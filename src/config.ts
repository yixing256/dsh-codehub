/**
 * dsh-codehub — configuration schema, decision resolution and hard-cap clamping.
 *
 * OWNER: `host-core`. Read-only consumers: `service.ts`, `routes.ts`, `index.ts`.
 *
 * WHY A SCHEMA AND NOT A HAND-BUILT FORM
 * --------------------------------------
 * The `settings` service on this runtime has NO `installSection` and NO
 * `register` (see types/dsh/index.d.ts). The settings form is derived
 * AUTOMATICALLY from the schemastery schema this module exports as `Config`.
 * That schema is therefore the settings UI, and every `.description()` below is
 * user-visible copy.
 *
 * THREE THINGS THIS MODULE GUARANTEES
 * ----------------------------------
 * 1. **No secret is representable.** There is no `token` / `cookie` field
 *    anywhere in the schema: credentials live in `ctx.credentials` only, and
 *    `isSecretKey()` additionally rejects any patch key that even looks like a
 *    secret, so a malformed PATCH cannot smuggle one into the profile patch or
 *    into `$DSH_HOME/dsh-codehub.json`.
 * 2. **An unanswered decision stays unanswered.** `failover.enabled` and
 *    `mergeSources` are booleans WITHOUT a default, so they resolve to
 *    `undefined` until the user touches them. `false` is a decided answer
 *    ("do not degrade") and is kept distinct from `undefined` ("never asked").
 *    `sourcePriority` / `github.accessPriority` default to the EMPTY array,
 *    which is likewise read as undecided by `gating.ts` — never as "all".
 * 3. **Hard caps are the ceiling.** Every number goes through `resolveLimits()`,
 *    which clamps into `HARD_LIMITS`. A user may lower a limit; nothing,
 *    including the CLI or a hand-edited patch, can raise it.
 *
 * 备注① lives here too: the local-proxy field's description is built from
 * `LOCAL_PROXY_LABEL` + `LOCAL_PROXY_HELP`, so the phrase 仅 Node 直连传输生效
 * reaches the derived settings form without a second hand-written copy.
 */

/**
 * `@deepseek-ai/schemastery`, NOT the unscoped `schemastery`.
 *
 * They are different packages: upstream `schemastery` tops out at 3.18.0, while
 * DSH publishes its own fork at 3.18.2 — and that fork is what
 * `@deepseek-ai/dsh-tools` depends on. Importing the unscoped package made this
 * plugin's schema a DIFFERENT `Schema` type from the one the SDK uses, so
 * TypeScript resolved the schema's inferred type through the fork's pnpm store
 * path and declaration emit failed with TS2742 ("cannot be named without a
 * reference to .pnpm/@deepseek-ai+schemastery@3.18.2/...").
 *
 * Shipping host plugins import the fork (`dsh-context` does), and it is also the
 * package carrying the `role(...)` secret-field support DSH's settings surface
 * understands. Declared as a peer dependency: the host provides it.
 */
import Schema from '@deepseek-ai/schemastery'

import {
  CDP_DEFAULT_PORT,
  CSDN_API_NOTE,
  CSDN_SEARCH_BASE,
  DEEP_READ_TARGETS,
  DEFAULT_LIMITS,
  GITHUB_ACCESS,
  GITEE_API_BASE,
  GITEE_OAUTH_SECRET_REF,
  HARD_LIMITS,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_LABEL,
  OAUTH_CALLBACK_PATH,
  SOURCES,
} from './contract.js'
import type { DeepReadTarget, GithubAccessId, SourceId } from './contract.js'

// ---------------------------------------------------------------------------
// Entry placement (docs/DESIGN.md §1). Not a contract constant because only the
// browser half and this schema need it.
// ---------------------------------------------------------------------------

export const ENTRY_PLACEMENTS = ['both', 'sidebar', 'settings'] as const

export type EntryPlacement = (typeof ENTRY_PLACEMENTS)[number]

/** Defaults the schema declares, kept in one object so copy and code agree. */
export const SCHEMA_DEFAULTS = {
  enabled: true,
  /**
   * Kept for schema compatibility, and now always true.
   *
   * It used to gate a first-run dialog that asked the user where the plugin
   * should appear. That dialog is gone: both surfaces are on by default and the
   * choice is an ordinary setting (`entryPlacement`) the user changes in the
   * plugin's settings page. Nothing asks on startup.
   */
  onboarded: true,
  entryPlacement: 'both' satisfies EntryPlacement,
  announceToAgent: true,
  htmlFallback: true,
  banner: true,
  /**
   * CSDN article pages carry the code blocks, so the second fetch is on by
   * default; it is a switch rather than a silent behaviour so a user can trade
   * one extra request per hit for fewer requests.
   */
  articleFetch: true,
  /** CDP cookie capture is a real security trade: opt-in, never on by default. */
  cdpEnabled: false,
  cdpPort: CDP_DEFAULT_PORT,
  /**
   * Auto-save the settings form. ON by default because the user asked for it
   * ("每改一处自动保存"), and switchable because the first version was not — which
   * left the manual button permanently disabled and the save bar useless.
   */
  autoSave: true,
} as const

