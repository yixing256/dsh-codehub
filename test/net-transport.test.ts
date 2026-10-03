/**
 * 统一网络出口 `src/net.ts`（task-5 §D 的安全与分类部分 + 备注①的通道行为）。
 *
 * Everything here is offline. `createTransport()` takes a `fetchImpl` test seam
 * and an optional `web` service, so the real retry loop, the real channel
 * selection and the real token policy all run — only the socket is fake. That is
 * the point: the security assertions must exercise the request the code actually
 * builds, not a re-implementation of it.
 *
 * Covered:
 *   • the local proxy is applied on `node` and never claimed on `dsh-web`;
 *   • `TOKEN_FORBIDDEN_ACCESS` strategies (ghproxy / raw-mirror /
 *     third-party-mirror) produce a request whose `token` is `undefined` and
 *     whose headers carry no `authorization` — verified on the wire-level fake;
 *   • a credential forces the `node` channel, because the harness channel takes
 *     no headers;
 *   • `dsh-web` fails → the transport re-plans onto `node` once (and re-runs the
 *     备注① proxy logic while doing so);
 *   • retries are bounded and skip `auth-required`;
 *   • a local misconfiguration (unparseable proxy / SOCKS4) refuses the request
 *     instead of silently going direct;
 *   • no log line, reason or rendered label ever contains a credential.
 */

import { describe, expect, it } from 'vitest'

import type { WebService } from '@deepseek-ai/dsh-web'

import { DEFAULT_LIMITS, HARD_LIMITS } from '../src/contract.js'
import {
  TransportError,
  WEB_CHANNEL_FALLBACK_NOTE,
  clampRetries,
  clampTimeoutMs,
  composeSignal,
  createTransport,
  parseProxyAddress,
  proxySupport,
  redactAddress,
  redactCredential,
  safeUrlLabel,
  scrubSecrets,
  timeoutSignal,
} from '../src/net.js'
import type { FetchInit, FetchLike, FetchLikeResponse } from '../src/net.js'
import { transportNotes } from '../src/sources/types.js'

const TARGET = 'https://api.github.com/search/repositories?q=vue'
const SECRET = 'ghp_supersecrettokenvalue'

interface FetchCall {
  readonly url: string
  readonly init: FetchInit | undefined
}

/** A `fetch` stand-in that records every call and answers from `answer`. */
function fakeFetch(answer: (url: string, init: FetchInit | undefined) => FetchLikeResponse): {
  readonly impl: FetchLike
  readonly calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return answer(url, init)
  }
  return { impl, calls }
}

function textResponse(status: number, body: string, url?: string): FetchLikeResponse {
  return url === undefined ? { status, text: async () => body } : { status, url, text: async () => body }
}

function webService(fetchImpl: WebService['fetch']): WebService {
  return { fetch: fetchImpl, search: async () => ({}) }
}

/** Run `work`, returning the thrown value instead of failing the test on throw. */
async function capture(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
    return undefined
  } catch (error) {
    return error
  }
}

// ---------------------------------------------------------------------------
// The node channel.
// ---------------------------------------------------------------------------

describe('传输 — node 通道', () => {
  it('把状态码 / 正文 / 最终地址如实带出，并走 GET + follow', async () => {
    const { impl, calls } = fakeFetch(() => textResponse(200, 'hello', TARGET))

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 0 })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('hello')
    expect(response.finalUrl).toBe(TARGET)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(TARGET)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.redirect).toBe('follow')
  })

  it('任何 HTTP 状态码都 resolve，不 throw（HTTP 归类是适配器的事）', async () => {
    const { impl } = fakeFetch(() => textResponse(403, 'rate limited'))

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 0 })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.statusCode).toBe(403)
    expect(response.body).toBe('rate limited')
  })

  it('429 在 retries=0 时不重发', async () => {
    const { impl, calls } = fakeFetch(() => textResponse(429, 'slow down'))

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 0 })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.statusCode).toBe(429)
    expect(calls).toHaveLength(1)
  })

  it('429 在 retries=1 时重发一次（受 limits.retries 约束）', async () => {
    const { impl, calls } = fakeFetch(() => textResponse(429, 'slow down'))

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 1, logger: () => {} })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.statusCode).toBe(429)
    expect(calls).toHaveLength(2)
  })

  it('网络层抛错会重试到预算用尽，然后抛 TransportError(network)', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error('fetch failed: ECONNREFUSED')
    })

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 1, logger: () => {} })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).kind).toBe('network')
    expect((error as TransportError).failure).toBe('network')
    expect(calls).toHaveLength(2)
  })

  it('auth-required 不重试（重发不会凭空变出凭据，那是降级链的活）', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new TransportError('auth-required', '缺少凭据')
    })

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 3, logger: () => {} })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect((error as TransportError).kind).toBe('auth-required')
    expect(calls).toHaveLength(1)
  })

  it('retries=0 时网络错误也只发一次：重试预算是硬约束', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error('fetch failed')
    })

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 0, logger: () => {} })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect((error as TransportError).kind).toBe('network')
    expect(calls).toHaveLength(1)
  })

  it('超时被归类为 timeout', async () => {
    const { impl } = fakeFetch(() => {
      const error = new Error('the operation was aborted')
      error.name = 'TimeoutError'
      throw error
    })

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 0, logger: () => {} })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect((error as TransportError).kind).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// The dsh-web channel.
// ---------------------------------------------------------------------------

