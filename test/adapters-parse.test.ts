/**
 * 三个源适配器的解析与端点（task-5 §E，后半）。
 *
 * All three adapters take an injected `Transport` and never fetch anything
 * themselves, so every path below is driven by a recording fake — zero network:
 *
 *   • **CSDN** — `result_vos[].title` carries `<em>` markup that must be stripped,
 *     the code block is extracted from `body`, a non-原创 item is down-weighted
 *     with 转载 named in the reason, and the endpoint is the live-probed one;
 *   • **GitHub** — the API base and the raw-file base are two INDEPENDENT paths
 *     (the probe found one reachable and the other not), repository fields map
 *     onto the unified envelope, `/search/code` refuses anonymous callers without
 *     issuing a request, and mirror strategies never receive a token;
 *   • **Gitee** — only the two real v5 endpoints are used; the endpoint that
 *     answered 404 on this host appears in NO line of code; an anonymous empty
 *     answer is reported as `empty` instead of being padded with invented rows.
 */

import { describe, expect, it } from 'vitest'

import {
  CSDN_SEARCH_BASE,
  GITHUB_API_BASE,
  GITHUB_RAW_ORIGIN,
  GITEE_API_BASE,
  GITEE_SEARCH_CODE,
  GITEE_SEARCH_REPOSITORIES,
} from '../src/contract.js'
import {
  buildCsdnSearchUrl,
  csdnRowsOf,
  extractCodeBlocks,
  parseCsdnTime,
  searchCsdn,
} from '../src/sources/csdn.js'
import {
  buildGiteeApiUrl,
  giteeHeaders,
  giteeRowsOf,
  parseGiteeRepo,
  parseGiteeSearchHtml,
  searchGiteeRepositories,
} from '../src/sources/gitee.js'
import {
  buildGithubApiUrl,
  buildGithubRawUrl,
  mapGithubRepo,
  parseGithubRepo,
  rawBasesFor,
  searchGithubCode,
  searchGithubRepos,
} from '../src/sources/github.js'
import { codeLinesContaining, isCommentLine, jsonAnswer, readRepoFile, recordingTransport } from './helpers.js'

// ---------------------------------------------------------------------------
// CSDN.
// ---------------------------------------------------------------------------

