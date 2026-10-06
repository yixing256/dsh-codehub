/**
 * dsh-codehub — unified network egress.
 *
 * Every byte this plugin sends to the outside world leaves through
 * `createTransport()`. Nothing else in `src/` may call `fetch` (docs/DESIGN.md
 * §5: adapters receive a `Transport` and have no other way out).
 *
 * ── 备注① — the local proxy applies ONLY on the `node` transport ─────────────
 *
 * There are exactly two channels:
 *
 *   | transport | implementation                | steerable by a proxy address |
 *   |-----------|-------------------------------|------------------------------|
 *   | `dsh-web` | the harness web service       | NO — the harness owns egress |
 *   | `node`    | this process's own HTTP client| YES                          |
 *
 * `planRequest()` therefore decides the channel AND whether the configured
 * proxy can be honoured, and whenever a configured setting is deliberately not
 * applied it emits a `reason`/`notes` sentence containing
 * `LOCAL_PROXY_SCOPE_NOTE` (仅 Node 直连传输生效). Those notes ride out on the
 * `TransportResponse` (`note` + `notes`) and are copied verbatim into the
 * adapter's `reason` — and on a thrown failure the same sentence is appended to
 * the error message. A sentence the user needs must never be swallowed.
 *
 * ── Failure taxonomy ────────────────────────────────────────────────────────
 *
 * The transport resolves for EVERY HTTP status code (2xx..5xx). Classifying an
 * HTTP answer is the adapter's job (`failureFromResponse()`), because it can
 * read the body. The transport throws `TransportError` only when no HTTP answer
 * exists at all — DNS/TCP/TLS/proxy-handshake failures, timeouts, cancellation —
 * plus the local misconfiguration cases in `planRequest().blocked`.
 *
 * `kind` and `failure` are BOTH set on the error, both are `FailureKind` values,
 * so either downstream convention works.
 *
 * ── Status precedence (documented, because two rules overlap) ───────────────
 *
 *   401            -> auth-required   (a credential is missing or invalid)
 *   403            -> rate-limited    (GitHub answers 403 for anonymous quota
 *                                      exhaustion; a token hint is attached
 *                                      separately by `classifyStatusHint`)
 *   429            -> rate-limited
 *   408            -> timeout
 *   404 / 410      -> not-code
 *   5xx            -> network
 *   other 4xx      -> parse-failed
 *   1xx / 2xx      -> undefined (no failure)
 *   3xx            -> empty (a redirect neither channel could follow carries
 *                            no data; both channels DO follow redirects when
 *                            they can, so reaching here means the chain ended)
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────
 *
 * Token values, cookie headers and proxy addresses must never reach a log line,
 * an error message or a response body. Two mechanisms enforce it: `scrubSecrets`
 * is applied to every message and log payload, and `redactAddress` /
 * `redactCredential` are the only way these modules render a sensitive value.
 * Request HEADERS are never logged at all (a CSDN cookie rides in one).
 */
import type { FailureKind, GithubAccessId, TransportId } from './contract.js';
import type { Transport } from './sources/types.js';
import type { WebService } from '@deepseek-ai/dsh-web';
/** Redirect hops followed on the hand-rolled proxy path (never on `fetch`). */
export declare const MAX_REDIRECTS = 3;
/** Handshake responses larger than this are treated as a broken proxy. */
export declare const MAX_HANDSHAKE_BYTES: number;
export type TransportLogger = (event: string, detail?: Record<string, unknown>) => void;
/**
 * Replace every credential-shaped substring with `****`.
 *
 * Rule order matters: the auth-scheme rule runs FIRST so the whole
 * `Bearer <value>` pair is consumed before the key/value rule can match the
 * keyword alone and strand the value. Sharing these `/g` literals between calls
 * is safe — `String.prototype.replace` resets `lastIndex` for a global regexp.
 */
