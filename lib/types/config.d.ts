/**
 * dsh-codehub — configuration schema, decision resolution and hard-cap clamping.
 *
 * OWNER: `host-core`. Read-only consumers: `service.ts`, `routes.ts`, `index.ts`.
 *
 * WHY A SCHEMA AND NOT A HAND-BUILT FORM
 * --------------------------------------
 * The `settings` service on this runtime has NO `installSection` and NO
 * `register` (see types/dsh/index.d.ts). The settings form is derived
 * AUTOMATICALLY from the schemastery schema this module exports as `Config`.
 * That schema is therefore the settings UI, and every `.description()` below is
 * user-visible copy.
 *
 * THREE THINGS THIS MODULE GUARANTEES
 * ----------------------------------
 * 1. **No secret is representable.** There is no `token` / `cookie` field
 *    anywhere in the schema: credentials live in `ctx.credentials` only, and
 *    `isSecretKey()` additionally rejects any patch key that even looks like a
 *    secret, so a malformed PATCH cannot smuggle one into the profile patch or
 *    into `$DSH_HOME/dsh-codehub.json`.
 * 2. **An unanswered decision stays unanswered.** `failover.enabled` and
 *    `mergeSources` are booleans WITHOUT a default, so they resolve to
 *    `undefined` until the user touches them. `false` is a decided answer
 *    ("do not degrade") and is kept distinct from `undefined` ("never asked").
 *    `sourcePriority` / `github.accessPriority` default to the EMPTY array,
 *    which is likewise read as undecided by `gating.ts` — never as "all".
 * 3. **Hard caps are the ceiling.** Every number goes through `resolveLimits()`,
 *    which clamps into `HARD_LIMITS`. A user may lower a limit; nothing,
 *    including the CLI or a hand-edited patch, can raise it.
 *
 * 备注① lives here too: the local-proxy field's description is built from
 * `LOCAL_PROXY_LABEL` + `LOCAL_PROXY_HELP`, so the phrase 仅 Node 直连传输生效
 * reaches the derived settings form without a second hand-written copy.
 */
/**
 * `@deepseek-ai/schemastery`, NOT the unscoped `schemastery`.
 *
 * They are different packages: upstream `schemastery` tops out at 3.18.0, while
 * DSH publishes its own fork at 3.18.2 — and that fork is what
 * `@deepseek-ai/dsh-tools` depends on. Importing the unscoped package made this
 * plugin's schema a DIFFERENT `Schema` type from the one the SDK uses, so
 * TypeScript resolved the schema's inferred type through the fork's pnpm store
 * path and declaration emit failed with TS2742 ("cannot be named without a
 * reference to .pnpm/@deepseek-ai+schemastery@3.18.2/...").
 *
 * Shipping host plugins import the fork (`dsh-context` does), and it is also the
 * package carrying the `role(...)` secret-field support DSH's settings surface
 * understands. Declared as a peer dependency: the host provides it.
 */
import Schema from '@deepseek-ai/schemastery';
import type { DeepReadTarget, GithubAccessId, SourceId } from './contract.js';
export declare const ENTRY_PLACEMENTS: readonly ["both", "sidebar", "settings"];
export type EntryPlacement = (typeof ENTRY_PLACEMENTS)[number];
/** Defaults the schema declares, kept in one object so copy and code agree. */
export declare const SCHEMA_DEFAULTS: {
    readonly enabled: true;
    /**
     * Kept for schema compatibility, and now always true.
     *
     * It used to gate a first-run dialog that asked the user where the plugin
     * should appear. That dialog is gone: both surfaces are on by default and the
     * choice is an ordinary setting (`entryPlacement`) the user changes in the
     * plugin's settings page. Nothing asks on startup.
     */
    readonly onboarded: true;
    readonly entryPlacement: "both";
    readonly announceToAgent: true;
    readonly htmlFallback: true;
    readonly banner: true;
    /**
     * CSDN article pages carry the code blocks, so the second fetch is on by
     * default; it is a switch rather than a silent behaviour so a user can trade
     * one extra request per hit for fewer requests.
     */
    readonly articleFetch: true;
    /** CDP cookie capture is a real security trade: opt-in, never on by default. */
    readonly cdpEnabled: false;
    readonly cdpPort: 9222;
    /**
     * Auto-save the settings form. ON by default because the user asked for it
     * ("每改一处自动保存"), and switchable because the first version was not — which
     * left the manual button permanently disabled and the save bar useless.
     */
    readonly autoSave: true;
};
/**
 * 备注① — the description of the local-proxy control.
 *
 * Built by concatenation, never re-typed: it must contain BOTH
 * `LOCAL_PROXY_LABEL` (本机代理 / SOCKS5 地址) and `LOCAL_PROXY_HELP` (which
 * carries `LOCAL_PROXY_SCOPE_NOTE` — 仅 Node 直连传输生效).
 */
