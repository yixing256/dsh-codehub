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
 *
 * ── 登录要求 / 反爬 / robots（单一来源见 contract.ts）─────────────────────────
 *
 * 实测 2026-10-04：搜索接口匿名可用（HTTP 200，30 条中仅 6 条带 `body`），正文代码
 * 需要打开文章页；文章页缺浏览器 UA / Referer 时会被 **HTTP 521** 反爬拦截，带上后
 * 200 且 19 个 `<pre>` 可抽。`so.csdn.net/robots.txt` 是 `Disallow: /`。这三件事分别
 * 由 `CSDN_LOGIN_REQUIREMENT` 与 `CSDN_ROBOTS_DISCLOSURE` 承载，本文件只引用、不重写：
 * 失败文案里带上它们，用户才知道「要不要登录、站点允不允许抓」。
 */

import {
  CSDN_API_NOTE,
  CSDN_API_PROBED_AT,
  CSDN_LOGIN_REQUIREMENT,
  CSDN_ROBOTS_DISCLOSURE,
  CSDN_SEARCH_BASE,
  HARD_LIMITS,
} from '../contract.js'
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
  optionalReason,
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

/**
 * 转载降权的两种说明（三态，见 `searchCsdn` 里 `reposted` 的推导）。
 *
 * `originalType` was measured to be ABSENT from the anonymous response
 * (2026-10-04), so "missing" must not be read as "转载": that would down-weight
 * every row and hide real hits. Only an explicit non-「原创」 value is a repost.
 */
const REPOST_NOTE = '原文 originalType 非「原创」，疑似转载，已降低置信度'
const ORIGINAL_TYPE_UNKNOWN_NOTE = '来源类型未知（响应里没有 originalType 字段），未按转载降权'

/** CSDN 正文里最多抽取的代码块数量（合并成一条有界摘录）。 */
export const CSDN_MAX_CODE_BLOCKS = 3

/**
 * Browser-like User-Agent. Measured 2026-10-04: an article page answers **HTTP
 * 521** to a request without a browser UA + Referer, and 200 with them. Kept as
 * an exported constant so a test can assert the headers CSDN actually receives.
 */
export const CSDN_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Referer that pairs with the UA above; the search page is the natural origin. */
export const CSDN_SEARCH_REFERER = 'https://so.csdn.net/'

/** Accept header for the JSON search endpoint. */
export const CSDN_SEARCH_ACCEPT = 'application/json, text/plain, */*'

/** Accept header for an article page (HTML). */
export const CSDN_ARTICLE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** CSDN 登录态是 Cookie，不是 Bearer token（见 `csdnRequestHeaders()`）。 */
export const CSDN_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: CSDN_SEARCH_ACCEPT,
  'user-agent': CSDN_BROWSER_USER_AGENT,
  referer: CSDN_SEARCH_REFERER,
}

/** HTTP status CSDN's anti-bot layer answers when UA / Referer are missing. */
export const CSDN_ARTICLE_BLOCKED_STATUS = 521

/** 521 时的中文说明：结论（被反爬拦截）+ 现状（已带 UA/Referer）+ 出路（登录 cookie）。 */
export const CSDN_ARTICLE_BLOCKED_NOTE =
  '文章页触发 CSDN 反爬（HTTP 521）：请求已带浏览器 UA / Referer 仍被拦截，站点会按频次与指纹判定自动抓取；带上登录 cookie 可提高成功率'

/** 文章页抽到代码时的来源说明（搜索结果本身不带正文）。 */
export const CSDN_ARTICLE_CODE_NOTE = '代码来自文章页（so.csdn.net 的搜索结果不带正文）'

/** 文章页 200 但没有可抽代码块时的说明。 */
export const CSDN_ARTICLE_NO_CODE_NOTE = '文章页已打开，但没有可抽取的代码块'

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
 * Headers for one CSDN search request. CSDN has no API token: its login state is
 * a cookie, so a credential handed to this adapter by `ctx.credentials` travels
 * in the `cookie` header. The header set is returned rather than sent, so the
 * test suite can assert it without a network.
 *
 * The browser UA + Referer are not decoration: measured 2026-10-04, CSDN's
 * anti-bot layer answers HTTP 521 to header-less requests, so every request this
 * adapter makes has to look like a browser navigation.
 */
