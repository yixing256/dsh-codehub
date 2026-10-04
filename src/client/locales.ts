/**
 * dsh-codehub — browser-half dictionaries (zh / en).
 *
 * The dictionary is a FLAT dot-key map. `en` is typed as `Record<LocaleKey, string>`
 * so a key added to `zh` without an English counterpart is a compile error — the
 * two languages cannot drift.
 *
 * `zh` is the source of truth for keys; `en` mirrors it. The runtime hands each
 * seat a `t` already bound to `LOCALE_NAMESPACE`; `useTranslate` prefers that,
 * and falls back to the translate bound at `apply()` time (some seats — the
 * keyed `main` seat and the `shell.overlay` seats — are registered without a
 * `locale` field, so they may receive no `t` at all).
 *
 * Anti-copy / provenance strings are deliberately NOT in this dictionary: the
 * rendered banner, the local-proxy scope note and the CSDN provenance note come
 * from `src/contract.ts` constants, so the single source of truth for them is
 * the contract and never a translated copy.
 */

import { useEffect } from 'react'

export const zh = {
  // -- shell / status ------------------------------------------------------
  'panel.title': 'DSH CodeHub',
  'panel.subtitle': '代码用法学习源 · 不是代码搬运器',
  'panel.hostReady': '已连接 host 路由',
  'panel.hostUnavailable': '未接入 host（/api/dsh-codehub/config 不可达）',
  'panel.loading': '加载中…',
  'panel.refresh': '重新读取配置',
  'panel.refreshing': '读取中…',
  'panel.save': '保存到 host',
  'panel.saving': '保存中…',
  'panel.saved': '已保存到 host',
  'panel.dirty': '有未保存的改动',
  'panel.clean': '与 host 配置一致',
  'panel.revert': '撤销改动',
  'panel.describeConfig': '配置接口：GET / PATCH /api/dsh-codehub/config',

  // -- learning-only banner (constant rendered next to it) -----------------
  'banner.resultsTitle': '学习参考用输出',

  // -- unresolved decisions ------------------------------------------------
  'decisions.title': '尚未决定的选项',
  'decisions.hint': '这些项没配置前，agent 调用 learn_code_from_web 会被直接拒绝，并先来问你。',
  'decisions.empty': '四个决策点都已配置。',
  'decisions.control': '设置位置',
  'decisions.refresh': '重新检查',
  'decisions.unavailable': '暂时读不到决策点状态（/api/dsh-codehub/decisions 不可达）。',

  // -- 1. source priority --------------------------------------------------
  'source.title': '源优先级',
  'source.hint': '拖拽排序，或使用上移 / 下移按钮（按钮是键盘与触屏的降级路径）。',
  'source.empty': '尚未设置优先级 —— 空列表表示「未决策」，agent 会先问你。',
  'source.moveUp': '上移',
  'source.moveDown': '下移',
  'source.dragHandle': '拖拽排序',
  'source.remove': '移出',
  'source.add': '加入',
  'source.preset': '填入推荐顺序 GitHub → Gitee → CSDN',
  'source.reset': '清空（回到未决策）',

  // -- 2. GitHub access ----------------------------------------------------
  'github.title': 'GitHub 访问方式',
  'github.hint': '每一项都必须由你主动勾选；插件不内置代理、不自动改 hosts。',
  'github.requirement': '前置条件',
  'github.tokenCarried': '会带 token',
  'github.tokenStripped': '不带 token',
  'github.tokenMirrorConflict':
    '已同时勾选「携带 token」的方式与「镜像转发」的方式：镜像路径会在构造请求时强制剥离 token，长期凭据不会交给第三方转发站。',
  'github.wattNote': 'Watt Toolkit 需你自行安装并勾选 GitHub；插件只做检测，不自带也不内置。',

  'risk.stable': '稳定',
  'risk.temporary': '临时',
  'risk.privacy-risk': '有隐私风险',
  'risk.not-recommended': '不推荐',

  // -- 3./4. tri-state decisions ------------------------------------------
  'failover.title': '失败自动降级',
  'failover.hint': '某个源失败（网络 / 超时 / 限流 / 需要登录）时自动切到下一个源。',
  'merge.title': '多源合并',
  'merge.hint': '多个源都命中时合并去重，而不是只用最高优先级的那个源。',
  'tristate.undecided': '未定',
  'tristate.on': '开',
  'tristate.off': '关',
  'tristate.undecidedNote': '尚未决定，agent 会先问你',

  // -- 5./6. accounts ------------------------------------------------------
  'account.github': 'GitHub Token 登录',
  'account.gitee': 'Gitee 登录',
  'account.csdn': 'CSDN 登录',
  'account.status': '登录状态',
  'account.configured': '已配置',
  'account.notConfigured': '未配置',
  'account.login': '登录',
  'account.relogin': '重新登录',
  'account.logout': '登出',
  'account.loggingOut': '清除中…',
  'account.githubHint': '选择「官方直连 API / Token 登录」时才会带上；镜像与第三方转发路径一律剥离 token。',
  'account.giteeHint': '无 token 时仍可查公开端点；空结果会标成 auth-required，不会伪造数据。',
  'account.csdnHint': '匿名搜索可用；受限结果会降低 confidence。',
  'account.neverShown': '界面只显示「已配置 / 未配置」，不显示值本身。',

  // -- 7. mirrors ----------------------------------------------------------
  'mirror.title': '镜像源列表',
  'mirror.hint': '不预填任何数据；列表为空 = 该方式不可用，插件不会兜底。',
  'mirror.webTitle': '网页 / API 代理基址（ghproxy、ghfast.top 等）',
  'mirror.rawTitle': 'raw 文件镜像基址',
  'mirror.webPlaceholder': 'https://ghproxy.net/',
  'mirror.rawPlaceholder': 'https://ghproxy.net/https://raw.githubusercontent.com',
  'mirror.add': '添加一行',
  'mirror.remove': '删除这一行',
  'mirror.empty': '（空列表，未预填任何数据）',
  'mirror.rawNote': '本机实测 raw.githubusercontent.com 不可直连，使用 raw 文件必须依赖这里填的镜像。',

  // -- 8. local proxy (label/help come from contract constants) ------------
  'proxy.placeholder': '127.0.0.1:7890',
  'proxy.empty': '未填写 = 该方式不出现在可用路径里。',

  // -- 9./10. limits -------------------------------------------------------
  'limits.title': '超时 / 重试 / 上限',
  'limits.hint': '可以调小，不能超过硬顶；硬顶由插件强制收敛。',
  'limits.timeoutMs': '单次请求超时 (ms)',
  'limits.retries': '重试次数',
  'limits.maxDepth': '递归深度上限',
  'limits.maxItems': '单次最大条目数',
  'limits.maxCodeChars': '单条代码片段最大字符数',
  'limits.hardCap': '硬顶',

  // -- 11. deep read -------------------------------------------------------
  'deepread.title': '深度阅读目标',
  'deepread.hint': '未选 = 只做浅搜索。深读产出的是思路笔记（LearnNote），不是文件副本。',
  'deepread.readme': 'README',
  'deepread.entry': '入口文件',
  'deepread.core': '核心模块',
  'deepread.tests': '测试',

  // -- 12. where the plugin appears ----------------------------------------
  // A plain saved setting: both surfaces are ON by default, and the user changes
  // it here. There is deliberately no first-run chooser to ask with.
  'entry.title': '显示位置',
  'entry.hint': '默认侧边栏和设置页都显示。改完点「保存」生效，不用重新加载页面。',
  'entry.sidebar': '侧边栏面板',
  'entry.sidebarDesc': '侧边栏顶部显示 GitHub 猫标 + codehub，点开是完整面板。',
  'entry.settings': '设置页',
  'entry.settingsDesc': '在设置里增加一节「DSH CodeHub 设置」。',
  'entry.both': '侧边栏 + 设置页（默认）',
  'entry.bothDesc': '两处都显示，也是最省事的选项。',
  'entry.current': '当前生效',
  'entry.inSync': '与已保存的设置一致',
  'entry.unsaved': '已改动，点保存后才生效',
  'entry.save': '保存显示位置',
  'entry.saving': '保存中…',

  // -- 13. CSDN provenance (constant rendered next to it) ------------------
  'csdn.endpoint': '搜索端点',

  // -- environment probes --------------------------------------------------
  'tools.title': '环境探测与自检',
  'tools.detectRun': '探测系统代理 / SOCKS5 / Watt / hosts',
  'tools.detecting': '探测中…',
  'tools.detectEmpty': '尚未探测。',
  'tools.smokeRun': '运行连通性自检',
  'tools.smokeRunning': '自检中…',
  'tools.smokeEmpty': '尚未运行自检。',
  'tools.results': '结果',

  // -- login dialog --------------------------------------------------------
  'login.githubTitle': '登录 GitHub',
  'login.giteeTitle': '登录 Gitee',
  'login.csdnTitle': '登录 CSDN',
  'login.githubTokenLabel': 'GitHub 个人访问令牌（PAT）',
  'login.tokenLabel': 'Gitee 私人令牌（access_token）',
  'login.cookieLabel': 'CSDN Cookie',
  'login.tokenPlaceholder': '粘贴 token（提交后输入框立即清空）',
  'login.cookiePlaceholder': '粘贴 cookie（提交后输入框立即清空）',
  'login.serviceUnavailable': '本机凭证服务不可用（503）—— 请确认 DSH 凭证服务已就绪后重试。',
  'login.submit': '提交凭据',
  'login.submitting': '提交中…',
  'login.clear': '清除已配置凭据',
  'login.clearing': '清除中…',
  'login.empty': '内容不能为空。',
  'login.cancel': '取消',
  'login.security': '凭据只存在 DSH 凭证服务里，不会写进配置文件，也不会进 git。',
  'login.once': '值只在提交时传输一次：不回显、不写入 localStorage、提交后立即清空输入框。',
  'login.status': '当前状态',
  'login.type': '凭据类型',
  'login.typeToken': 'token',
  'login.typeCookie': 'cookie',

  // -- settings page -------------------------------------------------------
  'settings.title': 'DSH CodeHub 设置',
  'settings.intro': '与侧边栏面板共用同一份配置（GET / PATCH /api/dsh-codehub/config），字段一致，布局更适合表单。',
  'settings.syncReady': 'settingsScope 可用：保存时会顺带同步到 DSH settings。',
  'settings.syncLoading': 'settingsScope 正在加载。',
  'settings.syncUnavailable': 'settingsScope 不可用（本 namespace 不在白名单内）—— 配置仍通过插件自己的路由读写，不受影响。',
  'settings.syncAbsent': '没有探测到 settingsScope 服务，仅使用插件自己的路由。',
  'settings.syncPull': '从 DSH settings 拉取',
  'settings.pullDone': '已从 DSH settings 拉取到草稿（保存在 host 前不会生效）。',
  'settings.pullEmpty': 'settingsScope 没有可拉取的配置。',
  'settings.formHint': '表单布局 · 与面板同源',

  // -- errors --------------------------------------------------------------
  'error.timeout': '请求超时',
  'error.network': '网络请求失败',
  'error.parse': '响应不是合法 JSON',
  'error.http': '请求被拒绝',
  'error.unavailable': 'host 路由不可达',
  'error.unknown': '未知错误',
  'error.retry': '重试',

  // -- shared --------------------------------------------------------------
  'common.dash': '—',
  'common.close': '关闭',
  'common.none': '无',
} as const

