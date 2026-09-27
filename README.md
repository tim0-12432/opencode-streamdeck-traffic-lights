# OpenCode Traffic Lights

Mirror your OpenCode agent's status to a single Elgato Stream Deck key, so you
can tell from across the room whether the agent needs you.

- **Green** — idle. Nothing is happening, nothing is being asked of you.
- **Yellow** — waiting on you. A permission prompt is open, or a session errored.
  Come look.
- **Red** — working. Tools are running, a turn is in flight, or the provider is
  retrying.

## Requirements

- **Node.js 24** — see [`.nvmrc`](.nvmrc). The plugin manifest pins
  `Nodejs.Version: "24"`, and the Stream Deck app ships its own runtime for the
  bundle, so this only matters for your build toolchain.
- **pnpm 11** — declared via `devEngines.packageManager` in the root
  `package.json`; pnpm will download a matching version for you.
- **OpenCode** with plugin support (verified against `1.18.32`).
- **Stream Deck 7.1+** — the manifest's `Software.MinimumVersion`. Windows 10+ or
  macOS 12+.
- The repo, from the `tim0-12432` scope:
  <https://github.com/tim0-12432/opencode-traffic-lights>

## Install & build

```sh
pnpm install
pnpm build
pnpm relink
pnpm validate
```

- `pnpm install` — installs the workspace (root, `opencode/`, `streamdeck/`).
- `pnpm build` — bundles the Stream Deck plugin to
  `streamdeck/com.tim0-12432.opencode-traffic-lights.sdPlugin/bin/plugin.js`.
  **This step is mandatory on a fresh clone.** `bin/` is gitignored, so the
  bundle is not in the repo, and the Stream Deck app will not load the plugin
  without it — a missing `CodePath` is a plugin that simply never appears.
- `pnpm relink` — symlinks the built `.sdPlugin` folder into the Stream Deck
  app's plugin directory (via `@elgato/cli`).
- `pnpm validate` — runs the Elgato manifest validator. Cheap; run it after any
  change to `manifest.json`.

You only need `pnpm build` + `pnpm relink` again whenever you change something in
`streamdeck/`. Changes in `opencode/` need no build at all (see below).

## Wiring up OpenCode

OpenCode loads plugins as **raw TypeScript** via Bun. There is no build step and
there is no compiled output to keep in sync — typechecking *is* the build, which
is why `pnpm build` in the `opencode` package is `tsc --noEmit`.

