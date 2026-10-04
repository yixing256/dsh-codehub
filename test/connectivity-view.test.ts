/**
 * 连通性面板的展示契约 —— 「三行、失败后面跟原因、不许 JSON 报文」。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The user's requirement was explicit: the connectivity check must NOT show a
 * JSON document, it must be a GUI that reports GitHub / Gitee / CSDN separately,
 * with the failure reason directly after the failure. The old card ended in
 * `<pre>{JSON.stringify(smoke, null, 2)}</pre>`.
 *
 * Two things can silently undo that, so both are pinned here:
 *
 *   1. **The shape stops being constant.** If a payload without `probes`, a
 *      partial record or an unknown source could shrink the list, the "三行"
 *      guarantee is gone. `normalizeSmoke` is therefore asserted against empty,
 *      partial, misordered and hostile payloads.
 *   2. **A raw body reaches the DOM.** The render is asserted to contain the
 *      normalised text and NONE of the payload's JSON (`"probes"`,
 *      `access_token`, a `<pre>`), and `panel.tsx` is asserted at SOURCE level to
 *      have lost `JSON.stringify(smoke` outright.
 *
 * Rendered with `react-dom/server` (the same technique as
 * `scripts/check-client-seats.mjs`) and a marker translate, so the assertions are
 * about structure and copy KEYS, not about the dictionary's wording.
 */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The browser half value-imports `Input` / `Modal` from
 * `@deepseek-ai/dsh-client-ui-primitives`. That package IS on disk here, but its
 * own runtime deps (`clsx`, …) are devDependencies of the SDK package and are not
 * installed, so importing it under vitest would fail on module LOAD — and the
 * test would then be asserting nothing. This factory mock substitutes the two
 * primitives with plain elements, so the component under test (the connectivity
 * GUI) is exercised for real while the unrelated SDK atom stays out of the way.
 * Nothing else about the SDK is used by these code paths.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
  Modal: (props: { children?: unknown }) => React.createElement('div', null, props.children as never),
}))

import {
  CDP_DEFAULT_PORT,
  CONNECTIVITY_MAX_REASON_LINES,
  CONNECTIVITY_ROW_ORDER,
  LOGIN_REQUIREMENTS,
  SOURCE_LABELS,
} from '../src/contract.js'
import {
  applyPatchLocally,
  buildPatch,
  describeConfigSummary,
  normalizeConfig,
  normalizeProbe,
  normalizeSmoke,
  sameConfig,
  summaryKeysForPatch,
  truncateReason,
} from '../src/client/api.js'
import { ConnectivityRows } from '../src/client/panel.js'
import type { ConnectivityRowView } from '../src/client/api.js'
import type { Translate } from '../src/client/locales.js'
import { readRepoFile } from './helpers.js'

/** Marker translate: every dictionary KEY becomes visible in the markup. */
const mark: Translate = key => `«${key}»`

function renderRows(payload: unknown): string {
  return renderToStaticMarkup(
    React.createElement(ConnectivityRows, {
      t: mark,
      rows: normalizeSmoke(payload),
      copied: null,
      onCopyReason: () => {},
    }),
  )
}

/** The three row source ids, in the order the panel must render them. */
const ROW_ORDER = [...CONNECTIVITY_ROW_ORDER]