/** Every dictionary key. Adding a key to `zh` without `en` fails to compile. */
export type LocaleKey = keyof typeof zh

/** A translate function bound to this plugin's dictionary. */
export type Translate = (key: LocaleKey) => string

export const en: Record<LocaleKey, string> = {
  'panel.title': 'DSH CodeHub',
  'panel.subtitle': 'Code-usage learning source · not a code copier',
  'panel.hostReady': 'Connected to the host route',
  'panel.hostUnavailable': 'Host not reachable (/api/dsh-codehub/config failed)',
  'panel.loading': 'Loading…',
  'panel.refresh': 'Reload config',
  'panel.refreshing': 'Reloading…',
  'panel.save': 'Save to host',
  'panel.saving': 'Saving…',
  'panel.saved': 'Saved to host',
  'panel.dirty': 'Unsaved changes',
  'panel.clean': 'In sync with the host',
  'panel.revert': 'Revert changes',
  'panel.describeConfig': 'Config route: GET / PATCH /api/dsh-codehub/config',

  'banner.resultsTitle': 'Study-only output',

  'decisions.title': 'Undecided options',
  'decisions.hint':
    'Until these are set, learn_code_from_web refuses to run and asks you first (zero network requests).',
  'decisions.empty': 'All four decisions are configured.',
  'decisions.control': 'Where to set it',
  'decisions.refresh': 'Re-check',
  'decisions.unavailable': 'Cannot read decision state right now (/api/dsh-codehub/decisions failed).',

  'source.title': 'Source priority',
  'source.hint': 'Drag, or use the move up / move down buttons (the buttons are the keyboard & touch path).',
  'source.empty': 'No priority yet — an empty list means "undecided", so the agent asks you first.',
  'source.moveUp': 'Move up',
  'source.moveDown': 'Move down',
  'source.dragHandle': 'Drag to reorder',
  'source.remove': 'Remove',
  'source.add': 'Add',
  'source.preset': 'Fill recommended order GitHub → Gitee → CSDN',
  'source.reset': 'Clear (back to undecided)',

  'github.title': 'GitHub access method',
  'github.hint': 'Every method is opt-in. The plugin ships no proxy and never edits your hosts file.',
  'github.requirement': 'Requirement',
  'github.tokenCarried': 'carries token',
  'github.tokenStripped': 'token stripped',
  'github.tokenMirrorConflict':
    'A token-carrying method and a mirror-forwarding method are both selected: mirror paths strip the token at request-build time, so long-lived credentials never reach a third-party relay.',
  'github.wattNote': 'Watt Toolkit is yours to install and enable for GitHub; the plugin only detects it.',

  'risk.stable': 'Stable',
  'risk.temporary': 'Temporary',
  'risk.privacy-risk': 'Privacy risk',
  'risk.not-recommended': 'Not recommended',

  'failover.title': 'Automatic failover',
  'failover.hint': 'On a failing source (network / timeout / rate limit / auth), move to the next source.',
  'merge.title': 'Merge sources',
  'merge.hint': 'When several sources hit, merge and de-duplicate instead of using only the top source.',
  'tristate.undecided': 'Undecided',
  'tristate.on': 'On',
  'tristate.off': 'Off',
  'tristate.undecidedNote': 'Undecided — the agent will ask you first',

  'account.github': 'GitHub token sign-in',
  'account.gitee': 'Gitee sign-in',
  'account.csdn': 'CSDN sign-in',
  'account.status': 'Sign-in status',
  'account.configured': 'Configured',
  'account.notConfigured': 'Not configured',
  'account.login': 'Sign in',
  'account.relogin': 'Replace credential',
  'account.logout': 'Sign out',
  'account.loggingOut': 'Clearing…',
  'account.githubHint':
    'Only attached on the official direct API / token methods; mirror and third-party relay paths always strip it.',
  'account.giteeHint':
    'Without a token the public endpoints still work; empty results are reported as auth-required, never fabricated.',
  'account.csdnHint': 'Anonymous search works; restricted results get a lower confidence.',
  'account.neverShown': 'The UI only shows configured / not configured — never the value itself.',

  'mirror.title': 'Mirror bases',
  'mirror.hint': 'Nothing is pre-filled. An empty list means the method is unavailable — there is no fallback.',
  'mirror.webTitle': 'Web / API proxy bases (ghproxy, ghfast.top, …)',
  'mirror.rawTitle': 'raw file mirror bases',
  'mirror.webPlaceholder': 'https://ghproxy.net/',
  'mirror.rawPlaceholder': 'https://ghproxy.net/https://raw.githubusercontent.com',
  'mirror.add': 'Add a row',
  'mirror.remove': 'Remove this row',
  'mirror.empty': '(empty list — nothing pre-filled)',
  'mirror.rawNote':
    'raw.githubusercontent.com is not directly reachable from this host, so raw file access depends on the mirror you enter here.',

  'proxy.placeholder': '127.0.0.1:7890',
  'proxy.empty': 'Left empty = this method never appears in the usable paths.',

  'limits.title': 'Timeouts, retries and caps',
  'limits.hint': 'Values may be lowered but never raised past the hard caps; the plugin clamps them.',
  'limits.timeoutMs': 'Request timeout (ms)',
  'limits.retries': 'Retries',
  'limits.maxDepth': 'Recursion depth cap',
  'limits.maxItems': 'Max items per call',
  'limits.maxCodeChars': 'Max chars per code excerpt',
  'limits.hardCap': 'hard cap',

  'deepread.title': 'Deep-read targets',
  'deepread.hint':
    'Nothing selected = shallow search only. Deep reading yields design notes (LearnNote), never file copies.',
  'deepread.readme': 'README',
  'deepread.entry': 'Entry file',
  'deepread.core': 'Core modules',
  'deepread.tests': 'Tests',

  // -- 12. where the plugin appears ----------------------------------------
  'entry.title': 'Where it appears',
  'entry.hint': 'Both surfaces are on by default. Change them here and press Save — no page reload needed.',
  'entry.sidebar': 'Sidebar panel',
  'entry.sidebarDesc': 'Puts the GitHub cat mark + codehub at the top of the sidebar; opens the full panel.',
  'entry.settings': 'Settings page',
  'entry.settingsDesc': 'Adds a "DSH CodeHub settings" section to settings.',
  'entry.both': 'Sidebar + settings page (default)',
  'entry.bothDesc': 'Both surfaces — the least surprising choice.',
  'entry.current': 'In effect',
  'entry.inSync': 'Matches the saved setting',
  'entry.unsaved': 'Changed — press Save to apply',
  'entry.save': 'Save placement',
  'entry.saving': 'Saving…',

  'csdn.endpoint': 'Search endpoint',

  'tools.title': 'Environment probe and self-check',
  'tools.detectRun': 'Probe system proxy / SOCKS5 / Watt / hosts',
  'tools.detecting': 'Probing…',
  'tools.detectEmpty': 'Not probed yet.',
  'tools.smokeRun': 'Run connectivity self-check',
  'tools.smokeRunning': 'Running…',
  'tools.smokeEmpty': 'Self-check has not run yet.',
  'tools.results': 'Result',

  'login.githubTitle': 'Sign in to GitHub',
  'login.giteeTitle': 'Sign in to Gitee',
  'login.csdnTitle': 'Sign in to CSDN',
  'login.githubTokenLabel': 'GitHub personal access token (PAT)',
  'login.tokenLabel': 'Gitee personal token (access_token)',
  'login.cookieLabel': 'CSDN cookie',
  'login.tokenPlaceholder': 'Paste the token (the field is cleared right after submit)',
  'login.cookiePlaceholder': 'Paste the cookie (the field is cleared right after submit)',
  'login.serviceUnavailable':
    'The local credential service is unavailable (503) — check that the DSH credential service is up, then retry.',
  'login.submit': 'Submit credential',
  'login.submitting': 'Submitting…',
  'login.clear': 'Remove stored credential',
  'login.clearing': 'Removing…',
  'login.empty': 'The value cannot be empty.',
  'login.cancel': 'Cancel',
  'login.security': 'The credential lives only in the DSH credential service — never in a config file, never in git.',
  'login.once':
    'The value travels exactly once, at submit time: never echoed back, never written to localStorage, cleared from the field immediately.',
  'login.status': 'Current status',
  'login.type': 'Credential kind',
  'login.typeToken': 'token',
  'login.typeCookie': 'cookie',

  'settings.title': 'DSH CodeHub settings',
  'settings.intro':
    'Shares one config source with the sidebar panel (GET / PATCH /api/dsh-codehub/config); same fields, form-friendly layout.',
  'settings.syncReady': 'settingsScope is available: saving also syncs it into DSH settings.',
  'settings.syncLoading': 'settingsScope is loading.',
  'settings.syncUnavailable':
    'settingsScope is unavailable (this namespace is not on the allow-list) — config still goes through the plugin route, unaffected.',
  'settings.syncAbsent': 'No settingsScope service detected; using the plugin route only.',
  'settings.syncPull': 'Pull from DSH settings',
  'settings.pullDone': 'Pulled from DSH settings into the draft (not applied until you save).',
  'settings.pullEmpty': 'settingsScope has no config to pull.',
  'settings.formHint': 'Form layout · same source as the panel',

  'error.timeout': 'Request timed out',
  'error.network': 'Network request failed',
  'error.parse': 'Response is not valid JSON',
  'error.http': 'Request rejected',
  'error.unavailable': 'Host route unavailable',
  'error.unknown': 'Unknown error',
  'error.retry': 'Retry',

  'common.dash': '—',
  'common.close': 'Close',
  'common.none': 'none',
}

