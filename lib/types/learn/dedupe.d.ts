/**
 * dsh-codehub — 去重（纯函数）.
 *
 * Two passes, in this order:
 *
 *   1. URL — `normalizeUrl()` drops the query string and the fragment, folds
 *      case, removes the default port, folds `www.` and the trailing slash.
 *   2. Content — `contentFingerprint()` hashes title + summary + excerpt after
 *      stripping whitespace, markup and punctuation, so the same snippet served
 *      by two sources (or by a mirror) collapses.
 *
 * The first row wins by default and the row's own `url` keeps its original
 * case, because `normalizeUrl()` is a key function, not a display transform.
 * No clock, no network, no globals: safe to unit test directly.
 */
import type { CodeLearnResult, LearnNote } from '../contract.js';
/** How to resolve a collision. */
export type DedupePreference = 'first' | 'confidence';
export interface DedupeOptions {
    /** Compare content fingerprints as well as URLs. Default true. */
    readonly byContent?: boolean;
    /** Keep the first row (default) or the highest-confidence one. */
    readonly prefer?: DedupePreference;
}
export interface DedupeStats {
    readonly input: number;
    readonly kept: number;
    readonly droppedByUrl: number;
    readonly droppedByContent: number;
}
export interface DedupeResult {
    readonly results: CodeLearnResult[];
    readonly stats: DedupeStats;
}
/**
 * Canonical dedupe key for a URL: no query, no fragment, lower case, no default
 * port, no `www.` prefix, no trailing slash. Unparseable input degrades to a
 * conservative textual normalization instead of throwing.
 */
export declare function normalizeUrl(url: string): string;
/** Alias of `normalizeUrl()`, named for how it is used. */
export declare function urlKey(url: string): string;
/** 64-bit FNV-1a, rendered as 16 hex chars. Deterministic, non-cryptographic. */
export declare function fnv1a64(text: string): string;
/**
 * Content fingerprint over the takeaway-bearing fields. The normalized length
 * is prefixed so two different payloads cannot collide on the hash alone
 * without also agreeing on size.
 */
export declare function contentFingerprint(input: {
    readonly title?: string;
    readonly code?: string;
    readonly learned_summary?: string;
}): string;
/** True when two rows carry the same takeaway content. */
export declare function isSameContent(a: CodeLearnResult, b: CodeLearnResult): boolean;
/**
 * Collapse duplicate rows. Order is stable: the surviving row keeps the
 * position of the first occurrence of its key.
 */
export declare function dedupeResults(results: readonly CodeLearnResult[], opts?: DedupeOptions): DedupeResult;
/**
 * Convenience wrapper for callers that only want the rows: same algorithm as
 * `dedupeResults()`, returns the array (stable order, first occurrence wins).
 */
export declare function dedupe(results: readonly CodeLearnResult[]): CodeLearnResult[];
/** Collapse notes by their source URL, keeping the first of each. */
export declare function dedupeNotes(notes: readonly LearnNote[]): LearnNote[];
/** Merge two result lists with dedupe; `primary` rows win on ties. */
export declare function mergeResults(primary: readonly CodeLearnResult[], secondary: readonly CodeLearnResult[], opts?: DedupeOptions): DedupeResult;
