/**
 * dsh-codehub — local store: `$DSH_HOME/dsh-codehub.json` (0600).
 *
 * WHAT LIVES HERE, AND WHY
 * ------------------------
 * Exactly one class of value: things that are sensitive but are NOT credentials.
 * Today that is the local proxy address (备注① target, docs/DESIGN.md §4) plus a
 * fallback configuration snapshot used while the settings RPC cannot persist our
 * namespace.
 *
 * Credentials never come near this file. `ctx.credentials` owns them, and this
 * module enforces that structurally rather than by convention:
 *
 *   - only three top-level keys are ever written (`localProxy`,
 *     `fallbackConfig`, `updatedAt`);
 *   - every nested key is passed through `isSecretKey()` from `config.ts`, so a
 *     value that reached the store under a name like `giteeToken`,
 *     `csdnCookie` or `authorization` is DROPPED on both write and read;
 *   - the scrubber is depth- and size-bounded, so a hostile or buggy caller
 *     cannot use the store as an unbounded blob either.
 *
 * Hence the counter-example in docs/DESIGN.md §4 — `dsh-ssh` writing an SSH
 * password in plaintext next to its config — is not repeatable here even by
 * accident: there is no code path that copies an arbitrary object into the file.
 *
 * PERMISSIONS
 * -----------
 * Directory `0700`, file `0600`, applied at creation AND re-applied after the
 * atomic rename (`rename` keeps the temp file's mode, but a pre-existing target
 * on some filesystems would otherwise win). Windows ignores POSIX mode bits for
 * anything but the read-only flag, so `chmod` is best-effort and never fatal.
 */
import type { CodehubConfig } from './config.js';
/** File name inside `$DSH_HOME`. */
export declare const STORE_FILE_NAME = "dsh-codehub.json";
/** Directory mode for `$DSH_HOME` (only applied when we create it). */
export declare const STORE_DIR_MODE = 448;
/** File mode for the store. 0600 = owner read/write only. */
export declare const STORE_FILE_MODE = 384;
/** Aliases kept because the project brief names these modes directly. */
export declare const DIR_MODE = 448;
export declare const FILE_MODE = 384;
/** Bounds of the scrubber. Anything larger is truncated rather than trusted. */
export declare const SCRUB_LIMITS: {
    readonly maxDepth: 4;
    readonly maxArrayItems: 64;
    readonly maxStringChars: 512;
};
/** The store's on-disk shape. `fallbackConfig` is a partial `CodehubConfig`. */
export interface LocalConfig {
    /** 备注① target — the only persisted proxy address. Never logged. */
    readonly localProxy?: string;
    /** Snapshot used ONLY while the settings service cannot persist our namespace. */
    readonly fallbackConfig?: CodehubConfig;
    /** ISO-8601 stamp of the last write, for diagnostics. */
    readonly updatedAt?: string;
}
export interface StoreWriteOutcome {
    readonly ok: boolean;
    readonly path: string;
    readonly value: LocalConfig;
    readonly error?: string;
}
export interface StoreDiagnostics {
    readonly path: string;
    readonly directory: string;
    readonly exists: boolean;
    readonly readable: boolean;
    /** Present when the file exists but could not be parsed. Never contains values. */
    readonly error?: string;
}
/** `$DSH_HOME`, else `$XDG_CONFIG_HOME/dsh`, else `~/.dsh`. */
export declare function resolveDshHome(): string;
export declare function resolveStorePath(home?: string): string;
/**
 * Depth- and size-bounded, secret-key-dropping JSON scrubber.
 *
 * Exported so tests can prove a token cannot round-trip through the store.
 */
export declare function scrubValue(value: unknown, depth?: number): unknown;
/** Trim a proxy address; drop control characters and absurd lengths. */
export declare function normalizeLocalProxy(value: unknown): string | undefined;
/**
 * Whitelist-and-scrub a parsed store file into `LocalConfig`.
 *
 * Unknown top-level keys are dropped, so a hand-edited file cannot introduce a
 * field this plugin would then start trusting.
 */
export declare function sanitizeLocalConfig(value: unknown): LocalConfig;
/**
 * Serialised, atomic, permission-tight access to the store file.
 *
 * `write()` merges into whatever is already on disk (so two independent fields
 * cannot clobber each other) and is queued in-process, which makes concurrent
 * PATCH requests from the browser panel safe without a lock file.
 */
export declare class LocalConfigStore {
    readonly filePath: string;
    private queue;
    constructor(filePath?: string);
    /** Never throws: a missing or corrupt file reads as `{}`. */
    read(): Promise<LocalConfig>;
    /** Merge `patch` on top of the current file, scrub, then write atomically. */
    write(patch: LocalConfig): Promise<StoreWriteOutcome>;
    /** Diagnostics for the `detect` route. Never returns stored values. */
    diagnostics(): Promise<StoreDiagnostics>;
    private persist;
}
