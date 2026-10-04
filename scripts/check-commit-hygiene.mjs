/**
 * dsh-codehub — commit hygiene: the user's own settings and credentials must never
 * be committable.
 *
 * WHY THIS EXISTS AS A SCRIPT
 * ---------------------------
 * The promise "保证我现在已经保存的设置配置不提交上去" cannot be kept by being careful
 * once. Two things about this plugin make an accident likely rather than theoretical:
 *
 *   1. The plugin WRITES a real config file — `$DSH_HOME/dsh-codehub.json` holds the
 *      fallback snapshot with the user's answers (source order, access priority, the
 *      CSDN switches) whenever the settings RPC refuses our namespace. If `DSH_HOME`
 *      ever points inside a checkout, that file lands in the working tree.
 *   2. Debugging the plugin involves pasting real tokens/cookies into terminals and
 *      scratch files, and `config.local.yml` / `.env` are the documented places for
 *      exactly that.
 *
 * So this script answers two questions against the CURRENT working tree, i.e. the
 * exact set a `git add -A` would stage:
 *
 *   A. Is any file committable that should never be — credentials, local overlays,
 *      a DSH profile directory, a session dump, or `$DSH_HOME` sitting inside the repo?
 *   B. Does any committable text file CONTAIN a high-signal credential shape?
 *
 * It is deliberately narrow on content: a sentinel, a placeholder or a document that
 * *talks about* tokens must not fail the gate, or the gate gets disabled and stops
 * protecting anything. Every flagged match can be reviewed by a human in one line.
 *
 * Run: node scripts/check-commit-hygiene.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const notes = []
const failures = []
const ok = (label) => notes.push(`  ok   ${label}`)
const fail = (label) => failures.push(label)

// ---------------------------------------------------------------------------
// A. the committable file set
// ---------------------------------------------------------------------------

/** Tracked files plus untracked-but-not-ignored ones: exactly what a commit sees. */
function committableFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort()
}

/**
 * Paths that must never be committed.
 *
 * `.env.example` and `config.example.yml` are TEMPLATES and are expected to be
 * committed — the point of them is to show the shape with empty values — so they are
 * excluded by name rather than by extension.
 */
const ALLOWED_TEMPLATES = new Set(['.env.example', 'config.example.yml'])
const DENY_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/,
  /\.local\.ya?ml$/,
  /\.token$/,
  /\.key$/,
  /\.pem$/,
  /(^|[-_.])credentials?\.json$/,
  /^(id_rsa|id_ed25519)(\.pub)?$/,
]
const DENY_PATH_SEGMENTS = ['profiles/', 'sessions/', 'plugins/', 'node_modules/', '/.dsh/']

