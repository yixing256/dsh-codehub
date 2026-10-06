/**
 * dsh-codehub — browser-half API client and shared config store.
 *
 * WHY THIS EXISTS INSTEAD OF `settingsScope`
 * ------------------------------------------
 * The DSH settings RPC only serves an allow-listed set of namespaces, and this
 * plugin's namespace is not guaranteed to be on it — `settingsScope` may report
 * `status: 'unavailable'`. So the PRIMARY config path is the plugin's own
 * loopback-fenced route family (`src/contract.ts: API_PREFIX`, implemented by
 * the host half): `config` (GET/PATCH), `decisions` (GET), `credentials`
 * (POST/DELETE), `detect` (GET), `smoke` (POST), `deepread` (POST).
 *
 * `settingsScope` is an OPTIONAL ENHANCEMENT only (`attachSettingsScope`): when
 * it is attached and `status === 'ready'` we mirror writes onto it and offer an
 * explicit pull. When it is absent or unavailable **nothing errors and nothing
 * blocks** — the read path never touches it.
 *
 * SECURITY
 * --------
 * Credential VALUES travel through exactly one function here (`saveCredential`)
 * and are never stored, logged, echoed or returned. `CodeHubCredentials` is a
 * boolean-only view: the UI can render "configured / not configured" and
 * nothing else.
 *
 * The read path is deliberately tolerant (missing fields fall back to
 * defaults, `mirrors`/`rawMirrors` are accepted as aliases of
 * `webProxyBases`/`rawMirrorBases`, `null` and missing both mean "undecided").
 * The write path is strict: it sends only the canonical field names and uses
 * JSON-Merge-Patch semantics — `null` on `failover.enabled` / `mergeSources`
 * means "un-decide this", because `false` is already a *valid answer*
 * ("do not fail over") and must never be conflated with "not asked yet".
 */
import type { ConnectivityStatus, DeepReadTarget, GithubAccessId, LoginMethodId, SourceId, TransportId, UnresolvedDecision } from '../contract.js';
import type { LocaleKey, Translate } from './locales.js';
/** The three entry placements. Literals match docs/DESIGN.md §1 and the host route. */
export type EntryPlacement = 'sidebar' | 'settings' | 'both';
/**
 * Placement / deep-read label keys live HERE, not in the form component.
 *
 * WHY: the settings form and the post-save summary both render these
 * vocabularies. Keeping one map per vocabulary means a renamed label cannot
 * reach one surface and miss the other — the same reason the contract holds the
 * copy that the host and the browser half share.
 */
export declare const PLACEMENT_LABEL: Record<EntryPlacement, LocaleKey>;
export declare const DEEP_READ_LABEL: Record<DeepReadTarget, LocaleKey>;
export interface CodeHubLimits {
    timeoutMs: number;
    retries: number;
    maxDepth: number;
    maxItems: number;
    maxCodeChars: number;
}
/**
 * Boolean-only credential view. There is intentionally no `value` field: the
 * browser half has no way to represent a secret, so it cannot render one.
 */
