/**
 * dsh-codehub — Cordis plugin entry (host half).
 *
 * WHAT THE LOADER SEES
 * --------------------
 *   `name`   — the plugin name (contract, never aliased)
 *   `inject` — `['tools', 'webServer', 'systemPrompt']`; `apply` runs once those
 *              are available
 *   `Config` — the schemastery schema the settings form is DERIVED from
 *   `apply`  — mounts the service, the tool, the routes and the prompt section
 *
 * Everything else here is a re-export for tests and for the browser half's
 * benefit, not part of the plugin contract.
 *
 * MOUNT ONCE, AND RE-APPLY CLEANLY
 * -------------------------------
 * Routes are keyed by `(kind, path)` and the prompt section is keyed by name, so
 * mounting the same plugin twice would throw on the second registration. A
 * `Symbol.for('dsh-codehub.mounted')` marker on `globalThis` guards that — and it
 * holds the CURRENT mount's disposer rather than a bare boolean, so a second
 * `apply` (a config change) tears the old mount down and rebuilds instead of
 * silently keeping stale settings. Unloading the fiber clears the marker.
 *
 * Each surface is its own `ctx.effect` group, so the whole plugin can be
 * disposed (and disposed partially: a failing group does not take the others
 * with it). Nothing in `apply` throws — a throw during mount can fail the entire
 * plugin install, which is a much worse outcome than a missing panel.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialsService } from '@deepseek-ai/dsh-credentials'
import type { WebServerService } from '@deepseek-ai/dsh-host-webserver'
import type { SystemPromptService } from '@deepseek-ai/dsh-system-prompt'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import type { WebService } from '@deepseek-ai/dsh-web'

import { HARD_LIMITS, PACKAGE_NAME, SOURCES } from './contract.js'
import type { CodehubConfig } from './config.js'
import { createConsoleLogger, createPostTransport, createTransport, isOfficialPostHost } from './net.js'
import { createOAuthService } from './oauth.js'
import { createBrowserLauncher } from './launcher.js'
import type { BrowserLauncher } from './launcher.js'
import type { OAuthService } from './oauth.js'
import { createPromptSection } from './prompt.js'
import { registerRoutes } from './routes.js'
import { CREDENTIAL_REFS, CodeSource } from './service.js'
import { createSettingsBridge } from './settings.js'
import { LocalConfigStore } from './store.js'
import { buildLearnCodeTool } from './tool.js'

// ---------------------------------------------------------------------------
// Plugin surface.
// ---------------------------------------------------------------------------

/** Plugin name and required injections come straight from the contract. */
export { name, inject } from './contract.js'

/** The schema the settings form is derived from (no `installSection` exists). */
export { Config } from './config.js'

/**
 * Re-exports for tests and for anyone reading the host half from the outside.
 * The 备注③ surfaces in particular must be importable without a live context.
 */
export { redactForDelivery } from './service.js'
export { LEARN_CODE_TOOL, LEARN_CODE_TOOL_DESCRIPTION } from './tool.js'
export { PROMPT_SECTION, PROMPT_SECTION_NAME } from './prompt.js'
export { evaluateDecisions, unresolvedDecisions } from './gating.js'
export { isLoopbackRequest } from './routes.js'

// ---------------------------------------------------------------------------
// Single-instance guard.
// ---------------------------------------------------------------------------

/** `Symbol.for`, so the marker is shared even if the module is loaded twice. */
const MOUNT_KEY: symbol = Symbol.for('dsh-codehub.mounted')

interface MountRecord {
  readonly dispose: () => void
}

/** `globalThis` viewed as a symbol-keyed registry. */
const registry = globalThis as unknown as Record<symbol, MountRecord | undefined>

/** Diagnostics: is this plugin currently mounted in this process? */
export function isMounted(): boolean {
  return registry[MOUNT_KEY] !== undefined
}

// ---------------------------------------------------------------------------
// apply.
// ---------------------------------------------------------------------------

/**
 * Mount the plugin.
 *
 * @param ctx   the Cordis context (services reached with `ctx.get`, never as
 *              properties — an un-injected service property throws here).
 * @param config the resolved configuration; every field is optional, and the
 *              four decisions are deliberately absent until the user answers.
 */
