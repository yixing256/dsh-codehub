/**
 * dsh-codehub — environment probes for the GitHub access picker (docs/DESIGN.md §3).
 *
 * WHAT THIS ANSWERS, AND WHAT IT REFUSES TO CLAIM
 * ----------------------------------------------
 * The user must be able to see whether a system proxy, a SOCKS5 endpoint, Watt
 * Toolkit or a hosts entry is already in place, because "detected" changes which
 * access strategy is worth selecting. It does NOT mean "enabled": Watt Toolkit
 * still has to be switched on by the user, and hosts entries still have to be
 * correct. The report says what was OBSERVED and nothing more — every inference
 * is spelled out in `notes`.
 *
 * Sources, in order of trust:
 *   1. the OS environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / lowercase),
 *   2. the Windows per-user Internet Settings registry keys, read with a fixed
 *      `reg.exe query` invocation (fixed binary, fixed arguments, no shell, a
 *      hard timeout, failures swallowed). This is a read-only local probe — it
 *      is not "spawning remote code", and it is the only dependency-free way to
 *      see the system proxy on Windows,
 *   3. the hosts file, scanned for GitHub/Gitee/CSDN-related names,
 *   4. candidate Watt Toolkit install directories.
 *
 * Nothing here sends a packet: a probe never touches the network, and the
 * plugin still installs no proxy of its own. Addresses appear in the REPORT
 * (the browser half displays them) but never in a log line — `notes` is
 * deliberately address-free.
 */

import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Registry key holding the per-user proxy configuration. */
export const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Hard cap on the registry probe; a slow `reg.exe` must not stall the route. */
export const REGISTRY_TIMEOUT_MS = 2_500

/** Hostnames whose presence in the hosts file is worth reporting. */
export const HOSTS_INTEREST = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'ghproxy',
  'ghfast',
  'gitmirror',
  'gitee.com',
  'csdn.net',
] as const

export interface ProxyDetection {
  readonly enabled: boolean
  readonly source: 'env' | 'registry' | 'none'
  /** The address the OS would use, or `false`. */
  readonly systemProxy: string | false
  /** A configured-but-disabled address, or `false`. */
  readonly configuredProxy: string | false
  /** The first SOCKS5 endpoint found anywhere, or `false`. */
  readonly socks5: string | false
  readonly httpProxy?: string
  readonly httpsProxy?: string
  readonly allProxy?: string
  readonly noProxy?: string
  readonly notes: readonly string[]
}

export interface WattDetection {
  readonly detected: boolean
  readonly evidence: readonly string[]
  readonly note: string
}

export interface HostsDetection {
  readonly path: string
  readonly readable: boolean
  readonly entries: readonly string[]
  readonly note: string
}

export interface DetectReport {
  readonly platform: string
  readonly generatedAt: string
  /** The four fields the browser half renders. */
  readonly systemProxy: string | false
  readonly socks5: string | false
  readonly watt: boolean
  readonly hosts: boolean
  readonly proxyEnabled: boolean
  readonly proxySource: string
  /** The proxy configured in the plugin itself, if any (already known to the UI). */
  readonly pluginProxy: string | false
  readonly wattDetail: readonly string[]
  readonly hostsEntries: readonly string[]
  readonly hostsPath: string
  readonly notes: readonly string[]
}

function readEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function isSocksAddress(value: string): boolean {
  return /^socks(4a?|5h?):\/\//i.test(value.trim())
}

// ---------------------------------------------------------------------------
// Windows registry (read-only, best effort).
// ---------------------------------------------------------------------------

