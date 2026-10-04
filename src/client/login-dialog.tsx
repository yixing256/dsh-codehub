/**
 * dsh-codehub — Gitee / CSDN / GitHub credential dialog, and the wizard entry.
 *
 * TWO WAYS IN, ONE PLACE THE VALUE CAN GO
 * ---------------------------------------
 * "浏览器登录" opens this dialog with that source's OAuth method: the dialog then
 * offers the step-by-step guide (`credential-guide.tsx`, which drives the OAuth
 * flow) plus the manual paste field as the fallback every flow needs. "令牌或
 * Cookie 导入" opens it with no method, i.e. the manual path only.
 *
 * VALUE HANDLING (the security contract of this file — unchanged, and still the
 * reason this dialog is small)
 * --------------------------------------------------
 * 1. The value exists in exactly two places: the controlled input's local state
 *    and the `POST /api/dsh-codehub/credentials` body. It is never put into the
 *    config store, never into localStorage/sessionStorage, never into a URL,
 *    never into a log line, and never into a React key or `title`.
 * 2. The field is cleared as soon as the request settles — success OR failure —
 *    so a rejected credential is not left sitting in the DOM.
 * 3. The only state rendered is the boolean `configured` flag that the route
 *    returns. There is no code path that can display a value it does not have.
 * 4. The dialog states plainly that the credential lives in the DSH credential
 *    service and never in the config file or git.
 *
 * The wizard is a SEPARATE overlay with its own store, so opening it (or closing
 * this dialog) cannot drag the other one down with it.
 *
 * A 503 means the host credential service itself is unavailable; that gets its
 * own message rather than being reported as a generic failure.
 */

import { Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputProps, ModalProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'

import { SOURCE_LOGIN_METHODS } from '../contract.js'
import type { LoginMethodId } from '../contract.js'
import {
  applyCredentials,
  clearCredential,
  describeError,
  isCredentialsServiceUnavailable,
  saveCredential,
  useConfigState,
} from './api.js'
import type { CredentialKind, CredentialSource } from './api.js'
import { closeCredentialGuide, CredentialGuide, openCredentialGuide } from './credential-guide.js'
import { useTranslate } from './locales.js'
import type { LocaleKey, Translate } from './locales.js'
import styles from './panel.module.css'

/** Typing bridge only — the runtime primitives are used as-is. */
const UIModal = Modal as unknown as ComponentType<ModalProps>
const UIInput = Input as unknown as ComponentType<InputProps>

/** GitHub and Gitee take a token; CSDN takes a cookie. */
const SOURCE_KIND: Record<CredentialSource, CredentialKind> = {
  github: 'token',
  gitee: 'token',
  csdn: 'cookie',
}

const SOURCE_TITLE: Record<CredentialSource, LocaleKey> = {
  github: 'login.githubTitle',
  gitee: 'login.giteeTitle',
  csdn: 'login.csdnTitle',
}

const SOURCE_LABEL: Record<CredentialSource, LocaleKey> = {
  github: 'login.githubTokenLabel',
  gitee: 'login.tokenLabel',
  csdn: 'login.cookieLabel',
}

const SOURCE_PLACEHOLDER: Record<CredentialSource, LocaleKey> = {
  github: 'login.tokenPlaceholder',
  gitee: 'login.tokenPlaceholder',
  csdn: 'login.cookiePlaceholder',
}

// ---------------------------------------------------------------------------
// Open/close store
// ---------------------------------------------------------------------------

export interface LoginDialogState {
  open: boolean
  source: CredentialSource | null
  /** Which method the caller came from, so the guide opens on the right tab. */
  method: LoginMethodId | null
}

let storeState: LoginDialogState = { open: false, source: null, method: null }
const listeners = new Set<() => void>()

function emit(next: LoginDialogState): void {
  storeState = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* a broken subscriber must not break the dialog */
    }
  }
}

export function subscribeLoginDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLoginDialogState(): LoginDialogState {
  return storeState
}

export function useLoginDialogState(): LoginDialogState {
  return useSyncExternalStore(subscribeLoginDialog, getLoginDialogState, getLoginDialogState)
}

