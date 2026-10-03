/**
 * 降级链与错误分类（task-5 §D）。
 *
 * `src/sources/degrade.ts` owns failover and is a pure, callback-injected
 * function, so the whole chain contract is asserted with a fake attempt function
 * and ZERO network:
 *
 *   • only `RETRYABLE_FAILURES` advance the chain; `empty` / `parse-failed` /
 *     `not-code` are FINAL (retrying an unchanged request cannot fix them);
 *   • the first success stops the walk — later rungs are never contacted;
 *   • `limits.maxDepth` bounds the walk (`[0, HARD_LIMITS.maxDepth]`), and a
 *     hostile 50-rung chain that always fails still terminates in ≤ 4 steps:
 *     the loop is `for`, there is no self-call anywhere;
 *   • an exhausted chain reports `ok:false` + `exhausted:true` + a reason naming
 *     the walk, instead of failing silently. The user-facing "do you want me to
 *     degrade?" question is produced by the service and asserted in
 *     `service-outlet.test.ts`.
 *
 * The second half of the file pins `net.ts`' classification tables, which is
 * where a wrong failure kind would mis-drive the chain.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_LIMITS, HARD_LIMITS, RETRYABLE_FAILURES } from '../src/contract.js'
import type { FailureKind } from '../src/contract.js'
import {
  TRANSPORT_RETRY_KINDS,
  TransportError,
  classifyStatus,
  classifyStatusHint,
  classifyThrown,
  isTransportRetryable,
  shouldRetryStatus,
} from '../src/net.js'
import {
  planRungs,
  retryableKinds,
  shouldAdvance,
  toFailoverEntries,
  usedFallback,
  withFailover,
} from '../src/sources/degrade.js'
import type { FailoverEntry, RungResult } from '../src/sources/degrade.js'
import { clampMaxDepth, isRetryableFailure } from '../src/sources/types.js'

// ---------------------------------------------------------------------------
// Fake rungs — no network, no clock.
// ---------------------------------------------------------------------------

function entry(id: string, extra: Partial<FailoverEntry> = {}): FailoverEntry {
  return { id, ...extra }
}

function failed(failure: FailureKind | undefined, reason = '这一级失败了'): RungResult<string> {
  return failure === undefined ? { value: null, reason } : { value: null, failure, reason }
}

function succeeded(value: string): RungResult<string> {
  return { value, reason: `这一级成功：${value}` }
}

const chainOf = (size: number): FailoverEntry[] =>
  Array.from({ length: size }, (_, index) => entry(`rung-${index}`))

describe('降级链 — 只有可重试的失败才前进', () => {
  it('RETRYABLE_FAILURES 的每一项都会切到下一级并成功收尾', async () => {
    for (const kind of RETRYABLE_FAILURES) {
      const visited: string[] = []
      const result = await withFailover([entry('a'), entry('b')], { maxDepth: 1 }, async (rung) => {
        visited.push(rung.id)
        return rung.id === 'a' ? failed(kind) : succeeded('b')
      })

      expect(result.ok, kind).toBe(true)
      expect(result.value, kind).toBe('b')
      expect(visited, kind).toEqual(['a', 'b'])
      expect(result.steps, kind).toBe(2)
      expect(result.depth, kind).toBe(1)
      expect(usedFallback(result), kind).toBe(true)
    }
  })

  it('empty / parse-failed / not-code 是终局：立刻停下，后面的级一次都不碰', async () => {
    const finals: FailureKind[] = ['empty', 'parse-failed', 'not-code']
    for (const kind of finals) {
      const visited: string[] = []
      const result = await withFailover(chainOf(3), { maxDepth: 2 }, async (rung) => {
        visited.push(rung.id)
        return failed(kind)
      })

      expect(result.ok, kind).toBe(false)
      expect(result.failure, kind).toBe(kind)
      expect(visited, kind).toEqual(['rung-0'])
      expect(result.exhausted, kind).toBe(false)
      expect(result.reason, kind).toContain('不在可重试集合内')
    }
  })

  it('value=null 且没有 failure 时按 empty 处理（终局，不误判为可重试）', async () => {
    const visited: string[] = []
    const result = await withFailover(chainOf(2), { maxDepth: 1 }, async (rung) => {
      visited.push(rung.id)
      return failed(undefined)
    })

    expect(result.failure).toBe('empty')
    expect(visited).toEqual(['rung-0'])
  })

  it('RETRYABLE_FAILURES 就是契约里那四项，且与 retryableKinds() 一致', () => {
    expect([...RETRYABLE_FAILURES]).toEqual(['network', 'timeout', 'rate-limited', 'auth-required'])
    expect(retryableKinds()).toEqual([...RETRYABLE_FAILURES])

    for (const kind of RETRYABLE_FAILURES) expect(shouldAdvance(kind)).toBe(true)
    expect(shouldAdvance('empty')).toBe(false)
    expect(shouldAdvance('parse-failed')).toBe(false)
    expect(shouldAdvance('not-code')).toBe(false)
    expect(shouldAdvance(undefined)).toBe(false)
    expect(isRetryableFailure('auth-required')).toBe(true)
  })

  it('第一级成功就停：后面两级一次都不碰', async () => {
    const visited: string[] = []
    const result = await withFailover(chainOf(3), { maxDepth: 2 }, async (rung) => {
      visited.push(rung.id)
      return succeeded(rung.id)
    })

    expect(visited).toEqual(['rung-0'])
    expect(result.ok).toBe(true)
    expect(result.steps).toBe(1)
    expect(result.depth).toBe(0)
    expect(usedFallback(result)).toBe(false)
  })

  it('isRetryable 可被覆盖（empty 也能被当作可前进）', async () => {
    const visited: string[] = []
    const result = await withFailover(chainOf(2), { maxDepth: 1, isRetryable: () => true }, async (rung) => {
      visited.push(rung.id)
      return failed('empty')
    })

    expect(visited).toEqual(['rung-0', 'rung-1'])
    expect(result.exhausted).toBe(true)
  })
})

describe('降级链 — 深度受 maxDepth 约束，不无限递归', () => {
  it('planRungs 的长度 = min(链长, maxDepth + 1, 硬顶 + 1)', () => {
    const chain = chainOf(10)
    expect(planRungs(chain, 0)).toHaveLength(1)
    expect(planRungs(chain, 1)).toHaveLength(2)
    expect(planRungs(chain, 2)).toHaveLength(3)
    expect(planRungs(chain, HARD_LIMITS.maxDepth)).toHaveLength(HARD_LIMITS.maxDepth + 1)
    expect(planRungs(chain, 99)).toHaveLength(HARD_LIMITS.maxDepth + 1)
    expect(planRungs(chain, undefined)).toHaveLength(DEFAULT_LIMITS.maxDepth + 1)
    expect(planRungs(chain, -5)).toHaveLength(DEFAULT_LIMITS.maxDepth + 1)
    expect(planRungs([], 3)).toHaveLength(0)
  })

  it('maxDepth 的 clamp 边界与 HARD_LIMITS 一致', () => {
    expect(clampMaxDepth(99)).toBe(HARD_LIMITS.maxDepth)
    expect(clampMaxDepth(HARD_LIMITS.maxDepth)).toBe(HARD_LIMITS.maxDepth)
    expect(clampMaxDepth(0)).toBe(0)
    expect(clampMaxDepth(undefined)).toBe(DEFAULT_LIMITS.maxDepth)
    expect(clampMaxDepth(-1)).toBe(DEFAULT_LIMITS.maxDepth)
    expect(clampMaxDepth(Number.NaN)).toBe(DEFAULT_LIMITS.maxDepth)
  })

  it('50 级链 + maxDepth=999（远超硬顶）+ 每级都失败 → 只走 4 步就终止', async () => {
    let attempts = 0
    const result = await withFailover(chainOf(50), { maxDepth: 999 }, async () => {
      attempts += 1
      return failed('network')
    })

    expect(attempts).toBe(HARD_LIMITS.maxDepth + 1)
    expect(result.steps).toBe(HARD_LIMITS.maxDepth + 1)
    expect(result.attempts).toHaveLength(HARD_LIMITS.maxDepth + 1)
    expect(result.depth).toBe(HARD_LIMITS.maxDepth)
    expect(result.exhausted).toBe(true)
  })

  it('maxDepth=0 只允许主级一次尝试', async () => {
    const visited: string[] = []
    const result = await withFailover(chainOf(5), { maxDepth: 0 }, async (rung) => {
      visited.push(rung.id)
      return failed('network')
    })

    expect(visited).toEqual(['rung-0'])
    expect(result.steps).toBe(1)
    expect(result.exhausted).toBe(true)
  })
})

describe('降级链 — 链尽时明确失败，不静默', () => {
  it('链走完仍失败 → ok:false + exhausted:true + reason 记录整条链', async () => {
    const result = await withFailover(chainOf(2), { maxDepth: 1 }, async (rung) =>
      failed('network', `第 ${rung.id} 级网络失败`),
    )

    expect(result.ok).toBe(false)
    expect(result.value).toBeNull()
    expect(result.exhausted).toBe(true)
    expect(result.failure).toBe('network')
    expect(result.reason).toContain('降级链已走完 2 级')
    expect(result.reason).toContain('maxDepth=1')
    // 每一级的结果都留在 attempts 里，调用方可以据此生成给用户的提问。
    expect(result.attempts.map((item) => item.entry.id)).toEqual(['rung-0', 'rung-1'])
    expect(result.attempts.every((item) => item.ok === false)).toBe(true)
  })

  it('空链给出明确失败，而不是「无事发生」', async () => {
    const result = await withFailover([], {}, async () => succeeded('never'))

    expect(result.ok).toBe(false)
    expect(result.failure).toBe('empty')
    expect(result.steps).toBe(0)
    expect(result.attempts).toEqual([])
    expect(result.reason).toContain('降级链为空')
  })

  it('note 原样并入最终 reason（备注① 的通道说明不会被吞掉）', async () => {
    const note = '仅 Node 直连传输生效'
    const result = await withFailover(chainOf(1), { maxDepth: 0, note }, async () => failed('network'))
    expect(result.reason).toContain(note)
  })

  it('成功路径的 reason 也保留已经走过的级', async () => {
    const result = await withFailover(chainOf(2), { maxDepth: 1 }, async (rung) =>
      rung.id === 'rung-0' ? failed('timeout') : succeeded('ok'),
    )
    expect(result.reason).toContain('rung-0')
    expect(result.reason).toContain('rung-1')
  })

  it('toFailoverEntries：字符串策略展开为条目，未知字符串不冒充访问方式', () => {
    const entries = toFailoverEntries(['direct', 'ghproxy', '   ', { id: 'custom', label: '自定义' }])

    expect(entries.map((item) => item.id)).toEqual(['direct', 'ghproxy', 'custom'])
    expect(entries[0]?.access).toBe('direct')
    expect(entries[1]?.access).toBe('ghproxy')
    expect(entries[2]?.access).toBeUndefined()
    expect(entries[2]?.label).toBe('自定义')
  })
})

describe('错误分类 — 驱动降级的那个值不能猜错', () => {
  it('HTTP 状态码到 FailureKind 的映射（见 net.ts 头部的优先级表）', () => {
    expect(classifyStatus(200, false)).toBeUndefined()
    expect(classifyStatus(204, true)).toBeUndefined()
    expect(classifyStatus(401, false)).toBe('auth-required')
    expect(classifyStatus(403, false)).toBe('rate-limited')
    expect(classifyStatus(403, true)).toBe('rate-limited')
    expect(classifyStatus(429, false)).toBe('rate-limited')
    expect(classifyStatus(408, false)).toBe('timeout')
    expect(classifyStatus(404, false)).toBe('not-code')
    expect(classifyStatus(410, false)).toBe('not-code')
    expect(classifyStatus(400, false)).toBe('parse-failed')
    expect(classifyStatus(500, false)).toBe('network')
    expect(classifyStatus(503, true)).toBe('network')

    // 403 兼具「限流」与「缺凭据」两种含义，一个 FailureKind 装不下，
    // 所以凭据提示走单独的函数。
    expect(classifyStatusHint(403, false)).toBeDefined()
    expect(classifyStatusHint(403, true)).toBeUndefined()
    expect(classifyStatusHint(429, false)).toBeUndefined()
  })

  it('抛出的异常按 name / message 归类', () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    expect(classifyThrown(abortError)).toBe('timeout')

    const timeoutError = new Error('connect ETIMEDOUT 1.2.3.4:443')
    expect(classifyThrown(timeoutError)).toBe('timeout')

    expect(classifyThrown(new Error('429 Too Many Requests'))).toBe('rate-limited')
    expect(classifyThrown(new Error('401 Unauthorized'))).toBe('auth-required')
    expect(classifyThrown(new Error('socket hang up'))).toBe('network')
    expect(classifyThrown(new TransportError('parse-failed', 'Unexpected token < in JSON'))).toBe('parse-failed')
    expect(classifyThrown(new TransportError('not-code', '不是代码'))).toBe('not-code')
  })

  it('只有可重试的传输错误会被自动重发；auth-required 不在其中', () => {
    expect([...TRANSPORT_RETRY_KINDS]).toEqual(['network', 'timeout', 'rate-limited'])
    expect(isTransportRetryable('auth-required')).toBe(false)
    expect(isTransportRetryable('network')).toBe(true)

    expect(shouldRetryStatus(429)).toBe(true)
    expect(shouldRetryStatus(502)).toBe(true)
    expect(shouldRetryStatus(503)).toBe(true)
    expect(shouldRetryStatus(504)).toBe(true)
    expect(shouldRetryStatus(500)).toBe(false)
    expect(shouldRetryStatus(200)).toBe(false)
  })
})
