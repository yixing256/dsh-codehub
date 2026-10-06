/**
 * dsh-codehub — the `codeSource` host service and the unified delivery outlet.
 *
 * This is the only place the plugin orchestrates: 决策门禁 -> 按 sourcePriority
 * 逐源查询 -> 失败降级（需用户已同意）-> 合并去重 -> 深度阅读 -> redactForDelivery.
 *
 * TWO INVARIANTS WORTH THE READING TIME
 * -------------------------------------
 * 1. **The decision gate runs before anything else.** `search()` checks
 *    `evaluateDecisions(config)` and returns early; on that path no adapter is
 *    constructed and no `Transport` is built, so "未决策" costs exactly zero
 *    network requests. That ordering is the requirement — not "ask after
 *    looking".
 * 2. **Every row leaves through `redactForDelivery()`.** It is the single
 *    outlet: it bounds `code`, marks `codeTruncated`, stamps the learning-only
 *    banner INTO the excerpt, validates `confidence`, and writes
 *    `is_verbatim_copy: false` — literally the only value the type permits.
 *    Nothing else in this file may construct a `CodeLearnResult` for delivery.
 *
 * On optional services: `credentials` and `web` are reached with `ctx.get()` and
 * a `undefined` check. Property access on an un-injected service throws on this
 * runtime, and a throw during mount can take the whole plugin install down.
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { WebService } from '@deepseek-ai/dsh-web';
import type { CodeLearnResult, DeepReadTarget, FailureKind, GithubAccessId, LearnNote, LoginMethodId, LoginGuide, SourceId, TransportId, UnresolvedDecision } from './contract.js';
import { type CodehubConfig, type ConfigJsonView, type CredentialTarget, type ResolvedConfig, type ResolvedLimits } from './config.js';
import { type TransportDeps, type TransportLogger } from './net.js';
import type { LocalConfigStore } from './store.js';
import type { SettingsBridge } from './settings.js';
import type { SourceAdapter, Transport } from './sources/types.js';
/**
 * The three credential references (docs/DESIGN.md §4).
 *
 * A `CredentialRef` is a plain string that doubles as an environment-variable
 * name, which is why these match `.env.example` exactly. The VALUE never enters
 * this module's state: it is fetched per call, handed to the adapter, and
 * dropped when the call returns.
 */
