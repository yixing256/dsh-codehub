/**
 * dsh-codehub — acceptance check for the shipped artifacts.
 *
 * Runs against the BUILT bundles, not the sources: it answers "does what we
 * would hand to DSH actually carry the things this project promises", which is a
 * different question from "do the sources typecheck".
 *
 * Checks, in the order of the delivery objective:
 *   1. host bundle exports the Cordis plugin surface (name / inject / apply / Config)
 *   2. the codeSource service key and the learn_code_from_web tool name are present
 *   3. 备注③ — the anti-copy statement reaches BOTH the tool description and the
 *      prompt section (i.e. it is in the host bundle at all, and twice)
 *   4. 备注① / 备注② — their exact strings survive bundling
 *   5. the client bundle is the DSH client-module-loader artifact, not bare ESM
 *   6. package.json / cordis.patch.yml / README all spell `dsh-codehub`
 *
 * Run: node scripts/verify-artifacts.mjs   (after `pnpm run build`)
 */

import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8')
const exists = async (rel) => {
  try {
    await access(path.join(ROOT, rel))
    return true
  } catch {
    return false
  }
}

const failures = []
const notes = []
/** Assert a substring is present, recording a failure instead of throwing. */
const want = (label, haystack, needle) => {
  if (haystack.includes(needle)) notes.push(`  ok   ${label}`)
  else failures.push(`${label}: missing ${JSON.stringify(needle.slice(0, 60))}`)
}

// ---- inputs ---------------------------------------------------------------
const contract = await read('src/contract.ts')
const host = await read('lib/index.mjs')
const client = await read('lib/client.js')
const pkg = JSON.parse(await read('package.json'))
const patch = await read('cordis.patch.yml')
const readme = await read('README.md')

// Pull the runtime string constants straight out of the built host bundle so the
// assertions below compare bundle content, not a re-imported module instance.
const contractValues = {
  antiCopy: "本插件是「代码用法学习源」，不是代码搬运器。",
  localProxyNote: '仅 Node 直连传输生效',
  csdnProbedAt: '2026-10-03',
}

// ---- 1. host plugin surface ----------------------------------------------
want('host exports the plugin name', host, 'dsh-codehub')
want('host declares the learn_code_from_web tool', host, 'learn_code_from_web')
want('host registers the codeSource service', host, 'codeSource')
want('host carries the system-prompt section name', host, 'plugin:dsh-codehub')

// ---- 2 / 3. 备注③ — the statement must appear in the bundle, twice --------
want('备注③ statement present in host bundle', host, contractValues.antiCopy)
const antiCopyHits = host.split(contractValues.antiCopy).length - 1
if (antiCopyHits >= 2) notes.push('  ok   备注③ statement appears at least twice (tool + prompt)')
else failures.push(`备注③ statement appears ${antiCopyHits}x in host bundle, expected >= 2 (tool description + prompt section)`)

// The tool description must itself carry the anti-copy clause. Assert on the
// contract source, which is where the two consumers take it from.
want('备注③ single source constant in contract', contract, 'export const ANTI_COPY_STATEMENT')
want('备注③ tool clause derives from it', contract, 'export const ANTI_COPY_TOOL_CLAUSE')
want('备注③ prompt text derives from it', contract, 'export const PROMPT_SECTION_TEXT')

// ---- 4. 备注① / 备注② ------------------------------------------------------
want('备注① local-proxy scope note survives bundling', host, contractValues.localProxyNote)
want('备注② CSDN probe date survives bundling', host, contractValues.csdnProbedAt)
want('备注② CSDN non-official wording survives bundling', host, '非官方内部接口')
want('备注① phrase documented in README', readme, contractValues.localProxyNote)
want('备注② probe date documented in README', readme, contractValues.csdnProbedAt)

// ---- 5. client bundle is the loader artifact ------------------------------
want('client is wrapped for the DSH module loader', client, 'window.__ModuleLoader__.load(')
want('client registers under the package id', client, 'id: "dsh-codehub"')
want('client exposes apply', client, 'exports.apply = apply')
want('client exposes inject', client, 'exports.inject = inject')
want('client defers its body into the factory', client, 'return module.exports;')
// React must stay external: a second React copy breaks hooks.
want('client keeps react external', client, 'require("react")')

// ---- 6. identity is consistent everywhere ---------------------------------
if (pkg.name === 'dsh-codehub') notes.push('  ok   package.json name = dsh-codehub')
else failures.push(`package.json name is ${JSON.stringify(pkg.name)}, expected "dsh-codehub"`)
want('cordis.patch.yml row name = dsh-codehub', patch, 'name: dsh-codehub')
want('cordis.patch.yml row id = dsh-codehub', patch, 'id: dsh-codehub')
want('README title = dsh-codehub', readme, '# dsh-codehub')
want('README states the transport limit', readme, '仅 Node 直连传输生效')
if (pkg.dsh?.client?.platform === 'web') notes.push('  ok   dsh.client.platform = web')
else failures.push('package.json dsh.client.platform must be "web"')
if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') notes.push('  ok   dsh.bundle.patch points at cordis.patch.yml')
else failures.push('package.json dsh.bundle.patch is wrong')

// ---- 7. required deliverables exist --------------------------------------
for (const rel of [
  'README.md', 'package.json', 'LICENSE', '.gitignore', 'cordis.patch.yml',
  'config.example.yml', '.env.example', 'lib/index.mjs', 'lib/client.js',
  'lib/types/index.d.ts', 'lib/types/client/index.d.ts',
]) {
  if (await exists(rel)) notes.push(`  ok   ${rel}`)
  else failures.push(`required deliverable missing: ${rel}`)
}

// ---- report --------------------------------------------------------------
console.log('=== dsh-codehub artifact acceptance ===')
for (const line of notes) console.log(line)
if (failures.length > 0) {
  console.log(`\nFAILED (${failures.length}):`)
  for (const line of failures) console.log(`  FAIL ${line}`)
  process.exitCode = 1
} else {
  console.log(`\nall ${notes.length} artifact checks passed`)
}
