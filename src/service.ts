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
  DEFAULT_LIMITS,
  GITHUB_API_BASE,
  HARD_LIMITS,
  LEARNING_ONLY_BANNER,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_SCOPE_NOTE,
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
import { createCsdnAdapter } from './sources/csdn.js'
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

  /** Resolve the effective configuration (defaults + fallback + settings + store). */
  async resolve(): Promise<ResolvedConfig> {
    const stored: LocalConfig = await this.deps.store.read().catch(() => ({}))
    const fromSettings = this.deps.settings === undefined ? undefined : (await this.deps.settings.read()).value
    // Precedence: store fallback snapshot < live Cordis config < settings value,
    // and the proxy address from the 0600 store beats every other layer.
    const merged: CodehubConfig = mergeConfigInput(
      mergeConfigInput(stored.fallbackConfig, this.deps.getConfig()),
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
      return { ok: false, probes: [], notes: ['插件当前处于关闭状态，未发起任何探测请求。'] }
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
    return { ok: probes.every((probe) => probe.ok), probes, notes }
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
