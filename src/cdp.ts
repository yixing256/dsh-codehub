/**
 * dsh-codehub — experimental cookie capture over the browser debug port (CDP).
 *
 * INTERFACE FROZEN IN PHASE 0 (docs/DESIGN.md §7). W1 implements the bodies;
 * `src/routes.ts` (`POST /api/dsh-codehub/cookies`) and the wizard call it.
 *
 * WHY THIS IS OPT-IN AND OFF BY DEFAULT
 * -------------------------------------
 * CSDN exposes no OAuth and no token API, so a session cookie is the only
 * credential — and its session cookies may be HttpOnly, which makes the common
 * "run document.cookie in the console" advice useless. Reading them from the
 * browser is therefore the only automated path, and it has a real cost: the
 * user must start their browser with `--remote-debugging-port`, which exposes a
 * port any local process can talk to. That trade is the user's to make, so:
 *
 *   • `csdn.cdpEnabled` must be true (default false) AND
 *   • the request must carry `consent: true`, and the UI must have shown the
 *     warning text — a missing consent is a refusal, not a default.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * No browser is spawned or bundled; no cookie database is read (Chrome's
 * DPAPI/App-Bound encryption is deliberately out of scope); no root CA is
 * installed; no proxy is started. It opens one websocket to 127.0.0.1 and asks
 * `Network.getCookies` for the requested origins.
 *
 * PRIVACY OF THE RESULT
 * ---------------------
 * The returned `cookieHeader` is the one value that must reach the credential
 * service and nothing else: not a log line, not an HTTP response, not a thrown
 * error. The response shape the browser half sees carries NAMES and COUNTS.
 */

import { CDP_COOKIE_HOSTS } from './contract.js'
import type { FetchLike } from './net.js'

/** The minimal websocket surface this module needs (global `WebSocket` fits). */
export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener?(type: string, listener: (event: unknown) => void): void
  on?(type: string, listener: (...args: never[]) => void): void
  /**
   * `0` = CONNECTING, `1` = OPEN. Optional because a test double may not model it;
   * when it is missing the send goes out immediately (see `readCookies`).
   */
  readonly readyState?: number
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface CdpCaptureInput {
  /** Debug port on 127.0.0.1. Non-loopback hosts are refused. */
  readonly port: number
  /** Origins whose cookies are collected. Defaults to `CDP_COOKIE_HOSTS`. */
  readonly origins?: readonly string[]
  /** Must be literally true; anything else is a refusal. */
  readonly consent: boolean
  readonly timeoutMs?: number
  /** Test seams. */
  readonly fetchImpl?: FetchLike
  readonly wsFactory?: WebSocketFactory
}

export type CdpFailure = 'consent-required' | 'unavailable' | 'network' | 'empty' | 'unsupported'

export interface CdpCaptureOk {
  readonly ok: true
  /**
   * The `name=value; name=value` header. Callers hand this straight to the
   * credential service; it must never be echoed, logged or persisted.
   */
  readonly cookieHeader: string
  /** Cookie NAMES only — safe to show the user. */
  readonly names: readonly string[]
  readonly hosts: readonly string[]
}

export interface CdpCaptureFailure {
  readonly ok: false
  readonly failure: CdpFailure
  /** Value-free explanation, safe to render and to log. */
  readonly reason: string
}

export type CdpCaptureResult = CdpCaptureOk | CdpCaptureFailure

