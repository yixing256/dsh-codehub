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

import {
  ACCESS_OPTIONS,
  ACCESS_RISK,
  CSDN_API_NOTE,
  CSDN_SEARCH_BASE,
  DECISION_KEYS,
  DEEP_READ_TARGETS,
  HARD_LIMITS,
  LEARNING_ONLY_BANNER,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_LABEL,
  LOCAL_PROXY_SCOPE_NOTE,
  LOGIN_REQUIREMENTS,
  LOGIN_URLS,
  CSDN_ROBOTS_DISCLOSURE,
  SOURCES,
  SOURCE_LABELS,
  SOURCE_LOGIN_METHODS,
  TOKEN_FORBIDDEN_ACCESS,
  TOOL_NAME,
  UI_ENTRY_LABEL,
} from '../contract.js'
import type {
  AccessRisk,
  ConnectivityStatus,
  DecisionKey,
  DeepReadTarget,
  GithubAccessId,
  LoginMethodId,
  SourceId,
} from '../contract.js'
/*
 * ONLY the two primitives that still exist on the live runtime are imported here.
 *
 * The icons deliberately are NOT: `Icon*Outline16` / `Icon*Outline14` were renamed
 * to `Icon*OutlineMedium` / `Icon*OutlineRegular` on DSH 0.2.0-rc.2, so importing
 * them yielded `undefined` and rendering them threw — blanking this whole panel
 * AND the settings section, while the sidebar glyph (which used no SDK icon)
 * kept working. See `./icon.tsx` for the inline glyphs and
 * `scripts/check-sdk-surface.mjs` for the gate that now catches a rename.
 */
import { Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputProps, ModalProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import type { ComponentType, ReactElement, ReactNode } from 'react'

import {
  applyCredentials,
  applyPatchLocally,
  autoSaveNow,
  clearCredential,
  DEEP_READ_LABEL,
  describeConfigSummary,
  describeError,
  fetchDetect,
  isDirty,
  launchDebugBrowser,
  loadConfig,
  normalizeProbe,
  normalizeSmoke,
  PLACEMENT_LABEL,
  pullSettingsScopePatch,
  refreshDecisions,
  resetDraft,
  runProbe,
  runSmoke,
  saveDraft,
  updateDraft,
  useConfigState,
  useSettingsScopeStatus,
} from './api.js'
import type {
  CodeHubConfigView,
  CodeHubLimits,
  ConnectivityRowView,
  CredentialSource,
  EntryPlacement,
} from './api.js'
import { openCredentialGuide } from './credential-guide.js'
import { GitHubCatGlyph, IconChevronDown, IconClose, IconPlus, IconRefresh } from './icon.js'
import { openLoginDialog } from './login-dialog.js'
import { useTranslate } from './locales.js'
import type { LocaleKey, Translate } from './locales.js'
import styles from './panel.module.css'

/**
 * Typing bridge for the two remaining primitives: the SDK shim declares them as
 * returning `ReactNode`, React's JSX contract wants an element type. The runtime
 * components are used unchanged.
 *
 * `Input` is resolved defensively: if a future runtime renames it, the field
 * degrades to a plain native `<input>` instead of an undefined component, which
 * would otherwise blank every control on both surfaces.
 */
export const UIInput = (typeof Input === 'function' ? Input : NativeInput) as unknown as ComponentType<InputProps>
export const UIModal = Modal as unknown as ComponentType<ModalProps>

/** Minimal native stand-in for the SDK `Input`, used only if the SDK loses it. */
function NativeInput(props: InputProps): ReactElement {
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      onChange={props.onChange}
    />
  )
}

/** The glyphs are re-exported so the settings card and dialogs share one source. */
export { IconChevronDown, IconClose, IconPlus, IconRefresh }

/** Props every seat of this plugin accepts. */
export interface SeatProps {
  t?: Translate
  slot?: string
}

/**
 * 备注① — the local-proxy control's label, scope note included.
 *
 * Built from the contract constants instead of a translated dictionary entry so
 * the required phrase 「仅 Node 直连传输生效」 (`LOCAL_PROXY_SCOPE_NOTE`) cannot be
 * dropped by a dictionary edit, and so the label and its `aria-label` are the
 * same string.
 */
const LOCAL_PROXY_FIELD_LABEL = `${LOCAL_PROXY_LABEL}（${LOCAL_PROXY_SCOPE_NOTE}）`

/**
 * Placement / deep-read label keys come from `./api.js` so the form and the
 * post-save summary render the same vocabulary (see api.ts for why).
 */
const RISK_LABEL: Record<AccessRisk, LocaleKey> = {
  stable: 'risk.stable',
  temporary: 'risk.temporary',
  'privacy-risk': 'risk.privacy-risk',
  'not-recommended': 'risk.not-recommended',
}

const PLACEMENT_DESC: Record<EntryPlacement, LocaleKey> = {
  sidebar: 'entry.sidebarDesc',
  settings: 'entry.settingsDesc',
  both: 'entry.bothDesc',
}

/**
 * The three placements as the control lists them.
 *
 * `both` first because it IS the default (`SCHEMA_DEFAULTS.entryPlacement`), so
 * the pre-selected choice is also the first one read.
 */
const PLACEMENTS: readonly EntryPlacement[] = ['both', 'sidebar', 'settings']

const CREDENTIAL_ROWS: ReadonlyArray<{ source: CredentialSource; label: LocaleKey; hint: LocaleKey }> = [
  { source: 'github', label: 'account.github', hint: 'account.githubHint' },
  { source: 'gitee', label: 'account.gitee', hint: 'account.giteeHint' },
  { source: 'csdn', label: 'account.csdn', hint: 'account.csdnHint' },
]

const LIMIT_FIELDS: ReadonlyArray<{ key: keyof CodeHubLimits; label: LocaleKey; min: number; max: number }> = [
  { key: 'timeoutMs', label: 'limits.timeoutMs', min: 1000, max: HARD_LIMITS.timeoutMs },
  { key: 'retries', label: 'limits.retries', min: 0, max: HARD_LIMITS.retries },
  { key: 'maxDepth', label: 'limits.maxDepth', min: 1, max: HARD_LIMITS.maxDepth },
  { key: 'maxItems', label: 'limits.maxItems', min: 1, max: HARD_LIMITS.maxItems },
  { key: 'maxCodeChars', label: 'limits.maxCodeChars', min: 200, max: HARD_LIMITS.maxCodeChars },
]

/** Sets one numeric limit without relying on union-keyed object spreads. */
function withLimit(limits: CodeHubLimits, key: keyof CodeHubLimits, value: number): CodeHubLimits {
  return {
    timeoutMs: key === 'timeoutMs' ? value : limits.timeoutMs,
    retries: key === 'retries' ? value : limits.retries,
    maxDepth: key === 'maxDepth' ? value : limits.maxDepth,
    maxItems: key === 'maxItems' ? value : limits.maxItems,
    maxCodeChars: key === 'maxCodeChars' ? value : limits.maxCodeChars,
  }
}

