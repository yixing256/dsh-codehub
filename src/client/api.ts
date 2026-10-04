/**
 * dsh-codehub — browser-half API client and shared config store.
 *
 * WHY THIS EXISTS INSTEAD OF `settingsScope`
 * ------------------------------------------
 * The DSH settings RPC only serves an allow-listed set of namespaces, and this
 * plugin's namespace is not guaranteed to be on it — `settingsScope` may report
 * `status: 'unavailable'`. So the PRIMARY config path is the plugin's own
 * loopback-fenced route family (`src/contract.ts: API_PREFIX`, implemented by
 * the host half): `config` (GET/PATCH), `decisions` (GET), `credentials`
 * (POST/DELETE), `detect` (GET), `smoke` (POST), `deepread` (POST).
 *
 * `settingsScope` is an OPTIONAL ENHANCEMENT only (`attachSettingsScope`): when
 * it is attached and `status === 'ready'` we mirror writes onto it and offer an
 * explicit pull. When it is absent or unavailable **nothing errors and nothing
 * blocks** — the read path never touches it.
 *
 * SECURITY
 * --------
 * Credential VALUES travel through exactly one function here (`saveCredential`)
 * and are never stored, logged, echoed or returned. `CodeHubCredentials` is a
 * boolean-only view: the UI can render "configured / not configured" and
 * nothing else.
 *
 * The read path is deliberately tolerant (missing fields fall back to
 * defaults, `mirrors`/`rawMirrors` are accepted as aliases of
 * `webProxyBases`/`rawMirrorBases`, `null` and missing both mean "undecided").
 * The write path is strict: it sends only the canonical field names and uses
 * JSON-Merge-Patch semantics — `null` on `failover.enabled` / `mergeSources`
 * means "un-decide this", because `false` is already a *valid answer*
 * ("do not fail over") and must never be conflated with "not asked yet".
 */

import { useCallback, useSyncExternalStore } from 'react'

import {
  ACCESS_OPTIONS,
  API_PREFIX,
  CDP_DEFAULT_PORT,
  CONNECTIVITY_MAX_REASON_LINES,
  CONNECTIVITY_ROW_ORDER,
  DECISION_KEYS,
  DEFAULT_LIMITS,
  DEEP_READ_TARGETS,
  GITHUB_ACCESS,
  HARD_LIMITS,
  SOURCES,
  SOURCE_LABELS,
  TRANSPORTS,
} from '../contract.js'
import type {
  ConnectivityStatus,
  DeepReadTarget,
  DecisionKey,
  GithubAccessId,
  LoginMethodId,
  SourceId,
  TransportId,
  UnresolvedDecision,
} from '../contract.js'
import type { LocaleKey, Translate } from './locales.js'

/** The three entry placements. Literals match docs/DESIGN.md §1 and the host route. */
export type EntryPlacement = 'sidebar' | 'settings' | 'both'

/**
 * Placement / deep-read label keys live HERE, not in the form component.
 *
 * WHY: the settings form and the post-save summary both render these
 * vocabularies. Keeping one map per vocabulary means a renamed label cannot
 * reach one surface and miss the other — the same reason the contract holds the
 * copy that the host and the browser half share.
 */
export const PLACEMENT_LABEL: Record<EntryPlacement, LocaleKey> = {
  sidebar: 'entry.sidebar',
  settings: 'entry.settings',
  both: 'entry.both',
}

export const DEEP_READ_LABEL: Record<DeepReadTarget, LocaleKey> = {
  readme: 'deepread.readme',
  entry: 'deepread.entry',
  core: 'deepread.core',
  tests: 'deepread.tests',
}

export interface CodeHubLimits {
  timeoutMs: number
  retries: number
  maxDepth: number
  maxItems: number
  maxCodeChars: number
}

/**
 * Boolean-only credential view. There is intentionally no `value` field: the
 * browser half has no way to represent a secret, so it cannot render one.
 */
export interface CodeHubCredentials {
  github: boolean
  gitee: boolean
  csdn: boolean
}

export type CredentialSource = 'github' | 'gitee' | 'csdn'
export type CredentialKind = 'token' | 'cookie'

/** Normalised config the whole browser half renders from. */
export interface CodeHubConfigView {
  readonly onboarded: boolean
  readonly entryPlacement: EntryPlacement
  readonly sourcePriority: readonly SourceId[]
  readonly githubAccessPriority: readonly GithubAccessId[]
  /** Web / API proxy bases (`github.webProxyBases`). Never pre-filled. */
  readonly webProxyBases: readonly string[]
  /** raw file mirror bases (`github.rawMirrorBases`). Never pre-filled. */
  readonly rawMirrorBases: readonly string[]
  readonly localProxy: string
  /** `null` = undecided. `false` is a real answer. */
  readonly failoverEnabled: boolean | null
  /** `null` = undecided. `false` is a real answer. */
  readonly mergeSources: boolean | null
  readonly limits: CodeHubLimits
  readonly deepReadTargets: readonly DeepReadTarget[]
  /** CSDN: fetch the article page when a hit carries no code (`csdn.articleFetch`). */
  readonly csdnArticleFetch: boolean
  /**
   * CSDN: the experimental browser-debug-port cookie capture
   * (`csdn.cdpEnabled`, default false). Exposed so the panel can BE the switch —
   * a config key that no control writes is a feature nobody can turn on.
   */
  readonly csdnCdpEnabled: boolean
  readonly csdnCdpPort: number
  /**
   * `ui.autoSave` — whether editing schedules a write by itself.
   *
   * The first version hard-coded auto-save ON with no switch, which left the
   * manual 「保存到 host」 button permanently disabled (the draft was always already
   * written) and the save bar decorative. It is a user-owned preference now, and
   * the switch sits IN the save bar — where the user went looking for it.
   */
  readonly autoSave: boolean
  readonly credentials: CodeHubCredentials
  /** The payload exactly as received, for diagnostics. Never rendered raw when it could hold secrets (it cannot). */
  readonly raw: unknown
}

/** Partial write payload. Only changed leaves are sent; `null` un-decides a tri-state. */
export interface CodeHubConfigPatch {
  onboarded?: boolean
  entryPlacement?: EntryPlacement
  sourcePriority?: readonly SourceId[]
  github?: {
    accessPriority?: readonly GithubAccessId[]
    webProxyBases?: readonly string[]
    rawMirrorBases?: readonly string[]
    localProxy?: string
  }
  csdn?: {
    articleFetch?: boolean
    cdpEnabled?: boolean
    cdpPort?: number
  }
  ui?: { autoSave?: boolean }
  failover?: { enabled: boolean | null }
  mergeSources?: boolean | null
  limits?: Partial<CodeHubLimits>
  deepRead?: { targets?: readonly DeepReadTarget[] }
}

// ---------------------------------------------------------------------------
// Errors — every failure is a readable message, never a bare DOMException.
// ---------------------------------------------------------------------------

export type ApiErrorKind = 'timeout' | 'network' | 'http' | 'parse' | 'unavailable'

export class CodeHubApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null

  constructor(kind: ApiErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'CodeHubApiError'
    this.kind = kind
    this.status = status
  }
}

/** The host route family is not there at all (not built / not registered). */
export function isRouteUnavailable(err: unknown): boolean {
  return err instanceof CodeHubApiError && err.kind === 'unavailable'
}

/** 503 from `/credentials` — the host credential service is not usable. */
export function isCredentialsServiceUnavailable(err: unknown): boolean {
  return err instanceof CodeHubApiError && err.status === 503
}

export function describeError(err: unknown): string {
  if (err instanceof CodeHubApiError) return err.message
  const message = errorMessage(err)
  return message.length > 0 ? message : '未知错误'
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.length > 0) return err.message
  if (typeof err === 'string') return err
  return ''
}

function isAbortLike(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'TimeoutError' || err.name === 'AbortError'
  }
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000
const SMOKE_TIMEOUT_MS = 60_000
const DEEP_READ_TIMEOUT_MS = 60_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function readJson(res: Response): Promise<unknown> {
  let text = ''
  try {
    text = await res.text()
  } catch (err) {
    throw new CodeHubApiError('parse', `读取响应正文失败：${errorMessage(err)}`, res.status)
  }
  if (text.trim().length === 0) {
    throw new CodeHubApiError('parse', '响应为空（期望 JSON 正文）', res.status)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new CodeHubApiError('parse', `响应不是合法 JSON：${text.slice(0, 200)}`, res.status)
  }
}