describe('normalizeSmoke 恒定三行，顺序取 CONNECTIVITY_ROW_ORDER', () => {
  it('空负载 → 三行，全部未检测', () => {
    for (const payload of [null, undefined, {}, 'nonsense', 42, [], { probes: null }]) {
      const rows = normalizeSmoke(payload)
      expect(rows.map(row => row.source), JSON.stringify(payload)).toEqual(ROW_ORDER)
      expect(rows.map(row => row.status), JSON.stringify(payload)).toEqual([
        'undetected',
        'undetected',
        'undetected',
      ])
      expect(rows.every(row => row.reason === '')).toBe(true)
      expect(rows.every(row => row.statusCode === null && row.latencyMs === null)).toBe(true)
    }
  })

  it('缺字段的记录 → 该行仍是未检测（不是崩溃、不是空卡）', () => {
    const rows = normalizeSmoke({ probes: [{ source: 'gitee' }, { nope: true }, { source: 'nope' }] })
    expect(rows.map(row => row.source)).toEqual(ROW_ORDER)
    expect(rows.every(row => row.status === 'undetected')).toBe(true)
  })

  it('返回顺序被打乱也按契约顺序渲染', () => {
    const rows = normalizeSmoke({
      probes: [
        { source: 'csdn', ok: true, statusCode: 200, latencyMs: 12, transport: 'node', reason: '' },
        { source: 'github', ok: false, statusCode: 401, reason: 'HTTP 401 Requires authentication' },
        { source: 'gitee', ok: true, statusCode: 200, latencyMs: 30, transport: 'dsh-web', reason: '' },
      ],
    })
    expect(rows.map(row => row.source)).toEqual(ROW_ORDER)
    expect(rows.map(row => row.status)).toEqual(['failed', 'ok', 'ok'])
  })

  it('失败行保留状态码、延迟、通道与原因', () => {
    const rows = normalizeSmoke({
      probes: [
        {
          source: 'gitee',
          ok: false,
          statusCode: 404,
          failure: 'not-code',
          latencyMs: 88,
          transport: 'node',
          reason: 'Gitee v5 没有代码搜索端点（HTTP 404）。',
        },
      ],
    })
    const gitee = rows.find(row => row.source === 'gitee')
    expect(gitee).toBeDefined()
    expect(gitee?.status).toBe('failed')
    expect(gitee?.statusCode).toBe(404)
    expect(gitee?.latencyMs).toBe(88)
    expect(gitee?.transport).toBe('node')
    expect(gitee?.reason).toContain('没有代码搜索端点')
  })

  it('原因按 CONNECTIVITY_MAX_REASON_LINES 截断', () => {
    const long = Array.from({ length: CONNECTIVITY_MAX_REASON_LINES + 3 }, (_, index) => `第${index + 1}行`).join('\n')
    const rows = normalizeSmoke({ probes: [{ source: 'csdn', ok: false, reason: long }] })
    const csdn = rows.find(row => row.source === 'csdn')
    expect(csdn?.reason).toContain('第1行')
    expect(csdn?.reason).toContain(`第${CONNECTIVITY_MAX_REASON_LINES}行`)
    expect(csdn?.reason).not.toContain(`第${CONNECTIVITY_MAX_REASON_LINES + 1}行`)
    expect(csdn?.reason).toContain('…')
    // The helper the component uses must obey the same constant.
    expect(truncateReason(long)).toBe(csdn?.reason)
    expect(truncateReason('单行原因')).toBe('单行原因')
  })

  it('capabilities 提供登录要求与实测证据', () => {
    const rows = normalizeSmoke({
      probes: [{ source: 'github', ok: false, statusCode: 401, reason: 'HTTP 401' }],
      capabilities: {
        github: { requiresLogin: true, evidence: '实测：匿名 /search/code 返回 401。' },
        gitee: { requiresLogin: false, evidence: '实测：匿名可读公开文件。' },
      },
    })
    const github = rows.find(row => row.source === 'github')
    const gitee = rows.find(row => row.source === 'gitee')
    expect(github?.requiresLogin).toBe(true)
    expect(github?.evidence).toContain('401')
    expect(gitee?.requiresLogin).toBe(false)
    expect(gitee?.evidence).toContain('公开文件')
  })

  it('/probe 的 operations[] 折叠成一行（不给用户看子操作清单）', () => {
    const rows = normalizeSmoke({
      reports: [
        {
          source: 'github',
          operations: [
            { operation: 'repo-search', reachable: true, statusCode: 200, requiresLogin: false, evidence: '仓库搜索匿名可用。' },
            { operation: 'code-search', reachable: false, statusCode: 401, requiresLogin: true, evidence: '代码搜索需要登录（401）。' },
          ],
        },
      ],
    })
    const github = rows.find(row => row.source === 'github')
    expect(github?.status).toBe('failed')
    expect(github?.requiresLogin).toBe(true)
    expect(github?.reason).toContain('需要登录')
  })

  it('normalizeProbe 不会抹掉本次没测到的行', () => {
    const before = normalizeSmoke({ probes: [{ source: 'github', ok: true, statusCode: 200, latencyMs: 5 }] })
    const after = normalizeProbe({ report: { source: 'csdn', reachable: false, evidence: 'so.csdn.net 521' } }, before)
    expect(after.map(row => row.source)).toEqual(ROW_ORDER)
    expect(after.find(row => row.source === 'github')?.status).toBe('ok')
    expect(after.find(row => row.source === 'csdn')?.status).toBe('failed')
    expect(after.find(row => row.source === 'gitee')?.status).toBe('undetected')
  })
})

