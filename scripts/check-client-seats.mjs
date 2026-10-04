/**
 * dsh-codehub — runtime check of the BROWSER half.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every client-side incident in this project so far was invisible to typecheck,
 * to the build and to the whole unit suite, because none of them ever *ran* the
 * browser artifact:
 *
 *   - `inject` named a service the client roster does not have, so the profile
 *     aborted the entire web boot;
 *   - the sidebar row was handed the full panel instead of a glyph, so the entry
 *     was effectively missing;
 *   - the stylesheet was extracted to a sibling file that nothing loaded, so the
 *     panel rendered unstyled.
 *
 * So this script loads the REAL built artifact the way DSH's client module loader
 * does — through `window.__ModuleLoader__.load({ id, factory })`, with a fake
 * `require` for the platform externals — then drives `apply()` and inspects what
 * was registered. It answers, against the shipped bytes:
 *
 *   1. does the file register as a deferred closure factory (not bare ESM)?
 *   2. does `apply()` run to completion without throwing, and is `inject` the
 *      observed client roster (`slots`, `locale`) and nothing more?
 *   3. are the seats we promise actually registered — `sidebar.panellist` (with a
 *      GLYPH), `main`, `settings.section`, and the login overlay?
 *   4. do those seats RENDER markup (server-rendered) instead of coming back
 *      empty? "The settings page shows nothing" must be caught here.
 *
 * Run: node scripts/check-client-seats.mjs   (after `pnpm run build`)
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const notes = []
const failures = []
const ok = (label) => notes.push(`  ok   ${label}`)
const fail = (label) => failures.push(label)
const check = (condition, label) => (condition ? ok(label) : fail(label))

/**
 * The primitives the bundle is ALLOWED to require.
 *
 * This used to be a permissive Proxy that answered every property with a stub
 * component — which is exactly why this harness stayed green through the incident
 * that blanked both seats: the browser half imported four icons that the live
 * runtime had RENAMED, so they were `undefined`, and rendering `<undefined />`
 * threw. A stub that never returns `undefined` cannot see that.
 *
 * So the stub now has an explicit allow-list and THROWS on anything else, and the
 * allow-list is cross-checked against the live runtime by
 * `scripts/check-sdk-surface.mjs`.
 */
const ALLOWED_PRIMITIVES = new Set(['Input', 'Modal'])

/** A component stub for the SDK packages the loader provides at runtime. */
const componentStub = () => null
const requestedPrimitives = new Set()
const primitivesStub = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === '__esModule') return true
      if (key === 'then') return undefined
      if (typeof key !== 'string') return undefined
      requestedPrimitives.add(key)
      if (!ALLOWED_PRIMITIVES.has(key)) {
        throw new Error(
          `client bundle required an UNEXPECTED primitives export "${key}" — ` +
            'add it to ALLOWED_PRIMITIVES only after confirming it exists on the live runtime ' +
            '(pnpm run verify:sdk)',
        )
      }
      return componentStub
    },
  },
)

// ---------------------------------------------------------------------------
// 1. Load the artifact through the loader contract
// ---------------------------------------------------------------------------

const source = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let spec = null
const fakeWindow = {
  __ModuleLoader__: {
    load: (value) => {
      spec = value
    },
  },
}

// `document` is passed as `undefined` so the bundle's DOM guard takes its
// no-DOM branch — the same branch an SSR/Node import takes.
new Function('window', 'document', source)(fakeWindow, undefined)

if (spec === null) {
  console.error('FAILED: lib/client.js never called window.__ModuleLoader__.load({...})')
  process.exit(1)
}
check(spec.id === 'dsh-codehub', `loader id is dsh-codehub (got ${JSON.stringify(spec.id)})`)
check(typeof spec.factory === 'function', 'load() carries a deferred factory function')

