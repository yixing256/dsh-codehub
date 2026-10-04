/**
 * 自动保存与常驻保存栏 —— 用户要求「每改一处自动保存 / 保存随时可见」。
 *
 * WHAT THIS PINS
 * --------------
 * 1. **Edits are written without pressing save.** One edit, then a quiet period,
 *    one PATCH — no keystroke storm.
 * 2. **A burst collapses into ONE write.** Five edits inside the debounce window
 *    must produce exactly one PATCH whose patch covers all of them, or the
 *    "本次修改" summary and the seat re-registration would fire per character.
 * 3. **A failed write keeps the edits.** The draft stays, `autoSavePending` stays
 *    true, and the error is visible — a failed auto-save must never eat work.
 * 4. **The manual path still exists** (`autoSaveNow`, `saveDraft('manual')`), and
 *    the bar says WHO saved, because a bar that only says 已保存 would hide a
 *    broken auto-writer.
 *
 * The host is a stubbed `fetch`: the route layer itself is covered by
 * `routes-fence.test.ts`, and what is under test here is the CLIENT's scheduling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTO_SAVE_DELAY_MS,
  autoSaveNow,
  getConfigState,
  isDirty,
  loadConfig,
  saveDraft,
  updateDraft,
} from '../src/client/api.js'

/**
 * A stateful stand-in for the host.
 *
 * It starts at the schema defaults and applies each PATCH the way the real route
 * does (one level deep, right side wins). Without the echo the client would read
 * back a payload missing `ui` and silently fall back to the default — which is
 * exactly the class of bug the precedence tests exist for.
 */
let hostState: Record<string, unknown>

function defaultHostState(): Record<string, unknown> {
  return {
    onboarded: true,
    entryPlacement: 'both',
    sourcePriority: ['github', 'gitee', 'csdn'],
    github: { accessPriority: ['direct'], webProxyBases: [], rawMirrorBases: [], localProxy: '' },
    csdn: { articleFetch: true, cdpEnabled: false, cdpPort: 9222 },
    ui: { autoSave: true },
    failover: { enabled: true },
    mergeSources: true,
    limits: {},
    deepRead: { targets: [] },
  }
}

function hostPayload(): unknown {
  // A host that predates the preference echoes no `ui` group at all — the case
  // that silently reverted the switch to its default.
  const config: Record<string, unknown> = { ...hostState }
  if (!hostKnowsAutoSave) delete config['ui']
  return {
    ok: true,
    config,
    credentials: { github: false, gitee: false, csdn: false },
    ...(extraWarnings.length === 0 ? {} : { warnings: [...extraWarnings] }),
  }
}

function applyPatchToHost(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    // An old host rejects unknown top-level groups by name, so `ui` never lands.
    if (key === 'ui' && !hostKnowsAutoSave) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      hostState[key] = value
      continue
    }
    const current = hostState[key]
    hostState[key] = { ...(typeof current === 'object' && current !== null ? current : {}), ...value }
  }
}

interface Recorded {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

let calls: Recorded[] = []
let patchBehaviour: 'ok' | 'reject' = 'ok'
/** False = the host bundle has not reloaded yet and drops `ui.*` keys. */
let hostKnowsAutoSave = true
/** Warnings the fake host attaches to a PATCH reply. */
let extraWarnings: string[] = []

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const path = String(url).replace('http://127.0.0.1', '')
      const method = (init?.method ?? 'GET').toUpperCase()
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body)
      calls.push({ method, path, body })

      if (method === 'PATCH' && patchBehaviour === 'reject') {
        return { ok: false, status: 500, text: async () => JSON.stringify({ ok: false, error: 'host 拒绝了这次写入' }) }
      }
      if (method === 'PATCH') {
        applyPatchToHost((body ?? {}) as Record<string, unknown>)
      }
      const payload = path.includes('/decisions')
        ? { ok: true, unresolved: [], decided: {}, decisionState: {} }
        : hostPayload()
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    }),
  )
}

