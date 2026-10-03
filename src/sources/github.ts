/**
 * dsh-codehub — GitHub 源适配器.
 *
 * Two independent, separately configurable base paths — this is the whole point
 * of the split, because the live probe on this host found one reachable and the
 * other not:
 *
 *   API 基址   `opts.apiBase`   default `GITHUB_API_BASE`     实测 HTTP 200 可直连
 *   raw 基址   `opts.rawMirrors` 默认为空 / 直连 raw origin   实测 fetch failed 不可直连
 *
 * The API path may carry a token (`tokenForAccess()`, which strips it for the
 * three mirror strategies). The raw path NEVER carries a token; it is a
 * public-content download through user-configured mirrors, and a bare mirror
 * host is prefixed onto the canonical raw URL exactly as the probe verified
 * (`ghproxy.net/https://raw.githubusercontent.com/...` → HTTP 200).
 *
 * Only real endpoints and real fields are used:
 *   `GET /search/repositories?q=&per_page=`      → `items[].{full_name,html_url,description,language,stargazers_count,updated_at,default_branch}`
 *   `GET /search/code?q=`                        → needs a token; without one this adapter answers `auth-required` and sends nothing
 *   `GET /repos/{owner}/{repo}`                  → `default_branch`
 *   `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` → `tree[].{path,type,size}`
 *
 * 备注①：no request of any kind is issued here except through `opts.transport`,
 * and every transport note is copied into `reason` verbatim.
 * 备注③：`search()` rows carry only a bounded excerpt plus a thinking summary;
 * `deepRead()` returns `LearnNote`s, never file bodies.
 */

import { GITHUB_API_BASE, GITHUB_RAW_ORIGIN } from '../contract.js'
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
  tokenForAccess,
  transportNotes,
} from './types.js'
import { dedupe } from '../learn/dedupe.js'
import { summarize } from '../learn/summary.js'
import { completenessFrom, score } from '../learn/score.js'
import {
  candidatePaths,
  deepReadFiles,
  type DeepReadCandidate,
  type DeepReadFetch,
  type DeepReadFetchResult,
} from '../learn/deepread.js'

/** Files one GitHub deep read may pull in. */
export const GITHUB_DEEPREAD_MAX_FILES = 6

/** Fields this adapter reads from a repository search row. Nothing else. */
const GITHUB_REPO_FIELDS = [
  'full_name',
  'html_url',
  'description',
  'language',
  'stargazers_count',
  'updated_at',
  'default_branch',
] as const

/** Fields read from a code-search row. */
const GITHUB_CODE_FIELDS = ['name', 'path', 'html_url', 'repository', 'text_matches'] as const

/** Headers GitHub documents for its REST API. */
export const GITHUB_API_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-codehub',
}

/** Header that makes `/search/code` include `text_matches[].fragment`. */
export const GITHUB_TEXT_MATCH_HEADERS: Readonly<Record<string, string>> = {
  ...GITHUB_API_HEADERS,
  accept: 'application/vnd.github.text-match+json',
}

/** Raw downloads go through mirrors and never carry a credential. */
export const GITHUB_RAW_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/plain, */*',
  'user-agent': 'dsh-codehub',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Index a regex group as `string | undefined` regardless of TS index typing. */
