/**
 * dsh-codehub — 去重（纯函数）.
 *
 * Two passes, in this order:
 *
 *   1. URL — `normalizeUrl()` drops the query string and the fragment, folds
 *      case, removes the default port, folds `www.` and the trailing slash.
 *   2. Content — `contentFingerprint()` hashes title + summary + excerpt after
 *      stripping whitespace, markup and punctuation, so the same snippet served
 *      by two sources (or by a mirror) collapses.
 *
 * The first row wins by default and the row's own `url` keeps its original
 * case, because `normalizeUrl()` is a key function, not a display transform.
 * No clock, no network, no globals: safe to unit test directly.
 */

import type { CodeLearnResult, LearnNote } from '../contract.js'

/** How to resolve a collision. */
export type DedupePreference = 'first' | 'confidence'

export interface DedupeOptions {
  /** Compare content fingerprints as well as URLs. Default true. */
  readonly byContent?: boolean
  /** Keep the first row (default) or the highest-confidence one. */
  readonly prefer?: DedupePreference
}

export interface DedupeStats {
  readonly input: number
  readonly kept: number
  readonly droppedByUrl: number
  readonly droppedByContent: number
}

export interface DedupeResult {
  readonly results: CodeLearnResult[]
  readonly stats: DedupeStats
}

const LEVEL_RANK: Readonly<Record<string, number>> = { high: 3, medium: 2, low: 1 }

function rankOf(confidence: string): number {
  return LEVEL_RANK[confidence] ?? 0
}

function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, '/')
}

/**
 * Canonical dedupe key for a URL: no query, no fragment, lower case, no default
 * port, no `www.` prefix, no trailing slash. Unparseable input degrades to a
 * conservative textual normalization instead of throwing.
 */
export function normalizeUrl(url: string): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (trimmed.length === 0) return ''

  const withoutFragment = trimmed.split('#')[0] ?? trimmed
  const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment

  let parsed: URL | null = null
  try {
    parsed = new URL(withoutQuery)
  } catch {
    parsed = null
  }

  if (parsed === null) {
    return withoutQuery.replace(/\/+$/, '').toLowerCase()
  }

  parsed.hash = ''
  parsed.search = ''
  const protocol = parsed.protocol.toLowerCase()
  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  const isDefaultPort = (protocol === 'http:' && parsed.port === '80') || (protocol === 'https:' && parsed.port === '443')
  const port = isDefaultPort ? '' : parsed.port
  const path = collapseSlashes(parsed.pathname).replace(/\/+$/, '')

  return `${protocol}//${host}${port.length > 0 ? `:${port}` : ''}${path}`.toLowerCase()
}

/** Alias of `normalizeUrl()`, named for how it is used. */
export function urlKey(url: string): string {
  return normalizeUrl(url)
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const UINT64_MASK = 0xffffffffffffffffn

/** 64-bit FNV-1a, rendered as 16 hex chars. Deterministic, non-cryptographic. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * FNV_PRIME) & UINT64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** Strip everything that is presentation rather than content. */
function normalizeContent(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[a-z0-9+#._-]*/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * Content fingerprint over the takeaway-bearing fields. The normalized length
 * is prefixed so two different payloads cannot collide on the hash alone
 * without also agreeing on size.
 */
export function contentFingerprint(input: {
  readonly title?: string
  readonly code?: string
  readonly learned_summary?: string
}): string {
  const title = typeof input.title === 'string' ? input.title : ''
  const code = typeof input.code === 'string' ? input.code : ''
  const summary = typeof input.learned_summary === 'string' ? input.learned_summary : ''
  const normalized = normalizeContent([title, summary, code].join('\n'))
  if (normalized.length === 0) return ''
  return `${normalized.length}-${fnv1a64(normalized)}`
}

/** True when two rows carry the same takeaway content. */
export function isSameContent(a: CodeLearnResult, b: CodeLearnResult): boolean {
  const left = contentFingerprint(a)
  const right = contentFingerprint(b)
  return left.length > 0 && left === right
}

/**
 * Collapse duplicate rows. Order is stable: the surviving row keeps the
 * position of the first occurrence of its key.
 */
export function dedupeResults(results: readonly CodeLearnResult[], opts: DedupeOptions = {}): DedupeResult {
  const byContent = opts.byContent !== false
  const prefer: DedupePreference = opts.prefer ?? 'first'

  const kept: CodeLearnResult[] = []
  const urlIndex = new Map<string, number>()
  const contentIndex = new Map<string, number>()
  let droppedByUrl = 0
  let droppedByContent = 0

  for (const row of results) {
    const key = urlKey(row.url)
    const fingerprint = byContent ? contentFingerprint(row) : ''

    const urlHit = key.length > 0 ? urlIndex.get(key) : undefined
    const contentHit = fingerprint.length > 0 ? contentIndex.get(fingerprint) : undefined
    const hit = urlHit ?? contentHit

    if (hit === undefined) {
      const index = kept.length
      kept.push(row)
      if (key.length > 0) urlIndex.set(key, index)
      if (fingerprint.length > 0) contentIndex.set(fingerprint, index)
      continue
    }

    if (urlHit !== undefined) droppedByUrl += 1
    else droppedByContent += 1

    if (prefer === 'confidence') {
      const existing: CodeLearnResult | undefined = kept[hit]
      if (existing !== undefined && rankOf(row.confidence) > rankOf(existing.confidence)) {
        kept[hit] = row
        if (urlHit === undefined && key.length > 0) urlIndex.set(key, hit)
        if (contentHit === undefined && fingerprint.length > 0) contentIndex.set(fingerprint, hit)
      }
    }
  }

  return {
    results: kept,
    stats: { input: results.length, kept: kept.length, droppedByUrl, droppedByContent },
  }
}

/**
 * Convenience wrapper for callers that only want the rows: same algorithm as
 * `dedupeResults()`, returns the array (stable order, first occurrence wins).
 */
export function dedupe(results: readonly CodeLearnResult[]): CodeLearnResult[] {
  return dedupeResults(results).results
}

/** Collapse notes by their source URL, keeping the first of each. */
export function dedupeNotes(notes: readonly LearnNote[]): LearnNote[] {
  const seen = new Set<string>()
  const kept: LearnNote[] = []
  for (const note of notes) {
    const key = urlKey(note.url)
    const fallback = `${note.title}\u0000${note.approach}`
    const identity = key.length > 0 ? key : fallback
    if (seen.has(identity)) continue
    seen.add(identity)
    kept.push(note)
  }
  return kept
}

/** Merge two result lists with dedupe; `primary` rows win on ties. */
export function mergeResults(
  primary: readonly CodeLearnResult[],
  secondary: readonly CodeLearnResult[],
  opts: DedupeOptions = {},
): DedupeResult {
  return dedupeResults([...primary, ...secondary], opts)
}