/**
 * 备注① — the description of the local-proxy control.
 *
 * Built by concatenation, never re-typed: it must contain BOTH
 * `LOCAL_PROXY_LABEL` (本机代理 / SOCKS5 地址) and `LOCAL_PROXY_HELP` (which
 * carries `LOCAL_PROXY_SCOPE_NOTE` — 仅 Node 直连传输生效).
 */
export const LOCAL_PROXY_FIELD_DESCRIPTION = `${LOCAL_PROXY_LABEL}：${LOCAL_PROXY_HELP}`

// ---------------------------------------------------------------------------
// The schema. Every `.description()` below is rendered to the user.
// ---------------------------------------------------------------------------

/**
 * `Schema.union([...])` over a readonly tuple of literals is the documented
 * schemastery enum form and is used for every closed vocabulary here, so the
 * derived form renders a select rather than a free-text box. The resolver
 * filters against the same contract arrays anyway (`readStringList()`), which is
 * what makes an unknown value from a hand-edited patch harmless.
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(SCHEMA_DEFAULTS.enabled)
    .description('是否启用 dsh-codehub。关闭后工具仍可被调用，但会直接拒绝并且不发任何网络请求。'),

  onboarded: Schema.boolean()
    .default(SCHEMA_DEFAULTS.onboarded)
    .description('历史字段，保留兼容。首次选择对话框已移除，默认即为「侧边栏 + 设置页」，不再询问。'),

  entryPlacement: Schema.union(ENTRY_PLACEMENTS)
    .default(SCHEMA_DEFAULTS.entryPlacement)
    .description(
      '插件显示在哪里：both=侧边栏面板+设置页（默认）；sidebar=仅侧边栏；settings=仅设置页。' +
        '侧边栏入口是顶部的 GitHub 猫标 + codehub。改完在插件设置里点「保存显示位置」生效。',
    ),

  announceToAgent: Schema.boolean()
    .default(SCHEMA_DEFAULTS.announceToAgent)
    .description(
      '是否把防搬运声明写入系统提示词段（plugin:dsh-codehub）。备注③要求该声明同时出现在工具描述与提示词段里，默认开启。',
    ),

  // 决策点 1/4 —— 默认空数组/无默认值 = 尚未决定。
  sourcePriority: Schema.array(Schema.union(SOURCES))
    .default([])
    .description('三个源的查询优先级，数组顺序即优先级。留空 = 尚未决定：工具会先问用户，且不发任何网络请求。'),

  github: Schema.object({
    accessPriority: Schema.array(Schema.union(GITHUB_ACCESS))
      .default([])
      .description(
        'GitHub 访问方式优先级，数组顺序即尝试顺序。留空 = 尚未决定。注意 ghproxy / raw-mirror / third-party-mirror 三条路径会被强制剥离 token。',
      ),
    apiBase: Schema.string()
      .default('')
      .description('覆盖 GitHub API 基址（留空 = 内置 https://api.github.com）。与 raw 文件基址是两条独立路径。'),
    webProxyBases: Schema.array(Schema.string())
      .default([])
      .description('网页 / API 代理基址（ghproxy、ghfast.top 等），按序尝试。不预填任何数据；空 = 该方式不可用，不兜底。'),
    rawMirrorBases: Schema.array(Schema.string())
      .default([])
      .description('raw 文件镜像基址。本机实测 raw.githubusercontent.com 不可直连，必须依赖此项；空 = raw 下载不可用。'),
    localProxy: Schema.string().default('').description(LOCAL_PROXY_FIELD_DESCRIPTION),
    oauthClientId: Schema.string()
      .default('')
      .description(
        '你的 GitHub OAuth App 的 Client ID（公开值，不是 secret）。在 https://github.com/settings/developers 新建 OAuth App 后获得。' +
          '设备码流程不需要 client_secret，但必须在该 App 里勾选 Enable Device Flow，否则 https://github.com/login/device/code 会直接报错。' +
          '留空 = 不使用 GitHub 浏览器登录，仍可粘贴 Personal Access Token。',
      ),
  }).description('GitHub 访问方式与镜像基址（docs/DESIGN.md §3）。'),

  gitee: Schema.object({
    apiBase: Schema.string()
      .default('')
      .description(`覆盖 Gitee v5 API 基址（留空 = 内置 ${GITEE_API_BASE}）。只使用真实存在的 v5 端点。`),
    htmlFallback: Schema.boolean()
      .default(SCHEMA_DEFAULTS.htmlFallback)
      .description('JSON 端点返回空结果时，是否允许回退抓取 HTML 页面；回退结果会标注来源并降低置信度。'),
    oauthClientId: Schema.string()
      .default('')
      .description(
        '你的 Gitee 第三方应用的 Client ID（公开值）。在 https://gitee.com/oauth/applications 创建应用后获得；' +
          'Gitee 没有设备码、也不支持 PKCE，只能走授权码流程，因此必须同时提供 client secret —— ' +
          `secret 绝不写进本配置，它只存在凭据服务里（${GITEE_OAUTH_SECRET_REF}）。留空 = 不使用 Gitee 浏览器登录。`,
      ),
    oauthRedirectUri: Schema.string()
      .default('')
      .description(
        'Gitee 授权回调地址，必须与你在 Gitee 应用里登记的地址完全一致（Gitee 不做模糊匹配，多一个斜杠都会失败）。' +
          `留空 = 运行时按本机请求头推导为 http://<host>${OAUTH_CALLBACK_PATH}，适用于直接用 127.0.0.1 打开设置页的常见情形；` +
          '只有当你从别的主机 / 端口访问设置页，或应用里登记的是另一个地址时才需要手填。',
      ),
  }).description('Gitee 访问设置。无 token 时仍允许只打公开端点，空结果标为 empty（不伪造数据）。'),

  csdn: Schema.object({
    apiBase: Schema.string()
      .default('')
      .description(`覆盖 CSDN 搜索基址（留空 = 内置 ${CSDN_SEARCH_BASE}）。${CSDN_API_NOTE}`),
    htmlFallback: Schema.boolean()
      .default(SCHEMA_DEFAULTS.htmlFallback)
      .description('搜索接口返回空结果时，是否允许回退抓取 HTML 页面；回退结果会标注来源并降低置信度。'),
    articleFetch: Schema.boolean()
      .default(SCHEMA_DEFAULTS.articleFetch)
      .description(
        '是否允许为命中的搜索结果再抓一次文章页。为什么默认开：实测搜索接口 30 条里只有 6 条带正文，代码通常只在文章页的 <pre> 里。' +
          '文章页必须带浏览器 UA / Referer，否则会被 HTTP 521 反爬拦截 —— 本插件会自动带上这两个头，代价是这类请求强制走 Node 直连传输（harness 通道不接受请求头）。',
      ),
    cdpEnabled: Schema.boolean()
      .default(SCHEMA_DEFAULTS.cdpEnabled)
      .description(
        '实验性：允许通过浏览器调试端口（CDP）读取 CSDN 登录 cookie。默认关闭，因为代价是真实的：' +
          '你必须用 --remote-debugging-port 启动浏览器，该端口对本机任何进程开放。' +
          '本插件不打包浏览器、不读 cookie 数据库（不碰 DPAPI / App-Bound）、不装根证书、不起代理；' +
          '即使开启，也只有收到显式带 consent 的请求时才会连 127.0.0.1。',
      ),
    cdpPort: Schema.number()
      .default(SCHEMA_DEFAULTS.cdpPort)
      .description(
        `浏览器调试端口。默认 ${CDP_DEFAULT_PORT}，即 Chrome / Edge 的 --remote-debugging-port 常用值。` +
          '取值收敛到 1..65535，越界会被夹回边界值而不是让请求失败。',
      ),
  }).description('CSDN 访问设置。CSDN 权重最低，只作补充。'),

  /**
   * Browser-half behaviour. Not a decision (nothing here blocks the tool), just a
   * preference the user owns — which is exactly why it must be switchable rather
   * than baked into the writer.
   */
  ui: Schema.object({
    autoSave: Schema.boolean()
      .default(SCHEMA_DEFAULTS.autoSave)
      .description(
        '改完设置后是否自动保存（默认开启，改完约 0.7 秒写入 host，连续编辑合并成一次）。' +
          '关闭后改动只会留在草稿里，需要你点「保存到 host」；想临时手动落地时，保存栏的按钮在待保存状态下也能点。',
      ),
  }).description('界面行为。与工具能否运行无关，纯偏好。'),

  failover: Schema.object({
    // NO .default() — undefined means "the user has not been asked yet".
    enabled: Schema.boolean().description(
      '某个源失败（network / timeout / rate-limited / auth-required）时，是否自动降级到下一个源。留空 = 尚未决定，工具会先问用户。',
    ),
    chain: Schema.array(Schema.union(GITHUB_ACCESS))
      .default([])
      .description('可选的显式降级顺序（GitHub 访问方式）。留空 = 沿用 accessPriority 的顺序。'),
  }).description('失败自动降级（docs/DESIGN.md §3）。降级本身是需要用户确认的动作。'),

  // NO .default() — undefined means "the user has not been asked yet".
  mergeSources: Schema.boolean().description(
    '多个源都命中时是否合并去重后返回；false = 只用最高优先级的那个源。留空 = 尚未决定，工具会先问用户。',
  ),

  limits: Schema.object({
    timeoutMs: Schema.number()
      .min(1)
      .max(HARD_LIMITS.timeoutMs)
      .default(DEFAULT_LIMITS.timeoutMs)
      .description(`单次请求超时（毫秒）。默认 ${DEFAULT_LIMITS.timeoutMs}，硬顶 ${HARD_LIMITS.timeoutMs}，只可下调。`),
    retries: Schema.number()
      .min(0)
      .max(HARD_LIMITS.retries)
      .default(DEFAULT_LIMITS.retries)
      .description(`传输层重试次数。默认 ${DEFAULT_LIMITS.retries}，硬顶 ${HARD_LIMITS.retries}，只可下调。`),
    maxDepth: Schema.number()
      .min(0)
      .max(HARD_LIMITS.maxDepth)
      .default(DEFAULT_LIMITS.maxDepth)
      .description(`递归 / 降级深度。默认 ${DEFAULT_LIMITS.maxDepth}，硬顶 ${HARD_LIMITS.maxDepth}，防无限递归。`),
    maxItems: Schema.number()
      .min(1)
      .max(HARD_LIMITS.maxItems)
      .default(DEFAULT_LIMITS.maxItems)
      .description(`单次返回条目上限。默认 ${DEFAULT_LIMITS.maxItems}，硬顶 ${HARD_LIMITS.maxItems}，只可下调。`),
    maxCodeChars: Schema.number()
      .min(1)
      .max(HARD_LIMITS.maxCodeChars)
      .default(DEFAULT_LIMITS.maxCodeChars)
      .description(
        `代码节选上限（字符）。默认 ${DEFAULT_LIMITS.maxCodeChars}，硬顶 ${HARD_LIMITS.maxCodeChars}。超出即截断并置 codeTruncated。`,
      ),
  }).description('超时 / 重试 / 深度 / 条目上限。属用户偏好，不是决策点；只能下调，不能超过硬顶。'),

  marking: Schema.object({
    banner: Schema.boolean()
      .default(SCHEMA_DEFAULTS.banner)
      .description('渲染时是否附加「仅学习参考 · 不得直接粘贴进用户项目」横幅。备注③的结构性约束不可关闭：解析时强制为 true。'),
  }).description('防搬运标注（备注③）。'),

  deepRead: Schema.object({
    targets: Schema.array(Schema.union(DEEP_READ_TARGETS))
      .default([])
      .description('深度阅读目标（readme / entry / core / tests）。留空 = 只做浅搜索，不做深度阅读。'),
  }).description('深度阅读设置。产物是思路笔记 LearnNote，不是文件副本。'),
})