function group(match: RegExpExecArray, index: number): string | undefined {
  const value: string | undefined = match[index]
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Read a JSON array field without guessing the container shape: only the exact
 * key is looked at, and anything that is not an array yields null.
 */
export function arrayField(container: unknown, key: string): readonly unknown[] | null {
  const raw: unknown = isRecord(container) ? container[key] : undefined
  return Array.isArray(raw) ? raw : null
}

// ---------------------------------------------------------------------------
// URL construction.
// ---------------------------------------------------------------------------

/** Strip trailing slashes from a base without touching its interior. */
function normalizeBase(base: string | undefined, fallback: string): string {
  const raw = typeof base === 'string' && base.trim().length > 0 ? base.trim() : fallback
  return raw.replace(/\/+$/, '')
}

/** Build an API URL from a configurable base plus a real endpoint path. */
export function buildGithubApiUrl(
  endpointPath: string,
  options: { readonly apiBase?: string; readonly params?: Readonly<Record<string, string | number>> } = {},
): string {
  const base = normalizeBase(options.apiBase, GITHUB_API_BASE)
  const path = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`
  const search = new URLSearchParams()
  if (options.params !== undefined) {
    for (const [key, value] of Object.entries(options.params)) {
      search.set(key, String(value))
    }
  }
  const query = search.toString()
  return query.length > 0 ? `${base}${path}?${query}` : `${base}${path}`
}

/**
 * Map a repo-relative path onto a raw base.
 *
 * Three shapes are accepted, all verified or user-configured:
 *   `https://ghproxy.net`                                  → `<base>/https://raw.githubusercontent.com/<path>`
 *   `https://ghproxy.net/https://raw.githubusercontent.com`→ `<base>/<path>`
 *   `https://cdn.example/{url}`                            → template substitution
 */
export function buildGithubRawUrl(base: string, repoPath: string): string {
  const path = repoPath.replace(/^\/+/, '')
  const canonical = `${GITHUB_RAW_ORIGIN}/${path}`
  const trimmed = base.trim().replace(/\/+$/, '')
  if (trimmed.includes('{url}')) return trimmed.split('{url}').join(canonical)
  if (trimmed.includes(GITHUB_RAW_ORIGIN)) return `${trimmed}/${path}`
  return `${trimmed}/${canonical}`
}

/**
 * Raw bases to try, in order.
 *
 * Decision #7 of the design is explicit: `rawMirrorBases` defaults to `[]` and
 * an empty list means "raw download is unavailable — do not improvise"
 * (`docs/DESIGN.md` §2, `config.ts`). So an empty list yields NO base and a
 * failure that names the missing setting, instead of guessing a mirror.
 *
 * The two exceptions are the access strategies whose whole purpose is to make
 * the canonical origin reachable from this machine (`local-proxy`, `watt`,
 * `hosts`): for those the origin itself is tried, because that is not a
 * fallback but the path the user just enabled. `direct` / `token` deliberately
 * do NOT qualify — the live probe found `raw.githubusercontent.com`
 * unreachable exactly there, which is why the failure reason says to add a
 * mirror.
 */
export function rawBasesFor(opts: AdapterSearchOptions): { readonly bases: readonly string[]; readonly reason: string } {
  const configuredRaw = opts.rawMirrors
  const configured =
    configuredRaw === undefined
      ? []
      : configuredRaw.filter((base: string) => typeof base === 'string' && base.trim().length > 0)
  if (configured.length > 0) {
    return { bases: configured.map((base) => base.trim()), reason: `使用 ${configured.length} 个已配置的 raw 镜像基址` }
  }

  const access = opts.access
  if (access === 'local-proxy' || access === 'watt' || access === 'hosts') {
    return {
      bases: [GITHUB_RAW_ORIGIN],
      reason: `访问方式「${access}」已让本机可直连 GitHub，直接读取 ${GITHUB_RAW_ORIGIN}（失败时请在 raw 镜像列表里补一个基址）`,
    }
  }
  return {
    bases: [],
    reason: joinReason(
      '未配置任何 raw 镜像基址（rawMirrorBases 为空）',
      `本机实测 ${GITHUB_RAW_ORIGIN} 不可直连，设计约定「空列表 = 该方式不可用，不兜底」`,
      '请在设置 → GitHub → raw 文件镜像里填入基址（例如 https://ghproxy.net/https://raw.githubusercontent.com）后重试',
    ),
  }
}

// ---------------------------------------------------------------------------
// Repository search.
// ---------------------------------------------------------------------------

/** Map one repository row onto the unified envelope. Returns null when unusable. */
export function mapGithubRepo(
  item: Record<string, unknown>,
  context: { readonly authenticated: boolean; readonly notes: readonly string[] },
): CodeLearnResult | null {
  const url = asString(item['html_url'])
  if (url === undefined) return null
  const fullName = asString(item['full_name']) ?? url
  const description = asString(item['description']) ?? ''
  const language = asString(item['language']) ?? ''
  const scored = score({
    source: 'github',
    authenticated: context.authenticated,
    reposted: false,
    completeness: completenessFrom(item, GITHUB_REPO_FIELDS),
    notes: context.notes,
  })
  return {
    source: 'github',
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
    reason: joinReason('GitHub 仓库搜索结果', scored.reason),
  }
}

/** `GET /search/repositories`. */
export async function searchGithubRepos(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const attempts: AdapterAttempt[] = []
  const maxItems = clampMaxItems(opts.maxItems)
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const trimmed = typeof query === 'string' ? query.trim() : ''
  const token = tokenForAccess(opts.access, opts.token)

  if (trimmed.length === 0) {
    return { ok: false, results: [], reason: 'GitHub 仓库搜索：查询为空，未发起任何请求。', failure: 'empty', attempts }
  }

  const url = buildGithubApiUrl('/search/repositories', {
    ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }),
    params: { q: trimmed, per_page: maxItems },
  })

  let res: TransportResponse
  try {
    res = await opts.transport({
      url,
      headers: { ...GITHUB_API_HEADERS },
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
  const httpFailure = failureFromResponse(res, 'GitHub 仓库搜索')
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
      reason: joinReason('GitHub 仓库搜索返回值不是合法 JSON', `解析错误：${detail}`, notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const items = arrayField(payload, 'items')
  if (items === null) {
    return {
      ok: false,
      results: [],
      reason: joinReason('GitHub 仓库搜索返回结构里没有 items[]', notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const rows: CodeLearnResult[] = []
  let skipped = 0
  for (const item of items) {
    if (!isRecord(item)) {
      skipped += 1
      continue
    }
    const row = mapGithubRepo(item, {
      authenticated: token !== undefined || opts.authenticated === true,
      notes,
    })
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
        items.length === 0 ? 'GitHub 仓库搜索返回 0 条结果' : `GitHub 仓库搜索命中 ${items.length} 条，但没有一条带得 html_url`,
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
      `GitHub 仓库搜索命中 ${rows.length} 条${token !== undefined ? '（已登录）' : '（匿名）'}`,
      truncated ? `已按 maxItems=${maxItems} 截断` : undefined,
      notes.join('；'),
    ),
    attempts,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Code search — token required.
// ---------------------------------------------------------------------------

/** Map one code-search row, using `text_matches[].fragment` for the excerpt. */
export function mapGithubCode(
  item: Record<string, unknown>,
  context: { readonly authenticated: boolean; readonly notes: readonly string[]; readonly maxCodeChars: number },
): CodeLearnResult | null {
  const url = asString(item['html_url'])
  if (url === undefined) return null
  const path = asString(item['path']) ?? asString(item['name']) ?? url
  const repositoryRaw: unknown = item['repository']
  const repository = isRecord(repositoryRaw) ? repositoryRaw : null
  const fullName = repository === null ? undefined : asString(repository['full_name'])
  const title = fullName === undefined ? path : `${fullName}/${path}`

  const fragments: string[] = []
  const textMatches: unknown = item['text_matches']
  if (Array.isArray(textMatches)) {
    for (const match of textMatches) {
      if (!isRecord(match)) continue
      const fragment = asString(match['fragment'])
      if (fragment !== undefined) fragments.push(fragment)
    }
  }
  const bounded = boundExcerpt(fragments.join('\n\n'), context.maxCodeChars)

  const scored = score({
    source: 'github',
    authenticated: context.authenticated,
    reposted: false,
    completeness: completenessFrom(item, GITHUB_CODE_FIELDS),
    notes: context.notes,
  })

  return {
    source: 'github',
    url,
    title,
    language: '',
    code: bounded.code,
    codeTruncated: bounded.codeTruncated,
    learned_summary: summarize({ title, body: fragments.join('\n\n') }),
    is_verbatim_copy: false,
    stars: null,
    updatedAt: null,
    confidence: scored.confidence,
    reason: joinReason('GitHub 代码搜索命中', scored.reason),
  }
}

/**
 * `GET /search/code`. Without a token this answers `auth-required` and issues
 * **zero** requests, because the endpoint rejects anonymous callers.
 */
export async function searchGithubCode(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const attempts: AdapterAttempt[] = []
  const maxItems = clampMaxItems(opts.maxItems)
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const trimmed = typeof query === 'string' ? query.trim() : ''
  const token = tokenForAccess(opts.access, opts.token)

  if (trimmed.length === 0) {
    return { ok: false, results: [], reason: 'GitHub 代码搜索：查询为空，未发起任何请求。', failure: 'empty', attempts }
  }
  if (token === undefined) {
    return {
      ok: false,
      results: [],
      reason: 'GitHub 代码搜索需要 token（/search/code 不接受匿名调用）；未发起任何请求。',
      failure: 'auth-required',
      attempts,
    }
  }

  const url = buildGithubApiUrl('/search/code', {
    ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }),
    params: { q: trimmed, per_page: maxItems },
  })

  let res: TransportResponse
  try {
    res = await opts.transport({
      url,
      headers: { ...GITHUB_TEXT_MATCH_HEADERS },
      token,
      timeoutMs,
      signal: opts.signal,
    })
  } catch (error) {
    const classified = classifyTransportError(error)
    attempts.push({ url, statusCode: null, failure: classified.failure, note: classified.reason })
    return { ok: false, results: [], reason: classified.reason, failure: classified.failure, attempts }
  }

  const notes = transportNotes(res)
  const httpFailure = failureFromResponse(res, 'GitHub 代码搜索')
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
      reason: joinReason('GitHub 代码搜索返回值不是合法 JSON', `解析错误：${detail}`, notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const items = arrayField(payload, 'items')
  if (items === null) {
    return {
      ok: false,
      results: [],
      reason: joinReason('GitHub 代码搜索返回结构里没有 items[]', notes.join('；')),
      failure: 'parse-failed',
      attempts,
    }
  }

  const rows: CodeLearnResult[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const row = mapGithubCode(item, {
      authenticated: true,
      notes,
      maxCodeChars: clampMaxCodeChars(opts.maxCodeChars),
    })
    if (row !== null) rows.push(row)
  }

  if (rows.length === 0) {
    return {
      ok: false,
      results: [],
      reason: joinReason('GitHub 代码搜索返回 0 条可用结果', notes.join('；')),
      failure: 'empty',
      attempts,
    }
  }

  const truncated = rows.length > maxItems
  return {
    ok: true,
    results: rows.slice(0, maxItems),
    reason: joinReason(`GitHub 代码搜索命中 ${rows.length} 条（已登录）`, truncated ? `已按 maxItems=${maxItems} 截断` : undefined, notes.join('；')),
    attempts,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Combined search: repositories, then (when logged in) code.
// ---------------------------------------------------------------------------

/** `search()` behind the adapter: repo search always, code search when a token exists. */
export async function searchGithub(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome> {
  const maxItems = clampMaxItems(opts.maxItems)
  const repo = await searchGithubRepos(query, opts)
  const token = tokenForAccess(opts.access, opts.token)

  let code: AdapterOutcome | undefined
  if (token !== undefined && repo.results.length < maxItems) {
    code = await searchGithubCode(query, opts)
  }

  const attempts: AdapterAttempt[] = [...(repo.attempts ?? []), ...(code?.attempts ?? [])]
  const rows = dedupe([...repo.results, ...(code?.results ?? [])]).slice(0, maxItems)

  if (rows.length === 0) {
    const failure: FailureKind = repo.failure ?? code?.failure ?? 'empty'
    return {
      ok: false,
      results: [],
      reason: joinReason(
        'GitHub 搜索未取得可用结果',
        repo.reason,
        code === undefined ? undefined : `代码搜索：${code.reason}`,
      ),
      failure,
      attempts,
    }
  }

  const truncated = repo.results.length + (code?.results.length ?? 0) > maxItems
  return {
    ok: true,
    results: rows,
    reason: joinReason(
      repo.reason,
      code === undefined ? undefined : code.reason,
      truncated ? `合并后已按 maxItems=${maxItems} 截断` : undefined,
    ),
    attempts,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Deep read — README / entry / core / tests via raw mirrors.
// ---------------------------------------------------------------------------

/** Split `owner/repo` out of any GitHub URL this adapter produced. */
export function parseGithubRepo(url: string): { readonly owner: string; readonly repo: string; readonly ref?: string } | null {
  const match = /^https?:\/\/[^/]*github(?:usercontent)?\.[a-z.]+\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:blob|tree)\/([^/\s#?]+))?/i.exec(
    url.trim(),
  )
  if (match === null) return null
  const owner = group(match, 1)
  const rawRepo = group(match, 2)
  if (owner === undefined || rawRepo === undefined) return null
  const repo = rawRepo.replace(/\.git$/, '')
  if (repo.length === 0) return null
  const ref = group(match, 3)
  return ref === undefined ? { owner, repo } : { owner, repo, ref }
}

interface GithubTreeEntry {
  readonly path: string
  readonly type: string
  readonly size: number
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.php', '.rb', '.java', '.kt', '.cs', '.vue', '.svelte'] as const

/** Pick core-module candidates out of a recursive tree listing. */
export function pickCorePaths(entries: readonly GithubTreeEntry[], limit: number = 3): readonly string[] {
  const candidates = entries.filter((entry) => {
    if (entry.type !== 'blob') return false
    const lower = entry.path.toLowerCase()
    if (/(^|\/)(tests?|__tests__|spec|e2e|docs?|examples?|benchmarks?)\//.test(lower)) return false
    if (/(^|\/)readme(\.[a-z-]+)?$/.test(lower)) return false
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(lower)) return false
    return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))
  })
  const scored = candidates.map((entry) => {
    const lower = entry.path.toLowerCase()
    let rank = 0
    if (lower.startsWith('src/') || lower.startsWith('lib/') || lower.startsWith('core/')) rank -= 2
    const depth = entry.path.split('/').length
    return { entry, rank: rank + depth }
  })
  scored.sort((left, right) => (left.rank === right.rank ? left.entry.path.localeCompare(right.entry.path) : left.rank - right.rank))
  return scored.slice(0, Math.max(1, limit)).map((item) => item.entry.path)
}

/** Pick test-file candidates out of a recursive tree listing. */
export function pickTestPaths(entries: readonly GithubTreeEntry[], limit: number = 2): readonly string[] {
  const candidates = entries.filter((entry) => {
    if (entry.type !== 'blob') return false
    const lower = entry.path.toLowerCase()
    if (/(^|\/)(tests?|__tests__|spec|e2e)\//.test(lower)) return true
    return /\.(test|spec)\.[a-z]+$/.test(lower)
  })
  candidates.sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path))
  return candidates.slice(0, Math.max(1, limit)).map((entry) => entry.path)
}

/** Deep read: resolve the default branch, discover files, read via raw mirrors. */
export async function deepReadGithub(
  url: string,
  targets: readonly DeepReadTarget[],
  opts: AdapterSearchOptions,
): Promise<AdapterDeepOutcome> {
  const attempts: AdapterAttempt[] = []
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const parsed = parseGithubRepo(url)
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

  const { bases, reason: baseReason } = rawBasesFor(opts)
  if (bases.length === 0) {
    return {
      notes: [],
      reason: joinReason('GitHub 深度阅读无法读取文件', baseReason),
      failure: 'network',
      fetchedUrls: [],
      skipped: requested,
      attempts,
    }
  }

  const fullName = `${parsed.owner}/${parsed.repo}`
  const token = tokenForAccess(opts.access, opts.token)

  // 1) default branch — real field on the repo endpoint; `HEAD` is the fallback
  //    ref so a rate-limited metadata call does not kill the whole read.
  let branch = parsed.ref ?? ''
  if (branch.length === 0) {
    const metaUrl = buildGithubApiUrl(`/repos/${parsed.owner}/${parsed.repo}`, opts.apiBase === undefined ? {} : { apiBase: opts.apiBase })
    try {
      const meta = await opts.transport({
        url: metaUrl,
        headers: { ...GITHUB_API_HEADERS },
        ...(token === undefined ? {} : { token }),
        timeoutMs,
        signal: opts.signal,
      })
      const metaFailure = failureFromResponse(meta, 'GitHub 仓库元数据')
      if (metaFailure === null) {
        const payload: unknown = JSON.parse(meta.body) as unknown
        const declared = isRecord(payload) ? asString(payload['default_branch']) : undefined
        branch = declared ?? 'HEAD'
      } else {
        branch = 'HEAD'
      }
      attempts.push({ url: metaUrl, statusCode: meta.statusCode, failure: metaFailure?.failure, note: optionalReason(metaFailure?.reason, transportNotes(meta).join('；')) })
    } catch (error) {
      const classified = classifyTransportError(error)
      attempts.push({ url: metaUrl, statusCode: null, failure: classified.failure, note: classified.reason })
      branch = 'HEAD'
    }
  }

  // 2) discovery — conventional paths, plus a real tree listing for core/tests.
  let treeEntries: readonly GithubTreeEntry[] = []
  const wantsTree = requested.includes('core') || requested.includes('tests')
  if (wantsTree) {
    const treeUrl = buildGithubApiUrl(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}`, {
      ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }),
      params: { recursive: '1' },
    })
    try {
      const tree = await opts.transport({
        url: treeUrl,
        headers: { ...GITHUB_API_HEADERS },
        ...(token === undefined ? {} : { token }),
        timeoutMs,
        signal: opts.signal,
      })
      const treeFailure = failureFromResponse(tree, 'GitHub 文件树')
      if (treeFailure === null) {
        const payload: unknown = JSON.parse(tree.body) as unknown
        const list = arrayField(payload, 'tree') ?? []
        treeEntries = list
          .filter(isRecord)
          .map((entry) => ({
            path: asString(entry['path']) ?? '',
            type: asString(entry['type']) ?? '',
            size: asNumber(entry['size']) ?? 0,
          }))
          .filter((entry) => entry.path.length > 0)
      }
      attempts.push({ url: treeUrl, statusCode: tree.statusCode, failure: treeFailure?.failure, note: optionalReason(treeFailure?.reason, transportNotes(tree).join('；')) })
    } catch (error) {
      const classified = classifyTransportError(error)
      attempts.push({ url: treeUrl, statusCode: null, failure: classified.failure, note: classified.reason })
    }
  }

  const candidates: DeepReadCandidate[] = []
  const pushCandidate = (path: string, target: DeepReadTarget): void => {
    const canonical = `${GITHUB_RAW_ORIGIN}/${fullName}/${branch}/${path}`
    if (candidates.some((candidate) => candidate.url === canonical)) return
    candidates.push({ url: canonical, target, label: path })
  }

  if (requested.includes('readme')) {
    for (const path of candidatePaths('readme')) pushCandidate(path, 'readme')
  }
  if (requested.includes('entry')) {
    for (const path of candidatePaths('entry')) pushCandidate(path, 'entry')
  }
  if (requested.includes('core')) {
    const corePaths = treeEntries.length > 0 ? pickCorePaths(treeEntries) : candidatePaths('core')
    for (const path of corePaths) pushCandidate(path, 'core')
  }
  if (requested.includes('tests')) {
    const paths = treeEntries.length > 0 ? pickTestPaths(treeEntries) : candidatePaths('tests')
    for (const path of paths) pushCandidate(path, 'tests')
  }

  // 3) fetch — every candidate is tried against each base in order. A 404 means
  //    "this path does not exist" and stops the base walk; a transport failure
  //    means "this mirror is down" and moves to the next base.
  const fetchFile: DeepReadFetch = async (candidateUrl: string): Promise<DeepReadFetchResult> => {
    const repoPath = candidateUrl.startsWith(`${GITHUB_RAW_ORIGIN}/`)
      ? candidateUrl.slice(GITHUB_RAW_ORIGIN.length + 1)
      : candidateUrl.replace(/^\/+/, '')
    const failures: string[] = []
    let lastUrl = candidateUrl
    for (const base of bases) {
      const raw = buildGithubRawUrl(base, repoPath)
      lastUrl = raw
      try {
        const res = await opts.transport({ url: raw, headers: { ...GITHUB_RAW_HEADERS }, timeoutMs, signal: opts.signal })
        const httpFailure = failureFromResponse(res, 'GitHub raw 文件')
        const notes = transportNotes(res)
        if (httpFailure === null) {
          return { ok: true, url: res.finalUrl.length > 0 ? res.finalUrl : raw, text: res.body }
        }
        failures.push(optionalReason(`${raw}：${httpFailure.reason}`, notes.join('；')) ?? raw)
        attempts.push({ url: raw, statusCode: res.statusCode, failure: httpFailure.failure, note: httpFailure.reason })
        if (httpFailure.failure === 'empty' || httpFailure.failure === 'auth-required' || httpFailure.failure === 'rate-limited') {
          return { ok: false, url: raw, failure: httpFailure.failure, reason: joinReason(httpFailure.reason, notes.join('；')) }
        }
      } catch (error) {
        const classified = classifyTransportError(error)
        failures.push(`${raw}：${classified.reason}`)
        attempts.push({ url: raw, statusCode: null, failure: classified.failure, note: classified.reason })
      }
    }
    return {
      ok: false,
      url: lastUrl,
      failure: 'network',
      reason: joinReason(`所有 raw 基址都失败（${bases.length} 个）`, failures.slice(0, 3).join('；'), baseReason),
    }
  }

  const outcome = await deepReadFiles({
    url,
    title: fullName,
    requested,
    candidates,
    fetchFile,
    maxFiles: GITHUB_DEEPREAD_MAX_FILES,
  })

  return { ...outcome, attempts: [...attempts, ...(outcome.attempts ?? [])] }
}

/** Adapter factory. */
export function createGithubAdapter(): SourceAdapter {
  return {
    id: 'github',
    search: searchGithub,
    deepRead: deepReadGithub,
  }
}
