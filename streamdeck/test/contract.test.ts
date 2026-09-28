/**
 * Contract + regression tests for the OpenCode <-> Stream Deck traffic-light
 * wire protocol. Zero test-framework dependencies: Node's built-in `node:test`
 * runner only (`node --test`). Run with `pnpm test`.
 *
 * WHAT IS REALLY EXERCISED (nothing here is a hand-written stand-in unless
 * flagged):
 *
 *  1. `shared/contract.ts`            -- imported as a real ES module.
 *  2. `opencode/src/plugin/state.ts`  -- imported as a real ES module.
 *  3. `streamdeck/src/plugin.ts`      -- the HTTP routing/validation layer is
 *     NOT copied into this file. The relevant source regions are sliced out of
 *     the real file at runtime, transpiled with the TypeScript compiler that is
 *     already a devDependency, and executed in a `new Function` scope with the
 *     same ambient names (`http`, `streamDeck`, `statusAction`, `PATH`,
 *     `MAX_BODY_BYTES`, `isState`, `MAX_TRACKED_INSTANCES`, `StringDecoder`, ...)
 *     injected. The marker strings are asserted, so a refactor that moves the
 *     code fails the suite loudly instead of silently testing a stale copy.
 *  4. `streamdeck/src/actions/paint-chain.ts` -- IMPORTED as a real ES module.
 *     `update` / `canTrack` / `markStale` / the `latest` dedupe memory of
 *     `OpenCodeStatus` are thin delegations to this class, so the HTTP tests and
 *     the repaint-ordering tests drive the REAL thing; only the USB write itself
 *     is stubbed (there is no Stream Deck app here). `MAX_TRACKED_INSTANCES` is
 *     NOT hard-coded: it is parsed out of the real action source.
 *     The `changed`-on-dedupe behaviour over the real built bundle is proven
 *     end-to-end in Part 3, not here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import ts from 'typescript';

import { PaintChain, type PaintFn } from '../src/actions/paint-chain.js';
import {
  ENV_HOST,
  ENV_PORT,
  HOST,
  MAX_BODY_BYTES,
  PATH,
  PORT,
  STALE_MS,
  STATES,
  SWEEP_MS,
  isState,
  resolveConfig,
  type State,
} from '../../shared/contract.js';
import { aggregate, derive, perSession } from '../../opencode/src/plugin/state.js';
import type { SessionRecord } from '../../opencode/src/plugin/state.js';

// ---------------------------------------------------------------------------
// Locating the repository, so the real sources can be read from the compiled
// test (which lives in streamdeck/test/.build/... and therefore sits three
// directories deeper than the source).
// ---------------------------------------------------------------------------

function findRepoRoot(start: string): string {
  let dir = start;

  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, 'could not locate the workspace root');
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_TS = path.join(REPO_ROOT, 'streamdeck', 'src', 'plugin.ts');
const ACTION_TS = path.join(REPO_ROOT, 'streamdeck', 'src', 'actions', 'opencode-status.ts');
const PAINT_CHAIN_TS = path.join(REPO_ROOT, 'streamdeck', 'src', 'actions', 'paint-chain.ts');
const MANIFEST_JSON = path.join(
  REPO_ROOT,
  'streamdeck',
  'com.tim0-12432.opencode-traffic-lights.sdPlugin',
  'manifest.json',
);

const actionSource = readFileSync(ACTION_TS, 'utf8');
const paintChainSource = readFileSync(PAINT_CHAIN_TS, 'utf8');

// ---------------------------------------------------------------------------
// Extracting the real `streamdeck/src/plugin.ts` regions.
// ---------------------------------------------------------------------------

const pluginSource = readFileSync(PLUGIN_TS, 'utf8');

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `marker not found in ${PLUGIN_TS}: ${JSON.stringify(from)}`);

  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `marker not found in ${PLUGIN_TS}: ${JSON.stringify(to)}`);

  return source.slice(start, end);
}

/**
 * `const lastSeen = ...` through the end of the `server.on('error')` handler:
 * content-type sniffing, `respond`, `readBody`, `parseState`, `onState`,
 * `handleRequest`, `http.createServer`, `clientError` and `error`.
 */
const SERVER_REGION = sliceBetween(
  pluginSource,
  'const lastSeen = new Map<number, number>();',
  'const sweeper = setInterval(',
);

/** The staleness sweeper, up to (but excluding) `server.listen`. */
const SWEEPER_REGION = sliceBetween(
  pluginSource,
  'const sweeper = setInterval(',
  'server.listen(port, host, () => {',
);

/** `readBody` on its own, so it can be fed a byte stream with chosen boundaries. */
const READBODY_REGION = sliceBetween(pluginSource, 'function readBody(', 'function parseState(');

const MAX_TRACKED_INSTANCES = ((): number => {
  const match = /export const MAX_TRACKED_INSTANCES = (\d+);/.exec(
    readFileSync(ACTION_TS, 'utf8'),
  );
  assert.ok(match, 'could not read MAX_TRACKED_INSTANCES from the real action source');
  return Number(match[1]);
})();

/** Transpiles a slice of real TypeScript and runs it in a controlled scope. */
function runRegion<T>(source: string, scope: Record<string, unknown>, returns: string): T {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const names = Object.keys(scope);
  const factory = new Function(...names, `${js}\nreturn (${returns});`) as unknown as (
    ...args: unknown[]
  ) => T;

  return factory(...names.map((name) => scope[name]));
}

// ---------------------------------------------------------------------------
// Stubbing the one thing that needs hardware: the USB `setImage` write. The
// dedupe, the instance cap and the repaint serialisation around it are the REAL
// `PaintChain`.
// ---------------------------------------------------------------------------

type LogEntry = { level: string; message: string };

type ActionStub = {
  canTrack: (instance: number) => boolean;
  update: (instance: number, state: State) => Promise<boolean>;
  markStale: (instance: number) => Promise<void>;
  /** The real dedupe memory, owned by the real `PaintChain`. */
  readonly latest: Map<number, State>;
  /** The real serialised repaint chain. */
  readonly chain: PaintChain;
  /** Instances that have at least one visible key, standing in for `this.actions`. */
  visibleKeys: Set<number>;
};

function createActionStub(paint?: PaintFn): ActionStub {
  const logs: LogEntry[] = [];
  const visibleKeys = new Set<number>();

  // This is `OpenCodeStatus.paint` (opencode-status.ts) with the Stream Deck
  // calls replaced: "a visible key exists for this instance" instead of
  // "getSettings resolved and this key's instance matches". A test may pass
  // its own `PaintFn` to model a failing `setImage`; the real `PaintChain`
  // around it is unchanged either way.
  const defaultPaint: PaintFn = (instance) =>
    Promise.resolve(visibleKeys.has(instance) ? 1 : 0);

  // The real thing, not a replica: `OpenCodeStatus` delegates to this class.
  const chain = new PaintChain({
    paint: paint ?? defaultPaint,
    maxTrackedInstances: MAX_TRACKED_INSTANCES,
    onUnpainted: (instance) => {
      logs.push({
        level: 'warn',
        message: `No visible key is configured for instance ${instance}.`,
      });
    },
  });

  return {
    chain,
    visibleKeys,

    get latest(): Map<number, State> {
      return chain.latest;
    },

    canTrack: (instance) => chain.canTrack(instance),
    update: (instance, state) => chain.update(instance, state),
    markStale: (instance) => chain.markStale(instance),
  };
}

type Harness = {
  server: http.Server;
  lastSeen: Map<number, number>;
  action: ActionStub;
  logs: LogEntry[];
  /** Advances the injected fake clock and runs one sweep tick. */
  tick: (ms: number) => void;
  close: () => Promise<void>;
};

type HarnessOptions = {
  fakeClock?: boolean;
  /** Overrides the stub's paint, e.g. to model a failing `setImage` write. */
  paint?: PaintFn;
};

function createHarness(options: HarnessOptions = {}): Harness {
  const logs: LogEntry[] = [];
  const streamDeck = {
    logger: {
      trace: () => undefined,
      debug: (message: string) => logs.push({ level: 'debug', message }),
      info: (message: string) => logs.push({ level: 'info', message }),
      warn: (message: string) => logs.push({ level: 'warn', message }),
      error: (message: string) => logs.push({ level: 'error', message }),
    },
  };

  const action = createActionStub(options.paint);
  const ticks: Array<() => void> = [];
  let now = 1_700_000_000_000;

  const scope: Record<string, unknown> = {
    http,
    streamDeck,
    statusAction: action,
    MAX_TRACKED_INSTANCES,
    MAX_BODY_BYTES,
    PATH,
    STALE_MS,
    SWEEP_MS,
    StringDecoder,
    isState,
    host: HOST,
    port: 0,
    clearInterval: () => undefined,
  };

  if (options.fakeClock) {
    scope['setInterval'] = (fn: () => void) => {
      ticks.push(fn);
      return { unref: () => undefined };
    };
    scope['Date'] = { now: () => now };
  }

  const region = options.fakeClock
    ? `${SERVER_REGION}\n${SWEEPER_REGION}`
    : SERVER_REGION;

  const bindings = runRegion<{
    server: http.Server;
    lastSeen: Map<number, number>;
    sweeper?: unknown;
  }>(region, scope, '({ server, lastSeen })');

  assert.ok(bindings.server instanceof http.Server, 'the real handler did not build a server');
  assert.ok(bindings.lastSeen instanceof Map, 'the real handler did not build lastSeen');

  const harness: Harness = {
    server: bindings.server,
    lastSeen: bindings.lastSeen,
    action,
    logs,
    tick: (ms: number) => {
      now += ms;
      assert.equal(ticks.length, 1, 'expected exactly one sweep interval');
      ticks[0]?.();
    },
    close: () =>
      new Promise<void>((resolve) => {
        harness.server.closeAllConnections();
        harness.server.close(() => resolve());
      }),
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Request helpers.
// ---------------------------------------------------------------------------

type Reply = { status: number; body: string; json: Record<string, unknown> };

async function post(
  port: number,
  payload: unknown,
  contentType: string | null = 'application/json',
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers['content-type'] = contentType;

  const response = await fetch(`http://127.0.0.1:${port}${PATH}`, {
    method: 'POST',
    headers,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

  const body = await response.text();
  let json: Record<string, unknown> = {};

  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Left empty on purpose: `body` is asserted separately where it matters.
  }

  return { status: response.status, body, json };
}

async function request(port: number, method: string, target: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${target}`, { method });
  await response.text();
  return response.status;
}

/** Sends raw bytes on a fresh socket and resolves with the raw response. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(payload);
    });
    socket.on('data', (chunk: string) => {
      out += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(out));
    socket.on('end', () => resolve(out));
  });
}

/**
 * Sends raw bytes but flushes each element of `parts` as a separate write with
 * a gap between them, so the server really does see them as separate 'data'
 * events (coalesced writes would make a split-character test vacuous).
 */
function rawExchangeInParts(port: number, parts: Buffer[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';
    let index = 0;

    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const sendNext = (): void => {
        if (index >= parts.length) {
          socket.end();
          return;
        }

        socket.write(parts[index] as Buffer);
        index += 1;
        setTimeout(sendNext, 15);
      };

      sendNext();
    });
    socket.on('data', (chunk: string) => {
      out += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(out));
    socket.on('end', () => resolve(out));
  });
}

/** `size` bytes of body, framed as one HTTP chunk. */
function httpChunk(bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${bytes.length.toString(16)}\r\n`),
    bytes,
    Buffer.from('\r\n'),
  ]);
}

