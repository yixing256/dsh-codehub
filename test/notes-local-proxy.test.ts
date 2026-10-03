/**
 * 备注① — 本机代理的作用范围：**仅 Node 直连传输生效**（task-5 §A.1）。
 *
 * Covered here, in order:
 *   1. the contract constant is EXACTLY the required phrase;
 *   2. `LOCAL_PROXY_HELP` (and the derived schema field description) carry it,
 *      while `LOCAL_PROXY_LABEL` does not — so the phrase reaches the rendered
 *      control through a real composition, not by accident of wording;
 *   3. `README.md` and `docs/DESIGN.md` both document the limitation;
 *   4. the browser half composes its local-proxy label from `LOCAL_PROXY_LABEL`
 *      + `LOCAL_PROXY_SCOPE_NOTE` and renders `LOCAL_PROXY_HELP` verbatim
 *      (source-text assertions: `src/client/**` imports SDK packages that exist
 *      only as ambient type declarations, so it cannot be imported under vitest);
 *   5. `net.planRequest()` — a pure function — applies a configured proxy on the
 *      `node` channel and explicitly does NOT apply it on `dsh-web`, saying why.
 *
 * Zero network: only pure planning is exercised; no `Transport` is ever built.
 */

import { describe, expect, it } from 'vitest'

import {
  ACCESS_OPTIONS,
  LOCAL_PROXY_HELP,
  LOCAL_PROXY_LABEL,
  LOCAL_PROXY_SCOPE_NOTE,
  TRANSPORTS,
} from '../src/contract.js'
import { Config, LOCAL_PROXY_FIELD_DESCRIPTION } from '../src/config.js'
import { parseProxyAddress, planRequest, proxySupport, redactAddress } from '../src/net.js'
import { readRepoFile } from './helpers.js'

const URL_UNDER_TEST = 'https://api.github.com/search/repositories?q=vue'

