/**
 * dsh-codehub — first-run entry-placement chooser.
 *
 * Rendered in the `shell.overlay` slot. Three placements, and the choice is
 * written to BOTH the host config (PATCH /api/dsh-codehub/config) and a local
 * one-shot latch (`dsh-codehub:first-run:v1`), because a placement is a user
 * decision that must survive a reload even when the host route is not wired up
 * yet.
 *
 * There is no first-run hook in this runtime, so the latch is the whole
 * mechanism — and because a latch can get out of sync with reality, the chooser
 * is ALWAYS reopenable from the panel and the settings page
 * (`openFirstRunChooser`). Choosing again tears the old registrations down
 * before the new ones are registered (see index.ts).
 *
 * Storage access is wrapped: localStorage can be disabled (privacy mode, quota,
 * partitioned iframe), so every read/write falls through to sessionStorage and
 * finally to "no latch" rather than throwing inside a seat render.
 */
import type { ReactNode } from 'react';
import type { EntryPlacement } from './api.js';
import type { Translate } from './locales.js';
/** The one-shot latch key. */
export declare const FIRST_RUN_KEY = "dsh-codehub:first-run:v1";
/** Read the latch. Returns null when nothing is stored or storage is unusable. */
export declare function readLatch(): string | null;
/** Write the latch. Silently does nothing when every storage is unusable. */
export declare function writeLatch(placement: EntryPlacement): void;
export interface FirstRunState {
    open: boolean;
    /** The placement currently in effect, used to pre-select a radio. */
    current: EntryPlacement;
    saving: boolean;
    error: string | null;
}
export declare function subscribeFirstRun(listener: () => void): () => void;
export declare function getFirstRunState(): FirstRunState;
export declare function useFirstRunState(): FirstRunState;
/** Open the chooser. Also the escape hatch behind "重新打开入口位置选择". */
export declare function openFirstRunChooser(current: EntryPlacement): void;
export declare function closeFirstRunChooser(): void;
type PlacementHandler = (placement: EntryPlacement) => void | Promise<void>;
export declare function setPlacementHandler(handler: PlacementHandler | null): void;
export interface FirstRunOverlayProps {
    t?: Translate;
    /** Injected by the registration face; falls back to the module handler. */
    onChoose?: PlacementHandler;
}
export declare function FirstRunOverlay(props: FirstRunOverlayProps): ReactNode;
export {};
