/**
 * dsh-codehub — 思路摘要（备注③）.
 *
 * What this module produces is a THINKING SUMMARY: 实现思路 / API 用法 / 取舍 / 坑.
 * It is not a code rewriter, and it must never emit a block of source. The
 * extraction pipeline enforces that structurally, in this order:
 *
 *   1. `stripCodeBlocks()` removes fenced blocks, `<pre>` blocks and
 *      indented code runs before anything is read as prose;
 *   2. `looksLikeCode()` drops any surviving line that is code-shaped;
 *   3. `cleanProse()` caps every bullet and drops markup-only fragments;
 *   4. `SUMMARY_LIMITS` caps bullets per section and the whole summary.
 *
 * 备注③ result field: `summarize()` returns the `learned_summary` string.
 */

/** Category keys, in render order. */
export interface SummarySections {
  readonly approach: readonly string[]
  readonly apiContract: readonly string[]
  readonly tradeoffs: readonly string[]
  readonly pitfalls: readonly string[]
}

/** Text a result row can offer to the summarizer. All fields optional. */
export interface SummaryInput {
  readonly title?: string
  readonly description?: string
  readonly readme?: string
  readonly body?: string
  /** Extra prose (e.g. a repo's `package.json` description, a README section). */
  readonly extras?: readonly string[]
  /** Detected language, used only for the fallback sentence. */
  readonly language?: string
}

/** Bounds that keep a summary a summary. Exported so tests can assert them. */
export const SUMMARY_LIMITS = {
  maxBulletsPerSection: 3,
  maxBulletChars: 220,
  maxTotalChars: 1_200,
  minBulletChars: 6,
} as const

type Category = keyof SummarySections

// ---------------------------------------------------------------------------
// Keyword tables. ASCII keywords match on word boundaries; CJK ones substring.
// ---------------------------------------------------------------------------

const APPROACH_KEYWORDS = [
  '思路',
  '实现',
  '原理',
  '架构',
  '设计',
  '流程',
  '机制',
  '做法',
  '方案',
  '通过',
  '首先',
  '然后',
  '接着',
  '最后',
  '整体',
  '结构',
  'overview',
  'architecture',
  'approach',
  'design',
  'implementation',
  'pipeline',
  'workflow',
  'how it works',
  'structure',
  'pattern',
] as const

const API_KEYWORDS = [
  '接口',
  '用法',
  '参数',
  '返回值',
  '返回',
  '调用',
  '签名',
  '配置项',
  '导入',
  '依赖',
  '方法',
  '函数',
  '属性',
  '回调',
  '钩子',
  '组件',
  '字段',
  '命令',
  'usage',
  'signature',
  'parameter',
  'argument',
  'endpoint',
  'method',
  'option',
  'flag',
  'callback',
  'hook',
  'props',
  'instance',
  'export',
  'install',
  'config',
  'default',
] as const

const TRADEOFF_KEYWORDS = [
  '取舍',
  '权衡',
  '对比',
  '相比',
  '优点',
  '缺点',
  '优势',
  '劣势',
  '代价',
  '替代',
  '更合适',
  '推荐用',
  '性能',
  '体积',
  '兼容',
  'tradeoff',
  'trade-off',
  'versus',
  'downside',
  'upside',
  'pros',
  'cons',
  'alternative',
  'instead',
  'prefer',
  'faster',
  'slower',
  'overhead',
] as const

const PITFALL_KEYWORDS = [
  '坑',
  '踩坑',
  '注意',
  '警告',
  '小心',
  '避免',
  '不要',
  '不能',
  '无法',
  '报错',
  '异常',
  '失败',
  '限制',
  '缺陷',
  '坑点',
  '容易',
  '务必',
  '切记',
  'gotcha',
  'pitfall',
  'caveat',
  'warning',
  'limitation',
  'avoid',
  'fails',
  'breaks',
  'crash',
  'issue',
  'bug',
  'must not',
  'deprecated',
] as const

interface Compiled {
  readonly re: RegExp | null
  readonly text: string
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compile(keywords: readonly string[]): readonly Compiled[] {
  return keywords.map((keyword) => {
    const text = keyword.toLowerCase()
    const ascii = /^[\x20-\x7e]+$/.test(text)
    return { text, re: ascii ? new RegExp(`\\b${escapeRegExp(text)}\\b`) : null }
  })
}

const COMPILED: Readonly<Record<Category, readonly Compiled[]>> = {
  approach: compile(APPROACH_KEYWORDS),
  apiContract: compile(API_KEYWORDS),
  tradeoffs: compile(TRADEOFF_KEYWORDS),
  pitfalls: compile(PITFALL_KEYWORDS),
}

/** Tie-break order when one sentence hits several categories. */
const PRIORITY: readonly Category[] = ['pitfalls', 'tradeoffs', 'apiContract', 'approach']

/** Page chrome that must never become a "takeaway". */
const NOISE_PATTERNS: readonly RegExp[] = [
  /^(目录|登录|注册|首页|上一篇|下一篇|相关推荐|热门文章|最新文章|推荐文章|展开|收起|点赞|收藏|评论|分享)$/,
  /(版权声明|本文为博主原创文章|转载请注明|未经许可|扫码关注|微信公众号|订阅|广告|赞助)/,
  /(阅读量|浏览量|点赞数|收藏数|评论数|发布于|更新时间)\s*[:：]?/,
  /^(https?:\/\/\S+)$/i,
  /^\s*[|·•\-—_=+*]{3,}\s*$/,
]

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  times: '×',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
}

function fromCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** Decode the HTML entities that appear in search payloads. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => fromCodePoint(Number.parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, dec: string) => fromCodePoint(Number.parseInt(dec, 10), match))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => ENTITIES[name] ?? match)
}

/** Strip markup, keeping text content. Inline `<code>` survives (API names matter). */
export function stripHtml(text: string): string {
  return decodeEntities(
    text
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|td|h[1-6]|section|article|blockquote|ul|ol|table)>/gi, '\n')
      .replace(/<(pre|code|textarea|figure)\b[^>]*>/gi, '\n')
      .replace(/<\/(pre|code|textarea|figure)>/gi, '\n'),
  ).replace(/<[^>]*>/g, ' ')
}

/** Remove fenced blocks, `<pre>` blocks and indented code runs. */
export function stripCodeBlocks(text: string): string {
  const withoutFences = text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/<(pre|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/```[\s\S]*$/g, '\n')

  const kept: string[] = []
  for (const rawLine of withoutFences.split(/\r?\n/)) {
    if (/^(?: {4,}|\t)/.test(rawLine)) continue
    kept.push(rawLine)
  }
  return kept.join('\n')
}

/** True when a line is code-shaped rather than prose. */
export function looksLikeCode(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false

  const STARTS = [
    'import ',
    'export ',
    'from ',
    'const ',
    'let ',
    'var ',
    'function ',
    'class ',
    'interface ',
    'enum ',
    'def ',
    'async def',
    'return ',
    'yield ',
    'if (',
    'for (',
    'while (',
    'switch (',
    'catch (',
    'else {',
    'try {',
    'throw ',
    'public ',
    'private ',
    'protected ',
    'static ',
    'package ',
    '#include',
    '#define',
    'using ',
    'namespace ',
    'impl ',
    'fn ',
    'pub ',
    'struct ',
    'module.exports',
    'require(',
    'console.',
    'print(',
    'fmt.',
    '<?php',
    '<!DOCTYPE',
  ]
  for (const start of STARTS) {
    if (trimmed.startsWith(start)) return true
  }

  if (/^[)\]}]/.test(trimmed)) return true
  if (/[{};]\s*$/.test(trimmed) && /[(){}=]/.test(trimmed)) return true
  if (/^(?:sudo|npm|pnpm|yarn|npx|git|docker|curl|cargo|go|pip)\s/.test(trimmed)) return true

  const operators = trimmed.match(/=>|->|::|\$\{|===|!==|&&|\|\||\+=|-=|\*=|\/=|!=|==|\+\+|--/g)
  if (operators !== null && operators.length >= 2) return true

  const symbols = trimmed.match(/[(){}\[\]=;<>|&]/g)
  if (symbols !== null && trimmed.length >= 16 && symbols.length / trimmed.length > 0.2) return true

  return false
}

/** Strip markdown decorations from one prose fragment. */
export function stripMarkdown(line: string): string {
  return decodeEntities(
    line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~]/g, ''),
  )
}

function headingText(line: string): string | null {
  const hash = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
  if (hash !== null) return hash[2] ?? null
  const bold = /^\s*\*\*(.+?)\*\*\s*[:：]?\s*$/.exec(line)
  if (bold !== null) return bold[1] ?? null
  const bracket = /^\s*【(.+?)】\s*[:：]?\s*$/.exec(line)
  if (bracket !== null) return bracket[1] ?? null
  return null
}

function scoreCategory(lower: string, category: Category): number {
  let hits = 0
  for (const keyword of COMPILED[category]) {
    const matched = keyword.re !== null ? keyword.re.test(lower) : lower.includes(keyword.text)
    if (matched) hits += 1
  }
  return hits
}

function categoryOf(text: string): Category | null {
  const lower = text.toLowerCase()
  let best: Category | null = null
  let bestHits = 0
  for (const category of PRIORITY) {
    const hits = scoreCategory(lower, category)
    if (hits > bestHits) {
      best = category
      bestHits = hits
    }
  }
  return best
}

/** Split prose into sentence-ish fragments (CJK punctuation, then latin periods). */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const chunk of text.split(/[。！？!?；;\n]+/)) {
    const trimmed = chunk.trim()
    if (trimmed.length === 0) continue
    for (const latin of trimmed.split(/\.\s+(?=[A-Z(])/)) {
      const piece = latin.trim().replace(/\.$/, '').trim()
      if (piece.length > 0) out.push(piece)
    }
  }
  return out
}

function letterCount(text: string): number {
  const matched = text.match(/[\p{L}\p{N}]/gu)
  return matched === null ? 0 : matched.length
}

function isNoise(text: string): boolean {
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(text)) return true
  }
  return false
}

/** Clean one candidate fragment, or null when it is not usable prose. */
export function cleanProse(fragment: string): string | null {
  const stripped = stripMarkdown(fragment).replace(/\s+/g, ' ').trim()
  if (stripped.length < SUMMARY_LIMITS.minBulletChars) return null
  if (letterCount(stripped) < SUMMARY_LIMITS.minBulletChars) return null
  if (looksLikeCode(stripped)) return null
  if (isNoise(stripped)) return null
  if (/^[\s\p{P}\p{S}]+$/u.test(stripped)) return null
  if (stripped.length > SUMMARY_LIMITS.maxBulletChars) {
    return `${stripped.slice(0, SUMMARY_LIMITS.maxBulletChars - 1)}…`
  }
  return stripped
}

function pushUnique(bucket: string[], value: string): void {
  if (bucket.includes(value)) return
  bucket.push(value)
}

/**
 * Extract the four takeaway buckets from raw text. Code is removed before
 * reading, so no bullet can be a line of source.
 */
export function extractSections(text: string): SummarySections {
  const buckets: Record<Category, string[]> = { approach: [], apiContract: [], tradeoffs: [], pitfalls: [] }
  const prose = stripHtml(stripCodeBlocks(text))
  let bias: Category | null = null

  for (const rawLine of prose.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    const heading = headingText(line)
    if (heading !== null) {
      bias = categoryOf(heading)
      continue
    }

    if (looksLikeCode(line)) continue

    for (const sentence of splitSentences(line)) {
      const clean = cleanProse(sentence)
      if (clean === null) continue
      const category = categoryOf(clean) ?? bias ?? 'approach'
      pushUnique(buckets[category], clean)
    }
  }

  const cap = (items: string[]): readonly string[] =>
    items.slice(0, SUMMARY_LIMITS.maxBulletsPerSection)

  return {
    approach: cap(buckets.approach),
    apiContract: cap(buckets.apiContract),
    tradeoffs: cap(buckets.tradeoffs),
    pitfalls: cap(buckets.pitfalls),
  }
}

const SECTION_LABELS: Readonly<Record<Category, string>> = {
  approach: '实现思路',
  apiContract: 'API 用法',
  tradeoffs: '取舍',
  pitfalls: '坑',
}

function renderSection(category: Category, items: readonly string[]): string {
  if (items.length === 0) return ''
  return `${SECTION_LABELS[category]}：${items.join('；')}`
}

/** Render the four buckets as the `learned_summary` string. */
export function renderSummary(sections: SummarySections): string {
  const parts: string[] = []
  for (const category of ['approach', 'apiContract', 'tradeoffs', 'pitfalls'] as const) {
    const rendered = renderSection(category, sections[category])
    if (rendered.length > 0) parts.push(rendered)
  }
  if (parts.length === 0) return '未能从该来源文本中抽取出可读的思路要点（原文可能以代码为主）。'
  const joined = parts.join('\n')
  if (joined.length <= SUMMARY_LIMITS.maxTotalChars) return joined
  return `${joined.slice(0, SUMMARY_LIMITS.maxTotalChars - 1)}…`
}

/** Summarize one text blob. */
export function summarizeText(text: string): string {
  return renderSummary(extractSections(text))
}

/** Summarize a mixed payload: title / description / README / body / extras. */
export function summarize(input: SummaryInput): string {
  // The title is deliberately NOT fed into the extractor: a title such as
  // 「使用 X 的三个坑」 would otherwise become a heading and bias every later
  // sentence into `pitfalls`. It is used only by the fallback below.
  const chunks: string[] = []
  if (typeof input.description === 'string') chunks.push(input.description)
  if (typeof input.readme === 'string') chunks.push(input.readme)
  if (typeof input.body === 'string') chunks.push(input.body)
  const extras = input.extras
  if (extras !== undefined) {
    for (const extra of extras) {
      if (typeof extra === 'string') chunks.push(extra)
    }
  }

  const summary = renderSummary(extractSections(chunks.join('\n\n')))
  if (!summary.startsWith('未能从该来源文本中抽取出可读的思路要点')) return summary

  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title.length > 0) {
    const language = typeof input.language === 'string' && input.language.length > 0 ? `（${input.language}）` : ''
    return `仅命中标题信息${language}：${title}；未从原文抽取出可读的思路要点。`
  }
  return summary
}

/** Convenience: summarize several blobs in order. */
export function summarizeTexts(...texts: readonly string[]): string {
  return summarizeText(texts.filter((text) => typeof text === 'string' && text.length > 0).join('\n\n'))
}
