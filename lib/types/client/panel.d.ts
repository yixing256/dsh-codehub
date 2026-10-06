/**
 * dsh-codehub — sidebar panel and the shared control surface.
 *
 * This file owns the 13 required controls (source priority, GitHub access,
 * the two tri-state decisions, accounts, mirror CRUD, local proxy, limits,
 * deep-read targets, the entry-placement escape hatch and the CSDN provenance
 * note). The settings page reuses `CodeHubControls` verbatim so the two
 * surfaces cannot drift — the task requires them to be the same fields from the
 * same data source.
 *
 * Non-negotiables encoded here:
 * - 备注① The local-proxy label carries `LOCAL_PROXY_SCOPE_NOTE` verbatim and
 *   the help text is `LOCAL_PROXY_HELP`; neither is translated, so the phrase
 *   cannot be lost in a dictionary edit.
 * - 备注② The CSDN block renders `CSDN_API_NOTE` verbatim and shows the
 *   endpoint base next to it.
 * - 备注③ Every result area carries `LEARNING_ONLY_BANNER`.
 * - Nothing is pre-filled: mirror lists start empty and only offer placeholders.
 * - Up/down buttons exist alongside drag-and-drop, so reordering works with a
 *   keyboard and on touch screens.
 * - Token vs mirror mutex is surfaced as a warning; the request builder
 *   enforces it, the UI only explains it.
 */
import type { SourceId } from '../contract.js';
import type { InputProps, ModalProps } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ComponentType, ReactElement } from 'react';
import type { ConnectivityRowView } from './api.js';
import { IconChevronDown, IconClose, IconPlus, IconRefresh } from './icon.js';
import type { Translate } from './locales.js';
/**
 * Typing bridge for the two remaining primitives: the SDK shim declares them as
 * returning `ReactNode`, React's JSX contract wants an element type. The runtime
 * components are used unchanged.
 *
 * `Input` is resolved defensively: if a future runtime renames it, the field
 * degrades to a plain native `<input>` instead of an undefined component, which
 * would otherwise blank every control on both surfaces.
 */
export declare const UIInput: ComponentType<InputProps>;
export declare const UIModal: ComponentType<ModalProps>;
/** The glyphs are re-exported so the settings card and dialogs share one source. */
export { IconChevronDown, IconClose, IconPlus, IconRefresh };
/** Props every seat of this plugin accepts. */
export interface SeatProps {
    t?: Translate;
    slot?: string;
}
/**
 * 备注③ — the banner every rendered result carries.
 *
 * Rendered verbatim from `LEARNING_ONLY_BANNER` (「仅学习参考 · 不得直接粘贴进用户项目」),
 * so a result surface cannot be added without the banner. The text is never
 * re-spelled here: the constant is the only source.
 */
export declare function LearningBanner({ t }: {
    t: Translate;
}): ReactElement;
/**
 * The three rows, rendered from normalised data ONLY.
 *
 * WHY IT IS A SEPARATE, PURE COMPONENT: the display contract ("three rows, the
 * reason on the line below the failed row, no raw payload") is the part the user
 * asked for, and it must be testable without a live host or a click. Nothing
 * here can reach a payload: it receives `ConnectivityRowView[]`, a type that has
 * no field able to hold a response body.
 */
export declare function ConnectivityRows(props: {
    t: Translate;
    rows: readonly ConnectivityRowView[];
    copied: SourceId | null;
    onCopyReason: (row: ConnectivityRowView) => void;
}): ReactElement;
export declare function CodeHubControls({ t, variant }: {
    t: Translate;
    variant: 'panel' | 'settings';
}): ReactElement;
export declare function CodeHubPanel(props: SeatProps): ReactElement;
