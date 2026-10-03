/**
 * Install dsh-codehub into a DSH profile from a local checkout.
 *
 * WHY A SCRIPT
 * ------------
 * Mounting a bundle in DSH takes TWO independent things, and getting only one
 * right fails silently:
 *
 *   1. the package must be RESOLVABLE — present in the profile's node_modules,
 *      listed in its package.json dependencies;
 *   2. the package must be MOUNTED — listed in `dsh.profile.bundles`, because
 *      that is what makes the profile boot merge the package's own
 *      `cordis.patch.yml` (its `insert` row) into the plugin tree.
 *
 * The official `dsh plugin --profile <name> add <pkg>` drives pnpm inside the
 * profile directory and reconciles (2) for you. It cannot be used here as-is
 * because this plugin is not published to any registry — it is a local
 * checkout. `link:` installs it, but pnpm knows nothing about `dsh.profile.
 * bundles`, so this script does step (2) explicitly and then verifies both.
 *
 * It is IDEMPOTENT and DRY-RUN BY DEFAULT. Pass --yes to actually write;
 * `--dry-run` always wins, so `--yes --dry-run` is a safe way to preview the
 * inverse of an applied change without touching anything. Every file it is
 * about to touch is first copied to `<file>.bak-codehub`.
 *
 * Usage:
 *   node scripts/install-into-profile.mjs --profile desktop              # preview install
 *   node scripts/install-into-profile.mjs --profile desktop --yes         # apply install
 *   node scripts/install-into-profile.mjs --profile desktop --uninstall   # preview uninstall
 *   node scripts/install-into-profile.mjs --profile desktop --yes --uninstall   # apply uninstall
 */

import { readFile, writeFile, copyFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-codehub'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const apply = flag('--yes') && !flag('--dry-run')
const uninstall = flag('--uninstall')
const profile = value('--profile')
const dshHome = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

if (profile === undefined) {
  console.error('usage: node scripts/install-into-profile.mjs --profile <name> [--yes] [--uninstall]')
  process.exit(2)
}

const profileDir = path.join(dshHome, 'profiles', profile)
const profilePkgPath = path.join(profileDir, 'package.json')
const profilePatchPath = path.join(profileDir, 'cordis.patch.yml')

const say = (line) => console.log(line)
const step = (line) => console.log(`\n== ${line}`)

/** Read a file, or undefined when it does not exist. */
async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Copy a file once to `<file>.bak-codehub` before its first modification. */
async function backup(file) {
  const bak = `${file}.bak-codehub`
  if ((await readIfPresent(bak)) === undefined) {
    await copyFile(file, bak)
    say(`   backed up -> ${path.basename(bak)}`)
  } else {
    say(`   backup already present -> ${path.basename(bak)}`)
  }
}

step(`profile: ${profileDir}`)
if ((await readIfPresent(profilePkgPath)) === undefined) {
  console.error(`no package.json at ${profilePkgPath}`)
  process.exit(2)
}

// ---- 1. the package itself must be built (lib/ is gitignored) -------------
const builtHost = path.join(ROOT, 'lib', 'index.mjs')
const builtClient = path.join(ROOT, 'lib', 'client.js')
for (const [label, file] of [['host bundle', builtHost], ['client bundle', builtClient]]) {
  try {
    await access(file)
    say(`   ok  ${label} present: ${path.relative(ROOT, file)}`)
  } catch {
    console.error(`   MISSING ${label}: ${path.relative(ROOT, file)} — run \`pnpm run build\` first.`)
    process.exit(2)
  }
}

// ---- 2. profile package.json: dependency + bundle row --------------------
const pkg = JSON.parse(await readIfPresent(profilePkgPath))
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

const depSpec = `link:${ROOT.replace(/\\/g, '/')}`
const hasDep = Object.hasOwn(pkg.dependencies, PKG_NAME)
const hasBundle = pkg.dsh.profile.bundles.includes(PKG_NAME)

step(uninstall ? 'removing the mount' : 'plan')
if (uninstall) {
  if (hasDep) say(`   - dependencies["${PKG_NAME}"]  (currently ${pkg.dependencies[PKG_NAME]})`)
  if (hasBundle) say(`   - dsh.profile.bundles[] entry "${PKG_NAME}"`)
  delete pkg.dependencies[PKG_NAME]
  const i = pkg.dsh.profile.bundles.indexOf(PKG_NAME)
  if (i !== -1) pkg.dsh.profile.bundles.splice(i, 1)
} else {
  if (hasDep) say(`   = dependencies["${PKG_NAME}"] already present (${pkg.dependencies[PKG_NAME]})`)
  else {
    say(`   + dependencies["${PKG_NAME}"] = "${depSpec}"`)
    pkg.dependencies[PKG_NAME] = depSpec
  }
  if (hasBundle) say(`   = dsh.profile.bundles[] already lists "${PKG_NAME}"`)
  else {
    say(`   + dsh.profile.bundles[] += "${PKG_NAME}"   (this is what mounts dsh.bundle.patch)`)
    pkg.dsh.profile.bundles.push(PKG_NAME)
  }
}

if (!apply) {
  say('\nDRY RUN — nothing written. Re-run with --yes to apply.')
  process.exit(0)
}

// ---- 3. write ------------------------------------------------------------
step('writing')
await backup(profilePkgPath)
await writeFile(profilePkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
say(`   wrote ${path.relative(dshHome, profilePkgPath)}`)

// ---- 4. verify -----------------------------------------------------------
step('verify')
const after = JSON.parse(await readIfPresent(profilePkgPath))
const expectDep = !uninstall
if (Object.hasOwn(after.dependencies, PKG_NAME) === expectDep) say(`   ok  dependency state matches (present=${expectDep})`)
else console.error('   FAIL dependency state unexpected')
const listed = after.dsh.profile.bundles.includes(PKG_NAME)
if (listed === expectDep) say(`   ok  bundle mount state matches (listed=${expectDep})`)
else console.error('   FAIL bundle mount state unexpected')

say(`
next:
  1. cd ${profileDir}
  2. pnpm install          # materialises the link: into node_modules
  3. restart the DSH desktop app (the host must re-compose the plugin tree)

rollback:
  node ${path.relative(ROOT, fileURLToPath(import.meta.url))} --profile ${profile} --yes --uninstall
  # or restore the .bak-codehub copies and re-run \`pnpm install\`
`)
