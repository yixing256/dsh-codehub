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

import { DECISION_GUIDE, DECISION_KEYS, GITHUB_ACCESS, SOURCES, decisionPrompt } from './contract.js'
import type { DecisionKey, GithubAccessId, SourceId, UnresolvedDecision } from './contract.js'

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

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
  readonly sourcePriority?: readonly string[] | null
  readonly github?: { readonly accessPriority?: readonly string[] | null } | null
  readonly failover?: { readonly enabled?: boolean | null } | null
  readonly mergeSources?: boolean | null
  /** Alias of `github.accessPriority`. */
  readonly githubAccessPriority?: readonly string[] | null
  /** Alias of `failover.enabled`. */
  readonly failoverEnabled?: boolean | null
}

/** The four decisions, normalised. `undefined` = undecided, always. */
export interface DecisionState {
  readonly sourcePriority: readonly SourceId[] | undefined
  readonly githubAccessPriority: readonly GithubAccessId[] | undefined
  readonly failoverEnabled: boolean | undefined
  readonly mergeSources: boolean | undefined
}

// ---------------------------------------------------------------------------
// Readers.
// ---------------------------------------------------------------------------

function listOf(value: unknown, allowed: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (!allowed.includes(trimmed)) continue
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  // 空数组 = 尚未决定，绝不回落到「全部源」或「默认顺序」。
  return out.length > 0 ? out : undefined
}

/** `undefined` unless the value is literally a boolean — `false` survives. */
function boolOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Normalise any acceptable input into the four tri-state values.
 *
 * Accepts `undefined` / `null` (an empty config) and reports everything as
 * undecided rather than throwing — a missing config is the most common way to
 * reach a freshly-installed plugin.
 */
export function decisionState(input?: DecisionInput | null): DecisionState {
  const source: DecisionInput = typeof input === 'object' && input !== null ? input : {}
  const github = typeof source.github === 'object' && source.github !== null ? source.github : {}
  const failover = typeof source.failover === 'object' && source.failover !== null ? source.failover : {}

  return {
    sourcePriority: listOf(source.sourcePriority, SOURCES) as readonly SourceId[] | undefined,
    githubAccessPriority: firstDefined(
      listOf(github.accessPriority, GITHUB_ACCESS),
      listOf(source.githubAccessPriority, GITHUB_ACCESS),
    ) as readonly GithubAccessId[] | undefined,
    failoverEnabled: firstDefined(boolOf(failover.enabled), boolOf(source.failoverEnabled)),
    mergeSources: boolOf(source.mergeSources),
  }
}

/** One frozen guide entry, copied so callers cannot mutate `DECISION_GUIDE`. */
export function decisionGuideFor(key: DecisionKey): UnresolvedDecision {
  const guide = DECISION_GUIDE[key]
  return { key: guide.key, detail: guide.detail, ask: guide.ask, control: guide.control }
}

/** True when this decision has an answer — including the answer `false`. */
export function isDecided(state: DecisionState, key: DecisionKey): boolean {
  switch (key) {
    case 'sourcePriority':
      return state.sourcePriority !== undefined
    case 'githubAccessPriority':
      return state.githubAccessPriority !== undefined
    case 'failoverEnabled':
      return state.failoverEnabled !== undefined
    case 'mergeSources':
      return state.mergeSources !== undefined
    default:
      return true
  }
}

/**
 * Every unresolved decision, in `DECISION_KEYS` order (stable, so the rendered
 * question list does not reshuffle between calls).
 */
export function unresolvedDecisions(input?: DecisionInput | null | DecisionState): UnresolvedDecision[] {
  const state = isDecisionState(input) ? input : decisionState(input)
  const out: UnresolvedDecision[] = []
  for (const key of DECISION_KEYS) {
    if (!isDecided(state, key)) out.push(decisionGuideFor(key))
  }
  return out
}

/** Keys only — handy for `reason` strings and tests. */
export function unresolvedKeys(input?: DecisionInput | null | DecisionState): DecisionKey[] {
  return unresolvedDecisions(input).map(item => item.key)
}

function isDecisionState(value: unknown): value is DecisionState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    'sourcePriority' in candidate &&
    'githubAccessPriority' in candidate &&
    'failoverEnabled' in candidate &&
    'mergeSources' in candidate &&
    !('github' in candidate) &&
    !('failover' in candidate)
  )
}

// ---------------------------------------------------------------------------
// The gate itself.
// ---------------------------------------------------------------------------

/**
 * The refusal payload's shape. It carries exactly the three fields the tool's
 * output schema declares — no extras — so a caller can return it verbatim:
 *
 * ```ts
 * { ok: false, unresolved_decisions: [...], ask_user: "…" }
 * ```
 */
export interface DecisionGateClosed {
  readonly ok: false
  readonly unresolved_decisions: readonly UnresolvedDecision[]
  readonly ask_user: string
}

export interface DecisionGateOpen {
  readonly ok: true
}

export type DecisionGate = DecisionGateOpen | DecisionGateClosed

/**
 * Decide whether the tool may run.
 *
 * A closed gate means: zero network requests, a `ok:false` value the model can
 * branch on, and one question per unresolved decision that the model is
 * expected to relay to the user verbatim.
 */
export function evaluateDecisions(input?: DecisionInput | null | DecisionState): DecisionGate {
  const unresolved = unresolvedDecisions(input)
  if (unresolved.length === 0) return { ok: true }
  return {
    ok: false,
    unresolved_decisions: unresolved,
    // `decisionPrompt()` joins each `ask` on its own line: one relayable
    // question per unresolved decision.
    ask_user: decisionPrompt(unresolved),
  }
}

/**
 * The message returned when the plugin itself is switched off.
 *
 * Deliberately separate from the decision gate: "disabled" is not an unanswered
 * decision, and mixing the two would send the user to the wrong control.
 */
export function disabledRefusal(): { readonly ok: false; readonly reason: string; readonly ask_user: string } {
  return {
    ok: false,
    reason: 'dsh-codehub 当前处于关闭状态（config.enabled = false），未发起任何网络请求。',
    ask_user: 'dsh-codehub 现在是关闭的。要我在设置里打开它再查吗？',
  }
}
