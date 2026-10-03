/**
 * Boot a DSH profile and report whether dsh-codehub mounted cleanly.
 *
 * WHY THIS EXISTS
 * ---------------
 * typecheck/build/test were ALL green while the plugin was in fact broken on the
 * real runtime: the tool's `output.schema` used the sugar `required: true` on
 * properties, which the runtime's schema validator rejects — so
 * `learn_code_from_web` never registered, and nothing in the unit suite (all
 * fake transports, no live loader) could see it.
 *
 * Only a real boot exercises the loader's schema validator. This script runs one
 * and greps the output for our own mount diagnostics, so "the plugin mounted" is
 * an observed fact rather than an inference from green unit tests.
 *
 * Usage: node scripts/boot-check.mjs [profileName] [seconds]
 */

import { spawn } from 'node:child_process'

const profile = process.argv[2] ?? 'codehub-test'
const seconds = Number(process.argv[3] ?? 25)

// Resolved from dsh.cmd, which is a shim for exactly this invocation:
//   set ELECTRON_RUN_AS_NODE=1
//   "<exe>" --expose-internals <asar>\dsh\node_modules\...\dsh-desktop-host\lib\cli.js
//
// We spawn the executable directly rather than the `.cmd`, because Node 24
// refuses to spawn a .cmd/.bat without a shell (EINVAL), and going through a
// shell would mean capturing output through a pipe from a shell — both are
// needless failure modes here.
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

setTimeout(() => {
  // The profile serves a GUI, so it does not exit on its own — stop it and
  // report what it printed.
  child.kill()
}, seconds * 1000)

await Promise.race([done, new Promise((r) => setTimeout(r, (seconds + 5) * 1000))])

const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '')
console.log(`--- captured ${lines.length} output lines ---`)

const ours = lines.filter((line) => line.includes('dsh-codehub'))
console.log('\n--- dsh-codehub diagnostics ---')
for (const line of ours) console.log(`  ${line}`)

const problems = lines.filter(
  (line) =>
    line.includes('dsh-codehub') &&
    /失败|error|Error|unsupported|cannot|Cannot/.test(line),
)

console.log('\n--- verdict ---')
const mounted = ours.some((line) => line.includes('已挂载'))
const toolRegistered = ours.some((line) => line.includes('工具已注册'))
const toolFailed = problems.some((line) => line.includes('tool'))

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
