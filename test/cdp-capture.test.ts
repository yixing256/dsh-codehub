/**
 * `src/cdp.ts` — 实验性 CDP cookie 抓取（task-1 W1-B）。
 *
 * Offline by construction: the debugger probe takes an injected `fetchImpl`, the
 * websocket takes an injected `wsFactory`, and neither the real port 9222 nor a
 * real browser is ever touched. What must hold here is the privacy contract —
 * the `cookieHeader` is produced for the credential service and for nothing
 * else: no failure reason, no log and no returned field may carry a cookie
 * value (only NAMES are safe).
 */

import { describe, expect, it, vi } from 'vitest'

import { CDP_COOKIE_HOSTS } from '../src/contract.js'
import { captureBrowserCookies } from '../src/cdp.js'
import type { WebSocketFactory, WebSocketLike } from '../src/cdp.js'
import type { FetchInit, FetchLike, FetchLikeResponse } from '../src/net.js'

const COOKIE_SENTINEL = 'SENTINEL_SESSION_VALUE_do_not_leak'
const DEBUGGER_URL = 'ws://127.0.0.1:9222/devtools/browser/abcdef'

interface FetchCall {
  readonly url: string
  readonly init: FetchInit | undefined
}

function fetchStub(answer: (url: string) => FetchLikeResponse | Promise<FetchLikeResponse>): {
  readonly impl: FetchLike
  readonly calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return await answer(url)
  }
  return { impl, calls }
}

function versionResponse(debuggerUrl: string): FetchLikeResponse {
  return { status: 200, text: async () => JSON.stringify({ Browser: 'Chrome/120', webSocketDebuggerUrl: debuggerUrl }) }
}

interface FakeSocket {
  readonly socket: WebSocketLike
  readonly sent: string[]
  /** Deliver a CDP reply as the browser would. */
  emitMessage(payload: unknown): void
  emitClose(): void
  /** The websocket finished its handshake. */
  emitOpen(): void
  emitError(): void
}

/**
 * A socket that records what was sent and lets the test drive the replies.
 *
 * Defaults to `readyState: 1` (OPEN) because most tests are about the CDP exchange
 * itself; `connecting: true` models a real handshake — the state in which the live
 * check found a bug (sending before OPEN threw and was reported as a timeout).
 */
function fakeSocket(options: { readonly connecting?: boolean } = {}): FakeSocket {
  const sent: string[] = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const socket: WebSocketLike = {
    get readyState() {
      return options.connecting === true ? 0 : 1
    },
    send: (data: string) => {
      sent.push(data)
    },
    close: () => {},
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
  }
  const emit = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  return {
    socket,
    sent,
    emitMessage: (payload) => emit('message', { data: JSON.stringify(payload) }),
    emitClose: () => emit('close', {}),
    emitOpen: () => emit('open', {}),
    emitError: () => emit('error', {}),
  }
}

/**
 * A CDP cookie reply. Cookies default to a `.csdn.net` domain because a
 * browser-wide `Storage.getCookies` answer always carries one, and the engine
 * scopes that answer to the requested hosts before it becomes a credential
 * (see `cookieMatchesHosts` in src/cdp.ts).
 */
function cookieReply(cookies: Array<{ name: string; value: string; domain?: string }>): unknown {
  return { id: 1, result: { cookies: cookies.map((cookie) => ({ domain: '.csdn.net', ...cookie })) } }
}

