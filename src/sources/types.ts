/**
 * dsh-codehub — source-adapter surface.
 *
 * OWNER: `adapters`. Consumers: the host half (`src/net.ts`, `src/tool.ts`)
 * builds `AdapterSearchOptions`; the three source adapters return
 * `AdapterOutcome` / `AdapterDeepOutcome`.
 *
 * Three rules are encoded here rather than left to convention:
 *
 * 1. 备注① — an adapter performs NO network I/O of its own. Every request goes
 *    through the injected `Transport`. Whatever note the transport attaches
 *    (for example `LOCAL_PROXY_SCOPE_NOTE` — 仅 Node 直连传输生效) is collected
 *    by `transportNotes()` and copied into `reason` verbatim by `joinReason()`.
 *    It is never replaced by a generic message.
 * 2. Failures are values, not thrown exceptions. Every adapter failure maps to
 *    exactly one `FailureKind`, because `degrade.ts` decides whether to advance
 *    a chain from that value alone.
 * 3. Endpoint literals live in `contract.ts` only. This file imports them; it
 *    never re-spells a URL.
 */

import {
  DEFAULT_LIMITS,
  FAILURE_KINDS,
  HARD_LIMITS,
  RETRYABLE_FAILURES,
  TOKEN_FORBIDDEN_ACCESS,
} from '../contract.js'
import type {
  CodeLearnResult,
  Confidence,
  DeepReadTarget,
  FailureKind,
  GithubAccessId,
  LearnNote,
  SourceId,
  TransportId,
} from '../contract.js'

// ---------------------------------------------------------------------------
// Transport — the only egress an adapter has (备注①).
// ---------------------------------------------------------------------------

/** One request as an adapter asks the host to issue it. Mirrors `src/net.ts`. */
export interface TransportRequest {
  url: string
  headers?: Record<string, string>
  /** 仅当策略允许时携带；镜像路径必须为 undefined */
  token?: string
  timeoutMs: number
  signal?: AbortSignal
}

/** One answer from the transport. Extra fields are optional so a 3-field impl still fits. */
export interface TransportResponse {
  statusCode: number
  body: string
  finalUrl: string
  /**
   * Optional transport provenance note (备注①). When `src/net.ts` reports that
   * something like the local proxy only applies to the `node` channel, it lands
   * here and the adapters copy it into `reason` unchanged.
   */
  note?: string
  /** Several transport notes, in order. Merged with `note` by `transportNotes()`. */
  notes?: readonly string[]
}

/** Injected egress. Adapters never import a fetch implementation. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

// ---------------------------------------------------------------------------
// Limits — every adapter clamps through these, so no caller can exceed a hard cap.
// ---------------------------------------------------------------------------

/** Per-request timeout, clamped into `(0, HARD_LIMITS.timeoutMs]`. */
export function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_LIMITS.timeoutMs
  }
  return Math.min(Math.floor(timeoutMs), HARD_LIMITS.timeoutMs)
}

/** Row bound, clamped into `[1, HARD_LIMITS.maxItems]`. */
export function clampMaxItems(maxItems: number | undefined): number {
  if (typeof maxItems !== 'number' || !Number.isFinite(maxItems) || maxItems < 1) {
    return DEFAULT_LIMITS.maxItems
  }
  return Math.min(Math.floor(maxItems), HARD_LIMITS.maxItems)
}

/** Excerpt bound, clamped into `[1, HARD_LIMITS.maxCodeChars]`. */
export function clampMaxCodeChars(maxCodeChars: number | undefined): number {
  if (typeof maxCodeChars !== 'number' || !Number.isFinite(maxCodeChars) || maxCodeChars < 1) {
    return DEFAULT_LIMITS.maxCodeChars
  }
  return Math.min(Math.floor(maxCodeChars), HARD_LIMITS.maxCodeChars)
}

/**
 * Failover depth budget, clamped into `[0, HARD_LIMITS.maxDepth]`.
 *
 * Depth counts *extra* rungs, so `maxDepth: 1` permits the primary plus one
 * fallback. `0` forbids any fallback.
 */