export function csdnRequestHeaders(opts: AdapterSearchOptions): Record<string, string> {
  const headers: Record<string, string> = { ...CSDN_REQUEST_HEADERS }
  if (typeof opts.token === 'string' && opts.token.trim().length > 0) headers['cookie'] = opts.token.trim()
  return headers
}

/**
 * Headers for one article-page request: same UA/Referer/cookie story as the
 * search call, but asking for HTML rather than JSON.
 */
export function csdnArticleHeaders(opts: AdapterSearchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...csdnRequestHeaders(opts),
    accept: CSDN_ARTICLE_ACCEPT,
  }
  return headers
}

/**
 * How many article pages this call may open.
 *
 * `maxDepth` is the caller's budget for the same reason it bounds failover: one
 * number the user already controls. It is read RAW (never through
 * `clampMaxDepth()`, whose missing-value default is 1) because an absent budget
 * must mean **zero** extra requests — a search that silently opens pages the
 * caller did not ask for would be worse than a missing excerpt.
 */
export function articlePageBudget(maxDepth: number | undefined): number {
  if (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth) || maxDepth <= 0) return 0
  return Math.min(Math.floor(maxDepth), HARD_LIMITS.maxDepth)
}

/** Reason clauses for a suspicious endpoint shape (备注②) plus the login / robots story. */
function failureNotesFor(failure: FailureKind): string[] {
  // 备注②：接口形态可疑时（空 / 解析失败 / 抽不到代码）把来源标注一并交给用户。
  if (failure !== 'empty' && failure !== 'parse-failed' && failure !== 'not-code') return []
  const notes: string[] = [CSDN_API_NOTE]
  if (failure === 'empty' || failure === 'not-code') {
    // 「需不需要登录」与「站点允不允许抓」是用户明确问过的两件事：按引用回答，
    // 而不是让调用方去猜为什么没有正文。
    notes.push(CSDN_LOGIN_REQUIREMENT, CSDN_ROBOTS_DISCLOSURE)
  }
  return notes
}

/** One article-page completion attempt: the code (possibly empty) plus its reason. */
interface CsdnArticleFetch {
  readonly code: string
  readonly language: string
  /** 中文说明，写进那一行的 reason；失败时解释为什么没拿到代码。 */
  readonly reason: string
}

/**
 * Open ONE article page and extract its code blocks.
 *
 * Why this exists: the search payload carries a usable `body` for only a
 * minority of rows (measured 30 rows / 6 with `body`), so a legitimate hit
 * usually has no code until its own page is read. Each call issues exactly one
 * request — no crawling, no link following — which is the position
 * `CSDN_ROBOTS_DISCLOSURE` states to the user. Failure is a value: the caller
 * keeps the row (title + URL) and records the reason, and never fabricates code.
 */