export declare const CREDENTIAL_REFS: {
    readonly github: "DSH_CODEHUB_GITHUB_TOKEN";
    readonly gitee: "DSH_CODEHUB_GITEE_TOKEN";
    readonly csdn: "DSH_CODEHUB_CSDN_COOKIE";
};
/** Operator-facing note for the mirror strategies. */
export declare const MIRROR_TOKEN_NOTE = "\u955C\u50CF / \u7B2C\u4E09\u65B9\u8F6C\u53D1\u8DEF\u5F84\u5728\u6784\u9020\u8BF7\u6C42\u65F6\u5F3A\u5236\u5265\u79BB token\uFF08TOKEN_FORBIDDEN_ACCESS\uFF09\u3002";
export interface SearchOptions {
    /** Restrict/order the sources for this call. Omitted = `config.sourcePriority`. */
    readonly sources?: readonly SourceId[] | undefined;
    readonly deepRead?: boolean | undefined;
    readonly maxItems?: number | undefined;
    readonly signal?: AbortSignal | undefined;
}
/** One source that did not answer usefully. */
export interface SourceFailure {
    readonly source: SourceId;
    readonly kind: FailureKind;
    readonly reason: string;
}
/** The value the tool returns and the route serialises. */
export interface SearchOutcome {
    readonly ok: boolean;
    readonly query: string;
    readonly results: readonly CodeLearnResult[];
    /** Deep-read notes. Notes, never files (备注③). */
    readonly notes: readonly LearnNote[];
    readonly failures: readonly SourceFailure[];
    readonly unresolved_decisions: readonly UnresolvedDecision[];
    readonly ask_user: string;
    readonly reason: string;
    /** True when a source failed and the chain moved on because the user allowed it. */
    readonly degraded: boolean;
    /** True when several sources were merged and de-duplicated. */
    readonly merged: boolean;
    readonly sources_queried: readonly SourceId[];
    readonly deep_read: boolean;
}
export interface ConfigView {
    readonly ok: true;
    readonly config: ConfigJsonView;
    readonly decisions: readonly UnresolvedDecision[];
    readonly decided: boolean;
    readonly credentials: Readonly<Record<CredentialTarget, boolean>>;
    readonly limits: ResolvedLimits;
    readonly transport: {
        readonly webAvailable: boolean;
        readonly proxyConfigured: boolean;
        readonly proxyScopeNote: string;
    };
    readonly notes: {
        readonly csdn: string;
        readonly localProxy: string;
        readonly antiCopy: string;
        readonly settings: string;
    };
    readonly paths: {
        readonly store: string;
    };
    readonly login: ConfigLoginView;
}
/** Login state for the wizard. Booleans and contract copy only — never a value. */
export interface ConfigLoginView {
    readonly requirements: Readonly<Record<SourceId, string>>;
    readonly oauth: {
        readonly github: boolean;
        readonly gitee: boolean;
    };
    readonly guides: Readonly<Record<LoginMethodId, LoginGuide>>;
}
/** One connectivity probe produced by the manual `smoke` action. */
export interface SmokeProbe {
    readonly source: SourceId;
    readonly label: string;
    readonly ok: boolean;
    readonly statusCode: number | null;
    readonly failure?: FailureKind;
    readonly latencyMs: number;
    readonly transport: TransportId;
    readonly reason: string;
}
export interface SmokeReport {
    readonly ok: boolean;
    readonly probes: readonly SmokeProbe[];
    readonly notes: readonly string[];
    /**
     * The anonymous per-operation capability picture, i.e. the answer to "does
     * querying CODE need a login?" (docs/DESIGN.md §7.1). It is the same report
     * `POST /api/dsh-codehub/probe` produces, reused rather than re-derived — the
     * connectivity panel and the wizard must not be able to disagree.
     */
    readonly capabilities: readonly SourceRequirementReport[];
}
/** One thing a source can be asked to do, as the connectivity panel names it. */
export declare const SOURCE_OPERATIONS: readonly ["repo-search", "code-search", "file-read", "article-read"];
export type SourceOperationId = (typeof SOURCE_OPERATIONS)[number];
/** Which operations make sense for which source. */
export declare const OPERATIONS_BY_SOURCE: Readonly<Record<SourceId, readonly SourceOperationId[]>>;
/**
 * The one operation a `smoke()` probe actually exercised.
 *
 * `smoke()` calls each adapter's `search()`: for GitHub and Gitee that is the
 * repository search, for CSDN its search API. Naming it honestly is what keeps
 * the derived capability row from claiming to have measured code search.
 */
export declare const PRIMARY_SMOKE_OPERATION: Readonly<Record<SourceId, SourceOperationId>>;
/**
 * Turn a self-check probe into the capability row the panel renders.
 *
 * Kept as a pure function so the derivation is testable without a service, and
 * so the one thing that matters stays visible: `requiresLogin` is the contract
 * baseline plus the live 401, never a guess.
 */
export declare function capabilityFromSmokeProbe(probe: SmokeProbe, probedAt: string): SourceRequirementReport;
/**
 * One measured operation. Exactly the field names DESIGN §7.5 whitelists for
 * `/probe` (plus the `operation` identity), and no credential can reach any of
 * them: `evidence` is built from contract copy and a status code.
 */
export interface SourceRequirementCheck {
    readonly operation: SourceOperationId;
    readonly reachable: boolean;
    /** `null` when the request never got an HTTP answer. */
    readonly statusCode: number | null;
    readonly requiresLogin: boolean;
    readonly evidence: string;
    readonly probedAt: string;
}
/** What one source looks like right now, anonymously unless asked otherwise. */
export interface SourceRequirementReport {
    readonly source: SourceId;
    readonly label: string;
    readonly probedAt: string;
    /** True when a stored credential rode along (`useStoredCredential`). */
    readonly authenticated: boolean;
    readonly operations: readonly SourceRequirementCheck[];
}
/**
 * How a credential check ended.
 *
 * `valid` / `invalid` come from an endpoint that really authenticates the caller
 * (GitHub and Gitee both have one). `improved` / `unchanged` / `rejected` come
 * from CSDN, which has NO validation endpoint at all — the honest answer there
 * is a comparison, not a verdict.
 */
