/**
 * dsh-codehub — unified network egress.
 *
 * Every byte this plugin sends to the outside world leaves through
 * `createTransport()`. Nothing else in `src/` may call `fetch` (docs/DESIGN.md
 * §5: adapters receive a `Transport` and have no other way out).
 *
 * ── 备注① — the local proxy applies ONLY on the `node` transport ─────────────
 *
 * There are exactly two channels:
 *
 *   | transport | implementation                | steerable by a proxy address |
 *   |-----------|-------------------------------|------------------------------|
 *   | `dsh-web` | the harness web service       | NO — the harness owns egress |
 *   | `node`    | this process's own HTTP client| YES                          |
 *
 * `planRequest()` therefore decides the channel AND whether the configured
 * proxy can be honoured, and whenever a configured setting is deliberately not
 * applied it emits a `reason`/`notes` sentence containing
 * `LOCAL_PROXY_SCOPE_NOTE` (仅 Node 直连传输生效). Those notes ride out on the
 * `TransportResponse` (`note` + `notes`) and are copied verbatim into the
 * adapter's `reason` — and on a thrown failure the same sentence is appended to
 * the error message. A sentence the user needs must never be swallowed.
 *
 * ── Failure taxonomy ────────────────────────────────────────────────────────
 *
 * The transport resolves for EVERY HTTP status code (2xx..5xx). Classifying an
 * HTTP answer is the adapter's job (`failureFromResponse()`), because it can
 * read the body. The transport throws `TransportError` only when no HTTP answer
 * exists at all — DNS/TCP/TLS/proxy-handshake failures, timeouts, cancellation —
 * plus the local misconfiguration cases in `planRequest().blocked`.
 *
 * `kind` and `failure` are BOTH set on the error, both are `FailureKind` values,
 * so either downstream convention works.
 *
 * ── Status precedence (documented, because two rules overlap) ───────────────
 *
 *   401            -> auth-required   (a credential is missing or invalid)
 *   403            -> rate-limited    (GitHub answers 403 for anonymous quota
 *                                      exhaustion; a token hint is attached
 *                                      separately by `classifyStatusHint`)
 *   429            -> rate-limited
 *   408            -> timeout
 *   404 / 410      -> not-code
 *   5xx            -> network
 *   other 4xx      -> parse-failed
 *   1xx / 2xx      -> undefined (no failure)
 *   3xx            -> empty (a redirect neither channel could follow carries
 *                            no data; both channels DO follow redirects when
 *                            they can, so reaching here means the chain ended)
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────
 *
 * Token values, cookie headers and proxy addresses must never reach a log line,
 * an error message or a response body. Two mechanisms enforce it: `scrubSecrets`
 * is applied to every message and log payload, and `redactAddress` /
 * `redactCredential` are the only way these modules render a sensitive value.
 * Request HEADERS are never logged at all (a CSDN cookie rides in one).
 */

import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

import {
  DEFAULT_LIMITS,
  HARD_LIMITS,
  LOCAL_PROXY_SCOPE_NOTE,
  RETRYABLE_FAILURES,
  TOKEN_FORBIDDEN_ACCESS,
} from './contract.js'
import type { FailureKind, GithubAccessId, TransportId } from './contract.js'
import type { Transport, TransportRequest, TransportResponse } from './sources/types.js'
import type { WebService } from '@deepseek-ai/dsh-web'

/** Redirect hops followed on the hand-rolled proxy path (never on `fetch`). */
export const MAX_REDIRECTS = 3

/** Handshake responses larger than this are treated as a broken proxy. */
export const MAX_HANDSHAKE_BYTES = 8 * 1024

/** Largest `err.message` we keep, so a chatty stack cannot flood a `reason`. */
const MAX_MESSAGE_CHARS = 400

// ---------------------------------------------------------------------------
// Logging + redaction.
// ---------------------------------------------------------------------------

export type TransportLogger = (event: string, detail?: Record<string, unknown>) => void

/**
 * `Bearer <token>` / `Basic <blob>` auth-scheme forms.
 *
 * Needed in addition to the key/value rule: `Authorization: Bearer sk-live-…`
 * would otherwise be reduced to `Authorization: **** sk-live-…`, because the
 * key/value rule stops at the space and only eats the scheme word — leaving the
 * actual secret in the log. Reported by tests-verify.
 */
const AUTH_SCHEME_PATTERN = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{6,})/gi

