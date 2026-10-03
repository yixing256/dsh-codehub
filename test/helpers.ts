/**
 * Shared test utilities.
 *
 * NOT a test file: vitest only collects files matching the `include` glob in
 * `vitest.config.ts` (`*.test.ts` under `test/`), so nothing here is executed on
 * its own.
 *
 * Two families of helper live here:
 *
 * 1. **Filesystem helpers.** Several requirements are about *documents and
 *    source text* rather than behaviour: 备注①② must survive in `README.md` /
 *    `docs/DESIGN.md`, the CSDN provenance note must be written into the header
 *    of `src/sources/csdn.ts`, the anti-copy statement must be ONE constant
 *    rather than two copies, and a live endpoint that 404s must not appear in
 *    `src/` as code. Those are asserted against real file text.
 *
 * 2. **Fake transports and result rows.** No test in this suite is allowed to
 *    touch the network. Every adapter call takes an injected `Transport`, so a
 *    recording fake is enough to drive a full search path offline.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CodeLearnResult } from '../src/contract.js'
import type { Transport, TransportRequest, TransportResponse } from '../src/sources/types.js'

/** Absolute repository root, derived from this file's URL (cwd-independent). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Read a repository file as UTF-8, e.g. `readRepoFile('README.md')`. */
export function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

/** Repository-relative, forward-slashed path — for readable failure messages. */
export function repoPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split('\\').join('/')
}

/** Every file under `src/`, recursively, in a stable order. */
export function listSourceFiles(): string[] {
  const root = join(REPO_ROOT, 'src')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

/** Every file under `src/` with its text, for whole-tree text invariants. */
export function readAllSourceFiles(): Array<{ readonly path: string; readonly text: string }> {
  return listSourceFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }))
}

/**
 * True when a line is ENTIRELY comment body — a JSDoc continuation (` * …`), a
 * `//` line, or a block-comment opener.
 *
 * Needed because some invariants are stated in prose that must quote the very
 * literal the invariant forbids. `src/contract.ts` documents the anti-copy
 * guarantee by writing `` `grep -n "is_verbatim_copy: true"` can never match ``
 * inside a JSDoc block, and `src/sources/gitee.ts` documents the 404 endpoint it
 * deliberately does NOT use. A raw substring scan would flag both; the real
 * invariant is about CODE, so comment lines are excluded — and each such
 * exclusion is itself asserted, so the exemption cannot silently hide a
 * regression.
 */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

export interface CodeHit {
  /** Repository-relative path. */
  readonly path: string
  /** 1-based line number. */
  readonly line: number
  readonly text: string
}

/** Lines whose CODE (not comments) contains `needle`. */
export function codeLinesContaining(needle: string): CodeHit[] {
  const hits: CodeHit[] = []
  for (const file of readAllSourceFiles()) {
    const lines = file.text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (!line.includes(needle)) continue
      if (isCommentLine(line)) continue
      hits.push({ path: repoPath(file.path), line: index + 1, text: line.trim() })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

const DEFAULT_ROW: CodeLearnResult = {
  source: 'github',
  url: 'https://github.com/example/repo',
  title: 'example/repo',
  language: 'TypeScript',
  code: 'const answer = compute()',
  codeTruncated: false,
  learned_summary: '先把输入归一化再建索引；返回值恒为数组，调用方不需要判空。',
  is_verbatim_copy: false,
  stars: 42,
  updatedAt: '2026-01-02T03:04:05.000Z',
  confidence: 'high',
  reason: '测试构造的行',
}

/**
 * A complete `CodeLearnResult`. `is_verbatim_copy` cannot be overridden with
 * `true`: `Partial<CodeLearnResult>` keeps it the literal `false`, so a test that
 * tried would not compile — which is itself part of the 备注③ guarantee.
 */
export function makeRow(overrides: Partial<CodeLearnResult> = {}): CodeLearnResult {
  return { ...DEFAULT_ROW, ...overrides } as CodeLearnResult
}

// ---------------------------------------------------------------------------
// Fake transports.
// ---------------------------------------------------------------------------

export interface RecordedTransport {
  readonly transport: Transport
  /** Every request the adapter issued, in order. No network is involved. */
  readonly calls: TransportRequest[]
}

/** A `Transport` that records its requests and answers from `answer`. */
export function recordingTransport(
  answer: (request: TransportRequest) => TransportResponse | Promise<TransportResponse>,
): RecordedTransport {
  const calls: TransportRequest[] = []
  const transport: Transport = async (request) => {
    calls.push(request)
    return await answer(request)
  }
  return { transport, calls }
}

/** A 200 answer carrying `body` (serialised when it is not already a string). */
export function jsonAnswer(body: unknown, extra: Partial<TransportResponse> = {}): TransportResponse {
  return {
    statusCode: 200,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    finalUrl: 'https://example.test/answer',
    ...extra,
  }
}
