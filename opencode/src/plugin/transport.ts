import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  REQUEST_TIMEOUT_MS,
  stateUrl,
} from '../../../shared/contract.js';
import type { State, StatePayload } from '../../../shared/contract.js';

/** Log service name used for every `client.app.log` entry we emit. */
export const SERVICE = 'opencode-traffic-lights';

/**
 * The one place the log prefix is built. `streamdeck-status.ts` calls this too,
 * so a line written by the plugin and a line written by the transport are
 * byte-identical -- which is what makes `grep '\[opencode-traffic-lights\]'`
 * a reliable "is the plugin loaded?" check.
 */
export function formatLine(message: string): string {
  return `[${SERVICE}] ${message}`;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFn = (level: LogLevel, message: string) => void;

export type TransportOptions = {
  instance: number;
  host: string;
  port: number;
  /** Required. Never allowed to throw -- a broken logger must not be able to
   *  take the heartbeat down. */
  log: LogFn;
};

export type Transport = {
  /**
   * Fire-and-forget heartbeat. Never throws, never blocks the caller.
   *
   * `state` is a THUNK, not a value: the derivation it guards is O(sessions)
   * and this is called on every single OpenCode event, so during a streaming
   * turn it runs hundreds of times a second. Evaluating it eagerly would burn
   * that work on the overwhelmingly common `inFlight`/backoff short-circuits.
   */
  beat(state: () => State): void;
  /** Single request that ignores both the stopped flag and the in-flight
   *  guard. Used once, by `dispose`, to leave the deck green. */
  send(state: State): Promise<void>;
  /**
   * Resolves once the in-flight beat (if any) has settled.
   *
   * TCP gives no ordering guarantee across connections, so a `red` started
   * microseconds before shutdown can be written to the socket AFTER the final
   * `green` and repaint the key. `dispose` awaits this before flushing, which
   * restores send-order == arrival-order for the last two writes.
   */
  drain(): Promise<void>;
  /** Permanently stop sending. Safe to call more than once. */
  stop(): void;
  readonly stopped: boolean;
  readonly inFlight: boolean;
};

/**
 * The POST channel to the Stream Deck plugin's state server.
 *
 * Two deliberate properties:
 *  - NO client-side dedupe. An unchanged state is still transmitted, so a
 *    restarted (or freshly launched) deck learns the current state on the very
 *    next beat instead of waiting for a transition that may never come. The
 *    expensive `setImage` write is deduped on the DECK side instead.
 *  - Concurrency is capped at 1. The deck plugin is a local loopback consumer
 *    and has no use for more than one outstanding beat.
 */
export function createTransport(options: TransportOptions): Transport {
  const { instance, host, port } = options;
  const log = options.log;
  const url = stateUrl(host, port);

  let seq = 0;
  let inFlight = false;
  let attempt: Promise<void> | null = null;
  let backoffMs = 0;
  let stopped = false;
  let retryAfter = 0;

  /** Throttles identical failure messages so a closed deck cannot spam logs. */
  const lastLoggedAt = new Map<string, number>();

  function note(level: LogLevel, message: string): void {
    const now = Date.now();
    const previous = lastLoggedAt.get(message);
    if (previous !== undefined && now - previous < BACKOFF_MAX_MS) return;
    lastLoggedAt.set(message, now);
    try {
      log(level, message);
    } catch {
      // A logger that throws must not be able to break the transport.
    }
  }

  function payload(state: State): string {
    const body: StatePayload = { instance, state, ts: Date.now(), seq: ++seq };
    return JSON.stringify(body);
  }

  async function post(body: string): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`${url} responded ${res.status} ${res.statusText}`);
    }
  }

  function succeed(): void {
    backoffMs = 0;
    retryAfter = 0;
  }

  function fail(error: unknown): void {
    // A client-side deadline is OUR fault, not the server's. The server holds
    // its response until it has repainted, so a timeout says "the repaint was
    // slow", not "the deck is gone". Charging a full backoff step for it would
    // walk a perfectly healthy system up the ladder and stretch its recovery to
    // 15 s. Hold the current step (never escalate) and say so in the log.
    if (isDeadline(error)) {
      const hold = backoffMs === 0 ? BACKOFF_MIN_MS : backoffMs;
      retryAfter = Date.now() + hold;
      note(
        'warn',
        `state POST exceeded our own ${REQUEST_TIMEOUT_MS}ms client deadline` +
          ` (${describe(error)}); retry in ${hold}ms without backing off further`,
      );
      return;
    }

    backoffMs = backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    retryAfter = Date.now() + backoffMs;
    note('warn', `state POST failed (${describe(error)}); retry in ${backoffMs}ms`);
  }

  function beat(state: () => State): void {
    if (stopped || inFlight) return;
    if (Date.now() < retryAfter) return;

    inFlight = true;
    const body = payload(state());

    // `attempt` never rejects, and `inFlight` is released in `finally` so a
    // throw can never wedge the transport into a permanently silent state.
    attempt = post(body)
      .then(succeed)
      .catch(fail)
      .finally(() => {
        inFlight = false;
        attempt = null;
      });
  }

  async function send(state: State): Promise<void> {
    try {
      await post(payload(state));
    } catch {
      // Shutting down. There is nobody left to report this to.
    }
  }

  async function drain(): Promise<void> {
    // `drain` never enqueues, so one read is the whole snapshot.
    const current = attempt;
    if (current === null) return;
    await current;
  }

  function stop(): void {
    stopped = true;
  }

  return {
    beat,
    send,
    drain,
    stop,
    get stopped() {
      return stopped;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * `true` for the abort raised by our own `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`.
 *
 * The name differs by runtime -- Node's `AbortSignal.timeout` rejects with a
 * `TimeoutError`, while a caller-supplied abort (or a polyfill) uses
 * `AbortError` -- so both are accepted rather than silently mis-bucketed.
 */
function isDeadline(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}
