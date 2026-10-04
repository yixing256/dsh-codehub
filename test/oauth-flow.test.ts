/**
 * `src/oauth.ts` — 浏览器登录流程引擎（task-1 W1-A）。
 *
 * Everything here is offline: `createOAuthService()` takes the `PostLike` seam,
 * the reachability probe, the clock and the sleeper by injection, so the real
 * state machine runs and only the network is fake. That is the point — the
 * security invariants must be asserted against the flow the code actually
 * drives, not against a re-implementation of it.
 *
 * The invariant under test throughout is the one the task singles out: a
 * credential value's only permitted destination is `writeCredential()`. A
 * sentinel token is used so that any leak into a return value, a status object,
 * a `reason` string or a log detail is a loud, unambiguous failure.
 */

import { describe, expect, it } from 'vitest'

import {
  GITEE_OAUTH_AUTHORIZE_ENDPOINT,
  GITEE_OAUTH_TOKEN_ENDPOINT,
  GITHUB_DEVICE_CODE_ENDPOINT,
  GITHUB_DEVICE_TOKEN_ENDPOINT,
  OAUTH_CALLBACK_PATH,
  OAUTH_SLOW_DOWN_STEP_MS,
} from '../src/contract.js'
import { createOAuthService, defaultRedirectUri } from '../src/oauth.js'
import type { OAuthDeps, OAuthService, OAuthStartInput, PostLike, PostRequest, PostResponse } from '../src/oauth.js'

const SENTINEL = 'ghp_SENTINEL_do_not_leak_0123456789'
const GITEE_SENTINEL = 'gitee_SENTINEL_do_not_leak_987654321'
const CLIENT_ID = 'Ov23liTESTCLIENTID'
const DEVICE_CODE = 'device_code_value_never_leaked'
const FIXED_NOW = 1_700_000_000_000

