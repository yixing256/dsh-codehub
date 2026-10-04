/**
 * dsh-codehub — the `codeSource` host service and the unified delivery outlet.
 *
 * This is the only place the plugin orchestrates: 决策门禁 -> 按 sourcePriority
 * 逐源查询 -> 失败降级（需用户已同意）-> 合并去重 -> 深度阅读 -> redactForDelivery.
 *
 * TWO INVARIANTS WORTH THE READING TIME
 * -------------------------------------
 * 1. **The decision gate runs before anything else.** `search()` checks
 *    `evaluateDecisions(config)` and returns early; on that path no adapter is
 *    constructed and no `Transport` is built, so "未决策" costs exactly zero
 *    network requests. That ordering is the requirement — not "ask after
 *    looking".
 * 2. **Every row leaves through `redactForDelivery()`.** It is the single
 *    outlet: it bounds `code`, marks `codeTruncated`, stamps the learning-only
 *    banner INTO the excerpt, validates `confidence`, and writes
 *    `is_verbatim_copy: false` — literally the only value the type permits.
 *    Nothing else in this file may construct a `CodeLearnResult` for delivery.
 *
 * On optional services: `credentials` and `web` are reached with `ctx.get()` and
 * a `undefined` check. Property access on an un-injected service throws on this
 * runtime, and a throw during mount can take the whole plugin install down.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialsService } from '@deepseek-ai/dsh-credentials'
import type { WebService } from '@deepseek-ai/dsh-web'

import {
  ANTI_COPY_STATEMENT,
  CONFIDENCE_LEVELS,
  CSDN_API_NOTE,
  CSDN_SEARCH_BASE,
  DEFAULT_LIMITS,
  GITHUB_API_BASE,
  GITEE_API_BASE,
  GITEE_OAUTH_SECRET_REF,
  HARD_LIMITS,
  LEARNING_ONLY_BANNER,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_SCOPE_NOTE,
  LOGIN_GUIDES,
  LOGIN_REQUIREMENTS,
  SERVICE_KEY,
  SETTINGS_NAMESPACE,
  SOURCES,
  SOURCE_LABELS,
} from './contract.js'
import type {
  CodeLearnResult,
  Confidence,
  DeepReadTarget,
  FailureKind,
  GithubAccessId,
  LearnNote,
  LoginMethodId,
  LoginGuide,
  SourceId,
  TransportId,
  UnresolvedDecision,
} from './contract.js'

import { disabledRefusal, evaluateDecisions, unresolvedDecisions } from './gating.js'
import {
  mergeConfigInput,
  resolveConfig,
  resolveLimits,
  toJsonView,
  type CodehubConfig,
  type ConfigJsonView,
  type CredentialTarget,
  type ResolvedConfig,
  type ResolvedLimits,
} from './config.js'
import { createTransport, type TransportDeps, type TransportLogger } from './net.js'
import type { LocalConfig, LocalConfigStore } from './store.js'
import type { SettingsBridge } from './settings.js'
import { CSDN_REQUEST_HEADERS, buildCsdnSearchUrl, createCsdnAdapter } from './sources/csdn.js'
import { createGiteeAdapter } from './sources/gitee.js'
import { createGithubAdapter } from './sources/github.js'
import { dedupe } from './learn/dedupe.js'
import type { AdapterOutcome, AdapterSearchOptions, SourceAdapter, Transport } from './sources/types.js'

// ---------------------------------------------------------------------------
// Credentials — references only. Values live in ctx.credentials.
// ---------------------------------------------------------------------------

/**
 * The three credential references (docs/DESIGN.md §4).
 *
 * A `CredentialRef` is a plain string that doubles as an environment-variable
 * name, which is why these match `.env.example` exactly. The VALUE never enters
 * this module's state: it is fetched per call, handed to the adapter, and
 * dropped when the call returns.
 */
export const CREDENTIAL_REFS = {
  github: 'DSH_CODEHUB_GITHUB_TOKEN',
  gitee: 'DSH_CODEHUB_GITEE_TOKEN',
  csdn: 'DSH_CODEHUB_CSDN_COOKIE',
} as const satisfies Readonly<Record<CredentialTarget, string>>

/** Operator-facing note for the mirror strategies. */
export const MIRROR_TOKEN_NOTE = '镜像 / 第三方转发路径在构造请求时强制剥离 token（TOKEN_FORBIDDEN_ACCESS）。'

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Restrict/order the sources for this call. Omitted = `config.sourcePriority`. */
  readonly sources?: readonly SourceId[] | undefined
  readonly deepRead?: boolean | undefined
  readonly maxItems?: number | undefined
  readonly signal?: AbortSignal | undefined
}

/** One source that did not answer usefully. */
export interface SourceFailure {
  readonly source: SourceId
  readonly kind: FailureKind
  readonly reason: string
}

/** The value the tool returns and the route serialises. */
export interface SearchOutcome {
  readonly ok: boolean
  readonly query: string
  readonly results: readonly CodeLearnResult[]
  /** Deep-read notes. Notes, never files (备注③). */
  readonly notes: readonly LearnNote[]
  readonly failures: readonly SourceFailure[]
  readonly unresolved_decisions: readonly UnresolvedDecision[]
  readonly ask_user: string
  readonly reason: string
  /** True when a source failed and the chain moved on because the user allowed it. */
  readonly degraded: boolean
  /** True when several sources were merged and de-duplicated. */
  readonly merged: boolean
  readonly sources_queried: readonly SourceId[]
  readonly deep_read: boolean
}

export interface ConfigView {
  readonly ok: true
  readonly config: ConfigJsonView
  readonly decisions: readonly UnresolvedDecision[]
  readonly decided: boolean
  readonly credentials: Readonly<Record<CredentialTarget, boolean>>
  readonly limits: ResolvedLimits
  readonly transport: {
    readonly webAvailable: boolean
    readonly proxyConfigured: boolean
    readonly proxyScopeNote: string
  }
  readonly notes: {
    readonly csdn: string
    readonly localProxy: string
    readonly antiCopy: string
    readonly settings: string
  }
  readonly paths: { readonly store: string }
  readonly login: ConfigLoginView
}

/** Login state for the wizard. Booleans and contract copy only — never a value. */
export interface ConfigLoginView {
  readonly requirements: Readonly<Record<SourceId, string>>
  readonly oauth: { readonly github: boolean; readonly gitee: boolean }
  readonly guides: Readonly<Record<LoginMethodId, LoginGuide>>
}

/** One connectivity probe produced by the manual `smoke` action. */
export interface SmokeProbe {
  readonly source: SourceId
  readonly label: string
  readonly ok: boolean
  readonly statusCode: number | null
  readonly failure?: FailureKind
  readonly latencyMs: number
  readonly transport: TransportId
  readonly reason: string
}

