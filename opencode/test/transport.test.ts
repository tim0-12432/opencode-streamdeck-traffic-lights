/**
 * Regression tests for the OpenCode half of the traffic-light plugin.
 * Zero test-framework dependencies: Node's built-in `node:test` runner only.
 * Run with `pnpm test` (compile, then `node --test`).
 *
 * WHAT IS REALLY EXERCISED (nothing here is a hand-written stand-in unless
 * explicitly flagged):
 *
 *  1. `shared/contract.ts`                -- imported as a real ES module.
 *  2. `opencode/src/plugin/state.ts`      -- imported as a real ES module.
 *  3. `opencode/src/plugin/transport.ts`  -- the REAL file, read from disk and
 *     executed. It cannot be imported directly because it value-imports
 *     `../../../shared/contract` without a file extension, which Node's ESM
 *     resolver rejects for compiled output (Bun and rollup both accept it). So
 *     the source is transpiled to CommonJS with the TypeScript compiler that is
 *     already a devDependency and run in a `new Function` scope whose `require`
 *     is a two-entry shim onto the real `contract` namespace. The backoff
 *     ladder, the `inFlight` guard, the retry gate, the payload shape and the
 *     deadline-vs-failure attribution under test are therefore the real code.
 *  4. `opencode/src/plugin/streamdeck-status.ts` -- loaded the same way, with
 *     the REAL `transport` and `state` modules injected. The `event` switch,
 *     the heartbeat routine, the error TTL, the text-activity TTL, the whole
 *     session -> colour mapping (including the pending-is-green inversion) and
 *     the `dispose` ordering under test are the real code. Only the two edges
 *     are stubbed, and neither can be real here: `fetch` (there is no deck in
 *     this process) and the OpenCode `client` (there is no OpenCode in this
 *     process).

 *
 * Markers are asserted, so a refactor that moves the code out of a sliced
 * region fails loudly instead of silently testing a stale copy.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import * as contract from '../../shared/contract.js';
import * as state from '../src/plugin/state.js';
import { aggregate, derive, perSession } from '../src/plugin/state.js';
import type { SessionRecord } from '../src/plugin/state.js';
import {
  ACTIVITY_TTL_MS,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  ENV_INSTANCE,
  ERROR_TTL_MS,
  HEARTBEAT_MS,
  PERMISSION_TTL_MS,
  REQUEST_TIMEOUT_MS,
  SESSION_TTL_MS,
  stateUrl,
  type State,
} from '../../shared/contract.js';


// ---------------------------------------------------------------------------
// Locating the repository, so the real sources can be read from the compiled
// test (which lives in opencode/test/.build/... and therefore sits three
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
const PLUGIN_TS = path.join(REPO_ROOT, 'opencode', 'src', 'plugin', 'streamdeck-status.ts');
const TRANSPORT_TS = path.join(REPO_ROOT, 'opencode', 'src', 'plugin', 'transport.ts');
const pluginSource = readFileSync(PLUGIN_TS, 'utf8');

/**
 * Marker slice: the body of the `event` hook, from its signature to the
 * `permission.ask` hook. OpenCode AWAITS `event`, so anything `await`-ing in
 * here blocks the whole agent on a loopback POST.
 */
function sliceEventHookBody(source: string): string {
  const from = '    event: async ({ event }: { event: Event }) => {';
  const to = "    'permission.ask': async (input, output) => {";
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `marker not found in ${PLUGIN_TS}: ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `marker not found in ${PLUGIN_TS}: ${JSON.stringify(to)}`);
  return source.slice(start + from.length, end);
}

const EVENT_HOOK_BODY = sliceEventHookBody(pluginSource);

/**
 * Marker slice: everything the factory runs BEFORE it hands `Hooks` back,
 * from the `Plugin` assignment to the fire-and-forget seed dispatch.
 *
 * This region is the one that used to hang OpenCode's startup: the factory is
 * `async`, OpenCode AWAITS it while booting, and the `await client.session
 * .status()` seed inside it aimed a request at the server that was still
 * booting. Response needs startup; startup needs the factory; the factory was
 * waiting on the response.
 */
function sliceFactoryPreamble(source: string): string {
  const from = 'export const StreamDeckStatus: Plugin = async ({ client }) => {';
  const to = '  void seed().catch(() => undefined);';
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `marker not found in ${PLUGIN_TS}: ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `marker not found in ${PLUGIN_TS}: ${JSON.stringify(to)}`);
  return source.slice(start, end + to.length);
}

const FACTORY_PREAMBLE = sliceFactoryPreamble(pluginSource);

// ---------------------------------------------------------------------------
// Loading the real plugin modules.
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogEntry = { level: string; message: string };

type TransportModule = {
  SERVICE: string;
  formatLine(message: string): string;
  createTransport(options: {
    instance: number;
    host: string;
    port: number;
    log: (level: LogLevel, message: string) => void;
  }): Transport;
};

type Transport = {
  beat(state: () => State): void;
  send(state: State): Promise<void>;
  drain(): Promise<void>;
  stop(): void;
  readonly stopped: boolean;
  readonly inFlight: boolean;
};

type PluginHooks = {
  event(input: { event: unknown }): Promise<void>;
  'permission.ask'(
    input: { sessionID: string; id: string },
    output: { status: string },
  ): Promise<void>;
  dispose(): Promise<void>;
};

type PluginModule = {
  StreamDeckStatus: (input: { client: unknown }) => Promise<PluginHooks>;
};

const CONTRACT_ID = '../../../shared/contract';