/** `key=value` / `key: value` forms, including quoted values. */
const KEY_VALUE_PATTERN =
  /(authorization|cookie|set-cookie|token|access_token|refresh_token|private_token|api[_-]?key|apikey|secret|password|passwd)\s*([=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi

/** `token sk-live-…` — a keyword separated from its value by whitespace only. */
const SPACED_VALUE_PATTERN = /\b(token|apikey|api[_-]?key|secret|password|passwd)\s+([A-Za-z0-9._~+/=-]{8,})/gi

/** `scheme://user:pass@host` — proxy / URL credentials. */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi

/**
 * Replace every credential-shaped substring with `****`.
 *
 * Rule order matters: the auth-scheme rule runs FIRST so the whole
 * `Bearer <value>` pair is consumed before the key/value rule can match the
 * keyword alone and strand the value. Sharing these `/g` literals between calls
 * is safe — `String.prototype.replace` resets `lastIndex` for a global regexp.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(AUTH_SCHEME_PATTERN, '$1 ****')
    .replace(KEY_VALUE_PATTERN, '$1$2****')
    .replace(SPACED_VALUE_PATTERN, '$1 ****')
    .replace(URL_USERINFO_PATTERN, '$1****@')
}

/** `socks5://user:pass@127.0.0.1:7890` -> `socks5://127.0.0.1:****`. */
export function redactAddress(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '(未配置)'
  const spec = parseProxyAddress(value)
  if (spec === undefined) return '****'
  return `${spec.scheme}://${spec.host}:****`
}

/** Credentials are rendered as a state, never as a value or a length. */
export function redactCredential(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? '(已配置)' : '(未配置)'
}

/** A loggable URL label: scheme + host + path. No query, no userinfo. */
export function safeUrlLabel(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return '(无法解析的地址)'
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { message?: unknown }).message
    if (typeof candidate === 'string') return candidate
  }
  try {
    return String(error)
  } catch {
    return '无法读取的错误对象'
  }
}

function shortMessage(error: unknown): string {
  const text = scrubSecrets(messageOf(error)).replace(/\s+/g, ' ').trim()
  if (text.length === 0) return '传输层未给出错误信息'
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
}

/**
 * Console logger.
 *
 * The shim exposes no `ctx.logger` (types/dsh/index.d.ts lists the observed
 * `Context` surface: `effect` / `get` / `inject` / `on`), and reaching for an
 * un-injected service property throws — so `console` it is. Every payload is
 * scrubbed, and the happy path logs nothing at all.
 */
export function createConsoleLogger(prefix = '[dsh-codehub]'): TransportLogger {
  return (event, detail) => {
    let suffix = ''
    if (detail !== undefined) {
      try {
        suffix = ` ${scrubSecrets(JSON.stringify(detail))}`
      } catch {
        suffix = ' (detail 无法序列化)'
      }
    }
    console.warn(`${prefix} ${scrubSecrets(event)}${suffix}`)
  }
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * A failure with no HTTP answer behind it.
 *
 * `name` mirrors the cause (`AbortError` / `TimeoutError`) when there is one, so
 * a downstream `err.name === 'AbortError'` check keeps working even without
 * reading `kind`.
 */
export class TransportError extends Error {
  readonly kind: FailureKind
  readonly failure: FailureKind
  readonly statusCode?: number

  constructor(kind: FailureKind, message: string, options?: { statusCode?: number; cause?: unknown; name?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.kind = kind
    this.failure = kind
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode
    this.name = options?.name ?? 'TransportError'
  }
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status onto the taxonomy. See the precedence table in the header.
 *
 * `hasToken` is part of the signature (the token policy and the caller both know
 * it) but does NOT change the classification: a 403 is the anonymous-quota
 * answer on GitHub, so it is `rate-limited` whether or not a credential rode
 * along. The credential hint is a separate sentence — `classifyStatusHint()` —
 * because one FailureKind cannot carry two meanings.
 */
export function classifyStatus(statusCode: number, hasToken: boolean): FailureKind | undefined {
  void hasToken
  if (statusCode >= 200 && statusCode < 300) return undefined
  if (statusCode === 401) return 'auth-required'
  if (statusCode === 403) return 'rate-limited'
  if (statusCode === 429) return 'rate-limited'
  if (statusCode === 408) return 'timeout'
  if (statusCode === 404 || statusCode === 410) return 'not-code'
  if (statusCode >= 500) return 'network'
  if (statusCode >= 400) return 'parse-failed'
  return 'empty'
}

/**
 * A second sentence for the `reason` when a status has a secondary meaning.
 * `403` without a credential is usually the anonymous quota: saying so is the
 * difference between "wait an hour" and "add a token".
 */
export function classifyStatusHint(statusCode: number, hasToken: boolean): string | undefined {
  if (statusCode === 403 && !hasToken) {
    return '本次请求未携带凭据，未登录的配额通常更低 —— 补一个 token 往往即可恢复。'
  }
  return undefined
}

/** Classify anything thrown by a socket / fetch / proxy handshake. */
export function classifyThrown(error: unknown): FailureKind {
  if (error instanceof TransportError) return error.kind
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  const text = messageOf(error).toLowerCase()
  if (/timed?\s?out|etimedout|timeout|超时/.test(text)) return 'timeout'
  if (/aborted|aborterror|cancell?ed|已取消/.test(text)) return 'timeout'
  if (/429|too many requests|rate ?limit|限流/.test(text)) return 'rate-limited'
  if (/401|403|unauthorized|forbidden|bad credentials|凭据/.test(text)) return 'auth-required'
  if (/unexpected token|json|parse|解析/.test(text)) return 'parse-failed'
  return 'network'
}

/**
 * Kinds worth re-issuing the SAME request for, derived from the contract.
 *
 * `auth-required` is subtracted on purpose: retrying cannot conjure a
 * credential, and spending the retry budget on it only delays the failover
 * chain, which is the layer that owns that case.
 */
export const TRANSPORT_RETRY_KINDS: readonly FailureKind[] = RETRYABLE_FAILURES.filter(
  (kind) => kind !== 'auth-required',
)

export function isTransportRetryable(kind: FailureKind): boolean {
  return TRANSPORT_RETRY_KINDS.includes(kind)
}

/** Transient HTTP answers the transport may re-issue by itself. */
export function shouldRetryStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504
}

export function clampRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMITS.retries
  return Math.min(Math.max(Math.floor(value), 0), HARD_LIMITS.retries)
}

export function clampTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_LIMITS.timeoutMs
  return Math.min(Math.floor(value), HARD_LIMITS.timeoutMs)
}

