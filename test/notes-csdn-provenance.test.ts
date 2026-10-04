/**
 * 备注② — CSDN v3 搜索接口的来源标注（task-5 §A.2；task-3 §C 复核）。
 *
 * The endpoint `https://so.csdn.net/api/v3/search` is NOT a documented public
 * API. The user requires the provenance to travel with it everywhere, so this
 * file asserts all four surfaces:
 *
 *   1. `CSDN_API_NOTE` contains the three required facts — 非官方 / the probe
 *      date `CSDN_API_PROBED_AT` / 失效;
 *   2. the header comment of `src/sources/csdn.ts` repeats the note VERBATIM
 *      (source-text assertion — that is the only way to prove a comment exists);
 *   3. `README.md` states the same three facts in its 接口稳定性 section;
 *   4. the adapter returns the note inside `reason` whenever the endpoint looks
 *      wrong (`empty` / `parse-failed` / `not-code`), instead of throwing, and
 *      the browser panel renders it verbatim.
 *
 * task-3 adds a second, equally single-sourced pair of sentences: the login
 * requirement (`CSDN_LOGIN_REQUIREMENT`) and the robots position
 * (`CSDN_ROBOTS_DISCLOSURE`). They must appear in the adapter SOURCE by
 * reference and on the source path the agent actually reads (the `reason`).
 *
 * Zero network: the adapter is driven by a recording fake `Transport`.
 */

import { describe, expect, it } from 'vitest'

import {
  CSDN_API_NOTE,
  CSDN_API_PROBED_AT,
  CSDN_LOGIN_REQUIREMENT,
  CSDN_ROBOTS_DISCLOSURE,
  CSDN_SEARCH_BASE,
  LOCAL_PROXY_SCOPE_NOTE,
} from '../src/contract.js'
import {
  CSDN_BROWSER_USER_AGENT,
  CSDN_PROVENANCE,
  CSDN_SEARCH_REFERER,
  CSDN_SOURCE_NOTE,
  buildCsdnSearchUrl,
  csdnArticleHeaders,
  csdnDeepRead,
  csdnRequestHeaders,
  searchCsdn,
} from '../src/sources/csdn.js'
import { jsonAnswer, readRepoFile, recordingTransport } from './helpers.js'

describe('备注② — CSDN_API_NOTE 的三要素', () => {
  it('实测日期常量就是 2026-10-03', () => {
    expect(CSDN_API_PROBED_AT).toBe('2026-10-03')
  })

  it('note 同时含「非官方」「实测日期 2026-10-03」「失效」，且故意不含 URL', () => {
    expect(CSDN_API_NOTE).toContain('非官方')
    expect(CSDN_API_NOTE).toContain(CSDN_API_PROBED_AT)
    expect(CSDN_API_NOTE).toContain('失效')

    // 职责分离：note 是渲染给用户看的来源标注（会出现在每一条 reason 里），
    // 端点 URL 由 CSDN_SEARCH_BASE 单独承担。把 URL 塞进 note 只会让 reason 变长。
    expect(CSDN_SEARCH_BASE).toBe('https://so.csdn.net/api/v3/search')
    expect(CSDN_API_NOTE).not.toContain('http')
  })

  it('CSDN_PROVENANCE 与别名导出指向同一份 note（不是复制出来的第二份）', () => {
    expect(CSDN_PROVENANCE.note).toBe(CSDN_API_NOTE)
    expect(CSDN_SOURCE_NOTE).toBe(CSDN_API_NOTE)
    expect(CSDN_PROVENANCE.probedAt).toBe(CSDN_API_PROBED_AT)
    expect(CSDN_PROVENANCE.official).toBe(false)
    expect(CSDN_PROVENANCE.apiBase).toBe(CSDN_SEARCH_BASE)
  })

  it('src/sources/csdn.ts 的文件头逐字写入了该 note（源码文本断言）', () => {
    const header = readRepoFile('src/sources/csdn.ts')
    expect(header).toContain(CSDN_API_NOTE)
  })

  it('README.md 的「接口稳定性」小节含同样三要素', () => {
    const readme = readRepoFile('README.md')
    expect(readme).toContain('非官方')
    expect(readme).toContain(CSDN_API_PROBED_AT)
    expect(readme).toContain('失效')
    // 三要素必须出现在同一条 note 里，而不是散落成三个无关的词。
    expect(readme).toContain(CSDN_API_NOTE)
  })

  it('docs/DESIGN.md 也记录了非官方 / 实测日期 / 可能失效', () => {
    const design = readRepoFile('docs/DESIGN.md')
    expect(design).toContain('非官方')
    expect(design).toContain(CSDN_API_PROBED_AT)
    expect(design).toContain('失效')
  })

  it('浏览器半边 CSDN 区域原样渲染 CSDN_API_NOTE（源码文本断言）', () => {
    const panel = readRepoFile('src/client/panel.tsx')
    // 渲染成表达式，而不是写在注释里。
    expect(panel).toMatch(/\{[^}]*CSDN_API_NOTE[^}]*\}/)
  })
})