export interface SmokeReport {
  readonly ok: boolean
  readonly probes: readonly SmokeProbe[]
  readonly notes: readonly string[]
  /**
   * The anonymous per-operation capability picture, i.e. the answer to "does
   * querying CODE need a login?" (docs/DESIGN.md §7.1). It is the same report
   * `POST /api/dsh-codehub/probe` produces, reused rather than re-derived — the
   * connectivity panel and the wizard must not be able to disagree.
   */
  readonly capabilities: readonly SourceRequirementReport[]
}

// ---------------------------------------------------------------------------
// Login requirements and credential validation (docs/DESIGN.md §7.5).
// ---------------------------------------------------------------------------

/** One thing a source can be asked to do, as the connectivity panel names it. */
export const SOURCE_OPERATIONS = ['repo-search', 'code-search', 'file-read', 'article-read'] as const

export type SourceOperationId = (typeof SOURCE_OPERATIONS)[number]

/** Which operations make sense for which source. */
export const OPERATIONS_BY_SOURCE: Readonly<Record<SourceId, readonly SourceOperationId[]>> = {
  github: ['repo-search', 'code-search', 'file-read'],
  gitee: ['repo-search', 'code-search', 'file-read'],
  csdn: ['code-search', 'article-read'],
}

/**
 * The one operation a `smoke()` probe actually exercised.
 *
 * `smoke()` calls each adapter's `search()`: for GitHub and Gitee that is the
 * repository search, for CSDN its search API. Naming it honestly is what keeps
 * the derived capability row from claiming to have measured code search.
 */
export const PRIMARY_SMOKE_OPERATION: Readonly<Record<SourceId, SourceOperationId>> = {
  github: 'repo-search',
  gitee: 'repo-search',
  csdn: 'code-search',
}

/**
 * Turn a self-check probe into the capability row the panel renders.
 *
 * Kept as a pure function so the derivation is testable without a service, and
 * so the one thing that matters stays visible: `requiresLogin` is the contract
 * baseline plus the live 401, never a guess.
 */
export function capabilityFromSmokeProbe(probe: SmokeProbe, probedAt: string): SourceRequirementReport {
  const source = probe.source
  const operation = PRIMARY_SMOKE_OPERATION[source]
  const status = probe.statusCode
  const requiresLogin = operationRequiresLogin(source, operation) || status === 401
  const measured = status === null ? '请求未得到应答' : `HTTP ${status}`
  return {
    source,
    label: probe.label,
    probedAt,
    authenticated: false,
    operations: [
      {
        operation,
        reachable: status !== null && status > 0,
        statusCode: status,
        requiresLogin,
        evidence: `${operation} 本次自检实测（匿名）：${measured} —— ${probe.reason} ${LOGIN_REQUIREMENTS[source]}`,
        probedAt,
      },
    ],
  }
}

/**
 * One measured operation. Exactly the field names DESIGN §7.5 whitelists for
 * `/probe` (plus the `operation` identity), and no credential can reach any of
 * them: `evidence` is built from contract copy and a status code.
 */
export interface SourceRequirementCheck {
  readonly operation: SourceOperationId
  readonly reachable: boolean
  /** `null` when the request never got an HTTP answer. */
  readonly statusCode: number | null
  readonly requiresLogin: boolean
  readonly evidence: string
  readonly probedAt: string
}

/** What one source looks like right now, anonymously unless asked otherwise. */
export interface SourceRequirementReport {
  readonly source: SourceId
  readonly label: string
  readonly probedAt: string
  /** True when a stored credential rode along (`useStoredCredential`). */
  readonly authenticated: boolean
  readonly operations: readonly SourceRequirementCheck[]
}

/**
 * How a credential check ended.
 *
 * `valid` / `invalid` come from an endpoint that really authenticates the caller
 * (GitHub and Gitee both have one). `improved` / `unchanged` / `rejected` come
 * from CSDN, which has NO validation endpoint at all — the honest answer there
 * is a comparison, not a verdict.
 */
export type CredentialVerdict = 'valid' | 'invalid' | 'unknown' | 'improved' | 'unchanged' | 'rejected'

export interface CredentialValidation {
  readonly source: SourceId
  readonly verdict: CredentialVerdict
  readonly statusCode: number | null
  /**
   * The caller's OWN identity (`login`, or `name` when there is no `login`).
   * Allowed to be echoed back: it is who the user is, not what they hold.
   */
  readonly account: string | null
  readonly reason: string
}

/** The query the probes use. One word, no user data, cheapest possible answer. */
export const PROBE_QUERY = 'vue'

/** Probes are diagnostics: they must answer fast, so they get their own budget. */
export const PROBE_TIMEOUT_MS = 8_000

export interface ConfigView {
  readonly ok: true
  readonly config: ConfigJsonView
  readonly decisions: readonly UnresolvedDecision[]
  readonly decided: boolean
  readonly credentials: Readonly<Record<CredentialTarget, boolean>>
  readonly limits: ResolvedLimits
  readonly transport: {
    readonly webAvailable: boolean
    readonly proxyConfigured: boolean
    readonly proxyScopeNote: string
  }
  readonly notes: {
    readonly csdn: string
    readonly localProxy: string
    readonly antiCopy: string
    readonly settings: string
  }
  readonly paths: { readonly store: string }
  /**
   * Login state for the wizard: which methods each source has, whether this
   * plugin is able to drive a browser flow at all, and the hand-held guides.
   *
   * BOOLEANS AND CONTRACT COPY ONLY. `oauth.github` / `oauth.gitee` answer "is
   * there a client id (and, for Gitee, a client secret in the credential
   * service)" — never the id or the secret itself.
   */
  readonly login: ConfigLoginView
}

/** Injection points. Everything has a production default; tests override. */
export interface CodeSourceDeps {
  /** The live config. Re-read on every call so a settings change is picked up. */
  readonly getConfig: () => CodehubConfig
  /** Local store (fallback snapshot + proxy address). */
  readonly store: LocalConfigStore
  readonly settings?: SettingsBridge | undefined
  /** `ctx.get('web')` — optional dependency. */
  readonly web?: WebService | undefined
  readonly logger?: TransportLogger | undefined
  /** Test seam; defaults to `net.createTransport`. */
  readonly createTransport?: ((deps: TransportDeps) => Transport) | undefined
  /** Test seam; defaults to the three real adapter factories. */
  readonly adapters?: readonly SourceAdapter[] | undefined
}

// ---------------------------------------------------------------------------
// redactForDelivery — the unified outlet (备注③ mechanism).
// ---------------------------------------------------------------------------

export interface RedactLimits {
  readonly maxCodeChars?: number | undefined
}

/** Same clamp the adapters use, from the same contract caps. */
function clampMaxCodeChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_LIMITS.maxCodeChars
  return Math.min(Math.floor(value), HARD_LIMITS.maxCodeChars)
}

/**
 * Cut on a line boundary when that keeps most of the budget, so an excerpt does
 * not end mid-token.
 */
function cutAtLineBoundary(text: string, budget: number): string {
  const hard = text.slice(0, budget)
  const lastBreak = hard.lastIndexOf('\n')
  if (lastBreak >= Math.floor(budget * 0.6)) return hard.slice(0, lastBreak)
  return hard
}