export interface CdpDeps {
  readonly fetchImpl?: FetchLike
  readonly wsFactory?: WebSocketFactory
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_HOST_ORIGIN = 'https://www.csdn.net'
/**
 * A page the capture prefers to attach to when it must go through the page-scoped
 * `Network` domain. `Storage.getCookies` (browser scope) is tried first because it
 * needs no attachment at all — see `captureBrowserCookies()`.
 */
const CDP_PAGE_URL = 'https://www.csdn.net/'

/** Every reason string below is a constant: none can carry a cookie value. */
const REASON_CONSENT = '需要你显式确认后再读取浏览器 cookie。'
const REASON_BAD_PORT = '调试端口必须是 1–65535 的本机端口（只允许 127.0.0.1）。'
const REASON_NO_WS = '当前运行环境没有 WebSocket，无法连接浏览器调试端口。'
const REASON_ENDPOINT = '浏览器调试端口没有响应 /json/version：请确认浏览器是以 --remote-debugging-port 启动的。'
const REASON_DEBUGGER_URL = '调试端口返回的 webSocketDebuggerUrl 不可用或不是本机地址。'
const REASON_TIMEOUT = '连接浏览器调试端口超时，未取到任何 cookie。'
/**
 * A websocket that never OPENED.
 *
 * MEASURED LIVE against real Chrome: the first version called `send()` while the
 * socket was still CONNECTING, `send()` threw, and the throw was reported as the
 * timeout above — i.e. the user was told to check a port that was listening fine.
 * A handshake failure is its own diagnosis, so it gets its own sentence.
 */
const REASON_HANDSHAKE =
  '与调试端口的 WebSocket 握手失败：端口可能没有监听、浏览器拒绝了本次来源，或进程已退出。' +
  'launcher 启动的浏览器已带 --remote-allow-origins=*；如果是你自己启动的浏览器，请确认也加了该参数。'
/** A request that failed to leave an OPEN socket. Distinct from both above. */
const REASON_SEND_FAILED = '向调试端口发送请求失败：'
const REASON_EMPTY = '浏览器里没有这些站点的 cookie：请先在浏览器登录 CSDN。'
/** Prefix for a CDP-level rejection; the engine's own message is appended. */
const REASON_CDP_REJECTED = '浏览器调试端口拒绝了这次读取：'
const REASON_NO_PAGE_TARGET =
  '浏览器里没有可附加的页面标签（读取 cookie 需要一个页面 target）。请先在那个浏览器里打开并登录 CSDN，再重试。'

/** The two ways to ask Chromium for cookies; which one works depends on the peer. */
type CdpMethod = 'Storage.getCookies' | 'Network.getCookies'

interface CookiePair {
  readonly name: string
  readonly value: string
  /**
   * Reported by the browser. Used ONLY to scope a browser-wide answer down to the
   * requested hosts — `Storage.getCookies` otherwise returns every site's cookies.
   */
  readonly domain?: string
}

/**
 * Origins are matched by Chromium against the cookie's own domain, so the
 * requested URLs must be absolute; a bare host is normalised to https.
 */
function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim()
  if (trimmed === '') return DEFAULT_HOST_ORIGIN
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function hostOf(origins: readonly string[]): string[] {
  const hosts: string[] = []
  for (const origin of origins) {
    try {
      const host = new URL(origin).host
      if (host !== '' && !hosts.includes(host)) hosts.push(host)
    } catch {
      // An unparseable origin contributes no host label; it is still requested.
    }
  }
  return hosts
}

/**
 * First pair wins on a duplicate name (the order V8 sends is stable), so the
 * same browser state always produces the same header.
 */
function joinPairs(cookies: readonly CookiePair[]): { cookieHeader: string; names: string[] } {
  const seen = new Set<string>()
  const parts: string[] = []
  const names: string[] = []
  for (const cookie of cookies) {
    if (cookie.name === '' || seen.has(cookie.name)) continue
    seen.add(cookie.name)
    names.push(cookie.name)
    parts.push(`${cookie.name}=${cookie.value}`)
  }
  return { cookieHeader: parts.join('; '), names }
}

function isLoopbackWsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    return parsed.protocol === 'ws:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1')
  } catch {
    return false
  }
}

interface CdpFetchOutcome {
  readonly debuggerUrl?: string
  readonly failure?: 'unavailable' | 'network'
}