/** Executes a REAL source file in a `new Function` scope with a `require` shim. */
function loadRealModule<T>(file: string, deps: Record<string, unknown>): T {
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const factory = new Function('exports', 'require', js) as unknown as (
    exports: Record<string, unknown>,
    require: (id: string) => unknown,
  ) => void;

  const moduleExports: Record<string, unknown> = {};
  factory(moduleExports, (id: string) => {
    if (!(id in deps)) {
      throw new Error(`unmapped import ${JSON.stringify(id)} while loading ${file}`);
    }
    return deps[id];
  });

  return moduleExports as T;
}

const transportModule = loadRealModule<TransportModule>(TRANSPORT_TS, {
  [CONTRACT_ID]: contract,
});

const pluginModule = loadRealModule<PluginModule>(PLUGIN_TS, {
  [CONTRACT_ID]: contract,
  './transport': transportModule,
  './state': state,
});

// ---------------------------------------------------------------------------
// Test harness: a stubbed `fetch`, a stubbed clock, and a captured heartbeat.
// ---------------------------------------------------------------------------

type FetchCall = {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  body: string;
  signal: AbortSignal | null | undefined;
  state: State;
};

type FetchResponse = { ok: boolean; status: number; statusText: string };

const OK_RESPONSE: FetchResponse = { ok: true, status: 200, statusText: 'OK' };

type Deferred = {
  /** Resolves with a 200, because a hanging request is the thing under test. */
  promise: Promise<FetchResponse>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FetchResponse>((res, rej) => {
    resolve = () => res(OK_RESPONSE);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending microtask (the whole `.then/.catch/.finally` chain) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realDateNow = Date.now;

type Stubs = {
  /** Every request the transport has issued, in issue order. */
  calls: FetchCall[];
  /** `level` + line for everything the plugin/transport logged. */
  logs: LogEntry[];
  /** The heartbeat callback captured from the (stubbed) `setInterval`. */
  heartbeat: (() => void) | null;
  /** The interval delay the plugin asked for, ms. */
  heartbeatMs: number;
  /** Ordered markers: `'setInterval' | 'clearInterval' | 'post:<state>'`. */
  order: string[];
  /** The fake clock, ms. */
  now: number;
  /** Install the response strategy for every subsequent request. */
  setRespond(respond: (call: FetchCall) => Promise<unknown>): void;
  /** Advance the fake clock by `ms`. */
  advance: (ms: number) => void;
  restore: () => void;
};

function installStubs(): Stubs {
  const calls: FetchCall[] = [];
  const logs: LogEntry[] = [];
  const order: string[] = [];
  let heartbeat: (() => void) | null = null;
  let heartbeatMs = 0;
  let now = 1_700_000_000_000;
  let release: (call: FetchCall) => Promise<unknown> = async () => OK_RESPONSE;

  // The plugin's own heartbeat is unref'd (as it must be in production), and so
  // is the `dispose` flush guard, so with `setInterval` stubbed out there is
  // nothing left holding the loop open and Node would abandon a test that is
  // legitimately waiting on a timer. This ref'd interval is that handle.
  const keepAlive = realSetInterval(() => undefined, 60_000);

  Date.now = () => now;

  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    heartbeat = callback;
    heartbeatMs = ms ?? 0;
    order.push('setInterval');
    // The plugin calls `.unref()` on the handle; there is no real timer here.
    return { unref: () => undefined } as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval;

  globalThis.clearInterval = ((handle?: unknown) => {
    order.push('clearInterval');
    void handle;
  }) as unknown as typeof globalThis.clearInterval;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '')) as { state: State };
    const call: FetchCall = {
      url: String(input),
      method: init?.method,
      contentType: (init?.headers as Record<string, string> | undefined)?.['content-type'],
      body: String(init?.body ?? ''),
      signal: init?.signal,
      state: parsed.state,
    };
    calls.push(call);
    order.push(`post:${parsed.state}`);
    return release(call);
  }) as unknown as typeof globalThis.fetch;

  // `defineProperties`, not `Object.assign`: assign would copy the VALUE of
  // each getter and freeze it at construction time.
  return {
    calls,
    logs,
    order,
    setRespond: (respond) => {
      release = respond;
    },
    advance: (ms) => {
      now += ms;
    },
    restore: () => {
      realClearInterval(keepAlive);
      globalThis.fetch = realFetch;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      Date.now = realDateNow;
    },
    get heartbeat() {
      return heartbeat;
    },
    get heartbeatMs() {
      return heartbeatMs;
    },
    get now() {
      return now;
    },
  };
}

let active: Stubs | null = null;

function stubs(): Stubs {
  assert.ok(active, 'installStubs() must wrap this test');
  return active;
}

function makeTransport(instance = 1): Transport {
  return transportModule.createTransport({
    instance,
    host: '127.0.0.1',
    port: 8765,
    log: (level, message) => {
      stubs().logs.push({ level, message: transportModule.formatLine(message) });
    },
  });
}

// ---------------------------------------------------------------------------
// Contract invariants.
// ---------------------------------------------------------------------------

