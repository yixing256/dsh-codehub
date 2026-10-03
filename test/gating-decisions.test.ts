/**
 * 决策点门禁（task-5 §C）—— 插件永不替用户拍板。
 *
 * `gating.ts` is pure, so the whole contract is asserted directly:
 *
 *   • an unanswered decision closes the gate with `ok:false`, one
 *     `UnresolvedDecision` per missing answer, and an `ask_user` string the model
 *     can relay verbatim;
 *   • **`false` is an answer, `undefined` is not.** "do not degrade" and "do not
 *     merge" must PASS — a truthiness check would be a bug, and this file pins the
 *     distinction from both sides;
 *   • an empty priority list means "not ranked yet", never "all sources";
 *   • unknown / blank / duplicated entries are filtered instead of being trusted;
 *   • the refusal happens with ZERO network requests — the strongest form of that
 *     assertion needs the live service, so it lives in `service-outlet.test.ts`
 *     (`CodeSource.search()` never even builds a transport when the gate is shut).
 */

import { describe, expect, it } from 'vitest'

import {
  DECISION_GUIDE,
  DECISION_KEYS,
  GITHUB_ACCESS,
  SOURCES,
  decisionPrompt,
} from '../src/contract.js'
import type { DecisionKey } from '../src/contract.js'
import {
  decisionGuideFor,
  decisionState,
  disabledRefusal,
  evaluateDecisions,
  isDecided,
  unresolvedDecisions,
  unresolvedKeys,
} from '../src/gating.js'
import type { DecisionInput } from '../src/gating.js'

/** All four decisions answered. `false` is a real answer in two of them. */
const DECIDED: DecisionInput = {
  sourcePriority: ['github', 'gitee', 'csdn'],
  github: { accessPriority: ['direct'] },
  failover: { enabled: false },
  mergeSources: false,
}

describe('门禁 — 未决策即拒答', () => {
  it('空配置 → ok:false + 四个未决策，顺序恒为 DECISION_KEYS', () => {
    const gate = evaluateDecisions({})
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')

    expect(gate.unresolved_decisions.map((item) => item.key)).toEqual([...DECISION_KEYS])
    expect(unresolvedKeys({})).toEqual([...DECISION_KEYS])
    expect(gate.ask_user.length).toBeGreaterThan(0)
    expect(gate.ask_user).toBe(decisionPrompt(gate.unresolved_decisions))
  })

  it('undefined / null 入参等同于空配置（全新安装的默认路径）', () => {
    expect(unresolvedKeys(undefined)).toEqual([...DECISION_KEYS])
    expect(unresolvedKeys(null)).toEqual([...DECISION_KEYS])
  })

  it('sourcePriority 为空数组 → 拒答，且只缺这一项', () => {
    const gate = evaluateDecisions({ ...DECIDED, sourcePriority: [] })
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.unresolved_decisions.map((item) => item.key)).toEqual(['sourcePriority'])
  })

  it('github.accessPriority 为空数组 → 拒答，含 githubAccessPriority', () => {
    const gate = evaluateDecisions({ ...DECIDED, github: { accessPriority: [] } })
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.unresolved_decisions.map((item) => item.key)).toContain('githubAccessPriority')
  })

  it('空数组绝不回落到「全部源」或「默认顺序」', () => {
    const state = decisionState({ sourcePriority: [] })
    expect(state.sourcePriority).toBeUndefined()
    expect(isDecided(state, 'sourcePriority')).toBe(false)

    const gate = evaluateDecisions({ sourcePriority: [] })
    expect(gate.ok).toBe(false)
  })
})

describe('门禁 — false 是有效答案，undefined 才是「还没问」', () => {
  it('failoverEnabled 未定义 → 拒答；false → 通过；true → 通过', () => {
    const missing: DecisionInput = { ...DECIDED, failover: {} }
    expect(unresolvedKeys(missing)).toEqual(['failoverEnabled'])
    expect(evaluateDecisions(missing).ok).toBe(false)

    expect(evaluateDecisions({ ...DECIDED, failover: { enabled: false } }).ok).toBe(true)
    expect(evaluateDecisions({ ...DECIDED, failover: { enabled: true } }).ok).toBe(true)
  })

  it('mergeSources 未定义 → 拒答；false → 通过；true → 通过', () => {
    const { mergeSources: _omitted, ...withoutMerge } = DECIDED
    void _omitted
    expect(unresolvedKeys(withoutMerge)).toEqual(['mergeSources'])
    expect(evaluateDecisions(withoutMerge).ok).toBe(false)

    expect(evaluateDecisions({ ...DECIDED, mergeSources: false }).ok).toBe(true)
    expect(evaluateDecisions({ ...DECIDED, mergeSources: true }).ok).toBe(true)
  })

  it('null 与 undefined 等价（JSON 里「未设置」只有这两种写法）', () => {
    expect(unresolvedKeys({ ...DECIDED, mergeSources: null })).toEqual(['mergeSources'])
    expect(unresolvedKeys({ ...DECIDED, failover: { enabled: null } })).toEqual(['failoverEnabled'])
  })

  it('四项全部有答案 → 允许执行', () => {
    const gate = evaluateDecisions(DECIDED)
    expect(gate.ok).toBe(true)
    expect(unresolvedDecisions(DECIDED)).toEqual([])
  })
})

