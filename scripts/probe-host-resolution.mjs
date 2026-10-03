/**
 * Probe how the DSH host would resolve and evaluate a plugin's host half.
 *
 * `dsh --dump-config` only prints the composed tree — it never imports a module,
 * so it cannot reproduce an evaluation failure. To see the real error we have to
 * evaluate the bundle under the SAME resolution rules the host uses: relative to
 * the PROFILE's node_modules (where the SDK lives), not this repo's.
 *
 * Usage: node scripts/probe-host-resolution.mjs <profileNodeModulesDir>
 */

const profileNodeModules = process.argv[2]
if (profileNodeModules === undefined) {
  console.error('usage: node scripts/probe-host-resolution.mjs <profileNodeModulesDir>')
  process.exit(2)
}

const PLUGIN_ENTRY = 'file:///D:/dsh-codehub/lib/index.mjs'
const SPECS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  'schemastery',
  '@deepseek-ai/dsh-tools',
  'react',
]

const { createRequire } = await import('node:module')
// A require anchored in the profile: this is where the host resolves from.
const profileRequire = createRequire(`${profileNodeModules}/dsh-codehub/lib/index.mjs`)

console.log(`resolving from: ${profileNodeModules}/dsh-codehub/lib/\n`)

console.log('--- can each SDK specifier be resolved from the PROFILE? ---')
for (const spec of SPECS) {
  try {
    const resolved = profileRequire.resolve(spec)
    console.log(`  OK   ${spec}`)
    console.log(`       -> ${resolved}`)
  } catch (error) {
    console.log(`  FAIL ${spec}  (${error.code})`)
  }
}

console.log('\n--- evaluating the host half ---')
try {
  await import(PLUGIN_ENTRY)
  console.log('  EVALUATED OK')
} catch (error) {
  console.log(`  THREW  name=${error?.name} code=${error?.code ?? '(none)'}`)
  console.log(`  message: ${String(error?.message).slice(0, 400)}`)
  if (error?.stack) {
    console.log('  stack (top 6):')
    for (const line of String(error.stack).split('\n').slice(0, 6)) console.log(`    ${line.trim()}`)
  }
  process.exitCode = 1
}
