/**
 * dsh-codehub — 深度阅读 → 思路笔记（备注③）.
 *
 * Output is a `LearnNote`, never a file copy:
 *
 *   approach    架构 / 整体做法，散文
 *   apiContract 公开 API 契约 —— 散文或**签名**（签名是契约，不是源码副本）
 *   tradeoffs   实现取舍与备选
 *   pitfalls    坑与失败模式
 *
 * Mechanism-level guarantees:
 *   • File bodies are never copied: only sentence-level prose (via
 *     `learn/summary.ts`, which strips code blocks before reading) and
 *     single-line signatures are kept.
 *   • Every bullet is collapsed to ONE line and bounded by
 *     `DEEPREAD_MAX_BULLET_CHARS`, so a pasted body cannot survive.
 *   • `sourceUrls[]` lists the files each set of claims came from, so every
 *     claim stays traceable.
 *
 * The module performs no network I/O of its own: the adapter injects a
 * `DeepReadFetch` (备注①), which makes the whole pipeline unit-testable with a
 * fake fetcher.
 */

import type { DeepReadTarget, FailureKind, LearnNote } from '../contract.js'
import type { AdapterAttempt, AdapterDeepOutcome } from '../sources/types.js'
import { classifyTransportError, isRetryableFailure, joinReason, optionalReason } from '../sources/types.js'
import { urlKey } from './dedupe.js'
import { extractSections } from './summary.js'

/** Caps that keep a note a note. Exported so tests can assert them. */
export const DEEPREAD_MAX_FILES = 6
export const DEEPREAD_MAX_CHARS_PER_FILE = 40_000
export const DEEPREAD_MAX_BULLETS = 8
export const DEEPREAD_MAX_BULLET_CHARS = 200
export const DEEPREAD_MAX_APPROACH_CHARS = 1_200
/**
 * Hard bound on requests one deep read may issue. Candidate lists are
 * conventional guesses, and without this bound a repo whose README is not at
 * the first path would cost dozens of 404s.
 */
export const DEEPREAD_MAX_ATTEMPTS = 12

/** One file that was successfully read. */
export interface DeepReadSource {
  readonly url: string
  readonly target: DeepReadTarget
  readonly text: string
  /** Human label, e.g. the repo-relative path. */
  readonly label?: string
}

/** A file the adapter wants read, already resolved to a fetchable URL. */
export interface DeepReadCandidate {
  readonly url: string
  readonly target: DeepReadTarget
  readonly label?: string
}

/** Injected reader. Never throws: a failure is a value (or is caught below). */
export type DeepReadFetchResult =
  | { readonly ok: true; readonly url: string; readonly text: string }
  | { readonly ok: false; readonly url: string; readonly failure: FailureKind; readonly reason: string }

export type DeepReadFetch = (url: string) => Promise<DeepReadFetchResult>

export interface DeepReadRun {
  /** Canonical repo / source URL the note is about. */
  readonly url: string
  readonly title: string
  /** Targets the user asked for. */
  readonly requested: readonly DeepReadTarget[]
  /** Candidate files in try order; the adapter builds these. */
  readonly candidates: readonly DeepReadCandidate[]
  readonly fetchFile: DeepReadFetch
  readonly maxFiles?: number
  readonly maxCharsPerFile?: number
}

function clampFiles(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEEPREAD_MAX_FILES
  return Math.min(Math.floor(value), DEEPREAD_MAX_FILES)
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut
}

/** Collapse to a single bounded line; returns null for empty input. */
export function sanitizeBullet(text: string, limit: number = DEEPREAD_MAX_BULLET_CHARS): string | null {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return null
  if (oneLine.length > limit) return `${oneLine.slice(0, limit - 1)}…`
  return oneLine
}

function pushBullet(target: string[], value: string | null, seen: Set<string>): void {
  if (value === null) return
  const key = value.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  target.push(value)
}

// ---------------------------------------------------------------------------
// Conventional file names per target. Adapters may add discovery on top.
// ---------------------------------------------------------------------------

const README_CANDIDATES = ['README.md', 'README.zh-CN.md', 'README.rst', 'readme.md', 'README.txt'] as const
const ENTRY_CANDIDATES = [
  'src/index.ts',
  'src/index.js',
  'index.ts',
  'index.js',
  'src/main.ts',
  'src/main.js',
  'main.ts',
  'main.js',
  'main.py',
  'app.py',
  '__init__.py',
  'index.php',
  'cmd/main.go',
  'src/main.rs',
  'src/lib.rs',
] as const
const MANIFEST_CANDIDATES = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'setup.py',
  'Gemfile',
  'requirements.txt',
] as const
const TEST_CANDIDATES = [
  'test/index.js',
  'tests/index.js',
  'test/index.ts',
  'tests/index.ts',
  'test.js',
  'tests/test.js',
  '__tests__/index.js',
  'tests/test_main.py',
  'test_main.py',
] as const