/** The `readBody` of the REAL plugin.ts, with the real MAX_BODY_BYTES. */
function realReadBody(): (req: IncomingMessage) => Promise<string | null> {
  assert.match(READBODY_REGION, /function readBody/);
  assert.match(READBODY_REGION, /new StringDecoder\('utf8'\)/);

  return runRegion<(req: IncomingMessage) => Promise<string | null>>(
    READBODY_REGION,
    { MAX_BODY_BYTES, StringDecoder },
    'readBody',
  );
}

// ---------------------------------------------------------------------------
// A `PaintFn` whose every call records itself and then BLOCKS until the test
// releases it: the controllable stand-in for the SDK's slow `getSettings()`
// round trip, which is the window the whole bug lives in.
// ---------------------------------------------------------------------------

type PaintCall = { instance: number; state: State };

type ControlledPaint = {
  /** One entry per paint that STARTED, in start order. */
  calls: PaintCall[];
  paint: PaintFn;
  /** Resolves once `count` paints have started (not necessarily finished). */
  started: (count: number) => Promise<void>;
  /** Lets the `index`-th recorded paint finish. */
  release: (index: number) => void;
  /** Lets every recorded paint finish. */
  releaseAll: () => void;
};

function createControlledPaint(): ControlledPaint {
  const calls: PaintCall[] = [];
  const releases: Array<() => void> = [];
  const waiters: Array<() => void> = [];

  const paint: PaintFn = (instance, state) =>
    new Promise<number>((resolve) => {
      releases[calls.length] = () => resolve(1);
      calls.push({ instance, state });

      for (const wake of waiters.splice(0)) wake();
    });

  return {
    calls,
    paint,

    async started(count: number): Promise<void> {
      while (calls.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },

    release(index: number): void {
      const release = releases[index];
      assert.ok(release, `no paint was recorded at index ${index}`);
      release();
    },

    releaseAll(): void {
      for (const release of releases) release?.();
    },
  };
}

/** Lets every already-queued microtask and timer callback run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function statusLine(raw: string): number {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  assert.ok(match, `no HTTP status line in reply: ${JSON.stringify(raw.slice(0, 120))}`);
  return Number(match[1]);
}

/** A well-formed request whose JSON body is exactly `bytes` long. */
function jsonOfLength(bytes: number): string {
  const base = { instance: 1, state: 'green', pad: '' };
  const overhead = JSON.stringify(base).length;
  assert.ok(bytes > overhead, `cannot build a ${bytes} byte payload`);
  base.pad = 'a'.repeat(bytes - overhead);
  const text = JSON.stringify(base);
  assert.equal(Buffer.byteLength(text, 'utf8'), bytes);
  return text;
}

// ---------------------------------------------------------------------------
// Unit tests against the real shared + state modules.
// ---------------------------------------------------------------------------

describe('isState() -- shared/contract.ts', () => {
  it('accepts exactly the three contract states', () => {
    for (const state of STATES) {
      assert.equal(isState(state), true, `expected ${state} to be accepted`);
    }
  });

  it('rejects an array, even a single-element one (the String() coercion hole)', () => {
    assert.equal(isState(['red']), false);
    assert.equal(isState(['red', 'green']), false);
  });

  it('rejects null and undefined', () => {
    assert.equal(isState(null), false);
    assert.equal(isState(undefined), false);
  });

  it('rejects a boxed String object', () => {
    assert.equal(isState(new String('red')), false);
  });

  it('rejects wrong casing and unknown states', () => {
    assert.equal(isState('RED'), false);
    assert.equal(isState('Red'), false);
    assert.equal(isState('blue'), false);
    assert.equal(isState(' green'), false);
    assert.equal(isState('green '), false);
  });
});

describe('resolveConfig() -- shared/contract.ts', () => {
  it('falls back to the contract defaults for an empty env', () => {
    assert.deepEqual(resolveConfig({}), { host: HOST, port: PORT });
    assert.deepEqual(resolveConfig(), { host: HOST, port: PORT });
  });

  it('treats an empty port variable as "unset"', () => {
    assert.deepEqual(resolveConfig({ [ENV_PORT]: '' }), { host: HOST, port: PORT });
  });

  it('honours a valid host and port override', () => {
    assert.deepEqual(resolveConfig({ [ENV_HOST]: '0.0.0.0', [ENV_PORT]: '9999' }), {
      host: '0.0.0.0',
      port: 9999,
    });
  });

  it('accepts the range boundaries 1 and 65535', () => {
    assert.equal(resolveConfig({ [ENV_PORT]: '1' }).port, 1);
    assert.equal(resolveConfig({ [ENV_PORT]: '65535' }).port, 65535);
  });

  it('rejects a non-integer port', () => {
    for (const raw of ['8765.5', 'abc', 'NaN', ' ', 'Infinity', '-Infinity', '1e']) {
      assert.throws(
        () => resolveConfig({ [ENV_PORT]: raw }),
        /must be an integer between 1 and 65535/,
        `expected ${JSON.stringify(raw)} to be rejected`,
      );
    }
  });

  it('KNOWN LAXITY: Number() coercion means hex, exponent and padded forms are accepted', () => {
    // Not a safety problem (the result is still an in-range safe integer), but
    // the contract is looser than "digits only" implies. See the report.
    assert.equal(resolveConfig({ [ENV_PORT]: '0x10' }).port, 16);
    assert.equal(resolveConfig({ [ENV_PORT]: '8e3' }).port, 8000);
    assert.equal(resolveConfig({ [ENV_PORT]: ' 8765 ' }).port, 8765);
  });

  it('rejects an out-of-range port', () => {
    for (const raw of ['0', '-1', '65536', '999999']) {
      assert.throws(
        () => resolveConfig({ [ENV_PORT]: raw }),
        /must be an integer between 1 and 65535/,
        `expected ${JSON.stringify(raw)} to be rejected`,
      );
    }
  });
});

describe('perSession() / aggregate() / derive() -- opencode/src/plugin/state.ts', () => {
  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      status: 'idle',
      pending: new Set<string>(),
      error: false,
      lastSeen: 0,
      ...overrides,
    };
  }

  it('busy with a pending permission is yellow (the prompt outranks the work)', () => {
    assert.equal(perSession(record({ status: 'busy', pending: new Set(['p1']) })), 'yellow');
  });

  it('busy on its own is red', () => {
    assert.equal(perSession(record({ status: 'busy' })), 'red');
  });

  it('retry is red -- work in progress, nobody is being asked anything', () => {
    assert.equal(perSession(record({ status: 'retry' })), 'red');
  });

  it('error is yellow', () => {
    assert.equal(perSession(record({ error: true })), 'yellow');
    assert.equal(perSession(record({ status: 'busy', error: true })), 'yellow');
  });

  it('idle with nothing pending is green', () => {
    assert.equal(perSession(record()), 'green');
  });

  it('REGRESSION: idle must NOT clear a pending permission', () => {
    // A permission prompt parks the turn, so OpenCode legitimately emits
    // session.idle while it waits for the answer. Clearing `pending` there
    // would flip the key green at the exact moment the user is being asked.
    const parked = record({ status: 'idle', pending: new Set(['permission-1']) });
    assert.equal(perSession(parked), 'yellow');
    assert.equal(derive([parked]), 'yellow');
  });

  it('REGRESSION: error must not be cleared by going idle either', () => {
    assert.equal(perSession(record({ status: 'idle', error: true })), 'yellow');
  });

  it('aggregate: any yellow anywhere beats any red anywhere', () => {
    assert.equal(aggregate(['red', 'yellow']), 'yellow');
    assert.equal(aggregate(['yellow', 'red']), 'yellow');
    assert.equal(aggregate(['green', 'red', 'yellow', 'red']), 'yellow');
  });

  it('aggregate: red wins when there is no yellow, green when there is neither', () => {
    assert.equal(aggregate(['green', 'red']), 'red');
    assert.equal(aggregate(['green', 'green']), 'green');
    assert.equal(aggregate([]), 'green');
  });

  it('derive: one busy session among idle sessions is red', () => {
    const sessions = [record(), record({ status: 'busy' }), record()];
    assert.equal(derive(sessions), 'red');
  });

  it('derive: a pending permission anywhere makes the whole deck yellow', () => {
    const sessions = [
      record({ status: 'busy' }),
      record({ status: 'idle', pending: new Set(['perm-9']) }),
    ];
    assert.equal(derive(sessions), 'yellow');
  });

  it('derive: no sessions is green', () => {
    assert.equal(derive([]), 'green');
  });

  it('derive: several pending permissions still read as one yellow', () => {
    const many = record({ pending: new Set(['a', 'b', 'c']) });
    assert.equal(derive([many]), 'yellow');
  });
});

