/**
 * dsh-codehub — 深度阅读 → 思路笔记（备注③）.
 *
 * Output is a `LearnNote`, never a file copy:
 *
 *   approach    架构 / 整体做法，散文
 *   apiContract 公开 API 契约 —— 散文或**签名**（签名是契约，不是源码副本）
 *   tradeoffs   实现取舍与备选
 *   pitfalls    坑与失败模式
 *
 * Mechanism-level guarantees:
 *   • File bodies are never copied: only sentence-level prose (via
 *     `learn/summary.ts`, which strips code blocks before reading) and
 *     single-line signatures are kept.
 *   • Every bullet is collapsed to ONE line and bounded by
 *     `DEEPREAD_MAX_BULLET_CHARS`, so a pasted body cannot survive.
 *   • `sourceUrls[]` lists the files each set of claims came from, so every
 *     claim stays traceable.
 *
 * The module performs no network I/O of its own: the adapter injects a
 * `DeepReadFetch` (备注①), which makes the whole pipeline unit-testable with a
 * fake fetcher.
 */
import type { DeepReadTarget, FailureKind, LearnNote } from '../contract.js';
import type { AdapterDeepOutcome } from '../sources/types.js';
/** Caps that keep a note a note. Exported so tests can assert them. */
export declare const DEEPREAD_MAX_FILES = 6;
export declare const DEEPREAD_MAX_CHARS_PER_FILE = 40000;
export declare const DEEPREAD_MAX_BULLETS = 8;
export declare const DEEPREAD_MAX_BULLET_CHARS = 200;
export declare const DEEPREAD_MAX_APPROACH_CHARS = 1200;
/**
 * Hard bound on requests one deep read may issue. Candidate lists are
 * conventional guesses, and without this bound a repo whose README is not at
 * the first path would cost dozens of 404s.
 */
export declare const DEEPREAD_MAX_ATTEMPTS = 12;
/** One file that was successfully read. */
export interface DeepReadSource {
    readonly url: string;
    readonly target: DeepReadTarget;
    readonly text: string;
    /** Human label, e.g. the repo-relative path. */
    readonly label?: string;
}
/** A file the adapter wants read, already resolved to a fetchable URL. */
export interface DeepReadCandidate {
    readonly url: string;
    readonly target: DeepReadTarget;
    readonly label?: string;
}
/** Injected reader. Never throws: a failure is a value (or is caught below). */
export type DeepReadFetchResult = {
    readonly ok: true;
    readonly url: string;
    readonly text: string;
} | {
    readonly ok: false;
    readonly url: string;
    readonly failure: FailureKind;
    readonly reason: string;
};
export type DeepReadFetch = (url: string) => Promise<DeepReadFetchResult>;
export interface DeepReadRun {
    /** Canonical repo / source URL the note is about. */
    readonly url: string;
    readonly title: string;
    /** Targets the user asked for. */
    readonly requested: readonly DeepReadTarget[];
    /** Candidate files in try order; the adapter builds these. */
    readonly candidates: readonly DeepReadCandidate[];
    readonly fetchFile: DeepReadFetch;
    readonly maxFiles?: number;
    readonly maxCharsPerFile?: number;
}
/** Collapse to a single bounded line; returns null for empty input. */
export declare function sanitizeBullet(text: string, limit?: number): string | null;
/** Conventional paths for one deep-read target. */
export declare function candidatePaths(target: DeepReadTarget): readonly string[];
/** Which target a repo-relative path belongs to. */
export declare function classifyDeepReadTarget(path: string): DeepReadTarget;
/**
 * Pull public API *signatures* out of a file. Only the declaration line is
 * kept, cut at the first body brace, so no function body can leak.
 */
export declare function signaturesFrom(text: string, limit?: number): readonly string[];
export interface ManifestFacts {
    readonly apiContract: readonly string[];
    readonly pitfalls: readonly string[];
    readonly approach: readonly string[];
}
/** Facts read from a manifest that the note can safely assert. */
export declare function manifestFacts(text: string): ManifestFacts;
/** Build the note. Pure: same sources in, same note out. */
export declare function distillNote(input: {
    readonly url: string;
    readonly title: string;
    readonly sources: readonly DeepReadSource[];
}): LearnNote;
/**
 * Round-robin the candidate list by target so one long conventional list
 * (test files, say) cannot starve the other requested targets.
 */
export declare function interleaveCandidates(candidates: readonly DeepReadCandidate[]): DeepReadCandidate[];
/** Read the candidate files, then distill. Never returns a file copy. */
export declare function deepReadFiles(run: DeepReadRun): Promise<AdapterDeepOutcome>;
/** Failure kinds that mean "try another rung", surfaced for adapters. */
export declare const DEEPREAD_RETRYABLE_HINT = "network/timeout/rate-limited/auth-required \u7531\u964D\u7EA7\u94FE\u51B3\u5B9A\u662F\u5426\u6362\u6E90";
/** Convenience: a one-line human summary of a note, for reasons and logs. */
export declare function describeNote(note: LearnNote): string;
