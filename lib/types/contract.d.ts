/**
 * dsh-codehub — frozen contract surface.
 *
 * OWNER: lead. This file is LOCKED once opened for parallel work: every other
 * module (host half, source adapters, learn layer, client half, tests) imports
 * its names from here instead of re-spelling literals. Changing a value here
 * changes it everywhere, which is the point.
 *
 * Why the anti-copy strings live here and are exported as single constants:
 * 备注③ requires the anti-plagiarism statement to be written into BOTH the
 * `learn_code_from_web` tool description AND the system-prompt section. Two
 * hand-maintained copies would drift; one constant plus a test that asserts
 * both surfaces reference it cannot.
 *
 * Plugin identity is fixed by the user and must never be aliased or renamed:
 * package name, cordis.patch.yml row name, README title and this service all
 * spell `dsh-codehub`.
 */
/** Cordis plugin name. */
export declare const name = "dsh-codehub";
/** npm package name; also the cordis.patch.yml insert row `name`. */
export declare const PACKAGE_NAME = "dsh-codehub";
/** The host service key this plugin provides, consumed as `ctx.codeSource`. */
export declare const SERVICE_KEY = "codeSource";
/** The single agent tool this plugin registers. */
export declare const TOOL_NAME = "learn_code_from_web";
/** Settings namespace. Matches the profile entry id (the loader keys forms by it). */
export declare const SETTINGS_NAMESPACE = "dsh-codehub";
/** Locale namespace owned by the browser half. */
export declare const LOCALE_NAMESPACE = "dsh-codehub";
/** Host plugin context this plugin requires before any surface mounts. */
export declare const inject: readonly ["tools", "webServer", "systemPrompt"];
/** Slot used by the login dialogs. */
export declare const OVERLAY_SLOT = "shell.overlay";
/** Ordered position of our system-prompt section (the tool-guidance band). */
export declare const PROMPT_SECTION_ORDER = 150;
/**
 * The seat id: the `sidebar.panellist` row id, the `main` slot key and the
 * `settings.section` id are all this one value.
 */
export declare const UI_ENTRY_ID = "codehub";
/**
 * The sidebar row's visible text. The shell owns the row chrome (button,
 * tooltip, rail geometry) and renders this label next to the glyph we draw, so
 * the user sees the GitHub cat mark followed by exactly this word.
 */
export declare const UI_ENTRY_LABEL = "codehub";
/**
 * The sidebar row's position. The rail sorts ascending, so a SMALL number puts
 * the row near the top — which is where the user asked for it.
 */
export declare const UI_ENTRY_ORDER = 5;
/** Order of the settings section in the settings page. */
export declare const UI_SETTINGS_ORDER = 30;
/** Order of the login overlay above other overlays. */
export declare const UI_OVERLAY_ORDER = 20;
/** Loopback-fenced route family served by the host half. */
export declare const API_PREFIX = "/api/dsh-codehub";
/** Live-probe date for the CSDN endpoint below. */
export declare const CSDN_API_PROBED_AT = "2026-10-03";
/**
 * CSDN search endpoint base. Non-official internal interface — see
 * CSDN_API_NOTE. Response fields consumed: `result_vos[].title` (contains
 * `<em>` markup), `.body`, `.description`, `.url`, `.originalType`, `.create_time`.
 */
export declare const CSDN_SEARCH_BASE = "https://so.csdn.net/api/v3/search";
/**
 * Provenance note for the CSDN endpoint. 备注② requires exactly three facts —
 * non-official, probe date, may break — and a test asserts all three survive in
 * every place this string is rendered.
 */
