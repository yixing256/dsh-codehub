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
  DEEP_READ_TARGETS,
  HARD_LIMITS,
  LEARNING_ONLY_BANNER,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_LABEL,
  LOCAL_PROXY_SCOPE_NOTE,
  SOURCES,
  SOURCE_LABELS,
  TOKEN_FORBIDDEN_ACCESS,
  UI_ENTRY_LABEL,
} from '../contract.js'
import type { AccessRisk, DeepReadTarget, GithubAccessId, SourceId } from '../contract.js'
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
  clearCredential,
  describeError,
  fetchDetect,
  isDirty,
  loadConfig,
  pullSettingsScopePatch,
  refreshDecisions,
  resetDraft,
  runSmoke,
  saveDraft,
  updateDraft,
  useConfigState,
  useSettingsScopeStatus,
} from './api.js'
import type { CodeHubConfigView, CodeHubLimits, CredentialSource, EntryPlacement } from './api.js'
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

const RISK_LABEL: Record<AccessRisk, LocaleKey> = {
  stable: 'risk.stable',
  temporary: 'risk.temporary',
  'privacy-risk': 'risk.privacy-risk',
  'not-recommended': 'risk.not-recommended',
}

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

/**
 * The three placements as the control lists them.
 *
 * `both` first because it IS the default (`SCHEMA_DEFAULTS.entryPlacement`), so
 * the pre-selected choice is also the first one read.
 */
const PLACEMENTS: readonly EntryPlacement[] = ['both', 'sidebar', 'settings']

const DEEP_READ_LABEL: Record<DeepReadTarget, LocaleKey> = {
  readme: 'deepread.readme',
  entry: 'deepread.entry',
  core: 'deepread.core',
  tests: 'deepread.tests',
}

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

function GithubAccessField(props: {
  t: Translate
  value: readonly GithubAccessId[]
  onChange: (value: readonly GithubAccessId[]) => void
}): ReactElement {
  const { t, value, onChange } = props
  const toggle = (id: GithubAccessId): void => {
    onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id])
  }
  const carriesToken = value.some(id => ACCESS_OPTIONS.find(option => option.id === id)?.carriesToken === true)
  const hasForbidden = value.some(id => TOKEN_FORBIDDEN_ACCESS.includes(id))

  return (
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
                <button type="button" className={styles.button} onClick={() => openLoginDialog(row.source)}>
                  {configured ? t('account.relogin') : t('account.login')}
                </button>
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
            {row.source === 'csdn' ? (
              <>
                {/* 备注② — CSDN_API_NOTE rendered verbatim: 非官方内部接口、
                    probe date CSDN_API_PROBED_AT、字段与可用性可能随时失效。 */}
                <p className={styles.noteBox}>{CSDN_API_NOTE}</p>
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
// Environment probe + connectivity self-check
// ---------------------------------------------------------------------------

function ProbeField({ t }: { t: Translate }): ReactElement {
  const [detect, setDetect] = useState<Record<string, string | number | boolean | null> | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [smoke, setSmoke] = useState<unknown>(null)
  const [smokeError, setSmokeError] = useState<string | null>(null)
  const [smoking, setSmoking] = useState(false)

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

  const runCheck = async (): Promise<void> => {
    setSmoking(true)
    setSmokeError(null)
    try {
      setSmoke(await runSmoke())
    } catch (err) {
      setSmokeError(describeError(err))
    } finally {
      setSmoking(false)
    }
  }

  const entries = detect ? Object.entries(detect) : []

  return (
    <SectionCard
      title={t('tools.title')}
      action={
        <span className={styles.buttonRow}>
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
          <button
            type="button"
            className={styles.button}
            disabled={smoking}
            onClick={() => {
              void runCheck()
            }}
          >
            {smoking ? t('tools.smokeRunning') : t('tools.smokeRun')}
          </button>
        </span>
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

      {smokeError ? <p className={styles.err}>{smokeError}</p> : null}
      {smoke === null && !smokeError ? <p className={styles.help}>{t('tools.smokeEmpty')}</p> : null}
      {smoke !== null ? (
        <>
          {/* 备注③ — any result surface carries the learning-only banner. */}
          <LearningBanner t={t} />
          <pre className={styles.codeBlock}>{JSON.stringify(smoke, null, 2)}</pre>
        </>
      ) : null}
    </SectionCard>
  )
}

function DecisionsField({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const unresolved = state.unresolved
  return (
    <SectionCard
      title={t('decisions.title')}
      hint={t('decisions.hint')}
      action={
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
      }
    >
      {state.unresolvedError ? <p className={styles.err}>{t('decisions.unavailable')}</p> : null}
      {!state.unresolvedError && unresolved.length === 0 ? (
        <p className={styles.ok}>{t('decisions.empty')}</p>
      ) : null}
      {unresolved.map(item => (
        <div key={item.key} className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>{item.ask}</span>
          <span className={styles.optionRequirement}>{item.detail}</span>
          <span className={styles.help}>
            {t('decisions.control')}: {item.control}
          </span>
        </div>
      ))}
    </SectionCard>
  )
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

function SaveBar({ t }: { t: Translate }): ReactElement {
  const state = useConfigState()
  const dirty = isDirty()
  return (
    <div className={styles.card}>
      <div className={styles.rowBetween}>
        <span className={dirty ? styles.statusWarn : styles.muted}>
          {dirty ? t('panel.dirty') : state.lastSavedAt !== null ? t('panel.saved') : t('panel.clean')}
        </span>
        <span className={styles.buttonRow}>
          <button type="button" className={styles.button} disabled={!dirty || state.saving} onClick={resetDraft}>
            {t('panel.revert')}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={!dirty || state.saving}
            onClick={() => {
              void saveDraft()
            }}
          >
            {state.saving ? t('panel.saving') : t('panel.save')}
          </button>
        </span>
      </div>
      {state.error ? <p className={styles.err}>{state.error}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The shared control surface — panel and settings page both render this.
// ---------------------------------------------------------------------------

export function CodeHubControls({ t, variant }: { t: Translate; variant: 'panel' | 'settings' }): ReactElement {
  const state = useConfigState()
  const config: CodeHubConfigView = state.draft ?? state.config

  const patchDraft = (mutate: (next: CodeHubConfigView) => CodeHubConfigView): void => updateDraft(mutate)

  return (
    <div className={variant === 'settings' ? styles.formGrid : styles.stack}>
      {variant === 'settings' ? <SettingsScopeRow t={t} /> : null}

      {/* 0. Where the plugin appears. FIRST, not last: it is the one control a
          user arrives looking for, and it is an ordinary saved setting — both
          surfaces are on by default, so nothing asks on startup. */}
      <EntryPlacementField t={t} />

      <DecisionsField t={t} />

      {/* 1. Source priority */}
      <SourcePriorityField
        t={t}
        value={config.sourcePriority}
        onChange={next => patchDraft(draft => ({ ...draft, sourcePriority: [...next] }))}
      />

      {/* 2. GitHub access, four risk bands, token/mirror mutex explained */}
      <GithubAccessField
        t={t}
        value={config.githubAccessPriority}
        onChange={next => patchDraft(draft => ({ ...draft, githubAccessPriority: [...next] }))}
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

      {/* 7. Mirror list CRUD */}
      <SectionCard title={t('mirror.title')}>
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
      <SectionCard title={LOCAL_PROXY_LABEL}>
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

      {/* 12. (entry placement moved to the top of this list — see step 0) */}

      <ProbeField t={t} />
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