/** Pull the human-readable message out of `{ ok:false, error }` style bodies. */
function pickMessage(body: unknown): string | null {
  const rec = asRecord(body)
  if (!rec) return null
  for (const key of ['error', 'message', 'detail']) {
    const value = rec[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(`${API_PREFIX}${path}`, init)
  } catch (err) {
    if (isAbortLike(err)) {
      throw new CodeHubApiError('timeout', `请求超时（${timeoutMs}ms，${method} ${path}）`)
    }
    throw new CodeHubApiError('network', `网络请求失败（${method} ${path}）：${errorMessage(err)}`)
  }

  if (!res.ok) {
    let parsed: unknown = null
    try {
      parsed = await readJson(res)
    } catch {
      parsed = null
    }
    const detail = pickMessage(parsed)
    const routeGone = res.status === 404 || res.status === 501 || res.status === 502 || res.status === 503
    const kind: ApiErrorKind = routeGone ? 'unavailable' : 'http'
    throw new CodeHubApiError(kind, detail ?? `HTTP ${res.status} ${method} ${path}`, res.status)
  }

  return readJson(res)
}

// ---------------------------------------------------------------------------
// Normalisation — tolerant reads, canonical writes.
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

function asEnumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed)
  return asStringArray(value).filter((item): item is T => allowedSet.has(item))
}