// ---------------------------------------------------------------------------
// Input shapes.
//
// These are hand-written rather than `Schema.infer<typeof Config>` on purpose:
// the resolved Cordis config object and a PATCH body arrive as plain JSON, and
// every field must be tolerant (`null`, missing, wrong type) instead of relying
// on an inference chain. `resolveConfig()` normalises all of it.
// ---------------------------------------------------------------------------

/** Every field optional/tolerant: this is what a PATCH body may look like. */
export interface CodehubConfig {
  readonly enabled?: boolean | null
  readonly onboarded?: boolean | null
  readonly entryPlacement?: string | null
  readonly announceToAgent?: boolean | null
  readonly sourcePriority?: readonly string[] | null
  readonly github?: GithubConfigInput | null
  readonly gitee?: GiteeConfigInput | null
  readonly csdn?: CsdnConfigInput | null
  readonly failover?: FailoverConfigInput | null
  readonly mergeSources?: boolean | null
  readonly limits?: LimitsInput | null
  readonly marking?: MarkingConfigInput | null
  readonly deepRead?: DeepReadConfigInput | null
  readonly ui?: UiConfigInput | null
}

/** Browser-half preferences. Nothing here can block the tool. */
export interface UiConfigInput {
  readonly autoSave?: boolean | null
}