export type CredentialVerdict = 'valid' | 'invalid' | 'unknown' | 'improved' | 'unchanged' | 'rejected';
export interface CredentialValidation {
    readonly source: SourceId;
    readonly verdict: CredentialVerdict;
    readonly statusCode: number | null;
    /**
     * The caller's OWN identity (`login`, or `name` when there is no `login`).
     * Allowed to be echoed back: it is who the user is, not what they hold.
     */
    readonly account: string | null;
    readonly reason: string;
}
/** The query the probes use. One word, no user data, cheapest possible answer. */
export declare const PROBE_QUERY = "vue";
/** Probes are diagnostics: they must answer fast, so they get their own budget. */
export declare const PROBE_TIMEOUT_MS = 8000;
export interface ConfigView {
    readonly ok: true;
    readonly config: ConfigJsonView;
    readonly decisions: readonly UnresolvedDecision[];
    readonly decided: boolean;
    readonly credentials: Readonly<Record<CredentialTarget, boolean>>;
    readonly limits: ResolvedLimits;
    readonly transport: {
        readonly webAvailable: boolean;
        readonly proxyConfigured: boolean;
        readonly proxyScopeNote: string;
    };
    readonly notes: {
        readonly csdn: string;
        readonly localProxy: string;
        readonly antiCopy: string;
        readonly settings: string;
    };
    readonly paths: {
        readonly store: string;
    };
    /**
     * Login state for the wizard: which methods each source has, whether this
     * plugin is able to drive a browser flow at all, and the hand-held guides.
     *
     * BOOLEANS AND CONTRACT COPY ONLY. `oauth.github` / `oauth.gitee` answer "is
     * there a client id (and, for Gitee, a client secret in the credential
     * service)" — never the id or the secret itself.
     */
    readonly login: ConfigLoginView;
}
/** Injection points. Everything has a production default; tests override. */
export interface CodeSourceDeps {
    /** The live config. Re-read on every call so a settings change is picked up. */
    readonly getConfig: () => CodehubConfig;
    /** Local store (fallback snapshot + proxy address). */
    readonly store: LocalConfigStore;
    readonly settings?: SettingsBridge | undefined;
    /** `ctx.get('web')` — optional dependency. */
    readonly web?: WebService | undefined;
    readonly logger?: TransportLogger | undefined;
    /** Test seam; defaults to `net.createTransport`. */
    readonly createTransport?: ((deps: TransportDeps) => Transport) | undefined;
    /** Test seam; defaults to the three real adapter factories. */
    readonly adapters?: readonly SourceAdapter[] | undefined;
}
export interface RedactLimits {
    readonly maxCodeChars?: number | undefined;
}
/**
 * THE delivery outlet: truncate + banner + confidence + `is_verbatim_copy: false`.
 *
 * Accepts one row or an array (both are used: `service.search` redacts the whole
 * batch, routes and tests redact a single row).
 *
 * The banner is written as the FIRST LINE OF `code` rather than only into a
 * wrapper field, because `code` is the thing a reader is tempted to copy. A
 * bounded excerpt therefore cannot be lifted out of the delivery without the
 * 仅学习参考 warning travelling with it. The banner is charged against
 * `maxCodeChars`, so the exported excerpt never exceeds the configured bound.
 */
export declare function redactForDelivery(result: CodeLearnResult, limits?: RedactLimits): CodeLearnResult;
export declare function redactForDelivery(results: readonly CodeLearnResult[], limits?: RedactLimits): CodeLearnResult[];
export interface AccessPlan {
    readonly access: GithubAccessId | undefined;
    readonly apiBase: string;
    readonly rawMirrors: readonly string[];
    readonly available: boolean;
    readonly notes: readonly string[];
}
/**
 * Compose a mirror API base from a configured prefix.
 *
 * `https://ghproxy.net/` + `https://api.github.com` -> `https://ghproxy.net/https://api.github.com`,
 * which is the form the adapters append endpoint paths to. A `{url}` template is
 * honoured too.
 */
export declare function composeMirrorBase(mirror: string, override: string): string;
/**
 * Pick the first GitHub access strategy that is actually usable.
 *
 * "Configured but unavailable" never falls back to something the user did not
 * choose (docs/DESIGN.md §2 #7: 空列表 = 该方式不可用，不兜底). Each skipped
 * strategy leaves a note explaining itself, so the reason string tells the user
 * what to fix rather than silently taking a different route.
 */
export declare function resolveAccess(config: ResolvedConfig): AccessPlan;
/**
 * Source order for one call.
 *
 * The configured `sourcePriority` is the backbone — the user's ranking is never
 * discarded. An explicit `sources` argument re-orders within it and appends
 * anything the ranking did not mention, because the caller asked for those
 * sources by name.
 */
export declare function orderSources(priority: readonly SourceId[], requested: readonly SourceId[]): SourceId[];
/**
 * The host service consumed as `ctx.codeSource`.
 *
 * Every optional service is looked up lazily through `ctx.get()` so a context
 * without `credentials` or `web` still mounts and still answers — with a clear
 * degradation message instead of an exception.
 */
