/**
 * dsh-codehub — CSDN 源适配器（补充源，权重最低）.
 *
 * ── 备注② 接口来源标注（contract.ts 的 `CSDN_API_NOTE` 全文，逐字保留）───────
 *
 *   CSDN v3 搜索接口为非官方内部接口（非公开 API），实测日期 2026-10-03，字段与可用性可能随时失效；失效时请改用 CSDN 网页搜索或关闭该源。
 *
 * 三要素必须同时存在：**非官方**（非公开 API）、**实测日期 2026-10-03**
 * （`CSDN_API_PROBED_AT`）、**可能失效**。上面这一行与 `CSDN_API_NOTE` 完全一致，
 * 由 `CSDN_API_NOTE` / `CSDN_API_PROBED_AT` 两个常量在运行时导出（见
 * `CSDN_PROVENANCE` 与 `CSDN_SEARCH_BASE` 旁的说明），端点一旦失效，失败原因里会带上
 * 该 note 全文，而不是抛一个裸异常。
 *
 * 备注①：本适配器不自己发网络请求 —— 一切经注入的 `Transport`，且 transport 附带的
 * 说明（例如「仅 Node 直连传输生效」）会被原样拼进 `reason`。
 *
 * 备注③：只产出「思路」摘要 + 有界代码摘录（`code` 仅学习参考），`is_verbatim_copy`
 * 恒为 false；`deepRead` 明确拒绝（CSDN 只作浅搜索补充）。
 */

import { CSDN_API_NOTE, CSDN_API_PROBED_AT, CSDN_SEARCH_BASE } from '../contract.js'
import type { CodeLearnResult, DeepReadTarget, FailureKind } from '../contract.js'
import type {
  AdapterAttempt,
  AdapterDeepOutcome,
  AdapterOutcome,
  AdapterSearchOptions,
  SourceAdapter,
  TransportResponse,
} from './types.js'
import {
  boundExcerpt,
  clampMaxCodeChars,
  clampMaxItems,
  clampTimeout,
  classifyTransportError,
  failureFromResponse,
  joinReason,
  transportNotes,
} from './types.js'
import { decodeEntities, looksLikeCode, stripHtml, summarize } from '../learn/summary.js'
import { completenessFrom, score } from '../learn/score.js'

/**
 * 备注② provenance, exported so the settings panel / README can render one
 * source of truth instead of re-typing the sentence.
 */
export const CSDN_PROVENANCE = {
  /** The endpoint base this adapter talks to. See `CSDN_API_NOTE`. */
  apiBase: CSDN_SEARCH_BASE,
  /** 非官方内部接口的完整来源标注（非官方 / 实测日期 / 可能失效）。 */
  note: CSDN_API_NOTE,
  /** 实测日期。 */
  probedAt: CSDN_API_PROBED_AT,
  /** This endpoint is not a public, documented API. */
  official: false,
} as const

/** Alias kept next to the adapter for callers that render the note. */
export const CSDN_SOURCE_NOTE = CSDN_API_NOTE

/** `result_vos[]` fields this adapter reads. Nothing outside this list is read. */
const CSDN_RESULT_FIELDS = ['title', 'body', 'description', 'url', 'originalType', 'create_time', 'author', 'view'] as const

/** 转载降权：`originalType !== '原创'` 时写入 reason 的说明。 */
const REPOST_NOTE = '原文 originalType 非「原创」，疑似转载，已降低置信度'

/** CSDN 正文里最多抽取的代码块数量（合并成一条有界摘录）。 */
export const CSDN_MAX_CODE_BLOCKS = 3

/** CSDN 登录态是 Cookie，不是 Bearer token（见 `csdnRequestHeaders()`）。 */
export const CSDN_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json, text/plain, */*',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * CSDN timestamps arrive as epoch numbers, epoch strings, or Beijing-time
 * strings. Unknown input yields null rather than a fabricated date.
 */
