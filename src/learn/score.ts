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

import { SOURCE_LABELS } from '../contract.js'
import type { Confidence, SourceId } from '../contract.js'
import { joinReason } from '../sources/types.js'
import type { Score, ScoreInput } from '../sources/types.js'

/** Source tier. GitHub 3 > Gitee 2 > CSDN 1 — CSDN is a supplement only. */
export const SOURCE_WEIGHT: Readonly<Record<SourceId, number>> = {
  github: 3,
  gitee: 2,
  csdn: 1,
}

/** Denominator used in the rendered reason. */
export const MAX_SOURCE_WEIGHT = 3

/** Points awarded when the call was authenticated. */
export const AUTH_BONUS = 1

/** Points removed for a reposted (non-original) item. */
export const REPOST_PENALTY = 2

/** Completeness bands. */
export const COMPLETENESS_HIGH = 0.8
export const COMPLETENESS_LOW = 0.4

/** Aggregate thresholds for the three levels. */
export const HIGH_SCORE = 5
export const MEDIUM_SCORE = 3

/** Highest level any CSDN row may reach, no matter how it scores. */
export const CSDN_CONFIDENCE_CEILING: Confidence = 'medium'

const LEVEL_RANK: Readonly<Record<Confidence, number>> = { low: 1, medium: 2, high: 3 }

/** Order two confidence levels. */
export function rankConfidence(level: Confidence): number {
  return LEVEL_RANK[level]
}

/** Lower a level so it never exceeds `ceiling`. */
export function capConfidence(level: Confidence, ceiling: Confidence): Confidence {
  return LEVEL_RANK[level] > LEVEL_RANK[ceiling] ? ceiling : level
}

/** Clamp a completeness ratio into `[0, 1]`; non-finite input becomes 0. */
export function clampCompleteness(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Rounded completeness ratio of `present` out of `expected` fields. */
export function completenessOf(present: number, expected: number): number {
  if (!Number.isFinite(expected) || expected <= 0) return 0
  return clampCompleteness(present / expected)
}

/** Completeness of a parsed object against the field names that were expected. */
export function completenessFrom(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): number {
  if (keys.length === 0) return 0
  let present = 0
  for (const key of keys) {
    const value = fields[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim().length === 0) continue
    present += 1
  }
  return completenessOf(present, keys.length)
}

/**
 * Weigh the four factors and emit the level plus one sentence.
 *
 * The reason always names the source tier, the login state, the completeness
 * band, the final points and the resulting level, so a reader can re-derive it.
 */
export function score(input: ScoreInput): Score {
  const weight = SOURCE_WEIGHT[input.source]
  const completeness = clampCompleteness(input.completeness)
  const factors: string[] = [`源等级 ${weight}/${MAX_SOURCE_WEIGHT}`]
  let points = weight

  if (input.authenticated) {
    points += AUTH_BONUS
    factors.push('已登录')
  } else {
    factors.push('未登录（匿名）')
  }

  if (input.reposted) {
    points -= REPOST_PENALTY
    factors.push('非原创（转载）条目已降权')
  } else {
    factors.push('原创标注')
  }

  if (completeness >= COMPLETENESS_HIGH) {
    points += 1
    factors.push(`解析完整度高（${Math.round(completeness * 100)}%）`)
  } else if (completeness >= COMPLETENESS_LOW) {
    factors.push(`解析完整度中（${Math.round(completeness * 100)}%）`)
  } else {
    points -= 1
    factors.push(`解析完整度低（${Math.round(completeness * 100)}%）`)
  }

  let confidence: Confidence = points >= HIGH_SCORE ? 'high' : points >= MEDIUM_SCORE ? 'medium' : 'low'
  if (input.source === 'csdn') confidence = capConfidence(confidence, CSDN_CONFIDENCE_CEILING)

  const noteList: readonly string[] = input.notes === undefined ? [] : input.notes
  const notes = joinReason(...noteList.filter((note: string) => typeof note === 'string'))
  const tail = notes.length > 0 ? `；${notes}` : ''
  const reason = `${SOURCE_LABELS[input.source]}：${factors.join('、')}，综合 ${points} 分 → ${confidence}${tail}。`

  return { confidence, reason }
}

/** Append clauses to an existing reason without introducing duplicates. */
export function withReason(reason: string, ...clauses: readonly (string | undefined)[]): string {
  const parts: string[] = [reason]
  for (const clause of clauses) {
    if (typeof clause === 'string') parts.push(clause)
  }
  const joined = joinReason(...parts)
  return joined.endsWith('。') || joined.endsWith('.') ? joined : `${joined}。`
}