export declare const LOCAL_PROXY_FIELD_DESCRIPTION = "\u672C\u673A\u4EE3\u7406 / SOCKS5 \u5730\u5740\uFF1A\u5F62\u5982 127.0.0.1:7890\u3002\u8BE5\u8BBE\u7F6E\uFF08\u4EC5 Node \u76F4\u8FDE\u4F20\u8F93\u751F\u6548\uFF09\uFF1A\u4EC5\u5F53\u4F20\u8F93\u901A\u9053\u4E3A Node \u76F4\u8FDE\u65F6\u5E94\u7528\uFF1B\u8D70 DSH \u81EA\u5E26 web \u901A\u9053\u65F6\u7531 Harness \u8D1F\u8D23\u51FA\u7F51\uFF0C\u672C\u63D2\u4EF6\u65E0\u6CD5\u4E3A\u5176\u6CE8\u5165\u4EE3\u7406\u3002";
/**
 * `Schema.union([...])` over a readonly tuple of literals is the documented
 * schemastery enum form and is used for every closed vocabulary here, so the
 * derived form renders a select rather than a free-text box. The resolver
 * filters against the same contract arrays anyway (`readStringList()`), which is
 * what makes an unknown value from a hand-edited patch harmless.
 */
export declare const Config: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    onboarded: Schema<boolean, boolean>;
    entryPlacement: Schema<"both" | "sidebar" | "settings", "both" | "sidebar" | "settings">;
    announceToAgent: Schema<boolean, boolean>;
    sourcePriority: Schema<("github" | "gitee" | "csdn")[], ("github" | "gitee" | "csdn")[]>;
    github: Schema<Schemastery.ObjectS<{
        accessPriority: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
        apiBase: Schema<string, string>;
        webProxyBases: Schema<string[], string[]>;
        rawMirrorBases: Schema<string[], string[]>;
        localProxy: Schema<string, string>;
        oauthClientId: Schema<string, string>;
    }>, Schemastery.ObjectT<{
        accessPriority: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
        apiBase: Schema<string, string>;
        webProxyBases: Schema<string[], string[]>;
        rawMirrorBases: Schema<string[], string[]>;
        localProxy: Schema<string, string>;
        oauthClientId: Schema<string, string>;
    }>>;
    gitee: Schema<Schemastery.ObjectS<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        oauthClientId: Schema<string, string>;
        oauthRedirectUri: Schema<string, string>;
    }>, Schemastery.ObjectT<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        oauthClientId: Schema<string, string>;
        oauthRedirectUri: Schema<string, string>;
    }>>;
    csdn: Schema<Schemastery.ObjectS<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        articleFetch: Schema<boolean, boolean>;
        cdpEnabled: Schema<boolean, boolean>;
        cdpPort: Schema<number, number>;
    }>, Schemastery.ObjectT<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        articleFetch: Schema<boolean, boolean>;
        cdpEnabled: Schema<boolean, boolean>;
        cdpPort: Schema<number, number>;
    }>>;
    /**
     * Browser-half behaviour. Not a decision (nothing here blocks the tool), just a
     * preference the user owns — which is exactly why it must be switchable rather
     * than baked into the writer.
     */
    ui: Schema<Schemastery.ObjectS<{
        autoSave: Schema<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        autoSave: Schema<boolean, boolean>;
    }>>;
    failover: Schema<Schemastery.ObjectS<{
        enabled: Schema<boolean, boolean>;
        chain: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
    }>, Schemastery.ObjectT<{
        enabled: Schema<boolean, boolean>;
        chain: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
    }>>;
    mergeSources: Schema<boolean, boolean>;
    limits: Schema<Schemastery.ObjectS<{
        timeoutMs: Schema<number, number>;
        retries: Schema<number, number>;
        maxDepth: Schema<number, number>;
        maxItems: Schema<number, number>;
        maxCodeChars: Schema<number, number>;
    }>, Schemastery.ObjectT<{
        timeoutMs: Schema<number, number>;
        retries: Schema<number, number>;
        maxDepth: Schema<number, number>;
        maxItems: Schema<number, number>;
        maxCodeChars: Schema<number, number>;
    }>>;
    marking: Schema<Schemastery.ObjectS<{
        banner: Schema<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        banner: Schema<boolean, boolean>;
    }>>;
    deepRead: Schema<Schemastery.ObjectS<{
        targets: Schema<("readme" | "entry" | "core" | "tests")[], ("readme" | "entry" | "core" | "tests")[]>;
    }>, Schemastery.ObjectT<{
        targets: Schema<("readme" | "entry" | "core" | "tests")[], ("readme" | "entry" | "core" | "tests")[]>;
    }>>;
}>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    onboarded: Schema<boolean, boolean>;
    entryPlacement: Schema<"both" | "sidebar" | "settings", "both" | "sidebar" | "settings">;
    announceToAgent: Schema<boolean, boolean>;
    sourcePriority: Schema<("github" | "gitee" | "csdn")[], ("github" | "gitee" | "csdn")[]>;
    github: Schema<Schemastery.ObjectS<{
        accessPriority: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
        apiBase: Schema<string, string>;
        webProxyBases: Schema<string[], string[]>;
        rawMirrorBases: Schema<string[], string[]>;
        localProxy: Schema<string, string>;
        oauthClientId: Schema<string, string>;
    }>, Schemastery.ObjectT<{
        accessPriority: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
        apiBase: Schema<string, string>;
        webProxyBases: Schema<string[], string[]>;
        rawMirrorBases: Schema<string[], string[]>;
        localProxy: Schema<string, string>;
        oauthClientId: Schema<string, string>;
    }>>;
    gitee: Schema<Schemastery.ObjectS<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        oauthClientId: Schema<string, string>;
        oauthRedirectUri: Schema<string, string>;
    }>, Schemastery.ObjectT<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        oauthClientId: Schema<string, string>;
        oauthRedirectUri: Schema<string, string>;
    }>>;
    csdn: Schema<Schemastery.ObjectS<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        articleFetch: Schema<boolean, boolean>;
        cdpEnabled: Schema<boolean, boolean>;
        cdpPort: Schema<number, number>;
    }>, Schemastery.ObjectT<{
        apiBase: Schema<string, string>;
        htmlFallback: Schema<boolean, boolean>;
        articleFetch: Schema<boolean, boolean>;
        cdpEnabled: Schema<boolean, boolean>;
        cdpPort: Schema<number, number>;
    }>>;
    /**
     * Browser-half behaviour. Not a decision (nothing here blocks the tool), just a
     * preference the user owns — which is exactly why it must be switchable rather
     * than baked into the writer.
     */
    ui: Schema<Schemastery.ObjectS<{
        autoSave: Schema<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        autoSave: Schema<boolean, boolean>;
    }>>;
    failover: Schema<Schemastery.ObjectS<{
        enabled: Schema<boolean, boolean>;
        chain: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
    }>, Schemastery.ObjectT<{
        enabled: Schema<boolean, boolean>;
        chain: Schema<("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[], ("direct" | "token" | "ghproxy" | "raw-mirror" | "local-proxy" | "watt" | "hosts" | "third-party-mirror")[]>;
    }>>;
    mergeSources: Schema<boolean, boolean>;
    limits: Schema<Schemastery.ObjectS<{
        timeoutMs: Schema<number, number>;
        retries: Schema<number, number>;
        maxDepth: Schema<number, number>;
        maxItems: Schema<number, number>;
        maxCodeChars: Schema<number, number>;
    }>, Schemastery.ObjectT<{
        timeoutMs: Schema<number, number>;
        retries: Schema<number, number>;
        maxDepth: Schema<number, number>;
        maxItems: Schema<number, number>;
        maxCodeChars: Schema<number, number>;
    }>>;
    marking: Schema<Schemastery.ObjectS<{
        banner: Schema<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        banner: Schema<boolean, boolean>;
    }>>;
    deepRead: Schema<Schemastery.ObjectS<{
        targets: Schema<("readme" | "entry" | "core" | "tests")[], ("readme" | "entry" | "core" | "tests")[]>;
    }>, Schemastery.ObjectT<{
        targets: Schema<("readme" | "entry" | "core" | "tests")[], ("readme" | "entry" | "core" | "tests")[]>;
    }>>;
}>>;
/** Every field optional/tolerant: this is what a PATCH body may look like. */
export interface CodehubConfig {
    readonly enabled?: boolean | null;
    readonly onboarded?: boolean | null;
    readonly entryPlacement?: string | null;
    readonly announceToAgent?: boolean | null;
    readonly sourcePriority?: readonly string[] | null;
    readonly github?: GithubConfigInput | null;
    readonly gitee?: GiteeConfigInput | null;
    readonly csdn?: CsdnConfigInput | null;
    readonly failover?: FailoverConfigInput | null;
    readonly mergeSources?: boolean | null;
    readonly limits?: LimitsInput | null;
    readonly marking?: MarkingConfigInput | null;
    readonly deepRead?: DeepReadConfigInput | null;
    readonly ui?: UiConfigInput | null;
}
/** Browser-half preferences. Nothing here can block the tool. */
export interface UiConfigInput {
    readonly autoSave?: boolean | null;
}
export interface GithubConfigInput {
    readonly accessPriority?: readonly string[] | null;
    readonly apiBase?: string | null;
    readonly webProxyBases?: readonly string[] | null;
    readonly rawMirrorBases?: readonly string[] | null;
    readonly localProxy?: string | null;
    /** The user's own OAuth App id. A public value — a client SECRET is never here. */
    readonly oauthClientId?: string | null;
}
export interface EndpointConfigInput {
    readonly apiBase?: string | null;
    readonly htmlFallback?: boolean | null;
}
/** Gitee adds the authorization-code flow, which needs an app id and a callback. */
export interface GiteeConfigInput extends EndpointConfigInput {
    readonly oauthClientId?: string | null;
    readonly oauthRedirectUri?: string | null;
}
/** CSDN adds the article-page fetch and the experimental CDP capture. */
export interface CsdnConfigInput extends EndpointConfigInput {
    readonly articleFetch?: boolean | null;
    readonly cdpEnabled?: boolean | null;
    readonly cdpPort?: number | null;
}
export interface FailoverConfigInput {
    readonly enabled?: boolean | null;
    readonly chain?: readonly string[] | null;
}
export interface LimitsInput {
    readonly timeoutMs?: number | null;
    readonly retries?: number | null;
    readonly maxDepth?: number | null;
    readonly maxItems?: number | null;
    readonly maxCodeChars?: number | null;
}
export interface MarkingConfigInput {
    readonly banner?: boolean | null;
}
export interface DeepReadConfigInput {
    readonly targets?: readonly string[] | null;
}
/**
 * The non-schema half of the configuration: values kept in
 * `$DSH_HOME/dsh-codehub.json` (0600) instead of the settings profile, plus the
 * fallback snapshot written when the settings service cannot persist our
 * namespace (docs/DESIGN.md §5).
 */
