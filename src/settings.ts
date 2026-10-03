/**
 * dsh-codehub — settings integration (optional enhancement only).
 *
 * THE RUNTIME FACT THIS MODULE IS BUILT AROUND
 * --------------------------------------------
 * `settings` on this runtime has NO `installSection` and NO `register` — only
 * `configure` / `describe` / `update` / `replace` / `mutate` (types/dsh/index.d.ts
 * records the observed method list, and dsh-ssh's `installSection` block is dead
 * code on this build, NOT a recipe). The settings form is derived automatically
 * from the schemastery `Config` exported by `src/config.ts`.
 *
 * So this file does exactly three small things:
 *
 *   1. `settings.configure({ auto: true })` when that callable exists, guarded,
 *      so a runtime without it degrades to "the schema-derived form only".
 *   2. A read path (`describe({ redactSecrets: true })`) used to merge the user's
 *      settings into the effective configuration.
 *   3. A write path that READS BACK after `update()`, because the documented trap
 *      is that a refused mutation resolves rather than rejects: in this API a
 *      successful `await` proves nothing, only the settled snapshot does.
 *
 * Everything is optional. If the service is absent, or our namespace is not
 * whitelisted (`status: 'unavailable'` on the client side is the symptom), the
 * browser half still reads and writes configuration through this plugin's own
 * loopback route, and `store.ts` keeps a fallback snapshot so no decision is
 * lost. A missing settings service is never an error.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor, SettingsService } from '@deepseek-ai/dsh-settings'

import { SETTINGS_NAMESPACE } from './contract.js'
import type { CodehubConfig } from './config.js'
import { mergeConfigInput } from './config.js'

/** One line the UI can show when the profile-backed settings page is unavailable. */
export const SETTINGS_FALLBACK_NOTE =
  '本插件的设置 namespace 不在 DSH settings RPC 的白名单里时，设置页会显示为不可用；' +
  '配置面板与设置页组件都改走插件自己的 /api/dsh-codehub/config 路由读写，功能不受影响。'

export interface SettingsReadResult {
  readonly available: boolean
  readonly value: CodehubConfig | undefined
  readonly revision: number | undefined
  readonly error?: string
}

export interface SettingsWriteResult {
  readonly ok: boolean
  readonly verified: boolean
  readonly error?: string
}

export interface SettingsBridge {
  /** False when the context has no `settings` service at all. */
  readonly available: boolean
  /** Register the auto-derived form. Returns a disposer; never throws. */
  configure(): () => void
  read(): Promise<SettingsReadResult>
  patch(patch: CodehubConfig): Promise<SettingsWriteResult>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Wrap the optional `settings` service.
 *
 * `ctx.get('settings')` — never `ctx.settings`. Reading an un-injected service
 * property throws on this runtime, and an exception thrown while mounting a
 * plugin can take the whole install down with it.
 */
export function createSettingsBridge(ctx: Context): SettingsBridge {
  const service = ctx.get<SettingsService>('settings')
  const available = service !== undefined

  function descriptorFor(): SettingsDescriptor | undefined {
    if (service === undefined) return undefined
    try {
      const list = service.describe({ redactSecrets: true })
      if (!Array.isArray(list)) return undefined
      return list.find((item) => item !== undefined && item !== null && item.ns === SETTINGS_NAMESPACE)
    } catch {
      return undefined
    }
  }

  async function readSettings(): Promise<SettingsReadResult> {
    if (service === undefined) {
      return { available: false, value: undefined, revision: undefined }
    }
    const descriptor = descriptorFor()
    if (descriptor === undefined) {
      return {
        available: false,
        value: undefined,
        revision: undefined,
        error: 'settings 服务里没有 dsh-codehub 这个 namespace（可能不在 RPC 白名单内）。',
      }
    }
    return {
      available: true,
      value: isRecord(descriptor.value) ? (descriptor.value as CodehubConfig) : undefined,
      revision: typeof descriptor.revision === 'number' ? descriptor.revision : undefined,
    }
  }

  return {
    available,

    configure(): () => void {
      if (service === undefined) return () => undefined
      const configure = (service as { configure?: unknown }).configure
      if (typeof configure !== 'function') {
        // Not present on every runtime build; the schema-derived form still works.
        return () => undefined
      }
      try {
        const dispose = (configure as (presentation: { auto?: boolean }) => unknown).call(service, { auto: true })
        return typeof dispose === 'function'
          ? () => {
              try {
                ;(dispose as () => void)()
              } catch {
                // A disposer that throws during unload must not break unload.
              }
            }
          : () => undefined
      } catch {
        return () => undefined
      }
    },

    read: readSettings,

    async patch(patch: CodehubConfig): Promise<SettingsWriteResult> {
      if (service === undefined) {
        return { ok: false, verified: false, error: '当前上下文没有 settings 服务。' }
      }
      try {
        await service.update(SETTINGS_NAMESPACE, patch as object)
      } catch (error) {
        return { ok: false, verified: false, error: messageOf(error) }
      }

      // A refused mutation RESOLVES instead of rejecting, so the write only
      // counts once the settled snapshot agrees with it.
      const settled = await readSettings()
      if (!settled.available) {
        return { ok: true, verified: false, ...(settled.error === undefined ? {} : { error: settled.error }) }
      }
      const settledRaw: unknown = settled.value
      if (!isRecord(settledRaw)) {
        return { ok: true, verified: false, error: 'settings 未返回可比较的快照，无法确认写入是否生效。' }
      }
      const expected = mergeConfigInput(settled.value, patch)
      let matched = true
      for (const [key, value] of Object.entries(expected)) {
        const actual = settledRaw[key]
        if (isRecord(value)) {
          if (!isRecord(actual)) {
            matched = false
            break
          }
          for (const [innerKey, innerValue] of Object.entries(value)) {
            if (innerValue === null || innerValue === undefined) continue
            if (actual[innerKey] !== innerValue) {
              matched = false
              break
            }
          }
        } else if (value !== null && value !== undefined && actual !== value) {
          matched = false
        }
        if (!matched) break
      }
      return matched
        ? { ok: true, verified: true }
        : { ok: true, verified: false, error: 'settings 没有把本次修改持久化（namespace 可能存在但只读）。' }
    },
  }
}