export function apply(ctx: Context, config: CodehubConfig = {}): void {
  const log = createConsoleLogger()

  const previous = registry[MOUNT_KEY]
  if (previous !== undefined) {
    // Re-apply: rebuild rather than double-register.
    try {
      previous.dispose()
    } catch {
      // A failing old mount must not block the new one.
    }
    delete registry[MOUNT_KEY]
  }

  const mount = mountAll(ctx, config, log)
  registry[MOUNT_KEY] = mount
  log('已挂载', { plugin: PACKAGE_NAME, enabled: config.enabled !== false })
}

function mountAll(
  ctx: Context,
  config: CodehubConfig,
  log: (event: string, detail?: Record<string, unknown>) => void,
): MountRecord {
  const disposers: (() => void)[] = []

  /** One `ctx.effect` group. A failure is logged, never thrown. */
  function group(label: string, body: () => void | (() => void)): void {
    try {
      const dispose = ctx.effect(body, label)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log('挂载分组失败', { group: label, reason: describe(error) })
    }
  }

  // Optional services. `ctx.get` returns undefined instead of throwing.
  const tools = ctx.get<ToolsService>('tools')
  const webServer = ctx.get<WebServerService>('webServer')
  const systemPrompt = ctx.get<SystemPromptService>('systemPrompt')
  const web = ctx.get<WebService>('web')

  const store = new LocalConfigStore()
  const settings = createSettingsBridge(ctx)
  const getConfig = (): CodehubConfig => config

  let service: CodeSource | undefined
  const currentService = (): CodeSource | undefined => service

  // The OAuth engine: built once per mount, injected into the routes. A failure
  // here must not take the mount down — the `/oauth` routes answer 503 and every
  // other surface keeps working (a PAT / cookie paste needs none of this).
  let oauth: OAuthService | undefined
  try {
    oauth = createOAuthService({
      post: buildPostTransport(config, store, log),
      writeCredential: async (ref, value) => {
        const credentials = ctx.get<CredentialsService>('credentials')
        if (credentials === undefined) throw new Error('credentials 服务不可用，无法保存登录结果。')
        await credentials.set(ref, value)
      },
      readCredential: async (ref) => {
        const credentials = ctx.get<CredentialsService>('credentials')
        if (credentials === undefined) return undefined
        try {
          const resolved = await credentials.resolve(ref)
          const value = resolved?.value
          return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
        } catch {
          return undefined
        }
      },
      credentialRefFor: (source) => CREDENTIAL_REFS[source],
      probeHost: probeProviderHost,
      logger: log,
    })
  } catch (error) {
    oauth = undefined
    log('OAuth 引擎构造失败，/oauth 路由将返回 503', { reason: describe(error) })
  }

  // The local browser launcher for the experimental CDP capture. Built here so the
  // route can answer 503 when it is missing, instead of the panel offering a button
  // that cannot work. It holds no credential: it locates a Chromium, starts it on a
  // dedicated profile under `$DSH_HOME`, and reports the loopback debugger URL.
  let launcher: BrowserLauncher | undefined
  try {
    launcher = createBrowserLauncher({})
  } catch (error) {
    launcher = undefined
    log('浏览器 launcher 构造失败，/launch-browser 将返回 503', { reason: describe(error) })
  }

  // -- 1. the service ------------------------------------------------------
  group('dsh-codehub: service', () => {
    const created = new CodeSource(ctx, {
      getConfig,
      store,
      settings,
      logger: log,
      ...(web === undefined ? {} : { web }),
    })
    service = created
    log('codeSource 服务已注册', { sources: SOURCES.length })
    return () => {
      service = undefined
    }
  })

  // -- 2. the tool ---------------------------------------------------------
  group('dsh-codehub: tool', () => {
    if (tools === undefined) {
      log('tools 服务不可用，未注册 learn_code_from_web')
      return
    }
    const definition = buildLearnCodeTool({
      get service() {
        return currentService()
      },
      getLimits: () => currentService()?.getLimits() ?? { timeoutMs: HARD_LIMITS.timeoutMs },
    })
    const dispose = tools.register(definition)
    log('工具已注册')
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  // -- 3. routes -----------------------------------------------------------
  group('dsh-codehub: routes', () => {
    const active = currentService()
    if (webServer === undefined) {
      log('webServer 服务不可用，未注册 /api/dsh-codehub/*')
      return
    }
    if (active === undefined) {
      log('codeSource 未就绪，未注册 /api/dsh-codehub/*')
      return
    }
    return registerRoutes({
      webServer,
      ctx,
      service: active,
      store,
      settings,
      logger: log,
      ...(oauth === undefined ? {} : { oauth }),
      ...(launcher === undefined ? {} : { launcher }),
    })
  })

  // -- 4. the prompt section (备注③ surface #2) ----------------------------
  group('dsh-codehub: prompt', () => {
    const controller = createPromptSection(systemPrompt, {
      enabled: config.announceToAgent !== false,
      log,
    })
    return () => controller.dispose()
  })

  // -- 5. optional settings integration ------------------------------------
  group('dsh-codehub: settings', () => settings.configure())

  // -- 6. the mount marker itself -----------------------------------------
  const record: MountRecord = {
    dispose: () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Unload must never throw.
        }
      }
      disposers.length = 0
    },
  }

  try {
    const guard = ctx.effect(
      () => () => {
        if (registry[MOUNT_KEY] === record) delete registry[MOUNT_KEY]
      },
      'dsh-codehub: mount guard',
    )
    if (typeof guard === 'function') disposers.push(guard)
  } catch (error) {
    log('挂载守卫注册失败', { reason: describe(error) })
  }

  return record
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return '无法读取的错误对象'
  }
}

