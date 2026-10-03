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

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModalProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'

import { describeError } from './api.js'
import type { EntryPlacement } from './api.js'
import { useTranslate } from './locales.js'
import type { LocaleKey, Translate } from './locales.js'
import styles from './panel.module.css'

/**
 * The shim types the primitives as returning `ReactNode`; React's component
 * contract wants an element. The cast is purely a typing bridge — the runtime
 * components are used as-is.
 */
const UIModal = Modal as unknown as ComponentType<ModalProps>

/** The one-shot latch key. */
export const FIRST_RUN_KEY = 'dsh-codehub:first-run:v1'

const PLACEMENTS: readonly EntryPlacement[] = ['sidebar', 'settings', 'both']

const PLACEMENT_LABEL: Record<EntryPlacement, LocaleKey> = {
  sidebar: 'entry.sidebar',
  settings: 'entry.settings',
  both: 'entry.both',
}

const PLACEMENT_DESC: Record<EntryPlacement, LocaleKey> = {
  sidebar: 'entry.sidebarDesc',
  settings: 'entry.settingsDesc',
  both: 'entry.bothDesc',
}

// ---------------------------------------------------------------------------
// Latch
// ---------------------------------------------------------------------------

interface LatchStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storageCandidates(): LatchStore[] {
  const stores: LatchStore[] = []
  try {
    if (typeof window !== 'undefined' && window.localStorage) stores.push(window.localStorage)
  } catch {
    /* storage disabled */
  }
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) stores.push(window.sessionStorage)
  } catch {
    /* storage disabled */
  }
  return stores
}

/** Read the latch. Returns null when nothing is stored or storage is unusable. */
export function readLatch(): string | null {
  for (const store of storageCandidates()) {
    try {
      const value = store.getItem(FIRST_RUN_KEY)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      /* try the next store */
    }
  }
  return null
}

/** Write the latch. Silently does nothing when every storage is unusable. */
export function writeLatch(placement: EntryPlacement): void {
  for (const store of storageCandidates()) {
    try {
      store.setItem(FIRST_RUN_KEY, placement)
      return
    } catch {
      /* try the next store */
    }
  }
}

// ---------------------------------------------------------------------------
// Open/close store (the panel and the settings page both re-open the chooser)
// ---------------------------------------------------------------------------

export interface FirstRunState {
  open: boolean
  /** The placement currently in effect, used to pre-select a radio. */
  current: EntryPlacement
  saving: boolean
  error: string | null
}

let storeState: FirstRunState = { open: false, current: 'both', saving: false, error: null }
const listeners = new Set<() => void>()

function emit(next: Partial<FirstRunState>): void {
  storeState = { ...storeState, ...next }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* a broken subscriber must not break the chooser */
    }
  }
}

export function subscribeFirstRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getFirstRunState(): FirstRunState {
  return storeState
}

export function useFirstRunState(): FirstRunState {
  return useSyncExternalStore(subscribeFirstRun, getFirstRunState, getFirstRunState)
}

/** Open the chooser. Also the escape hatch behind "重新打开入口位置选择". */
export function openFirstRunChooser(current: EntryPlacement): void {
  emit({ open: true, current, error: null })
}

export function closeFirstRunChooser(): void {
  emit({ open: false, error: null })
}

// ---------------------------------------------------------------------------
// Placement handler — index.ts owns register/teardown, the dialog owns the UI.
// ---------------------------------------------------------------------------

type PlacementHandler = (placement: EntryPlacement) => void | Promise<void>

let placementHandler: PlacementHandler | null = null

export function setPlacementHandler(handler: PlacementHandler | null): void {
  placementHandler = handler
}

export interface FirstRunOverlayProps {
  t?: Translate
  /** Injected by the registration face; falls back to the module handler. */
  onChoose?: PlacementHandler
}

export function FirstRunOverlay(props: FirstRunOverlayProps): ReactNode {
  const t = useTranslate(props)
  const state = useFirstRunState()
  const [selection, setSelection] = useState<EntryPlacement | null>(null)

  // Each time the chooser opens, forget the previous radio so the current
  // placement shows through.
  useEffect(() => {
    if (state.open) setSelection(null)
  }, [state.open])

  const active = selection ?? state.current

  const submit = async (): Promise<void> => {
    const choice = active
    // Latch first: the user's choice must survive even if the host write fails.
    writeLatch(choice)
    const handler = props.onChoose ?? placementHandler
    if (!handler) {
      emit({ saving: false, error: 'entry handler is not mounted' })
      return
    }
    emit({ saving: true, error: null })
    try {
      await handler(choice)
      emit({ open: false, saving: false, current: choice, error: null })
    } catch (err) {
      emit({ saving: false, error: describeError(err) })
    }
  }

  if (!state.open) return null

  return (
    <UIModal open onClose={closeFirstRunChooser} title={t('entry.firstRunTitle')}>
      <div className={styles.modalBody}>
        <p className={styles.help}>{t('entry.firstRunIntro')}</p>
        {PLACEMENTS.map(placement => (
          <label
            key={placement}
            className={`${styles.modalOption} ${active === placement ? styles.modalOptionSelected : ''}`}
          >
            <input
              type="radio"
              name="dsh-codehub-entry-placement"
              checked={active === placement}
              onChange={() => setSelection(placement)}
            />
            <span className={styles.modalOptionBody}>
              <span className={styles.modalOptionTitle}>{t(PLACEMENT_LABEL[placement])}</span>
              <span className={styles.modalOptionDesc}>{t(PLACEMENT_DESC[placement])}</span>
            </span>
          </label>
        ))}
        <p className={styles.help}>{t('entry.latchNote')}</p>
        <p className={styles.help}>{t('entry.switchNote')}</p>
        {state.error ? <p className={styles.err}>{state.error}</p> : null}
        <div className={styles.modalFooter}>
          <button type="button" className={styles.button} onClick={closeFirstRunChooser} disabled={state.saving}>
            {t('entry.later')}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            onClick={() => {
              void submit()
            }}
            disabled={state.saving}
          >
            {state.saving ? t('entry.applying') : t('entry.apply')}
          </button>
        </div>
      </div>
    </UIModal>
  )
}
