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

import { DEFAULT_LIMITS, GITHUB_ACCESS, HARD_LIMITS, RETRYABLE_FAILURES } from '../contract.js'
import type { FailureKind, GithubAccessId, SourceId, TransportId } from '../contract.js'
import { clampMaxDepth, isRetryableFailure, joinReason } from './types.js'

/** One rung of the user-configured `failover.chain`. */
export interface FailoverEntry {
  /** Stable id used in reasons and tests, e.g. `direct`, `ghproxy`. */
  readonly id: string
  /** Human label for the rendered reason; defaults to `id`. */
  readonly label?: string
  /** GitHub access strategy this rung corresponds to, when applicable. */
  readonly access?: GithubAccessId
  /** Transport override for this rung. */
  readonly transport?: TransportId
  /** Base override (proxy / mirror / raw mirror) for this rung. */
  readonly base?: string
  /** Source this rung re-enters; absent means "same source, another strategy". */
  readonly source?: SourceId
}

/** What one rung produced. `value === null` with no `failure` counts as `empty`. */
export interface RungResult<T> {
  readonly value: T | null
  readonly failure?: FailureKind
  readonly reason: string
}

/** Context handed to the attempt callback. */
export interface RungContext {
  readonly index: number
  /** 0 for the primary rung; increments once per fallback. */
  readonly depth: number
}

export type FailoverAttemptFn<T> = (entry: FailoverEntry, context: RungContext) => Promise<RungResult<T>>

export interface FailoverOptions {
  /** Budget of *extra* rungs. Clamped into `[0, HARD_LIMITS.maxDepth]`. */
  readonly maxDepth?: number
  /** Override retryability (defaults to `RETRYABLE_FAILURES`). */
  readonly isRetryable?: (failure: FailureKind | undefined) => boolean
  /** Extra clause appended to the final reason, e.g. a transport note (备注①). */
  readonly note?: string
}

/** One rung as it actually ran. */
export interface FailoverAttempt<T> {
  readonly entry: FailoverEntry
  readonly depth: number
  readonly ok: boolean
  readonly failure?: FailureKind
  readonly reason: string
  readonly value: T | null
}

export interface FailoverResult<T> {
  readonly ok: boolean
  readonly value: T | null
  /** The failure that ended the chain, when it ended unsuccessfully. */
  readonly failure?: FailureKind
  readonly reason: string
  readonly attempts: readonly FailoverAttempt<T>[]
  /** Rungs actually attempted. */
  readonly steps: number
  /** `steps - 1`, i.e. the fallback depth consumed. */
  readonly depth: number
  /** Chain ended unsuccessfully while rungs remained (retryable failure). */
  readonly exhausted: boolean
}

function isGithubAccess(value: string): value is GithubAccessId {
  return (GITHUB_ACCESS as readonly string[]).includes(value)
}

/** Accept plain strategy ids or full entries, so config can stay simple. */
export function toFailoverEntries(chain: readonly (string | FailoverEntry)[]): readonly FailoverEntry[] {
  const out: FailoverEntry[] = []
  for (const item of chain) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id.length === 0) continue
      out.push(isGithubAccess(id) ? { id, label: id, access: id } : { id, label: id })
      continue
    }
    if (typeof item.id === 'string' && item.id.trim().length > 0) out.push(item)
  }
  return out
}

/**
 * The rungs that may actually run, given the depth budget.
 * `maxDepth: 0` → primary only; `maxDepth: 1` → primary + one fallback.
 */
export function planRungs(chain: readonly FailoverEntry[], maxDepth: number | undefined): readonly FailoverEntry[] {
  const budget = clampMaxDepth(maxDepth ?? DEFAULT_LIMITS.maxDepth)
  const allowed = Math.min(chain.length, budget + 1, HARD_LIMITS.maxDepth + 1)
  return chain.slice(0, Math.max(0, allowed))
}

function labelOf(entry: FailoverEntry): string {
  return entry.label !== undefined && entry.label.length > 0 ? entry.label : entry.id
}

function chainText(attempts: readonly FailoverAttempt<unknown>[]): string {
  return attempts
    .map((attempt) => `[${attempt.depth}] ${labelOf(attempt.entry)} ${attempt.ok ? '成功' : `失败（${attempt.failure ?? 'empty'}）`}`)
    .join(' → ')
}

/** Should the chain advance past this failure? */
export function shouldAdvance(failure: FailureKind | undefined, options: FailoverOptions = {}): boolean {
  const predicate = options.isRetryable ?? isRetryableFailure
  return predicate(failure)
}

/**
 * Walk the chain until a rung succeeds, a non-retryable failure lands, or the
 * depth budget runs out. Never recurses; never runs more than
 * `planRungs().length` rungs.
 */
export async function withFailover<T>(
  chain: readonly FailoverEntry[],
  options: FailoverOptions,
  attempt: FailoverAttemptFn<T>,
): Promise<FailoverResult<T>> {
  const rungs = planRungs(chain, options.maxDepth)
  const attempts: FailoverAttempt<T>[] = []

  if (rungs.length === 0) {
    return {
      ok: false,
      value: null,
      failure: 'empty',
      reason: joinReason('降级链为空，未尝试任何方式', options.note),
      attempts,
      steps: 0,
      depth: 0,
      exhausted: false,
    }
  }

  for (let index = 0; index < rungs.length; index += 1) {
    const entry: FailoverEntry | undefined = rungs[index]
    if (entry === undefined) break
    const result = await attempt(entry, { index, depth: index })
    const ok = result.value !== null
    const failure: FailureKind | undefined = ok ? undefined : result.failure ?? 'empty'

    const record: FailoverAttempt<T> =
      failure === undefined
        ? { entry, depth: index, ok, reason: result.reason, value: result.value }
        : { entry, depth: index, ok, failure, reason: result.reason, value: result.value }
    attempts.push(record)

    if (ok) {
      return {
        ok: true,
        value: result.value,
        reason: joinReason(chainText(attempts), result.reason, options.note),
        attempts,
        steps: attempts.length,
        depth: index,
        exhausted: false,
      }
    }

    if (!shouldAdvance(failure, options)) {
      return {
        ok: false,
        value: null,
        failure,
        reason: joinReason(chainText(attempts), result.reason, `失败类型 ${failure} 不在可重试集合内，停止降级`, options.note),
        attempts,
        steps: attempts.length,
        depth: index,
        exhausted: false,
      }
    }
  }

  const last = attempts[attempts.length - 1]
  return {
    ok: false,
    value: null,
    failure: last?.failure ?? 'empty',
    reason: joinReason(
      chainText(attempts),
      last?.reason,
      `降级链已走完 ${attempts.length} 级（maxDepth=${clampMaxDepth(options.maxDepth ?? DEFAULT_LIMITS.maxDepth)}）`,
      options.note,
    ),
    attempts,
    steps: attempts.length,
    depth: Math.max(0, attempts.length - 1),
    exhausted: true,
  }
}

/** Convenience: the chain advanced past at least one rung before succeeding. */
export function usedFallback<T>(result: FailoverResult<T>): boolean {
  return result.ok && result.depth > 0
}

/** Convenience: the failure kinds the default predicate advances past. */
export function retryableKinds(): readonly FailureKind[] {
  return [...RETRYABLE_FAILURES]
}
