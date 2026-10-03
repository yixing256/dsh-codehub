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
import type { WebServerService } from '@deepseek-ai/dsh-host-webserver'
import type { SystemPromptService } from '@deepseek-ai/dsh-system-prompt'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import type { WebService } from '@deepseek-ai/dsh-web'

import { HARD_LIMITS, PACKAGE_NAME, SOURCES } from './contract.js'
import type { CodehubConfig } from './config.js'
import { createConsoleLogger } from './net.js'
import { createPromptSection } from './prompt.js'
import { registerRoutes } from './routes.js'
import { CodeSource } from './service.js'
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
    return registerRoutes({ webServer, ctx, service: active, store, settings, logger: log })
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
