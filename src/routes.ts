/**
 * dsh-codehub — the plugin's own loopback route family (`/api/dsh-codehub/*`).
 *
 * WHY THESE ROUTES ARE THE PRIMARY CONFIG PATH
 * -------------------------------------------
 * DSH's settings RPC only serves a whitelist of namespaces, so `settingsScope`
 * on the browser side can honestly report `status: 'unavailable'` for this
 * plugin. The panel and the settings card therefore read and write through these
 * routes (docs/DESIGN.md §5); `settingsScope` stays an optional enhancement.
 *
 * THE FENCE IS NOT OPTIONAL
 * -------------------------
 * The harness's own `/api` fence does NOT cover routes a plugin registers
 * itself. So every handler below starts with `isLoopbackRequest()` and answers
 * `403 {error:'forbidden: loopback-only'}` for anything else — this route family
 * can read configuration, write decisions and write CREDENTIALS, so a non-local
 * caller must never reach the body of a handler.
 *
 * The credentials route is the sharpest edge here: the value is read out of the
 * request body exactly once and handed to `ctx.credentials`. It is never logged,
 * never echoed back, never put in a response, and never written to the store.
 * The response only ever carries booleans.
 *
 * One `(kind, path)` may hold exactly ONE handler on this runtime, so each path
 * dispatches on `req.method` itself and answers `405` (with `Allow`) otherwise.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialsService } from '@deepseek-ai/dsh-credentials'
import type { WebRoute, WebServerService } from '@deepseek-ai/dsh-host-webserver'

import {
  API_PREFIX,
  CDP_COOKIE_HOSTS,
  DECISION_KEYS,
  DEEP_READ_TARGETS,
  GITEE_OAUTH_SECRET_REF,
  OAUTH_CALLBACK_PATH,
  SOURCES,
  SOURCE_LABELS,
  SOURCE_LOGIN_METHODS,
  decisionPrompt,
} from './contract.js'
import type { DecisionKey, DeepReadTarget, SourceId } from './contract.js'
import { CREDENTIAL_TARGETS, mergeConfigInput, splitConfigPatch } from './config.js'
import type { CredentialTarget } from './config.js'
import { captureBrowserCookies } from './cdp.js'
import type { CdpCaptureInput, CdpCaptureResult } from './cdp.js'
import type { BrowserLauncher } from './launcher.js'
import { detectEnvironment } from './detect.js'
import { createConsoleLogger, scrubSecrets } from './net.js'
import type { TransportLogger } from './net.js'
import type { OAuthMethod, OAuthService, OAuthSource } from './oauth.js'
import { CREDENTIAL_REFS, type CodeSource } from './service.js'
import { SETTINGS_FALLBACK_NOTE, type SettingsBridge } from './settings.js'
import type { LocalConfig, LocalConfigStore } from './store.js'

/** Request bodies are tiny (a patch or one credential); anything larger is refused. */
export const MAX_BODY_BYTES = 64 * 1024

/** The ten paths this plugin owns, all under `contract.API_PREFIX`. */
export const ROUTE_PATHS = {
  config: `${API_PREFIX}/config`,
  decisions: `${API_PREFIX}/decisions`,
  detect: `${API_PREFIX}/detect`,
  credentials: `${API_PREFIX}/credentials`,
  deepread: `${API_PREFIX}/deepread`,
  smoke: `${API_PREFIX}/smoke`,
  oauth: `${API_PREFIX}/oauth`,
  /**
   * The OAuth callback is the SAME path the provider is told to redirect to, so
   * it is read from the contract instead of being re-spelled here — a mismatch
   * between the registered Gitee callback and the route would be invisible.
   */
  oauthCallback: OAUTH_CALLBACK_PATH,
  probe: `${API_PREFIX}/probe`,
  cookies: `${API_PREFIX}/cookies`,
  /** Starts a debuggable Chromium when the CDP port is not listening yet. */
  launchBrowser: `${API_PREFIX}/launch-browser`,
} as const

export type RoutePathKey = keyof typeof ROUTE_PATHS

// ---------------------------------------------------------------------------
// Small HTTP helpers (exported: the fence and the JSON writer are unit-tested).
// ---------------------------------------------------------------------------