export interface GithubConfigInput {
  readonly accessPriority?: readonly string[] | null
  readonly apiBase?: string | null
  readonly webProxyBases?: readonly string[] | null
  readonly rawMirrorBases?: readonly string[] | null
  readonly localProxy?: string | null
  /** The user's own OAuth App id. A public value — a client SECRET is never here. */
  readonly oauthClientId?: string | null
}

export interface EndpointConfigInput {
  readonly apiBase?: string | null
  readonly htmlFallback?: boolean | null
}

/** Gitee adds the authorization-code flow, which needs an app id and a callback. */
export interface GiteeConfigInput extends EndpointConfigInput {
  readonly oauthClientId?: string | null
  readonly oauthRedirectUri?: string | null
}

/** CSDN adds the article-page fetch and the experimental CDP capture. */
export interface CsdnConfigInput extends EndpointConfigInput {
  readonly articleFetch?: boolean | null
  readonly cdpEnabled?: boolean | null
  readonly cdpPort?: number | null
}

export interface FailoverConfigInput {
  readonly enabled?: boolean | null
  readonly chain?: readonly string[] | null
}

export interface LimitsInput {
  readonly timeoutMs?: number | null
  readonly retries?: number | null
  readonly maxDepth?: number | null
  readonly maxItems?: number | null
  readonly maxCodeChars?: number | null
}