// ---------------------------------------------------------------------------
// HTTP tests against the real `streamdeck/src/plugin.ts` handler.
// ---------------------------------------------------------------------------

describe('the real plugin.ts handler is what is under test', () => {
  it('found both regions in the real source file', () => {
    assert.match(SERVER_REGION, /function hasJsonContentType/);
    assert.match(SERVER_REGION, /function parseState/);
    assert.match(SERVER_REGION, /async function handleRequest/);
    assert.match(SERVER_REGION, /server\.on\('clientError'/);
    assert.match(SWEEPER_REGION, /const sweeper = setInterval/);
    assert.match(SWEEPER_REGION, /sweeper\.unref\(\)/);
  });

  it('read the real MAX_TRACKED_INSTANCES out of the action source', () => {
    assert.equal(MAX_TRACKED_INSTANCES, 32);
  });

  it('the real action really does delegate its repaints to the serialised chain', () => {
    // If OpenCodeStatus ever grows a private `latest` again, the HTTP tests
    // would keep passing while the action regressed to unsynchronised paints.
    assert.match(actionSource, /new PaintChain\(/);
    assert.match(actionSource, /return this\.chain\.update\(instance, state\)/);
    assert.match(actionSource, /await this\.chain\.markStale\(instance\)/);
    assert.doesNotMatch(actionSource, /latest\.set\(/);
    assert.doesNotMatch(actionSource, /await this\.paint\(/);
    assert.match(paintChainSource, /private readonly chains = new Map<number, Chain>\(\)/);
  });
});

describe('REGRESSION: unsynchronised repaints -- the real PaintChain, real dedupe', () => {
  it('a sweep that lands after a newer state cannot strand the key', async () => {
    // The exact interleaving from the bug report:
    //   1. the sweeper's markStale(1) is awaiting inside its green paint,
    //   2. a POST /state with `red` arrives inside that window,
    //   3. the green setImage used to land AFTER the red one, leaving the key
    //      physically green while `latest` said 'red' -- and every later
    //      heartbeat deduped on `latest` and never repainted.
    const { calls, paint, started, release } = createControlledPaint();
    const chain = new PaintChain({ paint, maxTrackedInstances: MAX_TRACKED_INSTANCES });

    const sweep = chain.markStale(1);
    await started(1);
    assert.deepEqual(calls, [{ instance: 1, state: 'green' }]);

    const red = chain.update(1, 'red');
    await settle();
    assert.deepEqual(
      calls,
      [{ instance: 1, state: 'green' }],
      'red must not touch the key while the green paint is still in flight',
    );

    release(0);
    await started(2);
    assert.deepEqual(
      calls[1],
      { instance: 1, state: 'red' },
      'red may only start once green has actually landed',
    );

    release(1);
    assert.equal(await sweep, undefined);
    assert.equal(await red, true);

    assert.equal(calls.at(-1)?.state, 'red', 'the LAST paint that ran must be red');
    assert.equal(chain.latest.get(1), 'red', 'the dedupe memory must agree with the key');
    assert.equal(chain.isBusy(1), false);
    assert.equal(chain.chainCount, 0, 'the chain entry must be released, not leaked');
  });

  it('a state change mid-paint is repainted, never deduped to changed:false', async () => {
    // While the red paint is still in flight the key is showing whatever it
    // showed before, so claiming "red is already applied" would strand it: the
    // key would stay stale and the next heartbeat would dedupe forever.
    const { calls, paint, started, release } = createControlledPaint();
    const chain = new PaintChain({ paint, maxTrackedInstances: MAX_TRACKED_INSTANCES });

    const red = chain.update(1, 'red');
    await started(1);

    const again = chain.update(1, 'red');
    await settle();

    const early = await Promise.race([
      again.then(() => 'resolved'),
      settle().then(() => 'pending'),
    ]);
    assert.equal(early, 'pending', 'update must not resolve while its paint is still queued');
    assert.equal(calls.length, 1, 'the second paint must wait its turn on the chain');

    release(0);
    await started(2);
    release(1);
    assert.equal(await again, true, 'a repaint of a state that is not physically applied');
    assert.equal(await red, true);
    assert.deepEqual(
      calls.map((call) => call.state),
      ['red', 'red'],
    );
    assert.equal(chain.latest.get(1), 'red');

    // Now the key has genuinely settled, so the same state IS a dedupe, and the
    // dedupe must not write to the key again.
    const settledDuplicate = await chain.update(1, 'red');
    assert.equal(settledDuplicate, false, 'a settled state must dedupe to changed:false');
    assert.equal(calls.length, 2, 'a deduped state must not repaint');
    assert.equal(chain.chainCount, 0);

    // The half of the guard above that is actually load-bearing: `latest` says
    // 'red' AND the instance is busy. A paint for this instance is in flight and
    // is about to move the key, so claiming "red is already applied" would
    // strand it -- the in-flight green lands, `latest` still says 'red', and
    // nothing ever repaints. This is the `!this.isBusy(instance) &&` guard: with
    // it deleted, the call below resolves false without painting and the key is
    // left green while `latest` claims red.
    const inFlightGreen = chain.update(1, 'green');
    await started(3);
    assert.deepEqual(calls[2], { instance: 1, state: 'green' });
    assert.equal(chain.latest.get(1), 'red', 'the green has not landed, so latest still says red');

    let dedupedWhileBusy: boolean | undefined;
    void chain.update(1, 'red').then((value) => {
      dedupedWhileBusy = value;
    });

    await settle();
    assert.equal(dedupedWhileBusy, undefined, 'update must not resolve while its paint is queued');
    assert.equal(calls.length, 3, 'red must queue behind the in-flight green, not dedupe away');

    release(2);
    await started(4);
    assert.deepEqual(calls[3], { instance: 1, state: 'red' }, 'red may only start after green landed');
    release(3);
    await settle();

    assert.equal(dedupedWhileBusy, true, 'a state that is in `latest` but not on the key must repaint');
    // The green DID reach the key, so it honestly reports changed:true, but
    // `latest` refuses to record it because a newer paint is queued behind it.
    assert.equal(await inFlightGreen, true, 'a superseded paint that did land still repainted');
    assert.equal(chain.latest.get(1), 'red');
    assert.equal(chain.chainCount, 0);
  });

  it('a sweep arriving mid-paint leaves the key honest and the next heartbeat repairs it', async () => {
    // Reverse order: `red` is already painting when the sweeper concludes the
    // client is gone. The green is queued BEHIND the red, so it lands last and
    // the key is honestly green again -- but `latest` must NOT still claim red.
    const { calls, paint, started, release } = createControlledPaint();
    const chain = new PaintChain({ paint, maxTrackedInstances: MAX_TRACKED_INSTANCES });

    const red = chain.update(1, 'red');
    await started(1);

    const sweep = chain.markStale(1);
    await settle();
    assert.equal(calls.length, 1, 'the sweep must not paint on top of the in-flight red');

    release(0);
    await started(2);
    assert.deepEqual(
      calls.map((call) => call.state),
      ['red', 'green'],
      'ordered chain: the last enqueued paint is the last to land',
    );
    assert.equal(chain.latest.has(1), false, 'red must not be recorded while green is queued');

    release(1);
    await red;
    await sweep;

    // The key is green and `latest` does not claim red, so the next heartbeat
    // repaints instead of deduping -- the client is never left in the dark.
    const repaired = chain.update(1, 'red');
    await started(3);
    release(2);
    assert.equal(await repaired, true, 'the next heartbeat must repaint red, not dedupe away');
    assert.equal(calls.at(-1)?.state, 'red');
    assert.equal(chain.latest.get(1), 'red');
    assert.equal(chain.chainCount, 0);
  });

  it('serialises per instance: a blocked paint does not hold up another instance', async () => {
    const { calls, paint, started, release, releaseAll } = createControlledPaint();
    const chain = new PaintChain({ paint, maxTrackedInstances: MAX_TRACKED_INSTANCES });

    const one = chain.update(1, 'red');
    await started(1);

    // Instance 2 must reach the key while instance 1 is still blocked. A global
    // lock (or a shared chain) would hang here forever.
    const two = chain.update(2, 'yellow');
    await started(2);
    assert.deepEqual(
      calls,
      [
        { instance: 1, state: 'red' },
        { instance: 2, state: 'yellow' },
      ],
      'a second instance must not queue behind a slow first instance',
    );

    releaseAll();
    assert.equal(await one, true);
    assert.equal(await two, true);
    assert.equal(chain.chainCount, 0);
  });

  it('serialises a sequence of repaints for one instance, in order', async () => {
    const { calls, paint, started, release } = createControlledPaint();
    const chain = new PaintChain({ paint, maxTrackedInstances: MAX_TRACKED_INSTANCES });
    const results: boolean[] = [];

    for (const state of ['red', 'green', 'yellow'] as State[]) {
      const pending = chain.update(1, state);
      await started(calls.length + 1);
      assert.equal(calls.at(-1)?.state, state, 'a paint must not overtake an earlier one');
      release(calls.length - 1);
      results.push(await pending);
    }

    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(
      calls.map((call) => call.state),
      ['red', 'green', 'yellow'],
    );
    assert.equal(chain.latest.get(1), 'yellow');
    assert.equal(chain.chainCount, 0);
  });

  it('a synchronous burst collapses to the newest state instead of queueing stale writes', async () => {
    // Four states inside one tick. The first three are superseded before they
    // ever touch the key -- nobody could have seen them, and each would be
    // overwritten before the next -- so the only USB write that happens is the
    // newest state. That is the point of the supersede check; what must never
    // happen is the reverse: a stale write landing after a newer one.
    const { calls, paint, release } = createControlledPaint();
    const chain = new PaintChain({ paint, maxTrackedInstances: MAX_TRACKED_INSTANCES });

    const pending = (['red', 'green', 'yellow', 'red'] as State[]).map((state) =>
      chain.update(1, state),
    );

    await settle();
    assert.deepEqual(
      calls,
      [{ instance: 1, state: 'red' }],
      'only the newest state may reach the key; the superseded ones are dropped',
    );

    release(0);
    assert.deepEqual(
      await Promise.all(pending),
      [false, false, false, true],
      'only the paint that reached the key may report changed:true',
    );
    assert.equal(chain.latest.get(1), 'red');
    assert.equal(chain.chainCount, 0);

    // The key really has settled on red now, so the same state is a dedupe.
    assert.equal(await chain.update(1, 'red'), false);
    assert.equal(calls.length, 1, 'a deduped state must not repaint');
  });

  it('a failing paint does not poison the chain or the dedupe memory', async () => {
    let attempt = 0;
    const chain = new PaintChain({
      paint: () => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('setImage failed')) : Promise.resolve(1);
      },
      maxTrackedInstances: MAX_TRACKED_INSTANCES,
    });

    await assert.rejects(chain.update(1, 'red'), /setImage failed/);
    await settle();
    assert.equal(chain.chainCount, 0, 'a rejected paint must not leave a chain entry behind');
    assert.equal(chain.latest.has(1), false, 'a state that never reached the key is not recorded');

    // The next heartbeat must try again rather than dedupe against a state the
    // key never showed.
    assert.equal(await chain.update(1, 'red'), true);
    assert.equal(chain.latest.get(1), 'red');
    assert.equal(chain.chainCount, 0);
  });

  it('still refuses more than MAX_TRACKED_INSTANCES and still warns about invisible keys', async () => {
    const unpainted: number[] = [];
    const chain = new PaintChain({
      paint: () => Promise.resolve(0),
      maxTrackedInstances: MAX_TRACKED_INSTANCES,
      onUnpainted: (instance) => unpainted.push(instance),
    });

    for (let i = 0; i < MAX_TRACKED_INSTANCES; i += 1) {
      assert.equal(await chain.update(i, 'green'), true);
    }

    await assert.rejects(
      chain.update(9999, 'red'),
      new RegExp(`the limit of ${MAX_TRACKED_INSTANCES} tracked instances is reached`),
    );
    assert.equal(await chain.update(0, 'red'), true, 'an already-tracked instance still works');
    await chain.markStale(0);
    assert.equal(await chain.update(9999, 'red'), true, 'releasing a slot lets a new client in');
    assert.deepEqual(unpainted, [
      ...Array.from({ length: MAX_TRACKED_INSTANCES }, (_, i) => i),
      0,
      9999,
    ]);
  });
});

describe('POST /state -- the happy path', () => {
  const harness = createHarness();
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await harness.close();
  });

  for (const state of STATES) {
    it(`accepts state "${state}" and hands it to the action`, async () => {
      const instance = 100 + STATES.indexOf(state);
      harness.action.visibleKeys.add(instance);
      const seenBefore = harness.logs.length;

      const reply = await post(port, { instance, state });

      assert.equal(reply.status, 200);
      assert.equal(reply.json['ok'], true);
      assert.equal(reply.json['state'], state);
      assert.equal(reply.json['changed'], true);
      assert.equal(harness.action.latest.get(instance), state);
      assert.equal(harness.logs.slice(seenBefore).filter((l) => l.level === 'error').length, 0);
    });
  }

  it('tolerates the `; charset=utf-8` parameter on the content type', async () => {
    const reply = await post(port, { instance: 7, state: 'yellow' }, 'application/json; charset=utf-8');
    assert.equal(reply.status, 200);
    assert.equal(reply.json['state'], 'yellow');
  });

  it('tolerates an uppercase and padded content type', async () => {
    const reply = await post(port, { instance: 7, state: 'yellow' }, '  APPLICATION/JSON ; charset=UTF-8');
    assert.equal(reply.status, 200);
  });

  it('deduplicates: the same state twice reports changed:true then changed:false', async () => {
    const instance = 21;
    harness.action.visibleKeys.add(instance);

    const first = await post(port, { instance, state: 'red' });
    const second = await post(port, { instance, state: 'red' });
    const third = await post(port, { instance, state: 'green' });

    assert.equal(first.json['changed'], true);
    assert.equal(second.json['changed'], false);
    assert.equal(third.json['changed'], true);
    assert.equal(harness.action.latest.get(instance), 'green');
  });

  it('accepts the full transport payload shape {instance,state,ts,seq}', async () => {
    const payload = { instance: 5, state: 'red' as State, ts: Date.now(), seq: 42 };
    const reply = await post(port, payload);
    assert.equal(reply.status, 200);
    assert.equal(reply.json['ok'], true);
    assert.equal(reply.json['state'], 'red');
  });

  it('ignores ts and seq entirely -- liveness comes from the arrival clock', async () => {
    // A wildly wrong client clock and a replayed seq must not be rejected.
    assert.equal((await post(port, { instance: 5, state: 'red', ts: 0, seq: 0 })).status, 200);
    assert.equal((await post(port, { instance: 5, state: 'red', ts: 2 ** 53, seq: 99 })).status, 200);
    assert.equal(harness.lastSeen.has(5), true);
  });

  it('accepts instance 0 (the default instance)', async () => {
    const reply = await post(port, { instance: 0, state: 'green' });
    assert.equal(reply.status, 200);
  });
});