/**
 * True only for a request that arrived over a loopback socket.
 *
 * `true` is not returned for an empty/unknown `remoteAddress`: failing closed is
 * the whole point of the fence.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : ''
  if (address.length === 0) return false
  if (address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('127.')) return true
  if (address.startsWith('::ffff:127.')) return true
  return false
}

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  let body: string
  try {
    body = JSON.stringify(payload ?? null)
  } catch {
    body = JSON.stringify({ ok: false, error: '响应无法序列化。' })
  }
  res.statusCode = status
  try {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  } catch {
    // Headers already sent, or a minimal test double without setHeader.
  }
  res.end(body)
}

function setAllowHeader(res: ServerResponse, methods: readonly string[]): void {
  try {
    res.setHeader('allow', methods.join(', '))
  } catch {
    // Same as above: never fatal.
  }
}

export interface BodyResult {
  readonly ok: boolean
  readonly status: number
  readonly value?: unknown
  readonly error?: string
}

/**
 * Read and parse a JSON body with a hard size cap.
 *
 * The raw text is never logged: a credential arrives this way.
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
      total += buffer.length
      if (total > MAX_BODY_BYTES) {
        return { ok: false, status: 413, error: `请求体过大（上限 ${MAX_BODY_BYTES} 字节）。` }
      }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, status: 400, error: '读取请求体失败。' }
  }
  if (total === 0) return { ok: true, status: 200, value: {} }
  try {
    return { ok: true, status: 200, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { ok: false, status: 400, error: '请求体不是合法 JSON。' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Answer a browser with a page instead of JSON.
 *
 * Only the OAuth callback uses this, and the HTML is produced by the flow
 * engine: it is a self-closing page that carries no credential (docs/DESIGN.md
 * §7.3) — the code/state pair never travels back to the browser.
 */
function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  } catch {
    // Same minimal-double tolerance as writeJson.
  }
  res.end(html)
}

function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return scrubSecrets(text)
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export interface RouteDeps {
  /** `ctx.get('webServer')` — required, checked by the caller. */
  readonly webServer: WebServerService
  /** `ctx.get('credentials')` is looked up lazily; never accessed as a property. */
  readonly ctx: Context
  readonly service: CodeSource
  readonly store: LocalConfigStore
  readonly settings: SettingsBridge
  readonly logger?: TransportLogger | undefined
  /**
   * The browser-login engine. Optional so a host without it still mounts: the
   * `/oauth` routes then answer `503` instead of pretending to work.
   */
  readonly oauth?: OAuthService | undefined
  /** Test seam for the experimental CDP capture; defaults to the real one. */
  readonly captureCookies?: ((input: CdpCaptureInput) => Promise<CdpCaptureResult>) | undefined
  /**
   * The local launcher that starts a debuggable Chromium. Optional like the OAuth
   * engine: without it `/launch-browser` answers 503 rather than pretending.
   */
  readonly launcher?: BrowserLauncher | undefined
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * Wrap a handler with the two guards that must run first: loopback, then method.
 *
 * The order matters — a non-local caller must be rejected before its method (or
 * its body) is even considered.
 */
function fenced(methods: readonly string[], handler: RouteHandler): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (!methods.includes(method)) {
      setAllowHeader(res, methods)
      writeJson(res, 405, { error: 'method not allowed', allow: methods })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      // Never leak a raw stack into the browser half; the detail is scrubbed.
      writeJson(res, 500, { ok: false, error: 'internal error', detail: messageOf(error) })
    }
  }
}

/**
 * Register every route and return ONE disposer.
 *
 * A duplicate `(kind, path)` throws on this runtime, so each registration is
 * guarded individually: one failed path must not take the others down.
 */
