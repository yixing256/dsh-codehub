/**
 * `codeSource` 服务与统一交付出口（task-5 §B 的 `redactForDelivery` + §C 的「零网络」服务级断言）。
 *
 * Two requirements can only be proven here, at the service layer:
 *
 *   1. **`redactForDelivery()` is the single delivery outlet.** It bounds `code`
 *      (banner included in the budget), marks truncation, forces
 *      `is_verbatim_copy: false`, validates `confidence` and refuses to leave a
 *      row without a takeaway — the mechanism 备注③ relies on.
 *   2. **The decision gate costs exactly ZERO network requests.** `gating.ts`
 *      proves the gate is closed; only the live service can prove that a closed
 *      gate never even constructs a `Transport`, never calls an adapter, and
 *      still hands the model a relayable question.
 *
 * Everything runs against injected fakes: `createTransport` counts factory calls
 * and refuses to answer, the adapters are in-memory, and `store` is a stub. No
 * socket is ever opened.
 */

import { describe, expect, it } from 'vitest'

import {
  ANTI_COPY_STATEMENT,
  CSDN_API_NOTE,
  DECISION_GUIDE,
  DECISION_KEYS,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  LEARNING_ONLY_BANNER,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_SCOPE_NOTE,
} from '../src/contract.js'
import type { CodeLearnResult, DecisionKey, SourceId } from '../src/contract.js'
import { resolveConfig } from '../src/config.js'
import type { CodehubConfig } from '../src/config.js'
import { CodeSource, composeMirrorBase, orderSources, redactForDelivery, resolveAccess } from '../src/service.js'
import type { AdapterDeepOutcome, AdapterOutcome, SourceAdapter, Transport, TransportRequest } from '../src/sources/types.js'
import { makeRow } from './helpers.js'

const BANNER_LINE = `${LEARNING_ONLY_BANNER}\n`

/** All four decisions answered — two of them with the answer `false`. */
const DECIDED: CodehubConfig = {
  sourcePriority: ['github', 'gitee', 'csdn'],
  github: { accessPriority: ['direct'] },
  failover: { enabled: false },
  mergeSources: false,
}

// ---------------------------------------------------------------------------
// redactForDelivery — the unified outlet.
// ---------------------------------------------------------------------------