/** `null` and anything non-boolean mean "undecided" — never coerce to `false`. */
function asTriState(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * A boolean that HAS a schema default, so anything non-boolean means "use the
 * default" rather than "undecided". Used for the CSDN switches: they are
 * preferences with real defaults, not decisions that must be asked about.
 */
function asBooleanWith(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  const truncated = Math.trunc(numeric)
  return Math.min(max, Math.max(min, truncated))
}

/** Accepts `true`, `'configured'`, `{ configured: true }`. Values themselves are never read. */
function isConfigured(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 0 && value !== 'false' && value !== 'none'
  const rec = asRecord(value)
  if (rec) return rec['configured'] === true || typeof rec['source'] === 'string'
  return false
}

function normalizeLimits(source: Record<string, unknown> | null): CodeHubLimits {
  const rec = source ?? {}
  return {
    timeoutMs: clampInt(rec['timeoutMs'], DEFAULT_LIMITS.timeoutMs, 1000, HARD_LIMITS.timeoutMs),
    retries: clampInt(rec['retries'], DEFAULT_LIMITS.retries, 0, HARD_LIMITS.retries),
    maxDepth: clampInt(rec['maxDepth'], DEFAULT_LIMITS.maxDepth, 1, HARD_LIMITS.maxDepth),
    maxItems: clampInt(rec['maxItems'], DEFAULT_LIMITS.maxItems, 1, HARD_LIMITS.maxItems),
    maxCodeChars: clampInt(rec['maxCodeChars'], DEFAULT_LIMITS.maxCodeChars, 200, HARD_LIMITS.maxCodeChars),
  }
}

function normalizePlacement(value: unknown): EntryPlacement {
  return value === 'sidebar' || value === 'settings' || value === 'both' ? value : 'both'
}

export const EMPTY_CONFIG: CodeHubConfigView = {
  onboarded: false,
  entryPlacement: 'both',
  sourcePriority: [],
  githubAccessPriority: [],
  webProxyBases: [],
  rawMirrorBases: [],
  localProxy: '',
  failoverEnabled: null,
  mergeSources: null,
  limits: { ...DEFAULT_LIMITS },
  deepReadTargets: [],
  csdnArticleFetch: true,
  // Off by default, exactly like the schema: it opens a debug port on this
  // machine, and the panel is where the user consciously turns that on.
  csdnCdpEnabled: false,
  csdnCdpPort: CDP_DEFAULT_PORT,
  autoSave: true,
  credentials: { github: false, gitee: false, csdn: false },
  raw: null,
}

/**
 * Tolerant reader. Accepts the payload either wrapped in `{ config }` or flat,
 * and accepts `mirrors` / `rawMirrors` as aliases of the canonical
 * `webProxyBases` / `rawMirrorBases`.
 */
export function normalizeConfig(payload: unknown): CodeHubConfigView {
  const root = asRecord(payload) ?? {}
  const cfg = asRecord(root['config']) ?? root
  const github = asRecord(cfg['github']) ?? {}
  const failover = asRecord(cfg['failover']) ?? {}
  const limits = asRecord(cfg['limits'])
  const deepRead = asRecord(cfg['deepRead']) ?? {}
  const creds = asRecord(root['credentials']) ?? asRecord(cfg['credentials']) ?? {}
  const gitee = asRecord(cfg['gitee']) ?? {}
  const csdn = asRecord(cfg['csdn']) ?? {}

  return {
    onboarded: cfg['onboarded'] === true,
    entryPlacement: normalizePlacement(cfg['entryPlacement']),
    sourcePriority: asEnumArray(cfg['sourcePriority'], SOURCES),
    githubAccessPriority: asEnumArray(github['accessPriority'] ?? cfg['githubAccessPriority'], GITHUB_ACCESS),
    webProxyBases: asStringArray(github['webProxyBases'] ?? github['mirrors'] ?? cfg['webProxyBases']),
    rawMirrorBases: asStringArray(github['rawMirrorBases'] ?? github['rawMirrors'] ?? cfg['rawMirrorBases']),
    localProxy: typeof github['localProxy'] === 'string' ? github['localProxy'].trim() : '',
    failoverEnabled: asTriState(failover['enabled'] ?? cfg['failoverEnabled']),
    mergeSources: asTriState(cfg['mergeSources']),
    limits: normalizeLimits(limits),
    deepReadTargets: asEnumArray(deepRead['targets'] ?? cfg['deepReadTargets'], DEEP_READ_TARGETS),
    csdnArticleFetch: asBooleanWith(csdn['articleFetch'], true),
    csdnCdpEnabled: asBooleanWith(csdn['cdpEnabled'], false),
    csdnCdpPort: clampInt(csdn['cdpPort'], CDP_DEFAULT_PORT, 1, 65_535),
    autoSave: asBooleanWith(asRecord(cfg['ui'])?.['autoSave'], true),
    credentials: {
      github: isConfigured(creds['github'] ?? github['tokenConfigured']),
      gitee: isConfigured(creds['gitee'] ?? gitee['tokenConfigured']),
      csdn: isConfigured(creds['csdn'] ?? csdn['cookieConfigured']),
    },
    raw: payload,
  }
}

/** True when a payload really carries a config view (and is not just `{ ok:true }`). */
function looksLikeConfig(payload: unknown): boolean {
  const root = asRecord(payload)
  if (!root) return false
  if (asRecord(root['config'])) return true
  return ['onboarded', 'entryPlacement', 'sourcePriority', 'github', 'failover', 'mergeSources', 'limits', 'deepRead'].some(
    key => key in root,
  )
}

/** Mirror the host's deep-merge locally, so a `{ ok:true }`-only reply cannot wipe the view. */
export function applyPatchLocally(base: CodeHubConfigView, patch: CodeHubConfigPatch): CodeHubConfigView {
  return {
    ...base,
    onboarded: patch.onboarded ?? base.onboarded,
    entryPlacement: patch.entryPlacement ?? base.entryPlacement,
    sourcePriority: patch.sourcePriority ? [...patch.sourcePriority] : base.sourcePriority,
    githubAccessPriority: patch.github?.accessPriority ? [...patch.github.accessPriority] : base.githubAccessPriority,
    webProxyBases: patch.github?.webProxyBases ? [...patch.github.webProxyBases] : base.webProxyBases,
    rawMirrorBases: patch.github?.rawMirrorBases ? [...patch.github.rawMirrorBases] : base.rawMirrorBases,
    localProxy: patch.github?.localProxy ?? base.localProxy,
    failoverEnabled:
      patch.failover && 'enabled' in patch.failover ? (patch.failover.enabled ?? null) : base.failoverEnabled,
    mergeSources: patch.mergeSources !== undefined ? (patch.mergeSources ?? null) : base.mergeSources,
    limits: patch.limits ? { ...base.limits, ...patch.limits } : base.limits,
    deepReadTargets: patch.deepRead?.targets ? [...patch.deepRead.targets] : base.deepReadTargets,
    csdnArticleFetch: patch.csdn?.articleFetch ?? base.csdnArticleFetch,
    csdnCdpEnabled: patch.csdn?.cdpEnabled ?? base.csdnCdpEnabled,
    csdnCdpPort: patch.csdn?.cdpPort ?? base.csdnCdpPort,
    autoSave: patch.ui?.autoSave ?? base.autoSave,
  }
}

const LIMIT_KEYS = ['timeoutMs', 'retries', 'maxDepth', 'maxItems', 'maxCodeChars'] as const

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** Blank rows are an editing affordance only: they are never persisted. */
function cleanList(values: readonly string[]): string[] {
  return values.map(value => value.trim()).filter(value => value.length > 0)
}

/** Build the minimal canonical patch that turns `base` into `draft`. */
export function buildPatch(base: CodeHubConfigView, draft: CodeHubConfigView): CodeHubConfigPatch {
  const patch: CodeHubConfigPatch = {}
  if (base.onboarded !== draft.onboarded) patch.onboarded = draft.onboarded
  if (base.entryPlacement !== draft.entryPlacement) patch.entryPlacement = draft.entryPlacement
  if (!sameList(base.sourcePriority, draft.sourcePriority)) patch.sourcePriority = [...draft.sourcePriority]

  const github: NonNullable<CodeHubConfigPatch['github']> = {}
  if (!sameList(base.githubAccessPriority, draft.githubAccessPriority)) {
    github.accessPriority = [...draft.githubAccessPriority]
  }
  const webProxyBases = cleanList(draft.webProxyBases)
  if (!sameList(cleanList(base.webProxyBases), webProxyBases)) github.webProxyBases = webProxyBases
  const rawMirrorBases = cleanList(draft.rawMirrorBases)
  if (!sameList(cleanList(base.rawMirrorBases), rawMirrorBases)) github.rawMirrorBases = rawMirrorBases
  if (base.localProxy !== draft.localProxy) github.localProxy = draft.localProxy.trim()
  if (Object.keys(github).length > 0) patch.github = github

  const csdn: NonNullable<CodeHubConfigPatch['csdn']> = {}
  if (base.csdnArticleFetch !== draft.csdnArticleFetch) csdn.articleFetch = draft.csdnArticleFetch
  if (base.csdnCdpEnabled !== draft.csdnCdpEnabled) csdn.cdpEnabled = draft.csdnCdpEnabled
  if (base.csdnCdpPort !== draft.csdnCdpPort) csdn.cdpPort = draft.csdnCdpPort
  if (Object.keys(csdn).length > 0) patch.csdn = csdn

  // A preference, not a decision: sent only when it changes.
  if (base.autoSave !== draft.autoSave) patch.ui = { autoSave: draft.autoSave }

  if (base.failoverEnabled !== draft.failoverEnabled) patch.failover = { enabled: draft.failoverEnabled }
  if (base.mergeSources !== draft.mergeSources) patch.mergeSources = draft.mergeSources

  const limits: Partial<CodeHubLimits> = {}
  for (const key of LIMIT_KEYS) {
    if (base.limits[key] !== draft.limits[key]) limits[key] = draft.limits[key]
  }
  if (Object.keys(limits).length > 0) patch.limits = limits

  if (!sameList(base.deepReadTargets, draft.deepReadTargets)) {
    patch.deepRead = { targets: [...draft.deepReadTargets] }
  }
  return patch
}

/** Dirty check: a draft that differs only by blank mirror rows is NOT dirty. */
export function sameConfig(a: CodeHubConfigView, b: CodeHubConfigView): boolean {
  return Object.keys(buildPatch(a, b)).length === 0
}

// ---------------------------------------------------------------------------
// Post-save summary — "what did I just configure?" (DESIGN §8).
//
// WHY IT IS DERIVED FROM THE PATCH: the summary must mark the rows THIS save
// changed. `saveDraft` builds that patch with `buildPatch(before, after)`, and
// `saveConfig` stores the summary keys of the very patch the host accepted — so
// the marker describes a real write, not a guess made by diffing the view again
// after a host round-trip that may have normalised something.
//
// The VALUES always come from `state.config` (the host read-back), never from
// the draft: a summary of unsaved edits would lie about what is in effect.
// ---------------------------------------------------------------------------

/** Stable ids and render order of the summary rows. */
export const CONFIG_SUMMARY_KEYS = [
  'sourcePriority',
  'githubAccessPriority',
  'failoverEnabled',
  'mergeSources',
  'credentials',
  'mirrors',
  'localProxy',
  'csdnCdp',
  'limits',
  'deepReadTargets',
  'entryPlacement',
] as const

export type ConfigSummaryKey = (typeof CONFIG_SUMMARY_KEYS)[number]

/** One rendered summary line: a field name and its current (host) value. */
export interface ConfigSummaryRow {
  readonly key: ConfigSummaryKey
  readonly label: string
  readonly value: string
}

/** Which summary rows a given patch touches. Credentials have their own route. */
export function summaryKeysForPatch(patch: CodeHubConfigPatch): ConfigSummaryKey[] {
  const touched = new Set<ConfigSummaryKey>()
  if (patch.sourcePriority !== undefined) touched.add('sourcePriority')
  if (patch.github?.accessPriority !== undefined) touched.add('githubAccessPriority')
  const github = patch.github
  if (github !== undefined && (github.webProxyBases !== undefined || github.rawMirrorBases !== undefined)) {
    touched.add('mirrors')
  }
  if (github?.localProxy !== undefined) touched.add('localProxy')
  if (patch.csdn !== undefined) touched.add('csdnCdp')
  if (patch.failover !== undefined) touched.add('failoverEnabled')
  if (patch.mergeSources !== undefined) touched.add('mergeSources')
  if (patch.limits !== undefined) touched.add('limits')
  if (patch.deepRead !== undefined) touched.add('deepReadTargets')
  if (patch.entryPlacement !== undefined) touched.add('entryPlacement')
  return CONFIG_SUMMARY_KEYS.filter(key => touched.has(key))
}

function triStateText(value: boolean | null, t: Translate): string {
  if (value === null) return t('tristate.undecided')
  return value ? t('tristate.on') : t('tristate.off')
}

/** A label for an access id, taken from the contract's own option table. */
function accessLabel(id: GithubAccessId): string {
  return ACCESS_OPTIONS.find(option => option.id === id)?.label ?? id
}

/**
 * Build the "field name → current value" summary from a host read-back view.
 * `t` is injected so every row is rendered in the active language; a row whose
 * value the user never provided says 未提供 rather than pretending to be set.
 */
export function describeConfigSummary(view: CodeHubConfigView, t: Translate): ConfigSummaryRow[] {
  const notProvided = t('summary.notProvided')
  const priority =
    view.sourcePriority.length > 0
      ? view.sourcePriority.map(source => SOURCE_LABELS[source]).join(' → ')
      : notProvided
  const access =
    view.githubAccessPriority.length > 0
      ? view.githubAccessPriority.map(accessLabel).join('、')
      : notProvided
  const accounts = SOURCES.map(
    source => `${SOURCE_LABELS[source]} ${view.credentials[source] ? t('account.configured') : t('account.notConfigured')}`,
  ).join(' · ')
  const mirrors = `${t('summary.mirrorWeb')} ${view.webProxyBases.length} · ${t('summary.mirrorRaw')} ${view.rawMirrorBases.length}`
  const limits = [
    `${t('limits.timeoutMs')} ${view.limits.timeoutMs}`,
    `${t('limits.retries')} ${view.limits.retries}`,
    `${t('limits.maxItems')} ${view.limits.maxItems}`,
  ].join(' · ')
  const deepRead =
    view.deepReadTargets.length > 0
      ? view.deepReadTargets.map(target => t(DEEP_READ_LABEL[target])).join('、')
      : notProvided
  // The CSDN switches belong in the summary: enabling the experimental capture is
  // a configuration change the user should see reflected, not a hidden flag.
  const csdnCdp = [
    `${t('csdn.cdp.label')} ${view.csdnCdpEnabled ? t('tristate.on') : t('tristate.off')}`,
    `${t('csdn.cdp.port')} ${view.csdnCdpPort}`,
    `${t('csdn.articleFetch')} ${view.csdnArticleFetch ? t('tristate.on') : t('tristate.off')}`,
  ].join(' · ')

  const valueOf: Record<ConfigSummaryKey, string> = {
    sourcePriority: priority,
    githubAccessPriority: access,
    failoverEnabled: triStateText(view.failoverEnabled, t),
    mergeSources: triStateText(view.mergeSources, t),
    credentials: accounts,
    mirrors,
    localProxy: view.localProxy.length > 0 ? view.localProxy : notProvided,
    csdnCdp,
    limits,
    deepReadTargets: deepRead,
    entryPlacement: t(PLACEMENT_LABEL[view.entryPlacement]),
  }
  const labelOf: Record<ConfigSummaryKey, LocaleKey> = {
    sourcePriority: 'summary.row.sourcePriority',
    githubAccessPriority: 'summary.row.githubAccess',
    failoverEnabled: 'summary.row.failover',
    mergeSources: 'summary.row.merge',
    credentials: 'summary.row.accounts',
    mirrors: 'summary.row.mirrors',
    localProxy: 'summary.row.localProxy',
    csdnCdp: 'summary.row.csdnCdp',
    limits: 'summary.row.limits',
    deepReadTargets: 'summary.row.deepRead',
    entryPlacement: 'summary.row.entryPlacement',
  }

  return CONFIG_SUMMARY_KEYS.map(key => ({ key, label: t(labelOf[key]), value: valueOf[key] }))
}

// ---------------------------------------------------------------------------
// Connectivity view — the fixed three rows (DESIGN §7.6).
//
// WHY THIS IS A NORMALISER AND NOT A RENDERER OF THE PAYLOAD
// ---------------------------------------------------------
// The user's requirement is a GUI, not a JSON document: exactly three rows
// (GitHub / Gitee / CSDN, in `CONNECTIVITY_ROW_ORDER`), each with a status and,
// when it failed, the reason on the line below it. Two consequences follow, and
// both are deliberate:
//
//   1. The shape is CONSTANT. A payload with no `probes`, a missing row, an
//      unknown source or a partially filled record all still produce three rows
//      with `undetected` where nothing was measured. The panel therefore never
//      changes height or row order between runs.
//   2. Only whitelisted, human-meaningful fields are ever copied out of the
//      payload. Nothing here keeps the raw body, so no code path downstream can
//      render the JSON the DESIGN forbids rendering.
// ---------------------------------------------------------------------------

/** One of the three fixed connectivity rows. */
export interface ConnectivityRowView {
  readonly source: SourceId
  readonly status: ConnectivityStatus
  /** HTTP status the probe observed, when it got far enough to see one. */
  readonly statusCode: number | null
  readonly latencyMs: number | null
  readonly transport: TransportId | null
  /**
   * Bounded failure explanation, `''` unless the row failed. Bounded by
   * `CONNECTIVITY_MAX_REASON_LINES` because a provider's error text can be an
   * essay and the row must stay readable in a sidebar.
   */
  readonly reason: string
  /** Host-measured "does this source need a login?" answer; null = not measured. */
  readonly requiresLogin: boolean | null
  /** Host-measured evidence sentence; when non-empty it REPLACES the static line. */
  readonly evidence: string
}

/** Cut a reason down to `CONNECTIVITY_MAX_REASON_LINES` lines, keeping it readable. */
export function truncateReason(reason: string): string {
  const lines = reason
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length <= CONNECTIVITY_MAX_REASON_LINES) return lines.join(' ')
  return `${lines.slice(0, CONNECTIVITY_MAX_REASON_LINES).join(' ')} …`
}

