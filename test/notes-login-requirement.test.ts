/**
 * 登录要求与连通性 — 实测事实的单一来源，以及它必须到达的每一个面。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The user asked three separate questions that all hinge on ONE fact base:
 *
 *   • "connect GitHub/Gitee/CSDN through a browser login" — which is only
 *     possible for the sources whose endpoints are reachable and whose auth
 *     model allows it;
 *   • "check CSDN's connectivity" — the answer is three different facts
 *     (searchable anonymously, code only in the article page, 521 without
 *     UA/Referer);
 *   • "if querying code needs a login, say so clearly" — a sentence, but it has
 *     to be the SAME sentence in the panel, in the tool's failure reason, in the
 *     README and in the design doc, or the four surfaces will disagree.
 *
 * So the facts live in `src/contract.ts` as constants and this file proves:
 *   1. each constant still carries the three required ingredients — the
 *      consequence, the observed evidence, and the probe date;
 *   2. the constants reach every surface that has to state them (README,
 *      docs/DESIGN.md, the browser panel, the three adapters) *by reference*,
 *      not by a hand-copied second sentence;
 *   3. the login-method matrix and its hand-held guides are complete enough for
 *      the wizard to render — every source has at least one method, and every
 *      method has steps with at least one actionable step.
 *
 * If a fact is re-probed, change the constant and `LOGIN_REQUIREMENT_PROBED_AT`
 * in `src/contract.ts`; these tests then check the new value everywhere.
 */

import { describe, expect, it } from 'vitest'

import {
  CSDN_LOGIN_REQUIREMENT,
  CSDN_ROBOTS_DISCLOSURE,
  GITEE_CODE_SEARCH_SUPPORTED,
  GITHUB_LOGIN_REQUIREMENT,
  GITEE_LOGIN_REQUIREMENT,
  LOGIN_GUIDES,
  LOGIN_METHODS,
  LOGIN_METHOD_FAMILIES,
  LOGIN_METHOD_FAMILY,
  LOGIN_METHOD_KIND,
  LOGIN_REQUIREMENTS,
  LOGIN_REQUIREMENT_PROBED_AT,
  LOGIN_URLS,
  SOURCES,
  SOURCE_LOGIN_METHODS,
  loginGuideFor,
  loginMethodsOf,
} from '../src/contract.js'
import { readRepoFile } from './helpers.js'

/** The date form the constants must carry, so a stale note is detectable. */
const PROBE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

describe('登录要求 — 三条实测事实都带「结论 + 证据 + 日期」', () => {
  it('探针日期是可解析的日期，且确实出现在每条要求里', () => {
    expect(LOGIN_REQUIREMENT_PROBED_AT).toMatch(PROBE_DATE_PATTERN)
    expect(Number.isNaN(Date.parse(LOGIN_REQUIREMENT_PROBED_AT))).toBe(false)

    for (const text of [GITHUB_LOGIN_REQUIREMENT, GITEE_LOGIN_REQUIREMENT, CSDN_LOGIN_REQUIREMENT]) {
      expect(text).toContain(LOGIN_REQUIREMENT_PROBED_AT)
    }
  })

  it('GitHub：结论是「查代码必须登录」，证据是匿名 401', () => {
    expect(GITHUB_LOGIN_REQUIREMENT).toContain('必须登录')
    expect(GITHUB_LOGIN_REQUIREMENT).toContain('401')
    expect(GITHUB_LOGIN_REQUIREMENT).toContain('search/code')
  })

  it('Gitee：结论是「v5 没有代码搜索端点」，证据是 404，并说明仓库搜索需要 token', () => {
    expect(GITEE_CODE_SEARCH_SUPPORTED).toBe(false)
    expect(GITEE_LOGIN_REQUIREMENT).toContain('404')
    expect(GITEE_LOGIN_REQUIREMENT).toContain('search/code')
    expect(GITEE_LOGIN_REQUIREMENT).toContain('token')
    // 这条曾经是错的（把不存在的端点说成「需要 token」），所以要求它把真实情况写全。
    expect(GITEE_LOGIN_REQUIREMENT).toContain('空数组')
  })

  it('CSDN：结论是「没有 OAuth」「正文要打开文章页」，证据是 521 与匿名命中数', () => {
    expect(CSDN_LOGIN_REQUIREMENT).toContain('OAuth')
    expect(CSDN_LOGIN_REQUIREMENT).toContain('521')
    expect(CSDN_LOGIN_REQUIREMENT).toContain('文章页')
    expect(CSDN_LOGIN_REQUIREMENT).toContain('cookie')
  })

  it('robots 立场单独成句，且不是含糊其辞', () => {
    expect(CSDN_ROBOTS_DISCLOSURE).toContain('robots.txt')
    expect(CSDN_ROBOTS_DISCLOSURE).toContain('Disallow: /')
    expect(CSDN_ROBOTS_DISCLOSURE).toContain('单次请求')
  })

  it('LOGIN_REQUIREMENTS 覆盖三个源，且都指向同一批常量', () => {
    expect(Object.keys(LOGIN_REQUIREMENTS).sort()).toEqual([...SOURCES].sort())
    expect(LOGIN_REQUIREMENTS.github).toBe(GITHUB_LOGIN_REQUIREMENT)
    expect(LOGIN_REQUIREMENTS.gitee).toBe(GITEE_LOGIN_REQUIREMENT)
    expect(LOGIN_REQUIREMENTS.csdn).toBe(CSDN_LOGIN_REQUIREMENT)
  })
})