export function clampMaxDepth(maxDepth: number | undefined): number {
  if (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth) || maxDepth < 0) {
    return DEFAULT_LIMITS.maxDepth
  }
  return Math.min(Math.floor(maxDepth), HARD_LIMITS.maxDepth)
}

// ---------------------------------------------------------------------------
// Per-call options.
// ---------------------------------------------------------------------------

/** Everything one adapter call needs. The adapter performs no I/O outside `transport`. */
export interface AdapterSearchOptions {
  /** 备注①: injected egress. Required — an adapter has no other way out. */
  transport: Transport
  /** Per-request timeout; clamped by `clampTimeout()`. */
  timeoutMs?: number
  /** Row bound; clamped by `clampMaxItems()`. */
  maxItems?: number
  /**
   * How many times the caller permits re-issuing the *same* request. Adapters
   * issue each request exactly once and let `degrade.ts` own the chain, so this
   * value is echoed into `reason` (and into failover plans) rather than honoured
   * here — that keeps retries from being counted twice.
   */
  retries?: number
  /** Credential for this call. Mirrors must never receive it — see `tokenForAccess()`. */
  token?: string
  /** Whether this call is authenticated (drives `score.ts`). */
  authenticated?: boolean
  /** GitHub access strategy: decides token carriage and mirror-vs-official base. */
  access?: GithubAccessId
  /** Which transport the caller used. Informational only (备注① reasons). */
  transportId?: TransportId
  /**
   * API base override for whichever endpoint this adapter talks to. Defaults:
   * `GITHUB_API_BASE` (github), `GITEE_API_BASE` (gitee), `CSDN_SEARCH_BASE` (csdn).
   */
  apiBase?: string
  /**
   * GitHub raw-file base list, tried in order until one answers. Each entry is
   * either a prefix (`https://ghproxy.net/https://raw.githubusercontent.com`)
   * or a `{url}` template. Tokens are never attached on this path.
   */
  rawMirrors?: readonly string[]
  /** Allow the HTML-page fallback when the JSON endpoint answers empty (gitee/csdn). */
  htmlFallback?: boolean
  /** Failover depth budget for this call; clamped by `clampMaxDepth()`. */
  maxDepth?: number
  /** Cancellation for the whole call. */
  signal?: AbortSignal
  /** Bound on the `code` excerpt; clamped by `clampMaxCodeChars()`. */
  maxCodeChars?: number
}

// ---------------------------------------------------------------------------
// Outcomes — failures as values.
// ---------------------------------------------------------------------------

/** One request an adapter actually made, for the reason string and for tests. */
export interface AdapterAttempt {
  /** URL as requested, after mirror / template expansion. */
  readonly url: string
  /** HTTP status, or null when the request threw before answering. */
  readonly statusCode: number | null
  /** Set when this attempt failed. */
  readonly failure?: FailureKind
  /** Verbatim per-attempt note, including transport notes (备注①). */
  readonly note?: string
}

/** What a single `search()` call produced. */
export interface AdapterOutcome {
  /** True iff `failure` is undefined and at least one row survived. */
  readonly ok: boolean
  /** Rows ready for scoring / redaction. Never a verbatim file copy (备注③). */
  readonly results: CodeLearnResult[]
  /** Why this outcome looks the way it does; transport notes survive verbatim. */
  readonly reason: string
  /** Exactly one classification when the call produced no usable rows. */
  readonly failure?: FailureKind
  /** Every request made, in order. */
  readonly attempts?: readonly AdapterAttempt[]
  /** True when rows were dropped because of the `maxItems` bound. */
  readonly truncated?: boolean
}

/** What a `deepRead()` call produced: notes, never files (备注③). */
export interface AdapterDeepOutcome {
  /** Distilled approach / contract / tradeoffs / pitfalls. Never a file copy. */
  readonly notes: LearnNote[]
  readonly reason: string
  readonly failure?: FailureKind
  /** Files actually read while distilling. */
  readonly fetchedUrls?: readonly string[]
  /** Requested targets that yielded nothing usable. */
  readonly skipped?: readonly DeepReadTarget[]
  readonly attempts?: readonly AdapterAttempt[]
}

// ---------------------------------------------------------------------------
// Scoring surface — shared by `learn/score.ts` and every adapter.
// ---------------------------------------------------------------------------

