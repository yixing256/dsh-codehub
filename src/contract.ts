/**
 * dsh-codehub — frozen contract surface.
 *
 * OWNER: lead. This file is LOCKED once opened for parallel work: every other
 * module (host half, source adapters, learn layer, client half, tests) imports
 * its names from here instead of re-spelling literals. Changing a value here
 * changes it everywhere, which is the point.
 *
 * Why the anti-copy strings live here and are exported as single constants:
 * 备注③ requires the anti-plagiarism statement to be written into BOTH the
 * `learn_code_from_web` tool description AND the system-prompt section. Two
 * hand-maintained copies would drift; one constant plus a test that asserts
 * both surfaces reference it cannot.
 *
 * Plugin identity is fixed by the user and must never be aliased or renamed:
 * package name, cordis.patch.yml row name, README title and this service all
 * spell `dsh-codehub`.
 */

// ---------------------------------------------------------------------------
// Identity — never rename, never alias.
// ---------------------------------------------------------------------------

/** Cordis plugin name. */
export const name = 'dsh-codehub'

/** npm package name; also the cordis.patch.yml insert row `name`. */
export const PACKAGE_NAME = 'dsh-codehub'

/** The host service key this plugin provides, consumed as `ctx.codeSource`. */
export const SERVICE_KEY = 'codeSource'

/** The single agent tool this plugin registers. */
export const TOOL_NAME = 'learn_code_from_web'

/** Settings namespace. Matches the profile entry id (the loader keys forms by it). */
export const SETTINGS_NAMESPACE = 'dsh-codehub'

/** Locale namespace owned by the browser half. */
export const LOCALE_NAMESPACE = 'dsh-codehub'

/** Host plugin context this plugin requires before any surface mounts. */
export const inject = ['tools', 'webServer', 'systemPrompt'] as const

/** Slot used by the login dialogs. */
export const OVERLAY_SLOT = 'shell.overlay'

/** Ordered position of our system-prompt section (the tool-guidance band). */
export const PROMPT_SECTION_ORDER = 150

// ---------------------------------------------------------------------------
// Browser-half seat identity.
//
// One id, one label, one order — shared by the sidebar row, the `main` key and
// the settings section, so the three seats cannot drift apart, and imported by
// the tests that assert they agree.
// ---------------------------------------------------------------------------

/**
 * The seat id: the `sidebar.panellist` row id, the `main` slot key and the
 * `settings.section` id are all this one value.
 */
export const UI_ENTRY_ID = 'codehub'

/**
 * The sidebar row's visible text. The shell owns the row chrome (button,
 * tooltip, rail geometry) and renders this label next to the glyph we draw, so
 * the user sees the GitHub cat mark followed by exactly this word.
 */
export const UI_ENTRY_LABEL = 'codehub'

/**
 * The sidebar row's position. The rail sorts ascending, so a SMALL number puts
 * the row near the top — which is where the user asked for it.
 */
export const UI_ENTRY_ORDER = 5

/** Order of the settings section in the settings page. */
export const UI_SETTINGS_ORDER = 30

/** Order of the login overlay above other overlays. */
export const UI_OVERLAY_ORDER = 20

/** Loopback-fenced route family served by the host half. */
export const API_PREFIX = '/api/dsh-codehub'

// ---------------------------------------------------------------------------
// 备注② — CSDN v3 endpoint provenance.
//
// This endpoint is NOT a documented public API. It was probed live on the date
// below and answered 200 with a `result_vos[]` array. It can change or vanish
// without notice, so the provenance travels with the base URL everywhere the
// URL is shown: the settings panel, the README and the source header.
// ---------------------------------------------------------------------------

/** Live-probe date for the CSDN endpoint below. */
export const CSDN_API_PROBED_AT = '2026-10-03'

/**
 * CSDN search endpoint base. Non-official internal interface — see
 * CSDN_API_NOTE. Response fields consumed: `result_vos[].title` (contains
 * `<em>` markup), `.body`, `.description`, `.url`, `.originalType`, `.create_time`.
 */
export const CSDN_SEARCH_BASE = 'https://so.csdn.net/api/v3/search'

/**
 * Provenance note for the CSDN endpoint. 备注② requires exactly three facts —
 * non-official, probe date, may break — and a test asserts all three survive in
 * every place this string is rendered.
 */
export const CSDN_API_NOTE =
  'CSDN v3 搜索接口为非官方内部接口（非公开 API），实测日期 ' +
  CSDN_API_PROBED_AT +
  '，字段与可用性可能随时失效；失效时请改用 CSDN 网页搜索或关闭该源。'

/** Gitee v5 API base. */
export const GITEE_API_BASE = 'https://gitee.com/api/v5'

/**
 * Endpoints the brief named for Gitee DO NOT EXIST — and neither does the one
 * this constant used to name as a code search.
 *
 * `https://gitee.com/api/v5/projects?q=...` was probed live and returned 404.
 * `GET /api/v5/search/code` was probed live on 2026-10-04 and returned **404
 * with an HTML "页面不存在" page** — the mock-like code search this plugin used
 * to claim is not a real v5 endpoint at all, so the adapter must never build a
 * request for it again. The only real search endpoint is the repositories one,
 * which answers `[]` for anonymous callers (a token is required for data).
 *
 * `GITEE_CODE_SEARCH_SUPPORTED` makes that a fact the UI, the tool `reason` and
 * the tests can all read instead of each re-stating it.
 */
