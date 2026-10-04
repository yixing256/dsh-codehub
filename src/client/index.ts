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

import type { Context } from '@deepseek-ai/cordis'
import type { LocaleService } from '@deepseek-ai/dsh-client-locale'
import type { SlotRegistration, SlotsService } from '@deepseek-ai/dsh-client-ui-renderer'

import {
  LOCALE_NAMESPACE,
  OVERLAY_SLOT,
  SETTINGS_NAMESPACE,
  UI_ENTRY_ID,
  UI_ENTRY_LABEL,
  UI_ENTRY_ORDER,
  UI_OVERLAY_ORDER,
  UI_SETTINGS_ORDER,
} from '../contract.js'
import {
  attachSettingsScope,
  getConfigState,
  getSettingsScope,
  loadConfig,
  subscribeConfig,
} from './api.js'
import type { EntryPlacement } from './api.js'
import { withSeatBoundary } from './error-boundary.js'
import { CodeHubPanelGlyph } from './icon.js'
import { LoginOverlay } from './login-dialog.js'
import { dictionaries, setActiveTranslate, translateNow } from './locales.js'
import { CodeHubPanel } from './panel.js'
import { CodeHubSettingsCard } from './settings-card.js'
import type { SettingsCardProps } from './settings-card.js'

/**
 * Every seat is wrapped in a render guard.
 *
 * A throw inside a seat otherwise leaves an EMPTY region with nothing to report —
 * which is precisely how a renamed SDK icon turned into "点开什么都没有" on both
 * surfaces at once. With the guard, the failure is a readable message naming the
 * error and the check that localises it. See `error-boundary.tsx`.
 */
const GuardedPanelGlyph = withSeatBoundary(CodeHubPanelGlyph)
const GuardedPanel = withSeatBoundary(CodeHubPanel)
const GuardedSettingsCard = withSeatBoundary(CodeHubSettingsCard)
const GuardedLoginOverlay = withSeatBoundary(LoginOverlay)

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
export const inject: string[] = ['slots', 'locale']

const LOGIN_SEAT_ID = 'codehub-login'

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
    // The row's GLYPH, never the panel: see the SIDEBAR ROW CONTRACT above.
    mountSeat(
      ctx,
      'sidebar.panellist',
      {
        name: 'sidebar.panellist',
        id: UI_ENTRY_ID,
        order: UI_ENTRY_ORDER,
        // The literal the user asked for; not a dictionary lookup, so the row
        // text cannot be changed by a locale edit.
        label: () => UI_ENTRY_LABEL,
      },
      GuardedPanelGlyph,
      bag,
    )
    mountSeat(
      ctx,
      'main',
      { name: 'main', key: UI_ENTRY_ID, order: UI_ENTRY_ORDER, label: () => UI_ENTRY_LABEL },
      GuardedPanel,
      bag,
    )
  }

  if (placement === 'settings' || placement === 'both') {
    mountSeat(
      ctx,
      'settings.section',
      {
        name: 'settings.section',
        id: UI_ENTRY_ID,
        order: UI_SETTINGS_ORDER,
        label: () => translateNow('panel.title'),
        locale: LOCALE_NAMESPACE,
        inject: () => ({ scope: getSettingsScope() }),
      },
      GuardedSettingsCard satisfies (props: SettingsCardProps) => unknown,
      bag,
    )
  }

  log(`entry placement applied: ${placement}`)
}

/**
 * The login dialog lives in `shell.overlay` and is placement-independent: the
 * user must still be able to sign in (and change placement) when neither the
 * sidebar row nor the settings section is shown.
 */
function mountOverlays(ctx: ClientContext): void {
  teardownBag(overlayBag)
  const bag = createBag()
  overlayBag = bag
  mountSeat(
    ctx,
    OVERLAY_SLOT,
    { name: OVERLAY_SLOT, id: LOGIN_SEAT_ID, order: UI_OVERLAY_ORDER },
    GuardedLoginOverlay,
    bag,
  )
}

// ---------------------------------------------------------------------------
// Placement follows the SAVED config, never the draft
// ---------------------------------------------------------------------------

/** Last placement whose seats are actually registered. */
let appliedPlacement: EntryPlacement | null = null

/**
 * Register the seats for `placement`, once.
 *
 * Idempotent on purpose: the config store emits on every draft keystroke, and
 * re-running `mountPlacement` for an unchanged placement would tear down and
 * rebuild the user's panel for no reason.
 */
function applyPlacement(ctx: ClientContext, placement: EntryPlacement): void {
  if (appliedPlacement === placement) return
  appliedPlacement = placement
  mountPlacement(ctx, placement)
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

async function bootstrap(ctx: ClientContext): Promise<void> {
  try {
    const state = await loadConfig()
    applyPlacement(ctx, state.config.entryPlacement)
  } catch (err) {
    log('bootstrap failed; falling back to the default placement', err)
    try {
      // Both surfaces: the default the user asked for, and the default the
      // schema declares, so a broken config route cannot hide the plugin.
      applyPlacement(ctx, 'both')
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
    // The placement setting takes effect on SAVE: the store emits whenever the
    // host has accepted a config, and the seats follow `config` (not `draft`).
    ctx.effect(
      () =>
        subscribeConfig(() => {
          try {
            applyPlacement(ctx, getConfigState().config.entryPlacement)
          } catch (err) {
            log('applying the saved entry placement failed', err)
          }
        }),
      'dsh-codehub:placement-follows-config',
    )
  } catch (err) {
    log('placement subscription failed', err)
  }

  try {
    ctx.effect(() => () => {
      teardownBag(placementBag)
      teardownBag(overlayBag)
      // A later re-mount must be able to register the seats again.
      appliedPlacement = null
    }, 'dsh-codehub:client-teardown')
  } catch (err) {
    log('teardown effect registration failed', err)
  }

  void bootstrap(ctx)
}