/** Wrap anything thrown into a `TransportError`, keeping 备注① wording. */
export function toTransportError(error: unknown, context?: { readonly reason?: string | undefined }): TransportError {
  const name = error instanceof Error ? error.name : ''
  let base: TransportError
  if (error instanceof TransportError) {
    base = error
  } else if (name === 'AbortError') {
    base = new TransportError('timeout', '请求已取消。', { cause: error, name: 'AbortError' })
  } else if (name === 'TimeoutError') {
    base = new TransportError('timeout', '请求超时。', { cause: error, name: 'TimeoutError' })
  } else {
    const kind = classifyThrown(error)
    base = new TransportError(kind, shortMessage(error), { cause: error })
  }

  const reason = scrubSecrets(context?.reason ?? '')
  if (reason.length === 0 || base.message.includes(reason)) return base
  return new TransportError(base.kind, `${base.message}（${reason}）`, {
    statusCode: base.statusCode,
    cause: base,
    name: base.name,
  })
}

// ---------------------------------------------------------------------------
// Signals.
// ---------------------------------------------------------------------------

/**
 * `AbortSignal.any([...])` over the signals that actually exist.
 *
 * `exec.signal` is optional in `ToolExecutionInput`, and passing `undefined`
 * into `AbortSignal.any` throws, so the list is filtered first. A manual
 * controller stands in for runtimes without `any` (Node < 20.3), which keeps
 * the composed timeout working instead of silently dropping it.
 */
export function composeSignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const usable = signals.filter((item): item is AbortSignal => item !== undefined)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]

  const anyOf = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any
  if (typeof anyOf === 'function') return anyOf.call(AbortSignal, usable)

  const controller = new AbortController()
  for (const item of usable) {
    if (item.aborted) {
      controller.abort(item.reason)
      break
    }
    item.addEventListener('abort', () => controller.abort(item.reason), { once: true })
  }
  return controller.signal
}

/** `AbortSignal.timeout(ms)`, with a manual fallback. */
export function timeoutSignal(timeoutMs: number): AbortSignal {
  const factory = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (typeof factory === 'function') return factory.call(AbortSignal, timeoutMs)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  return controller.signal
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      cleanup()
      reject(new TransportError('timeout', '请求在重试等待期间被取消。', { name: 'AbortError' }))
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function backoffMs(attempt: number): number {
  return Math.min(200 * 2 ** attempt, 2_000)
}

// ---------------------------------------------------------------------------
// Proxy addresses.
// ---------------------------------------------------------------------------

export interface ProxySpec {
  readonly scheme: 'http' | 'https' | 'socks5' | 'socks4'
  readonly host: string
  readonly port: number
  /** `user:pass` when the configured address carried userinfo. Never logged. */
  readonly auth?: string
  /** The configured text, for `redactAddress()` and diagnostics only. */
  readonly raw: string
}

/**
 * Parse `127.0.0.1:7890`, `http://host:port`, `socks5://user:pass@host:port`.
 *
 * A bare `host:port` is read as an HTTP proxy, which is what Clash / V2Ray /
 * Watt expose by default. Returns `undefined` for anything unparseable;
 * `planRequest()` then REFUSES the request rather than guessing — a configured
 * proxy that silently fails open would send traffic the user meant to tunnel.
 */
export function parseProxyAddress(value: unknown): ProxySpec | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.replace(/\s+/g, '').trim()
  if (raw.length === 0) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }

  const protocol = url.protocol.replace(/:$/, '').toLowerCase()
  let scheme: ProxySpec['scheme']
  if (protocol === 'http' || protocol === 'https' || protocol === 'socks5' || protocol === 'socks4') {
    scheme = protocol
  } else if (protocol === 'socks5h') {
    scheme = 'socks5'
  } else if (protocol === 'socks4a') {
    scheme = 'socks4'
  } else {
    return undefined
  }

  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (host.length === 0) return undefined

  const port = url.port.length > 0 ? Number(url.port) : scheme === 'socks5' || scheme === 'socks4' ? 1080 : 8080
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined

  const auth =
    url.username.length > 0
      ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
      : undefined

  return auth === undefined ? { scheme, host, port, raw } : { scheme, host, port, auth, raw }
}

/** SOCKS4 is parsed (so it can be reported) but not implemented. */
export function proxySupport(spec: ProxySpec): { readonly supported: boolean; readonly reason?: string } {
  if (spec.scheme === 'socks4') {
    return {
      supported: false,
      reason: '暂不支持 SOCKS4 代理（仅支持 HTTP / HTTPS / SOCKS5）。请改用 socks5://host:port 或 http://host:port；本次不发起请求，也不会绕过代理直连。',
    }
  }
  return { supported: true }
}

// ---------------------------------------------------------------------------
// Request planning (pure — this is what the 备注① tests exercise).
// ---------------------------------------------------------------------------