describe('门禁 — 别名与容错', () => {
  it('顶层别名 githubAccessPriority / failoverEnabled 也认（避免误判为未决策）', () => {
    const gate = evaluateDecisions({
      sourcePriority: ['github'],
      githubAccessPriority: ['direct'],
      failoverEnabled: false,
      mergeSources: false,
    })
    expect(gate.ok).toBe(true)
  })

  it('嵌套写法优先于顶层别名（canonical 路径是嵌套的）', () => {
    const state = decisionState({
      github: { accessPriority: ['ghproxy'] },
      githubAccessPriority: ['direct'],
      failover: { enabled: true },
      failoverEnabled: false,
    })
    expect(state.githubAccessPriority).toEqual(['ghproxy'])
    expect(state.failoverEnabled).toBe(true)
  })

  it('未知值被过滤掉；全是未知值 → 仍然算未决策', () => {
    expect(unresolvedKeys({ ...DECIDED, sourcePriority: ['bitbucket'] })).toEqual(['sourcePriority'])
    expect(unresolvedKeys({ ...DECIDED, github: { accessPriority: ['nope'] } })).toEqual(['githubAccessPriority'])
  })

  it('空白项与重复项被清理，顺序保留', () => {
    const state = decisionState({ sourcePriority: [' gitee ', '', 'github', 'gitee', '  ', 'csdn'] })
    expect(state.sourcePriority).toEqual(['gitee', 'github', 'csdn'])
  })

  it('非布尔值不被当作答案（只有真正的 boolean 才算答过）', () => {
    expect(decisionState({ mergeSources: 'false' as unknown as boolean }).mergeSources).toBeUndefined()
    expect(decisionState({ failover: { enabled: 1 as unknown as boolean } }).failoverEnabled).toBeUndefined()
  })

  it('决策状态对象可以直接回传（幂等：state → 门禁 → state 不变）', () => {
    const state = decisionState(DECIDED)
    expect(state.sourcePriority).toEqual(['github', 'gitee', 'csdn'])
    expect(state.githubAccessPriority).toEqual(['direct'])
    expect(state.failoverEnabled).toBe(false)
    expect(state.mergeSources).toBe(false)

    const again = decisionState(state as unknown as DecisionInput)
    expect(again).toEqual(state)
    expect(evaluateDecisions(state).ok).toBe(true)
    expect(unresolvedDecisions(state)).toEqual([])
  })
})

describe('门禁 — 每个未决策都可直接转述给用户', () => {
  it('DECISION_GUIDE 四条的 ask 非空、是问句、且有 detail 与 control', () => {
    for (const key of DECISION_KEYS) {
      const guide = DECISION_GUIDE[key]
      expect(guide.key).toBe(key)
      expect(guide.ask.trim().length).toBeGreaterThan(0)
      expect(guide.ask.trim().endsWith('？'), `${key}.ask 应是问句`).toBe(true)
      expect(guide.detail.trim().length).toBeGreaterThan(0)
      expect(guide.control.trim().length).toBeGreaterThan(0)
    }
  })

  it('ask_user 逐行包含每一条 ask（一行一个问题，模型可原样转述）', () => {
    const gate = evaluateDecisions({})
    if (gate.ok) throw new Error('unreachable')

    const lines = gate.ask_user.split('\n')
    expect(lines).toHaveLength(DECISION_KEYS.length)
    for (const item of gate.unresolved_decisions) {
      expect(gate.ask_user).toContain(item.ask)
    }
  })

  it('decisionGuideFor 返回副本，改不动 DECISION_GUIDE', () => {
    const copy = decisionGuideFor('sourcePriority')
    expect(copy).toEqual(DECISION_GUIDE.sourcePriority)
    expect(copy).not.toBe(DECISION_GUIDE.sourcePriority)
  })

  it('契约里的来源与访问方式枚举非空，且门禁只认它们', () => {
    expect([...SOURCES]).toEqual(['github', 'gitee', 'csdn'])
    expect(GITHUB_ACCESS.length).toBeGreaterThanOrEqual(8)
  })
})

describe('门禁 — 关闭状态与决策缺失是两回事', () => {
  it('disabledRefusal() 给出独立的关闭说明与提问，不混入决策点', () => {
    const refusal = disabledRefusal()
    expect(refusal.ok).toBe(false)
    expect(refusal.reason).toContain('enabled')
    expect(refusal.reason).toContain('未发起任何网络请求')
    expect(refusal.ask_user.trim().endsWith('？')).toBe(true)
    for (const key of DECISION_KEYS) {
      expect(refusal.ask_user).not.toContain(DECISION_GUIDE[key as DecisionKey].ask)
    }
  })
})
