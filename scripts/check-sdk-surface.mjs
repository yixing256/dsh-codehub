/**
 * Precise diff: every `@deepseek-ai/...` named import in src/ vs the LIVE runtime.
 *
 * WHY: the repo's `types/dsh/index.d.ts` is a hand-written shim mirrored from DSH
 * 0.1.5-rc.3 while the desktop app runs 0.2.0-rc.2. Typecheck therefore happily
 * accepts names the runtime no longer exports, and a missing React component
 * blanks the seat that renders it — invisible to typecheck, unit tests, and to SSR
 * behind a stubbed SDK.
 *
 * Reads the real packages out of `app.asar`.
 */

import { openArchive, readFileFromArchive, walk } from './asar-read.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives in scripts/). */
const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Every TypeScript source file under `src/`. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * `import { a, b } from 'pkg'` — non-nested braces only.
 *
 * Statement-level `import type { … }` is captured separately so it can be SKIPPED:
 * a type import is erased at build time and cannot break at runtime. Per-specifier
 * `type X` inside a value import is stripped for the same reason. Only VALUE
 * imports are checked — those are the ones that become `undefined`.
 */
const VALUE_IMPORT_RE = /import\s+(type\s+)?\{([^{}]*)\}\s*from\s*'(@deepseek-ai\/[^']+)'/g

const ctx = await openArchive()
const entries = [...walk(ctx.header)]

/** The runtime's own package tree inside the archive. */
const PKG_ROOT = 'dsh/node_modules/'

/** Resolve a package's entry file inside the archive and read its exports. */
async function runtimeExports(packageName) {
  const prefix = `${PKG_ROOT}${packageName}/`
  const pkgEntry = entries.find((entry) => entry.path === `${prefix}package.json`)
  if (pkgEntry === undefined) return { present: false }
  const pkg = JSON.parse(await readFileFromArchive(ctx, pkgEntry.path))
  const main = typeof pkg.main === 'string' ? pkg.main : 'lib/index.js'
  const libEntry = entries.find((entry) => entry.path === `${prefix}${main}`)
  if (libEntry === undefined) return { present: true, version: pkg.version, names: new Set(), main }

  const source = await readFileFromArchive(ctx, libEntry.path)
  const names = new Set()
  // Re-export and declaration forms both appear; collect every `export { ... }`.
  const re = /export\s*\{([^{}]*)\}/g
  let match
  while ((match = re.exec(source)) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  // `export function Foo` / `export class Foo` / `export const Foo`.
  const declRe = /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  while ((match = declRe.exec(source)) !== null) names.add(match[1])
  return { present: true, version: pkg.version, names, main }
}

// ---- collect our VALUE imports --------------------------------------------
const wanted = new Map() // package -> Set(names)
const typeOnly = new Map() // package -> Set(names), reported but not enforced
for (const file of sourceFiles(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8')
  let match
  while ((match = VALUE_IMPORT_RE.exec(text)) !== null) {
    const isTypeOnly = match[1] !== undefined
    const pkg = match[3]
    const target = isTypeOnly ? typeOnly : wanted
    const set = target.get(pkg) ?? new Set()
    for (const raw of match[2].split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name)
    }
    target.set(pkg, set)
  }
}

// ---- diff -----------------------------------------------------------------
let problems = 0
for (const [pkg, names] of [...wanted].sort()) {
  const runtime = await runtimeExports(pkg)
  if (!runtime.present) {
    console.log(`\n${pkg}: NOT IN THE RUNTIME ARCHIVE (host-provided or phantom?)`)
    continue
  }
  const missing = [...names].filter((name) => !runtime.names.has(name)).sort()
  const status = missing.length === 0 ? 'ok  ' : 'FAIL'
  console.log(`\n${status} ${pkg}@${runtime.version}  (${names.size} value imports, ${runtime.names.size} exports)`)
  if (missing.length === 0) {
    console.log(`       every imported value exists: ${[...names].sort().join(', ')}`)
  } else {
    for (const name of missing) {
      const stem = name.replace(/(Outline|Fill)?(Medium|Regular|\d+)$/, '')
      const near = [...runtime.names].filter((c) => c.startsWith(stem) && c !== name).slice(0, 6)
      console.log(`       MISSING ${name}   near: ${near.join(', ') || '(none)'}`)
    }
  }
  problems += missing.length
}

// Type-only imports cannot break at runtime, but a name that no longer exists is
// still a stale shim worth reporting.
for (const [pkg, names] of [...typeOnly].sort()) {
  const runtime = await runtimeExports(pkg)
  if (!runtime.present) continue
  const gone = [...names].filter((name) => !runtime.names.has(name)).sort()
  if (gone.length > 0) {
    console.log(`\nnote ${pkg}@${runtime.version}: ${gone.length} TYPE-only import(s) absent from the runtime exports`)
    console.log(`       ${gone.join(', ')}`)
    console.log('       (harmless at runtime — they are erased; kept visible so the shim can be re-mirrored)')
  }
}

await ctx.handle.close()
console.log(
  problems === 0
    ? '\nSDK surface: every VALUE imported from @deepseek-ai/* exists in the live runtime'
    : `\nSDK surface: ${problems} imported VALUE(s) DO NOT EXIST in the live runtime`,
)
process.exitCode = problems === 0 ? 0 : 1
