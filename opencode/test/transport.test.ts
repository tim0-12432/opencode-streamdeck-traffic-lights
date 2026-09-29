/**
 * Regression tests for the OpenCode half of the traffic-light plugin.
 * Zero test-framework dependencies: Node's built-in `node:test` runner only.
 * Run with `pnpm test` (compile, then `node --test`).
 *
 * WHAT IS REALLY EXERCISED (nothing here is a hand-written stand-in unless
 * explicitly flagged):
 *
 *  1. `shared/contract.ts`  -- imported as a real ES module.
 *  2. `opencode/src/plugin/state.ts`      -- imported as a real ES module.
 *  3. `opencode/src/plugin/transport.ts`  -- the REAL file, read from disk and
 *     executed. It cannot be imported directly because this runner transpiles a
 *     SINGLE file at a time, so its own imports are satisfied by the `require`
 *     shim below. The source is transpiled to CommonJS with the TypeScript
 *     compiler that is
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
const CONTRACT_TS = path.join(REPO_ROOT, 'shared', 'contract.ts');
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

const CONTRACT_ID = '../../../shared/contract.js';

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
  './transport.js': transportModule,
  './state.js': state,
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

/**
 * The event hook is now COALESCED: it arms a zero-delay timer rather than
 * beating inline, so a beat only happens once `flushTimers()` runs. Every helper
 * that used to mean "dispatch this event and let the beat land" has to say so.
 */
async function drain(): Promise<void> {
  stubs().flushTimers();
  await settle();
}

const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;

/** Everything the stubbed timer API saw, so coalescing is observable. */
type TimerLog = {
  /** Every `setTimeout` call, in issue order. */
  armed: Array<{ ms: number }>;
  /** How many of those were cleared before firing. */
  cleared: number;
  /** How many of those actually ran. */
  fired: number;
};

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
  /** The `setTimeout` / `clearTimeout` traffic, which is the coalescer itself. */
  timers: TimerLog;
  /** Runs every deferred zero-delay timer once, oldest first. */
  flushTimers: () => void;
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
  const timers: TimerLog = { armed: [], cleared: 0, fired: 0 };
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

  // The coalescing timer is the code under test here, so it is RECORDED rather
  // than run behind the test's back: arming, clearing and firing all have to be
  // observable for the burst tests to mean anything.
  //
  // Only ZERO-delay timers are deferred. `dispose`'s flush guard is 300ms and
  // genuinely has to elapse for that test to mean anything, so anything with a
  // non-zero delay is handed straight to the real timer.
  const pendingZero: Array<{ id: number; fire: () => void }> = [];
  let handleSeq = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number) => {
    handleSeq += 1;
    const id = handleSeq;
    timers.armed.push({ ms: ms ?? 0 });

    // Non-zero delays are handed straight to the real timer: `dispose`'s flush
    // guard is 300ms and genuinely has to elapse for that test to mean
    // anything.
    if ((ms ?? 0) !== 0) {
      return realSetTimeout(callback as () => void, ms) as unknown as NodeJS.Timeout;
    }

    const handle = { id, unref: () => undefined } as unknown as NodeJS.Timeout;
    pendingZero.push({
      id,
      fire: () => {
        timers.fired += 1;
        callback();
      },
    });
    return handle;
  }) as unknown as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle?: unknown) => {
    timers.cleared += 1;
    const id = (handle as { id?: number } | undefined)?.id;
    if (id === undefined) {
      realClearTimeout(handle as NodeJS.Timeout);
      return;
    }
    // Dropping a pending zero-delay timer by id is precisely the coalescing
    // behaviour under test: the previous one must not fire.
    const index = pendingZero.findIndex((entry) => entry.id === id);
    if (index >= 0) pendingZero.splice(index, 1);
  }) as unknown as typeof globalThis.clearTimeout;


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
    timers,
    setRespond: (respond) => {
      release = respond;
    },
    advance: (ms) => {
      now += ms;
    },
    /** Runs every deferred zero-delay timer once, oldest first. */
    flushTimers: () => {
      for (const entry of pendingZero.splice(0)) entry.fire();
    },
    restore: () => {
      realClearInterval(keepAlive);
      globalThis.fetch = realFetch;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
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
    // `shared/contract.ts` is consumed as raw TypeScript by BOTH
    // sides, so it must stay dependency-free. The file is read from disk, not
    // imported.
    const source = readFileSync(path.join(CONTRACT_TS), 'utf8');
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
      messages: new Set<string>(['msg_1', 'msg_2']),
      hasAssistantMessage: true,
      lastSeen: 42,
    };
    const before = {
      status: record.status,
      pending: [...record.pending],
      error: record.error,
      active: record.active,
      messages: [...record.messages],
      hasAssistantMessage: record.hasAssistantMessage,
      lastSeen: record.lastSeen,
    };

    perSession(record);
    aggregate([perSession(record)]);
    derive([record, record]);

    assert.equal(record.status, before.status);
    assert.deepEqual([...record.pending], before.pending);
    assert.equal(record.error, before.error);
    assert.equal(record.active, before.active);
    assert.deepEqual([...record.messages], before.messages, 'the id set must not be written');
    assert.equal(record.hasAssistantMessage, before.hasAssistantMessage);
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

