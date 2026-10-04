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
import {
  CONNECTIVITY_ROW_ORDER,
  SOURCES,
  SOURCE_LABELS,
  UI_ENTRY_ID,
  UI_ENTRY_LABEL,
  UI_ENTRY_ORDER,
  UI_SETTINGS_ORDER,
} from '../src/contract.js'
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
    // No CODE line may reference the removed latch or its dialog. Prose may: the
    // header comments explain why it was removed, and `isCommentLine` excludes those.
    //
    // The match is on the removed IDENTIFIERS, not the bare words: `--no-first-run`
    // is a Chromium flag the browser launcher passes, and a substring match on
    // "first-run" would fail the build for a completely unrelated reason.
    expect(codeLinesContaining('dsh-codehub:first-run:v1')).toEqual([])
    expect(codeLinesContaining('FirstRunDialog')).toEqual([])
    expect(codeLinesContaining('first-run.tsx')).toEqual([])
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

describe('保存后第一眼回答「我配置了什么」', () => {
  it('保存摘要排在同一个表单的最上方（原决策点位置）', () => {
    const summaryAt = panel.indexOf('<SavedSummaryField')
    const placementAt = panel.indexOf('<EntryPlacementField')
    expect(summaryAt, 'CodeHubControls 必须渲染 SavedSummaryField').toBeGreaterThanOrEqual(0)
    expect(placementAt).toBeGreaterThan(summaryAt)
  })

  it('摘要值一律取 host 回读值，草稿不参与', () => {
    const start = panel.indexOf('function SavedSummaryField')
    const block = panel.slice(start, panel.indexOf('function formatClock', start))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).toMatch(/describeConfigSummary\(state\.config/)
    expect(block, '摘要不得渲染草稿值').not.toMatch(/state\.draft/)
  })

  it('本次改动过的行标「本次修改」，没有改动时显示「没有改动需要保存」', () => {
    const start = panel.indexOf('function SavedSummaryField')
    const block = panel.slice(start, panel.indexOf('function formatClock', start))
    expect(block).toMatch(/state\.lastChangedKeys/)
    expect(block).toMatch(/summary\.modified/)
    expect(block).toMatch(/summary\.noChanges/)
    expect(block).toMatch(/summary\.hostValue/)
    // The changed keys come from the patch the HOST accepted, not from a second
    // diff taken after the read-back.
    const api = readRepoFile('src/client/api.ts')
    expect(api).toMatch(/summaryKeysForPatch\(patch\)/)
    expect(api).toMatch(/lastChangedKeys/)
  })

  it('摘要覆盖用户要求的每一项', () => {
    const api = readRepoFile('src/client/api.ts')
    for (const key of [
      'sourcePriority',
      'githubAccessPriority',
      'failoverEnabled',
      'mergeSources',
      'credentials',
      'mirrors',
      'localProxy',
      'limits',
      'deepReadTargets',
      'entryPlacement',
    ]) {
      expect(api, `摘要缺少 ${key} 行`).toContain(`'${key}'`)
    }
  })
})

