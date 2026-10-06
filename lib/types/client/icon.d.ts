/**
 * dsh-codehub — the browser half's own glyphs.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Two reasons, both about not depending on the SDK's icon set:
 *
 *   1. `sidebar.panellist` — the sidebar rail row. That slot does NOT take a
 *      panel: the shell owns the button, the label text, the tooltip and the rail
 *      geometry, and hands the component a `{ size }` share so it draws ONLY the
 *      glyph. This is how every shipping panel row works (`dsh-ssh` passes
 *      `SshPanelIcon`, not its panel), and passing a full panel here is why the
 *      plugin's sidebar row never appeared.
 *   2. The small line-art glyphs (plus / close / refresh / chevron) are drawn
 *      here instead of imported. See their section below: the SDK renamed them and
 *      the rename silently blanked both seats.
 *
 * The glyphs are also shown in the panel/settings header, so the mark and the word
 * `codehub` are visually tied together everywhere the plugin names itself.
 *
 * THE CAT MARK
 * ------------
 * The path below is the `mark-github` glyph from GitHub's Octicons set, which is
 * MIT-licensed and whose entire purpose is to represent GitHub in a UI. It is
 * attributed here rather than silently inlined; everything else in this file is
 * drawn for this plugin. Every glyph uses `currentColor` so it inherits the
 * shell's theme colour and needs no literal colour (panel.module.css rule 1).
 *
 * The `data-dsh-panel-entry` attribute is the only DOM this plugin owns inside
 * the shell's row, and it is what lets a skin (or a test) identify which row
 * belongs to which plugin — the shell stamps no per-entry hook of its own.
 */
import type { ReactElement } from 'react';
/** What the shell passes to a sidebar row glyph: a square edge, in px. */
export interface PanelGlyphProps {
    size?: number;
}
/** Default glyph edge when the shell does not pass one. */
export declare const PANEL_GLYPH_SIZE = 16;
/**
 * THE LINE-ART GLYPHS ARE OURS, NOT THE SDK'S — on purpose.
 *
 * This plugin used to import `IconPlusOutline16`, `IconCloseOutline16`,
 * `IconRefreshOutline16` and `IconChevronDownOutline14` from
 * `@deepseek-ai/dsh-client-ui-primitives`. On the LIVE runtime (DSH 0.2.0-rc.2,
 * read straight out of `app.asar` by `scripts/check-sdk-surface.mjs`) those names
 * NO LONGER EXIST — they are `Icon*OutlineMedium` / `Icon*OutlineRegular` there.
 *
 * A renamed React component is not a build error while the repo's hand-written
 * type shim still declares the old name. It is `undefined` at runtime, and
 * rendering `<undefined />` throws — which took down the ENTIRE seat. The sidebar
 * row (a pure inline SVG using no SDK icons) rendered fine while both the panel
 * and the settings section came up blank.
 *
 * So these four glyphs are drawn here. It costs ~40 lines, removes a whole class
 * of cross-version breakage, and matches what shipping panels do (dsh-ssh draws
 * its own sidebar glyph too).
 */
/** Shared props for the small line-art glyphs. */
interface LineGlyphProps {
    /** Square edge in px. */
    size?: number;
    className?: string;
}
/** A plus sign (add a mirror row). */
export declare function IconPlus({ size, className }: LineGlyphProps): ReactElement;
/** A cross (remove a row, close a dialog). */
export declare function IconClose({ size, className }: LineGlyphProps): ReactElement;
/** A circular arrow (re-read the config). */
export declare function IconRefresh({ size, className }: LineGlyphProps): ReactElement;
/** A downward chevron (expand a group). */
export declare function IconChevronDown({ size, className }: LineGlyphProps): ReactElement;
/**
 * The GitHub cat mark, as a decorative glyph.
 *
 * `aria-hidden` because the shell's row already carries the accessible name
 * (`UI_ENTRY_LABEL`); announcing the mark too would double-announce the row.
 */
export declare function GitHubCatGlyph({ size }: PanelGlyphProps): ReactElement;
/**
 * The `sidebar.panellist` row component.
 *
 * Carries `data-dsh-panel-entry` so the row this glyph belongs to is
 * identifiable; see the file header.
 */
export declare function CodeHubPanelGlyph({ size }: PanelGlyphProps): ReactElement;
export {};
