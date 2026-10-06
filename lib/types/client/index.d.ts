/**
 * dsh-codehub — browser half entry point.
 *
 * LOADER CONTRACT
 * ---------------
 * The bundle is wrapped by the DSH client module loader as
 * `window.__ModuleLoader__.load({ id, factory })` and must expose a NAMED
 * `apply` and a NAMED `inject`. There is no default export, and no `Config`.
 *
 * FAILURE CONTRACT
 * ----------------
 * A client plugin whose `apply` throws takes the whole GUI down with it. So
 * every step here is individually wrapped: a locale that will not register, a
 * slot that is never declared, a config route that is not wired up yet — each
 * one degrades to a log line, never to an exception.
 *
 * SLOT CONTRACT
 * -------------
 * `ctx.slots.register` THROWS on a slot the ledger has not declared yet, so
 * every seat goes through `ctx.slots.inject(slot, cb)`, which waits for the
 * declaration and then registers inside the callback.
 *
 * SIDEBAR ROW CONTRACT — this is not the panel
 * --------------------------------------------
 * `sidebar.panellist` takes a GLYPH, not a page. The shell owns the row button,
 * the label, the tooltip and the rail geometry, and passes the component only a
 * `{ size }` share (verified against shipping panels: `dsh-ssh` registers
 * `SshPanelIcon` there and its page on `main`). Registering the full panel on
 * this slot — which this plugin used to do — leaves the row broken/unusable, so
 * the entry is effectively invisible. `CodeHubPanelGlyph` draws the GitHub cat
 * mark; `main` carries the panel itself.
 *
 * PLACEMENT CONTRACT
 * ------------------
 * Both surfaces are ON by default and the user changes that from the plugin's
 * own settings page, not from a first-run dialog — there is no chooser left to
 * ask with. `entryPlacement` is an ordinary saved setting: the seats follow the
 * SAVED config, never the unsaved draft, so a placement change takes effect
 * exactly once, when the user saves. That is implemented by subscribing to the
 * config store below rather than by a dialog callback.
 *
 * Switching placements tears the old registrations down BEFORE the new ones are
 * created — re-registering the same seat id while the old one is live would
 * throw, and a caught throw would silently leave the user on the old placement.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LocaleService } from '@deepseek-ai/dsh-client-locale';
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-renderer';
/**
 * The services this bundle needs. Declared as a NAMED export — the loader reads
 * it before calling `apply`.
 *
 * `settingsScope` is DELIBERATELY NOT LISTED, and adding it back HARD-FAILS THE
 * WHOLE BOOT.
 *
 * The loader treats `inject` as a hard requirement: an entry still waiting for a
 * named service never activates, and a profile with an unactivated entry aborts
 * with `web boot: 1 entry did not activate` /
 * `dsh-codehub: pending (waiting for service: settingsScope)`. On this runtime
 * `settingsScope` is not in the client service roster at all (observed:
 * layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces),
 * so the entry would wait forever.
 *
 * It is also unnecessary: `attachSettings()` below treats the settings mirror as
 * an optional enhancement — it probes `webUiSettings`, then falls back to a
 * property read, and otherwise logs and continues with the plugin's own
 * `/api/dsh-codehub/config` route as the only config path. A hard dependency on
 * a service that may not exist is exactly the wrong shape for that.
 */
export declare const inject: string[];
/** The client context, narrowed to the services named in `inject`. */
interface ClientContext extends Context {
    readonly slots: SlotsService;
    readonly locale: LocaleService;
}
export declare function apply(ctx: ClientContext): void;
export {};