export interface MarkingConfigInput {
  readonly banner?: boolean | null
}

export interface DeepReadConfigInput {
  readonly targets?: readonly string[] | null
}

/**
 * The non-schema half of the configuration: values kept in
 * `$DSH_HOME/dsh-codehub.json` (0600) instead of the settings profile, plus the
 * fallback snapshot written when the settings service cannot persist our
 * namespace (docs/DESIGN.md §5).
 */
export interface LocalConfigInput {
  /** 备注① target: the only place a local proxy address is persisted. */
  readonly localProxy?: string | null
  /** Full config snapshot, used ONLY while the settings service is unavailable. */
  readonly fallbackConfig?: CodehubConfig | null
}

// ---------------------------------------------------------------------------
// Resolved (normalised) shapes — every field present, every cap applied.
// ---------------------------------------------------------------------------

export interface ResolvedLimits {
  readonly timeoutMs: number
  readonly retries: number
  readonly maxDepth: number
  readonly maxItems: number
  readonly maxCodeChars: number
}

export interface ResolvedGithubConfig {
  readonly accessPriority: readonly GithubAccessId[]
  readonly apiBase: string
  readonly webProxyBases: readonly string[]
  readonly rawMirrorBases: readonly string[]
  readonly localProxy: string
  /** Empty = no GitHub browser login offered; a PAT paste remains available. */
  readonly oauthClientId: string
}

export interface ResolvedEndpointConfig {
  readonly apiBase: string
  readonly htmlFallback: boolean
}

export interface ResolvedGiteeConfig extends ResolvedEndpointConfig {
  readonly oauthClientId: string
  /** Empty = derive `http://<request host>${OAUTH_CALLBACK_PATH}` at request time. */
  readonly oauthRedirectUri: string
}

export interface ResolvedCsdnConfig extends ResolvedEndpointConfig {
  readonly articleFetch: boolean
  readonly cdpEnabled: boolean
  /** Always inside 1..65535 — clamped by `resolveConfig()`. */
  readonly cdpPort: number
}

export interface ResolvedFailoverConfig {
  /** `undefined` = still undecided; `false` = decided not to degrade. */
  readonly enabled: boolean | undefined
  readonly chain: readonly GithubAccessId[]
}

export interface ResolvedConfig {
  readonly enabled: boolean
  readonly onboarded: boolean
  readonly entryPlacement: EntryPlacement
  readonly announceToAgent: boolean
  readonly sourcePriority: readonly SourceId[]
  readonly github: ResolvedGithubConfig
  readonly gitee: ResolvedGiteeConfig
  readonly csdn: ResolvedCsdnConfig
  readonly failover: ResolvedFailoverConfig
  /** `undefined` = still undecided; `false` = decided not to merge. */
  readonly mergeSources: boolean | undefined
  readonly limits: ResolvedLimits
  readonly marking: { readonly banner: true }
  readonly deepRead: { readonly targets: readonly DeepReadTarget[] }
  /** Browser-half preferences (no decision semantics here). */
  readonly ui: { readonly autoSave: boolean }
}

// ---------------------------------------------------------------------------
// Small tolerant readers. Nothing here throws: a bad value falls back, it never
// takes the plugin down.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `undefined` unless the value is literally a boolean — `false` is preserved. */
export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readBooleanOr(value: unknown, fallback: boolean): boolean {
  const parsed = readBoolean(value)
  return parsed === undefined ? fallback : parsed
}

