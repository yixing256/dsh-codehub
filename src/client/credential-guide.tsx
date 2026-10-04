/**
 * dsh-codehub — the credential guide (「单独一个界面手把手教」).
 *
 * WHY A SEPARATE WIZARD INSTEAD OF A BIGGER DIALOG
 * ------------------------------------------------
 * Getting a credential is 3–4 browser steps that differ per source: create an
 * OAuth App and tick Device Flow (GitHub), register a callback and create an
 * application (Gitee), copy a Cookie request header out of DevTools (CSDN). The
 * step text therefore comes from `LOGIN_GUIDES` / `loginGuideFor()` in the frozen
 * contract — this file renders it, it does not re-write it.
 *
 * VALUE HANDLING (the security contract of this file)
 * --------------------------------------------------
 * 1. Values live in component state only: the controlled input, and the request
 *    body built from it. Nothing goes to the config store, localStorage, a URL or
 *    a log line. There is no code path here that can display a value it does not
 *    have, and every value field is `type="password"`.
 * 2. The ONE value that outlives a single request is the Gitee `clientSecret`:
 *    the same secret is needed both to start the flow and to complete it when the
 *    callback never arrives. It is therefore kept (masked) until the FLOW
 *    settles, and cleared on close — never persisted, never sent anywhere but
 *    those two request bodies. Every other value is cleared as soon as its
 *    request settles.
 * 3. The device-flow `userCode` and the authorization `code` are NOT rendered
 *    from the host payload beyond what the host already sends by design; only
 *    the CDP result (cookie NAMES and a count) is shown, never a cookie value.
 */

import { Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputProps, ModalProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactElement } from 'react'

import {
  CDP_DEFAULT_PORT,
  loginGuideFor,
  loginMethodsOf,
  LOGIN_METHOD_FAMILIES,
  LOGIN_METHOD_KIND,
  LOGIN_URLS,
  OAUTH_CALLBACK_PATH,
  OAUTH_SLOW_DOWN_STEP_MS,
  SOURCE_LOGIN_METHODS,
  SOURCE_LABELS,
} from '../contract.js'
import type { LoginGuideField, LoginMethodId, SourceId } from '../contract.js'
import {
  applyCredentials,
  autoSaveNow,
  captureCookies,
  cancelOAuth,
  completeOAuth,
  describeError,
  isCredentialsServiceUnavailable,
  launchDebugBrowser,
  markCredentialConfigured,
  saveCredential,
  startOAuth,
  statusOAuth,
  updateDraft,
  useConfigState,
} from './api.js'
import type { CookieCaptureView, OAuthFlowStatus, OAuthFlowView } from './api.js'
import { useTranslate } from './locales.js'
import type { LocaleKey, Translate } from './locales.js'
import styles from './panel.module.css'

/** Typing bridge only — the runtime primitives are used as-is (same as the dialog). */
const UIModal = Modal as unknown as ComponentType<ModalProps>
const UIInput = Input as unknown as ComponentType<InputProps>

const OAUTH_STATUS_LABEL: Record<OAuthFlowStatus, LocaleKey> = {
  pending: 'guide.status.pending',
  slow_down: 'guide.status.slow_down',
  done: 'guide.status.done',
  expired: 'guide.status.expired',
  error: 'guide.status.error',
  unknown: 'guide.status.unknown',
}

/** `pat` / `cookie-paste` write straight to the credential service; the two OAuth methods do not. */
const MANUAL_KIND: Partial<Record<LoginMethodId, 'token' | 'cookie'>> = {
  pat: 'token',
  'cookie-paste': 'cookie',
}

/**
 * Clipboard write with an honest failure path (same reasoning as the panel's
 * copy button: a silent failure is worse than no button).
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    /* reported to the user by the caller */
  }
  return false
}

/**
 * Open a URL in a new tab.
 *
 * MUST be called synchronously from the click handler: browsers only honour
 * `window.open` while the user gesture is live, and an `await` before this call
 * spends the gesture. That is why every "打开" button calls this directly and the
 * URL it opens was already stored in state by an earlier, separate action.
 */
