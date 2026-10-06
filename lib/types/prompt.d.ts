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
import type { PromptSection, SystemPromptService } from '@deepseek-ai/dsh-system-prompt';
/** Stable section name. The `plugin:` prefix keeps it in the plugin band. */
export declare const PROMPT_SECTION_NAME = "plugin:dsh-codehub";
/** The exact section this plugin contributes, built from contract constants. */
export declare const PROMPT_SECTION: PromptSection;
export type PromptLogger = (event: string, detail?: Record<string, unknown>) => void;
/**
 * Owns at most one live prompt section.
 *
 * Construct it with `undefined` when the service is missing: `apply()` then
 * reports `false` and logs instead of throwing, so a missing optional service
 * cannot fail the plugin mount.
 */
export declare class PromptSectionController {
    private readonly service;
    private readonly log?;
    /** The live registration's disposer. Named `disposer` so the public method
     *  `dispose()` below does not collide with it. */
    private disposer;
    private state;
    constructor(service: SystemPromptService | undefined, log?: PromptLogger | undefined);
    /** True while a section is registered. */
    get registered(): boolean;
    /**
     * Make the live registration match `enabled`.
     *
     * Returns true when a section is registered afterwards. Safe to call
     * repeatedly; a no-op when the state already matches.
     */
    apply(enabled: boolean): boolean;
    /** Unregister without changing the desired state tracking. */
    private teardown;
    /** Idempotent. Call from the owning `ctx.effect` disposer. */
    dispose(): void;
}
export interface PromptSectionOptions {
    /** `config.announceToAgent` — defaults to announced (备注③ wants it on). */
    readonly enabled?: boolean;
    readonly log?: PromptLogger;
}
/**
 * Register (or skip) the section and return the controller that owns it.
 *
 * The caller threads this through `ctx.effect` so unloading the plugin removes
 * the section.
 */
export declare function createPromptSection(service: SystemPromptService | undefined, options?: PromptSectionOptions): PromptSectionController;