export function registerRoutes(deps: RouteDeps): () => void {
  const log = deps.logger ?? createConsoleLogger()
  const disposers: (() => void)[] = []

  const routes: readonly WebRoute[] = [
    { kind: 'exact', path: ROUTE_PATHS.config, handler: fenced(['GET', 'PATCH'], (req, res) => handleConfig(deps, req, res)) },
    { kind: 'exact', path: ROUTE_PATHS.decisions, handler: fenced(['GET'], (req, res) => handleDecisions(deps, res)) },
    { kind: 'exact', path: ROUTE_PATHS.detect, handler: fenced(['GET'], (req, res) => handleDetect(deps, res)) },
    {
      kind: 'exact',
      path: ROUTE_PATHS.credentials,
      handler: fenced(['POST', 'DELETE'], (req, res) => handleCredentials(deps, req, res)),
    },
    { kind: 'exact', path: ROUTE_PATHS.deepread, handler: fenced(['POST'], (req, res) => handleDeepRead(deps, req, res)) },
    { kind: 'exact', path: ROUTE_PATHS.smoke, handler: fenced(['POST'], (req, res) => handleSmoke(deps, res)) },
    // One `(kind, path)` holds one handler, so `/oauth` dispatches on the method
    // AND on the `action` in the body (start / cancel / complete).
    { kind: 'exact', path: ROUTE_PATHS.oauth, handler: fenced(['GET', 'POST', 'DELETE'], (req, res) => handleOAuth(deps, req, res)) },
    { kind: 'exact', path: ROUTE_PATHS.oauthCallback, handler: fenced(['GET'], (req, res) => handleOAuthCallback(deps, req, res)) },
    { kind: 'exact', path: ROUTE_PATHS.probe, handler: fenced(['POST'], (req, res) => handleProbe(deps, req, res)) },
    { kind: 'exact', path: ROUTE_PATHS.cookies, handler: fenced(['POST'], (req, res) => handleCookies(deps, req, res)) },
    {
      kind: 'exact',
      path: ROUTE_PATHS.launchBrowser,
      handler: fenced(['POST'], (req, res) => handleLaunchBrowser(deps, req, res)),
    },
  ]

  for (const route of routes) {
    try {
      disposers.push(deps.webServer.register(route))
    } catch (error) {
      log('注册路由失败', { path: route.path, reason: messageOf(error) })
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Unloading must not throw.
      }
    }
    disposers.length = 0
  }
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/** The config view both `GET` and `PATCH` answer with. */
async function configPayload(deps: RouteDeps): Promise<Record<string, unknown>> {
  const view = await deps.service.describeConfig()
  return {
    ok: true,
    config: view.config,
    credentials: view.credentials,
    unresolved: view.decisions,
    decided: view.decided,
    limits: view.limits,
    transport: view.transport,
    notes: view.notes,
    paths: view.paths,
    login: view.login,
    labels: { sources: SOURCE_LABELS },
    settings: {
      available: deps.settings.available,
      note: SETTINGS_FALLBACK_NOTE,
    },
  }
}

async function handleConfig(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'GET') {
    writeJson(res, 200, await configPayload(deps))
    return
  }

  // ---- PATCH ------------------------------------------------------------
  const body = await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }

  const split = splitConfigPatch(body.value)
  if (!split.ok) {
    writeJson(res, 400, { ok: false, error: split.error })
    return
  }

  const warnings: string[] = []
  if (split.rejected.length > 0) {
    // Reported by NAME only. A dropped value is never echoed, because the most
    // likely reason a key is dropped is that it looked like a secret.
    warnings.push(`已忽略本插件不接受的字段：${split.rejected.join('、')}。凭据请走 /credentials，不要写进配置。`)
  }

  // 1. the proxy address belongs to the 0600 store, not the profile.
  if (split.local.localProxy !== undefined) {
    const outcome = await deps.store.write({ localProxy: split.local.localProxy })
    if (!outcome.ok) {
      writeJson(res, 500, { ok: false, error: `本机代理地址写入失败：${outcome.error ?? '未知原因'}` })
      return
    }
  }

  // 2. everything else goes to the settings namespace when it is writable.
  const hasSettingsPatch = Object.keys(split.settings).length > 0
  let settingsVerified = false
  let settingsError: string | undefined
  if (hasSettingsPatch) {
    const written = await deps.settings.patch(split.settings)
    settingsVerified = written.ok && written.verified
    settingsError = written.error
  }

  // 3. no decision may be lost: keep a snapshot in the 0600 store whenever the
  //    profile could not confirm the write.
  if (hasSettingsPatch && !settingsVerified) {
    const stored: LocalConfig = await deps.store.read().catch(() => ({}))
    const snapshot = mergeConfigInput(stored.fallbackConfig, split.settings)
    const outcome = await deps.store.write({ fallbackConfig: snapshot })
    if (!outcome.ok) {
      writeJson(res, 500, { ok: false, error: `配置回退快照写入失败：${outcome.error ?? '未知原因'}` })
      return
    }
    if (settingsError !== undefined && settingsError.length > 0) warnings.push(settingsError)
    warnings.push('settings 未确认本次写入，已把配置存进 $DSH_HOME/dsh-codehub.json（0600）作为回退，功能不受影响。')
  }

  const payload = await configPayload(deps)
  writeJson(res, 200, { ...payload, warnings })
}