export declare const CSDN_API_NOTE: string;
/** Gitee v5 API base. */
export declare const GITEE_API_BASE = "https://gitee.com/api/v5";
/**
 * Endpoints the brief named for Gitee DO NOT EXIST — and neither does the one
 * this constant used to name as a code search.
 *
 * `https://gitee.com/api/v5/projects?q=...` was probed live and returned 404.
 * `GET /api/v5/search/code` was probed live on 2026-10-04 and returned **404
 * with an HTML "页面不存在" page** — the mock-like code search this plugin used
 * to claim is not a real v5 endpoint at all, so the adapter must never build a
 * request for it again. The only real search endpoint is the repositories one,
 * which answers `[]` for anonymous callers (a token is required for data).
 *
 * `GITEE_CODE_SEARCH_SUPPORTED` makes that a fact the UI, the tool `reason` and
 * the tests can all read instead of each re-stating it.
 */
export declare const GITEE_SEARCH_REPOSITORIES = "/search/repositories";
/**
 * Gitee v5 has NO code-search endpoint. Measured 2026-10-04: `/search/code`
 * answers 404 (HTML page-not-found) — this is not "needs a login", the endpoint
 * simply does not exist. Gitee's *web* code search lives at search.gitee.com and
 * renders client-side, so it needs a logged-in browser session. The path literal
 * deliberately does NOT exist as a constant here: while it did, an adapter built
 * requests for it (see the removed `searchGiteeCode`).
 */
export declare const GITEE_CODE_SEARCH_SUPPORTED = false;
/** GitHub API base. Probed live: reachable directly (HTTP 200). */
export declare const GITHUB_API_BASE = "https://api.github.com";
/**
 * Raw-content origin. Probed live: NOT reachable from this host. Kept as the
 * default value of the configurable raw-mirror list so the UI can show what a
 * mirror is a mirror *of*; requests go through the user's mirror bases instead.
 */
export declare const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";
/** The exact phrase 备注① requires on the local-proxy control. */
export declare const LOCAL_PROXY_SCOPE_NOTE = "\u4EC5 Node \u76F4\u8FDE\u4F20\u8F93\u751F\u6548";
/** Local-proxy control label, carrying the scope note. */
export declare const LOCAL_PROXY_LABEL = "\u672C\u673A\u4EE3\u7406 / SOCKS5 \u5730\u5740";
/** Local-proxy help text, carrying the scope note plus the reason. */
export declare const LOCAL_PROXY_HELP: string;
/** The three supported learning sources, in the user's canonical reading order. */
export declare const SOURCES: readonly ["github", "gitee", "csdn"];
export type SourceId = (typeof SOURCES)[number];
/** Human-facing source names for prompts and rendered output. */
export declare const SOURCE_LABELS: Readonly<Record<SourceId, string>>;
/**
 * How a request reaches the network.
 * - `dsh-web`: the harness's own web service (`ctx.web.fetch`). Preferred when
 *   available, since it is the sanctioned egress path.
 * - `node`: global `fetch` from this process. Required for token-bearing
 *   requests the user wants kept off the shared channel, and the only transport
 *   a local proxy (备注①) can steer.
 */
export declare const TRANSPORTS: readonly ["dsh-web", "node"];
export type TransportId = (typeof TRANSPORTS)[number];
export declare const GITHUB_ACCESS: readonly ["direct", "token", "ghproxy", "raw-mirror", "local-proxy", "watt", "hosts", "third-party-mirror"];
export type GithubAccessId = (typeof GITHUB_ACCESS)[number];
/** Risk band shown as a tab in the settings panel. */
export declare const ACCESS_RISK: readonly ["stable", "temporary", "privacy-risk", "not-recommended"];
export type AccessRisk = (typeof ACCESS_RISK)[number];
/** One option row in the GitHub access picker. */
export interface AccessOption {
    readonly id: GithubAccessId;
    readonly label: string;
    readonly risk: AccessRisk;
    /** What the user must do before it can be selected. */
    readonly requirement: string;
    /**
     * When true a token is attached. Mirrors on this list MUST be false: a token
     * handed to a third-party mirror is a credential leak, so the picker forbids
     * the combination and the request builder re-checks it.
     */
    readonly carriesToken: boolean;
}
export declare const ACCESS_OPTIONS: readonly AccessOption[];
/** Strategies that must never carry a token, enforced at request-build time. */
export declare const TOKEN_FORBIDDEN_ACCESS: readonly GithubAccessId[];
/**
 * Failure taxonomy the user specified. Every adapter failure maps to exactly
 * one of these; the category (not the raw error) drives failover and the
 * `reason` the agent sees.
 */