function emptyConnectivityRow(source: SourceId): ConnectivityRowView {
  return {
    source,
    status: 'undetected',
    statusCode: null,
    latencyMs: null,
    transport: null,
    reason: '',
    requiresLogin: null,
    evidence: '',
  }
}

/** The constant three rows, in contract order, before any payload is applied. */
export function emptyConnectivityRows(): ConnectivityRowView[] {
  return CONNECTIVITY_ROW_ORDER.map(source => emptyConnectivityRow(source))
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function readSource(value: unknown): SourceId | null {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value) ? (value as SourceId) : null
}

function readTransport(value: unknown): TransportId | null {
  return typeof value === 'string' && (TRANSPORTS as readonly string[]).includes(value)
    ? (value as TransportId)
    : null
}

/**
 * Fold one host record into a row. Tolerant by design: `/smoke` sends `ok`,
 * `/probe` sends `reachable`, and either may carry `status`/`statusCode`,
 * `latencyMs`, `transport`, `failure`, `reason` and `evidence`.
 */
function mergeConnectivityRecord(row: ConnectivityRowView, record: Record<string, unknown>): ConnectivityRowView {
  const ok = readBoolean(record, ['ok', 'reachable'])
  const status: ConnectivityStatus = ok === true ? 'ok' : ok === false ? 'failed' : row.status
  const evidence = readString(record, ['evidence']) ?? row.evidence
  const failure = readString(record, ['failure'])
  const detail =
    readString(record, ['reason']) ??
    (status === 'failed' ? (evidence.length > 0 ? evidence : failure === null ? null : `failure=${failure}`) : null)
  const reason = status === 'failed' ? truncateReason(detail ?? row.reason) : ''
  return {
    source: row.source,
    status,
    statusCode: readNumber(record, ['statusCode', 'status']) ?? row.statusCode,
    latencyMs: readNumber(record, ['latencyMs', 'latency']) ?? row.latencyMs,
    transport: readTransport(record['transport']) ?? row.transport,
    reason,
    requiresLogin: readBoolean(record, ['requiresLogin', 'loginRequired']) ?? row.requiresLogin,
    evidence,
  }
}

/** Every per-source record a payload may carry, in the order they should apply. */
function collectHostRecords(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload)
  if (!root) return []
  const out: Record<string, unknown>[] = []
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const record = asRecord(item)
        if (record) out.push(summariseReport(record))
      }
      return
    }
    const record = asRecord(value)
    if (record) out.push(summariseReport(record))
  }
  push(root['probes'])
  push(root['reports'])
  push(root['report'])
  // A flat body naming exactly one source is a record too — that is the
  // `/probe` shape from DESIGN §7.5.
  if (readSource(root['source']) !== null) out.push(summariseReport(root))
  return out
}

/**
 * A `/probe` report carries one record per (source, operation). The panel has
 * one row per SOURCE, so the operations are folded into that row here: a row is
 * connected only when every operation was reachable, and the login answer is
 * true when any operation demanded one.
 *
 * WHY FOLD RATHER THAN RENDER THE OPERATIONS: the user asked for three rows with
 * a reason after a failure. Listing four sub-operations per source is the JSON
 * dump again, in a different costume.
 */
function summariseReport(record: Record<string, unknown>): Record<string, unknown> {
  const source = readSource(record['source'])
  const operations = Array.isArray(record['operations'])
    ? record['operations'].map(item => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null)
    : []
  if (source === null || operations.length === 0) return record

  const reachable = operations.map(operation => readBoolean(operation, ['reachable', 'ok']))
  const known = reachable.filter((value): value is boolean => value !== null)
  const statusCodes = operations
    .map(operation => readNumber(operation, ['statusCode']))
    .filter((value): value is number => value !== null)
  const loginAnswers = operations
    .map(operation => readBoolean(operation, ['requiresLogin', 'loginRequired']))
    .filter((value): value is boolean => value !== null)

  const failing = operations.filter(operation => readBoolean(operation, ['reachable', 'ok']) === false)
  const firstFailingEvidence = failing
    .map(operation => readString(operation, ['evidence', 'reason']))
    .find((value): value is string => value !== null && value !== undefined)
  const firstEvidence = operations
    .map(operation => readString(operation, ['evidence']))
    .find((value): value is string => value !== null && value !== undefined)

  const summary: Record<string, unknown> = { source }
  if (known.length > 0) summary['ok'] = known.every(value => value)
  if (statusCodes.length > 0) summary['statusCode'] = statusCodes[0]
  if (loginAnswers.length > 0) summary['requiresLogin'] = loginAnswers.includes(true)
  const evidence = firstFailingEvidence ?? firstEvidence
  if (evidence !== undefined && evidence.length > 0) summary['evidence'] = evidence
  return summary
}

