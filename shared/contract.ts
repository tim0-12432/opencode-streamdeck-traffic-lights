/**
 * Single source of truth for the OpenCode <-> Stream Deck traffic-light wire
 * contract. Imported as raw TypeScript by BOTH consumers:
 *   - opencode/  -> loaded by Bun, no build step
 *   - streamdeck/ -> bundled by rollup
 * Therefore: zero imports, zero runtime deps, types + pure functions only.
 */

export const HOST = '127.0.0.1';

/** Fallback port. Overridable on BOTH sides via the env vars below. */
export const PORT = 8765;

export const ENV_HOST = 'OPENCODE_SD_HOST';
export const ENV_PORT = 'OPENCODE_SD_PORT';
export const ENV_INSTANCE = 'OPENCODE_STREAMDECK_INSTANCE';

export const STATES = ['green', 'yellow', 'red'] as const;

export type State = (typeof STATES)[number];

/**
 * What the three names mean, and nothing about HOW they are decided -- that
 * mapping lives in `opencode/src/plugin/state.ts`, which the server never
 * imports. This is the shared half of the vocabulary only:
 *
 *   green  -- at rest: idle, or blocked on the user (a pending permission)
 *   yellow -- busy with no tool and no text output: the model is thinking
 *   red    -- a tool is running, text is streaming, or the session errored
 *
 * The wire contract below is deliberately colour-agnostic: the server only
 * ever knows the three strings, so changing the meaning of a colour cannot
 * affect it.
 */

/** Runtime type guard. Rejects `['red']`, `new String('red')`, `'RED'`, etc. */
export function isState(value: unknown): value is State {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

export const DEFAULT_INSTANCE = 1;

/** Wire payload. `ts`/`seq` are diagnostics + ordering only -- the server
 *  derives liveness from its OWN arrival clock. */
export type StatePayload = {
  instance: number;
  state: State;
  /** Wall-clock ms, sent by the client. Informational only. */
  ts: number;
  /** Strictly increasing per client instance. Monotonic. */
  seq: number;
};

export const PATH = '/state';

/** Max accepted request body, bytes. */
export const MAX_BODY_BYTES = 4096;

/** Client -> server: how often a beat is sent. */
export const HEARTBEAT_MS = 2000;
/** Server: silence after which a client is considered gone. 3 missed beats. */
export const STALE_MS = 6000;
/** Server: how often the staleness sweep runs. */
export const SWEEP_MS = 1000;
/** Client: per-request deadline. MUST be < HEARTBEAT_MS, or a slow response
 *  would leave no room for the next beat inside one interval.
 *
 *  This is a CLIENT-side `AbortSignal.timeout`, not a server property: the
 *  server holds the response until it has repainted every visible key, so the
 *  measured latency includes a repaint. The old 700 ms was tight enough that a
 *  merely slow `setImage` was misread as a dead server. Asserted by
 *  `opencode/test/transport.test.ts`. */
export const REQUEST_TIMEOUT_MS = 1500;
/** Client: capped exponential backoff bounds. */
export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 15000;
/** Safety net: a pending permission older than this is assumed to have a lost reply. */
export const PERMISSION_TTL_MS = 300000;
/** How long a text part keeps a session `active` after its last update. While
 *  this window is open the session reads RED (text is streaming); once it
 *  lapses the session falls back to YELLOW, which is what a model going quiet
 *  to think actually looks like.
 *
 *  A tool is deliberately NOT covered by this TTL: a long-running tool such as
 *  `sleep 60` emits no events at all while it runs, so expiring it would
 *  downgrade a genuinely working agent to "thinking" for most of a minute. */
export const ACTIVITY_TTL_MS = 5000;
/** Safety net: an error older than this is assumed to have no follow-up event.
 *  A fatal `ApiError`/`ProviderAuthError` is normally the last event of a turn,
 *  and the session goes idle straight after a failure, so nothing but this TTL
 *  clears the flag. It is also what keeps the key from being permanently RED
 *  for a session that died minutes ago. */
export const ERROR_TTL_MS = 60000;
/** Idle sessions unseen for this long are pruned from the state map. */
export const SESSION_TTL_MS = 600000;

/**
 * Symmetric config resolution. Both sides call this with their own env so the
 * override semantics are identical by construction.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = {},
): { host: string; port: number } {
  const rawPort = env[ENV_PORT];
  const port = rawPort === undefined || rawPort === '' ? PORT : Number(rawPort);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${ENV_PORT} must be an integer between 1 and 65535`);
  }

  const host = env[ENV_HOST] || HOST;
  return { host, port };
}

export function stateUrl(host: string, port: number): string {
  return `http://${host}:${port}${PATH}`;
}
