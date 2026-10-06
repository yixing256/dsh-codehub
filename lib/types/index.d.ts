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
import type { Context } from '@deepseek-ai/cordis';
import type { CodehubConfig } from './config.js';
/** Plugin name and required injections come straight from the contract. */
export { name, inject } from './contract.js';
/** The schema the settings form is derived from (no `installSection` exists). */
export { Config } from './config.js';
/**
 * Re-exports for tests and for anyone reading the host half from the outside.
 * The 备注③ surfaces in particular must be importable without a live context.
 */
export { redactForDelivery } from './service.js';
export { LEARN_CODE_TOOL, LEARN_CODE_TOOL_DESCRIPTION } from './tool.js';
export { PROMPT_SECTION, PROMPT_SECTION_NAME } from './prompt.js';
export { evaluateDecisions, unresolvedDecisions } from './gating.js';
export { isLoopbackRequest } from './routes.js';
/** Diagnostics: is this plugin currently mounted in this process? */
export declare function isMounted(): boolean;
/**
 * Mount the plugin.
 *
 * @param ctx   the Cordis context (services reached with `ctx.get`, never as
 *              properties — an un-injected service property throws here).
 * @param config the resolved configuration; every field is optional, and the
 *              four decisions are deliberately absent until the user answers.
 */
export declare function apply(ctx: Context, config?: CodehubConfig): void;