/**
 * A real `ToolPart` update, including the `messageID` that EVERY `Part` variant
 * in the SDK carries. That field is load-bearing: it is the only evidence the
 * pump has that the session is not empty, and it is what makes the
 * "no messages -> green" parity rule safe to sit above `active`.
 */
function toolPart(
  sessionID: string,
  status: 'pending' | 'running' | 'error' | 'completed',
  messageID = 'msg_1',
) {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `prt_${sessionID}`,
        sessionID,
        messageID,
        type: 'tool',
        callID: `call_${sessionID}`,
        tool: 'bash',
        state: { status },
      },
    },
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

/**
 * A real `EventMessageUpdated`. This is the ONLY event that carries a role, and
 * it is what makes the reference's "no assistant message yet -> yellow" rule
 * implementable against SDK 1.18.32 rather than guessed at.
 */
function messageEvent(
  sessionID: string,
  role: 'user' | 'assistant',
  id = role === 'user' ? 'msg_user' : 'msg_1',
) {
  return {
    type: 'message.updated',
    properties: { info: { id, sessionID, role } },
  };
}

/** The two `message.updated` events of a session that has already talked. */
async function talk(hooks: PluginHooks, sessionID: string): Promise<void> {
  await send(hooks, messageEvent(sessionID, 'user'));
  await send(hooks, messageEvent(sessionID, 'assistant'));
}



async function send(hooks: PluginHooks, event: unknown): Promise<void> {
  await hooks.event({ event });
  await drain();
}