export declare function scrubSecrets(text: string): string;
/** `socks5://user:pass@127.0.0.1:7890` -> `socks5://127.0.0.1:****`. */
export declare function redactAddress(value: unknown): string;
/** Credentials are rendered as a state, never as a value or a length. */
export declare function redactCredential(value: unknown): string;
/** A loggable URL label: scheme + host + path. No query, no userinfo. */
export declare function safeUrlLabel(value: string): string;
/**
 * Console logger.
 *
 * The shim exposes no `ctx.logger` (types/dsh/index.d.ts lists the observed
 * `Context` surface: `effect` / `get` / `inject` / `on`), and reaching for an
 * un-injected service property throws — so `console` it is. Every payload is
 * scrubbed, and the happy path logs nothing at all.
 */
export declare function createConsoleLogger(prefix?: string): TransportLogger;
/**
 * A failure with no HTTP answer behind it.
 *
 * `name` mirrors the cause (`AbortError` / `TimeoutError`) when there is one, so
 * a downstream `err.name === 'AbortError'` check keeps working even without
 * reading `kind`.
 */
export declare class TransportError extends Error {
    readonly kind: FailureKind;
    readonly failure: FailureKind;
    readonly statusCode?: number;
    constructor(kind: FailureKind, message: string, options?: {
        statusCode?: number;
        cause?: unknown;
        name?: string;
    });
}
/**
 * Map an HTTP status onto the taxonomy. See the precedence table in the header.
 *
 * `hasToken` is part of the signature (the token policy and the caller both know
 * it) but does NOT change the classification: a 403 is the anonymous-quota
 * answer on GitHub, so it is `rate-limited` whether or not a credential rode
 * along. The credential hint is a separate sentence — `classifyStatusHint()` —
 * because one FailureKind cannot carry two meanings.
 */
export declare function classifyStatus(statusCode: number, hasToken: boolean): FailureKind | undefined;
/**
 * A second sentence for the `reason` when a status has a secondary meaning.
 * `403` without a credential is usually the anonymous quota: saying so is the
 * difference between "wait an hour" and "add a token".
 */
export declare function classifyStatusHint(statusCode: number, hasToken: boolean): string | undefined;
/** Classify anything thrown by a socket / fetch / proxy handshake. */
export declare function classifyThrown(error: unknown): FailureKind;
/**
 * Kinds worth re-issuing the SAME request for, derived from the contract.
 *
 * `auth-required` is subtracted on purpose: retrying cannot conjure a
 * credential, and spending the retry budget on it only delays the failover
 * chain, which is the layer that owns that case.
 */
export declare const TRANSPORT_RETRY_KINDS: readonly FailureKind[];
export declare function isTransportRetryable(kind: FailureKind): boolean;
/** Transient HTTP answers the transport may re-issue by itself. */
export declare function shouldRetryStatus(statusCode: number): boolean;
export declare function clampRetries(value: unknown): number;
export declare function clampTimeoutMs(value: unknown): number;
/** Wrap anything thrown into a `TransportError`, keeping 备注① wording. */
export declare function toTransportError(error: unknown, context?: {
    readonly reason?: string | undefined;
}): TransportError;
/**
 * `AbortSignal.any([...])` over the signals that actually exist.
 *
 * `exec.signal` is optional in `ToolExecutionInput`, and passing `undefined`
 * into `AbortSignal.any` throws, so the list is filtered first. A manual
 * controller stands in for runtimes without `any` (Node < 20.3), which keeps
 * the composed timeout working instead of silently dropping it.
 */
export declare function composeSignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined;
/** `AbortSignal.timeout(ms)`, with a manual fallback. */
export declare function timeoutSignal(timeoutMs: number): AbortSignal;
export interface ProxySpec {
    readonly scheme: 'http' | 'https' | 'socks5' | 'socks4';
    readonly host: string;
    readonly port: number;
    /** `user:pass` when the configured address carried userinfo. Never logged. */
    readonly auth?: string;
    /** The configured text, for `redactAddress()` and diagnostics only. */
    readonly raw: string;
}
/**
 * Parse `127.0.0.1:7890`, `http://host:port`, `socks5://user:pass@host:port`.
 *
 * A bare `host:port` is read as an HTTP proxy, which is what Clash / V2Ray /
 * Watt expose by default. Returns `undefined` for anything unparseable;
 * `planRequest()` then REFUSES the request rather than guessing — a configured
 * proxy that silently fails open would send traffic the user meant to tunnel.
 */
