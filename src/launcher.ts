/**
 * dsh-codehub — launch a debuggable Chromium so the CDP cookie capture can work.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The experimental capture needs `http://127.0.0.1:<port>/json/version` to answer,
 * which the user can only get by starting a browser with
 * `--remote-debugging-port=…`. Telling the user to do that by hand is where the
 * feature died in practice: they open their normal browser, the flag is ignored
 * (an already-running instance owns the profile), and the plugin reports 'timeout'
 * forever. So the plugin does it: probe first, and if nothing is listening, find a
 * Chromium, start it on its OWN profile with the right flags, and wait for the
 * debugger URL to appear.
 *
 * WHY A SEPARATE `--user-data-dir`
 * --------------------------------
 * Chromium refuses to open a debug port on a profile that another process already
 * owns, and on some builds it refuses on the *default* profile at all. A dedicated
 * directory under `$DSH_HOME` therefore always works — at the cost that it starts
 * empty, which is why the caller opens the CSDN login page in it.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * - It never touches the user's normal profile: no reading, no copying, no locking.
 * - It never downloads a browser, and refuses when it cannot find one.
 * - It does not inject anything into the page, and it holds no credential: the
 *   cookie capture reads browser state over CDP in `cdp.ts`, and what it finds goes
 *   straight to the credential service.
 *
 * The profile directory IS sensitive (it holds the logged-in session), so it lives
 * under `$DSH_HOME` with mode 0700 and is never inside a repository.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { CDP_REMOTE_ALLOW_ORIGINS_FLAG, CDP_USER_DATA_DIR_NAME } from './contract.js'
import type { FetchLike } from './net.js'
import { resolveDshHome } from './store.js'

/** A Chromium-family executable this machine actually has. */
export interface BrowserCandidate {
  readonly id: 'chrome' | 'edge' | 'brave' | 'chromium'
  readonly label: string
  readonly path: string
}

export type LaunchFailure = 'no-browser' | 'spawn-failed' | 'timeout' | 'bad-port' | 'unsupported'

export interface LaunchOk {
  readonly ok: true
  /** False when a debugger was already listening (nothing was started). */
  readonly launched: boolean
  readonly browser: BrowserCandidate | null
  readonly port: number
  readonly userDataDir: string
  /** The `webSocketDebuggerUrl` the capture will attach to. Loopback, not secret. */
  readonly debuggerUrl: string
  /** Free-form, value-free status line for the UI. */
  readonly reason: string
}

export interface LaunchFailureResult {
  readonly ok: false
  readonly failure: LaunchFailure
  /** Value-free; safe to render and to log. */
  readonly reason: string
  /** Where the launcher looked, so "no browser" is actionable. */
  readonly searched?: readonly string[]
}

export type LaunchResult = LaunchOk | LaunchFailureResult

export interface LaunchInput {
  readonly port: number
  /** Page to open in the new window (the CSDN login page by default). */
  readonly url?: string
  /** Pin a browser by id; omitted = first candidate wins. */
  readonly browserId?: BrowserCandidate['id'] | undefined
  /** Override the profile directory (tests, or a user with a preferred path). */
  readonly userDataDir?: string
  readonly timeoutMs?: number
}

/** Injection points. Everything has a production default; tests override. */
export interface LauncherDeps {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly exists?: (path: string) => boolean
  readonly mkdirp?: (path: string) => void
  readonly spawnImpl?: typeof spawn
  readonly fetchImpl?: FetchLike
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly dshHome?: string
  /** Override the dedicated profile directory (defaults to `$DSH_HOME/<name>`). */
  readonly userDataDir?: string
}

export interface BrowserLauncher {
  /** Every Chromium-family executable found, in preference order. */
  listBrowsers(): BrowserCandidate[]
  /** Probe, then start one if nothing is listening. */
  launch(input: LaunchInput): Promise<LaunchResult>
  /** Where the dedicated profile lives (also used to explain the cost). */
  userDataDir(): string
}

/** The port the probe and the default launch use. Kept in sync with config. */
const DEFAULT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 400

