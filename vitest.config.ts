import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * dsh-codehub test config.
 *
 * Default environment is `node`, which is what the host half, the source
 * adapters and the contract tests need — they exercise fetch/parsing/failover
 * logic, not the DOM.
 *
 * SDK STUB: `@deepseek-ai/*` is NOT on disk (it ships inside the DSH runtime and
 * is injected by the loader), so vitest cannot resolve it. Exactly one value
 * import of the SDK exists in `src/` — `Service` in `src/service.ts` — and
 * esbuild erases `import type` but not value imports, so a test reaching that
 * module would fail at transform time without this alias. Every other SDK import
 * is type-only and needs no mapping. See test/stubs/cordis.ts.
 *
 * CLIENT TESTS: the browser half needs a DOM. `jsdom` is deliberately NOT a
 * dependency yet (no client test exists, and the project brief froze the
 * dependency list). When the first client test lands, pick one:
 *   1. per-file opt-in — put `// @vitest-environment jsdom` at the top of that
 *      test file, and add `jsdom` to devDependencies; or
 *   2. split the run into Vitest `projects` (a `node` project for
 *      `test/**\/*.test.ts` and a `jsdom` project for `test/client/**`).
 * Do NOT use `environmentMatchGlobs`: it is deprecated in Vitest 3.
 *
 * `passWithNoTests` stays false on purpose: a green run must mean tests ran.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': fileURLToPath(new URL('./test/stubs/cordis.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'lib/**', 'dist/**'],
    passWithNoTests: false,
  },
})