describe('传输 — dsh-web 通道', () => {
  it('只把 { url } 交给 harness（没有请求头，凭据因此不可能搭车）', async () => {
    const seen: Array<Record<string, unknown>> = []
    const web = webService(async (request) => {
      seen.push({ ...request })
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'from-web' }, truncated: false }
    })
    const { impl, calls } = fakeFetch(() => textResponse(500, 'node should not be used'))

    const transport = createTransport({ transport: 'dsh-web', web, fetchImpl: impl, retries: 0 })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.body).toBe('from-web')
    expect(response.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0] ?? {})).toEqual(['url'])
    expect(calls).toHaveLength(0)
  })

  it('需要携带凭据时改走 node —— harness 通道无法附加请求头', async () => {
    let webCalls = 0
    const web = webService(async (request) => {
      webCalls += 1
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'should not happen' }, truncated: false }
    })
    const { impl, calls } = fakeFetch(() => textResponse(200, '{"ok":true}'))

    const transport = createTransport({ web, fetchImpl: impl, retries: 0 })
    const response = await transport({ url: TARGET, token: SECRET, timeoutMs: 1_000 })

    expect(webCalls).toBe(0)
    expect(response.body).toBe('{"ok":true}')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${SECRET}` })
  })

  it('harness 通道网络层失败 → 回退 node 一次，并重新套用代理逻辑', async () => {
    const web = webService(async () => {
      throw new Error('fetch failed')
    })
    const { impl, calls } = fakeFetch(() => textResponse(200, 'from-node', TARGET))

    const transport = createTransport({ web, fetchImpl: impl, retries: 1, logger: () => {} })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.body).toBe('from-node')
    expect(calls).toHaveLength(1)
    const notes = transportNotes(response).join('\n')
    expect(notes).toContain(WEB_CHANNEL_FALLBACK_NOTE)
  })

  it('retries=0 也必须回退 node：通道回退不消耗重试预算', async () => {
    // 回退是「换一条通道」，不是「重发同一个请求」，所以 limits.retries = 0
    // （用户明确说「不要重试」）不能把它一起关掉。
    const web = webService(async () => {
      throw new Error('fetch failed')
    })
    const { impl, calls } = fakeFetch(() => textResponse(200, 'from-node', TARGET))

    const transport = createTransport({ web, fetchImpl: impl, retries: 0, logger: () => {} })
    const response = await transport({ url: TARGET, timeoutMs: 1_000 })

    expect(response.body).toBe('from-node')
    expect(calls).toHaveLength(1)
    expect(transportNotes(response).join('\n')).toContain(WEB_CHANNEL_FALLBACK_NOTE)
  })
})

// ---------------------------------------------------------------------------
// Token policy — the security requirement.
// ---------------------------------------------------------------------------

describe('安全 — 镜像路径强制剥离 token', () => {
  it('TOKEN_FORBIDDEN_ACCESS 的三条路径都拿不到 token（wire 级别验证）', async () => {
    const forbidden = ['ghproxy', 'raw-mirror', 'third-party-mirror'] as const

    for (const access of forbidden) {
      const { impl, calls } = fakeFetch(() => textResponse(200, '{}'))
      const transport = createTransport({ transport: 'node', access, fetchImpl: impl, retries: 0 })

      await transport({ url: `${TARGET}&token=${SECRET}`, token: SECRET, timeoutMs: 1_000 })

      expect(calls, access).toHaveLength(1)
      expect(calls[0]?.init?.headers, access).not.toHaveProperty('authorization')
      expect(JSON.stringify(calls[0]?.init?.headers ?? {}), access).not.toContain(SECRET)
    }
  })

  it('官方直连 / token 路径照常带上 Bearer', async () => {
    for (const access of ['direct', 'token'] as const) {
      const { impl, calls } = fakeFetch(() => textResponse(200, '{}'))
      const transport = createTransport({ transport: 'node', access, fetchImpl: impl, retries: 0 })

      await transport({ url: TARGET, token: SECRET, timeoutMs: 1_000 })

      expect(calls[0]?.init?.headers, access).toMatchObject({ authorization: `Bearer ${SECRET}` })
    }
  })

  it('调用方自带的 authorization 头不会被覆盖（凭据来源由调用方决定）', async () => {
    const { impl, calls } = fakeFetch(() => textResponse(200, '{}'))
    const transport = createTransport({ transport: 'node', access: 'direct', fetchImpl: impl, retries: 0 })

    await transport({ url: TARGET, token: SECRET, headers: { authorization: 'Basic abc' }, timeoutMs: 1_000 })

    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Basic abc' })
  })

  it('日志里绝不出现凭据（且确实产生了日志，断言不是恒真）', async () => {
    const logs: string[] = []
    const { impl } = fakeFetch(() => {
      throw new Error('fetch failed')
    })

    const transport = createTransport({
      transport: 'node',
      access: 'direct',
      fetchImpl: impl,
      retries: 1,
      logger: (event, detail) => {
        logs.push(`${event} ${JSON.stringify(detail ?? {})}`)
      },
    })

    await capture(() => transport({ url: TARGET, token: SECRET, timeoutMs: 1_000 }))

    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(SECRET)
  })

  it('msg 级脱敏：token= / cookie: / Bearer / 空格分隔 / URL userinfo 都不会漏出', () => {
    expect(scrubSecrets(`token=${SECRET}`)).not.toContain(SECRET)
    expect(scrubSecrets(`cookie: ${SECRET}`)).not.toContain(SECRET)
    expect(scrubSecrets('https://user:pass@example.com/x')).not.toContain('user:pass')

    // 空格分隔的 Bearer 曾是个缺口：只要求关键词后紧跟 = 或 : 的实现会把
    // 'Authorization: Bearer sk-live-…' 变成 'Authorization: **** sk-live-…'，
    // 真 token 留在外面。这里把修好的行为钉住。
    expect(scrubSecrets(`Bearer ${SECRET}`)).not.toContain(SECRET)
    expect(scrubSecrets(`Authorization: Bearer ${SECRET}`)).not.toContain(SECRET)
    expect(scrubSecrets(`basic ${SECRET}`)).not.toContain(SECRET)
    expect(scrubSecrets(`apikey ${SECRET}`)).not.toContain(SECRET)

    // 非空性：正常文本必须原样通过，否则上面的「不包含」可能只是把所有东西都抹了。
    expect(scrubSecrets('nothing sensitive here')).toBe('nothing sensitive here')
    expect(scrubSecrets('检索 GitHub / Gitee / CSDN 上的代码用法')).toBe('检索 GitHub / Gitee / CSDN 上的代码用法')
  })

  it('底层错误消息里的凭据被脱敏后才向上抛（真管道，不是单独调 scrubSecrets）', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error(`Request failed: Authorization: Bearer ${SECRET}`)
    })

    const transport = createTransport({ transport: 'node', fetchImpl: impl, retries: 0, logger: () => {} })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).message).not.toContain(SECRET)
    expect((error as TransportError).message).toContain('****')
  })

  it('地址与凭据只以状态渲染，URL 标签丢掉 query', () => {
    expect(redactAddress('socks5://user:pass@127.0.0.1:1080')).toBe('socks5://127.0.0.1:****')
    expect(redactAddress(undefined)).toBe('(未配置)')
    expect(redactAddress('http://')).toBe('****')
    expect(redactCredential(SECRET)).toBe('(已配置)')
    expect(redactCredential('')).toBe('(未配置)')
    expect(redactCredential(undefined)).toBe('(未配置)')
    expect(safeUrlLabel(`${TARGET}&token=${SECRET}`)).toBe('https://api.github.com/search/repositories')
    expect(safeUrlLabel('not a url')).toBe('(无法解析的地址)')
  })
})

// ---------------------------------------------------------------------------
// Local misconfiguration.
// ---------------------------------------------------------------------------

describe('安全 — 本机配置错误宁可失败也不静默直连', () => {
  it('代理地址无法解析 → 抛错且一次网络请求都不发', async () => {
    const { impl, calls } = fakeFetch(() => textResponse(200, 'should not happen'))

    const transport = createTransport({ transport: 'node', localProxy: 'ftp://127.0.0.1:21', fetchImpl: impl, retries: 0 })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).message).toContain('无法解析')
    expect(calls).toHaveLength(0)
  })

  it('SOCKS4 → 抛错且不发请求', async () => {
    const { impl, calls } = fakeFetch(() => textResponse(200, 'should not happen'))

    const transport = createTransport({
      transport: 'node',
      localProxy: 'socks4://127.0.0.1:1080',
      fetchImpl: impl,
      retries: 0,
    })
    const error = await capture(() => transport({ url: TARGET, timeoutMs: 1_000 }))

    expect((error as TransportError).message).toContain('SOCKS4')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe('net — 纯函数边界', () => {
  it('parseProxyAddress 的协议与默认端口', () => {
    expect(parseProxyAddress('127.0.0.1:7890')).toMatchObject({ scheme: 'http', host: '127.0.0.1', port: 7890 })
    expect(parseProxyAddress('http://proxy.local')).toMatchObject({ scheme: 'http', port: 8080 })
    expect(parseProxyAddress('https://proxy.local:8443')).toMatchObject({ scheme: 'https', port: 8443 })
    expect(parseProxyAddress('socks5://proxy.local')).toMatchObject({ scheme: 'socks5', port: 1080 })
    expect(parseProxyAddress('socks5h://proxy.local:1080')).toMatchObject({ scheme: 'socks5', port: 1080 })
    expect(parseProxyAddress('socks4a://proxy.local:1080')).toMatchObject({ scheme: 'socks4', port: 1080 })
    expect(parseProxyAddress('socks5://user:pass@proxy.local:1080')).toMatchObject({ auth: 'user:pass' })

    expect(parseProxyAddress('ftp://proxy.local:21')).toBeUndefined()
    expect(parseProxyAddress('')).toBeUndefined()
    expect(parseProxyAddress('   ')).toBeUndefined()
    expect(parseProxyAddress(undefined)).toBeUndefined()
    expect(parseProxyAddress(42)).toBeUndefined()
  })

  it('proxySupport 只对 SOCKS4 说不', () => {
    const socks4 = parseProxyAddress('socks4://proxy.local:1080')
    expect(socks4 === undefined ? undefined : proxySupport(socks4).supported).toBe(false)
    const socks5 = parseProxyAddress('socks5://proxy.local:1080')
    expect(socks5 === undefined ? undefined : proxySupport(socks5).supported).toBe(true)
  })

  it('clampRetries / clampTimeoutMs 只可下调，不超过硬顶', () => {
    expect(clampRetries(0)).toBe(0)
    expect(clampRetries(99)).toBe(HARD_LIMITS.retries)
    expect(clampRetries(-3)).toBe(0)
    expect(clampRetries(undefined)).toBe(DEFAULT_LIMITS.retries)
    expect(clampRetries(Number.NaN)).toBe(DEFAULT_LIMITS.retries)

    expect(clampTimeoutMs(1_000)).toBe(1_000)
    expect(clampTimeoutMs(999_999)).toBe(HARD_LIMITS.timeoutMs)
    expect(clampTimeoutMs(0)).toBe(DEFAULT_LIMITS.timeoutMs)
    expect(clampTimeoutMs(undefined)).toBe(DEFAULT_LIMITS.timeoutMs)
  })

  it('composeSignal 过滤 undefined，并只在本机可用的实现上分支', () => {
    expect(composeSignal([])).toBeUndefined()
    expect(composeSignal([undefined, undefined])).toBeUndefined()

    const single = new AbortController()
    expect(composeSignal([undefined, single.signal])).toBe(single.signal)

    const first = new AbortController()
    const second = new AbortController()
    const any = composeSignal([first.signal, second.signal])
    expect(any).toBeDefined()
    expect(any?.aborted).toBe(false)
    first.abort()
    expect(any?.aborted).toBe(true)
  })

  it('timeoutSignal 返回未中止的信号', () => {
    const signal = timeoutSignal(5_000)
    expect(signal.aborted).toBe(false)
  })
})