export interface LocalConfigInput {
    /** 备注① target: the only place a local proxy address is persisted. */
    readonly localProxy?: string | null;
    /** Full config snapshot, used ONLY while the settings service is unavailable. */
    readonly fallbackConfig?: CodehubConfig | null;
}
export interface ResolvedLimits {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly maxDepth: number;
    readonly maxItems: number;
    readonly maxCodeChars: number;
}
export interface ResolvedGithubConfig {
    readonly accessPriority: readonly GithubAccessId[];
    readonly apiBase: string;
    readonly webProxyBases: readonly string[];
    readonly rawMirrorBases: readonly string[];
    readonly localProxy: string;
    /** Empty = no GitHub browser login offered; a PAT paste remains available. */
    readonly oauthClientId: string;
}
export interface ResolvedEndpointConfig {
    readonly apiBase: string;
    readonly htmlFallback: boolean;
}
export interface ResolvedGiteeConfig extends ResolvedEndpointConfig {
    readonly oauthClientId: string;
    /** Empty = derive `http://<request host>${OAUTH_CALLBACK_PATH}` at request time. */
    readonly oauthRedirectUri: string;
}
export interface ResolvedCsdnConfig extends ResolvedEndpointConfig {
    readonly articleFetch: boolean;
    readonly cdpEnabled: boolean;
    /** Always inside 1..65535 — clamped by `resolveConfig()`. */
    readonly cdpPort: number;
}
export interface ResolvedFailoverConfig {
    /** `undefined` = still undecided; `false` = decided not to degrade. */
    readonly enabled: boolean | undefined;
    readonly chain: readonly GithubAccessId[];
}
export interface ResolvedConfig {
    readonly enabled: boolean;
    readonly onboarded: boolean;
    readonly entryPlacement: EntryPlacement;
    readonly announceToAgent: boolean;
    readonly sourcePriority: readonly SourceId[];
    readonly github: ResolvedGithubConfig;
    readonly gitee: ResolvedGiteeConfig;
    readonly csdn: ResolvedCsdnConfig;
    readonly failover: ResolvedFailoverConfig;
    /** `undefined` = still undecided; `false` = decided not to merge. */
    readonly mergeSources: boolean | undefined;
    readonly limits: ResolvedLimits;
    readonly marking: {
        readonly banner: true;
    };
    readonly deepRead: {
        readonly targets: readonly DeepReadTarget[];
    };
    /** Browser-half preferences (no decision semantics here). */
    readonly ui: {
        readonly autoSave: boolean;
    };
}
/** `undefined` unless the value is literally a boolean — `false` is preserved. */
export declare function readBoolean(value: unknown): boolean | undefined;
export declare function readString(value: unknown, fallback?: string): string;
/** Trimmed, de-duplicated, order-preserving string list, optionally filtered. */
export declare function readStringList(value: unknown, allowed?: readonly string[]): string[];
/** Clamp every limit into `HARD_LIMITS`. Exported so tests can assert the caps. */
export declare function resolveLimits(raw?: LimitsInput | null): ResolvedLimits;
/** Normalise one config layer (already merged) into the shape the host uses. */
export declare function resolveConfig(settings?: CodehubConfig | null, local?: LocalConfigInput | null): ResolvedConfig;
/**
 * A key that must never be persisted by this plugin, anywhere.
 *
 * Credentials belong to `ctx.credentials`; a PATCH naming one is a caller
 * mistake, and it is dropped (and reported) rather than written to a profile
 * patch or to the 0600 store file.
 */