function parseRegistryValue(stdout: string, name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ|DWORD)\\s+(.*)$`, 'm')
  const match = pattern.exec(stdout)
  if (match === null) return undefined
  const value = match[1].trim()
  return value.length > 0 ? value : undefined
}

function queryRegistryValue(name: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    if (process.platform !== 'win32') {
      resolve(undefined)
      return
    }
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = execFile(
        'reg.exe',
        ['query', INTERNET_SETTINGS_KEY, '/v', name],
        { timeout: REGISTRY_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) {
            finish(undefined)
            return
          }
          finish(parseRegistryValue(String(stdout), name))
        },
      )
      child.on('error', () => finish(undefined))
    } catch {
      finish(undefined)
    }
  })
}

async function detectSystemProxy(pluginProxy: string): Promise<ProxyDetection> {
  const notes: string[] = []
  const httpProxy = readEnv(['HTTP_PROXY', 'http_proxy'])
  const httpsProxy = readEnv(['HTTPS_PROXY', 'https_proxy'])
  const allProxy = readEnv(['ALL_PROXY', 'all_proxy'])
  const noProxy = readEnv(['NO_PROXY', 'no_proxy'])

  const envCandidates: string[] = []
  const addEnv = (value: string | undefined): void => {
    if (typeof value === 'string' && !envCandidates.includes(value)) envCandidates.push(value)
  }
  addEnv(httpsProxy)
  addEnv(httpProxy)
  addEnv(allProxy)

  let registryServer: string | undefined
  let registryEnable: string | undefined
  if (process.platform === 'win32') {
    registryServer = await queryRegistryValue('ProxyServer')
    registryEnable = await queryRegistryValue('ProxyEnable')
  }
  const registryEnabled = registryEnable === undefined ? undefined : /^0x0*1$/i.test(registryEnable)

  const base = {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(allProxy === undefined ? {} : { allProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  }

  const socksCandidate = [...envCandidates, ...(registryServer === undefined ? [] : [registryServer])].find(
    (candidate) => isSocksAddress(candidate),
  )
  const socks5: string | false = socksCandidate ?? false

  if (envCandidates.length > 0) {
    notes.push('检测到环境变量代理设置（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY），已在报告中给出原始地址。')
    return {
      ...base,
      enabled: true,
      source: 'env',
      systemProxy: envCandidates[0],
      configuredProxy: envCandidates[0],
      socks5,
      notes,
    }
  }

  if (registryServer !== undefined) {
    const enabled = registryEnabled !== false
    notes.push(
      enabled
        ? '检测到 Windows Internet 设置里的系统代理。检测到不等于本插件会使用它：只有在访问方式里勾选「本机代理」并填写地址后才会生效。'
        : 'Windows Internet 设置里配置了代理地址，但 ProxyEnable 为 0（未启用）；本插件不会替你启用它。',
    )
    return {
      ...base,
      enabled,
      source: 'registry',
      systemProxy: enabled ? registryServer : false,
      configuredProxy: registryServer,
      socks5,
      notes,
    }
  }

  notes.push('未检测到系统代理（环境变量与 Windows Internet 设置均为空）。')
  return { ...base, enabled: false, source: 'none', systemProxy: false, configuredProxy: false, socks5, notes }
}

// ---------------------------------------------------------------------------
// Hosts file.
// ---------------------------------------------------------------------------

function hostsFilePath(): string {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    return join(root, 'System32', 'drivers', 'etc', 'hosts')
  }
  return '/etc/hosts'
}

async function detectHosts(): Promise<HostsDetection> {
  const path = hostsFilePath()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {
      path,
      readable: false,
      entries: [],
      note: 'hosts 文件不可读（权限或路径不同）；这不影响本插件，只是无法提示 Hosts 方式是否已生效。',
    }
  }

  const entries: string[] = []
  for (const line of text.split(/\r?\n/).slice(0, 20_000)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const lower = trimmed.toLowerCase()
    if (!HOSTS_INTEREST.some((needle) => lower.includes(needle))) continue
    if (entries.length < 20 && !entries.includes(trimmed)) entries.push(trimmed)
  }

  return {
    path,
    readable: true,
    entries,
    note:
      entries.length > 0
        ? 'hosts 文件里存在与本项目相关的主机名条目。请自行确认它们当前仍然有效 —— 本插件不硬编码、也不改写任何 IP。'
        : 'hosts 文件可读，但没有与本项目相关的主机名条目。',
  }
}

// ---------------------------------------------------------------------------
// Watt Toolkit (formerly Steam++).
// ---------------------------------------------------------------------------

/** Candidate install directories, relative to a Windows root variable. */
export const WATT_INSTALL_HINTS = [
  ['ProgramFiles', 'Watt Toolkit'],
  ['ProgramFiles(x86)', 'Watt Toolkit'],
  ['LOCALAPPDATA', 'Watt Toolkit'],
  ['ProgramFiles', 'Steam++'],
  ['ProgramFiles(x86)', 'Steam++'],
  ['LOCALAPPDATA', 'Steam++'],
] as const

async function detectWatt(): Promise<WattDetection> {
  const evidence: string[] = []
  if (process.platform === 'win32') {
    for (const [variable, folder] of WATT_INSTALL_HINTS) {
      const root = process.env[variable]
      if (typeof root !== 'string' || root.trim().length === 0) continue
      const candidate = join(root, folder)
      try {
        await access(candidate)
        evidence.push(`${variable}\\${folder}`)
      } catch {
        // Not installed at this location — the normal case.
      }
    }
  }

  return {
    detected: evidence.length > 0,
    evidence,
    note:
      '本插件不自带、也不内置任何代理。若已安装 Watt Toolkit（官网 steampp.net），请在它的「网络加速」里勾选 GitHub，再把上面检测到的系统代理地址填进「本机代理 / SOCKS5」。检测到安装目录不等于加速已启用。',
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export interface DetectOptions {
  /** The proxy address configured in the plugin, if any. */
  readonly localProxy?: string | undefined
}

/**
 * Run every probe. Never throws: an unavailable probe reports what it could not
 * see, because "unknown" is a legitimate answer for a picker to render.
 */
export async function detectEnvironment(options: DetectOptions = {}): Promise<DetectReport> {
  const pluginProxy = typeof options.localProxy === 'string' ? options.localProxy.trim() : ''
  const [proxy, watt, hosts] = await Promise.all([detectSystemProxy(pluginProxy), detectWatt(), detectHosts()])

  const notes: string[] = [...proxy.notes]
  if (pluginProxy.length > 0) {
    notes.push('本插件自己配置的代理地址已记录（仅存于 $DSH_HOME/dsh-codehub.json，权限 0600），并且仅 Node 直连传输生效。')
  }

  if (proxy.systemProxy === false && proxy.socks5 === false && pluginProxy.length > 0) {
    notes.push('系统里没有检测到代理，但本插件自己配置了代理地址 —— 该地址按设计只在 Node 直连传输生效。')
  }

  return {
    platform: process.platform,
    generatedAt: new Date().toISOString(),
    systemProxy: proxy.systemProxy,
    socks5: proxy.socks5,
    watt: watt.detected,
    hosts: hosts.entries.length > 0,
    proxyEnabled: proxy.enabled,
    proxySource: proxy.source,
    pluginProxy: pluginProxy.length > 0 ? pluginProxy : false,
    wattDetail: watt.evidence,
    hostsEntries: hosts.entries,
    hostsPath: hosts.path,
    notes: [...notes, watt.note, hosts.note],
  }
}