describe('备注② — 端点形态可疑时把来源标注交给用户', () => {
  it('返回值不是合法 JSON → parse-failed，reason 带 note，尝试记录带真端点', async () => {
    const { transport, calls } = recordingTransport(() => jsonAnswer('not json at all'))
    const outcome = await searchCsdn('vue 响应式', { transport })

    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('parse-failed')
    expect(outcome.reason).toContain(CSDN_API_NOTE)
    expect(calls).toHaveLength(1)
    // note 与端点各自承担职责：reason 里是 note，尝试记录里是真实端点。
    expect(outcome.attempts?.[0]?.url.startsWith(CSDN_SEARCH_BASE)).toBe(true)
  })

  it('返回结构里没有 result_vos[] → parse-failed，reason 带 note（不编造字段）', async () => {
    const { transport } = recordingTransport(() => jsonAnswer({ data: { list: [] } }))
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.failure).toBe('parse-failed')
    expect(outcome.reason).toContain('result_vos')
    expect(outcome.reason).toContain(CSDN_API_NOTE)
    expect(outcome.results).toEqual([])
  })

  it('0 条结果 → empty，reason 带 note', async () => {
    const { transport } = recordingTransport(() => jsonAnswer({ result_vos: [] }))
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.failure).toBe('empty')
    expect(outcome.reason).toContain(CSDN_API_NOTE)
  })

  it('命中但抽不到代码块 → not-code，reason 带 note', async () => {
    const { transport } = recordingTransport(() =>
      jsonAnswer({
        result_vos: [
          {
            title: '只有正文',
            body: '这里没有任何代码块，全是散文说明。',
            url: 'https://blog.csdn.net/u/article/details/1',
            originalType: '原创',
          },
        ],
      }),
    )
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.failure).toBe('not-code')
    expect(outcome.reason).toContain(CSDN_API_NOTE)
    expect(outcome.results).toEqual([])
  })

  it('深读明确拒绝（CSDN 只作浅搜索补充），并带上来源标注', async () => {
    const outcome = await csdnDeepRead('https://blog.csdn.net/u/article/details/1', ['readme'], {
      transport: () => Promise.reject(new Error('深读不应发起任何请求')),
    })

    expect(outcome.failure).toBe('not-code')
    expect(outcome.notes).toEqual([])
    expect(outcome.reason).toContain(CSDN_API_NOTE)
  })
})

describe('备注② — 只发实测确认过的参数与真端点', () => {
  it('搜索 URL 指向 CSDN_SEARCH_BASE，只带 q/t/p/s/platform', () => {
    const url = buildCsdnSearchUrl('vue 响应式')
    expect(url.startsWith(CSDN_SEARCH_BASE)).toBe(true)

    const params = new URL(url).searchParams
    expect(params.get('q')).toBe('vue 响应式')
    expect([...params.keys()].sort()).toEqual(['p', 'platform', 'q', 's', 't'])
  })

  it('CSDN 登录态走 cookie 头（不是 Bearer），且没有 token 时不带头', () => {
    expect(csdnRequestHeaders({ transport: async () => jsonAnswer({}) })).not.toHaveProperty('cookie')
    expect(csdnRequestHeaders({ transport: async () => jsonAnswer({}), token: 'csdn-session' })).toMatchObject({
      cookie: 'csdn-session',
    })
  })

  it('备注①：transport 附带的说明原样进入 reason，不被吞掉', async () => {
    const { transport } = recordingTransport(() =>
      jsonAnswer({ result_vos: [] }, { notes: [LOCAL_PROXY_SCOPE_NOTE] }),
    )
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.reason).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })
})