/**
 * Windows install locations, **Edge first**.
 *
 * THE ORDER IS AN INTERNAL DECISION, NOT A SWITCH TO EXPOSE: Edge ships with
 * Windows, so it is the browser a user is most likely to already have; Chrome is
 * the fallback. `launch()` takes the first candidate that exists and nothing in the
 * UI offers a picker — one more question between the user and a cookie is exactly
 * what this feature was meant to remove.
 */
function windowsCandidates(env: NodeJS.ProcessEnv): Array<{ id: BrowserCandidate['id']; label: string; path: string }> {
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env['LOCALAPPDATA'] ?? join(env['USERPROFILE'] ?? 'C:\\Users\\Default', 'AppData', 'Local')
  return [
    { id: 'edge', label: 'Microsoft Edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { id: 'edge', label: 'Microsoft Edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { id: 'chrome', label: 'Google Chrome', path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { id: 'chrome', label: 'Google Chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    {
      id: 'chrome',
      label: 'Google Chrome',
      path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    {
      id: 'brave',
      label: 'Brave',
      path: join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    },
  ]
}

/** POSIX / macOS locations, same Edge-first order. */
function posixCandidates(platform: NodeJS.Platform): Array<{ id: BrowserCandidate['id']; label: string; path: string }> {
  if (platform === 'darwin') {
    return [
      { id: 'edge', label: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { id: 'chrome', label: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { id: 'brave', label: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { id: 'chromium', label: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ]
  }
  return [
    { id: 'edge', label: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
    { id: 'chrome', label: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { id: 'chrome', label: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
    { id: 'chromium', label: 'Chromium', path: '/usr/bin/chromium' },
    { id: 'chromium', label: 'Chromium', path: '/usr/bin/chromium-browser' },
  ]
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  return typeof candidate === 'function' ? (candidate as FetchLike) : undefined
}

/**
 * Build the launcher.
 *
 * The interface is three methods on purpose: `listBrowsers()` for the UI's picker,
 * `launch()` for the action, and `userDataDir()` so the copy can say where the
 * session lives. Everything else (paths, flags, polling) stays inside.
 */
export function createBrowserLauncher(deps: LauncherDeps = {}): BrowserLauncher {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const spawnImpl = deps.spawnImpl ?? spawn
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? globalFetch()

  /**
   * The dedicated profile for ONE browser family.
   *
   * Per-browser on purpose: Edge and Chrome both write a Chromium profile, but they
   * are different products and sharing one directory across them invites a profile
   * reset the first time the order changes. The suffix also makes it obvious in the
   * filesystem which browser owns a logged-in session.
   */
  const profileDir = (browserId: BrowserCandidate['id'] = 'edge'): string =>
    deps.userDataDir ?? join(deps.dshHome ?? resolveDshHome(), `${CDP_USER_DATA_DIR_NAME}-${browserId}`)

  function listBrowsers(): BrowserCandidate[] {
    const raw = platform === 'win32' ? windowsCandidates(env) : posixCandidates(platform)
    const found: BrowserCandidate[] = []
    for (const candidate of raw) {
      if (!exists(candidate.path)) continue
      // The same browser often appears twice (per-user + machine-wide install):
      // report it once, at the first path that exists.
      if (found.some((item) => item.id === candidate.id)) continue
      found.push(candidate)
    }
    return found
  }

  /** Ask /json/version once. Returns the debugger URL, or nothing. */
  async function probe(port: number, timeoutMs: number): Promise<string | undefined> {
    if (fetchImpl === undefined) return undefined
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
      })
      if (response.status !== 200) return undefined
      const parsed: unknown = JSON.parse(await response.text())
      if (parsed === null || typeof parsed !== 'object') return undefined
      const url = (parsed as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
      return typeof url === 'string' && url.length > 0 ? url : undefined
    } catch {
      return undefined
    }
  }

  return {
    listBrowsers,
    /** The profile the PREFERRED (first) browser would use; see `profileDir`. */
    userDataDir: () => profileDir(),

    async launch(input: LaunchInput): Promise<LaunchResult> {
      const port = input.port
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return { ok: false, failure: 'bad-port', reason: '调试端口必须是 1–65535 的整数。' }
      }
      if (fetchImpl === undefined) {
        return { ok: false, failure: 'unsupported', reason: '当前进程没有可用的 fetch，无法探测调试端口。' }
      }

      const timeoutMs =
        typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? input.timeoutMs
          : DEFAULT_TIMEOUT_MS

      // 1. Already listening? Never start a second browser for the same port.
      const existing = await probe(port, timeoutMs)
      if (existing !== undefined) {
        return {
          ok: true,
          launched: false,
          browser: null,
          port,
          userDataDir: profileDir(),
          debuggerUrl: existing,
          reason: `端口 ${port} 上已经有一个可调试的浏览器，直接复用它（没有启动新的）。`,
        }
      }

      // 2. Find a browser. No browser is a REAL failure the user must fix.
      const candidates = listBrowsers()
      if (candidates.length === 0) {
        return {
          ok: false,
          failure: 'no-browser',
          reason: '没有找到 Chrome / Edge / Brave / Chromium。请先安装其中一个，或用 --remote-debugging-port 自行启动浏览器。',
          searched:
            platform === 'win32'
              ? windowsCandidates(env).map((item) => item.path)
              : posixCandidates(platform).map((item) => item.path),
        }
      }
      const browser =
        input.browserId === undefined
          ? (candidates[0] as BrowserCandidate)
          : (candidates.find((item) => item.id === input.browserId) ?? (candidates[0] as BrowserCandidate))

      // 3. A dedicated profile: the default one is owned by the running browser,
      //    and Chromium then ignores the debug flag entirely.
      const userDataDir = input.userDataDir ?? profileDir(browser.id)
      try {
        ;(deps.mkdirp ?? ((dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 })))(userDataDir)
      } catch {
        return { ok: false, failure: 'spawn-failed', reason: `无法创建浏览器专用配置目录：${userDataDir}` }
      }

      const args = [
        `--remote-debugging-port=${port}`,
        CDP_REMOTE_ALLOW_ORIGINS_FLAG,
        `--user-data-dir=${userDataDir}`,
        // Keep the window usable and quiet: this is a debugging session, not a
        // browser the user should have to configure.
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,InfiniteSessionRestore',
        ...(input.url === undefined || input.url.length === 0 ? [] : [input.url]),
      ]

      // 3b. Detached and stdio-ignored: the browser must outlive this request, and
      //     piping its stdio would block on a pipe nobody drains.
      let pid = 0
      try {
        const child = spawnImpl(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: false })
        pid = typeof child.pid === 'number' ? child.pid : 0
        child.unref?.()
      } catch (error) {
        return {
          ok: false,
          failure: 'spawn-failed',
          reason: `启动 ${browser.label} 失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      // 4. Wait for the port to answer. Chromium takes a beat to bind it, and a
      //    first-run profile takes longer.
      const deadline = now() + timeoutMs
      let debuggerUrl: string | undefined
      while (now() < deadline) {
        debuggerUrl = await probe(port, 2_000)
        if (debuggerUrl !== undefined) break
        await sleep(POLL_INTERVAL_MS)
      }
      if (debuggerUrl === undefined) {
        return {
          ok: false,
          failure: 'timeout',
          reason:
            `已启动 ${browser.label}（pid ${pid}），但 ${timeoutMs / 1000} 秒内端口 ${port} 没有响应。` +
            '常见原因：该浏览器已在用同一个配置目录运行（调试端口被忽略）、端口被别的程序占用，或安全软件拦截。' +
            '可以换一个端口，或先完全退出调试浏览器再重试。',
        }
      }

      return {
        ok: true,
        launched: true,
        browser,
        port,
        userDataDir,
        debuggerUrl,
        reason: `已启动 ${browser.label}（独立配置：${userDataDir}）。请在打开的窗口里登录 CSDN，然后回来点「读取 Cookie」。`,
      }
    },
  }
}