export function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Trimmed, de-duplicated, order-preserving string list, optionally filtered. */
export function readStringList(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (allowed !== undefined && !allowed.includes(trimmed)) continue
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Base URL without a trailing slash; empty string means "use the built-in". */
function readBase(value: unknown): string {
  const raw = readString(value)
  return raw.endsWith('/') ? raw.replace(/\/+$/, '') : raw
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

/** Clamp every limit into `HARD_LIMITS`. Exported so tests can assert the caps. */
export function resolveLimits(raw?: LimitsInput | null): ResolvedLimits {
  const source: LimitsInput = isRecord(raw) ? raw : {}
  return {
    timeoutMs: clampNumber(source.timeoutMs, 1, HARD_LIMITS.timeoutMs, DEFAULT_LIMITS.timeoutMs),
    retries: clampNumber(source.retries, 0, HARD_LIMITS.retries, DEFAULT_LIMITS.retries),
    maxDepth: clampNumber(source.maxDepth, 0, HARD_LIMITS.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxItems: clampNumber(source.maxItems, 1, HARD_LIMITS.maxItems, DEFAULT_LIMITS.maxItems),
    maxCodeChars: clampNumber(source.maxCodeChars, 1, HARD_LIMITS.maxCodeChars, DEFAULT_LIMITS.maxCodeChars),
  }
}

/** Normalise one config layer (already merged) into the shape the host uses. */
export function resolveConfig(
  settings?: CodehubConfig | null,
  local?: LocalConfigInput | null,
): ResolvedConfig {
  const input: CodehubConfig = isRecord(settings) ? settings : {}
  const localInput: LocalConfigInput = isRecord(local) ? local : {}
  // Explicit annotations matter: without them the ternary widens to
  // `X | {}` and every property read below becomes a type error.
  const github: GithubConfigInput = isRecord(input.github) ? input.github : {}
  const gitee: GiteeConfigInput = isRecord(input.gitee) ? input.gitee : {}
  const csdn: CsdnConfigInput = isRecord(input.csdn) ? input.csdn : {}
  const failover: FailoverConfigInput = isRecord(input.failover) ? input.failover : {}
  const deepRead: DeepReadConfigInput = isRecord(input.deepRead) ? input.deepRead : {}
  const ui: UiConfigInput = isRecord(input.ui) ? input.ui : {}

  const placement = readString(input.entryPlacement)
  const entryPlacement = (ENTRY_PLACEMENTS as readonly string[]).includes(placement)
    ? (placement as EntryPlacement)
    : SCHEMA_DEFAULTS.entryPlacement

  // The proxy address is the one value the local store owns; when it is set
  // there it wins over the (informational) schema field.
  const localProxy = readString(localInput.localProxy) || readString(github.localProxy)

  return {
    enabled: readBooleanOr(input.enabled, SCHEMA_DEFAULTS.enabled),
    onboarded: readBooleanOr(input.onboarded, SCHEMA_DEFAULTS.onboarded),
    entryPlacement,
    announceToAgent: readBooleanOr(input.announceToAgent, SCHEMA_DEFAULTS.announceToAgent),
    sourcePriority: readStringList(input.sourcePriority, SOURCES) as SourceId[],
    github: {
      accessPriority: readStringList(github.accessPriority, GITHUB_ACCESS) as GithubAccessId[],
      apiBase: readBase(github.apiBase),
      webProxyBases: readStringList(github.webProxyBases),
      rawMirrorBases: readStringList(github.rawMirrorBases),
      localProxy,
      oauthClientId: readString(github.oauthClientId),
    },
    gitee: {
      apiBase: readBase(gitee.apiBase),
      htmlFallback: readBooleanOr(gitee.htmlFallback, SCHEMA_DEFAULTS.htmlFallback),
      oauthClientId: readString(gitee.oauthClientId),
      oauthRedirectUri: readString(gitee.oauthRedirectUri),
    },
    csdn: {
      apiBase: readBase(csdn.apiBase),
      htmlFallback: readBooleanOr(csdn.htmlFallback, SCHEMA_DEFAULTS.htmlFallback),
      articleFetch: readBooleanOr(csdn.articleFetch, SCHEMA_DEFAULTS.articleFetch),
      cdpEnabled: readBooleanOr(csdn.cdpEnabled, SCHEMA_DEFAULTS.cdpEnabled),
      // A port outside the TCP range is not an answer, it is a typo: clamp it so
      // the CDP request can never be aimed at host 0 or >65535.
      cdpPort: clampNumber(csdn.cdpPort, 1, 65535, SCHEMA_DEFAULTS.cdpPort),
    },
    // A preference with a real default: non-boolean means "use the default", not
    // "undecided" (nothing here blocks the tool, unlike the four decisions).
    ui: {
      autoSave: readBooleanOr(ui.autoSave, SCHEMA_DEFAULTS.autoSave),
    },
    failover: {
      enabled: readBoolean(failover.enabled),
      chain: readStringList(failover.chain, GITHUB_ACCESS) as GithubAccessId[],
    },
    mergeSources: readBoolean(input.mergeSources),
    limits: resolveLimits(input.limits),
    // 备注③ is structural: the banner cannot be switched off.
    marking: { banner: true },
    deepRead: {
      targets: readStringList(deepRead.targets, DEEP_READ_TARGETS) as DeepReadTarget[],
    },
  }
}

// ---------------------------------------------------------------------------
// Patch handling.
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = [
  'enabled',
  'onboarded',
  'entryPlacement',
  'announceToAgent',
  'sourcePriority',
  'github',
  'gitee',
  'csdn',
  'failover',
  'mergeSources',
  'limits',
  'marking',
  'deepRead',
  'ui',
] as const

const GITHUB_KEYS = ['accessPriority', 'apiBase', 'webProxyBases', 'rawMirrorBases', 'localProxy', 'oauthClientId'] as const
/**
 * Gitee and CSDN no longer share one key list.
 *
 * They used to, which meant `csdn` accepted a `oauthRedirectUri` and `gitee`
 * accepted `cdpPort` — harmless-looking, but the split is what keeps the two
 * credential stories (authorization code vs cookie) from bleeding into each
 * other. Nested keys that are not listed are rejected BY NAME, which is also how
 * a nested `oauthClientSecret` is refused.
 */
const GITEE_KEYS = ['apiBase', 'htmlFallback', 'oauthClientId', 'oauthRedirectUri'] as const
const CSDN_KEYS = ['apiBase', 'htmlFallback', 'articleFetch', 'cdpEnabled', 'cdpPort'] as const
const FAILOVER_KEYS = ['enabled', 'chain'] as const
const LIMITS_KEYS = ['timeoutMs', 'retries', 'maxDepth', 'maxItems', 'maxCodeChars'] as const
const MARKING_KEYS = ['banner'] as const
const DEEP_READ_KEYS = ['targets'] as const
const UI_KEYS = ['autoSave'] as const

/**
 * A key that must never be persisted by this plugin, anywhere.
 *
 * Credentials belong to `ctx.credentials`; a PATCH naming one is a caller
 * mistake, and it is dropped (and reported) rather than written to a profile
 * patch or to the 0600 store file.
 */
export const SECRET_KEY_PATTERN = /(token|secret|cookie|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)/i

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key)
}

function pickKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  rejected: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) {
      out[key] = value
      continue
    }
    rejected.push(key)
  }
  return out
}