/** Conventional paths for one deep-read target. */
export function candidatePaths(target: DeepReadTarget): readonly string[] {
  switch (target) {
    case 'readme':
      return README_CANDIDATES
    case 'entry':
      return ENTRY_CANDIDATES
    case 'core':
      return MANIFEST_CANDIDATES
    case 'tests':
      return TEST_CANDIDATES
    default:
      return []
  }
}

/** Which target a repo-relative path belongs to. */
export function classifyDeepReadTarget(path: string): DeepReadTarget {
  const lower = path.toLowerCase()
  if (/(^|\/)readme(\.[a-z-]+)?$/.test(lower)) return 'readme'
  if (/(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/.test(lower) || /\.(test|spec)\.[a-z]+$/.test(lower)) return 'tests'
  if (
    /(^|\/)(index|main|app|entry|__init__|lib|mod)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|php|rb|java|kt|cs)$/.test(lower)
  ) {
    return 'entry'
  }
  return 'core'
}

// ---------------------------------------------------------------------------
// Signature extraction — contracts, never bodies.
// ---------------------------------------------------------------------------

const SIGNATURE_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+[A-Za-z_$][\w$]*/,
  /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\(/,
  /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|const|type)\s+[A-Za-z_]\w*/,
  /^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?[A-Za-z_][\w<>\[\],.? ]*\s+[A-Za-z_]\w*\s*\(/,
  /^\s*function\s+[A-Za-z_$][\w$]*\s*\(/,
  /^\s*(?:public\s+|private\s+|protected\s+)?function\s+[A-Za-z_]\w*\s*\(/,
  /^\s*(?:module\.exports|exports\.[A-Za-z_$][\w$]*)\s*=/,
  /^\s*type\s+[A-Za-z_]\w*\s*(?:<[^>]*>)?\s*=/,
]

/**
 * Pull public API *signatures* out of a file. Only the declaration line is
 * kept, cut at the first body brace, so no function body can leak.
 */
export function signaturesFrom(text: string, limit: number = DEEPREAD_MAX_BULLETS): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length >= limit) break
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) continue
    let matched = false
    for (const pattern of SIGNATURE_PATTERNS) {
      if (pattern.test(line)) {
        matched = true
        break
      }
    }
    if (!matched) continue
    if (line.includes('=>') && line.length > 120) continue
    const bodyStart = line.indexOf('{')
    const withoutBody = bodyStart >= 0 ? line.slice(0, bodyStart) : line
    const signature = sanitizeBullet(withoutBody.replace(/[;{]\s*$/, '').trim(), 160)
    if (signature === null) continue
    if (!/[(\w]/.test(signature)) continue
    const key = signature.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(signature)
  }
  return out
}

// ---------------------------------------------------------------------------
// Manifest facts — real declared fields only.
// ---------------------------------------------------------------------------

export interface ManifestFacts {
  readonly apiContract: readonly string[]
  readonly pitfalls: readonly string[]
  readonly approach: readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function keysOf(value: unknown): string[] {
  const record = asRecord(value)
  return record === null ? [] : Object.keys(record)
}

/** Facts read from a manifest that the note can safely assert. */
export function manifestFacts(text: string): ManifestFacts {
  const apiContract: string[] = []
  const pitfalls: string[] = []
  const approach: string[] = []

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = undefined
  }
  const pkg = asRecord(parsed)
  if (pkg !== null && (typeof pkg['name'] === 'string' || pkg['dependencies'] !== undefined || pkg['peerDependencies'] !== undefined)) {
    const peers = keysOf(pkg['peerDependencies'])
    if (peers.length > 0) apiContract.push(`peerDependencies 要求宿主提供：${peers.join('、')}`)
    const deps = keysOf(pkg['dependencies'])
    if (deps.length > 0) approach.push(`运行时依赖 ${deps.length} 个（${deps.slice(0, 8).join('、')}）`)
    const devDeps = keysOf(pkg['devDependencies'])
    if (devDeps.length > 0) approach.push(`开发依赖 ${devDeps.length} 个`)
    const engines = asRecord(pkg['engines'])
    if (engines !== null) {
      const declared = Object.entries(engines)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => `${key} ${value}`)
      if (declared.length > 0) pitfalls.push(`engines 声明 ${declared.join('、')}，运行环境不符时会失败`)
    }
    const type = pkg['type']
    if (type === 'module') pitfalls.push('package.json 声明 "type": "module"，CommonJS 的 require 不可直接使用')
    const main = pkg['main']
    if (typeof main === 'string' && main.length > 0) apiContract.push(`入口字段 main = ${main}`)
  }

  const python = /requires-python\s*=\s*["']([^"']+)["']/.exec(text)
  if (python !== null) pitfalls.push(`requires-python = ${python[1] ?? ''}，Python 版本不符会安装失败`)
  const edition = /^\s*edition\s*=\s*["']([^"']+)["']/m.exec(text)
  if (edition !== null) pitfalls.push(`Cargo edition = ${edition[1] ?? ''}，工具链过旧会编译失败`)
  const goVersion = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)
  if (goVersion !== null) pitfalls.push(`go.mod 要求 Go ${goVersion[1] ?? ''} 及以上`)

  return { apiContract, pitfalls, approach }
}

