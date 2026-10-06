/**
 * dsh-codehub — 降级链（纯函数式，可注入回调）.
 *
 * Rules encoded here, not left to the caller:
 *
 *   1. **只对 `RETRYABLE_FAILURES` 前进。** A rung whose failure is `empty`,
 *      `parse-failed` or `not-code` is FINAL for the chain — retrying an
 *      unchanged request cannot fix those, so the chain stops and the caller
 *      moves on to the next source. 备注①「不重试」的另一半是「不浪费请求」。
 *   2. **不无限递归。** `withFailover()` is a `for` loop over a pre-planned rung
 *      list; there is no self-call anywhere in this file. The list length is
 *      `min(chain.length, maxDepth + 1)` and `maxDepth` is clamped into
 *      `[0, HARD_LIMITS.maxDepth]`, so at most 4 rungs can ever run.
 *   3. **成功即停。** The first rung that returns a non-null value wins, and no
 *      later rung is contacted.
 *
 * The callback is injected, so the whole thing is unit-testable with a fake
 * attempt function and zero network.
 */
import type { FailureKind, GithubAccessId, SourceId, TransportId } from '../contract.js';
/** One rung of the user-configured `failover.chain`. */
export interface FailoverEntry {
    /** Stable id used in reasons and tests, e.g. `direct`, `ghproxy`. */
    readonly id: string;
    /** Human label for the rendered reason; defaults to `id`. */
    readonly label?: string;
    /** GitHub access strategy this rung corresponds to, when applicable. */
    readonly access?: GithubAccessId;
    /** Transport override for this rung. */
    readonly transport?: TransportId;
    /** Base override (proxy / mirror / raw mirror) for this rung. */
    readonly base?: string;
    /** Source this rung re-enters; absent means "same source, another strategy". */
    readonly source?: SourceId;
}
/** What one rung produced. `value === null` with no `failure` counts as `empty`. */
export interface RungResult<T> {
    readonly value: T | null;
    readonly failure?: FailureKind;
    readonly reason: string;
}
/** Context handed to the attempt callback. */
export interface RungContext {
    readonly index: number;
    /** 0 for the primary rung; increments once per fallback. */
    readonly depth: number;
}
export type FailoverAttemptFn<T> = (entry: FailoverEntry, context: RungContext) => Promise<RungResult<T>>;
export interface FailoverOptions {
    /** Budget of *extra* rungs. Clamped into `[0, HARD_LIMITS.maxDepth]`. */
    readonly maxDepth?: number;
    /** Override retryability (defaults to `RETRYABLE_FAILURES`). */
    readonly isRetryable?: (failure: FailureKind | undefined) => boolean;
    /** Extra clause appended to the final reason, e.g. a transport note (备注①). */
    readonly note?: string;
}
/** One rung as it actually ran. */
export interface FailoverAttempt<T> {
    readonly entry: FailoverEntry;
    readonly depth: number;
    readonly ok: boolean;
    readonly failure?: FailureKind;
    readonly reason: string;
    readonly value: T | null;
}
export interface FailoverResult<T> {
    readonly ok: boolean;
    readonly value: T | null;
    /** The failure that ended the chain, when it ended unsuccessfully. */
    readonly failure?: FailureKind;
    readonly reason: string;
    readonly attempts: readonly FailoverAttempt<T>[];
    /** Rungs actually attempted. */
    readonly steps: number;
    /** `steps - 1`, i.e. the fallback depth consumed. */
    readonly depth: number;
    /** Chain ended unsuccessfully while rungs remained (retryable failure). */
    readonly exhausted: boolean;
}
/** Accept plain strategy ids or full entries, so config can stay simple. */
export declare function toFailoverEntries(chain: readonly (string | FailoverEntry)[]): readonly FailoverEntry[];
/**
 * The rungs that may actually run, given the depth budget.
 * `maxDepth: 0` → primary only; `maxDepth: 1` → primary + one fallback.
 */
export declare function planRungs(chain: readonly FailoverEntry[], maxDepth: number | undefined): readonly FailoverEntry[];
/** Should the chain advance past this failure? */
export declare function shouldAdvance(failure: FailureKind | undefined, options?: FailoverOptions): boolean;
/**
 * Walk the chain until a rung succeeds, a non-retryable failure lands, or the
 * depth budget runs out. Never recurses; never runs more than
 * `planRungs().length` rungs.
 */
export declare function withFailover<T>(chain: readonly FailoverEntry[], options: FailoverOptions, attempt: FailoverAttemptFn<T>): Promise<FailoverResult<T>>;
/** Convenience: the chain advanced past at least one rung before succeeding. */
export declare function usedFallback<T>(result: FailoverResult<T>): boolean;
/** Convenience: the failure kinds the default predicate advances past. */
export declare function retryableKinds(): readonly FailureKind[];