/**
 * `capabilities` is the host's per-source login answer. Accept both shapes an
 * implementation may choose — keyed by source, or an array of records — because
 * this is presentation data, not a credential surface.
 */
function applyCapabilities(rows: Map<SourceId, ConnectivityRowView>, value: unknown): void {
  const apply = (source: SourceId, record: Record<string, unknown>): void => {
    const row = rows.get(source)
    if (!row) return
    rows.set(source, {
      ...row,
      requiresLogin: readBoolean(record, ['requiresLogin', 'loginRequired']) ?? row.requiresLogin,
      evidence: readString(record, ['evidence']) ?? row.evidence,
    })
  }
  const keyed = asRecord(value)
  if (keyed) {
    for (const [key, entry] of Object.entries(keyed)) {
      const source = readSource(key)
      const record = asRecord(entry)
      if (source !== null && record) apply(source, record)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry)
      if (!record) continue
      const source = readSource(record['source'])
      if (source !== null) apply(source, record)
    }
  }
}

function foldRecords(base: readonly ConnectivityRowView[], payload: unknown): ConnectivityRowView[] {
  const rows = new Map<SourceId, ConnectivityRowView>()
  for (const row of base) rows.set(row.source, row)
  // A row the base does not know about can never appear: the map starts from the
  // constant rows, so the panel cannot render a fourth source.
  for (const source of CONNECTIVITY_ROW_ORDER) {
    if (!rows.has(source)) rows.set(source, emptyConnectivityRow(source))
  }
  for (const record of collectHostRecords(payload)) {
    const source = readSource(record['source'] ?? record['id'])
    const row = source === null ? undefined : rows.get(source)
    if (row !== undefined) rows.set(row.source, mergeConnectivityRecord(row, record))
  }
  applyCapabilities(rows, asRecord(payload)?.['capabilities'])
  return CONNECTIVITY_ROW_ORDER.map(source => rows.get(source) ?? emptyConnectivityRow(source))
}

/**
 * Normalise a `POST /smoke` payload into the constant three rows. An empty or
 * unreadable payload yields three `undetected` rows — never a crash, never a
 * blank card.
 */
export function normalizeSmoke(payload: unknown): ConnectivityRowView[] {
  return foldRecords(emptyConnectivityRows(), payload)
}

/**
 * Same normalisation for `POST /probe`, but merged onto the rows already on
 * screen: a probe answers only what it measured, and the row a probe did not
 * cover must keep showing its previous result rather than flicker to未检测.
 */
export function normalizeProbe(payload: unknown, base: readonly ConnectivityRowView[]): ConnectivityRowView[] {
  return foldRecords(base.length > 0 ? base : emptyConnectivityRows(), payload)
}

// ---------------------------------------------------------------------------
// Route calls
// ---------------------------------------------------------------------------

export async function fetchConfig(): Promise<CodeHubConfigView> {
  return normalizeConfig(await request('GET', '/config'))
}

export async function patchConfig(patch: CodeHubConfigPatch): Promise<unknown> {
  return request('PATCH', '/config', patch)
}

function coerceDecision(value: unknown): UnresolvedDecision | null {
  const rec = asRecord(value)
  if (!rec) return null
  const key = rec['key']
  if (typeof key !== 'string' || !(DECISION_KEYS as readonly string[]).includes(key)) return null
  return {
    key: key as DecisionKey,
    detail: typeof rec['detail'] === 'string' ? rec['detail'] : '',
    ask: typeof rec['ask'] === 'string' ? rec['ask'] : '',
    control: typeof rec['control'] === 'string' ? rec['control'] : '',
  }
}

export async function fetchDecisions(): Promise<UnresolvedDecision[]> {
  const payload = await request('GET', '/decisions')
  const root = asRecord(payload) ?? {}
  const list = Array.isArray(root['unresolved'])
    ? root['unresolved']
    : Array.isArray(root['unresolved_decisions'])
      ? root['unresolved_decisions']
      : []
  return list.map(coerceDecision).filter((item): item is UnresolvedDecision => item !== null)
}