export interface PlanInput {
  readonly url: string
  readonly token?: string | undefined
  readonly headers?: Record<string, string> | undefined
  /** Caller preference. Omitted = the planner picks (dsh-web first). */
  readonly transport?: TransportId | undefined
  readonly access?: GithubAccessId | undefined
  readonly localProxy?: string | undefined
  readonly hasWebService?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

export interface TransportPlan {
  readonly url: string
  readonly transport: TransportId
  readonly timeoutMs: number
  readonly headers: Record<string, string>
  readonly token?: string
  readonly tokenStripped: boolean
  readonly proxy?: ProxySpec
  readonly proxyConfigured: boolean
  /** True only on the `node` channel — 备注①. */
  readonly proxyApplied: boolean
  /** The sentence explaining any setting that was NOT applied. */
  readonly reason?: string
  readonly notes: readonly string[]
  /** True when local configuration makes the request impossible (no silent bypass). */
  readonly blocked: boolean
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted)
}

/**
 * Decide the channel, the token policy and the proxy application for one request.
 *
 * Order of operations:
 *   1. **Token policy re-check.** `TOKEN_FORBIDDEN_ACCESS` strategies lose the
 *      token HERE, at request-build time, even if a caller already stripped it.
 *      Handing a long-lived credential to a third-party relay is a leak, not a
 *      tradeoff.
 *   2. **Channel choice.** A caller-provided `transport` wins. Otherwise
 *      `dsh-web` is preferred when the harness web service exists and no proxy
 *      is configured; a configured proxy (or a credential) forces `node`,
 *      because that is the only channel either can use.
 *   3. **Proxy application.** `node` -> applied. `dsh-web` -> explicitly NOT
 *      applied, with a 备注① sentence in `reason` + `notes`.
 */
export function planRequest(input: PlanInput): TransportPlan {
  const notes: string[] = []

  // 1. token policy ------------------------------------------------------
  const rawToken = typeof input.token === 'string' && input.token.trim().length > 0 ? input.token.trim() : undefined
  let token = rawToken
  let tokenStripped = false
  const forbidden =
    input.access !== undefined && (TOKEN_FORBIDDEN_ACCESS as readonly string[]).includes(input.access)
  if (token !== undefined && forbidden) {
    token = undefined
    tokenStripped = true
    notes.push(
      `访问方式「${input.access}」在 TOKEN_FORBIDDEN_ACCESS 名单里，已在请求构造阶段强制剥离 token（第三方转发不得接触长期凭据）。`,
    )
  }

  // headers are passed through untouched (a CSDN cookie rides in one) -----
  const headers: Record<string, string> = { ...(input.headers ?? {}) }
  if (token !== undefined && !hasHeader(headers, 'authorization')) {
    headers.authorization = `Bearer ${token}`
  }

  // 2. proxy + channel ---------------------------------------------------
  const configuredProxy = typeof input.localProxy === 'string' ? input.localProxy.trim() : ''
  const proxy = parseProxyAddress(configuredProxy)
  const proxyConfigured = proxy !== undefined
  const support = proxy === undefined ? undefined : proxySupport(proxy)
  const hasWeb = input.hasWebService === true

  let transport: TransportId
  if (input.transport !== undefined) {
    transport = input.transport
  } else if (hasWeb && proxy === undefined) {
    transport = 'dsh-web'
  } else {
    transport = 'node'
    if (hasWeb && proxy !== undefined) {
      notes.push(`检测到本机代理配置，已选择 Node 直连传输以便应用它（${LOCAL_PROXY_SCOPE_NOTE}）。`)
    }
  }

  if (token !== undefined && transport === 'dsh-web') {
    transport = 'node'
    notes.push('本次请求需要携带凭据，而 DSH 自带 web 通道无法附加请求头，已改走 Node 直连传输。')
  }

  if (input.access === 'local-proxy' && transport === 'dsh-web') {
    transport = 'node'
    notes.push(`访问方式选择了「本机代理」，该方式${LOCAL_PROXY_SCOPE_NOTE}，已改走 node 通道。`)
  }

  // 3. proxy application -------------------------------------------------
  let proxyApplied = false
  let reason: string | undefined
  let blocked = false

  if (configuredProxy.length > 0 && proxy === undefined) {
    // A configured-but-unparseable proxy must NOT be ignored: silently going
    // direct would be a privacy surprise, so the request is refused instead.
    reason =
      '本机代理地址无法解析（形如 127.0.0.1:7890、http://host:port 或 socks5://host:port）。本次不发起请求，也不会绕过代理静默直连。'
    blocked = true
  } else if (proxy !== undefined && support !== undefined && !support.supported) {
    reason = support.reason
    blocked = true
  } else if (input.access === 'local-proxy' && proxy === undefined) {
    reason = '访问方式选择了「本机代理 / SOCKS5」，但配置里没有代理地址；按设计「未填 = 该方式不可用」，本次不发起请求（不会静默改走直连）。'
    blocked = true
  } else if (proxy !== undefined) {
    if (transport === 'node') {
      proxyApplied = true
      notes.push(`已应用本机代理（${LOCAL_PROXY_SCOPE_NOTE}）：本次走 Node 直连传输。`)
    } else {
      reason = `已配置本机代理，但本次请求走 DSH 自带 web 通道（${LOCAL_PROXY_SCOPE_NOTE}）：出网由 Harness 负责，本插件无法为其注入代理，因此该代理未被应用。如需它生效，请让本插件改走 Node 直连传输。`
    }
  }

  if (reason !== undefined) notes.push(reason)

  return {
    url: input.url,
    transport,
    timeoutMs: clampTimeoutMs(input.timeoutMs),
    headers,
    ...(token === undefined ? {} : { token }),
    tokenStripped,
    ...(proxy === undefined ? {} : { proxy }),
    proxyConfigured,
    proxyApplied,
    ...(reason === undefined ? {} : { reason }),
    notes,
    blocked,
  }
}

