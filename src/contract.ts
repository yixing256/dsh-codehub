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
 * Endpoints the brief named for Gitee DO NOT EXIST.
 *
 * `https://gitee.com/api/v5/projects?q=...` was probed live and returned 404.
 * The real v5 search endpoints are the two below; both are authenticated on
 * this deployment (anonymous `/search/repositories` returned an empty array).
 * Adapters must use these and must never fabricate response fields for the
 * endpoint that 404s.
 */
export const GITEE_SEARCH_REPOSITORIES = '/search/repositories'
export const GITEE_SEARCH_CODE = '/search/code'

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