describe('渲染出来的是 GUI，不是 JSON 报文', () => {
  const payload = {
    ok: false,
    probes: [
      { source: 'github', label: 'GitHub', ok: true, statusCode: 200, latencyMs: 41, transport: 'node', reason: '' },
      { source: 'gitee', label: 'Gitee', ok: false, statusCode: 404, failure: 'not-code', latencyMs: 90, transport: 'node', reason: 'Gitee v5 没有代码搜索端点（HTTP 404 页面不存在）。' },
      { source: 'csdn', label: 'CSDN', ok: false, statusCode: 521, failure: 'network', latencyMs: 300, transport: 'node', reason: '缺 UA / Referer 时文章页返回 HTTP 521 反爬拦截。' },
    ],
    notes: ['自检只使用公开端点。'],
    access_token: 'ghp_SENTINEL_should_never_render',
  }
  const markup = renderRows(payload)

  it('三个源名各占一行，一共三行', () => {
    for (const source of ROW_ORDER) {
      expect(markup, `必须渲染 ${source} 这一行`).toContain(SOURCE_LABELS[source])
    }
    expect(markup.split('<li').length - 1).toBe(3)
  })

  it('失败行的下一行直接给出 reason 文本', () => {
    const giteeAt = markup.indexOf(SOURCE_LABELS.gitee)
    const reasonAt = markup.indexOf('没有代码搜索端点')
    expect(giteeAt).toBeGreaterThanOrEqual(0)
    expect(reasonAt, '失败原因必须出现在渲染产物里').toBeGreaterThan(giteeAt)
    expect(markup).toContain('«connect.reasonLabel»')
    expect(markup).toContain('«connect.copyReason»')
    // And the successful row must NOT carry a reason block.
    expect(markup.indexOf('反爬拦截')).toBeGreaterThan(markup.indexOf(SOURCE_LABELS.csdn))
  })

  it('成功行给出 HTTP 状态码 · 延迟 · 通道', () => {
    expect(markup).toContain('HTTP 200 · 41ms · node')
  })

  it('状态是颜色 + 文案双通道', () => {
    for (const key of ['connect.status.ok', 'connect.status.failed']) {
      expect(markup).toContain(`«${key}»`)
    }
  })

  it('每行都带该源的登录要求（未实测时用契约常量）', () => {
    expect(markup).toContain(LOGIN_REQUIREMENTS.github)
    expect(markup).toContain(LOGIN_REQUIREMENTS.csdn)
  })

  it('渲染产物里没有任何报文体（没有 <pre>、没有 JSON 字段名、没有哨兵凭据）', () => {
    for (const forbidden of ['<pre', '"probes"', 'access_token', 'ghp_SENTINEL', '»"}', 'notes']) {
      expect(markup, `渲染产物不得包含 ${forbidden}`).not.toContain(forbidden)
    }
    // JSON.stringify's own signature (a quoted key followed by a colon) must not
    // appear: that is what a payload dump looks like in HTML.
    expect(markup).not.toMatch(/&quot;(probes|reason|statusCode)&quot;:/)
  })
})

describe('源码级：客户端不能再对 smoke / probe 返回做 JSON.stringify', () => {
  const panel = readRepoFile('src/client/panel.tsx')

  it('panel.tsx 里没有 JSON.stringify(smoke', () => {
    expect(panel).not.toContain('JSON.stringify(smoke')
  })

  it('panel.tsx 不 stringify 任何 smoke / probe / payload 变量', () => {
    expect(panel).not.toMatch(/JSON\.stringify\(\s*(smoke|probe|payload|rows|report)/)
  })

  it('连通性卡片里没有 <pre> 渲染块', () => {
    const start = panel.indexOf('function ConnectivityField')
    const block = panel.slice(start, panel.indexOf('function DecisionsField', start))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).not.toContain('<pre')
  })
})

