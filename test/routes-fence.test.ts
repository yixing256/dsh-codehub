/**
 * 路由围栏（task-5 §F，后半）。
 *
 * The harness's own `/api` fence does NOT cover routes a plugin registers itself,
 * and this route family can read configuration, write decisions and write
 * CREDENTIALS. So the two guards are asserted behaviourally, through the real
 * registered handlers with fake `req`/`res` objects:
 *
 *   • a non-loopback caller gets `403 {error:'forbidden: loopback-only'}` and the
 *     handler body never runs — the service is not touched at all;
 *   • an empty / unknown `remoteAddress` fails CLOSED (403), because that is the
 *     case an attacker controls;
 *   • the method check runs SECOND and answers `405` with `Allow`;
 *   • the credential route never echoes a value: the response carries booleans,
 *     and the value appears nowhere in it.
 *
 * `src/routes.ts` imports `CREDENTIAL_REFS` from `src/service.ts`, which is why
 * this file depends on the `@deepseek-ai/cordis` alias in `vitest.config.ts`.
 */

import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebServerService } from '@deepseek-ai/dsh-host-webserver'

import {
  ANTI_COPY_STATEMENT,
  CDP_COOKIE_HOSTS,
  CSDN_API_NOTE,
  DECISION_GUIDE,
  DEFAULT_LIMITS,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_SCOPE_NOTE,
} from '../src/contract.js'
import type { UnresolvedDecision } from '../src/contract.js'
import { resolveConfig } from '../src/config.js'
import type { CodehubConfig } from '../src/config.js'
import type { CdpCaptureResult } from '../src/cdp.js'
import type { OAuthService } from '../src/oauth.js'
import { CREDENTIAL_REFS } from '../src/service.js'
import { MAX_BODY_BYTES, ROUTE_PATHS, isLoopbackRequest, registerRoutes, writeJson } from '../src/routes.js'

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number
  readonly headers: Record<string, string | number | readonly string[]>
  body: string
  ended: boolean
  setHeader(name: string, value: string | number | readonly string[]): void
  end(chunk?: string): void
}

function fakeResponse(options: { readonly withSetHeader?: boolean } = {}): FakeResponse {
  const response: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      if (options.withSetHeader === false) throw new TypeError('setHeader is not available')
      response.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      response.ended = true
      response.body = chunk ?? ''
    },
  }
  return response
}

interface FakeRequestOptions {
  readonly method?: string
  readonly url?: string
  readonly remoteAddress?: string | undefined
  readonly body?: unknown
}

