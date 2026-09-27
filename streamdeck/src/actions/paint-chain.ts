import type { State } from '../../../shared/contract';

/**
 * Paints one state to every visible key of `instance`.
 * @returns how many visible keys were actually written.
 */
export type PaintFn = (instance: number, state: State) => Promise<number>;

/** One instance's ordered queue. */
type Chain = {
  /** Tail of the promise chain. Never rejects, so one failure cannot poison it. */
  tail: Promise<void>;
  /** Bumped on every enqueue: only the newest task for an instance may paint. */
  revision: number;
};

/** What one enqueued task produced. */
type Enqueued = {
  /** Keys painted, or `null` when the task was dropped as superseded. */
  painted: number | null;
  /** This instance's chain revision at the moment the task was enqueued. */
  revision: number;
};

/**
 * Upper bound on how long ONE paint may take. A `setImage` that never settles
 * -- a wedged socket, a Stream Deck app that stopped answering -- would
 * otherwise pin the instance's chain forever: the dedupe short-circuit stays
 * suppressed, every later state for that instance queues behind a task that
 * will never run, and the HTTP handler never responds. Racing the paint against
 * this bound turns a hang into a rejection, so the chain entry is released and
 * the next heartbeat retries like any other failed write.
 *
 * Generous, because a slow-but-real write must not be thrown away: it is many
 * times any plausible `getSettings` + `setImage` round trip.
 */
export const PAINT_TIMEOUT_MS = 15_000;

export type PaintChainOptions = {
  /** The abstract paint. This class knows nothing about Stream Deck hardware. */
  paint: PaintFn;
  /** Upper bound on tracked instances (see `MAX_TRACKED_INSTANCES`). */
  maxTrackedInstances: number;
  /** Called when a COMPLETED paint found no visible key for the instance. */
  onUnpainted?: (instance: number) => void;
};

/**
 * Serialised, per-instance repaint chain plus the dedupe memory that goes with
 * it.
 *
 * WHY THIS EXISTS: painting is not synchronous. `OpenCodeStatus.paint` awaits
 * `key.getSettings()` before `setImage`, so there is at least one `await`
 * between "decide what the key should show" and "write it to the key". Two
 * repaints of the same instance issued from INDEPENDENT async paths can
 * therefore interleave: the staleness sweeper's green starts, a `POST /state`
 * red arrives while that `getSettings` is still in flight, and the green
 * `setImage` can then land AFTER the red one. The key is physically green,
 * `latest` says 'red', and every subsequent heartbeat dedupes on `latest` and
 * never repaints. The key stays wrong until the state genuinely changes --
 * exactly the failure the whole "dedupe on the server" design exists to
 * prevent.
 *
 * Note what this argument does NOT rest on. How long `getSettings` really takes
 * depends on the SDK's `useLegacySettingsBehavior` flag (with the default,
 * non-legacy setting it answers from a settings cache rather than making a
 * round trip), and whether `setImage` resolves once the message is written to
 * the socket or once the hardware has acknowledged it likewise depends on the
 * SDK. Neither figure is relied upon here. The hazard needs only ONE await
 * between the decision and the write, and JavaScript's single-threaded
 * scheduler grants that unconditionally.
 *
 * THE INVARIANT, established here rather than by convention, FOR EVERY WRITE
 * THAT GOES THROUGH THIS CHAIN: for every instance, either a paint is in
 * flight/queued, or the key physically shows `latest.get(instance)`.
 *
 * The qualifier is load-bearing and deliberately narrow. `OpenCodeStatus`'s
 * `onWillAppear` and `onDidReceiveSettings` call `setImage` directly, outside
 * this chain, because they repaint ONE key rather than every key configured for
 * an instance. They read `latest` to pick their colour, so they agree with the
 * chain's view of the world, but NOTHING serialises them against a chain paint
 * that is in flight for the same instance. Routing them through here would
 * change which keys get written, so they are left alone and the invariant is
 * claimed no wider than it is actually enforced.
 *
 * Three rules hold it up:
 *
 *  1. ORDER. Every paint for an instance goes through one chain, so the last
 *     enqueued paint is the last to land. A superseded paint can never overtake
 *     a newer one.
 *  2. `latest` is written ONLY after its own paint has actually completed, and
 *     only while no newer paint is queued behind it. So `latest` can
 *     under-report (be absent), which costs one redundant repaint, but it can
 *     never over-report -- which is the state that strands a key.
 *  3. The dedupe short-circuit is suppressed while the instance is busy, so a
 *     state is never reported as "already applied" on the strength of a paint
 *     that has not reached the key yet.
 *  4. A cap slot is RESERVED synchronously, before the first `await`, and
 *     released in a `finally`. Rule 2 makes `latest` grow only after a paint
 *     has settled, so a check made against `latest` alone is not atomic with
 *     the thing it is bounding: N concurrent requests for N distinct instances
 *     all read an empty `latest` and all pass. Reserving first is what makes
 *     `maxTrackedInstances` an upper bound rather than a suggestion.
 *
 * Standard library only, no Stream Deck imports, so the ordering can be tested
 * directly with a slow paint (see streamdeck/test/contract.test.ts).
 */
