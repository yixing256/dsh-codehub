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
 * PLACEMENT CONTRACT
 * ------------------
 * `entryPlacement` decides which seats exist at all: 'sidebar' registers
 * `sidebar.panellist` + `main`, 'settings' registers `settings.section` only,
 * 'both' registers all three. Switching placements tears the old registrations
 * down BEFORE the new ones are created — re-registering the same seat id while
 * the old one is live would throw (and a caught throw would silently leave the
 * user on the old placement).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LocaleService } from '@deepseek-ai/dsh-client-locale'
import type { SlotRegistration, SlotsService } from '@deepseek-ai/dsh-client-ui-renderer'

import { LOCALE_NAMESPACE, OVERLAY_SLOT, SETTINGS_NAMESPACE } from '../contract.js'
import {
  attachSettingsScope,
  getConfigState,
  getSettingsScope,
  loadConfig,
  saveConfig,
} from './api.js'
import type { ConfigStoreState, EntryPlacement } from './api.js'
import { FirstRunOverlay, openFirstRunChooser, readLatch, setPlacementHandler, writeLatch } from './first-run.js'
import { LoginOverlay } from './login-dialog.js'
import { dictionaries, setActiveTranslate, translateNow } from './locales.js'
import { CodeHubPanel } from './panel.js'
import type { SeatProps } from './panel.js'
import { CodeHubSettingsCard } from './settings-card.js'
import type { SettingsCardProps } from './settings-card.js'

/**
 * The services this bundle needs. Declared as a NAMED export — the loader reads
 * it before calling `apply`.
 */
export const inject: string[] = ['slots', 'locale', 'settingsScope']

/** The seat id shared by the panellist entry, the `main` key and settings form. */
const PANEL_ID = 'codehub'
const FIRST_RUN_SEAT_ID = 'codehub-first-run'
const LOGIN_SEAT_ID = 'codehub-login'

const PANEL_ORDER = 30
const OVERLAY_ORDER = 10

/** The client context, narrowed to the services named in `inject`. */
interface ClientContext extends Context {
  readonly slots: SlotsService
  readonly locale: LocaleService
}

function log(...args: unknown[]): void {
  try {
    console.warn('[dsh-codehub]', ...args)
  } catch {
    /* a console that rejects writes must not break mounting */
  }
}

// ---------------------------------------------------------------------------
// Mount guard
// ---------------------------------------------------------------------------

const MOUNT_FLAG = Symbol.for('dsh-codehub.client.mounted')

/** Returns true when this context already mounted the browser half. */
function claimMount(ctx: ClientContext): boolean {
  const record = ctx as unknown as Record<PropertyKey, unknown>
  if (record[MOUNT_FLAG] === true) return true
  record[MOUNT_FLAG] = true
  return false
}

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

function registerLocale(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, dictionaries()), 'dsh-codehub:locale')
  try {
    setActiveTranslate(ctx.locale.bind(LOCALE_NAMESPACE))
  } catch (err) {
    log('locale.bind failed; falling back to the zh dictionary', err)
  }
}

// ---------------------------------------------------------------------------
// Seat mounting
// ---------------------------------------------------------------------------

/**
 * One teardown bag per seat group.
 *
 * `generation` is bumped when the bag is torn down, so an `inject` callback
 * that fires LATE (the slot was declared after the user already switched
 * placement) can tell that its registration belongs to a dead generation and
 * decline — a stale seat can never resurrect itself. Placement and overlay
 * seats keep separate bags precisely so a placement switch does not orphan the
 * overlay seats.
 */
interface SeatBag {
  generation: number
  stale: boolean
  disposers: Array<() => void>
}

function createBag(): SeatBag {
  return { generation: 0, stale: false, disposers: [] }
}

let placementBag: SeatBag = createBag()
let overlayBag: SeatBag = createBag()

function mountSeat(
  ctx: ClientContext,
  slot: string,
  registration: SlotRegistration,
  component: unknown,
  bag: SeatBag,
): void {
  const captured = bag.generation
  let disposeSeat: (() => void) | null = null
  let disposeInject: (() => void) | null = null

  const runSeatDisposer = (): void => {
    const dispose = disposeSeat
    disposeSeat = null
    if (!dispose) return
    try {
      dispose()
    } catch (err) {
      log(`disposing the ${slot} seat failed`, err)
    }
  }

  try {
    disposeInject = ctx.slots.inject(slot, () => {
      if (bag.stale || captured !== bag.generation) {
        log(`slot ${slot} declared after teardown; not registering`)
        return undefined
      }
      try {
        disposeSeat = ctx.slots.register(registration, component)
        return runSeatDisposer
      } catch (err) {
        log(`registering on ${slot} failed`, err)
        return undefined
      }
    })
  } catch (err) {
    log(`slots.inject(${slot}) failed`, err)
  }

  bag.disposers.push(() => {
    runSeatDisposer()
    const dispose = disposeInject
    disposeInject = null
    if (!dispose) return
    try {
      dispose()
    } catch (err) {
      log(`releasing the ${slot} injection failed`, err)
    }
  })
}

/** Tear a bag down: registrations first (reverse order), then clear it. */
function teardownBag(bag: SeatBag): void {
  bag.stale = true
  bag.generation += 1
  const disposers = bag.disposers
  bag.disposers = []
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch (err) {
      log('seat teardown step failed', err)
    }
  }
}