describe('POST /state -- content-type enforcement (the cross-origin drive-by fix)', () => {
  const harness = createHarness();
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await harness.close();
  });

  it('rejects text/plain with a valid JSON body as 415', async () => {
    // text/plain is CORS-safelisted, so any page the user visits could drive
    // the key without a preflight. This must never be honoured.
    const reply = await post(port, { instance: 1, state: 'red' }, 'text/plain');
    assert.equal(reply.status, 415);
  });

  it('rejects a CORS-safelisted form encoding as 415', async () => {
    const reply = await post(port, { instance: 1, state: 'red' }, 'application/x-www-form-urlencoded');
    assert.equal(reply.status, 415);
  });

  it('rejects text/plain;charset=UTF-8 (the exact header a drive-by would send)', async () => {
    const reply = await post(port, { instance: 1, state: 'red' }, 'text/plain;charset=UTF-8');
    assert.equal(reply.status, 415);
  });

  it('rejects a missing content type as 415', async () => {
    const reply = await post(port, { instance: 1, state: 'red' }, null);
    assert.equal(reply.status, 415);
  });

  it('rejects an empty content type as 415', async () => {
    const reply = await post(port, { instance: 1, state: 'red' }, '');
    assert.equal(reply.status, 415);
  });

  it('rejects `application/jsonx` -- no prefix matching', async () => {
    const reply = await post(port, { instance: 1, state: 'red' }, 'application/jsonx');
    assert.equal(reply.status, 415);
  });

  it('answers 415 with a JSON body', async () => {
    const reply = await post(port, { instance: 1, state: 'red' }, 'text/plain');
    assert.equal(reply.json['error'], 'Content-Type must be application/json');
  });
});

describe('POST /state -- payload validation', () => {
  const harness = createHarness();
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await harness.close();
  });

  it('REGRESSION: an array state is 400, not silently coerced to "red"', async () => {
    // `String(['red']) === 'red'`, so a naive truthy check would accept this.
    const reply = await post(port, { instance: 1, state: ['red'] });
    assert.equal(reply.status, 400);
    assert.equal(harness.action.latest.get(1), undefined);
  });

  it('rejects wrong-case, unknown and missing states with 400', async () => {
    for (const state of ['RED', 'blue', 'Green', '', 0, 1, true, null, {}, ['red'], { toString: () => 'red' }]) {
      const reply = await post(port, { instance: 1, state });
      assert.equal(reply.status, 400, `expected state ${JSON.stringify(state)} to be rejected`);
    }

    assert.equal((await post(port, { instance: 1 })).status, 400);
  });

  it('rejects a bad instance with 400', async () => {
    for (const instance of [-1, 1.5, '1', null, true, [], {}, 2 ** 53, Number.NaN]) {
      const reply = await post(port, { instance, state: 'red' });
      assert.equal(reply.status, 400, `expected instance ${JSON.stringify(instance)} to be rejected`);
    }

    assert.equal((await post(port, { state: 'red' })).status, 400);
  });

  it('rejects malformed JSON with 400', async () => {
    for (const body of ['{', 'not json', '{"instance":1,}', "{'instance':1}", '', '[1,2']) {
      const reply = await post(port, body);
      assert.equal(reply.status, 400, `expected ${JSON.stringify(body)} to be rejected`);
    }
  });

  it('rejects a JSON scalar or array as the top level with 400', async () => {
    for (const body of ['null', '1', '"red"', '[]', '["red"]']) {
      assert.equal((await post(port, body)).status, 400, `expected ${body} to be rejected`);
    }
  });

  it('ignores unknown extra fields', async () => {
    const reply = await post(port, { instance: 1, state: 'green', evil: '<script>', nested: { a: 1 } });
    assert.equal(reply.status, 200);
  });

  it('rejects a prototype-pollution attempt without crashing', async () => {
    const reply = await post(port, '{"instance":1,"state":"green","__proto__":{"polluted":true}}');
    assert.equal(reply.status, 200);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('validates the body BEFORE the content type is irrelevant to the order', async () => {
    // A bad content type short-circuits at 415 even when the body is also bad.
    assert.equal((await post(port, { instance: -1, state: 'blue' }, 'text/plain')).status, 415);
  });
});