/** Let queued promise callbacks run (the save path is async). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function patches(): Recorded[] {
  return calls.filter((call) => call.method === 'PATCH')
}

beforeEach(async () => {
  vi.useFakeTimers()
  calls = []
  patchBehaviour = 'ok'
  hostKnowsAutoSave = true
  extraWarnings = []
  hostState = defaultHostState()
  stubFetch()
  // A fresh host view; `force` because the store caches a previous load.
  await loadConfig(true)
  await settle()
  calls = calls.filter((call) => call.method !== 'GET')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('自动保存 — 改一处就写，无需点保存', () => {
  it('一次编辑 → 安静期后恰好一次 PATCH（不是立即，也不是每个按键）', async () => {
    updateDraft(draft => ({ ...draft, localProxy: '127.0.0.1:7890' }))

    // Scheduled, not sent: the user may still be typing.
    expect(patches()).toHaveLength(0)
    expect(getConfigState().autoSavePending).toBe(true)
    expect(isDirty()).toBe(true)

    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS)
    await settle()

    expect(patches()).toHaveLength(1)
    expect(patches()[0]?.body).toEqual({ github: { localProxy: '127.0.0.1:7890' } })
    // Saved: the draft is gone and the bar can say so.
    expect(getConfigState().draft).toBeNull()
    expect(getConfigState().autoSavePending).toBe(false)
    expect(getConfigState().lastSaveReason).toBe('auto')
  })

  it('一串连续编辑合并成一次写入，patch 覆盖全部改动', async () => {
    updateDraft(draft => ({ ...draft, localProxy: '127.0.0.1:7890' }))
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS / 2)
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS / 2)
    updateDraft(draft => ({ ...draft, csdnCdpPort: 9333 }))

    // Still one pending write: the debounce restarted each time.
    expect(patches()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS)
    await settle()

    expect(patches()).toHaveLength(1)
    expect(patches()[0]?.body).toEqual({
      github: { localProxy: '127.0.0.1:7890' },
      csdn: { cdpEnabled: true, cdpPort: 9333 },
    })
  })

  it('把一个值改回原样不算改动：不写、也不留草稿', async () => {
    const before = getConfigState().config
    updateDraft(draft => ({ ...draft, localProxy: '127.0.0.1:7890' }))
    updateDraft(draft => ({ ...draft, localProxy: before.localProxy }))

    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 2)
    await settle()

    expect(patches()).toHaveLength(0)
    expect(getConfigState().autoSavePending).toBe(false)
    expect(isDirty()).toBe(false)
  })

  it('写入失败时保留改动：草稿还在、pending 仍为真、错误可见', async () => {
    patchBehaviour = 'reject'
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))

    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS)
    await settle()

    expect(patches()).toHaveLength(1)
    expect(getConfigState().draft).not.toBeNull()
    expect(getConfigState().autoSavePending).toBe(true)
    expect(isDirty()).toBe(true)
    expect(getConfigState().error).toContain('拒绝')

    // …and the manual path can retry it.
    patchBehaviour = 'ok'
    expect(await autoSaveNow()).toBe(true)
    expect(getConfigState().draft).toBeNull()
    expect(getConfigState().lastSaveReason).toBe('auto')
  })

  it('autoSaveNow 立即落地并取消已排期的写入（向导「启用 CDP」用它）', async () => {
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))
    expect(await autoSaveNow()).toBe(true)
    expect(patches()).toHaveLength(1)

    // The scheduled timer was cancelled, so no second write follows.
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 3)
    await settle()
    expect(patches()).toHaveLength(1)
  })

  it('手动保存仍然可用，并且被标记为 manual（保存栏据此区分措辞）', async () => {
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))
    expect(await saveDraft('manual')).toBe(true)
    expect(getConfigState().lastSaveReason).toBe('manual')
    expect(patches()).toHaveLength(1)
  })
})

describe('自动保存开关与保存栏（源码级）', () => {
  it('开关就在保存栏里：能关，且关了之后按钮依然可用', async () => {
    const panel = await import('node:fs').then(fs => fs.readFileSync('src/client/panel.tsx', 'utf8'))
    const css = await import('node:fs').then(fs => fs.readFileSync('src/client/panel.module.css', 'utf8'))

    // 上一版的缺陷：自动保存写死开启且没有开关 → 草稿总是已被写掉 → 手动按钮恒 disabled。
    expect(panel).not.toContain('panel.autoSaveOn')
    expect(panel).toContain('panel.autoSaveToggle')
    expect(panel).toMatch(/autoSave: next/)
    expect(css).toMatch(/\.saveBarToggle\s*\{[\s\S]*display:\s*inline-flex/)

    // 按钮在两种模式下都有意义：待写入即可点，点了就是「立即写」。
    expect(panel).toMatch(/const canWrite = \(dirty \|\| state\.autoSavePending\) && !state\.saving/)
    expect(panel).toMatch(/void autoSaveNow\(\)/)
    expect(panel).toContain('panel.saveNow')
    expect(panel).toContain('panel.dirtyManual')
    // 保存栏仍然常驻，文案仍区分自动/手动/待保存。
    expect(panel).toContain('saveBarSticky')
    expect(panel).toContain('panel.autoSaved')
    expect(panel).toContain('panel.autoSavePending')
    expect(css).toMatch(/\.saveBarSticky\s*\{[\s\S]*position:\s*sticky/)
  })
})

/**
 * Load with a known auto-save preference (the same path the bar switch uses).
 *
 * Module scope because two describes need it: 「开关可以关掉」 and the regression for
 * 「关掉之后被悄悄改回开」.
 */
async function loadWith(autoSave: boolean): Promise<void> {
  calls = []
  patchBehaviour = 'ok'
  hostState = defaultHostState()
  stubFetch()
  await loadConfig(true)
  await settle()
  updateDraft(draft => ({ ...draft, autoSave }))
  await autoSaveNow()
  // Turning the switch OFF flushes a write from inside `updateDraft`, so the
  // explicit call above can land while that one is still in flight: wait until the
  // store is quiet before asserting.
  for (let i = 0; i < 20 && getConfigState().saving; i += 1) await vi.advanceTimersByTimeAsync(10)
  await settle()
  // Discard everything the SETUP wrote (the switch itself is an edit); the test
  // that follows asserts only on what it triggers.
  calls = []
}