// ---------------------------------------------------------------------------
// Injectable fetch surface.
// ---------------------------------------------------------------------------

export interface FetchInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  readonly redirect?: 'follow' | 'manual' | 'error'
}

export interface FetchLikeResponse {
  readonly status: number
  readonly url?: string
  text(): Promise<string>
}

/** Structural view of global fetch — lets tests inject a fake without a network. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchLikeResponse>

function defaultFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') {
    throw new TransportError('network', '本进程没有可用的 fetch（需要 Node ^22.19.0 || >=24.0.0）。')
  }
  return candidate as FetchLike
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

export interface TransportDeps {
  /** Force a channel. Omitted = the planner decides per request. */
  readonly transport?: TransportId | undefined
  /** Access strategy in force; drives the token policy. */
  readonly access?: GithubAccessId | undefined
  /** 备注① value. Applied on `node` only. */
  readonly localProxy?: string | undefined
  readonly retries?: number | undefined
  readonly timeoutMs?: number | undefined
  /** `ctx.get('web')` — optional dependency, may be absent. */
  readonly web?: WebService | undefined
  /** Test seam. Defaults to global fetch. */
  readonly fetchImpl?: FetchLike | undefined
  readonly logger?: TransportLogger | undefined
}

/**
 * Build the one `Transport` the adapters receive.
 *
 * Retries live in a bounded `for` loop (no recursion, so no depth to exhaust):
 * they apply to thrown `network` / `timeout` failures and to the transient HTTP
 * statuses in `shouldRetryStatus()`, never to `auth-required`. The budget comes
 * from `limits.retries`, clamped by `HARD_LIMITS.retries`.
 *
 * CHANNEL FALLBACK (task requirement: 默认优先 dsh-web，不可用时回退 node): when
 * the harness web service exists but the request dies at the network layer, the
 * transport re-plans onto the `node` channel ONCE. That re-plan matters — it
 * re-runs the 备注① logic, so if a local proxy is configured it is actually
 * applied on the channel that can honour it, instead of being silently ignored.
 * A caller that pinned `deps.transport` explicitly is never second-guessed.
 */
export function createTransport(deps: TransportDeps = {}): Transport {
  const logger = deps.logger ?? createConsoleLogger()
  const retryBudget = clampRetries(deps.retries)

  return async function transport(request: TransportRequest): Promise<TransportResponse> {
    const planInput: PlanInput = {
      url: request.url,
      token: request.token,
      headers: request.headers,
      transport: deps.transport,
      access: deps.access,
      localProxy: deps.localProxy,
      hasWebService: deps.web !== undefined,
      timeoutMs: request.timeoutMs ?? deps.timeoutMs,
    }

    let plan = planRequest(planInput)
    if (plan.blocked) {
      // Local misconfiguration: fail loudly instead of quietly going direct.
      throw new TransportError('network', plan.reason ?? '本机配置阻止了本次请求。')
    }

    /** True once the harness channel has been abandoned for the node channel. */
    let fellBackToNode = false

    // `attempt` counts RETRIES; the loop guard is deliberately one larger so the
    // single channel fallback is never charged against the retry budget. With
    // `retries: 0` (a legal setting) the fallback must still happen — a channel
    // switch is not a retry. Reported by tests-verify.
    let attempt = 0
    let lastFailure: TransportError | undefined
    for (let guard = 0; guard <= retryBudget + 1; guard += 1) {
      try {
        const response = await send(plan, deps, request.signal)
        if (shouldRetryStatus(response.statusCode) && attempt < retryBudget) {
          lastFailure = new TransportError(
            classifyStatus(response.statusCode, plan.token !== undefined) ?? 'network',
            `HTTP ${response.statusCode}，准备重试。`,
            { statusCode: response.statusCode },
          )
          logger('传输遇到可重试状态码', {
            status: response.statusCode,
            attempt: attempt + 1,
            transport: plan.transport,
            host: safeUrlLabel(plan.url),
          })
          await delay(backoffMs(attempt), request.signal)
          attempt += 1
          continue
        }
        return response
      } catch (error) {
        const failure = toTransportError(error, plan)
        lastFailure = failure

        // The harness channel answered nothing at all: fall back to this
        // process's own client, once, and re-plan so 备注① is re-evaluated.
        if (
          plan.transport === 'dsh-web' &&
          !fellBackToNode &&
          deps.transport === undefined &&
          failure.kind === 'network'
        ) {
          fellBackToNode = true
          plan = replanOnNode(planInput, failure)
          logger('DSH web 通道不可用，回退到 Node 直连传输', {
            kind: failure.kind,
            host: safeUrlLabel(plan.url),
          })
          if (plan.blocked) throw new TransportError('network', plan.reason ?? '本机配置阻止了本次请求。')
          continue
        }

        if (!isTransportRetryable(failure.kind) || attempt >= retryBudget) throw failure
        logger('传输失败，重试中', {
          kind: failure.kind,
          attempt: attempt + 1,
          transport: plan.transport,
          host: safeUrlLabel(plan.url),
        })
        await delay(backoffMs(attempt), request.signal)
        attempt += 1
      }
    }
    throw lastFailure ?? new TransportError('network', '传输在重试后仍未成功。')
  }
}

