/**
 * dsh-codehub — source-adapter surface.
 *
 * OWNER: `adapters`. Consumers: the host half (`src/net.ts`, `src/tool.ts`)
 * builds `AdapterSearchOptions`; the three source adapters return
 * `AdapterOutcome` / `AdapterDeepOutcome`.
 *
 * Three rules are encoded here rather than left to convention:
 *
 * 1. 备注① — an adapter performs NO network I/O of its own. Every request goes
 *    through the injected `Transport`. Whatever note the transport attaches
 *    (for example `LOCAL_PROXY_SCOPE_NOTE` — 仅 Node 直连传输生效) is collected
 *    by `transportNotes()` and copied into `reason` verbatim by `joinReason()`.
 *    It is never replaced by a generic message.
 * 2. Failures are values, not thrown exceptions. Every adapter failure maps to
 *    exactly one `FailureKind`, because `degrade.ts` decides whether to advance
 *    a chain from that value alone.
 * 3. Endpoint literals live in `contract.ts` only. This file imports them; it
 *    never re-spells a URL.
 */
import type { CodeLearnResult, Confidence, DeepReadTarget, FailureKind, GithubAccessId, LearnNote, SourceId, TransportId } from '../contract.js';
/** One request as an adapter asks the host to issue it. Mirrors `src/net.ts`. */
export interface TransportRequest {
    url: string;
    headers?: Record<string, string>;
    /** 仅当策略允许时携带；镜像路径必须为 undefined */
    token?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}
/** One answer from the transport. Extra fields are optional so a 3-field impl still fits. */
export interface TransportResponse {
    statusCode: number;
    body: string;
    finalUrl: string;
    /**
     * Optional transport provenance note (备注①). When `src/net.ts` reports that
     * something like the local proxy only applies to the `node` channel, it lands
     * here and the adapters copy it into `reason` unchanged.
     */
    note?: string;
    /** Several transport notes, in order. Merged with `note` by `transportNotes()`. */
    notes?: readonly string[];
}
/** Injected egress. Adapters never import a fetch implementation. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
/** Per-request timeout, clamped into `(0, HARD_LIMITS.timeoutMs]`. */
export declare function clampTimeout(timeoutMs: number | undefined): number;
/** Row bound, clamped into `[1, HARD_LIMITS.maxItems]`. */
export declare function clampMaxItems(maxItems: number | undefined): number;
/** Excerpt bound, clamped into `[1, HARD_LIMITS.maxCodeChars]`. */
export declare function clampMaxCodeChars(maxCodeChars: number | undefined): number;
/**
 * Failover depth budget, clamped into `[0, HARD_LIMITS.maxDepth]`.
 *
 * Depth counts *extra* rungs, so `maxDepth: 1` permits the primary plus one
 * fallback. `0` forbids any fallback.
 */
