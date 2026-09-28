/**
 * Sets the process working directory to this plugin's `.sdPlugin` folder, and it
 * has to be the FIRST thing that runs in the bundle.
 *
 * WHY THIS IS NEEDED
 *
 * `@elgato/streamdeck@3` resolves two things from `process.cwd()`, not from the
 * path of the script that was launched:
 *
 *   - `plugin/manifest.js`:  `join(process.cwd(), "manifest.json")`, and
 *     `getManifest()` THROWS when that file is missing.
 *   - `plugin/logging/index.js`: the log `FileTarget` is built at IMPORT time
 *     with `dest: join(cwd(), "logs")` and `fileName: getPluginUUID()`, where
 *     `getPluginUUID()` is `basename(process.cwd())` minus `.sdPlugin`.
 *
 * The SDK never chdirs itself; it trusts the host to have set the cwd. When
 * Stream Deck launches the plugin from anywhere else, `registerAction()` at
 * module top level therefore throws `Failed to read manifest.json as the file
 * does not exist.`, nothing binds the status port, and -- because the manifest
 * sets `"Debug": "disabled"` -- the stderr carrying the reason is discarded. The
 * symptom the user sees is a plugin that is "unstable", plus a key frozen on the
 * manifest's stock image.
 *
 * WHY IT IS A SEPARATE, SIDE-EFFECT-ONLY MODULE
 *
 * An ESM bundle runs module bodies in dependency order, and `import` statements
 * are hoisted, so a module that does NOT import the SDK and is listed FIRST in
 * the entry's imports is fully evaluated before any SDK code runs. The log
 * target is constructed at SDK import time, so anything later is already too
 * late. This module must therefore stay free of `@elgato/streamdeck` imports,
 * and `./ensure-cwd` must stay the first import in `src/plugin.ts`.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walks UP from this module's own directory and returns the first ancestor that
 * holds a `manifest.json` -- i.e. the `.sdPlugin` root. Deriving the target from
 * the module's location rather than from `process.cwd()` is the whole point: cwd
 * is the thing that is unreliable. Walking up (rather than counting a fixed
 * number of `..`) keeps this correct however deeply the module is nested, and it
 * is anchored by the one file that actually identifies a Stream Deck plugin.
 */
function findPluginRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(path.join(dir, 'manifest.json'))) return dir;

    const parent = path.dirname(dir);

    // Reached the filesystem root: `dirname` is a fixed point there.
    if (parent === dir) return null;

    dir = parent;
  }
}

/**
 * Best-effort breadcrumb in the plugin's own `logs/` folder. With `"Debug":
 * "disabled"` Stream Deck throws stderr away, so a launch-time failure has
 * nowhere else to leave a trace -- this is the only record of it. Every call is
 * individually guarded: a diagnostics write must never be able to abort the
 * plugin it is trying to explain.
 */
function recordInPluginLogs(pluginRoot: string, message: string): void {
  try {
    const logs = path.join(pluginRoot, 'logs');
    mkdirSync(logs, { recursive: true });
    appendFileSync(
      path.join(logs, 'ensure-cwd.log'),
      `${new Date().toISOString()} WARN ${message}\n`,
      'utf8',
    );
  } catch {
    // Nothing to do: we are already in the failure path we are reporting on.
  }
}

function ensureCwd(): void {
  const pluginRoot = findPluginRoot();

  if (pluginRoot === null) {
    // No `manifest.json` anywhere above this module: this is not a bundled
    // `.sdPlugin` layout (a dev run, or a relocated entry point). Leave cwd
    // exactly as the host set it -- guessing would be worse than doing nothing.
    return;
  }

  const current = process.cwd();

  // Already correct (the normal Stream Deck launch). A chdir here would be a
  // pointless, and on Windows not entirely free, syscall.
  if (path.resolve(current) === path.resolve(pluginRoot)) return;

  try {
    process.chdir(pluginRoot);
  } catch (error) {
    const message = `Could not set the working directory to ${pluginRoot} (cwd is ${current}): ${String(error)}. The Stream Deck SDK resolves manifest.json and its log folder from the working directory, so this plugin cannot start.`;

    // `console.warn` rather than the SDK logger: the SDK is not loaded yet, and
    // with "Debug": "disabled" this may well go nowhere. The file below is the
    // reliable half.
    console.warn(message);
    recordInPluginLogs(pluginRoot, message);
  }
}

ensureCwd();
