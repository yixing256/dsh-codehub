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

import { DEFAULT_LIMITS, HARD_LIMITS } from '../src/contract.js'
import {
  Config,
  SECRET_KEY_PATTERN,
  isSecretKey,
  readBoolean,
  readStringList,
  resolveLimits,
  splitConfigPatch,
} from '../src/config.js'
import type { CodehubConfig } from '../src/config.js'
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
