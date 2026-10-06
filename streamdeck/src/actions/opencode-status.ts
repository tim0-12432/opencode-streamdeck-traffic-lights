import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
} from '@elgato/streamdeck';
import { DEFAULT_INSTANCE, STATES, type State } from '../../../shared/contract';
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

/**
 * A 1x1 opaque green PNG, the last-resort image.
 *
 * This is the ONLY form Stream Deck 7.1 is guaranteed to accept when nothing
 * can be read from disk: a base64 data-URL with a declared MIME type. It is
 * deliberately tiny, so the fallback path never ships a large string to the
 * app. See `fallbackImage` for why nothing else is accepted.
 */
const MINIMAL_FALLBACK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNQOhr3HwAElwJFIip35gAAAABJRU5ErkJggg==';

/**
 * The resolved built-in image for each state, cached at module level.
 *
 * A repaint happens on every heartbeat (the client posts every 2s), so reading
 * three PNGs from disk per repaint would mean a steady stream of synchronous
 * file I/O for the lifetime of the plugin. Each state is therefore resolved at
 * most once and the base64 string is reused. Caching the degraded results too
 * means a permanently missing file is reported once, not once per heartbeat.
 */
const builtinImageCache = new Map<State, string>();

/**
 * Reads one of the generated key images and returns it as a base64 data-URL.
 *
 * WHY A DATA-URL AND NOT RAW SVG (this comment used to be wrong)
 *
 * `setImage` does have a data-URL decoder, and it resolves plugin-relative
 * paths, but it does NOT accept raw SVG markup: the SDK forwards `payload.image`
 * verbatim with no encoding or detection, and Stream Deck 7.1.0.22321 silently
 * IGNORES an unrecognised value, leaving the key on its last (or manifest)
 * image with no error anywhere. Passing an SVG string therefore looks like it
 * worked while painting nothing. A base64 `data:image/png;base64,...` value is
 * the form the property inspector's own `FileReader.readAsDataURL` produces and
 * the form that is proven to reach the key, so that is what is sent here.
 *
 * The files are the generated traffic-light artwork
 * (`streamdeck/scripts/generate-images.mjs`), read relative to the process
 * working directory, which `ensure-cwd` has already pointed at the
 * `.sdPlugin` root -- the same directory the manifest is resolved against, and
 * the one Stream Deck itself sets when it launches the plugin.
 *
 * Never throws. If a state's own file cannot be read it degrades to a sibling
 * state image and finally to the neutral `MINIMAL_FALLBACK` pixel, logging a
 * warning rather than taking the plugin -- and the key's ability to repaint at
 * all -- down with it.
 */
function fallbackImage(state: State): string {
  const cached = builtinImageCache.get(state);
  if (cached !== undefined) return cached;

  const relative = `imgs/actions/status/${state}.png`;
  let dataUrl: string | null = null;

  try {
    // Preferred: this state's own artwork.
    const buffer = readFileSync(path.resolve(relative));
    dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (error) {
    streamDeck.logger.warn(
      `Could not read the built-in ${state} image (${relative}): ${String(error)}. Falling back to a minimal placeholder.`,
    );
    // Last resort that still paints *something*: a sibling state's file, then
    // the neutral 1x1 pixel. All three live in the same folder, so this only
    // helps if one file is individually missing -- but a wrong-colour light is
    // better than a key frozen on a stale image, and the warning above records
    // that the colour is approximate.
    for (const sibling of STATES) {
      if (sibling === state) continue;
      try {
        const buffer = readFileSync(path.resolve(`imgs/actions/status/${sibling}.png`));
        dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
        streamDeck.logger.warn(`Using the ${sibling} artwork as a stand-in for ${state}.`);
        break;
      } catch {
        // Try the next sibling; the neutral pixel below is the final answer.
      }
    }
  }

  const result = dataUrl ?? MINIMAL_FALLBACK;
  builtinImageCache.set(state, result);
  return result;
}

function imageFor(settings: Settings, state: State): string {
  const selected = {
    green: settings.greenImage,
    yellow: settings.yellowImage,
    red: settings.redImage,
  }[state];

  if (!selected) return fallbackImage(state);

  if (selected.startsWith('data:image/')) return selected;
  if (selected.startsWith('imgs/') || selected.startsWith('ui/')) return selected;

  try {
    const decoded = decodeURIComponent(selected);
    if (path.isAbsolute(decoded) || /^[a-zA-Z]:[\\/]/.test(decoded)) {
      const buffer = readFileSync(decoded);
      const ext = path.extname(decoded).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png';
      return `data:image/${mime};base64,${buffer.toString('base64')}`;
    }
  } catch (error) {
    streamDeck.logger.warn(`Could not read custom ${state} image from path "${selected}": ${String(error)}`);
    return fallbackImage(state);
  }

  streamDeck.logger.warn(
    `Ignoring the configured ${state} image: expected a data:image/ URL or a plugin-relative path under imgs/ or ui/, got "${selected.slice(0, 120)}". Using the built-in ${state} circle instead.`,
  );
  return fallbackImage(state);
}

@action({ UUID: 'com.tim0-12432.opencode-streamdeck-traffic-lights.status' })
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
