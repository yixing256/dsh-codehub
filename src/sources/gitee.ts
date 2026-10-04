/**
 * dsh-codehub — Gitee 源适配器.
 *
 * Endpoint — and ONLY this one, from `contract.ts`:
 *
 *   `GITEE_SEARCH_REPOSITORIES`  `/search/repositories?q=&per_page=`
 *
 * There is NO code-search endpoint to pair with it. Measured 2026-10-04:
 * `GET https://gitee.com/api/v5/search/code?q=vue` answers **HTTP 404 with an
 * HTML page-not-found body**, so it is not a v5 endpoint at all and this module
 * must never build a request for it (see `GITEE_CODE_SEARCH_SUPPORTED`). Gitee's
 * *web* code search (search.gitee.com) renders client-side and needs a
 * logged-in session, so it is not reachable as an API either.
 *
 * `https://gitee.com/api/v5/projects?q=...` was probed live and returned **404**
 * as well. It does not exist, is not referenced anywhere in this file, and must
 * never be implemented.
 *
 * Live facts this adapter is built around:
 *   • anonymous `/search/repositories?q=vue` → HTTP 200 with an empty array, so
 *     an anonymous empty answer is reported as `empty` — never padded with
 *     invented rows;
 *   • when the JSON surface yields nothing, the adapter may fall back to the
 *     search HTML page (`opts.htmlFallback === true`), and those rows are
 *     explicitly labelled as an HTML fallback with a lower confidence.
 *
 * Auth: a personal access token, delivered either as an `Authorization: Bearer`
 * header (default — keeps the credential out of URLs, which the project bans
 * from logs) or as the documented `access_token` query parameter when the caller
 * asks for it. The token comes from `ctx.credentials` via `opts.token`; this
 * module never reads an environment variable.
 *
 * 备注①：all egress goes through `opts.transport`, and transport notes are copied
 * into `reason` verbatim.
 *
 * 登录要求：every failure/no-result `reason` quotes `GITEE_LOGIN_REQUIREMENT`
 * rather than re-spelling the three measured facts, so the adapter, the panel,
 * the README and the tests can never disagree.
 */

import { GITEE_API_BASE, GITEE_LOGIN_REQUIREMENT, GITEE_SEARCH_REPOSITORIES } from '../contract.js'
import type { CodeLearnResult, DeepReadTarget } from '../contract.js'
import type {
  AdapterAttempt,
  AdapterDeepOutcome,
  AdapterOutcome,
  AdapterSearchOptions,
  SourceAdapter,
  TransportResponse,
} from './types.js'
import {
  clampMaxItems,
  clampTimeout,
  classifyTransportError,
  failureFromResponse,
  joinReason,
  optionalReason,
  tokenForAccess,
  transportNotes,
} from './types.js'
import { dedupe } from '../learn/dedupe.js'
import { stripHtml, summarize } from '../learn/summary.js'
import { completenessFrom, score } from '../learn/score.js'
import { candidatePaths, deepReadFiles, type DeepReadCandidate, type DeepReadFetch, type DeepReadFetchResult } from '../learn/deepread.js'

/** Repo fields this adapter reads. Gitee v5 uses the same names as GitHub here. */
const GITEE_REPO_FIELDS = [
  'full_name',
  'html_url',
  'description',
  'language',
  'stargazers_count',
  'updated_at',
  'default_branch',
] as const

/** Gitee API headers. */
export const GITEE_API_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'user-agent': 'dsh-codehub',
}

/** Same-origin raw file base for public content. */
export const GITEE_RAW_BASE = 'https://gitee.com'

/** HTML search page used only by the explicit fallback path. */
export const GITEE_WEB_SEARCH_BASE = 'https://search.gitee.com/'

/** Gitee 搜索网页兜底文案（含来源标注）。 */
export const GITEE_HTML_FALLBACK_NOTE = 'HTML 网页兜底（未走官方 API），字段不完整、置信度较低'

