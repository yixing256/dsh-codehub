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
  DECISION_KEYS,
  DEEP_READ_TARGETS,
  SOURCE_LABELS,
  decisionPrompt,
} from './contract.js'
import type { DecisionKey, DeepReadTarget } from './contract.js'
import { CREDENTIAL_TARGETS, mergeConfigInput, splitConfigPatch } from './config.js'
import type { CredentialTarget } from './config.js'
import { detectEnvironment } from './detect.js'
import { createConsoleLogger, scrubSecrets } from './net.js'
import type { TransportLogger } from './net.js'
import { CREDENTIAL_REFS, type CodeSource } from './service.js'
import { SETTINGS_FALLBACK_NOTE, type SettingsBridge } from './settings.js'
import type { LocalConfig, LocalConfigStore } from './store.js'

/** Request bodies are tiny (a patch or one credential); anything larger is refused. */
export const MAX_BODY_BYTES = 64 * 1024

/** The six paths this plugin owns, all under `contract.API_PREFIX`. */
export const ROUTE_PATHS = {
  config: `${API_PREFIX}/config`,
  decisions: `${API_PREFIX}/decisions`,
  detect: `${API_PREFIX}/detect`,
  credentials: `${API_PREFIX}/credentials`,
  deepread: `${API_PREFIX}/deepread`,
  smoke: `${API_PREFIX}/smoke`,
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
 * guarded individually: one failed path must not take the other five down.
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