describe('登录要求 — 每个面都按引用拿到同一句话（不是手抄第二份）', () => {
  it('README 把三件事都讲到了（并指向常量作为单一来源）', () => {
    const readme = readRepoFile('README.md')

    // README is user-facing prose, so it states the FACTS (with the measured
    // evidence inline) rather than quoting the constant identifiers — but it must
    // still point a reader at the single source of truth at least once.
    expect(readme).toContain('search/code')
    expect(readme).toContain('401')
    expect(readme).toContain('404')
    expect(readme).toContain('521')
    expect(readme).toContain('OAuth')
    expect(readme).toContain('LOGIN_REQUIREMENT')
    expect(readme).toContain('Disallow: /')
  })

  it('DESIGN 点名了三个常量（工程师文档的责任）', () => {
    const design = readRepoFile('docs/DESIGN.md')

    for (const name of ['GITHUB_LOGIN_REQUIREMENT', 'GITEE_LOGIN_REQUIREMENT', 'CSDN_LOGIN_REQUIREMENT']) {
      expect(design, `DESIGN 应点名 ${name}`).toContain(name)
    }
    expect(design).toContain(LOGIN_REQUIREMENT_PROBED_AT)
    expect(design).toContain('404')
    expect(design).toContain('401')
    expect(design).toContain('521')
  })

  it('浏览器半边引用了这些常量（而不是另写一套文案）', () => {
    const panel = readRepoFile('src/client/panel.tsx')
    expect(panel).toContain('LOGIN_REQUIREMENT')
    expect(panel).toContain('CSDN_ROBOTS_DISCLOSURE')
  })

  it('三个适配器都按引用拿到对应常量', () => {
    for (const [path, name] of [
      ['src/sources/github.ts', 'GITHUB_LOGIN_REQUIREMENT'],
      ['src/sources/gitee.ts', 'GITEE_LOGIN_REQUIREMENT'],
      ['src/sources/csdn.ts', 'CSDN_LOGIN_REQUIREMENT'],
    ] as const) {
      const text = readRepoFile(path)
      // 允许直接引用常量名，也允许经 LOGIN_REQUIREMENTS 映射取用。
      expect(text.includes(name) || text.includes('LOGIN_REQUIREMENTS'), `${path} 应引用 ${name}`).toBe(true)
    }
  })

  it('失败文案里不会再出现「不存在的端点需要 token」这种错误说法', () => {
    const gitee = readRepoFile('src/sources/gitee.ts')
    // 删掉端点后，不该再有对 /search/code 的请求构造。
    expect(gitee).not.toContain('buildGiteeApiUrl(GITEE_SEARCH_CODE')
  })
})