const jsxRuntime = await import('react/jsx-runtime')
const externals = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}
const requiredIds = []
const fakeRequire = (id) => {
  requiredIds.push(id)
  if (Object.hasOwn(externals, id)) return externals[id]
  // Another SDK package: reuse the allow-listed stub, whose Proxy refuses any
  // name that is not known to exist on the live runtime.
  if (id.startsWith('@deepseek-ai/')) return primitivesStub
  throw new Error(`client bundle required an unexpected external: ${id}`)
}

// Nothing may execute before the loader materializes the module. A throw here is
// reported as a check failure rather than crashing the script, so the SDK-surface
// message above stays readable.
let mod
try {
  mod = spec.factory(fakeRequire)
  ok('the factory materialized without requiring an unknown SDK export')
} catch (error) {
  fail(`the factory threw while materializing: ${error instanceof Error ? error.message : String(error)}`)
  mod = { apply: undefined, inject: undefined }
}
check(
  [...requestedPrimitives].every((name) => ALLOWED_PRIMITIVES.has(name)),
  `only allow-listed primitives were touched (${[...requestedPrimitives].sort().join(', ') || 'none'})`,
)

check(typeof mod.apply === 'function', 'module exports a named `apply`')
check(Array.isArray(mod.inject), 'module exports a named `inject`')
check(
  JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale']),
  `inject is exactly the observed client roster (got ${JSON.stringify(mod.inject)})`,
)

// ---------------------------------------------------------------------------
// 2. Drive apply() against a minimal slot/locale context
// ---------------------------------------------------------------------------

const seats = []
const injectedSlots = []
const disposers = []

