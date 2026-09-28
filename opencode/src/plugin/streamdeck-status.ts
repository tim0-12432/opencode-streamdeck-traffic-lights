import type { Plugin } from '@opencode-ai/plugin';
import type { Event } from '@opencode-ai/sdk';

import {
  ACTIVITY_TTL_MS,
  DEFAULT_INSTANCE,
  ENV_INSTANCE,
  ERROR_TTL_MS,
  HEARTBEAT_MS,
  HOST,
  PERMISSION_TTL_MS,
  PORT,
  SESSION_TTL_MS,
  resolveConfig,
  stateUrl,
} from '../../../shared/contract';

import { SERVICE, createTransport, formatLine } from './transport';
import type { LogLevel } from './transport';
import { derive } from './state';
import type { SessionRecord, SessionStatusKind } from './state';

/** Upper bound on the final `green` flush performed during `dispose`. */
const DISPOSE_FLUSH_MS = 300;

/**
 * A live session as the event pump sees it: the pure `SessionRecord` the
 * decision function consumes, plus the two raw signals that `active` is
 * derived from.
 *
 * `active` is a GETTER, not a stored field, and that is the point: the whole
 * file can flip `toolRunning` / `textActive` and there is no way for the
 * derived boolean to drift away from them. It also cannot be assigned, so a
 * future edit cannot quietly introduce a third source of truth.
 */
type LiveSession = SessionRecord & {
  /**
   * A tool call is in flight. NO TTL: a long-running tool (`sleep 60`, a
   * deploy) emits nothing at all while it runs, so a time-based expiry would
   * downgrade a working agent to "thinking" for most of a minute. Cleared only
   * by the tool's own `completed`/`error` part, or by `session.idle`.
   */
  toolRunning: boolean;
  /**
   * Text was generated within the last `ACTIVITY_TTL_MS`. This one IS
   * time-bounded, because a model that has gone quiet mid-turn is genuinely
   * thinking -- and thinking is yellow, not red.
   */
  textActive: boolean;
  /** When `textActive` was last stamped, ms. Zero when `textActive` is false. */
  textAt: number;
};

