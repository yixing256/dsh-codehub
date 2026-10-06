/**
 * dsh-codehub — 置信度与理由（纯函数）.
 *
 * `confidence` is a function of exactly four things, per the brief:
 *
 *   源等级（SOURCE_WEIGHT）× 是否登录 × 是否转载 × 解析完整度
 *
 * CSDN carries the lowest source weight and can therefore never reach `high`
 * on its own (see `CSDN_CONFIDENCE_CEILING`). The same call also produces the
 * one-sentence `reason`; extra clauses handed in by a caller — such as a
 * transport-provenance note (备注①) — are appended verbatim, never dropped.
 *
 * Everything here is pure: no clock, no network, no globals.
 */
import type { Confidence, SourceId } from '../contract.js';
import type { Score, ScoreInput } from '../sources/types.js';
/** Source tier. GitHub 3 > Gitee 2 > CSDN 1 — CSDN is a supplement only. */
export declare const SOURCE_WEIGHT: Readonly<Record<SourceId, number>>;
/** Denominator used in the rendered reason. */
export declare const MAX_SOURCE_WEIGHT = 3;
/** Points awarded when the call was authenticated. */
export declare const AUTH_BONUS = 1;
/** Points removed for a reposted (non-original) item. */
export declare const REPOST_PENALTY = 2;
/** Completeness bands. */
export declare const COMPLETENESS_HIGH = 0.8;
export declare const COMPLETENESS_LOW = 0.4;
/** Aggregate thresholds for the three levels. */
export declare const HIGH_SCORE = 5;
export declare const MEDIUM_SCORE = 3;
/** Highest level any CSDN row may reach, no matter how it scores. */
export declare const CSDN_CONFIDENCE_CEILING: Confidence;
/** Order two confidence levels. */
export declare function rankConfidence(level: Confidence): number;
/** Lower a level so it never exceeds `ceiling`. */
export declare function capConfidence(level: Confidence, ceiling: Confidence): Confidence;
/** Clamp a completeness ratio into `[0, 1]`; non-finite input becomes 0. */
export declare function clampCompleteness(value: number): number;
/** Rounded completeness ratio of `present` out of `expected` fields. */
export declare function completenessOf(present: number, expected: number): number;
/** Completeness of a parsed object against the field names that were expected. */
export declare function completenessFrom(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): number;
/**
 * Weigh the four factors and emit the level plus one sentence.
 *
 * The reason always names the source tier, the login state, the completeness
 * band, the final points and the resulting level, so a reader can re-derive it.
 */
export declare function score(input: ScoreInput): Score;
/** Append clauses to an existing reason without introducing duplicates. */
export declare function withReason(reason: string, ...clauses: readonly (string | undefined)[]): string;
