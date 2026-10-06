/**
 * dsh-codehub — browser-login (OAuth) flow engine.
 *
 * INTERFACE FROZEN IN PHASE 0 (docs/DESIGN.md §7). Implementations of the
 * stubs below must keep these signatures: `src/routes.ts` and `src/index.ts`
 * wire them, and `test/oauth-flow.test.ts` crosses this same seam with a fake
 * `PostLike`.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * "Click a button, log in in the browser, and end up with a token in the
 * credential service" is three different flows behind one idea:
 *
 *   • GitHub — RFC 8628 device flow: POST /login/device/code, show the user
 *     code, poll POST /login/oauth/access_token. No client secret, but the
 *     user's OAuth App must have Device Flow enabled.
 *   • Gitee — authorization code: redirect the browser to /oauth/authorize,
 *     receive `?code=` on the LOOPBACK callback, exchange it at /oauth/token
 *     with client_id + client_secret. Gitee supports neither device flow nor
 *     PKCE, so a secret is unavoidable — it lives in `ctx.credentials` only.
 *
 * INVARIANTS (asserted by tests, not just documented)
 * ---------------------------------------------------
 * 1. **A credential value never leaves this module.** The only place a token is
 *    handed to is `writeCredential()`; no result object, `reason` string or log
 *    line may contain it. Responses to the browser carry booleans and status
 *    codes only.
 * 2. **No second request after a failed preflight.** If the provider host is
 *    unreachable, `start()` answers `unavailable` and issues nothing else.
 * 3. **Only official hosts.** The injected `post` seam is called with
 *    github.com / gitee.com URLs exclusively; mirrors and third-party forwards
 *    are never used for a credential exchange.
 * 4. **Flow state is memory-only.** No file, no store, no settings namespace:
 *    a flow is a process-local, time-boxed, single-use record. The Gitee client
 *    secret is the one sensitive value that record holds (the callback exchange
 *    happens later, after the browser returns), so it lives exactly as long as
 *    the flow does and dies with it.
 * 5. **`state` is checked.** A callback whose `state` does not match the live
 *    flow is refused (`400`) and writes nothing.
 */
import type { LoginMethodId } from './contract.js';
/** The two sources that have a real OAuth flow. CSDN has none, by design. */
export type OAuthSource = 'github' | 'gitee';
/** Methods this engine implements. `pat` / cookie methods never reach it. */
export type OAuthMethod = Extract<LoginMethodId, 'oauth-device' | 'oauth-code'>;
/**
 * The POST seam, implemented by `net.ts` (`createPostTransport`).
 *
 * It exists because the plugin's ordinary transport is GET-only and the DSH web
 * channel takes a bare `{ url }` — neither can carry a form body or a client
 * secret. This seam is the single exception, and it is deliberately narrow:
 * official hosts only, no mirror routing.
 */
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
/** Everything `start()` may read; no field carries an obtained secret. */
export interface OAuthStartInput {
    readonly source: OAuthSource;
    readonly method: OAuthMethod;
    /** The user's own OAuth App id (config, never a secret). */
    readonly clientId: string;
    /**
     * Gitee only: the secret is resolved by the caller from `ctx.credentials` and
     * handed in for the exchange. It is kept IN MEMORY on the flow record for that
     * flow's lifetime (15 min at most) because the callback exchange happens later,
     * once the browser returns; it is never written to disk, never logged, never
     * echoed, and dropped with the record.
     */
    readonly clientSecret?: string;
    /** Gitee only: must equal the callback URL registered on the app. */
    readonly redirectUri?: string;
    /** Host header of the initiating request, used to derive the default redirect. */
    readonly requestHost?: string;
    readonly signal?: AbortSignal;
}
/** What the browser half needs to render a device-flow prompt. */
export interface OAuthStartDevice {
    readonly ok: true;
    readonly kind: 'device';
    readonly flowId: string;
    /** The 8-character code the user types at `verificationUri`. */
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresInMs: number;
    /** Current poll interval; the UI may show it, the host owns the timing. */
    readonly intervalMs: number;
}
/** What the browser half needs to open an authorization page. */
export interface OAuthStartRedirect {
    readonly ok: true;
    readonly kind: 'redirect';
    readonly flowId: string;
    readonly authorizeUrl: string;
    readonly redirectUri: string;
    readonly expiresInMs: number;
}
export interface OAuthStartUnavailable {
    readonly ok: false;
    readonly reason: string;
    /** Where the user can still get a credential: a guide method or a URL. */
    readonly fallback: readonly string[];
}
export type OAuthStart = OAuthStartDevice | OAuthStartRedirect | OAuthStartUnavailable;
export type OAuthFlowState = 'pending' | 'slow_down' | 'done' | 'expired' | 'error';
export interface OAuthStatus {
    readonly flowId: string;
    readonly state: OAuthFlowState;
    /** True once the credential is confirmed present in the credential service. */
    readonly credentialConfigured: boolean;
    /** Human-readable, value-free explanation of the current state. */
    readonly reason: string;
    readonly intervalMs: number;
}
export interface OAuthComplete {
    readonly ok: boolean;
    readonly credentialConfigured: boolean;
    readonly reason: string;
}
export interface OAuthCallbackOutcome {
    readonly status: number;
    /** A tiny self-closing page; never carries a credential. */
    readonly html: string;
}
/** Injected dependencies — the test seam is exactly this object. */
export interface OAuthDeps {
    readonly post: PostLike;
    /** Writes the obtained value into the credential service, by ref name. */
    readonly writeCredential: (ref: string, value: string) => Promise<void>;
    /** Reads the Gitee client secret (never logged, never returned to the caller). */
    readonly readCredential?: (ref: string) => Promise<string | undefined>;
    /** Ref the obtained credential is stored under (from `service.CREDENTIAL_REFS`). */
    readonly credentialRefFor: (source: OAuthSource) => string;
    /** Reachability preflight for one host; injected so tests need no network. */
    readonly probeHost: (host: string, signal?: AbortSignal) => Promise<{
        reachable: boolean;
        detail: string;
    }>;
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly logger?: (event: string, detail?: Record<string, unknown>) => void;
}
export interface OAuthService {
    start(input: OAuthStartInput): Promise<OAuthStart>;
    status(flowId: string): Promise<OAuthStatus>;
    /** Manual fallback for the authorization-code flow (paste `code` back). */
    completeWithCode(input: {
        readonly code: string;
        readonly clientId: string;
        readonly clientSecret?: string;
        readonly redirectUri: string;
        readonly signal?: AbortSignal;
    }): Promise<OAuthComplete>;
    cancel(flowId: string): void;
    /** The loopback callback handler; validates `state` before doing anything. */
    handleCallback(params: {
        code?: string;
        state?: string;
        error?: string;
    }): Promise<OAuthCallbackOutcome>;
}
/**
 * The default README asks the user to register the loopback callback, so the
 * plugin must build the same absolute URL from the initiating request's Host
 * header when the caller did not pin one.
 */
export declare function defaultRedirectUri(requestHost: string | undefined): string;
/**
 * Phase 0 stub replaced by W1: the real device-flow / authorization-code state
 * machines. Signatures and invariants above are what is fixed.
 */
export declare function createOAuthService(deps: OAuthDeps): OAuthService;
