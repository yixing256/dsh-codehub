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
import type { CodeLearnResult, DeepReadTarget } from '../contract.js';
import type { AdapterDeepOutcome, AdapterOutcome, AdapterSearchOptions, SourceAdapter } from './types.js';
/** Gitee API headers. */
export declare const GITEE_API_HEADERS: Readonly<Record<string, string>>;
/** Same-origin raw file base for public content. */
export declare const GITEE_RAW_BASE = "https://gitee.com";
/** HTML search page used only by the explicit fallback path. */
export declare const GITEE_WEB_SEARCH_BASE = "https://search.gitee.com/";
/** Gitee 搜索网页兜底文案（含来源标注）。 */
export declare const GITEE_HTML_FALLBACK_NOTE = "HTML \u7F51\u9875\u515C\u5E95\uFF08\u672A\u8D70\u5B98\u65B9 API\uFF09\uFF0C\u5B57\u6BB5\u4E0D\u5B8C\u6574\u3001\u7F6E\u4FE1\u5EA6\u8F83\u4F4E";
/** Files one Gitee deep read may pull in. */
export declare const GITEE_DEEPREAD_MAX_FILES = 5;
/**
 * Build a Gitee v5 URL. `endpointPath` is a path this module owns — a contract
 * constant (`GITEE_SEARCH_REPOSITORIES`) or a repository metadata path built
 * from parsed owner/repo. This is not a general URL builder, and no caller may
 * pass a code-search path: that endpoint does not exist.
 */
export declare function buildGiteeApiUrl(endpointPath: string, options?: {
    readonly apiBase?: string;
    readonly params?: Readonly<Record<string, string | number>>;
    readonly token?: string;
    readonly tokenInQuery?: boolean;
}): string;
/** Headers for one Gitee API call. Bearer by default; never logs the token. */
export declare function giteeHeaders(opts: AdapterSearchOptions): Record<string, string>;
/** Accept a bare array or an `items[]` container; `null` means the shape changed. */
export declare function giteeRowsOf(payload: unknown): readonly Record<string, unknown>[] | null;
/** Map one Gitee repository row. Returns null when it carries no openable URL. */
export declare function mapGiteeRepo(item: Record<string, unknown>, context: {
    readonly authenticated: boolean;
    readonly notes: readonly string[];
}): CodeLearnResult | null;
/** `GET /search/repositories`. An anonymous empty answer stays `empty`. */
export declare function searchGiteeRepositories(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** One repo link scraped from the search page. */
export interface GiteeHtmlHit {
    readonly url: string;
    readonly title: string;
}
/** Scrape `/{owner}/{repo}` anchors out of the search page. Heuristic by nature. */
export declare function parseGiteeSearchHtml(html: string, limit?: number): readonly GiteeHtmlHit[];
/** Fetch the search page and turn its repo links into low-confidence rows. */
export declare function searchGiteeHtml(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** `search()` behind the adapter. */
export declare function searchGitee(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** Split `owner/repo` out of a Gitee URL. */
export declare function parseGiteeRepo(url: string): {
    readonly owner: string;
    readonly repo: string;
} | null;
/** Gitee raw file URL: same origin, `/raw/{branch}/{path}`. */
export declare function buildGiteeRawUrl(fullName: string, branch: string, path: string): string;
/**
 * Deep read for Gitee. Gitee has no cheap recursive tree listing in this
 * adapter, so discovery is conventional: README / entry candidates by name,
 * manifests for `core`, common test paths for `tests` — and whatever was not
 * found is reported in `skipped` instead of being invented.
 *
 * Raw reads are public-content only: the token is never put in a URL (see the
 * module header), so private repositories answer `auth-required` from Gitee.
 */
export declare function deepReadGitee(url: string, targets: readonly DeepReadTarget[], opts: AdapterSearchOptions): Promise<AdapterDeepOutcome>;
/** Adapter factory. */
export declare function createGiteeAdapter(): SourceAdapter;
