/**
 * dsh-codehub — browser-login (OAuth) flow engine.
 *
 * INTERFACE FROZEN IN PHASE 0 (docs/DESIGN.md §7). Implementations of the
 * stubs below must keep these signatures: `src/routes.ts` and `src/index.ts`
 * wire them, and `test/oauth-flow.test.ts` crosses this same seam with a fake
 * `PostLike`.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * "Click a button, log in in the browser, and end up with a token in the
 * credential service" is three different flows behind one idea:
 *
 *   • GitHub — RFC 8628 device flow: POST /login/device/code, show the user
 *     code, poll POST /login/oauth/access_token. No client secret, but the
 *     user's OAuth App must have Device Flow enabled.
 *   • Gitee — authorization code: redirect the browser to /oauth/authorize,
 *     receive `?code=` on the LOOPBACK callback, exchange it at /oauth/token
 *     with client_id + client_secret. Gitee supports neither device flow nor
 *     PKCE, so a secret is unavoidable — it lives in `ctx.credentials` only.
 *
 * INVARIANTS (asserted by tests, not just documented)
 * ---------------------------------------------------
 * 1. **A credential value never leaves this module.** The only place a token is
 *    handed to is `writeCredential()`; no result object, `reason` string or log
 *    line may contain it. Responses to the browser carry booleans and status
 *    codes only.
 * 2. **No second request after a failed preflight.** If the provider host is
 *    unreachable, `start()` answers `unavailable` and issues nothing else.
 * 3. **Only official hosts.** The injected `post` seam is called with
 *    github.com / gitee.com URLs exclusively; mirrors and third-party forwards
 *    are never used for a credential exchange.
 * 4. **Flow state is memory-only.** No file, no store, no settings namespace:
 *    a flow is a process-local, time-boxed, single-use record. The Gitee client
 *    secret is the one sensitive value that record holds (the callback exchange
 *    happens later, after the browser returns), so it lives exactly as long as
 *    the flow does and dies with it.
 * 5. **`state` is checked.** A callback whose `state` does not match the live
 *    flow is refused (`400`) and writes nothing.
 */

import { randomBytes } from 'node:crypto'

import {
  GITEE_OAUTH_AUTHORIZE_ENDPOINT,
  GITEE_OAUTH_TOKEN_ENDPOINT,
  GITHUB_DEVICE_CODE_ENDPOINT,
  GITHUB_DEVICE_TOKEN_ENDPOINT,
  GITHUB_DEVICE_VERIFICATION_URI,
  OAUTH_CALLBACK_PATH,
  OAUTH_FLOW_TTL_MS,
  OAUTH_SLOW_DOWN_STEP_MS,
} from './contract.js'
import type { LoginMethodId } from './contract.js'

/** The two sources that have a real OAuth flow. CSDN has none, by design. */
export type OAuthSource = 'github' | 'gitee'

/** Methods this engine implements. `pat` / cookie methods never reach it. */
export type OAuthMethod = Extract<LoginMethodId, 'oauth-device' | 'oauth-code'>

/**
 * The POST seam, implemented by `net.ts` (`createPostTransport`).
 *
 * It exists because the plugin's ordinary transport is GET-only and the DSH web
 * channel takes a bare `{ url }` — neither can carry a form body or a client
 * secret. This seam is the single exception, and it is deliberately narrow:
 * official hosts only, no mirror routing.
 */
