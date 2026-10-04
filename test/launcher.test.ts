/**
 * `src/launcher.ts` — 探测端口 → 找 Chromium → 用独立 profile 带调试端口启动 → 回传
 * `webSocketDebuggerUrl`。
 *
 * Offline by construction: the filesystem probe, the spawn call and the port probe
 * are all injected. What must hold:
 *
 *   1. **Nothing is started while a debugger is already listening** — starting a
 *      second browser on the same port would fight the first one for the profile.
 *   2. **No browser found is a real, actionable failure** (`no-browser` + the list of
 *      paths that were searched), not a silent success with a bogus URL.
 *   3. **The flags are exactly the ones the CDP path needs**: a dedicated
 *      `--user-data-dir` (a shared/default profile makes Chromium IGNORE the debug
 *      flag), the port, and `--remote-allow-origins=*`.
 *   4. **The child is detached with stdio ignored** — it must outlive the request,
 *      and piping an undrained pipe would hang the host.
 *   5. A port that never answers is `timeout` with a fix in the reason, and the
 *      profile directory lives under `$DSH_HOME` (it holds a logged-in session).
 */

import { describe, expect, it, vi } from 'vitest'

import { CDP_REMOTE_ALLOW_ORIGINS_FLAG, CDP_USER_DATA_DIR_NAME } from '../src/contract.js'
import { createBrowserLauncher } from '../src/launcher.js'
import type { BrowserCandidate, LauncherDeps } from '../src/launcher.js'
import type { FetchInit, FetchLike, FetchLikeResponse } from '../src/net.js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: unknown
}

function makeDeps(overrides: {
  readonly present?: readonly string[]
  readonly versionReply?: (url: string) => FetchLikeResponse | Promise<FetchLikeResponse>
  readonly spawnThrows?: boolean
  readonly now?: () => number
}): {
  readonly deps: LauncherDeps
  readonly spawns: SpawnCall[]
  readonly probes: string[]
  readonly unrefs: () => number
} {
  const spawns: SpawnCall[] = []
  const probes: string[] = []
  let unrefs = 0
  const present = new Set(overrides.present ?? [])

  const fetchImpl: FetchLike = async (url: string, _init?: FetchInit) => {
    probes.push(url)
    if (overrides.versionReply === undefined) throw new Error('nothing listening')
    return await overrides.versionReply(url)
  }

  const deps: LauncherDeps = {
    platform: 'win32',
    env: {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    },
    exists: (path) => present.has(path),
    mkdirp: () => {},
    fetchImpl,
    now: overrides.now ?? (() => Date.now()),
    sleep: async () => {
      /* the poll loop is bounded by `now`, which the tests control */
    },
    // `dshHome` (not `userDataDir`) so the per-browser default path is exercised.
    dshHome: 'C:\\Users\\tester\\.dsh',
    spawnImpl: ((command: string, args: string[], options: unknown) => {
      if (overrides.spawnThrows === true) throw new Error('EACCES')
      spawns.push({ command, args, options })
      return {
        pid: 4242,
        unref: () => {
          unrefs += 1
        },
      }
    }) as unknown as LauncherDeps['spawnImpl'],
  }

  return { deps, spawns, probes, unrefs: () => unrefs }
}

function versionReplyFor(debuggerUrl: string): () => FetchLikeResponse {
  return () => ({ status: 200, text: async () => JSON.stringify({ Browser: 'Chrome/126', webSocketDebuggerUrl: debuggerUrl }) })
}

describe('浏览器 launcher — 找浏览器', () => {
  it('Edge 优先于 Chrome —— 内定顺序，不是用户选项', () => {
    const { deps } = makeDeps({ present: [CHROME, EDGE] })
    const launcher = createBrowserLauncher(deps)
    const found: BrowserCandidate[] = launcher.listBrowsers()

    // Both exist; Edge wins because it ships with Windows. Nothing in the UI offers
    // a picker — a choice here would be one more question before a cookie.
    expect(found.map((item) => item.id)).toEqual(['edge', 'chrome'])
    expect(found[0]?.path).toBe(EDGE)
    // The profile is per browser family, so switching browsers cannot corrupt one.
    expect(launcher.userDataDir()).toBe(`C:\\Users\\tester\\.dsh\\${CDP_USER_DATA_DIR_NAME}-edge`)
  })

  it('同一浏览器去重：用户级 + 全局安装只报告一次', () => {
    const { deps } = makeDeps({ present: [CHROME] })
    const found = createBrowserLauncher(deps).listBrowsers()

    expect(found).toHaveLength(1)
    expect(found[0]?.path).toBe(CHROME)
  })

  it('一个都没有时：仍然返回 non-empty 的搜索路径清单（错误信息要可执行）', async () => {
    const { deps, spawns } = makeDeps({ present: [] })
    const result = await createBrowserLauncher(deps).launch({ port: 9222 })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('no-browser')
    expect(result.searched?.length ?? 0).toBeGreaterThan(0)
    expect(result.searched?.some((path) => path.endsWith('chrome.exe'))).toBe(true)
    expect(spawns).toHaveLength(0)
  })
})