export interface CodeHubCredentials {
    github: boolean;
    gitee: boolean;
    csdn: boolean;
}
export type CredentialSource = 'github' | 'gitee' | 'csdn';
export type CredentialKind = 'token' | 'cookie';
/** Normalised config the whole browser half renders from. */
export interface CodeHubConfigView {
    readonly onboarded: boolean;
    readonly entryPlacement: EntryPlacement;
    readonly sourcePriority: readonly SourceId[];
    readonly githubAccessPriority: readonly GithubAccessId[];
    /** Web / API proxy bases (`github.webProxyBases`). Never pre-filled. */
    readonly webProxyBases: readonly string[];
    /** raw file mirror bases (`github.rawMirrorBases`). Never pre-filled. */
    readonly rawMirrorBases: readonly string[];
    readonly localProxy: string;
    /** `null` = undecided. `false` is a real answer. */
    readonly failoverEnabled: boolean | null;
    /** `null` = undecided. `false` is a real answer. */
    readonly mergeSources: boolean | null;
    readonly limits: CodeHubLimits;
    readonly deepReadTargets: readonly DeepReadTarget[];
    /** CSDN: fetch the article page when a hit carries no code (`csdn.articleFetch`). */
    readonly csdnArticleFetch: boolean;
    /**
     * CSDN: the experimental browser-debug-port cookie capture
     * (`csdn.cdpEnabled`, default false). Exposed so the panel can BE the switch —
     * a config key that no control writes is a feature nobody can turn on.
     */
    readonly csdnCdpEnabled: boolean;
    readonly csdnCdpPort: number;
    /**
     * `ui.autoSave` — whether editing schedules a write by itself.
     *
     * The first version hard-coded auto-save ON with no switch, which left the
     * manual 「保存到 host」 button permanently disabled (the draft was always already
     * written) and the save bar decorative. It is a user-owned preference now, and
     * the switch sits IN the save bar — where the user went looking for it.
     */
    readonly autoSave: boolean;
    readonly credentials: CodeHubCredentials;
    /** The payload exactly as received, for diagnostics. Never rendered raw when it could hold secrets (it cannot). */
    readonly raw: unknown;
}
/** Partial write payload. Only changed leaves are sent; `null` un-decides a tri-state. */
export interface CodeHubConfigPatch {
    onboarded?: boolean;
    entryPlacement?: EntryPlacement;
    sourcePriority?: readonly SourceId[];
    github?: {
        accessPriority?: readonly GithubAccessId[];
        webProxyBases?: readonly string[];
        rawMirrorBases?: readonly string[];
        localProxy?: string;
    };
    csdn?: {
        articleFetch?: boolean;
        cdpEnabled?: boolean;
        cdpPort?: number;
    };
    ui?: {
        autoSave?: boolean;
    };
    failover?: {
        enabled: boolean | null;
    };
    mergeSources?: boolean | null;
    limits?: Partial<CodeHubLimits>;
    deepRead?: {
        targets?: readonly DeepReadTarget[];
    };
}
export type ApiErrorKind = 'timeout' | 'network' | 'http' | 'parse' | 'unavailable';
export declare class CodeHubApiError extends Error {
    readonly kind: ApiErrorKind;
    readonly status: number | null;
    constructor(kind: ApiErrorKind, message: string, status?: number | null);
}
/** The host route family is not there at all (not built / not registered). */
export declare function isRouteUnavailable(err: unknown): boolean;
/** 503 from `/credentials` — the host credential service is not usable. */
export declare function isCredentialsServiceUnavailable(err: unknown): boolean;
export declare function describeError(err: unknown): string;
export declare const EMPTY_CONFIG: CodeHubConfigView;
/**
 * Tolerant reader. Accepts the payload either wrapped in `{ config }` or flat,
 * and accepts `mirrors` / `rawMirrors` as aliases of the canonical
 * `webProxyBases` / `rawMirrorBases`.
 */
export declare function normalizeConfig(payload: unknown): CodeHubConfigView;
/** Mirror the host's deep-merge locally, so a `{ ok:true }`-only reply cannot wipe the view. */
export declare function applyPatchLocally(base: CodeHubConfigView, patch: CodeHubConfigPatch): CodeHubConfigView;
/** Build the minimal canonical patch that turns `base` into `draft`. */
export declare function buildPatch(base: CodeHubConfigView, draft: CodeHubConfigView): CodeHubConfigPatch;
/** Dirty check: a draft that differs only by blank mirror rows is NOT dirty. */
export declare function sameConfig(a: CodeHubConfigView, b: CodeHubConfigView): boolean;
/** Stable ids and render order of the summary rows. */
export declare const CONFIG_SUMMARY_KEYS: readonly ["sourcePriority", "githubAccessPriority", "failoverEnabled", "mergeSources", "credentials", "mirrors", "localProxy", "csdnCdp", "limits", "deepReadTargets", "entryPlacement"];
export type ConfigSummaryKey = (typeof CONFIG_SUMMARY_KEYS)[number];
/** One rendered summary line: a field name and its current (host) value. */
export interface ConfigSummaryRow {
    readonly key: ConfigSummaryKey;
    readonly label: string;
    readonly value: string;
}
/** Which summary rows a given patch touches. Credentials have their own route. */
export declare function summaryKeysForPatch(patch: CodeHubConfigPatch): ConfigSummaryKey[];
/**
 * Build the "field name → current value" summary from a host read-back view.
 * `t` is injected so every row is rendered in the active language; a row whose
 * value the user never provided says 未提供 rather than pretending to be set.
 */
export declare function describeConfigSummary(view: CodeHubConfigView, t: Translate): ConfigSummaryRow[];
/** One of the three fixed connectivity rows. */
export interface ConnectivityRowView {
    readonly source: SourceId;
    readonly status: ConnectivityStatus;
    /** HTTP status the probe observed, when it got far enough to see one. */
    readonly statusCode: number | null;
    readonly latencyMs: number | null;
    readonly transport: TransportId | null;
    /**
     * Bounded failure explanation, `''` unless the row failed. Bounded by
     * `CONNECTIVITY_MAX_REASON_LINES` because a provider's error text can be an
     * essay and the row must stay readable in a sidebar.
     */
    readonly reason: string;
    /** Host-measured "does this source need a login?" answer; null = not measured. */
    readonly requiresLogin: boolean | null;
    /** Host-measured evidence sentence; when non-empty it REPLACES the static line. */
    readonly evidence: string;
}
/** Cut a reason down to `CONNECTIVITY_MAX_REASON_LINES` lines, keeping it readable. */
export declare function truncateReason(reason: string): string;
/** The constant three rows, in contract order, before any payload is applied. */
export declare function emptyConnectivityRows(): ConnectivityRowView[];
/**
 * Normalise a `POST /smoke` payload into the constant three rows. An empty or
 * unreadable payload yields three `undetected` rows — never a crash, never a
 * blank card.
 */
