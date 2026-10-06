/**
 * dsh-codehub — 思路摘要（备注③）.
 *
 * What this module produces is a THINKING SUMMARY: 实现思路 / API 用法 / 取舍 / 坑.
 * It is not a code rewriter, and it must never emit a block of source. The
 * extraction pipeline enforces that structurally, in this order:
 *
 *   1. `stripCodeBlocks()` removes fenced blocks, `<pre>` blocks and
 *      indented code runs before anything is read as prose;
 *   2. `looksLikeCode()` drops any surviving line that is code-shaped;
 *   3. `cleanProse()` caps every bullet and drops markup-only fragments;
 *   4. `SUMMARY_LIMITS` caps bullets per section and the whole summary.
 *
 * 备注③ result field: `summarize()` returns the `learned_summary` string.
 */
/** Category keys, in render order. */
export interface SummarySections {
    readonly approach: readonly string[];
    readonly apiContract: readonly string[];
    readonly tradeoffs: readonly string[];
    readonly pitfalls: readonly string[];
}
/** Text a result row can offer to the summarizer. All fields optional. */
export interface SummaryInput {
    readonly title?: string;
    readonly description?: string;
    readonly readme?: string;
    readonly body?: string;
    /** Extra prose (e.g. a repo's `package.json` description, a README section). */
    readonly extras?: readonly string[];
    /** Detected language, used only for the fallback sentence. */
    readonly language?: string;
}
/** Bounds that keep a summary a summary. Exported so tests can assert them. */
export declare const SUMMARY_LIMITS: {
    readonly maxBulletsPerSection: 3;
    readonly maxBulletChars: 220;
    readonly maxTotalChars: 1200;
    readonly minBulletChars: 6;
};
/** Decode the HTML entities that appear in search payloads. */
export declare function decodeEntities(text: string): string;
/** Strip markup, keeping text content. Inline `<code>` survives (API names matter). */
export declare function stripHtml(text: string): string;
/** Remove fenced blocks, `<pre>` blocks and indented code runs. */
export declare function stripCodeBlocks(text: string): string;
/** True when a line is code-shaped rather than prose. */
export declare function looksLikeCode(line: string): boolean;
/** Strip markdown decorations from one prose fragment. */
export declare function stripMarkdown(line: string): string;
/** Split prose into sentence-ish fragments (CJK punctuation, then latin periods). */
export declare function splitSentences(text: string): string[];
/** Clean one candidate fragment, or null when it is not usable prose. */
export declare function cleanProse(fragment: string): string | null;
/**
 * Extract the four takeaway buckets from raw text. Code is removed before
 * reading, so no bullet can be a line of source.
 */
export declare function extractSections(text: string): SummarySections;
/** Render the four buckets as the `learned_summary` string. */
export declare function renderSummary(sections: SummarySections): string;
/** Summarize one text blob. */
export declare function summarizeText(text: string): string;
/** Summarize a mixed payload: title / description / README / body / extras. */
export declare function summarize(input: SummaryInput): string;
/** Convenience: summarize several blobs in order. */
export declare function summarizeTexts(...texts: readonly string[]): string;