function fakeRequest(options: FakeRequestOptions = {}): IncomingMessage {
  const serialised = options.body === undefined ? '' : JSON.stringify(options.body)
  const chunks = serialised.length > 0 ? [Buffer.from(serialised, 'utf8')] : []
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    socket: { remoteAddress: options.remoteAddress === undefined ? '127.0.0.1' : options.remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return request as unknown as IncomingMessage
}

interface Harness {
  readonly routes: WebRoute[]
  readonly calls: {
    describeConfig: number
    getUnresolved: number
    deepRead: number
    credentialStatus: number
    credentialSet: Array<{ readonly ref: string; readonly value: string }>
    credentialUnset: number
    /** `credentials.resolve()` — the probe must never touch this anonymously. */
    credentialResolve: number
    probe: Array<{ readonly source?: string; readonly useStoredCredential?: boolean }>
    oauthStart: Array<Record<string, unknown>>
    oauthCancel: string[]
    capture: number
    disposers: number
  }
  readonly dispose: () => void
}

interface HarnessOptions {
  readonly unresolved?: readonly UnresolvedDecision[]
  readonly credentials?: boolean
  /** The resolved config the new handlers read (cdpEnabled / oauth client ids). */
  readonly config?: CodehubConfig
  /** False = no OAuth engine mounted, so `/oauth` must answer 503. */
  readonly oauth?: boolean
  /** What the injected CDP capture seam answers. */
  readonly cdp?: CdpCaptureResult
}

function harness(options: HarnessOptions = {}): Harness {
  const routes: WebRoute[] = []
  const calls: Harness['calls'] = {
    describeConfig: 0,
    getUnresolved: 0,
    deepRead: 0,
    credentialStatus: 0,
    credentialSet: [],
    credentialUnset: 0,
    credentialResolve: 0,
    probe: [],
    oauthStart: [],
    oauthCancel: [],
    capture: 0,
    disposers: 0,
  }
  const unresolved = options.unresolved ?? []

  const service = {
    async describeConfig() {
      calls.describeConfig += 1
      return {
        ok: true as const,
        config: { enabled: true, sourcePriority: [] as string[] },
        decisions: [...unresolved],
        decided: unresolved.length === 0,
        credentials: { github: false, gitee: true, csdn: false },
        limits: { ...DEFAULT_LIMITS },
        transport: { webAvailable: false, proxyConfigured: false, proxyScopeNote: LOCAL_PROXY_SCOPE_NOTE },
        notes: { csdn: CSDN_API_NOTE, localProxy: LOCAL_PROXY_HELP, antiCopy: ANTI_COPY_STATEMENT, settings: 'ns' },
        paths: { store: '/tmp/dsh-codehub.json' },
        login: {
          requirements: { github: 'g', gitee: 'e', csdn: 'c' },
          oauth: { github: false, gitee: false },
          guides: {},
        },
      }
    },
    async getUnresolved() {
      calls.getUnresolved += 1
      return [...unresolved]
    },
    async deepRead() {
      calls.deepRead += 1
      return []
    },
    async credentialStatus() {
      calls.credentialStatus += 1
      return { github: false, gitee: true, csdn: false }
    },
    async probe(input: { source?: string; useStoredCredential?: boolean } = {}) {
      calls.probe.push({ ...input })
      const probedAt = '2026-10-05T00:00:00.000Z'
      return {
        source: input.source ?? 'github',
        label: input.source ?? 'github',
        probedAt,
        authenticated: input.useStoredCredential === true,
        operations: [
          { operation: 'code-search', reachable: true, statusCode: 401, requiresLogin: true, evidence: 'e', probedAt },
        ],
      }
    },
    async smoke() {
      return { ok: true, probes: [], notes: [], capabilities: [] }
    },
    async resolve() {
      // A REAL resolved config: the decisions route reads nested paths off it.
      return resolveConfig(options.config ?? {})
    },
  }

  const credentialsService =
    options.credentials === false
      ? undefined
      : {
          async set(ref: string, value: string) {
            calls.credentialSet.push({ ref, value })
          },
          async unset() {
            calls.credentialUnset += 1
          },
          async resolve() {
            calls.credentialResolve += 1
            return undefined
          },
          async describe() {
            return { configured: false, writable: true }
          },
        }

  const oauth =
    options.oauth === false
      ? undefined
      : ({
          async start(input: Record<string, unknown>) {
            calls.oauthStart.push({ ...input })
            return {
              ok: true,
              kind: 'device',
              flowId: 'flow-1',
              userCode: 'ABCD-1234',
              verificationUri: 'https://github.com/login/device',
              expiresInMs: 900_000,
              intervalMs: 5_000,
            }
          },
          async status(flowId: string) {
            return { flowId, state: 'pending', credentialConfigured: false, reason: '', intervalMs: 5_000 }
          },
          async completeWithCode() {
            return { ok: true, credentialConfigured: true, reason: 'ok' }
          },
          cancel(flowId: string) {
            calls.oauthCancel.push(flowId)
          },
          async handleCallback() {
            return { status: 200, html: '<!doctype html><p>done</p>' }
          },
        } as unknown as OAuthService)

  const webServer = {
    register(route: WebRoute) {
      routes.push(route)
      return () => {
        calls.disposers += 1
      }
    },
    registerUpgrade() {
      return () => {}
    },
    registerFallback() {
      return () => {}
    },
  }

  const dispose = registerRoutes({
    webServer: webServer as unknown as WebServerService,
    ctx: { get: (name: string) => (name === 'credentials' ? credentialsService : undefined) } as never,
    service: service as never,
    store: { filePath: '/tmp/dsh-codehub.json', read: async () => ({}), write: async () => ({ ok: true }) } as never,
    settings: { available: false, read: async () => ({ value: undefined }), patch: async () => ({ ok: false, verified: false }) } as never,
    ...(oauth === undefined ? {} : { oauth }),
    captureCookies: async () => {
      calls.capture += 1
      return (
        options.cdp ?? {
          ok: true,
          cookieHeader: 'SESS=super-secret-cookie',
          names: ['SESS'],
          hosts: [...CDP_COOKIE_HOSTS],
        }
      )
    },
    logger: () => {},
  })

  return { routes, calls, dispose }
}

function routeFor(tested: Harness, path: string): WebRoute {
  const route = tested.routes.find((item) => item.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  return route
}

async function call(
  tested: Harness,
  path: string,
  options: FakeRequestOptions = {},
): Promise<FakeResponse> {
  const response = fakeResponse()
  await routeFor(tested, path).handler(
    fakeRequest(options),
    response as unknown as ServerResponse,
  )
  return response
}

// ---------------------------------------------------------------------------
// The fence itself.
// ---------------------------------------------------------------------------

describe('路由 — loopback 围栏', () => {
  it('isLoopbackRequest 只认本机地址；空/未知地址一律 fail closed', () => {
    const request = (remoteAddress: string | undefined): IncomingMessage =>
      ({ socket: remoteAddress === undefined ? {} : { remoteAddress } }) as unknown as IncomingMessage

    expect(isLoopbackRequest(request('127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(request('127.0.0.5'))).toBe(true)
    expect(isLoopbackRequest(request('::1'))).toBe(true)
    expect(isLoopbackRequest(request('::ffff:127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(request('::ffff:127.0.0.9'))).toBe(true)

    expect(isLoopbackRequest(request('10.0.0.5'))).toBe(false)
    expect(isLoopbackRequest(request('192.168.1.20'))).toBe(false)
    expect(isLoopbackRequest(request('::ffff:10.0.0.5'))).toBe(false)
    expect(isLoopbackRequest(request(undefined))).toBe(false)
    expect(isLoopbackRequest(request(''))).toBe(false)
  })

  it('非本机请求 → 403 forbidden: loopback-only，且 handler 内部一次都没跑', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.config, { method: 'GET', remoteAddress: '10.0.0.5' })

    expect(response.statusCode).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden: loopback-only' })
    expect(tested.calls.describeConfig).toBe(0)
  })

  it('未带 remoteAddress 的请求同样被拒（不是「没地址就放行」）', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.decisions, { remoteAddress: '' })

    expect(response.statusCode).toBe(403)
    expect(tested.calls.getUnresolved).toBe(0)
  })

  it('方法不匹配 → 405，并带上 Allow（围栏先于方法判断）', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.config, { method: 'DELETE' })

    expect(response.statusCode).toBe(405)
    expect(response.headers['allow']).toBe('GET, PATCH')
    expect(JSON.parse(response.body)).toMatchObject({ error: 'method not allowed' })
    expect(tested.calls.describeConfig).toBe(0)
  })

  it('注册的是契约里的六条路径，且都是 exact', () => {
    const tested = harness()
    expect(tested.routes.map((route) => route.path).sort()).toEqual(Object.values(ROUTE_PATHS).sort())
    expect(tested.routes.every((route) => route.kind === 'exact')).toBe(true)

    tested.dispose()
    expect(tested.calls.disposers).toBe(tested.routes.length)
    // 反复 dispose 不应抛异常。
    expect(() => tested.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The happy paths.
// ---------------------------------------------------------------------------

describe('路由 — 本机请求走通', () => {
  it('GET /config 返回 ok:true，并把三条备注文案一起交给浏览器半边', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.config, { method: 'GET' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    const payload = JSON.parse(response.body) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(tested.calls.describeConfig).toBe(1)
    expect(response.body).toContain(CSDN_API_NOTE)
    expect(response.body).toContain(LOCAL_PROXY_SCOPE_NOTE)
    expect(response.body).toContain(ANTI_COPY_STATEMENT)
    expect(payload['paths']).toEqual({ store: '/tmp/dsh-codehub.json' })
  })

  it('GET /decisions 返回未决策列表与可直接转述的问题', async () => {
    const tested = harness({ unresolved: [DECISION_GUIDE.sourcePriority] })
    const response = await call(tested, ROUTE_PATHS.decisions)

    expect(response.statusCode).toBe(200)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    expect(payload['unresolved']).toHaveLength(1)
    expect(payload['ask_user']).toBe(DECISION_GUIDE.sourcePriority.ask)
    expect(payload['decided']).toMatchObject({ sourcePriority: false, githubAccessPriority: true })
    expect(tested.calls.getUnresolved).toBe(1)
  })

  it('POST /deepread 在决策未确认时 → 409 且一次深读都不发起', async () => {
    const tested = harness({ unresolved: [DECISION_GUIDE.githubAccessPriority] })
    const response = await call(tested, ROUTE_PATHS.deepread, {
      method: 'POST',
      body: { url: 'https://github.com/vuejs/core', targets: ['readme', 'nope'] },
    })

    expect(response.statusCode).toBe(409)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false })
    expect(response.body).toContain(DECISION_GUIDE.githubAccessPriority.ask)
    expect(tested.calls.deepRead).toBe(0)
  })

  it('POST /deepread 只接受 http/https，拒绝本地可达的其它协议', async () => {
    const tested = harness()
    const file = await call(tested, ROUTE_PATHS.deepread, { method: 'POST', body: { url: 'file:///etc/passwd' } })
    expect(file.statusCode).toBe(400)
    expect(tested.calls.deepRead).toBe(0)

    const missing = await call(tested, ROUTE_PATHS.deepread, { method: 'POST', body: {} })
    expect(missing.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Credentials.
// ---------------------------------------------------------------------------

describe('路由 — 凭据：值只过一次，绝不回显', () => {
  it('POST /credentials 把值交给凭证服务，响应只有布尔状态', async () => {
    const tested = harness()
    const secret = 'gitee-super-secret-value'
    const response = await call(tested, ROUTE_PATHS.credentials, {
      method: 'POST',
      body: { source: 'gitee', kind: 'token', value: secret },
    })

    expect(response.statusCode).toBe(200)
    expect(tested.calls.credentialSet).toEqual([{ ref: CREDENTIAL_REFS.gitee, value: secret }])
    expect(response.body).not.toContain(secret)
    expect(JSON.parse(response.body)).toEqual({ ok: true, credentials: { github: false, gitee: true, csdn: false } })
  })

  it('DELETE /credentials 只做清除，不回显任何值', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.credentials, {
      method: 'DELETE',
      url: `${ROUTE_PATHS.credentials}?source=csdn`,
    })

    expect(response.statusCode).toBe(200)
    expect(tested.calls.credentialUnset).toBe(1)
    expect(response.body).not.toContain('cookie')
  })

  it('source / kind / value 不合法时 → 400，且不接触凭证服务', async () => {
    const tested = harness()

    const badSource = await call(tested, ROUTE_PATHS.credentials, {
      method: 'POST',
      body: { source: 'bitbucket', value: 'x' },
    })
    expect(badSource.statusCode).toBe(400)

    const badKind = await call(tested, ROUTE_PATHS.credentials, {
      method: 'POST',
      body: { source: 'gitee', kind: 'password', value: 'x' },
    })
    expect(badKind.statusCode).toBe(400)

    const emptyValue = await call(tested, ROUTE_PATHS.credentials, {
      method: 'POST',
      body: { source: 'gitee', value: '   ' },
    })
    expect(emptyValue.statusCode).toBe(400)

    expect(tested.calls.credentialSet).toEqual([])
  })

  it('凭证服务不可用时 → 503，而不是假装成功', async () => {
    const tested = harness({ credentials: false })
    const response = await call(tested, ROUTE_PATHS.credentials, {
      method: 'POST',
      body: { source: 'gitee', value: 'x' },
    })

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: 'credentials-service-unavailable' })
  })
})

// ---------------------------------------------------------------------------
// writeJson / body limits.
// ---------------------------------------------------------------------------

describe('路由 — 响应写入与请求体上限', () => {
  it('writeJson 设置状态码、JSON 头并结束响应', () => {
    const response = fakeResponse()
    writeJson(response as unknown as ServerResponse, 201, { ok: true })

    expect(response.statusCode).toBe(201)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toBe('{"ok":true}')
    expect(response.ended).toBe(true)
  })

  it('setHeader 不可用的最小 res 也能写出响应（永不致命）', () => {
    const response = fakeResponse({ withSetHeader: false })
    expect(() => writeJson(response as unknown as ServerResponse, 200, { ok: true })).not.toThrow()
    expect(response.body).toBe('{"ok":true}')
  })

  it('循环引用无法序列化时退化为一个可读的错误对象', () => {
    const response = fakeResponse()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    writeJson(response as unknown as ServerResponse, 200, circular)

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false })
  })

  it('请求体超过上限 → 413（凭据请求不该拖着大 body）', async () => {
    const tested = harness()
    const huge = { source: 'gitee', value: 'x'.repeat(MAX_BODY_BYTES + 10) }
    const response = await call(tested, ROUTE_PATHS.credentials, { method: 'POST', body: huge })

    expect(response.statusCode).toBe(413)
    expect(tested.calls.credentialSet).toEqual([])
  })

  it('非法 JSON 请求体 → 400', async () => {
    const tested = harness()
    const response = fakeResponse()
    const request = {
      method: 'POST',
      url: ROUTE_PATHS.credentials,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{ not json', 'utf8')
      },
    } as unknown as IncomingMessage

    await routeFor(tested, ROUTE_PATHS.credentials).handler(request, response as unknown as ServerResponse)
    expect(response.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// The browser-login / probe / cookie routes (docs/DESIGN.md §7.5).
//
// The fence is not re-implemented for these four paths: the point of the tests
// below is that the SAME fence wraps them (403 before the body runs, 405 with
// `Allow`), and that their responses stay inside the frozen field whitelist —
// which is what makes "a credential can never be echoed" structural rather than
// a promise.
// ---------------------------------------------------------------------------

const NEW_ROUTES = [ROUTE_PATHS.oauth, ROUTE_PATHS.oauthCallback, ROUTE_PATHS.probe, ROUTE_PATHS.cookies] as const

describe('路由 — 浏览器登录 / 探测 / cookie（loopback 围栏同样生效）', () => {
  it('四条新路由都注册成 exact，且路径与契约一致（含回调路径取自 contract）', () => {
    const tested = harness()
    for (const path of NEW_ROUTES) {
      const route = routeFor(tested, path)
      expect(route.kind, path).toBe('exact')
    }
    expect(ROUTE_PATHS.oauthCallback).toBe('/api/dsh-codehub/oauth/callback')
    tested.dispose()
  })

  it('非本机调用四条新路由 → 403，且 handler 内部一次都没跑', async () => {
    for (const path of NEW_ROUTES) {
      const tested = harness()
      const response = await call(tested, path, { method: 'POST', remoteAddress: '10.0.0.5' })

      expect(response.statusCode, path).toBe(403)
      expect(JSON.parse(response.body), path).toEqual({ error: 'forbidden: loopback-only' })
      expect(tested.calls.probe, path).toEqual([])
      expect(tested.calls.oauthStart, path).toEqual([])
      expect(tested.calls.capture, path).toBe(0)
      expect(tested.calls.credentialSet, path).toEqual([])
    }
  })

  it('方法不匹配 → 405 并带 Allow（围栏先于方法判断）', async () => {
    const tested = harness()

    const oauth = await call(tested, ROUTE_PATHS.oauth, { method: 'PATCH' })
    expect(oauth.statusCode).toBe(405)
    expect(oauth.headers['allow']).toBe('GET, POST, DELETE')

    const callback = await call(tested, ROUTE_PATHS.oauthCallback, { method: 'POST' })
    expect(callback.statusCode).toBe(405)
    expect(callback.headers['allow']).toBe('GET')

    for (const path of [ROUTE_PATHS.probe, ROUTE_PATHS.cookies]) {
      const response = await call(tested, path, { method: 'GET' })
      expect(response.statusCode, path).toBe(405)
      expect(response.headers['allow'], path).toBe('POST')
      // 405 是围栏给的，handler 不该被调用。
      expect(tested.calls.oauthStart, path).toEqual([])
      expect(tested.calls.capture, path).toBe(0)
    }
  })

  it('/oauth POST start 的响应只出现 DESIGN §7.5 白名单字段，绝不出现 access_token', async () => {
    const tested = harness({ config: { github: { oauthClientId: 'client-id-public' } } })
    const response = await call(tested, ROUTE_PATHS.oauth, {
      method: 'POST',
      body: { action: 'start', source: 'github', method: 'oauth-device' },
    })

    expect(response.statusCode).toBe(200)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    // `ok` 是信封字段；其余必须是冻结白名单里的名字。
    expect(Object.keys(payload).sort()).toEqual(
      ['ok', 'flowId', 'kind', 'userCode', 'verificationUri', 'expiresIn', 'interval', 'status', 'reason', 'credentialConfigured'].sort(),
    )
    expect(payload['kind']).toBe('device')
    expect(payload['userCode']).toBe('ABCD-1234')
    expect(payload['status']).toBe('pending')
    expect('access_token' in payload).toBe(false)
    expect(response.body).not.toContain('access_token')
    expect(tested.calls.oauthStart).toHaveLength(1)
    // The client id comes from config, not from the browser.
    expect(tested.calls.oauthStart[0]?.['clientId']).toBe('client-id-public')
  })

  it('/oauth POST 携带 clientSecret 时：值进入引擎，但绝不回到响应体（sentinel 断言）', async () => {
    // The Gitee authorization-code flow is the ONE new inbound path where a
    // credential value travels from the browser into the host. It may only ever
    // reach the engine call, so the response is checked against the sentinel.
    const SECRET_SENTINEL = 'gitee_client_secret_SENTINEL_do_not_echo'
    const tested = harness({ config: { gitee: { oauthClientId: 'cid', oauthRedirectUri: 'http://127.0.0.1:1/cb' } } })

    const response = await call(tested, ROUTE_PATHS.oauth, {
      method: 'POST',
      body: {
        action: 'start',
        source: 'gitee',
        method: 'oauth-code',
        clientSecret: SECRET_SENTINEL,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain(SECRET_SENTINEL)
    // It did reach the engine — a body-supplied secret is accepted as a one-shot
    // fallback so the panel can collect it before the user saves it.
    expect(tested.calls.oauthStart).toHaveLength(1)
    expect(tested.calls.oauthStart[0]?.['clientSecret']).toBe(SECRET_SENTINEL)
  })

  it('/oauth 未配置 client id → 400，且一次 start 都不发起', async () => {
    const tested = harness({ config: {} })
    const response = await call(tested, ROUTE_PATHS.oauth, {
      method: 'POST',
      body: { action: 'start', source: 'github' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('oauthClientId')
    expect(tested.calls.oauthStart).toEqual([])
  })

  it('/oauth 引擎不可用时 → 503（不是假装成功）', async () => {
    const tested = harness({ oauth: false })
    const response = await call(tested, ROUTE_PATHS.oauth, { method: 'GET', url: `${ROUTE_PATHS.oauth}?flowId=f1` })

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: 'oauth-engine-unavailable' })
  })

  it('/oauth DELETE → cancel；GET 无 flowId → 400', async () => {
    const tested = harness()
    const cancelled = await call(tested, ROUTE_PATHS.oauth, {
      method: 'DELETE',
      url: `${ROUTE_PATHS.oauth}?flowId=flow-9`,
    })
    expect(cancelled.statusCode).toBe(200)
    expect(tested.calls.oauthCancel).toEqual(['flow-9'])
    expect(cancelled.body).not.toContain('access_token')

    const missing = await call(tested, ROUTE_PATHS.oauth, { method: 'GET' })
    expect(missing.statusCode).toBe(400)
  })

  it('/oauth/callback 返回自关闭 HTML（text/html，不带凭据）', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.oauthCallback, {
      url: `${ROUTE_PATHS.oauthCallback}?code=abc&state=xyz`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.body).toContain('<!doctype html>')
  })

  it('/probe 默认匿名：不解析任何凭据，逐操作给出 probedAt', async () => {
    const tested = harness()
    const response = await call(tested, ROUTE_PATHS.probe, { method: 'POST', body: {} })

    expect(response.statusCode).toBe(200)
    const payload = JSON.parse(response.body) as { ok: boolean; reports: Array<Record<string, unknown>> }
    expect(payload.ok).toBe(true)
    expect(payload.reports).toHaveLength(3)
    for (const report of payload.reports) {
      expect(report['authenticated']).toBe(false)
      expect(report['probedAt']).toEqual(expect.any(String))
    }
    // 默认匿名 = 一次 credentials.resolve 都没有。
    expect(tested.calls.credentialResolve).toBe(0)
    expect(tested.calls.probe.every((entry) => entry.useStoredCredential !== true)).toBe(true)

    const single = await call(tested, ROUTE_PATHS.probe, {
      method: 'POST',
      body: { source: 'gitee', useStoredCredential: true },
    })
    const singlePayload = JSON.parse(single.body) as { report: Record<string, unknown> }
    expect(singlePayload.report['source']).toBe('gitee')
    expect(tested.calls.probe.at(-1)).toEqual({ source: 'gitee', useStoredCredential: true })

    const bad = await call(tested, ROUTE_PATHS.probe, { method: 'POST', body: { source: 'bitbucket' } })
    expect(bad.statusCode).toBe(400)
  })

  it('/cookies 未开启 CDP → 403，一次捕获都不发起', async () => {
    const tested = harness({ config: { csdn: { cdpEnabled: false } } })
    const response = await call(tested, ROUTE_PATHS.cookies, { method: 'POST', body: { consent: true } })

    expect(response.statusCode).toBe(403)
    expect(tested.calls.capture).toBe(0)
    expect(tested.calls.credentialSet).toEqual([])
  })

  it('/cookies 缺少 consent → 403（同意不是默认值）', async () => {
    const tested = harness({ config: { csdn: { cdpEnabled: true } } })
    const response = await call(tested, ROUTE_PATHS.cookies, { method: 'POST', body: {} })

    expect(response.statusCode).toBe(403)
    expect(response.body).toContain('consent')
    expect(tested.calls.capture).toBe(0)
    expect(tested.calls.credentialSet).toEqual([])
  })

  it('/cookies 双闸门都通过 → 值只交给凭据服务，响应只有数量与名称', async () => {
    const tested = harness({ config: { csdn: { cdpEnabled: true, cdpPort: 9333 } } })
    const response = await call(tested, ROUTE_PATHS.cookies, { method: 'POST', body: { consent: true, port: 9222 } })

    expect(response.statusCode).toBe(200)
    expect(tested.calls.capture).toBe(1)
    expect(tested.calls.credentialSet).toEqual([{ ref: CREDENTIAL_REFS.csdn, value: 'SESS=super-secret-cookie' }])
    expect(response.body).not.toContain('super-secret-cookie')
    expect(response.body).not.toContain('SESS=super-secret-cookie')

    const payload = JSON.parse(response.body) as Record<string, unknown>
    expect(payload['count']).toBe(1)
    expect(payload['names']).toEqual(['SESS'])
    expect(payload['hosts']).toEqual([...CDP_COOKIE_HOSTS])
  })
})
