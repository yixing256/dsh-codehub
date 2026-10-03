/**
 * dsh-codehub — live network smoke test for the three source adapters.
 *
 * WHAT IT IS FOR
 * --------------
 * The unit suite never touches the network (adapters are tested through an
 * injected fake transport), so nothing in `pnpm test` proves the adapters can
 * parse a REAL response. This script fills exactly that gap: it runs each
 * adapter against the live endpoint and reports what actually came back.
 *
 * It is deliberately NOT part of `pnpm test` — it depends on the network, on
 * endpoints that rate-limit, and on one endpoint (CSDN) that is not a public
 * API. Run it by hand:
 *
 *     pnpm run smoke
 *
 * Readings, not assertions: a failure here may mean the endpoint moved, the
 * machine is offline, or the credential is missing — all of which are useful
 * facts rather than a broken build. Read the output before acting on it.
 *
 * Run with: node --experimental-strip-types scripts/smoke.ts   (Node 22+)
 *           node scripts/smoke.ts                             (Node 24+)
 */

import { createGithubAdapter } from '../src/sources/github.ts'
import { createGiteeAdapter } from '../src/sources/gitee.ts'
import { createCsdnAdapter } from '../src/sources/csdn.ts'
import { GITHUB_API_BASE, GITHUB_RAW_ORIGIN } from '../src/contract.ts'
import type { SourceAdapter } from '../src/sources/types.ts'
import type { TransportRequest, TransportResponse } from '../src/sources/types.ts'

/** Node's own outbound fetch, wrapped in the adapter transport contract. */
async function nodeTransport(request: TransportRequest): Promise<TransportResponse> {
  const response = await fetch(request.url, {
    headers: request.headers,
    redirect: 'follow',
    signal: request.signal ?? AbortSignal.timeout(request.timeoutMs),
  })
  const body = await response.text()
  return { statusCode: response.status, body, finalUrl: response.url }
}

const QUERY = 'axios interceptor'

/** Credentials are read from the environment for this script only. */
const GITHUB_TOKEN = process.env.DSH_CODEHUB_GITHUB_TOKEN ?? ''
const GITEE_TOKEN = process.env.DSH_CODEHUB_GITEE_TOKEN ?? ''

interface Report {
  source: string
  ok: boolean
  count: number
  failure?: string
  reason: string
  sample?: { title: string; url: string; language: string; confidence: string }
  notes?: string[]
}

/** Run one adapter and reduce its outcome to a printable row. */
async function probe(id: string, adapter: SourceAdapter): Promise<Report> {
  const notes: string[] = []
  try {
    const outcome = await adapter.search(QUERY, {
      transport: nodeTransport,
      timeoutMs: 15_000,
      maxItems: 3,
      token: id === 'github' ? GITHUB_TOKEN || undefined : id === 'gitee' ? GITEE_TOKEN || undefined : undefined,
      authenticated: id === 'github' ? GITHUB_TOKEN !== '' : id === 'gitee' ? GITEE_TOKEN !== '' : false,
      transportId: 'node',
      apiBase: GITHUB_API_BASE,
      // raw origin deliberately NOT offered as a mirror: this machine cannot
      // reach it (see README "已验证事实"). Passing it would just add a 15s
      // timeout to every deep read.
      rawMirrors: [],
      htmlFallback: false,
    })
    const first = outcome.results[0]
    return {
      source: adapter.id,
      ok: outcome.ok,
      count: outcome.results.length,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      reason: outcome.reason,
      ...(first === undefined
        ? {}
        : {
            sample: {
              title: first.title,
              url: first.url,
              language: first.language,
              confidence: first.confidence,
            },
          }),
      notes,
    }
  } catch (error) {
    return {
      source: id,
      ok: false,
      count: 0,
      failure: 'threw',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Confirm the raw origin really is unreachable, so the README claim stays true. */
async function probeRawOrigin(): Promise<string> {
  const url = `${GITHUB_RAW_ORIGIN}/octocat/Hello-World/master/README`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    return `reachable (HTTP ${response.status}) — the README claim is now STALE`
  } catch (error) {
    return `unreachable (${error instanceof Error ? error.message : String(error)}) — matches the README`
  }
}

const reports: Report[] = []
reports.push(await probe('github', createGithubAdapter()))
reports.push(await probe('gitee', createGiteeAdapter()))
reports.push(await probe('csdn', createCsdnAdapter()))

console.log('\n=== dsh-codehub live adapter smoke ===')
console.log(`query: ${JSON.stringify(QUERY)}  transport: node  auth: github=${GITHUB_TOKEN ? 'yes' : 'no'} gitee=${GITEE_TOKEN ? 'yes' : 'no'}\n`)
for (const report of reports) {
  console.log(`[${report.source}] ok=${report.ok} results=${report.count}${report.failure ? ` failure=${report.failure}` : ''}`)
  console.log(`  reason: ${report.reason}`)
  if (report.sample) {
    console.log(`  sample: ${report.sample.confidence} | ${report.sample.language || '(no language)'} | ${report.sample.title}`)
    console.log(`          ${report.sample.url}`)
  }
  console.log('')
}

console.log('=== raw origin reachability (README cross-check) ===')
console.log(`  ${GITHUB_RAW_ORIGIN}: ${await probeRawOrigin()}`)

// Node's own fetch has no egress on some machines (this one included), so a
// blanket `network` failure above is usually the TRANSPORT, not the adapter or
// the endpoint. Say so explicitly rather than letting the next reader chase a
// nonexistent parsing bug.
if (reports.every((report) => !report.ok && report.failure === 'network')) {
  console.log(`
note: every source failed with \`network\`, and this script only exercises the
      \`node\` transport. On a machine where this process has no direct egress
      that is the expected result, not an adapter bug — the plugin then relies on
      the DSH \`dsh-web\` channel, which this script cannot reach from outside the
      DSH process. See the "已验证事实" section of README.md.
`)
}