/** The four factors `score.ts` weighs, plus verbatim notes. */
export interface ScoreInput {
  readonly source: SourceId
  /** The call was authenticated for this source. */
  readonly authenticated: boolean
  /** The item is marked as a repost (`originalType !== '原创'`). */
  readonly reposted: boolean
  /** 0..1 — how much of the expected payload parsed into usable fields. */
  readonly completeness: number
  /** Extra clauses copied verbatim into `reason`, e.g. the transport scope note. */
  readonly notes?: readonly string[]
}

/** One scored row: the level plus the single-sentence justification. */
export interface Score {
  readonly confidence: Confidence
  readonly reason: string
}

// ---------------------------------------------------------------------------
// The adapter interface. `host-core` programs against exactly this.
// ---------------------------------------------------------------------------

export interface SourceAdapter {
  readonly id: SourceId
  /** 单次搜索。失败必须归类到 FailureKind，不要抛裸异常。 */
  search(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>
  /** 仅 github/gitee 支持；csdn 返回 not-code。 */
  deepRead?(url: string, targets: readonly DeepReadTarget[], opts: AdapterSearchOptions): Promise<AdapterDeepOutcome>
}

// ---------------------------------------------------------------------------
// Shared helpers. Pure — unit-testable without a network.
// ---------------------------------------------------------------------------

/** Join reason clauses with `；`, dropping empties. Order is preserved. */
export function joinReason(...parts: readonly (string | undefined | null)[]): string {
  const kept: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') continue
    const trimmed = part.trim()
    if (trimmed.length > 0 && !kept.includes(trimmed)) kept.push(trimmed)
  }
  return kept.join('；')
}

/** Narrow an unknown value to a `FailureKind`. */
export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value)
}

/** Like `joinReason()`, but yields `undefined` when nothing survives. */
export function optionalReason(...parts: readonly (string | undefined | null)[]): string | undefined {
  const joined = joinReason(...parts.slice())
  return joined.length > 0 ? joined : undefined
}

/** Only failures in `RETRYABLE_FAILURES` may advance a failover chain. */
export function isRetryableFailure(failure: FailureKind | undefined): boolean {
  return failure !== undefined && (RETRYABLE_FAILURES as readonly FailureKind[]).includes(failure)
}

/** A classified failure: the taxonomy value plus the human sentence. */
export interface ClassifiedFailure {
  readonly failure: FailureKind
  readonly reason: string
}

/** Collect transport notes (备注①) in order, `note` first, then `notes`. */
export function transportNotes(res: TransportResponse | undefined | null): string[] {
  if (res === undefined || res === null) return []
  const out: string[] = []
  if (typeof res.note === 'string' && res.note.trim().length > 0) out.push(res.note.trim())
  const list = res.notes
  if (list !== undefined) {
    for (const item of list) {
      if (typeof item === 'string' && item.trim().length > 0 && !out.includes(item.trim())) {
        out.push(item.trim())
      }
    }
  }
  return out
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const candidate = (err as { message?: unknown }).message
    if (typeof candidate === 'string') return candidate
  }
  try {
    return String(err)
  } catch {
    return '传输层抛出了无法读取的错误对象'
  }
}

/**
 * Map a thrown transport error onto one `FailureKind`.
 *
 * The transport's own wording is kept verbatim (备注①): `src/net.ts` may explain
 * that a setting only applies to the node channel, and that sentence must reach
 * the agent unchanged. A pre-classified `failure` / `kind` property on the error
 * is honoured when present.
 */