/** Note attached when the harness channel is abandoned for the node channel. */
export const WEB_CHANNEL_FALLBACK_NOTE =
  'DSH 自带 web 通道请求失败（network），已回退到 Node 直连传输重试一次；本机代理若已配置，将在该通道上生效。'

function replanOnNode(planInput: PlanInput, failure: TransportError): TransportPlan {
  const replanned = planRequest({ ...planInput, transport: 'node' })
  const detail = failure.message.trim().length > 0 ? `（通道错误：${failure.message}）` : ''
  const note = `${WEB_CHANNEL_FALLBACK_NOTE}${detail}`
  return {
    ...replanned,
    notes: [...replanned.notes, note],
    reason: replanned.reason ?? note,
  }
}

async function send(
  plan: TransportPlan,
  deps: TransportDeps,
  signal: AbortSignal | undefined,
): Promise<TransportResponse> {
  if (plan.transport === 'dsh-web') {
    const web = deps.web
    if (web === undefined) {
      throw new TransportError('network', '本次计划选用 dsh-web 通道，但当前上下文没有可用的 web 服务。')
    }
    return sendViaWeb(web, plan, signal)
  }
  if (plan.proxyApplied && plan.proxy !== undefined) {
    return sendViaProxy(plan, plan.proxy, signal)
  }
  return sendDirect(plan, deps, signal)
}

/** 备注①: the harness channel. `{ url }` only — no headers, no credentials. */
async function sendViaWeb(
  web: WebService,
  plan: TransportPlan,
  signal: AbortSignal | undefined,
): Promise<TransportResponse> {
  const notes = [...plan.notes]
  const result = await web.fetch({ url: plan.url }, signal)
  const body = typeof result.body?.content === 'string' ? result.body.content : ''
  if (result.truncated === true) {
    notes.push('DSH 自带 web 通道返回的内容被截断（truncated），解析结果可能不完整。')
  }
  return {
    statusCode: typeof result.statusCode === 'number' ? result.statusCode : 0,
    body,
    finalUrl: typeof result.url === 'string' && result.url.length > 0 ? result.url : plan.url,
    ...(plan.reason === undefined ? {} : { note: plan.reason }),
    notes,
  }
}

/** The plain `node` channel: this process's own fetch. */
async function sendDirect(
  plan: TransportPlan,
  deps: TransportDeps,
  signal: AbortSignal | undefined,
): Promise<TransportResponse> {
  const impl = deps.fetchImpl ?? defaultFetch()
  const response = await impl(plan.url, {
    method: 'GET',
    headers: plan.headers,
    redirect: 'follow',
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await response.text()
  return {
    statusCode: response.status,
    body,
    finalUrl: typeof response.url === 'string' && response.url.length > 0 ? response.url : plan.url,
    ...(plan.reason === undefined ? {} : { note: plan.reason }),
    notes: plan.notes,
  }
}

// ---------------------------------------------------------------------------
// The proxied `node` channel.
//
// `fetch` cannot be pointed at a proxy without a dispatcher package, and this
// plugin ships exactly one runtime dependency (schemastery). So the proxied
// path is a small HTTP/1.1 client built on node:http(s) + a hand-rolled tunnel:
//
//   HTTP(S) proxy : CONNECT host:port  (200 -> tunnel, 407 -> auth-required)
//   SOCKS5 proxy  : greeting, optional user/pass, CONNECT with a domain name
//
// node:http does the fiddly parts (chunked transfer decoding, header parsing,
// keep-alive) and node:zlib the content encodings; only the tunnel handshake is
// ours. The direct path never touches any of this code.
// ---------------------------------------------------------------------------

interface TunnelTarget {
  readonly host: string
  readonly port: number
  readonly tls: boolean
}

async function sendViaProxy(
  plan: TransportPlan,
  proxy: ProxySpec,
  signal: AbortSignal | undefined,
): Promise<TransportResponse> {
  let current: URL
  try {
    current = new URL(plan.url)
  } catch {
    throw new TransportError('parse-failed', '无法解析目标地址，已放弃经代理请求。')
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    throw new TransportError('network', `不支持经代理访问 ${current.protocol} 目标。`)
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const answer = await proxyRequestOnce(current, plan, proxy, signal, plan.timeoutMs)
    const location = answer.location
    if (answer.statusCode >= 300 && answer.statusCode < 400 && typeof location === 'string' && location.length > 0) {
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new TransportError('parse-failed', '代理返回了无法解析的跳转地址。')
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new TransportError('network', `代理把请求跳转到了不支持的协议：${next.protocol}`)
      }
      if (hop === MAX_REDIRECTS) {
        throw new TransportError('network', `经代理的请求跳转次数超过上限（${MAX_REDIRECTS}）。`)
      }
      current = next
      continue
    }
    return {
      statusCode: answer.statusCode,
      body: answer.body,
      finalUrl: current.toString(),
      ...(plan.reason === undefined ? {} : { note: plan.reason }),
      notes: plan.notes,
    }
  }

  throw new TransportError('network', '经代理的请求未能完成。')
}

interface ProxyAnswer {
  readonly statusCode: number
  readonly body: string
  readonly location?: string
}

async function proxyRequestOnce(
  url: URL,
  plan: TransportPlan,
  proxy: ProxySpec,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ProxyAnswer> {
  const tls = url.protocol === 'https:'
  const target: TunnelTarget = {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : tls ? 443 : 80,
    tls,
  }

  const options: Record<string, unknown> = {
    method: 'GET',
    host: target.host,
    port: target.port,
    path: `${url.pathname}${url.search}`,
    headers: plan.headers,
    setHost: true,
    // NOTE: no `agent` key, on purpose. Node honours `createConnection` ONLY
    // when no agent is used, and `agent: false` does NOT mean "no agent" — it
    // creates a fresh default Agent, which would quietly connect DIRECTLY and
    // make the proxy a lie. Leaving the key out is load-bearing.
    createConnection: (_options: unknown, oncreate: (error: Error | null, socket?: Duplex) => void): undefined => {
      openTunnel(proxy, target, timeoutMs, signal).then(
        (socket) => oncreate(null, socket),
        (error: unknown) => oncreate(toTransportError(error, plan), undefined),
      )
      return undefined
    },
  }
  if (signal !== undefined) options.signal = signal

  return new Promise<ProxyAnswer>((resolve, reject) => {
    let active: ClientRequest | undefined

    function onResponse(res: IncomingMessage): void {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      res.on('error', (error: Error) => {
        active?.destroy()
        reject(toTransportError(error, plan))
      })
      res.on('end', () => {
        const raw = decodeContentEncoding(Buffer.concat(chunks), res.headers['content-encoding'])
        resolve({
          statusCode: res.statusCode ?? 0,
          body: raw.toString('utf8'),
          ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}),
        })
      })
    }

    try {
      active = tls
        ? httpsRequest(options as unknown as RequestOptions, onResponse)
        : httpRequest(options as unknown as RequestOptions, onResponse)
    } catch (error) {
      reject(toTransportError(error, plan))
      return
    }

    active?.setTimeout(timeoutMs, () => {
      active?.destroy(new TransportError('timeout', `经代理的请求超时（${timeoutMs} ms）。`, { name: 'TimeoutError' }))
    })
    active?.on('error', (error: Error) => {
      reject(toTransportError(error, plan))
    })
    active?.end()
  })
}