/** Files one Gitee deep read may pull in. */
export const GITEE_DEEPREAD_MAX_FILES = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeBase(base: string | undefined): string {
  const raw = typeof base === 'string' && base.trim().length > 0 ? base.trim() : GITEE_API_BASE
  return raw.replace(/\/+$/, '')
}

/**
 * Build a Gitee v5 URL. `endpointPath` is a path this module owns — a contract
 * constant (`GITEE_SEARCH_REPOSITORIES`) or a repository metadata path built
 * from parsed owner/repo. This is not a general URL builder, and no caller may
 * pass a code-search path: that endpoint does not exist.
 */
export function buildGiteeApiUrl(
  endpointPath: string,
  options: {
    readonly apiBase?: string
    readonly params?: Readonly<Record<string, string | number>>
    readonly token?: string
    readonly tokenInQuery?: boolean
  } = {},
): string {
  const path = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`
  const search = new URLSearchParams()
  if (options.params !== undefined) {
    for (const [key, value] of Object.entries(options.params)) search.set(key, String(value))
  }
  if (options.tokenInQuery === true && typeof options.token === 'string' && options.token.length > 0) {
    search.set('access_token', options.token)
  }
  const query = search.toString()
  const base = normalizeBase(options.apiBase)
  return query.length > 0 ? `${base}${path}?${query}` : `${base}${path}`
}

/** Headers for one Gitee API call. Bearer by default; never logs the token. */
export function giteeHeaders(opts: AdapterSearchOptions): Record<string, string> {
  const headers: Record<string, string> = { ...GITEE_API_HEADERS }
  const token = tokenForAccess(opts.access, opts.token)
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  return headers
}

/** Accept a bare array or an `items[]` container; `null` means the shape changed. */
export function giteeRowsOf(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (isRecord(payload)) {
    const items = payload['items']
    if (Array.isArray(items)) return items.filter(isRecord)
  }
  return null
}

/** Map one Gitee repository row. Returns null when it carries no openable URL. */
export function mapGiteeRepo(
  item: Record<string, unknown>,
  context: { readonly authenticated: boolean; readonly notes: readonly string[] },
): CodeLearnResult | null {
  const url = asString(item['html_url'])
  if (url === undefined) return null
  const fullName = asString(item['full_name']) ?? url
  const description = asString(item['description']) ?? ''
  const language = asString(item['language']) ?? ''
  const scored = score({
    source: 'gitee',
    authenticated: context.authenticated,
    reposted: false,
    completeness: completenessFrom(item, GITEE_REPO_FIELDS),
    notes: context.notes,
  })
  return {
    source: 'gitee',
    url,
    title: fullName,
    language,
    code: '',
    codeTruncated: false,
    learned_summary: summarize({ title: fullName, description, language }),
    is_verbatim_copy: false,
    stars: asNumber(item['stargazers_count']) ?? null,
    updatedAt: asString(item['updated_at']) ?? null,
    confidence: scored.confidence,
    reason: joinReason('Gitee 仓库搜索结果', scored.reason),
  }
}

/** `GET /search/repositories`. An anonymous empty answer stays `empty`. */
export async function searchGiteeRepositories(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const attempts: AdapterAttempt[] = []
  const maxItems = clampMaxItems(opts.maxItems)
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const token = tokenForAccess(opts.access, opts.token)
  const trimmed = typeof query === 'string' ? query.trim() : ''

  if (trimmed.length === 0) {
    return { ok: false, results: [], reason: 'Gitee 仓库搜索：查询为空，未发起任何请求。', failure: 'empty', attempts }
  }

  const url = buildGiteeApiUrl(GITEE_SEARCH_REPOSITORIES, {
    ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }),
    params: { q: trimmed, per_page: maxItems },
  })

  let res: TransportResponse
  try {
    res = await opts.transport({
      url,
      headers: giteeHeaders(opts),
      ...(token === undefined ? {} : { token }),
      timeoutMs,
      signal: opts.signal,
    })
  } catch (error) {
    const classified = classifyTransportError(error)
    attempts.push({ url, statusCode: null, failure: classified.failure, note: classified.reason })
    return { ok: false, results: [], reason: classified.reason, failure: classified.failure, attempts }
  }

  const notes = transportNotes(res)
  const httpFailure = failureFromResponse(res, 'Gitee 仓库搜索')
  attempts.push({
    url,
    statusCode: res.statusCode,
    failure: httpFailure?.failure,
    note: optionalReason(httpFailure?.reason, notes.join('；')),
  })
  if (httpFailure !== null) {
    return { ok: false, results: [], reason: httpFailure.reason, failure: httpFailure.failure, attempts }
  }

  let payload: unknown
  try {
    payload = JSON.parse(res.body) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      results: [],
      reason: joinReason('Gitee 仓库搜索返回值不是合法 JSON', `解析错误：${detail}`, notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const items = giteeRowsOf(payload)
  if (items === null) {
    return {
      ok: false,
      results: [],
      reason: joinReason('Gitee 仓库搜索返回结构既不是数组也没有 items[]', notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const rows: CodeLearnResult[] = []
  let skipped = 0
  for (const item of items) {
    const row = mapGiteeRepo(item, { authenticated: token !== undefined || opts.authenticated === true, notes })
    if (row === null) {
      skipped += 1
      continue
    }
    rows.push(row)
  }

  if (rows.length === 0) {
    return {
      ok: false,
      results: [],
      reason: joinReason(
        items.length === 0
          ? 'Gitee 仓库搜索返回 0 条结果'
          : `Gitee 仓库搜索命中 ${items.length} 条，但没有一条带得 html_url`,
        // Single source of truth for the login story: the anonymous empty array
        // is a token issue, not a "no such code" issue.
        GITEE_LOGIN_REQUIREMENT,
        skipped > 0 ? `跳过 ${skipped} 条不可用条目` : undefined,
        notes.join('；'),
      ),
      failure: 'empty',
      attempts,
    }
  }

  const truncated = rows.length > maxItems
  return {
    ok: true,
    results: rows.slice(0, maxItems),
    reason: joinReason(
      `Gitee 仓库搜索命中 ${rows.length} 条${token !== undefined ? '（已登录）' : '（匿名）'}`,
      truncated ? `已按 maxItems=${maxItems} 截断` : undefined,
      notes.join('；'),
    ),
    attempts,
    truncated,
  }
}

/*
 * REMOVED — `searchGiteeCode` and its `GET /search/code` request builder.
 *
 * Measured 2026-10-04: that path answers HTTP 404 with an HTML page-not-found
 * body, i.e. Gitee v5 has no code-search endpoint at all (see
 * `GITEE_CODE_SEARCH_SUPPORTED`). Keeping a function that could rebuild the
 * request would keep the old "code search just needs a token" story alive, so
 * the function is gone rather than merely disabled; what Gitee actually
 * requires is quoted from `GITEE_LOGIN_REQUIREMENT` instead.
 */

// ---------------------------------------------------------------------------
// HTML fallback — explicit opt-in, explicitly labelled, lower confidence.
// ---------------------------------------------------------------------------

/** One repo link scraped from the search page. */
export interface GiteeHtmlHit {
  readonly url: string
  readonly title: string
}

const RESERVED_OWNERS = new Set([
  'explore',
  'login',
  'search',
  'help',
  'enterprise',
  'oschina',
  'gitee',
  'about',
  'users',
  'organizations',
  'assets',
  'api',
  'oauth',
  'terms',
  'features',
  'pricing',
  'education',
  'ai',
  'notifications',
  'dashboard',
  'settings',
  'signup',
  'session',
  'static',
])

/** Scrape `/{owner}/{repo}` anchors out of the search page. Heuristic by nature. */
export function parseGiteeSearchHtml(html: string, limit: number = 10): readonly GiteeHtmlHit[] {
  const hits: GiteeHtmlHit[] = []
  const seen = new Set<string>()
  const anchor = /href=["'](?:https?:\/\/(?:www\.)?gitee\.com)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi
  for (let match = anchor.exec(html); match !== null; match = anchor.exec(html)) {
    if (hits.length >= limit) break
    const owner: string | undefined = match[1]
    const repo: string | undefined = match[2]
    if (owner === undefined || repo === undefined) continue
    if (RESERVED_OWNERS.has(owner.toLowerCase())) continue
    if (RESERVED_OWNERS.has(repo.toLowerCase())) continue
    const url = `${GITEE_RAW_BASE}/${owner}/${repo}`
    if (seen.has(url.toLowerCase())) continue
    seen.add(url.toLowerCase())
    const title = stripHtml(match[3] ?? '').replace(/\s+/g, ' ').trim()
    hits.push({ url, title: title.length > 0 ? title : `${owner}/${repo}` })
  }
  return hits
}

/** Fetch the search page and turn its repo links into low-confidence rows. */
export async function searchGiteeHtml(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const attempts: AdapterAttempt[] = []
  const maxItems = clampMaxItems(opts.maxItems)
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const url = `${GITEE_WEB_SEARCH_BASE}?${new URLSearchParams({ q: query, type: 'repository' }).toString()}`

  let res: TransportResponse
  try {
    res = await opts.transport({
      url,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'dsh-codehub' },
      timeoutMs,
      signal: opts.signal,
    })
  } catch (error) {
    const classified = classifyTransportError(error)
    attempts.push({ url, statusCode: null, failure: classified.failure, note: classified.reason })
    return { ok: false, results: [], reason: joinReason('Gitee 网页兜底失败', classified.reason), failure: classified.failure, attempts }
  }

  const notes = transportNotes(res)
  const httpFailure = failureFromResponse(res, 'Gitee 搜索网页')
  attempts.push({
    url,
    statusCode: res.statusCode,
    failure: httpFailure?.failure,
    note: optionalReason(httpFailure?.reason, notes.join('；')),
  })
  if (httpFailure !== null) {
    return {
      ok: false,
      results: [],
      reason: joinReason('Gitee 网页兜底失败', httpFailure.reason, notes.join('；')),
      failure: httpFailure.failure,
      attempts,
    }
  }

  const hits = parseGiteeSearchHtml(res.body, maxItems)
  if (hits.length === 0) {
    // Measured 2026-10-04: search.gitee.com answers with an SPA shell — the
    // result list is rendered client-side, so a 200 page legitimately carries
    // zero anchors. Say that instead of the vague "the page structure changed",
    // and say what would actually be needed to search code there.
    return {
      ok: false,
      results: [],
      reason: joinReason(
        'Gitee 网页兜底未解析出仓库链接：实测 search.gitee.com 返回的是 SPA 外壳（结果由前端渲染，服务端 HTML 里没有链接），网页版代码搜索需要登录',
        GITEE_LOGIN_REQUIREMENT,
        notes.join('；'),
      ),
      failure: 'empty',
      attempts,
    }
  }

  const rows: CodeLearnResult[] = hits.map((hit) => {
    const scored = score({
      source: 'gitee',
      authenticated: opts.authenticated === true,
      reposted: false,
      completeness: 0.35,
      notes: [GITEE_HTML_FALLBACK_NOTE, ...notes],
    })
    return {
      source: 'gitee',
      url: hit.url,
      title: hit.title,
      language: '',
      code: '',
      codeTruncated: false,
      learned_summary: summarize({ title: hit.title }),
      is_verbatim_copy: false,
      stars: null,
      updatedAt: null,
      confidence: scored.confidence,
      reason: scored.reason,
    }
  })

  return {
    ok: true,
    results: rows.slice(0, maxItems),
    reason: joinReason(`Gitee 网页兜底解析出 ${rows.length} 条仓库链接`, GITEE_HTML_FALLBACK_NOTE, notes.join('；')),
    attempts,
    truncated: rows.length > maxItems,
  }
}

// ---------------------------------------------------------------------------
// Combined search: the repositories API, then (opt-in) the HTML page.
//
// There used to be a middle rung that called a "code search" API. It is gone:
// that endpoint answers 404 (see the REMOVED note above), so the only two real
// rungs are the repositories endpoint and the explicitly opted-in web page.
// ---------------------------------------------------------------------------

/** `search()` behind the adapter. */
export async function searchGitee(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const maxItems = clampMaxItems(opts.maxItems)
  const repo = await searchGiteeRepositories(query, opts)

  // No code-search rung exists to try, so the anonymous empty array is the whole
  // API story; `GITEE_LOGIN_REQUIREMENT` carries it into every failure reason.
  const merged = dedupe(repo.results).slice(0, maxItems)
  if (merged.length > 0) {
    return {
      ok: true,
      results: merged,
      reason: joinReason(repo.reason, GITEE_LOGIN_REQUIREMENT),
      attempts: [...(repo.attempts ?? [])],
      truncated: repo.results.length > maxItems,
    }
  }

  if (opts.htmlFallback === true) {
    const html = await searchGiteeHtml(query, opts)
    return {
      ok: html.results.length > 0,
      results: html.results,
      reason: joinReason('Gitee API 未取得结果，已按配置回退到网页兜底', repo.reason, html.reason),
      failure: html.results.length > 0 ? undefined : html.failure ?? repo.failure ?? 'empty',
      attempts: [...(repo.attempts ?? []), ...(html.attempts ?? [])],
      truncated: html.truncated,
    }
  }

  return {
    ok: false,
    results: [],
    reason: joinReason(
      'Gitee 未取得结果（可开启 htmlFallback 回退到网页搜索）',
      // Says why in the contract's own words: no v5 code endpoint (404), an
      // anonymous repository search is `[]` (token needed), and the web code
      // search requires a logged-in session.
      GITEE_LOGIN_REQUIREMENT,
      repo.reason,
    ),
    failure: repo.failure ?? 'empty',
    attempts: [...(repo.attempts ?? [])],
  }
}

// ---------------------------------------------------------------------------
// Deep read.
// ---------------------------------------------------------------------------

/** Split `owner/repo` out of a Gitee URL. */
export function parseGiteeRepo(url: string): { readonly owner: string; readonly repo: string } | null {
  const match = /^https?:\/\/(?:www\.)?gitee\.com\/([^/\s#?]+)\/([^/\s#?]+)/i.exec(url.trim())
  if (match === null) return null
  const owner: string | undefined = match[1]
  const rawRepo: string | undefined = match[2]
  if (owner === undefined || rawRepo === undefined) return null
  const repo = rawRepo.replace(/\.git$/, '')
  if (owner.length === 0 || repo.length === 0) return null
  return { owner, repo }
}

/** Gitee raw file URL: same origin, `/raw/{branch}/{path}`. */
export function buildGiteeRawUrl(fullName: string, branch: string, path: string): string {
  return `${GITEE_RAW_BASE}/${fullName}/raw/${branch}/${path.replace(/^\/+/, '')}`
}

/**
 * Deep read for Gitee. Gitee has no cheap recursive tree listing in this
 * adapter, so discovery is conventional: README / entry candidates by name,
 * manifests for `core`, common test paths for `tests` — and whatever was not
 * found is reported in `skipped` instead of being invented.
 *
 * Raw reads are public-content only: the token is never put in a URL (see the
 * module header), so private repositories answer `auth-required` from Gitee.
 */
export async function deepReadGitee(
  url: string,
  targets: readonly DeepReadTarget[],
  opts: AdapterSearchOptions,
): Promise<AdapterDeepOutcome> {
  const attempts: AdapterAttempt[] = []
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const parsed = parseGiteeRepo(url)
  const requested: readonly DeepReadTarget[] = targets.length > 0 ? [...targets] : ['readme']

  if (parsed === null) {
    return {
      notes: [],
      reason: `无法从 URL 解析出 owner/repo：${url}`,
      failure: 'parse-failed',
      fetchedUrls: [],
      skipped: requested,
      attempts,
    }
  }

  const fullName = `${parsed.owner}/${parsed.repo}`
  const token = tokenForAccess(opts.access, opts.token)

  // default branch: real field on the repo endpoint; `master` is Gitee's
  // long-standing default and is only used when the metadata call fails.
  let branch = 'master'
  const metaUrl = buildGiteeApiUrl(`/repos/${parsed.owner}/${parsed.repo}`, {
    ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }),
  })
  try {
    const meta = await opts.transport({
      url: metaUrl,
      headers: giteeHeaders(opts),
      ...(token === undefined ? {} : { token }),
      timeoutMs,
      signal: opts.signal,
    })
    const metaFailure = failureFromResponse(meta, 'Gitee 仓库元数据')
    if (metaFailure === null) {
      const payload: unknown = JSON.parse(meta.body) as unknown
      const declared = isRecord(payload) ? asString(payload['default_branch']) : undefined
      if (declared !== undefined) branch = declared
    }
    attempts.push({
      url: metaUrl,
      statusCode: meta.statusCode,
      failure: metaFailure?.failure,
      note: optionalReason(metaFailure?.reason, transportNotes(meta).join('；')),
    })
  } catch (error) {
    const classified = classifyTransportError(error)
    attempts.push({ url: metaUrl, statusCode: null, failure: classified.failure, note: classified.reason })
  }

  const candidates: DeepReadCandidate[] = []
  for (const target of requested) {
    for (const path of candidatePaths(target)) {
      const raw = buildGiteeRawUrl(fullName, branch, path)
      if (candidates.some((candidate) => candidate.url === raw)) continue
      candidates.push({ url: raw, target, label: path })
    }
  }

  const fetchFile: DeepReadFetch = async (candidateUrl: string): Promise<DeepReadFetchResult> => {
    try {
      const res = await opts.transport({
        url: candidateUrl,
        headers: { accept: 'text/plain, */*', 'user-agent': 'dsh-codehub' },
        timeoutMs,
        signal: opts.signal,
      })
      const httpFailure = failureFromResponse(res, 'Gitee raw 文件')
      const notes = transportNotes(res)
      if (httpFailure === null) {
        return { ok: true, url: res.finalUrl.length > 0 ? res.finalUrl : candidateUrl, text: res.body }
      }
      attempts.push({ url: candidateUrl, statusCode: res.statusCode, failure: httpFailure.failure, note: httpFailure.reason })
      return { ok: false, url: candidateUrl, failure: httpFailure.failure, reason: joinReason(httpFailure.reason, notes.join('；')) }
    } catch (error) {
      const classified = classifyTransportError(error)
      attempts.push({ url: candidateUrl, statusCode: null, failure: classified.failure, note: classified.reason })
      return { ok: false, url: candidateUrl, failure: classified.failure, reason: classified.reason }
    }
  }

  const outcome = await deepReadFiles({
    url,
    title: fullName,
    requested,
    candidates,
    fetchFile,
    maxFiles: GITEE_DEEPREAD_MAX_FILES,
  })

  return { ...outcome, attempts: [...attempts, ...(outcome.attempts ?? [])] }
}

/** Adapter factory. */
export function createGiteeAdapter(): SourceAdapter {
  return {
    id: 'gitee',
    search: searchGitee,
    deepRead: deepReadGitee,
  }
}