/** Open the dialog, optionally recording which method the user meant. */
export function openLoginDialog(source: CredentialSource, method?: LoginMethodId): void {
  emit({ open: true, source, method: method ?? null })
}

export function closeLoginDialog(): void {
  emit({ open: false, source: storeState.source, method: storeState.method })
}

export interface LoginOverlayProps {
  t?: Translate
}

export function LoginOverlay(props: LoginOverlayProps): ReactNode {
  const t = useTranslate(props)
  const dialog = useLoginDialogState()
  const config = useConfigState().config

  /**
   * The ONLY copy of the pending credential. Cleared on submit, on close and on
   * source switch — this component never re-renders it anywhere else.
   */
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const source = dialog.source

  useEffect(() => {
    // A stale secret must never survive a close or a provider switch.
    if (!dialog.open) {
      setValue('')
      setError(null)
      setBusy(false)
      return
    }
    setValue('')
    setError(null)
  }, [dialog.open, source])

  if (!dialog.open || source === null) {
    // The wizard is an overlay of its own with its own store: a closed login
    // dialog must never take an open wizard down with it.
    return <CredentialGuide t={t} />
  }

  const configured = config.credentials[source]
  const kind = SOURCE_KIND[source]

  const submit = async (): Promise<void> => {
    if (busy) return
    const draftValue = value.trim()
    if (draftValue.length === 0) {
      setError(t('login.empty'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const credentials = await saveCredential(source, kind, draftValue)
      applyCredentials(credentials)
      closeLoginDialog()
    } catch (err) {
      setError(isCredentialsServiceUnavailable(err) ? t('login.serviceUnavailable') : describeError(err))
    } finally {
      // Exactly one pass: whatever happened, the value leaves the DOM here.
      setValue('')
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const credentials = await clearCredential(source)
      applyCredentials(credentials)
      closeLoginDialog()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <UIModal open onClose={closeLoginDialog} title={t(SOURCE_TITLE[source])}>
        <div className={styles.modalBody}>
          <div className={styles.statusRow}>
            <span className={styles.muted}>{t('login.status')}</span>
            <span className={configured ? styles.statusOk : styles.muted}>
              {configured ? t('account.configured') : t('account.notConfigured')}
            </span>
            <span className={styles.muted}>
              {t('login.type')}: {kind === 'token' ? t('login.typeToken') : t('login.typeCookie')}
            </span>
          </div>

          <label className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>{t(SOURCE_LABEL[source])}</span>
            <UIInput
              type="password"
              value={value}
              placeholder={t(SOURCE_PLACEHOLDER[source])}
              disabled={busy}
              onChange={event => setValue(event.target.value)}
              aria-label={t(SOURCE_LABEL[source])}
            />
          </label>

          <p className={styles.secretNote}>{t('login.security')}</p>
          <p className={styles.help}>{t('login.once')}</p>
          <p className={styles.help}>{t('account.neverShown')}</p>
          {error ? <p className={styles.err}>{error}</p> : null}

          <div className={styles.modalFooter}>
            {configured ? (
              <button
                type="button"
                className={styles.buttonDanger}
                disabled={busy}
                onClick={() => {
                  void signOut()
                }}
              >
                {busy ? t('login.clearing') : t('login.clear')}
              </button>
            ) : null}
            {/* The hand-held route out of this dialog: the manual paste field
                stays as the fallback for exactly the cases the wizard cannot
                cover (a moved port, a blocked browser, a provider that refuses). */}
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                const method = dialog.method ?? SOURCE_LOGIN_METHODS[source][0]
                closeLoginDialog()
                if (method !== undefined) openCredentialGuide(source, method)
              }}
            >
              {t('account.guide')}
            </button>
            <button type="button" className={styles.button} disabled={busy} onClick={closeLoginDialog}>
              {t('login.cancel')}
            </button>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy}
              onClick={() => {
                void submit()
              }}
            >
              {busy ? t('login.submitting') : t('login.submit')}
            </button>
          </div>
        </div>
      </UIModal>
      {/* Mounted alongside, not inside: the wizard survives this dialog closing. */}
      <CredentialGuide t={t} />
    </>
  )
}