export declare function normalizeSmoke(payload: unknown): ConnectivityRowView[];
/**
 * Same normalisation for `POST /probe`, but merged onto the rows already on
 * screen: a probe answers only what it measured, and the row a probe did not
 * cover must keep showing its previous result rather than flicker to未检测.
 */
export declare function normalizeProbe(payload: unknown, base: readonly ConnectivityRowView[]): ConnectivityRowView[];
export declare function fetchConfig(): Promise<CodeHubConfigView>;
export declare function patchConfig(patch: CodeHubConfigPatch): Promise<unknown>;
export declare function fetchDecisions(): Promise<UnresolvedDecision[]>;
/** Primitive-only view of the host environment probe (nested notes are dropped). */
export declare function fetchDetect(): Promise<Record<string, string | number | boolean | null>>;
export declare function runSmoke(): Promise<unknown>;
/** What the launcher reports. Only loopback facts; no credential can appear here. */
export interface LaunchBrowserView {
    readonly ok: boolean;
    readonly launched: boolean;
    readonly port: number;
    readonly userDataDir: string;
    readonly debuggerUrl: string;
    readonly browserLabel: string;
    readonly reason: string;
}
/**
 * Start a debuggable Chromium when nothing is listening on the debug port.
 *
 * `consent: true` is required by the route: opening a browser whose debug port any
 * local process can reach is the risky act, so it is an explicit choice and never a
 * side effect of opening the wizard.
 */
export declare function launchDebugBrowser(input: {
    readonly port: number;
    readonly consent: boolean;
    readonly url?: string;
}): Promise<LaunchBrowserView>;
/**
 * `POST /probe` — the same reachability question, but the host may attach the
 * credential already in the credential service (`useStoredCredential`). The
 * value still never travels through the browser half: the flag asks the HOST to
 * use what it already holds.
 */
export declare function runProbe(options?: {
    useStoredCredential?: boolean;
    source?: SourceId;
}): Promise<unknown>;
export type OAuthMethod = Extract<LoginMethodId, 'oauth-device' | 'oauth-code'>;
export type OAuthFlowStatus = 'pending' | 'slow_down' | 'done' | 'expired' | 'error' | 'unknown';
export interface OAuthFlowView {
    readonly flowId: string;
    readonly kind: 'device' | 'redirect' | '';
    readonly userCode: string;
    /** The URL to open in the browser, whatever the flow kind. */
    readonly verificationUri: string;
    readonly expiresInMs: number;
    readonly intervalMs: number;
    readonly status: OAuthFlowStatus;
    readonly reason: string;
    readonly credentialConfigured: boolean;
    /** False when the host refused to start the flow (reason explains why). */
    readonly ok: boolean;
}
export declare function normalizeOAuth(payload: unknown): OAuthFlowView;
/**
 * Start a browser login. The `clientSecret` (Gitee) exists in this request body
 * exactly as the manual paste path exists in `saveCredential` — it is never
 * stored, echoed or logged, and the caller clears its field once the request
 * settles.
 */
export declare function startOAuth(input: {
    source: CredentialSource;
    method: OAuthMethod;
    clientId: string;
    clientSecret?: string;
}): Promise<OAuthFlowView>;
export declare function statusOAuth(flowId: string): Promise<OAuthFlowView>;
export declare function cancelOAuth(flowId: string): Promise<OAuthFlowView>;
/**
 * Manual fallback for the Gitee authorization code: the callback may never come
 * back (a moved port, a blocking browser), so the user can paste the `code`.
 * That code is a single-use credential: it lives in the input field and in this
 * request body only, and the field is cleared as soon as the call settles.
 */
export declare function completeOAuth(input: {
    source: CredentialSource;
    code: string;
    clientId?: string;
    clientSecret?: string;
}): Promise<OAuthFlowView>;
/**
 * Experimental CDP cookie capture. The response whitelist is `count/names/hosts`:
 * the cookie VALUE is written into the credential service by the host and is
 * never returned, so this view cannot represent one.
 */