// ---------------------------------------------------------------------------
// CSDN 抓取选项 —— 「怎么启用 CDP 抓取？」
//
// The user asked exactly that, and the honest answer used to be "you cannot from
// the UI": `csdn.cdpEnabled` existed in the schema but NO control ever wrote it, so
// the /cookies route answered 403 forever. These tests keep the switch wired to
// the route end to end: view → draft → patch → host key.
// ---------------------------------------------------------------------------

describe('CSDN 抓取选项：界面开关真的接到了配置键上', () => {
  const panelSource = readRepoFile('src/client/panel.tsx')
  const guideSource = readRepoFile('src/client/credential-guide.tsx')
  const css = readRepoFile('src/client/panel.module.css')

  it('normalizeConfig 读 csdn.cdpEnabled / cdpPort / articleFetch，缺字段走默认', () => {
    const explicit = normalizeConfig({
      config: { csdn: { cdpEnabled: true, cdpPort: 9333, articleFetch: false } },
    })
    expect(explicit.csdnCdpEnabled).toBe(true)
    expect(explicit.csdnCdpPort).toBe(9333)
    expect(explicit.csdnArticleFetch).toBe(false)

    // Absent → the schema defaults, NOT "off by accident of parsing".
    const absent = normalizeConfig({ config: {} })
    expect(absent.csdnCdpEnabled).toBe(false)
    expect(absent.csdnCdpPort).toBe(CDP_DEFAULT_PORT)
    expect(absent.csdnArticleFetch).toBe(true)
    // Out-of-range ports are clamped, never trusted.
    expect(normalizeConfig({ config: { csdn: { cdpPort: 70_000 } } }).csdnCdpPort).toBe(65_535)
    expect(normalizeConfig({ config: { csdn: { cdpPort: 0 } } }).csdnCdpPort).toBe(1)
  })

  it('buildPatch 把开关变化变成 host 认识的 csdn 键（只发变化的叶子）', () => {
    const base = normalizeConfig({ config: {} })
    const draft = { ...base, csdnCdpEnabled: true, csdnCdpPort: 9333 }
    expect(buildPatch(base, draft)).toEqual({ csdn: { cdpEnabled: true, cdpPort: 9333 } })
    // No change → no key at all (so a save cannot silently reset the other leaf).
    expect(buildPatch(base, base)).toEqual({})
    expect(sameConfig(base, draft)).toBe(false)
    // The local mirror applies it too, so the panel updates before the read-back.
    const local = applyPatchLocally(base, { csdn: { cdpEnabled: true } })
    expect(local.csdnCdpEnabled).toBe(true)
    expect(local.csdnArticleFetch).toBe(base.csdnArticleFetch)
  })

  it('开关出现在「已保存的配置」摘要里，保存后能看到自己开了它', () => {
    expect(summaryKeysForPatch({ csdn: { cdpEnabled: true } })).toContain('csdnCdp')
    const rows = describeConfigSummary({ ...normalizeConfig({ config: {} }), csdnCdpEnabled: true }, mark)
    const row = rows.find(entry => entry.key === 'csdnCdp')
    expect(row).toBeDefined()
    expect(row?.value).toContain('«tristate.on»')
    expect(row?.value).toContain(String(CDP_DEFAULT_PORT))
  })

  it('面板真的渲染了这个开关（不是只有 schema 里有）', () => {
    for (const needle of ['csdnCdpEnabled', 'csdnArticleFetch', 'csdnCdpPort', 'csdn.cdp.label', 'csdn.cdp.howTo']) {
      expect(panelSource, `面板必须包含 ${needle}`).toContain(needle)
    }
    // 默认关闭时给的是「怎么开」的说明，不是静默。
    expect(panelSource).toContain('csdn.cdp.off')
    // 安全代价必须写在开关旁边。
    expect(panelSource).toContain('csdn.cdp.warn')
    // 复用既有样式类，不引入没人写规则的孤儿类。
    for (const name of ['checkRow', 'optionBody', 'optionLabel', 'optionRequirement', 'warn', 'help']) {
      expect(css, `.${name} 必须有真实规则`).toMatch(new RegExp(`\\.${name}\\s*\\{`))
    }
  })

  it('向导的 CDP 方式仍然要求二次同意（开关打开不等于自动读取）', () => {
    expect(guideSource).toMatch(/guide\.cdpConsent/)
    expect(guideSource).toMatch(/disabled=\{busy !== null \|\| !consent\}/)
  })
})