/** Deep merge (top level + one nested group) with `null` meaning "unset". */
export function mergeConfigInput(
  base?: CodehubConfig | null,
  patch?: CodehubConfig | null,
): CodehubConfig {
  const left: Record<string, unknown> = isRecord(base) ? { ...base } : {}
  const right: Record<string, unknown> = isRecord(patch) ? patch : {}
  const out: Record<string, unknown> = { ...left }

  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) continue
    const current = out[key]
    if (isRecord(current) && isRecord(value)) {
      out[key] = { ...current, ...value }
      continue
    }
    out[key] = value
  }
  // The patch is a plain JSON record; the assertion is explicit rather than
  // implicit because `CodehubConfig` is an interface and therefore has no
  // index signature of its own. `resolveConfig()` re-validates every field.
  return out as unknown as CodehubConfig
}

export interface PatchSplitResult {
  /** False only when the body was not a JSON object at all. */
  readonly ok: boolean
  /** Keys dropped because this plugin does not own them, or they look secret. */
  readonly rejected: readonly string[]
  /** Values that belong in `$DSH_HOME/dsh-codehub.json` (0600), not the profile. */
  readonly local: { readonly localProxy?: string }
  /** The sanitised patch destined for the settings namespace. */
  readonly settings: CodehubConfig
  readonly error?: string
}

/**
 * Split an incoming PATCH into "goes to the 0600 store" and "goes to settings".
 *
 * Only `github.localProxy` is stored locally (docs/DESIGN.md §4: a proxy address
 * is sensitive but is not a credential). Everything else is a normal setting.
 * Unknown and secret-looking keys are dropped and reported — never persisted.
 */