describe('保存条用结果词，决策点折叠并下沉到保存条上方', () => {
  it('SaveBar 文案是「已保存 N 项改动 / 与 host 一致 / 有未保存的改动」', () => {
    const start = panel.indexOf('function SaveBar')
    const block = panel.slice(start, panel.indexOf('function CodeHubControls', start))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).toMatch(/panel\.dirty/)
    expect(block).toMatch(/summary\.changeCount/)
    expect(block).toMatch(/panel\.clean/)
    expect(block).toMatch(/panel\.revert/)
  })

  it('DecisionsField 在 SaveBar 之前，且不再是表单顶部那一项', () => {
    const decisionsAt = panel.indexOf('<DecisionsField')
    const saveAt = panel.indexOf('<SaveBar')
    const placementAt = panel.indexOf('<EntryPlacementField')
    expect(decisionsAt).toBeGreaterThanOrEqual(0)
    expect(saveAt).toBeGreaterThan(decisionsAt)
    expect(decisionsAt).toBeGreaterThan(placementAt)
  })

  it('折叠标题是「还差 N 项」，N=0 时给一行就绪 + 工具名', () => {
    const start = panel.indexOf('function DecisionsField')
    const block = panel.slice(start, panel.indexOf('function SavedSummaryField', start))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).toMatch(/decisions\.remainingPrefix/)
    expect(block).toMatch(/DECISION_KEYS\.length/)
    expect(block).toMatch(/TOOL_NAME/)
    expect(block).toMatch(/decisions\.readyHint/)
    // 措辞：描述还差什么，不说教。
    for (const value of Object.values(zh)) {
      expect(value).not.toContain('你还没有')
    }
  })

  it('每条决策点都有「现在就定」，可选未配项不进这个清单', () => {
    const start = panel.indexOf('function DecisionsField')
    const block = panel.slice(start, panel.indexOf('function SavedSummaryField', start))
    expect(block).toMatch(/decisions\.decideNow/)
    expect(block).toMatch(/source\.preset/)
    expect(block).toMatch(/tristate\.on/)
    expect(block).toMatch(/tristate\.off/)
    expect(block).toMatch(/onLocateGithubAccess/)
    // 可选项只在自己的控件旁显示「未配置」，不在未完成清单里。
    expect(block).not.toMatch(/localProxy|webProxyBases|rawMirrorBases|credentials/)
  })

  it('可选未配项在各自控件旁内联显示「未配置」', () => {
    // Mirrors: an action badge on the mirror card when both lists are empty.
    expect(panel).toMatch(/common\.notConfigured/)
    const mirrorAt = panel.indexOf("title={t('mirror.title')}")
    expect(mirrorAt).toBeGreaterThanOrEqual(0)
    expect(panel.slice(mirrorAt, mirrorAt + 400)).toMatch(/common\.notConfigured/)
    // Local proxy: same treatment on the proxy card.
    const proxyAt = panel.indexOf('title={LOCAL_PROXY_LABEL}')
    expect(proxyAt).toBeGreaterThanOrEqual(0)
    expect(panel.slice(proxyAt, proxyAt + 300)).toMatch(/common\.notConfigured/)
    // Accounts already render 已配置 / 未配置 per source.
    expect(panel).toMatch(/account\.notConfigured/)
  })
})

describe('账号区：每源状态 + 四条路径 + 行内登录要求', () => {
  it('浏览器登录 / 令牌或 Cookie 导入 / 获取向导 / 登出都在这里', () => {
    const start = panel.indexOf('function AccountsField')
    const block = panel.slice(start, panel.indexOf('function MirrorField', start))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).toMatch(/account\.browserLogin/)
    expect(block).toMatch(/account\.import/)
    expect(block).toMatch(/account\.guide/)
    expect(block).toMatch(/account\.logout/)
    expect(block).toMatch(/openCredentialGuide/)
    expect(block).toMatch(/openLoginDialog/)
  })

  it('登录要求来自契约常量，浏览器登录只给真有 OAuth 的源', () => {
    const start = panel.indexOf('function AccountsField')
    const block = panel.slice(start, panel.indexOf('function MirrorField', start))
    expect(block).toMatch(/LOGIN_REQUIREMENTS\[row\.source\]/)
    expect(block).toMatch(/SOURCE_LOGIN_METHODS\[row\.source\]/)
    expect(block).toMatch(/oauth-device/)
    expect(block).toMatch(/oauth-code/)
  })
})