describe('POST /state -- routing', () => {
  const harness = createHarness();
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await harness.close();
  });

  it('GET /state is 404', async () => {
    assert.equal(await request(port, 'GET', PATH), 404);
  });

  it('POST /nope is 404', async () => {
    assert.equal((await post(port, { instance: 1, state: 'red' })).status, 200);
    const body = JSON.stringify({ instance: 1, state: 'red' });
    const response = await fetch(`http://127.0.0.1:${port}/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    await response.text();
    assert.equal(response.status, 404);
  });

  it('other methods on /state are 404', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      assert.equal(await request(port, method, PATH), 404, `expected ${method} to be 404`);
    }
  });

  it('is 404 for a query string, because the path is compared verbatim', async () => {
    const response = await fetch(`http://127.0.0.1:${port}${PATH}?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance: 1, state: 'red' }),
    });
    await response.text();
    assert.equal(response.status, 404);
  });

  it('is 404 for a CORS preflight OPTIONS, which is the drive-by defence', async () => {
    const response = await fetch(`http://127.0.0.1:${port}${PATH}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    await response.text();
    assert.equal(response.status, 404);
  });

  it('never advertises a permissive CORS policy', async () => {
    const response = await fetch(`http://127.0.0.1:${port}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ instance: 1, state: 'green' }),
    });
    await response.text();
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  });

  it('always answers with a JSON content type', async () => {
    const reply = await post(port, { instance: 1, state: 'green' });
    const response = await fetch(`http://127.0.0.1:${port}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance: 1, state: 'green' }),
    });
    await response.text();
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(reply.json['ok'], true);
  });
});

describe('POST /state -- body limits and connection abuse', () => {
  const harness = createHarness();
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await harness.close();
  });

  async function stillAlive(): Promise<void> {
    const reply = await post(port, { instance: 1, state: 'green' });
    assert.equal(reply.status, 200, 'the server must still answer after the abuse');
  }

  it('accepts a body of exactly MAX_BODY_BYTES', async () => {
    const body = jsonOfLength(MAX_BODY_BYTES);
    const reply = await post(port, body);
    assert.equal(reply.status, 200);
    await stillAlive();
  });

  it('REGRESSION: a body over MAX_BODY_BYTES is 413 and the server SURVIVES', async () => {
    const reply = await post(port, jsonOfLength(MAX_BODY_BYTES + 1));
    assert.equal(reply.status, 413);
    // The old implementation called req.destroy(), which crashed the process.
    await stillAlive();
  });

  it('survives a wildly oversized body (1 MiB)', async () => {
    const reply = await post(port, jsonOfLength(1024 * 1024));
    assert.equal(reply.status, 413);
    await stillAlive();
  });

  it('survives a chunked oversized body with no content-length', async () => {
    // The chunk-size line is HEX, unlike Content-Length.
    const size = MAX_BODY_BYTES + 64;
    const raw = await rawExchange(
      port,
      `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
        `${size.toString(16)}\r\n${'a'.repeat(size)}\r\n0\r\n\r\n`,
    );
    assert.equal(statusLine(raw), 413);
    await stillAlive();
  });

  it('answers a chunked body within the limit', async () => {
    const body = jsonOfLength(64);
    const raw = await rawExchange(
      port,
      `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
        `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
    );
    assert.equal(statusLine(raw), 200);
    assert.match(raw, /"ok":true/);
  });

  it('REGRESSION: a body of EXACTLY MAX_BODY_BYTES survives a split multi-byte character', async () => {
    // Discriminator: `€` is 3 UTF-8 bytes. Decoded chunk-by-chunk it became two
    // U+FFFD, which is 6 bytes, so the real byte count was inflated past
    // MAX_BODY_BYTES and a legal body was rejected with 413. With the decoder
    // buffering across the boundary the body is reassembled byte-for-byte, is
    // still exactly 4096 bytes, and is accepted.
    const overhead = Buffer.byteLength('{"instance":1,"state":"green","pad":""}', 'utf8');
    const euros = Buffer.from('€', 'utf8');
    const pad = 'a'.repeat(MAX_BODY_BYTES - overhead - euros.length) + '€';
    const text = `{"instance":1,"state":"green","pad":"${pad}"}`;
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(bytes.length, MAX_BODY_BYTES);

    // Cut one byte into the `€`, so a per-chunk decode would corrupt it.
    const cut = bytes.indexOf(euros) + 1;
    assert.deepEqual(bytes.subarray(cut - 1, cut + 2), euros, 'the cut must fall inside the €');

    const header = Buffer.from(
      `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
        'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
    );
    const raw = await rawExchangeInParts(port, [
      Buffer.concat([header, httpChunk(bytes.subarray(0, cut))]),
      Buffer.concat([httpChunk(bytes.subarray(cut)), Buffer.from('0\r\n\r\n')]),
    ]);

    assert.equal(statusLine(raw), 200, 'a legal body must not be rejected for phantom bytes');
    assert.match(raw, /"ok":true/);
    assert.equal(harness.action.latest.get(1), 'green');
  });

  it('REGRESSION: a request aborted mid-body does not crash the server', async () => {
    const header =
      `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
      `content-length: 500\r\nConnection: keep-alive\r\n\r\n`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.on('error', () => resolve());
        socket.on('connect', () => {
          // Send a truncated, syntactically broken body, then rip the socket
          // out from under the server mid-flight.
          socket.write(header);
          socket.write('{"instance":1,"state":"re');
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 15);
        });
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    await stillAlive();
  });

  it('survives a socket that is closed before any body byte arrives', async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => resolve());
      socket.on('connect', () => {
        socket.write(`POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 200\r\n\r\n`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 15);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await stillAlive();
  });

  it('REGRESSION: malformed HTTP on a raw socket does not crash the server', async () => {
    for (const garbage of [
      'GARBAGE NOT HTTP AT ALL\r\n\r\n',
      'GET\r\n\r\n',
      'POST /state HTTP/9.9\r\n\r\n',
      '\u0000\u0001\u0002\u0003',
      `POST ${PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n`,
      `POST ${PATH} HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: -1\r\n\r\n`,
    ]) {
      await rawExchange(port, garbage);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    await stillAlive();
  });

  it('survives a burst of concurrent half-open sockets', async () => {
    const sockets = Array.from({ length: 20 }, () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.write(`POST ${PATH} HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: 9999\r\n\r\n{`);
      return socket;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stillAlive();
  });
});

// ---------------------------------------------------------------------------
// readBody() on its own, from the real plugin.ts source, fed a byte stream with
// hand-picked chunk boundaries. Through the HTTP handler a mangled multi-byte
// character would still parse as JSON, so the body itself has to be asserted.
// ---------------------------------------------------------------------------

describe('readBody() -- the real plugin.ts source, controlled chunk boundaries', () => {
  const readBody = realReadBody();

  function feed(chunks: Buffer[], end: 'end' | 'destroy' = 'end'): Promise<string | null> {
    const req = new PassThrough();
    const promise = readBody(req as unknown as IncomingMessage);

    for (const chunk of chunks) req.write(chunk);

    if (end === 'end') req.end();
    else req.destroy();

    return promise;
  }

  /** Fails rather than hangs, so a leaked promise is a test failure. */
  async function settleRead(promise: Promise<string | null>): Promise<string | null | 'leaked'> {
    return Promise.race([
      promise,
      new Promise<'leaked'>((resolve) => setTimeout(() => resolve('leaked'), 1000)),
    ]);
  }

  it('REGRESSION: a multi-byte character split across chunks is reassembled byte-for-byte', async () => {
    const text = '{"instance":1,"state":"green","note":"€ and €"}';
    const bytes = Buffer.from(text, 'utf8');
    const cut = bytes.indexOf(Buffer.from('€', 'utf8')) + 1;

    // Guard: the naive `chunk.toString('utf8')` really does corrupt this split,
    // so the assertion below is not vacuous.
    const naive = bytes.subarray(0, cut).toString('utf8') + bytes.subarray(cut).toString('utf8');
    assert.notEqual(naive, text, 'this split must fall inside a character');
    assert.match(naive, /\ufffd/, 'the naive per-chunk decode must produce replacement characters');
    assert.notEqual(
      Buffer.byteLength(naive, 'utf8'),
      Buffer.byteLength(text, 'utf8'),
      'the corruption must also change the measured byte count',
    );

    const body = await feed([bytes.subarray(0, cut), bytes.subarray(cut)]);

    assert.equal(body, text);
    assert.equal(Buffer.from(body as string, 'utf8').equals(bytes), true);
  });

  it('REGRESSION: a split at EVERY single-byte boundary still reassembles', async () => {
    // The strongest form of the fix: TCP is free to break the body anywhere.
    const text = '{"instance":1,"state":"green","note":"€€€ ok"}';
    const bytes = Buffer.from(text, 'utf8');

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const body = await feed([bytes.subarray(0, cut), bytes.subarray(cut)]);
      assert.equal(body, text, `body corrupted when split at byte ${cut}`);
    }
  });

  it('reassembles a body delivered one byte at a time', async () => {
    const text = '{"instance":1,"state":"green","note":"日本 €"}';
    const bytes = Buffer.from(text, 'utf8');
    const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));

    assert.equal(await feed(chunks), text);
  });

  it('REGRESSION: an aborted request resolves the PARTIAL body, and does not leak', async () => {
    // The doc comment used to claim this resolved null. It does not: 'close'
    // hands back what arrived. That is safe -- a truncated request is rejected
    // by the HTTP parser and never reaches the handler, and the partial text is
    // either unparseable or refused by parseState -- but it must be pinned down.
    const partial = '{"instance":1,"state":"re';
    const settled = await settleRead(feed([Buffer.from(partial)], 'destroy'));

    assert.notEqual(settled, 'leaked', 'readBody must not leak its promise on an aborted request');
    assert.equal(settled, partial, "'close' resolves the partial body, not null");
  });

  it('an aborted request before any byte arrives resolves the empty string', async () => {
    assert.equal(await settleRead(feed([], 'destroy')), '');
  });

  it('an oversized body resolves null, and stays null once it is known', async () => {
    const chunks = [Buffer.alloc(MAX_BODY_BYTES, 0x61), Buffer.alloc(1024, 0x62)];
    assert.equal(await feed(chunks), null);
  });

  it('a stream error discards the body and resolves null', async () => {
    const req = new PassThrough();
    const promise = readBody(req as unknown as IncomingMessage);
    req.write(Buffer.from('{"instance":1,"state":"red"}'));
    req.emit('error', new Error('ECONNRESET'));

    assert.equal(await settleRead(promise), null);
  });

  it('an exactly-at-the-limit multi-byte body is accepted', async () => {
    const overhead = Buffer.byteLength('{"instance":1,"pad":""}', 'utf8');
    const text = `{"instance":1,"pad":"${'a'.repeat(MAX_BODY_BYTES - overhead - 3)}€"}`;
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(bytes.length, MAX_BODY_BYTES);

    assert.equal(await feed([bytes.subarray(0, 4), bytes.subarray(4, 7), bytes.subarray(7)]), text);
  });
});