export function splitConfigPatch(patch: unknown): PatchSplitResult {
  if (!isRecord(patch)) {
    return { ok: false, rejected: [], local: {}, settings: {}, error: '请求体必须是一个 JSON 对象。' }
  }

  const rejected: string[] = []
  const settings: Record<string, unknown> = {}
  const local: { localProxy?: string } = {}

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key) || isSecretKey(key)) {
      rejected.push(key)
      continue
    }

    if (key === 'github') {
      if (value === null) {
        settings.github = null
        continue
      }
      if (!isRecord(value)) {
        rejected.push('github')
        continue
      }
      const group = pickKeys(value, GITHUB_KEYS, rejected)
      if ('localProxy' in group) {
        const proxy = group.localProxy
        delete group.localProxy
        if (proxy === null) local.localProxy = ''
        else if (typeof proxy === 'string') local.localProxy = proxy.trim()
        else rejected.push('github.localProxy')
      }
      settings.github = group
      continue
    }

    if (key === 'gitee' || key === 'csdn') {
      const allowed: readonly string[] = key === 'gitee' ? GITEE_KEYS : CSDN_KEYS
      settings[key] = isRecord(value) ? pickKeys(value, allowed, rejected) : value
      continue
    }

    if (key === 'failover') {
      settings.failover = isRecord(value) ? pickKeys(value, FAILOVER_KEYS, rejected) : value
      continue
    }

    if (key === 'limits') {
      settings.limits = isRecord(value) ? pickKeys(value, LIMITS_KEYS, rejected) : value
      continue
    }

    if (key === 'marking') {
      settings.marking = isRecord(value) ? pickKeys(value, MARKING_KEYS, rejected) : value
      continue
    }

    if (key === 'deepRead') {
      settings.deepRead = isRecord(value) ? pickKeys(value, DEEP_READ_KEYS, rejected) : value
      continue
    }

    if (key === 'ui') {
      settings.ui = isRecord(value) ? pickKeys(value, UI_KEYS, rejected) : value
      continue
    }

    settings[key] = value
  }

  return { ok: true, rejected, local, settings: settings as unknown as CodehubConfig }
}

// ---------------------------------------------------------------------------
// JSON view — the exact shape `GET /api/dsh-codehub/config` returns and the
// browser half consumes. Tri-state decisions are emitted as explicit `null`.
// ---------------------------------------------------------------------------

export interface ConfigJsonViewGithub extends ResolvedGithubConfig {
  /** Alias of `webProxyBases`, kept for the browser half's original field name. */
  readonly mirrors: readonly string[]
  /** Alias of `rawMirrorBases`. */
  readonly rawMirrors: readonly string[]
}

export interface ConfigJsonView {
  readonly enabled: boolean
  readonly onboarded: boolean
  readonly entryPlacement: EntryPlacement
  readonly announceToAgent: boolean
  readonly sourcePriority: readonly SourceId[]
  readonly github: ConfigJsonViewGithub
  readonly gitee: ResolvedGiteeConfig
  readonly csdn: ResolvedCsdnConfig
  readonly failover: { readonly enabled: boolean | null; readonly chain: readonly GithubAccessId[] }
  readonly mergeSources: boolean | null
  readonly limits: ResolvedLimits
  readonly marking: { readonly banner: true }
  readonly deepRead: { readonly targets: readonly DeepReadTarget[] }
  readonly ui: { readonly autoSave: boolean }
}

/** `undefined` -> `null`, so "undecided" survives JSON serialisation. */
export function toJsonView(config: ResolvedConfig): ConfigJsonView {
  return {
    enabled: config.enabled,
    onboarded: config.onboarded,
    entryPlacement: config.entryPlacement,
    announceToAgent: config.announceToAgent,
    sourcePriority: [...config.sourcePriority],
    github: {
      ...config.github,
      mirrors: [...config.github.webProxyBases],
      rawMirrors: [...config.github.rawMirrorBases],
    },
    gitee: { ...config.gitee },
    csdn: { ...config.csdn },
    failover: {
      enabled: config.failover.enabled === undefined ? null : config.failover.enabled,
      chain: [...config.failover.chain],
    },
    mergeSources: config.mergeSources === undefined ? null : config.mergeSources,
    limits: { ...config.limits },
    marking: { banner: true },
    deepRead: { targets: [...config.deepRead.targets] },
    ui: { ...config.ui },
  }
}

/** The only credential-shaped fields the schema will ever expose: booleans. */
export const CREDENTIAL_TARGETS = ['github', 'gitee', 'csdn'] as const

export type CredentialTarget = (typeof CREDENTIAL_TARGETS)[number]