// ---------------------------------------------------------------------------
// CSDN 登录要求 / robots 立场（task-3 §C）.
//
// 「查代码需不需要登录」和「站点允不允许抓」是两个用户明确问过的问题。两条答案
// 都由 contract.ts 提供，这里证明它们既写在适配器源码里（按引用），也确实出现在
// agent 会读到的 source path（失败/补齐时的 reason）上。
// ---------------------------------------------------------------------------

describe('CSDN — 登录要求与 robots 立场按引用到达 source path', () => {
  it('csdn.ts 引用两个常量，而不是另写一套文案（源码文本断言）', () => {
    const source = readRepoFile('src/sources/csdn.ts')
    expect(source).toContain('CSDN_LOGIN_REQUIREMENT')
    expect(source).toContain('CSDN_ROBOTS_DISCLOSURE')
  })

  it('0 条结果（empty）：reason 同时回答「要不要登录」与 robots 立场', async () => {
    const { transport } = recordingTransport(() => jsonAnswer({ result_vos: [] }))
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.failure).toBe('empty')
    expect(outcome.reason).toContain(CSDN_API_NOTE)
    expect(outcome.reason).toContain(CSDN_LOGIN_REQUIREMENT)
    expect(outcome.reason).toContain(CSDN_ROBOTS_DISCLOSURE)
  })

  it('命中但抽不到代码（not-code）：reason 同样带上两句', async () => {
    const { transport } = recordingTransport(() =>
      jsonAnswer({
        result_vos: [
          {
            title: '只有正文',
            body: '这里没有任何代码块，全是散文说明。',
            url: 'https://blog.csdn.net/u/article/details/1',
          },
        ],
      }),
    )
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.failure).toBe('not-code')
    expect(outcome.reason).toContain(CSDN_LOGIN_REQUIREMENT)
    expect(outcome.reason).toContain(CSDN_ROBOTS_DISCLOSURE)
  })

  it('每一次请求都带浏览器 UA + Referer（实测缺它们会被 521 拦截）', () => {
    const search = csdnRequestHeaders({ transport: async () => jsonAnswer({}) })
    expect(search['user-agent']).toBe(CSDN_BROWSER_USER_AGENT)
    expect(search['referer']).toBe(CSDN_SEARCH_REFERER)
    expect(CSDN_BROWSER_USER_AGENT).toContain('Mozilla/5.0')
    expect(CSDN_BROWSER_USER_AGENT).toContain('Chrome/126')

    const article = csdnArticleHeaders({ transport: async () => jsonAnswer({}), token: 'csdn-session' })
    expect(article['user-agent']).toBe(CSDN_BROWSER_USER_AGENT)
    expect(article['referer']).toBe(CSDN_SEARCH_REFERER)
    expect(article['cookie']).toBe('csdn-session')
    expect(article['accept']).toContain('text/html')
  })

  it('文章页补齐的那一行随行披露 robots 立场（单次请求，不批量遍历）', async () => {
    const search = jsonAnswer({
      result_vos: [
        {
          title: '散文标题',
          body: '搜索结果里没有代码。',
          url: 'https://blog.csdn.net/u/article/details/9',
        },
      ],
    })
    const article = jsonAnswer('<pre class="language-ts">const a = 1</pre>')
    const { transport } = recordingTransport((request) =>
      request.url.includes('blog.csdn.net') ? article : search,
    )
    const outcome = await searchCsdn('vue', { transport, articleFetch: true, maxDepth: 1 })

    expect(outcome.results[0]?.code).toContain('const a = 1')
    expect(outcome.results[0]?.reason).toContain(CSDN_ROBOTS_DISCLOSURE)
  })
})