const ctx = {
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  get() {
    return undefined
  },
  on() {
    return () => {}
  },
  slots: {
    inject(slot, callback) {
      injectedSlots.push(slot)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(registration, component) {
      seats.push({ registration, component })
      return () => {}
    },
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
    subscribe: () => () => {},
    getSnapshot: () => ({ active: 'zh' }),
  },
}

try {
  // The plugin logs its mount diagnostics through console.warn, which is exactly
  // what we want in the app and noise here.
  const realWarn = console.warn
  console.warn = () => {}
  try {
    mod.apply(ctx)
    ok('apply() ran without throwing')
  } finally {
    console.warn = realWarn
  }
} catch (error) {
  fail(`apply() threw: ${error instanceof Error ? error.message : String(error)}`)
}

/** Wait for the async bootstrap to settle, without hanging the check. */
const deadline = Date.now() + 5000
while (Date.now() < deadline) {
  if (seats.some((seat) => seat.registration.name === 'settings.section')) break
  await new Promise((resolve) => setTimeout(resolve, 25))
}

const seatNames = seats.map((seat) => seat.registration.name)
for (const expected of ['sidebar.panellist', 'main', 'settings.section', 'shell.overlay']) {
  check(seatNames.includes(expected), `registered the ${expected} seat`)
}

const seatFor = (name) => seats.find((seat) => seat.registration.name === name)

// The seats must follow the SAVED config. With no host route reachable the store
// falls back to its default, which is `both` — so both surfaces must be present.
const placement = seatFor('settings.section') !== undefined && seatFor('sidebar.panellist') !== undefined
check(placement, 'default placement registers BOTH surfaces (no first-run dialog needed)')

// ---------------------------------------------------------------------------
// 3. The sidebar row is a GLYPH, and the seats actually render
// ---------------------------------------------------------------------------

const panellist = seatFor('sidebar.panellist')
if (panellist === undefined) {
  fail('no sidebar.panellist seat to inspect')
} else {
  check(
    panellist.registration.id === 'codehub',
    `sidebar row id is codehub (got ${JSON.stringify(panellist.registration.id)})`,
  )
  check(
    typeof panellist.registration.order === 'number' && panellist.registration.order < 30,
    `sidebar row sorts near the top (order ${panellist.registration.order})`,
  )
  let label = ''
  try {
    label = panellist.registration.label()
  } catch (error) {
    fail(`sidebar row label() threw: ${String(error)}`)
  }
  check(label === 'codehub', `sidebar row text is codehub (got ${JSON.stringify(label)})`)

  // The shell hands a row glyph only a size; it must render the cat mark and
  // nothing panel-shaped.
  let markup = ''
  try {
    markup = renderToStaticMarkup(React.createElement(panellist.component, { size: 16 }))
  } catch (error) {
    fail(`the sidebar glyph threw while rendering: ${error instanceof Error ? error.message : String(error)}`)
  }
  check(markup.includes('<svg'), 'the sidebar row renders an svg glyph')
  check(markup.includes('data-dsh-panel-entry="codehub"'), 'the glyph identifies its row')
  // Structurally a glyph: one svg, no panel furniture. (Asserting a byte length
  // would be wrong — the cat-mark path alone is ~700 bytes.)
  const svgCount = markup.split('<svg').length - 1
  check(svgCount === 1, `the glyph is exactly one svg (got ${svgCount})`);
  for (const forbidden of ['<input', '<button', '<h2', '<section', '<label']) {
    check(!markup.includes(forbidden), `the sidebar row has no ${forbidden} (it is a row glyph, not a page)`)
  }
}

/**
 * Render one seat with a MARKER translate.
 *
 * The harness has no locale service, so a real `t` is injected instead: it wraps
 * each dictionary KEY in guillemets. That makes the rendered copy assertable
 * without depending on the dictionary's wording or the active language.
 */
const MARK = (key) => `«${key}»`
const renderSeat = (name, props = {}) => {
  const seat = seatFor(name)
  if (seat === undefined) {
    fail(`no ${name} seat to render`)
    return ''
  }
  try {
    return renderToStaticMarkup(React.createElement(seat.component, { t: MARK, ...props }))
  } catch (error) {
    fail(`${name} threw while rendering: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

const settingsMarkup = renderSeat('settings.section', { slot: 'settings.section' })
const plainSettings = settingsMarkup.replace(/<[^>]*>/g, '').trim()
check(settingsMarkup.length > 0, 'the settings section renders markup')
check(
  plainSettings.length > 40,
  `the settings section renders real content, not an empty card (${plainSettings.length} chars of text)`,
)

// The placement control: three SEPARATE options, each with its own description
// line, plus one save button.
const radios = settingsMarkup.split('name="dsh-codehub-placement"').length - 1
check(radios === 3, `the settings section offers 3 placement options (got ${radios})`)
check(settingsMarkup.includes(MARK('entry.title')), 'the settings section shows the "where it appears" heading')
check(settingsMarkup.includes(MARK('entry.save')), 'the settings section ships the save button for placement')
for (const key of ['entry.both', 'entry.sidebar', 'entry.settings']) {
  check(settingsMarkup.includes(MARK(key)), `the settings section lists the ${key} option`)
}
for (const key of ['entry.bothDesc', 'entry.sidebarDesc', 'entry.settingsDesc']) {
  check(settingsMarkup.includes(MARK(key)), `${key} renders as its own line, not crammed into the title`)
}

const panelMarkup = renderSeat('main', { slot: 'main' })
check(panelMarkup.length > 0, 'the main-slot panel renders markup')

const loginMarkup = renderSeat('shell.overlay', { slot: 'shell.overlay' })
check(typeof loginMarkup === 'string', 'the login overlay seat is renderable')

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

console.log('=== dsh-codehub client-half runtime check ===')
console.log(`  externals required by the bundle: ${[...new Set(requiredIds)].sort().join(', ')}`)
console.log(`  seats registered: ${seatNames.join(', ')}`)
console.log(`  slots injected: ${injectedSlots.join(', ')}`)
for (const line of notes) console.log(line)
if (failures.length > 0) {
  console.log(`\nFAILED (${failures.length}):`)
  for (const line of failures) console.log(`  FAIL ${line}`)
  process.exitCode = 1
} else {
  console.log(`\nall ${notes.length} client-half checks passed`)
}