export class PaintChain {
  /** Last state whose paint COMPLETED, per instance. Absent = unknown. */
  readonly latest = new Map<number, State>();

  private readonly chains = new Map<number, Chain>();

  /**
   * Cap slots claimed by an `update` that has passed admission but not yet
   * settled. Counted rather than a plain set, because two concurrent updates
   * for the SAME instance each hold a claim and either one may be the one that
   * releases; a set would drop the other's claim on the first release and the
   * slot would briefly stop being accounted for.
   */
  private readonly reservations = new Map<number, number>();

  private readonly paint: PaintFn;

  private readonly maxTrackedInstances: number;

  private readonly onUnpainted: ((instance: number) => void) | undefined;

  constructor(options: PaintChainOptions) {
    this.paint = options.paint;
    this.maxTrackedInstances = options.maxTrackedInstances;
    this.onUnpainted = options.onUnpainted;
  }

  /** Live chain entries. One per instance that is mid-repaint; exposed for tests. */
  get chainCount(): number {
    return this.chains.size;
  }

  /** `true` while a paint for `instance` is running or queued behind another. */
  isBusy(instance: number): boolean {
    return this.chains.has(instance);
  }

  /** Whether another client instance can still be tracked. */
  canTrack(instance: number): boolean {
    // An instance that already occupies a slot -- because it is in `latest` or
    // because a concurrent `update` has reserved one -- is ALWAYS admitted: the
    // cap is a bound on how many DISTINCT instances may be held, never a lockout
    // of a client that is already inside it.
    return (
      this.latest.has(instance) ||
      this.reservations.has(instance) ||
      this.admittedCount < this.maxTrackedInstances
    );
  }

  /**
   * How many distinct instances currently hold a cap slot, counting each
   * instance ONCE even if it is both in `latest` and reserved by an update in
   * flight. Naively adding the two sizes would let a burst of repeat traffic
   * for already-tracked clients inflate the count and lock out a brand new
   * client for no reason -- bounded, but self-inflicted.
   */
  private get admittedCount(): number {
    let count = this.reservations.size;

    for (const instance of this.latest.keys()) {
      if (!this.reservations.has(instance)) count += 1;
    }

    return count;
  }

  private reserve(instance: number): void {
    this.reservations.set(instance, (this.reservations.get(instance) ?? 0) + 1);
  }

  private release(instance: number): void {
    const held = (this.reservations.get(instance) ?? 0) - 1;

    if (held > 0) this.reservations.set(instance, held);
    else this.reservations.delete(instance);
  }