export declare const SECRET_KEY_PATTERN: RegExp;
export declare function isSecretKey(key: string): boolean;
/** Deep merge (top level + one nested group) with `null` meaning "unset". */
export declare function mergeConfigInput(base?: CodehubConfig | null, patch?: CodehubConfig | null): CodehubConfig;
export interface PatchSplitResult {
    /** False only when the body was not a JSON object at all. */
    readonly ok: boolean;
    /** Keys dropped because this plugin does not own them, or they look secret. */
    readonly rejected: readonly string[];
    /** Values that belong in `$DSH_HOME/dsh-codehub.json` (0600), not the profile. */
    readonly local: {
        readonly localProxy?: string;
    };
    /** The sanitised patch destined for the settings namespace. */
    readonly settings: CodehubConfig;
    readonly error?: string;
}
/**
 * Split an incoming PATCH into "goes to the 0600 store" and "goes to settings".
 *
 * Only `github.localProxy` is stored locally (docs/DESIGN.md §4: a proxy address
 * is sensitive but is not a credential). Everything else is a normal setting.
 * Unknown and secret-looking keys are dropped and reported — never persisted.
 */
export declare function splitConfigPatch(patch: unknown): PatchSplitResult;
export interface ConfigJsonViewGithub extends ResolvedGithubConfig {
    /** Alias of `webProxyBases`, kept for the browser half's original field name. */
    readonly mirrors: readonly string[];
    /** Alias of `rawMirrorBases`. */
    readonly rawMirrors: readonly string[];
}
export interface ConfigJsonView {
    readonly enabled: boolean;
    readonly onboarded: boolean;
    readonly entryPlacement: EntryPlacement;
    readonly announceToAgent: boolean;
    readonly sourcePriority: readonly SourceId[];
    readonly github: ConfigJsonViewGithub;
    readonly gitee: ResolvedGiteeConfig;
    readonly csdn: ResolvedCsdnConfig;
    readonly failover: {
        readonly enabled: boolean | null;
        readonly chain: readonly GithubAccessId[];
    };
    readonly mergeSources: boolean | null;
    readonly limits: ResolvedLimits;
    readonly marking: {
        readonly banner: true;
    };
    readonly deepRead: {
        readonly targets: readonly DeepReadTarget[];
    };
    readonly ui: {
        readonly autoSave: boolean;
    };
}
/** `undefined` -> `null`, so "undecided" survives JSON serialisation. */
export declare function toJsonView(config: ResolvedConfig): ConfigJsonView;
/** The only credential-shaped fields the schema will ever expose: booleans. */
export declare const CREDENTIAL_TARGETS: readonly ["github", "gitee", "csdn"];
export type CredentialTarget = (typeof CREDENTIAL_TARGETS)[number];