export declare class CodeSource extends Service {
    private readonly context;
    private readonly deps;
    constructor(ctx: Context, deps: CodeSourceDeps);
    /** Resolve the effective configuration (built-in config + store snapshot + settings). */
    resolve(): Promise<ResolvedConfig>;
    /** Current effective limits. The tool needs them before it composes a timeout. */
    getLimits(): ResolvedLimits;
    /** The four decisions that have no answer yet. Empty = the tool may run. */
    getUnresolved(): Promise<UnresolvedDecision[]>;
    describeConfig(): Promise<ConfigView>;
    /** Presence of one credential ref, as a boolean. A value never leaves here. */
    private hasCredential;
    /** Booleans only — `describe()`, never `resolve()`. A value never leaves here. */
    credentialStatus(): Promise<Record<CredentialTarget, boolean>>;
    /**
     * Query the sources in priority order.
     *
     * Returns a value for every business outcome (including refusals) so the model
     * can branch on `ok`. Only a caller mistake throws.
     */
    search(query: string, options?: SearchOptions): Promise<SearchOutcome>;
    /**
     * Distil design notes from one URL. Returns notes, never files.
     *
     * Returns `[]` (with a log line) when a decision is still open — the caller
     * that needs a *reason* should ask `getUnresolved()` first, which is what the
     * `POST /deepread` route does.
     */
    deepRead(url: string, targets?: readonly DeepReadTarget[], options?: SearchOptions): Promise<LearnNote[]>;
    /**
     * Manual connectivity self-check.
     *
     * Deliberately TOKEN-FREE: it exercises the anonymous path only, so running it
     * can never leak a credential, and its result tells the user whether the
     * public route works before they invest in one.
     */
    smoke(): Promise<SmokeReport>;
    /**
     * Measure what one source can actually do right now, operation by operation.
     *
     * Deliberately ANONYMOUS by default: the connectivity panel has to answer
     * before the user has any credential, and a self-check that quietly spent one
     * would be a credential leaving the process without being asked. Pass
     * `useStoredCredential: true` to include the stored one.
     *
     * Runs without the decision gate: probing is how a user decides.
     */
    probe(input?: {
        readonly source?: SourceId;
        readonly useStoredCredential?: boolean;
    }): Promise<SourceRequirementReport>;
    private probeOperation;
    /**
     * Check the stored credential for one source.
     *
     * GitHub and Gitee both publish an endpoint that authenticates the caller, so
     * the answer is a real verdict. CSDN publishes none — it has no OAuth and no
     * token API — so the honest answer there is a comparison between an anonymous
     * and a cookie-carrying sample, reported as improved / unchanged / rejected
     * instead of a verdict this service cannot actually make.
     */
    validateCredential(source: SourceId): Promise<CredentialValidation>;
    /** CSDN: no validation endpoint exists, so compare anonymous with cookie. */
    private validateCsdnCredential;
    private sampleCsdn;
    private adapterFor;
    private buildTransport;
    private adapterOptions;
    /** Best-effort channel label for the `reason` wording. Informational only. */
    private plannedTransport;
    /**
     * Endpoint base override for one source. Empty string = the adapter's built-in
     * base (`GITHUB_API_BASE` / `GITEE_API_BASE` / `CSDN_SEARCH_BASE`), which is
     * also what a mirror strategy composes from.
     */
    private apiBaseFor;
    private resolveToken;
    private sourceForUrl;
}
/**
 * Does this operation need a login, per the contract's measured facts?
 *
 * These baselines come from `LOGIN_REQUIREMENTS` (github code search → 401
 * anonymous; Gitee has no `/search/code` endpoint and its web code search needs
 * a session; CSDN article pages are anti-bot gated without a cookie). They are
 * the STARTING point — `probeOperation()` upgrades `requiresLogin` to true when
 * the live request answers 401.
 */
export declare function operationRequiresLogin(source: SourceId, operation: SourceOperationId): boolean;
/**
 * The URL one probe hits.
 *
 * Every base comes from the resolved config (or the contract's built-in), and
 * the file-read targets are public, well-known repositories so a failure means
 * "this path is not readable" rather than "the probe invented a bad URL".
 */
export declare function probeUrlFor(source: SourceId, operation: SourceOperationId, config: ResolvedConfig): string;
/**
 * The caller's own identity out of a `/user` payload.
 *
 * This is the ONE field from a credential check that may travel back: it says
 * WHO the user is, never WHAT they hold. Parsing is guarded because a proxy or a
 * captive portal can answer 200 with HTML.
 */
export declare function accountFromUserPayload(body: string): string | null;
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The dsh-codehub host service. */
        codeSource: CodeSource;
    }
}
