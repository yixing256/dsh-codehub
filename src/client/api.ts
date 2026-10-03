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
  API_PREFIX,
  DECISION_KEYS,
  DEFAULT_LIMITS,
  DEEP_READ_TARGETS,
  GITHUB_ACCESS,
  HARD_LIMITS,
  SOURCES,
} from '../contract.js'
import type {
  DeepReadTarget,
  DecisionKey,
  GithubAccessId,
  SourceId,
  UnresolvedDecision,
} from '../contract.js'

/** The three entry placements. Literals match docs/DESIGN.md §1 and the host route. */
export type EntryPlacement = 'sidebar' | 'settings' | 'both'

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
  unresolved: readonly UnresolvedDecision[]
  unresolvedError: string | null
}

let storeState: ConfigStoreState = {
  status: 'idle',
  config: EMPTY_CONFIG,
  draft: null,
  loaded: false,
  error: null,
  saving: false,
  lastSavedAt: null,
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

/** Push the whole current config view through a patch and adopt the host's answer. */
export async function saveConfig(patch: CodeHubConfigPatch): Promise<boolean> {
  emit({ saving: true, error: null })
  try {
    const payload = await patchConfig(patch)
    const next = looksLikeConfig(payload) ? normalizeConfig(payload) : applyPatchLocally(storeState.config, patch)
    emit({
      saving: false,
      status: 'ready',
      loaded: true,
      config: { ...next, raw: payload },
      draft: null,
      error: null,
      lastSavedAt: Date.now(),
    })
    pushToSettingsScope(patch)
    void refreshDecisions()
    return true
  } catch (err) {
    emit({ saving: false, error: describeError(err) })
    return false
  }
}

/** Current draft (or the host view when there are no edits). */
export function getDraft(): CodeHubConfigView {
  return storeState.draft ?? storeState.config
}

export function isDirty(): boolean {
  return storeState.draft !== null && !sameConfig(storeState.config, storeState.draft)
}

export function updateDraft(mutate: (next: CodeHubConfigView) => CodeHubConfigView): void {
  emit({ draft: mutate(getDraft()) })
}

export function resetDraft(): void {
  emit({ draft: null })
}

/** Save the draft. Returns false and keeps the draft when the host refuses. */
export async function saveDraft(): Promise<boolean> {
  if (storeState.draft === null) return true
  const patch = buildPatch(storeState.config, storeState.draft)
  if (Object.keys(patch).length === 0) {
    emit({ draft: null })
    return true
  }
  return saveConfig(patch)
}

/** Adopt the credential booleans the route just returned (values never travel here). */
export function applyCredentials(credentials: CodeHubCredentials): void {
  emit({ config: { ...storeState.config, credentials } })
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
  return patch
}
