/**
 * dsh-codehub — the plugin's own loopback route family (`/api/dsh-codehub/*`).
 *
 * WHY THESE ROUTES ARE THE PRIMARY CONFIG PATH
 * -------------------------------------------
 * DSH's settings RPC only serves a whitelist of namespaces, so `settingsScope`
 * on the browser side can honestly report `status: 'unavailable'` for this
 * plugin. The panel and the settings card therefore read and write through these
 * routes (docs/DESIGN.md §5); `settingsScope` stays an optional enhancement.
 *
 * THE FENCE IS NOT OPTIONAL
 * -------------------------
 * The harness's own `/api` fence does NOT cover routes a plugin registers
 * itself. So every handler below starts with `isLoopbackRequest()` and answers
 * `403 {error:'forbidden: loopback-only'}` for anything else — this route family
 * can read configuration, write decisions and write CREDENTIALS, so a non-local
 * caller must never reach the body of a handler.
 *
 * The credentials route is the sharpest edge here: the value is read out of the
 * request body exactly once and handed to `ctx.credentials`. It is never logged,
 * never echoed back, never put in a response, and never written to the store.
 * The response only ever carries booleans.
 *
 * One `(kind, path)` may hold exactly ONE handler on this runtime, so each path
 * dispatches on `req.method` itself and answers `405` (with `Allow`) otherwise.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { WebServerService } from '@deepseek-ai/dsh-host-webserver';
import type { CdpCaptureInput, CdpCaptureResult } from './cdp.js';
import type { BrowserLauncher } from './launcher.js';
import type { TransportLogger } from './net.js';
import type { OAuthService } from './oauth.js';
import { type CodeSource } from './service.js';
import { type SettingsBridge } from './settings.js';
import type { LocalConfigStore } from './store.js';
/** Request bodies are tiny (a patch or one credential); anything larger is refused. */
export declare const MAX_BODY_BYTES: number;
/** The ten paths this plugin owns, all under `contract.API_PREFIX`. */
export declare const ROUTE_PATHS: {
    readonly config: "/api/dsh-codehub/config";
    readonly decisions: "/api/dsh-codehub/decisions";
    readonly detect: "/api/dsh-codehub/detect";
    readonly credentials: "/api/dsh-codehub/credentials";
    readonly deepread: "/api/dsh-codehub/deepread";
    readonly smoke: "/api/dsh-codehub/smoke";
    readonly oauth: "/api/dsh-codehub/oauth";
    /**
     * The OAuth callback is the SAME path the provider is told to redirect to, so
     * it is read from the contract instead of being re-spelled here — a mismatch
     * between the registered Gitee callback and the route would be invisible.
     */
    readonly oauthCallback: "/api/dsh-codehub/oauth/callback";
    readonly probe: "/api/dsh-codehub/probe";
    readonly cookies: "/api/dsh-codehub/cookies";
    /** Starts a debuggable Chromium when the CDP port is not listening yet. */
    readonly launchBrowser: "/api/dsh-codehub/launch-browser";
};
export type RoutePathKey = keyof typeof ROUTE_PATHS;
/**
 * True only for a request that arrived over a loopback socket.
 *
 * `true` is not returned for an empty/unknown `remoteAddress`: failing closed is
 * the whole point of the fence.
 */
export declare function isLoopbackRequest(req: IncomingMessage): boolean;
export declare function writeJson(res: ServerResponse, status: number, payload: unknown): void;
export interface BodyResult {
    readonly ok: boolean;
    readonly status: number;
    readonly value?: unknown;
    readonly error?: string;
}
/**
 * Read and parse a JSON body with a hard size cap.
 *
 * The raw text is never logged: a credential arrives this way.
 */
export declare function readJsonBody(req: IncomingMessage): Promise<BodyResult>;
export interface RouteDeps {
    /** `ctx.get('webServer')` — required, checked by the caller. */
    readonly webServer: WebServerService;
    /** `ctx.get('credentials')` is looked up lazily; never accessed as a property. */
    readonly ctx: Context;
    readonly service: CodeSource;
    readonly store: LocalConfigStore;
    readonly settings: SettingsBridge;
    readonly logger?: TransportLogger | undefined;
    /**
     * The browser-login engine. Optional so a host without it still mounts: the
     * `/oauth` routes then answer `503` instead of pretending to work.
     */
    readonly oauth?: OAuthService | undefined;
    /** Test seam for the experimental CDP capture; defaults to the real one. */
    readonly captureCookies?: ((input: CdpCaptureInput) => Promise<CdpCaptureResult>) | undefined;
    /**
     * The local launcher that starts a debuggable Chromium. Optional like the OAuth
     * engine: without it `/launch-browser` answers 503 rather than pretending.
     */
    readonly launcher?: BrowserLauncher | undefined;
}
/**
 * Register every route and return ONE disposer.
 *
 * A duplicate `(kind, path)` throws on this runtime, so each registration is
 * guarded individually: one failed path must not take the others down.
 */
export declare function registerRoutes(deps: RouteDeps): () => void;