function ok(body: unknown, statusCode = 200): PostResponse {
  return { statusCode, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

function deviceCodeBody(): Record<string, unknown> {
  return {
    device_code: DEVICE_CODE,
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 1,
  }
}

interface Harness {
  readonly service: OAuthService
  readonly posts: PostRequest[]
  readonly writes: Array<{ readonly ref: string; readonly value: string }>
  readonly logs: Array<{ readonly event: string; readonly detail: Record<string, unknown> | undefined }>
  readonly sleeps: number[]
  advance(ms: number): void
}

interface HarnessOptions {
  readonly responses?: readonly (PostResponse | Error)[]
  readonly reachable?: boolean
  readonly credentialRef?: string
  /** Answer the preflight; defaults to reachable. */
  readonly probe?: (host: string) => { reachable: boolean; detail: string }
  /**
   * Take manual control of the poll intervals. Without it, `sleep` resolves on a
   * real (0ms) timer, which keeps the loop from draining the whole 15-minute TTL
   * inside one microtask turn while keeping the tests fast. With it, the test
   * decides exactly when each interval ends, so intermediate states such as
   * `slow_down` are deterministically observable.
   */
  readonly sleepGate?: boolean
}

interface Harness {
  readonly service: OAuthService
  readonly posts: PostRequest[]
  readonly writes: Array<{ readonly ref: string; readonly value: string }>
  readonly logs: Array<{ readonly event: string; readonly detail: Record<string, unknown> | undefined }>
  readonly sleeps: number[]
  /** Only meaningful with `sleepGate`: release the next interval. */
  releaseSleep(): Promise<void>
  advance(ms: number): void
}

/**
 * Thrown when a test queued fewer responses than the engine asked for. It is a
 * distinct class so it can never be confused with the deliberate network
 * failure under test (`new Error('ETIMEDOUT')`).
 */
class ExhaustedError extends Error {}

/**
 * Build a service whose clock only moves when `sleep` is called, so a
 * 15-minute polling loop runs in microseconds and the recorded sleep durations
 * are exactly the intervals the engine chose.
 */
function harness(options: HarnessOptions = {}): Harness {
  const posts: PostRequest[] = []
  const writes: Array<{ ref: string; value: string }> = []
  const logs: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const sleeps: number[] = []
  const queue = [...(options.responses ?? [])]
  const waiters: Array<() => void> = []
  let pendingSleeps = 0
  let clock = FIXED_NOW

  const post: PostLike = async (request) => {
    posts.push(request)
    const next = queue.shift()
    if (next === undefined) throw new ExhaustedError('fake transport exhausted: unexpected extra POST')
    if (next instanceof Error) throw next
    return next
  }

  const deps: OAuthDeps = {
    post,
    writeCredential: async (ref, value) => {
      writes.push({ ref, value })
    },
    credentialRefFor: () => options.credentialRef ?? 'DSH_CODEHUB_GITHUB_TOKEN',
    probeHost: async (host) => options.probe?.(host) ?? { reachable: options.reachable ?? true, detail: '' },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
      if (options.sleepGate === true) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          pendingSleeps += 1
        })
        return
      }
      // A real (0ms) timer keeps the loop from consuming the whole TTL inside
      // one microtask turn, without making the test wait real intervals.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    logger: (event, detail) => {
      logs.push({ event, detail })
    },
  }

  return {
    service: createOAuthService(deps),
    posts,
    writes,
    logs,
    sleeps,
    releaseSleep: async () => {
      // Wait for the loop to actually be blocked on an interval; the check is a
      // microtask, so this cannot spin for a macrotask.
      for (let spin = 0; spin < 1_000 && pendingSleeps === 0; spin += 1) {
        await Promise.resolve()
      }
      if (pendingSleeps === 0) return
      pendingSleeps -= 1
      waiters.shift()?.()
      // One microtask checkpoint: enough for the loop to post and reach the
      // next interval, so the caller's next `releaseSleep` always finds a
      // waiter. Microtasks (not timers) keep a TTL-length run fast.
      await Promise.resolve()
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function deviceInput(overrides: Partial<OAuthStartInput> = {}): OAuthStartInput {
  return { source: 'github', method: 'oauth-device', clientId: CLIENT_ID, ...overrides }
}

function giteeInput(overrides: Partial<OAuthStartInput> = {}): OAuthStartInput {
  return {
    source: 'gitee',
    method: 'oauth-code',
    clientId: CLIENT_ID,
    clientSecret: 'gitee-client-secret',
    redirectUri: `http://127.0.0.1:8080${OAUTH_CALLBACK_PATH}`,
    ...overrides,
  }
}

/** Poll until `check()` holds or a bounded number of macrotasks has passed. */
async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(check()).toBe(true)
}

/** Every observable string a flow can produce, flattened for sentinel scans. */
function observableText(values: readonly unknown[]): string {
  return JSON.stringify(values)
}

// ---------------------------------------------------------------------------
// GitHub device flow.
// ---------------------------------------------------------------------------

describe('GitHub 设备码流程', () => {
  it('预检不可达时返回 unavailable、给出 pat 兜底，且一个请求都不发', async () => {
    const test = harness({ probe: () => ({ reachable: false, detail: 'TCP 443 连接超时' }) })

    const started = await test.service.start(deviceInput())

    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('unreachable')
    expect(started.fallback).toEqual(['pat'])
    expect(started.reason).toContain('github.com')
    expect(postCount(test)).toBe(0)
  })

  it('申请设备码：只打官方主机、scope 为空、带 accept: application/json', async () => {
    const test = harness({ responses: [ok(deviceCodeBody()), ok({ access_token: SENTINEL })] })

    const started = await test.service.start(deviceInput())
    expect(started.ok).toBe(true)
    if (!started.ok || started.kind !== 'device') throw new Error('expected a device flow')

    expect(started.userCode).toBe('ABCD-1234')
    expect(started.verificationUri).toBe('https://github.com/login/device')
    expect(started.expiresInMs).toBe(900_000)
    expect(started.flowId).not.toBe('')

    const first = test.posts[0]
    expect(first?.url).toBe(GITHUB_DEVICE_CODE_ENDPOINT)
    expect(first?.url.startsWith('https://github.com/')).toBe(true)
    expect(first?.form).toEqual({ client_id: CLIENT_ID, scope: '' })
    expect(first?.headers).toEqual({ accept: 'application/json' })
    expect(typeof first?.timeoutMs).toBe('number')
  })

  it('成功：token 只交给 writeCredential，不出现在任何返回值或日志里', async () => {
    const test = harness({ responses: [ok(deviceCodeBody()), ok({ access_token: SENTINEL, token_type: 'bearer' })] })

    const started = await test.service.start(deviceInput())
    await until(() => test.writes.length === 1)

    expect(test.writes).toEqual([{ ref: 'DSH_CODEHUB_GITHUB_TOKEN', value: SENTINEL }])

    const statusResult = await test.service.status(started.ok ? started.flowId : '')
    expect(statusResult.state).toBe('done')
    expect(statusResult.credentialConfigured).toBe(true)

    const second = test.posts[1]
    expect(second?.url).toBe(GITHUB_DEVICE_TOKEN_ENDPOINT)
    expect(second?.form).toEqual({
      client_id: CLIENT_ID,
      device_code: DEVICE_CODE,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })

    // Invariant 1: the sentinel never appears in anything observable.
    const observable = observableText([started, statusResult, test.logs, test.posts.map((p) => p.form)])
    expect(observable).not.toContain(SENTINEL)
    // The engine is not allowed to log the device code either.
    expect(observableText(test.logs)).not.toContain(DEVICE_CODE)
  })

  it('authorization_pending 保持 pending 并按 interval 继续轮询', async () => {
    const test = harness({
      responses: [
        ok(deviceCodeBody()),
        ok({ error: 'authorization_pending' }),
        ok({ error: 'authorization_pending' }),
        ok({ access_token: SENTINEL }),
      ],
    })

    const started = await test.service.start(deviceInput())
    expect(started.ok).toBe(true)
    if (!started.ok || started.kind !== 'device') throw new Error('expected a device flow')

    const pending = await test.service.status(started.flowId)
    expect(pending.state).toBe('pending')
    expect(pending.credentialConfigured).toBe(false)

    await until(() => test.writes.length === 1)
    expect(test.posts).toHaveLength(4)
    // interval 1s from the provider, floored at 1s; every wait is that interval.
    expect(test.sleeps).toEqual([1_000, 1_000, 1_000])
  })

  it('slow_down 把间隔 +OAUTH_SLOW_DOWN_STEP_MS 并把状态置为 slow_down', async () => {
    const test = harness({
      responses: [ok(deviceCodeBody()), ok({ error: 'slow_down' }), ok({ access_token: SENTINEL })],
    })

    const started = await test.service.start(deviceInput())
    if (!started.ok) throw new Error('expected a device flow')

    await until(() => test.writes.length === 1)
    expect(test.sleeps).toEqual([1_000, 1_000 + OAUTH_SLOW_DOWN_STEP_MS])
    // Terminal state is `done`; the slow_down state was observable mid-flight.
    const statusResult = await test.service.status(started.ok ? started.flowId : '')
    expect(statusResult.state).toBe('done')
    expect(statusResult.intervalMs).toBe(1_000 + OAUTH_SLOW_DOWN_STEP_MS)
  })

  it('slow_down 进行中 status 报告 slow_down 与加长后的 interval', async () => {
    // Manual interval control: the first poll answers `slow_down`, every later
    // poll stays pending, so the loop cannot reach the TTL while the test looks.
    const test = harness({
      responses: [ok(deviceCodeBody()), ok({ error: 'slow_down' }), ...Array.from({ length: 8 }, () => ok({ error: 'authorization_pending' }))],
      sleepGate: true,
    })

    const started = await test.service.start(deviceInput())
    if (!started.ok) throw new Error('expected a device flow')
    await until(() => test.sleeps.length === 1)
    await test.releaseSleep() // ends interval #1 → the `slow_down` poll happens
    await until(() => test.sleeps.length === 2)

    const statusResult = await test.service.status(started.flowId)
    expect(test.sleeps).toEqual([1_000, 1_000 + OAUTH_SLOW_DOWN_STEP_MS])
    expect(statusResult.state).toBe('slow_down')
    expect(statusResult.intervalMs).toBe(1_000 + OAUTH_SLOW_DOWN_STEP_MS)
    test.service.cancel(started.flowId)
    await test.releaseSleep()
  })

  it.each([
    ['access_denied', '拒绝'],
    ['device_flow_disabled', 'Enable Device Flow'],
    ['incorrect_client_credentials', 'Client ID'],
    ['unsupported_grant_type', '授权类型'],
    ['incorrect_device_code', '设备码'],
  ])('%s 映射为可读中文文案且不写入凭据', async (error, expected) => {
    const test = harness({ responses: [ok(deviceCodeBody()), ok({ error })] })

    const started = await test.service.start(deviceInput())
    if (!started.ok) throw new Error('expected a device flow')
    let state = ''
    for (let index = 0; index < 200 && state !== 'error'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      state = (await test.service.status(started.flowId)).state
    }

    expect(state).toBe('error')
    const statusResult = await test.service.status(started.flowId)
    expect(statusResult.reason).toContain(expected)
    expect(test.writes).toHaveLength(0)
  })

  it('expired_token 置为 expired，超时（TTL）同样置为 expired', async () => {
    const expired = harness({ responses: [ok(deviceCodeBody()), ok({ error: 'expired_token' })] })
    const started = await expired.service.start(deviceInput())
    if (!started.ok) throw new Error('expected a device flow')
    let state = ''
    for (let index = 0; index < 200 && state !== 'expired'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      state = (await expired.service.status(started.flowId)).state
    }
    expect(state).toBe('expired')
    expect(expired.writes).toHaveLength(0)

    // A provider that answers "pending" for ever cannot outlive
    // `OAUTH_FLOW_TTL_MS`: the fake clock advances by one interval per release.
    const forever = harness({
      responses: [ok(deviceCodeBody()), ...Array.from({ length: 2_000 }, () => ok({ error: 'authorization_pending' }))],
      sleepGate: true,
    })
    const pending = await forever.service.start(deviceInput())
    if (!pending.ok) throw new Error('expected a device flow')
    // Drive the intervals until the flow leaves `pending`; the bound is above
    // `OAUTH_FLOW_TTL_MS / 1000` waits, so the TTL must be what ends it — not a
    // shortage of queued responses.
    for (let index = 0; index < 1_010; index += 1) {
      const state = (await forever.service.status(pending.flowId)).state
      if (state !== 'pending') break
      // Release a batch: the exact count is irrelevant, only that the clock is
      // driven past the TTL.
      for (let batch = 0; batch < 32; batch += 1) await forever.releaseSleep()
    }
    const finalState = await forever.service.status(pending.flowId)
    expect(finalState.state).toBe('expired')
    expect(finalState.reason).toContain('超时')
    expect(forever.writes).toHaveLength(0)
  })

  it('cancel 之后不再发任何请求', async () => {
    const test = harness({
      responses: [ok(deviceCodeBody()), ok({ error: 'authorization_pending' }), ok({ error: 'authorization_pending' })],
    })

    const started = await test.service.start(deviceInput())
    if (!started.ok) throw new Error('expected a device flow')
    await until(() => test.posts.length >= 2)

    test.service.cancel(started.flowId)
    const countAtCancel = test.posts.length
    // Give the loop every chance to misbehave: if it were still running, the
    // queued responses would be consumed here.
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(test.posts.length).toBe(countAtCancel)
    const statusResult = await test.service.status(started.flowId)
    expect(statusResult.state).toBe('error')
    expect(statusResult.reason).toContain('取消')
    expect(test.writes).toHaveLength(0)
  })

  it('status 对未知 flowId 返回 error 而不是抛错', async () => {
    const test = harness()
    const statusResult = await test.service.status('flow_does_not_exist')
    expect(statusResult.state).toBe('error')
    expect(statusResult.credentialConfigured).toBe(false)
  })

  it('source/method 不匹配时拒绝，且不发任何请求', async () => {
    const test = harness()
    const wrong = await test.service.start({ source: 'gitee', method: 'oauth-device', clientId: CLIENT_ID })
    expect(wrong.ok).toBe(false)
    if (wrong.ok) throw new Error('unreachable')
    expect(wrong.fallback).toEqual(['pat'])
    expect(test.posts).toHaveLength(0)
    expect(test.writes).toHaveLength(0)
  })

  it('设备码申请失败（HTTP 400）不触发轮询', async () => {
    const test = harness({ responses: [ok({ error: 'not_found' }, 404)] })
    const started = await test.service.start(deviceInput())
    expect(started.ok).toBe(false)
    expect(test.posts).toHaveLength(1)
  })

  it('post 抛错时返回网络文案而不是把异常抛给调用方', async () => {
    const test = harness({ responses: [new Error('ETIMEDOUT')] })
    const started = await test.service.start(deviceInput())
    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('unreachable')
    expect(started.fallback).toEqual(['pat'])
  })
})

function postCount(test: Harness): number {
  return test.posts.length
}

// ---------------------------------------------------------------------------
// Gitee authorization code flow.
// ---------------------------------------------------------------------------

describe('Gitee 授权码流程', () => {
  it('preflight 不可达时返回 unavailable，且不发请求', async () => {
    const test = harness({ probe: () => ({ reachable: false, detail: 'DNS 解析失败' }) })

    const started = await test.service.start(giteeInput())

    expect(started.ok).toBe(false)
    if (started.ok) throw new Error('unreachable')
    expect(started.fallback).toEqual(['pat'])
    expect(started.reason).toContain('gitee.com')
    expect(test.posts).toHaveLength(0)
  })

  it('authorizeUrl 带 client_id/redirect_uri/response_type/state，state 每次不同', async () => {
    const first = await harness().service.start(giteeInput())
    const second = await harness().service.start(giteeInput())

    if (!first.ok || first.kind !== 'redirect' || !second.ok || second.kind !== 'redirect') {
      throw new Error('expected redirect flows')
    }
    const url = new URL(first.authorizeUrl)
    expect(first.authorizeUrl.startsWith(GITEE_OAUTH_AUTHORIZE_ENDPOINT)).toBe(true)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:8080${OAUTH_CALLBACK_PATH}`)
    expect(url.searchParams.get('response_type')).toBe('code')
    const state = url.searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThanOrEqual(16)
    expect(new URL(second.authorizeUrl).searchParams.get('state')).not.toBe(state)
    expect(first.flowId).not.toBe(second.flowId)
    expect(first.expiresInMs).toBeGreaterThan(0)
  })

  it('未给 redirectUri 时用请求 Host 派生回调地址', () => {
    expect(defaultRedirectUri('127.0.0.1:8080')).toBe(`http://127.0.0.1:8080${OAUTH_CALLBACK_PATH}`)
    expect(defaultRedirectUri('localhost:3000')).toBe(`http://localhost:3000${OAUTH_CALLBACK_PATH}`)
    expect(defaultRedirectUri(undefined)).toBe(OAUTH_CALLBACK_PATH)
  })

  it('回调 state 不符 → 400 且不写凭据、不发 token 请求', async () => {
    const test = harness({ responses: [ok({ access_token: GITEE_SENTINEL })] })
    const started = await test.service.start(giteeInput())
    if (!started.ok) throw new Error('expected a redirect flow')

    const outcome = await test.service.handleCallback({ code: 'the-code', state: 'not-the-state' })

    expect(outcome.status).toBe(400)
    expect(outcome.html).not.toContain(GITEE_SENTINEL)
    expect(test.writes).toHaveLength(0)
    expect(test.posts).toHaveLength(0)
  })

  it('回调缺 code → 400 且不消费 state；同一 state 找回 code 后成功，成功即不可重放', async () => {
    const test = harness({ responses: [ok({ access_token: GITEE_SENTINEL })] })
    const started = await test.service.start(giteeInput())
    if (!started.ok || started.kind !== 'redirect') throw new Error('expected a redirect flow')
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? ''

    // A refresh/speculative hit without a code must not burn the state: the real
    // callback is still allowed to arrive.
    const missing = await test.service.handleCallback({ state })
    expect(missing.status).toBe(400)
    expect(test.writes).toHaveLength(0)
    expect(test.posts).toHaveLength(0)

    const success = await test.service.handleCallback({ code: 'the-code', state })
    expect(success.status).toBe(200)
    expect(test.writes).toHaveLength(1)

    // Single use: the state is consumed by the exchange, so a replay starts no
    // second exchange and writes nothing.
    const replay = await test.service.handleCallback({ code: 'the-code', state })
    expect(replay.status).toBe(400)
    expect(replay.html).not.toContain(GITEE_SENTINEL)
    expect(test.writes).toHaveLength(1)
    expect(test.posts).toHaveLength(1)
  })

  it('回调带 error → 400，不写凭据', async () => {
    const test = harness()
    const started = await test.service.start(giteeInput())
    if (!started.ok || started.kind !== 'redirect') throw new Error('expected a redirect flow')
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? ''

    const outcome = await test.service.handleCallback({ state, error: 'access_denied' })
    expect(outcome.status).toBe(400)
    expect(test.writes).toHaveLength(0)
  })

  it('成功回调：token 只交给 writeCredential，HTML 自关闭且不含凭据', async () => {
    const test = harness({ responses: [ok({ access_token: GITEE_SENTINEL })] })
    const started = await test.service.start(giteeInput())
    if (!started.ok || started.kind !== 'redirect') throw new Error('expected a redirect flow')
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? ''

    const outcome = await test.service.handleCallback({ code: 'the-code', state })

    expect(outcome.status).toBe(200)
    expect(outcome.html).toContain('登录成功')
    expect(outcome.html).toContain('window.close()')
    expect(test.writes).toEqual([{ ref: 'DSH_CODEHUB_GITHUB_TOKEN', value: GITEE_SENTINEL }])

    const exchange = test.posts[0]
    expect(exchange?.url).toBe(GITEE_OAUTH_TOKEN_ENDPOINT)
    expect(exchange?.form).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: CLIENT_ID,
      redirect_uri: `http://127.0.0.1:8080${OAUTH_CALLBACK_PATH}`,
      client_secret: 'gitee-client-secret',
    })

    const statusResult = await test.service.status(started.flowId)
    expect(statusResult.state).toBe('done')
    expect(statusResult.credentialConfigured).toBe(true)

    const observable = observableText([started, statusResult, outcome, test.logs])
    expect(observable).not.toContain(GITEE_SENTINEL)
    // The client secret is a credential too: it must not reach a log line.
    expect(observable).not.toContain('gitee-client-secret')
  })

  it('换 token 返回非 200 / 无 access_token → 400 且不写凭据', async () => {
    const noToken = harness({ responses: [ok({ error: 'invalid_grant' }, 400)] })
    const first = await noToken.service.start(giteeInput())
    if (!first.ok || first.kind !== 'redirect') throw new Error('expected a redirect flow')
    const failed = await noToken.service.handleCallback({
      code: 'bad',
      state: new URL(first.authorizeUrl).searchParams.get('state') ?? '',
    })
    expect(failed.status).toBe(400)
    expect(noToken.writes).toHaveLength(0)

    const emptyBody = harness({ responses: [ok('{}', 200)] })
    const second = await emptyBody.service.start(giteeInput())
    if (!second.ok || second.kind !== 'redirect') throw new Error('expected a redirect flow')
    const empty = await emptyBody.service.handleCallback({
      code: 'bad',
      state: new URL(second.authorizeUrl).searchParams.get('state') ?? '',
    })
    expect(empty.status).toBe(400)
    expect(emptyBody.writes).toHaveLength(0)
  })

  it('completeWithCode 手动兜底：无需活动流程，成功后返回 ok', async () => {
    const test = harness({ responses: [ok({ access_token: GITEE_SENTINEL })] })

    const outcome = await test.service.completeWithCode({
      code: 'pasted-code',
      clientId: CLIENT_ID,
      clientSecret: 'gitee-client-secret',
      redirectUri: `http://127.0.0.1:8080${OAUTH_CALLBACK_PATH}`,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.credentialConfigured).toBe(true)
    expect(test.writes).toEqual([{ ref: 'DSH_CODEHUB_GITHUB_TOKEN', value: GITEE_SENTINEL }])
    expect(observableText([outcome, test.logs])).not.toContain(GITEE_SENTINEL)
  })

  it('form 编码的 token 响应同样被解析（GitHub/Gitee 两种格式）', async () => {
    const test = harness({ responses: [ok(`access_token=${GITEE_SENTINEL}&token_type=bearer`)] })
    const outcome = await test.service.completeWithCode({
      code: 'pasted-code',
      clientId: CLIENT_ID,
      redirectUri: 'http://127.0.0.1:8080/cb',
    })
    expect(outcome.ok).toBe(true)
    expect(test.writes[0]?.value).toBe(GITEE_SENTINEL)
  })

  it('流程状态只在内存：状态查询不落盘，也没有任何持久化字段', async () => {
    const test = harness()
    const started = await test.service.start(giteeInput())
    if (!started.ok) throw new Error('expected a redirect flow')
    const statusResult = await test.service.status(started.flowId)
    // The status object is exactly the frozen contract shape — nothing else can
    // ride along, so no persistence handle exists.
    expect(Object.keys(statusResult).sort()).toEqual(
      ['credentialConfigured', 'flowId', 'intervalMs', 'reason', 'state'].sort(),
    )
  })

  it('授权码流程没有轮询器，TTL 到期由 status 懒判定为 expired', async () => {
    const test = harness()
    const started = await test.service.start(giteeInput())
    if (!started.ok || started.kind !== 'redirect') throw new Error('expected a redirect flow')
    expect(started.expiresInMs).toBeGreaterThan(0)

    test.advance(started.expiresInMs + 1)

    const statusResult = await test.service.status(started.flowId)
    expect(statusResult.state).toBe('expired')
    expect(statusResult.credentialConfigured).toBe(false)
    expect(test.writes).toHaveLength(0)

    // An expired state is no longer a valid target for a late callback.
    const late = await test.service.handleCallback({
      code: 'late-code',
      state: new URL(started.authorizeUrl).searchParams.get('state') ?? '',
    })
    expect(late.status).toBe(400)
    expect(test.writes).toHaveLength(0)
    expect(test.posts).toHaveLength(0)
  })
})