function mountPlacement(ctx: ClientContext, placement: EntryPlacement): void {
  // 先拆旧注册，再建新的 — re-registering a live seat id with the same id would
  // throw, and a swallowed throw would silently keep the old placement.
  teardownBag(placementBag)
  const bag = createBag()
  placementBag = bag

  if (placement === 'sidebar' || placement === 'both') {
    mountSeat(
      ctx,
      'sidebar.panellist',
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => translateNow('panel.title'),
      },
      CodeHubPanel satisfies (props: SeatProps) => unknown,
      bag,
    )
    mountSeat(ctx, 'main', { name: 'main', key: PANEL_ID, order: PANEL_ORDER }, CodeHubPanel, bag)
  }

  if (placement === 'settings' || placement === 'both') {
    mountSeat(
      ctx,
      'settings.section',
      {
        name: 'settings.section',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => translateNow('panel.title'),
        locale: LOCALE_NAMESPACE,
        inject: () => ({ scope: getSettingsScope() }),
      },
      CodeHubSettingsCard satisfies (props: SettingsCardProps) => unknown,
      bag,
    )
  }

  log(`entry placement applied: ${placement}`)
}

/**
 * The first-run chooser and the credential dialogs live in `shell.overlay` and
 * are placement-independent: the user must still be able to log in (and change
 * placement) when the panel itself is not shown.
 */
function mountOverlays(ctx: ClientContext): void {
  teardownBag(overlayBag)
  const bag = createBag()
  overlayBag = bag
  mountSeat(
    ctx,
    OVERLAY_SLOT,
    { name: OVERLAY_SLOT, id: FIRST_RUN_SEAT_ID, order: OVERLAY_ORDER },
    FirstRunOverlay,
    bag,
  )
  mountSeat(
    ctx,
    OVERLAY_SLOT,
    { name: OVERLAY_SLOT, id: LOGIN_SEAT_ID, order: OVERLAY_ORDER + 10 },
    LoginOverlay,
    bag,
  )
}

// ---------------------------------------------------------------------------
// settingsScope — optional enhancement only
// ---------------------------------------------------------------------------

function attachSettings(ctx: ClientContext): void {
  let candidate: unknown
  try {
    candidate = typeof ctx.get === 'function' ? ctx.get<unknown>('webUiSettings') : undefined
  } catch (err) {
    log('ctx.get(webUiSettings) failed', err)
  }
  if (candidate === undefined || candidate === null) {
    const record = ctx as unknown as Record<string, unknown>
    candidate = record['settingsScope'] ?? record['webUiSettings']
  }

  const record =
    candidate !== null && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : null
  const bind = record?.['bind']

  let scope: unknown
  if (typeof bind === 'function') {
    try {
      scope = (bind as (spec: unknown) => unknown).call(candidate, { namespace: SETTINGS_NAMESPACE })
    } catch (err) {
      log('settingsScope.bind failed', err)
    }
  } else if (record && typeof record['getSnapshot'] === 'function') {
    // Already a bound scope rather than a binder.
    scope = candidate
  }

  if (scope !== undefined && scope !== null && attachSettingsScope(scope)) {
    log('settingsScope attached (optional mirror enabled)')
  } else {
    log('settingsScope unavailable; the plugin route stays the only config path')
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** The chooser is shown once, and reopened on demand from the panel. */
function needsChooser(state: ConfigStoreState): boolean {
  try {
    if (state.loaded && state.config.onboarded) {
      // The host says this profile is onboarded but the latch is gone (fresh
      // browser profile, cleared storage): re-seed it rather than ask again.
      writeLatch(state.config.entryPlacement)
      return false
    }
    if (readLatch() === null) return true
    // A latch without an onboarded config means the profile was reset (or the
    // earlier write never landed) — ask again instead of guessing.
    return state.loaded && state.config.onboarded === false
  } catch (err) {
    log('reading the first-run latch failed', err)
    return false
  }
}

async function handlePlacementChoice(ctx: ClientContext, placement: EntryPlacement): Promise<void> {
  // Apply locally first: the user gets the placement they asked for even when
  // the config write is refused. Then persist, and surface a refusal loudly.
  mountPlacement(ctx, placement)
  const saved = await saveConfig({ entryPlacement: placement, onboarded: true })
  if (!saved) {
    throw new Error(getConfigState().error ?? 'PATCH /api/dsh-codehub/config failed')
  }
}

async function bootstrap(ctx: ClientContext): Promise<void> {
  try {
    const state = await loadConfig()
    mountPlacement(ctx, state.config.entryPlacement)
    if (needsChooser(state)) openFirstRunChooser(state.config.entryPlacement)
  } catch (err) {
    log('bootstrap failed; falling back to the default placement', err)
    try {
      mountPlacement(ctx, 'both')
    } catch (inner) {
      log('fallback placement failed', inner)
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx: ClientContext): void {
  try {
    if (claimMount(ctx)) {
      log('already mounted on this context; skipping')
      return
    }
  } catch (err) {
    log('mount guard failed (continuing)', err)
  }

  try {
    registerLocale(ctx)
  } catch (err) {
    log('locale registration failed', err)
  }

  try {
    setPlacementHandler(placement => handlePlacementChoice(ctx, placement))
  } catch (err) {
    log('placement handler registration failed', err)
  }

  try {
    attachSettings(ctx)
  } catch (err) {
    log('settingsScope probe failed', err)
  }

  try {
    mountOverlays(ctx)
  } catch (err) {
    log('overlay registration failed', err)
  }

  try {
    ctx.effect(() => () => {
      teardownBag(placementBag)
      teardownBag(overlayBag)
      setPlacementHandler(null)
    }, 'dsh-codehub:client-teardown')
  } catch (err) {
    log('teardown effect registration failed', err)
  }

  void bootstrap(ctx)
}