async function fetchDebuggerUrl(
  fetchImpl: FetchLike,
  port: number,
  timeoutMs: number,
): Promise<CdpFetchOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      method: 'GET',
      signal: controller.signal,
    })
    if (response.status !== 200) return { failure: 'unavailable' }
    let parsed: unknown
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      return { failure: 'unavailable' }
    }
    if (parsed === null || typeof parsed !== 'object') return { failure: 'unavailable' }
    const url = (parsed as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
    if (typeof url !== 'string' || url === '') return { failure: 'unavailable' }
    return { debuggerUrl: url }
  } catch {
    // Abort and socket errors answer the same way: nothing was read.
    return { failure: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** The CDP error message, bounded and single-line: never a cookie value. */
function cdpErrorMessage(error: unknown): string {
  const record = error !== null && typeof error === 'object' ? (error as { message?: unknown; code?: unknown }) : {}
  const message = typeof record.message === 'string' && record.message.trim().length > 0 ? record.message : '未知原因'
  const code = typeof record.code === 'number' ? `（code ${record.code}）` : ''
  return `${message.replace(/\s+/g, ' ').slice(0, 200)}${code}`
}

/**
 * The cookies a browser-wide answer is allowed to contribute.
 *
 * `Storage.getCookies` answers with EVERY cookie in the browser context, so the
 * result is scoped to the requested hosts before it can become a credential: a
 * `SENTINEL` for some unrelated site must not ride into the CSDN cookie header.
 * (The page-scoped `Network.getCookies` already answers per requested URL, so it
 * needs no such filter — but running it through this is harmless.)
 */
function cookieMatchesHosts(cookie: CookiePair, hosts: readonly string[]): boolean {
  const domain = (cookie.domain ?? '').replace(/^\./, '').trim().toLowerCase()
  if (domain === '') return false
  for (const host of hosts) {
    const bare = host.split(':')[0]?.trim().toLowerCase() ?? ''
    if (bare === '') continue
    if (bare === domain || bare.endsWith(`.${domain}`)) return true
  }
  return false
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Pick a page target's debugger URL out of `/json/list`.
 *
 * Needed because the browser-scope endpoint cannot answer `Network.getCookies`:
 * that domain is per-page. A target already sitting on the CSDN origin is
 * preferred, so the capture reads the cookies of the session the user actually
 * logged into rather than of a blank tab.
 */
async function fetchPageTarget(
  fetchImpl: FetchLike,
  port: number,
  timeoutMs: number,
): Promise<{ readonly debuggerUrl?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      method: 'GET',
      signal: controller.signal,
    })
    if (response.status !== 200) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      return {}
    }
    if (!Array.isArray(parsed)) return {}
    const preferredHost = hostOfUrl(CDP_PAGE_URL)
    const pages = parsed.filter(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'page' &&
        typeof (item as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === 'string',
    ) as Array<{ url?: unknown; webSocketDebuggerUrl: string }>
    const onCsdn = pages.find((page) => hostOfUrl(typeof page.url === 'string' ? page.url : '') === preferredHost)
    const chosen = onCsdn ?? pages[0] ?? null
    return chosen === null ? {} : { debuggerUrl: chosen.webSocketDebuggerUrl }
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the debugger for cookies over one websocket and resolve with a value-free
 * failure instead of throwing, so a caller can render the reason straight into
 * the settings page.
 *
 * TWO CORRECTIONS THIS FUNCTION CARRIES (both were real defects):
 * 1. A CDP error frame is answered IMMEDIATELY with `unsupported` and the
 *    browser's own message. Dropping it and waiting for the timeout reported
 *    "connection timed out" for what was really "this method is not available
 *    on this endpoint" — a lie that sends the user to the wrong fix.
 * 2. The method is a parameter. The browser-scope endpoint cannot serve
 *    `Network.getCookies` (the domain is per-page), so the caller tries
 *    `Storage.getCookies` first and only then attaches to a page target.
 */
async function readCookies(
  wsFactory: WebSocketFactory,
  debuggerUrl: string,
  origins: readonly string[],
  timeoutMs: number,
  method: CdpMethod,
): Promise<{ readonly cookies: readonly CookiePair[] } | { readonly failure: 'network' | 'unsupported'; readonly reason: string }> {
  type ReadOutcome =
    | { readonly cookies: readonly CookiePair[] }
    | { readonly failure: 'network' | 'unsupported'; readonly reason: string }
  return await new Promise<ReadOutcome>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocketLike | undefined
    const finish = (value: ReadOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // A socket that already died needs no close.
      }
      resolve(value)
    }
    timer = setTimeout(() => finish({ failure: 'network', reason: REASON_TIMEOUT }), timeoutMs)

    try {
      socket = wsFactory(debuggerUrl)
    } catch {
      finish({ failure: 'network', reason: REASON_TIMEOUT })
      return
    }

    /** Accept only the reply to request id 1; anything else is noise. */
    const onMessageData = (raw: unknown): void => {
      if (typeof raw !== 'string') return
      let message: unknown
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }
      if (message === null || typeof message !== 'object') return
      const record = message as {
        id?: unknown
        error?: unknown
        result?: { cookies?: unknown }
      }
      if (record.id !== 1) return
      if (record.error !== undefined) {
        finish({ failure: 'unsupported', reason: `${REASON_CDP_REJECTED}${method}：${cdpErrorMessage(record.error)}` })
        return
      }
      if (!Array.isArray(record.result?.cookies)) {
        finish({ failure: 'unsupported', reason: `${REASON_CDP_REJECTED}${method}：响应里没有 cookies 字段。` })
        return
      }
      const cookies: CookiePair[] = []
      for (const item of record.result.cookies) {
        if (item === null || typeof item !== 'object') continue
        const name = (item as { name?: unknown }).name
        const value = (item as { value?: unknown }).value
        const domain = (item as { domain?: unknown }).domain
        if (typeof name !== 'string') continue
        cookies.push({
          name,
          value: typeof value === 'string' ? value : '',
          ...(typeof domain === 'string' ? { domain } : {}),
        })
      }
      finish({ cookies })
    }

    /**
     * Send the one request.
     *
     * Never before the socket is OPEN: `send()` throws while CONNECTING, and the
     * first version reported that throw as a timeout — which is a lie about a port
     * that is listening. Undici's WebSocket exposes `readyState`, so it is used when
     * present; a test double without it is treated as already open.
     */
    const sendRequest = (): void => {
      try {
        socket?.send(
          JSON.stringify({
            id: 1,
            method,
            // `Network.getCookies` is URL-scoped; `Storage.getCookies` takes no
            // parameters (the caller filters its browser-wide answer by host).
            params: method === 'Storage.getCookies' ? {} : { urls: [...origins] },
          }),
        )
      } catch (error) {
        finish({ failure: 'network', reason: `${REASON_SEND_FAILED}${cdpErrorMessage(error)}` })
      }
    }

    // Both listener shapes exist in the wild; support whichever the injected
    // socket (or the global one) offers.
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', () => sendRequest())
      socket.addEventListener('message', (event: unknown) => {
        const raw = typeof event === 'string' ? event : (event as { data?: unknown } | null)?.data
        onMessageData(raw)
      })
      socket.addEventListener('close', () => finish({ failure: 'network', reason: REASON_HANDSHAKE }))
      socket.addEventListener('error', () => finish({ failure: 'network', reason: REASON_HANDSHAKE }))
    } else if (typeof socket.on === 'function') {
      socket.on('open', (() => sendRequest()) as (...args: never[]) => void)
      socket.on('message', ((event: unknown) => {
        onMessageData((event as { data?: unknown } | undefined)?.data)
      }) as (...args: never[]) => void)
      socket.on('close', (() => finish({ failure: 'network', reason: REASON_HANDSHAKE })) as (...args: never[]) => void)
      socket.on('error', (() => finish({ failure: 'network', reason: REASON_HANDSHAKE })) as (...args: never[]) => void)
    } else {
      finish({ failure: 'network', reason: REASON_HANDSHAKE })
      return
    }

    if (socket.readyState === undefined || socket.readyState === 1) sendRequest()
  })
}

