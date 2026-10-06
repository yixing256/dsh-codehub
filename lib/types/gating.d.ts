/**
 * dsh-codehub — 决策点门禁 (docs/DESIGN.md §2).
 *
 * THE INVARIANT: the plugin never decides on the user's behalf.
 *
 * Four decisions are owned by the user. Until each one has an answer, the tool
 * refuses to run — and the refusal happens BEFORE any network access, so an
 * unanswered question can never be "helpfully" pre-answered by fetching data
 * first and asking afterwards. `service.search()` calls `evaluateDecisions()`
 * as its first statement and returns early; `src/tool.ts` never reaches the
 * transport on that path. That ordering is the whole point of this module.
 *
 * `undefined` IS NOT `false`
 * --------------------------
 * `failoverEnabled` and `mergeSources` are tri-state:
 *
 *   | value       | meaning                                    |
 *   |-------------|--------------------------------------------|
 *   | `undefined` | never asked -> REFUSE and ask the user      |
 *   | `false`     | decided: "do not degrade" / "do not merge"  |
 *   | `true`      | decided: "do it"                            |
 *
 * `false` is a perfectly good answer and MUST pass the gate. Any truthiness
 * check (`if (!cfg.mergeSources) refuse`) would be a bug, which is why the
 * readers below are explicit `typeof value === 'boolean'` narrowings and the
 * decision state carries `boolean | undefined` rather than `boolean`.
 *
 * `sourcePriority` / `githubAccessPriority` use the other spelling of
 * "undecided": the EMPTY LIST. An empty list must never be read as "all
 * sources" or "just use the default order" — it means the user has not ranked
 * them yet, and the plugin must ask.
 */
import type { DecisionKey, GithubAccessId, SourceId, UnresolvedDecision } from './contract.js';
/**
 * Everything the gate reads.
 *
 * Typed structurally (not as `ResolvedConfig`) on purpose: a raw settings
 * patch, a resolved config and a hand-written test fixture must all be
 * acceptable, and every field is optional so a partially-populated config
 * simply reports more unresolved decisions.
 *
 * `githubAccessPriority` / `failoverEnabled` are tolerated top-level aliases for
 * `github.accessPriority` / `failover.enabled`. The canonical schema paths are
 * the nested ones (docs/DESIGN.md §4); the aliases keep a config that was
 * flattened by some other layer from being misread as "undecided", which would
 * be a false refusal.
 */
export interface DecisionInput {
    readonly sourcePriority?: readonly string[] | null;
    readonly github?: {
        readonly accessPriority?: readonly string[] | null;
    } | null;
    readonly failover?: {
        readonly enabled?: boolean | null;
    } | null;
    readonly mergeSources?: boolean | null;
    /** Alias of `github.accessPriority`. */
    readonly githubAccessPriority?: readonly string[] | null;
    /** Alias of `failover.enabled`. */
    readonly failoverEnabled?: boolean | null;
}
/** The four decisions, normalised. `undefined` = undecided, always. */
export interface DecisionState {
    readonly sourcePriority: readonly SourceId[] | undefined;
    readonly githubAccessPriority: readonly GithubAccessId[] | undefined;
    readonly failoverEnabled: boolean | undefined;
    readonly mergeSources: boolean | undefined;
}
/**
 * Normalise any acceptable input into the four tri-state values.
 *
 * Accepts `undefined` / `null` (an empty config) and reports everything as
 * undecided rather than throwing — a missing config is the most common way to
 * reach a freshly-installed plugin.
 */
export declare function decisionState(input?: DecisionInput | null): DecisionState;
/** One frozen guide entry, copied so callers cannot mutate `DECISION_GUIDE`. */
export declare function decisionGuideFor(key: DecisionKey): UnresolvedDecision;
/** True when this decision has an answer — including the answer `false`. */
export declare function isDecided(state: DecisionState, key: DecisionKey): boolean;
/**
 * Every unresolved decision, in `DECISION_KEYS` order (stable, so the rendered
 * question list does not reshuffle between calls).
 */
export declare function unresolvedDecisions(input?: DecisionInput | null | DecisionState): UnresolvedDecision[];
/** Keys only — handy for `reason` strings and tests. */
export declare function unresolvedKeys(input?: DecisionInput | null | DecisionState): DecisionKey[];
/**
 * The refusal payload's shape. It carries exactly the three fields the tool's
 * output schema declares — no extras — so a caller can return it verbatim:
 *
 * ```ts
 * { ok: false, unresolved_decisions: [...], ask_user: "…" }
 * ```
 */
export interface DecisionGateClosed {
    readonly ok: false;
    readonly unresolved_decisions: readonly UnresolvedDecision[];
    readonly ask_user: string;
}
export interface DecisionGateOpen {
    readonly ok: true;
}
export type DecisionGate = DecisionGateOpen | DecisionGateClosed;
/**
 * Decide whether the tool may run.
 *
 * A closed gate means: zero network requests, a `ok:false` value the model can
 * branch on, and one question per unresolved decision that the model is
 * expected to relay to the user verbatim.
 */
export declare function evaluateDecisions(input?: DecisionInput | null | DecisionState): DecisionGate;
/**
 * The message returned when the plugin itself is switched off.
 *
 * Deliberately separate from the decision gate: "disabled" is not an unanswered
 * decision, and mixing the two would send the user to the wrong control.
 */
export declare function disabledRefusal(): {
    readonly ok: false;
    readonly reason: string;
    readonly ask_user: string;
};