describe('CDP cookie 抓取', () => {
  it('没有 consent 时拒绝，且不碰网络也不开 websocket', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const wsFactory = vi.fn(() => fakeSocket().socket) as unknown as WebSocketFactory

    const result = await captureBrowserCookies(
      { port: 9222, consent: false, fetchImpl: fetchImpl.impl, wsFactory },
      {},
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('consent-required')
    expect(fetchImpl.calls).toHaveLength(0)
    expect(wsFactory).not.toHaveBeenCalled()
  })

  it('端口不合法时拒绝，不发请求', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))

    for (const port of [0, -1, 70_000, 1.5]) {
      const result = await captureBrowserCookies({ port, consent: true, fetchImpl: fetchImpl.impl }, {})
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.failure).toBe('unavailable')
    }
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('成功：GET /json/version → Storage.getCookies（browser 作用域）→ 只保留请求站点，拼出 cookieHeader 与 names', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket()
    const wsFactory: WebSocketFactory = (url) => {
      expect(url).toBe(DEBUGGER_URL)
      return fake.socket
    }

    const capture = captureBrowserCookies({ port: 9222, consent: true, fetchImpl: fetchImpl.impl, wsFactory })
    // The engine's first act after connecting is the CDP request.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.sent).toHaveLength(1)
    const request = JSON.parse(fake.sent[0] ?? '{}') as { id: number; method: string; params: unknown }
    // Browser scope needs no page attachment, so this is the FIRST attempt.
    expect(request.method).toBe('Storage.getCookies')
    expect(request.params).toEqual({})

    fake.emitMessage(
      cookieReply([
        { name: 'csrfToken', value: 'abc', domain: '.csdn.net' },
        { name: 'SESSION', value: COOKIE_SENTINEL, domain: '.csdn.net' },
        { name: 'SESSION', value: 'duplicate-must-not-win', domain: 'blog.csdn.net' },
        // A browser-wide answer also carries OTHER sites' cookies: they must not
        // ride along into the CSDN credential.
        { name: 'unrelated', value: 'OTHER_SITE_SENTINEL', domain: '.example.com' },
      ]),
    )

    const result = await capture
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a capture')
    expect(result.cookieHeader).toBe(`csrfToken=abc; SESSION=${COOKIE_SENTINEL}`)
    expect(result.names).toEqual(['csrfToken', 'SESSION'])
    expect(result.hosts).toEqual(['www.csdn.net', 'so.csdn.net', 'blog.csdn.net'])
    expect(result.cookieHeader).not.toContain('OTHER_SITE_SENTINEL')
    expect(fetchImpl.calls[0]?.url).toBe('http://127.0.0.1:9222/json/version')
  })

  it('browser 端点拒绝 Storage 方法时：报 CDP 自己的错误（不是超时），并回退到页面 target 的 Network.getCookies', async () => {
    const pageWs = 'ws://127.0.0.1:9222/devtools/page/page-1'
    const fetchImpl = fetchStub((url) =>
      url.endsWith('/json/list')
        ? { status: 200, text: async () => JSON.stringify([{ type: 'page', url: 'https://www.csdn.net/', webSocketDebuggerUrl: pageWs }]) }
        : versionResponse(DEBUGGER_URL),
    )
    const browserSocket = fakeSocket()
    const pageSocket = fakeSocket()
    const wsFactory: WebSocketFactory = (url) => (url === pageWs ? pageSocket.socket : browserSocket.socket)

    const capture = captureBrowserCookies({ port: 9222, consent: true, fetchImpl: fetchImpl.impl, wsFactory })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The browser-scope attempt is refused by the browser itself.
    browserSocket.emitMessage({ id: 1, error: { code: -32601, message: "'Storage.getCookies' wasn't found" } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:9222/json/version',
      'http://127.0.0.1:9222/json/list',
    ])
    const request = JSON.parse(pageSocket.sent[0] ?? '{}') as { method: string; params: { urls: string[] } }
    expect(request.method).toBe('Network.getCookies')
    expect(request.params.urls).toEqual([...CDP_COOKIE_HOSTS])

    pageSocket.emitMessage(cookieReply([{ name: 'SESSION', value: COOKIE_SENTINEL }]))

    const result = await capture
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a capture')
    expect(result.cookieHeader).toBe(`SESSION=${COOKIE_SENTINEL}`)
  })

  it('两种方法都被拒绝 → unsupported 且立刻返回（不伪装成超时）', async () => {
    const fetchImpl = fetchStub((url) =>
      url.endsWith('/json/list') ? { status: 200, text: async () => '[]' } : versionResponse(DEBUGGER_URL),
    )
    const fake = fakeSocket()

    const started = Date.now()
    const capture = captureBrowserCookies({
      port: 9222,
      consent: true,
      timeoutMs: 5_000,
      fetchImpl: fetchImpl.impl,
      wsFactory: () => fake.socket,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.emitMessage({ id: 1, error: { code: -32601, message: 'Method not found' } })

    const result = await capture
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('unsupported')
    expect(result.reason).toContain('Method not found')
    expect(result.reason).toContain('Storage.getCookies')
    // It must not have waited for the 5s timeout to say so.
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  /*
   * MEASURED LIVE against real Chrome: the capture used to `send()` while the
   * websocket was still CONNECTING. `send()` throws in that state, the throw was
   * mapped to the timeout reason, and the user was told to check a port that was
   * listening perfectly. These two tests pin the corrected handshake.
   */
  it('CONNECTING 状态不发请求：握手完成后才发出（真实 Chrome 上的那个 bug）', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket({ connecting: true })

    const capture = captureBrowserCookies({
      port: 9222,
      consent: true,
      fetchImpl: fetchImpl.impl,
      wsFactory: () => fake.socket,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Nothing may be sent yet: sending while CONNECTING is what threw.
    expect(fake.sent).toHaveLength(0)

    fake.emitOpen()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.sent).toHaveLength(1)

    fake.emitMessage(cookieReply([{ name: 'SESSION', value: COOKIE_SENTINEL }]))
    const result = await capture
    expect(result.ok).toBe(true)
  })

  it('握手失败（error / close）→ 报「握手」，不再说成「超时」', async () => {
    for (const fail of ['error', 'close'] as const) {
      const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
      const fake = fakeSocket({ connecting: true })
      const capture = captureBrowserCookies({
        port: 9222,
        consent: true,
        timeoutMs: 5_000,
        fetchImpl: fetchImpl.impl,
        wsFactory: () => fake.socket,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (fail === 'error') fake.emitError()
      else fake.emitClose()

      const result = await capture
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      // A port that IS listening must never be described as a timeout.
      expect(result.reason).toContain('握手')
      expect(result.reason).not.toContain('超时')
    }
  })

  it('调试端口不可达 → unavailable，且 reason 里没有任何 cookie 值', async () => {
    const refused = fetchStub(() => {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:9222 ${COOKIE_SENTINEL}`)
    })

    const result = await captureBrowserCookies({ port: 9222, consent: true, fetchImpl: refused.impl }, {})

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('network')
    expect(result.reason).not.toContain(COOKIE_SENTINEL)
  })

  it('/json/version 返回非 200 或缺 webSocketDebuggerUrl → unavailable，不开 websocket', async () => {
    const notFound = fetchStub(() => ({ status: 404, text: async () => 'not found' }))
    const wsFactory = vi.fn(() => fakeSocket().socket) as unknown as WebSocketFactory

    const result = await captureBrowserCookies(
      { port: 9222, consent: true, fetchImpl: notFound.impl, wsFactory },
      {},
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('unavailable')
    expect(wsFactory).not.toHaveBeenCalled()

    const junk = fetchStub(() => ({ status: 200, text: async () => 'not json at all' }))
    const second = await captureBrowserCookies({ port: 9222, consent: true, fetchImpl: junk.impl }, {})
    expect(second.ok).toBe(false)
  })

  it('webSocketDebuggerUrl 不是本机地址 → unavailable（不对外拨号）', async () => {
    const remote = fetchStub(() => versionResponse('ws://10.0.0.5:9222/devtools/browser/x'))
    const wsFactory = vi.fn(() => fakeSocket().socket) as unknown as WebSocketFactory

    const result = await captureBrowserCookies({ port: 9222, consent: true, fetchImpl: remote.impl, wsFactory }, {})

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('unavailable')
    expect(wsFactory).not.toHaveBeenCalled()
  })

  it('浏览器里没有该站 cookie → empty，且不返回 cookieHeader', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket()
    const capture = captureBrowserCookies({
      port: 9222,
      consent: true,
      fetchImpl: fetchImpl.impl,
      wsFactory: () => fake.socket,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.emitMessage(cookieReply([]))

    const result = await capture
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('empty')
    expect(result.reason).not.toContain(COOKIE_SENTINEL)
  })

  it('websocket 一直不回 → 超时返回 network，且不泄漏任何值', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket()

    const result = await captureBrowserCookies(
      { port: 9222, consent: true, timeoutMs: 30, fetchImpl: fetchImpl.impl, wsFactory: () => fake.socket },
      {},
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('network')
    expect(result.reason).not.toContain(COOKIE_SENTINEL)
  })

  it('websocket 在回应前断开 → network', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket()
    const capture = captureBrowserCookies({
      port: 9222,
      consent: true,
      timeoutMs: 200,
      fetchImpl: fetchImpl.impl,
      wsFactory: () => fake.socket,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.emitClose()

    const result = await capture
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('network')
  })

  it('deps 里的 fetchImpl/wsFactory 优先于 input，且 origins 可覆盖', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket()
    const capture = captureBrowserCookies(
      { port: 9333, consent: true, origins: ['csdn.net'] },
      { fetchImpl: fetchImpl.impl, wsFactory: () => fake.socket },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchImpl.calls[0]?.url).toBe('http://127.0.0.1:9333/json/version')
    // Browser scope takes no URL list; the requested origins are applied as a
    // host filter on the answer instead (asserted through `result.hosts` below).
    const request = JSON.parse(fake.sent[0] ?? '{}') as { method: string; params: unknown }
    expect(request.method).toBe('Storage.getCookies')
    expect(request.params).toEqual({})

    fake.emitMessage(cookieReply([{ name: 'a', value: 'b' }]))
    const result = await capture
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a capture')
    expect(result.hosts).toEqual(['csdn.net'])
  })

  it('非 CDP 的杂音消息被忽略，只认 id = 1 的回复', async () => {
    const fetchImpl = fetchStub(() => versionResponse(DEBUGGER_URL))
    const fake = fakeSocket()
    const capture = captureBrowserCookies({
      port: 9222,
      consent: true,
      timeoutMs: 200,
      fetchImpl: fetchImpl.impl,
      wsFactory: () => fake.socket,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    fake.emitMessage({ method: 'Network.requestWillBeSent', params: { requestId: '1' } })
    fake.emitMessage({ id: 99, result: { cookies: [{ name: 'other', value: 'ignored', domain: '.csdn.net' }] } })
    fake.emitMessage({ id: 1, result: { cookies: [{ name: 'keep', value: 'yes', domain: '.csdn.net' }] } })

    const result = await capture
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a capture')
    expect(result.cookieHeader).toBe('keep=yes')
    expect(result.names).toEqual(['keep'])
  })
})
