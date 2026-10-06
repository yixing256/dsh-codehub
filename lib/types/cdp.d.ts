/**
 * dsh-codehub — experimental cookie capture over the browser debug port (CDP).
 *
 * INTERFACE FROZEN IN PHASE 0 (docs/DESIGN.md §7). W1 implements the bodies;
 * `src/routes.ts` (`POST /api/dsh-codehub/cookies`) and the wizard call it.
 *
 * WHY THIS IS OPT-IN AND OFF BY DEFAULT
 * -------------------------------------
 * CSDN exposes no OAuth and no token API, so a session cookie is the only
 * credential — and its session cookies may be HttpOnly, which makes the common
 * "run document.cookie in the console" advice useless. Reading them from the
 * browser is therefore the only automated path, and it has a real cost: the
 * user must start their browser with `--remote-debugging-port`, which exposes a
 * port any local process can talk to. That trade is the user's to make, so:
 *
 *   • `csdn.cdpEnabled` must be true (default false) AND
 *   • the request must carry `consent: true`, and the UI must have shown the
 *     warning text — a missing consent is a refusal, not a default.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * No browser is spawned or bundled; no cookie database is read (Chrome's
 * DPAPI/App-Bound encryption is deliberately out of scope); no root CA is
 * installed; no proxy is started. It opens one websocket to 127.0.0.1 and asks
 * `Network.getCookies` for the requested origins.
 *
 * PRIVACY OF THE RESULT
 * ---------------------
 * The returned `cookieHeader` is the one value that must reach the credential
 * service and nothing else: not a log line, not an HTTP response, not a thrown
 * error. The response shape the browser half sees carries NAMES and COUNTS.
 */
import type { FetchLike } from './net.js';
/** The minimal websocket surface this module needs (global `WebSocket` fits). */
export interface WebSocketLike {
    send(data: string): void;
    close(): void;
    addEventListener?(type: string, listener: (event: unknown) => void): void;
    on?(type: string, listener: (...args: never[]) => void): void;
    /**
     * `0` = CONNECTING, `1` = OPEN. Optional because a test double may not model it;
     * when it is missing the send goes out immediately (see `readCookies`).
     */
    readonly readyState?: number;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
export interface CdpCaptureInput {
    /** Debug port on 127.0.0.1. Non-loopback hosts are refused. */
    readonly port: number;
    /** Origins whose cookies are collected. Defaults to `CDP_COOKIE_HOSTS`. */
    readonly origins?: readonly string[];
    /** Must be literally true; anything else is a refusal. */
    readonly consent: boolean;
    readonly timeoutMs?: number;
    /** Test seams. */
    readonly fetchImpl?: FetchLike;
    readonly wsFactory?: WebSocketFactory;
}
export type CdpFailure = 'consent-required' | 'unavailable' | 'network' | 'empty' | 'unsupported';
export interface CdpCaptureOk {
    readonly ok: true;
    /**
     * The `name=value; name=value` header. Callers hand this straight to the
     * credential service; it must never be echoed, logged or persisted.
     */
    readonly cookieHeader: string;
    /** Cookie NAMES only — safe to show the user. */
    readonly names: readonly string[];
    readonly hosts: readonly string[];
}
export interface CdpCaptureFailure {
    readonly ok: false;
    readonly failure: CdpFailure;
    /** Value-free explanation, safe to render and to log. */
    readonly reason: string;
}
export type CdpCaptureResult = CdpCaptureOk | CdpCaptureFailure;
export interface CdpDeps {
    readonly fetchImpl?: FetchLike;
    readonly wsFactory?: WebSocketFactory;
}
/**
 * Read the requested sites' cookies once, over the browser's debug port.
 *
 * STRATEGY (and why it is two attempts, not one):
 *   1. `Storage.getCookies` on the BROWSER endpoint — needs no page attachment,
 *      so it works even when the user has no CSDN tab open. Its answer covers
 *      every site in the browser context, so it is filtered down to the requested
 *      hosts before it can become a credential.
 *   2. If the browser endpoint refuses that method (older Chromium, or a
 *      WebSocket peer that only serves page sessions), attach to a PAGE target
 *      from `/json/list` and ask the page-scoped `Network.getCookies` instead.
 * A CDP error is reported as itself — never as a timeout.
 */
export declare function captureBrowserCookies(input: CdpCaptureInput, deps?: CdpDeps): Promise<CdpCaptureResult>;
