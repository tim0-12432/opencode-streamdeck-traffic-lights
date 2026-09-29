import type { State } from '../../../shared/contract.js';

/**
 * Status of a single session, flattened from the SDK's `SessionStatus`
 * discriminated union. `retry` is a provider-level retry: the model is working
 * but emitting no tokens and running no tool, which under the new mapping is
 * indistinguishable from thinking, so it aggregates as yellow unless the
 * session is also `active`.
 */
export type SessionStatusKind = 'idle' | 'retry' | 'busy';

/**
 * Everything we know about one session.
 *
 * - `pending` holds the ids of permission prompts the user has not answered
 *   yet. They have their own lifetime and are deliberately NOT cleared by idle
 *   transitions, because a permission prompt parks the turn: OpenCode
 *   legitimately emits `session.idle` while it waits for the answer. They map
 *   to GREEN, so this is no longer about outranking anything -- a prompt means
 *   the session is blocked on the user, which is the definition of at rest.
 * - `active` means a tool is running or text is streaming. The producer of
 *   these records owns that judgement (see `streamdeck-status.ts`), because
 *   only it can see the part-level events and the `ACTIVITY_TTL_MS` window.
 *   Here it is just a boolean this module reads.
 * - `error` is a failure that has not yet aged out of `ERROR_TTL_MS`. It is
 *   the single most visible thing a session can report, so it is checked first.
 * - `messages` is the set of message ids this process has SEEN for the
 *   session, gathered from `message.updated` and from the `messageID` every
 *   part carries. It is never pruned per-message: a session that has had one
 *   message has had a conversation, and the reference's "no messages yet ->
 *   green" rule is about the empty session, not about the individual ids. The
 *   producer owns the mutation; here it is read for its size only.
 * - `hasAssistantMessage` records that at least one ASSISTANT message has been
 *   seen, which is the reference's "no assistant message yet -> yellow" rule.
 *   A busy session whose only traffic so far is the user's own prompt is not
 *   thinking, it is still being sent: yellow, not red.
 */
export type SessionRecord = {
  status: SessionStatusKind;
  pending: Set<string>;
  error: boolean;
  /** A tool is running, or text is streaming. Derived upstream, read here. */
  active: boolean;
  /**
   * Message ids observed on this session. Read-only here; the size is the
   * whole point of the field.
   */
  messages: Set<string>;
  /** At least one assistant message has been observed. */
  hasAssistantMessage: boolean;
  lastSeen: number;
};

/**
 * Ordered decision procedure for ONE session. First match wins, and the order
 * is load-bearing: the signals overlap, so an unordered expression would let a
 * later signal outrank an earlier one.
 *
 *   1. error           -> red     a failure is the most visible thing there is,
 *                                 and ERROR_TTL_MS is what bounds it
 *   2. pending prompt  -> green   blocked on you IS at rest
 *   3. idle            -> green   nothing is in flight
 *   4. no messages     -> green   parity with the reference implementation: an
 *                                 empty session has nothing to report, however
 *                                 the provider labelled it
 *   5. active          -> red     a tool is running, or text is streaming
 *   6. no assistant    -> yellow  nothing has come back from the model yet
 *   7. busy / retry    -> yellow  no tool and no output: the model is thinking
 *   8. fallthrough     -> green
 *
 * Note what rule 3 buys us: because `idle` is decided BEFORE `active`, a stale
 * `active` flag can never resurrect a finished session into red. The event pump
 * may not have seen the teardown event yet, and that is fine.
 *
 * Rule 4 sits ABOVE rule 5 deliberately, and that is only safe because of a
 * property of the producer, not of this function: `active` is set exclusively
 * by a `message.part.updated` carrying a `messageID`, so a session that is
 * `active` necessarily has at least one message in `messages`. The two rules
 * can never disagree about the same record. The end-to-end test `a busy
 * session with an ACTIVE TOOL is red, never the green of parity rule 4` in
 * `opencode/test/transport.test.ts` asserts exactly that, through the real
 * event pump, because a green flood would be the worst possible failure mode
 * for a traffic light.
 *
 * Written as an ordered early-return chain rather than independent `.some()`
 * calls so that a later signal can never outrank an earlier one.
 */
export function perSession(record: SessionRecord): State {
  if (record.error) return 'red';
  if (record.pending.size > 0) return 'green';
  if (record.status === 'idle') return 'green';
  if (record.messages.size === 0) return 'green';
  if (record.active) return 'red';
  if (!record.hasAssistantMessage) return 'yellow';

  // Rule 7, then rule 8. Written as a switch because the compiler has already
  // narrowed `status` to `'busy' | 'retry'` by the time we get here, so a
  // literal `status !== 'idle'` would be flagged as a comparison between types
  // with no overlap -- and would tell the reader nothing the switch does not.
  switch (record.status) {
    case 'busy':
    case 'retry':
      return 'yellow';
    default:
      return 'green';
  }
}

/**
 * One OpenCode process can host several sessions at once. Severity maximum
 * wins, with `green < yellow < red`: red means something is running or has
 * failed and needs you to look; yellow means work in progress that is merely
 * thinking; green means the whole process is at rest. A single busy session
 * therefore lights the key red even if ten other sessions are idle, and a
 * single error outranks a busy session.
 */
export function aggregate(states: Iterable<State>): State {
  let red = false;
  let yellow = false;

  for (const state of states) {
    if (state === 'red') red = true;
    else if (state === 'yellow') yellow = true;
  }

  if (red) return 'red';
  return yellow ? 'yellow' : 'green';
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