function riskBadgeClass(risk: AccessRisk): string {
  switch (risk) {
    case 'stable':
      return styles.badgeStable
    case 'temporary':
      return styles.badgeTemporary
    case 'privacy-risk':
      return styles.badgePrivacy
    default:
      return styles.badgeNotRecommended
  }
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function SectionCard(props: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{props.title}</span>
        {props.action ?? null}
      </div>
      {props.hint ? <p className={styles.help}>{props.hint}</p> : null}
      {props.children}
    </section>
  )
}

/**
 * 备注③ — the banner every rendered result carries.
 *
 * Rendered verbatim from `LEARNING_ONLY_BANNER` (「仅学习参考 · 不得直接粘贴进用户项目」),
 * so a result surface cannot be added without the banner. The text is never
 * re-spelled here: the constant is the only source.
 */
export function LearningBanner({ t }: { t: Translate }): ReactElement {
  return (
    <div className={styles.banner}>
      <span className={styles.bannerTitle}>{t('banner.resultsTitle')}</span>
      <span className={styles.bannerText}>{LEARNING_ONLY_BANNER}</span>
    </div>
  )
}

/**
 * Three-state switch: undecided / on / off. `null` is "not asked yet" and must
 * never be rendered as "off".
 */
function TriStateField(props: {
  t: Translate
  value: boolean | null
  onChange: (value: boolean | null) => void
  groupLabel: string
}): ReactElement {
  const id = useId()
  const groupName = `dsh-codehub-${id}`
  const options: ReadonlyArray<{ value: boolean | null; label: LocaleKey }> = [
    { value: null, label: 'tristate.undecided' },
    { value: true, label: 'tristate.on' },
    { value: false, label: 'tristate.off' },
  ]
  return (
    <div className={styles.tristateRow} role="radiogroup" aria-label={props.groupLabel}>
      {options.map(option => {
        const inputId = `${groupName}-${String(option.value)}`
        return (
          <label key={inputId} className={styles.radioLabel} htmlFor={inputId}>
            <input
              id={inputId}
              type="radio"
              name={groupName}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span>{props.t(option.label)}</span>
          </label>
        )
      })}
      {props.value === null ? <span className={styles.warn}>{props.t('tristate.undecidedNote')}</span> : null}
    </div>
  )
}