export interface PostRequest {
  readonly url: string
  readonly form: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  /** Local proxy address (备注①), applied only on the node channel. */
  readonly proxy?: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface PostResponse {
  readonly statusCode: number
  readonly body: string
}

export type PostLike = (request: PostRequest) => Promise<PostResponse>

/** Everything `start()` may read; no field carries an obtained secret. */
export interface OAuthStartInput {
  readonly source: OAuthSource
  readonly method: OAuthMethod
  /** The user's own OAuth App id (config, never a secret). */
  readonly clientId: string
  /**
   * Gitee only: the secret is resolved by the caller from `ctx.credentials` and
   * handed in for the exchange. It is kept IN MEMORY on the flow record for that
   * flow's lifetime (15 min at most) because the callback exchange happens later,
   * once the browser returns; it is never written to disk, never logged, never
   * echoed, and dropped with the record.
   */
  readonly clientSecret?: string
  /** Gitee only: must equal the callback URL registered on the app. */
  readonly redirectUri?: string
  /** Host header of the initiating request, used to derive the default redirect. */
  readonly requestHost?: string
  readonly signal?: AbortSignal
}

/** What the browser half needs to render a device-flow prompt. */
export interface OAuthStartDevice {
  readonly ok: true
  readonly kind: 'device'
  readonly flowId: string
  /** The 8-character code the user types at `verificationUri`. */
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresInMs: number
  /** Current poll interval; the UI may show it, the host owns the timing. */
  readonly intervalMs: number
}

/** What the browser half needs to open an authorization page. */
export interface OAuthStartRedirect {
  readonly ok: true
  readonly kind: 'redirect'
  readonly flowId: string
  readonly authorizeUrl: string
  readonly redirectUri: string
  readonly expiresInMs: number
}

export interface OAuthStartUnavailable {
  readonly ok: false
  readonly reason: string
  /** Where the user can still get a credential: a guide method or a URL. */
  readonly fallback: readonly string[]
}

export type OAuthStart = OAuthStartDevice | OAuthStartRedirect | OAuthStartUnavailable

export type OAuthFlowState = 'pending' | 'slow_down' | 'done' | 'expired' | 'error'

export interface OAuthStatus {
  readonly flowId: string
  readonly state: OAuthFlowState
  /** True once the credential is confirmed present in the credential service. */
  readonly credentialConfigured: boolean
  /** Human-readable, value-free explanation of the current state. */
  readonly reason: string
  readonly intervalMs: number
}

export interface OAuthComplete {
  readonly ok: boolean
  readonly credentialConfigured: boolean
  readonly reason: string
}

export interface OAuthCallbackOutcome {
  readonly status: number
  /** A tiny self-closing page; never carries a credential. */
  readonly html: string
}

/** Injected dependencies — the test seam is exactly this object. */
export interface OAuthDeps {
  readonly post: PostLike
  /** Writes the obtained value into the credential service, by ref name. */
  readonly writeCredential: (ref: string, value: string) => Promise<void>
  /** Reads the Gitee client secret (never logged, never returned to the caller). */
  readonly readCredential?: (ref: string) => Promise<string | undefined>
  /** Ref the obtained credential is stored under (from `service.CREDENTIAL_REFS`). */
  readonly credentialRefFor: (source: OAuthSource) => string
  /** Reachability preflight for one host; injected so tests need no network. */
  readonly probeHost: (host: string, signal?: AbortSignal) => Promise<{ reachable: boolean; detail: string }>
  readonly now?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly logger?: (event: string, detail?: Record<string, unknown>) => void
}

export interface OAuthService {
  start(input: OAuthStartInput): Promise<OAuthStart>
  status(flowId: string): Promise<OAuthStatus>
  /** Manual fallback for the authorization-code flow (paste `code` back). */
  completeWithCode(input: {
    readonly code: string
    readonly clientId: string
    readonly clientSecret?: string
    readonly redirectUri: string
    readonly signal?: AbortSignal
  }): Promise<OAuthComplete>
  cancel(flowId: string): void
  /** The loopback callback handler; validates `state` before doing anything. */
  handleCallback(params: { code?: string; state?: string; error?: string }): Promise<OAuthCallbackOutcome>
}

// ---------------------------------------------------------------------------
// Minimal self-closing pages. Both are static strings: no value interpolated
// here can ever be a credential (invariant 1), so the browser half can render
// them directly.
// ---------------------------------------------------------------------------

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>登录成功</title>' +
  '<p>登录成功，可关闭本窗口。</p><script>window.close()</script>'

const FAILURE_HTML =
  '<!doctype html><meta charset="utf-8"><title>登录失败</title>' +
  '<p>登录失败，请回到插件重试。</p><script>window.close()</script>'

/** Refusal used when a callback names a source whose flow is not redirect-based. */
const ERROR_FLOW_ABSENT = '没有进行中的授权流程，或该流程已过期；请回到插件重新发起登录。'
const ERROR_STATE_MISMATCH = '授权回调的 state 与当前流程不符，已拒绝本次请求。'
const ERROR_PROVIDER = '授权服务返回了错误，已中止本次流程。'
const ERROR_CANCELLED = '流程已被取消。'
const ERROR_TIMEOUT = '流程等待超时（15 分钟），请重新发起登录。'
/** A token that arrived but could not be stored — not a network failure. */
const ERROR_CREDENTIAL_WRITE = '已取到 token，但写入 DSH 凭据服务失败；请确认 credentials 服务可用后重试。'
const PROVIDER_TIMEOUT_MS = 15_000
/** Poll floor: never hammer the provider faster than this, whatever it says. */
const MIN_INTERVAL_MS = 1_000
const DEFAULT_INTERVAL_MS = 5_000

/** Value-free network failure text; the thrown error message is provider-free. */
const NETWORK_REASON = '与授权服务的请求失败（网络不可达或超时），请稍后重试或改用 PAT。'

interface FlowRecord {
  readonly flowId: string
  readonly source: OAuthSource
  readonly method: OAuthMethod
  readonly clientId: string
  /** Gitee only. Held in memory for the single exchange, never logged. */
  clientSecret?: string
  readonly deviceCode?: string
  readonly state?: string
  readonly redirectUri?: string
  readonly createdAt: number
  /** Wall-clock deadline of the whole flow (`OAUTH_FLOW_TTL_MS`). */
  readonly deadline: number
  /** Effective poll interval; `slow_down` widens it by `OAUTH_SLOW_DOWN_STEP_MS`. */
  intervalMs: number
  userCode?: string
  verificationUri?: string
  stateValue: OAuthFlowState
  reason: string
  credentialConfigured: boolean
  /** True for a flow that is finished, failed, cancelled or expired. */
  ended: boolean
  readonly controller: AbortController
}

/** Parse a token response that may be JSON or form-encoded (GitHub does both). */
function parseTokenBody(body: string): Record<string, string> {
  const text = body.trim()
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') {
        const out: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') out[key] = value
          else if (typeof value === 'number') out[key] = String(value)
        }
        return out
      }
    } catch {
      // Fall through to the form-encoded reader: some proxies corrupt JSON.
    }
  }
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