function openUrl(url: string): void {
  try {
    if (typeof window === 'undefined') return
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* a blocked popup leaves the copy-link button as the fallback */
  }
}

/** The loopback callback the Gitee app must register, derived from the live page. */
function callbackUrl(): string {
  try {
    if (typeof window === 'undefined') return OAUTH_CALLBACK_PATH
    return `http://${window.location.host}${OAUTH_CALLBACK_PATH}`
  } catch {
    return OAUTH_CALLBACK_PATH
  }
}

// ---------------------------------------------------------------------------
// Open/close store — a separate overlay from the login dialog on purpose
// ---------------------------------------------------------------------------

export interface CredentialGuideState {
  open: boolean
  source: SourceId | null
  method: LoginMethodId | null
}

let guideState: CredentialGuideState = { open: false, source: null, method: null }
const listeners = new Set<() => void>()

function emit(next: CredentialGuideState): void {
  guideState = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* a broken subscriber must not break the wizard */
    }
  }
}

export function subscribeCredentialGuide(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCredentialGuideState(): CredentialGuideState {
  return guideState
}

export function useCredentialGuideState(): CredentialGuideState {
  return useSyncExternalStore(subscribeCredentialGuide, getCredentialGuideState, getCredentialGuideState)
}

/** Open the wizard for one source; the method defaults to that source's first. */
export function openCredentialGuide(source: SourceId, method?: LoginMethodId): void {
  const fallback = SOURCE_LOGIN_METHODS[source][0] ?? null
  emit({ open: true, source, method: method ?? fallback })
}

export function closeCredentialGuide(): void {
  emit({ open: false, source: guideState.source, method: guideState.method })
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

export interface CredentialGuideProps {
  t?: Translate
}

/**
 * Rendered from the `shell.overlay` seat. It subscribes to its own store, so the
 * parent does not need to pass open/close state (and a closed login dialog can
 * never take the wizard down with it).
 */
export function CredentialGuide(props: CredentialGuideProps): ReactElement | null {
  const t = useTranslate(props)
  const state = useCredentialGuideState()
  const source = state.source
  const method = state.method
  /**
   * The CONFIG store as well as the guide store: the CDP switch lives in the
   * config, and the wizard carries its own copy of that switch (see the
   * `cookie-cdp` branch) so the user is never sent to another screen to find it.
   */
  const configState = useConfigState()

  const [fields, setFields] = useState<Partial<Record<LoginGuideField['slot'], string>>>({})
  const [busy, setBusy] = useState<'start' | 'fields' | 'code' | 'cdp' | 'enable-cdp' | 'launch-browser' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flow, setFlow] = useState<OAuthFlowView | null>(null)
  const [code, setCode] = useState('')
  const [consent, setConsent] = useState(false)
  const [port, setPort] = useState(String(CDP_DEFAULT_PORT))
  const [capture, setCapture] = useState<CookieCaptureView | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [launchNote, setLaunchNote] = useState<string | null>(null)

  // A stale secret must never survive a close or a switch to another source.
  useEffect(() => {
    setFields({})
    setFlow(null)
    setError(null)
    setCode('')
    setConsent(false)
    setPort(String(CDP_DEFAULT_PORT))
    setCapture(null)
    setCopied(null)
    setBusy(null)
  }, [state.open, source, method])

  // Poll the live flow. The host owns the provider-side timing; this only asks.
  useEffect(() => {
    if (flow === null || flow.flowId === '') return undefined
    if (flow.status !== 'pending' && flow.status !== 'slow_down') return undefined
    const base = flow.intervalMs > 0 ? flow.intervalMs : 5_000
    const interval = flow.status === 'slow_down' ? base + OAUTH_SLOW_DOWN_STEP_MS : base
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const next = await statusOAuth(flow.flowId)
          setFlow(next)
          // The credential is already in the service by the time the host reports
          // this; only the boolean travels, never a value.
          if (next.credentialConfigured && next.status === 'done' && source !== null) {
            markCredentialConfigured(source)
            setFields(current => ({ ...current, clientSecret: '' }))
          }
        } catch (err) {
          setError(describeError(err))
        }
      })()
    }, Math.max(1_000, interval))
    return () => clearTimeout(timer)
  }, [flow, source])

  if (!state.open || source === null || method === null) return null

  /**
   * Switch method WITHOUT closing the wizard.
   *
   * It just re-emits the store with the new method; the existing effect keyed on
   * `method` then clears every value-bearing field, so switching from an OAuth
   * flow to a manual paste (or the reverse) can never leave a stale secret, code
   * or cookie behind in a field the new method would submit.
   */
  const selectMethod = (next: LoginMethodId): void => {
    if (next === method) return
    emit({ open: true, source, method: next })
  }

  /**
   * Enable the experimental capture from inside the wizard, and SAVE IT NOW.
   *
   * Not left to the debounced auto-save: the host refuses the read until it has
   * the flag (`/cookies` → 403 `csdn.cdpEnabled = false`), so a pending write would
   * make the very next click fail for no visible reason. The port the user has
   * already typed is included, so the panel and the read agree on one number.
   */
  const enableCdp = async (): Promise<void> => {    if (busy !== null) return
    setBusy('enable-cdp')
    setError(null)
    try {
      const parsedPort = Number(port)
      updateDraft(draft => ({
        ...draft,
        csdnCdpEnabled: true,
        ...(Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
          ? { csdnCdpPort: Math.trunc(parsedPort) }
          : {}),
      }))
      if (!(await autoSaveNow())) setError(t('guide.cdpEnableFailed'))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const guide = loginGuideFor(source, method)
  const manualKind = MANUAL_KIND[method]
  const secretKind = LOGIN_METHOD_KIND[method]

  /**
   * ③ 启动调试浏览器 — the same action the panel offers, but here.
   *
   * WHY HERE: the user described the round trip as disjointed ("主界面到向导的操作太割裂"):
   * enable the switch in the panel, then come back to the wizard to read. The wizard
   * now owns every step of the CDP path in the order they happen: enable → launch →
   * log in in that window → consent → read. The launcher itself probes first, so
   * pressing it twice (or with a debugger already running) never starts a second one.
   */
  const launchBrowser = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('launch-browser')
    setError(null)
    setLaunchNote(null)
    try {
      const parsedPort = Number(port)
      const result = await launchDebugBrowser({
        port: Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535 ? Math.trunc(parsedPort) : CDP_DEFAULT_PORT,
        consent: true,
        url: LOGIN_URLS.csdnLogin,
      })
      setLaunchNote(result.reason.length > 0 ? result.reason : t('csdn.cdp.launched'))
    } catch (err) {
      setLaunchNote(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  // One input per distinct slot any step asks for, in contract order.
  const fieldSpecs: LoginGuideField[] = []
  for (const step of guide.steps) {
    for (const field of step.fields ?? []) {
      if (!fieldSpecs.some(spec => spec.slot === field.slot)) fieldSpecs.push(field)
    }
  }

  const setField = (slot: LoginGuideField['slot'], value: string): void => {
    setFields(current => ({ ...current, [slot]: value }))
  }

  const copy = async (id: string, text: string): Promise<void> => {
    const done = await copyToClipboard(text)
    setCopied(done ? id : null)
    if (!done) setError(t('guide.copyFailed'))
  }

  const finishFlow = (view: OAuthFlowView): void => {
    setFlow(view)
    // The flow is over: the Gitee secret is single-use per flow and leaves now.
    if (view.status !== 'pending' && view.status !== 'slow_down') {
      setFields(current => ({ ...current, clientSecret: '' }))
    }
    if (view.credentialConfigured) markCredentialConfigured(source)
  }

  const startFlow = async (): Promise<void> => {
    if (busy !== null) return
    const clientId = (fields.clientId ?? '').trim()
    if (clientId === '') {
      setError(t('login.empty'))
      return
    }
    const clientSecret = (fields.clientSecret ?? '').trim()
    if (method !== 'oauth-device' && method !== 'oauth-code') return
    setBusy('start')
    setError(null)
    try {
      const view = await startOAuth({
        source,
        method,
        clientId,
        ...(clientSecret === '' ? {} : { clientSecret }),
      })
      if (!view.ok) setError(`${t('guide.startFailed')}${view.reason}`)
      finishFlow(view)
    } catch (err) {
      setError(`${t('guide.startFailed')}${describeError(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const cancelFlow = async (): Promise<void> => {
    const current = flow
    if (current === null || current.flowId === '') return
    setError(null)
    try {
      const view = await cancelOAuth(current.flowId)
      setFlow(view)
      setFields(next => ({ ...next, clientSecret: '' }))
    } catch (err) {
      setError(describeError(err))
    }
  }

  const submitCode = async (): Promise<void> => {
    if (busy !== null) return
    const value = code.trim()
    if (value === '') {
      setError(t('login.empty'))
      return
    }
    setBusy('code')
    setError(null)
    try {
      const view = await completeOAuth({
        source,
        code: value,
        clientId: (fields.clientId ?? '').trim(),
        clientSecret: (fields.clientSecret ?? '').trim(),
      })
      if (!view.ok) setError(view.reason)
      finishFlow(view)
    } catch (err) {
      setError(describeError(err))
    } finally {
      // The authorization code is single-use: whatever happened, it leaves the DOM.
      setCode('')
      setBusy(null)
    }
  }

  const saveManualValue = async (): Promise<void> => {
    if (busy !== null) return
    if (manualKind === undefined) return
    const slot: LoginGuideField['slot'] = manualKind === 'cookie' ? 'cookie' : 'token'
    const value = (fields[slot] ?? '').trim()
    if (value === '') {
      setError(t('login.empty'))
      return
    }
    setBusy('fields')
    setError(null)
    try {
      applyCredentials(await saveCredential(source, manualKind, value))
      setFlow({ ...EMPTY_FLOW, ok: true, status: 'done', credentialConfigured: true, reason: t('guide.statusConfigured') })
    } catch (err) {
      setError(isCredentialsServiceUnavailable(err) ? t('login.serviceUnavailable') : describeError(err))
    } finally {
      setField(slot, '')
      setBusy(null)
    }
  }

  const readCookies = async (): Promise<void> => {
    if (busy !== null || !consent) return
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      setError(t('guide.cdpPort'))
      return
    }
    setBusy('cdp')
    setError(null)
    try {
      const result = await captureCookies({ consent: true, port: parsed })
      setCapture(result)
      if (result.ok) markCredentialConfigured('csdn')
      else if (result.reason.length > 0) setError(result.reason)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const statusText = flow === null ? null : t(OAUTH_STATUS_LABEL[flow.status])

  /**
   * The method picker, grouped into the two families.
   *
   * WHY A PICKER AT ALL: the wizard used to open straight into whichever method
   * the caller asked for, so the other ways to get a credential were invisible —
   * and the two KINDS were indistinguishable even when both were listed. Now the
   * family is the first thing on screen: "浏览器 OAuth 登录" (the browser does the
   * authorization) versus "令牌 / Cookie 手动导入" (you copy a value out of a
   * browser you already trust). A source that has no OAuth says so instead of
   * silently showing one family.
   */
  const familyPicker = (
    <div className={styles.guideFamilies}>
      {LOGIN_METHOD_FAMILIES.map(family => {
        const methods = loginMethodsOf(source, family)
        const familyKey = family === 'oauth' ? 'guide.family.oauth' : 'guide.family.manual'
        const hintKey = family === 'oauth' ? 'guide.family.oauthHint' : 'guide.family.manualHint'
        return (
          <section key={family} className={styles.guideFamily}>
            <div className={styles.guideFamilyHead}>
              <span
                className={`${styles.guideFamilyBadge} ${family === 'oauth' ? styles.guideFamilyBadgeOauth : styles.guideFamilyBadgeManual}`}
              >
                {t(familyKey)}
              </span>
              <span className={styles.guideFamilyHint}>{t(hintKey)}</span>
            </div>
            {methods.length === 0 ? (
              <p className={styles.guideFamilyEmpty}>{t('guide.family.noOauth')}</p>
            ) : (
              <div className={styles.guideMethodRow} role="radiogroup" aria-label={t(familyKey)}>
                {methods.map(candidate => {
                  const selected = candidate === method
                  const kindLabel =
                    LOGIN_METHOD_KIND[candidate] === 'cookie'
                      ? t('guide.kind.cookie')
                      : t('guide.kind.token')
                  return (
                    <button
                      key={candidate}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`${styles.guideMethodBase} ${selected ? styles.guideMethodActive : ''}`}
                      onClick={() => selectMethod(candidate)}
                    >
                      <span className={styles.guideMethodTitle}>{loginGuideFor(source, candidate).title}</span>
                      <span className={styles.guideMethodKind}>{kindLabel}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )

  return (
    <UIModal open onClose={closeCredentialGuide} title={`${SOURCE_LABELS[source]} · ${t('guide.title')}`}>
      <div className={styles.modalBody}>
        {/* The scroll region: some methods have 4 long steps plus a callback URL
            and two value fields, which does not fit one window. The footer stays
            OUTSIDE it so the close button is always reachable. */}
        <div className={styles.guideScroll}>
          <p className={styles.help}>{t('guide.intro')}</p>

          {familyPicker}

          <p className={styles.noteBox}>{guide.why}</p>

          <span className={styles.fieldLabel}>{t('guide.steps')}</span>
          <ol className={styles.guideSteps}>
            {guide.steps.map((step, index) => {
              const url = step.url
              return (
                <li key={`${guide.method}-${index}`} className={styles.guideStep}>
                  <span className={styles.guideStepTitle}>{step.title}</span>
                  <span className={styles.guideStepDetail}>{step.detail}</span>
                  {url !== undefined ? (
                    <span className={styles.buttonRow}>
                      {/* The URL is shown so it can be read and re-typed when the
                          browser blocks the popup. */}
                      <span className={styles.mono}>{url}</span>
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        onClick={() => {
                          void copy(`url-${index}`, url)
                        }}
                      >
                        {copied === `url-${index}` ? t('guide.linkCopied') : t('guide.copyLink')}
                      </button>
                      {step.openInBrowser === true ? (
                        <button type="button" className={styles.button} onClick={() => openUrl(url)}>
                          {t('guide.open')}
                        </button>
                      ) : null}
                    </span>
                  ) : null}
              </li>
            )
          })}
        </ol>

        {/* Gitee: the callback must be registered before the flow starts, and the
            path comes from the contract, never from a literal in this file. */}
        {method === 'oauth-code' ? (
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t('guide.callback')}</span>
            <span className={styles.buttonRow}>
              <span className={styles.mono}>{callbackUrl()}</span>
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => {
                  void copy('callback', callbackUrl())
                }}
              >
                {copied === 'callback' ? t('guide.callbackCopied') : t('guide.copyCallback')}
              </button>
            </span>
            <span className={styles.help}>{t('guide.callbackDerived')}</span>
          </div>
        ) : null}

        {/* Value fields. OAuth methods need clientId (+secret), the manual methods
            need the token/cookie itself. */}
        {fieldSpecs.length > 0 ? (
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t('guide.pasteValues')}</span>
            {fieldSpecs.map(field => (
              <label key={field.slot} className={styles.fieldGroup}>
                <span className={styles.help}>{field.label}</span>
                <UIInput
                  // Secrets are masked: the guide must never be a way to read a
                  // credential back off the screen.
                  type={field.slot === 'clientId' ? 'text' : 'password'}
                  value={fields[field.slot] ?? ''}
                  placeholder={field.hint}
                  disabled={busy !== null}
                  aria-label={field.label}
                  onChange={event => setField(field.slot, event.target.value)}
                />
              </label>
            ))}
          </div>
        ) : null}

        {/* GitHub device flow / Gitee authorization code: start, then show what
            the user must do, then let them cancel or paste a code by hand. */}
        {secretKind !== 'cookie' && manualKind === undefined ? (
          <div className={styles.buttonRow}>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy !== null}
              onClick={() => {
                void startFlow()
              }}
            >
              {busy === 'start' ? t('guide.starting') : t('guide.start')}
            </button>
            {flow !== null && flow.flowId !== '' && (flow.status === 'pending' || flow.status === 'slow_down') ? (
              <button
                type="button"
                className={styles.buttonDanger}
                onClick={() => {
                  void cancelFlow()
                }}
              >
                {t('guide.cancel')}
              </button>
            ) : null}
          </div>
        ) : null}

        {statusText !== null ? (
          <div className={styles.statusRow}>
            <span className={styles.muted}>{t('guide.polling')}</span>
            <span className={flow?.status === 'done' ? styles.statusOk : flow?.status === 'error' ? styles.statusError : styles.statusWarn}>
              {statusText}
            </span>
            {flow !== null && flow.reason.length > 0 ? <span className={styles.muted}>{flow.reason}</span> : null}
          </div>
        ) : null}

        {/* Device flow: the user code, big and copyable. */}
        {flow !== null && flow.userCode.length > 0 ? (
          <div className={styles.guideCode}>
            <span className={styles.guideCodeText}>{flow.userCode}</span>
            <span className={styles.buttonRow}>
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => {
                  void copy('userCode', flow.userCode)
                }}
              >
                {copied === 'userCode' ? t('guide.linkCopied') : t('guide.copyLink')}
              </button>
              {flow.verificationUri.length > 0 ? (
                <button type="button" className={styles.button} onClick={() => openUrl(flow.verificationUri)}>
                  {t('guide.openVerification')}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}

        {/* Authorization-code flow whose device code is empty: the URL still needs
            opening, and the open must stay a plain click handler. */}
        {flow !== null && flow.userCode.length === 0 && flow.verificationUri.length > 0 ? (
          <div className={styles.buttonRow}>
            <span className={styles.mono}>{flow.verificationUri}</span>
            <button type="button" className={styles.button} onClick={() => openUrl(flow.verificationUri)}>
              {t('guide.openVerification')}
            </button>
          </div>
        ) : null}

        {/* Gitee manual fallback: the callback may never arrive. */}
        {method === 'oauth-code' ? (
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t('guide.manualCode')}</span>
            <UIInput
              type="password"
              value={code}
              placeholder={t('guide.manualCodePlaceholder')}
              disabled={busy !== null}
              aria-label={t('guide.manualCode')}
              onChange={event => setCode(event.target.value)}
            />
            <button
              type="button"
              className={styles.button}
              disabled={busy !== null}
              onClick={() => {
                void submitCode()
              }}
            >
              {busy === 'code' ? t('guide.submitting') : t('guide.submitCode')}
            </button>
          </div>
        ) : null}

        {/* Manual token / cookie: the same credential-service path the dialog uses. */}
        {manualKind !== undefined ? (
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy !== null}
            onClick={() => {
              void saveManualValue()
            }}
          >
            {busy === 'fields' ? t('guide.saving') : t('guide.saveValues')}
          </button>
        ) : null}

        {/* Experimental CDP capture: warning first, consent required, and the
            result carries names and a count only.

            THE GATE IS SHOWN HERE, NOT HIDDEN IN THE PANEL. The user's complaint
            was exact: "实验性：从本机浏览器读取 Cookie（CDP）要么放到向导里，要么向导里有
            明显提示要到主界面打开 CDP 才能使用". So the wizard carries the switch: when
            the host has it off, a warning says so and one button enables + saves it
            (auto-save would not be enough — the read is refused until the HOST has
            the flag, so this flushes the write immediately). When it is on, the
            line says where to turn it back off. */}
        {method === 'cookie-cdp' ? (
          <div className={styles.fieldGroup}>
            {configState.config.csdnCdpEnabled ? (
              <p className={styles.help}>{t('guide.cdpEnabled')}</p>
            ) : (
              <>
                <p className={styles.warn}>{t('guide.cdpDisabledNotice')}</p>
                <span className={styles.buttonRow}>
                  <button
                    type="button"
                    className={styles.buttonPrimary}
                    disabled={busy !== null}
                    onClick={() => {
                      void enableCdp()
                    }}
                  >
                    {busy === 'enable-cdp' ? t('guide.cdpEnabling') : t('guide.cdpEnable')}
                  </button>
                  <span className={styles.help}>{t('guide.cdpEnableHint')}</span>
                </span>
              </>
            )}
            {/* 启动调试浏览器：CDP 抓取这一步的内容，不另起一个编号步骤。
                The launcher probes first, so pressing this twice — or with a debugger
                already listening — never starts a second browser. */}
            <span className={styles.buttonRow}>
              <button
                type="button"
                className={styles.button}
                disabled={busy !== null || !configState.config.csdnCdpEnabled}
                onClick={() => {
                  void launchBrowser()
                }}
              >
                {busy === 'launch-browser' ? t('csdn.cdp.launching') : t('csdn.cdp.launch')}
              </button>
              <span className={styles.help}>
                {configState.config.csdnCdpEnabled ? t('csdn.cdp.launchHint') : t('guide.cdpLaunchNeedsEnable')}
              </span>
            </span>
            {launchNote !== null ? <p className={styles.help}>{launchNote}</p> : null}

            <p className={styles.guideWarning}>{t('guide.cdpWarning')}</p>
            <label className={styles.radioLabel}>
              <input
                type="checkbox"
                checked={consent}
                onChange={event => setConsent(event.target.checked)}
              />
              <span>{t('guide.cdpConsent')}</span>
            </label>
            <label className={styles.fieldGroup}>
              <span className={styles.help}>{t('guide.cdpPort')}</span>
              <UIInput
                type="number"
                value={port}
                disabled={busy !== null || !consent}
                aria-label={t('guide.cdpPort')}
                onChange={event => setPort(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy !== null || !consent || !configState.config.csdnCdpEnabled}
              onClick={() => {
                void readCookies()
              }}
            >
              {busy === 'cdp' ? t('guide.cdpReading') : t('guide.cdpRead')}
            </button>
            <span className={styles.help}>{t('guide.cdpResult')}</span>
            {capture === null ? (
              <span className={styles.help}>{t('guide.cdpNone')}</span>
            ) : (
              <div className={styles.kvList}>
                <div className={styles.kvRow}>
                  <span className={styles.kvKey}>{t('guide.cdpCount')}</span>
                  <span className={styles.kvValue}>{String(capture.count)}</span>
                </div>
                <div className={styles.kvRow}>
                  <span className={styles.kvKey}>{t('guide.cdpNames')}</span>
                  <span className={styles.kvValue}>{capture.names.join(', ')}</span>
                </div>
                <div className={styles.kvRow}>
                  <span className={styles.kvKey}>{t('guide.cdpHosts')}</span>
                  <span className={styles.kvValue}>{capture.hosts.join(', ')}</span>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <p className={styles.secretNote}>{t('login.security')}</p>
        <p className={styles.help}>{t('login.once')}</p>
        {error !== null ? <p className={styles.err}>{error}</p> : null}
        </div>
        {/* Outside the scroll region on purpose: the close button must never
            require scrolling to reach. */}
        <div className={styles.modalFooter}>
          <button type="button" className={styles.button} onClick={closeCredentialGuide}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </UIModal>
  )
}

/**
 * A value-free stand-in for "the manual write succeeded". It carries no
 * credential field at all, which is why it can be built here by hand.
 */
const EMPTY_FLOW: OAuthFlowView = {
  flowId: '',
  kind: '',
  userCode: '',
  verificationUri: '',
  expiresInMs: 0,
  intervalMs: 0,
  status: 'done',
  reason: '',
  credentialConfigured: true,
  ok: true,
}