describe('POST /state -- concurrency and adversarial clients', () => {
  const harness = createHarness();
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    port = address.port;
  });

  after(async () => {
    await harness.close();
  });

  it('handles 40 concurrent rapid state changes for one instance', async () => {
    const instance = 77;
    harness.action.visibleKeys.add(instance);

    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        post(port, { instance, state: (['red', 'green', 'yellow'] as const)[i % 3]!, ts: Date.now(), seq: i }),
      ),
    );

    for (const reply of replies) {
      assert.equal(reply.status, 200);
      assert.equal(reply.json['ok'], true);
    }

    // Whichever request arrived last wins, and the winner is a real state.
    assert.ok(STATES.includes(harness.action.latest.get(instance) as State));
    assert.equal(harness.logs.filter((l) => l.level === 'error').length, 0);
  });

  it('handles concurrent changes across many instances', async () => {
    const replies = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(port, { instance: 200 + i, state: 'yellow' })),
    );
    assert.equal(replies.every((r) => r.status === 200), true);
    assert.equal(harness.action.latest.size >= 30, true);
  });

  it('accepts a state for an instance that has no key configured, without crashing', async () => {
    const instance = 4242;
    assert.equal(harness.action.visibleKeys.has(instance), false);

    const reply = await post(port, { instance, state: 'red' });

    assert.equal(reply.status, 200);
    assert.equal(reply.json['changed'], true);
    assert.equal(harness.action.latest.get(instance), 'red');
  });

  it('refuses to track more than MAX_TRACKED_INSTANCES instances with 503', async () => {
    const scoped = createHarness();

    await new Promise<void>((resolve) => {
      scoped.server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = scoped.server.address();
    assert.ok(address && typeof address === 'object');
    const scopedPort = address.port;

    try {
      for (let i = 0; i < MAX_TRACKED_INSTANCES; i += 1) {
        assert.equal((await post(scopedPort, { instance: i, state: 'green' })).status, 200);
      }

      assert.equal(scoped.action.latest.size, MAX_TRACKED_INSTANCES);

      const overflow = await post(scopedPort, { instance: 9999, state: 'green' });
      assert.equal(overflow.status, 503);
      assert.equal(overflow.json['ok'], false);

      // An already-tracked instance still works: the cap is a memory bound,
      // not a lockout.
      assert.equal((await post(scopedPort, { instance: 0, state: 'red' })).status, 200);
      // And releasing one slot lets a new client in.
      await scoped.action.markStale(0);
      scoped.action.latest.delete(0);
      assert.equal((await post(scopedPort, { instance: 9999, state: 'green' })).status, 200);
    } finally {
      await scoped.close();
    }
  });

  it('REGRESSION: a concurrent flood for distinct instances cannot exceed MAX_TRACKED_INSTANCES', async () => {
    // The cap used to be checked against `latest`, which is only written once a
    // paint has SETTLED, so the admission test was not atomic with the thing it
    // was bounding. N requests for N distinct instances, all in flight before
    // any paint completes, all passed `canTrack` and `latest` grew to N. The
    // documented memory bound was therefore not a bound at all, and a local
    // process could hold the cap hostage until its flood entries aged out.
    //
    // The admission test and the reservation that backs it now happen in the
    // same synchronous block, before the first `await`, so exactly
    // MAX_TRACKED_INSTANCES distinct instances can be admitted and the rest are
    // refused.
    //
    // The paint PARKS until the whole flood has had its chance to be admitted.
    // That is what makes the test non-vacuous: the stub paint used elsewhere
    // resolves immediately, so each request finished before the next one had
    // even been read and every flood request was admitted strictly one at a
    // time -- which hid the bug entirely. With the paint held open, every
    // request is inside `update` at the same time, which is the only situation
    // the un-atomic cap check ever lost.
    let paintStarts = 0;
    let openGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const paint: PaintFn = () => {
      paintStarts += 1;
      return gate.then(() => 1);
    };

    const scoped = createHarness({ paint });

    await new Promise<void>((resolve) => {
      scoped.server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = scoped.server.address();
    assert.ok(address && typeof address === 'object');
    const scopedPort = address.port;

    const flood = MAX_TRACKED_INSTANCES * 3;

    try {
      const posts = Array.from({ length: flood }, (_, i) =>
        post(scopedPort, { instance: 5000 + i, state: 'red' }),
      );

      // Long enough for every one of the `flood` request bodies to be read and
      // parked inside its paint, which is single-digit milliseconds locally.
      await new Promise((resolve) => setTimeout(resolve, 300));
      openGate();

      const replies = await Promise.all(posts);
      const statuses = replies.map((reply) => reply.status);
      const refused = statuses.filter((status) => status === 503).length;

      assert.ok(
        paintStarts >= MAX_TRACKED_INSTANCES,
        `the paint must have parked at least MAX_TRACKED_INSTANCES requests concurrently, saw ${paintStarts}`,
      );
      assert.equal(
        scoped.action.latest.size,
        MAX_TRACKED_INSTANCES,
        `latest must never exceed the cap under concurrency, got ${scoped.action.latest.size}`,
      );
      assert.equal(
        statuses.filter((status) => status === 200).length,
        MAX_TRACKED_INSTANCES,
        'exactly the cap may be admitted',
      );
      assert.equal(
        refused,
        flood - MAX_TRACKED_INSTANCES,
        'every request over the cap must be refused with a retryable 503',
      );
      assert.deepEqual(
        [...new Set(statuses)].sort(),
        [200, 503],
        `unexpected statuses: ${[...new Set(statuses)].join(', ')}`,
      );

      // The cap is a memory bound, not a lockout: a client that got in still
      // works, and an over-cap client never got a slot to begin with. Snapshotted
      // first -- the requests below mutate `latest` while this loop awaits.
      for (const [instance, state] of [...scoped.action.latest]) {
        assert.equal((await post(scopedPort, { instance, state })).status, 200);
      }
      assert.equal(scoped.action.latest.size, MAX_TRACKED_INSTANCES);
    } finally {
      openGate();
      await scoped.close();
    }
  });

  it('a state POST for a never-seen instance is stamped into lastSeen', async () => {
    // A fresh harness: the tests above deliberately filled the instance cap.
    const scoped = createHarness();

    await new Promise<void>((resolve) => {
      scoped.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = scoped.server.address();
    assert.ok(address && typeof address === 'object');
    const scopedPort = address.port;

    try {
      assert.equal(scoped.lastSeen.has(31337), false);
      const reply = await post(scopedPort, { instance: 31337, state: 'green' });
      assert.equal(reply.status, 200);
      assert.equal(scoped.lastSeen.has(31337), true);
    } finally {
      await scoped.close();
    }
  });
});

describe('the staleness sweeper -- real plugin.ts code on a controlled clock', () => {
  it('forces green and warns after STALE_MS of silence', async () => {
    const harness = createHarness({ fakeClock: true });

    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      const first = await post(port, { instance: 1, state: 'red' });
      assert.equal(first.json['changed'], true);
      assert.equal(harness.action.latest.get(1), 'red');

      // STALE_MS itself is NOT stale: the guard is `now - seen <= STALE_MS`.
      harness.tick(STALE_MS);
      assert.equal(harness.action.latest.get(1), 'red');
      assert.equal(harness.logs.filter((l) => l.level === 'warn').length, 0);

      harness.tick(1);
      assert.equal(harness.action.latest.get(1), undefined, 'the key must be released');
      const warning = harness.logs.find((l) => l.level === 'warn');
      assert.ok(warning, 'the sweeper must log a warning');
      assert.match(warning.message, /has not reported for 6000ms/);
      assert.match(warning.message, /forcing its key to green/);
      assert.equal(harness.lastSeen.has(1), false);

      // It is swept once, not repeatedly: the entry is gone from lastSeen.
      harness.tick(5 * STALE_MS);
      assert.equal(harness.logs.filter((l) => l.level === 'warn').length, 1);
    } finally {
      await harness.close();
    }
  });

  it('a heartbeat inside the window keeps the instance alive', async () => {
    const harness = createHarness({ fakeClock: true });

    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      await post(port, { instance: 2, state: 'red' });
      for (let i = 0; i < 5; i += 1) {
        harness.tick(STALE_MS - 1000);
        await post(port, { instance: 2, state: 'red' });
      }
      assert.equal(harness.action.latest.get(2), 'red');
      assert.equal(harness.logs.filter((l) => l.level === 'warn').length, 0);
    } finally {
      await harness.close();
    }
  });

  it('a request in flight is not swept out from under the client', async () => {
    const harness = createHarness({ fakeClock: true });

    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      await post(port, { instance: 3, state: 'red' });

      // Park a request mid-body: the handler is suspended inside readBody.
      const parked = net.connect(port, '127.0.0.1');
      const parkedHeader =
        `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
        `content-length: 40\r\nConnection: close\r\n\r\n`;
      await new Promise<void>((resolve) => {
        parked.on('error', () => resolve());
        parked.on('connect', () => {
          parked.write(parkedHeader);
          parked.write('{"instance":3,"state":"yel');
          setTimeout(resolve, 30);
        });
      });

      // The sweep runs while that request is mid-flight.
      harness.tick(STALE_MS + 1);
      assert.equal(harness.action.latest.get(3), undefined);
      assert.equal(harness.lastSeen.has(3), false);

      // Finish the parked request: the arrival wins and the deck recovers.
      await new Promise<void>((resolve) => {
        parked.on('error', () => resolve());
        parked.write('low"}\r\n0\r\n\r\n');
        setTimeout(resolve, 60);
      });
      parked.destroy();

      // The client is gone again, so a later sweep is legitimate.
      harness.tick(STALE_MS + 1);
      assert.equal(harness.action.latest.get(3), undefined);
    } finally {
      await harness.close();
    }
  });

  it('re-arming after a sweep repaints, because markStale cleared the dedupe memory', async () => {
    const harness = createHarness({ fakeClock: true });

    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      await post(port, { instance: 4, state: 'red' });
      harness.tick(STALE_MS + 1);
      assert.equal(harness.action.latest.get(4), undefined);

      const back = await post(port, { instance: 4, state: 'red' });
      assert.equal(back.json['changed'], true, 'the key must be repainted, not deduped away');
    } finally {
      await harness.close();
    }
  });

  it('REGRESSION: a request answered 503 is not a heartbeat, so an unservable client goes stale and frees its slot', async () => {
    // The deadlock this pins down. 32 clients fill the cap. Instance 0 is one of
    // them, but its `setImage` write has started failing, so every state it
    // posts is answered 503 and NEVER reaches the deck. It keeps posting all
    // the same.
    //
    // If the liveness stamp were written before the apply, each of those
    // refused requests would refresh `lastSeen[0]`, the sweeper would never see
    // instance 0 as stale, and its cap slot would be held forever -- leaving a
    // brand new client locked out until some OTHER client happened to go
    // silent. The recovery depended on a request that could never be served,
    // so the deadlock sustained itself.
    //
    // The stamp now lands only on the success path, so "no state applied for
    // STALE_MS" is what makes a client stale, whether or not it keeps talking.
    const paint: PaintFn = (instance, state) =>
      instance === 0 && state === 'red'
        ? Promise.reject(new Error('setImage failed'))
        : Promise.resolve(1);

    const harness = createHarness({ fakeClock: true, paint });

    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      for (let i = 0; i < MAX_TRACKED_INSTANCES; i += 1) {
        assert.equal((await post(port, { instance: i, state: 'green' })).status, 200);
      }
      assert.equal(harness.action.latest.size, MAX_TRACKED_INSTANCES);

      // The cap is full, so this brand new client is turned away. It is the one
      // that has to be admitted later for the regression to be caught.
      const refused = await post(port, { instance: 9999, state: 'green' });
      assert.equal(refused.status, 503);
      assert.equal(refused.json['ok'], false);

      // One round of heartbeats: instances 1..31 stay perfectly healthy, and
      // instance 0 keeps posting a state that cannot be applied.
      const beat = async (): Promise<void> => {
        for (let i = 1; i < MAX_TRACKED_INSTANCES; i += 1) {
          assert.equal((await post(port, { instance: i, state: 'green' })).status, 200);
        }

        const stampBefore = harness.lastSeen.get(0);
        const unservable = await post(port, { instance: 0, state: 'red' });

        assert.equal(unservable.status, 503, 'an unappliable state must still be 503');
        assert.equal(unservable.json['ok'], false);
        assert.equal(
          harness.lastSeen.get(0),
          stampBefore,
          'a 503 must not refresh the liveness clock',
        );

        // STALE_MS - 1000: the healthy clients are stamped at `now`, so they
        // survive this sweep. A two-ms margin would be enough to prove the
        // point; the whole of STALE_MS is not.
        harness.tick(STALE_MS - 1000);
      };

      await beat();
      await beat();
      await beat();

      // Instance 0 has had no state applied for well over STALE_MS, so the
      // sweeper reclaims it: its slot is released and its key goes green.
      assert.equal(harness.lastSeen.has(0), false, 'the unservable client must go stale');
      assert.equal(harness.action.latest.has(0), false, 'its cap slot must be released');
      assert.equal(harness.action.latest.size, MAX_TRACKED_INSTANCES - 1);
      assert.equal(
        harness.logs.some(
          (l) => l.level === 'warn' && /Instance 0 has not reported for 6000ms/.test(l.message),
        ),
        true,
        'the sweeper must conclude the unservable client is gone',
      );

      // The deadlock breaks itself: the slot freed by a client whose requests
      // could never be served admits the client that was turned away.
      const admitted = await post(port, { instance: 9999, state: 'green' });
      assert.equal(admitted.status, 200, 'the released slot must admit the refused client');
      assert.equal(admitted.json['ok'], true);
      assert.equal(admitted.json['changed'], true);
      assert.equal(harness.action.latest.get(9999), 'green');
      assert.equal(harness.lastSeen.has(9999), true);
    } finally {
      await harness.close();
    }
  });

  it('REGRESSION: a markStale repaint that throws does not abandon the key red', async () => {
    // `markStale` forgets the state BEFORE it repaints, so a repaint that
    // throws used to leave the instance with nothing tracking it: not in
    // `latest`, not in `lastSeen`, and its key still physically red. Since the
    // client is silent by definition (that is why it was swept), no future
    // request would ever come along to repair it.
    const paints: PaintCall[] = [];
    let greenBroken = true;

    const paint: PaintFn = (instance, state) => {
      paints.push({ instance, state });

      return instance === 1 && state === 'green' && greenBroken
        ? Promise.reject(new Error('setImage failed'))
        : Promise.resolve(1);
    };

    const harness = createHarness({ fakeClock: true, paint });

    await new Promise<void>((resolve) => {
      harness.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = harness.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      const red = await post(port, { instance: 1, state: 'red' });
      assert.equal(red.status, 200);
      assert.deepEqual(paints, [{ instance: 1, state: 'red' }]);

      // First sweep: the green repaint is attempted and fails.
      harness.tick(STALE_MS + 1);
      await settle();

      assert.deepEqual(
        paints,
        [
          { instance: 1, state: 'red' },
          { instance: 1, state: 'green' },
        ],
        'the sweeper must have tried to force the key green',
      );
      assert.equal(harness.action.latest.has(1), false, 'the cap slot is still released');
      assert.match(
        harness.logs.find((l) => l.level === 'error')?.message ?? '',
        /Could not repaint stale instance 1: Error: setImage failed/,
      );
      assert.equal(
        harness.lastSeen.has(1),
        true,
        'a failed repaint must re-arm the instance, not abandon it untracked and ungreen',
      );

      // Second sweep, with the write working again: the retry really repaints.
      greenBroken = false;
      harness.tick(STALE_MS + 1);
      await settle();

      assert.deepEqual(
        paints,
        [
          { instance: 1, state: 'red' },
          { instance: 1, state: 'green' },
          { instance: 1, state: 'green' },
        ],
        'the re-armed instance must be swept again, not left on its last colour',
      );
      assert.equal(harness.lastSeen.has(1), false, 'a successful sweep clears the entry again');
      assert.equal(
        harness.action.chain.chainCount,
        0,
        'a rejected paint must not leave a chain entry behind',
      );
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The REAL manifest.json, as the Stream Deck software actually reads it.
// ---------------------------------------------------------------------------

describe('manifest.json -- Nodejs.Debug, which Stream Deck injects into node argv', () => {
  /** The real file, parsed fresh on every access so a stale read cannot hide a bad edit. */
  function nodejs(): Record<string, unknown> | undefined {
    const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8')) as Record<string, unknown>;
    return manifest['Nodejs'] as Record<string, unknown> | undefined;
  }

  it('the real manifest parses and still declares the node runtime', () => {
    const block = nodejs();
    assert.ok(block, 'manifest.json must keep a Nodejs block');
    assert.equal(typeof block['Version'], 'string');
  });

  it('REGRESSION: Nodejs.Debug is absent, `enabled`, `break`, or real node flags', () => {
    // `Nodejs.Debug` is NOT an enum. Stream Deck splices the value verbatim
    // into `execArgv` immediately before the entry script, so anything that is
    // not a node option is consumed as the ENTRY MODULE PATH. `"Debug":
    // "disabled"` therefore made node try to require a module literally named
    // `disabled` and exit 1 before this bundle was ever evaluated.
    //
    // The shipping configuration is to OMIT the key: `enabled` and `break` both
    // attach a Node inspector, which a normal install does not want.
    const block = nodejs();
    assert.ok(block, 'manifest.json must keep a Nodejs block');

    const hasKey = Object.hasOwn(block, 'Debug');
    if (!hasKey) return;

    const value = block['Debug'];
    assert.equal(
      typeof value,
      'string',
      `Nodejs.Debug must be a string, got ${JSON.stringify(value)}`,
    );

    const debug = value as string;
    const valid =
      debug === 'enabled' || debug === 'break' || debug.trimStart().startsWith('-');

    assert.equal(
      valid,
      true,
      `Nodejs.Debug ${JSON.stringify(debug)} is neither a pre-defined value ` +
        '(`enabled`, `break`) nor a node flag; it would be injected as an ' +
        'argument and could be read as the entry module path',
    );
  });

  it('REGRESSION: Nodejs.Debug is not the invalid value `disabled`', () => {
    const block = nodejs();
    assert.ok(block, 'manifest.json must keep a Nodejs block');
    assert.notEqual(
      block['Debug'],
      'disabled',
      '`disabled` is not a Stream Deck debug value: it is injected into node ' +
        'argv as a bare token, where node reads it as the entry module path ' +
        '(`Cannot find module ...\\disabled`, exit code 1)',
    );
  });
});

// ---------------------------------------------------------------------------
// The generated images. These guard the two causes of "the key shows a grey
// three-circles placeholder":
//   (A) a manifest image path that does not resolve on disk, and
//   (B) an image that is not really a PNG (or the wrong size / not transparent).
// Both fail SILENTLY at runtime -- Stream Deck just keeps the placeholder -- so
// the only place they can be caught is a test that reads the real files.
// ---------------------------------------------------------------------------

/** The `.sdPlugin` root, i.e. the folder the manifest is resolved against. */
const SD_PLUGIN_DIR = path.dirname(MANIFEST_JSON);
const IMGS_DIR = path.join(SD_PLUGIN_DIR, 'imgs');

/** Every `.png` under `imgs/`, as paths relative to that folder. */
function generatedPngs(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.toLowerCase().endsWith('.png')) found.push(rel);
    }
  };
  walk(IMGS_DIR, '');
  return found.sort();
}