export const StreamDeckStatus: Plugin = async ({ client }) => {
  const sessions = new Map<string, LiveSession>();
  /** When each pending permission id was first seen, for TTL expiry. */
  const pendingAt = new Map<string, number>();
  /** When each session's error flag was raised, for `ERROR_TTL_MS` expiry. */
  const errorAt = new Map<string, number>();

  function log(level: LogLevel, message: string): void {
    const line = formatLine(message);
    try {
      void client.app
        .log({ body: { service: SERVICE, level, message: line } })
        .catch(() => console.warn(line));
    } catch {
      console.warn(line);
    }
  }

  const warn = (message: string) => log('warn', message);

  // A throw here would abort loading of EVERY opencode plugin, so a bad env
  // value degrades to the defaults instead.
  let host = HOST;
  let port = PORT;
  try {
    const resolved = resolveConfig(process.env);
    host = resolved.host;
    port = resolved.port;
  } catch (error) {
    warn(`invalid host/port config (${message(error)}); falling back to ${HOST}:${PORT}`);
  }

  const instance = readInstance(process.env[ENV_INSTANCE]);
  if (instance === null) {
    warn(`${ENV_INSTANCE} must be a non-negative integer; falling back to ${DEFAULT_INSTANCE}`);
  }
  const resolvedInstance = instance ?? DEFAULT_INSTANCE;

  const transport = createTransport({
    instance: resolvedInstance,
    host,
    port,
    log,
  });

  function get(sessionID: string): LiveSession {
    const existing = sessions.get(sessionID);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing;
    }

    const record: LiveSession = {
      status: 'idle',
      pending: new Set<string>(),
      error: false,
      toolRunning: false,
      textActive: false,
      textAt: 0,
      // DERIVED, never stored. The two signals above are the only truth.
      get active(): boolean {
        return this.toolRunning || this.textActive;
      },
      lastSeen: Date.now(),
    };
    sessions.set(sessionID, record);
    return record;
  }

  function markPending(sessionID: string, permissionID: string): void {
    const record = get(sessionID);
    record.pending.add(permissionID);
    if (!pendingAt.has(permissionID)) {
      pendingAt.set(permissionID, Date.now());
    }
  }

  function clearPending(sessionID: string, permissionID: string): void {
    sessions.get(sessionID)?.pending.delete(permissionID);
    pendingAt.delete(permissionID);
  }

  function markError(sessionID: string): void {
    get(sessionID).error = true;
    // Re-stamping on every event keeps the flag alive while a turn is
    // demonstrably retrying, and `expire()` measures from the LAST sighting.
    errorAt.set(sessionID, Date.now());
  }

  function clearError(sessionID: string): void {
    const record = sessions.get(sessionID);
    if (record) record.error = false;
    errorAt.delete(sessionID);
  }

  function stopWorking(sessionID: string): void {
    // Everything that makes a session "actively generating". Called when the
    // turn demonstrably ends.
    const record = sessions.get(sessionID);
    if (!record) return;
    record.toolRunning = false;
    record.textActive = false;
    record.textAt = 0;
  }

  function setStatus(sessionID: string, status: SessionStatusKind): void {
    const record = get(sessionID);
    record.status = status;
    if (status === 'idle') {
      stopWorking(sessionID);
    }
    // `error` is deliberately NOT cleared here. Under the new mapping an error
    // is RED, and a failing session goes idle IMMEDIATELY afterwards -- the
    // failure ends the turn, it does not continue it. Clearing the flag on
    // idle would therefore make red invisible for exactly the failures that
    // matter most. ERROR_TTL_MS is what bounds it, and that is the only thing
    // that does.
    //
    // NOTE: `pending` is intentionally untouched too. A permission prompt parks
    // the turn, so OpenCode legitimately emits `session.idle` while it waits
    // for your answer. Pending is GREEN, so the light already says the right
    // thing there, but the prompt still has to survive the turn boundary or
    // the light would report "at rest, nothing waiting on you" while you are
    // being asked a question. Its lifetime is its own: a real
    // `permission.replied`, a `permission.ask` that resolves without asking,
    // `session.deleted`, or PERMISSION_TTL_MS for a lost reply.
  }

  function expire(): void {
    const now = Date.now();
    for (const [permissionID, at] of pendingAt) {
      if (now - at < PERMISSION_TTL_MS) continue;
      pendingAt.delete(permissionID);
      for (const record of sessions.values()) {
        record.pending.delete(permissionID);
      }
    }
    // Text activity is the ONE thing that expires on a timer. While the window
    // is open the session is red (something is being written); once it lapses
    // the session drops to yellow, which is the honest reading of a model that
    // stopped emitting tokens.
    //
    // `toolRunning` is deliberately absent from this sweep: a tool that runs
    // for a minute without emitting a single event is still a tool that is
    // running, and downgrading it to "thinking" would be a lie.
    for (const record of sessions.values()) {
      if (!record.textActive) continue;
      if (now - record.textAt < ACTIVITY_TTL_MS) continue;
      record.textActive = false;
      record.textAt = 0;
    }
    // An error is NOT cleared by an idle transition, for the reason spelled
    // out in `setStatus`. So ERROR_TTL_MS is not merely a safety net here, it
    // is the ONLY thing that ever clears a fatal ApiError/ProviderAuthError --
    // those are the last event of a turn, with nothing behind them. Without it
    // the key would sit red for a session that finished minutes ago, which is
    // worse than no red at all.
    for (const [sessionID, at] of errorAt) {
      if (now - at < ERROR_TTL_MS) continue;
      errorAt.delete(sessionID);
      const record = sessions.get(sessionID);
      if (record) record.error = false;
    }
  }

  function prune(): void {
    const now = Date.now();
    for (const [sessionID, record] of sessions) {
      if (now - record.lastSeen < SESSION_TTL_MS) continue;
      // Any still-pending permission was already expired above, since
      // PERMISSION_TTL_MS (5min) is shorter than SESSION_TTL_MS (10min).
      for (const permissionID of record.pending) {
        pendingAt.delete(permissionID);
      }
      // Dropping the record drops `toolRunning` / `textActive` / `textAt`
      // with it -- they are fields, not parallel maps, so they cannot leak.
      // `errorAt` IS a parallel map and has to be cleared by hand.
      errorAt.delete(sessionID);
      sessions.delete(sessionID);
    }
  }

  // A thunk, so the O(sessions) derivation is only paid for a beat that is
  // actually going to be sent. `beat()` is called on every OpenCode event.
  const beat = () => transport.beat(() => derive(sessions.values()));

  const timer = setInterval(() => {
    expire();
    prune();
    beat();
  }, HEARTBEAT_MS);
  // Never hold the opencode process open.
  timer.unref();

  // The one INFO line, emitted SYNCHRONOUSLY -- before anything that could
  // block. `log()`'s only other callers are the warning paths, so on a healthy
  // install this is the only line the README's
  // `grep '\[opencode-traffic-lights\]'` check can find, and it must not depend
  // on the seed below ever settling.
  const url = stateUrl(host, port);
  log('info', `traffic light active -> ${url} as instance ${resolvedInstance}`);

  beat();

  // Seed from the server so a restart does not report green while a session is
  // already busy. Note that a seeded `busy` session carries no part-level
  // evidence, so it lands on YELLOW (thinking) rather than red -- which is the
  // honest reading, and still unmistakably not "idle".
  //
  // FIRE AND FORGET, and that is load-bearing rather than stylistic. OpenCode
  // AWAITS this factory during boot, and this request is aimed at the very
  // server that is still booting us. Awaiting it here is a self-deadlock: the
  // response cannot arrive until startup finishes, and startup cannot finish
  // until this factory returns `Hooks`. The symptom is a blank, input-less TUI
  // whose only plugin log output is the heartbeat's transport warnings -- the
  // `setInterval` above is already beating while the factory is parked here, so
  // the deck-side warnings keep coming forever and no startup line ever appears.
  //
  // Nothing is lost by not waiting. Every real state arrives via the `event`
  // hook, so the seed is a best-effort head start, never a source of truth.
  void seed().catch(() => undefined);

  async function seed(): Promise<void> {
    // `session.status()` is declared `ThrowOnError = false`, so the hey-api
    // client RESOLVES with `{ error }` for a non-2xx instead of throwing --
    // checking `data` alone would swallow every HTTP-level failure silently and
    // boot the plugin with no diagnostic at all.
    let seedError: string | null = null;
    let seeded = 0;
    try {
      const { data, error } = await client.session.status();
      if (error) {
        seedError = describeSeedError(error);
      } else if (data) {
        for (const [sessionID, status] of Object.entries(data)) {
          get(sessionID).status = status.type;
          seeded += 1;
        }
      }
    } catch (error) {
      seedError = message(error);
    }

    if (seedError !== null) {
      warn(`could not seed session status (${seedError}); continuing from events only`);
    }

    // Only when the seed actually taught us something, so the common
    // fresh-boot case (nothing to seed) adds no redundant request to the wire.
    //
    // `drain()` first, because the startup beat issued just above is normally
    // still in flight and the transport's concurrency cap would silently swallow
    // this one. Waiting here is free -- we are already off the startup path, and
    // the drain is bounded by REQUEST_TIMEOUT_MS.
    if (seeded > 0) {
      await transport.drain();
      beat();
    }
  }

  return {
    event: async ({ event }: { event: Event }) => {
      // Synchronous state mutation only. OpenCode AWAITS this hook, so it must
      // never block on I/O -- the POST is fired and forgotten.
      switch (event.type) {
        case 'permission.updated': {
          // Blocks the turn on the user, so the session reads GREEN: the light
          // means "waiting on you", exactly like an idle session.
          markPending(event.properties.sessionID, event.properties.id);
          break;
        }

        case 'permission.replied': {
          clearPending(event.properties.sessionID, event.properties.permissionID);
          break;
        }

        case 'session.status': {
          setStatus(event.properties.sessionID, event.properties.status.type);
          break;
        }

        case 'session.idle': {
          setStatus(event.properties.sessionID, 'idle');
          break;
        }

        case 'session.error': {
          const { sessionID } = event.properties;
          if (sessionID) {
            markError(sessionID);
          } else {
            // NO global fallback. The previous code stamped `error` on every
            // known session, which poisoned sessions that would never receive
            // an event to clear the flag and so stayed red -- the loudest
            // possible colour -- until they aged out. The trade is deliberate:
            // an unattributable error is reported in the log (visible,
            // greppable, actionable) instead of being smeared across the whole
            // deck (invisible and wrong). The deck simply keeps whatever colour
            // it already had.
            warn('session.error carried no sessionID; not attributing it to any session');
          }
          break;
        }

        case 'message.part.updated': {
          const part = event.properties.part;
          if (part.type === 'tool') {
            const record = get(part.sessionID);
            switch (part.state.status) {
              case 'pending':
              case 'running': {
                // No TTL on this one -- see `LiveSession.toolRunning`.
                record.toolRunning = true;
                record.status = 'busy';
                clearError(part.sessionID);
                break;
              }
              case 'error': {
                record.toolRunning = false;
                markError(part.sessionID);
                record.status = 'idle';
                break;
              }
              case 'completed': {
                record.toolRunning = false;
                record.status = 'idle';
                // An error is not sticky. One early tool error followed by a
                // stream of `completed` parts means the agent recovered and is
                // demonstrably working; leaving the light red for the rest of
                // the turn would be a lie. `ERROR_TTL_MS` remains the safety
                // net for errors with no follow-up event at all.
                clearError(part.sessionID);
                break;
              }
            }
            break;
          }

          if (part.type === 'text') {
            // Synthetic parts (injected by the SDK, not written by the model)
            // and ignored parts (injected by the TUI/plugin layer) are not
            // output. Counting them would paint the key red for a turn that is
            // only narrating.
            if (part.synthetic === true || part.ignored === true) break;

            const record = get(part.sessionID);
            record.textActive = true;
            record.textAt = Date.now();
            // `status` is deliberately NOT touched. A text part must not
            // resurrect a session that is idle -- `perSession` checks
            // `status === 'idle'` before `active`, so a stale stream window
            // can never turn a finished session red.
          }
          break;
        }

        case 'session.deleted': {
          const { info } = event.properties;
          for (const permissionID of sessions.get(info.id)?.pending ?? []) {
            pendingAt.delete(permissionID);
          }
          // The record itself carries `toolRunning` / `textActive` / `textAt`,
          // so deleting it clears all three; `errorAt` is a parallel map and
          // has to be dropped explicitly.
          errorAt.delete(info.id);
          sessions.delete(info.id);
          break;
        }

        case 'session.compacted': {
          // No traffic-light meaning: compaction is invisible to the user.
          break;
        }

        default:
          // Unhandled SDK events must never break the build.
          break;
      }

      beat();
    },

    'permission.ask': async (input, output) => {
      // Mechanism unchanged: an unresolved prompt is remembered under its own
      // lifetime. The resulting colour is green -- a prompt means the turn is
      // parked on the user, which is the same at-rest reading as an idle
      // session, so it no longer outranks anything.
      if (output.status === 'ask') {
        markPending(input.sessionID, input.id);
      } else {
        clearPending(input.sessionID, input.id);
      }
      beat();
    },

    dispose: async () => {
      clearInterval(timer);
      // Stop FIRST: a beat must never land after the final green and flip the
      // light back on during shutdown.
      transport.stop();
      // Then DRAIN, so a `red` already on the wire is written before the
      // `green`. Across two connections TCP gives no ordering guarantee, so
      // without this the last write can land in the opposite order and leave
      // the key red on a cleanly shut-down agent. Still inside the flush bound:
      // `drain` is racing the same guard as the flush.
      await Promise.race([
        transport.drain().then(() => transport.send('green')),
        flushGuard(),
      ]);
    },
  };
};

function flushGuard(): Promise<void> {
  return new Promise((resolve) => {
    const guard = setTimeout(() => resolve(), DISPOSE_FLUSH_MS);
    guard.unref();
  });
}

/** Returns the validated instance, or `null` when the value is unusable. */
function readInstance(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_INSTANCE;

  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_INSTANCE;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Renders the `error` half of a hey-api result tuple. That value is the PARSED
 * RESPONSE BODY, not a native `Error` -- OpenCode's shape is
 * `{ name, data: { message } }` -- but a thrown/rejected path or a different
 * failure can still put anything here, so it degrades to `message()`.
 */
function describeSeedError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const body = error as { name?: unknown; data?: { message?: unknown } };
    const detail = typeof body.data?.message === 'string' ? body.data.message : '';
    if (typeof body.name === 'string') return detail ? `${body.name}: ${detail}` : body.name;
  }
  return message(error);
}