describe('shared/contract.ts', () => {
  it('keeps REQUEST_TIMEOUT_MS below HEARTBEAT_MS', () => {
    // The request deadline is a CLIENT-side abort, and a beat is sent every
    // HEARTBEAT_MS. If the deadline were >= the interval, a single slow
    // response would swallow the next beat.
    assert.ok(
      REQUEST_TIMEOUT_MS < HEARTBEAT_MS,
      `REQUEST_TIMEOUT_MS (${REQUEST_TIMEOUT_MS}) must be < HEARTBEAT_MS (${HEARTBEAT_MS})`,
    );
  });

  it('gives the request deadline room for one repaint', () => {
    // 700 ms was tight enough that a merely slow `setImage` read as a dead
    // server. This is a regression guard, not a performance target.
    assert.ok(REQUEST_TIMEOUT_MS >= 1500, `REQUEST_TIMEOUT_MS is ${REQUEST_TIMEOUT_MS}`);
  });

  it('keeps the two TTLs ordered the way the sweep relies on', () => {
    // `prune()` relies on PERMISSION_TTL_MS expiring first, and a session must
    // outlive its own error flag so the flag can be read at all.
    assert.ok(PERMISSION_TTL_MS < SESSION_TTL_MS);
    assert.ok(ERROR_TTL_MS < SESSION_TTL_MS);
  });

  it('gives the text-activity window at least one heartbeat to be seen in', () => {
    // `expire()` only runs on the HEARTBEAT_MS sweep, so an activity window
    // shorter than the interval could never be observed as open -- every part
    // would be yellow on the very beat that observed it.
    assert.ok(ACTIVITY_TTL_MS > HEARTBEAT_MS, `${ACTIVITY_TTL_MS} must exceed ${HEARTBEAT_MS}`);
  });


  it('resolves a URL that the transport and the server agree on', () => {
    assert.equal(stateUrl('127.0.0.1', 8765), 'http://127.0.0.1:8765/state');
  });

  it('exposes the instance env var alongside its siblings', () => {
    assert.equal(ENV_INSTANCE, 'OPENCODE_STREAMDECK_INSTANCE');
  });

  it('has zero imports of any kind', () => {
    // `shared/contract.ts` is consumed as raw TypeScript by BOTH sides, so it
    // must stay dependency-free. The file is read from disk, not imported.
    const source = readFileSync(path.join(REPO_ROOT, 'shared', 'contract.ts'), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\s+.*\bfrom\b|require\(/.test(line));
    assert.deepEqual(imports, [], `contract.ts must stay import-free, found: ${imports.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// The decision function must stay a pure function of its input.
// ---------------------------------------------------------------------------

describe('opencode/src/plugin/state.ts is pure', () => {
  const STATE_TS = path.join(REPO_ROOT, 'opencode', 'src', 'plugin', 'state.ts');

  it('imports nothing but one type-only import', () => {
    // A runtime import would drag `contract` (or worse, a Node global) into
    // the one file that has to be a pure function of its records.
    const source = readFileSync(STATE_TS, 'utf8');
    const runtimeImports = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line));
    assert.deepEqual(runtimeImports, [], `state.ts must stay import-free, found: ${runtimeImports.join(', ')}`);

    const typeImports = source.split('\n').filter((line) => /^\s*import\s+type\b/.test(line));
    assert.equal(typeImports.length, 1, `expected exactly one type-only import, found ${typeImports.length}`);
    assert.match(typeImports[0], /shared\/contract/);
  });

  it('holds no clock, no timers and no node globals', () => {
    // Time is the PUMP's job: `expire()` and `Date.now()` live in
    // `streamdeck-status.ts`. If `state.ts` ever read a clock, `perSession`
    // would stop being a function of its argument alone and the whole test
    // suite above would be measuring the machine it ran on.
    const source = readFileSync(STATE_TS, 'utf8');
    for (const forbidden of [
      'Date.now',
      'new Date',
      'setTimeout',
      'setInterval',
      'process.',
      'globalThis',
      'performance.',
      'Math.random',
      'fetch(',
      'require(',
    ]) {
      assert.ok(!source.includes(forbidden), `state.ts must not reference ${forbidden}`);
    }
  });

  it('does not mutate the record it is given', () => {
    const record: SessionRecord = {
      status: 'busy',
      pending: new Set<string>(['p1']),
      error: false,
      active: true,
      lastSeen: 42,
    };
    const before = {
      status: record.status,
      pending: [...record.pending],
      error: record.error,
      active: record.active,
      lastSeen: record.lastSeen,
    };

    perSession(record);
    aggregate([perSession(record)]);
    derive([record, record]);

    assert.equal(record.status, before.status);
    assert.deepEqual([...record.pending], before.pending);
    assert.equal(record.error, before.error);
    assert.equal(record.active, before.active);
    assert.equal(record.lastSeen, before.lastSeen);
  });
});

// ---------------------------------------------------------------------------
// Transport: the in-flight guard, the backoff ladder, the retry gate.
// ---------------------------------------------------------------------------


describe('transport: in-flight guard', () => {
  it('caps concurrency at 1 and releases on success', async () => {
    active = installStubs();
    const gate = deferred();
    stubs().setRespond(() => gate.promise);

    const transport = makeTransport();
    for (let i = 0; i < 5; i += 1) transport.beat(() => 'red');

    await settle();
    assert.equal(stubs().calls.length, 1, 'four more beats must not reach the socket');
    assert.equal(transport.inFlight, true);

    gate.resolve();
    await settle();
    assert.equal(transport.inFlight, false);
    assert.equal(stubs().calls.length, 1);

    transport.beat(() => 'red');
    await settle();
    assert.equal(stubs().calls.length, 2, 'the guard must be reusable after a success');
  });

  it('caps concurrency at 1 and releases on rejection', async () => {
    active = installStubs();
    const gate = deferred();
    stubs().setRespond(() => gate.promise);

    const transport = makeTransport();
    for (let i = 0; i < 5; i += 1) transport.beat(() => 'red');
    await settle();
    assert.equal(stubs().calls.length, 1);

    gate.reject(new Error('socket hang up'));
    await settle();
    assert.equal(transport.inFlight, false, 'a rejection must not wedge the transport');

    // Recovered: the ladder is the only thing still holding it back.
    stubs().advance(BACKOFF_MIN_MS);
    transport.beat(() => 'red');
    await settle();
    assert.equal(stubs().calls.length, 2);
  });

  it('never evaluates the state thunk for a suppressed beat', async () => {
    // The derivation is O(sessions) and `beat` runs on every OpenCode event.
    // A thunk means a suppressed beat costs nothing.
    active = installStubs();
    const gate = deferred();
    stubs().setRespond(() => gate.promise);

    const transport = makeTransport();
    let derived = 0;
    const derive = (): State => {
      derived += 1;
      return 'yellow';
    };

    transport.beat(derive);
    for (let i = 0; i < 500; i += 1) transport.beat(derive);
    assert.equal(derived, 1, 'the in-flight short-circuit must precede the derivation');

    gate.resolve();
    await settle();

    // Now force a failure, which is what arms the retry gate.
    stubs().setRespond(() => Promise.reject(new Error('ECONNREFUSED')));
    transport.beat(derive);
    await settle();
    assert.equal(derived, 2);

    const armed = derived;
    for (let i = 0; i < 500; i += 1) transport.beat(derive);
    assert.equal(derived, armed, 'the retry gate must precede the derivation');
  });
});

describe('transport: backoff ladder', () => {
  it('climbs 250 -> ... -> 15000, caps, and resets to 0 on success', async () => {
    active = installStubs();
    stubs().setRespond(() => Promise.reject(new Error('ECONNREFUSED')));

    const transport = makeTransport();
    const expected = [
      BACKOFF_MIN_MS, // 250
      500,
      1000,
      2000,
      4000,
      8000,
      BACKOFF_MAX_MS, // 15000
      BACKOFF_MAX_MS, // capped, not 30000
    ];

    for (const step of expected) {
      const before = stubs().calls.length;
      transport.beat(() => 'red');
      await settle();
      assert.equal(stubs().calls.length, before + 1, 'a beat at the retry instant must be sent');

      // One tick short of the window: suppressed.
      stubs().advance(step - 1);
      transport.beat(() => 'red');
      await settle();
      assert.equal(stubs().calls.length, before + 1, `a beat inside the ${step}ms window must wait`);

      // Exactly at the window: accepted, and this is where the next rung starts.
      stubs().advance(1);
    }

    assert.equal(
      stubs().calls.length,
      expected.length,
      'the ladder must not grow an extra rung past the cap',
    );

    // A success rewinds the ladder to zero, proven by a beat at the same
    // instant being accepted.
    stubs().setRespond(async () => ({ ok: true, status: 200, statusText: 'OK' }));
    const before = stubs().calls.length;
    transport.beat(() => 'green');
    await settle();
    assert.equal(stubs().calls.length, before + 1);
  });

  it('treats a 503 as a failure', async () => {
    active = installStubs();
    stubs().setRespond(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }));

    const transport = makeTransport();
    transport.beat(() => 'red');
    await settle();

    const warn = stubs().logs.find((entry) => entry.level === 'warn');
    assert.ok(warn, 'a 503 must be logged as a warning');
    assert.match(warn.message, /responded 503 Service Unavailable/);
    assert.match(warn.message, new RegExp(`retry in ${BACKOFF_MIN_MS}ms`));

    // ...and the gate is armed, so the ladder really did move.
    const before = stubs().calls.length;
    transport.beat(() => 'red');
    await settle();
    assert.equal(stubs().calls.length, before);
  });

  it('does not spend a backoff step on our own client deadline', async () => {
    active = installStubs();
    const transport = makeTransport();
    stubs().setRespond(() => Promise.reject(new Error('ECONNREFUSED')));

    // Two genuine failures: 250, then 500.
    for (let i = 0; i < 2; i += 1) {
      transport.beat(() => 'red');
      await settle();
      stubs().advance(i === 0 ? BACKOFF_MIN_MS : 500);
    }

    // Now OUR deadline fires, three times. The ladder must hold at 500.
    const deadline = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    stubs().setRespond(() => Promise.reject(deadline));

    for (let i = 0; i < 3; i += 1) {
      transport.beat(() => 'red');
      await settle();
      stubs().advance(500);
    }

    const log = stubs().logs.map((entry) => entry.message).join('\n');
    assert.match(log, /exceeded our own 1500ms client deadline/);
    assert.match(
      log,
      /without backing off further/,
      'a client-side timeout must be attributed as such, not as a server failure',
    );

    // A real failure after three deadlines must take the NEXT rung (1000), not
    // jump several steps.
    stubs().setRespond(() => Promise.reject(new Error('ECONNREFUSED')));
    transport.beat(() => 'red');
    await settle();
    const last = stubs().logs[stubs().logs.length - 1].message;
    assert.match(last, new RegExp(`retry in 1000ms`));
  });
});

describe('transport: request shape', () => {
  it('sends exactly { instance, state, ts, seq } with a strictly increasing seq', async () => {
    active = installStubs();
    const transport = makeTransport(7);
    const states: State[] = ['green', 'yellow', 'red', 'yellow', 'green'];

    for (const colour of states) {
      transport.beat(() => colour);
      await settle();
    }

    assert.equal(stubs().calls.length, states.length);
    const seqs: number[] = [];

    for (const [index, call] of stubs().calls.entries()) {
      const parsed = JSON.parse(call.body) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ['instance', 'seq', 'state', 'ts'],
        'the payload must not grow or lose a field',
      );
      assert.equal(parsed.instance, 7);
      assert.equal(parsed.state, states[index]);
      assert.equal(typeof parsed.ts, 'number');
      seqs.push(parsed.seq as number);
    }

    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i] > seqs[i - 1], `seq must strictly increase: ${seqs.join(', ')}`);
    }
  });

  it('does NOT deduplicate an unchanged state', async () => {
    // The deck dedupes on its own side; deduping here would mean a freshly
    // started deck never learns the current state.
    active = installStubs();
    const transport = makeTransport();
    for (let i = 0; i < 3; i += 1) {
      transport.beat(() => 'red');
      await settle();
    }
    assert.equal(stubs().calls.length, 3);
  });

  it('uses POST, the json content-type, and the contract URL', async () => {
    active = installStubs();
    makeTransport().beat(() => 'red');
    await settle();

    const [call] = stubs().calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.contentType, 'application/json');
    assert.equal(call.url, stateUrl('127.0.0.1', 8765));
  });

  it('attaches an AbortSignal to every request', async () => {
    active = installStubs();
    makeTransport().beat(() => 'red');
    await settle();

    const [call] = stubs().calls;
    assert.ok(call.signal, 'a request without a signal can hang forever');
    assert.equal(typeof call.signal!.aborted, 'boolean');
  });

  it('never blocks or throws out of beat()', async () => {
    active = installStubs();
    stubs().setRespond(() => Promise.reject(new Error('boom')));
    const transport = makeTransport();

    // Synchronous by contract: the OpenCode `event` hook awaits nothing.
    const returned = transport.beat(() => 'red');
    assert.equal(returned, undefined);
    await settle();
    assert.equal(transport.inFlight, false);
  });

  it('stop() is permanent and idempotent, and send() ignores it', async () => {
    active = installStubs();
    const transport = makeTransport();
    transport.stop();
    transport.stop();
    assert.equal(transport.stopped, true);

    transport.beat(() => 'red');
    await settle();
    assert.equal(stubs().calls.length, 0, 'a stopped transport sends no beats');

    // `send` is the one escape hatch `dispose` needs.
    await transport.send('green');
    assert.equal(stubs().calls.length, 1);
    assert.equal(stubs().calls[0].state, 'green');
  });
});

describe('transport: drain', () => {
  it('waits for the in-flight request, and is a no-op when idle', async () => {
    active = installStubs();
    const gate = deferred();
    stubs().setRespond(() => gate.promise);

    const transport = makeTransport();
    await transport.drain();
    assert.equal(stubs().calls.length, 0, 'drain must not send anything of its own');

    transport.beat(() => 'red');
    await settle();

    let drained = false;
    const waiting = transport.drain().then(() => {
      drained = true;
    });
    await settle();
    assert.equal(drained, false, 'drain must not resolve while a request is in flight');

    gate.resolve();
    await waiting;
    assert.equal(drained, true);
    assert.equal(transport.inFlight, false);
  });

  it('resolves even when the in-flight request fails', async () => {
    active = installStubs();
    stubs().setRespond(() => Promise.reject(new Error('ECONNREFUSED')));
    const transport = makeTransport();

    transport.beat(() => 'red');
    await settle();

    await transport.drain();
    assert.equal(transport.inFlight, false);
  });
});

// ---------------------------------------------------------------------------
// The plugin: event handling, the heartbeat sweep, and dispose ordering.
// ---------------------------------------------------------------------------

type ClientStub = {
  logs: LogEntry[];
  client: {
    app: { log(input: { body: LogEntry }): Promise<unknown> };
    session: { status(): Promise<unknown> };
  };
  /** The result tuple `client.session.status()` resolves with. */
  seed: {
    data?: Record<string, { type: string }>;
    error?: unknown;
    throws?: unknown;
    /** Models the boot self-deadlock: the request is issued and NEVER settles. */
    stalls?: boolean;
  };
};

function createClientStub(): ClientStub {
  const stub: ClientStub = {
    logs: [],
    client: {
      app: {
        log(input: { body: LogEntry }) {
          stub.logs.push(input.body);
          return Promise.resolve({ data: true });
        },
      },
      session: {
        status() {
          if (stub.seed.stalls === true) return new Promise<unknown>(() => undefined);
          if (stub.seed.throws !== undefined) return Promise.reject(stub.seed.throws);
          return Promise.resolve({ data: stub.seed.data, error: stub.seed.error });
        },
      },
    },
    seed: {},
  };
  return stub;
}

async function startPlugin(client: ClientStub): Promise<PluginHooks> {
  const hooks = await pluginModule.StreamDeckStatus({ client: client.client });
  // The plugin fires its startup beat as the last thing it does, and that
  // request is still in flight when the promise resolves. Let it land, or
  // every event-driven beat in the test is silently swallowed by the guard.
  await settle();
  return hooks;
}

function toolPart(sessionID: string, status: 'pending' | 'running' | 'error' | 'completed') {
  return {
    type: 'message.part.updated',
    properties: { part: { type: 'tool', sessionID, state: { status } } },
  };
}

/** A real `TextPart` update. `extra` can set `synthetic` / `ignored` / `time`. */
function textPart(sessionID: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'message.part.updated',
    properties: {
      part: { id: `prt_${sessionID}`, type: 'text', sessionID, messageID: 'msg_1', text: 'hi', ...extra },
      delta: 'hi',
    },
  };
}


async function send(hooks: PluginHooks, event: unknown): Promise<void> {
  await hooks.event({ event });
  await settle();
}

/** Drives one heartbeat sweep, i.e. `expire()` + `prune()` + `beat()`. */
function tick(): void {
  assert.ok(stubs().heartbeat, 'the plugin never registered its heartbeat');
  stubs().heartbeat!();
}

describe('plugin: startup', () => {
  it('logs one info line naming the endpoint and instance', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    const info = client.logs.filter((entry) => entry.level === 'info');
    assert.equal(info.length, 1, 'exactly one startup line, so a healthy install is greppable');
    assert.match(
      info[0].message,
      /^\[opencode-traffic-lights\] traffic light active -> http:\/\/127\.0\.0\.1:8765\/state as instance 1$/,
    );

    await hooks.dispose();
  });

  it('reports an HTTP-level seed failure instead of booting silently', async () => {
    // `session.status()` is `ThrowOnError = false`, so a non-2xx RESOLVES with
    // `{ error }`. Checking `data` alone skipped the catch entirely.
    active = installStubs();
    const client = createClientStub();
    client.seed = { data: undefined, error: { name: 'BadRequest', data: { message: 'boom' } } };

    const hooks = await startPlugin(client);
    const warn = client.logs.find((entry) => entry.level === 'warn');
    assert.ok(warn, 'a resolved-with-error seed must still warn');
    assert.match(warn.message, /could not seed session status \(BadRequest: boom\)/);

    await hooks.dispose();
  });

  it('still starts and beats when the seed rejects outright', async () => {
    active = installStubs();
    const client = createClientStub();
    client.seed = { throws: new Error('ECONNREFUSED') };

    const hooks = await startPlugin(client);
    assert.ok(
      client.logs.some((entry) => /could not seed session status \(ECONNREFUSED\)/.test(entry.message)),
    );
    assert.equal(stubs().calls.length, 1, 'the startup beat must still be sent');

    await hooks.dispose();
  });

  it('seeds busy sessions from the server so a restart is not falsely green', async () => {
    active = installStubs();
    const client = createClientStub();
    client.seed = { data: { ses_1: { type: 'busy' } } };

    const hooks = await startPlugin(client);

    // The startup beat goes out green the instant the factory returns -- it does
    // NOT wait for the seed -- and the seed's own beat then corrects it.
    //
    // The correction is YELLOW, not red: the seed teaches us the status and
    // nothing else, so there is no evidence of a tool or a text stream. A
    // busy-but-silent session is exactly "thinking" under the new mapping, and
    // the point of the seed is only to not report a false green.
    assert.equal(stubs().calls[0].state, 'green', 'the startup beat must not wait for the seed');
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await hooks.dispose();
  });

  it('returns Hooks promptly even when the seed request never settles', async () => {
    // THE REGRESSION TEST for the startup hang. `client.session.status()` is
    // modelled as a request that is issued and never resolves, which is exactly
    // what the plugin did to itself during boot: it aimed a request at the
    // server that was still booting it. OpenCode AWAITS the factory, so a
    // factory parked on that request never returns `Hooks`, startup never
    // completes, and the session is a blank screen with no prompt.
    active = installStubs();
    const client = createClientStub();
    client.seed = { stalls: true };

    const startedAt = process.hrtime.bigint();
    const hooks = await pluginModule.StreamDeckStatus({ client: client.client });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.equal(typeof hooks.event, 'function', 'Hooks must be returned, not a pending promise');
    assert.equal(typeof hooks.dispose, 'function');
    // Nothing in the factory does I/O of its own, so it must complete in
    // microtask time. 250ms is ~a million times the real cost.
    assert.ok(elapsedMs < 250, `factory took ${elapsedMs}ms; the seed must not gate plugin load`);

    // The load is complete and observable even though the seed is still parked.
    await settle();
    assert.ok(
      client.logs.some((entry) => /traffic light active/.test(entry.message)),
      'the startup line must be emitted without waiting for the seed',
    );
    assert.equal(stubs().calls.length, 1, 'the startup beat must still be sent');

    await hooks.dispose();
  });
});

describe('plugin: the factory never blocks on the seed', () => {
  it('contains no await between the factory signature and the seed dispatch', () => {
    // The behavioural test above proves the current shape works; this one stops
    // a future edit from quietly reintroducing a top-level `await` -- or worse,
    // an `await seed()` -- which would reintroduce the boot self-deadlock.
    const awaits = FACTORY_PREAMBLE.match(/\bawait\b/g) ?? [];
    assert.deepEqual(awaits, [], 'the factory preamble must not await anything');
  });

  it('dispatches the seed fire-and-forget, with a rejection guard attached', () => {
    assert.match(FACTORY_PREAMBLE, /void seed\(\)\.catch\(/);
  });
});

describe('plugin: heartbeat and error lifetime', () => {
  it('registers a HEARTBEAT_MS interval that expires and prunes', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    assert.equal(stubs().heartbeatMs, HEARTBEAT_MS);

    await send(hooks, {
      type: 'session.status',
      properties: { sessionID: 'ses_x', status: { type: 'idle' } },
    });
    // Nothing to expire: the error is younger than ERROR_TTL_MS.
    stubs().advance(ERROR_TTL_MS - 1);
    tick();
    await settle();
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    stubs().advance(2);
    tick();
    await settle();

    await hooks.dispose();
  });

  it('clears a stale error after ERROR_TTL_MS', async () => {
    // An error is RED, and a failing session goes idle immediately afterwards,
    // so the flag deliberately survives that idle. ERROR_TTL_MS is therefore
    // the only thing that ever clears a fatal ApiError/ProviderAuthError --
    // without it the key would sit red for a session that died minutes ago.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.error', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    stubs().advance(ERROR_TTL_MS - 1);
    tick();
    await settle();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'the flag must survive right up to the TTL',
    );

    stubs().advance(2);
    tick();
    await settle();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'the TTL safety net must clear a stuck error',
    );

    await hooks.dispose();
  });

  it('clears the error on a completed tool part, not just on pending/running', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, toolPart('ses_1', 'error'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await send(hooks, toolPart('ses_1', 'completed'));
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'a recovered turn must not stay red for the rest of the turn',
    );

    await hooks.dispose();
  });

  it('warns instead of poisoning every session when an error has no sessionID', async () => {
    // The old `else` branch stamped `error` on all known sessions, and those
    // sessions never receive an event that clears the flag, so each stayed
    // yellow. Under the new mapping the same bug would leave them all RED.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    const before = stubs().calls.length;
    await send(hooks, { type: 'session.error', properties: {} });

    assert.ok(
      client.logs.some((entry) => /session\.error carried no sessionID/.test(entry.message)),
      'an unattributable error must be visible in the log',
    );
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'yellow',
      'an unattributed error must not recolour unrelated sessions',
    );
    assert.ok(stubs().calls.length > before);

    await hooks.dispose();
  });
});

// ---------------------------------------------------------------------------
// The colour mapping itself: the six ordered rules, driven through the REAL
// event pump rather than hand-built records, so the two halves -- the pure
// decision function and the state that feeds it -- are covered together.
// ---------------------------------------------------------------------------

describe('perSession() -- the six ordered rules', () => {
  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      status: 'idle',
      pending: new Set<string>(),
      error: false,
      active: false,
      lastSeen: 0,
      ...overrides,
    };
  }

  it('rule 1: an error is red, and outranks everything else', () => {
    assert.equal(perSession(record({ error: true })), 'red');
    assert.equal(perSession(record({ status: 'busy', error: true })), 'red');
    assert.equal(perSession(record({ status: 'busy', active: true, error: true })), 'red');
    // Including a pending prompt: the failure is still the loudest thing.
    assert.equal(perSession(record({ status: 'busy', pending: new Set(['p1']), error: true })), 'red');
  });

  it('rule 2: a pending permission is GREEN -- the inversion that matters', () => {
    // Under the previous mapping a prompt outranked the work and read yellow.
    // Now a prompt means the turn is blocked on the user, which is the same
    // at-rest reading as idle.
    assert.equal(perSession(record({ status: 'busy', pending: new Set(['p1']) })), 'green');
    // Even with a stale `active` flag still latched.
    assert.equal(perSession(record({ status: 'busy', active: true, pending: new Set(['p1']) })), 'green');
  });

  it('rule 3: idle is green, and it is decided BEFORE `active`', () => {
    assert.equal(perSession(record()), 'green');
    // A stale tool/text window must never resurrect a finished session.
    assert.equal(perSession(record({ status: 'idle', active: true })), 'green');
  });

  it('rule 4: active is red -- a tool running, or text streaming', () => {
    assert.equal(perSession(record({ status: 'busy', active: true })), 'red');
    assert.equal(perSession(record({ status: 'retry', active: true })), 'red');
  });

  it('rule 5: busy or retry with nothing running is yellow (thinking)', () => {
    assert.equal(perSession(record({ status: 'busy' })), 'yellow');
    assert.equal(perSession(record({ status: 'retry' })), 'yellow');
  });

  it('rule 6: the fallthrough is green', () => {
    assert.equal(perSession(record({ status: 'idle', pending: new Set(['p1', 'p2', 'p3']) })), 'green');
  });

  it('aggregate: red beats yellow beats green', () => {
    assert.equal(aggregate(['green', 'yellow']), 'yellow');
    assert.equal(aggregate(['yellow', 'red']), 'red');
    assert.equal(aggregate(['red', 'yellow']), 'red');
    assert.equal(aggregate(['green', 'red', 'yellow', 'red']), 'red');
    assert.equal(aggregate(['green', 'green']), 'green');
    assert.equal(aggregate([]), 'green');
  });

  it('derive: severity max across sessions', () => {
    const idle = record();
    const thinking = record({ status: 'busy' });
    const working = record({ status: 'busy', active: true });
    const failed = record({ error: true });

    assert.equal(derive([idle, idle]), 'green');
    assert.equal(derive([idle, thinking]), 'yellow');
    assert.equal(derive([thinking, working]), 'red');
    assert.equal(derive([working, failed]), 'red');
    assert.equal(derive([idle, thinking, failed]), 'red');
    assert.equal(derive([]), 'green');
  });
});

describe('plugin: the colour mapping end to end', () => {
  it('idle, nothing pending, not active -> green', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, {
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('a pending permission on a BUSY session is green, not yellow', async () => {
    // The inversion, asserted through the real pump: the prompt outranks the
    // busy status, and the answer is green because "waiting on you" is at rest.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow', 'sanity: busy alone is yellow');

    await send(hooks, {
      type: 'permission.updated',
      properties: { id: 'perm-1', sessionID: 'ses_1', type: 'bash', title: 'rm -rf /' },
    });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'a pending permission must read as at rest',
    );

    // ...and it goes back to yellow the moment it is answered.
    await send(hooks, {
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', permissionID: 'perm-1', response: 'once' },
    });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await hooks.dispose();
  });

  it('a pending permission survives the idle that parks the turn', async () => {
    // OpenCode emits `session.idle` while a prompt waits, so the prompt has to
    // outlive it -- otherwise the light would claim "nothing is waiting on you"
    // at the exact moment you are being asked a question.
    //
    // Proof that is observable through the colour: once the turn picks back up
    // the session reads GREEN if and only if the prompt is still recorded. If
    // the idle transition had dropped it, step 3 would be yellow too.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, {
      type: 'permission.updated',
      properties: { id: 'perm-1', sessionID: 'ses_1', type: 'bash', title: 'deploy' },
    });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'the prompt must still be recorded, so the resumed turn reads as waiting on you',
    );

    await send(hooks, {
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', permissionID: 'perm-1', response: 'once' },
    });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'yellow',
      'once answered, nothing blocks on you any more, so the turn reads as thinking',
    );

    await hooks.dispose();
  });

  it('busy with no tool and no text is yellow', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // `retry` is a busy variant: a provider is retrying, no tokens, no tool.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'busy' } } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await hooks.dispose();
  });

  it('a running tool is red, and NO TTL ever downgrades it to thinking', async () => {
    // The whole reason `toolRunning` is separate from `textActive`: a tool
    // like `sleep 60` emits no events while it runs, so a time-based expiry
    // would call a working agent idle for most of a minute.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // Well past both ACTIVITY_TTL_MS and a couple of heartbeats, with no
    // further events at all.
    stubs().advance(ACTIVITY_TTL_MS * 6);
    tick();
    await settle();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'a running tool must not decay to yellow just because it is quiet',
    );

    // The tool's own completion is what clears it.
    await send(hooks, toolPart('ses_1', 'completed'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('streaming text is red, then falls back to yellow after ACTIVITY_TTL_MS', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await send(hooks, textPart('ses_1'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red', 'text streaming is red');

    stubs().advance(ACTIVITY_TTL_MS - 1);
    tick();
    await settle();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'the activity window must stay open right up to the TTL',
    );

    // The model has gone quiet mid-turn: it is thinking, not working.
    stubs().advance(2);
    tick();
    await settle();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'yellow',
      'a busy session with no output past ACTIVITY_TTL_MS reads as thinking',
    );

    // ...and a further text part re-arms it.
    await send(hooks, textPart('ses_1'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await hooks.dispose();
  });

  it('ignores synthetic and ignored text parts', async () => {
    // Those parts are injected by the SDK / the client, not written by the
    // model. Counting them would paint the key red for a turn that is only
    // narrating.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await send(hooks, textPart('ses_1', { synthetic: true }));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await send(hooks, textPart('ses_1', { ignored: true }));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await hooks.dispose();
  });

  it('an error is red, and SURVIVES the idle that follows a failure', async () => {
    // The deliberate change: `session.idle` no longer clears the error flag.
    // A failure ends the turn, so the idle arrives immediately afterwards; if
    // it cleared the flag, red would be invisible for exactly the failures
    // that matter most.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.error', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'an idle transition must not paper over a failure',
    );

    // A pending prompt is green, but the error still outranks it.
    await send(hooks, {
      type: 'permission.updated',
      properties: { id: 'perm-1', sessionID: 'ses_1', type: 'bash', title: 'rm' },
    });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // Only ERROR_TTL_MS clears it.
    stubs().advance(ERROR_TTL_MS + 1);
    tick();
    await settle();
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('a text part cannot resurrect an idle session', async () => {
    // Rule 3 is checked before rule 4, so a part that arrives after the turn
    // is over cannot paint the key red for a finished session.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, textPart('ses_1'));
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    // Even a fresh text part, with the session still idle.
    await send(hooks, textPart('ses_1'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('aggregate: one red session outranks a yellow one on the same deck', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await send(hooks, toolPart('ses_2', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // The first session is still thinking, but red wins.
    stubs().advance(ACTIVITY_TTL_MS + 1);
    tick();
    await settle();
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // Both quiet again -> the deck drops back to yellow, not to green.
    await send(hooks, toolPart('ses_2', 'completed'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // ...and to green once nothing is left.
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('session.deleted drops every per-session signal', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await send(hooks, { type: 'session.error', properties: { sessionID: 'ses_1' } });
    await send(hooks, textPart('ses_1'));
    await send(hooks, {
      type: 'permission.updated',
      properties: { id: 'perm-1', sessionID: 'ses_1', type: 'bash', title: 'rm' },
    });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await send(hooks, {
      type: 'session.deleted',
      properties: { info: { id: 'ses_1' } },
    });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'a deleted session must leave nothing behind -- not a red from the error, the tool or the text',
    );

    // The error flag really is gone, not just outranked: nothing ages it out
    // early either.
    stubs().advance(ERROR_TTL_MS + 1);
    tick();
    await settle();
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });
});


describe('plugin: dispose ordering', () => {
  it('clears the interval BEFORE the final green, and drains first', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    // The startup beat, sent green.
    await settle();
    assert.deepEqual(stubs().order, ['setInterval', 'post:green']);

    // Now a red goes out and is held on the wire. A TOOL part, not a bare
    // `session.status`: under the new mapping a busy session with no tool and
    // no text is yellow (thinking), and this test is about the red-then-green
    // drain ordering, so it needs a genuine red.
    const gate = deferred();
    stubs().setRespond(() => gate.promise);
    await hooks.event({ event: toolPart('ses_1', 'running') });
    await settle();
    assert.equal(stubs().order[stubs().order.length - 1], 'post:red');


    let disposed = false;
    const disposing = hooks.dispose().then(() => {
      disposed = true;
    });
    await settle();

    assert.ok(
      stubs().order.includes('clearInterval'),
      'the interval must be cleared, or a beat can land after the green',
    );
    assert.equal(
      stubs().calls.filter((call) => call.state === 'green').length,
      1,
      'no green may be issued while the red is still in flight -- that is the drain',
    );
    assert.equal(disposed, false);

    gate.resolve();
    await disposing;

    assert.deepEqual(stubs().order, [
      'setInterval',
      'post:green',
      'post:red',
      'clearInterval',
      'post:green',
    ]);
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');
  });

  it('stops sending before the final green', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);
    await settle();

    const before = stubs().calls.length;
    await hooks.dispose();
    const after = stubs().calls.length;

    // Any further event must not put a byte on the wire.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(stubs().calls.length, after, 'a stopped transport must stay silent');
    assert.ok(after > before);
  });

  it('resolves within the flush bound when the server is unreachable', async () => {
    active = installStubs();
    stubs().setRespond(() => new Promise<unknown>(() => undefined));

    const client = createClientStub();
    const hooks = await startPlugin(client);
    // A beat that will never come back, so `drain()` cannot resolve either.
    await settle();
    assert.equal(stubs().calls.length, 1);

    const startedAt = process.hrtime.bigint();
    await hooks.dispose();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // DISPOSE_FLUSH_MS is 300; anything near it proves the guard fires.
    assert.ok(elapsedMs < 1000, `dispose took ${elapsedMs}ms, expected the flush guard to fire`);
  });
});

describe('plugin: the event hook stays synchronous', () => {
  it('contains zero await tokens', () => {
    // OpenCode AWAITS this hook, so a single awaited loopback POST would stall
    // the agent. The transport is fire-and-forget by construction; this guard
    // keeps it that way.
    const awaits = EVENT_HOOK_BODY.match(/\bawait\b/g) ?? [];
    assert.deepEqual(awaits, [], 'the event hook body must not await anything');
  });

  it('still fires a beat after every event', () => {
    assert.match(EVENT_HOOK_BODY, /\n\s*beat\(\);\n/);
  });
});

afterEach(() => {
  active?.restore();
  active = null;
});
