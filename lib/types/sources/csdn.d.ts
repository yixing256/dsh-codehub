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
import type { DeepReadTarget } from '../contract.js';
import type { AdapterDeepOutcome, AdapterOutcome, AdapterSearchOptions, SourceAdapter } from './types.js';
/**
 * 备注② provenance, exported so the settings panel / README can render one
 * source of truth instead of re-typing the sentence.
 */
export declare const CSDN_PROVENANCE: {
    /** The endpoint base this adapter talks to. See `CSDN_API_NOTE`. */
    readonly apiBase: "https://so.csdn.net/api/v3/search";
    /** 非官方内部接口的完整来源标注（非官方 / 实测日期 / 可能失效）。 */
    readonly note: string;
    /** 实测日期。 */
    readonly probedAt: "2026-10-03";
    /** This endpoint is not a public, documented API. */
    readonly official: false;
};
/** Alias kept next to the adapter for callers that render the note. */
export declare const CSDN_SOURCE_NOTE: string;
/** CSDN 正文里最多抽取的代码块数量（合并成一条有界摘录）。 */
export declare const CSDN_MAX_CODE_BLOCKS = 3;
/**
 * Browser-like User-Agent. Measured 2026-10-04: an article page answers **HTTP
 * 521** to a request without a browser UA + Referer, and 200 with them. Kept as
 * an exported constant so a test can assert the headers CSDN actually receives.
 */
export declare const CSDN_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** Referer that pairs with the UA above; the search page is the natural origin. */
export declare const CSDN_SEARCH_REFERER = "https://so.csdn.net/";
/** Accept header for the JSON search endpoint. */
export declare const CSDN_SEARCH_ACCEPT = "application/json, text/plain, */*";
/** Accept header for an article page (HTML). */
export declare const CSDN_ARTICLE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
/** CSDN 登录态是 Cookie，不是 Bearer token（见 `csdnRequestHeaders()`）。 */
export declare const CSDN_REQUEST_HEADERS: Readonly<Record<string, string>>;
/** HTTP status CSDN's anti-bot layer answers when UA / Referer are missing. */
export declare const CSDN_ARTICLE_BLOCKED_STATUS = 521;
/** 521 时的中文说明：结论（被反爬拦截）+ 现状（已带 UA/Referer）+ 出路（登录 cookie）。 */
export declare const CSDN_ARTICLE_BLOCKED_NOTE = "\u6587\u7AE0\u9875\u89E6\u53D1 CSDN \u53CD\u722C\uFF08HTTP 521\uFF09\uFF1A\u8BF7\u6C42\u5DF2\u5E26\u6D4F\u89C8\u5668 UA / Referer \u4ECD\u88AB\u62E6\u622A\uFF0C\u7AD9\u70B9\u4F1A\u6309\u9891\u6B21\u4E0E\u6307\u7EB9\u5224\u5B9A\u81EA\u52A8\u6293\u53D6\uFF1B\u5E26\u4E0A\u767B\u5F55 cookie \u53EF\u63D0\u9AD8\u6210\u529F\u7387";
/** 文章页抽到代码时的来源说明（搜索结果本身不带正文）。 */
export declare const CSDN_ARTICLE_CODE_NOTE = "\u4EE3\u7801\u6765\u81EA\u6587\u7AE0\u9875\uFF08so.csdn.net \u7684\u641C\u7D22\u7ED3\u679C\u4E0D\u5E26\u6B63\u6587\uFF09";
/** 文章页 200 但没有可抽代码块时的说明。 */
export declare const CSDN_ARTICLE_NO_CODE_NOTE = "\u6587\u7AE0\u9875\u5DF2\u6253\u5F00\uFF0C\u4F46\u6CA1\u6709\u53EF\u62BD\u53D6\u7684\u4EE3\u7801\u5757";
/**
 * CSDN timestamps arrive as epoch numbers, epoch strings, or Beijing-time
 * strings. Unknown input yields null rather than a fabricated date.
 */
export declare function parseCsdnTime(value: unknown): string | null;
/** Extract the row array from the (non-official) payload. `null` = shape changed. */
export declare function csdnRowsOf(payload: unknown): readonly Record<string, unknown>[] | null;
/** One extracted code block. */
export interface ExtractedCode {
    /** Blocks joined in document order, already bounded by the caller. */
    readonly code: string;
    /** Language of the first block that declared one, else ''. */
    readonly language: string;
    /** How many blocks were found. */
    readonly blocks: number;
}
/**
 * 抽代码块：先 ``` 围栏，再 `<pre>` 区块，最后才退到缩进块。
 * Returns at most `maxBlocks` non-empty blocks, joined in document order.
 */
export declare function extractCodeBlocks(text: string, maxBlocks?: number): ExtractedCode;
/**
 * Search URL. Only these parameters are sent — the extra filter parameters seen
 * in scraping write-ups are deliberately omitted, because this endpoint is not
 * documented and an unverified parameter is worse than a missing one (备注②).
 */
export declare function buildCsdnSearchUrl(query: string, options?: {
    readonly apiBase?: string;
    readonly page?: number;
}): string;
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
export declare function csdnRequestHeaders(opts: AdapterSearchOptions): Record<string, string>;
/**
 * Headers for one article-page request: same UA/Referer/cookie story as the
 * search call, but asking for HTML rather than JSON.
 */
export declare function csdnArticleHeaders(opts: AdapterSearchOptions): Record<string, string>;
/**
 * How many article pages this call may open.
 *
 * `maxDepth` is the caller's budget for the same reason it bounds failover: one
 * number the user already controls. It is read RAW (never through
 * `clampMaxDepth()`, whose missing-value default is 1) because an absent budget
 * must mean **zero** extra requests — a search that silently opens pages the
 * caller did not ask for would be worse than a missing excerpt.
 */
export declare function articlePageBudget(maxDepth: number | undefined): number;
/** One CSDN search. Failures are values; nothing is thrown. */
export declare function searchCsdn(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
/** CSDN 不支持深度阅读：它只作浅搜索补充（不返回任何文件副本）。 */
export declare function csdnDeepRead(_url: string, targets: readonly DeepReadTarget[], _opts: AdapterSearchOptions): Promise<AdapterDeepOutcome>;
/** Adapter factory. `id` is fixed by the contract. */
export declare function createCsdnAdapter(): SourceAdapter;