type DecodedPng = {
  width: number;
  height: number;
  /** Colour type / bit depth / interlace, asserted to be the RGBA non-interlaced form. */
  colorType: number;
  depth: number;
  interlace: number;
  /** Raw RGBA, `width * height * 4` bytes, top-down. */
  pixels: Buffer;
  /** The raw inflated scanline stream, filter bytes included. */
  raw: Buffer;
};

/**
 * Decodes a PNG that the generator produced: 8-bit RGBA (colour type 6), no
 * interlacing, every scanline filtered with byte 0 (None). This mirrors
 * `generate-images.mjs` exactly, so it both proves the image is decodable and
 * pins the structure the encoder promises.
 */
function decodePng(buf: Buffer): DecodedPng {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    signature,
    'not a PNG: the 8-byte signature is wrong',
  );

  let offset = 8;
  let header: { width: number; height: number; depth: number; colorType: number; interlace: number } | null =
    null;
  const idats: Buffer[] = [];
  const chunkTypes: string[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunkTypes.push(type);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8]!,
        colorType: data[9]!,
        interlace: data[12]!,
      };
    } else if (type === 'IDAT') {
      idats.push(data);
    }

    offset += 12 + length;
  }

  assert.ok(header, 'the PNG has no IHDR chunk');
  assert.equal(chunkTypes[0], 'IHDR', 'IHDR must be the first chunk');
  assert.equal(chunkTypes.at(-1), 'IEND', 'IEND must be the last chunk');
  assert.ok(idats.length > 0, 'the PNG has no IDAT chunk');

  const { width, height, depth, colorType, interlace } = header;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  assert.equal(
    raw.length,
    (stride + 1) * height,
    'the inflated scanline stream has the wrong length',
  );

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    assert.equal(raw[rowStart], 0, `scanline ${y} is not filtered with 0 (None)`);
    raw.copy(pixels, y * stride, rowStart + 1, rowStart + 1 + stride);
  }

  return { width, height, colorType, depth, interlace, pixels, raw };
}

