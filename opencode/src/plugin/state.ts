import type { State } from '../../../shared/contract';

/**
 * Status of a single session, flattened from the SDK's `SessionStatus`
 * discriminated union. `retry` is a provider-level retry: work is in progress
 * and the user is not being asked anything, so it aggregates as red.
 */
export type SessionStatusKind = 'idle' | 'busy' | 'retry';

/**
 * Everything we know about one session. `pending` holds the ids of permission
 * prompts the user has not answered yet -- those have their own lifetime and
 * are deliberately NOT cleared by idle transitions.
 */
export type SessionRecord = {
  status: SessionStatusKind;
  pending: Set<string>;
  error: boolean;
  lastSeen: number;
};

/**
 * Ordered decision procedure for ONE session. First match wins, and the order
 * is load-bearing: the signals overlap. A session that is simultaneously busy
 * AND awaiting a permission prompt must read as yellow, because the prompt is
 * the single most actionable thing on screen -- you are being asked a question
 * and the light is asking you to come look.
 *
 * Written as an ordered early-return chain rather than independent `.some()`
 * calls so that a later signal can never outrank an earlier one.
 */
export function perSession(record: SessionRecord): State {
  if (record.pending.size > 0) return 'yellow';
  if (record.error) return 'yellow';
  if (record.status !== 'idle') return 'red';
  return 'green';
}

/**
 * One OpenCode process can host several sessions at once. The most actionable
 * state across all of them wins: any yellow anywhere beats any red anywhere.
 */
export function aggregate(states: Iterable<State>): State {
  let red = false;

  for (const state of states) {
    if (state === 'yellow') return 'yellow';
    if (state === 'red') red = true;
  }

  return red ? 'red' : 'green';
}

/** Pure: same records in, same state out. No timers, no I/O, no mutation. */
export function derive(records: Iterable<SessionRecord>): State {
  return aggregate(mapPerSession(records));
}

function* mapPerSession(records: Iterable<SessionRecord>): Generator<State> {
  for (const record of records) {
    yield perSession(record);
  }
}
