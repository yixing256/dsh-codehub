/**
 * 配置与密钥（task-5 §F，前半）。
 *
 * The requirement is structural: **no credential is representable in the config
 * schema, and no credential can reach the store file.** Three mechanisms are
 * asserted separately, because each one alone would be bypassable:
 *
 *   1. the schemastery schema exposes no token/cookie/secret-shaped field at any
 *      nesting level (asserted by walking `Config.dict`, using the very
 *      `isSecretKey()` predicate the store relies on);
 *   2. a PATCH naming a credential is rejected BY NAME and never persisted;
 *   3. `scrubValue()` drops secret-shaped keys on both write and read, so even a
 *      hand-written store file cannot smuggle one back in — plus the file really
 *      is written `0600`/`0700` where the platform supports POSIX modes.
 *
 * Also pinned here: the schema defaults, which are the reason a fresh install
 * reports four *undecided* decisions rather than silently picking defaults.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CDP_DEFAULT_PORT, DEFAULT_LIMITS, HARD_LIMITS } from '../src/contract.js'
import {
  Config,
  SECRET_KEY_PATTERN,
  isSecretKey,
  readBoolean,
  readStringList,
  resolveConfig,
  resolveLimits,
  splitConfigPatch,
  toJsonView,
} from '../src/config.js'
import type { CodehubConfig } from '../src/config.js'
import { TransportError, createPostTransport, createTransport } from '../src/net.js'
import {
  DIR_MODE,
  FILE_MODE,
  LocalConfigStore,
  SCRUB_LIMITS,
  STORE_DIR_MODE,
  STORE_FILE_MODE,
  STORE_FILE_NAME,
  normalizeLocalProxy,
  resolveStorePath,
  sanitizeLocalConfig,
  scrubValue,
} from '../src/store.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-codehub-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe('配置 schema — 没有任何 token 字段', () => {
  it('顶层与每个嵌套分组的属性名都不像密钥，且 isSecretKey 一致判定', () => {
    const top = Object.keys(Config.dict ?? {})
    expect(top.length).toBeGreaterThanOrEqual(10)

    for (const key of top) {
      expect(isSecretKey(key), `顶层字段 ${key} 不应像密钥`).toBe(false)
    }

    const groups = ['github', 'gitee', 'csdn', 'failover', 'limits', 'marking', 'deepRead']
    for (const group of groups) {
      const nested = Object.keys(Config.dict?.[group]?.dict ?? {})
      expect(nested.length, `${group} 分组应存在且非空`).toBeGreaterThan(0)
      for (const key of nested) {
        expect(isSecretKey(key), `${group}.${key} 不应像密钥`).toBe(false)
      }
    }
  })

  it('显式点名禁用字段：token / cookie / authorization / apiKey 一个都不在 schema 里', () => {
    const everyField = new Set<string>()
    for (const [key, schema] of Object.entries(Config.dict ?? {})) {
      everyField.add(key)
      for (const nested of Object.keys(schema.dict ?? {})) everyField.add(nested)
    }

    for (const forbidden of ['token', 'giteeToken', 'githubToken', 'csdnCookie', 'cookie', 'authorization', 'apiKey', 'api_key', 'password', 'secret']) {
      expect(everyField.has(forbidden), `schema 不应包含 ${forbidden}`).toBe(false)
    }
  })

  it('isSecretKey 认得常见的密钥字段名，但不误伤正常字段', () => {
    for (const name of ['token', 'giteeToken', 'csdnCookie', 'authorization', 'apiKey', 'api-key', 'privateKey', 'password', 'credential']) {
      expect(isSecretKey(name), name).toBe(true)
    }
    for (const name of ['sourcePriority', 'localProxy', 'rawMirrorBases', 'webProxyBases', 'accessPriority', 'maxCodeChars', 'apiBase', 'deepRead', 'targets']) {
      expect(isSecretKey(name), name).toBe(false)
    }
    expect(SECRET_KEY_PATTERN.test('DSH_CODEHUB_GITEE_TOKEN')).toBe(true)
  })

  it('默认值让四个决策点保持「未决」，而不是被默默填上', () => {
    const resolved = Config({}) as unknown as Record<string, unknown>

    expect(resolved['sourcePriority']).toEqual([])
    const github = resolved['github'] as Record<string, unknown>
    expect(github['accessPriority']).toEqual([])
    const failover = resolved['failover'] as Record<string, unknown>
    expect(failover['enabled']).toBeUndefined()
    expect(resolved['mergeSources']).toBeUndefined()

    // 属偏好而非决策点的那些字段确实有默认值 —— 两边的区别是刻意的。
    expect(resolved['enabled']).toBe(true)
    expect(resolved['announceToAgent']).toBe(true)
  })
})

describe('配置 PATCH — 密钥字段按名字拒收，绝不落盘', () => {
  it('github.localProxy 归 0600 存储，密钥字段被拒收并只报名字', () => {
    const split = splitConfigPatch({
      sourcePriority: ['github'],
      github: { localProxy: '127.0.0.1:7890', token: 'ghp_leak_value' },
      giteeToken: 'another_leak',
    })

    expect(split.ok).toBe(true)
    // `rejected` is `readonly string[]`: copy before sorting (sort() mutates in place).
    expect([...split.rejected].sort()).toEqual(['giteeToken', 'token'])
    expect(split.local.localProxy).toBe('127.0.0.1:7890')
    expect(split.settings.sourcePriority).toEqual(['github'])

    const persisted = JSON.stringify(split.settings)
    expect(persisted).not.toContain('ghp_leak_value')
    expect(persisted).not.toContain('another_leak')
    expect(Object.keys(split.settings)).not.toContain('giteeToken')
  })

  it('非对象请求体直接拒绝；未知字段被拒收但不影响其余字段', () => {
    expect(splitConfigPatch('not an object').ok).toBe(false)
    expect(splitConfigPatch(null).ok).toBe(false)

    const split = splitConfigPatch({ enabled: false, somethingElse: 1 })
    expect(split.ok).toBe(true)
    expect(split.rejected).toEqual(['somethingElse'])
    expect(split.settings.enabled).toBe(false)
  })

  it('limits 只接受白名单字段，未知字段被拒收', () => {
    const split = splitConfigPatch({ limits: { maxItems: 3, unlimited: true } })
    expect(split.ok).toBe(true)
    expect(split.rejected).toEqual(['unlimited'])
    expect(split.settings.limits).toEqual({ maxItems: 3 })
  })
})

describe('存储 — 0600 / 0700 与密钥不可落盘', () => {
  it('模式常量就是 0600 / 0700（含别名）', () => {
    expect(STORE_FILE_MODE).toBe(0o600)
    expect(STORE_DIR_MODE).toBe(0o700)
    expect(FILE_MODE).toBe(STORE_FILE_MODE)
    expect(DIR_MODE).toBe(STORE_DIR_MODE)
    expect(STORE_FILE_NAME).toBe('dsh-codehub.json')
  })

  it('真的写出文件（父目录不存在也能建），并在支持的平台上落实 0600', async () => {
    const directory = temporaryDirectory()
    const store = new LocalConfigStore(join(directory, 'nested', STORE_FILE_NAME))

    const outcome = await store.write({ localProxy: '127.0.0.1:7890' })
    expect(outcome.ok).toBe(true)
    expect(outcome.path).toBe(join(directory, 'nested', STORE_FILE_NAME))

    const text = readFileSync(outcome.path, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ localProxy: '127.0.0.1:7890' })

    const mode = statSync(outcome.path).mode & 0o777
    if (process.platform === 'win32') {
      // Windows 只落实只读位；实现里 chmod 是尽力而为、绝不致命（store.ts 头注释）。
      expect(mode & 0o200).toBe(0o200)
    } else {
      expect(mode).toBe(0o600)
    }

    const read = await store.read()
    expect(read.localProxy).toBe('127.0.0.1:7890')
  })

  it('写进去的密钥字段被丢弃：文件里搜不到那个值，回读也没有该键', async () => {
    const directory = temporaryDirectory()
    const store = new LocalConfigStore(join(directory, STORE_FILE_NAME))

    const leaking = {
      github: { accessPriority: ['direct'], token: 'ghp_leak_value' },
      csdnCookie: 'session_leak_value',
    } as unknown as CodehubConfig

    const outcome = await store.write({ fallbackConfig: leaking })
    expect(outcome.ok).toBe(true)

    const raw = readFileSync(outcome.path, 'utf8')
    expect(raw).not.toContain('ghp_leak_value')
    expect(raw).not.toContain('session_leak_value')
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('Cookie')

    const read = await store.read()
    expect(read.fallbackConfig?.github?.accessPriority).toEqual(['direct'])
    expect(Object.keys(read.fallbackConfig ?? {})).not.toContain('csdnCookie')
    expect(Object.keys(read.fallbackConfig?.github ?? {})).not.toContain('token')
  })

  it('存储文件的顶层键只有白名单那三个', async () => {
    const directory = temporaryDirectory()
    const store = new LocalConfigStore(join(directory, STORE_FILE_NAME))
    await store.write({ localProxy: '127.0.0.1:7890' })

    const parsed = JSON.parse(readFileSync(store.filePath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['localProxy', 'updatedAt'])
  })

  it('DSH_HOME 决定默认路径（每次构造时解析）', () => {
    const directory = temporaryDirectory()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = directory
    try {
      expect(resolveStorePath()).toBe(join(directory, STORE_FILE_NAME))
      expect(new LocalConfigStore().filePath).toBe(join(directory, STORE_FILE_NAME))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('损坏或缺失的文件读成空对象，不抛异常', async () => {
    const directory = temporaryDirectory()
    const store = new LocalConfigStore(join(directory, 'missing.json'))
    expect(await store.read()).toEqual({})

    const broken = new LocalConfigStore(join(directory, 'broken.json'))
    await broken.write({ localProxy: '127.0.0.1:7890' })
    const diagnostics = await broken.diagnostics()
    expect(diagnostics.exists).toBe(true)
    expect(diagnostics.readable).toBe(true)
    expect(diagnostics.path).toBe(broken.filePath)
  })
})

describe('存储 — scrubValue / sanitizeLocalConfig / normalizeLocalProxy', () => {
  it('scrubValue 在任意深度丢掉密钥键', () => {
    expect(scrubValue({ token: 'x' })).toEqual({})
    expect(scrubValue({ nested: { authorization: 'x', keep: 1 } })).toEqual({ nested: { keep: 1 } })
    expect(scrubValue({ list: [{ cookie: 'x', keep: 2 }] })).toEqual({ list: [{ keep: 2 }] })
    expect(scrubValue({ a: 'ok', b: false, c: 3, d: null })).toEqual({ a: 'ok', b: false, c: 3, d: null })
  })

  it('scrubValue 有深度与长度上界，不会变成无界 blob', () => {
    expect(scrubValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: {} } } })
    const long = scrubValue({ s: 'x'.repeat(1_000) }) as { s: string }
    expect(long.s).toHaveLength(SCRUB_LIMITS.maxStringChars)
    const many = scrubValue({ list: Array.from({ length: 100 }, (_, index) => index) }) as { list: number[] }
    expect(many.list).toHaveLength(SCRUB_LIMITS.maxArrayItems)
  })

  it('sanitizeLocalConfig 只保留白名单顶层键', () => {
    expect(sanitizeLocalConfig({ localProxy: '127.0.0.1:7890', evil: 'x', updatedAt: 't' })).toEqual({
      localProxy: '127.0.0.1:7890',
      updatedAt: 't',
    })
    expect(sanitizeLocalConfig(null)).toEqual({})
    expect(sanitizeLocalConfig([])).toEqual({})
    expect(sanitizeLocalConfig('nope')).toEqual({})
  })

  it('normalizeLocalProxy 去空白与不可见字符，含空格的地址视为无效', () => {
    expect(normalizeLocalProxy('  127.0.0.1:7890  ')).toBe('127.0.0.1:7890')
    expect(normalizeLocalProxy('\u0000127.0.0.1:7890\u007f')).toBe('127.0.0.1:7890')
    expect(normalizeLocalProxy('127.0.0.1:7890 extra')).toBeUndefined()
    expect(normalizeLocalProxy('')).toBeUndefined()
    expect(normalizeLocalProxy(undefined)).toBeUndefined()
    expect(normalizeLocalProxy(42)).toBeUndefined()
  })
})

describe('限制 — 只可下调，不能超过硬顶', () => {
  it('resolveLimits 把超限值夹回 HARD_LIMITS，缺省值取 DEFAULT_LIMITS', () => {
    expect(
      resolveLimits({ timeoutMs: 999_999, retries: 99, maxDepth: 99, maxItems: 999, maxCodeChars: 999_999 }),
    ).toEqual({ ...HARD_LIMITS })
    expect(resolveLimits()).toEqual({ ...DEFAULT_LIMITS })
    expect(resolveLimits(null)).toEqual({ ...DEFAULT_LIMITS })
    expect(resolveLimits({ timeoutMs: 0 }).timeoutMs).toBe(1)
    expect(resolveLimits({ maxDepth: -3 }).maxDepth).toBe(0)
    expect(resolveLimits({ timeoutMs: Number.NaN }).timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs)
  })

  it('宽容读取器：只有真正的布尔值才算答案，未知枚举值被过滤', () => {
    expect(readBoolean(false)).toBe(false)
    expect(readBoolean(true)).toBe(true)
    expect(readBoolean('false')).toBeUndefined()
    expect(readBoolean(0)).toBeUndefined()
    expect(readBoolean(undefined)).toBeUndefined()

    expect(readStringList([' github ', 'github', 'gitee', 'nope'], ['github', 'gitee', 'csdn'])).toEqual([
      'github',
      'gitee',
    ])
    expect(readStringList('github')).toEqual([])
    expect(readStringList(undefined)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The login / article-fetch / CDP fields added for docs/DESIGN.md §7.
//
// The red line is unchanged and is re-asserted here on purpose: these six new
// fields are all NON-secret (a client ID is public, a port is a port), so the
// schema must take them while `gitee.oauthClientSecret` — which Gitee does
// require — stays out of both the schema and the store file.
// ---------------------------------------------------------------------------

/** `meta.description` is what the settings form renders; empty copy = no help. */
function descriptionOf(group: string, key: string): string {
  const schema = Config.dict?.[group]?.dict?.[key]
  const description = schema?.meta?.description
  return typeof description === 'string' ? description : ''
}

