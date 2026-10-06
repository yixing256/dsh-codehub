/**
 * dsh-codehub — launch a debuggable Chromium so the CDP cookie capture can work.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The experimental capture needs `http://127.0.0.1:<port>/json/version` to answer,
 * which the user can only get by starting a browser with
 * `--remote-debugging-port=…`. Telling the user to do that by hand is where the
 * feature died in practice: they open their normal browser, the flag is ignored
 * (an already-running instance owns the profile), and the plugin reports 'timeout'
 * forever. So the plugin does it: probe first, and if nothing is listening, find a
 * Chromium, start it on its OWN profile with the right flags, and wait for the
 * debugger URL to appear.
 *
 * WHY A SEPARATE `--user-data-dir`
 * --------------------------------
 * Chromium refuses to open a debug port on a profile that another process already
 * owns, and on some builds it refuses on the *default* profile at all. A dedicated
 * directory under `$DSH_HOME` therefore always works — at the cost that it starts
 * empty, which is why the caller opens the CSDN login page in it.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * - It never touches the user's normal profile: no reading, no copying, no locking.
 * - It never downloads a browser, and refuses when it cannot find one.
 * - It does not inject anything into the page, and it holds no credential: the
 *   cookie capture reads browser state over CDP in `cdp.ts`, and what it finds goes
 *   straight to the credential service.
 *
 * The profile directory IS sensitive (it holds the logged-in session), so it lives
 * under `$DSH_HOME` with mode 0700 and is never inside a repository.
 */
import { spawn } from 'node:child_process';
import type { FetchLike } from './net.js';
/** A Chromium-family executable this machine actually has. */
export interface BrowserCandidate {
    readonly id: 'chrome' | 'edge' | 'brave' | 'chromium';
    readonly label: string;
    readonly path: string;
}
export type LaunchFailure = 'no-browser' | 'spawn-failed' | 'timeout' | 'bad-port' | 'unsupported';
export interface LaunchOk {
    readonly ok: true;
    /** False when a debugger was already listening (nothing was started). */
    readonly launched: boolean;
    readonly browser: BrowserCandidate | null;
    readonly port: number;
    readonly userDataDir: string;
    /** The `webSocketDebuggerUrl` the capture will attach to. Loopback, not secret. */
    readonly debuggerUrl: string;
    /** Free-form, value-free status line for the UI. */
    readonly reason: string;
}
export interface LaunchFailureResult {
    readonly ok: false;
    readonly failure: LaunchFailure;
    /** Value-free; safe to render and to log. */
    readonly reason: string;
    /** Where the launcher looked, so "no browser" is actionable. */
    readonly searched?: readonly string[];
}
export type LaunchResult = LaunchOk | LaunchFailureResult;
export interface LaunchInput {
    readonly port: number;
    /** Page to open in the new window (the CSDN login page by default). */
    readonly url?: string;
    /** Pin a browser by id; omitted = first candidate wins. */
    readonly browserId?: BrowserCandidate['id'] | undefined;
    /** Override the profile directory (tests, or a user with a preferred path). */
    readonly userDataDir?: string;
    readonly timeoutMs?: number;
}
/** Injection points. Everything has a production default; tests override. */
export interface LauncherDeps {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly exists?: (path: string) => boolean;
    readonly mkdirp?: (path: string) => void;
    readonly spawnImpl?: typeof spawn;
    readonly fetchImpl?: FetchLike;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly dshHome?: string;
    /** Override the dedicated profile directory (defaults to `$DSH_HOME/<name>`). */
    readonly userDataDir?: string;
}
export interface BrowserLauncher {
    /** Every Chromium-family executable found, in preference order. */
    listBrowsers(): BrowserCandidate[];
    /** Probe, then start one if nothing is listening. */
    launch(input: LaunchInput): Promise<LaunchResult>;
    /** Where the dedicated profile lives (also used to explain the cost). */
    userDataDir(): string;
}
/**
 * Build the launcher.
 *
 * The interface is three methods on purpose: `listBrowsers()` for the UI's picker,
 * `launch()` for the action, and `userDataDir()` so the copy can say where the
 * session lives. Everything else (paths, flags, polling) stays inside.
 */
export declare function createBrowserLauncher(deps?: LauncherDeps): BrowserLauncher;