export const GITEE_SEARCH_REPOSITORIES = '/search/repositories'

/**
 * Gitee v5 has NO code-search endpoint. Measured 2026-10-04: `/search/code`
 * answers 404 (HTML page-not-found) — this is not "needs a login", the endpoint
 * simply does not exist. Gitee's *web* code search lives at search.gitee.com and
 * renders client-side, so it needs a logged-in browser session. The path literal
 * deliberately does NOT exist as a constant here: while it did, an adapter built
 * requests for it (see the removed `searchGiteeCode`).
 */
export const GITEE_CODE_SEARCH_SUPPORTED = false

/** GitHub API base. Probed live: reachable directly (HTTP 200). */
export const GITHUB_API_BASE = 'https://api.github.com'

/**
 * Raw-content origin. Probed live: NOT reachable from this host. Kept as the
 * default value of the configurable raw-mirror list so the UI can show what a
 * mirror is a mirror *of*; requests go through the user's mirror bases instead.
 */
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com'

// ---------------------------------------------------------------------------
// 备注① — local proxy applicability.
//
// The plugin has two transports. `node` is our own outbound fetch and is the
// only one a proxy address can steer. `dsh-web` rides the harness's own web
// service, whose egress we cannot configure. The settings UI must say so; a
// test asserts this exact phrase survives into the rendered label.
// ---------------------------------------------------------------------------

/** The exact phrase 备注① requires on the local-proxy control. */
export const LOCAL_PROXY_SCOPE_NOTE = '仅 Node 直连传输生效'

/** Local-proxy control label, carrying the scope note. */
export const LOCAL_PROXY_LABEL = '本机代理 / SOCKS5 地址'

/** Local-proxy help text, carrying the scope note plus the reason. */
export const LOCAL_PROXY_HELP =
  '形如 127.0.0.1:7890。该设置（' +
  LOCAL_PROXY_SCOPE_NOTE +
  '）：仅当传输通道为 Node 直连时应用；走 DSH 自带 web 通道时由 Harness 负责出网，本插件无法为其注入代理。'

// ---------------------------------------------------------------------------
// Learning sources.
// ---------------------------------------------------------------------------

/** The three supported learning sources, in the user's canonical reading order. */
export const SOURCES = ['github', 'gitee', 'csdn'] as const

export type SourceId = (typeof SOURCES)[number]