async function handleDecisions(deps: RouteDeps, res: ServerResponse): Promise<void> {
  const unresolved = await deps.service.getUnresolved()
  const state = await deps.service.resolve()
  const decided: Record<string, boolean> = {}
  for (const key of DECISION_KEYS) {
    decided[key] = !unresolved.some((item) => item.key === (key as DecisionKey))
  }
  writeJson(res, 200, {
    ok: true,
    unresolved,
    ask_user: decisionPrompt(unresolved),
    decided,
    decisionState: {
      sourcePriority: state.sourcePriority,
      githubAccessPriority: state.github.accessPriority,
      failoverEnabled: state.failover.enabled === undefined ? null : state.failover.enabled,
      mergeSources: state.mergeSources === undefined ? null : state.mergeSources,
    },
  })
}

async function handleDetect(deps: RouteDeps, res: ServerResponse): Promise<void> {
  const config = await deps.service.resolve()
  const report = await detectEnvironment({ localProxy: config.github.localProxy })
  writeJson(res, 200, { ok: true, ...report, store: deps.store.filePath })
}

async function handleCredentials(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const credentials = deps.ctx.get<CredentialsService>('credentials')
  if (credentials === undefined) {
    writeJson(res, 503, { ok: false, error: 'credentials-service-unavailable' })
    return
  }

  const method = (req.method ?? 'POST').toUpperCase()
  const query = requestUrl(req)
  const body: BodyResult = method === 'DELETE' ? { ok: true, status: 200, value: {} } : await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }
  const record: Record<string, unknown> = isRecord(body.value) ? body.value : {}

  const rawSource =
    typeof record.source === 'string' ? record.source.trim() : (query.searchParams.get('source') ?? '')
  if (!(CREDENTIAL_TARGETS as readonly string[]).includes(rawSource)) {
    writeJson(res, 400, { ok: false, error: '`source` 必须是 github / gitee / csdn 之一。' })
    return
  }
  const target = rawSource as CredentialTarget
  const ref = CREDENTIAL_REFS[target]

  if (method === 'POST') {
    const kind = typeof record.kind === 'string' ? record.kind.trim() : 'token'
    if (kind !== 'token' && kind !== 'cookie') {
      writeJson(res, 400, { ok: false, error: '`kind` 只能是 token 或 cookie。' })
      return
    }
    const value = record.value
    if (typeof value !== 'string' || value.trim().length === 0) {
      writeJson(res, 400, { ok: false, error: '`value` 必须是非空字符串。' })
      return
    }
    try {
      // The value is used HERE and nowhere else: not logged, not echoed, not
      // written to disk by this plugin.
      await credentials.set(ref, value)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: `写入凭据失败：${messageOf(error)}` })
      return
    }
  } else {
    try {
      await credentials.unset(ref)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: `清除凭据失败：${messageOf(error)}` })
      return
    }
  }

  writeJson(res, 200, { ok: true, credentials: await deps.service.credentialStatus() })
}