/** Dispatches without letting the coalesced beat fire, for burst tests. */
async function arm(hooks: PluginHooks, events: readonly unknown[]): Promise<void> {
  for (const event of events) {
    // The hook body is synchronous, so the timer is armed before this awaits
    // anything: a whole burst lands inside one tick.
    await hooks.event({ event });
  }
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
      /^\[opencode-streamdeck-traffic-lights\] traffic light active -> http:\/\/127\.0\.0\.1:8765\/state as instance 1$/,
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

  it('FIX 2: a tool `error` part (an interrupt) is NOT a session error', async () => {
    // The old assertion here was `toolPart('error') -> red`. That encoded the
    // bug: pressing ESC arrives as `state.status === 'error'`, and marking it
    // painted the key red until ERROR_TTL_MS expired -- because `setStatus`
    // deliberately does not clear `error` on idle, and an interrupt is
    // normally followed immediately by `session.idle`. The reference
    // implementation has no error concept at all: a tool that is not running
    // is simply not in its active set. The assertion is INVERTED, not deleted.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red', 'sanity: a running tool is red');

    await send(hooks, toolPart('ses_1', 'error'));
    assert.notEqual(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'an interrupted tool must not be reported as a failure',
    );

    // And the idle that follows an interrupt must really turn it green. Under
    // the old behaviour it stayed red for the whole ERROR_TTL_MS window.
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'an interrupt must end green, not linger red',
    );

    // Only `session.error` -- a provider/API failure -- still raises the flag.
    await send(hooks, { type: 'session.error', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await hooks.dispose();
  });

  it('FIX 2: a tool error still clears nothing and raises nothing -- proven through the TTL', async () => {
    // A tool `error` must not stamp `errorAt` either. If it did, the flag would
    // be invisible until ERROR_TTL_MS anyway; the sharper proof is that the
    // session goes green on `session.idle` immediately, which the test above
    // already asserts. Here we pin the reverse: `session.error` is bounded by
    // ERROR_TTL_MS and nothing else.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, toolPart('ses_1', 'error'));
    assert.notEqual(stubs().calls[stubs().calls.length - 1].state, 'red');

    // A heartbeat must not turn a tool error red either.
    stubs().advance(HEARTBEAT_MS * 3);
    tick();
    await drain();
    assert.notEqual(stubs().calls[stubs().calls.length - 1].state, 'red');

    await hooks.dispose();
  });

  it('warns instead of poisoning every session when an error has no sessionID', async () => {
    // The old `else` branch stamped `error` on all known sessions, and those
    // sessions never receive an event that clears the flag, so each stayed
    // yellow. Under the new mapping the same bug would leave them all RED.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, messageEvent('ses_1', 'user'));
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
// The colour mapping itself: the eight ordered rules, driven through the REAL
// event pump rather than hand-built records, so the two halves -- the pure
// decision function and the state that feeds it -- are covered together.
// ---------------------------------------------------------------------------

describe('perSession() -- the ordered rules', () => {
  // The default is a session that HAS a conversation (one message, at least one
  // of them from the assistant). That is what the other six rules are written
  // about; the two new message rules are asserted below with the fields
  // explicitly emptied.
  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      status: 'idle',
      pending: new Set<string>(),
      error: false,
      active: false,
      messages: new Set<string>(['msg_1']),
      hasAssistantMessage: true,
      lastSeen: 0,
      ...overrides,
    };
  }

  const noMessages = { messages: new Set<string>(), hasAssistantMessage: false };
  const onlyUser = {
    messages: new Set<string>(['msg_1']),
    hasAssistantMessage: false,
  };

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

  it('rule 4 (NEW, parity): a session with no messages at all is GREEN', () => {
    // Straight from the reference implementation, which returns green for a
    // session whose message list is empty however the provider labelled it.
    // This is the "fresh session" rule, and it is why the rule order matters.
    assert.equal(perSession(record({ status: 'busy', ...noMessages })), 'green');
    assert.equal(perSession(record({ status: 'retry', ...noMessages })), 'green');
    // It still yields to an error (rule 1) and to a pending prompt (rule 2),
    // which are both earlier.
    assert.equal(perSession(record({ status: 'busy', error: true, ...noMessages })), 'red');
    assert.equal(
      perSession(record({ status: 'busy', pending: new Set(['p1']), ...noMessages })),
      'green',
    );
  });

  it('rule 5: active is red -- a tool running, or text streaming', () => {
    assert.equal(perSession(record({ status: 'busy', active: true })), 'red');
    assert.equal(perSession(record({ status: 'retry', active: true })), 'red');
  });

  it('rule 5 SAFETY: a busy session with an active tool is RED, never the green of rule 4', () => {
    // The one failure mode that would make rule 4 dangerous: if message
    // tracking were ever unreliable, a genuinely working session could be
    // painted green. A session can only be `active` by way of a part, and
    // every part carries the id of the message it belongs to, so the two
    // states cannot disagree. Asserted here as a property of the RECORDS, and
    // end to end through the real event pump in
    // `plugin: the message rules are safe`.
    const working = record({ status: 'busy', active: true });
    assert.equal(working.messages.size, 1);
    assert.equal(perSession(working), 'red');

    // And the converse, which is what would actually be broken if the pump
    // forgot to register the message: same signals, empty message set.
    assert.equal(perSession(record({ status: 'busy', active: true, ...noMessages })), 'green');
  });

  it('rule 6 (NEW, parity): a busy session with no assistant message yet is YELLOW', () => {
    // The user's own prompt has been seen, the model has not answered: the
    // session is working, it is just not doing anything we can see yet.
    assert.equal(perSession(record({ status: 'busy', ...onlyUser })), 'yellow');
    assert.equal(perSession(record({ status: 'retry', ...onlyUser })), 'yellow');
    // It ranks BELOW `active`: a tool running before the first assistant
    // message is complete is still red.
    assert.equal(perSession(record({ status: 'busy', active: true, ...onlyUser })), 'red');
  });

  it('rule 7: busy or retry with nothing running is yellow (thinking)', () => {
    assert.equal(perSession(record({ status: 'busy' })), 'yellow');
    assert.equal(perSession(record({ status: 'retry' })), 'yellow');
  });

  it('rule 8: the fallthrough is green', () => {
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

    await talk(hooks, 'ses_1');
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

    // The prompt parks the turn on a session that has already talked.
    await talk(hooks, 'ses_1');
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

    // FIX 3: a `busy` status alone is no longer enough for yellow. A session
    // that has produced no message at all reads GREEN (parity with the
    // reference), so the conversation has to exist before the status means
    // "thinking".
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'a busy session with no messages at all is green (parity rule 4)',
    );

    await talk(hooks, 'ses_1');
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // `retry` is a busy variant: a provider is retrying, no tokens, no tool.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'busy' } } });
    await talk(hooks, 'ses_2');
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // One message-less session on a deck of its own still reads green, even
    // alongside sessions that are merely thinking. (Asserted on a deck of its
    // own: `aggregate` takes the severity maximum, so a yellow sibling would
    // mask the green -- the per-session reading is pinned in the pure tests.)
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_2' } });
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_3', status: { type: 'busy' } } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'a message-less session is green, not yellow',
    );

    await hooks.dispose();
  });

  it('a busy session with NO assistant message yet is yellow (parity rule 6)', async () => {
    // The user has pressed enter, the model has not said anything yet. That is
    // working-in-progress, not a failure and not at rest: yellow.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, messageEvent('ses_1', 'user'));
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'yellow',
      'a session with only a user message is thinking, not green',
    );

    // And once the assistant does answer, the same record shape is unchanged --
    // which is the point: the rule keys off the assistant message, not off
    // anything a part did.
    await send(hooks, messageEvent('ses_1', 'assistant'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    await hooks.dispose();
  });

  it('a busy session with an ACTIVE TOOL is red, never the green of parity rule 4', async () => {
    // The safety case for FIX 3. Rule 4 ("no messages -> green") sits ABOVE
    // `active`, so the only thing standing between a working session and a
    // wrongly green key is that a part event registers the message id the part
    // carries. If that wiring were ever lost, THIS test would go green.
    //
    // Real OpenCode event order: the status flips to busy, then the assistant
    // starts streaming and calls a tool.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'green',
      'sanity: nothing has been said yet',
    );

    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'a tool part carries its messageID, so the session is not message-less',
    );

    // The same for a streaming text part, which is the other way a session
    // becomes `active`.
    await send(hooks, textPart('ses_1', { id: 'prt_text', messageID: 'msg_2' }));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // And for a SECOND session, so a cross-session green cannot hide behind a
    // red one.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'busy' } } });
    await send(hooks, toolPart('ses_2', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await hooks.dispose();
  });

  it('FIX 1: a COMPLETED tool part does not change the session status (no green flash)', async () => {
    // The reported bug. The tool branch used to write `record.status = 'idle'`
    // on completion, and `perSession` checks `status === 'idle'` BEFORE
    // `active`, so the key flashed green every single time a tool finished --
    // several times a turn, while the agent was demonstrably still working.
    //
    // The status belongs to the session lifecycle events and nothing else.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    // The real order OpenCode emits for a turn.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await talk(hooks, 'ses_1');
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow', 'sanity: thinking');

    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // The tool finishes. Before FIX 1 this turned GREEN; the session is still
    // busy, still working, and only `session.idle` may say otherwise.
    await send(hooks, toolPart('ses_1', 'completed'));
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'yellow',
      'a completed tool must not declare the session idle',
    );

    // Nor may a pending/running part. Both directions of the same bug.
    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');
    await send(hooks, toolPart('ses_1', 'completed'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // Only the lifecycle event ends the turn.
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('FIX 1: the whole reported turn never flashes green', async () => {
    // Scenario A, end to end through the real pump. Every colour is asserted
    // at every step, so a single regression anywhere in the chain fails here.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    const step = async (event: unknown, expected: string, why: string): Promise<void> => {
      await send(hooks, event);
      const actual = stubs().calls[stubs().calls.length - 1].state;
      assert.equal(actual, expected, `${why}: expected ${expected}, got ${actual}`);
    };

    // The real order OpenCode emits for a turn: the user's message is created,
    // the session flips to busy, the assistant starts replying, tools run, and
    // the turn ends with `session.idle`. (The first `message.updated` is what
    // takes the session out of parity rule 4 -- a session with no messages at
    // all is genuinely green.)
    await step(messageEvent('ses_1', 'user'), 'green', 'the session is idle with only a message');
    await step(messageEvent('ses_1', 'assistant'), 'green', 'still idle');
    await step(
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      'yellow',
      'the turn has started: thinking',
    );
    await step(toolPart('ses_1', 'running'), 'red', 'a tool is running');
    await step(toolPart('ses_1', 'completed'), 'yellow', 'the tool finished, the turn did not');
    await step(textPart('ses_1'), 'red', 'text is streaming');
    await step(toolPart('ses_1', 'running'), 'red', 'a tool is running again');
    // Still red rather than yellow: the TEXT window from two steps ago is
    // still open (ACTIVITY_TTL_MS), and text streaming is work in progress.
    // The point of the step is that it is not GREEN.
    await step(toolPart('ses_1', 'completed'), 'red', 'that tool finished too, text is still streaming');
    await step({ type: 'session.idle', properties: { sessionID: 'ses_1' } }, 'green', 'the turn is over');

    // Not green at ANY point from the `busy` onwards until the final idle.
    // Scanned rather than only per-step asserted, so the claim survives a
    // future step being added to the trace. Index 0 is the startup beat, and
    // the first three steps are legitimately green (the session is still idle);
    // the window that must stay clear of green is the whole turn.
    const seen = stubs().calls.map((call) => call.state);
    const turn = seen.slice(4);
    assert.equal(
      turn.filter((colour) => colour === 'green').length,
      1,
      `exactly one green across the turn (the final idle), got ${turn.join(', ')}`,
    );
    assert.equal(turn.at(-1), 'green', `the turn must end green, got ${turn.join(', ')}`);
    assert.notEqual(turn[turn.length - 2], 'green', 'the second-to-last step must not be green');

    await hooks.dispose();
  });

  it('FIX 2: an interrupt ends the turn green, never red', async () => {
    // Scenario B: ESC during a tool. `state.status === 'error'` on a tool part
    // is an INTERRUPTION, not a failure, and the reference implementation has
    // no error concept for it at all. The sequence must never contain a red
    // after the tool stopped running.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    const step = async (event: unknown, expected: string, why: string): Promise<void> => {
      await send(hooks, event);
      const actual = stubs().calls[stubs().calls.length - 1].state;
      assert.equal(actual, expected, `${why}: expected ${expected}, got ${actual}`);
    };

    await step(
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      'green',
      'nothing has been said yet',
    );
    await step(toolPart('ses_1', 'running'), 'red', 'a tool is running');
    await step(toolPart('ses_1', 'error'), 'yellow', 'ESC interrupted it: not a failure');
    await step({ type: 'session.idle', properties: { sessionID: 'ses_1' } }, 'green', 'the turn is over');

    // The one red in the trace is the legitimately-running tool. Nothing after
    // the interrupt is red, and the error TTL never comes into it. The startup
    // beat is excluded: it precedes the turn and is green by definition.
    const seen = stubs().calls.slice(1).map((call) => call.state);
    assert.deepEqual(seen, ['green', 'red', 'yellow', 'green'], `got ${seen.join(', ')}`);

    await hooks.dispose();
  });

  it('session.error still yields red and still survives a following session.idle', async () => {
    // DELIBERATELY UNCHANGED by both fixes. A provider / API failure is a real
    // failure, it is the loudest thing a session can report, and it goes idle
    // immediately afterwards -- so `setStatus` deliberately does not clear the
    // flag, and ERROR_TTL_MS is the only thing that does. This is the test that
    // would fail if FIX 2 had been over-applied to `session.error`.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.error', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'an idle transition must not paper over a provider failure',
    );

    // Only ERROR_TTL_MS clears it.
    stubs().advance(ERROR_TTL_MS + 1);
    tick();
    await drain();
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('a running tool is red, and NO TTL ever downgrades it to thinking', async () => {
    // The whole reason `toolRunning` is separate from `textActive`: a tool
    // like `sleep 60` emits no events while it runs, so a time-based expiry
    // would call a working agent idle for most of a minute.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    // FIX 1: a part event no longer writes the status, so the turn has to be
    // opened by the SESSION event. A bare tool part on a session the pump still
    // believes is idle reads green, and that is correct -- idle is decided
    // before `active` precisely so a stale window cannot resurrect a finished
    // session.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await send(hooks, toolPart('ses_1', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // Well past both ACTIVITY_TTL_MS and a couple of heartbeats, with no
    // further events at all.
    stubs().advance(ACTIVITY_TTL_MS * 6);
    tick();
    await drain();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'a running tool must not decay to yellow just because it is quiet',
    );

    // The tool's own completion is what clears it -- and it clears the WORK, not
    // the status. The turn is still open, so it drops to yellow, not green.
    await send(hooks, toolPart('ses_1', 'completed'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // Only the lifecycle event takes it to green.
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('streaming text is red, then falls back to yellow after ACTIVITY_TTL_MS', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await talk(hooks, 'ses_1');
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow', 'sanity: thinking');

    await send(hooks, textPart('ses_1'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red', 'text streaming is red');

    stubs().advance(ACTIVITY_TTL_MS - 1);
    tick();
    await drain();
    assert.equal(
      stubs().calls[stubs().calls.length - 1].state,
      'red',
      'the activity window must stay open right up to the TTL',
    );

    // The model has gone quiet mid-turn: it is thinking, not working.
    stubs().advance(2);
    tick();
    await drain();
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
    await talk(hooks, 'ses_1');
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
    await talk(hooks, 'ses_1');
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // FIX 1: the second session's turn has to be opened by a session event too,
    // because a part event no longer writes the status.
    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'busy' } } });
    await send(hooks, toolPart('ses_2', 'running'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // The first session is still thinking, but red wins.
    stubs().advance(ACTIVITY_TTL_MS + 1);
    tick();
    await drain();
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    // Both quiet again -> the deck drops back to yellow, not to green. The
    // second session is still `busy` (FIX 1), it has just stopped working.
    await send(hooks, toolPart('ses_2', 'completed'));
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'yellow');

    // ...and to green once nothing is left, which now needs BOTH turns closed.
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
    await send(hooks, { type: 'session.idle', properties: { sessionID: 'ses_2' } });
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('session.deleted drops every per-session signal', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    await send(hooks, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
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
    await drain();
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
    // `session.status`: a busy session with no tool and no text is yellow
    // (thinking), and this test is about the red-then-green drain ordering, so
    // it needs a genuine red. `session.status busy` has to come first, because
    // a part event no longer writes the status -- that is FIX 1.
    const gate = deferred();
    stubs().setRespond(() => gate.promise);
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    await hooks.event({ event: toolPart('ses_1', 'running') });
    await drain();
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

  it('schedules a coalesced beat after every event, not an inline one', () => {
    // FIX 4: the hook now arms a zero-delay timer instead of beating inline.
    // Still synchronous to RETURN -- `setTimeout` blocks nothing -- so the
    // "no await in the event hook" guarantee above is unchanged.
    assert.match(EVENT_HOOK_BODY, /\n\s*scheduleBeat\(\);\n/);
    assert.doesNotMatch(EVENT_HOOK_BODY, /\n\s*beat\(\);\n/);
  });

  it('the heartbeat sweep still beats INLINE -- a sweep is not a burst', () => {
    // Coalescing is for events only. The `setInterval` callback is a different
    // function in a different closure, so the two can never be confused; this
    // asserts the sweep is not routed through the coalescer.
    assert.match(pluginSource, /const timer = setInterval\(\(\) => \{\s*expire\(\);\s*prune\(\);\s*beat\(\);/);
  });

  it('unrefs the coalescing timer and clears it in dispose', async () => {
    // Both halves matter: without the unref a pending beat would keep the
    // OpenCode process alive for one extra tick, and without the clear a beat
    // could be armed during shutdown.
    assert.match(pluginSource, /coalesceTimer = setTimeout\([\s\S]*?\}, 0\);[\s\S]*?coalesceTimer\.unref\(\);/);
    assert.match(
      pluginSource,
      /dispose: async \(\) => \{[\s\S]*?if \(coalesceTimer !== undefined\) \{\s*clearTimeout\(coalesceTimer\);/,
    );
  });
});

describe('plugin: FIX 4 -- event bursts are coalesced', () => {
  it('N synchronous events in one tick produce ONE beat', async () => {
    // The reference implementation does exactly this: clear the pending timer,
    // arm a fresh zero-delay one. A turn emits a long run of
    // `message.part.updated` events, and without coalescing each one ran a full
    // O(sessions) derivation.
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    const burst = [
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      messageEvent('ses_1', 'user'),
      messageEvent('ses_1', 'assistant'),
      toolPart('ses_1', 'running'),
      textPart('ses_1'),
      toolPart('ses_1', 'completed'),
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ];

    const before = {
      calls: stubs().calls.length,
      armed: stubs().timers.armed.length,
      fired: stubs().timers.fired,
    };

    await arm(hooks, burst);

    // Every event armed a timer, and every one but the last cleared the
    // previous: N-1 clears for N events.
    assert.equal(
      stubs().timers.armed.length - before.armed,
      burst.length,
      'every event must arm the coalescing timer',
    );
    assert.equal(
      stubs().timers.cleared,
      burst.length - 1,
      'every event but the last must clear the pending one',
    );
    assert.equal(stubs().timers.fired, before.fired, 'no timer may fire inside the burst');
    assert.equal(
      stubs().calls.length,
      before.calls,
      'a burst must put nothing on the wire until the timer runs',
    );

    // One timer survives the burst, and it produces exactly one beat.
    await drain();
    assert.equal(stubs().timers.fired, before.fired + 1, 'the burst must collapse to one beat');
    assert.equal(
      stubs().calls.length,
      before.calls + 1,
      'one POST for the whole burst',
    );
    // ...carrying the FINAL state, not an intermediate one.
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'green');

    await hooks.dispose();
  });

  it('a single event still beats promptly, on the very next turn', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    const before = stubs().calls.length;
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    await hooks.event({ event: toolPart('ses_1', 'running') });

    // Nothing yet: the beat is queued, not run inline.
    assert.equal(stubs().calls.length, before);

    // One drain is enough. The timer is zero-delay, so the beat is prompt
    // rather than deferred to the next HEARTBEAT_MS sweep.
    await drain();
    assert.equal(stubs().calls.length, before + 1);
    assert.equal(stubs().calls[stubs().calls.length - 1].state, 'red');

    await hooks.dispose();
  });

  it('the FIRST beat is synchronous -- the plugin does not wait a tick to prove it is alive', async () => {
    active = installStubs();
    const client = createClientStub();

    const hooks = await pluginModule.StreamDeckStatus({ client: client.client });

    // No `settle()` and no `flushTimers()`: the startup beat must already be on
    // the wire, because the deck has to learn the plugin is alive without
    // another turn of the event loop.
    assert.equal(stubs().calls.length, 1, 'the startup beat is synchronous');
    assert.equal(stubs().calls[0].state, 'green');

    await settle();
    await hooks.dispose();
  });

  it('a pending coalesced beat is dropped by dispose', async () => {
    active = installStubs();
    const client = createClientStub();
    const hooks = await startPlugin(client);

    // Arm without draining.
    await hooks.event({ event: toolPart('ses_1', 'running') });
    const firedBefore = stubs().timers.fired;

    await hooks.dispose();

    // The flush timer is what fires here, not a beat: `dispose` cleared the
    // coalescer first.
    assert.equal(stubs().timers.fired, firedBefore, 'dispose must clear the pending coalesced beat');
    assert.equal(stubs().calls.at(-1)?.state, 'green', 'the final green must still be the last write');
  });
});

afterEach(() => {
  active?.restore();
  active = null;
});