/** Primitive-only view of the host environment probe (nested notes are dropped). */
export async function fetchDetect(): Promise<Record<string, string | number | boolean | null>> {
  const payload = await request('GET', '/detect')
  const root = asRecord(payload) ?? {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(root)) {
    if (key === 'ok' || key === 'notes') continue
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

export async function runSmoke(): Promise<unknown> {
  return request('POST', '/smoke', {}, SMOKE_TIMEOUT_MS)
}

/** What the launcher reports. Only loopback facts; no credential can appear here. */
export interface LaunchBrowserView {
  readonly ok: boolean
  readonly launched: boolean
  readonly port: number
  readonly userDataDir: string
  readonly debuggerUrl: string
  readonly browserLabel: string
  readonly reason: string
}

/**
 * Start a debuggable Chromium when nothing is listening on the debug port.
 *
 * `consent: true` is required by the route: opening a browser whose debug port any
 * local process can reach is the risky act, so it is an explicit choice and never a
 * side effect of opening the wizard.
 */
export async function launchDebugBrowser(input: {
  readonly port: number
  readonly consent: boolean
  readonly url?: string
}): Promise<LaunchBrowserView> {
  const payload = await request(
    'POST',
    '/launch-browser',
    {
      port: input.port,
      consent: input.consent,
      ...(input.url === undefined ? {} : { url: input.url }),
    },
    DEEP_READ_TIMEOUT_MS,
  )
  const root = asRecord(payload) ?? {}
  const browser = asRecord(root['browser'])
  return {
    ok: root['ok'] !== false,
    launched: root['launched'] === true,
    port: typeof root['port'] === 'number' ? root['port'] : input.port,
    userDataDir: typeof root['userDataDir'] === 'string' ? root['userDataDir'] : '',
    debuggerUrl: typeof root['debuggerUrl'] === 'string' ? root['debuggerUrl'] : '',
    browserLabel: typeof browser?.['label'] === 'string' ? browser['label'] : '',
    reason: typeof root['reason'] === 'string' ? root['reason'] : '',
  }
}

/**
 * `POST /probe` — the same reachability question, but the host may attach the
 * credential already in the credential service (`useStoredCredential`). The
 * value still never travels through the browser half: the flag asks the HOST to
 * use what it already holds.
 */
export async function runProbe(options: { useStoredCredential?: boolean; source?: SourceId } = {}): Promise<unknown> {
  const body: Record<string, unknown> = { useStoredCredential: options.useStoredCredential === true }
  if (options.source !== undefined) body['source'] = options.source
  return request('POST', '/probe', body, SMOKE_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// OAuth flow calls (DESIGN §7.5).
//
// The response whitelist is `flowId/kind/userCode/verificationUri/expiresIn/
// interval/status/reason/credentialConfigured`. The normaliser below reads
// exactly those fields (plus the `*Ms` spellings the flow engine uses), so a
// reply can never smuggle a token into browser state.
//
// `verificationUri` is the one URL the browser must open, for BOTH flow kinds:
// for `kind:'device'` it is github.com/login/device, for `kind:'redirect'` the
// host puts the Gitee authorize URL there (the URL carries client_id /
// redirect_uri / state only — no credential).
// ---------------------------------------------------------------------------

export type OAuthMethod = Extract<LoginMethodId, 'oauth-device' | 'oauth-code'>

export type OAuthFlowStatus = 'pending' | 'slow_down' | 'done' | 'expired' | 'error' | 'unknown'

export interface OAuthFlowView {
  readonly flowId: string
  readonly kind: 'device' | 'redirect' | ''
  readonly userCode: string
  /** The URL to open in the browser, whatever the flow kind. */
  readonly verificationUri: string
  readonly expiresInMs: number
  readonly intervalMs: number
  readonly status: OAuthFlowStatus
  readonly reason: string
  readonly credentialConfigured: boolean
  /** False when the host refused to start the flow (reason explains why). */
  readonly ok: boolean
}

/** `status` and `state` are both accepted: the route and the engine name it differently. */
function normalizeOAuthStatus(value: unknown): OAuthFlowStatus {
  if (value === 'pending' || value === 'slow_down' || value === 'done' || value === 'expired' || value === 'error') {
    return value
  }
  if (value === 'configured') return 'done'
  if (value === 'success' || value === 'ok') return 'done'
  return 'unknown'
}

export function normalizeOAuth(payload: unknown): OAuthFlowView {
  const root = asRecord(payload) ?? {}
  const seconds = readNumber(root, ['expiresIn'])
  const secondsInterval = readNumber(root, ['interval'])
  return {
    flowId: readString(root, ['flowId']) ?? '',
    kind:
      root['kind'] === 'device' || root['kind'] === 'redirect'
        ? root['kind']
        : root['userCode'] !== undefined
          ? 'device'
          : '',
    userCode: readString(root, ['userCode']) ?? '',
    verificationUri: readString(root, ['verificationUri', 'authorizeUrl']) ?? '',
    expiresInMs: readNumber(root, ['expiresInMs']) ?? (seconds === null ? 0 : seconds * 1000),
    intervalMs: readNumber(root, ['intervalMs']) ?? (secondsInterval === null ? 0 : secondsInterval * 1000),
    status: normalizeOAuthStatus(root['status'] ?? root['state']),
    // ONLY `reason`. The host builds every /oauth reply field by field from the
    // §7.5 whitelist, so a provider's own `error` / `message` text never belongs
    // in the DOM; reading those keys here would make it one host-side change away
    // from rendering third-party text into the settings page.
    reason: readString(root, ['reason']) ?? '',
    credentialConfigured: readBoolean(root, ['credentialConfigured']) === true,
    ok: root['ok'] !== false,
  }
}

/**
 * Start a browser login. The `clientSecret` (Gitee) exists in this request body
 * exactly as the manual paste path exists in `saveCredential` — it is never
 * stored, echoed or logged, and the caller clears its field once the request
 * settles.
 */
export async function startOAuth(input: {
  source: CredentialSource
  method: OAuthMethod
  clientId: string
  clientSecret?: string
}): Promise<OAuthFlowView> {
  const body: Record<string, unknown> = {
    action: 'start',
    source: input.source,
    method: input.method,
    clientId: input.clientId,
  }
  if (input.clientSecret !== undefined && input.clientSecret !== '') body['clientSecret'] = input.clientSecret
  return normalizeOAuth(await request('POST', '/oauth', body, SMOKE_TIMEOUT_MS))
}

export async function statusOAuth(flowId: string): Promise<OAuthFlowView> {
  return normalizeOAuth(await request('GET', `/oauth?flowId=${encodeURIComponent(flowId)}`))
}

export async function cancelOAuth(flowId: string): Promise<OAuthFlowView> {
  return normalizeOAuth(await request('POST', '/oauth', { action: 'cancel', flowId }))
}

/**
 * Manual fallback for the Gitee authorization code: the callback may never come
 * back (a moved port, a blocking browser), so the user can paste the `code`.
 * That code is a single-use credential: it lives in the input field and in this
 * request body only, and the field is cleared as soon as the call settles.
 */
export async function completeOAuth(input: {
  source: CredentialSource
  code: string
  clientId?: string
  clientSecret?: string
}): Promise<OAuthFlowView> {
  const body: Record<string, unknown> = { action: 'complete', source: input.source, code: input.code }
  if (input.clientId !== undefined && input.clientId !== '') body['clientId'] = input.clientId
  if (input.clientSecret !== undefined && input.clientSecret !== '') body['clientSecret'] = input.clientSecret
  return normalizeOAuth(await request('POST', '/oauth', body, SMOKE_TIMEOUT_MS))
}

/**
 * Experimental CDP cookie capture. The response whitelist is `count/names/hosts`:
 * the cookie VALUE is written into the credential service by the host and is
 * never returned, so this view cannot represent one.
 */
export interface CookieCaptureView {
  readonly ok: boolean
  readonly count: number
  readonly names: readonly string[]
  readonly hosts: readonly string[]
  readonly reason: string
}

export function normalizeCookies(payload: unknown): CookieCaptureView {
  const root = asRecord(payload) ?? {}
  const names = Array.isArray(root['names']) ? root['names'].filter((n): n is string => typeof n === 'string') : []
  const hosts = Array.isArray(root['hosts']) ? root['hosts'].filter((h): h is string => typeof h === 'string') : []
  const count = readNumber(root, ['count'])
  return {
    ok: root['ok'] !== false,
    count: count ?? names.length,
    names,
    hosts,
    reason: readString(root, ['reason', 'error']) ?? '',
  }
}

/** `consent` is genuinely required by the route; the UI must have shown the warning first. */
export async function captureCookies(input: { consent: boolean; port: number }): Promise<CookieCaptureView> {
  return normalizeCookies(await request('POST', '/cookies', { consent: input.consent === true, port: input.port }, SMOKE_TIMEOUT_MS))
}

export async function requestDeepRead(url: string, targets: readonly DeepReadTarget[]): Promise<unknown> {
  return request('POST', '/deepread', { url, targets: [...targets] }, DEEP_READ_TIMEOUT_MS)
}

/**
 * The ONLY place a credential value is ever handled. It goes into the request
 * body, is never returned, never logged, never cached, never compared.
 */
export async function saveCredential(
  source: CredentialSource,
  kind: CredentialKind,
  value: string,
): Promise<CodeHubCredentials> {
  const payload = await request('POST', '/credentials', { source, kind, value })
  return normalizeCredentials(payload, source, true)
}

export async function clearCredential(source: CredentialSource): Promise<CodeHubCredentials> {
  const payload = await request('DELETE', '/credentials', { source })
  return normalizeCredentials(payload, source, false)
}

function normalizeCredentials(
  payload: unknown,
  source: CredentialSource,
  fallbackValue: boolean,
): CodeHubCredentials {
  const root = asRecord(payload) ?? {}
  const creds = asRecord(root['credentials'])
  const current = storeState.config.credentials
  if (!creds) {
    // The route answered without a credential view: fall back to the optimistic
    // outcome for this one source and keep the other two as they were.
    return {
      github: source === 'github' ? fallbackValue : current.github,
      gitee: source === 'gitee' ? fallbackValue : current.gitee,
      csdn: source === 'csdn' ? fallbackValue : current.csdn,
    }
  }
  const read = (key: CredentialSource): boolean => (creds[key] === undefined ? current[key] : isConfigured(creds[key]))
  return { github: read('github'), gitee: read('gitee'), csdn: read('csdn') }
}

// ---------------------------------------------------------------------------
// Shared store — one config, one draft, for every seat.
// ---------------------------------------------------------------------------

export interface ConfigStoreState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  config: CodeHubConfigView
  /** Local edits. `null` = no edits; the host view is authoritative. */
  draft: CodeHubConfigView | null
  /** True once a real host payload has been read. */
  loaded: boolean
  error: string | null
  saving: boolean
  lastSavedAt: number | null
  /** How the LAST accepted save was triggered — the bar says which. */
  lastSaveReason: SaveReason | null
  /** An auto-save is scheduled and not yet sent (the bar says "待自动保存"). */
  autoSavePending: boolean
  /** Warnings the host attached to the last accepted save (value-free strings). */
  lastWarnings: readonly string[]
  /** Summary rows the LAST accepted save touched. Empty = nothing to report. */
  lastChangedKeys: readonly ConfigSummaryKey[]
  unresolved: readonly UnresolvedDecision[]
  unresolvedError: string | null
}

/** `auto` = the debounced writer fired; `manual` = the user pressed save; `preference` = a switch that governs the writer. */
export type SaveReason = 'auto' | 'manual' | 'preference'

let storeState: ConfigStoreState = {
  status: 'idle',
  config: EMPTY_CONFIG,
  draft: null,
  loaded: false,
  error: null,
  saving: false,
  lastSavedAt: null,
  lastSaveReason: null,
  autoSavePending: false,
  lastWarnings: [],
  lastChangedKeys: [],
  unresolved: [],
  unresolvedError: null,
}

const listeners = new Set<() => void>()

function emit(next: Partial<ConfigStoreState>): void {
  storeState = { ...storeState, ...next }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* a broken subscriber must not break the config store */
    }
  }
}

export function subscribeConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getConfigState(): ConfigStoreState {
  return storeState
}

export function useConfigState(): ConfigStoreState {
  return useSyncExternalStore(subscribeConfig, getConfigState, getConfigState)
}

let inflightLoad: Promise<ConfigStoreState> | null = null

/** Load the host config once; `force` re-reads (the refresh button). */
export function loadConfig(force = false): Promise<ConfigStoreState> {
  if (inflightLoad) return inflightLoad
  if (!force && storeState.status === 'ready') return Promise.resolve(storeState)
  emit({ status: 'loading', error: null })
  const promise = (async (): Promise<ConfigStoreState> => {
    try {
      const config = await fetchConfig()
      emit({ status: 'ready', config, loaded: true, draft: null, error: null })
      void refreshDecisions()
    } catch (err) {
      emit({ status: 'error', error: describeError(err) })
    } finally {
      inflightLoad = null
    }
    return storeState
  })()
  inflightLoad = promise
  return promise
}

export async function refreshDecisions(): Promise<void> {
  try {
    const unresolved = await fetchDecisions()
    emit({ unresolved, unresolvedError: null })
  } catch (err) {
    emit({ unresolvedError: describeError(err) })
  }
}

/** Host warnings carried by a PATCH reply, as strings. Never rendered as a payload. */
function warningsOf(payload: unknown): string[] {
  const root = asRecord(payload)
  const warnings = root?.['warnings']
  if (!Array.isArray(warnings)) return []
  return warnings.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

/**
 * Does the reply actually carry `ui.autoSave`?
 *
 * A host that predates the preference (a plugin bundle that is loaded but not yet
 * reloaded) does not echo `ui` and drops the key from the patch. Adopting its
 * read-back would then RESET the user's explicit choice to the default — which is
 * exactly the reported bug: 「我关闭了自动保存，结果直接自动保存，又开启了」. When the
 * field is absent the local value is kept and the host is told about it.
 */
function payloadCarriesAutoSave(payload: unknown): boolean {
  const root = asRecord(payload)
  const cfg = asRecord(root?.['config']) ?? root
  const ui = asRecord(cfg?.['ui'])
  return typeof ui?.['autoSave'] === 'boolean'
}

/** Push the whole current config view through a patch and adopt the host's answer. */
export async function saveConfig(patch: CodeHubConfigPatch, reason: SaveReason = 'manual'): Promise<boolean> {
  const attemptedAutoSave = patch.ui?.autoSave
  emit({ saving: true, error: null, autoSavePending: false })
  try {
    const payload = await patchConfig(patch)
    const next = looksLikeConfig(payload) ? normalizeConfig(payload) : applyPatchLocally(storeState.config, patch)
    const warnings = warningsOf(payload)
    // A host that does not know the key cannot persist it: keep the user's choice
    // for this session and say so, instead of silently reverting it.
    const preferenceDropped = attemptedAutoSave !== undefined && !payloadCarriesAutoSave(payload)
    if (preferenceDropped) {
      warnings.push(t_hostDoesNotKnowAutoSave(attemptedAutoSave))
    }
    emit({
      saving: false,
      status: 'ready',
      loaded: true,
      config: {
        ...next,
        ...(preferenceDropped && attemptedAutoSave !== undefined ? { autoSave: attemptedAutoSave } : {}),
        raw: payload,
      },
      draft: null,
      error: null,
      lastSavedAt: Date.now(),
      lastSaveReason: reason,
      autoSavePending: false,
      lastWarnings: warnings,
      // The patch the host accepted is the only honest record of what changed;
      // deriving it again from the read-back would miss a normalised value.
      lastChangedKeys: summaryKeysForPatch(patch),
    })
    pushToSettingsScope(patch)
    void refreshDecisions()
    return true
  } catch (err) {
    // The draft is KEPT on failure (a failed auto-save must not eat edits), and a
    // pending flag stays set so the user sees that something still needs saving.
    emit({ saving: false, error: describeError(err), autoSavePending: isDirty() })
    return false
  }
}

/** The host-side warning text for a dropped preference. Kept value-free and short. */
function t_hostDoesNotKnowAutoSave(value: boolean): string {
  return value
    ? '当前 host 不认识自动保存设置（它可能还没重新加载插件）：已在本页保持「开」，重载后仍会回到默认。'
    : '当前 host 不认识自动保存设置（它可能还没重新加载插件）：已在本页保持「关」，重载后会回到默认。重启 DSH 后可持久化。'
}

/** Current draft (or the host view when there are no edits). */
export function getDraft(): CodeHubConfigView {
  return storeState.draft ?? storeState.config
}

export function isDirty(): boolean {
  return storeState.draft !== null && !sameConfig(storeState.config, storeState.draft)
}

// ---------------------------------------------------------------------------
// Auto-save (user request: "每次改个选项点保存太麻烦")
//
// WHY A DEBOUNCE AND NOT PER-KEYSTROKE WRITES: every edit lands in the draft, so
// writing on each one would POST once per character, re-register the seats on
// every placement click, and make the "本次修改" summary meaningless. A short
// quiet period collapses a burst into ONE save whose patch covers all of it.
//
// The manual save button stays: it is the immediate path, and it is what a save
// failure tells the user to press. `autoSaveNow()` is exported so tests (and the
// wizard's "enable CDP" button) can flush the pending write without a timer.
// ---------------------------------------------------------------------------

/** Quiet period after the last edit before the draft is written. */
export const AUTO_SAVE_DELAY_MS = 700

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

/** Cancel a scheduled auto-save. Exported for tests and for an explicit save. */
export function cancelAutoSave(): void {
  if (autoSaveTimer === null) return
  clearTimeout(autoSaveTimer)
  autoSaveTimer = null
  if (storeState.autoSavePending) emit({ autoSavePending: false })
}

/**
 * Write the draft now, collapsing any scheduled auto-save into this call.
 *
 * Returns the same value `saveDraft` does: `false` means the host refused and the
 * draft is still there to retry.
 */
export async function autoSaveNow(reason: SaveReason = 'auto'): Promise<boolean> {
  cancelAutoSave()
  if (storeState.saving) {
    // A write is already in flight; queue one more so the newest edit is not lost.
    scheduleAutoSave()
    return false
  }
  if (!isDirty()) return true
  return await saveDraft(reason)
}

function scheduleAutoSave(): void {
  if (!getDraft().autoSave) {
    // The user turned auto-save off: the edit stays in the draft and the save bar
    // says so. This is the half that was missing in the first version — auto-save
    // ON with no switch meant the manual button could never be pressed.
    cancelAutoSave()
    return
  }
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  emit({ autoSavePending: true })
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null
    void autoSaveNow()
  }, AUTO_SAVE_DELAY_MS)
}

