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

import type { ReactElement } from 'react'

import { UI_ENTRY_ID } from '../contract.js'

/** What the shell passes to a sidebar row glyph: a square edge, in px. */
export interface PanelGlyphProps {
  size?: number
}

/** Default glyph edge when the shell does not pass one. */
export const PANEL_GLYPH_SIZE = 16

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
  size?: number
  className?: string
}

/** Attributes shared by every line-art glyph: line art, theme-coloured, hidden. */
function lineGlyph(size: number, className?: string) {
  return {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': 'true' as const,
    focusable: 'false' as const,
    ...(className === undefined ? {} : { className }),
  }
}

/** A plus sign (add a mirror row). */
export function IconPlus({ size = PANEL_GLYPH_SIZE, className }: LineGlyphProps): ReactElement {
  return (
    <svg {...lineGlyph(size, className)}>
      <path d="M8 3.25v9.5" />
      <path d="M3.25 8h9.5" />
    </svg>
  )
}

/** A cross (remove a row, close a dialog). */
export function IconClose({ size = PANEL_GLYPH_SIZE, className }: LineGlyphProps): ReactElement {
  return (
    <svg {...lineGlyph(size, className)}>
      <path d="M4.2 4.2l7.6 7.6" />
      <path d="M11.8 4.2l-7.6 7.6" />
    </svg>
  )
}

/** A circular arrow (re-read the config). */
export function IconRefresh({ size = PANEL_GLYPH_SIZE, className }: LineGlyphProps): ReactElement {
  return (
    <svg {...lineGlyph(size, className)}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.7-3.85" />
      <path d="M13.25 2.6v3.4h-3.4" />
    </svg>
  )
}

/** A downward chevron (expand a group). */
export function IconChevronDown({ size = 14, className }: LineGlyphProps): ReactElement {
  return (
    <svg {...lineGlyph(size, className)}>
      <path d="M3.9 6.1L7 9.2l3.1-3.1" />
    </svg>
  )
}

/**
 * The GitHub cat mark, as a decorative glyph.
 *
 * `aria-hidden` because the shell's row already carries the accessible name
 * (`UI_ENTRY_LABEL`); announcing the mark too would double-announce the row.
 */
export function GitHubCatGlyph({ size = PANEL_GLYPH_SIZE }: PanelGlyphProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/**
 * The `sidebar.panellist` row component.
 *
 * Carries `data-dsh-panel-entry` so the row this glyph belongs to is
 * identifiable; see the file header.
 */
export function CodeHubPanelGlyph({ size = PANEL_GLYPH_SIZE }: PanelGlyphProps): ReactElement {
  return (
    <span data-dsh-panel-entry={UI_ENTRY_ID} style={{ display: 'inline-flex', lineHeight: 0 }}>
      <GitHubCatGlyph size={size} />
    </span>
  )
}