// ---------------------------------------------------------------------------
// Distillation.
// ---------------------------------------------------------------------------

/** Build the note. Pure: same sources in, same note out. */
export function distillNote(input: {
  readonly url: string
  readonly title: string
  readonly sources: readonly DeepReadSource[]
}): LearnNote {
  const approachParts: string[] = []
  const apiParts: string[] = []
  const tradeoffParts: string[] = []
  const pitfallParts: string[] = []
  const sourceUrls: string[] = []
  const seen = {
    approach: new Set<string>(),
    api: new Set<string>(),
    tradeoff: new Set<string>(),
    pitfall: new Set<string>(),
  }

  if (input.url.length > 0) sourceUrls.push(input.url)

  for (const source of input.sources) {
    if (!sourceUrls.includes(source.url)) sourceUrls.push(source.url)
    const sections = extractSections(source.text)
    for (const item of sections.approach) pushBullet(approachParts, sanitizeBullet(item), seen.approach)
    for (const item of sections.apiContract) pushBullet(apiParts, sanitizeBullet(item), seen.api)
    for (const item of sections.tradeoffs) pushBullet(tradeoffParts, sanitizeBullet(item), seen.tradeoff)
    for (const item of sections.pitfalls) pushBullet(pitfallParts, sanitizeBullet(item), seen.pitfall)

    if (source.target === 'entry' || source.target === 'core') {
      for (const signature of signaturesFrom(source.text)) {
        const label = source.label !== undefined && source.label.length > 0 ? `${source.label}: ` : ''
        pushBullet(apiParts, sanitizeBullet(`${label}${signature}`, DEEPREAD_MAX_BULLET_CHARS), seen.api)
      }
      const facts = manifestFacts(source.text)
      for (const item of facts.apiContract) pushBullet(apiParts, sanitizeBullet(item), seen.api)
      for (const item of facts.pitfalls) pushBullet(pitfallParts, sanitizeBullet(item), seen.pitfall)
      for (const item of facts.approach) pushBullet(approachParts, sanitizeBullet(item), seen.approach)
    }
  }

  const coverage = [...new Set(input.sources.map((source) => source.target))].join('/')
  const lead = `共读取 ${input.sources.length} 个文件（覆盖 ${coverage.length > 0 ? coverage : '无'}）。`
  const approach = sanitizeBullet(`${lead} ${approachParts.slice(0, 4).join(' ')}`, DEEPREAD_MAX_APPROACH_CHARS) ?? lead

  return {
    url: input.url,
    title: input.title,
    approach,
    apiContract: apiParts.slice(0, DEEPREAD_MAX_BULLETS),
    tradeoffs: tradeoffParts.slice(0, 5),
    pitfalls: pitfallParts.slice(0, 5),
    sourceUrls,
  }
}

// ---------------------------------------------------------------------------
// The orchestrator. Failures are values; a partial read still produces a note.
// ---------------------------------------------------------------------------

/**
 * Round-robin the candidate list by target so one long conventional list
 * (test files, say) cannot starve the other requested targets.
 */