describe('CSDN — 解析 result_vos[]', () => {
  const payload = {
    result_vos: [
      {
        title: 'Vue3 <em>响应式</em> 原理详解',
        body: '前言\n```ts\nconst count = ref(0)\n```\n后记',
        description: '把响应式讲清楚',
        url: 'https://blog.csdn.net/someone/article/details/100',
        originalType: '原创',
        create_time: '2026-09-01 10:00:00',
        author: 'someone',
        view: 1234,
      },
    ],
  }

  it('title 里的 <em> 被剥离，代码块从 body 抽出，字段映射正确', async () => {
    const { transport, calls } = recordingTransport(() => jsonAnswer(payload))
    const outcome = await searchCsdn('vue 响应式', {
      transport,
      authenticated: true,
      token: 'csdn-session-cookie',
      maxItems: 5,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.results).toHaveLength(1)
    const row = outcome.results[0]

    expect(row?.title).toBe('Vue3 响应式 原理详解')
    expect(row?.title).not.toContain('<em>')
    expect(row?.title).not.toContain('</em>')
    expect(row?.code).toContain('const count = ref(0)')
    expect(row?.language).toBe('ts')
    expect(row?.url).toBe('https://blog.csdn.net/someone/article/details/100')
    expect(row?.is_verbatim_copy).toBe(false)
    expect(row?.stars).toBeNull()
    expect(row?.updatedAt).toBe('2026-09-01T02:00:00.000Z')
    expect(row?.learned_summary.length).toBeGreaterThan(0)
    expect(row?.reason).toContain('someone')

    // 请求本身：真端点、cookie 登录态、绝不带 authorization。
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.startsWith(CSDN_SEARCH_BASE)).toBe(true)
    expect(calls[0]?.headers).toMatchObject({ cookie: 'csdn-session-cookie' })
    expect(calls[0]?.headers).not.toHaveProperty('authorization')
  })

  it('CSDN 权重最低：即使已登录 + 原创 + 解析完整也只能到 medium', async () => {
    const { transport } = recordingTransport(() => jsonAnswer(payload))
    const outcome = await searchCsdn('vue', { transport, authenticated: true })

    expect(outcome.results[0]?.confidence).toBe('medium')
  })

  it('转载降权：originalType 非「原创」时 reason 里注明疑似转载', async () => {
    const reposted = {
      result_vos: [{ ...payload.result_vos[0], originalType: '转载' }],
    }
    const { transport } = recordingTransport(() => jsonAnswer(reposted))
    const outcome = await searchCsdn('vue', { transport, authenticated: true })

    const row = outcome.results[0]
    expect(row?.reason).toContain('疑似转载')
    expect(row?.confidence).toBe('low')
  })

  it('缺 url 的条目被跳过，不伪造链接', async () => {
    const { transport } = recordingTransport(() =>
      jsonAnswer({ result_vos: [{ title: '没有 url', body: '```ts\nconst a = 1\n```' }] }),
    )
    const outcome = await searchCsdn('vue', { transport })

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toEqual([])
    expect(outcome.reason).toContain('缺少 url')
  })

  it('maxItems 生效并标记 truncated', async () => {
    const many = {
      result_vos: Array.from({ length: 5 }, (_, index) => ({
        ...payload.result_vos[0],
        title: `第 ${index} 篇`,
        url: `https://blog.csdn.net/someone/article/details/${index}`,
      })),
    }
    const { transport } = recordingTransport(() => jsonAnswer(many))
    const outcome = await searchCsdn('vue', { transport, maxItems: 2 })

    expect(outcome.results).toHaveLength(2)
    expect(outcome.truncated).toBe(true)
  })

  it('csdnRowsOf 接受 result_vos[] 或裸数组，其余给 null', () => {
    expect(csdnRowsOf({ result_vos: [{ a: 1 }] })).toHaveLength(1)
    expect(csdnRowsOf([{ a: 1 }, 'x'])).toHaveLength(1)
    expect(csdnRowsOf({ data: [] })).toBeNull()
    expect(csdnRowsOf(null)).toBeNull()
  })

  it('parseCsdnTime 认识 epoch / 北京时间字符串，未知输入给 null（不编造日期）', () => {
    expect(parseCsdnTime(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString())
    expect(parseCsdnTime('1700000000')).toBe(new Date(1_700_000_000_000).toISOString())
    expect(parseCsdnTime('2026-09-01 10:00:00')).toBe('2026-09-01T02:00:00.000Z')
    expect(parseCsdnTime('2026-09-01')).toBe('2026-08-31T16:00:00.000Z')
    expect(parseCsdnTime('')).toBeNull()
    expect(parseCsdnTime('昨天')).toBeNull()
    expect(parseCsdnTime(undefined)).toBeNull()
  })

  it('extractCodeBlocks：``` 围栏优先，带语言标签', () => {
    const extracted = extractCodeBlocks('前言\n```ts\nconst a = 1\nconst b = 2\n```\n后记')
    expect(extracted.blocks).toBe(1)
    expect(extracted.language).toBe('ts')
    expect(extracted.code).toBe('const a = 1\nconst b = 2')
  })

  it('extractCodeBlocks：<pre> 区块（含 language 属性，内联标签被清掉）', () => {
    const extracted = extractCodeBlocks('<pre class="language-js">const <span>x</span> = 1</pre>')
    expect(extracted.blocks).toBe(1)
    expect(extracted.language).toBe('js')
    expect(extracted.code).toBe('const x = 1')
    expect(extracted.code).not.toContain('<span>')
  })

  it('extractCodeBlocks：没有围栏时退回缩进块；没有代码时给出空结果', () => {
    const indented = extractCodeBlocks('说明文字\n\n    const value = compute()\n    return value\n')
    expect(indented.blocks).toBe(1)
    expect(indented.code).toBe('const value = compute()\nreturn value')

    const nothing = extractCodeBlocks('这是一段纯散文，没有任何代码。')
    expect(nothing).toEqual({ code: '', language: '', blocks: 0 })
    expect(extractCodeBlocks('')).toEqual({ code: '', language: '', blocks: 0 })
  })

  it('extractCodeBlocks 遵守块数上限', () => {
    const three = '```a\nconst a = 1\n```\n```b\nconst b = 2\n```\n```c\nconst c = 3\n```'
    expect(extractCodeBlocks(three, 2).blocks).toBe(2)
    expect(extractCodeBlocks(three, 2).language).toBe('a')
  })

  it('buildCsdnSearchUrl 只带实测确认过的参数', () => {
    const url = buildCsdnSearchUrl('vue', { apiBase: `${CSDN_SEARCH_BASE}/` })
    expect(url.startsWith(CSDN_SEARCH_BASE)).toBe(true)
    expect(new URL(url).searchParams.get('platform')).toBe('pc')
  })
})

// ---------------------------------------------------------------------------
// GitHub.
// ---------------------------------------------------------------------------

describe('GitHub — API 基址与 raw 基址是两条独立路径', () => {
  it('API URL 用的是 API 基址（可被镜像前缀覆盖），与 raw 基址无关', () => {
    expect(buildGithubApiUrl('/search/repositories', { params: { q: 'vue', per_page: 5 } })).toBe(
      `${GITHUB_API_BASE}/search/repositories?q=vue&per_page=5`,
    )
    expect(
      buildGithubApiUrl('/search/repositories', {
        apiBase: `${GITHUB_API_BASE}/`,
        params: { q: 'vue' },
      }),
    ).toBe(`${GITHUB_API_BASE}/search/repositories?q=vue`)
  })

  it('raw URL 按三种基址形态展开（前缀 / 已含 origin / {url} 模板）', () => {
    expect(buildGithubRawUrl('https://ghproxy.net', 'README.md')).toBe(
      `https://ghproxy.net/${GITHUB_RAW_ORIGIN}/README.md`,
    )
    expect(buildGithubRawUrl(`${GITHUB_RAW_ORIGIN}/`, 'README.md')).toBe(`${GITHUB_RAW_ORIGIN}/README.md`)
    expect(buildGithubRawUrl('https://cdn.example/{url}', 'src/index.ts')).toBe(
      `https://cdn.example/${GITHUB_RAW_ORIGIN}/src/index.ts`,
    )
  })

  it('默认没有任何 raw 基址：空列表 = 该方式不可用，不兜底', () => {
    const bare = rawBasesFor({ transport: async () => jsonAnswer({}) })
    expect(bare.bases).toEqual([])
    expect(bare.reason).toContain('rawMirrorBases')

    const configured = rawBasesFor({ transport: async () => jsonAnswer({}), rawMirrors: ['https://ghproxy.net', '  '] })
    expect(configured.bases).toEqual(['https://ghproxy.net'])

    // 只配了 API 基址不会凭空造出 raw 基址 —— 这正是「两条独立路径」的含义。
    const apiOnly = rawBasesFor({
      transport: async () => jsonAnswer({}),
      apiBase: 'https://ghproxy.net/https://api.github.com',
    })
    expect(apiOnly.bases).toEqual([])
  })

  it('本地代理 / Watt / hosts 三种访问方式下才尝试官方 raw origin', () => {
    for (const access of ['local-proxy', 'watt', 'hosts'] as const) {
      const plan = rawBasesFor({ transport: async () => jsonAnswer({}), access })
      expect(plan.bases, access).toEqual([GITHUB_RAW_ORIGIN])
    }
    // direct / token 不在此列：实测该域名在这两条路径上不可直连。
    for (const access of ['direct', 'token'] as const) {
      expect(rawBasesFor({ transport: async () => jsonAnswer({}), access }).bases, access).toEqual([])
    }
  })

  it('parseGithubRepo 从各种 GitHub URL 里取出 owner/repo/ref', () => {
    expect(parseGithubRepo('https://github.com/vuejs/core')).toMatchObject({ owner: 'vuejs', repo: 'core' })
    expect(parseGithubRepo('https://github.com/vuejs/core.git')).toMatchObject({ owner: 'vuejs', repo: 'core' })
    expect(parseGithubRepo('https://github.com/vuejs/core/blob/main/src/index.ts')).toMatchObject({
      owner: 'vuejs',
      repo: 'core',
      ref: 'main',
    })
    expect(parseGithubRepo('https://gitlab.com/a/b')).toBeNull()
  })
})

describe('GitHub — 仓库搜索结果映射', () => {
  it('只用实测存在的字段，不伪造', () => {
    const row = mapGithubRepo(
      {
        full_name: 'vuejs/core',
        html_url: 'https://github.com/vuejs/core',
        description: 'Vue.js',
        language: 'TypeScript',
        stargazers_count: 12345,
        updated_at: '2026-05-01T00:00:00Z',
        default_branch: 'main',
      },
      { authenticated: true, notes: [] },
    )

    expect(row).not.toBeNull()
    expect(row?.source).toBe('github')
    expect(row?.title).toBe('vuejs/core')
    expect(row?.url).toBe('https://github.com/vuejs/core')
    expect(row?.language).toBe('TypeScript')
    expect(row?.stars).toBe(12345)
    expect(row?.updatedAt).toBe('2026-05-01T00:00:00Z')
    expect(row?.code).toBe('')
    expect(row?.codeTruncated).toBe(false)
    expect(row?.is_verbatim_copy).toBe(false)
    expect(row?.confidence).toBe('high')
    expect(row?.learned_summary.length).toBeGreaterThan(0)
  })

  it('缺 html_url 的条目直接判为不可用，而不是编一个地址', () => {
    expect(mapGithubRepo({ full_name: 'a/b' }, { authenticated: false, notes: [] })).toBeNull()
  })

  it('searchGithubRepos 走 API 基址，跳过不可用条目', async () => {
    const { transport, calls } = recordingTransport(() =>
      jsonAnswer({
        items: [
          {
            full_name: 'vuejs/core',
            html_url: 'https://github.com/vuejs/core',
            stargazers_count: 1,
          },
          { full_name: 'no-url/repo' },
        ],
      }),
    )
    const outcome = await searchGithubRepos('vue', { transport, maxItems: 10 })

    expect(outcome.ok).toBe(true)
    expect(outcome.results).toHaveLength(1)
    expect(calls[0]?.url.startsWith(GITHUB_API_BASE)).toBe(true)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('q')).toBe('vue')
  })

  it('items[] 缺失 → parse-failed（结构变了就说结构变了）', async () => {
    const { transport } = recordingTransport(() => jsonAnswer({ total_count: 0 }))
    const outcome = await searchGithubRepos('vue', { transport })

    expect(outcome.failure).toBe('parse-failed')
    expect(outcome.reason).toContain('items')
  })

  it('0 条结果 → empty，不补数据', async () => {
    const { transport } = recordingTransport(() => jsonAnswer({ items: [] }))
    const outcome = await searchGithubRepos('vue', { transport })

    expect(outcome.failure).toBe('empty')
    expect(outcome.results).toEqual([])
  })
})