async function handleDeepRead(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }
  const record: Record<string, unknown> = isRecord(body.value) ? body.value : {}

  const raw = typeof record.url === 'string' ? record.url.trim() : ''
  if (raw.length === 0) {
    writeJson(res, 400, { ok: false, error: '`url` 必填。' })
    return
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    writeJson(res, 400, { ok: false, error: '`url` 不是合法地址。' })
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // Refuse file:, data:, and anything else a request could use to reach locally.
    writeJson(res, 400, { ok: false, error: '只接受 http / https 地址。' })
    return
  }

  let targets: DeepReadTarget[] | undefined
  if (Array.isArray(record.targets)) {
    targets = []
    for (const item of record.targets) {
      if (typeof item === 'string' && (DEEP_READ_TARGETS as readonly string[]).includes(item)) {
        targets.push(item as DeepReadTarget)
      }
    }
  }

  const unresolved = await deps.service.getUnresolved()
  if (unresolved.length > 0) {
    // Same rule as the tool: no network request before the decisions exist.
    writeJson(res, 409, {
      ok: false,
      error: '尚有决策点未确认，未发起任何网络请求。',
      unresolved,
      ask_user: decisionPrompt(unresolved),
    })
    return
  }

  const notes = await deps.service.deepRead(raw, targets)
  writeJson(res, 200, {
    ok: true,
    url: raw,
    notes,
    reason: notes.length > 0 ? '' : '没有产出笔记：可能未选择深度阅读目标、该源不支持深读，或抓取失败。',
  })
}

async function handleSmoke(deps: RouteDeps, res: ServerResponse): Promise<void> {
  const report = await deps.service.smoke()
  // Always 200: the payload itself carries `ok`, and the browser half renders it
  // as-is rather than treating a failed probe as a transport error.
  writeJson(res, 200, report)
}

// ---------------------------------------------------------------------------
// Browser login (docs/DESIGN.md §7.3 and §7.5).
//
// RESPONSE WHITELIST — the shape of every reply below is built field by field
// from the frozen list `flowId/kind/userCode/verificationUri/expiresIn/interval/
// status/reason/credentialConfigured`. Nothing is ever spread out of a flow
// object, so a credential cannot ride along even if the engine started carrying
// one; that is why this file does not use `{...result}`.
// ---------------------------------------------------------------------------

/** Only these two sources have an OAuth flow; CSDN has none, by design. */
const OAUTH_SOURCES: readonly OAuthSource[] = ['github', 'gitee']

function isOAuthSource(value: unknown): value is OAuthSource {
  return typeof value === 'string' && (OAUTH_SOURCES as readonly string[]).includes(value)
}

/** The single method each source has in the contract's login vocabulary. */
const OAUTH_METHOD_FOR: Readonly<Record<OAuthSource, OAuthMethod>> = {
  github: 'oauth-device',
  gitee: 'oauth-code',
}

function isOAuthMethod(value: unknown): value is OAuthMethod {
  return value === 'oauth-device' || value === 'oauth-code'
}

/** Read one optional string field out of a request body. */
function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The Gitee client secret, straight out of the credential service.
 *
 * It is resolved HERE, used for one exchange, and never stored on the flow
 * record nor echoed (docs/DESIGN.md §7.3). A body-supplied secret is accepted as
 * a fallback only because the panel may collect one before it is saved — it is
 * treated exactly like the stored one: used, never logged, never returned.
 */