export function interleaveCandidates(candidates: readonly DeepReadCandidate[]): DeepReadCandidate[] {
  const byTarget = new Map<DeepReadTarget, DeepReadCandidate[]>()
  for (const candidate of candidates) {
    const list = byTarget.get(candidate.target)
    if (list === undefined) byTarget.set(candidate.target, [candidate])
    else list.push(candidate)
  }
  const out: DeepReadCandidate[] = []
  let index = 0
  for (;;) {
    let added = false
    for (const list of byTarget.values()) {
      if (index < list.length) {
        out.push(list[index])
        added = true
      }
    }
    if (!added) break
    index += 1
  }
  return out
}

/** Read the candidate files, then distill. Never returns a file copy. */
export async function deepReadFiles(run: DeepReadRun): Promise<AdapterDeepOutcome> {
  const maxFiles = clampFiles(run.maxFiles)
  const maxChars = typeof run.maxCharsPerFile === 'number' && Number.isFinite(run.maxCharsPerFile) && run.maxCharsPerFile > 0
    ? Math.floor(run.maxCharsPerFile)
    : DEEPREAD_MAX_CHARS_PER_FILE

  const attempts: AdapterAttempt[] = []
  const sources: DeepReadSource[] = []
  const fetchedUrls: string[] = []
  const seenKeys = new Set<string>()
  const failureNotes: string[] = []
  const ordered = interleaveCandidates(run.candidates)
  let firstFailure: FailureKind | undefined
  let retryableHit = false
  let capped = false

  for (const candidate of ordered) {
    if (sources.length >= maxFiles) break
    if (attempts.length >= DEEPREAD_MAX_ATTEMPTS) {
      capped = true
      break
    }
    const key = urlKey(candidate.url)
    const identity = key.length > 0 ? key : candidate.url
    if (seenKeys.has(identity)) continue
    seenKeys.add(identity)

    let result: DeepReadFetchResult
    try {
      result = await run.fetchFile(candidate.url)
    } catch (error) {
      const classified = classifyTransportError(error)
      result = { ok: false, url: candidate.url, failure: classified.failure, reason: classified.reason }
    }

    if (!result.ok) {
      attempts.push({ url: result.url, statusCode: null, failure: result.failure, note: result.reason })
      if (firstFailure === undefined) firstFailure = result.failure
      if (isRetryableFailure(result.failure)) retryableHit = true
      failureNotes.push(`${result.url}：${result.reason}`)
      continue
    }

    sources.push({
      url: result.url,
      target: candidate.target,
      text: truncateText(result.text, maxChars),
      label: candidate.label,
    })
    fetchedUrls.push(result.url)
    attempts.push({ url: result.url, statusCode: 200 })
  }

  if (sources.length === 0) {
    const failure: FailureKind = firstFailure ?? 'empty'
    return {
      notes: [],
      reason: joinReason(
        `深度阅读未能读取到任何文件（尝试 ${attempts.length} 个候选${capped ? `，已达上限 ${DEEPREAD_MAX_ATTEMPTS}` : ''}）`,
        failureNotes.slice(0, 3).join('；'),
        retryableHit ? '部分候选是可重试失败，交给降级链处理' : undefined,
      ),
      failure,
      fetchedUrls: [],
      skipped: [...run.requested],
      attempts,
    }
  }

  const covered = new Set(sources.map((source) => source.target))
  const skipped = run.requested.filter((target) => !covered.has(target))
  const note = distillNote({ url: run.url, title: run.title, sources })

  return {
    notes: [note],
    reason: joinReason(
      `深度阅读完成：读取 ${sources.length} 个文件（${[...covered].join('/')}），产出 1 条思路笔记`,
      skipped.length > 0 ? `未覆盖目标：${skipped.join('、')}` : undefined,
      capped ? `候选请求已达上限 ${DEEPREAD_MAX_ATTEMPTS}，其余候选未尝试` : undefined,
      failureNotes.length > 0 ? `部分候选读取失败：${failureNotes.slice(0, 2).join('；')}` : undefined,
    ),
    fetchedUrls,
    skipped,
    attempts,
  }
}

/** Failure kinds that mean "try another rung", surfaced for adapters. */
export const DEEPREAD_RETRYABLE_HINT = 'network/timeout/rate-limited/auth-required 由降级链决定是否换源'

/** Convenience: a one-line human summary of a note, for reasons and logs. */
export function describeNote(note: LearnNote): string {
  return optionalReason(
    `${note.title}`,
    note.apiContract.length > 0 ? `API 契约 ${note.apiContract.length} 条` : undefined,
    note.pitfalls.length > 0 ? `坑 ${note.pitfalls.length} 条` : undefined,
    note.sourceUrls.length > 0 ? `来源 ${note.sourceUrls.length} 个` : undefined,
  ) ?? note.title
}
