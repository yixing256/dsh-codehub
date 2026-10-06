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
import type { CodeLearnResult, DeepReadTarget } from '../contract.js';
import type { AdapterDeepOutcome, AdapterOutcome, AdapterSearchOptions, SourceAdapter } from './types.js';
/** Files one GitHub deep read may pull in. */
export declare const GITHUB_DEEPREAD_MAX_FILES = 6;
/** Headers GitHub documents for its REST API. */
export declare const GITHUB_API_HEADERS: Readonly<Record<string, string>>;
/** Header that makes `/search/code` include `text_matches[].fragment`. */
export declare const GITHUB_TEXT_MATCH_HEADERS: Readonly<Record<string, string>>;
/** Raw downloads go through mirrors and never carry a credential. */
export declare const GITHUB_RAW_HEADERS: Readonly<Record<string, string>>;
/**
 * Read a JSON array field without guessing the container shape: only the exact
 * key is looked at, and anything that is not an array yields null.
 */
export declare function arrayField(container: unknown, key: string): readonly unknown[] | null;
/** Build an API URL from a configurable base plus a real endpoint path. */
export declare function buildGithubApiUrl(endpointPath: string, options?: {
    readonly apiBase?: string;
    readonly params?: Readonly<Record<string, string | number>>;
}): string;
/**
 * Map a repo-relative path onto a raw base.
 *
 * Three shapes are accepted, all verified or user-configured:
 *   `https://ghproxy.net`                                  → `<base>/https://raw.githubusercontent.com/<path>`
 *   `https://ghproxy.net/https://raw.githubusercontent.com`→ `<base>/<path>`
 *   `https://cdn.example/{url}`                            → template substitution
 */
export declare function buildGithubRawUrl(base: string, repoPath: string): string;
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
export declare function rawBasesFor(opts: AdapterSearchOptions): {
    readonly bases: readonly string[];
    readonly reason: string;
};
/** Map one repository row onto the unified envelope. Returns null when unusable. */
export declare function mapGithubRepo(item: Record<string, unknown>, context: {
    readonly authenticated: boolean;
    readonly notes: readonly string[];
}): CodeLearnResult | null;
/** `GET /search/repositories`. */
export declare function searchGithubRepos(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** Map one code-search row, using `text_matches[].fragment` for the excerpt. */
export declare function mapGithubCode(item: Record<string, unknown>, context: {
    readonly authenticated: boolean;
    readonly notes: readonly string[];
    readonly maxCodeChars: number;
}): CodeLearnResult | null;
/**
 * `GET /search/code`. Without a token this answers `auth-required` and issues
 * **zero** requests, because the endpoint rejects anonymous callers.
 *
 * The evidence — measured 2026-10-04: anonymous `GET
 * api.github.com/search/code?q=vue` → HTTP 401 `Requires authentication` — is
 * quoted from `GITHUB_LOGIN_REQUIREMENT` instead of being re-typed here, so the
 * tool reason, the connectivity panel and the README cannot drift apart.
 */
export declare function searchGithubCode(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** `search()` behind the adapter: repo search always, code search when a token exists. */
export declare function searchGithub(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** Split `owner/repo` out of any GitHub URL this adapter produced. */
export declare function parseGithubRepo(url: string): {
    readonly owner: string;
    readonly repo: string;
    readonly ref?: string;
} | null;
interface GithubTreeEntry {
    readonly path: string;
    readonly type: string;
    readonly size: number;
}
/** Pick core-module candidates out of a recursive tree listing. */
export declare function pickCorePaths(entries: readonly GithubTreeEntry[], limit?: number): readonly string[];
/** Pick test-file candidates out of a recursive tree listing. */
export declare function pickTestPaths(entries: readonly GithubTreeEntry[], limit?: number): readonly string[];
/** Deep read: resolve the default branch, discover files, read via raw mirrors. */
export declare function deepReadGithub(url: string, targets: readonly DeepReadTarget[], opts: AdapterSearchOptions): Promise<AdapterDeepOutcome>;
/** Adapter factory. */
export declare function createGithubAdapter(): SourceAdapter;
export {};