describe('登录方式矩阵与手把手向导', () => {
  it('每个源都至少有一种登录方式，且方式都在契约的枚举里', () => {
    for (const source of SOURCES) {
      const methods = SOURCE_LOGIN_METHODS[source]
      expect(methods.length, `${source} 应有登录方式`).toBeGreaterThan(0)
      for (const method of methods) expect(LOGIN_METHODS).toContain(method)
    }
  })

  it('CSDN 明确没有 OAuth：它只有 cookie 两种导入方式', () => {
    expect([...SOURCE_LOGIN_METHODS.csdn]).toEqual(['cookie-paste', 'cookie-cdp'])
  })

  it('每种方式都恰好属于一个「家族」，且按源分得开（OAuth vs 手动导入）', () => {
    // The user's requirement: OAuth and token/cookie import must be visibly
    // different things. That starts with them being different DATA.
    for (const method of LOGIN_METHODS) {
      expect(LOGIN_METHOD_FAMILIES).toContain(LOGIN_METHOD_FAMILY[method])
    }

    expect(loginMethodsOf('github', 'oauth')).toEqual(['oauth-device'])
    expect(loginMethodsOf('github', 'manual')).toEqual(['pat'])
    expect(loginMethodsOf('gitee', 'oauth')).toEqual(['oauth-code'])
    expect(loginMethodsOf('gitee', 'manual')).toEqual(['pat'])
    // CSDN has no OAuth at all — the wizard must say that, not hide it.
    expect(loginMethodsOf('csdn', 'oauth')).toEqual([])
    expect(loginMethodsOf('csdn', 'manual')).toEqual(['cookie-paste', 'cookie-cdp'])

    // The two families together are exactly the source's method list: nothing may
    // be dropped by the grouping (that is how a method silently disappears).
    for (const source of SOURCES) {
      const regrouped = LOGIN_METHOD_FAMILIES.flatMap((family) => loginMethodsOf(source, family))
      expect([...regrouped].sort(), `${source} 分组后不能丢方式`).toEqual([...SOURCE_LOGIN_METHODS[source]].sort())
    }
  })

  it('每种方式都有 kind 与至少两步可执行指引（含可打开/可复制的 URL 或要填的字段）', () => {
    for (const method of LOGIN_METHODS) {
      expect(LOGIN_METHOD_KIND[method]).toMatch(/^(token|cookie|secret)$/)
      const guide = LOGIN_GUIDES[method]
      expect(guide.method).toBe(method)
      expect(guide.why.length).toBeGreaterThan(10)
      expect(guide.steps.length).toBeGreaterThanOrEqual(2)
      const actionable = guide.steps.some((step) => step.url !== undefined || (step.fields?.length ?? 0) > 0)
      expect(actionable, `${method} 至少要有一处可打开链接或可填字段`).toBe(true)
      for (const step of guide.steps) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)
      }
    }
  })

  it('PAT 指引按源区分（GitHub 与 Gitee 的令牌页不是同一个）', () => {
    const github = loginGuideFor('github', 'pat')
    const gitee = loginGuideFor('gitee', 'pat')
    expect(github.title).not.toBe(gitee.title)

    const githubUrls = github.steps.flatMap((step) => (step.url === undefined ? [] : [step.url]))
    const giteeUrls = gitee.steps.flatMap((step) => (step.url === undefined ? [] : [step.url]))
    expect(githubUrls.some((url) => url.includes('github.com'))).toBe(true)
    expect(giteeUrls.some((url) => url.includes('gitee.com'))).toBe(true)
  })

  it('注册/登录 URL 都是 https，且指向对应平台', () => {
    for (const [key, url] of Object.entries(LOGIN_URLS)) {
      expect(url.startsWith('https://'), `${key} 必须是 https`).toBe(true)
    }
    expect(LOGIN_URLS.githubOAuthApp).toContain('github.com')
    expect(LOGIN_URLS.giteeOAuthApp).toContain('gitee.com')
    expect(LOGIN_URLS.csdnLogin).toContain('csdn.net')
  })
})