/** Human-facing source names for prompts and rendered output. */
export const SOURCE_LABELS: Readonly<Record<SourceId, string>> = {
  github: 'GitHub',
  gitee: 'Gitee',
  csdn: 'CSDN',
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

/**
 * How a request reaches the network.
 * - `dsh-web`: the harness's own web service (`ctx.web.fetch`). Preferred when
 *   available, since it is the sanctioned egress path.
 * - `node`: global `fetch` from this process. Required for token-bearing
 *   requests the user wants kept off the shared channel, and the only transport
 *   a local proxy (备注①) can steer.
 */
export const TRANSPORTS = ['dsh-web', 'node'] as const

export type TransportId = (typeof TRANSPORTS)[number]

// ---------------------------------------------------------------------------
// GitHub access strategies. Every one must be explicitly opt-in by the user.
// ---------------------------------------------------------------------------

export const GITHUB_ACCESS = [
  'direct',
  'token',
  'ghproxy',
  'raw-mirror',
  'local-proxy',
  'watt',
  'hosts',
  'third-party-mirror',
] as const

export type GithubAccessId = (typeof GITHUB_ACCESS)[number]

/** Risk band shown as a tab in the settings panel. */
export const ACCESS_RISK = ['stable', 'temporary', 'privacy-risk', 'not-recommended'] as const

export type AccessRisk = (typeof ACCESS_RISK)[number]

/** One option row in the GitHub access picker. */
export interface AccessOption {
  readonly id: GithubAccessId
  readonly label: string
  readonly risk: AccessRisk
  /** What the user must do before it can be selected. */
  readonly requirement: string
  /**
   * When true a token is attached. Mirrors on this list MUST be false: a token
   * handed to a third-party mirror is a credential leak, so the picker forbids
   * the combination and the request builder re-checks it.
   */
  readonly carriesToken: boolean
}

export const ACCESS_OPTIONS: readonly AccessOption[] = [
  {
    id: 'direct',
    label: '官方直连 API',
    risk: 'stable',
    requirement: '无需配置。实测 api.github.com 可达。',
    carriesToken: true,
  },
  {
    id: 'token',
    label: 'GitHub Token 登录',
    risk: 'stable',
    requirement: '在下方填入 token（仅存入凭证服务，不回显）。提升额度并允许私有仓库。',
    carriesToken: true,
  },
  {
    id: 'ghproxy',
    label: '网页 / API 代理（ghproxy、ghfast.top 等）',
    risk: 'temporary',
    requirement: '在镜像源列表里自行增删代理基址。公共公益节点随时可能失效。',
    carriesToken: false,
  },
  {
    id: 'raw-mirror',
    label: 'raw 文件镜像（仅文件下载用）',
    risk: 'temporary',
    requirement: '在 raw 镜像列表里填入基址；本机实测 raw.githubusercontent.com 不可直连，必须依赖此项。',
    carriesToken: false,
  },
  {
    id: 'local-proxy',
    label: LOCAL_PROXY_LABEL,
    risk: 'temporary',
    requirement: LOCAL_PROXY_HELP,
    carriesToken: true,
  },
  {
    id: 'watt',
    label: 'Watt Toolkit（原名 Steam++）',
    risk: 'stable',
    requirement:
      '可安装 Watt Toolkit（官网 steampp.net）并在「网络加速」里勾选 GitHub；本插件自动检测系统代理 / Hosts 是否已生效。插件不自带 Watt Toolkit，也不内置任何代理。',
    carriesToken: true,
  },
  {
    id: 'hosts',
    label: 'Hosts / DNS 优化',
    risk: 'not-recommended',
    requirement: '仅提供说明，不硬编码任何过期 IP。请自行查询当前有效地址。',
    carriesToken: true,
  },
  {
    id: 'third-party-mirror',
    label: '第三方镜像站',
    risk: 'privacy-risk',
    requirement: '请求经第三方转发，可能被记录。此路径强制剥离 token，仅用于公开内容。',
    carriesToken: false,
  },
]

/** Strategies that must never carry a token, enforced at request-build time. */
export const TOKEN_FORBIDDEN_ACCESS: readonly GithubAccessId[] = ['ghproxy', 'raw-mirror', 'third-party-mirror']

// ---------------------------------------------------------------------------
// Failure classification and confidence.
// ---------------------------------------------------------------------------

/**
 * Failure taxonomy the user specified. Every adapter failure maps to exactly
 * one of these; the category (not the raw error) drives failover and the
 * `reason` the agent sees.
 */
export const FAILURE_KINDS = [
  'network',
  'timeout',
  'empty',
  'rate-limited',
  'auth-required',
  'parse-failed',
  'not-code',
] as const

export type FailureKind = (typeof FAILURE_KINDS)[number]

/** Failure kinds a failover chain may advance past. */
export const RETRYABLE_FAILURES: readonly FailureKind[] = ['network', 'timeout', 'rate-limited', 'auth-required']

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const

export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

// ---------------------------------------------------------------------------
// The unified result envelope.
// ---------------------------------------------------------------------------

/**
 * One learning result.
 *
 * `is_verbatim_copy` is typed as the literal `false`, not `boolean`. That is the
 * mechanism-level guarantee 备注③ asks for: there is no assignable value that
 * marks a result as a permitted verbatim copy, so no code path can construct
 * one, and `grep -n "is_verbatim_copy: true"` can never match.
 */
export interface CodeLearnResult {
  /** Which source produced this row. */
  readonly source: SourceId
  /** Canonical, human-openable URL. */
  readonly url: string
  readonly title: string
  /** Detected language, or empty when unknown. */
  readonly language: string
  /**
   * Bounded excerpt, for study only. Displayed with the learning-only banner
   * and never presented as a deliverable. Truncated to `limits.maxCodeChars`.
   */
  readonly code: string
  /** Whether `code` was truncated to fit the bound. */
  readonly codeTruncated: boolean
  /** The takeaway: approach / contract / tradeoff / pitfall. Never the code. */
  readonly learned_summary: string
  /** Structurally fixed. See the interface doc above. */
  readonly is_verbatim_copy: false
  /** Star count when the source reports one, else null. */
  readonly stars: number | null
  /** ISO-8601 last-updated timestamp when known, else null. */
  readonly updatedAt: string | null
  readonly confidence: Confidence
  /** Why this row exists and why it scored the way it did. */
  readonly reason: string
}

/** The banner every rendered result carries. */
export const LEARNING_ONLY_BANNER = '【仅学习参考 · 不得直接粘贴进用户项目】'

// ---------------------------------------------------------------------------
// 备注③ — the anti-plagiarism statement.
//
// Written verbatim into BOTH the tool description and the system-prompt section.
// Consumed as a template (TEACHING_CONTRACT) so one edit reaches both surfaces.
// ---------------------------------------------------------------------------

/** The core boundary statement, shared by the tool and the prompt. */
export const ANTI_COPY_STATEMENT =
  '本插件是「代码用法学习源」，不是代码搬运器。通过本插件拿到的结果只能用于：总结实现思路、提炼 API 用法、对比不同实现取舍、记录踩坑笔记。' +
  '严禁把远端抓到的代码片段原样粘贴进用户项目，不允许生成「直接抄来的函数 / 文件」作为交付物。' +
  '若用户确实需要某段逻辑，只能基于学到的思路、按用户项目既有风格重新手写，并主动说明「这是参考 <来源 URL> 思路重写的，非直接复制」。' +
  '返回结构中的 is_verbatim_copy 恒为 false，code 字段仅作学习参考展示，不得作为交付物转述。'

/** Tool-description clause; 备注③ requires it on the tool itself. */
export const ANTI_COPY_TOOL_CLAUSE =
  '仅用于学习用法，不返回可直接粘贴的代码交付物。' + ANTI_COPY_STATEMENT

/** System-prompt section text. */
export const PROMPT_SECTION_TEXT = '本机已安装 dsh-codehub 插件（DSH 代码用法学习源）。' + ANTI_COPY_STATEMENT

// ---------------------------------------------------------------------------
// Decision gating.
//
// Every entry in this list is a decision the plugin must never make on the
// user's behalf. When one is unset the tool refuses to run, performs zero
// network requests, and hands the agent a question to ask the user. The
// `ask` string is what the agent relays; it is phrased as the user wrote it.
// ---------------------------------------------------------------------------

export const DECISION_KEYS = [
  'sourcePriority',
  'githubAccessPriority',
  'failoverEnabled',
  'mergeSources',
] as const

export type DecisionKey = (typeof DECISION_KEYS)[number]

/** One unresolved decision, surfaced to the agent instead of a silent default. */
export interface UnresolvedDecision {
  readonly key: DecisionKey
  /** What is missing, in one line. */
  readonly detail: string
  /** The question the agent must put to the user before retrying. */
  readonly ask: string
  /** Where the user can set it, when a control exists. */
  readonly control: string
}

export const DECISION_GUIDE: Readonly<Record<DecisionKey, UnresolvedDecision>> = {
  sourcePriority: {
    key: 'sourcePriority',
    detail: '尚未决定三个源的查询优先级（当前为空）。',
    ask: '你想按 GitHub→Gitee→CSDN 还是别的顺序查？',
    control: '侧边栏面板 / 设置页 → 源优先级（拖拽排序）',
  },
  githubAccessPriority: {
    key: 'githubAccessPriority',
    detail: '尚未选择 GitHub 的访问方式（当前为空）。',
    ask: '你本机开了 Watt Toolkit 还是配了代理？我按哪种方式访问 GitHub？',
    control: '侧边栏面板 / 设置页 → GitHub 访问方式',
  },
  failoverEnabled: {
    key: 'failoverEnabled',
    detail: '尚未确认是否开启失败自动降级。',
    ask: '某个源失败时要自动降级到下一个源吗？',
    control: '侧边栏面板 / 设置页 → 失败自动降级（开关）',
  },
  mergeSources: {
    key: 'mergeSources',
    detail: '尚未确认是否多源合并。',
    ask: '多个源都命中时，要我合并去重后再给你，还是只用最高优先级的那个源？',
    control: '侧边栏面板 / 设置页 → 多源合并（开关）',
  },
}

/** Render the refusal payload's human-readable instruction. */
export function decisionPrompt(unresolved: readonly UnresolvedDecision[]): string {
  return unresolved.map(item => item.ask).join('\n')
}

// ---------------------------------------------------------------------------
// Learning / deep-read shape. The product of deep reading is NOTES, never files.
// ---------------------------------------------------------------------------

export const DEEP_READ_TARGETS = ['readme', 'entry', 'core', 'tests'] as const

export type DeepReadTarget = (typeof DEEP_READ_TARGETS)[number]

/** A design/usage note distilled from a repository. Not a file copy. */
export interface LearnNote {
  readonly url: string
  readonly title: string
  /** Architecture / approach in prose. */
  readonly approach: string
  /** Public API surface and its contract, as prose or signatures. */
  readonly apiContract: readonly string[]
  /** Tradeoffs and alternatives the implementation chose between. */
  readonly tradeoffs: readonly string[]
  /** Pitfalls, gotchas and failure modes. */
  readonly pitfalls: readonly string[]
  /** The URLs this note was distilled from — each claim stays traceable. */
  readonly sourceUrls: readonly string[]
}

/** Hard caps. The user may lower them in settings; they may not be raised past these. */
export const HARD_LIMITS = {
  timeoutMs: 120_000,
  retries: 5,
  maxDepth: 3,
  maxItems: 20,
  maxCodeChars: 20_000,
} as const

/** Schema defaults. Deliberately independent of the decision-gated fields. */
export const DEFAULT_LIMITS = {
  timeoutMs: 15_000,
  retries: 2,
  maxDepth: 1,
  maxItems: 8,
  maxCodeChars: 4_000,
} as const

// ---------------------------------------------------------------------------
// Tool I/O schema pieces shared by the tool definition and its tests.
// ---------------------------------------------------------------------------

export const TOOL_PARAMS = ['query', 'sources', 'deepRead', 'maxItems'] as const

// ---------------------------------------------------------------------------
// Login, OAuth and connectivity — 实测事实 + 展示契约.
//
// WHY THIS LIVES IN THE CONTRACT
// ------------------------------
// The user asked, in one breath, for three things that share one fact base:
// a browser login that ends with a token/cookie in the credential service, a
// connectivity panel that must NOT dump raw JSON, and an explicit answer to
// "does querying code need a login?". Every one of those surfaces has to say
// the same thing about the same endpoint, so the sentences live here once and
// the host half, the browser half, the README and the tests all read them.
//
// The facts below were measured on `LOGIN_REQUIREMENT_PROBED_AT` from this
// machine. They are DATA, not marketing: each one names the endpoint, the
// observed status and the consequence. Re-probe before changing them, and keep
// the date in step — three test files assert the evidence and the date survive.
// ---------------------------------------------------------------------------

/** The date the login-requirement facts below were measured live. */
export const LOGIN_REQUIREMENT_PROBED_AT = '2026-10-04'

/**
 * GitHub: repo search and file reads are anonymous; CODE search is not.
 *
 * Measured 2026-10-04: anonymous `GET https://api.github.com/search/code?q=vue`
 * answers **HTTP 401 `Requires authentication`**. A token is therefore
 * mandatory for code search. `github.com` itself was TCP-unreachable from this
 * machine in the same probe (see `GITHUB_HTML_ORIGIN`), which is why the OAuth
 * preflight reports reachability instead of assuming it.
 */
export const GITHUB_LOGIN_REQUIREMENT =
  '查代码必须登录：实测 ' +
  LOGIN_REQUIREMENT_PROBED_AT +
  ' 匿名调用 api.github.com/search/code 返回 HTTP 401 Requires authentication。' +
  '仓库搜索与读取公开文件无需登录。'

/**
 * Gitee: the v5 code-search endpoint does not exist; repository search needs a
 * token; public file contents are readable anonymously.
 *
 * Measured 2026-10-04: `GET https://gitee.com/api/v5/search/code?q=vue` → HTTP
 * 404 HTML「页面不存在」; `GET /api/v5/search/repositories?q=vue` → HTTP 200
 * with `[]` for an anonymous caller; `GET /api/v5/repos/{owner}/{repo}/contents/…`
 * → HTTP 200 anonymously. The web code search (search.gitee.com) renders
 * client-side and needs a logged-in session.
 */
export const GITEE_LOGIN_REQUIREMENT =
  '查代码要登录，但方式不同：实测 ' +
  LOGIN_REQUIREMENT_PROBED_AT +
  ' Gitee v5 没有 /search/code 端点（返回 HTTP 404 页面不存在），网页版代码搜索需要登录；' +
  '仓库搜索匿名返回空数组（需要 token），公开仓库文件内容匿名可读。'

/**
 * CSDN: search is reachable anonymously, but the payload rarely carries code;
 * the article page does, and it is rate-limited/anti-bot gated without a
 * logged-in cookie.
 *
 * Measured 2026-10-04: `https://so.csdn.net/api/v3/search` → HTTP 200, 30 rows,
 * only **6** of them carrying a non-empty `body`, and **no `originalType`
 * field at all**; `blog.csdn.net` article pages → HTTP 200 with real `<pre>`
 * blocks when a browser-like User-Agent + Referer are sent, and **HTTP 521**
 * without them on some articles. A logged-in cookie raises the success rate;
 * CSDN exposes no OAuth and no token API.
 */
export const CSDN_LOGIN_REQUIREMENT =
  'CSDN 没有 OAuth：实测 ' +
  LOGIN_REQUIREMENT_PROBED_AT +
  ' 搜索接口匿名可用（HTTP 200，30 条中仅 6 条带正文），正文代码需要打开文章页；' +
  '文章页缺 UA / Referer 时会被 HTTP 521 反爬拦截，登录 cookie 可提高成功率。'

/**
 * The robots position, stated rather than hidden.
 *
 * `https://so.csdn.net/robots.txt` is exactly `User-agent: *` +
 * `Disallow: /`; `blog.csdn.net/robots.txt` is `Allow: /`. This plugin issues
 * ONE request per user-triggered action and never crawls, which is the position
 * the UI and the README must state next to the endpoint.
 */
export const CSDN_ROBOTS_DISCLOSURE =
  'so.csdn.net/robots.txt 声明 Disallow: /（该主机不允许自动抓取）。本插件只在你的显式操作下发起单次请求，不做爬取、不批量遍历。'

/** Per-source login requirement, keyed by the source id used everywhere else. */
export const LOGIN_REQUIREMENTS: Readonly<Record<SourceId, string>> = {
  github: GITHUB_LOGIN_REQUIREMENT,
  gitee: GITEE_LOGIN_REQUIREMENT,
  csdn: CSDN_LOGIN_REQUIREMENT,
}

// ---------------------------------------------------------------------------
// Login methods and the hand-held guide the wizard renders.
// ---------------------------------------------------------------------------

/**
 * How a credential can legitimately be obtained for a source.
 *
 * `oauth-device` — GitHub device flow (own OAuth App, no client secret).
 * `oauth-code`   — Gitee authorization code (own app, client secret mandator).
 * `pat`          — a personal access token the user creates in the browser.
 * `cookie-paste` — the user copies a Cookie request header out of DevTools.
 * `cookie-cdp`   — experimental: read the cookie over the browser debug port.
 */
export const LOGIN_METHODS = ['oauth-device', 'oauth-code', 'pat', 'cookie-paste', 'cookie-cdp'] as const

export type LoginMethodId = (typeof LOGIN_METHODS)[number]

/** Which methods each source actually supports, in the order the UI lists them. */
export const SOURCE_LOGIN_METHODS: Readonly<Record<SourceId, readonly LoginMethodId[]>> = {
  github: ['oauth-device', 'pat'],
  gitee: ['oauth-code', 'pat'],
  csdn: ['cookie-paste', 'cookie-cdp'],
}

/**
 * The two FAMILIES the wizard must keep visually apart.
 *
 * The user asked for this in so many words: a browser OAuth login is a different
 * KIND of action from copying a token or a cookie out of a browser, and dumping
 * both into one undifferentiated list is what makes a settings page unreadable.
 * The split lives here (data, not three `if`s in the view) so the wizard, its
 * tests and any future surface agree on which side a method falls.
 */
export const LOGIN_METHOD_FAMILIES = ['oauth', 'manual'] as const

export type LoginMethodFamily = (typeof LOGIN_METHOD_FAMILIES)[number]

/** `oauth` = the browser does the authorization; `manual` = the user copies a value. */
export const LOGIN_METHOD_FAMILY: Readonly<Record<LoginMethodId, LoginMethodFamily>> = {
  'oauth-device': 'oauth',
  'oauth-code': 'oauth',
  pat: 'manual',
  'cookie-paste': 'manual',
  'cookie-cdp': 'manual',
}

/** The methods of one family this source supports, in contract order. */
export function loginMethodsOf(source: SourceId, family: LoginMethodFamily): LoginMethodId[] {
  return SOURCE_LOGIN_METHODS[source].filter((method) => LOGIN_METHOD_FAMILY[method] === family)
}

/** Credential kind a method produces, for the wizard's field and the label. */
export const LOGIN_METHOD_KIND: Readonly<Record<LoginMethodId, 'token' | 'cookie' | 'secret'>> = {
  'oauth-device': 'token',
  'oauth-code': 'token',
  pat: 'token',
  'cookie-paste': 'cookie',
  'cookie-cdp': 'cookie',
}

/** One page the wizard offers to open, so no URL is re-typed in the UI. */
export const LOGIN_URLS = {
  /** GitHub: create an OAuth App. Device Flow must be ticked inside it. */
  githubOAuthApp: 'https://github.com/settings/applications/new',
  /** GitHub: where the device flow sends the user to type `user_code`. */
  githubDeviceVerification: 'https://github.com/login/device',
  /** GitHub: fine-grained PAT, prefilled for read-only public content. */
  githubFineGrainedToken:
    'https://github.com/settings/personal-access-tokens/new?name=dsh-codehub&description=dsh-codehub+read-only+public+code+access',
  /** GitHub: classic PAT (no scope can still read public information). */
  githubClassicToken: 'https://github.com/settings/tokens/new',
  /** Gitee: create a 第三方应用 (callback URL must be registered here). */
  giteeOAuthApp: 'https://gitee.com/oauth/applications',
  /** Gitee: personal access token page. */
  giteeToken: 'https://gitee.com/profile/personal_access_tokens',
  /** CSDN: where the user signs in before copying the cookie. */
  csdnLogin: 'https://passport.csdn.net/login',
  /** CSDN: the search page the cookie is being pasted for. */
  csdnSearch: 'https://so.csdn.net/so/search',
} as const

/** One field a guide step wants the user to paste back into the plugin. */
export interface LoginGuideField {
  /** Which config/credential slot the value ends up in. */
  readonly slot: 'clientId' | 'clientSecret' | 'token' | 'cookie'
  readonly label: string
  /** Format hint shown as the placeholder, e.g. the length/shape of the value. */
  readonly hint: string
}

/** One numbered step of the hand-held guide. */
export interface LoginGuideStep {
  readonly title: string
  readonly detail: string
  /** A page to open (and to offer as a copyable URL) for this step. */
  readonly url?: string
  /** Whether the UI should offer "open in browser" for `url`. */
  readonly openInBrowser?: boolean
  /** Fields this step asks the user to bring back, if any. */
  readonly fields?: readonly LoginGuideField[]
}

export interface LoginGuide {
  readonly method: LoginMethodId
  readonly title: string
  /** One sentence on why this method needs to exist. */
  readonly why: string
  readonly steps: readonly LoginGuideStep[]
}

const GITHUB_DEVICE_GUIDE: LoginGuide = {
  method: 'oauth-device',
  title: 'GitHub 浏览器登录（设备码流程）',
  why:
    'GitHub 的代码搜索必须带 token。设备码流程让你在浏览器里点一次授权，插件自己把 token 存进凭据服务——不需要手抄 token，也不需要 client_secret。',
  steps: [
    {
      title: '1. 建一个属于你的 OAuth App',
      detail:
        '打开 GitHub 的 OAuth App 创建页（需要已登录 GitHub）。Application name 随意；Homepage URL 填 https://github.com 即可；Authorization callback URL 对设备码流程不使用，随便填一个 https 地址即可。',
      url: LOGIN_URLS.githubOAuthApp,
      openInBrowser: true,
    },
    {
      title: '2. 勾选 Enable Device Flow',
      detail:
        '创建后回到该 App 的编辑页，勾上 Enable Device Flow 并保存。没有这一步，授权会以 device_flow_disabled 失败——这是 GitHub 的硬性要求。',
    },
    {
      title: '3. 复制 Client ID',
      detail: '只复制 Client ID（形如 Ov23li…，20 位左右）。Client secrets 不需要，也不要填到这里。',
      fields: [{ slot: 'clientId', label: 'Client ID', hint: 'Ov23li…' }],
    },
    {
      title: '4. 回到插件点「浏览器登录」',
      detail:
        '插件会显示一个 8 位用户码并打开 https://github.com/login/device，输入该码并授权即可；token 由插件直接写入 DSH 凭据服务，页面只显示「已配置」。',
      url: LOGIN_URLS.githubDeviceVerification,
      openInBrowser: true,
    },
  ],
}

const GITHUB_PAT_GUIDE: LoginGuide = {
  method: 'pat',
  title: 'GitHub 个人访问令牌（PAT）',
  why: '设备码流程需要一个 OAuth App，且本机必须能连上 github.com；PAT 不需要注册应用，是这两条都不满足时的兜底。',
  steps: [
    {
      title: '1. 打开令牌创建页',
      detail:
        '推荐 fine-grained（细粒度）令牌：打开下面的预填链接，只读公开仓库内容即可。若打开的是经典令牌页，不勾任何 scope 也能读公开信息。',
      url: LOGIN_URLS.githubFineGrainedToken,
      openInBrowser: true,
    },
    {
      title: '2. 生成并复制令牌',
      detail: '令牌形如 github_pat_… 或 ghp_…，只在生成时显示一次，请立刻复制。',
      fields: [{ slot: 'token', label: 'GitHub Token', hint: 'github_pat_… 或 ghp_…' }],
    },
    {
      title: '3. 粘贴并验证',
      detail: '粘回下面的输入框并保存；插件会立刻用 api.github.com/user 校验一次，返回 200 才算有效。',
    },
  ],
}

const GITEE_OAUTH_GUIDE: LoginGuide = {
  method: 'oauth-code',
  title: 'Gitee 浏览器登录（授权码流程）',
  why:
    'Gitee 不支持设备码，也不支持 PKCE：必须有一个第三方应用（client_id + client_secret），并且回调地址要事先登记。',
  steps: [
    {
      title: '1. 建一个 Gitee 第三方应用',
      detail:
        '打开「第三方应用」页面并创建应用。应用主页可填 https://gitee.com；回调地址必须与插件显示的回调地址完全一致（下一步会给出可复制的那一串）。',
      url: LOGIN_URLS.giteeOAuthApp,
      openInBrowser: true,
    },
    {
      title: '2. 把回调地址登记进应用',
      detail:
        '插件下方会显示形如 http://127.0.0.1:<端口>/api/dsh-codehub/oauth/callback 的回调地址，点「复制回调地址」后原样粘进 Gitee 应用的回调地址栏。端口变化后需要重新登记。',
    },
    {
      title: '3. 复制 Client ID 与 Client Secret',
      detail:
        'Client ID 存进配置；Client Secret 只进 DSH 凭据服务（不写配置文件、不进 git、不回显）。',
      fields: [
        { slot: 'clientId', label: 'Gitee Client ID', hint: '32–64 位十六进制' },
        { slot: 'clientSecret', label: 'Gitee Client Secret', hint: '只存进凭据服务' },
      ],
    },
    {
      title: '4. 回到插件点「浏览器登录」',
      detail:
        '插件会打开 Gitee 授权页；授权后浏览器会跳回本机回调地址并自动完成。若回调没回来（端口被改过/浏览器拦截），把地址栏里 code= 后面那串粘回插件的手动输入框即可。',
    },
  ],
}

const GITEE_PAT_GUIDE: LoginGuide = {
  method: 'pat',
  title: 'Gitee 私人令牌（access_token）',
  why: '不需要注册应用、不需要回调地址，是 Gitee 最省事的路径；仓库搜索必须有它。',
  steps: [
    {
      title: '1. 打开私人令牌页',
      detail: '需要已登录 Gitee。创建时勾选读取仓库相关的权限即可，不必给写权限。',
      url: LOGIN_URLS.giteeToken,
      openInBrowser: true,
    },
    {
      title: '2. 复制令牌',
      detail: '令牌只在创建时显示一次，形如 32–40 位十六进制字符串。',
      fields: [{ slot: 'token', label: 'Gitee Token', hint: '32–40 位十六进制' }],
    },
    {
      title: '3. 粘贴并验证',
      detail: '插件会用 gitee.com/api/v5/user 校验；200 才算有效，401 表示令牌已失效或复制不全。',
    },
  ],
}

const CSDN_COOKIE_PASTE_GUIDE: LoginGuide = {
  method: 'cookie-paste',
  title: 'CSDN Cookie（手动粘贴）',
  why: 'CSDN 没有 OAuth，登录态只有 cookie。匿名也能搜，但正文代码经常拿不到；带上登录 cookie 成功率更高。',
  steps: [
    {
      title: '1. 在浏览器里登录 CSDN',
      detail: '用你平常的浏览器打开并登录即可，插件不接触你的浏览器。',
      url: LOGIN_URLS.csdnLogin,
      openInBrowser: true,
    },
    {
      title: '2. 复制 Cookie 请求头（不要用 document.cookie）',
      detail:
        'F12 → Network → 刷新一次 csdn.net 的请求 → 点任意一个请求 → Headers → Request Headers → 复制 Cookie: 后面那一整串。' +
        '以分号分隔的 name=value; name=value。注意：HttpOnly 的 cookie 在控制台 document.cookie 里看不到，所以必须从 Network 面板复制。',
      url: LOGIN_URLS.csdnSearch,
      openInBrowser: true,
    },
    {
      title: '3. 粘贴并验证',
      detail: '粘回输入框保存。插件会做一次匿名/带 cookie 的结果抽样对比，并如实告诉你是否观察到改善。',
      fields: [{ slot: 'cookie', label: 'CSDN Cookie', hint: 'name=value; name=value; …' }],
    },
  ],
}

const CSDN_COOKIE_CDP_GUIDE: LoginGuide = {
  method: 'cookie-cdp',
  title: 'CSDN Cookie（实验性：从本机浏览器读取）',
  why:
    '如果你不想手动复制，可以让插件通过浏览器的调试端口读一次 cookie——包括 HttpOnly 的那些。代价是本机会多出一个本地进程可访问的调试端口。',
  steps: [
    {
      title: '1. 确认安全代价',
      detail:
        '开启浏览器调试端口后，本机上的任何程序都能通过该端口读取你浏览器的会话。请看完这一步再决定；插件默认关闭这个能力，只在本次操作里使用，且只取 csdn.net 的 cookie。',
    },
    {
      title: '2. 用调试端口启动浏览器',
      detail:
        '先完全退出浏览器，再用带 --remote-debugging-port=9222 的参数启动（用你原来的用户目录，登录态才在）。' +
        '示例（Windows，Edge/Chrome）：msedge.exe --remote-debugging-port=9222   或   chrome.exe --remote-debugging-port=9222。',
    },
    {
      title: '3. 在那个浏览器里登录 CSDN，然后回到插件点「读取 Cookie」',
      detail: '插件连 http://127.0.0.1:9222 读一次 cookie 并直接写进凭据服务；结果只显示 cookie 名称与数量，不显示值。',
      url: LOGIN_URLS.csdnLogin,
      openInBrowser: true,
    },
  ],
}

/** Every guide, keyed by method. The wizard renders these verbatim. */
export const LOGIN_GUIDES: Readonly<Record<LoginMethodId, LoginGuide>> = {
  'oauth-device': GITHUB_DEVICE_GUIDE,
  'oauth-code': GITEE_OAUTH_GUIDE,
  pat: GITHUB_PAT_GUIDE,
  'cookie-paste': CSDN_COOKIE_PASTE_GUIDE,
  'cookie-cdp': CSDN_COOKIE_CDP_GUIDE,
}

/** Method → guide lookup that keeps the PAT guides source-specific. */
export function loginGuideFor(source: SourceId, method: LoginMethodId): LoginGuide {
  if (method === 'pat') return source === 'gitee' ? GITEE_PAT_GUIDE : GITHUB_PAT_GUIDE
  return LOGIN_GUIDES[method]
}

// ---------------------------------------------------------------------------
// OAuth endpoints and flow constants.
//
// GitHub device flow: no client_secret, but "Enable Device Flow" must be ticked
// on the user's own OAuth App, and `github.com` must be reachable from the host
// process (it is NOT on this machine — see README).
// Gitee: authorization code only; client_secret is mandatory and the callback
// URL must be registered in advance.
// ---------------------------------------------------------------------------

export const GITHUB_DEVICE_CODE_ENDPOINT = 'https://github.com/login/device/code'
export const GITHUB_DEVICE_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token'
/** Where the device flow tells the user to type the code. */
export const GITHUB_DEVICE_VERIFICATION_URI = 'https://github.com/login/device'
export const GITEE_OAUTH_AUTHORIZE_ENDPOINT = 'https://gitee.com/oauth/authorize'
export const GITEE_OAUTH_TOKEN_ENDPOINT = 'https://gitee.com/oauth/token'

/** The loopback path the Gitee authorization code comes back to. */
export const OAUTH_CALLBACK_PATH = '/api/dsh-codehub/oauth/callback'

/** One flow lives at most this long; both providers expire around here too. */
export const OAUTH_FLOW_TTL_MS = 15 * 60 * 1000

/** `slow_down` means: wait at least this much longer before the next poll. */
export const OAUTH_SLOW_DOWN_STEP_MS = 5_000

/** Credential ref holding the user's own Gitee OAuth client secret. */
export const GITEE_OAUTH_SECRET_REF = 'DSH_CODEHUB_GITEE_OAUTH_CLIENT_SECRET'

// ---------------------------------------------------------------------------
// Connectivity panel contract (the "no JSON dump" requirement).
//
// The panel renders exactly these rows, in this order, whether or not a probe
// has run; a probe result only fills in the status and the reason text. The
// browser half must never render the raw payload.
// ---------------------------------------------------------------------------

/** Fixed row order of the connectivity panel. */
export const CONNECTIVITY_ROW_ORDER = SOURCES

export const CONNECTIVITY_STATUSES = ['undetected', 'running', 'ok', 'failed'] as const

export type ConnectivityStatus = (typeof CONNECTIVITY_STATUSES)[number]

/** A failed row shows at most this many lines of reason before truncating. */
export const CONNECTIVITY_MAX_REASON_LINES = 4

/** Default browser debug port for the experimental CDP cookie capture. */
export const CDP_DEFAULT_PORT = 9222

/**
 * The dedicated profile the launcher starts Chromium with.
 *
 * It lives under `$DSH_HOME` because it holds a logged-in browser session: that is
 * exactly as sensitive as the cookie we are about to read, so it must never sit
 * inside a repository or a shared temp directory.
 */
export const CDP_USER_DATA_DIR_NAME = 'dsh-codehub-browser'

/**
 * Chromium rejects a CDP websocket whose `Origin` it does not allow (Chrome 111+),
 * so the launcher passes this flag — the user asked for it explicitly, and without
 * it attaching from a non-browser client can fail with a 403 during the handshake.
 * The cost is stated in the UI: it lets any origin that can reach the loopback port
 * talk to the debugger, which is why the port stays on 127.0.0.1 and the whole
 * capability is opt-in twice over.
 */
export const CDP_REMOTE_ALLOW_ORIGINS_FLAG = '--remote-allow-origins=*'

/** The only hosts the CDP cookie capture is ever allowed to read for. */
export const CDP_COOKIE_HOSTS = ['https://www.csdn.net', 'https://so.csdn.net', 'https://blog.csdn.net'] as const