export function classifyTransportError(err: unknown): ClassifiedFailure {
  const message = messageOf(err)
  const detail = message.trim().length > 0 ? message.trim() : '传输层未给出错误信息'

  if (typeof err === 'object' && err !== null) {
    const explicit = err as { failure?: unknown; kind?: unknown }
    const kind = explicit.failure ?? explicit.kind
    if (isFailureKind(kind)) {
      return { failure: kind, reason: `传输失败（${kind}）：${detail}` }
    }
  }

  const name = err instanceof Error ? err.name : ''
  const lower = message.toLowerCase()

  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|etimedout|超时/.test(lower)) {
    return { failure: 'timeout', reason: `传输超时：${detail}` }
  }
  if (/too many requests|rate ?limit|429|限流/.test(lower)) {
    return { failure: 'rate-limited', reason: `传输被限流：${detail}` }
  }
  if (/unauthorized|forbidden|bad credentials|requires authentication|401|403|凭据/.test(lower)) {
    return { failure: 'auth-required', reason: `传输缺少有效凭据：${detail}` }
  }
  if (/unexpected token|json|parse|解析/.test(lower)) {
    return { failure: 'parse-failed', reason: `传输返回的内容无法解析：${detail}` }
  }
  return { failure: 'network', reason: `网络请求失败：${detail}` }
}

/**
 * Classify a non-2xx `TransportResponse`. Returns null for 2xx so callers can
 * proceed to parse. `what` is the human subject, e.g. `GitHub 仓库搜索`.
 */
export function failureFromResponse(res: TransportResponse, what: string): ClassifiedFailure | null {
  const status = res.statusCode
  const notes = transportNotes(res)
  const suffix = notes.length > 0 ? `；${notes.join('；')}` : ''
  // A transport that cannot report a status (the DSH web channel sends 0 when
  // the harness answer carries none) must not be read as a failure: the caller
  // classifies from the body instead, and a body that does not parse becomes
  // `parse-failed` anyway.
  if (typeof status !== 'number' || !Number.isFinite(status) || status <= 0) return null
  if (status >= 200 && status < 300) return null

  const body = typeof res.body === 'string' ? res.body.slice(0, 400) : ''
  const lower = body.toLowerCase()

  if (status === 401) {
    return { failure: 'auth-required', reason: `${what} 需要登录或凭据无效（HTTP 401）${suffix}` }
  }
  if (status === 403) {
    const rateLimited = /rate limit|too many requests|abuse|限流/.test(lower)
    return rateLimited
      ? { failure: 'rate-limited', reason: `${what} 被限流（HTTP 403）${suffix}` }
      : { failure: 'auth-required', reason: `${what} 被拒绝，可能需要登录或凭据不足（HTTP 403）${suffix}` }
  }
  if (status === 404) {
    return {
      failure: 'empty',
      reason: `${what} 未找到（HTTP 404）：接口路径可能已变更，或该目标不存在${suffix}`,
    }
  }
  if (status === 408) {
    return { failure: 'timeout', reason: `${what} 请求超时（HTTP 408）${suffix}` }
  }
  if (status === 429) {
    return { failure: 'rate-limited', reason: `${what} 被限流（HTTP 429）${suffix}` }
  }
  if (status >= 500) {
    return { failure: 'network', reason: `${what} 服务端错误（HTTP ${status}）${suffix}` }
  }
  if (status >= 400) {
    return { failure: 'parse-failed', reason: `${what} 请求被拒绝（HTTP ${status}）：查询或参数不被接受${suffix}` }
  }
  return { failure: 'network', reason: `${what} 返回了未预期的状态码（HTTP ${status}）${suffix}` }
}

/**
 * Token carriage gate. Mirrors listed in `TOKEN_FORBIDDEN_ACCESS` (ghproxy,
 * raw-mirror, third-party-mirror) must never see a credential, so this returns
 * undefined for them even when the caller passed a token.
 */
export function tokenForAccess(access: GithubAccessId | undefined, token: string | undefined): string | undefined {
  if (typeof token !== 'string' || token.trim().length === 0) return undefined
  if (access !== undefined && (TOKEN_FORBIDDEN_ACCESS as readonly GithubAccessId[]).includes(access)) {
    return undefined
  }
  return token
}

/** Truncate an excerpt to `limit` chars and report whether anything was cut. */
export function boundExcerpt(text: string, limit: number): { readonly code: string; readonly codeTruncated: boolean } {
  const bound = clampMaxCodeChars(limit)
  if (text.length <= bound) return { code: text, codeTruncated: false }
  return { code: text.slice(0, bound), codeTruncated: true }
}

/** Standard `not-code` answer used by adapters that cannot serve a request. */
export function notCodeOutcome(reason: string): AdapterOutcome {
  return { ok: false, results: [], reason, failure: 'not-code' }
}
