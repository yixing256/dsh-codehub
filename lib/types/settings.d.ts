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
import type { Context } from '@deepseek-ai/cordis';
import type { CodehubConfig } from './config.js';
/** One line the UI can show when the profile-backed settings page is unavailable. */
export declare const SETTINGS_FALLBACK_NOTE: string;
export interface SettingsReadResult {
    readonly available: boolean;
    readonly value: CodehubConfig | undefined;
    readonly revision: number | undefined;
    readonly error?: string;
}
export interface SettingsWriteResult {
    readonly ok: boolean;
    readonly verified: boolean;
    readonly error?: string;
}
export interface SettingsBridge {
    /** False when the context has no `settings` service at all. */
    readonly available: boolean;
    /** Register the auto-derived form. Returns a disposer; never throws. */
    configure(): () => void;
    read(): Promise<SettingsReadResult>;
    patch(patch: CodehubConfig): Promise<SettingsWriteResult>;
}
/**
 * Wrap the optional `settings` service.
 *
 * `ctx.get('settings')` — never `ctx.settings`. Reading an un-injected service
 * property throws on this runtime, and an exception thrown while mounting a
 * plugin can take the whole install down with it.
 */
export declare function createSettingsBridge(ctx: Context): SettingsBridge;