describe('备注① — 契约常量与文档', () => {
  it('LOCAL_PROXY_SCOPE_NOTE 严格等于要求的字样', () => {
    expect(LOCAL_PROXY_SCOPE_NOTE).toBe('仅 Node 直连传输生效')
  })

  it('LOCAL_PROXY_HELP 含该字样，而 LOCAL_PROXY_LABEL 不含（说明是拼接出来的，不是同一句）', () => {
    expect(LOCAL_PROXY_HELP).toContain(LOCAL_PROXY_SCOPE_NOTE)
    expect(LOCAL_PROXY_LABEL).not.toContain(LOCAL_PROXY_SCOPE_NOTE)
    expect(LOCAL_PROXY_LABEL.length).toBeGreaterThan(0)
  })

  it('配置 schema 的代理字段描述（表单渲染文案）含该字样', () => {
    // The form is derived from the schemastery schema, so the description IS the
    // user-visible copy.
    expect(LOCAL_PROXY_FIELD_DESCRIPTION).toContain(LOCAL_PROXY_LABEL)
    expect(LOCAL_PROXY_FIELD_DESCRIPTION).toContain(LOCAL_PROXY_SCOPE_NOTE)

    const githubSchema = Config.dict?.['github']
    expect(githubSchema, 'schema 应暴露 github 分组').toBeDefined()
    const description = githubSchema?.dict?.['localProxy']?.meta.description
    expect(typeof description).toBe('string')
    expect(String(description)).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('ACCESS_OPTIONS 的 local-proxy 条目（风险档要求文案）含该字样', () => {
    const option = ACCESS_OPTIONS.find((item) => item.id === 'local-proxy')
    expect(option).toBeDefined()
    expect(option?.requirement).toContain(LOCAL_PROXY_SCOPE_NOTE)
    // 本机代理是用户主动开启的路径，因此允许携带 token（与镜像路径相反）。
    expect(option?.carriesToken).toBe(true)
  })

  it('README.md 与 docs/DESIGN.md 都写明了这条限制', () => {
    expect(readRepoFile('README.md')).toContain(LOCAL_PROXY_SCOPE_NOTE)
    expect(readRepoFile('docs/DESIGN.md')).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('README 详述代理适用范围时不再引用实现里不存在的配置项 localProxyKind', () => {
    const readme = readRepoFile('README.md')
    expect(readme).not.toContain('localProxyKind')
    // 反向确认：README 确实谈到了代理地址字段本身，否则上面那行是空断言。
    expect(readme).toContain('github.localProxy')
    expect(readme).toContain('SOCKS4')
  })

  it('浏览器半边：代理 label 由 LOCAL_PROXY_LABEL + LOCAL_PROXY_SCOPE_NOTE 拼成，help 原样渲染', () => {
    const panel = readRepoFile('src/client/panel.tsx')
    // 两者必须出现在同一条模板拼接里 —— 只各自出现一次不足以证明 label 带上了这句话。
    expect(panel).toMatch(/`\$\{LOCAL_PROXY_LABEL\}[^`]*\$\{LOCAL_PROXY_SCOPE_NOTE\}[^`]*`/)
    expect(panel).toContain('{LOCAL_PROXY_HELP}')
    expect(panel).toContain('LOCAL_PROXY_HELP')
  })
})

describe('备注① — net.planRequest 的通道行为（纯函数，零网络）', () => {
  it('确认只有两条通道：dsh-web 与 node', () => {
    expect([...TRANSPORTS]).toEqual(['dsh-web', 'node'])
  })

  it('transport=dsh-web 时不应用代理，并给出含该字样的原因', () => {
    const plan = planRequest({ url: URL_UNDER_TEST, transport: 'dsh-web', localProxy: '127.0.0.1:7890' })

    expect(plan.transport).toBe('dsh-web')
    expect(plan.proxyConfigured).toBe(true)
    expect(plan.proxyApplied).toBe(false)
    // 不是静默忽略：必须留下解释。
    expect(plan.reason).toBeDefined()
    expect(plan.reason).toContain(LOCAL_PROXY_SCOPE_NOTE)
    expect(plan.notes.join('\n')).toContain(LOCAL_PROXY_SCOPE_NOTE)
    // 本机配置错误才 blocked；「通道不支持代理」是如实说明，不是拒发。
    expect(plan.blocked).toBe(false)
  })

  it('transport=node 时应用代理，并同样带出该字样', () => {
    const plan = planRequest({ url: URL_UNDER_TEST, transport: 'node', localProxy: '127.0.0.1:7890' })

    expect(plan.transport).toBe('node')
    expect(plan.proxyConfigured).toBe(true)
    expect(plan.proxyApplied).toBe(true)
    expect(plan.blocked).toBe(false)
    expect(plan.proxy).toMatchObject({ scheme: 'http', host: '127.0.0.1', port: 7890 })
    expect(plan.notes.join('\n')).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('同一份代理配置在两条通道上的结论不同 —— 这就是备注①要说明的差异', () => {
    const web = planRequest({ url: URL_UNDER_TEST, transport: 'dsh-web', localProxy: 'socks5://127.0.0.1:1080' })
    const node = planRequest({ url: URL_UNDER_TEST, transport: 'node', localProxy: 'socks5://127.0.0.1:1080' })

    expect(web.proxyApplied).toBe(false)
    expect(node.proxyApplied).toBe(true)
    expect(web.transport).not.toBe(node.transport)
  })

  it('访问方式选「本机代理」时，dsh-web 会被改走 node，否则该方式永远不可能生效', () => {
    const plan = planRequest({
      url: URL_UNDER_TEST,
      transport: 'dsh-web',
      access: 'local-proxy',
      localProxy: '127.0.0.1:7890',
    })

    expect(plan.transport).toBe('node')
    expect(plan.proxyApplied).toBe(true)
    expect(plan.notes.join('\n')).toContain(LOCAL_PROXY_SCOPE_NOTE)
  })

  it('配置了却无法解析的代理 → 拒绝请求，绝不静默直连', () => {
    const plan = planRequest({ url: URL_UNDER_TEST, transport: 'node', localProxy: 'ftp://127.0.0.1:21' })

    expect(plan.blocked).toBe(true)
    expect(plan.proxyApplied).toBe(false)
    expect(plan.proxyConfigured).toBe(false)
    expect(plan.reason).toContain('无法解析')
  })

  it('选了「本机代理」但没填地址 → 拒绝请求（未填 = 该方式不可用，不兜底）', () => {
    const plan = planRequest({ url: URL_UNDER_TEST, transport: 'node', access: 'local-proxy' })

    expect(plan.blocked).toBe(true)
    expect(plan.proxyApplied).toBe(false)
  })

  it('SOCKS4 被明确拒绝：不发起请求，也不绕过代理直连', () => {
    const spec = parseProxyAddress('socks4://127.0.0.1:1080')
    expect(spec).toBeDefined()
    expect(spec === undefined ? undefined : proxySupport(spec).supported).toBe(false)

    const plan = planRequest({ url: URL_UNDER_TEST, transport: 'node', localProxy: 'socks4://127.0.0.1:1080' })
    expect(plan.blocked).toBe(true)
    expect(plan.proxyApplied).toBe(false)
    expect(plan.reason).toContain('SOCKS4')
  })

  it('代理地址里的凭据绝不进入可日志化的渲染结果', () => {
    const raw = 'socks5://user:secret@127.0.0.1:1080'
    const plan = planRequest({ url: URL_UNDER_TEST, transport: 'node', localProxy: raw })

    expect(plan.proxyApplied).toBe(true)
    // The structured plan must carry the credential (the CONNECT handshake needs
    // it), but nothing that is RENDERED may: `reason`/`notes` go to the agent.
    expect(plan.notes.join('\n')).not.toContain('secret')
    expect(String(plan.reason)).not.toContain('secret')
    expect(redactAddress(raw)).toBe('socks5://127.0.0.1:****')
  })
})