function isResultArray(value: CodeLearnResult | readonly CodeLearnResult[]): value is readonly CodeLearnResult[] {
  return Array.isArray(value)
}

function fallbackSummary(result: CodeLearnResult): string {
  const subject = result.title.trim().length > 0 ? result.title : result.url
  return `未提取出思路要点（来源：${subject}）。请打开来源原文自行阅读，不要把它当作可直接使用的代码。`
}

/**
 * THE delivery outlet: truncate + banner + confidence + `is_verbatim_copy: false`.
 *
 * Accepts one row or an array (both are used: `service.search` redacts the whole
 * batch, routes and tests redact a single row).
 *
 * The banner is written as the FIRST LINE OF `code` rather than only into a
 * wrapper field, because `code` is the thing a reader is tempted to copy. A
 * bounded excerpt therefore cannot be lifted out of the delivery without the
 * 仅学习参考 warning travelling with it. The banner is charged against
 * `maxCodeChars`, so the exported excerpt never exceeds the configured bound.
 */
export function redactForDelivery(result: CodeLearnResult, limits?: RedactLimits): CodeLearnResult
export function redactForDelivery(results: readonly CodeLearnResult[], limits?: RedactLimits): CodeLearnResult[]
export function redactForDelivery(
  input: CodeLearnResult | readonly CodeLearnResult[],
  limits: RedactLimits = {},
): CodeLearnResult | CodeLearnResult[] {
  const budget = clampMaxCodeChars(limits.maxCodeChars)
  if (isResultArray(input)) return input.map((item) => redactOne(item, budget))
  return redactOne(input, budget)
}

function redactOne(result: CodeLearnResult, budget: number): CodeLearnResult {
  const banner = `${LEARNING_ONLY_BANNER}\n`
  const rawCode = typeof result.code === 'string' ? result.code : ''
  const codeBudget = Math.max(1, budget - banner.length)
  const truncated = rawCode.length > codeBudget
  const kept = truncated ? cutAtLineBoundary(rawCode, codeBudget) : rawCode

  const summary =
    typeof result.learned_summary === 'string' && result.learned_summary.trim().length > 0
      ? result.learned_summary
      : fallbackSummary(result)

  const confidence: Confidence = (CONFIDENCE_LEVELS as readonly string[]).includes(result.confidence)
    ? result.confidence
    : 'low'

  return {
    source: result.source,
    url: result.url,
    title: result.title,
    language: typeof result.language === 'string' ? result.language : '',
    code: `${banner}${kept}`,
    codeTruncated: truncated || result.codeTruncated === true,
    learned_summary: summary,
    // 备注③: structurally false. There is no assignable `true`.
    is_verbatim_copy: false,
    stars: typeof result.stars === 'number' && Number.isFinite(result.stars) ? result.stars : null,
    updatedAt: typeof result.updatedAt === 'string' && result.updatedAt.trim().length > 0 ? result.updatedAt : null,
    confidence,
    reason: typeof result.reason === 'string' ? result.reason : '',
  }
}

// ---------------------------------------------------------------------------
// GitHub access resolution.
// ---------------------------------------------------------------------------

export interface AccessPlan {
  readonly access: GithubAccessId | undefined
  readonly apiBase: string
  readonly rawMirrors: readonly string[]
  readonly available: boolean
  readonly notes: readonly string[]
}

/**
 * Compose a mirror API base from a configured prefix.
 *
 * `https://ghproxy.net/` + `https://api.github.com` -> `https://ghproxy.net/https://api.github.com`,
 * which is the form the adapters append endpoint paths to. A `{url}` template is
 * honoured too.
 */