export declare const FAILURE_KINDS: readonly ["network", "timeout", "empty", "rate-limited", "auth-required", "parse-failed", "not-code"];
export type FailureKind = (typeof FAILURE_KINDS)[number];
/** Failure kinds a failover chain may advance past. */
export declare const RETRYABLE_FAILURES: readonly FailureKind[];
export declare const CONFIDENCE_LEVELS: readonly ["high", "medium", "low"];
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
/**
 * One learning result.
 *
 * `is_verbatim_copy` is typed as the literal `false`, not `boolean`. That is the
 * mechanism-level guarantee 备注③ asks for: there is no assignable value that
 * marks a result as a permitted verbatim copy, so no code path can construct
 * one, and `grep -n "is_verbatim_copy: true"` can never match.
 */
export interface CodeLearnResult {
    /** Which source produced this row. */
    readonly source: SourceId;
    /** Canonical, human-openable URL. */
    readonly url: string;
    readonly title: string;
    /** Detected language, or empty when unknown. */
    readonly language: string;
    /**
     * Bounded excerpt, for study only. Displayed with the learning-only banner
     * and never presented as a deliverable. Truncated to `limits.maxCodeChars`.
     */
    readonly code: string;
    /** Whether `code` was truncated to fit the bound. */
    readonly codeTruncated: boolean;
    /** The takeaway: approach / contract / tradeoff / pitfall. Never the code. */
    readonly learned_summary: string;
    /** Structurally fixed. See the interface doc above. */
    readonly is_verbatim_copy: false;
    /** Star count when the source reports one, else null. */
    readonly stars: number | null;
    /** ISO-8601 last-updated timestamp when known, else null. */
    readonly updatedAt: string | null;
    readonly confidence: Confidence;
    /** Why this row exists and why it scored the way it did. */
    readonly reason: string;
}
/** The banner every rendered result carries. */
export declare const LEARNING_ONLY_BANNER = "\u3010\u4EC5\u5B66\u4E60\u53C2\u8003 \u00B7 \u4E0D\u5F97\u76F4\u63A5\u7C98\u8D34\u8FDB\u7528\u6237\u9879\u76EE\u3011";
/** The core boundary statement, shared by the tool and the prompt. */
export declare const ANTI_COPY_STATEMENT: string;
/** Tool-description clause; 备注③ requires it on the tool itself. */
export declare const ANTI_COPY_TOOL_CLAUSE: string;
/** System-prompt section text. */
export declare const PROMPT_SECTION_TEXT: string;
export declare const DECISION_KEYS: readonly ["sourcePriority", "githubAccessPriority", "failoverEnabled", "mergeSources"];
export type DecisionKey = (typeof DECISION_KEYS)[number];
/** One unresolved decision, surfaced to the agent instead of a silent default. */
export interface UnresolvedDecision {
    readonly key: DecisionKey;
    /** What is missing, in one line. */
    readonly detail: string;
    /** The question the agent must put to the user before retrying. */
    readonly ask: string;
    /** Where the user can set it, when a control exists. */
    readonly control: string;
}
export declare const DECISION_GUIDE: Readonly<Record<DecisionKey, UnresolvedDecision>>;
/** Render the refusal payload's human-readable instruction. */
export declare function decisionPrompt(unresolved: readonly UnresolvedDecision[]): string;
export declare const DEEP_READ_TARGETS: readonly ["readme", "entry", "core", "tests"];
export type DeepReadTarget = (typeof DEEP_READ_TARGETS)[number];
/** A design/usage note distilled from a repository. Not a file copy. */
export interface LearnNote {
    readonly url: string;
    readonly title: string;
    /** Architecture / approach in prose. */
    readonly approach: string;
    /** Public API surface and its contract, as prose or signatures. */
    readonly apiContract: readonly string[];
    /** Tradeoffs and alternatives the implementation chose between. */
    readonly tradeoffs: readonly string[];
    /** Pitfalls, gotchas and failure modes. */
    readonly pitfalls: readonly string[];
    /** The URLs this note was distilled from — each claim stays traceable. */
    readonly sourceUrls: readonly string[];
}
/** Hard caps. The user may lower them in settings; they may not be raised past these. */
export declare const HARD_LIMITS: {
    readonly timeoutMs: 120000;
    readonly retries: 5;
    readonly maxDepth: 3;
    readonly maxItems: 20;
    readonly maxCodeChars: 20000;
};
/** Schema defaults. Deliberately independent of the decision-gated fields. */
export declare const DEFAULT_LIMITS: {
    readonly timeoutMs: 15000;
    readonly retries: 2;
    readonly maxDepth: 1;
    readonly maxItems: 8;
    readonly maxCodeChars: 4000;
};
export declare const TOOL_PARAMS: readonly ["query", "sources", "deepRead", "maxItems"];
/** The date the login-requirement facts below were measured live. */
export declare const LOGIN_REQUIREMENT_PROBED_AT = "2026-10-04";
/**
 * GitHub: repo search and file reads are anonymous; CODE search is not.
 *
 * Measured 2026-10-04: anonymous `GET https://api.github.com/search/code?q=vue`
 * answers **HTTP 401 `Requires authentication`**. A token is therefore
 * mandatory for code search. `github.com` itself was TCP-unreachable from this
 * machine in the same probe (see `GITHUB_HTML_ORIGIN`), which is why the OAuth
 * preflight reports reachability instead of assuming it.
 */
