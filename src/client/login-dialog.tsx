/**
 * dsh-codehub — Gitee / CSDN / GitHub credential dialog.
 *
 * VALUE HANDLING (the security contract of this file)
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
 * A 503 means the host credential service itself is unavailable; that gets its
 * own message rather than being reported as a generic failure.
 */

import { Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputProps, ModalProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'

import {
  applyCredentials,
  clearCredential,
  describeError,
  isCredentialsServiceUnavailable,
  saveCredential,
  useConfigState,
} from './api.js'
import type { CredentialKind, CredentialSource } from './api.js'
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
}

let storeState: LoginDialogState = { open: false, source: null }
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

export function openLoginDialog(source: CredentialSource): void {
  emit({ open: true, source })
}

export function closeLoginDialog(): void {
  emit({ open: false, source: storeState.source })
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

  if (!dialog.open || source === null) return null

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
  )
}