export function composeMirrorBase(mirror: string, override: string): string {
  const official = override.trim().length > 0 ? override.trim() : GITHUB_API_BASE
  const trimmed = mirror.trim().replace(/\/+$/, '')
  if (trimmed.includes('{url}')) return trimmed.replace('{url}', official)
  const bare = official.replace(/^https?:\/\//, '')
  if (trimmed.endsWith(bare)) return trimmed
  return `${trimmed}/${official}`
}

/**
 * Pick the first GitHub access strategy that is actually usable.
 *
 * "Configured but unavailable" never falls back to something the user did not
 * choose (docs/DESIGN.md §2 #7: 空列表 = 该方式不可用，不兜底). Each skipped
 * strategy leaves a note explaining itself, so the reason string tells the user
 * what to fix rather than silently taking a different route.
 */
export function resolveAccess(config: ResolvedConfig): AccessPlan {
  const notes: string[] = []
  const rawMirrors = [...config.github.rawMirrorBases]
  const priority = config.github.accessPriority

  if (priority.length === 0) {
    return {
      access: undefined,
      apiBase: '',
      rawMirrors,
      available: false,
      notes: ['尚未决定 GitHub 的访问方式（accessPriority 为空），不会替用户选择。'],
    }
  }

  for (const candidate of priority) {
    if (candidate === 'direct' || candidate === 'watt' || candidate === 'hosts') {
      return { access: candidate, apiBase: config.github.apiBase, rawMirrors, available: true, notes }
    }
    if (candidate === 'token') {
      return {
        access: candidate,
        apiBase: config.github.apiBase,
        rawMirrors,
        available: true,
        notes: [...notes, '选择「Token 登录」；未配置 token 时会以匿名额度访问并在 reason 里标注。'],
      }
    }
    if (candidate === 'local-proxy') {
      if (config.github.localProxy.trim().length === 0) {
        notes.push('「本机代理」已勾选但地址为空；按设计「未填 = 该方式不可用」，继续看下一个方式。')
        continue
      }
      return {
        access: candidate,
        apiBase: config.github.apiBase,
        rawMirrors,
        available: true,
        notes: [...notes, `本机代理${LOCAL_PROXY_SCOPE_NOTE}。`],
      }
    }
    if (candidate === 'ghproxy' || candidate === 'third-party-mirror') {
      const base = config.github.webProxyBases[0]
      if (base === undefined || base.trim().length === 0) {
        notes.push(`「${candidate}」已勾选但镜像基址列表为空；按设计不预填、不兜底，继续看下一个方式。`)
        continue
      }
      return {
        access: candidate,
        apiBase: composeMirrorBase(base, config.github.apiBase),
        rawMirrors,
        available: true,
        notes: [...notes, MIRROR_TOKEN_NOTE],
      }
    }
    // raw-mirror serves file downloads, not the search API.
    notes.push('「raw 文件镜像」只用于文件下载，不提供搜索 API 基址，跳过（不会退回官方直连）。')
  }

  return {
    access: undefined,
    apiBase: '',
    rawMirrors,
    available: false,
    notes: [...notes, 'accessPriority 里勾选的访问方式当前都不可用，未发起请求。'],
  }
}

// ---------------------------------------------------------------------------
// Source ordering.
// ---------------------------------------------------------------------------

function normalizeSources(values: readonly string[] | undefined): SourceId[] {
  if (values === undefined) return []
  const out: SourceId[] = []
  for (const value of values) {
    if (!(SOURCES as readonly string[]).includes(value)) continue
    if (!out.includes(value as SourceId)) out.push(value as SourceId)
  }
  return out
}

/**
 * Source order for one call.
 *
 * The configured `sourcePriority` is the backbone — the user's ranking is never
 * discarded. An explicit `sources` argument re-orders within it and appends
 * anything the ranking did not mention, because the caller asked for those
 * sources by name.
 */
export function orderSources(
  priority: readonly SourceId[],
  requested: readonly SourceId[],
): SourceId[] {
  if (requested.length === 0) return [...priority]
  return [
    ...priority.filter((source) => requested.includes(source)),
    ...requested.filter((source) => !priority.includes(source)),
  ]
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

/**
 * The host service consumed as `ctx.codeSource`.
 *
 * Every optional service is looked up lazily through `ctx.get()` so a context
 * without `credentials` or `web` still mounts and still answers — with a clear
 * degradation message instead of an exception.
 */
export class CodeSource extends Service {
  private readonly context: Context

  private readonly deps: CodeSourceDeps

  constructor(ctx: Context, deps: CodeSourceDeps) {
    super(ctx, SERVICE_KEY)
    this.context = ctx
    this.deps = deps
  }

  // -- configuration ------------------------------------------------------

  /** Resolve the effective configuration (built-in config + store snapshot + settings). */
  async resolve(): Promise<ResolvedConfig> {
    const stored: LocalConfig = await this.deps.store.read().catch(() => ({}))
    const fromSettings = this.deps.settings === undefined ? undefined : (await this.deps.settings.read()).value
    /**
     * PRECEDENCE, and why the store snapshot is NOT last (this order was a bug).
     *
     * The live Cordis config is the plugin's own resolved config: `apply()` is
     * handed the schema-filled object, so every key carries its DEFAULT. Treating
     * it as "more authoritative than the user's saved values" therefore pins every
     * defaulted key to its default forever. Observed on a real installation:
     * the user's `sourcePriority` / `github.accessPriority` / CSDN switches sat in
     * the 0600 store, the settings namespace refused the write ("no volatile
     * fields"), and the host still answered `sourcePriority: []` — i.e. the panel
     * reported 「尚未决定」 for decisions the user had already made, and the tool
     * gate kept refusing.
     *
     * Correct order:
     *   1. live Cordis config (built-in defaults / profile patch) — the BASE;
     *   2. the 0600 store snapshot — what the user actually saved while the
     *      settings RPC could not persist our namespace;
     *   3. the settings namespace — authoritative whenever it is readable.
     * The proxy address stays owned by the 0600 store outright (备注①).
     */
    const merged: CodehubConfig = mergeConfigInput(
      mergeConfigInput(this.deps.getConfig(), stored.fallbackConfig),
      fromSettings,
    )
    return resolveConfig(merged, { localProxy: stored.localProxy })
  }

  /** Current effective limits. The tool needs them before it composes a timeout. */
  getLimits(): ResolvedLimits {
    return resolveLimits(this.deps.getConfig().limits)
  }

  /** The four decisions that have no answer yet. Empty = the tool may run. */
  async getUnresolved(): Promise<UnresolvedDecision[]> {
    const config = await this.resolve()
    return unresolvedDecisions(config)
  }

  async describeConfig(): Promise<ConfigView> {
    const config = await this.resolve()
    const decisions = unresolvedDecisions(config)
    const storePath = this.deps.store.filePath
    return {
      ok: true,
      config: toJsonView(config),
      decisions,
      decided: decisions.length === 0,
      credentials: await this.credentialStatus(),
      limits: config.limits,
      transport: {
        webAvailable: this.deps.web !== undefined,
        proxyConfigured: config.github.localProxy.trim().length > 0,
        proxyScopeNote: LOCAL_PROXY_SCOPE_NOTE,
      },
      notes: {
        csdn: CSDN_API_NOTE,
        localProxy: LOCAL_PROXY_HELP,
        antiCopy: ANTI_COPY_STATEMENT,
        settings: `settings namespace: ${SETTINGS_NAMESPACE}`,
      },
      paths: { store: storePath },
      login: {
        requirements: LOGIN_REQUIREMENTS,
        oauth: {
          // A client id is public and comes from config; the Gitee secret is a
          // credential, so this asks the credential service for its PRESENCE
          // only (`describe()`, never `resolve()`).
          github: config.github.oauthClientId.trim().length > 0,
          gitee:
            config.gitee.oauthClientId.trim().length > 0 && (await this.hasCredential(GITEE_OAUTH_SECRET_REF)),
        },
        guides: LOGIN_GUIDES,
      },
    }
  }

  /** Presence of one credential ref, as a boolean. A value never leaves here. */
  private async hasCredential(ref: string): Promise<boolean> {
    const credentials = this.context.get<CredentialsService>('credentials')
    if (credentials === undefined) return false
    try {
      const info = await credentials.describe(ref)
      return info?.configured === true
    } catch {
      return false
    }
  }

  /** Booleans only — `describe()`, never `resolve()`. A value never leaves here. */
  async credentialStatus(): Promise<Record<CredentialTarget, boolean>> {
    const targets: CredentialTarget[] = ['github', 'gitee', 'csdn']
    const out = { github: false, gitee: false, csdn: false }
    const credentials = this.context.get<CredentialsService>('credentials')
    if (credentials === undefined) return out
    for (const target of targets) {
      try {
        const info = await credentials.describe(CREDENTIAL_REFS[target])
        out[target] = info?.configured === true
      } catch {
        out[target] = false
      }
    }
    return out
  }

  // -- search -------------------------------------------------------------

  /**
   * Query the sources in priority order.
   *
   * Returns a value for every business outcome (including refusals) so the model
   * can branch on `ok`. Only a caller mistake throws.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
    const trimmed = typeof query === 'string' ? query.trim() : ''
    const empty: SearchOutcome = {
      ok: false,
      query: trimmed,
      results: [],
      notes: [],
      failures: [],
      unresolved_decisions: [],
      ask_user: '',
      reason: '',
      degraded: false,
      merged: false,
      sources_queried: [],
      deep_read: false,
    }

    const config = await this.resolve()

    if (!config.enabled) {
      const refusal = disabledRefusal()
      return { ...empty, reason: refusal.reason, ask_user: refusal.ask_user }
    }

    // ---- 决策门禁：在任何网络请求之前 --------------------------------------
    const gate = evaluateDecisions(config)
    if (!gate.ok) {
      return {
        ...empty,
        unresolved_decisions: [...gate.unresolved_decisions],
        ask_user: gate.ask_user,
        reason: '尚有决策点未确认，按设计未发起任何网络请求。请先回答下面的问题，再让我重试。',
      }
    }

    const order = orderSources(config.sourcePriority, normalizeSources(options.sources))
    if (order.length === 0) {
      return { ...empty, reason: '没有任何可查询的源（sourcePriority 与本次指定的来源都为空）。' }
    }

    const access = resolveAccess(config)
    const requestedLimit =
      typeof options.maxItems === 'number' && Number.isFinite(options.maxItems)
        ? options.maxItems
        : config.limits.maxItems
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), config.limits.maxItems, HARD_LIMITS.maxItems)

    const failures: SourceFailure[] = []
    const collected: CodeLearnResult[] = []
    const notes: LearnNote[] = []
    const queried: SourceId[] = []
    const chainNotes: string[] = []
    let degraded = false
    let deepReadPerformed = false

    for (const source of order) {
      // 降级深度：maxDepth 是「额外还能再试几个源」的预算。
      if (failures.length > config.limits.maxDepth && config.failover.enabled === true) {
        chainNotes.push(`降级深度已达上限（limits.maxDepth = ${config.limits.maxDepth}），停止继续切换源。`)
        break
      }

      const adapter = this.adapterFor(source)
      if (adapter === undefined) {
        failures.push({ source, kind: 'not-code', reason: `没有可用的 ${SOURCE_LABELS[source]} 适配器。` })
        continue
      }

      // `AccessPlan.access` is the contract `GithubAccessId`; the plan itself is
      // only used for the endpoint base. Keeping the two apart is what the
      // compiler forces here — and what keeps the adapter options honest.
      const sourceAccess: GithubAccessId | undefined = source === 'github' ? access.access : undefined
      if (source === 'github' && !access.available) {
        failures.push({
          source,
          kind: 'network',
          reason: ['GitHub 访问方式当前不可用，未发起请求。', ...access.notes].join(' '),
        })
        if (config.failover.enabled !== true) break
        degraded = true
        continue
      }

      const token = await this.resolveToken(source)
      const authenticated = token !== undefined
      const transport = this.buildTransport(config, sourceAccess)

      let outcome: AdapterOutcome
      try {
        outcome = await adapter.search(
          trimmed,
          this.adapterOptions(config, transport, {
            token,
            authenticated,
            access: sourceAccess,
            limit,
            signal: options.signal,
            apiBase: this.apiBaseFor(source, access, config),
            htmlFallback: source === 'github' ? undefined : source === 'gitee' ? config.gitee.htmlFallback : config.csdn.htmlFallback,
          }),
        )
      } catch (error) {
        const kind = classifyAdapterThrow(error)
        outcome = { ok: false, results: [], reason: `适配器抛出异常：${describeError(error)}`, failure: kind }
      }

      queried.push(source)

      if (outcome.ok && outcome.results.length > 0) {
        collected.push(...outcome.results)
        if (outcome.truncated === true) chainNotes.push(`${SOURCE_LABELS[source]} 的结果被 maxItems 截断。`)
        if (config.mergeSources !== true) {
          // Decided: only the top-priority source that answered.
          break
        }
        continue
      }

      const kind: FailureKind = outcome.failure ?? 'empty'
      failures.push({ source, kind, reason: outcome.reason })

      if (config.failover.enabled !== true) {
        // 未开启自动降级：停下并询问，不替用户决定换源。
        break
      }
      degraded = true
      chainNotes.push(`${SOURCE_LABELS[source]} 失败（${kind}），按用户设置自动降级到下一个源。`)
    }

    // 多源合并（仅当用户已决定合并）后统一去重并收敛到 limit。
    const deduped = collected.length > 0 ? dedupe(collected) : []
    const bounded = deduped.slice(0, limit)
    const results = redactForDelivery(bounded, { maxCodeChars: config.limits.maxCodeChars })

    // ---- 深度阅读（选做） ---------------------------------------------------
    const targets = config.deepRead.targets
    if (options.deepRead === true) {
      if (targets.length === 0) {
        chainNotes.push('已请求深度阅读，但没有选择深度阅读目标（决策点 11），本次只做浅搜索。')
      } else {
        const budget = Math.max(1, config.limits.maxDepth)
        let used = 0
        for (const row of results) {
          if (used >= budget) break
          const adapter = this.adapterFor(row.source)
          if (adapter?.deepRead === undefined) continue
          const accessPlan = row.source === 'github' ? access : undefined
          const sourceAccess: GithubAccessId | undefined = accessPlan?.access
          const token = await this.resolveToken(row.source)
          try {
            const deep = await adapter.deepRead(
              row.url,
              targets,
              this.adapterOptions(config, this.buildTransport(config, sourceAccess), {
                token,
                authenticated: token !== undefined,
                access: sourceAccess,
                limit,
                signal: options.signal,
                apiBase: this.apiBaseFor(row.source, accessPlan, config),
                maxDepth: 0,
              }),
            )
            if (deep.notes.length > 0) {
              notes.push(...deep.notes)
              deepReadPerformed = true
            } else if (deep.reason.length > 0) {
              chainNotes.push(`深度阅读未产出笔记：${deep.reason}`)
            }
          } catch (error) {
            chainNotes.push(`深度阅读失败：${describeError(error)}`)
          }
          used += 1
        }
      }
    }

    const reasonParts = [
      ...chainNotes,
      ...(failures.length > 0 ? [`失败：${failures.map((item) => `${item.source}=${item.kind}`).join('、')}`] : []),
      `共 ${results.length} 条（合并去重后${config.mergeSources === true ? '，已开启多源合并' : '，未开启多源合并'}）。`,
      '结果仅用于学习实现思路 / API 用法 / 取舍 / 踩坑，不是可直接粘贴的代码交付物。',
    ]

    if (results.length === 0) {
      const untried = order.filter((source) => !queried.includes(source))
      return {
        ok: false,
        query: trimmed,
        results: [],
        notes,
        failures,
        unresolved_decisions: [],
        ask_user:
          untried.length > 0
            ? `这些源都没有给出可用结果。要不要再查 ${untried.map((source) => SOURCE_LABELS[source]).join(' / ')}？`
            : '所有源都没有给出可用结果。要不要换一组更具体的关键词，或者调整访问方式（token / 镜像 / 本机代理）？',
        reason: reasonParts.join(' '),
        degraded,
        merged: config.mergeSources === true,
        sources_queried: queried,
        deep_read: deepReadPerformed,
      }
    }

    return {
      ok: true,
      query: trimmed,
      results,
      notes,
      failures,
      unresolved_decisions: [],
      ask_user: '',
      reason: reasonParts.join(' '),
      degraded,
      merged: config.mergeSources === true,
      sources_queried: queried,
      deep_read: deepReadPerformed,
    }
  }

  // -- deep read ----------------------------------------------------------

  /**
   * Distil design notes from one URL. Returns notes, never files.
   *
   * Returns `[]` (with a log line) when a decision is still open — the caller
   * that needs a *reason* should ask `getUnresolved()` first, which is what the
   * `POST /deepread` route does.
   */
  async deepRead(
    url: string,
    targets?: readonly DeepReadTarget[],
    options: SearchOptions = {},
  ): Promise<LearnNote[]> {
    const config = await this.resolve()
    if (!config.enabled) return []
    const gate = evaluateDecisions(config)
    if (!gate.ok) {
      this.deps.logger?.('深度阅读被决策门禁拒绝，未发起网络请求', { unresolved: gate.unresolved_decisions.length })
      return []
    }

    const wanted = targets !== undefined && targets.length > 0 ? targets : config.deepRead.targets
    if (wanted.length === 0) return []

    const source = this.sourceForUrl(url, config.sourcePriority)
    const adapter = this.adapterFor(source)
    if (adapter?.deepRead === undefined) return []

    const accessPlan = source === 'github' ? resolveAccess(config) : undefined
    const sourceAccess: GithubAccessId | undefined = accessPlan?.access
    const token = await this.resolveToken(source)
    try {
      const outcome = await adapter.deepRead(
        url,
        wanted,
        this.adapterOptions(config, this.buildTransport(config, sourceAccess), {
          token,
          authenticated: token !== undefined,
          access: sourceAccess,
          signal: options.signal,
          apiBase: this.apiBaseFor(source, accessPlan, config),
        }),
      )
      return outcome.notes
    } catch (error) {
      this.deps.logger?.('深度阅读失败', { source, reason: describeError(error) })
      return []
    }
  }

  // -- smoke --------------------------------------------------------------

  /**
   * Manual connectivity self-check.
   *
   * Deliberately TOKEN-FREE: it exercises the anonymous path only, so running it
   * can never leak a credential, and its result tells the user whether the
   * public route works before they invest in one.
   */
  async smoke(): Promise<SmokeReport> {
    const config = await this.resolve()
    if (!config.enabled) {
      return { ok: false, probes: [], notes: ['插件当前处于关闭状态，未发起任何探测请求。'], capabilities: [] }
    }

    const probes: SmokeProbe[] = []
    const notes: string[] = ['自检只使用公开端点且不携带任何凭据（token / cookie 都不会发出）。']

    for (const source of SOURCES) {
      const adapter = this.adapterFor(source)
      if (adapter === undefined) {
        probes.push({
          source,
          label: SOURCE_LABELS[source],
          ok: false,
          statusCode: null,
          failure: 'not-code',
          latencyMs: 0,
          transport: 'node',
          reason: `没有可用的 ${SOURCE_LABELS[source]} 适配器。`,
        })
        continue
      }
      const started = Date.now()
      const transport = this.buildTransport(config, undefined)
      try {
        const outcome = await adapter.search('vue', this.adapterOptions(config, transport, { limit: 1 }))
        const status = outcome.attempts?.find((attempt) => attempt.statusCode !== null)?.statusCode ?? null
        probes.push({
          source,
          label: SOURCE_LABELS[source],
          ok: outcome.ok,
          statusCode: status,
          ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
          latencyMs: Date.now() - started,
          transport: config.github.localProxy.trim().length > 0 ? 'node' : this.deps.web === undefined ? 'node' : 'dsh-web',
          reason: outcome.reason,
        })
      } catch (error) {
        probes.push({
          source,
          label: SOURCE_LABELS[source],
          ok: false,
          statusCode: null,
          failure: classifyAdapterThrow(error),
          latencyMs: Date.now() - started,
          transport: 'node',
          reason: describeError(error),
        })
      }
    }

    if (config.github.localProxy.trim().length > 0) {
      notes.push(`本机代理已配置：${LOCAL_PROXY_SCOPE_NOTE}。`)
    }

    // The capability rows answer the "查代码要不要登录" question with measurements
    // instead of folklore. They are DERIVED from the three anonymous probes this
    // self-check already ran — deliberately NOT a second `probe()` pass: that
    // would turn one click into eleven requests (3 + 3 + 3 + 2 operation probes),
    // which is both slow and rude to the endpoints CSDN's robots.txt already
    // asks machines not to crawl. `POST /probe` stays the per-operation
    // measurement a user asks for explicitly.
    const probedAt = new Date().toISOString()
    const capabilities = probes.map((probe) => capabilityFromSmokeProbe(probe, probedAt))
    notes.push(
      '上方每行的「查代码是否需要登录」= 本次匿名实测的 HTTP 状态码 + contract 里的实测文案；自检不携带任何凭据。',
    )

    return { ok: probes.every((probe) => probe.ok), probes, notes, capabilities }
  }

  // -- probe / credential validation --------------------------------------

  /**
   * Measure what one source can actually do right now, operation by operation.
   *
   * Deliberately ANONYMOUS by default: the connectivity panel has to answer
   * before the user has any credential, and a self-check that quietly spent one
   * would be a credential leaving the process without being asked. Pass
   * `useStoredCredential: true` to include the stored one.
   *
   * Runs without the decision gate: probing is how a user decides.
   */
  async probe(input: { readonly source?: SourceId; readonly useStoredCredential?: boolean } = {}): Promise<SourceRequirementReport> {
    const config = await this.resolve()
    const source: SourceId = input.source ?? config.sourcePriority[0] ?? 'github'
    const useCredential = input.useStoredCredential === true
    const token = useCredential ? await this.resolveToken(source) : undefined
    const authenticated = token !== undefined
    const transport = this.buildTransport(config, source === 'github' ? resolveAccess(config).access : undefined)
    const probedAt = new Date().toISOString()

    const operations: SourceRequirementCheck[] = []
    for (const operation of OPERATIONS_BY_SOURCE[source]) {
      operations.push(await this.probeOperation(config, transport, source, operation, token, authenticated, probedAt))
    }

    return { source, label: SOURCE_LABELS[source], probedAt, authenticated, operations }
  }

  private async probeOperation(
    config: ResolvedConfig,
    transport: Transport,
    source: SourceId,
    operation: SourceOperationId,
    token: string | undefined,
    authenticated: boolean,
    probedAt: string,
  ): Promise<SourceRequirementCheck> {
    const baseline = operationRequiresLogin(source, operation)
    const url = probeUrlFor(source, operation, config)
    // CSDN answers HTTP 521 without a browser-like UA / Referer, so the probe
    // sends the same headers the adapter does — otherwise the probe would report
    // a fake failure and the panel would blame the wrong thing.
    const headers = source === 'csdn' ? { ...CSDN_REQUEST_HEADERS } : undefined
    const timeoutMs = Math.min(config.limits.timeoutMs, PROBE_TIMEOUT_MS)
    const mode = authenticated ? '带已存凭据' : '匿名'

    try {
      const response = await transport({
        url,
        ...(headers === undefined ? {} : { headers }),
        ...(authenticated && token !== undefined ? { token } : {}),
        timeoutMs,
      })
      const reachable = response.statusCode > 0
      // A 401 is the measurement that matters most: it is the difference between
      // "the contract says this needs a login" and "this endpoint just said so".
      const requiresLogin = baseline || response.statusCode === 401
      const hint = response.statusCode === 521 ? '（HTTP 521：反爬拦截，通常代表缺少 UA / Referer 或日志态已失效）' : ''
      return {
        operation,
        reachable,
        statusCode: response.statusCode,
        requiresLogin,
        evidence: `${operation} 本次实测：HTTP ${response.statusCode}（${mode}）${hint} ${LOGIN_REQUIREMENTS[source]}`,
        probedAt,
      }
    } catch (error) {
      return {
        operation,
        reachable: false,
        statusCode: null,
        requiresLogin: baseline,
        evidence: `${operation} 本次实测：请求未得到应答（${mode}）—— ${describeError(error)} ${LOGIN_REQUIREMENTS[source]}`,
        probedAt,
      }
    }
  }

  /**
   * Check the stored credential for one source.
   *
   * GitHub and Gitee both publish an endpoint that authenticates the caller, so
   * the answer is a real verdict. CSDN publishes none — it has no OAuth and no
   * token API — so the honest answer there is a comparison between an anonymous
   * and a cookie-carrying sample, reported as improved / unchanged / rejected
   * instead of a verdict this service cannot actually make.
   */
  async validateCredential(source: SourceId): Promise<CredentialValidation> {
    if (source === 'csdn') return this.validateCsdnCredential()
    const config = await this.resolve()
    const token = await this.resolveToken(source)
    if (token === undefined) {
      return {
        source,
        verdict: 'unknown',
        statusCode: null,
        account: null,
        reason: `尚未配置 ${SOURCE_LABELS[source]} 凭据，无法校验。`,
      }
    }

    const base = source === 'github' ? config.github.apiBase || GITHUB_API_BASE : config.gitee.apiBase || GITEE_API_BASE
    const url = `${base.replace(/\/+$/, '')}/user`
    const transport = this.buildTransport(config, source === 'github' ? resolveAccess(config).access : undefined)
    try {
      const response = await transport({ url, token, timeoutMs: Math.min(config.limits.timeoutMs, PROBE_TIMEOUT_MS) })
      if (response.statusCode === 200) {
        return {
          source,
          verdict: 'valid',
          statusCode: 200,
          account: accountFromUserPayload(response.body),
          reason: `HTTP 200：凭据有效，这是你自己的账号身份。`,
        }
      }
      if (response.statusCode === 401) {
        return {
          source,
          verdict: 'invalid',
          statusCode: 401,
          account: null,
          reason: 'HTTP 401：凭据被拒绝（已过期、被撤销，或复制时少了字符）。',
        }
      }
      if (response.statusCode === 403) {
        return {
          source,
          verdict: 'unknown',
          statusCode: 403,
          account: null,
          reason: 'HTTP 403：凭据本身可能有效，但当前被限流或无权访问该端点，无法据此判断。',
        }
      }
      return {
        source,
        verdict: 'unknown',
        statusCode: response.statusCode,
        account: null,
        reason: `HTTP ${response.statusCode}：不是 200/401，无法据此判断凭据好坏。`,
      }
    } catch (error) {
      return {
        source,
        verdict: 'unknown',
        statusCode: null,
        account: null,
        reason: `校验请求未得到应答：${describeError(error)}`,
      }
    }
  }

  /** CSDN: no validation endpoint exists, so compare anonymous with cookie. */
  private async validateCsdnCredential(): Promise<CredentialValidation> {
    const config = await this.resolve()
    const cookie = await this.resolveToken('csdn')
    if (cookie === undefined) {
      return {
        source: 'csdn',
        verdict: 'unknown',
        statusCode: null,
        account: null,
        reason: '尚未配置 CSDN cookie，无法做对比校验。',
      }
    }

    const url = buildCsdnSearchUrl(PROBE_QUERY, config.csdn.apiBase.length > 0 ? { apiBase: config.csdn.apiBase } : {})
    const transport = this.buildTransport(config, undefined)
    const timeoutMs = Math.min(config.limits.timeoutMs, PROBE_TIMEOUT_MS)
    const anonymous = await this.sampleCsdn(transport, url, undefined, timeoutMs)
    const authenticated = await this.sampleCsdn(transport, url, cookie, timeoutMs)

    const anonOk = anonymous !== null && anonymous.statusCode >= 200 && anonymous.statusCode < 300
    const withOk = authenticated !== null && authenticated.statusCode >= 200 && authenticated.statusCode < 300
    const reasonBase = 'CSDN 没有官方校验接口（无 OAuth、无 token API），这里只能做匿名 vs 携带 cookie 的抽样对比。'

    if (withOk && !anonOk) {
      return { source: 'csdn', verdict: 'improved', statusCode: authenticated?.statusCode ?? null, account: null, reason: `${reasonBase} 匿名请求未成功、带 cookie 成功，说明 cookie 生效。` }
    }
    if (withOk && anonOk) {
      const grew = (authenticated?.length ?? 0) > (anonymous?.length ?? 0) * 1.2
      return {
        source: 'csdn',
        verdict: grew ? 'improved' : 'unchanged',
        statusCode: authenticated?.statusCode ?? null,
        account: null,
        reason: `${reasonBase} 两种方式都成功，返回体${grew ? '明显变大，cookie 可能提高了成功率' : '大小相当，本次看不出差别'}。`,
      }
    }
    if (anonymous !== null && anonOk && authenticated !== null && authenticated.statusCode >= 400) {
      return {
        source: 'csdn',
        verdict: 'rejected',
        statusCode: authenticated.statusCode,
        account: null,
        reason: `${reasonBase} 匿名可用但带 cookie 被拒（HTTP ${authenticated.statusCode}），cookie 可能已失效或被风控。`,
      }
    }
    return {
      source: 'csdn',
      verdict: 'unknown',
      statusCode: authenticated?.statusCode ?? null,
      account: null,
      reason: `${reasonBase} 本次两次抽样都没能给出结论。`,
    }
  }

  private async sampleCsdn(
    transport: Transport,
    url: string,
    cookie: string | undefined,
    timeoutMs: number,
  ): Promise<{ readonly statusCode: number; readonly length: number } | null> {
    try {
      const headers: Record<string, string> = { ...CSDN_REQUEST_HEADERS }
      if (cookie !== undefined) headers['cookie'] = cookie
      const response = await transport({ url, headers, timeoutMs })
      return { statusCode: response.statusCode, length: response.body.length }
    } catch {
      return null
    }
  }

  // -- internals ----------------------------------------------------------

  private adapterFor(source: SourceId): SourceAdapter | undefined {
    const injected = this.deps.adapters
    if (injected !== undefined) {
      const found = injected.find((candidate) => candidate.id === source)
      if (found !== undefined) return found
    }
    switch (source) {
      case 'github':
        return createGithubAdapter()
      case 'gitee':
        return createGiteeAdapter()
      case 'csdn':
        return createCsdnAdapter()
      default:
        return undefined
    }
  }

  private buildTransport(config: ResolvedConfig, access: GithubAccessId | undefined): Transport {
    const factory = this.deps.createTransport ?? createTransport
    return factory({
      ...(access === undefined ? {} : { access }),
      localProxy: config.github.localProxy,
      retries: config.limits.retries,
      timeoutMs: config.limits.timeoutMs,
      ...(this.deps.web === undefined ? {} : { web: this.deps.web }),
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    })
  }

  private adapterOptions(
    config: ResolvedConfig,
    transport: Transport,
    extra: {
      readonly token?: string | undefined
      readonly authenticated?: boolean | undefined
      readonly access?: GithubAccessId | undefined
      readonly limit?: number | undefined
      readonly signal?: AbortSignal | undefined
      readonly apiBase?: string | undefined
      readonly htmlFallback?: boolean | undefined
      readonly maxDepth?: number | undefined
    } = {},
  ): AdapterSearchOptions {
    const limit = extra.limit ?? config.limits.maxItems
    return {
      transport,
      timeoutMs: config.limits.timeoutMs,
      maxItems: Math.min(limit, HARD_LIMITS.maxItems),
      retries: config.limits.retries,
      authenticated: extra.authenticated === true,
      transportId: this.plannedTransport(config),
      rawMirrors: config.github.rawMirrorBases,
      maxDepth: extra.maxDepth ?? config.limits.maxDepth,
      maxCodeChars: config.limits.maxCodeChars,
      ...(extra.token === undefined ? {} : { token: extra.token }),
      ...(extra.access === undefined ? {} : { access: extra.access }),
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
      ...(extra.apiBase === undefined || extra.apiBase.length === 0 ? {} : { apiBase: extra.apiBase }),
      ...(extra.htmlFallback === undefined ? {} : { htmlFallback: extra.htmlFallback }),
    }
  }

  /** Best-effort channel label for the `reason` wording. Informational only. */
  private plannedTransport(config: ResolvedConfig): TransportId {
    if (config.github.localProxy.trim().length > 0) return 'node'
    return this.deps.web === undefined ? 'node' : 'dsh-web'
  }

  /**
   * Endpoint base override for one source. Empty string = the adapter's built-in
   * base (`GITHUB_API_BASE` / `GITEE_API_BASE` / `CSDN_SEARCH_BASE`), which is
   * also what a mirror strategy composes from.
   */
  private apiBaseFor(source: SourceId, access: AccessPlan | undefined, config: ResolvedConfig): string {
    if (source === 'github') return access?.apiBase ?? ''
    if (source === 'gitee') return config.gitee.apiBase
    return config.csdn.apiBase
  }

  private async resolveToken(target: CredentialTarget): Promise<string | undefined> {
    const credentials = this.context.get<CredentialsService>('credentials')
    if (credentials === undefined) return undefined
    try {
      const resolved = await credentials.resolve(CREDENTIAL_REFS[target])
      const value = resolved?.value
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
    } catch {
      return undefined
    }
  }

  private sourceForUrl(url: string, priority: readonly SourceId[]): SourceId {
    const lower = url.toLowerCase()
    if (lower.includes('github')) return 'github'
    if (lower.includes('gitee')) return 'gitee'
    if (lower.includes('csdn')) return 'csdn'
    return priority[0] ?? 'github'
  }
}

// ---------------------------------------------------------------------------
// Local helpers (kept out of the class for testability).
// ---------------------------------------------------------------------------

/**
 * Does this operation need a login, per the contract's measured facts?
 *
 * These baselines come from `LOGIN_REQUIREMENTS` (github code search → 401
 * anonymous; Gitee has no `/search/code` endpoint and its web code search needs
 * a session; CSDN article pages are anti-bot gated without a cookie). They are
 * the STARTING point — `probeOperation()` upgrades `requiresLogin` to true when
 * the live request answers 401.
 */
export function operationRequiresLogin(source: SourceId, operation: SourceOperationId): boolean {
  if (source === 'github') return operation === 'code-search'
  if (source === 'gitee') return operation === 'repo-search' || operation === 'code-search'
  return operation === 'article-read'
}

/**
 * The URL one probe hits.
 *
 * Every base comes from the resolved config (or the contract's built-in), and
 * the file-read targets are public, well-known repositories so a failure means
 * "this path is not readable" rather than "the probe invented a bad URL".
 */
export function probeUrlFor(source: SourceId, operation: SourceOperationId, config: ResolvedConfig): string {
  const base = (value: string, fallback: string): string => (value.trim().length > 0 ? value.trim() : fallback).replace(/\/+$/, '')
  const query = `q=${encodeURIComponent(PROBE_QUERY)}&per_page=1`

  if (source === 'github') {
    const root = base(config.github.apiBase, GITHUB_API_BASE)
    if (operation === 'repo-search') return `${root}/search/repositories?${query}`
    if (operation === 'code-search') return `${root}/search/code?${query}`
    return `${root}/repos/vuejs/core/contents/package.json`
  }
  if (source === 'gitee') {
    const root = base(config.gitee.apiBase, GITEE_API_BASE)
    if (operation === 'repo-search') return `${root}/search/repositories?${query}`
    // Probed on purpose: the contract measured this endpoint as HTTP 404. The
    // panel must show "the endpoint does not exist", not "add a token".
    if (operation === 'code-search') return `${root}/search/code?${query}`
    return `${root}/repos/mirrors/vue/contents/README.md`
  }
  if (operation === 'code-search') {
    return buildCsdnSearchUrl(PROBE_QUERY, config.csdn.apiBase.length > 0 ? { apiBase: config.csdn.apiBase } : {})
  }
  // 'article-read': the blog host root, deliberately NOT a pinned article id.
  // Article ids rot, and what the probe must answer is whether the article host
  // serves a browser-like request at all (HTTP 200) or bounces it (HTTP 521).
  return 'https://blog.csdn.net/'
}

/**
 * The caller's own identity out of a `/user` payload.
 *
 * This is the ONE field from a credential check that may travel back: it says
 * WHO the user is, never WHAT they hold. Parsing is guarded because a proxy or a
 * captive portal can answer 200 with HTML.
 */
export function accountFromUserPayload(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { login?: unknown; name?: unknown; username?: unknown }
    for (const candidate of [record.login, record.username, record.name]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    }
    return null
  } catch {
    return null
  }
}

/**
 * Classify anything an adapter threw.
 *
 * Adapters are supposed to return failures as VALUES (see `sources/types.ts`),
 * so reaching this function means one of them threw. The taxonomy value is
 * recovered from `failure` / `kind` when present, exactly as
 * `classifyTransportError()` does, so a bug in an adapter still produces a
 * classifiable outcome instead of a raw exception in the model's face.
 */
function classifyAdapterThrow(error: unknown): FailureKind {
  if (typeof error === 'object' && error !== null) {
    const explicit = error as { failure?: unknown; kind?: unknown }
    const candidate = explicit.failure ?? explicit.kind
    if (typeof candidate === 'string' && (FAILURE_KIND_VALUES as readonly string[]).includes(candidate)) {
      return candidate as FailureKind
    }
  }
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  return 'network'
}

const FAILURE_KIND_VALUES: readonly FailureKind[] = [
  'network',
  'timeout',
  'empty',
  'rate-limited',
  'auth-required',
  'parse-failed',
  'not-code',
]

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return '无法读取的错误对象'
  }
}

// ---------------------------------------------------------------------------
// Service registration on the context.
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The dsh-codehub host service. */
    codeSource: CodeSource
  }
}