/** The four image paths the real manifest points at, in manifest order. */
function manifestImageRefs(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8')) as {
    Actions: Array<{ Icon?: string; States?: Array<{ Image?: string }> }>;
    CategoryIcon?: string;
    Icon?: string;
  };

  const refs: string[] = [];
  for (const action of manifest.Actions) {
    if (action.Icon) refs.push(action.Icon);
    for (const state of action.States ?? []) {
      if (state.Image) refs.push(state.Image);
    }
  }
  if (manifest.CategoryIcon) refs.push(manifest.CategoryIcon);
  if (manifest.Icon) refs.push(manifest.Icon);
  return refs;
}

describe('the manifest images resolve on disk (a typo must not silently keep the placeholder)', () => {
  it('every image path the manifest references exists as a real file', () => {
    const refs = manifestImageRefs();
    assert.equal(refs.length, 4, 'expected exactly 4 image references in the manifest');

    for (const ref of refs) {
      // The manifest omits the extension; Stream Deck appends `.png`.
      const png = path.join(SD_PLUGIN_DIR, `${ref}.png`);
      assert.ok(existsSync(png), `manifest image "${ref}" does not resolve to ${png}`);
    }
  });

  it('each referenced image also has an @2x twin', () => {
    for (const ref of manifestImageRefs()) {
      const twin = path.join(SD_PLUGIN_DIR, `${ref}@2x.png`);
      assert.ok(existsSync(twin), `manifest image "${ref}" has no @2x twin at ${twin}`);
    }
  });

  it('references the generated traffic-light artwork, not the old Elgato counter template', () => {
    const manifest = readFileSync(MANIFEST_JSON, 'utf8');
    assert.doesNotMatch(manifest, /actions\/counter/, 'the deleted counter template is still referenced');
    assert.match(manifest, /imgs\/actions\/status\/icon/, 'the action icon must be the generated one');
    assert.match(manifest, /imgs\/actions\/status\/green/, 'the default state must be the generated green light');
  });

  it('the manifest still has exactly one unnamed state, so a fresh key is green', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8')) as {
      Actions: Array<{ States?: Array<Record<string, unknown>> }>;
    };
    const states = manifest.Actions[0]?.States ?? [];
    assert.equal(states.length, 1, 'the action must declare exactly one state');
    assert.equal(states[0]?.['Image'], 'imgs/actions/status/green');
    assert.equal(states[0]?.['Name'], undefined, 'the single state must be unnamed (the default)');
  });

  it('the built-in fallback reads the same generated files the manifest uses', () => {
    // `fallbackImage()` must ship a base64 data-URL, not raw SVG: the app
    // silently ignores an unrecognised `setImage` value. Pin both halves.
    assert.doesNotMatch(actionSource, /<svg/, 'fallbackImage must not emit raw SVG markup');
    assert.match(actionSource, /data:image\/png;base64,/);
    assert.match(actionSource, /imgs\/actions\/status\/\$\{state\}\.png/);
  });
});

describe('every generated image is a structurally valid PNG', () => {
  // The exact size each generated file must decode to. Key states are 72/144;
  // the icons are the >= 36px minimum (or 28px for the monochrome category
  // icon, which Elgato's schema requires).
  const EXPECTED: Record<string, { width: number; height: number }> = {
    'actions/status/green.png': { width: 72, height: 72 },
    'actions/status/green@2x.png': { width: 144, height: 144 },
    'actions/status/yellow.png': { width: 72, height: 72 },
    'actions/status/yellow@2x.png': { width: 144, height: 144 },
    'actions/status/red.png': { width: 72, height: 72 },
    'actions/status/red@2x.png': { width: 144, height: 144 },
    'actions/status/icon.png': { width: 72, height: 72 },
    'actions/status/icon@2x.png': { width: 144, height: 144 },
    'plugin/category-icon.png': { width: 28, height: 28 },
    'plugin/category-icon@2x.png': { width: 56, height: 56 },
    'plugin/marketplace.png': { width: 512, height: 512 },
    'plugin/marketplace@2x.png': { width: 1024, height: 1024 },
  };

  it('the expected set of files is exactly what the generator produced', () => {
    assert.deepEqual(generatedPngs(), Object.keys(EXPECTED).sort());
  });

  for (const [rel, size] of Object.entries(EXPECTED)) {
    it(`${rel} is a valid ${size.width}x${size.height} RGBA PNG`, () => {
      const file = path.join(IMGS_DIR, ...rel.split('/'));
      assert.ok(existsSync(file), `${rel} is missing -- run \`pnpm images\``);

      const bytes = readFileSync(file);
      assert.ok(bytes.length > 100, `${rel} is only ${bytes.length} bytes: suspiciously empty`);

      const png = decodePng(bytes);
      assert.equal(png.depth, 8, `${rel} must be 8-bit`);
      assert.equal(png.colorType, 6, `${rel} must be colour type 6 (RGBA)`);
      assert.equal(png.interlace, 0, `${rel} must not be interlaced`);
      assert.equal(png.width, size.width, `${rel} has the wrong width`);
      assert.equal(png.height, size.height, `${rel} has the wrong height`);
    });
  }

  it('the action icon is at least the 36x36 minimum (never the old 20x20 plus sign)', () => {
    for (const rel of ['actions/status/icon.png', 'actions/status/icon@2x.png']) {
      const png = decodePng(readFileSync(path.join(IMGS_DIR, ...rel.split('/'))));
      assert.ok(
        png.width >= 36 && png.height >= 36,
        `${rel} is ${png.width}x${png.height}, below the 36px action-icon minimum`,
      );
    }
  });

  it('the category icon is a transparent-background monochrome icon', () => {
    for (const rel of ['plugin/category-icon.png', 'plugin/category-icon@2x.png']) {
      const png = decodePng(readFileSync(path.join(IMGS_DIR, ...rel.split('/'))));

      // Every corner must be fully transparent -- no opaque background box.
      const corners: Array<[number, number]> = [
        [0, 0],
        [png.width - 1, 0],
        [0, png.height - 1],
        [png.width - 1, png.height - 1],
      ];
      for (const [x, y] of corners) {
        const alpha = png.pixels[(y * png.width + x) * 4 + 3];
        assert.equal(alpha, 0, `${rel} corner (${x},${y}) is not fully transparent (alpha ${alpha})`);
      }

      // ...and there must be a genuinely opaque WHITE pixel: flat #FFFFFF, not
      // a colour and not a semi-transparent tint.
      let opaqueWhite = 0;
      for (let i = 0; i < png.width * png.height; i += 1) {
        const o = i * 4;
        const [r, g, b, a] = [png.pixels[o], png.pixels[o + 1], png.pixels[o + 2], png.pixels[o + 3]];
        if (r === 255 && g === 255 && b === 255 && a === 255) opaqueWhite += 1;
      }
      assert.ok(opaqueWhite > 0, `${rel} has no fully opaque white pixel: it is not a white glyph`);
    }
  });
});