Point OpenCode at the plugin's entry file. The path **must be absolute**; OpenCode
resolves plugin specifiers as package specifiers, so a relative path will not
resolve:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "C:/Users/you/path/to/opencode-traffic-lights/opencode/src/plugin/index.ts"
  ]
}
```

Edit this in your global config (`~/.config/opencode/opencode.json`) or a
project-level one.

If you would rather not repeat an absolute path, link the package and use a
bare specifier instead:

```sh
bun link /absolute/path/to/opencode-traffic-lights/opencode
```

```json
{
  "plugin": ["@tim0-12432/opencode-traffic-lights-opencode"]
}
```

**Link it, do not copy it.** A `file:` dependency — which is what `bun add
file:/…/opencode` creates — is *copied* into
`node_modules/@tim0-12432/opencode-traffic-lights-opencode/`, and from there
the plugin's `import … from '../../../shared/contract'` resolves to
`node_modules/shared/contract`, which does not exist. The plugin then fails to
load with a module-not-found error. `bun link` installs a **symlink**, so
`../../../shared` still points back into the repo and resolves correctly. For
the same reason there is no supported `bun add` route: link, or use the
absolute path above.

Note that the package is marked `"private": true`, and that is load-bearing
rather than cosmetic. The wire contract lives at `<repo>/shared/contract.ts`,
which is *outside* the `opencode/` package directory, so no `files` allowlist
could ever include it. Publishing the package would silently ship a broken
plugin that cannot resolve its own contract. Keeping it private forces the
absolute-path or `bun link` route above, which works with the repo layout.

## Multi-instance setup

The traffic light is addressed by an **instance number**.

- The OpenCode side reads `OPENCODE_STREAMDECK_INSTANCE` and defaults to `1`.
- Each key has an **Instance** field in the Stream Deck property inspector,
  which also defaults to `1`.

These two must match. A mismatch is the single most common cause of a key that
never lights up: the state is arriving, it is just being applied to an instance
no visible key is configured for. The plugin logs a warning
(`No visible key is configured for instance N`) when this happens, so check
`*.sdPlugin/logs/` before assuming something is broken.

To run several agents side by side, give each its own `OPENCODE_STREAMDECK_INSTANCE`
(1, 2, 3, …) and set the matching **Instance** on each key. Up to 32 instances
are tracked.

## The wire contract

The OpenCode plugin POSTs to a loopback HTTP server run by the Stream Deck
plugin. There is no shared process — this is the entire interface.

| | |
| --- | --- |
| Endpoint | `POST http://127.0.0.1:8765/state` |
| `Content-Type` | `application/json` — **required**, otherwise `415` |
| Bind address | `127.0.0.1` only; not reachable from the network |
| Max body | 4096 bytes, otherwise `413` |
| Client deadline | 1500 ms — see [Recovery behaviour](#recovery-behaviour) |

Request body:

```json
{ "instance": 1, "state": "green", "ts": 1735689600000, "seq": 42 }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `instance` | non-negative integer | Which logical agent this is. |
| `state` | `"green" \| "yellow" \| "red"` | The colour to paint. |
| `ts` | number | Client wall clock, ms. Diagnostics only. |
| `seq` | number | Strictly increasing per client. Ordering/diagnostics only. |

The server derives liveness from its *own* arrival clock, never from `ts` — a
client with a wrong clock must not be able to look fresh forever. Anything that
is not `POST /state` gets `404`; a malformed body gets `400`.

The 1500 ms is a **client-side** `AbortSignal.timeout` on the POST, not a
server limit — the server has no timeout at all. It has to stay below
`HEARTBEAT_MS` (2 s) or a single slow response would swallow the next beat, and
it has to leave room for the repaint the server performs *before* it answers
(`statusAction.update` awaits `getSettings` + `setImage` per visible key). An
`AbortError` from this deadline is attributed as our own latency and does **not**
climb the backoff ladder; a genuine transport failure does. `opencode/test`
asserts both the `< HEARTBEAT_MS` relationship and that distinction.

Response: `{ "ok": true, "state": "green", "changed": true }`. `changed` is
`false` when the key was already in that state and was not repainted.

## Recovery behaviour

The OpenCode side sends a heartbeat **every 2 s**, and sends one immediately on
every state event — an unchanged state is still transmitted on purpose, so a
freshly started deck learns the current state on the very next beat instead of
waiting for a transition that may never come.

- **Stream Deck restarts** — the restart drops the server's memory of the last
  state. The plugin resyncs within about one heartbeat (~2 s) because the
  OpenCode side never deduplicates — **unless the client is in backoff**, in
  which case the next attempt is up to 15 s away, so resync takes up to ~15 s.
- **Stream Deck is not running when OpenCode starts** — the POSTs fail. The
  client backs off exponentially (250 ms → 15 s cap) and recovers on its own as
  soon as the deck is back; no restart needed.
- **OpenCode is killed or crashes** — no clean `dispose` runs, so no final
  `green` is sent. The deck notices the silence after 6 s (3 missed beats), then
  repaints the key green. Total: about 7 s from the last beat.
- **OpenCode exits cleanly** — `dispose` clears the interval, stops the
  transport, *drains* the in-flight beat (so a `red` already on the wire is
  written first — TCP gives no ordering guarantee across connections), then
  flushes one `green`, all inside a 300 ms bound.
- **A pending permission is not cleared by an idle transition.** OpenCode
  legitimately emits `session.idle` while a permission prompt parks the turn, so
  honouring it would flip the light green at the exact moment you are being
  asked a question. Pending prompts have their own lifetime: they are cleared by
  an actual `permission.replied`, by a `permission.ask` that resolves without
  asking, by `session.deleted`, or by a 5-minute safety TTL for a lost reply.
- **An error is *not* sticky.** Unlike a permission, a stale yellow is worse
  than no yellow, because it sends you to a session that finished minutes ago.
  `error` is cleared by any `session.status`/`session.idle`, by a tool part that
  goes `pending`, `running` or `completed`, and — as a safety net for a fatal
  `ApiError`/`ProviderAuthError`, which is normally the *last* event of a turn
  with no `session.idle` behind it — by a 1-minute TTL.

## Dev escape hatch

`OPENCODE_SD_HOST` and `OPENCODE_SD_PORT` override the address on **both**
sides, using identical resolution logic (`shared/contract.ts`).

These are **not user settings**. The Stream Deck manifest has no field for
environment variables, and the Stream Deck app does not reliably pass an
environment through to the plugin process — in practice the host side inherits
whatever your login shell exported, which is fine for local debugging and
nothing more. There is no UI for it and it is not documented anywhere else.

The OpenCode side does get a real environment, so `OPENCODE_SD_PORT` there is a
reliable way to move the OpenCode plugin to a non-default port (you must then
move the deck side too, or nothing will connect).

## Troubleshooting

- **The key never lights up at all.**
  - `OPENCODE_STREAMDECK_INSTANCE` does not match the key's **Instance**
    setting. Check the log for `No visible key is configured for instance N`.
  - You did not run `pnpm build`. `bin/plugin.js` is gitignored and must be built
    on every fresh clone.
  - The manifest's `CodePath` (`bin/plugin.js`) does not resolve. `pnpm validate`
    will tell you.
- **The key is stuck on a colour.** It self-heals: within ~7 s of OpenCode
  going silent the deck forces the key green. If it does not, read
  `streamdeck/com.tim0-12432.opencode-traffic-lights.sdPlugin/logs/` — the plugin
  logs every missed heartbeat, every untracked instance, and every state it
  fails to apply there. A routine successful state application is not logged.
- **`Port 8765 is already in use`.** Another copy of the plugin (or another
  process) holds the port. The plugin exits deliberately in this case so that the
  Stream Deck app surfaces the crash, rather than staying up and deaf with a
  permanently misleading green key. Close the other copy — a leftover
  `streamdeck` process from `pnpm watch` is the usual culprit.
- **Permission prompts never turn the light yellow.** Make sure OpenCode is
  actually running the plugin. On a healthy start the plugin emits exactly one
  `info` line, so grep the OpenCode log for `[opencode-traffic-lights]` and
  look for:

  ```
  [opencode-traffic-lights] traffic light active -> http://127.0.0.1:8765/state as instance 1
  ```

  If that line is there, the plugin is loaded and the problem is on the deck
  side. If nothing matches, OpenCode never loaded it — re-check the `plugin`
  array in `opencode.json` and the path in it.

## Project layout

```
shared/
  contract.ts                     single source of truth for the wire contract
opencode/
  src/plugin/
    index.ts                      plugin entry point (what OpenCode loads)
    state.ts                      pure session -> colour derivation
    transport.ts                  the POST heartbeat client
    streamdeck-status.ts          the OpenCode Plugin: events, timers, dispose
  test/
    tsconfig.json                 emits compiled tests into test/.build/
    transport.test.ts             transport + plugin regression tests
streamdeck/
  src/
    plugin.ts                     loopback HTTP state server + sweeper
    actions/opencode-status.ts    the Stream Deck action (key painting)
    actions/paint-chain.ts        serialised per-instance repaint + dedupe
  test/
    tsconfig.json
    contract.test.ts              wire-contract, HTTP, and repaint-ordering tests
  com.tim0-12432.opencode-traffic-lights.sdPlugin/
    manifest.json                 plugin manifest (validator input)
    ui/status.html                property inspector
    imgs/                         action + plugin icons
    bin/                          BUILD OUTPUT, gitignored
    logs/                         RUNTIME LOGS, gitignored
```

`shared/contract.ts` has zero imports and zero runtime dependencies by design:
it is consumed as raw TypeScript by *both* sides — Bun loads it directly,
rollup bundles it — so it must stay portable. `opencode/test` asserts that.

## Scripts

All of these run from the repository root.

| Script | What it does |
| --- | --- |
| `pnpm install` | Install the workspace. Run this first, and again after any `package.json` change. |
| `pnpm build` | Bundle the Stream Deck plugin to `*.sdPlugin/bin/plugin.js`. |
| `pnpm watch` | Rollup in watch mode; restarts the Stream Deck plugin after each rebuild. |
| `pnpm relink` | `streamdeck unlink` + `streamdeck link` the `.sdPlugin` folder into the Stream Deck app. |
| `pnpm validate` | Validate `manifest.json` with the Elgato CLI. |
| `pnpm tsc` | Typecheck every workspace package (`tsc --noEmit`). |
| `pnpm test` | Compile and run every workspace package's `node:test` suite. |

Tests are real in **both** packages — `pnpm test` runs `node --test` in each:

- `streamdeck/test/contract.test.ts` — the larger suite. It imports
  `shared/contract.ts`, `opencode/src/plugin/state.ts` and the real
  `PaintChain`, and slices the routing/validation regions out of the real
  `streamdeck/src/plugin.ts`, transpiles them with the TypeScript compiler, and
  executes them against a real loopback `http.Server`.
- `opencode/test/transport.test.ts` — the OpenCode half. It imports
  `shared/contract.ts` and `state.ts` as real modules, and loads the real
  `transport.ts` / `streamdeck-status.ts` by transpiling them from disk, so
  the backoff ladder, the in-flight guard, the error TTL and the `dispose`
  ordering under test are the shipped code. Only `fetch` and the OpenCode
  `client` are stubbed.

Neither suite adds a dependency: both are plain `node:test`. `typescript` is
already a devDependency, which is what makes the runtime transpile possible.

Per-package `build`/`watch` in `opencode/` are `tsc --noEmit` variants: there is
nothing to emit, because Bun runs the TypeScript directly.

## License

MIT — see [LICENSE](LICENSE).