/**
 * The default README asks the user to register the loopback callback, so the
 * plugin must build the same absolute URL from the initiating request's Host
 * header when the caller did not pin one.
 */
export function defaultRedirectUri(requestHost: string | undefined): string {
  const host = (requestHost ?? '').trim().replace(/\/+$/, '')
  if (host === '') return OAUTH_CALLBACK_PATH
  const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`
  return `${withScheme}${OAUTH_CALLBACK_PATH}`
}

/**
 * Phase 0 stub replaced by W1: the real device-flow / authorization-code state
 * machines. Signatures and invariants above are what is fixed.
 */
export function createOAuthService(deps: OAuthDeps): OAuthService {
  const now = deps.now ?? ((): number => Date.now())
  const sleep = deps.sleep ?? defaultSleep
  const logger = deps.logger ?? ((): void => {})
  const flows = new Map<string, FlowRecord>()

  const newFlowId = (): string => `flow_${randomBytes(9).toString('hex')}`
  const newState = (): string => randomBytes(16).toString('hex')

  /** Drop finished flows long after their TTL: the map must not grow forever. */
  const reclaim = (): void => {
    const at = now()
    for (const [key, flow] of flows) {
      if (flow.ended && at - flow.createdAt > OAUTH_FLOW_TTL_MS) flows.delete(key)
    }
  }

  const finish = (flow: FlowRecord, state: OAuthFlowState, reason: string): void => {
    flow.stateValue = state
    flow.reason = reason
    flow.ended = true
  }

  /**
   * A redirect flow has no background poller to notice the deadline, so the
   * TTL is enforced lazily wherever the flow is observed.
   */
  const expireIfDue = (flow: FlowRecord): void => {
    if (flow.ended || now() <= flow.deadline) return
    finish(flow, 'expired', ERROR_TIMEOUT)
    logger('oauth.flow.expired', { flowId: flow.flowId, source: flow.source })
  }

  const statusOf = (flow: FlowRecord): OAuthStatus => ({
    flowId: flow.flowId,
    state: flow.stateValue,
    credentialConfigured: flow.credentialConfigured,
    reason: flow.reason,
    intervalMs: flow.intervalMs,
  })

  const activate = (flow: FlowRecord, outer?: AbortSignal): void => {
    const abort = (): void => flow.controller.abort()
    if (outer === undefined) return
    if (outer.aborted) abort()
    else outer.addEventListener('abort', abort, { once: true })
  }

  /** One POST on the official-host seam; every failure is value-free. */
  const postForm = async (
    url: string,
    form: Record<string, string>,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<PostResponse> => {
    return await deps.post({ url, form, headers, timeoutMs: PROVIDER_TIMEOUT_MS, signal })
  }

  /**
   * Exchange an authorization code. The returned token is written to the
   * credential service here and is never returned, logged or embedded in a
   * reason string (invariant 1).
   */
  const exchangeAuthorizationCode = async (
    input: {
      readonly code: string
      readonly clientId: string
      readonly clientSecret?: string
      readonly redirectUri: string
      readonly signal?: AbortSignal
    },
    source: OAuthSource,
    ref: string,
  ): Promise<OAuthComplete> => {
    const signal = input.signal
    // `throwIfAborted` is the only abort probe that reads as "abort wins here"
    // without the compiler narrowing `signal` for the rest of the function.
    try {
      signal?.throwIfAborted()
    } catch {
      return { ok: false, credentialConfigured: false, reason: ERROR_CANCELLED }
    }
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
    }
    if (input.clientSecret !== undefined && input.clientSecret !== '') form.client_secret = input.clientSecret
    let response: PostResponse
    try {
      response = await postForm(
        GITEE_OAUTH_TOKEN_ENDPOINT,
        form,
        { accept: 'application/json' },
        signal ?? new AbortController().signal,
      )
    } catch {
      logger('oauth.exchange.failed', { source, host: 'gitee.com' })
      return { ok: false, credentialConfigured: false, reason: NETWORK_REASON }
    }
    const payload = parseTokenBody(response.body)
    if (response.statusCode !== 200 || payload.access_token === undefined || payload.access_token === '') {
      logger('oauth.exchange.rejected', { source, host: 'gitee.com', statusCode: response.statusCode })
      return {
        ok: false,
        credentialConfigured: false,
        reason: `授权码换取凭据失败（HTTP ${response.statusCode}）：请检查 client_id / client_secret 与回调地址是否与 Gitee 应用一致。`,
      }
    }
    const token = payload.access_token
    // Fail closed if abort arrived while the exchange was in flight: the token
    // is dropped, never persisted.
    try {
      signal?.throwIfAborted()
    } catch {
      return { ok: false, credentialConfigured: false, reason: ERROR_CANCELLED }
    }
    await deps.writeCredential(ref, token)
    logger('oauth.exchange.done', { source, host: 'gitee.com', statusCode: 200 })
    return { ok: true, credentialConfigured: true, reason: '凭据已写入 DSH 凭据服务。' }
  }

  const startGithubDevice = async (input: OAuthStartInput, flow: FlowRecord, ref: string): Promise<OAuthStart> => {
    const probe = await deps.probeHost('github.com', flow.controller.signal)
    if (!probe.reachable) {
      logger('oauth.preflight.failed', { source: 'github', host: 'github.com' })
      return {
        ok: false,
        reason: `无法连接 github.com：${probe.detail}。设备码流程需要本机直连 github.com，请改用个人访问令牌（PAT）。`,
        fallback: ['pat'],
      }
    }

    let codeResponse: PostResponse
    try {
      codeResponse = await postForm(
        GITHUB_DEVICE_CODE_ENDPOINT,
        { client_id: input.clientId, scope: '' },
        { accept: 'application/json' },
        flow.controller.signal,
      )
    } catch {
      logger('oauth.device_code.failed', { source: 'github', host: 'github.com' })
      return { ok: false, reason: NETWORK_REASON, fallback: ['pat'] }
    }
    const payload = parseTokenBody(codeResponse.body)
    const deviceCode = payload.device_code
    const userCode = payload.user_code
    if (codeResponse.statusCode !== 200 || deviceCode === undefined || userCode === undefined) {
      logger('oauth.device_code.rejected', { source: 'github', host: 'github.com', statusCode: codeResponse.statusCode })
      const hint =
        payload.error === 'device_flow_disabled'
          ? '你的 OAuth App 没有开启设备码流程：请在该 App 的编辑页勾选 Enable Device Flow 后重试。'
          : `设备码申请失败（HTTP ${codeResponse.statusCode}）：请确认 Client ID 来自你自己的 OAuth App。`
      return { ok: false, reason: hint, fallback: ['pat'] }
    }

    // `expires_in` arrives in seconds (RFC 8628) and the wire contract here is
    // milliseconds, so the conversion happens once, at the boundary.
    const expiresInSeconds = clampFinite(Number(payload.expires_in), OAUTH_FLOW_TTL_MS / 1000, 0, OAUTH_FLOW_TTL_MS / 1000)
    const expiresInMs = expiresInSeconds * 1000
    const intervalMs = Math.max(MIN_INTERVAL_MS, clampFinite(Number(payload.interval), DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, 60_000))
    flow.intervalMs = intervalMs
    flow.userCode = userCode
    flow.verificationUri = payload.verification_uri ?? GITHUB_DEVICE_VERIFICATION_URI
    flow.reason = '等待你在浏览器中完成授权。'

    // Poll in the background: `start()` has already handed the user code to the
    // browser half, and the flow must survive that returning.
    void pollDeviceToken(flow, deviceCode, ref)

    return {
      ok: true,
      kind: 'device',
      flowId: flow.flowId,
      userCode,
      verificationUri: flow.verificationUri,
      expiresInMs,
      intervalMs,
    }
  }

  /** The RFC 8628 polling loop. Never emits the device code or the token. */
  const pollDeviceToken = async (flow: FlowRecord, deviceCode: string, ref: string): Promise<void> => {
    const signal = flow.controller.signal
    try {
      while (!flow.ended && !signal.aborted) {
        if (now() > flow.deadline) {
          finish(flow, 'expired', ERROR_TIMEOUT)
          logger('oauth.device.expired', { source: 'github', host: 'github.com' })
          return
        }
        if (now() + flow.intervalMs > flow.deadline) {
          finish(flow, 'expired', ERROR_TIMEOUT)
          logger('oauth.device.expired', { source: 'github', host: 'github.com' })
          return
        }
        try {
          await sleep(flow.intervalMs, signal)
        } catch {
          // Aborted while waiting: `cancel()` owns the terminal state.
          return
        }
        if (signal.aborted || flow.ended) return

        let response: PostResponse
        try {
          response = await postForm(
            GITHUB_DEVICE_TOKEN_ENDPOINT,
            {
              client_id: flow.clientId,
              device_code: deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            },
            { accept: 'application/json' },
            signal,
          )
        } catch {
          if (signal.aborted) return
          // A transport failure is not a provider verdict: keep polling within
          // the TTL so a transient blip does not kill an in-flight login.
          finish(flow, 'error', NETWORK_REASON)
          logger('oauth.device.network_failed', { source: 'github', host: 'github.com' })
          return
        }
        const payload = parseTokenBody(response.body)

        if (response.statusCode === 200 && payload.access_token !== undefined && payload.access_token !== '') {
          const token = payload.access_token
          // The one and only sink for a credential value. Aborting before the
          // write and after it differ deliberately: abort must win, so the
          // token is dropped rather than persisted after a cancel.
          if (signal.aborted) return
          try {
            await deps.writeCredential(ref, token)
          } catch {
            // A refused credential write is NOT a network problem. Reporting it
            // as one would send the user to check their connection for what is
            // really a credential-service failure. The reason stays value-free.
            finish(flow, 'error', ERROR_CREDENTIAL_WRITE)
            logger('oauth.device.credential_write_failed', { source: 'github' })
            return
          }
          flow.credentialConfigured = true
          finish(flow, 'done', '凭据已写入 DSH 凭据服务。')
          logger('oauth.device.done', { source: 'github', host: 'github.com', statusCode: 200 })
          return
        }

        switch (payload.error ?? '') {
          case 'authorization_pending':
            flow.reason = '等待你在浏览器中完成授权。'
            continue
          case 'slow_down': {
            flow.intervalMs += OAUTH_SLOW_DOWN_STEP_MS
            flow.stateValue = 'slow_down'
            flow.reason = '授权服务要求放慢轮询，已自动延长间隔。'
            logger('oauth.device.slow_down', { source: 'github', host: 'github.com', intervalMs: flow.intervalMs })
            continue
          }
          case 'expired_token':
            finish(flow, 'expired', '设备码已过期，请重新发起登录。')
            logger('oauth.device.expired', { source: 'github', host: 'github.com' })
            return
          case 'access_denied':
            finish(flow, 'error', '你在浏览器中拒绝了本次授权。若这是误操作，请重新发起登录。')
            logger('oauth.device.denied', { source: 'github', host: 'github.com' })
            return
          case 'device_flow_disabled':
            finish(
              flow,
              'error',
              '你的 OAuth App 没有开启设备码流程：请在该 App 的编辑页勾选 Enable Device Flow 并保存后重试。',
            )
            logger('oauth.device.flow_disabled', { source: 'github', host: 'github.com' })
            return
          case 'incorrect_client_credentials':
            finish(flow, 'error', 'Client ID 不正确：请核对插件里填写的 GitHub OAuth App Client ID。')
            logger('oauth.device.bad_client', { source: 'github', host: 'github.com' })
            return
          case 'unsupported_grant_type':
            finish(flow, 'error', 'GitHub 不接受该授权类型，请确认该 App 已启用设备码流程。')
            logger('oauth.device.bad_grant', { source: 'github', host: 'github.com' })
            return
          case 'incorrect_device_code':
            finish(flow, 'error', '设备码不正确或已被使用，请重新发起登录。')
            logger('oauth.device.bad_code', { source: 'github', host: 'github.com' })
            return
          default:
            finish(
              flow,
              'error',
              `授权失败（HTTP ${response.statusCode}）：请回到插件重新发起登录，或改用个人访问令牌（PAT）。`,
            )
            logger('oauth.device.unknown_error', {
              source: 'github',
              host: 'github.com',
              statusCode: response.statusCode,
            })
            return
        }
      }
    } catch {
      // Defensive: the loop must never reject into the void.
      if (!flow.ended) finish(flow, 'error', NETWORK_REASON)
    }
  }

  const startGiteeCode = async (input: OAuthStartInput, flow: FlowRecord): Promise<OAuthStart> => {
    const probe = await deps.probeHost('gitee.com', flow.controller.signal)
    if (!probe.reachable) {
      logger('oauth.preflight.failed', { source: 'gitee', host: 'gitee.com' })
      return {
        ok: false,
        reason: `无法连接 gitee.com：${probe.detail}。授权码流程需要本机直连 gitee.com，请改用个人访问令牌（PAT）。`,
        fallback: ['pat'],
      }
    }
    const redirectUri = input.redirectUri ?? defaultRedirectUri(input.requestHost)
    const authorizeUrl = new URL(GITEE_OAUTH_AUTHORIZE_ENDPOINT)
    authorizeUrl.searchParams.set('client_id', input.clientId)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('state', flow.state ?? '')
    flow.reason = '等待你在浏览器中完成授权。'
    return {
      ok: true,
      kind: 'redirect',
      flowId: flow.flowId,
      authorizeUrl: authorizeUrl.toString(),
      redirectUri,
      expiresInMs: OAUTH_FLOW_TTL_MS,
    }
  }

  const refFor = (source: OAuthSource): string => deps.credentialRefFor(source)

  return {
    async start(input: OAuthStartInput): Promise<OAuthStart> {
      reclaim()
      // The source decides which provider endpoint a credential is exchanged
      // with, so a mismatched pair is refused rather than silently mapped.
      if (input.method === 'oauth-device' && input.source !== 'github') {
        return { ok: false, reason: '只有 GitHub 支持设备码流程。', fallback: ['pat'] }
      }
      if (input.method === 'oauth-code' && input.source !== 'gitee') {
        return { ok: false, reason: '只有 Gitee 支持授权码流程。', fallback: ['pat'] }
      }
      const flow: FlowRecord = {
        flowId: newFlowId(),
        source: input.source,
        method: input.method,
        clientId: input.clientId,
        createdAt: now(),
        deadline: now() + OAUTH_FLOW_TTL_MS,
        intervalMs: DEFAULT_INTERVAL_MS,
        stateValue: 'pending',
        reason: '流程已创建，等待你在浏览器中完成授权。',
        credentialConfigured: false,
        ended: false,
        controller: new AbortController(),
      }
      if (input.clientSecret !== undefined) flow.clientSecret = input.clientSecret
      activate(flow, input.signal)
      flows.set(flow.flowId, flow)
      logger('oauth.start', { source: input.source, method: input.method, flowId: flow.flowId })

      if (input.method === 'oauth-device') {
        return await startGithubDevice(input, flow, refFor('github'))
      }
      const redirectUri = input.redirectUri ?? defaultRedirectUri(input.requestHost)
      const state = newState()
      const withState: FlowRecord = { ...flow, state, redirectUri }
      // Replace the provisional record so `handleCallback` finds the state.
      flows.set(flow.flowId, withState)
      return await startGiteeCode(input, withState)
    },

    /**
     * `state` decides which flow a callback belongs to, so the lookup is by
     * state and never by "the newest flow".
     */
    async handleCallback(params): Promise<OAuthCallbackOutcome> {
      reclaim()
      const state = params.state ?? ''
      const flow = state === '' ? undefined : [...flows.values()].find((candidate) => candidate.state === state)
      if (flow === undefined) {
        logger('oauth.callback.rejected', { reason: 'state-mismatch' })
        return { status: 400, html: FAILURE_HTML }
      }
      if (params.error !== undefined && params.error !== '') {
        finish(flow, 'error', ERROR_PROVIDER)
        logger('oauth.callback.provider_error', { source: flow.source })
        return { status: 400, html: FAILURE_HTML }
      }
      if (flow.ended) {
        // Single use: the state is consumed the moment it names a live flow, so
        // a replayed callback can never start a second exchange.
        logger('oauth.callback.rejected', { reason: 'replayed' })
        return { status: 400, html: FAILURE_HTML }
      }
      expireIfDue(flow)
      if (flow.ended) {
        logger('oauth.callback.rejected', { reason: 'expired' })
        return { status: 400, html: FAILURE_HTML }
      }
      if (params.code === undefined || params.code === '') {
        logger('oauth.callback.missing_code', { source: flow.source })
        return { status: 400, html: FAILURE_HTML }
      }
      // Consume the state only once a code is actually in hand.
      flow.ended = true
      const secret = flow.clientSecret ?? (await deps.readCredential?.(refFor('gitee'))) ?? ''
      const outcome = await exchangeAuthorizationCode(
        {
          code: params.code,
          clientId: flow.clientId,
          clientSecret: secret,
          redirectUri: flow.redirectUri ?? defaultRedirectUri(undefined),
        },
        'gitee',
        refFor('gitee'),
      )
      flow.credentialConfigured = outcome.credentialConfigured
      finish(flow, outcome.ok ? 'done' : 'error', outcome.reason)
      return outcome.ok ? { status: 200, html: SUCCESS_HTML } : { status: 400, html: FAILURE_HTML }
    },

    async completeWithCode(input): Promise<OAuthComplete> {
      return await exchangeAuthorizationCode(input, 'gitee', refFor('gitee'))
    },

    async status(flowId: string): Promise<OAuthStatus> {
      reclaim()
      const flow = flows.get(flowId)
      if (flow === undefined) {
        return {
          flowId,
          state: 'error',
          credentialConfigured: false,
          reason: '没有这个流程：它可能已过期，或插件重启过。请重新发起登录。',
          intervalMs: 0,
        }
      }
      expireIfDue(flow)
      return statusOf(flow)
    },

    cancel(flowId: string): void {
      const flow = flows.get(flowId)
      if (flow === undefined) return
      // Mark first, then abort: the polling loop checks both, and the terminal
      // state must not be overwritten by whatever response was in flight.
      finish(flow, 'error', ERROR_CANCELLED)
      flow.controller.abort()
      logger('oauth.cancel', { flowId })
    },
  }
}

function clampFinite(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Real sleep; aborts promptly so `cancel()` never waits out a full interval. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