export declare const GITHUB_LOGIN_REQUIREMENT: string;
/**
 * Gitee: the v5 code-search endpoint does not exist; repository search needs a
 * token; public file contents are readable anonymously.
 *
 * Measured 2026-10-04: `GET https://gitee.com/api/v5/search/code?q=vue` → HTTP
 * 404 HTML「页面不存在」; `GET /api/v5/search/repositories?q=vue` → HTTP 200
 * with `[]` for an anonymous caller; `GET /api/v5/repos/{owner}/{repo}/contents/…`
 * → HTTP 200 anonymously. The web code search (search.gitee.com) renders
 * client-side and needs a logged-in session.
 */
export declare const GITEE_LOGIN_REQUIREMENT: string;
/**
 * CSDN: search is reachable anonymously, but the payload rarely carries code;
 * the article page does, and it is rate-limited/anti-bot gated without a
 * logged-in cookie.
 *
 * Measured 2026-10-04: `https://so.csdn.net/api/v3/search` → HTTP 200, 30 rows,
 * only **6** of them carrying a non-empty `body`, and **no `originalType`
 * field at all**; `blog.csdn.net` article pages → HTTP 200 with real `<pre>`
 * blocks when a browser-like User-Agent + Referer are sent, and **HTTP 521**
 * without them on some articles. A logged-in cookie raises the success rate;
 * CSDN exposes no OAuth and no token API.
 */
export declare const CSDN_LOGIN_REQUIREMENT: string;
/**
 * The robots position, stated rather than hidden.
 *
 * `https://so.csdn.net/robots.txt` is exactly `User-agent: *` +
 * `Disallow: /`; `blog.csdn.net/robots.txt` is `Allow: /`. This plugin issues
 * ONE request per user-triggered action and never crawls, which is the position
 * the UI and the README must state next to the endpoint.
 */