describe('连通性面板：恒定三行 GUI，不是 JSON 报文', () => {
  const api = readRepoFile('src/client/api.ts')

  it('三行与契约一致，行序来自 CONNECTIVITY_ROW_ORDER', () => {
    expect([...CONNECTIVITY_ROW_ORDER]).toEqual([...SOURCES])
    expect(api).toMatch(/CONNECTIVITY_ROW_ORDER\.map/)
    expect(api).toMatch(/export function normalizeSmoke/)
    // 空负载也要有三行 → 面板永远不变高变矮。
    expect(api).toMatch(/export function emptyConnectivityRows/)
  })

  it('渲染源名 + 状态双通道 + 失败行下一行的原因', () => {
    const start = panel.indexOf('function ConnectivityRows')
    const block = panel.slice(start, panel.indexOf('function ConnectivityField', start))
    expect(start).toBeGreaterThanOrEqual(0)
    for (const source of CONNECTIVITY_ROW_ORDER) {
      expect(SOURCE_LABELS[source].length, `${source} 必须有可渲染的源名`).toBeGreaterThan(0)
    }
    expect(block).toMatch(/SOURCE_LABELS\[row\.source\]/)
    expect(block).toMatch(/CONNECT_STATUS_LABEL\[row\.status\]/)
    expect(block).toMatch(/connectReasonRow/)
    expect(block).toMatch(/LOGIN_REQUIREMENTS\[row\.source\]/)
    expect(block).toMatch(/connectMeta/)
  })

  it('两个按钮走 /smoke 与 /probe(useStoredCredential)', () => {
    const start = panel.indexOf('function ConnectivityField')
    const block = panel.slice(start, panel.indexOf('function DecisionsField', start))
    expect(block).toMatch(/connect\.runSmoke/)
    expect(block).toMatch(/connect\.runProbe/)
    expect(block).toMatch(/runSmoke\(\)/)
    expect(block).toMatch(/runProbe\(\{ useStoredCredential: true \}\)/)
  })

  it('不挂 LearningBanner、不渲染 <pre>、/detect 仍是独立卡片', () => {
    const start = panel.indexOf('function ConnectivityField')
    const block = panel.slice(start, panel.indexOf('function DecisionsField', start))
    expect(block).not.toMatch(/LearningBanner/)
    expect(block).not.toContain('<pre')
    expect(panel).not.toContain('JSON.stringify(smoke')
    expect(panel).toMatch(/function DetectField/)
    expect(panel).toMatch(/styles\.kvList/)
  })

  it('新增的 CSS 类都有规则（verify-artifacts 的廉价版本）', () => {
    const css = readRepoFile('src/client/panel.module.css')
    for (const name of [
      'connectList',
      'connectRow',
      'connectBadgeIdle',
      'connectBadgeRunning',
      'connectBadgeOk',
      'connectBadgeFailed',
      'connectMeta',
      'connectReasonRow',
      'connectReason',
      'connectLogin',
      'summaryHeadline',
      'summaryGrid',
      'summaryRow',
      'summaryLabel',
      'summaryValue',
      'summaryChanged',
      'decisionsHead',
      'decisionsCount',
      'decisionsBody',
      'decisionsItem',
      'decisionsActions',
      'fieldHighlight',
      'guideSteps',
      'guideStep',
      'guideStepTitle',
      'guideStepDetail',
      'guideCode',
      'guideCodeText',
      'guideWarning',
      // The wizard's scroll region and its two method families (user request:
      // the guide did not fit one window, and OAuth had to be visibly distinct
      // from token/cookie import).
      'guideScroll',
      'guideFamilies',
      'guideFamily',
      'guideFamilyHead',
      'guideFamilyBadge',
      'guideFamilyBadgeOauth',
      'guideFamilyBadgeManual',
      'guideFamilyHint',
      'guideFamilyEmpty',
      'guideMethodRow',
      'guideMethodBase',
      'guideMethodActive',
      'guideMethodTitle',
      'guideMethodKind',
    ]) {
      expect(css, `.${name} 必须有真实规则`).toMatch(new RegExp(`\\.${name}\\s*\\{`))
    }
  })
})

