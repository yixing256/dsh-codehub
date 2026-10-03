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
  CSDN_API_NOTE,
  DECISION_GUIDE,
  DEFAULT_LIMITS,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_SCOPE_NOTE,
} from '../src/contract.js'
import type { UnresolvedDecision } from '../src/contract.js'
import { resolveConfig } from '../src/config.js'
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
    disposers: number
  }
  readonly dispose: () => void
}

function harness(options: { readonly unresolved?: readonly UnresolvedDecision[]; readonly credentials?: boolean } = {}): Harness {
  const routes: WebRoute[] = []
  const calls: Harness['calls'] = {
    describeConfig: 0,
    getUnresolved: 0,
    deepRead: 0,
    credentialStatus: 0,
    credentialSet: [],
    credentialUnset: 0,
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
    async smoke() {
      return { ok: true, probes: [], notes: [] }
    },
    async resolve() {
      // A REAL resolved config: the decisions route reads nested paths off it.
      return resolveConfig({})
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
        }

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