describe('配置 schema — 新增 6 个字段（登录 / 文章抓取 / CDP）', () => {
  it('六个字段都进了 schema，且每个都有 description（文案就是设置表单里的说明）', () => {
    expect(Object.keys(Config.dict?.github?.dict ?? {})).toContain('oauthClientId')
    expect(Object.keys(Config.dict?.gitee?.dict ?? {})).toEqual(
      expect.arrayContaining(['oauthClientId', 'oauthRedirectUri']),
    )
    expect(Object.keys(Config.dict?.csdn?.dict ?? {})).toEqual(
      expect.arrayContaining(['articleFetch', 'cdpEnabled', 'cdpPort']),
    )

    for (const [group, key] of [
      ['github', 'oauthClientId'],
      ['gitee', 'oauthClientId'],
      ['gitee', 'oauthRedirectUri'],
      ['csdn', 'articleFetch'],
      ['csdn', 'cdpEnabled'],
      ['csdn', 'cdpPort'],
    ] as const) {
      const description = descriptionOf(group, key)
      expect(description.length, `${group}.${key} 必须有说明文案`).toBeGreaterThan(30)
    }
  })

  it('说明文案带上实测事实：Device Flow 勾选、回调必须一致、CDP 的安全代价', () => {
    expect(descriptionOf('github', 'oauthClientId')).toContain('Device Flow')
    expect(descriptionOf('gitee', 'oauthRedirectUri')).toContain('/api/dsh-codehub/oauth/callback')
    expect(descriptionOf('gitee', 'oauthRedirectUri')).toContain('完全一致')
    expect(descriptionOf('csdn', 'cdpEnabled')).toContain('--remote-debugging-port')
    expect(descriptionOf('csdn', 'articleFetch')).toContain('521')
    expect(descriptionOf('csdn', 'cdpPort')).toContain(String(CDP_DEFAULT_PORT))
  })

  it('默认值：client id 为空、文章抓取开、CDP 关（opt-in 不是默认）', () => {
    const resolved = Config({}) as unknown as Record<string, Record<string, unknown>>

    expect(resolved['github']?.['oauthClientId']).toBe('')
    expect(resolved['gitee']?.['oauthClientId']).toBe('')
    expect(resolved['gitee']?.['oauthRedirectUri']).toBe('')
    expect(resolved['csdn']?.['articleFetch']).toBe(true)
    expect(resolved['csdn']?.['cdpEnabled']).toBe(false)
    expect(resolved['csdn']?.['cdpPort']).toBe(CDP_DEFAULT_PORT)
  })

  it('gitee.oauthClientSecret 绝不进 schema（Gitee 确实需要 secret，但它只进凭据服务）', () => {
    const giteeFields = Object.keys(Config.dict?.gitee?.dict ?? {})
    expect(giteeFields).not.toContain('oauthClientSecret')
    expect(giteeFields).not.toContain('clientSecret')
    for (const key of giteeFields) expect(isSecretKey(key), key).toBe(false)
  })
})

