/**
 * Minimal stand-in for `@deepseek-ai/cordis` under vitest.
 *
 * WHY THIS EXISTS
 * ---------------
 * The DSH SDK is NOT installed on disk — it ships inside the DSH runtime
 * (app.asar) and is provided to plugins by the loader at runtime. vitest
 * transpiles with esbuild, which erases `import type` but NOT value imports, so
 * any test that reaches a module doing a *value* import from the SDK fails at
 * transform time with:
 *
 *     Failed to resolve import "@deepseek-ai/cordis" from "src/service.ts"
 *
 * Exactly one value import exists in `src/`: `Service` in `src/service.ts`,
 * used as `class CodeSource extends Service { super(ctx, SERVICE_KEY) }` — the
 * only way a Cordis plugin registers a service, so it cannot be removed. Every
 * other SDK import in this repo is type-only and needs no stub.
 *
 * `vitest.config.ts` aliases `@deepseek-ai/cordis` to this file. The published
 * bundle is unaffected: `@deepseek-ai/*` is marked external in tsdown.config.ts
 * and resolved by the DSH loader in production.
 *
 * The constructor deliberately does nothing — tests only need `super(...)` to be
 * callable so a service instance can be constructed against a fake context.
 */
export abstract class Service {
  constructor(_ctx: unknown, _key: string) {}
}
