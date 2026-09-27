import { spawn } from 'node:child_process';
import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
} from '@elgato/streamdeck';
import { DEFAULT_INSTANCE, type State } from '../../../shared/contract';
import { PaintChain } from './paint-chain';

type Settings = {
  instance?: number;
  greenImage?: string;
  yellowImage?: string;
  redImage?: string;
  tapMode?: 'none' | 'url' | 'program';
  tapUrl?: string;
  program?: string;
  arguments?: string; // JSON array, e.g. ["--window", "opencode-2"]
};

/**
 * Upper bound on the number of tracked instances a buggy or hostile client can
 * make us hold. Each entry costs a map slot in `PaintChain.latest` and forces
 * the staleness sweeper to poll it every SWEEP_MS.
 */
export const MAX_TRACKED_INSTANCES = 32;

const defaults: Record<State, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
};

/**
 * `setImage` has no data-URL decoder: it accepts a plugin-relative path, a
 * base64 string with a declared mime type, or raw SVG markup. Returning raw SVG
 * keeps the key painted even when the user picked no custom image.
 */
function fallbackImage(state: State): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
    '<rect width="144" height="144" fill="#171717"/>' +
    `<circle cx="72" cy="72" r="49" fill="${defaults[state]}"/>` +
    '</svg>'
  );
}

function imageFor(settings: Settings, state: State): string {
  const selected = {
    green: settings.greenImage,
    yellow: settings.yellowImage,
    red: settings.redImage,
  }[state];

  if (!selected) return fallbackImage(state);

  // The property inspector hands us a `FileReader.readAsDataURL` result; it must
  // reach Stream Deck byte-for-byte.
  if (selected.startsWith('data:image/')) return selected;

  // `setImage` also resolves paths relative to the plugin folder.
  if (selected.startsWith('imgs/') || selected.startsWith('ui/')) return selected;

  streamDeck.logger.warn(
    `Ignoring the configured ${state} image: expected a data:image/ URL or a plugin-relative path under imgs/ or ui/, got "${selected.slice(0, 120)}". Using the built-in ${state} circle instead.`,
  );
  return fallbackImage(state);
}

@action({ UUID: 'com.tim0-12432.opencode-traffic-lights.status' })
export class OpenCodeStatus extends SingletonAction<Settings> {
  /**
   * Serialised per instance, and the only thing allowed to write
   * `latest`. Every repaint goes through it, so a superseded paint can never
   * land after a newer one and `latest` can never claim a colour the key is
   * not showing.
   */
  private readonly chain = new PaintChain({
    paint: (instance, state) => this.paint(instance, state),
    maxTrackedInstances: MAX_TRACKED_INSTANCES,
    onUnpainted: (instance) => {
      // The common case -- both sides at the default instance of 1 -- MATCHES
      // and never gets here, and an absent `settings.instance` already means the
      // default. So reaching this at all is a genuine mismatch, almost always
      // OPENCODE_STREAMDECK_INSTANCE on the OpenCode side not matching the
      // "Instance" setting of any visible key.
      streamDeck.logger.warn(
        `No visible key is configured for instance ${instance}. Set the action's instance in the property inspector to ${instance} (or set OPENCODE_STREAMDECK_INSTANCE=${instance} on the OpenCode side).`,
      );
    },
  });

  /** Whether another client instance can still be tracked. */
  canTrack(instance: number): boolean {
    return this.chain.canTrack(instance);
  }

  /**
   * Applies `state` to every visible key configured for `instance`.
   * Deduplicated here rather than on the client: the USB `setImage` write is
   * the expensive part, the loopback POST is free.
   * @returns `true` when the deck was actually repainted.
   */
  async update(instance: number, state: State): Promise<boolean> {
    return this.chain.update(instance, state);
  }

  /** The client went silent: forget its state and paint the key green again. */
  async markStale(instance: number): Promise<void> {
    await this.chain.markStale(instance);
  }

  /** @returns how many visible keys were painted. */
  private async paint(instance: number, state: State): Promise<number> {
    // `this.actions` contains the currently visible copies of this action.
    const tasks: Promise<void>[] = [];
    let painted = 0;

    this.actions.forEach((key) => {
      if (!key.isKey()) return;

      tasks.push(
        (async () => {
          const settings = await key.getSettings();

          if ((settings.instance ?? DEFAULT_INSTANCE) !== instance) return;

          painted += 1;
          await key.setImage(imageFor(settings, state));
        })(),
      );
    });

    await Promise.all(tasks);
    return painted;
  }

  /**
   * The single key that just appeared is repainted straight from `latest`,
   * WITHOUT going through the chain: the chain's `paint` writes every key
   * configured for an instance, and this only ever touches this one. The
   * colour read is still the chain's, so the two agree on intent, but nothing
   * serialises this write against a chain paint in flight for the same
   * instance. See the narrowed invariant in PaintChain.
   */
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;

    const settings = ev.payload.settings;
    const state = this.chain.latest.get(settings.instance ?? DEFAULT_INSTANCE) ?? 'green';
    await ev.action.setImage(imageFor(settings, state));
  }

  /** See `onWillAppear`: a direct single-key write, deliberately off the chain. */
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<Settings>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;

    const settings = ev.payload.settings;
    const state = this.chain.latest.get(settings.instance ?? DEFAULT_INSTANCE) ?? 'green';
    await ev.action.setImage(imageFor(settings, state));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const settings = ev.payload.settings;

    try {
      if (settings.tapMode === 'url' && settings.tapUrl) {
        const url = new URL(settings.tapUrl);

        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('Only http(s) URLs are accepted');
        }

        const opener =
          process.platform === 'win32'
            ? { command: 'explorer.exe', args: [url.href] }
            : { command: 'open', args: [url.href] }; // macOS

        const child = spawn(opener.command, opener.args, {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', (error) => streamDeck.logger.error(String(error)));
        child.unref();
      }

      if (settings.tapMode === 'program' && settings.program) {
        const args: unknown = JSON.parse(settings.arguments || '[]');

        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
          throw new Error('Arguments must be a JSON array of strings');
        }

        const child = spawn(settings.program, args, {
          detached: true,
          stdio: 'ignore',
          shell: false,
        });
        child.on('error', (error) => streamDeck.logger.error(String(error)));
        child.unref();
      }
    } catch (error) {
      streamDeck.logger.error(`Tap action failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}
