/**
 * 浏览器半边的落点与外观契约。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three user-visible failures traced back to contracts that no test was watching:
 *
 *   1. **The sidebar row was given the whole panel.** `sidebar.panellist` takes a
 *      GLYPH, not a page: the shell owns the row button, label, tooltip and rail
 *      geometry and passes the component only `{ size }` (shipping panels do it
 *      that way — `dsh-ssh` registers `SshPanelIcon` there and its page on
 *      `main`). Passing `CodeHubPanel` left the row unusable, so the entry was
 *      effectively missing.
 *   2. **A first-run dialog asked where to appear, every time.** Both surfaces are
 *      on by default now, and the choice is an ordinary saved setting.
 *   3. **The placement control was a cramped inline cluster.** It is now one
 *      row per option, each with its own title line and description line, plus a
 *      single Save button that persists through the same path as the form save.
 *
 * Asserted against SOURCE TEXT, not by importing the module: the browser half
 * imports `@deepseek-ai/dsh-client-ui-primitives`, which exists only as an ambient
 * declaration, so importing it under vitest would fail to resolve — the test would
 * then be testing the wrong thing. (Same reasoning as `inject-contract.test.ts`.)
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SCHEMA_DEFAULTS } from '../src/config.js'
import { UI_ENTRY_ID, UI_ENTRY_LABEL, UI_ENTRY_ORDER, UI_SETTINGS_ORDER } from '../src/contract.js'
import { en, zh } from '../src/client/locales.js'
import { codeLinesContaining, readRepoFile, REPO_ROOT } from './helpers.js'

const client = readRepoFile('src/client/index.ts')
const panel = readRepoFile('src/client/panel.tsx')
const glyph = readRepoFile('src/client/icon.tsx')

describe('默认两处都显示，且不再有首次询问', () => {
  it('schema 默认 entryPlacement=both、onboarded=true', () => {
    expect(SCHEMA_DEFAULTS.entryPlacement).toBe('both')
    expect(SCHEMA_DEFAULTS.onboarded).toBe(true)
  })

  it('first-run 选择器已经不存在了', () => {
    expect(existsSync(join(REPO_ROOT, 'src/client/first-run.tsx'))).toBe(false)
    // No CODE line may reference the removed latch/dialog. Prose may: the header
    // comments explain why it was removed, and `isCommentLine` excludes those.
    expect(codeLinesContaining('first-run')).toEqual([])
    expect(codeLinesContaining('dsh-codehub:first-run:v1')).toEqual([])
  })

  it('locale 字典里不再有 firstRun / reopen 之类的一次性询问文案', () => {
    for (const key of Object.keys(zh)) {
      expect(key).not.toMatch(/firstRun|reopen|latchNote|switchNote/)
    }
  })

  it('配置路由挂了也退到 both，而不是隐身', () => {
    expect(client).toMatch(/applyPlacement\(ctx, 'both'\)/)
  })
})

describe('侧边栏入口 = GitHub 猫标 + codehub，且在最上面', () => {
  it('sidebar.panellist 注册的是 glyph，不是整块面板', () => {
    const start = client.indexOf("'sidebar.panellist'")
    expect(start, 'client/index.ts 必须注册 sidebar.panellist').toBeGreaterThanOrEqual(0)
    const end = client.indexOf("'main'", start)
    expect(end, "sidebar.panellist 之后必须注册 'main'").toBeGreaterThan(start)
    const panellistBlock = client.slice(start, end)

    // The seat is registered through the render guard; the guard's inner component
    // is the glyph, never the panel.
    expect(panellistBlock).toMatch(/GuardedPanelGlyph/)
    expect(panellistBlock, 'sidebar.panellist 不能挂整块面板').not.toMatch(/GuardedPanel\b/)
    expect(client).toMatch(/withSeatBoundary\(CodeHubPanelGlyph\)/)
  })

  it('main 槽挂的是真面板', () => {
    const start = client.indexOf("'main'")
    const block = client.slice(start, client.indexOf("'settings.section'", start))
    expect(block).toMatch(/GuardedPanel\b/)
    expect(client).toMatch(/withSeatBoundary\(CodeHubPanel\)/)
  })

  it('行文本就是 codehub，id/order 来自 contract', () => {
    expect(UI_ENTRY_LABEL).toBe('codehub')
    expect(UI_ENTRY_ID).toBe('codehub')
    // The rail sorts ascending, so a small order puts the row near the top.
    expect(UI_ENTRY_ORDER).toBeLessThan(UI_SETTINGS_ORDER)
    expect(client).toMatch(/label:\s*\(\)\s*=>\s*UI_ENTRY_LABEL/)
    expect(client).toMatch(/order:\s*UI_ENTRY_ORDER/)
  })

  it('glyph 是 currentColor 的装饰性 svg，且带行标识属性', () => {
    expect(glyph).toMatch(/<svg/)
    expect(glyph).toMatch(/viewBox="0 0 16 16"/)
    expect(glyph).toMatch(/fill="currentColor"/)
    expect(glyph).toMatch(/aria-hidden="true"/)
    expect(glyph).toMatch(/data-dsh-panel-entry=\{UI_ENTRY_ID\}/)
    // A plugin must never hard-code a colour: light/dark both come from tokens.
    expect(glyph).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
})

describe('显示位置是插件设置里的一项，保存一次即生效', () => {
  it('设置页与面板共用同一个控件', () => {
    expect(panel).toMatch(/export function CodeHubControls/)
    expect(readRepoFile('src/client/settings-card.tsx')).toMatch(/CodeHubControls/)
  })

  it('控制项排在表单最前面，用户一进来就能看到', () => {
    const placementAt = panel.indexOf('<EntryPlacementField')
    const decisionsAt = panel.indexOf('<DecisionsField')
    expect(placementAt).toBeGreaterThanOrEqual(0)
    expect(decisionsAt).toBeGreaterThanOrEqual(0)
    expect(placementAt).toBeLessThan(decisionsAt)
  })

  it('三个选项各自成行，标题与说明分两行（不再挤在一起）', () => {
    const start = panel.indexOf('function EntryPlacementField')
    const block = panel.slice(start, panel.indexOf('function SettingsScopeRow'))
    expect(block).toMatch(/styles\.optionList/)
    expect(block).toMatch(/styles\.optionRowSelected/)
    expect(block).toMatch(/type="radio"/)
    // title on one line, description on the NEXT — the fix for the cramped copy.
    expect(block).toMatch(/styles\.optionTitle/)
    expect(block).toMatch(/styles\.optionDesc/)
    // The options are stacked rows with a real gap, not an inline radio run.
    const css = readRepoFile('src/client/panel.module.css')
    const listRule = /\.optionList\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(listRule).toMatch(/flex-direction:\s*column/)
    expect(listRule).toMatch(/gap:\s*\d+px/)
    // The old cramped chooser styles are gone entirely.
    expect(css).not.toMatch(/\.modalOption/)
  })

  it('只有一个保存按钮，走的是同一条持久化路径（saveDraft）', () => {
    const start = panel.indexOf('function EntryPlacementField')
    const block = panel.slice(start, panel.indexOf('function SettingsScopeRow'))
    const buttons = [...block.matchAll(/<button\b/g)]
    expect(buttons.length, '显示位置控件应当只有一个按钮').toBe(1)
    expect(block).toMatch(/saveDraft\(\)/)
    expect(block).toMatch(/disabled=\{!pending/)
    expect(block).toMatch(/t\('entry\.save'\)/)
  })

  it('落点跟着「已保存」的配置走，而不是草稿 —— 所以保存一次才生效', () => {
    expect(client).toMatch(/subscribeConfig/)
    expect(client).toMatch(/applyPlacement\(ctx, getConfigState\(\)\.config\.entryPlacement\)/)
    // The draft must not move the seats: that would make an unsaved radio click
    // rearrange the user's shell.
    expect(client).not.toMatch(/draft[^\n]*entryPlacement/)
  })
})

describe('双语字典键完全一致', () => {
  it('en 与 zh 的键集合相同（缺一个都是漏译文）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('新增的显示位置文案两种语言都有内容', () => {
    for (const key of ['entry.title', 'entry.hint', 'entry.sidebar', 'entry.settings', 'entry.both', 'entry.save'] as const) {
      expect(zh[key].length, `zh ${key}`).toBeGreaterThan(0)
      expect(en[key].length, `en ${key}`).toBeGreaterThan(0)
    }
  })
})

describe('样式表必须跟着 bundle 走', () => {
  /*
   * tsdown extracts `*.module.css` into a sibling `lib/client.css` and leaves the
   * JS holding only the scoped class-NAME map. Nothing loads a sibling asset —
   * DSH's client loader fetches the JS entry alone — so without inlining, every
   * class is a scope hash with no rules behind it and the whole panel renders
   * unstyled (dense, cramped). That is what the user saw.
   *
   * The runtime side of this is `scripts/check-client-seats.mjs` plus the
   * `data-plugin-css` check in `scripts/verify-artifacts.mjs`; this is the cheap
   * source-level guard that runs on every `pnpm test`.
   */
  const wrapper = readRepoFile('scripts/wrap-client.mjs')

  it('wrap-client 把 stylesheet 内联进 factory', () => {
    expect(wrapper).toMatch(/STYLESHEET/)
    expect(wrapper).toMatch(/client\.css/)
    expect(wrapper).toMatch(/cssInjection/)
    expect(wrapper).toMatch(/data-plugin-css/)
    expect(wrapper).toMatch(/textContent/)
    // Escaping the CSS into a JS string literal must go through JSON.stringify, or
    // a quote or newline in the stylesheet breaks the bundle.
    expect(wrapper).toMatch(/JSON\.stringify\(cssText\)/)
  })

  it('注入代码放在 factory 内部，且为无 DOM 的导入留了退路', () => {
    expect(wrapper).toMatch(/typeof document !== "undefined"/)
    // INTRO opens the factory; the injection is concatenated after it.
    expect(wrapper).toMatch(/INTRO \+ styles \+ chunk \+ OUTRO/)
  })

  it('内联之后不再单独发布 lib/client.css（没有第二个消费者）', () => {
    expect(wrapper).toMatch(/\[BUNDLE, \.\.\.\(styles\.length > 0 \? \[STYLESHEET\] : \[\]\)\]/)
  })

  it('面板样式定义了选项之间的间距，标题与说明分两行', () => {
    const css = readRepoFile('src/client/panel.module.css')
    const rowRule = /\.optionRow\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rowRule).toMatch(/padding:/)
    const titleRule = /\.optionTitle\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    const descRule = /\.optionDesc\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(titleRule).toMatch(/font-weight:\s*600/)
    // The description is its own block with its own line height — not inline text
    // running on from the title.
    expect(descRule).toMatch(/line-height:/)
    expect(descRule).toMatch(/font-size:\s*12px/)
  })
})