function decodeContentEncoding(raw: Buffer, header: string | string[] | undefined): Buffer {
  const value = Array.isArray(header) ? header[0] : header
  const kind = typeof value === 'string' ? value.toLowerCase().trim() : ''
  try {
    if (kind === 'gzip' || kind === 'x-gzip') return gunzipSync(raw)
    if (kind === 'deflate') return inflateSync(raw)
    if (kind === 'br') return brotliDecompressSync(raw)
  } catch {
    // A mislabelled encoding must not lose the whole answer.
    return raw
  }
  return raw
}

function noop(): void {
  // Deliberate: see attachErrorSink().
}

/** A permanent no-op error sink, so a stray socket error can never crash DSH. */
function attachErrorSink(socket: Socket | TLSSocket): void {
  socket.on('error', noop)
}

async function dialProxy(proxy: ProxySpec, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: proxy.port })
  attachErrorSink(socket)

  function onAbort(): void {
    socket.destroy(new TransportError('timeout', '请求已取消。', { name: 'AbortError' }))
  }

  try {
    if (signal !== undefined) {
      if (signal.aborted) throw new TransportError('timeout', '请求已取消。', { name: 'AbortError' })
      signal.addEventListener('abort', onAbort, { once: true })
    }
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new TransportError('timeout', `连接代理超时（${timeoutMs} ms）。`, { name: 'TimeoutError' }))
    })
    await once(socket, 'connect')
  } catch (error) {
    socket.destroy()
    throw toTransportError(error, { reason: `代理地址 ${redactAddress(proxy.raw)}` })
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }

  socket.setTimeout(0)
  return socket
}

function waitReadable(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer)
      socket.off('readable', onReadable)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    function settle(error?: Error): void {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    function onReadable(): void {
      settle()
    }
    function onError(error: Error): void {
      settle(toTransportError(error))
    }
    function onClose(): void {
      settle(new TransportError('network', '代理在握手完成前关闭了连接。'))
    }

    timer = setTimeout(() => {
      settle(new TransportError('timeout', `代理握手超时（${timeoutMs} ms）。`, { name: 'TimeoutError' }))
    }, timeoutMs)
    socket.on('readable', onReadable)
    socket.on('error', onError)
    socket.on('close', onClose)
    // Bytes may already be buffered, in which case 'readable' will not re-fire.
    if (socket.readableLength > 0) settle()
  })
}

async function readExact(socket: Socket, size: number, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < size) {
    const chunk = socket.read() as Buffer | null
    if (chunk === null) {
      await waitReadable(socket, timeoutMs)
      continue
    }
    chunks.push(chunk)
    total += chunk.length
  }
  const joined = Buffer.concat(chunks)
  if (joined.length > size) socket.unshift(joined.subarray(size))
  return joined.subarray(0, size)
}

