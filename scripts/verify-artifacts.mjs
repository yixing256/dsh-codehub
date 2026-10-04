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
 *   5b. the tool's `parameters` is RAW JSON Schema with an object root — the
 *      provider gets that object verbatim, and a parameter name at the root
 *      (`maxItems`) is read as the JSON-Schema keyword and rejected
 *   5c. the client's stylesheet is INLINED into the bundle, with no orphan
 *      `lib/client.css` that nothing would load
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

// ---- 4b. login requirement facts survive bundling --------------------------
//
// These four sentences are what the UI, the tool failure reasons and the README
// all state about "does querying code need a login?". They are derived from
// contract constants; this checks the BUILT bundles actually carry them (and
// that tree-shaking did not quietly drop a constant that only tests import),
// plus the two coarser facts a reader must be able to find.
want('login requirement probe date survives bundling', host, '2026-10-04')
want('GitHub anonymous code search evidence survives', host, 'Requires authentication')
want('Gitee missing code-search endpoint evidence survives', host, 'HTTP 404')
want('CSDN anti-bot evidence survives', host, 'HTTP 521')
want('CSDN robots disclosure is shipped', host, 'robots.txt')
want('CSDN robots disclosure is documented in README', readme, 'Disallow: /')
want(
  'README states code search needs a token (GitHub)',
  readme,
  'search/code',
)
want('README documents the GitHub device flow', readme, 'Device Flow')
want('README documents the callback registration (Gitee)', readme, '回调地址')

// ---- 5. client bundle is the loader artifact ------------------------------
want('client is wrapped for the DSH module loader', client, 'window.__ModuleLoader__.load(')
want('client registers under the package id', client, 'id: "dsh-codehub"')
want('client exposes apply', client, 'exports.apply = apply')
want('client exposes inject', client, 'exports.inject = inject')
want('client defers its body into the factory', client, 'return module.exports;')
// React must stay external: a second React copy breaks hooks.
want('client keeps react external', client, 'require("react")')

// ---- 5b. the tool's argument schema is RAW JSON Schema -------------------
//
// The provider receives `definition.parameters` VERBATIM: `tools.register()`
// validates only `output.schema` and never touches `parameters`, and only
// `defineTool()` compiles the author-facing per-property DSL. Shipping the DSL
// map puts the PARAMETER NAMES at the schema ROOT, so the provider reads the
// `maxItems` property as the `maxItems` KEYWORD (which must be an integer) and
// rejects the whole tool:
//
//   Invalid schema for function 'learn_code_from_web':
//   {"type":"integer","description":"…"} is not of type "integer"
//
// That kills every conversation, not just the tool. Asserted here against the
// BUILT bundle, because that object is what actually reaches the provider.
const paramsLiteral = /const LEARN_CODE_PARAMETERS = \{([\s\S]*?)\n\};/.exec(host)?.[1] ?? ''
if (paramsLiteral.length === 0) {
  failures.push('host bundle has no `const LEARN_CODE_PARAMETERS = {…}` to inspect')
} else {
  want('tool parameters declare an object root', paramsLiteral, 'type: "object"')
  want('tool parameters are closed', paramsLiteral, 'additionalProperties: false')
  want('tool parameters nest the argument names under properties', paramsLiteral, 'properties: PARAM_PROPERTIES')
  want('tool parameters use the required NAME ARRAY form', paramsLiteral, 'required:')
  // The decisive one: a parameter name at the ROOT is a JSON-Schema keyword
  // candidate, and `maxItems` is exactly the name that broke the provider.
  if (/["']?maxItems["']?\s*:/.test(paramsLiteral)) {
    failures.push(
      'tool parameters put `maxItems` at the schema ROOT — the provider reads it as the JSON Schema keyword and rejects every request',
    )
  } else {
    notes.push('  ok   no parameter name sits at the schema root (maxItems is under properties)')
  }
  // Non-vacuity: PARAM_PROPERTIES must really be there and really hold maxItems,
  // otherwise the check above could pass on a schema with no arguments at all.
  if (host.includes('const PARAM_PROPERTIES = {') && /maxItems\s*:/.test(host)) {
    notes.push('  ok   PARAM_PROPERTIES still declares maxItems (root check is not vacuous)')
  } else {
    failures.push('PARAM_PROPERTIES / maxItems missing from the bundle — the root check above proves nothing')
  }
}
want('tool ships that schema as `parameters`', host, 'parameters: LEARN_CODE_PARAMETERS')

// ---- 5c. the client stylesheet is inlined, not orphaned -------------------
//
// tsdown extracts `*.module.css` to a sibling `lib/client.css` and leaves the JS
// with only the scoped class-NAME map. Nothing loads a sibling asset (the client
// loader fetches the JS entry alone), so an un-inlined stylesheet means every
// class is a scope hash with no rules: the panel renders unstyled and cramped.
// Shipping browser halves inline the CSS and inject one guarded <style> tag.
want('client inlines its stylesheet', client, 'data-plugin-css=')
want('client injects the stylesheet once, guarded', client, 'document.querySelector("style[data-plugin-css="')
want('client writes the stylesheet via textContent (never innerHTML)', client, 'textContent = __dshCssText')
want('client guards the injection for a DOM-less import', client, 'typeof document !== "undefined"')
if (await exists('lib/client.css')) {
  failures.push(
    'lib/client.css is shipped but nothing loads it — a second copy of the stylesheet with no consumer; inline it and delete the file',
  )
} else {
  notes.push('  ok   no orphan lib/client.css (the stylesheet lives inside lib/client.js)')
}

// The inlined stylesheet must actually COVER every class the map hands to React.
// A map entry with no rule is a className that resolves to nothing, which is the
// same user-visible defect as not loading the sheet at all.
const cssLiteral = /var __dshCssText = ("(?:[^"\\]|\\.)*");/.exec(client)
if (cssLiteral === null) {
  failures.push('client has no `__dshCssText` literal to compare against the class map')
} else {
  const inlinedCss = JSON.parse(cssLiteral[1])
  const mapStart = client.indexOf('var panel_module_default = {')
  const mapEnd = mapStart === -1 ? -1 : client.indexOf('};', mapStart)
  if (mapStart === -1 || mapEnd === -1) {
    failures.push('client has no `panel_module_default` class map to compare against the stylesheet')
  } else {
    const entries = [...client.slice(mapStart, mapEnd).matchAll(/"([A-Za-z0-9_]+)": "([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ])
    const unstyled = entries.filter(([, scoped]) => !inlinedCss.includes(`.${scoped}`))
    if (entries.length === 0) {
      failures.push('the class map is empty — the stylesheet-coverage check would be vacuous')
    } else if (unstyled.length > 0) {
      failures.push(
        `${unstyled.length} class-map entries have no rule in the inlined stylesheet: ` +
          unstyled.map(([key, scoped]) => `${key} -> ${scoped}`).join(', '),
      )
    } else {
      notes.push(`  ok   all ${entries.length} class-map entries have a rule in the inlined stylesheet`)
    }
  }
}

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