export declare function parseProxyAddress(value: unknown): ProxySpec | undefined;
/** SOCKS4 is parsed (so it can be reported) but not implemented. */
export declare function proxySupport(spec: ProxySpec): {
    readonly supported: boolean;
    readonly reason?: string;
};
export interface PlanInput {
    readonly url: string;
    readonly token?: string | undefined;
    readonly headers?: Record<string, string> | undefined;
    /** Caller preference. Omitted = the planner picks (dsh-web first). */
    readonly transport?: TransportId | undefined;
    readonly access?: GithubAccessId | undefined;
    readonly localProxy?: string | undefined;
    readonly hasWebService?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
}
export interface TransportPlan {
    readonly url: string;
    readonly transport: TransportId;
    readonly timeoutMs: number;
    readonly headers: Record<string, string>;
    readonly token?: string;
    readonly tokenStripped: boolean;
    readonly proxy?: ProxySpec;
    readonly proxyConfigured: boolean;
    /** True only on the `node` channel — 备注①. */
    readonly proxyApplied: boolean;
    /**
     * True when the header rule (not the token or the proxy) is what moved this
     * request off the harness channel. The transport uses it for the ONE thing it
     * is allowed to do about a node-channel failure: fall back to `dsh-web` and
     * say out loud that the headers were dropped.
     */
    readonly headersForcedNode: boolean;
    /** The sentence explaining any setting that was NOT applied. */
    readonly reason?: string;
    readonly notes: readonly string[];
    /** True when local configuration makes the request impossible (no silent bypass). */
    readonly blocked: boolean;
}
/**
 * Decide the channel, the token policy and the proxy application for one request.
 *
 * Order of operations:
 *   1. **Token policy re-check.** `TOKEN_FORBIDDEN_ACCESS` strategies lose the
 *      token HERE, at request-build time, even if a caller already stripped it.
 *      Handing a long-lived credential to a third-party relay is a leak, not a
 *      tradeoff.
 *   2. **Channel choice.** A caller-provided `transport` wins. Otherwise
 *      `dsh-web` is preferred when the harness web service exists and no proxy
 *      is configured; a configured proxy (or a credential) forces `node`,
 *      because that is the only channel either can use.
 *   3. **Proxy application.** `node` -> applied. `dsh-web` -> explicitly NOT
 *      applied, with a 备注① sentence in `reason` + `notes`.
 */
export declare function planRequest(input: PlanInput): TransportPlan;
export interface FetchInit {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    /** Request body. Added for the OAuth POST seam; the GET paths never set it. */
    readonly body?: string;
    readonly signal?: AbortSignal;
    readonly redirect?: 'follow' | 'manual' | 'error';
}
export interface FetchLikeResponse {
    readonly status: number;
    readonly url?: string;
    text(): Promise<string>;
}
/** Structural view of global fetch — lets tests inject a fake without a network. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchLikeResponse>;
/**
 * Can THIS process open its own connection (the `node` channel)?
 *
 * `planRequest()` is pure apart from this check, and it needs the answer for one
 * decision: a request that carries headers cannot use the harness channel (which
 * accepts `{ url }` only). When there is no local `fetch` the request still goes
 * out — over the harness channel, with its headers dropped — and the `reason`
 * says so instead of failing silently.
 */