describe('自动保存可以关掉（ui.autoSave = false）', () => {
  it('关闭后编辑只留在草稿里：不排期、不写、状态是「有未保存的改动」', async () => {
    await loadWith(false)

    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 5)
    await settle()

    expect(patches()).toHaveLength(0)
    expect(isDirty()).toBe(true)
    expect(getConfigState().autoSavePending).toBe(false)
    expect(getConfigState().draft?.csdnCdpEnabled).toBe(true)
  })

  it('关闭状态下按钮仍然能写（保存栏按钮走的就是这条路）', async () => {
    await loadWith(false)
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))

    expect(await autoSaveNow()).toBe(true)
    expect(patches()).toHaveLength(1)
    expect(getConfigState().draft).toBeNull()
  })

  it('待保存时把开关打开：自动保存恢复，且那一笔改动不丢', async () => {
    await loadWith(false)
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))
    expect(patches()).toHaveLength(0)

    updateDraft(draft => ({ ...draft, autoSave: true }))
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS)
    await settle()

    expect(patches()).toHaveLength(1)
    expect(patches()[0]?.body).toMatchObject({ csdn: { cdpEnabled: true }, ui: { autoSave: true } })
    expect(getConfigState().draft).toBeNull()
  })

  it('开着的时候把开关关掉：这一次写入必须发生（开关本身要被保存），之后再编辑就不写了', async () => {
    await loadWith(true)
    updateDraft(draft => ({ ...draft, csdnCdpEnabled: true }))
    expect(getConfigState().autoSavePending).toBe(true)

    updateDraft(draft => ({ ...draft, autoSave: false }))
    await settle()

    // Exactly one write, and it carries both the pending edit and the preference —
    // otherwise the switch would silently revert to ON on the next page load.
    expect(patches()).toHaveLength(1)
    expect(patches()[0]?.body).toMatchObject({ csdn: { cdpEnabled: true }, ui: { autoSave: false } })
    expect(getConfigState().draft).toBeNull()
    expect(getConfigState().config.autoSave).toBe(false)

    // From now on nothing is written by itself.
    calls = []
    updateDraft(draft => ({ ...draft, csdnCdpPort: 9333 }))
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 5)
    await settle()
    expect(patches()).toHaveLength(0)
    expect(isDirty()).toBe(true)
  })

  it('开关关闭这件事本身能被保存（否则刷新后又变回开启）', async () => {
    await loadWith(true)
    calls = []
    updateDraft(draft => ({ ...draft, autoSave: false }))
    await settle()

    expect(patches()).toHaveLength(1)
    expect(patches()[0]?.body).toEqual({ ui: { autoSave: false } })
    expect(getConfigState().config.autoSave).toBe(false)
    // 这一次写入是「开关本身」，不是自动保存又跑了一次：措辞必须区分。
    expect(getConfigState().lastSaveReason).toBe('preference')
  })
})

/**
 * 用户报告的原话：「我关闭了自动保存，结果直接自动保存，又开启了」。
 *
 * Two things produced that: (a) the switch's own write looked like the auto-saver
 * running, and (b) a host that did not know the key dropped it, so adopting the
 * read-back reset the user's explicit choice to the default. (b) is the actual
 * revert and it must never happen silently.
 */
describe('关掉自动保存不能被悄悄改回「开」（回归）', () => {
  it('老 host 不认识 ui.autoSave：本页保持「关」，并且把原因说出来', async () => {
    hostKnowsAutoSave = false
    await loadWith(true)

    updateDraft(draft => ({ ...draft, autoSave: false }))
    await settle()

    expect(patches()).toHaveLength(1)
    // The bug: config.autoSave flipped back to true right here.
    expect(getConfigState().config.autoSave).toBe(false)
    expect(getConfigState().lastSaveReason).toBe('preference')
    expect(getConfigState().lastWarnings.join(' ')).toContain('不认识自动保存设置')
    // And the panel shows it rather than swallowing it.
    expect(getConfigState().lastWarnings.length).toBeGreaterThan(0)
  })

  it('新 host 认识 ui.autoSave：保持「关」，且没有多余警告', async () => {
    hostKnowsAutoSave = true
    await loadWith(true)

    updateDraft(draft => ({ ...draft, autoSave: false }))
    await settle()

    expect(getConfigState().config.autoSave).toBe(false)
    expect(getConfigState().lastWarnings).toEqual([])
  })

  it('host 自己带回 warnings 时也要透出（不是只显示我们加的）', async () => {
    hostKnowsAutoSave = true
    await loadWith(true)
    extraWarnings = ['已忽略本插件不接受的字段：ui。']

    updateDraft(draft => ({ ...draft, autoSave: false }))
    await settle()

    expect(getConfigState().lastWarnings).toContain('已忽略本插件不接受的字段：ui。')
  })
})