describe('交付出口 — is_verbatim_copy 恒为 false，code 恒有界', () => {
  it('横幅写在 code 首行（截图/复制都甩不掉），且 is_verbatim_copy === false', () => {
    const row = redactForDelivery(makeRow({ code: 'const a = 1' }), { maxCodeChars: 500 })

    expect(row.is_verbatim_copy).toBe(false)
    expect(row.code.startsWith(BANNER_LINE)).toBe(true)
    expect(row.code).toBe(`${BANNER_LINE}const a = 1`)
    expect(row.codeTruncated).toBe(false)
  })

  it('超限即截断，且 code.length（含横幅）不超过 maxCodeChars', () => {
    const row = redactForDelivery(makeRow({ code: 'x'.repeat(500) }), { maxCodeChars: 100 })

    expect(row.codeTruncated).toBe(true)
    expect(row.code.length).toBeLessThanOrEqual(100)
    expect(row.code.startsWith(BANNER_LINE)).toBe(true)
  })

  it('按行边界切，不留半行', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n')
    const row = redactForDelivery(makeRow({ code: lines }), { maxCodeChars: 120 })

    expect(row.codeTruncated).toBe(true)
    const kept = row.code.slice(BANNER_LINE.length)
    expect(lines.startsWith(kept)).toBe(true)
    expect(kept.split('\n').every((line) => /^line-\d+$/.test(line))).toBe(true)
  })

  it('预算内的 code 不标截断；原行已标截断则保持 true', () => {
    expect(redactForDelivery(makeRow({ code: 'short' }), { maxCodeChars: 100 }).codeTruncated).toBe(false)
    expect(redactForDelivery(makeRow({ code: 'short', codeTruncated: true }), { maxCodeChars: 100 }).codeTruncated).toBe(
      true,
    )
  })

  it('maxCodeChars 被夹回 HARD_LIMITS，调用方无法放大它', () => {
    const huge = 'y'.repeat(HARD_LIMITS.maxCodeChars + 1_000)
    const row = redactForDelivery(makeRow({ code: huge }), { maxCodeChars: 10_000_000 })

    expect(row.code.length).toBeLessThanOrEqual(HARD_LIMITS.maxCodeChars)
    expect(row.codeTruncated).toBe(true)
  })

  it('缺省预算取自 DEFAULT_LIMITS', () => {
    const row = redactForDelivery(makeRow({ code: 'z'.repeat(DEFAULT_LIMITS.maxCodeChars + 100) }))

    expect(row.codeTruncated).toBe(true)
    expect(row.code.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxCodeChars)
  })

  it('非法 confidence 降级为 low；没有思路时给诚实兜底句（且不含代码）', () => {
    const invalid = redactForDelivery(
      { ...makeRow(), confidence: 'nonsense' as unknown as CodeLearnResult['confidence'] },
      { maxCodeChars: 500 },
    )
    expect(invalid.confidence).toBe('low')

    const fallback = redactForDelivery(makeRow({ learned_summary: '   ', code: 'SECRET_SNIPPET_XYZ' }), {
      maxCodeChars: 500,
    })
    expect(fallback.learned_summary.trim().length).toBeGreaterThan(0)
    expect(fallback.learned_summary).toContain('不要把它当作可直接使用的代码')
    expect(fallback.learned_summary).not.toContain('SECRET_SNIPPET_XYZ')
  })

  it('数组形式逐条脱敏，返回新数组', () => {
    const rows = [makeRow({ url: 'https://a.dev/1' }), makeRow({ url: 'https://a.dev/2' })]
    const redacted = redactForDelivery(rows, { maxCodeChars: 500 })

    expect(redacted).toHaveLength(2)
    expect(redacted).not.toBe(rows)
    for (const row of redacted) {
      expect(row.is_verbatim_copy).toBe(false)
      expect(row.code.startsWith(BANNER_LINE)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// CodeSource — fakes only.
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: CodeSource
  readonly counters: { transportFactory: number; search: number; deepRead: number }
  readonly queried: SourceId[]
  readonly transportCalls: TransportRequest[]
}

interface HarnessOptions {
  readonly config?: CodehubConfig
  readonly rows?: readonly CodeLearnResult[]
  readonly failSources?: readonly SourceId[]
}

function harness(options: HarnessOptions = {}): Harness {
  const config = options.config ?? {}
  const rows = options.rows ?? [makeRow()]
  const failing = new Set<SourceId>(options.failSources ?? [])
  const counters = { transportFactory: 0, search: 0, deepRead: 0 }
  const queried: SourceId[] = []
  const transportCalls: TransportRequest[] = []

  const adapters: SourceAdapter[] = (['github', 'gitee', 'csdn'] as const).map((id) => ({
    id,
    search: async (): Promise<AdapterOutcome> => {
      counters.search += 1
      queried.push(id)
      if (failing.has(id)) return { ok: false, results: [], reason: `${id} 失败`, failure: 'network' }
      return { ok: true, results: [...rows], reason: `${id} 命中` }
    },
    deepRead: async (): Promise<AdapterDeepOutcome> => {
      counters.deepRead += 1
      return { notes: [], reason: '没有产出笔记' }
    },
  }))

  const store = {
    read: async () => ({}),
    write: async () => ({ ok: true, path: '/tmp/x', value: {} }),
    filePath: '/tmp/dsh-codehub.json',
  }

  const service = new CodeSource({ get: () => undefined } as never, {
    getConfig: () => config,
    store: store as never,
    adapters,
    createTransport: () => {
      counters.transportFactory += 1
      const transport: Transport = async (request) => {
        transportCalls.push(request)
        throw new Error('测试禁止真实网络请求：transport 不应被调用')
      }
      return transport
    },
  })

  return { service, counters, queried, transportCalls }
}

describe('决策门禁 — 服务级：拒答时代价恰好为零网络请求', () => {
  it('四项全未决策 → 拒答、四个问题、零 transport、零适配器调用', async () => {
    const tested = harness({ config: {} })
    const outcome = await tested.service.search('vue 响应式')

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toEqual([])
    expect(outcome.unresolved_decisions.map((item) => item.key)).toEqual([...DECISION_KEYS])
    expect(outcome.ask_user).toContain(DECISION_GUIDE.sourcePriority.ask)
    expect(outcome.reason).toContain('未发起任何网络请求')

    // 最强形式：连 transport 工厂都没构造过，适配器更没被碰过。
    expect(tested.counters).toEqual({ transportFactory: 0, search: 0, deepRead: 0 })
    expect(tested.queried).toEqual([])
    expect(tested.transportCalls).toEqual([])
  })

  it('四种「缺一项」的组合逐一验证：只报缺的那一项，且都不发请求', async () => {
    const cases: ReadonlyArray<{ readonly config: CodehubConfig; readonly missing: DecisionKey }> = [
      { config: { ...DECIDED, sourcePriority: [] }, missing: 'sourcePriority' },
      { config: { ...DECIDED, github: { accessPriority: [] } }, missing: 'githubAccessPriority' },
      { config: { ...DECIDED, failover: {} }, missing: 'failoverEnabled' },
      { config: { ...DECIDED, mergeSources: undefined }, missing: 'mergeSources' },
    ]

    for (const item of cases) {
      const tested = harness({ config: item.config })
      const outcome = await tested.service.search('vue')

      expect(outcome.ok, item.missing).toBe(false)
      expect(outcome.unresolved_decisions.map((entry) => entry.key), item.missing).toEqual([item.missing])
      expect(tested.counters.transportFactory, item.missing).toBe(0)
      expect(tested.counters.search, item.missing).toBe(0)
      expect(tested.transportCalls, item.missing).toEqual([])
    }
  })

  it('false 是有效答案：failover / merge 都答 false 时门禁放行并真的去查', async () => {
    const tested = harness({ config: DECIDED })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(true)
    expect(outcome.unresolved_decisions).toEqual([])
    expect(outcome.ask_user).toBe('')
    expect(tested.counters.search).toBe(1)
    expect(tested.counters.transportFactory).toBe(1)
  })

  it('插件关闭时也拒答，且同样零请求（关闭 ≠ 未决策）', async () => {
    const tested = harness({ config: { ...DECIDED, enabled: false } })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('关闭状态')
    expect(outcome.ask_user.trim().endsWith('？')).toBe(true)
    expect(tested.counters).toEqual({ transportFactory: 0, search: 0, deepRead: 0 })
  })
})

describe('服务 — 排序、降级与合并', () => {
  it('mergeSources=false：只用最高优先级、且真的成功了的那个源', async () => {
    const tested = harness({ config: DECIDED })
    const outcome = await tested.service.search('vue')

    expect(outcome.sources_queried).toEqual(['github'])
    expect(outcome.merged).toBe(false)
    expect(outcome.degraded).toBe(false)
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]?.is_verbatim_copy).toBe(false)
    expect(outcome.results[0]?.code.startsWith(BANNER_LINE)).toBe(true)
  })

  it('failover=false：第一个源失败就停，并把「要不要换源」变成给用户的提问', async () => {
    const tested = harness({ config: { ...DECIDED, sourcePriority: ['github', 'gitee'] }, failSources: ['github'] })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(false)
    expect(outcome.sources_queried).toEqual(['github'])
    expect(outcome.degraded).toBe(false)
    expect(outcome.failures).toEqual([{ source: 'github', kind: 'network', reason: 'github 失败' }])
    expect(outcome.ask_user.trim().endsWith('？')).toBe(true)
    expect(outcome.ask_user).toContain('Gitee')
  })

  it('failover=true：按用户设置切到下一个源，degraded 为 true', async () => {
    const tested = harness({
      config: { ...DECIDED, sourcePriority: ['github', 'gitee'], failover: { enabled: true } },
      failSources: ['github'],
    })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(true)
    expect(outcome.sources_queried).toEqual(['github', 'gitee'])
    expect(outcome.degraded).toBe(true)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.reason).toContain('自动降级')
  })

  it('mergeSources=true：多源合并去重；同一 URL 的结果只留一条', async () => {
    const tested = harness({
      config: { ...DECIDED, sourcePriority: ['github', 'gitee'], mergeSources: true },
      rows: [makeRow({ url: 'https://github.com/a/b' })],
    })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(true)
    expect(outcome.sources_queried).toEqual(['github', 'gitee'])
    expect(outcome.merged).toBe(true)
    expect(outcome.results).toHaveLength(1)
  })

  it('降级深度受 limits.maxDepth 约束，不会把 sourcePriority 整个跑一遍', async () => {
    const tested = harness({
      config: { ...DECIDED, failover: { enabled: true }, limits: { maxDepth: 1 } },
      failSources: ['github', 'gitee', 'csdn'],
    })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(false)
    expect(outcome.sources_queried).toEqual(['github', 'gitee'])
    expect(outcome.reason).toContain('降级深度已达上限')
  })

  it('所有源都失败时给出可转述的提问，而不是静默返回空', async () => {
    const tested = harness({
      config: {
        ...DECIDED,
        sourcePriority: ['github', 'gitee', 'csdn'],
        failover: { enabled: true },
        // 放开深度预算，让三个源都真的被尝试一遍。
        limits: { maxDepth: HARD_LIMITS.maxDepth },
      },
      failSources: ['github', 'gitee', 'csdn'],
    })
    const outcome = await tested.service.search('vue')

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toEqual([])
    expect(outcome.sources_queried).toEqual(['github', 'gitee', 'csdn'])
    expect(outcome.failures).toHaveLength(3)
    expect(outcome.ask_user.trim().length).toBeGreaterThan(0)
    expect(outcome.ask_user.trim().endsWith('？')).toBe(true)
  })
})

describe('服务 — 配置视图把三条备注交给前端', () => {
  it('describeConfig 带出 CSDN 来源标注 / 代理适用范围 / 防搬运声明，且决策未定以 null 序列化', async () => {
    const tested = harness({ config: {} })
    const view = await tested.service.describeConfig()

    expect(view.ok).toBe(true)
    expect(view.decisions.map((item) => item.key)).toEqual([...DECISION_KEYS])
    expect(view.decided).toBe(false)
    expect(view.notes.csdn).toBe(CSDN_API_NOTE)
    expect(view.notes.localProxy).toBe(LOCAL_PROXY_HELP)
    expect(view.notes.antiCopy).toBe(ANTI_COPY_STATEMENT)
    expect(view.transport.proxyScopeNote).toBe(LOCAL_PROXY_SCOPE_NOTE)
    expect(view.paths.store).toBe('/tmp/dsh-codehub.json')
    expect(view.credentials).toEqual({ github: false, gitee: false, csdn: false })

    // 「未决策」必须在 JSON 里活下来（null ≠ false）。
    expect(view.config.failover.enabled).toBeNull()
    expect(view.config.mergeSources).toBeNull()
    expect(view.config.sourcePriority).toEqual([])
    expect(view.config.github.accessPriority).toEqual([])
    expect(view.limits).toEqual({ ...DEFAULT_LIMITS })
  })

  it('凭据状态只有布尔：值永远不经过这里', async () => {
    const tested = harness({ config: DECIDED })
    const status = await tested.service.credentialStatus()

    expect(Object.values(status).every((value) => typeof value === 'boolean')).toBe(true)
    expect(Object.keys(status).sort()).toEqual(['csdn', 'gitee', 'github'])
    expect(JSON.stringify(status)).not.toContain('token')
  })
})

describe('服务 — 纯函数：源顺序 / 镜像基址 / 访问方式', () => {
  it('orderSources 保留用户排序，显式请求只做过滤与补位', () => {
    expect(orderSources(['github', 'gitee', 'csdn'], [])).toEqual(['github', 'gitee', 'csdn'])
    expect(orderSources(['github', 'gitee', 'csdn'], ['csdn'])).toEqual(['csdn'])
    expect(orderSources(['github'], ['gitee', 'github'])).toEqual(['github', 'gitee'])
    expect(orderSources([], ['gitee'])).toEqual(['gitee'])
  })

  it('composeMirrorBase 拼出 ghproxy 形态，也支持 {url} 模板与已含 origin 的基址', () => {
    expect(composeMirrorBase('https://ghproxy.net/', 'https://api.github.com')).toBe(
      'https://ghproxy.net/https://api.github.com',
    )
    expect(composeMirrorBase('https://ghproxy.net/https://api.github.com', 'https://api.github.com')).toBe(
      'https://ghproxy.net/https://api.github.com',
    )
    expect(composeMirrorBase('https://cdn.example/{url}', '')).toBe('https://cdn.example/https://api.github.com')
  })

  it('resolveAccess：空列表 = 不可用，绝不替用户选一条路', () => {
    const plan = resolveAccess(resolveConfig({}))

    expect(plan.available).toBe(false)
    expect(plan.access).toBeUndefined()
    expect(plan.notes.join(' ')).toContain('accessPriority')
  })

  it('resolveAccess：direct 可用，token 会提示匿名额度，ghproxy 缺基址就跳过', () => {
    const direct = resolveAccess(resolveConfig({ github: { accessPriority: ['direct'] } }))
    expect(direct.available).toBe(true)
    expect(direct.access).toBe('direct')

    const token = resolveAccess(resolveConfig({ github: { accessPriority: ['token'] } }))
    expect(token.access).toBe('token')
    expect(token.notes.join(' ')).toContain('匿名额度')

    const noBase = resolveAccess(resolveConfig({ github: { accessPriority: ['ghproxy'] } }))
    expect(noBase.available).toBe(false)
    expect(noBase.notes.join(' ')).toContain('镜像基址列表为空')

    const withBase = resolveAccess(
      resolveConfig({ github: { accessPriority: ['ghproxy'], webProxyBases: ['https://ghproxy.net'] } }),
    )
    expect(withBase.available).toBe(true)
    expect(withBase.apiBase).toBe('https://ghproxy.net/https://api.github.com')
    expect(withBase.notes.join(' ')).toContain('剥离 token')
  })

  it('resolveAccess：local-proxy 未填地址时跳过；填了才可用并带上备注①', () => {
    const empty = resolveAccess(resolveConfig({ github: { accessPriority: ['local-proxy'] } }))
    expect(empty.available).toBe(false)
    expect(empty.notes.join(' ')).toContain('本机代理')

    const configured = resolveAccess(
      resolveConfig({ github: { accessPriority: ['local-proxy'], localProxy: '127.0.0.1:7890' } }),
    )
    expect(configured.available).toBe(true)
    expect(configured.notes.join(' ')).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('resolveAccess：raw-mirror 不提供搜索基址，也不会退回官方直连', () => {
    const plan = resolveAccess(resolveConfig({ github: { accessPriority: ['raw-mirror'] } }))

    expect(plan.available).toBe(false)
    expect(plan.notes.join(' ')).toContain('raw')
    expect(plan.apiBase).toBe('')
  })
})