  /**
   * Applies `state` to every visible key configured for `instance`,
   * serialised behind any paint already queued for it.
   *
   * @returns `true` when the deck was actually repainted by THIS call.
   */
  async update(instance: number, state: State): Promise<boolean> {
    if (!this.canTrack(instance)) {
      throw new Error(
        `Refusing instance ${instance}: the limit of ${this.maxTrackedInstances} tracked instances is reached`,
      );
    }

    // The slot is claimed HERE, in the same synchronous block as the admission
    // test above and before the first `await` of this function. Claiming it
    // after a paint settled -- which is when `latest` grows -- would leave the
    // test and the increment uninterleaved, and a burst of concurrent requests
    // for distinct instances would then ALL pass against a `latest` that has
    // not caught up yet. That is the difference between a memory bound and a
    // wish.
    this.reserve(instance);

    try {
      // Rule 3: a dedupe hit is only trustworthy while nothing is in flight.
      // `latest` describes the key as of the last COMPLETED paint, and a queued
      // paint (typically the sweeper's green) is still going to move it.
      if (!this.isBusy(instance) && this.latest.get(instance) === state) return false;

      const { painted, revision } = await this.enqueue(instance, state);

      // Superseded before it ran: a newer state for this instance owns the key
      // ahead of us and owns `latest`. Nothing was painted, so nothing to report.
      if (painted === null) return false;

      // Rule 2: record what the key physically shows, and only while nothing
      // newer is queued. If a newer paint arrived during ours it is still ahead
      // in the chain and will record its own state; recording ours would put
      // `latest` a step ahead of the key and strand it on the next heartbeat.
      if (!this.supersededSince(instance, revision)) this.latest.set(instance, state);

      if (painted === 0) this.onUnpainted?.(instance);

      return true;
    } finally {
      this.release(instance);
    }
  }

  /**
   * The client went silent: forget its state and paint the key green again.
   *
   * The forget is eager, which is safe in the pessimistic direction: if the
   * green paint is superseded or fails, `latest` under-reports and the next
   * state repaints instead of deduping. The opposite error -- remembering a
   * colour the key does not show -- is the one this class exists to prevent.
   */
  async markStale(instance: number): Promise<void> {
    this.latest.delete(instance);
    await this.enqueue(instance, 'green');
  }

  /**
   * Appends a paint to `instance`'s chain.
   *
   * Tasks run in enqueue order, so the last enqueued paint is the last to
   * reach the key. A task that is no longer the newest when its turn comes is
   * dropped: writing it would only be overwritten moments later.
   */
  private enqueue(instance: number, state: State): Promise<Enqueued> {
    const chain = this.chains.get(instance) ?? { tail: Promise.resolve(), revision: 0 };

    chain.revision += 1;
    const revision = chain.revision;
    this.chains.set(instance, chain);

    const run = chain.tail.then(async (): Promise<Enqueued> => {
      if (this.supersededSince(instance, revision)) {
        return { painted: null, revision };
      }

      return { painted: await this.paintWithin(instance, state), revision };
    });

    // A rejected tail would reject every later task for this instance with it,
    // so the chain swallows failures here; `run` still surfaces them.
    chain.tail = run.then(
      () => undefined,
      () => undefined,
    );

    // Drop the map entry once this task was the last one queued, so `chains`
    // cannot accumulate one entry per instance ever seen. It is deleted, not
    // cleared, so a later paint starts a fresh chain -- which is safe, because
    // everything in the old chain had already settled.
    void chain.tail.then(() => {
      if (this.chains.get(instance) === chain && chain.revision === revision) {
        this.chains.delete(instance);
      }
    });

    return run;
  }

  /**
   * `this.paint`, bounded by `PAINT_TIMEOUT_MS`.
   *
   * A timeout is reported as a REJECTION on purpose: it surfaces to `update`'s
   * caller exactly like a failed `setImage` (503 upstream, `latest` untouched,
   * a slot released), which is the honest description -- the key was not
   * repainted. Letting it resolve instead would record a state that may never
   * have reached the hardware, which is the one failure this class exists to
   * prevent.
   *
   * The paint promise itself is not cancellable and may still settle later; it
   * is simply no longer awaited, and its rejection -- if any -- is swallowed by
   * the race, so a late failure cannot surface as an unhandled rejection.
   */
  private async paintWithin(instance: number, state: State): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        this.paint(instance, state),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Painting instance ${instance} to ${state} timed out after ${PAINT_TIMEOUT_MS}ms`,
              ),
            );
          }, PAINT_TIMEOUT_MS);
          // Never hold the event loop open on our own account.
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `true` when a NEWER paint for `instance` was queued after `revision`, i.e.
   * that paint -- not this one -- owns the key and `latest` next.
   *
   * The entry is deliberately NOT the test: the enqueued task's own entry is
   * still there while it records its result, which would make every paint look
   * superseded to itself.
   */
  private supersededSince(instance: number, revision: number): boolean {
    const chain = this.chains.get(instance);
    return chain !== undefined && chain.revision !== revision;
  }
}