function pathProblem(file) {
  const base = path.basename(file)
  if (ALLOWED_TEMPLATES.has(base)) return undefined
  for (const pattern of DENY_BASENAME_PATTERNS) {
    if (pattern.test(base)) return `文件名看起来是凭据 / 本地覆盖：${base}`
  }
  const normalised = `/${file.split(path.sep).join('/')}`
  for (const segment of DENY_PATH_SEGMENTS) {
    if (normalised.includes(`/${segment}`)) return `路径落在不该提交的目录里：${segment}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// B. content shapes
// ---------------------------------------------------------------------------

/**
 * Obvious fakes. A test sentinel or a documentation placeholder must pass, or the
 * gate becomes noise and someone turns it off.
 */
const FAKE_MARKERS = [
  'sentinel',
  'do_not_leak',
  'donotuse',
  'placeholder',
  'example',
  'fake',
  'dummy',
  'redacted',
  'your-',
  'xxxx',
  '<',
  '${',
]

/**
 * Shapes a REAL credential has and a sentence does not. Applied to every file,
 * including tests: a genuine PAT pasted into a test is exactly the accident this is
 * for, and the length/entropy bounds are what keep short test words out.
 */
const HARD_PATTERNS = [
  // Real GitHub PATs are 36+ characters; `ghp_supersecrettokenvalue` (a test word) is not.
  { label: 'GitHub token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
]

/**
 * `TOKEN = <long opaque value>` — how a real credential reaches a `.env`, a `.yml`,
 * or a `const X_SECRET = '…'` line in source.
 *
 * FOUR RESTRICTIONS, each earned by a miss or a false positive during self-testing:
 *   • the value must be a QUOTED literal (or, for the yml/env form, a bare token at
 *     end of line) — this is what keeps `const token = payload.access_token` in
 *     `src/oauth.ts` out, since that is an expression, not a secret;
 *   • the key must END with the secret word (`API_KEY`, `LEAK_PROBE_SECRET`), not
 *     merely contain it;
 *   • obvious fakes (sentinel / example / placeholder …) are skipped;
 *   • test files are skipped for THIS pattern: they are supposed to hold fake
 *     credentials, and flagging them trains people to ignore the gate. Their content
 *     is still checked by HARD_PATTERNS.
 */
const ASSIGNED_LITERAL_PATTERN =
  /[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|COOKIE|PASSWORD|PASSWD|API[_-]?KEY)\s*[:=]\s*(['"])([^'"\n]{16,})\1/g
const ASSIGNED_BARE_PATTERN =
  /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:TOKEN|SECRET|COOKIE|PASSWORD|PASSWD|API[_-]?KEY)[A-Z0-9_]*[ \t]*[:=][ \t]*([A-Za-z0-9_\-/+=]{16,})[ \t]*$/gim

function isTestFile(relative) {
  const normalised = relative.split(path.sep).join('/')
  return normalised.startsWith('test/') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalised)
}

/** Files we never need to read: binaries and build output. */
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.zip', '.mjs.map'])
const MAX_BYTES = 1024 * 1024

function contentProblems(absolute, relative) {
  if (SKIP_EXTENSIONS.has(path.extname(relative).toLowerCase())) return []
  let text
  try {
    if (statSync(absolute).size > MAX_BYTES) return []
    text = readFileSync(absolute, 'utf8')
  } catch {
    return []
  }
  // A file that is not valid UTF-8 text yields replacement characters in bulk; skip it.
  if ((text.match(/\uFFFD/g) ?? []).length > 16) return []

  const found = []
  const record = (label, snippet, index) => {
    const lower = snippet.toLowerCase()
    if (FAKE_MARKERS.some((marker) => lower.includes(marker))) return
    // An expression is not a literal: `token = payload.access_token`.
    if (/[.()?]/.test(snippet)) return
    const line = text.slice(0, index).split('\n').length
    found.push(`${relative}:${line} 形如「${label}」：${snippet.slice(0, 24)}…`)
  }

  for (const { label, pattern } of HARD_PATTERNS) {
    for (const match of text.matchAll(pattern)) record(label, match[0], match.index ?? 0)
  }
  if (!isTestFile(relative)) {
    for (const match of text.matchAll(ASSIGNED_LITERAL_PATTERN)) {
      record('assigned secret', match[2] ?? match[0], match.index ?? 0)
    }
    for (const match of text.matchAll(ASSIGNED_BARE_PATTERN)) {
      record('assigned secret', match[1] ?? match[0], match.index ?? 0)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

let files
try {
  files = committableFiles()
} catch (error) {
  console.error(`无法列出可提交文件（git 不可用？）：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

/**
 * What is ALREADY STAGED, checked separately.
 *
 * `git ls-files` cannot see this trap: an ignored file added with `git add -f` is
 * invisible to `--exclude-standard` but is exactly what gets committed. So the index
 * is inspected on its own terms.
 */
let staged = []
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
} catch {
  staged = []
}

if (files.length === 0 && staged.length === 0) {
  fail('可提交文件列表为空 —— git 状态异常，拒绝给出"干净"的结论')
}

const pathFailures = []
for (const file of files) {
  const problem = pathProblem(file)
  if (problem !== undefined) pathFailures.push(`${file} —— ${problem}`)
}
if (pathFailures.length === 0) ok(`${files.length} 个可提交文件里没有凭据 / 本地覆盖 / profile 目录`)
else for (const item of pathFailures) fail(item)

const contentFailures = []
for (const file of files) {
  contentFailures.push(...contentProblems(path.join(ROOT, file), file))
}
if (contentFailures.length === 0) ok('可提交文件的内容里没有高信号凭据形状')
else for (const item of contentFailures) fail(item)

// The index, on its own terms (catches `git add -f` on an ignored file).
const stagedFailures = []
for (const file of staged) {
  const problem = pathProblem(file)
  if (problem !== undefined) stagedFailures.push(`${file}（已暂存）—— ${problem}`)
  stagedFailures.push(...contentProblems(path.join(ROOT, file), `${file}（已暂存）`))
}
if (stagedFailures.length === 0) {
  ok(staged.length === 0 ? '暂存区为空' : `暂存区的 ${staged.length} 个文件同样干净（含 git add -f 的情况）`)
} else {
  for (const item of stagedFailures) fail(item)
}

/**
 * The one arrangement that would put the user's SAVED SETTINGS into the repo: a
 * `DSH_HOME` that resolves inside the checkout. The store is the plugin's own file,
 * so this is checked rather than assumed.
 */
const dshHome = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const resolvedHome = path.resolve(dshHome)
const insideRepo = resolvedHome === ROOT || resolvedHome.startsWith(`${ROOT}${path.sep}`)
if (insideRepo) {
  fail(`DSH_HOME 落在仓库内（${resolvedHome}）：插件的 0600 配置快照会被写进工作树`)
} else {
  ok(`DSH_HOME 在仓库之外（${resolvedHome}）—— 保存的设置不会被提交`)
}

/** And the store file itself must not be tracked, wherever it lives. */
const storeNames = ['dsh-codehub.json']
const trackedStore = files.filter((file) => storeNames.includes(path.basename(file)))
if (trackedStore.length === 0) ok('可提交文件里没有任何 dsh-codehub.json 快照')
else for (const item of trackedStore) fail(`插件的配置快照出现在可提交列表里：${item}`)

console.log('=== dsh-codehub commit hygiene ===')
for (const line of notes) console.log(line)
if (failures.length > 0) {
  console.log(`\nFAILED (${failures.length}):`)
  for (const line of failures) console.log(`  FAIL ${line}`)
  console.log('\n请先处理上面每一项，再提交。若某项确认是误报，请改这个脚本的判定规则，而不是跳过它。')
  process.exitCode = 1
} else {
  console.log(`\nall ${notes.length} hygiene checks passed — 当前工作树可以安全提交`)
}