describe('向导是单独一个界面，且不含新依赖', () => {
  const guide = readRepoFile('src/client/credential-guide.tsx')
  const css = readRepoFile('src/client/panel.module.css')

  it('按 loginGuideFor 渲染步骤，URL 可复制也可打开', () => {
    expect(guide).toMatch(/loginGuideFor\(source, method\)/)
    expect(guide).toMatch(/guide\.copyLink/)
    expect(guide).toMatch(/guide\.open/)
    expect(guide).toMatch(/window\.open/)
  })

  it('内容装不下一个窗口：正文在滚动区里，关闭按钮在滚动区之外', () => {
    // The scroll container must exist and the footer must NOT be inside it, or
    // the close button becomes unreachable on a long guide.
    expect(guide).toMatch(/styles\.guideScroll/)
    const scrollStart = guide.indexOf('styles.guideScroll')
    const footerStart = guide.indexOf('styles.modalFooter')
    expect(scrollStart).toBeGreaterThan(-1)
    expect(footerStart).toBeGreaterThan(scrollStart)
    // The scroll region is a real box with a bounded height in the stylesheet.
    expect(css).toMatch(/\.guideScroll\s*\{[\s\S]*max-height/)
    expect(css).toMatch(/\.guideScroll\s*\{[\s\S]*overflow-y:\s*auto/)
  })

  it('两种凭据获取方式分组展示，且 OAuth 与手动导入各有自己的标题与徽标', () => {
    // Family membership is DATA (contract), not three `if`s in the view.
    expect(guide).toMatch(/LOGIN_METHOD_FAMILIES/)
    expect(guide).toMatch(/loginMethodsOf\(source, family\)/)
    for (const key of ['guide.family.oauth', 'guide.family.oauthHint', 'guide.family.manual', 'guide.family.manualHint']) {
      expect(guide).toContain(key)
    }
    // A source with no OAuth must SAY so instead of silently showing one family.
    expect(guide).toMatch(/guide\.family\.noOauth/)
    // Each option carries its kind (token vs cookie) so the two families cannot
    // be confused by wording alone.
    expect(guide).toMatch(/guide\.kind\.cookie/)
    expect(guide).toMatch(/guide\.kind\.token/)
    // Both group headings are their own visual elements, not one bold line.
    expect(guide).toMatch(/guideFamilyBadgeOauth/)
    expect(guide).toMatch(/guideFamilyBadgeManual/)
  })

  it('切换方式时不关窗，且切换会清掉上一个方式留下的值', () => {
    expect(guide).toMatch(/const selectMethod = \(next: LoginMethodId\)/)
    // The clearing effect is keyed on the method, so a switch wipes every field.
    expect(guide).toMatch(/\[state\.open, source, method\]/)
    expect(guide).toMatch(/setFields\(\{\}\)/)
  })

  it('window.open 在点击处理里同步调用（否则会被弹窗拦截）', () => {
    expect(guide).toMatch(/onClick=\{\(\) => openUrl\(/)
    // No await may precede the open call inside the handler.
    expect(guide).not.toMatch(/await[^\n]*window\.open/)
  })

  it('回调地址用契约常量拼，不手写路径', () => {
    expect(guide).toMatch(/\$\{OAUTH_CALLBACK_PATH\}/)
    expect(guide).not.toContain("'/api/dsh-codehub/oauth/callback'")
  })

  it('CDP 路径必须先勾选「我已了解风险」，结果只给名称与数量', () => {
    expect(guide).toMatch(/guide\.cdpConsent/)
    expect(guide).toMatch(/disabled=\{busy !== null \|\| !consent\}/)
    expect(guide).toMatch(/guide\.cdpNames/)
    expect(guide).toMatch(/guide\.cdpCount/)
    // 只有 whitelist 出来的字段被渲染，值不可能出现。
    expect(guide).not.toMatch(/cookieHeader/)
  })

  it('登录对话框仍是向导入口，且保留手动粘贴兜底', () => {
    const dialog = readRepoFile('src/client/login-dialog.tsx')
    expect(dialog).toMatch(/openCredentialGuide/)
    expect(dialog).toMatch(/CredentialGuide/)
    expect(dialog).toMatch(/saveCredential\(source, kind, draftValue\)/)
    // 值只在输入框与请求体各存在一次；提交后立即清空。
    expect(dialog).toMatch(/setValue\(''\)/)
    // No storage API is ever touched (the values contract is about USE, so the
    // prose that names localStorage is deliberately not what is matched here).
    expect(dialog).not.toMatch(/(window\.)?(local|session)Storage\s*[.[]/)
    expect(guide).not.toMatch(/(window\.)?(local|session)Storage\s*[.[]/)
  })

  it('CDP 开关就在向导里：关着时明说要先打开，并且能一键打开并立即保存', () => {
    // 用户要求：「要么放到向导里，要么向导里有明显提示要到主界面打开 CDP 才能使用」。
    expect(guide).toContain('guide.cdpDisabledNotice')
    expect(guide).toContain('guide.cdpEnable')
    expect(guide).toContain('guide.cdpEnableHint')
    // 打开后要说明去哪儿关，避免开关变成单向门。
    expect(guide).toContain('guide.cdpEnabled')
    // 未启用时「读取」按钮就是禁用的（不能点了之后才慢慢失败）。
    expect(guide).toMatch(/!configState\.config\.csdnCdpEnabled/)
    // 一键启用必须「立即保存」：只排期自动保存的话 host 还没拿到标记，下一次点击必然 403。
    expect(guide).toMatch(/await autoSaveNow\(\)/)
    expect(guide).toMatch(/csdnCdpEnabled: true/)
    // 保存失败时有明确去向，而不是静默。
    expect(guide).toContain('guide.cdpEnableFailed')
  })

  it('「启动调试浏览器」属于 CDP 抓取那一步，不另起编号步骤', () => {
    // The whole CDP path lives in one pane: 启用 → 启动 → 在那个窗口登录 → 同意 → 读取。
    expect(guide).toContain('launchDebugBrowser')
    expect(guide).toContain('csdn.cdp.launch')
    // 没有「③ …（就在这一步完成，不用回主界面）」这种编号标题与解说腔。
    expect(guide).not.toContain('guide.cdpStepLaunch')
    expect(readRepoFile('src/client/locales.ts')).not.toContain('不用回主界面')
    // 未启用时按钮禁用并说明原因（不能点了才发现 host 拒绝）。
    expect(guide).toContain('guide.cdpLaunchNeedsEnable')
    // 启动时把登录页一起打开：独立配置目录一开始是未登录的。
    expect(guide).toContain('LOGIN_URLS.csdnLogin')
    // 启动结果就地显示（含「请在那个窗口登录 CSDN」的下一步）。
    expect(guide).toContain('launchNote')
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
