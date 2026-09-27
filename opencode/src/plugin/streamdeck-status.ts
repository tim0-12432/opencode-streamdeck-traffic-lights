import type { Plugin } from '@opencode-ai/plugin';
import type { Event } from '@opencode-ai/sdk';

import {
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

export const StreamDeckStatus: Plugin = async ({ client }) => {
  const sessions = new Map<string, SessionRecord>();
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

  function get(sessionID: string): SessionRecord {
    const existing = sessions.get(sessionID);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing;
    }

    const record: SessionRecord = {
      status: 'idle',
      pending: new Set<string>(),
      error: false,
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

  function setStatus(sessionID: string, status: SessionStatusKind): void {
    const record = get(sessionID);
    record.status = status;
    clearError(sessionID);
    // NOTE: `pending` is intentionally untouched. A permission prompt parks the
    // turn, so opencode legitimately emits `session.idle` while it waits for
    // your answer. Clearing here would flip the light green at the exact
    // moment you are being prompted, which destroys the whole feature.
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
    // An error is NOT sticky by design -- unlike a permission prompt, a stale
    // yellow is worse than no yellow, because it sends you to a session that
    // finished minutes ago. `ERROR_TTL_MS` is the safety net for the fatal
    // errors (ApiError / ProviderAuthError) that are the LAST event of a turn,
    // with no `session.idle` behind them to clear the flag.
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

  // Seed from the server so a restart does not report green while a session is
  // already busy. One loopback call inside try/catch; events will correct it.
  //
  // `session.status()` is declared `ThrowOnError = false`, so the hey-api
  // client RESOLVES with `{ error }` for a non-2xx instead of throwing --
  // checking `data` alone would swallow every HTTP-level failure silently and
  // boot the plugin with no diagnostic at all.
  let seedError: string | null = null;
  try {
    const { data, error } = await client.session.status();
    if (error) {
      seedError = describeSeedError(error);
    } else if (data) {
      for (const [sessionID, status] of Object.entries(data)) {
        get(sessionID).status = status.type;
      }
    }
  } catch (error) {
    seedError = message(error);
  }

  if (seedError !== null) {
    warn(`could not seed session status (${seedError}); continuing from events only`);
  }

  // The one INFO line. `log()`'s only other callers are the warning paths, so
  // before this the log contained nothing at all on a healthy install and the
  // README's `grep '\[opencode-traffic-lights\]'` check could not distinguish
  // "loaded and fine" from "not loaded".
  const url = stateUrl(host, port);
  log('info', `traffic light active -> ${url} as instance ${resolvedInstance}`);

  beat();

  return {
    event: async ({ event }: { event: Event }) => {
      // Synchronous state mutation only. OpenCode AWAITS this hook, so it must
      // never block on I/O -- the POST is fired and forgotten.
      switch (event.type) {
        case 'permission.updated': {
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
            // a `setStatus` to clear it and so stayed yellow until they aged
            // out. The trade is deliberate: an unattributable error is reported
            // in the log (visible, greppable, actionable) instead of being
            // smeared across the whole deck (invisible and wrong). The deck
            // simply keeps whatever colour it already had.
            warn('session.error carried no sessionID; not attributing it to any session');
          }
          break;
        }

        case 'message.part.updated': {
          const part = event.properties.part;
          if (part.type !== 'tool') break;

          const record = get(part.sessionID);
          switch (part.state.status) {
            case 'pending':
            case 'running': {
              record.status = 'busy';
              clearError(part.sessionID);
              break;
            }
            case 'error': {
              markError(part.sessionID);
              record.status = 'idle';
              break;
            }
            case 'completed': {
              record.status = 'idle';
              // An error is not sticky. One early tool error followed by a
              // stream of `completed` parts means the agent recovered and is
              // demonstrably working; leaving the light yellow for the rest of
              // the turn would be a lie. `ERROR_TTL_MS` remains the safety net
              // for errors with no follow-up event at all.
              clearError(part.sessionID);
              break;
            }
          }
          break;
        }

        case 'session.deleted': {
          const { info } = event.properties;
          for (const permissionID of sessions.get(info.id)?.pending ?? []) {
            pendingAt.delete(permissionID);
          }
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