export function parseCsdnTime(value: unknown): string | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d{9,13}$/.test(value.trim()) ? Number(value.trim()) : undefined
  if (numeric !== undefined && Number.isFinite(numeric)) {
    const ms = numeric > 1e11 ? numeric : numeric * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  const normalized = trimmed.replace(/\//g, '-').replace(' ', 'T')
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
  const looksIso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(normalized)
  if (!looksIso) return null
  // CSDN renders Beijing time; a zone-less value is therefore read as UTC+8.
  const candidate = hasZone ? normalized : `${normalized.length <= 10 ? `${normalized}T00:00:00` : normalized}+08:00`
  const date = new Date(candidate)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Extract the row array from the (non-official) payload. `null` = shape changed. */
export function csdnRowsOf(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (isRecord(payload)) {
    const vos = payload['result_vos']
    if (Array.isArray(vos)) return vos.filter(isRecord)
  }
  return null
}

/** One extracted code block. */
export interface ExtractedCode {
  /** Blocks joined in document order, already bounded by the caller. */
  readonly code: string
  /** Language of the first block that declared one, else ''. */
  readonly language: string
  /** How many blocks were found. */
  readonly blocks: number
}

function normalizeLanguage(info: string): string {
  const first = info.trim().split(/\s+/)[0] ?? ''
  return first.replace(/^\{?\.?/, '').replace(/[:}]$/, '').toLowerCase()
}

/**
 * Strip the inline markup CSDN puts inside `<pre>`/`<code>`, then decode
 * entities. Only *named* tags are removed, so a comparison such as `a < b && c > d`
 * is not mistaken for a tag.
 */
function cleanCode(text: string): string {
  return decodeEntities(
    text.replace(
      /<\/?(?:code|span|em|strong|b|i|u|a|br|div|p|font|label|mark|sub|sup|ol|ul|li)\b[^>]*>/gi,
      '',
    ),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

function indentedBlocks(text: string): Array<{ code: string; language: string }> {
  const groups: string[][] = []
  let current: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    if (/^(?: {4}|\t)/.test(line)) {
      if (current === null) {
        current = []
        groups.push(current)
      }
      current.push(line.replace(/^(?: {4}|\t)/, ''))
      continue
    }
    if (line.trim().length === 0 && current !== null) {
      current.push('')
      continue
    }
    current = null
  }
  return groups
    .filter((group) => group.some((line) => looksLikeCode(line)))
    .map((group) => ({ code: group.join('\n').trim(), language: '' }))
}

/**
 * 抽代码块：先 ``` 围栏，再 `<pre>` 区块，最后才退到缩进块。
 * Returns at most `maxBlocks` non-empty blocks, joined in document order.
 */
export function extractCodeBlocks(text: string, maxBlocks: number = CSDN_MAX_CODE_BLOCKS): ExtractedCode {
  const empty: ExtractedCode = { code: '', language: '', blocks: 0 }
  if (typeof text !== 'string' || text.length === 0) return empty

  const found: Array<{ code: string; language: string }> = []

  const fence = /```([^\n`]*)\r?\n([\s\S]*?)```/g
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    const info = match[1] ?? ''
    found.push({ language: normalizeLanguage(info), code: cleanCode(match[2] ?? '') })
  }

  const pre = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi
  for (let match = pre.exec(text); match !== null; match = pre.exec(text)) {
    const attributes = match[1] ?? ''
    const inner = match[2] ?? ''
    const declared = /(?:language|lang|brush)[-:=]["']?([\w+#.-]+)/i.exec(attributes) ?? /class=["'][^"']*?(?:language|lang)-([\w+#.-]+)/i.exec(inner)
    found.push({ language: declared === null ? '' : declared[1]?.toLowerCase() ?? '', code: cleanCode(inner) })
  }

  if (found.every((block) => block.code.trim().length === 0)) {
    found.length = 0
    for (const block of indentedBlocks(text)) found.push(block)
  }

  const usable = found.filter((block) => block.code.trim().length > 0).slice(0, Math.max(1, Math.floor(maxBlocks)))
  if (usable.length === 0) return empty

  const language = usable.find((block) => block.language.length > 0)?.language ?? ''
  return { code: usable.map((block) => block.code.trim()).join('\n\n'), language, blocks: usable.length }
}

/**
 * Search URL. Only these parameters are sent — the extra filter parameters seen
 * in scraping write-ups are deliberately omitted, because this endpoint is not
 * documented and an unverified parameter is worse than a missing one (备注②).
 */
export function buildCsdnSearchUrl(
  query: string,
  options: { readonly apiBase?: string; readonly page?: number } = {},
): string {
  const raw = typeof options.apiBase === 'string' && options.apiBase.trim().length > 0 ? options.apiBase.trim() : CSDN_SEARCH_BASE
  const base = raw.replace(/\/+$/, '')
  const page = typeof options.page === 'number' && Number.isFinite(options.page) && options.page >= 1 ? Math.floor(options.page) : 1
  const params = new URLSearchParams({ q: query, t: 'all', p: String(page), s: '0', platform: 'pc' })
  return `${base}?${params.toString()}`
}

/**
 * Headers for one CSDN request. CSDN has no API token: its login state is a
 * cookie, so a credential handed to this adapter by `ctx.credentials` travels in
 * the `cookie` header. The header set is returned rather than sent, so the test
 * suite can assert it without a network.
 */
export function csdnRequestHeaders(opts: AdapterSearchOptions): Record<string, string> {
  const headers: Record<string, string> = { ...CSDN_REQUEST_HEADERS }
  if (typeof opts.token === 'string' && opts.token.trim().length > 0) headers['cookie'] = opts.token.trim()
  return headers
}

function failureNoteFor(failure: FailureKind): string | undefined {
  // 备注②：接口形态可疑时（空 / 解析失败 / 抽不到代码）把来源标注一并交给用户。
  if (failure === 'empty' || failure === 'parse-failed' || failure === 'not-code') return CSDN_API_NOTE
  return undefined
}

/** One CSDN search. Failures are values; nothing is thrown. */
export async function searchCsdn(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const attempts: AdapterAttempt[] = []
  const maxItems = clampMaxItems(opts.maxItems)
  const maxCodeChars = clampMaxCodeChars(opts.maxCodeChars)
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const trimmed = typeof query === 'string' ? query.trim() : ''

  if (trimmed.length === 0) {
    return { ok: false, results: [], reason: 'CSDN 搜索：查询为空，未发起任何请求。', failure: 'empty', attempts }
  }

  const url = buildCsdnSearchUrl(trimmed, opts.apiBase === undefined ? {} : { apiBase: opts.apiBase })
  let res: TransportResponse
  try {
    res = await opts.transport({ url, headers: csdnRequestHeaders(opts), timeoutMs, signal: opts.signal })
  } catch (error) {
    const classified = classifyTransportError(error)
    attempts.push({ url, statusCode: null, failure: classified.failure, note: classified.reason })
    return {
      ok: false,
      results: [],
      reason: joinReason('CSDN 搜索失败', classified.reason, failureNoteFor(classified.failure)),
      failure: classified.failure,
      attempts,
    }
  }

  const notes = transportNotes(res)
  const httpFailure = failureFromResponse(res, 'CSDN 搜索')
  attempts.push({
    url,
    statusCode: res.statusCode,
    failure: httpFailure?.failure,
    note: joinReason(httpFailure?.reason, notes.join('；')),
  })
  if (httpFailure !== null) {
    return {
      ok: false,
      results: [],
      reason: joinReason('CSDN 搜索失败', httpFailure.reason, failureNoteFor(httpFailure.failure)),
      failure: httpFailure.failure,
      attempts,
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(res.body) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      results: [],
      reason: joinReason('CSDN 搜索返回值不是合法 JSON', `解析错误：${detail}`, CSDN_API_NOTE, notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const rows = csdnRowsOf(payload)
  if (rows === null) {
    return {
      ok: false,
      results: [],
      reason: joinReason('CSDN 搜索返回的结构里没有 result_vos[]，接口字段可能已变更', CSDN_API_NOTE, notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const results: CodeLearnResult[] = []
  let skippedNoUrl = 0
  let skippedNoCode = 0

  for (const raw of rows) {
    const urlValue = asString(raw['url'])
    if (urlValue === undefined) {
      skippedNoUrl += 1
      continue
    }
    const body = asString(raw['body']) ?? ''
    const description = asString(raw['description']) ?? ''
    const extracted = extractCodeBlocks(body.length > 0 ? body : description)
    if (extracted.code.trim().length === 0) {
      skippedNoCode += 1
      continue
    }

    const title = stripHtml(asString(raw['title']) ?? '').replace(/\s+/g, ' ').trim() || '（无标题）'
    const originalType = asString(raw['originalType'])
    const reposted = originalType !== '原创'
    const bounded = boundExcerpt(extracted.code, maxCodeChars)

    const rowNotes: string[] = []
    if (reposted) rowNotes.push(REPOST_NOTE)
    const author = asString(raw['author'])
    if (author !== undefined) rowNotes.push(`作者 ${author}`)
    const view = asNumber(raw['view'])
    if (view !== undefined) rowNotes.push(`阅读 ${view}`)
    for (const note of notes) rowNotes.push(note)

    const scored = score({
      source: 'csdn',
      authenticated: opts.authenticated === true,
      reposted,
      completeness: completenessFrom(raw, CSDN_RESULT_FIELDS),
      notes: rowNotes,
    })

    results.push({
      source: 'csdn',
      url: urlValue,
      title,
      language: extracted.language,
      code: bounded.code,
      codeTruncated: bounded.codeTruncated,
      learned_summary: summarize({ title, description, body, language: extracted.language }),
      is_verbatim_copy: false,
      stars: null,
      updatedAt: parseCsdnTime(raw['create_time']),
      confidence: scored.confidence,
      reason: scored.reason,
    })
  }

  if (results.length === 0) {
    const failure: FailureKind = rows.length === 0 ? 'empty' : 'not-code'
    return {
      ok: false,
      results: [],
      reason: joinReason(
        rows.length === 0
          ? 'CSDN 搜索返回 0 条结果'
          : `CSDN 命中 ${rows.length} 条，但没有任何条目包含可抽取的代码块`,
        skippedNoUrl > 0 ? `跳过 ${skippedNoUrl} 条缺少 url 的条目` : undefined,
        skippedNoCode > 0 ? `跳过 ${skippedNoCode} 条无代码块的条目` : undefined,
        failureNoteFor(failure),
        notes.join('；'),
      ),
      failure,
      attempts,
    }
  }

  const truncated = results.length > maxItems
  const kept = results.slice(0, maxItems)
  return {
    ok: true,
    results: kept,
    reason: joinReason(
      `CSDN 搜索命中 ${rows.length} 条，抽取到 ${results.length} 个含代码块的条目`,
      truncated ? `已按 maxItems=${maxItems} 截断` : undefined,
      notes.join('；'),
    ),
    attempts,
    truncated,
  }
}

/** CSDN 不支持深度阅读：它只作浅搜索补充（不返回任何文件副本）。 */
export async function csdnDeepRead(
  _url: string,
  targets: readonly DeepReadTarget[],
  _opts: AdapterSearchOptions,
): Promise<AdapterDeepOutcome> {
  const asked = targets.length > 0 ? targets.join('、') : '（未指定目标）'
  return {
    notes: [],
    reason: joinReason(`CSDN 仅作浅搜索补充，不支持深度阅读（请求目标：${asked}）`, CSDN_API_NOTE),
    failure: 'not-code',
    fetchedUrls: [],
    skipped: [...targets],
  }
}

/** Adapter factory. `id` is fixed by the contract. */
export function createCsdnAdapter(): SourceAdapter {
  return {
    id: 'csdn',
    search: searchCsdn,
    deepRead: csdnDeepRead,
  }
}
