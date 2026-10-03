import { defineConfig } from 'tsdown'

/**
 * dsh-codehub build — two INDEPENDENT bundles sharing one output directory.
 *
 *   host   : src/index.ts        -> lib/index.mjs   (Cordis plugin, Node ESM)
 *   client : src/client/index.ts -> lib/client.js   (web half, browser ESM)
 *
 * Declarations are NOT produced here: `pnpm run build` runs
 * `tsc -p tsconfig.build.json` first, which emits lib/types/** . That is why
 * `clean: false` is set on both entries below — tsdown's `clean` defaults to
 * true and would delete lib/types (and the other entry's output) on every run.
 *
 * `dts: false` is also deliberate: tsdown auto-enables declaration generation
 * whenever package.json has a `types` field, which ours does. Leaving it on
 * would race tsc and drop `*.d.mts` files next to the bundles that nothing
 * points at (`main`/`exports` reference lib/types/**).
 *
 * Option names verified against tsdown@0.22.2's own type declarations. Note the
 * top-level `external` option is DEPRECATED in 0.22 and throws if combined with
 * its replacement, so only `deps.neverBundle` is used here.
 */

/**
 * The host half is loaded by the Cordis loader inside the DSH process.
 *
 * - `schemastery` is a real runtime dependency (package.json `dependencies`) and
 *   must stay external so the settings schema is shared with the host, not
 *   duplicated inside the bundle.
 * - `@deepseek-ai/*` is the SDK. It is NOT installed on disk — it ships inside
 *   DSH's app.asar and is provided by the loader at runtime. Without this
 *   external the real host half could never build ("could not resolve
 *   '@deepseek-ai/dsh-tools'"), which is why it is listed here even though the
 *   brief only named schemastery.
 * - Node builtins are external automatically under `platform: 'node'`.
 */
const HOST_RUNTIME_EXTERNALS: (string | RegExp)[] = ['schemastery', /^@deepseek-ai\//]

/**
 * The browser half is loaded by DSH's client module loader, which resolves these
 * bare specifiers itself. Every one of them MUST stay external:
 *
 * - `react` / `react/jsx-runtime` — one React instance must be shared with the
 *   host renderer; a second copy inside the bundle breaks hooks.
 * - `react-dom` / `react-dom/client` — devDependency only, so tsdown would
 *   otherwise inline it (deps in `peerDependencies` are external by default,
 *   devDependencies are not).
 * - `@deepseek-ai/*` — the client SDK (locale, renderer/slots, settings,
 *   primitives). Phantom dependencies: neither installed nor resolvable, so
 *   inlining is impossible and the build would fail outright.
 */
const CLIENT_RUNTIME_EXTERNALS: (string | RegExp)[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\//,
]

export default defineConfig([
  {
    name: 'dsh-codehub (host)',
    // Object-form entry: the key becomes the chunk name, so the output is
    // exactly lib/index.mjs regardless of the entry directory depth.
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    deps: { neverBundle: HOST_RUNTIME_EXTERNALS },
    outputOptions: { entryFileNames: '[name].mjs' },
  },
  {
    name: 'dsh-codehub (client)',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    // COMMONJS, deliberately — this is the one place the plugin's module format
    // is not a free choice.
    //
    // DSH's client module loader does NOT consume a plain ESM file for
    // `exports['./client']`. Every shipping browser half is a
    // `window.__ModuleLoader__.load({ id, factory })` artifact whose factory
    // body is CommonJS: the factory is handed a `require` that resolves the
    // platform externals, and the loader reads the module's `exports`. A plain
    // `import ... / export { apply }` file cannot run inside that factory — the
    // factory has no ES module scope — so the plugin would simply never mount.
    // (Verified against the shipped lib/client.js of dsh-better-sidebar,
    // dsh-context, dsh-drop-caret and dsh-webview-clipboard, all of which open
    // with `window.__ModuleLoader__.load({` and close with the factory `});`.)
    //
    // The host half above is the opposite: it IS plain ESM, exactly like every
    // shipping host half (`export { Config, apply, inject, name }`).
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    deps: { neverBundle: CLIENT_RUNTIME_EXTERNALS },
    // Emitted as an intermediate: scripts/wrap-client.mjs wraps it into the
    // CommonJS closure factory DSH's client module loader expects and writes the
    // result to lib/client.js, then deletes this intermediate. The wrapper lives
    // in a script rather than this config purely for readability — see its
    // header for the contract and why the deferral matters.
    outputOptions: { entryFileNames: '[name].cjs' },
    // CSS Modules (docs/DESIGN.md §5 styles the panel with `*.module.css` +
    // `--dsw-alias-*` / `--ds-*` tokens). The `css` pipeline comes from
    // `@tsdown/css`; once installed, `.module.css` is treated as a CSS module by
    // default (`modules` defaults to `{}`) and lightningcss emits scoped names
    // plus the JS class-name map — `postcss-modules` is NOT required because the
    // default transformer is lightningcss, not postcss.
    //
    // `splitting: false` (the default) puts every stylesheet of this build into
    // one file, named here: lib/client.css.
    //
    // OPEN QUESTION for the `client` teammate: `inject` stays false, so the JS
    // keeps NO reference to lib/client.css. If DSH's module loader only fetches
    // `lib/client.js`, the stylesheet never reaches the page — verify against a
    // shipping client plugin, then either set `css: { inject: true }` (the JS
    // then keeps an `import './client.css'` the loader must resolve) or mount the
    // styles from JS (e.g. an inline `?inline` import). Decide from live evidence,
    // not from this comment.
    css: { fileName: 'client.css' },
  },
  {
    name: 'dsh-codehub (smoke script)',
    // The live-network smoke test is a dev tool, not a shipped artifact. It is
    // bundled only because Node cannot execute it directly: our sources use the
    // NodeNext `.js` specifier convention (needed for declaration emit), and
    // Node's type-stripping resolves those specifiers literally, so it looks for
    // `contract.js` and finds nothing. Bundling resolves `./x.js` back to `x.ts`
    // exactly as the shipped builds do, so the script exercises the same graph
    // the plugin does.
    entry: { 'smoke': 'scripts/smoke.ts' },
    outDir: 'scripts/.build',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
])

/*
 * CSS / CSS Modules (for the `client` teammate):
 *
 * `import styles from './panel.module.css'` typechecks through the ambient
 * declaration in src/client/css-modules.d.ts, and compiles through the
 * `@tsdown/css` devDependency wired in the client entry above (scoped class
 * names + JS class-name map, lightningcss transformer). It is an ADDITION to the
 * brief's dependency list, required because tsdown itself ships no CSS support:
 * without that package a `.module.css` import would not produce a usable class
 * map, and docs/DESIGN.md §5 specifies CSS Modules for the panel.
 *
 * The client bundle is a single ESM file with named exports (`apply`, `inject`);
 * do not add a default export — see types/dsh/index.d.ts. If the client ever uses
 * a dynamic `import()`, rolldown will emit a hashed chunk next to lib/client.js;
 * plain rolldown code splitting is fine for Node, but a browser loader that only
 * fetches the entry file would miss that chunk, so prefer `outputOptions:
 * { inlineDynamicImports: true }` there if it ever comes up.
 */