export declare function nodeChannelAvailable(): boolean;
export interface TransportDeps {
    /** Force a channel. Omitted = the planner decides per request. */
    readonly transport?: TransportId | undefined;
    /** Access strategy in force; drives the token policy. */
    readonly access?: GithubAccessId | undefined;
    /** 备注① value. Applied on `node` only. */
    readonly localProxy?: string | undefined;
    readonly retries?: number | undefined;
    readonly timeoutMs?: number | undefined;
    /** `ctx.get('web')` — optional dependency, may be absent. */
    readonly web?: WebService | undefined;
    /** Test seam. Defaults to global fetch. */
    readonly fetchImpl?: FetchLike | undefined;
    readonly logger?: TransportLogger | undefined;
}
/**
 * Build the one `Transport` the adapters receive.
 *
 * Retries live in a bounded `for` loop (no recursion, so no depth to exhaust):
 * they apply to thrown `network` / `timeout` failures and to the transient HTTP
 * statuses in `shouldRetryStatus()`, never to `auth-required`. The budget comes
 * from `limits.retries`, clamped by `HARD_LIMITS.retries`.
 *
 * CHANNEL FALLBACK (task requirement: 默认优先 dsh-web，不可用时回退 node): when
 * the harness web service exists but the request dies at the network layer, the
 * transport re-plans onto the `node` channel ONCE. That re-plan matters — it
 * re-runs the 备注① logic, so if a local proxy is configured it is actually
 * applied on the channel that can honour it, instead of being silently ignored.
 * A caller that pinned `deps.transport` explicitly is never second-guessed.
 */
export declare function createTransport(deps?: TransportDeps): Transport;
/** Note attached when the harness channel is abandoned for the node channel. */
export declare const WEB_CHANNEL_FALLBACK_NOTE = "DSH \u81EA\u5E26 web \u901A\u9053\u8BF7\u6C42\u5931\u8D25\uFF08network\uFF09\uFF0C\u5DF2\u56DE\u9000\u5230 Node \u76F4\u8FDE\u4F20\u8F93\u91CD\u8BD5\u4E00\u6B21\uFF1B\u672C\u673A\u4EE3\u7406\u82E5\u5DF2\u914D\u7F6E\uFF0C\u5C06\u5728\u8BE5\u901A\u9053\u4E0A\u751F\u6548\u3002";
/** Note attached when a header-carrying request loses its headers on `dsh-web`. */
export declare const WEB_CHANNEL_HEADER_LOSS_NOTE = "Node \u76F4\u8FDE\u4F20\u8F93\u4E0D\u53EF\u7528\uFF08network\uFF09\uFF0C\u5DF2\u56DE\u9000\u5230 DSH \u81EA\u5E26 web \u901A\u9053\u91CD\u8BD5\u4E00\u6B21\uFF1A\u8BE5\u901A\u9053\u53EA\u63A5\u6536 { url }\uFF0C\u672C\u6B21\u8BF7\u6C42\u5934\uFF08User-Agent / Referer \u7B49\uFF09\u4F1A\u88AB\u4E22\u5F03\uFF0CCSDN \u6587\u7AE0\u9875\u53EF\u80FD\u88AB HTTP 521 \u53CD\u722C\u62E6\u622A\u3002";
/**
 * The official hosts (and their subdomains) the POST seam may talk to.
 *
 * `github.com` / `gitee.com` are the OAuth hosts; `api.` / `login.` / `oauth.`
 * only ever appear as SUBDOMAINS or paths of those two, so a suffix match is the
 * correct test — and it is checked before any socket is opened.
 */
export declare const POST_ALLOWED_HOSTS: readonly string[];
/** One form POST as `src/oauth.ts` needs it. Shape frozen in Phase 0. */
export interface PostRequest {
    readonly url: string;
    readonly form: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    /** Local proxy address (备注①), applied only on the node channel. */
    readonly proxy?: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}
export interface PostResponse {
    readonly statusCode: number;
    readonly body: string;
}
export type PostLike = (request: PostRequest) => Promise<PostResponse>;
/** True when `host` is one of the official provider hosts (or a subdomain). */
export declare function isOfficialPostHost(host: string): boolean;
/**
 * Build the OAuth POST transport.
 *
 * `deps.localProxy` is read on EVERY request rather than captured, so a getter
 * (or a later edit of the object) is honoured: the proxy address is a live user
 * setting, and pinning a stale snapshot here would send a credential exchange
 * outside the tunnel the user asked for.
 */
export declare function createPostTransport(deps?: {
    fetchImpl?: FetchLike;
    localProxy?: string;
}): PostLike;