export interface CookieCaptureView {
    readonly ok: boolean;
    readonly count: number;
    readonly names: readonly string[];
    readonly hosts: readonly string[];
    readonly reason: string;
}
export declare function normalizeCookies(payload: unknown): CookieCaptureView;
/** `consent` is genuinely required by the route; the UI must have shown the warning first. */
export declare function captureCookies(input: {
    consent: boolean;
    port: number;
}): Promise<CookieCaptureView>;
export declare function requestDeepRead(url: string, targets: readonly DeepReadTarget[]): Promise<unknown>;
/**
 * The ONLY place a credential value is ever handled. It goes into the request
 * body, is never returned, never logged, never cached, never compared.
 */
export declare function saveCredential(source: CredentialSource, kind: CredentialKind, value: string): Promise<CodeHubCredentials>;
export declare function clearCredential(source: CredentialSource): Promise<CodeHubCredentials>;
export interface ConfigStoreState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    config: CodeHubConfigView;
    /** Local edits. `null` = no edits; the host view is authoritative. */
    draft: CodeHubConfigView | null;
    /** True once a real host payload has been read. */
    loaded: boolean;
    error: string | null;
    saving: boolean;
    lastSavedAt: number | null;
    /** How the LAST accepted save was triggered — the bar says which. */
    lastSaveReason: SaveReason | null;
    /** An auto-save is scheduled and not yet sent (the bar says "待自动保存"). */
    autoSavePending: boolean;
    /** Warnings the host attached to the last accepted save (value-free strings). */
    lastWarnings: readonly string[];
    /** Summary rows the LAST accepted save touched. Empty = nothing to report. */
    lastChangedKeys: readonly ConfigSummaryKey[];
    unresolved: readonly UnresolvedDecision[];
    unresolvedError: string | null;
}
/** `auto` = the debounced writer fired; `manual` = the user pressed save; `preference` = a switch that governs the writer. */
export type SaveReason = 'auto' | 'manual' | 'preference';
export declare function subscribeConfig(listener: () => void): () => void;
export declare function getConfigState(): ConfigStoreState;
export declare function useConfigState(): ConfigStoreState;
/** Load the host config once; `force` re-reads (the refresh button). */
export declare function loadConfig(force?: boolean): Promise<ConfigStoreState>;
export declare function refreshDecisions(): Promise<void>;
/** Push the whole current config view through a patch and adopt the host's answer. */
export declare function saveConfig(patch: CodeHubConfigPatch, reason?: SaveReason): Promise<boolean>;
/** Current draft (or the host view when there are no edits). */
export declare function getDraft(): CodeHubConfigView;
export declare function isDirty(): boolean;
/** Quiet period after the last edit before the draft is written. */
export declare const AUTO_SAVE_DELAY_MS = 700;
/** Cancel a scheduled auto-save. Exported for tests and for an explicit save. */
export declare function cancelAutoSave(): void;
/**
 * Write the draft now, collapsing any scheduled auto-save into this call.
 *
 * Returns the same value `saveDraft` does: `false` means the host refused and the
 * draft is still there to retry.
 */
export declare function autoSaveNow(reason?: SaveReason): Promise<boolean>;
/** Record an edit and schedule the write that will persist it. */
export declare function updateDraft(mutate: (next: CodeHubConfigView) => CodeHubConfigView): void;
export declare function resetDraft(): void;
/** Save the draft. Returns false and keeps the draft when the host refuses. */
export declare function saveDraft(reason?: SaveReason): Promise<boolean>;
/** Adopt the credential booleans the route just returned (values never travel here). */
export declare function applyCredentials(credentials: CodeHubCredentials): void;
/**
 * Flip ONE source's configured flag after an out-of-band write (an OAuth flow
 * finishing, a CDP capture). Only the boolean moves; there is no value to put
 * anywhere, which is the point.
 */
export declare function markCredentialConfigured(source: CredentialSource): void;
/**
 * Attach a DSH settings scope. Only used for the optional mirror: a scope whose
 * shape we do not recognise is dropped silently (no error, no blocking).
 */
export declare function attachSettingsScope(scope: unknown): boolean;
export declare function hasSettingsScope(): boolean;
/** The coerced scope, handed to the settings-section seat through its inject face. */
export declare function getSettingsScope(): unknown;
export interface SettingsScopeStatus {
    present: boolean;
    status: string;
    writable: boolean;
    revision: number;
}
/** Reactive scope status. `unavailable`/`absent` are normal states, not errors. */
export declare function useSettingsScopeStatus(): SettingsScopeStatus;
/** Explicit pull: only a `ready` scope yields a patch; anything else yields null. */
export declare function pullSettingsScopePatch(): CodeHubConfigPatch | null;