describe('浏览器 launcher — 启动与探测', () => {
  it('端口上已有可调试浏览器：不启动第二个，直接复用它的 debuggerUrl', async () => {
    const { deps, spawns } = makeDeps({
      present: [CHROME],
      versionReply: versionReplyFor('ws://127.0.0.1:9222/devtools/browser/existing'),
    })
    const result = await createBrowserLauncher(deps).launch({ port: 9222 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.launched).toBe(false)
    expect(result.browser).toBeNull()
    expect(result.debuggerUrl).toBe('ws://127.0.0.1:9222/devtools/browser/existing')
    expect(spawns).toHaveLength(0)
  })

  it('端口静默时：用独立 profile + 调试端口 + remote-allow-origins 启动，并回传 debuggerUrl', async () => {
    let launched = false
    const { deps, spawns, unrefs } = makeDeps({
      present: [CHROME],
      versionReply: () => {
        // Silent until the spawn happened, then the port answers — the real order.
        if (!launched) throw new Error('ECONNREFUSED')
        return versionReplyFor('ws://127.0.0.1:9222/devtools/browser/abc')()
      },
    })
    const originalSpawn = deps.spawnImpl as unknown as (c: string, a: string[], o: unknown) => { pid: number; unref: () => void }
    const wrapped: LauncherDeps = {
      ...deps,
      spawnImpl: ((command: string, args: string[], options: unknown) => {
        launched = true
        return originalSpawn(command, args, options)
      }) as unknown as LauncherDeps['spawnImpl'],
    }

    const result = await createBrowserLauncher(wrapped).launch({
      port: 9222,
      url: 'https://passport.csdn.net/login',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.launched).toBe(true)
    expect(result.browser?.id).toBe('chrome')
    expect(result.debuggerUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc')

    expect(spawns).toHaveLength(1)
    const call = spawns[0]
    expect(call?.command).toBe(CHROME)
    expect(call?.args).toContain('--remote-debugging-port=9222')
    expect(call?.args).toContain(CDP_REMOTE_ALLOW_ORIGINS_FLAG)
    // The dedicated profile is the whole reason the flag is honoured.
    expect(call?.args).toContain(`--user-data-dir=${result.userDataDir}`)
    expect(call?.args).toContain('--no-first-run')
    // The login page is opened for the user: a fresh profile starts logged out.
    expect(call?.args).toContain('https://passport.csdn.net/login')
    // Detached + ignored stdio: the browser must outlive the request and never
    // block on a pipe nobody drains.
    expect(call?.options).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(unrefs()).toBe(1)
  })

  it('启动了但端口一直不响应 → timeout，并且 reason 里给出可执行的修复方向', async () => {
    let launched = false
    const { deps } = makeDeps({ present: [EDGE], versionReply: () => Promise.reject(new Error('ECONNREFUSED')) })
    const originalSpawn = deps.spawnImpl as unknown as (c: string, a: string[], o: unknown) => { pid: number; unref: () => void }
    const wrapped: LauncherDeps = {
      ...deps,
      spawnImpl: ((c: string, a: string[], o: unknown) => {
        launched = true
        return originalSpawn(c, a, o)
      }) as unknown as LauncherDeps['spawnImpl'],
    }

    const result = await createBrowserLauncher(wrapped).launch({ port: 9333, timeoutMs: 3 })

    expect(launched).toBe(true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('timeout')
    expect(result.reason).toContain('9333')
    expect(result.reason).toContain('配置目录')
  })

  it('spawn 抛错 → spawn-failed（不是假装成功）', async () => {
    const { deps } = makeDeps({ present: [CHROME], spawnThrows: true })
    const result = await createBrowserLauncher(deps).launch({ port: 9222 })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toBe('spawn-failed')
    expect(result.reason).toContain('Chrome')
  })

  it('端口非法 → bad-port，且不探测也不启动', async () => {
    const { deps, spawns, probes } = makeDeps({ present: [CHROME] })
    for (const port of [0, -1, 70_000, 1.5]) {
      const result = await createBrowserLauncher(deps).launch({ port })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.failure).toBe('bad-port')
    }
    expect(spawns).toHaveLength(0)
    expect(probes).toHaveLength(0)
  })

  it('没有 fetch 可用 → unsupported（不盲启动一个连不上的浏览器）', async () => {
    const { deps, spawns } = makeDeps({ present: [CHROME] })
    // The launcher defaults `fetchImpl` to the global fetch, so "no fetch" means the
    // GLOBAL one is missing (an old runtime) — stubbing it away is the real path.
    const original = globalThis.fetch
    vi.stubGlobal('fetch', undefined)
    try {
      const result = await createBrowserLauncher({ ...deps, fetchImpl: undefined }).launch({ port: 9222 })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.failure).toBe('unsupported')
      expect(spawns).toHaveLength(0)
    } finally {
      vi.stubGlobal('fetch', original)
      vi.unstubAllGlobals()
    }
  })

  it('探测只打 127.0.0.1（不会把调试端口探测发到别的地址）', async () => {
    const { deps, probes } = makeDeps({ present: [CHROME], versionReply: versionReplyFor('ws://127.0.0.1:9222/x') })
    await createBrowserLauncher(deps).launch({ port: 9222 })
    expect(probes.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true)
  })
})

describe('浏览器 launcher — 路由接线（源码级）', () => {
  it('/launch-browser 与 /cookies 用同一组双重门禁（cdpEnabled + consent）', async () => {
    const fs = await import('node:fs')
    const routes = fs.readFileSync('src/routes.ts', 'utf8')
    const block = routes.slice(routes.indexOf('async function handleLaunchBrowser'))
    expect(block).toContain('config.csdn.cdpEnabled !== true')
    expect(block).toContain("record['consent'] !== true")
    // 响应里只有回环事实，没有凭据。
    expect(block).toContain('debuggerUrl: result.debuggerUrl')
    expect(block).not.toContain('cookieHeader')
  })

  it('启动按钮在面板里，并且可以先探测再启动（不会重复启动）', async () => {
    const fs = await import('node:fs')
    const panel = fs.readFileSync('src/client/panel.tsx', 'utf8')
    expect(panel).toContain('launchDebugBrowser')
    expect(panel).toContain('csdn.cdp.launch')
    expect(panel).toContain('LOGIN_URLS.csdnLogin')
  })
})
