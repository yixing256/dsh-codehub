/**
 * Boot a DSH profile, report whether dsh-codehub mounted, and fetch the plugin's
 * served client bundle.
 *
 * WHY THIS EXISTS
 * ---------------
 * typecheck/build/test were ALL green while the plugin was in fact broken on the
 * real runtime: the tool's `output.schema` used the sugar `required: true` on
 * properties, which the runtime's schema validator rejects — so
 * `learn_code_from_web` never registered, and nothing in the unit suite (all fake
 * transports, no live loader) could see it. Only a real boot exercises that
 * validator.
 *
 * This also fetches `/plugins/<id>/client.js`, which is the only way to check
 * the BROWSER half without a browser: it proves the module-loader route serves
 * our wrapped artifact rather than failing to compose it. It cannot prove the
 * bundle's runtime behaviour in the page.
 *
 * WHAT THIS SCRIPT CANNOT CATCH — and what does
 * ---------------------------------------------
 * It boots the CLI/host profile, so it does NOT reproduce a browser-half
 * activation failure. A later incident proved the gap: the client bundle
 * declared `inject: [slots, locale, settingsScope]`, `settingsScope` is not a
 * client service, and the Electron app aborted with
 * `web boot: 1 entry did not activate / dsh-codehub: pending (waiting for
 * service: settingsScope)` — while this script still reported the host half
 * mounted. Browser-half contracts are guarded by
 * `test/inject-contract.test.ts` (source-text, deterministic) instead.
 *
 * Usage: node scripts/boot-check.mjs [profileName] [seconds] [port]
 */

import { spawn } from 'node:child_process'

const profile = process.argv[2] ?? 'codehub-test'
const seconds = Number(process.argv[3] ?? 25)
const port = Number(process.argv[4] ?? 19388)

// Resolved from dsh.cmd, which is a shim for exactly this invocation:
//   set ELECTRON_RUN_AS_NODE=1
//   "<exe>" --expose-internals <asar>\...\dsh-desktop-host\lib\cli.js
//
// We spawn the executable directly rather than the `.cmd`, because Node 24
// refuses to spawn a .cmd/.bat without a shell (EINVAL).
const EXE = 'D:\\deepseek_desktop\\DeepSeek Harness.exe'
const CLI = 'D:\\deepseek_desktop\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'

console.log(`booting profile "${profile}" for ${seconds}s …\n`)

const child = spawn(EXE, ['--expose-internals', CLI, '--profile', profile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

let output = ''
const collect = (chunk) => {
  output += chunk.toString('utf8')
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

const done = new Promise((resolve) => {
  child.on('exit', (code) => resolve(code))
})

// Give the server a moment, then probe the client bundle while it is up.
let clientReport = 'not probed'
const probeAt = Math.max(5, Math.min(seconds - 5, 15)) * 1000
const probe = new Promise((resolve) => {
  setTimeout(async () => {
    const url = `http://127.0.0.1:${port}/plugins/dsh-codehub/client.js`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const body = await response.text()
      const wrapped = body.includes('window.__ModuleLoader__.load(')
      const exposesApply = body.includes('exports.apply = apply')
      const exposesInject = body.includes('exports.inject = inject')
      clientReport = `HTTP ${response.status}, ${body.length}B, wrapped=${wrapped}, apply=${exposesApply}, inject=${exposesInject}`
      if (response.status !== 200 || !wrapped || !exposesApply) {
        clientReport += '  <-- PROBLEM'
        process.exitCode = 1
      }
    } catch (error) {
      clientReport = `fetch failed: ${error instanceof Error ? error.message : String(error)}`
    }
    resolve()
  }, probeAt)
})

setTimeout(() => {
  // The profile serves a GUI, so it does not exit on its own — stop it.
  child.kill()
}, seconds * 1000)

await Promise.race([done, new Promise((r) => setTimeout(r, (seconds + 5) * 1000))])
await probe

const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '')
console.log(`--- captured ${lines.length} output lines ---`)

const ours = lines.filter((line) => line.includes('dsh-codehub'))
console.log('\n--- dsh-codehub diagnostics ---')
for (const line of ours) console.log(`  ${line}`)

console.log(`\n--- served client bundle (${`/plugins/dsh-codehub/client.js`}) ---`)
console.log(`  ${clientReport}`)

const problems = lines.filter(
  (line) => line.includes('dsh-codehub') && /失败|error|Error|unsupported|cannot|Cannot/.test(line),
)

console.log('\n--- verdict ---')
const mounted = ours.some((line) => line.includes('已挂载'))
const toolRegistered = ours.some((line) => line.includes('工具已注册'))

if (problems.length > 0) {
  console.log(`FAIL  ${problems.length} dsh-codehub problem line(s):`)
  for (const line of problems) console.log(`      ${line.slice(0, 300)}`)
  process.exitCode = 1
} else if (!mounted) {
  console.log('INCONCLUSIVE  no mount diagnostic captured (did the profile boot at all?)')
  process.exitCode = 1
} else {
  console.log(`OK    host half mounted; tool registered = ${toolRegistered}`)
}