/** Numeric field clamped to [min, max]; commits only in range, clamps on blur. */
function NumberField(props: {
  label: string
  value: number
  min: number
  max: number
  capLabel: string
  onChange: (value: number) => void
}): ReactElement {
  const { label, value, min, max, capLabel, onChange } = props
  const [text, setText] = useState(String(value))

  useEffect(() => {
    const parsed = Number(text)
    if (!Number.isFinite(parsed) || Math.trunc(parsed) !== value) setText(String(value))
    // `text` is intentionally not a dependency: this only re-syncs on a value
    // change coming from outside (host reload, revert, clamp).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const clamp = (numeric: number): number => Math.min(max, Math.max(min, Math.trunc(numeric)))

  const handleChange = (raw: string): void => {
    setText(raw)
    if (raw.trim().length === 0) return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    const truncated = Math.trunc(parsed)
    if (truncated < min || truncated > max) return
    onChange(truncated)
  }

  const handleBlur = (): void => {
    const parsed = Number(text)
    if (text.trim().length === 0 || !Number.isFinite(parsed)) {
      setText(String(value))
      return
    }
    const next = clamp(parsed)
    onChange(next)
    setText(String(next))
  }

  return (
    // `onBlur` lives on the wrapper: React synthesises it from the bubbling
    // focusout event, and the SDK shim's InputProps has no onBlur of its own.
    <label className={styles.numField} onBlur={handleBlur}>
      <span className={styles.fieldLabel}>{label}</span>
      <UIInput
        type="number"
        value={text}
        aria-label={label}
        onChange={event => handleChange(event.target.value)}
      />
      <span className={styles.help}>
        {capLabel}: {min}–{max}
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// 1. Source priority (drag + mandatory keyboard fallback)
// ---------------------------------------------------------------------------

function SourcePriorityField(props: {
  t: Translate
  value: readonly SourceId[]
  onChange: (value: readonly SourceId[]) => void
}): ReactElement {
  const { t, value, onChange } = props
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= value.length || from === to || from < 0) return
    const next = [...value]
    const [item] = next.splice(from, 1)
    if (item === undefined) return
    next.splice(to, 0, item)
    onChange(next)
  }

  const missing = SOURCES.filter(source => !value.includes(source))

  return (
    <SectionCard title={t('source.title')} hint={t('source.hint')}>
      <ul className={styles.list}>
        {value.map((source, index) => (
          <li
            key={source}
            className={`${styles.listItem} ${dragIndex === index ? styles.listItemActive : ''}`}
            draggable
            onDragStart={event => {
              setDragIndex(index)
              try {
                event.dataTransfer.setData('text/plain', String(index))
                event.dataTransfer.effectAllowed = 'move'
              } catch {
                /* some environments refuse dataTransfer; the buttons still work */
              }
            }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              if (dragIndex !== null) move(dragIndex, index)
              setDragIndex(null)
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <span className={styles.grip} aria-hidden="true" title={t('source.dragHandle')}>
              ⠿
            </span>
            <span className={`${styles.optionLabel} ${styles.listLabel}`}>{SOURCE_LABELS[source]}</span>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`${SOURCE_LABELS[source]} ${t('source.moveUp')}`}
              title={t('source.moveUp')}
              disabled={index === 0}
              onClick={() => move(index, index - 1)}
            >
              <IconChevronDown className={styles.chevronUp} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`${SOURCE_LABELS[source]} ${t('source.moveDown')}`}
              title={t('source.moveDown')}
              disabled={index === value.length - 1}
              onClick={() => move(index, index + 1)}
            >
              <IconChevronDown />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`${SOURCE_LABELS[source]} ${t('source.remove')}`}
              title={t('source.remove')}
              onClick={() => onChange(value.filter(item => item !== source))}
            >
              <IconClose />
            </button>
          </li>
        ))}
      </ul>
      {value.length === 0 ? <p className={styles.warn}>{t('source.empty')}</p> : null}
      <div className={styles.row}>
        {missing.map(source => (
          <button key={source} type="button" className={styles.buttonGhost} onClick={() => onChange([...value, source])}>
            <IconPlus />
            {SOURCE_LABELS[source]}
          </button>
        ))}
        {value.length === 0 ? (
          <button type="button" className={styles.buttonGhost} onClick={() => onChange([...SOURCES])}>
            {t('source.preset')}
          </button>
        ) : (
          <button type="button" className={styles.buttonGhost} onClick={() => onChange([])}>
            {t('source.reset')}
          </button>
        )}
      </div>
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// 2. GitHub access, grouped by the four risk bands
// ---------------------------------------------------------------------------

/** Anchor id for the GitHub access card, so the folded decision list can scroll to it. */
const GITHUB_ACCESS_ANCHOR_ID = 'dsh-codehub-github-access'

function GithubAccessField(props: {
  t: Translate
  value: readonly GithubAccessId[]
  onChange: (value: readonly GithubAccessId[]) => void
  /** Set briefly by "现在就定" so the user can see WHICH control it meant. */
  highlighted?: boolean
}): ReactElement {
  const { t, value, onChange } = props
  const toggle = (id: GithubAccessId): void => {
    onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id])
  }
  const carriesToken = value.some(id => ACCESS_OPTIONS.find(option => option.id === id)?.carriesToken === true)
  const hasForbidden = value.some(id => TOKEN_FORBIDDEN_ACCESS.includes(id))

  return (
    // The wrapper (not the card) carries the anchor and the highlight outline.
    // The id is not guaranteed unique when BOTH surfaces are mounted at once (the
    // sidebar panel and the settings section share this component); that is
    // acceptable here because it is only a scroll target, and `getElementById`
    // then resolves to the first — i.e. the one nearest the top of the page.
    <div id={GITHUB_ACCESS_ANCHOR_ID} className={props.highlighted === true ? styles.fieldHighlight : undefined}>
      <SectionCard title={t('github.title')} hint={t('github.hint')}>
        {ACCESS_RISK.map(risk => (
          <div key={risk} className={styles.riskGroup}>
            <div className={styles.riskHeader}>
              <span className={`${styles.badge} ${riskBadgeClass(risk)}`}>{t(RISK_LABEL[risk])}</span>
            </div>
            {ACCESS_OPTIONS.filter(option => option.risk === risk).map(option => (
              <label key={option.id} className={styles.checkRow}>
                <input type="checkbox" checked={value.includes(option.id)} onChange={() => toggle(option.id)} />
                <span className={styles.optionBody}>
                  <span className={styles.optionLabel}>
                    {option.label}
                    <span
                      className={`${styles.badgeMini} ${option.carriesToken ? styles.badgeToken : styles.badgeNoToken}`}
                    >
                      {option.carriesToken ? t('github.tokenCarried') : t('github.tokenStripped')}
                    </span>
                  </span>
                  <span className={styles.optionRequirement}>{option.requirement}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
        {value.length === 0 ? <p className={styles.warn}>{t('tristate.undecidedNote')}</p> : null}
        {carriesToken && hasForbidden ? <p className={styles.warn}>{t('github.tokenMirrorConflict')}</p> : null}
        <p className={styles.help}>{t('github.wattNote')}</p>
      </SectionCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5./6. Accounts (credential status is boolean-only) + 备注② CSDN note
// ---------------------------------------------------------------------------

function AccountsField({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const [busy, setBusy] = useState<CredentialSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const credentials = state.config.credentials

  const signOut = async (source: CredentialSource): Promise<void> => {
    if (busy) return
    setBusy(source)
    setError(null)
    try {
      applyCredentials(await clearCredential(source))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SectionCard title={t('account.status')} hint={t('account.neverShown')}>
      {CREDENTIAL_ROWS.map(row => {
        const configured = credentials[row.source]
        const methods = SOURCE_LOGIN_METHODS[row.source]
        // A browser flow only exists for the sources the contract says have one
        // (GitHub device flow, Gitee authorization code). CSDN has no OAuth, so
        // the button is absent rather than present-and-failing.
        const browserMethod = methods.find(method => method === 'oauth-device' || method === 'oauth-code')
        const guideMethod: LoginMethodId | undefined = browserMethod ?? methods[0]
        return (
          <div key={row.source} className={styles.fieldGroup}>
            <div className={styles.rowBetween}>
              <span className={styles.fieldLabel}>
                {t(row.label)} ·{' '}
                <span className={configured ? styles.statusOk : styles.muted}>
                  {configured ? t('account.configured') : t('account.notConfigured')}
                </span>
              </span>
              <span className={styles.buttonRow}>
                {browserMethod !== undefined ? (
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => openLoginDialog(row.source, browserMethod)}
                  >
                    {t('account.browserLogin')}
                  </button>
                ) : null}
                <button type="button" className={styles.button} onClick={() => openLoginDialog(row.source)}>
                  {t('account.import')}
                </button>
                {guideMethod !== undefined ? (
                  <button
                    type="button"
                    className={styles.buttonGhost}
                    onClick={() => openCredentialGuide(row.source, guideMethod)}
                  >
                    {t('account.guide')}
                  </button>
                ) : null}
                {configured ? (
                  <button
                    type="button"
                    className={styles.buttonDanger}
                    disabled={busy === row.source}
                    onClick={() => {
                      void signOut(row.source)
                    }}
                  >
                    {busy === row.source ? t('account.loggingOut') : t('account.logout')}
                  </button>
                ) : null}
              </span>
            </div>
            <p className={styles.help}>{t(row.hint)}</p>
            {/* The per-source login requirement, from the contract constant the
                tests and the host read too — so the panel cannot drift from the
                measured facts of 2026-10-04. */}
            <p className={styles.help}>
              {t('account.loginRequirement')}：{LOGIN_REQUIREMENTS[row.source]}
            </p>
            {row.source === 'csdn' ? (
              <>
                {/* 备注② — CSDN_API_NOTE rendered verbatim: 非官方内部接口、
                    probe date CSDN_API_PROBED_AT、字段与可用性可能随时失效。 */}
                <p className={styles.noteBox}>{CSDN_API_NOTE}</p>
                {/* robots 立场必须和端点写在一起披露（DESIGN §7.1 / §9）：这是
                    「请求一次、不爬取」的承诺，不能只在文档里说。 */}
                <p className={styles.noteBox}>{CSDN_ROBOTS_DISCLOSURE}</p>
                <p className={styles.help}>
                  {t('csdn.endpoint')}: <span className={styles.mono}>{CSDN_SEARCH_BASE}</span>
                </p>
              </>
            ) : null}
          </div>
        )
      })}
      {error ? <p className={styles.err}>{error}</p> : null}
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// CSDN 抓取选项 — the two switches and the debug port
// ---------------------------------------------------------------------------

/**
 * `csdn.articleFetch`, `csdn.cdpEnabled` and `csdn.cdpPort`.
 *
 * The panel is the PRIMARY config surface for this plugin (docs/DESIGN.md §5), so
 * a key that only exists in the schema is effectively unreachable: this card is
 * what makes the experimental capture actually turn-on-able. The CDP toggle ships
 * the cost next to the box (a debug port any local process can talk to) and stays
 * OFF until the user ticks it; the wizard then asks for consent a second time
 * before reading anything.
 */
function CsdnOptionsField({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const config: CodeHubConfigView = state.draft ?? state.config
  const [launching, setLaunching] = useState(false)
  const [launchNote, setLaunchNote] = useState<string | null>(null)

  // Same draft path as every other control: nothing registers seats or writes the
  // host until the user saves.
  const setArticleFetch = (next: boolean): void => {
    updateDraft(draft => ({ ...draft, csdnArticleFetch: next }))
  }
  const setCdpEnabled = (next: boolean): void => {
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: next }))
  }
  const setCdpPort = (next: number): void => {
    updateDraft(draft => ({ ...draft, csdnCdpPort: next }))
  }

  /**
   * 「启动调试浏览器」 — the one click the whole CDP path needed.
   *
   * The launcher probes first (nothing is started when a debugger is already
   * listening), then starts a Chromium on its OWN profile with the debug flags and
   * waits until the port answers. It opens the CSDN login page, because a dedicated
   * profile starts logged out — that is the price of a debug port that always works.
   */
  const launchBrowser = async (): Promise<void> => {
    if (launching) return
    setLaunching(true)
    setLaunchNote(null)
    try {
      const result = await launchDebugBrowser({
        port: config.csdnCdpPort,
        consent: true,
        url: LOGIN_URLS.csdnLogin,
      })
      setLaunchNote(
        result.reason.length > 0
          ? result.reason
          : result.launched
            ? t('csdn.cdp.launched')
            : t('csdn.cdp.alreadyRunning'),
      )
    } catch (err) {
      setLaunchNote(describeError(err))
    } finally {
      setLaunching(false)
    }
  }

  return (
    <SectionCard title={t('csdn.options.title')} hint={t('csdn.options.hint')}>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={config.csdnArticleFetch}
          onChange={event => setArticleFetch(event.target.checked)}
        />
        <span className={styles.optionBody}>
          <span className={styles.optionLabel}>{t('csdn.articleFetch')}</span>
          <span className={styles.optionRequirement}>{t('csdn.articleFetch.hint')}</span>
        </span>
      </label>

      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={config.csdnCdpEnabled}
          onChange={event => setCdpEnabled(event.target.checked)}
        />
        <span className={styles.optionBody}>
          <span className={styles.optionLabel}>{t('csdn.cdp.label')}</span>
          <span className={styles.optionRequirement}>{t('csdn.cdp.hint')}</span>
        </span>
      </label>

      {config.csdnCdpEnabled ? (
        <>
          <p className={styles.warn}>{t('csdn.cdp.warn')}</p>
          {/* The one click that makes the whole path work: probe the port, and if
              nothing is listening, start a Chromium with the debug flags on its own
              profile and wait for the debugger URL. */}
          <span className={styles.buttonRow}>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={launching}
              onClick={() => {
                void launchBrowser()
              }}
            >
              {launching ? t('csdn.cdp.launching') : t('csdn.cdp.launch')}
            </button>
            <span className={styles.help}>{t('csdn.cdp.launchHint')}</span>
          </span>
          {launchNote !== null ? <p className={styles.help}>{launchNote}</p> : null}
          <p className={styles.help}>{t('csdn.cdp.howTo')}</p>
          <NumberField
            label={t('csdn.cdp.port')}
            capLabel={t('limits.hardCap')}
            value={config.csdnCdpPort}
            min={1}
            max={65_535}
            onChange={setCdpPort}
          />
        </>
      ) : (
        <p className={styles.help}>{t('csdn.cdp.off')}</p>
      )}
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// 7. Mirror CRUD — never pre-filled, placeholders only
// ---------------------------------------------------------------------------

function MirrorField(props: {
  t: Translate
  title: string
  hint: string
  placeholder: string
  values: readonly string[]
  onChange: (values: readonly string[]) => void
}): ReactElement {
  const { t, title, hint, placeholder, values, onChange } = props
  const replace = (index: number, next: string): void => {
    onChange(values.map((item, itemIndex) => (itemIndex === index ? next : item)))
  }
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.rowBetween}>
        <span className={styles.fieldLabel}>{title}</span>
        <button type="button" className={styles.buttonGhost} onClick={() => onChange([...values, ''])}>
          <IconPlus />
          {t('mirror.add')}
        </button>
      </div>
      {values.length === 0 ? <p className={styles.emptyText}>{t('mirror.empty')}</p> : null}
      <div className={styles.mirrorList}>
        {values.map((value, index) => (
          <div key={`mirror-${index}`} className={styles.mirrorRow}>
            <UIInput
              value={value}
              placeholder={placeholder}
              aria-label={`${title} ${index + 1}`}
              onChange={event => replace(index, event.target.value)}
            />
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t('mirror.remove')}
              title={t('mirror.remove')}
              onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            >
              <IconClose />
            </button>
          </div>
        ))}
      </div>
      <p className={styles.help}>{hint}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Environment probe (its own card) + the connectivity GUI
// ---------------------------------------------------------------------------

/**
 * The environment probe keeps its own card and its flat key/value list: it
 * answers "what does this machine look like", which is diagnostics, not
 * connectivity. Splitting the two is what lets the connectivity card obey its
 * own display contract (three rows, reason under the failed row).
 */
function DetectField({ t }: { t: Translate }): ReactElement {
  const [detect, setDetect] = useState<Record<string, string | number | boolean | null> | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)

  const runDetect = async (): Promise<void> => {
    setDetecting(true)
    setDetectError(null)
    try {
      setDetect(await fetchDetect())
    } catch (err) {
      setDetectError(describeError(err))
    } finally {
      setDetecting(false)
    }
  }

  const entries = detect ? Object.entries(detect) : []

  return (
    <SectionCard
      title={t('tools.title')}
      action={
        <button
          type="button"
          className={styles.button}
          disabled={detecting}
          onClick={() => {
            void runDetect()
          }}
        >
          {detecting ? t('tools.detecting') : t('tools.detectRun')}
        </button>
      }
    >
      {detectError ? <p className={styles.err}>{detectError}</p> : null}
      {entries.length === 0 && !detectError ? <p className={styles.help}>{t('tools.detectEmpty')}</p> : null}
      {entries.length > 0 ? (
        <div className={styles.kvList}>
          {entries.map(([key, value]) => (
            <div key={key} className={styles.kvRow}>
              <span className={styles.kvKey}>{key}</span>
              <span className={styles.kvValue}>{value === null ? t('common.dash') : String(value)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </SectionCard>
  )
}

/** Status label per contract status — colour is never the only channel. */
const CONNECT_STATUS_LABEL: Record<ConnectivityStatus, LocaleKey> = {
  undetected: 'connect.status.undetected',
  running: 'connect.status.running',
  ok: 'connect.status.ok',
  failed: 'connect.status.failed',
}

function connectivityBadgeClass(status: ConnectivityStatus): string {
  switch (status) {
    case 'ok':
      return styles.connectBadgeOk
    case 'failed':
      return styles.connectBadgeFailed
    case 'running':
      return styles.connectBadgeRunning
    default:
      return styles.connectBadgeIdle
  }
}

/**
 * Clipboard write with an honest failure path.
 *
 * WHY NOT A HIDDEN TEXTAREA + `execCommand`: it cannot be verified from here and
 * it silently "succeeds" without writing. A blocked clipboard is reported, and
 * the user can still select the text — the copy button is a convenience, not the
 * only way to reach the reason.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the reported failure */
  }
  return false
}

/**
 * The three rows, rendered from normalised data ONLY.
 *
 * WHY IT IS A SEPARATE, PURE COMPONENT: the display contract ("three rows, the
 * reason on the line below the failed row, no raw payload") is the part the user
 * asked for, and it must be testable without a live host or a click. Nothing
 * here can reach a payload: it receives `ConnectivityRowView[]`, a type that has
 * no field able to hold a response body.
 */
export function ConnectivityRows(props: {
  t: Translate
  rows: readonly ConnectivityRowView[]
  copied: SourceId | null
  onCopyReason: (row: ConnectivityRowView) => void
}): ReactElement {
  const { t, rows, copied, onCopyReason } = props
  return (
    <ul className={styles.connectList}>
      {rows.map(row => (
        <li key={row.source} className={styles.connectRow}>
          <div className={styles.connectHead}>
            <span className={styles.connectSource}>{SOURCE_LABELS[row.source]}</span>
            <span className={`${styles.connectBadge} ${connectivityBadgeClass(row.status)}`}>
              {t(CONNECT_STATUS_LABEL[row.status])}
            </span>
            {row.status === 'ok' ? (
              <span className={styles.connectMeta}>{`HTTP ${row.statusCode ?? '—'} · ${row.latencyMs ?? '—'}ms · ${row.transport ?? '—'}`}</span>
            ) : null}
          </div>
          {/* The failure reason sits on the line directly BELOW the failed row —
              the user asked for the reason "right after the failure", not behind a
              hover and not at the bottom of the card. */}
          {row.status === 'failed' && row.reason.length > 0 ? (
            <div className={styles.connectReasonRow}>
              <span className={styles.connectReason}>
                {t('connect.reasonLabel')}：{row.reason}
              </span>
              <button type="button" className={styles.buttonGhost} onClick={() => onCopyReason(row)}>
                {copied === row.source ? t('connect.reasonCopied') : t('connect.copyReason')}
              </button>
            </div>
          ) : null}
          <p className={styles.connectLogin}>
            {`${t('connect.loginRequirement')}：`}
            {row.evidence.length > 0 ? row.evidence : LOGIN_REQUIREMENTS[row.source]}
            {row.requiresLogin === true
              ? ` · ${t('connect.requiresLogin')}`
              : row.requiresLogin === false
                ? ` · ${t('connect.noLoginNeeded')}`
                : ''}
          </p>
        </li>
      ))}
    </ul>
  )
}

/**
 * Connectivity GUI — the user's headline requirement.
 *
 * WHAT THIS REPLACES AND WHY IT CANNOT COME BACK: the old card serialised the
 * whole smoke payload into a `<pre>` block. That is a JSON document, not a
 * GUI, and it put provider payloads (and any field a future host version decided
 * to add) on screen. Here the payload is normalised by `normalizeSmoke` /
 * `normalizeProbe` into exactly the three contract rows, and ONLY the failure
 * reason text is renderable — the raw body is never stored, so no later edit can
 * accidentally print it.
 *
 * The card deliberately does NOT carry `LearningBanner`: that banner marks
 * learning-result surfaces, and connectivity is not one.
 */
function ConnectivityField({ t }: { t: Translate }): ReactElement {
  const [rows, setRows] = useState<readonly ConnectivityRowView[]>(() => normalizeSmoke(null))
  const [busy, setBusy] = useState<'smoke' | 'probe' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<SourceId | null>(null)
  const [checked, setChecked] = useState(false)

  const run = async (kind: 'smoke' | 'probe'): Promise<void> => {
    if (busy !== null) return
    setBusy(kind)
    setError(null)
    setCopied(null)
    try {
      const payload = kind === 'smoke' ? await runSmoke() : await runProbe({ useStoredCredential: true })
      // The probe merges onto what is on screen: it answers only the sources it
      // measured, and a row it did not cover must keep its previous verdict.
      setRows(kind === 'smoke' ? normalizeSmoke(payload) : normalizeProbe(payload, rows))
      setChecked(true)
    } catch (err) {
      setError(`${kind === 'smoke' ? t('connect.smokeFailed') : t('connect.probeFailed')}${describeError(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const copyReason = async (row: ConnectivityRowView): Promise<void> => {
    const done = await copyToClipboard(row.reason)
    setCopied(done ? row.source : null)
    if (!done) setError(t('connect.copyFailed'))
  }

  // While a check runs every row shows 检测中: the user asked a question and the
  // answer is not in yet, which is exactly what that status means.
  const visible: readonly ConnectivityRowView[] =
    busy === null ? rows : rows.map(row => ({ ...row, status: 'running' as const }))

  return (
    <SectionCard
      title={t('connect.title')}
      hint={t('connect.hint')}
      action={
        <span className={styles.buttonRow}>
          <button
            type="button"
            className={styles.button}
            disabled={busy !== null}
            onClick={() => {
              void run('smoke')
            }}
          >
            {busy === 'smoke' ? t('connect.smokeRunning') : t('connect.runSmoke')}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={busy !== null}
            onClick={() => {
              void run('probe')
            }}
          >
            {busy === 'probe' ? t('connect.probeRunning') : t('connect.runProbe')}
          </button>
        </span>
      }
    >
      {error !== null ? <p className={styles.err}>{error}</p> : null}
      {!checked && busy === null && error === null ? <p className={styles.help}>{t('connect.empty')}</p> : null}
      <ConnectivityRows
        t={t}
        rows={visible}
        copied={copied}
        onCopyReason={row => {
          void copyReason(row)
        }}
      />
    </SectionCard>
  )
}

/**
 * The decision points, FOLDED DOWN and moved to just above the save bar.
 *
 * WHY IT MOVED: a blocking list belongs next to the action it blocks, not at the
 * top of the form where it reads as the page's headline. The wording is also
 * deliberately "还差 N 项 / 未提供" rather than "你还没有…" — it describes the
 * remaining work, it does not scold the user.
 *
 * N = 0 collapses to a single success line: nothing is missing, so there is
 * nothing to read. Optional items (token / mirrors / proxy / CSDN sign-in) are
 * NEVER listed here — they do not block the tool, and listing them would turn a
 * short list into a chore.
 */
function DecisionsField(props: { t: Translate; onLocateGithubAccess?: () => void }): ReactElement {
  const { t, onLocateGithubAccess } = props
  const state = useConfigState()
  const [open, setOpen] = useState(false)
  const [located, setLocated] = useState(false)
  const unresolved = state.unresolved
  const total = DECISION_KEYS.length
  const remaining = unresolved.length
  const ready = Math.max(0, total - remaining)

  const decide = (mutate: (next: CodeHubConfigView) => CodeHubConfigView): void => updateDraft(mutate)

  /** One "decide it here and now" affordance per decision key, where one exists. */
  const decideNow = (key: DecisionKey): ReactNode => {
    if (key === 'sourcePriority') {
      return (
        <button
          type="button"
          className={styles.button}
          onClick={() => decide(next => ({ ...next, sourcePriority: [...SOURCES] }))}
        >
          {t('decisions.decideNow')}：{t('source.preset')}
        </button>
      )
    }
    if (key === 'failoverEnabled' || key === 'mergeSources') {
      const set = (value: boolean): void => {
        decide(next =>
          key === 'failoverEnabled' ? { ...next, failoverEnabled: value } : { ...next, mergeSources: value },
        )
      }
      return (
        <>
          <button type="button" className={styles.button} onClick={() => set(true)}>
            {t('decisions.decideNow')}：{t('tristate.on')}
          </button>
          <button type="button" className={styles.button} onClick={() => set(false)}>
            {t('decisions.decideNow')}：{t('tristate.off')}
          </button>
        </>
      )
    }
    if (key === 'githubAccessPriority') {
      return (
        <>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              onLocateGithubAccess?.()
              setLocated(true)
            }}
          >
            {t('decisions.decideNow')}
          </button>
          {located ? <span className={styles.help}>{t('decisions.located')}</span> : null}
        </>
      )
    }
    return null
  }

  // Nothing missing: one line, and no fold to open. Returning early keeps the
  // success state from rendering an empty list body.
  if (!state.unresolvedError && remaining === 0) {
    return (
      <SectionCard title={t('decisions.title')}>
        <p className={styles.ok}>
          {ready}/{total} {t('decisions.ready')}
        </p>
        <p className={styles.help}>
          <span className={styles.mono}>{TOOL_NAME}</span> {t('decisions.readyHint')}
        </p>
      </SectionCard>
    )
  }

  return (
    <SectionCard title={t('decisions.title')}>
      <button
        type="button"
        className={styles.decisionsHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          {`${t('decisions.remainingPrefix')} ${remaining} ${t('decisions.remainingSuffix')}`}
          <span className={styles.decisionsCount}>{` · ${ready}/${total} ${t('decisions.ready')}`}</span>
        </span>
        <span className={styles.muted}>{open ? t('decisions.collapse') : t('decisions.expand')}</span>
      </button>
      {state.unresolvedError ? <p className={styles.err}>{t('decisions.unavailable')}</p> : null}
      {open ? (
        <div className={styles.decisionsBody}>
          {unresolved.map(item => (
            <div key={item.key} className={styles.decisionsItem}>
              <span className={styles.fieldLabel}>
                {item.ask.length > 0 ? item.ask : t('decisions.notProvided')}
              </span>
              <span className={styles.optionRequirement}>
                {item.detail.length > 0 ? item.detail : t('decisions.notProvided')}
              </span>
              <span className={styles.help}>
                {t('decisions.control')}: {item.control}
              </span>
              <div className={styles.decisionsActions}>{decideNow(item.key)}</div>
            </div>
          ))}
          <p className={styles.help}>{t('decisions.optionalNote')}</p>
          <div className={styles.decisionsActions}>
            <button
              type="button"
              className={styles.buttonGhost}
              onClick={() => {
                void refreshDecisions()
              }}
            >
              <IconRefresh />
              {t('decisions.refresh')}
            </button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  )
}

/**
 * "What did I just configure?" — the first thing the page must answer after a
 * save (DESIGN §8).
 *
 * EVERY value here comes from `state.config`, the host read-back. The draft is
 * never used: a summary that showed unsaved edits would claim something is in
 * effect when the host has not accepted it.
 */
function SavedSummaryField({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const rows = describeConfigSummary(state.config, t)
  const changed = new Set<string>(state.lastChangedKeys)
  const dirty = isDirty()
  const saves = state.lastChangedKeys.length

  const headline =
    state.lastSavedAt === null
      ? t('summary.hostValue')
      : saves > 0
        ? `${t('summary.savedToHost')} · ${formatClock(state.lastSavedAt)} · ${saves} ${t('summary.changeCount')}`
        : t('summary.noChanges')

  return (
    <SectionCard title={t('summary.title')}>
      <p className={styles.summaryHeadline}>{headline}</p>
      {dirty ? <p className={styles.help}>{t('summary.dirtyNote')}</p> : null}
      <div className={styles.summaryGrid}>
        {rows.map(row => (
          <div key={row.key} className={styles.summaryRow}>
            <span className={styles.summaryLabel}>{row.label}</span>
            <span className={styles.summaryValue}>
              {row.value}
              {changed.has(row.key) ? (
                <span className={styles.summaryChanged}>{t('summary.modified')}</span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

/**
 * Wall-clock label for a save timestamp.
 *
 * WHY IT IS NOT IN THE DICTIONARY: the correct rendering ("14:32" / "2:32 PM")
 * is decided by the user's locale, and `toLocaleTimeString()` already knows it.
 * A hand-written dictionary entry would get it wrong in most locales.
 */
function formatClock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    return '—'
  }
}

function EntryPlacementField({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const draft = (state.draft ?? state.config).entryPlacement
  const saved = state.config.entryPlacement
  const pending = draft !== saved
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      // The same save path as the bar at the bottom of the form: the host
      // accepts the patch, the config store adopts it, and index.ts (which
      // subscribes to that store) re-registers the seats. Nothing here reaches
      // into the slot registry directly.
      await saveDraft()
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard title={t('entry.title')} hint={t('entry.hint')}>
      <div className={styles.optionList} role="radiogroup" aria-label={t('entry.title')}>
        {PLACEMENTS.map(placement => {
          const selected = draft === placement
          return (
            <label
              key={placement}
              className={`${styles.optionRow} ${selected ? styles.optionRowSelected : ''}`}
            >
              <input
                type="radio"
                className={styles.optionInput}
                name="dsh-codehub-placement"
                value={placement}
                checked={selected}
                onChange={() => updateDraft(next => ({ ...next, entryPlacement: placement }))}
              />
              <span className={styles.optionText}>
                <span className={styles.optionTitle}>{t(PLACEMENT_LABEL[placement])}</span>
                <span className={styles.optionDesc}>{t(PLACEMENT_DESC[placement])}</span>
              </span>
            </label>
          )
        })}
      </div>

      <div className={styles.optionSaveRow}>
        <span className={pending ? styles.statusWarn : styles.muted}>
          {pending ? t('entry.unsaved') : `${t('entry.current')}：${t(PLACEMENT_LABEL[saved])} · ${t('entry.inSync')}`}
        </span>
        <button
          type="button"
          className={styles.buttonPrimary}
          disabled={!pending || saving}
          onClick={() => {
            void save()
          }}
        >
          {saving ? t('entry.saving') : t('entry.save')}
        </button>
      </div>
    </SectionCard>
  )
}

function SettingsScopeRow({ t }: { t: Translate }): ReactElement {
  const status = useSettingsScopeStatus()
  const [message, setMessage] = useState<string | null>(null)
  const hint = !status.present
    ? t('settings.syncAbsent')
    : status.status === 'ready'
      ? t('settings.syncReady')
      : status.status === 'loading'
        ? t('settings.syncLoading')
        : t('settings.syncUnavailable')

  const pull = (): void => {
    const patch = pullSettingsScopePatch()
    if (!patch || Object.keys(patch).length === 0) {
      setMessage(t('settings.pullEmpty'))
      return
    }
    updateDraft(next => applyPatchLocally(next, patch))
    setMessage(t('settings.pullDone'))
  }

  return (
    <div className={styles.card}>
      <div className={styles.rowBetween}>
        <span className={styles.help}>{hint}</span>
        <button type="button" className={styles.button} disabled={!status.present} onClick={pull}>
          {t('settings.syncPull')}
        </button>
      </div>
      {message ? <p className={styles.help}>{message}</p> : null}
    </div>
  )
}

/**
 * The save bar states the OUTCOME, not the obligation: what was saved and how
 * many changes it carried, or that the form already matches the host.
 */
/**
 * The always-visible save bar, carrying the auto-save switch itself.
 *
 * WHY THE SWITCH IS HERE: the first version hard-coded auto-save ON. That meant
 * every edit was already written by the time the user looked at the bar, so
 * 「保存到 host」 was permanently disabled and the bar was decorative — the user's
 * exact complaint. Auto-save is a real preference now (`ui.autoSave`) and its
 * switch sits in the bar, i.e. where the user went looking for it.
 *
 * THE BUTTON IS USEFUL IN BOTH MODES:
 *   • auto-save ON  → 「立即保存」, enabled while a write is pending or a draft exists;
 *     it flushes immediately instead of waiting out the debounce.
 *   • auto-save OFF → 「保存到 host」, enabled whenever there is anything to write.
 * So a disabled button means exactly one thing: nothing to save.
 */
function SaveBar({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const dirty = isDirty()
  const saves = state.lastChangedKeys.length
  const stamp =
    state.lastSavedAt === null
      ? ''
      : new Date(state.lastSavedAt).toLocaleTimeString(undefined, { hour12: false })
  const autoSave = state.draft?.autoSave ?? state.config.autoSave
  const canWrite = (dirty || state.autoSavePending) && !state.saving

  const status = dirty
    ? state.saving
      ? t('panel.saving')
      : state.autoSavePending
        ? t('panel.autoSavePending')
        : t('panel.dirtyManual')
    : state.lastSavedAt === null || saves === 0
      ? t('panel.clean')
      : `${state.lastSaveReason === 'auto' ? t('panel.autoSaved') : state.lastSaveReason === 'preference' ? t('panel.preferenceSaved') : t('panel.saved')} · ${saves} ${t('summary.changeCount')}${stamp === '' ? '' : ` · ${stamp}`}`

  return (
    <div className={`${styles.card} ${styles.saveBarSticky}`}>
      <div className={styles.rowBetween}>
        <span className={dirty ? styles.statusWarn : styles.muted}>{status}</span>
        <span className={styles.buttonRow}>
          <label className={styles.saveBarToggle}>
            <input
              type="checkbox"
              checked={autoSave}
              onChange={event => {
                const next = event.target.checked
                // Flipping this switch is itself an edit: it must persist, and
                // turning it OFF has to cancel a write already scheduled (the
                // scheduler re-reads the draft, so `updateDraft` handles both).
                updateDraft(draft => ({ ...draft, autoSave: next }))
              }}
            />
            <span>{t('panel.autoSaveToggle')}</span>
          </label>
          <button
            type="button"
            className={styles.button}
            disabled={!canWrite}
            onClick={resetDraft}
            title={t('panel.revertHint')}
          >
            {t('panel.revert')}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={!canWrite}
            onClick={() => {
              // `autoSaveNow` collapses a pending auto-save into this click, so the
              // button means "write it now" in BOTH modes.
              void autoSaveNow()
            }}
          >
            {state.saving ? t('panel.saving') : autoSave ? t('panel.saveNow') : t('panel.save')}
          </button>
        </span>
      </div>
      {state.error ? <p className={styles.err}>{state.error}</p> : null}
      {/* Host-side warnings are shown, not swallowed: the case that produced them
          was a host that dropped `ui.autoSave` and silently reverted the switch. */}
      {state.lastWarnings.map(warning => (
        <p key={warning} className={styles.warn}>
          {warning}
        </p>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The shared control surface — panel and settings page both render this.
// ---------------------------------------------------------------------------

export function CodeHubControls({ t, variant }: { t: Translate; variant: 'panel' | 'settings' }): ReactElement {
  const state = useConfigState()
  const config: CodeHubConfigView = state.draft ?? state.config
  const [highlightGithubAccess, setHighlightGithubAccess] = useState(false)

  // The highlight is a pointer, not a state: it fades on its own so a later look
  // at the page does not show a stale "look here" ring.
  useEffect(() => {
    if (!highlightGithubAccess) return undefined
    const timer = setTimeout(() => setHighlightGithubAccess(false), 5000)
    return () => clearTimeout(timer)
  }, [highlightGithubAccess])

  const locateGithubAccess = (): void => {
    setHighlightGithubAccess(true)
    if (typeof document === 'undefined') return
    const target = document.getElementById(GITHUB_ACCESS_ANCHOR_ID)
    target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }

  const patchDraft = (mutate: (next: CodeHubConfigView) => CodeHubConfigView): void => updateDraft(mutate)

  return (
    <div className={variant === 'settings' ? styles.formGrid : styles.stack}>
      {/* 0. What is actually configured, first: after a save the page must answer
          "我配置了什么" before anything else. Values are host read-backs. */}
      <SavedSummaryField t={t} />

      {variant === 'settings' ? <SettingsScopeRow t={t} /> : null}

      {/* 1. Where the plugin appears. It is the one control a user arrives
          looking for, and it is an ordinary saved setting — both surfaces are on
          by default, so nothing asks on startup. */}
      <EntryPlacementField t={t} />

      {/* 2. Source priority */}
      <SourcePriorityField
        t={t}
        value={config.sourcePriority}
        onChange={next => patchDraft(draft => ({ ...draft, sourcePriority: [...next] }))}
      />

      {/* 3. GitHub access, four risk bands, token/mirror mutex explained */}
      <GithubAccessField
        t={t}
        value={config.githubAccessPriority}
        onChange={next => patchDraft(draft => ({ ...draft, githubAccessPriority: [...next] }))}
        highlighted={highlightGithubAccess}
      />

      {/* 3. Failover tri-state */}
      <SectionCard title={t('failover.title')} hint={t('failover.hint')}>
        <TriStateField
          t={t}
          groupLabel={t('failover.title')}
          value={config.failoverEnabled}
          onChange={next => patchDraft(draft => ({ ...draft, failoverEnabled: next }))}
        />
      </SectionCard>

      {/* 4. Merge tri-state */}
      <SectionCard title={t('merge.title')} hint={t('merge.hint')}>
        <TriStateField
          t={t}
          groupLabel={t('merge.title')}
          value={config.mergeSources}
          onChange={next => patchDraft(draft => ({ ...draft, mergeSources: next }))}
        />
      </SectionCard>

      {/* 5./6. Accounts (+ 备注② CSDN provenance) */}
      <AccountsField t={t} />

      {/* CSDN 抓取选项 — the switches behind the "how do I enable it?" question.
          A config key with no control is a feature nobody can turn on, so the
          experimental capture (default OFF) is a visible checkbox here, with its
          cost stated next to it rather than buried in a schema description. */}
      <CsdnOptionsField t={t} />

      {/* 7. Mirror list CRUD. An empty list is reported INLINE here as 未配置 —
          the optional items never enter the "still missing" list, because they do
          not block the tool. */}
      <SectionCard
        title={t('mirror.title')}
        action={
          config.webProxyBases.length === 0 && config.rawMirrorBases.length === 0 ? (
            <span className={styles.muted}>{t('common.notConfigured')}</span>
          ) : null
        }
      >
        <MirrorField
          t={t}
          title={t('mirror.webTitle')}
          hint={t('mirror.hint')}
          placeholder={t('mirror.webPlaceholder')}
          values={config.webProxyBases}
          onChange={next => patchDraft(draft => ({ ...draft, webProxyBases: [...next] }))}
        />
        <MirrorField
          t={t}
          title={t('mirror.rawTitle')}
          hint={t('mirror.rawNote')}
          placeholder={t('mirror.rawPlaceholder')}
          values={config.rawMirrorBases}
          onChange={next => patchDraft(draft => ({ ...draft, rawMirrorBases: [...next] }))}
        />
      </SectionCard>

      {/* 8. Local proxy — 备注① label + help rendered from contract constants.
          Rendered text contains 「仅 Node 直连传输生效」 (LOCAL_PROXY_SCOPE_NOTE)
          and the full LOCAL_PROXY_HELP. */}
      <SectionCard
        title={LOCAL_PROXY_LABEL}
        action={
          config.localProxy.trim().length === 0 ? (
            <span className={styles.muted}>{t('common.notConfigured')}</span>
          ) : null
        }
      >
        <label className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>{LOCAL_PROXY_FIELD_LABEL}</span>
          <UIInput
            value={config.localProxy}
            placeholder={t('proxy.placeholder')}
            aria-label={LOCAL_PROXY_FIELD_LABEL}
            onChange={event => patchDraft(draft => ({ ...draft, localProxy: event.target.value }))}
          />
        </label>
        <p className={styles.help}>{LOCAL_PROXY_HELP}</p>
        <p className={styles.help}>{t('proxy.empty')}</p>
      </SectionCard>

      {/* 9./10. Limits */}
      <SectionCard title={t('limits.title')} hint={t('limits.hint')}>
        <div className={styles.inlineFields}>
          {LIMIT_FIELDS.map(field => (
            <NumberField
              key={field.key}
              label={t(field.label)}
              capLabel={t('limits.hardCap')}
              value={config.limits[field.key]}
              min={field.min}
              max={field.max}
              onChange={next =>
                patchDraft(draft => ({ ...draft, limits: withLimit(draft.limits, field.key, next) }))
              }
            />
          ))}
        </div>
      </SectionCard>

      {/* 11. Deep-read targets */}
      <SectionCard title={t('deepread.title')} hint={t('deepread.hint')}>
        <div className={styles.row}>
          {DEEP_READ_TARGETS.map(target => (
            <label key={target} className={styles.radioLabel}>
              <input
                type="checkbox"
                checked={config.deepReadTargets.includes(target)}
                onChange={() =>
                  patchDraft(draft => ({
                    ...draft,
                    deepReadTargets: draft.deepReadTargets.includes(target)
                      ? draft.deepReadTargets.filter(item => item !== target)
                      : [...draft.deepReadTargets, target],
                  }))
                }
              />
              <span>{t(DEEP_READ_LABEL[target])}</span>
            </label>
          ))}
        </div>
      </SectionCard>

      {/* 12. (entry placement moved to the top of this list — see step 1) */}

      {/* 13. Connectivity — the three-row GUI. Not a result surface, so no banner. */}
      <ConnectivityField t={t} />

      {/* 14. Environment probe, its own card with the flat key/value list. */}
      <DetectField t={t} />

      {/* 15. The blocking decisions, folded down to sit right above the save bar:
          this is the last thing read before saving, and it is about what blocks
          the first tool call. */}
      <DecisionsField t={t} onLocateGithubAccess={locateGithubAccess} />
      <SaveBar t={t} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar panel seat
// ---------------------------------------------------------------------------

export function CodeHubPanel(props: SeatProps): ReactElement {
  const t = useTranslate(props)
  const state = useConfigState()

  useEffect(() => {
    void loadConfig()
  }, [])

  const status =
    state.status === 'idle' || state.status === 'loading'
      ? { text: t('panel.loading'), className: styles.muted }
      : state.status === 'ready'
        ? { text: t('panel.hostReady'), className: styles.statusOk }
        : { text: t('panel.hostUnavailable'), className: styles.statusError }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        {/* The GitHub cat mark followed by the plugin's word — the same pair the
            sidebar rail row shows, drawn from the same glyph component. */}
        <span className={styles.entryMark}>
          <GitHubCatGlyph size={18} />
          <span className={styles.entryMarkText}>{UI_ENTRY_LABEL}</span>
        </span>
        <p className={styles.subtitle}>{t('panel.subtitle')}</p>
      </header>

      <div className={styles.statusRow}>
        <span className={status.className}>{status.text}</span>
        {state.status === 'error' && state.error ? <span className={styles.muted}>{state.error}</span> : null}
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.buttonGhost}
          disabled={state.status === 'loading'}
          onClick={() => {
            void loadConfig(true)
          }}
        >
          <IconRefresh />
          {t('panel.refresh')}
        </button>
      </div>
      <p className={styles.help}>{t('panel.describeConfig')}</p>

      {/* 备注③ — the panel's result-bearing surfaces carry the banner. */}
      <LearningBanner t={t} />

      <CodeHubControls t={t} variant="panel" />
    </div>
  )
}
