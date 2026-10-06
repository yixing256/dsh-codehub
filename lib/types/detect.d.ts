/**
 * dsh-codehub — environment probes for the GitHub access picker (docs/DESIGN.md §3).
 *
 * WHAT THIS ANSWERS, AND WHAT IT REFUSES TO CLAIM
 * ----------------------------------------------
 * The user must be able to see whether a system proxy, a SOCKS5 endpoint, Watt
 * Toolkit or a hosts entry is already in place, because "detected" changes which
 * access strategy is worth selecting. It does NOT mean "enabled": Watt Toolkit
 * still has to be switched on by the user, and hosts entries still have to be
 * correct. The report says what was OBSERVED and nothing more — every inference
 * is spelled out in `notes`.
 *
 * Sources, in order of trust:
 *   1. the OS environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / lowercase),
 *   2. the Windows per-user Internet Settings registry keys, read with a fixed
 *      `reg.exe query` invocation (fixed binary, fixed arguments, no shell, a
 *      hard timeout, failures swallowed). This is a read-only local probe — it
 *      is not "spawning remote code", and it is the only dependency-free way to
 *      see the system proxy on Windows,
 *   3. the hosts file, scanned for GitHub/Gitee/CSDN-related names,
 *   4. candidate Watt Toolkit install directories.
 *
 * Nothing here sends a packet: a probe never touches the network, and the
 * plugin still installs no proxy of its own. Addresses appear in the REPORT
 * (the browser half displays them) but never in a log line — `notes` is
 * deliberately address-free.
 */
/** Registry key holding the per-user proxy configuration. */
export declare const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** Hard cap on the registry probe; a slow `reg.exe` must not stall the route. */
export declare const REGISTRY_TIMEOUT_MS = 2500;
/** Hostnames whose presence in the hosts file is worth reporting. */
export declare const HOSTS_INTEREST: readonly ["github.com", "githubusercontent.com", "githubassets.com", "ghproxy", "ghfast", "gitmirror", "gitee.com", "csdn.net"];
export interface ProxyDetection {
    readonly enabled: boolean;
    readonly source: 'env' | 'registry' | 'none';
    /** The address the OS would use, or `false`. */
    readonly systemProxy: string | false;
    /** A configured-but-disabled address, or `false`. */
    readonly configuredProxy: string | false;
    /** The first SOCKS5 endpoint found anywhere, or `false`. */
    readonly socks5: string | false;
    readonly httpProxy?: string;
    readonly httpsProxy?: string;
    readonly allProxy?: string;
    readonly noProxy?: string;
    readonly notes: readonly string[];
}
export interface WattDetection {
    readonly detected: boolean;
    readonly evidence: readonly string[];
    readonly note: string;
}
export interface HostsDetection {
    readonly path: string;
    readonly readable: boolean;
    readonly entries: readonly string[];
    readonly note: string;
}
export interface DetectReport {
    readonly platform: string;
    readonly generatedAt: string;
    /** The four fields the browser half renders. */
    readonly systemProxy: string | false;
    readonly socks5: string | false;
    readonly watt: boolean;
    readonly hosts: boolean;
    readonly proxyEnabled: boolean;
    readonly proxySource: string;
    /** The proxy configured in the plugin itself, if any (already known to the UI). */
    readonly pluginProxy: string | false;
    readonly wattDetail: readonly string[];
    readonly hostsEntries: readonly string[];
    readonly hostsPath: string;
    readonly notes: readonly string[];
}
/** Candidate install directories, relative to a Windows root variable. */
export declare const WATT_INSTALL_HINTS: readonly [readonly ["ProgramFiles", "Watt Toolkit"], readonly ["ProgramFiles(x86)", "Watt Toolkit"], readonly ["LOCALAPPDATA", "Watt Toolkit"], readonly ["ProgramFiles", "Steam++"], readonly ["ProgramFiles(x86)", "Steam++"], readonly ["LOCALAPPDATA", "Steam++"]];
export interface DetectOptions {
    /** The proxy address configured in the plugin, if any. */
    readonly localProxy?: string | undefined;
}
/**
 * Run every probe. Never throws: an unavailable probe reports what it could not
 * see, because "unknown" is a legitimate answer for a picker to render.
 */
export declare function detectEnvironment(options?: DetectOptions): Promise<DetectReport>;