describe('GitHub — token 策略', () => {
  it('镜像访问方式下，适配器交给 transport 的 token 是 undefined', async () => {
    const { transport, calls } = recordingTransport(() => jsonAnswer({ items: [] }))
    await searchGithubRepos('vue', { transport, access: 'ghproxy', token: 'ghp_secret' })

    expect(calls[0]?.token).toBeUndefined()
    expect(calls[0]?.headers).not.toHaveProperty('authorization')
  })

  it('官方直连时 token 照常下传（请求头由统一出口添加）', async () => {
    const { transport, calls } = recordingTransport(() => jsonAnswer({ items: [] }))
    await searchGithubRepos('vue', { transport, access: 'direct', token: 'ghp_secret' })

    expect(calls[0]?.token).toBe('ghp_secret')
  })

  it('/search/code 不接受匿名调用：归类 auth-required 且一次请求都不发', async () => {
    const { transport, calls } = recordingTransport(() => jsonAnswer({ items: [] }))
    const outcome = await searchGithubCode('vue', { transport })

    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('auth-required')
    expect(outcome.results).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('/search/code 带 token 时才发请求', async () => {
    const { transport, calls } = recordingTransport(() =>
      jsonAnswer({ items: [{ html_url: 'https://github.com/a/b/blob/main/x.ts', path: 'x.ts' }] }),
    )
    const outcome = await searchGithubCode('vue', { transport, token: 'ghp_secret', access: 'direct' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/search/code')
    expect(outcome.ok).toBe(true)
    expect(outcome.results[0]?.url).toBe('https://github.com/a/b/blob/main/x.ts')
  })
})

// ---------------------------------------------------------------------------
// Gitee.
// ---------------------------------------------------------------------------

describe('Gitee — 只用真实存在的端点', () => {
  it('src/ 的代码里不存在 gitee.com/api/v5/projects（实测 404）', () => {
    expect(codeLinesContaining('/api/v5/projects')).toEqual([])

    // 非空性：gitee.ts 的注释确实写了这个端点，所以上面的扫描是「按注释豁免」，
    // 而不是「根本没搜到」。
    const source = readRepoFile('src/sources/gitee.ts')
    expect(source).toContain('gitee.com/api/v5/projects')
    expect(
      source.split(/\r?\n/).some((line) => line.includes('/api/v5/projects') && isCommentLine(line)),
    ).toBe(true)
  })

  it('URL 构造只用契约里的两个 v5 端点', () => {
    const repos = buildGiteeApiUrl(GITEE_SEARCH_REPOSITORIES, { params: { q: 'vue', per_page: 5 } })
    expect(repos).toBe(`${GITEE_API_BASE}/search/repositories?q=vue&per_page=5`)
    expect(repos).not.toContain('/projects')

    const code = buildGiteeApiUrl(GITEE_SEARCH_CODE, { params: { q: 'vue' }, token: 'gitee-tok', tokenInQuery: true })
    expect(code.startsWith(`${GITEE_API_BASE}${GITEE_SEARCH_CODE}`)).toBe(true)
    expect(new URL(code).searchParams.get('access_token')).toBe('gitee-tok')
  })

  it('token 走 Bearer 头；镜像访问方式下不带凭据', () => {
    expect(giteeHeaders({ transport: async () => jsonAnswer({}), token: 'gitee-tok' })).toMatchObject({
      authorization: 'Bearer gitee-tok',
    })
    expect(
      giteeHeaders({ transport: async () => jsonAnswer({}), token: 'gitee-tok', access: 'third-party-mirror' }),
    ).not.toHaveProperty('authorization')
  })

  it('匿名返回空数组 → empty，绝不编造结果', async () => {
    const { transport, calls } = recordingTransport(() => jsonAnswer([]))
    const outcome = await searchGiteeRepositories('vue', { transport })

    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('empty')
    expect(outcome.results).toEqual([])
    expect(outcome.reason).toContain('0 条结果')
    expect(calls[0]?.url).toContain(GITEE_SEARCH_REPOSITORIES)
  })

  it('命中但缺 html_url 时也判 empty，并说明跳过了几条', async () => {
    const { transport } = recordingTransport(() => jsonAnswer([{ full_name: 'a/b' }]))
    const outcome = await searchGiteeRepositories('vue', { transport })

    expect(outcome.failure).toBe('empty')
    expect(outcome.results).toEqual([])
    expect(outcome.reason).toContain('html_url')
  })

  it('行数据可以是裸数组，也可以是 items[] 容器', () => {
    expect(giteeRowsOf([{ a: 1 }])).toHaveLength(1)
    expect(giteeRowsOf({ items: [{ a: 1 }, { b: 2 }] })).toHaveLength(2)
    expect(giteeRowsOf({ data: [] })).toBeNull()
  })

  it('HTML 兜底只抓仓库链接，跳过保留路径', () => {
    const html =
      '<a href="/vuejs/vue">Vue</a>' +
      '<a href="/explore/trending">Trending</a>' +
      '<a href="https://gitee.com/mindspore/mindspore">MindSpore</a>'

    const hits = parseGiteeSearchHtml(html)
    expect(hits.map((hit) => hit.url)).toEqual(['https://gitee.com/vuejs/vue', 'https://gitee.com/mindspore/mindspore'])
    expect(hits[0]?.title).toBe('Vue')
    expect(parseGiteeSearchHtml('<p>没有链接</p>')).toEqual([])
  })

  it('parseGiteeRepo 取出 owner/repo，非 Gitee 地址给 null', () => {
    expect(parseGiteeRepo('https://gitee.com/vuejs/vue')).toEqual({ owner: 'vuejs', repo: 'vue' })
    expect(parseGiteeRepo('https://gitee.com/vuejs/vue.git')).toEqual({ owner: 'vuejs', repo: 'vue' })
    expect(parseGiteeRepo('https://github.com/vuejs/core')).toBeNull()
  })
})
