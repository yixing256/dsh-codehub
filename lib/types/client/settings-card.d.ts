/**
 * dsh-codehub — settings page seat (`settings.section`).
 *
 * Same fields, same data source, same components as the sidebar panel: it
 * renders `CodeHubControls` from panel.tsx, so the two surfaces cannot drift.
 * The only differences are the shell (a wider, form-shaped container) and the
 * optional `settingsScope` mirror, which is reported as a status line rather
 * than treated as a dependency.
 *
 * `settingsScope` may be `unavailable` — the namespace is not guaranteed to be
 * on the DSH settings allow-list. That state is displayed as information and
 * never blocks a read or a write; the plugin route remains the source of truth.
 */
import type { ReactElement } from 'react';
import type { Translate } from './locales.js';
export interface SettingsCardProps {
    t?: Translate;
    slot?: string;
    /** Supplied by the registration's inject face when a settings scope exists. */
    scope?: unknown;
}
export declare function CodeHubSettingsCard(props: SettingsCardProps): ReactElement;