export declare const CSDN_ROBOTS_DISCLOSURE = "so.csdn.net/robots.txt \u58F0\u660E Disallow: /\uFF08\u8BE5\u4E3B\u673A\u4E0D\u5141\u8BB8\u81EA\u52A8\u6293\u53D6\uFF09\u3002\u672C\u63D2\u4EF6\u53EA\u5728\u4F60\u7684\u663E\u5F0F\u64CD\u4F5C\u4E0B\u53D1\u8D77\u5355\u6B21\u8BF7\u6C42\uFF0C\u4E0D\u505A\u722C\u53D6\u3001\u4E0D\u6279\u91CF\u904D\u5386\u3002";
/** Per-source login requirement, keyed by the source id used everywhere else. */
export declare const LOGIN_REQUIREMENTS: Readonly<Record<SourceId, string>>;
/**
 * How a credential can legitimately be obtained for a source.
 *
 * `oauth-device` — GitHub device flow (own OAuth App, no client secret).
 * `oauth-code`   — Gitee authorization code (own app, client secret mandator).
 * `pat`          — a personal access token the user creates in the browser.
 * `cookie-paste` — the user copies a Cookie request header out of DevTools.
 * `cookie-cdp`   — experimental: read the cookie over the browser debug port.
 */
export declare const LOGIN_METHODS: readonly ["oauth-device", "oauth-code", "pat", "cookie-paste", "cookie-cdp"];
export type LoginMethodId = (typeof LOGIN_METHODS)[number];
/** Which methods each source actually supports, in the order the UI lists them. */
export declare const SOURCE_LOGIN_METHODS: Readonly<Record<SourceId, readonly LoginMethodId[]>>;
/**
 * The two FAMILIES the wizard must keep visually apart.
 *
 * The user asked for this in so many words: a browser OAuth login is a different
 * KIND of action from copying a token or a cookie out of a browser, and dumping
 * both into one undifferentiated list is what makes a settings page unreadable.
 * The split lives here (data, not three `if`s in the view) so the wizard, its
 * tests and any future surface agree on which side a method falls.
 */