async function readHead(socket: Socket, delimiter: string, timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const chunk = socket.read() as Buffer | null
    if (chunk === null) {
      await waitReadable(socket, timeoutMs)
      continue
    }
    chunks.push(chunk)
    total += chunk.length
    const joined = Buffer.concat(chunks)
    const index = joined.indexOf(delimiter)
    if (index >= 0) {
      const rest = joined.subarray(index + delimiter.length)
      if (rest.length > 0) socket.unshift(rest)
      return joined.subarray(0, index).toString('latin1')
    }
    if (total > MAX_HANDSHAKE_BYTES) {
      throw new TransportError('parse-failed', '代理握手响应过大，已放弃。')
    }
  }
}

async function httpProxyConnect(
  socket: Socket,
  target: TunnelTarget,
  proxy: ProxySpec,
  timeoutMs: number,
): Promise<void> {
  const authority = `${target.host}:${target.port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive']
  if (proxy.auth !== undefined) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth, 'utf8').toString('base64')}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)

  const head = await readHead(socket, '\r\n\r\n', timeoutMs)
  const statusLine = head.split('\r\n', 1)[0] ?? ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
  if (match === null) {
    throw new TransportError('parse-failed', 'HTTP 代理返回了无法解析的握手响应。')
  }
  const status = Number(match[1])
  if (status === 407) {
    throw new TransportError('auth-required', 'HTTP 代理要求认证（407）；请在代理地址里带上 user:pass。')
  }
  if (status !== 200) {
    throw new TransportError('network', `HTTP 代理拒绝建立隧道（HTTP ${status}）。`)
  }
}

async function socks5Connect(
  socket: Socket,
  target: TunnelTarget,
  proxy: ProxySpec,
  timeoutMs: number,
): Promise<void> {
  const auth = typeof proxy.auth === 'string' && proxy.auth.length > 0 ? proxy.auth : undefined
  socket.write(auth === undefined ? Buffer.from([0x05, 0x01, 0x00]) : Buffer.from([0x05, 0x02, 0x00, 0x02]))

  const method = await readExact(socket, 2, timeoutMs)
  if (method[0] !== 0x05) throw new TransportError('network', 'SOCKS5 代理返回了无法识别的协议版本。')
  if (method[1] === 0xff) throw new TransportError('auth-required', 'SOCKS5 代理拒绝了所有可用的认证方式。')
  if (method[1] === 0x02) {
    if (auth === undefined) {
      throw new TransportError('auth-required', 'SOCKS5 代理要求用户名/密码认证，但代理地址里没有凭据。')
    }
    const separator = auth.indexOf(':')
    const user = separator >= 0 ? auth.slice(0, separator) : auth
    const password = separator >= 0 ? auth.slice(separator + 1) : ''
    const userBuffer = Buffer.from(user, 'utf8')
    const passwordBuffer = Buffer.from(password, 'utf8')
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, userBuffer.length]),
        userBuffer,
        Buffer.from([passwordBuffer.length]),
        passwordBuffer,
      ]),
    )
    const authReply = await readExact(socket, 2, timeoutMs)
    if (authReply[1] !== 0x00) {
      throw new TransportError('auth-required', 'SOCKS5 用户名/密码认证被拒绝。')
    }
  } else if (method[1] !== 0x00) {
    throw new TransportError('auth-required', `SOCKS5 代理要求不支持的认证方式（0x${method[1].toString(16)}）。`)
  }

  const hostBuffer = Buffer.from(target.host, 'utf8')
  const portBuffer = Buffer.alloc(2)
  portBuffer.writeUInt16BE(target.port)
  socket.write(
    Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]), hostBuffer, portBuffer]),
  )

  const reply = await readExact(socket, 4, timeoutMs)
  if (reply[1] !== 0x00) {
    throw new TransportError('network', `SOCKS5 代理拒绝建立隧道（状态码 0x${reply[1].toString(16)}）。`)
  }
  const addressType = reply[3]
  if (addressType === 0x01) await readExact(socket, 6, timeoutMs)
  else if (addressType === 0x04) await readExact(socket, 18, timeoutMs)
  else if (addressType === 0x03) {
    const length = await readExact(socket, 1, timeoutMs)
    await readExact(socket, length[0] + 2, timeoutMs)
  } else {
    throw new TransportError('parse-failed', 'SOCKS5 代理返回了无法识别的地址类型。')
  }
}

function startTls(socket: Socket, servername: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tlsSocket = tlsConnect({ socket, servername })
    attachErrorSink(tlsSocket)

    function settle(error?: Error): void {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error === undefined) resolve(tlsSocket)
      else {
        tlsSocket.destroy()
        reject(error)
      }
    }
    function onError(error: Error): void {
      if (settled) return
      settle(error instanceof TransportError ? error : toTransportError(error))
    }

    tlsSocket.once('secureConnect', () => settle())
    tlsSocket.on('error', onError)
    timer = setTimeout(() => {
      settle(new TransportError('timeout', `经代理的 TLS 握手超时（${timeoutMs} ms）。`, { name: 'TimeoutError' }))
    }, timeoutMs)
  })
}

async function openTunnel(
  proxy: ProxySpec,
  target: TunnelTarget,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Duplex> {
  const socket = await dialProxy(proxy, timeoutMs, signal)
  try {
    if (proxy.scheme === 'socks5') await socks5Connect(socket, target, proxy, timeoutMs)
    else await httpProxyConnect(socket, target, proxy, timeoutMs)
    if (!target.tls) return socket
    return await startTls(socket, target.host, timeoutMs)
  } catch (error) {
    socket.destroy()
    throw toTransportError(error)
  }
}
