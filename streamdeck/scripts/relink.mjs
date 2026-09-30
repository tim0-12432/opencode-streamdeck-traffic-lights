#!/usr/bin/env node
/**
 * Relink the Stream Deck plugin after the UUID rename.
 *
 * The plugin UUID changed from `com.tim0-12432.opencode-traffic-lights` to
 * `com.tim0-12432.opencode-streamdeck-traffic-lights`. If an old copy is still
 * installed in the Stream Deck app, both copies run at once and contend for
 * `127.0.0.1:8765`; the new one dies on EADDRINUSE and the key goes dead.
 *
 * So this script unlinks BOTH UUIDs (best-effort -- a plugin that is not
 * currently linked is the normal case and must NOT abort the run) and then
 * links the new plugin. Only the final `link` exit code is propagated, because
 * that is the step that must succeed.
 *
 * Why Node instead of `|| true`? The repo is developed on Windows (cmd.exe),
 * where `true` is not a command, so `streamdeck unlink ... || true` breaks the
 * `&&` chain whenever unlink exits non-zero. Plain Node runs everywhere npm
 * runs, with no shell idioms.
 *
 * Why execSync (string) instead of execFileSync (array)? On Windows the
 * `streamdeck` bin is a `.CMD` wrapper, which spawnSync/execFileSync cannot
 * launch without a shell. execSync runs through the platform shell
 * (cmd.exe / /bin/sh), which resolves `.CMD` via PATHEXT on Windows and finds
 * the bin on PATH on POSIX -- the same resolution the original npm-script form
 * relied on.
 *
 * Paths come from `node:path` (resolved from this script's own location) rather
 * than shell features, so the script works regardless of the directory it is
 * invoked from. The plugin path is double-quoted in the shell command so that
 * paths containing spaces (common on Windows, e.g. under `C:\Users\Your Name\`)
 * are passed through intact on both cmd.exe and POSIX sh.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_UUID = 'com.tim0-12432.opencode-traffic-lights';
const NEW_UUID = 'com.tim0-12432.opencode-streamdeck-traffic-lights';
const PLUGIN = path.resolve(HERE, '..', `${NEW_UUID}.sdPlugin`);

function unlink(uuid) {
  try {
    execSync(`streamdeck unlink ${uuid}`, { stdio: 'inherit' });
  } catch (err) {
    // Not linked is the expected/normal case; ignore and continue.
    const code = err?.status ?? err?.code ?? 'non-zero';
    console.warn(`streamdeck unlink ${uuid} exited ${code} (ignored)`);
  }
}

unlink(OLD_UUID);
unlink(NEW_UUID);

// The link step must succeed; let its exit code propagate to the caller.
console.log(`Linking ${PLUGIN}...`);
execSync(`streamdeck link "${PLUGIN}"`, { stdio: 'inherit' });