async function readGiteeSecret(deps: RouteDeps): Promise<string | undefined> {
  const credentials = deps.ctx.get<CredentialsService>('credentials')
  if (credentials === undefined) return undefined
  try {
    const resolved = await credentials.resolve(GITEE_OAUTH_SECRET_REF)
    const value = resolved?.value
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/** `http://<host><OAUTH_CALLBACK_PATH>` — the loopback default Gitee registers. */
function deriveRedirectUri(req: IncomingMessage): string {
  const host = typeof req.headers?.host === 'string' && req.headers.host.trim().length > 0 ? req.headers.host.trim() : '127.0.0.1'
  return `http://${host}${OAUTH_CALLBACK_PATH}`
}

async function handleOAuth(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const oauth = deps.oauth
  if (oauth === undefined) {
    writeJson(res, 503, { ok: false, error: 'oauth-engine-unavailable' })
    return
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const query = requestUrl(req)

  if (method === 'GET') {
    const flowId = query.searchParams.get('flowId')?.trim() ?? ''
    if (flowId.length === 0) {
      writeJson(res, 400, { ok: false, error: '`flowId` 必填。' })
      return
    }
    const status = await oauth.status(flowId)
    writeJson(res, 200, {
      ok: true,
      flowId: status.flowId,
      status: status.state,
      reason: status.reason,
      interval: status.intervalMs,
      credentialConfigured: status.credentialConfigured,
    })
    return
  }

  const body = await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }
  const record: Record<string, unknown> = isRecord(body.value) ? body.value : {}
  // DELETE carries no body: the flow id comes from the query string instead.
  const action = method === 'DELETE' ? 'cancel' : bodyString(record, 'action') || 'start'
  const config = await deps.service.resolve()

  if (action === 'cancel') {
    const flowId = bodyString(record, 'flowId') || (query.searchParams.get('flowId') ?? '').trim()
    if (flowId.length === 0) {
      writeJson(res, 400, { ok: false, error: '`flowId` 必填。' })
      return
    }
    oauth.cancel(flowId)
    // Report the state the ENGINE settled on (`error` after a cancel) rather than
    // a second, hand-written one: two sources for one fact is how they drift.
    const settled = await oauth.status(flowId)
    writeJson(res, 200, {
      ok: true,
      flowId,
      status: settled.state,
      reason: settled.reason,
      interval: settled.intervalMs,
      credentialConfigured: settled.credentialConfigured,
    })
    return
  }

  if (action === 'complete') {
    // The manual paste path: Gitee's callback can fail (wrong port, no browser),
    // and the design requires that path to always stay available.
    const code = bodyString(record, 'code')
    if (code.length === 0) {
      writeJson(res, 400, { ok: false, error: '`code` 必填。' })
      return
    }
    const clientId = bodyString(record, 'clientId') || config.gitee.oauthClientId
    const clientSecret = (await readGiteeSecret(deps)) ?? bodyString(record, 'clientSecret')
    const redirectUri = bodyString(record, 'redirectUri') || config.gitee.oauthRedirectUri || deriveRedirectUri(req)
    const outcome = await oauth.completeWithCode({
      code,
      clientId,
      ...(clientSecret.length === 0 ? {} : { clientSecret }),
      redirectUri,
    })
    writeJson(res, 200, {
      ok: outcome.ok,
      status: outcome.ok ? 'done' : 'error',
      reason: outcome.reason,
      interval: 0,
      credentialConfigured: outcome.credentialConfigured,
    })
    return
  }

  if (action !== 'start') {
    writeJson(res, 400, { ok: false, error: '`action` 只能是 start / cancel / complete。' })
    return
  }

  // ---- start ------------------------------------------------------------
  const source = record['source']
  if (!isOAuthSource(source)) {
    writeJson(res, 400, { ok: false, error: '`source` 只能是 github 或 gitee（CSDN 没有 OAuth）。' })
    return
  }
  const requestedMethod = record['method']
  const sourceMethod = OAUTH_METHOD_FOR[source]
  if (requestedMethod !== undefined && !isOAuthMethod(requestedMethod)) {
    writeJson(res, 400, { ok: false, error: '`method` 只能是 oauth-device 或 oauth-code。' })
    return
  }
  if (isOAuthMethod(requestedMethod) && requestedMethod !== sourceMethod) {
    writeJson(res, 400, {
      ok: false,
      error: `不支持的方法组合：${SOURCE_LABELS[source]} 只能用 ${sourceMethod}（可用方法：${SOURCE_LOGIN_METHODS[source].join(' / ')}）。`,
    })
    return
  }

  const clientId = bodyString(record, 'clientId') || (source === 'github' ? config.github.oauthClientId : config.gitee.oauthClientId)
  if (clientId.length === 0) {
    writeJson(res, 400, {
      ok: false,
      error:
        source === 'github'
          ? '尚未配置 github.oauthClientId：请先在 GitHub 建一个 OAuth App 并勾选 Enable Device Flow，把 Client ID 填进设置（或改用 PAT 粘贴）。'
          : '尚未配置 gitee.oauthClientId：请先在 Gitee 建第三方应用并把 Client ID 填进设置（或改用 PAT 粘贴）。',
    })
    return
  }

  const secret = source === 'gitee' ? ((await readGiteeSecret(deps)) ?? bodyString(record, 'clientSecret')) : ''
  const redirectUri =
    source === 'gitee' ? bodyString(record, 'redirectUri') || config.gitee.oauthRedirectUri || deriveRedirectUri(req) : ''
  const requestHost = typeof req.headers?.host === 'string' ? req.headers.host : ''

  const started = await oauth.start({
    source,
    method: sourceMethod,
    clientId,
    ...(secret.length === 0 ? {} : { clientSecret: secret }),
    ...(redirectUri.length === 0 ? {} : { redirectUri }),
    ...(requestHost.length === 0 ? {} : { requestHost }),
  })

  if (started.ok === false) {
    writeJson(res, 200, {
      ok: false,
      status: 'error',
      // The fallback methods are not a whitelisted field, so they are folded
      // into the sentence: the panel shows `reason` and nothing else.
      reason: `${started.reason} 仍可用的方式：${started.fallback.join(' / ')}。`,
      interval: 0,
      credentialConfigured: false,
    })
    return
  }

  if (started.kind === 'device') {
    writeJson(res, 200, {
      ok: true,
      kind: 'device',
      flowId: started.flowId,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresIn: started.expiresInMs,
      interval: started.intervalMs,
      status: 'pending',
      reason: '',
      credentialConfigured: false,
    })
    return
  }

  writeJson(res, 200, {
    ok: true,
    kind: 'redirect',
    flowId: started.flowId,
    // The browser must OPEN this URL, and the `state` is generated host-side, so
    // the client cannot compose it. `authorizeUrl` is not in the DESIGN §7.5
    // whitelist, while `verificationUri` is and means exactly "the URL the user
    // must open" — so the authorize URL travels in that field for this kind.
    verificationUri: started.authorizeUrl,
    expiresIn: started.expiresInMs,
    interval: 0,
    status: 'pending',
    reason: '',
    credentialConfigured: false,
  })
}

async function handleOAuthCallback(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const oauth = deps.oauth
  if (oauth === undefined) {
    writeJson(res, 503, { ok: false, error: 'oauth-engine-unavailable' })
    return
  }
  const query = requestUrl(req)
  const params: { code?: string; state?: string; error?: string } = {}
  for (const key of ['code', 'state', 'error'] as const) {
    const value = query.searchParams.get(key)
    if (value !== null) params[key] = value
  }
  const outcome = await oauth.handleCallback(params)
  // A closed page, not JSON: this URL is what the browser lands on. It carries
  // no credential — the engine only reports whether the exchange worked.
  writeHtml(res, outcome.status, outcome.html)
}

// ---------------------------------------------------------------------------
// Capability probe and the experimental cookie capture (§7.4, §7.5).
// ---------------------------------------------------------------------------

async function handleProbe(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }
  const record: Record<string, unknown> = isRecord(body.value) ? body.value : {}

  const rawSource = bodyString(record, 'source')
  if (rawSource.length > 0 && !(SOURCES as readonly string[]).includes(rawSource)) {
    writeJson(res, 400, { ok: false, error: '`source` 只能是 github / gitee / csdn 之一。' })
    return
  }
  // ANONYMOUS unless explicitly asked otherwise. A probe is the one call the UI
  // makes before any credential exists, so spending one by default would be a
  // credential leaving the process without the user asking for it.
  const useStoredCredential = record['useStoredCredential'] === true

  if (rawSource.length > 0) {
    const report = await deps.service.probe({ source: rawSource as SourceId, useStoredCredential })
    writeJson(res, 200, { ok: true, report })
    return
  }

  const reports = []
  for (const source of SOURCES) reports.push(await deps.service.probe({ source, useStoredCredential }))
  writeJson(res, 200, { ok: true, reports })
}

async function handleCookies(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {  const body = await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }
  const record: Record<string, unknown> = isRecord(body.value) ? body.value : {}
  const config = await deps.service.resolve()

  // Two independent gates, in the order the user meets them: the feature must be
  // switched on, and THIS request must carry explicit consent. A missing consent
  // is a refusal, never a default (§7.4).
  if (config.csdn.cdpEnabled !== true) {
    writeJson(res, 403, {
      ok: false,
      error: 'CSDN 的 CDP 抓取未启用（csdn.cdpEnabled = false）。它需要你显式开启，因为浏览器调试端口对本机任何进程开放。',
    })
    return
  }
  if (record['consent'] !== true) {
    writeJson(res, 403, {
      ok: false,
      error: '缺少 consent: true。读取浏览器 cookie 需要你在界面上主动确认，本插件不会默认执行。',
    })
    return
  }

  const credentials = deps.ctx.get<CredentialsService>('credentials')
  if (credentials === undefined) {
    writeJson(res, 503, { ok: false, error: 'credentials-service-unavailable' })
    return
  }

  const requestedPort = record['port']
  const port =
    typeof requestedPort === 'number' && Number.isFinite(requestedPort)
      ? Math.min(Math.max(Math.floor(requestedPort), 1), 65535)
      : config.csdn.cdpPort
  const capture = deps.captureCookies ?? captureBrowserCookies
  const result = await capture({
    port,
    origins: CDP_COOKIE_HOSTS,
    consent: true,
    timeoutMs: Math.min(config.limits.timeoutMs, 10_000),
  })

  if (result.ok === false) {
    writeJson(res, result.failure === 'consent-required' ? 403 : 502, { ok: false, error: result.reason })
    return
  }

  try {
    // The ONE place the cookie header is used. It is never put in the response,
    // never logged and never written by this plugin to disk.
    await credentials.set(CREDENTIAL_REFS.csdn, result.cookieHeader)
  } catch (error) {
    writeJson(res, 500, { ok: false, error: `写入 CSDN cookie 失败：${messageOf(error)}` })
    return
  }

  writeJson(res, 200, {
    ok: true,
    count: result.names.length,
    names: [...result.names],
    hosts: [...result.hosts],
    reason: `已把 ${result.names.length} 个 cookie 交给凭据服务；这里只回显名称，值不会离开凭据服务。`,
  })
}

/**
 * `POST /launch-browser` — start a debuggable Chromium when the port is silent.
 *
 * SAME TWO GATES AS `/cookies`, for the same reason: starting a browser whose
 * debug port is open is the risky act, so it needs the feature switched on AND an
 * explicit `consent: true` in the request. The response carries the loopback
 * `webSocketDebuggerUrl` (not a secret) and never any credential.
 */
async function handleLaunchBrowser(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const launcher = deps.launcher
  if (launcher === undefined) {
    writeJson(res, 503, { ok: false, error: 'launcher-unavailable' })
    return
  }
  const body = await readJsonBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, error: body.error })
    return
  }
  const record: Record<string, unknown> = isRecord(body.value) ? body.value : {}
  const config = await deps.service.resolve()

  if (config.csdn.cdpEnabled !== true) {
    writeJson(res, 403, {
      ok: false,
      error: 'CSDN 的 CDP 抓取未启用（csdn.cdpEnabled = false）。先打开它，再启动调试浏览器。',
    })
    return
  }
  if (record['consent'] !== true) {
    writeJson(res, 403, {
      ok: false,
      error: '缺少 consent: true。启动一个开着调试端口的浏览器需要你主动确认。',
    })
    return
  }

  const requestedPort = record['port']
  const port =
    typeof requestedPort === 'number' && Number.isFinite(requestedPort)
      ? Math.min(Math.max(Math.floor(requestedPort), 1), 65535)
      : config.csdn.cdpPort
  const requestedUrl = typeof record['url'] === 'string' ? record['url'].trim() : ''
  const browserId = typeof record['browserId'] === 'string' ? record['browserId'].trim() : ''

  const result = await launcher.launch({
    port,
    ...(requestedUrl.length === 0 ? {} : { url: requestedUrl }),
    ...(browserId.length === 0 ? {} : { browserId: browserId as never }),
  })

  if (result.ok === false) {
    // 404 reads as "nothing to attach to yet"; the reason says how to fix it.
    writeJson(res, result.failure === 'bad-port' ? 400 : 502, {
      ok: false,
      error: result.reason,
      failure: result.failure,
      ...(result.searched === undefined ? {} : { searched: [...result.searched] }),
    })
    return
  }

  writeJson(res, 200, {
    ok: true,
    launched: result.launched,
    port: result.port,
    userDataDir: result.userDataDir,
    debuggerUrl: result.debuggerUrl,
    ...(result.browser === null ? {} : { browser: { id: result.browser.id, label: result.browser.label } }),
    reason: result.reason,
  })
}