async function fetchCsdnArticleCode(
  url: string,
  opts: AdapterSearchOptions,
  timeoutMs: number,
  attempts: AdapterAttempt[],
): Promise<CsdnArticleFetch> {
  let res: TransportResponse
  try {
    res = await opts.transport({ url, headers: csdnArticleHeaders(opts), timeoutMs, signal: opts.signal })
  } catch (error) {
    const classified = classifyTransportError(error)
    attempts.push({ url, statusCode: null, failure: classified.failure, note: classified.reason })
    return { code: '', language: '', reason: joinReason('文章页抓取失败，未取到代码', classified.reason) }
  }

  const notes = transportNotes(res)
  const httpFailure = failureFromResponse(res, 'CSDN 文章页')
  if (httpFailure !== null) {
    attempts.push({
      url,
      statusCode: res.statusCode,
      failure: httpFailure.failure,
      note: optionalReason(httpFailure.reason, notes.join('；')),
    })
    const blocked = res.statusCode === CSDN_ARTICLE_BLOCKED_STATUS
    return {
      code: '',
      language: '',
      reason: joinReason(
        blocked ? CSDN_ARTICLE_BLOCKED_NOTE : `文章页未取到代码（HTTP ${res.statusCode}）`,
        // 521 时「要不要登录」就是用户的下一个问题，按引用一并回答。
        blocked ? CSDN_LOGIN_REQUIREMENT : undefined,
        httpFailure.reason,
        notes.join('；'),
      ),
    }
  }

  const extracted = extractCodeBlocks(res.body)
  attempts.push({ url, statusCode: res.statusCode, note: optionalReason(notes.join('；')) })
  if (extracted.code.trim().length === 0) {
    return { code: '', language: '', reason: joinReason(CSDN_ARTICLE_NO_CODE_NOTE, notes.join('；')) }
  }
  return { code: extracted.code, language: extracted.language, reason: joinReason(CSDN_ARTICLE_CODE_NOTE, notes.join('；')) }
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
      reason: joinReason('CSDN 搜索失败', classified.reason, ...failureNotesFor(classified.failure)),
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
      reason: joinReason('CSDN 搜索失败', httpFailure.reason, ...failureNotesFor(httpFailure.failure)),
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
  // Article-page completion is opt-in twice over: `articleFetch === true` AND a
  // positive `maxDepth` budget. The budget is shared across rows, so one call
  // can never fan out into a crawl.
  const articleBudget = opts.articleFetch === true ? articlePageBudget(opts.maxDepth) : 0
  let articleFetches = 0

  for (const raw of rows) {
    const urlValue = asString(raw['url'])
    if (urlValue === undefined) {
      skippedNoUrl += 1
      continue
    }
    const body = asString(raw['body']) ?? ''
    const description = asString(raw['description']) ?? ''
    const extracted = extractCodeBlocks(body.length > 0 ? body : description)
    const title = stripHtml(asString(raw['title']) ?? '').replace(/\s+/g, ' ').trim() || '（无标题）'

    let code = extracted.code
    let language = extracted.language
    const rowNotes: string[] = []
    let articleAttempted = false

    if (code.trim().length === 0 && articleBudget > articleFetches) {
      articleFetches += 1
      articleAttempted = true
      const article = await fetchCsdnArticleCode(urlValue, opts, timeoutMs, attempts)
      code = article.code
      language = article.language
      // 站点策略随行披露：本次只抓了这一篇，不批量遍历。
      rowNotes.push(CSDN_ROBOTS_DISCLOSURE)
      rowNotes.push(article.reason)
    }

    if (code.trim().length === 0 && !articleAttempted) {
      // No code and no permission to look at the article page: keep the old
      // behaviour and do not emit a row that carries nothing but a title.
      skippedNoCode += 1
      continue
    }

    // Three-state `originalType`: the field is ABSENT from the anonymous
    // response (measured 2026-10-04), so only an explicit non-「原创」 value is a
    // repost. Missing -> unknown -> no penalty, with the state named in `reason`.
    const originalType = asString(raw['originalType'])
    const originalTypeUnknown = originalType === undefined
    const reposted = originalType !== undefined && originalType !== '原创'
    const bounded = boundExcerpt(code, maxCodeChars)

    if (reposted) rowNotes.push(REPOST_NOTE)
    else if (originalTypeUnknown) rowNotes.push(ORIGINAL_TYPE_UNKNOWN_NOTE)
    const author = asString(raw['author'])
    if (author !== undefined) rowNotes.push(`作者 ${author}`)
    const view = asNumber(raw['view'])
    if (view !== undefined) rowNotes.push(`阅读 ${view}`)
    for (const note of notes) rowNotes.push(note)

    const scored = score({
      source: 'csdn',
      authenticated: opts.authenticated === true,
      // `score()` only models two states; "unknown" is deliberately scored as
      // NOT reposted (the honest reading of a missing field) and the unknown
      // state travels in the notes instead.
      reposted,
      completeness: completenessFrom(raw, CSDN_RESULT_FIELDS),
      notes: rowNotes,
    })

    results.push({
      source: 'csdn',
      url: urlValue,
      title,
      language,
      code: bounded.code,
      codeTruncated: bounded.codeTruncated,
      learned_summary: summarize({ title, description, body, language }),
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
        ...failureNotesFor(failure),
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
      `CSDN 搜索命中 ${rows.length} 条，抽取到 ${results.length} 个条目（其中 ${kept.filter((row) => row.code.length > 0).length} 条带代码摘录）`,
      articleFetches > 0 ? `已按 articleFetch 打开 ${articleFetches} 篇文章页补齐正文` : undefined,
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