export declare function clampMaxDepth(maxDepth: number | undefined): number;
/** Everything one adapter call needs. The adapter performs no I/O outside `transport`. */
export interface AdapterSearchOptions {
    /** 备注①: injected egress. Required — an adapter has no other way out. */
    transport: Transport;
    /** Per-request timeout; clamped by `clampTimeout()`. */
    timeoutMs?: number;
    /** Row bound; clamped by `clampMaxItems()`. */
    maxItems?: number;
    /**
     * How many times the caller permits re-issuing the *same* request. Adapters
     * issue each request exactly once and let `degrade.ts` own the chain, so this
     * value is echoed into `reason` (and into failover plans) rather than honoured
     * here — that keeps retries from being counted twice.
     */
    retries?: number;
    /** Credential for this call. Mirrors must never receive it — see `tokenForAccess()`. */
    token?: string;
    /** Whether this call is authenticated (drives `score.ts`). */
    authenticated?: boolean;
    /** GitHub access strategy: decides token carriage and mirror-vs-official base. */
    access?: GithubAccessId;
    /** Which transport the caller used. Informational only (备注① reasons). */
    transportId?: TransportId;
    /**
     * API base override for whichever endpoint this adapter talks to. Defaults:
     * `GITHUB_API_BASE` (github), `GITEE_API_BASE` (gitee), `CSDN_SEARCH_BASE` (csdn).
     */
    apiBase?: string;
    /**
     * GitHub raw-file base list, tried in order until one answers. Each entry is
     * either a prefix (`https://ghproxy.net/https://raw.githubusercontent.com`)
     * or a `{url}` template. Tokens are never attached on this path.
     */
    rawMirrors?: readonly string[];
    /** Allow the HTML-page fallback when the JSON endpoint answers empty (gitee/csdn). */
    htmlFallback?: boolean;
    /**
     * Opt-in article-page completion (CSDN only).
     *
     * Measured 2026-10-04: `so.csdn.net`'s search payload carries a usable body
     * for only 6 of 30 rows, so a hit can be real while its code is missing. When
     * this is true the adapter may fetch the hit's own article page once to
     * extract the code there. `undefined` means false, which keeps every existing
     * caller on the old, network-cheaper path.
     */
    articleFetch?: boolean;
    /**
     * Failover depth budget for this call; clamped by `clampMaxDepth()`.
     *
     * CSDN additionally reads it as the **article-page count budget** for
     * `articleFetch` (see above). That path uses the RAW value, not
     * `clampMaxDepth()`: a missing value must mean 0 pages, whereas
     * `clampMaxDepth(undefined)` supplies a failover default of 1.
     */
    maxDepth?: number;
    /** Cancellation for the whole call. */
    signal?: AbortSignal;
    /** Bound on the `code` excerpt; clamped by `clampMaxCodeChars()`. */
    maxCodeChars?: number;
}
/** One request an adapter actually made, for the reason string and for tests. */
export interface AdapterAttempt {
    /** URL as requested, after mirror / template expansion. */
    readonly url: string;
    /** HTTP status, or null when the request threw before answering. */
    readonly statusCode: number | null;
    /** Set when this attempt failed. */
    readonly failure?: FailureKind;
    /** Verbatim per-attempt note, including transport notes (备注①). */
    readonly note?: string;
}
/** What a single `search()` call produced. */
export interface AdapterOutcome {
    /** True iff `failure` is undefined and at least one row survived. */
    readonly ok: boolean;
    /** Rows ready for scoring / redaction. Never a verbatim file copy (备注③). */
    readonly results: CodeLearnResult[];
    /** Why this outcome looks the way it does; transport notes survive verbatim. */
    readonly reason: string;
    /** Exactly one classification when the call produced no usable rows. */
    readonly failure?: FailureKind;
    /** Every request made, in order. */
    readonly attempts?: readonly AdapterAttempt[];
    /** True when rows were dropped because of the `maxItems` bound. */
    readonly truncated?: boolean;
}
/** What a `deepRead()` call produced: notes, never files (备注③). */
export interface AdapterDeepOutcome {
    /** Distilled approach / contract / tradeoffs / pitfalls. Never a file copy. */
    readonly notes: LearnNote[];
    readonly reason: string;
    readonly failure?: FailureKind;
    /** Files actually read while distilling. */
    readonly fetchedUrls?: readonly string[];
    /** Requested targets that yielded nothing usable. */
    readonly skipped?: readonly DeepReadTarget[];
    readonly attempts?: readonly AdapterAttempt[];
}
/** The four factors `score.ts` weighs, plus verbatim notes. */
export interface ScoreInput {
    readonly source: SourceId;
    /** The call was authenticated for this source. */
    readonly authenticated: boolean;
    /** The item is marked as a repost (`originalType !== '原创'`). */
    readonly reposted: boolean;
    /** 0..1 — how much of the expected payload parsed into usable fields. */
    readonly completeness: number;
    /** Extra clauses copied verbatim into `reason`, e.g. the transport scope note. */
    readonly notes?: readonly string[];
}
/** One scored row: the level plus the single-sentence justification. */
export interface Score {
    readonly confidence: Confidence;
    readonly reason: string;
}
export interface SourceAdapter {
    readonly id: SourceId;
    /** 单次搜索。失败必须归类到 FailureKind，不要抛裸异常。 */
    search(query: string, opts: AdapterSearchOptions): Promise<AdapterOutcome>;
    /** 仅 github/gitee 支持；csdn 返回 not-code。 */
    deepRead?(url: string, targets: readonly DeepReadTarget[], opts: AdapterSearchOptions): Promise<AdapterDeepOutcome>;
}
/** Join reason clauses with `；`, dropping empties. Order is preserved. */
export declare function joinReason(...parts: readonly (string | undefined | null)[]): string;
/** Narrow an unknown value to a `FailureKind`. */
export declare function isFailureKind(value: unknown): value is FailureKind;
/** Like `joinReason()`, but yields `undefined` when nothing survives. */
export declare function optionalReason(...parts: readonly (string | undefined | null)[]): string | undefined;
/** Only failures in `RETRYABLE_FAILURES` may advance a failover chain. */
export declare function isRetryableFailure(failure: FailureKind | undefined): boolean;
/** A classified failure: the taxonomy value plus the human sentence. */
export interface ClassifiedFailure {
    readonly failure: FailureKind;
    readonly reason: string;
}
/** Collect transport notes (备注①) in order, `note` first, then `notes`. */
export declare function transportNotes(res: TransportResponse | undefined | null): string[];
/**
 * Map a thrown transport error onto one `FailureKind`.
 *
 * The transport's own wording is kept verbatim (备注①): `src/net.ts` may explain
 * that a setting only applies to the node channel, and that sentence must reach
 * the agent unchanged. A pre-classified `failure` / `kind` property on the error
 * is honoured when present.
 */
export declare function classifyTransportError(err: unknown): ClassifiedFailure;
/**
 * Classify a non-2xx `TransportResponse`. Returns null for 2xx so callers can
 * proceed to parse. `what` is the human subject, e.g. `GitHub 仓库搜索`.
 */
export declare function failureFromResponse(res: TransportResponse, what: string): ClassifiedFailure | null;
/**
 * Token carriage gate. Mirrors listed in `TOKEN_FORBIDDEN_ACCESS` (ghproxy,
 * raw-mirror, third-party-mirror) must never see a credential, so this returns
 * undefined for them even when the caller passed a token.
 */
export declare function tokenForAccess(access: GithubAccessId | undefined, token: string | undefined): string | undefined;
/** Truncate an excerpt to `limit` chars and report whether anything was cut. */
export declare function boundExcerpt(text: string, limit: number): {
    readonly code: string;
    readonly codeTruncated: boolean;
};
/** Standard `not-code` answer used by adapters that cannot serve a request. */
export declare function notCodeOutcome(reason: string): AdapterOutcome;