// ---------------------------------------------------------------------------
// Browser-login plumbing (docs/DESIGN.md §7.2 / §7.3).
// ---------------------------------------------------------------------------

/** How long the reachability preflight may take. Short: it gates a user action. */
const HOST_PROBE_TIMEOUT_MS = 5_000

/** The provider hosts this plugin may probe. Anything else is not ours to dial. */
function isProbeableHost(host: string): boolean {
  return isOfficialPostHost(host.replace(/^https?:\/\//, '').split('/')[0] ?? '')
}

/**
 * Value-free reachability preflight for the OAuth engine (`probeHost`).
 *
 * WHY IT EXISTS: this machine cannot open `github.com` (TCP 443 times out,
 * docs/DESIGN.md §7.1), so a device flow would hang and then fail with a
 * transport error. Answering "unreachable" BEFORE the first request is what lets
 * the panel offer the PAT path instead.
 *
 * Never throws: a preflight that threw would be indistinguishable from a broken
 * flow, and the engine must be able to turn a `false` into a sentence.
 */
async function probeProviderHost(host: string, signal?: AbortSignal): Promise<{ reachable: boolean; detail: string }> {
  if (!isProbeableHost(host)) {
    return { reachable: false, detail: `不在可达性预检白名单里（只预检 github.com / gitee.com 及其子域）：${host}` }
  }
  const target = host.startsWith('http') ? host : `https://${host}`
  try {
    // No logger on purpose: an unreachable github.com is the EXPECTED state here
    // and its detail travels to the user through the return value, not the log.
    const transport = createTransport({ transport: 'node', retries: 0, timeoutMs: HOST_PROBE_TIMEOUT_MS, logger: () => {} })
    const response = await transport({
      url: target,
      timeoutMs: HOST_PROBE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    })
    // Any HTTP answer proves the TCP/TLS path works, even a 404 or a 403.
    return { reachable: response.statusCode > 0, detail: `HTTP ${response.statusCode}` }
  } catch (error) {
    return { reachable: false, detail: describe(error) }
  }
}

/**
 * The POST seam the OAuth engine gets (`createPostTransport`).
 *
 * The proxy address is read LAZILY from a mutable box: the transport must be
 * built synchronously during mount, while the winning address lives in the 0600
 * store and can only be read asynchronously. `resolveConfig()` lets the store
 * beat the schema field, and the login exchange has to follow the same rule —
 * otherwise a user who set the proxy only in the store would see the credential
 * exchange leave untunneled.
 */
function buildPostTransport(
  config: CodehubConfig,
  store: LocalConfigStore,
  log: (event: string, detail?: Record<string, unknown>) => void,
): ReturnType<typeof createPostTransport> {
  const box: { localProxy?: string } = { localProxy: readConfiguredProxy(config) }
  void store
    .read()
    .then((stored) => {
      const value = typeof stored.localProxy === 'string' ? stored.localProxy.trim() : ''
      if (value.length > 0) box.localProxy = value
    })
    .catch((error: unknown) => {
      log('读取本机代理地址失败，OAuth 将按配置字段里的地址出网', { reason: describe(error) })
    })
  return createPostTransport(box)
}

/** `github.localProxy` off the (tolerant) Cordis config object. */
function readConfiguredProxy(config: CodehubConfig): string {
  const group = config.github
  return typeof group?.localProxy === 'string' ? group.localProxy.trim() : ''
}