export declare const LOGIN_METHOD_FAMILIES: readonly ["oauth", "manual"];
export type LoginMethodFamily = (typeof LOGIN_METHOD_FAMILIES)[number];
/** `oauth` = the browser does the authorization; `manual` = the user copies a value. */
export declare const LOGIN_METHOD_FAMILY: Readonly<Record<LoginMethodId, LoginMethodFamily>>;
/** The methods of one family this source supports, in contract order. */
export declare function loginMethodsOf(source: SourceId, family: LoginMethodFamily): LoginMethodId[];
/** Credential kind a method produces, for the wizard's field and the label. */
export declare const LOGIN_METHOD_KIND: Readonly<Record<LoginMethodId, 'token' | 'cookie' | 'secret'>>;
/** One page the wizard offers to open, so no URL is re-typed in the UI. */
export declare const LOGIN_URLS: {
    /** GitHub: create an OAuth App. Device Flow must be ticked inside it. */
    readonly githubOAuthApp: "https://github.com/settings/applications/new";
    /** GitHub: where the device flow sends the user to type `user_code`. */
    readonly githubDeviceVerification: "https://github.com/login/device";
    /** GitHub: fine-grained PAT, prefilled for read-only public content. */
    readonly githubFineGrainedToken: "https://github.com/settings/personal-access-tokens/new?name=dsh-codehub&description=dsh-codehub+read-only+public+code+access";
    /** GitHub: classic PAT (no scope can still read public information). */
    readonly githubClassicToken: "https://github.com/settings/tokens/new";
    /** Gitee: create a 第三方应用 (callback URL must be registered here). */
    readonly giteeOAuthApp: "https://gitee.com/oauth/applications";
    /** Gitee: personal access token page. */
    readonly giteeToken: "https://gitee.com/profile/personal_access_tokens";
    /** CSDN: where the user signs in before copying the cookie. */
    readonly csdnLogin: "https://passport.csdn.net/login";
    /** CSDN: the search page the cookie is being pasted for. */
    readonly csdnSearch: "https://so.csdn.net/so/search";
};
/** One field a guide step wants the user to paste back into the plugin. */
export interface LoginGuideField {
    /** Which config/credential slot the value ends up in. */
    readonly slot: 'clientId' | 'clientSecret' | 'token' | 'cookie';
    readonly label: string;
    /** Format hint shown as the placeholder, e.g. the length/shape of the value. */
    readonly hint: string;
}
/** One numbered step of the hand-held guide. */
export interface LoginGuideStep {
    readonly title: string;
    readonly detail: string;
    /** A page to open (and to offer as a copyable URL) for this step. */
    readonly url?: string;
    /** Whether the UI should offer "open in browser" for `url`. */
    readonly openInBrowser?: boolean;
    /** Fields this step asks the user to bring back, if any. */
    readonly fields?: readonly LoginGuideField[];
}
export interface LoginGuide {
    readonly method: LoginMethodId;
    readonly title: string;
    /** One sentence on why this method needs to exist. */
    readonly why: string;
    readonly steps: readonly LoginGuideStep[];
}
/** Every guide, keyed by method. The wizard renders these verbatim. */
export declare const LOGIN_GUIDES: Readonly<Record<LoginMethodId, LoginGuide>>;
/** Method → guide lookup that keeps the PAT guides source-specific. */
export declare function loginGuideFor(source: SourceId, method: LoginMethodId): LoginGuide;
export declare const GITHUB_DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
export declare const GITHUB_DEVICE_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
/** Where the device flow tells the user to type the code. */
export declare const GITHUB_DEVICE_VERIFICATION_URI = "https://github.com/login/device";
export declare const GITEE_OAUTH_AUTHORIZE_ENDPOINT = "https://gitee.com/oauth/authorize";
export declare const GITEE_OAUTH_TOKEN_ENDPOINT = "https://gitee.com/oauth/token";
/** The loopback path the Gitee authorization code comes back to. */
export declare const OAUTH_CALLBACK_PATH = "/api/dsh-codehub/oauth/callback";
/** One flow lives at most this long; both providers expire around here too. */
export declare const OAUTH_FLOW_TTL_MS: number;
/** `slow_down` means: wait at least this much longer before the next poll. */
export declare const OAUTH_SLOW_DOWN_STEP_MS = 5000;
/** Credential ref holding the user's own Gitee OAuth client secret. */
export declare const GITEE_OAUTH_SECRET_REF = "DSH_CODEHUB_GITEE_OAUTH_CLIENT_SECRET";
/** Fixed row order of the connectivity panel. */
export declare const CONNECTIVITY_ROW_ORDER: readonly ["github", "gitee", "csdn"];
export declare const CONNECTIVITY_STATUSES: readonly ["undetected", "running", "ok", "failed"];
export type ConnectivityStatus = (typeof CONNECTIVITY_STATUSES)[number];
/** A failed row shows at most this many lines of reason before truncating. */
export declare const CONNECTIVITY_MAX_REASON_LINES = 4;
/** Default browser debug port for the experimental CDP cookie capture. */
export declare const CDP_DEFAULT_PORT = 9222;
/**
 * The dedicated profile the launcher starts Chromium with.
 *
 * It lives under `$DSH_HOME` because it holds a logged-in browser session: that is
 * exactly as sensitive as the cookie we are about to read, so it must never sit
 * inside a repository or a shared temp directory.
 */
export declare const CDP_USER_DATA_DIR_NAME = "dsh-codehub-browser";
/**
 * Chromium rejects a CDP websocket whose `Origin` it does not allow (Chrome 111+),
 * so the launcher passes this flag — the user asked for it explicitly, and without
 * it attaching from a non-browser client can fail with a 403 during the handshake.
 * The cost is stated in the UI: it lets any origin that can reach the loopback port
 * talk to the debugger, which is why the port stays on 127.0.0.1 and the whole
 * capability is opt-in twice over.
 */
export declare const CDP_REMOTE_ALLOW_ORIGINS_FLAG = "--remote-allow-origins=*";
/** The only hosts the CDP cookie capture is ever allowed to read for. */
export declare const CDP_COOKIE_HOSTS: readonly ["https://www.csdn.net", "https://so.csdn.net", "https://blog.csdn.net"];
