/**
 * 去重与打分（task-5 §E，前半）。
 *
 * `src/learn/dedupe.ts` and `src/learn/score.ts` are pure — no clock, no network,
 * no globals — so they are asserted directly:
 *
 *   • URL normalisation folds query, fragment, case, `www.`, the default port and
 *     the trailing slash into ONE key, so the same page reached by two routes
 *     collapses; content fingerprinting catches the same snippet served from two
 *     different URLs (the mirror case);
 *   • `score()` weighs exactly the four briefed factors (source tier × login ×
 *     repost × completeness), CSDN carries the lowest weight and can never reach
 *     `high`, and a reposted item is down-weighted with 转载 named in the reason;
 *   • the shared helpers in `src/sources/types.ts` (clamps, failure
 *     classification, token policy, excerpt bound, reason joining) — the pieces
 *     every adapter builds on — are pinned to their documented boundaries.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_LIMITS, HARD_LIMITS, LOCAL_PROXY_SCOPE_NOTE } from '../src/contract.js'
import {
  contentFingerprint,
  dedupe,
  dedupeNotes,
  dedupeResults,
  fnv1a64,
  isSameContent,
  mergeResults,
  normalizeUrl,
  urlKey,
} from '../src/learn/dedupe.js'
import {
  CSDN_CONFIDENCE_CEILING,
  COMPLETENESS_HIGH,
  COMPLETENESS_LOW,
  MAX_SOURCE_WEIGHT,
  SOURCE_WEIGHT,
  capConfidence,
  clampCompleteness,
  completenessFrom,
  completenessOf,
  rankConfidence,
  score,
  withReason,
} from '../src/learn/score.js'
import {
  boundExcerpt,
  clampMaxCodeChars,
  clampMaxItems,
  clampTimeout,
  classifyTransportError,
  failureFromResponse,
  isFailureKind,
  isRetryableFailure,
  joinReason,
  notCodeOutcome,
  optionalReason,
  tokenForAccess,
  transportNotes,
} from '../src/sources/types.js'
import type { TransportResponse } from '../src/sources/types.js'
import { makeRow } from './helpers.js'

describe('去重 — URL 归一化', () => {
  it('query / 锚点 / 大小写 / www. / 默认端口 / 末尾斜杠都视为同一条', () => {
    const canonical = 'https://github.com/vuejs/core'
    expect(normalizeUrl('https://github.com/vuejs/core')).toBe(canonical)
    expect(normalizeUrl('https://GitHub.com/Vuejs/Core/')).toBe(canonical)
    expect(normalizeUrl('https://github.com/vuejs/core?tab=readme#install')).toBe(canonical)
    expect(normalizeUrl('https://www.github.com/vuejs/core/')).toBe(canonical)
    expect(normalizeUrl('https://github.com:443/vuejs/core//')).toBe(canonical)
    expect(normalizeUrl('  https://github.com/vuejs/core  ')).toBe(canonical)
  })

  it('非默认端口保留，内部重复斜杠折叠', () => {
    expect(normalizeUrl('http://example.com:80/a//b/')).toBe('http://example.com/a/b')
    expect(normalizeUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x')
  })

  it('空值与无法解析的输入不抛异常', () => {
    expect(normalizeUrl('')).toBe('')
    expect(normalizeUrl('not a url')).toBe('not a url')
    expect(urlKey('')).toBe('')
  })
})

describe('去重 — 合并同一条结果', () => {
  it('同一 URL 的两条（各自 title/summary 不同）只留第一条，并按 URL 计数', () => {
    const first = makeRow({ url: 'https://a.dev/x?utm_source=feed' })
    const second = makeRow({ url: 'https://a.dev/x#top', title: '另一份拷贝', learned_summary: '不同摘要', code: 'other()' })

    const outcome = dedupeResults([first, second])
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]).toBe(first)
    expect(outcome.stats).toEqual({ input: 2, kept: 1, droppedByUrl: 1, droppedByContent: 0 })
  })

  it('不同 URL 但内容指纹相同 → 按内容去重（镜像/转载场景）', () => {
    const native = makeRow({ url: 'https://github.com/a/b' })
    const mirrored = makeRow({ url: 'https://ghproxy.net/https://raw.githubusercontent.com/a/b' })

    expect(isSameContent(native, mirrored)).toBe(true)

    const outcome = dedupeResults([native, mirrored])
    expect(outcome.results).toHaveLength(1)
    expect(outcome.stats.droppedByContent).toBe(1)
    expect(outcome.stats.droppedByUrl).toBe(0)
  })

  it('byContent:false 只按 URL 去重', () => {
    const native = makeRow({ url: 'https://github.com/a/b' })
    const mirrored = makeRow({ url: 'https://gitcode.com/a/b' })

    expect(dedupeResults([native, mirrored], { byContent: false }).results).toHaveLength(2)
    expect(dedupeResults([native, mirrored]).results).toHaveLength(1)
  })

  it('prefer:"confidence" 时保留置信度更高的那条，但位置不变', () => {
    const low = makeRow({ url: 'https://a.dev/x', confidence: 'low', title: '低' })
    const high = makeRow({ url: 'https://a.dev/x', confidence: 'high', title: '高' })

    const outcome = dedupeResults([low, high], { prefer: 'confidence' })
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]?.title).toBe('高')
    expect(outcome.results[0]?.confidence).toBe('high')
  })

  it('dedupe() 与 dedupeResults().results 等价，且顺序稳定', () => {
    const rows = [
      makeRow({ url: 'https://a.dev/1', title: '第一条', learned_summary: '摘要一' }),
      makeRow({ url: 'https://a.dev/2', title: '第二条', learned_summary: '摘要二' }),
      makeRow({ url: 'https://a.dev/1?x=1', title: '第一条的另一个地址', learned_summary: '摘要一' }),
    ]
    expect(dedupe(rows).map((row) => row.url)).toEqual(['https://a.dev/1', 'https://a.dev/2'])
    expect(dedupe(rows)).toEqual(dedupeResults(rows).results)
  })

  it('mergeResults 先放主源，平局时主源胜出', () => {
    const primary = makeRow({ url: 'https://a.dev/x', title: '主源' })
    const secondary = makeRow({ url: 'https://a.dev/x', title: '次源' })

    const merged = mergeResults([primary], [secondary])
    expect(merged.results).toHaveLength(1)
    expect(merged.results[0]?.title).toBe('主源')
  })

  it('dedupeNotes 按 URL 折叠笔记', () => {
    const note = {
      url: 'https://github.com/a/b#readme',
      title: 'a/b',
      approach: '分层：解析 → 校验 → 执行。',
      apiContract: ['create(config): Instance'],
      tradeoffs: ['用闭包换掉类实例'],
      pitfalls: ['配置对象会被就地修改'],
      sourceUrls: ['https://github.com/a/b'],
    }
    const duplicate = { ...note, url: 'https://github.com/a/b', approach: '另一份' }

    expect(dedupeNotes([note, duplicate])).toHaveLength(1)
    expect(dedupeNotes([note, duplicate])[0]?.approach).toBe(note.approach)
    expect(dedupeNotes([note])).toEqual([note])
  })

  it('指纹是确定性的 16 位十六进制，且长度参与比对', () => {
    expect(fnv1a64('abc')).toBe(fnv1a64('abc'))
    expect(fnv1a64('abc')).toMatch(/^[0-9a-f]{16}$/)
    expect(fnv1a64('abc')).not.toBe(fnv1a64('abd'))

    const one = contentFingerprint({ title: '标题', code: 'a()', learned_summary: '摘要' })
    const two = contentFingerprint({ title: '标题', code: 'a()', learned_summary: '摘要' })
    expect(one).toBe(two)
    expect(contentFingerprint({ title: '别的', code: 'b()', learned_summary: '别摘要' })).not.toBe(one)
    // 标点与空白不参与指纹：同一个思路换个排版仍是同一条。
    expect(contentFingerprint({ title: '标题!', learned_summary: '摘要' })).toBe(
      contentFingerprint({ title: '标题', learned_summary: '摘要' }),
    )
    expect(contentFingerprint({})).toBe('')
  })

  it('空内容的两行不会被判定为同一内容（避免全部塌成一条）', () => {
    expect(isSameContent(makeRow({ title: '', learned_summary: '', code: '' }), makeRow({ title: '', learned_summary: '', code: '' }))).toBe(
      false,
    )
  })
})

describe('打分 — CSDN 权重最低', () => {
  it('源等级 github 3 > gitee 2 > csdn 1，分母为 3', () => {
    expect(SOURCE_WEIGHT.github).toBeGreaterThan(SOURCE_WEIGHT.gitee)
    expect(SOURCE_WEIGHT.gitee).toBeGreaterThan(SOURCE_WEIGHT.csdn)
    expect(SOURCE_WEIGHT.csdn).toBe(1)
    expect(MAX_SOURCE_WEIGHT).toBe(3)
  })

  it('CSDN 即使「已登录 + 原创 + 解析完整」也只能到 medium', () => {
    const best = score({ source: 'csdn', authenticated: true, reposted: false, completeness: 1 })
    expect(best.confidence).toBe('medium')
    expect(best.confidence).not.toBe('high')
    expect(CSDN_CONFIDENCE_CEILING).toBe('medium')
    expect(best.reason).toContain('源等级 1/3')
  })

  it('CSDN 匿名 + 转载 + 解析不全 → low', () => {
    const worst = score({ source: 'csdn', authenticated: false, reposted: true, completeness: 0.1 })
    expect(worst.confidence).toBe('low')
    expect(worst.reason).toContain('转载')
  })

  it('同等因素下 GitHub 明显高于 Gitee，Gitee 高于 CSDN', () => {
    const input = { authenticated: true, reposted: false, completeness: 1 } as const
    const github = score({ source: 'github', ...input })
    const gitee = score({ source: 'gitee', ...input })
    const csdn = score({ source: 'csdn', ...input })

    expect(github.confidence).toBe('high')
    expect(gitee.confidence).toBe('medium')
    expect(csdn.confidence).toBe('medium')
    expect(rankConfidence(github.confidence)).toBeGreaterThan(rankConfidence(gitee.confidence))
    expect(rankConfidence(gitee.confidence)).toBeGreaterThanOrEqual(rankConfidence(csdn.confidence))
  })
})

describe('打分 — 四个因子都体现在 reason 里', () => {
  it('登录加分：同一输入下已登录不低于匿名', () => {
    const anonymous = score({ source: 'github', authenticated: false, reposted: false, completeness: 1 })
    const loggedIn = score({ source: 'github', authenticated: true, reposted: false, completeness: 1 })

    expect(anonymous.confidence).toBe('medium')
    expect(loggedIn.confidence).toBe('high')
    expect(anonymous.reason).toContain('未登录')
    expect(loggedIn.reason).toContain('已登录')
  })

  it('转载降权并在 reason 里注明（备注②的 CSDN 转载要求）', () => {
    const original = score({ source: 'gitee', authenticated: true, reposted: false, completeness: 1 })
    const reposted = score({ source: 'gitee', authenticated: true, reposted: true, completeness: 1 })

    expect(reposted.confidence).toBe('low')
    expect(rankConfidence(reposted.confidence)).toBeLessThan(rankConfidence(original.confidence))
    expect(reposted.reason).toContain('非原创')
    expect(reposted.reason).toContain('降权')
  })

  it('解析完整度分三档，低完整度会扣分', () => {
    // 输入取自 score.ts 的分档常量，别把 0.9/0.5/0.1 这类魔法值硬编进来。
    // 分数账（github 基础 3 分）：
    //   高完整度 3 + AUTH_BONUS(1) + 1 = 5 >= HIGH_SCORE(5) → high
    //   中完整度 3 + 0 + 0 = 3 >= MEDIUM_SCORE(3)          → medium
    //   低完整度 3 + 0 - 1 = 2 <  MEDIUM_SCORE(3)          → low
    const high = score({
      source: 'github',
      authenticated: true,
      reposted: false,
      completeness: COMPLETENESS_HIGH,
    })
    const middle = score({
      source: 'github',
      authenticated: false,
      reposted: false,
      completeness: (COMPLETENESS_HIGH + COMPLETENESS_LOW) / 2,
    })
    const low = score({
      source: 'github',
      authenticated: false,
      reposted: false,
      completeness: COMPLETENESS_LOW / 2,
    })

    expect(high.confidence).toBe('high')
    expect(middle.confidence).toBe('medium')
    expect(low.confidence).toBe('low')
    expect(low.reason).toContain('解析完整度低')
  })

  it('备注①：外部附带的说明被原样并入 reason，不被丢弃', () => {
    const scored = score({
      source: 'github',
      authenticated: false,
      reposted: false,
      completeness: 1,
      notes: [LOCAL_PROXY_SCOPE_NOTE],
    })
    expect(scored.reason).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('completeness 的边界与 clamp', () => {
    expect(clampCompleteness(Number.NaN)).toBe(0)
    expect(clampCompleteness(-1)).toBe(0)
    expect(clampCompleteness(2)).toBe(1)
    expect(clampCompleteness(0.5)).toBe(0.5)

    expect(completenessOf(4, 5)).toBeCloseTo(0.8, 6)
    expect(completenessOf(1, 0)).toBe(0)

    expect(completenessFrom({ a: 1, b: '', c: null }, ['a', 'b', 'c'])).toBeCloseTo(1 / 3, 6)
    expect(completenessFrom({ a: 1 }, [])).toBe(0)
    expect(completenessFrom({}, ['a'])).toBe(0)
  })

  it('capConfidence / rankConfidence 只降不升', () => {
    expect(capConfidence('high', 'medium')).toBe('medium')
    expect(capConfidence('low', 'medium')).toBe('low')
    expect(capConfidence('medium', 'medium')).toBe('medium')
    expect(rankConfidence('high')).toBeGreaterThan(rankConfidence('medium'))
    expect(rankConfidence('medium')).toBeGreaterThan(rankConfidence('low'))
  })

  it('withReason 追加子句、不重复、并保证句末标点', () => {
    expect(withReason('基础理由。', '补充一', '补充一')).toBe('基础理由。；补充一。')
    expect(withReason('没有句号', '补充')).toBe('没有句号；补充。')
    expect(withReason('什么都没有')).toBe('什么都没有。')
  })
})

describe('共享工具 — 适配器依赖的那层边界', () => {
  it('joinReason 去空、去重、保序；optionalReason 全空时给 undefined', () => {
    expect(joinReason('a', undefined, 'b', 'a', '   ', null)).toBe('a；b')
    expect(joinReason()).toBe('')
    expect(optionalReason(' ', undefined)).toBeUndefined()
    expect(optionalReason('x')).toBe('x')
  })

  it('isFailureKind 只认契约里的七种', () => {
    expect(isFailureKind('network')).toBe(true)
    expect(isFailureKind('not-code')).toBe(true)
    expect(isFailureKind('nope')).toBe(false)
    expect(isFailureKind(undefined)).toBe(false)
  })

  it('boundExcerpt 截断到上限并标记', () => {
    expect(boundExcerpt('abcdef', 3)).toEqual({ code: 'abc', codeTruncated: true })
    expect(boundExcerpt('abc', 3)).toEqual({ code: 'abc', codeTruncated: false })
    // 超硬顶的输入被夹回硬顶，而不是被信任
    expect(boundExcerpt('x'.repeat(HARD_LIMITS.maxCodeChars + 10), HARD_LIMITS.maxCodeChars + 10).code).toHaveLength(
      HARD_LIMITS.maxCodeChars,
    )
  })

  it('clamp* 一律以 DEFAULT_LIMITS / HARD_LIMITS 为准', () => {
    expect(clampMaxItems(999)).toBe(HARD_LIMITS.maxItems)
    expect(clampMaxItems(0)).toBe(DEFAULT_LIMITS.maxItems)
    expect(clampMaxItems(undefined)).toBe(DEFAULT_LIMITS.maxItems)
    expect(clampMaxCodeChars(999_999)).toBe(HARD_LIMITS.maxCodeChars)
    expect(clampMaxCodeChars(undefined)).toBe(DEFAULT_LIMITS.maxCodeChars)
    expect(clampTimeout(0)).toBe(DEFAULT_LIMITS.timeoutMs)
    expect(clampTimeout(999_999)).toBe(HARD_LIMITS.timeoutMs)
  })

  it('notCodeOutcome 是标准的 not-code 值，不抛异常', () => {
    expect(notCodeOutcome('不支持')).toEqual({ ok: false, results: [], reason: '不支持', failure: 'not-code' })
  })

  it('failureFromResponse 把 HTTP 状态映射到 FailureKind，并把通道说明带进 reason', () => {
    const answer = (statusCode: number, body: string, extra: Partial<TransportResponse> = {}): TransportResponse => ({
      statusCode,
      body,
      finalUrl: 'https://example.test/x',
      ...extra,
    })

    expect(failureFromResponse(answer(200, '{}'), '测试')).toBeNull()
    expect(failureFromResponse(answer(0, '{}'), '测试')).toBeNull()

    expect(failureFromResponse(answer(401, ''), '测试')?.failure).toBe('auth-required')
    expect(failureFromResponse(answer(403, 'API rate limit exceeded'), '测试')?.failure).toBe('rate-limited')
    expect(failureFromResponse(answer(403, 'Forbidden'), '测试')?.failure).toBe('auth-required')
    expect(failureFromResponse(answer(404, ''), '测试')?.failure).toBe('empty')
    expect(failureFromResponse(answer(408, ''), '测试')?.failure).toBe('timeout')
    expect(failureFromResponse(answer(429, ''), '测试')?.failure).toBe('rate-limited')
    expect(failureFromResponse(answer(500, ''), '测试')?.failure).toBe('network')
    expect(failureFromResponse(answer(400, ''), '测试')?.failure).toBe('parse-failed')

    const withNote = failureFromResponse(answer(429, '', { note: LOCAL_PROXY_SCOPE_NOTE }), '测试')
    expect(withNote?.reason).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('transportNotes 去空、去重、保序（note 在前，notes 在后）', () => {
    expect(transportNotes(undefined)).toEqual([])
    expect(
      transportNotes({ statusCode: 200, body: '', finalUrl: '', note: 'n1', notes: ['n1', ' n2 ', ''] }),
    ).toEqual(['n1', 'n2'])
  })

  it('tokenForAccess：镜像路径永远拿不到凭据', () => {
    expect(tokenForAccess('ghproxy', 'tok')).toBeUndefined()
    expect(tokenForAccess('raw-mirror', 'tok')).toBeUndefined()
    expect(tokenForAccess('third-party-mirror', 'tok')).toBeUndefined()
    expect(tokenForAccess('direct', 'tok')).toBe('tok')
    expect(tokenForAccess('token', 'tok')).toBe('tok')
    expect(tokenForAccess(undefined, 'tok')).toBe('tok')
    expect(tokenForAccess('direct', '   ')).toBeUndefined()
    expect(tokenForAccess('direct', undefined)).toBeUndefined()
  })

  it('classifyTransportError 识别名称、消息与已分类的错误对象', () => {
    const timeout = new Error('connect ETIMEDOUT')
    expect(classifyTransportError(timeout).failure).toBe('timeout')

    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(classifyTransportError(abort).failure).toBe('timeout')

    expect(classifyTransportError(new Error('429 Too Many Requests')).failure).toBe('rate-limited')
    expect(classifyTransportError(new Error('401 Unauthorized')).failure).toBe('auth-required')
    expect(classifyTransportError(new Error('Unexpected token < in JSON')).failure).toBe('parse-failed')
    expect(classifyTransportError(new Error('socket hang up')).failure).toBe('network')
    expect(classifyTransportError({ failure: 'not-code', message: '不是代码' }).failure).toBe('not-code')
    expect(classifyTransportError('纯字符串错误').failure).toBe('network')
  })

  it('isRetryableFailure 只认 RETRYABLE_FAILURES', () => {
    expect(isRetryableFailure('network')).toBe(true)
    expect(isRetryableFailure('timeout')).toBe(true)
    expect(isRetryableFailure('rate-limited')).toBe(true)
    expect(isRetryableFailure('auth-required')).toBe(true)
    expect(isRetryableFailure('empty')).toBe(false)
    expect(isRetryableFailure('parse-failed')).toBe(false)
    expect(isRetryableFailure('not-code')).toBe(false)
    expect(isRetryableFailure(undefined)).toBe(false)
  })
})
