# Contributing

For a general overview, see [README.md](README.md). For technical details on the protocol and components, see [ARCHITECTURE.md](ARCHITECTURE.md).

This repository is `opencode-streamdeck-traffic-lights`. It is a pnpm workspace with an OpenCode plugin, a Stream Deck plugin, and one shared protocol module.

## Prerequisites

- Node.js 24, as selected by [`.nvmrc`](.nvmrc).
- pnpm 11, declared by `devEngines.packageManager` in the root `package.json`.
- OpenCode with plugin support (the project is verified against OpenCode `1.18.32`) for OpenCode-side work.
- Stream Deck 7.1+ on Windows 10+ or macOS 12+ for Stream Deck-side work.

## Set up a clone

```sh
git clone https://github.com/tim0-12432/opencode-streamdeck-traffic-lights.git
cd opencode-streamdeck-traffic-lights
pnpm install
pnpm build
pnpm relink
```

`pnpm build` is required on a fresh clone: `streamdeck/...sdPlugin/bin/` is gitignored, and the manifest's `CodePath` points to the generated bundle. `pnpm relink` links the built `.sdPlugin` folder into the Stream Deck app. Run `pnpm validate` after manifest changes.

Changes under `opencode/` are loaded as raw TypeScript by Bun and do not need a bundle build. Changes under `streamdeck/` need `pnpm build` and `pnpm relink` again.

## Use a local OpenCode plugin

OpenCode resolves plugin entries as package specifiers, so a checkout path must be absolute. In `~/.config/opencode/opencode.json` or a project-level config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/absolute/path/to/opencode-streamdeck-traffic-lights/opencode/src/plugin/index.ts"
  ]
}
```

The OpenCode package can alternatively be linked:

```sh
bun link /absolute/path/to/opencode-streamdeck-traffic-lights/opencode
```

```json
{
  "plugin": ["@tim0-12432/opencode-streamdeck-traffic-lights-opencode"]
}
```

Use `bun link`, not `bun add file:/.../opencode`. A `file:` dependency copies the package into `node_modules`; the source import `../../../shared/contract.js` then escapes the copied package and resolves to a nonexistent shared module. `bun link` creates a symlink back into the checkout, so the import resolves. The published npm package is another option: it ships the compiled copy under `dist/`.

The Stream Deck half is not run from a checkout by OpenCode. Build and install it as a `.streamDeckPlugin` bundle for the Stream Deck app.

## Scripts

Run these from the repository root:

| Script | Purpose |
| --- | --- |
| `pnpm install` | Install the workspace; repeat after `package.json` changes. |
| `pnpm build` | Bundle the Stream Deck plugin to `*.sdPlugin/bin/plugin.js`. |
| `pnpm watch` | Run Rollup in watch mode and restart the Stream Deck plugin after each rebuild. |
| `pnpm relink` | Unlink then link the `.sdPlugin` folder through the Elgato CLI. |
| `pnpm validate` | Validate `manifest.json` with the Elgato CLI. |
| `pnpm tsc` | Typecheck all workspace packages with `tsc --noEmit`. |
| `pnpm test` | Compile and run each workspace's `node:test` suite. |

Per-package `build` and `watch` scripts in `opencode/` are `tsc --noEmit` variants. Bun executes the TypeScript directly, so there is no OpenCode bundle to emit.

## Layout and boundaries

```text
opencode-streamdeck-traffic-lights/
├── shared/
│   └── contract.ts
├── opencode/
│   ├── src/plugin/
│   │   ├── index.ts
│   │   ├── state.ts
│   │   ├── transport.ts
│   │   └── streamdeck-status.ts
│   └── test/
│       ├── tsconfig.json
│       └── transport.test.ts
└── streamdeck/
    ├── src/
    │   ├── plugin.ts
    │   └── actions/
    │       ├── opencode-status.ts
    │       └── paint-chain.ts
    ├── test/
    │   ├── tsconfig.json
    │   └── contract.test.ts
    └── com.tim0-12432.opencode-streamdeck-traffic-lights.sdPlugin/
        ├── manifest.json
        ├── ui/status.html
        ├── imgs/
        ├── bin/       # generated, gitignored
        └── logs/      # runtime logs, gitignored
```

`shared/contract.ts` is the wire contract for both halves. It has zero imports and zero runtime dependencies so Bun can load it as raw TypeScript and Rollup can bundle it. `opencode/` imports it as `../../../shared/contract`; `streamdeck/` bundles it as `../../shared/contract`.

The published OpenCode package is re-rooted during its build: `opencode/tsconfig.build.json` uses `rootDir: ".."`, placing `shared/` under the published `dist/` tree so the import remains inside the package. `streamdeck/` is marked `"private": true`: it is not an npm package, and the Stream Deck app consumes a `.sdPlugin` directory or `.streamDeckPlugin` bundle instead.

## Tests and transpilation

Both packages have real `node:test` suites and add no test dependency. TypeScript is already a development dependency and is used to transpile selected shipped source at test time.

- `streamdeck/test/contract.test.ts` imports `shared/contract.ts`, `opencode/src/plugin/state.ts`, and the real `PaintChain`. It extracts the routing and validation regions of `streamdeck/src/plugin.ts`, transpiles them with the TypeScript compiler, and runs them against a real loopback `http.Server`. It covers the wire contract, HTTP behaviour, and repaint ordering.
- `opencode/test/transport.test.ts` imports the shared contract and state modules directly, and transpiles `transport.ts` and `streamdeck-status.ts` from disk. It therefore exercises the shipped colour mapping, backoff ladder, in-flight guard, error TTL, text-activity TTL, and `dispose` ordering. Only `fetch` and the OpenCode `client` are stubbed.

`PaintChain` serialises repaints per instance and deduplicates unchanged paint requests. Keep changes to its ordering guarantees covered by the Stream Deck contract tests.

## Build and release

Validate before packaging:

```sh
pnpm install
pnpm build
pnpm validate
pnpm --filter ./streamdeck exec streamdeck pack \
  com.tim0-12432.opencode-streamdeck-traffic-lights.sdPlugin \
  --output . --force
```

The pack command writes `streamdeck/com.tim0-12432.opencode-streamdeck-traffic-lights.streamDeckPlugin`, a zip with one top-level `.sdPlugin` directory. The manifest validator also runs during packing and rejects an invalid manifest. Each release rebuilds this bundle and attaches it to the GitHub Release.

Before publishing the OpenCode package, check the version and package metadata, then publish the `opencode/` package to npm. It is `"private": false` and its `prepack` script builds `dist/`. The Stream Deck package remains private and is distributed only through the `.streamDeckPlugin` release asset.

## Versioning and upgrades

The manifest version in `streamdeck/com.tim0-12432.opencode-streamdeck-traffic-lights.sdPlugin/manifest.json` must be updated for a release. The GitHub Release should contain the freshly packed asset; the OpenCode package version should be kept consistent with the npm release being published.

The action UUID changed from `com.tim0-12432.opencode-traffic-lights` to `com.tim0-12432.opencode-streamdeck-traffic-lights`. Stream Deck keys store their **Instance** setting against the action UUID, so an upgrade across that change loses existing key configuration: users must re-add the action and set **Instance** again. `pnpm relink` unlinks the old UUID before linking the new one, avoiding a legacy-copy collision on `127.0.0.1:8765`.

## License

Contributions are made under the MIT license; see [LICENSE](LICENSE).
