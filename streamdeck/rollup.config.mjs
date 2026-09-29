import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.tim0-12432.opencode-streamdeck-traffic-lights.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		typescript({
			tsconfig: "./tsconfig.json",
			mapRoot: isWatching ? "./" : undefined,
			// The default filter is scoped to THIS package root, so the shared
			// contract at ../shared/contract.ts is silently SKIPPED by the
			// transform -- rollup then receives raw TypeScript and fails with a
			// confusing `Expected a semicolon`. It lives outside this package, so
			// it must stay listed here explicitly.
			include: ["src/**/*.ts", "../shared/**/*.ts"]
		}),
		// `.ts` is in `extensions` because ../shared/contract.ts is consumed as
		// RAW TypeScript: it is shared with opencode/, which Bun loads directly
		// with no build step, so it can never be compiled ahead of time.
		// Consumers import it extensionless as `shared/contract`, so without this
		// rollup cannot resolve the import to a .ts file.
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
			extensions: [".ts", ".mjs", ".js", ".json", ".node"]
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		}
	]
};

export default config;
