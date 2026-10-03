/**
 * dsh-codehub — system-prompt section (备注③, docs/DESIGN.md §5).
 *
 * The anti-plagiarism statement has to reach the model through TWO surfaces:
 * the `learn_code_from_web` tool description (`ANTI_COPY_TOOL_CLAUSE`) and this
 * prompt section (`PROMPT_SECTION_TEXT`). Both are derived from the single
 * `ANTI_COPY_STATEMENT` constant in `src/contract.ts`; this file imports the
 * text and NEVER re-spells it. A test asserts both surfaces contain that same
 * constant, which is only meaningful because there is exactly one copy.
 *
 * REGISTRATION DISCIPLINE
 * -----------------------
 * `systemPrompt.section()` is keyed by name: registering `plugin:dsh-codehub`
 * twice throws. `config.announceToAgent` can therefore not be a naive
 * `if (enabled) register()` — toggling it would either throw or leak the old
 * registration. The controller below keeps a SINGLE disposer, tears the old
 * section down before building the new one, and is idempotent when the desired
 * state has not changed. That is the "拆旧的再建新的" pattern the brief asks for.
 */

import { PACKAGE_NAME, PROMPT_SECTION_ORDER, PROMPT_SECTION_TEXT } from './contract.js'
import type { PromptSection, SystemPromptService } from '@deepseek-ai/dsh-system-prompt'

/** Stable section name. The `plugin:` prefix keeps it in the plugin band. */
export const PROMPT_SECTION_NAME = `plugin:${PACKAGE_NAME}`

/** The exact section this plugin contributes, built from contract constants. */
export const PROMPT_SECTION: PromptSection = {
  name: PROMPT_SECTION_NAME,
  order: PROMPT_SECTION_ORDER,
  text: PROMPT_SECTION_TEXT,
}

export type PromptLogger = (event: string, detail?: Record<string, unknown>) => void

/**
 * Owns at most one live prompt section.
 *
 * Construct it with `undefined` when the service is missing: `apply()` then
 * reports `false` and logs instead of throwing, so a missing optional service
 * cannot fail the plugin mount.
 */
export class PromptSectionController {
  /** The live registration's disposer. Named `disposer` so the public method
   *  `dispose()` below does not collide with it. */
  private disposer: (() => void) | undefined

  private state: boolean | undefined

  constructor(
    private readonly service: SystemPromptService | undefined,
    private readonly log?: PromptLogger,
  ) {}

  /** True while a section is registered. */
  get registered(): boolean {
    return this.disposer !== undefined
  }

  /**
   * Make the live registration match `enabled`.
   *
   * Returns true when a section is registered afterwards. Safe to call
   * repeatedly; a no-op when the state already matches.
   */
  apply(enabled: boolean): boolean {
    // Idempotent when the live registration already matches the desired state
    // (and the previous attempt actually succeeded).
    if (this.state === enabled && this.registered === enabled) {
      return this.registered
    }
    this.teardown()

    if (!enabled) {
      this.state = false
      return false
    }

    if (this.service === undefined) {
      this.state = true
      this.log?.('systemPrompt 服务不可用，防搬运声明段未注册（工具描述里的声明仍然生效）')
      return false
    }

    try {
      const disposer = this.service.section({ ...PROMPT_SECTION })
      this.disposer = typeof disposer === 'function' ? disposer : undefined
      this.state = true
      return this.disposer !== undefined
    } catch (error) {
      // A duplicate-name error must never escape into the plugin mount.
      this.state = true
      this.log?.('注册 systemPrompt 段失败', {
        section: PROMPT_SECTION_NAME,
        reason: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /** Unregister without changing the desired state tracking. */
  private teardown(): void {
    const disposer = this.disposer
    this.disposer = undefined
    if (disposer === undefined) return
    try {
      disposer()
    } catch (error) {
      this.log?.('注销 systemPrompt 段失败', {
        section: PROMPT_SECTION_NAME,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Idempotent. Call from the owning `ctx.effect` disposer. */
  dispose(): void {
    this.teardown()
    this.state = false
  }
}

export interface PromptSectionOptions {
  /** `config.announceToAgent` — defaults to announced (备注③ wants it on). */
  readonly enabled?: boolean
  readonly log?: PromptLogger
}

/**
 * Register (or skip) the section and return the controller that owns it.
 *
 * The caller threads this through `ctx.effect` so unloading the plugin removes
 * the section.
 */
export function createPromptSection(
  service: SystemPromptService | undefined,
  options: PromptSectionOptions = {},
): PromptSectionController {
  const controller = new PromptSectionController(service, options.log)
  controller.apply(options.enabled !== false)
  return controller
}