/**
 * The translate bound at `apply()` time (`ctx.locale.bind(LOCALE_NAMESPACE)`).
 * Module-level on purpose: the keyed `main` seat and the overlay seats may be
 * rendered without a `t` prop.
 */
let active: Translate | null = null

export function setActiveTranslate(next: Translate | null): void {
  active = next
}

/** Translate through the active binding, falling back to the zh dictionary. */
export function translateNow(key: LocaleKey): string {
  const t = active
  if (t) {
    try {
      const out = t(key)
      if (typeof out === 'string' && out.length > 0) return out
    } catch {
      /* a broken locale service must never break a seat render */
    }
  }
  return zh[key]
}

const fallbackTranslate: Translate = key => zh[key]

/**
 * Plain `Record<string, string>` copies for `ctx.locale.register`.
 *
 * The literal-typed dictionaries are what give us compile-time key parity; the
 * registration API wants an index-signature map, so the copies keep that
 * boundary explicit instead of relying on an implicit index signature.
 */
export function dictionaries(): { zh: Record<string, string>; en: Record<string, string> } {
  return { zh: { ...zh }, en: { ...en } }
}

/**
 * Resolve the translate for a seat: the prop the renderer passed wins, then the
 * binding captured at apply time, then the raw zh dictionary.
 */
export function useTranslate(props: { t?: Translate }): Translate {
  const provided = typeof props.t === 'function' ? props.t : null
  useEffect(() => {
    if (provided) setActiveTranslate(provided)
  }, [provided])
  return provided ?? active ?? fallbackTranslate
}