function globalWebSocketFactory(): WebSocketFactory | undefined {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof candidate !== 'function') return undefined
  return (url: string): WebSocketLike => new (candidate as new (url: string) => WebSocketLike)(url)
}

/**
 * Read the requested sites' cookies once, over the browser's debug port.
 *
 * STRATEGY (and why it is two attempts, not one):
 *   1. `Storage.getCookies` on the BROWSER endpoint — needs no page attachment,
 *      so it works even when the user has no CSDN tab open. Its answer covers
 *      every site in the browser context, so it is filtered down to the requested
 *      hosts before it can become a credential.
 *   2. If the browser endpoint refuses that method (older Chromium, or a
 *      WebSocket peer that only serves page sessions), attach to a PAGE target
 *      from `/json/list` and ask the page-scoped `Network.getCookies` instead.
 * A CDP error is reported as itself — never as a timeout.
 */
export async function captureBrowserCookies(
  input: CdpCaptureInput,
  deps: CdpDeps = {},
): Promise<CdpCaptureResult> {
  if (input.consent !== true) {
    return { ok: false, failure: 'consent-required', reason: REASON_CONSENT }
  }
  const port = input.port
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, failure: 'unavailable', reason: REASON_BAD_PORT }
  }

  // Check the socket capability before the HTTP probe: a missing WebSocket means
  // the capture can never succeed, and failing first keeps 127.0.0.1 untouched.
  const wsFactory = deps.wsFactory ?? input.wsFactory ?? globalWebSocketFactory()
  if (wsFactory === undefined) {
    return { ok: false, failure: 'unsupported', reason: REASON_NO_WS }
  }
  const fetchImpl = deps.fetchImpl ?? input.fetchImpl ?? globalFetch()
  if (fetchImpl === undefined) {
    return { ok: false, failure: 'unsupported', reason: '当前进程没有可用的 fetch，无法探测浏览器调试端口。' }
  }

  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_TIMEOUT_MS
  const origins = (input.origins ?? CDP_COOKIE_HOSTS).map(normalizeOrigin)
  const hosts = hostOf(origins)

  const probe = await fetchDebuggerUrl(fetchImpl, port, timeoutMs)
  if (probe.debuggerUrl === undefined) {
    return {
      ok: false,
      failure: probe.failure ?? 'unavailable',
      reason: probe.failure === 'network' ? REASON_TIMEOUT : REASON_ENDPOINT,
    }
  }
  // Defence in depth: a debugger URL pointing off-loopback is never dialled.
  if (!isLoopbackWsUrl(probe.debuggerUrl)) {
    return { ok: false, failure: 'unavailable', reason: REASON_DEBUGGER_URL }
  }

  const browserRead = await readCookies(wsFactory, probe.debuggerUrl, origins, timeoutMs, 'Storage.getCookies')
  let cookies: readonly CookiePair[]
  if ('cookies' in browserRead) {
    cookies = browserRead.cookies.filter((cookie) => cookieMatchesHosts(cookie, hosts))
  } else if (browserRead.failure === 'network') {
    return { ok: false, failure: 'network', reason: browserRead.reason }
  } else {
    // The browser endpoint refused the method: go through a page target.
    const page = await fetchPageTarget(fetchImpl, port, timeoutMs)
    if (page.debuggerUrl === undefined || !isLoopbackWsUrl(page.debuggerUrl)) {
      return { ok: false, failure: 'unsupported', reason: `${browserRead.reason} ${REASON_NO_PAGE_TARGET}` }
    }
    const pageRead = await readCookies(wsFactory, page.debuggerUrl, origins, timeoutMs, 'Network.getCookies')
    if (!('cookies' in pageRead)) {
      return { ok: false, failure: pageRead.failure, reason: pageRead.reason }
    }
    cookies = pageRead.cookies
  }

  const { cookieHeader, names } = joinPairs(cookies)
  if (cookieHeader === '') {
    return { ok: false, failure: 'empty', reason: REASON_EMPTY }
  }
  return { ok: true, cookieHeader, names, hosts }
}

function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}
