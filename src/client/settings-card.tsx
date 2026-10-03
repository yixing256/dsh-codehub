/**
 * dsh-codehub — settings page seat (`settings.section`).
 *
 * Same fields, same data source, same components as the sidebar panel: it
 * renders `CodeHubControls` from panel.tsx, so the two surfaces cannot drift.
 * The only differences are the shell (a wider, form-shaped container) and the
 * optional `settingsScope` mirror, which is reported as a status line rather
 * than treated as a dependency.
 *
 * `settingsScope` may be `unavailable` — the namespace is not guaranteed to be
 * on the DSH settings allow-list. That state is displayed as information and
 * never blocks a read or a write; the plugin route remains the source of truth.
 */

import { useEffect } from 'react'
import type { ReactElement } from 'react'

import { attachSettingsScope, loadConfig, useConfigState } from './api.js'
import { useTranslate } from './locales.js'
import type { Translate } from './locales.js'
import { CodeHubControls, IconRefresh, LearningBanner } from './panel.js'
import styles from './panel.module.css'

export interface SettingsCardProps {
  t?: Translate
  slot?: string
  /** Supplied by the registration's inject face when a settings scope exists. */
  scope?: unknown
}

export function CodeHubSettingsCard(props: SettingsCardProps): ReactElement {
  const t = useTranslate(props)
  const state = useConfigState()

  useEffect(() => {
    void loadConfig()
  }, [])

  useEffect(() => {
    if (props.scope !== undefined && props.scope !== null) attachSettingsScope(props.scope)
  }, [props.scope])

  const status =
    state.status === 'idle' || state.status === 'loading'
      ? { text: t('panel.loading'), className: styles.muted }
      : state.status === 'ready'
        ? { text: t('panel.hostReady'), className: styles.statusOk }
        : { text: t('panel.hostUnavailable'), className: styles.statusError }

  return (
    <div className={styles.settingsRoot}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('settings.title')}</h2>
        <p className={styles.subtitle}>{t('settings.intro')}</p>
      </header>

      <div className={styles.statusRow}>
        <span className={status.className}>{status.text}</span>
        {state.status === 'error' && state.error ? <span className={styles.muted}>{state.error}</span> : null}
        <span className={styles.muted}>{t('settings.formHint')}</span>
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

      {/* 备注③ — the settings page's result-bearing surfaces carry the banner. */}
      <LearningBanner t={t} />

      <CodeHubControls t={t} variant="settings" />
    </div>
  )
}