/** Record an edit and schedule the write that will persist it. */
export function updateDraft(mutate: (next: CodeHubConfigView) => CodeHubConfigView): void {
  const before = getDraft().autoSave
  emit({ draft: mutate(getDraft()) })
  const after = getDraft().autoSave

  // Only schedule when this is a real edit: a no-op mutation (e.g. re-selecting the
  // same radio) must not produce a save.
  if (!isDirty()) {
    cancelAutoSave()
    return
  }
  if (after) {
    scheduleAutoSave()
    return
  }
  if (before) {
    /**
     * The user just turned auto-save OFF.
     *
     * The switch is itself an edit, so it has to reach the host — and this is the
     * LAST moment a write can happen automatically: once the handler returns,
     * `scheduleAutoSave()` refuses to run. So flush now, which also persists any
     * edits that were already scheduled (they were going to be written anyway,
     * and dropping them would lose work the user had already asked to save).
     *
     * The reason is `preference`, not `auto`, because the bar must not report
     * 「已自动保存」 a heartbeat after the user asked for no automatic saving —
     * that reads as "it ignored me". From here on edits stay in the draft.
     */
    void autoSaveNow('preference')
    return
  }
  // Already off, and this edit is not the switch: leave it in the draft.
  cancelAutoSave()
}

export function resetDraft(): void {
  cancelAutoSave()
  emit({ draft: null })
}