describe('配置 PATCH — 新字段可写可回读，secret 形状仍按名字拒收', () => {
  it('六个字段都能通过 PATCH 落进 settings，并被 resolveConfig 原样读回', () => {
    const split = splitConfigPatch({
      github: { oauthClientId: 'github-client-id-public' },
      gitee: { oauthClientId: 'gitee-client-id-public', oauthRedirectUri: 'http://127.0.0.1:19387/api/dsh-codehub/oauth/callback' },
      csdn: { articleFetch: false, cdpEnabled: true, cdpPort: 9333 },
    })

    expect(split.ok).toBe(true)
    expect(split.rejected).toEqual([])
    expect(split.settings.github?.oauthClientId).toBe('github-client-id-public')

    const resolved = resolveConfig(split.settings)
    expect(resolved.github.oauthClientId).toBe('github-client-id-public')
    expect(resolved.gitee.oauthClientId).toBe('gitee-client-id-public')
    expect(resolved.gitee.oauthRedirectUri).toBe('http://127.0.0.1:19387/api/dsh-codehub/oauth/callback')
    expect(resolved.csdn.articleFetch).toBe(false)
    expect(resolved.csdn.cdpEnabled).toBe(true)
    expect(resolved.csdn.cdpPort).toBe(9333)
  })

  it('ui.autoSave 能通过 PATCH 落进 settings，并被 resolveConfig / JSON 视图读回', () => {
    // The switch exists because auto-save ON with no way off left the manual save
    // button permanently disabled; it must therefore round-trip like any setting.
    const off = splitConfigPatch({ ui: { autoSave: false } })
    expect(off.ok).toBe(true)
    expect(off.rejected).toEqual([])
    expect(resolveConfig(off.settings).ui.autoSave).toBe(false)
    expect(toJsonView(resolveConfig(off.settings)).ui).toEqual({ autoSave: false })

    // Default stays ON (the user asked for auto-save), and a junk value is not a
    // decision: it falls back to the default rather than to `false`.
    expect(resolveConfig({}).ui.autoSave).toBe(true)
    expect(resolveConfig({ ui: { autoSave: 'yes' as unknown as boolean } }).ui.autoSave).toBe(true)

    // An unknown key inside the group is rejected BY NAME, like every other group.
    const junk = splitConfigPatch({ ui: { autoSave: true, autoSaveEverything: true } })
    expect(junk.rejected).toEqual(['autoSaveEverything'])
    expect(junk.settings.ui).toEqual({ autoSave: true })
  })

  it('oauthClientSecret / *token* / *secret* 形状的 patch 被拒收，且只报字段名', () => {
    const split = splitConfigPatch({
      github: { oauthClientSecret: 'ghs_leak_value', oauthClientId: 'public-id' },
      gitee: { oauthClientSecret: 'gitee_leak_value' },
      csdn: { cookie: 'session_leak_value' },
      giteeToken: 'top_level_leak',
      oauthClientSecret: 'top_level_secret_leak',
    })

    expect(split.ok).toBe(true)
    expect([...split.rejected].sort()).toEqual(
      ['cookie', 'giteeToken', 'oauthClientSecret', 'oauthClientSecret', 'oauthClientSecret'].sort(),
    )
    // 白名单字段照常保留。
    expect(split.settings.github?.oauthClientId).toBe('public-id')

    const persisted = JSON.stringify(split.settings)
    expect(persisted).not.toContain('leak')
    expect(persisted).not.toContain('ghs_')
    expect(persisted).not.toContain('session_leak_value')
  })

  it('csdn.cdpPort 越界收敛到 1..65535，不是拒收也不是透传', () => {
    expect(resolveConfig({ csdn: { cdpPort: 99999 } }).csdn.cdpPort).toBe(65535)
    expect(resolveConfig({ csdn: { cdpPort: 0 } }).csdn.cdpPort).toBe(1)
    expect(resolveConfig({ csdn: { cdpPort: -5 } }).csdn.cdpPort).toBe(1)
    expect(resolveConfig({ csdn: { cdpPort: 1234.9 } }).csdn.cdpPort).toBe(1234)
    expect(resolveConfig({ csdn: { cdpPort: Number.NaN } }).csdn.cdpPort).toBe(CDP_DEFAULT_PORT)
    expect(resolveConfig({ csdn: { cdpPort: '9222' as unknown as number } }).csdn.cdpPort).toBe(CDP_DEFAULT_PORT)
    expect(resolveConfig({}).csdn.cdpPort).toBe(CDP_DEFAULT_PORT)
  })

  it('gitee 与 csdn 不再共用一份键白名单（互不串门）', () => {
    const split = splitConfigPatch({
      gitee: { cdpPort: 9222 },
      csdn: { oauthRedirectUri: 'http://127.0.0.1/cb' },
    })

    expect([...split.rejected].sort()).toEqual(['cdpPort', 'oauthRedirectUri'])
    expect(split.settings.gitee).toEqual({})
    expect(split.settings.csdn).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// The OAuth POST seam (`net.createPostTransport`, docs/DESIGN.md §7.2).
//
// This is the only egress in the plugin that carries a `client_secret`, so its
// hard rules are the same family as the key policy above and are asserted here:
// official hosts only, https only, and a configured-but-unusable proxy refuses
// the request instead of quietly sending the exchange direct. The GET transport
// itself is covered by `net-transport.test.ts`; this block adds only the shape
// that file cannot reach.
// ---------------------------------------------------------------------------

describe('出网 POST seam — 带凭据的 POST 只打官方主机', () => {
  interface PostCall {
    readonly url: string
    readonly init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } | undefined
  }

  function fakeFetch(status: number, body: string): { readonly impl: (url: string, init?: PostCall['init']) => Promise<{ status: number; text: () => Promise<string> }>; readonly calls: PostCall[] } {
    const calls: PostCall[] = []
    return {
      impl: async (url, init) => {
        calls.push({ url, init })
        return { status, text: async () => body }
      },
      calls,
    }
  }

  it('直连形态：POST + 表单体 + content-type，并把状态码与正文如实带出', async () => {
    const fetch = fakeFetch(200, '{"access_token":"not-our-business"}')
    const post = createPostTransport({ fetchImpl: fetch.impl })

    const response = await post({
      url: 'https://github.com/login/device/code',
      form: { client_id: 'abc', scope: 'repo' },
      timeoutMs: 1_000,
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('access_token')
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]?.url).toBe('https://github.com/login/device/code')
    expect(fetch.calls[0]?.init?.method).toBe('POST')
    expect(fetch.calls[0]?.init?.headers?.['content-type']).toBe('application/x-www-form-urlencoded')
    expect(fetch.calls[0]?.init?.headers?.['accept']).toBe('application/json')
    expect(fetch.calls[0]?.init?.body).toBe('client_id=abc&scope=repo')
  })

  it('HTTP 4xx 是「值」不是异常（业务错误由 OAuth 引擎判断）', async () => {
    const fetch = fakeFetch(400, '{"error":"incorrect_client_credentials"}')
    const post = createPostTransport({ fetchImpl: fetch.impl })

    const response = await post({ url: 'https://gitee.com/oauth/token', form: {}, timeoutMs: 1_000 })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('incorrect_client_credentials')
  })

  it('非官方主机 / 子域冒充 / http → 直接拒绝，且一次请求都不发', async () => {
    for (const url of [
      'https://ghproxy.net/https://github.com/login/device/code',
      'https://github.com.evil.example/login/device/code',
      'https://example.com/oauth/token',
      'http://github.com/login/device/code',
    ]) {
      const fetch = fakeFetch(200, '{}')
      const post = createPostTransport({ fetchImpl: fetch.impl })

      const error = await post({ url, form: {}, timeoutMs: 1_000 }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

      expect(error, url).toBeInstanceOf(TransportError)
      expect((error as TransportError).kind, url).toBe('network')
      expect(fetch.calls, url).toHaveLength(0)
    }
  })

  it('官方子域（api.github.com / gitee.com）是允许的', async () => {
    const fetch = fakeFetch(200, '{}')
    const post = createPostTransport({ fetchImpl: fetch.impl })

    await post({ url: 'https://api.github.com/login/oauth/access_token', form: {}, timeoutMs: 1_000 })
    await post({ url: 'https://gitee.com/oauth/token', form: {}, timeoutMs: 1_000 })

    expect(fetch.calls.map((call) => call.url)).toEqual([
      'https://api.github.com/login/oauth/access_token',
      'https://gitee.com/oauth/token',
    ])
  })

  it('网络层异常被包装成 TransportError，且消息里不留凭据', async () => {
    const post = createPostTransport({
      fetchImpl: async () => {
        throw new Error('fetch failed: ECONNREFUSED')
      },
    })

    const error = await post({ url: 'https://github.com/login/device/code', form: {}, timeoutMs: 1_000 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).kind).toBe('network')
  })

  it('配置了却无法解析的代理 → 拒绝请求，绝不静默直连', async () => {
    const fetch = fakeFetch(200, '{}')
    const post = createPostTransport({ fetchImpl: fetch.impl, localProxy: 'ftp://127.0.0.1:21' })

    const error = await post({ url: 'https://gitee.com/oauth/token', form: {}, timeoutMs: 1_000 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).message).toContain('无法解析')
    expect(fetch.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The channel rule that makes the CSDN article fetch work at all.
//
// `ctx.web.fetch` accepts a bare `{ url }`, so a request carrying a User-Agent /
// Referer silently loses them there — and CSDN answers HTTP 521 to a headerless
// article fetch. Headers therefore force the node channel; the tests below pin
// both halves of that trade: the honest fallback when node itself is unusable,
// and the fact that a CREDENTIAL never takes it.
// ---------------------------------------------------------------------------

describe('出网通道 — 请求头强制 node，node 不可用时如实回退 dsh-web', () => {
  const CSDN_ARTICLE = 'https://blog.csdn.net/someone/article/details/100'

  /** A `ctx.web.fetch` stand-in that records the request it was handed. */
  function fakeWeb(): { readonly web: unknown; readonly seen: Array<Record<string, unknown>> } {
    const seen: Array<Record<string, unknown>> = []
    return {
      seen,
      web: {
        async fetch(request: { url: string }) {
          seen.push({ ...request })
          return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'from-web' }, truncated: false }
        },
        async search() {
          return {}
        },
      },
    }
  }

  it('带请求头 → 先走 node；node 网络层失败 → 回退 dsh-web，并写明请求头被丢弃、可能被 521 拦截', async () => {
    const { web, seen } = fakeWeb()
    const transport = createTransport({
      web: web as never,
      fetchImpl: async () => {
        throw new Error('fetch failed: ECONNREFUSED')
      },
      retries: 0,
      logger: () => {},
    })

    const response = await transport({
      url: CSDN_ARTICLE,
      headers: { 'user-agent': 'dsh-codehub', referer: 'https://so.csdn.net/' },
      timeoutMs: 1_000,
    })

    expect(response.body).toBe('from-web')
    expect(seen).toHaveLength(1)
    // 头被丢弃是回退的代价，也是必须说出来的事。
    expect(Object.keys(seen[0] ?? {})).toEqual(['url'])
    const notes = [...(response.notes ?? []), response.note ?? ''].join('\n')
    expect(notes).toContain('521')
    expect(notes).toContain('请求头')
  })

  it('带凭据的请求绝不回退 dsh-web（那条通道没有请求头，凭据也无处安放）', async () => {
    const { web, seen } = fakeWeb()
    const transport = createTransport({
      web: web as never,
      fetchImpl: async () => {
        throw new Error('fetch failed: ECONNREFUSED')
      },
      retries: 0,
      logger: () => {},
    })

    const error = await transport({
      url: 'https://api.github.com/search/code?q=vue',
      token: 'ghp_super_secret',
      headers: { accept: 'application/vnd.github+json' },
      timeoutMs: 1_000,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(TransportError)
    expect(seen).toHaveLength(0)
  })
})