/** Save the draft. Returns false and keeps the draft when the host refuses. */
export async function saveDraft(reason: SaveReason = 'manual'): Promise<boolean> {
  cancelAutoSave()
  if (storeState.draft === null) return true
  const patch = buildPatch(storeState.config, storeState.draft)
  if (Object.keys(patch).length === 0) {
    // A draft that only differs by blank rows is not a change: drop it silently.
    emit({ draft: null })
    return true
  }
  return saveConfig(patch, reason)
}

/** Adopt the credential booleans the route just returned (values never travel here). */
export function applyCredentials(credentials: CodeHubCredentials): void {
  emit({ config: { ...storeState.config, credentials } })
}

/**
 * Flip ONE source's configured flag after an out-of-band write (an OAuth flow
 * finishing, a CDP capture). Only the boolean moves; there is no value to put
 * anywhere, which is the point.
 */
export function markCredentialConfigured(source: CredentialSource): void {
  emit({ config: { ...storeState.config, credentials: { ...storeState.config.credentials, [source]: true } } })
}

// ---------------------------------------------------------------------------
// settingsScope — optional enhancement, never a dependency.
// ---------------------------------------------------------------------------

interface SettingsScopeSnapshotLike {
  status?: string
  writable?: boolean
  revision?: number
  value?: unknown
}

interface SettingsScopeLike {
  getSnapshot(): SettingsScopeSnapshotLike
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): unknown
}

let settingsScope: SettingsScopeLike | null = null

/**
 * Attach a DSH settings scope. Only used for the optional mirror: a scope whose
 * shape we do not recognise is dropped silently (no error, no blocking).
 */
export function attachSettingsScope(scope: unknown): boolean {
  const rec = asRecord(scope)
  if (!rec || typeof rec['getSnapshot'] !== 'function' || typeof rec['subscribe'] !== 'function') {
    settingsScope = null
    return false
  }
  settingsScope = {
    getSnapshot: () => {
      try {
        return (rec['getSnapshot'] as () => SettingsScopeSnapshotLike | undefined).call(scope) ?? {}
      } catch {
        return {}
      }
    },
    subscribe: listener => {
      try {
        const dispose = (rec['subscribe'] as (l: () => void) => unknown).call(scope, listener)
        return typeof dispose === 'function' ? (dispose as () => void) : () => {}
      } catch {
        return () => {}
      }
    },
    set: (field, value) => {
      const setter = rec['set']
      if (typeof setter !== 'function') return undefined
      try {
        return (setter as (f: string, v: unknown) => unknown).call(scope, field, value)
      } catch {
        return undefined
      }
    },
  }
  return true
}

export function hasSettingsScope(): boolean {
  return settingsScope !== null
}

/** The coerced scope, handed to the settings-section seat through its inject face. */
export function getSettingsScope(): unknown {
  return settingsScope
}

export interface SettingsScopeStatus {
  present: boolean
  status: string
  writable: boolean
  revision: number
}

let cachedScopeStatus: SettingsScopeStatus = { present: false, status: 'absent', writable: false, revision: -1 }

function readScopeStatus(): SettingsScopeStatus {
  const scope = settingsScope
  if (!scope) {
    if (cachedScopeStatus.present) cachedScopeStatus = { present: false, status: 'absent', writable: false, revision: -1 }
    return cachedScopeStatus
  }
  const snapshot = scope.getSnapshot()
  const status = typeof snapshot.status === 'string' ? snapshot.status : 'unknown'
  const writable = snapshot.writable === true
  const revision = typeof snapshot.revision === 'number' ? snapshot.revision : -1
  if (
    cachedScopeStatus.present !== true ||
    cachedScopeStatus.status !== status ||
    cachedScopeStatus.writable !== writable ||
    cachedScopeStatus.revision !== revision
  ) {
    cachedScopeStatus = { present: true, status, writable, revision }
  }
  return cachedScopeStatus
}

/** Reactive scope status. `unavailable`/`absent` are normal states, not errors. */
export function useSettingsScopeStatus(): SettingsScopeStatus {
  const subscribe = useCallback((listener: () => void) => {
    const scope = settingsScope
    if (!scope) return () => {}
    return scope.subscribe(listener)
  }, [])
  const getSnapshot = useCallback(() => readScopeStatus(), [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Explicit pull: only a `ready` scope yields a patch; anything else yields null. */
export function pullSettingsScopePatch(): CodeHubConfigPatch | null {
  const scope = settingsScope
  if (!scope) return null
  const snapshot = scope.getSnapshot()
  if (snapshot.status !== 'ready') return null
  return recordToPatch(snapshot.value)
}

/** Best-effort mirror of a saved patch onto the scope. Failures are ignored by design. */
function pushToSettingsScope(patch: CodeHubConfigPatch): void {
  const scope = settingsScope
  if (!scope) return
  const snapshot = scope.getSnapshot()
  if (snapshot.status !== 'ready' || snapshot.writable === false) return
  for (const [key, value] of Object.entries(patch)) {
    try {
      const result = scope.set(key, value)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch(() => {})
      }
    } catch {
      /* optional enhancement only */
    }
  }
}

/** Field-presence-aware read: only leaves actually present in the payload become a patch. */
function recordToPatch(value: unknown): CodeHubConfigPatch {
  const root = asRecord(value)
  if (!root) return {}
  const cfg = asRecord(root['config']) ?? root
  const patch: CodeHubConfigPatch = {}
  const onboarded = cfg['onboarded']
  if (typeof onboarded === 'boolean') patch.onboarded = onboarded
  const placement = cfg['entryPlacement']
  if (placement === 'sidebar' || placement === 'settings' || placement === 'both') patch.entryPlacement = placement
  if (Array.isArray(cfg['sourcePriority'])) patch.sourcePriority = asEnumArray(cfg['sourcePriority'], SOURCES)

  const github = asRecord(cfg['github'])
  if (github) {
    const next: NonNullable<CodeHubConfigPatch['github']> = {}
    if (Array.isArray(github['accessPriority'])) {
      next.accessPriority = asEnumArray(github['accessPriority'], GITHUB_ACCESS)
    }
    const web = github['webProxyBases'] ?? github['mirrors']
    if (Array.isArray(web)) next.webProxyBases = asStringArray(web)
    const raw = github['rawMirrorBases'] ?? github['rawMirrors']
    if (Array.isArray(raw)) next.rawMirrorBases = asStringArray(raw)
    if (typeof github['localProxy'] === 'string') next.localProxy = github['localProxy'].trim()
    if (Object.keys(next).length > 0) patch.github = next
  }

  const mergeSources = cfg['mergeSources']
  if (typeof mergeSources === 'boolean') patch.mergeSources = mergeSources
  const failover = asRecord(cfg['failover'])
  if (failover && typeof failover['enabled'] === 'boolean') patch.failover = { enabled: failover['enabled'] }
  const limits = asRecord(cfg['limits'])
  if (limits) patch.limits = normalizeLimits(limits)
  const deepRead = asRecord(cfg['deepRead'])
  if (deepRead && Array.isArray(deepRead['targets'])) {
    patch.deepRead = { targets: asEnumArray(deepRead['targets'], DEEP_READ_TARGETS) }
  }
  // Field-presence-aware, like every other leaf here: only what the payload
  // actually carries becomes a patch, so a pull cannot reset a switch to default.
  const csdn = asRecord(cfg['csdn'])
  if (csdn) {
    const next: NonNullable<CodeHubConfigPatch['csdn']> = {}
    if (typeof csdn['articleFetch'] === 'boolean') next.articleFetch = csdn['articleFetch']
    if (typeof csdn['cdpEnabled'] === 'boolean') next.cdpEnabled = csdn['cdpEnabled']
    if (typeof csdn['cdpPort'] === 'number') next.cdpPort = clampInt(csdn['cdpPort'], CDP_DEFAULT_PORT, 1, 65_535)
    if (Object.keys(next).length > 0) patch.csdn = next
  }
  return patch
}
