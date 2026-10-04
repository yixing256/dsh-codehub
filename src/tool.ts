/**
 * dsh-codehub — the `learn_code_from_web` agent tool.
 *
 * WHAT THIS TOOL IS FOR (备注③)
 * ----------------------------
 * Learning usage, not moving code. Its description carries
 * `ANTI_COPY_TOOL_CLAUSE` verbatim — imported from `src/contract.ts`, never
 * re-typed — and that clause embeds the single `ANTI_COPY_STATEMENT` the system
 * prompt section also uses. A test asserts both surfaces contain the same
 * constant, which only means something because there is exactly one copy.
 *
 * FAILURES ARE VALUES
 * -------------------
 * A refusal (an unanswered decision, the plugin disabled, every source empty) is
 * returned as `{ ok: false, ... }` in the declared output schema, because the
 * model must be able to branch on it. `throw` is reserved for the caller using
 * the tool wrongly — a missing `query`, a `sources` value outside the enum, a
 * `maxItems` that is not a positive integer — and every such message starts with
 * `dsh-codehub: ` so it is obvious where it came from.
 *
 * The definition is built by `buildLearnCodeTool(deps)`; `LEARN_CODE_TOOL` is a
 * ready-made instance whose `description`, `parameters` and `output` are static,
 * so tests can import it and inspect the description without a live service.
 */

import type { ContentBlock, ObjectSchema, ParamSpec, ToolDefinition, ToolExecutionInput } from '@deepseek-ai/dsh-tools'

import {
  ANTI_COPY_TOOL_CLAUSE,
  CONFIDENCE_LEVELS,
  DECISION_KEYS,
  DEEP_READ_TARGETS,
  FAILURE_KINDS,
  HARD_LIMITS,
  LEARNING_ONLY_BANNER,
  SOURCES,
  SOURCE_LABELS,
  TOOL_NAME,
  TOOL_PARAMS,
} from './contract.js'
import type { LearnNote, SourceId, UnresolvedDecision } from './contract.js'
import { composeSignal, timeoutSignal } from './net.js'
import type { CodeSource, SearchOutcome, SourceFailure } from './service.js'

// ---------------------------------------------------------------------------
// Description — 备注③ surface #1.
// ---------------------------------------------------------------------------

/**
 * The tool description.
 *
 * Composed from the contract clause; the surrounding sentences only explain the
 * decision gate and the note-shaped output, they do not restate the boundary.
 */
export const LEARN_CODE_TOOL_DESCRIPTION =
  '检索 GitHub / Gitee / CSDN 上的代码用法，并提炼「实现思路 / API 用法 / 取舍 / 踩坑」四类要点；' +
  '也可对单个仓库做深度阅读，产出思路笔记。' +
  ANTI_COPY_TOOL_CLAUSE +
  '未确认的决策点（源优先级、GitHub 访问方式、失败降级、多源合并）会让本工具直接拒绝执行：' +
  '此时不发起任何网络请求，只返回要转述给用户的问题。'

// ---------------------------------------------------------------------------
// Arguments.
//
// `parameters` IS RAW JSON SCHEMA. THE SUGAR PER-PROPERTY MAP IS NOT ACCEPTED.
// ---------------------------------------------------------------------------
// `ToolSchema.parameters` (dsh-llm) is documented as "JSON Schema object for the
// arguments", and `tools.register()` hands that object to the provider
// UNCHANGED. Only `defineTool()` compiles the author-facing per-property DSL
// (`parameterSchemaSpecToJsonSchema`); a definition built by hand — which is what
// `buildLearnCodeTool()` returns — is never compiled.
//
// Handing `register()` the DSL map therefore ships a schema whose ROOT KEYS are
// the parameter names. Any parameter whose name is also a JSON Schema keyword is
// then read as that keyword, and the provider rejects the whole tool — which
// takes every conversation down, not just this tool:
//
//   Invalid schema for function 'learn_code_from_web':
//   {"type":"integer","description":"本次最多返回多少条。…"} is not of type "integer"
//
// That message is the provider reading the `maxItems` PROPERTY as the `maxItems`
// KEYWORD, which must be an integer. Hence the rule encoded below: the root is
// always `{ type: 'object', properties }`, so a property name can never be
// interpreted as a schema keyword. `test/tool-schema.test.ts` asserts both the
// shape and the absence of that exact failure.
// ---------------------------------------------------------------------------

export interface LearnCodeArgs {
  readonly query: string
  readonly sources?: readonly SourceId[] | undefined
  readonly deepRead?: boolean | undefined
  readonly maxItems?: number | undefined
}

/** One JSON-Schema node, in the subset this tool's arguments use. */
export interface ParamNode {
  readonly type: 'string' | 'integer' | 'boolean' | 'array' | 'object'
  readonly description?: string
  readonly enum?: readonly string[]
  readonly items?: ParamNode
}

/**
 * The arguments schema the provider receives.
 *
 * Deliberately a `type` alias (not an `interface`): an object literal type
 * carries an implicit index signature, which is what makes it assignable to the
 * runtime's `Record<string, unknown>` `parameters` field without a cast.
 */
export type LearnCodeParameters = {
  readonly type: 'object'
  readonly additionalProperties: false
  readonly required: readonly string[]
  readonly properties: Readonly<Record<(typeof TOOL_PARAMS)[number], ParamNode>>
}

const PARAM_PROPERTIES: Readonly<Record<(typeof TOOL_PARAMS)[number], ParamNode>> = {
  query: {
    type: 'string',
    description: '要学习的主题、API 名称或问题，例如「cordis service 生命周期」或「undici proxy agent」。',
  },
  sources: {
    type: 'array',
    items: { type: 'string', enum: SOURCES },
    description:
      '可选：只查这些源，并以此顺序优先（仍受用户配置的源优先级约束）。省略 = 按用户配置的顺序查全部源。',
  },
  deepRead: {
    type: 'boolean',
    description: '是否对命中的仓库做深度阅读，产出思路笔记 LearnNote（不是文件副本）。需要用户已选择深度阅读目标。',
  },
  maxItems: {
    type: 'integer',
    description: `本次最多返回多少条。省略 = 用户配置值；再大也不会超过硬顶 ${HARD_LIMITS.maxItems}。`,
  },
}

/**
 * The required parameter names, in the top-level array form.
 *
 * The array form is load-bearing for the same reason it is in the output schema:
 * a boolean `required` on a property is not valid JSON Schema here.
 */
export const LEARN_CODE_REQUIRED_PARAMS: readonly string[] = ['query']

/** The compiled `parameters` schema. See the section header for why it is raw. */
export const LEARN_CODE_PARAMETERS: LearnCodeParameters = {
  type: 'object',
  additionalProperties: false,
  required: [...LEARN_CODE_REQUIRED_PARAMS],
  properties: PARAM_PROPERTIES,
}

/** Declared parameter names, in contract order. */
export const LEARN_CODE_PARAM_NAMES: readonly string[] = TOOL_PARAMS.filter((name) => name in PARAM_PROPERTIES)

function readArgs(raw: unknown): LearnCodeArgs {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('dsh-codehub: 工具入参必须是一个对象。')
  }
  const record = raw as Record<string, unknown>

  const query = record.query
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('dsh-codehub: 缺少必填参数 `query`（非空字符串）。')
  }

  let sources: SourceId[] | undefined
  const rawSources = record.sources
  if (rawSources !== undefined && rawSources !== null) {
    if (!Array.isArray(rawSources)) {
      throw new Error('dsh-codehub: `sources` 必须是数组。')
    }
    sources = []
    for (const item of rawSources) {
      if (typeof item !== 'string' || !(SOURCES as readonly string[]).includes(item)) {
        throw new Error(`dsh-codehub: \`sources\` 只接受 ${SOURCES.join(' / ')}，收到 ${String(item)}。`)
      }
      const id = item as SourceId
      if (!sources.includes(id)) sources.push(id)
    }
  }

  const rawDeepRead = record.deepRead
  if (rawDeepRead !== undefined && rawDeepRead !== null && typeof rawDeepRead !== 'boolean') {
    throw new Error('dsh-codehub: `deepRead` 必须是布尔值。')
  }

  let maxItems: number | undefined
  const rawMaxItems = record.maxItems
  if (rawMaxItems !== undefined && rawMaxItems !== null) {
    if (typeof rawMaxItems !== 'number' || !Number.isFinite(rawMaxItems) || rawMaxItems < 1) {
      throw new Error('dsh-codehub: `maxItems` 必须是 ≥ 1 的整数。')
    }
    maxItems = Math.min(Math.floor(rawMaxItems), HARD_LIMITS.maxItems)
  }

  return {
    query: query.trim(),
    ...(sources === undefined ? {} : { sources }),
    ...(typeof rawDeepRead === 'boolean' ? { deepRead: rawDeepRead } : {}),
    ...(maxItems === undefined ? {} : { maxItems }),
  }
}

// ---------------------------------------------------------------------------
// Output schema — full JSON-Schema object form, `additionalProperties: false`,
// nullable values as `oneOf`.
//
// REQUIRED LIVES IN *BOTH* PLACES, AND THAT IS DELIBERATE.
// -------------------------------------------------------
// The runtime's schema validator REJECTS the sugar `required: true` on a
// property of an `output.schema`, and the rejection fails the whole tool
// registration:
//
//   unsupported JSON schema: schema.properties.ok.required is not supported on
//   type "boolean"; schema.properties.query.required is not supported on type
//   "string"; ...
//
// So the authoritative form is the top-level `required: [...]` name array (plain
// JSON Schema), built from `REQUIRED` below. The per-property `required: true`
// markers are kept as well, but ONLY as an internal fact that `requiredNames()`
// derives the array from — they live in local records that are never handed to
// the runtime, so they cannot reach the validator and cannot drift from the
// array.
//
// Note this differs from the `parameters` sugar DSL, where per-property
// `required: true` IS accepted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Output schema — plain JSON-Schema object form, `additionalProperties: false`,
// nullable values as `oneOf`.
//
// REQUIRED IS AN ARRAY HERE, NOT THE SUGAR FLAG.
// ---------------------------------------------
// The runtime's schema validator REJECTS the sugar `required: true` on a
// property of an `output.schema`, and that rejection fails the ENTIRE tool
// registration (the tool silently never appears):
//
//   unsupported JSON schema: schema.properties.ok.required is not supported on
//   type "boolean"; schema.properties.query.required is not supported on type
//   "string"; ...
//
// So every object in this tree uses the plain form: a top-level
// `required: [names]` array. The `required: true` markers on the `*_PROPERTIES`
// records below are kept ONLY as an internal, source-visible fact — those
// records hold `ObjectSchema` values and the marker is stripped before the
// schema object is built, because an unknown `required` key on a property spec
// is exactly what the validator rejects. `requiredNames()` derives the array
// from the same records, so the two cannot drift.
//
// Note this differs from the `parameters` sugar DSL, where per-property
// `required: true` IS accepted.
// ---------------------------------------------------------------------------

/** Property names marked `required` in a local property record. */
function requiredNames(properties: Record<string, ParamSpec>): readonly string[] {
  return Object.entries(properties).filter(([, spec]) => spec.required === true).map(([key]) => key)
}

/**
 * Strip the internal `required` marker from every property spec.
 *
 * The marker must NOT reach the runtime: `required` on a property of an
 * `output.schema` is the exact construct the validator rejects. It is only ever
 * read back by `requiredNames()`.
 */
function stripRequired(properties: Record<string, ParamSpec>): Record<string, ParamSpec> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, spec]) => {
      const { required: _marker, ...rest } = spec
      return [key, rest]
    }),
  )
}

/** Build one object schema with `required` hoisted to the array form. */
function objectSchema(properties: Record<string, ParamSpec>): ObjectSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: requiredNames(properties),
    properties: stripRequired(properties),
  }
}

const RESULT_PROPERTIES: Record<string, ParamSpec> = {
  source: { type: 'string', enum: SOURCES, required: true, description: '命中的源。' },
  url: { type: 'string', required: true, description: '可直接打开的来源地址。' },
  title: { type: 'string', required: true },
  language: { type: 'string', required: true, description: '识别到的语言；未知时为空字符串。' },
  code: {
    type: 'string',
    required: true,
    description: `仅作学习参考的节选，首行固定是「${LEARNING_ONLY_BANNER}」，长度不超过用户配置的 maxCodeChars。`,
  },
  codeTruncated: { type: 'boolean', required: true, description: '节选是否因超限被截断。' },
  learned_summary: { type: 'string', required: true, description: '提炼出的思路 / 用法 / 取舍 / 坑。不是代码的改写。' },
  is_verbatim_copy: {
    type: 'boolean',
    required: true,
    const: false,
    description: '结构上恒为 false：本工具不存在「返回可直接粘贴的代码」这种结果。',
  },
  stars: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true, description: '来源给出的星标数，未知时 null。' },
  updatedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: 'ISO-8601 更新时间，未知时 null。' },
  confidence: { type: 'string', enum: CONFIDENCE_LEVELS, required: true },
  reason: { type: 'string', required: true, description: '这一条为什么出现、置信度为什么是这样。' },
}

const RESULT_SCHEMA: ObjectSchema = objectSchema(RESULT_PROPERTIES)

const NOTE_PROPERTIES: Record<string, ParamSpec> = {
  url: { type: 'string', required: true },
  title: { type: 'string', required: true },
  approach: { type: 'string', required: true, description: '实现思路（散文），不是源码。' },
  apiContract: { type: 'array', required: true, items: { type: 'string' } },
  tradeoffs: { type: 'array', required: true, items: { type: 'string' } },
  pitfalls: { type: 'array', required: true, items: { type: 'string' } },
  sourceUrls: { type: 'array', required: true, items: { type: 'string' }, description: '每条结论的来源地址，保持可追溯。' },
}

const NOTE_SCHEMA: ObjectSchema = objectSchema(NOTE_PROPERTIES)

const FAILURE_PROPERTIES: Record<string, ParamSpec> = {
  source: { type: 'string', enum: SOURCES, required: true },
  kind: { type: 'string', enum: FAILURE_KINDS, required: true },
  reason: { type: 'string', required: true },
}

const FAILURE_SCHEMA: ObjectSchema = objectSchema(FAILURE_PROPERTIES)

const DECISION_PROPERTIES: Record<string, ParamSpec> = {
  key: { type: 'string', enum: DECISION_KEYS, required: true },
  detail: { type: 'string', required: true },
  ask: { type: 'string', required: true, description: '可以直接转述给用户的问题。' },
  control: { type: 'string', required: true, description: '告诉用户去哪里点。' },
}

const DECISION_SCHEMA: ObjectSchema = objectSchema(DECISION_PROPERTIES)

/** The complete output schema. `ok:false` payloads use the same shape. */
const OUTPUT_PROPERTIES: Record<string, ParamSpec> = {
  ok: { type: 'boolean', required: true, description: 'false = 业务性拒绝（未决策 / 已禁用 / 无结果），详见 reason 与 ask_user。' },
  query: { type: 'string', required: true },
  results: { type: 'array', required: true, items: RESULT_SCHEMA },
  notes: { type: 'array', required: true, items: NOTE_SCHEMA, description: '深度阅读产出的思路笔记（可能为空）。' },
  failures: { type: 'array', required: true, items: FAILURE_SCHEMA, description: '每个失败源及其分类。' },
  unresolved_decisions: {
    type: 'array',
    required: true,
    items: DECISION_SCHEMA,
    description: '未确认的决策点；非空时 ok 必为 false，且未发起任何网络请求。',
  },
  ask_user: { type: 'string', required: true, description: '要转述给用户的问题；ok 为 true 时是空字符串。' },
  reason: { type: 'string', required: true },
  degraded: { type: 'boolean', required: true, description: '是否因用户已同意自动降级而切换过源。' },
  merged: { type: 'boolean', required: true, description: '结果是否来自多源合并去重。' },
  sources_queried: { type: 'array', required: true, items: { type: 'string', enum: SOURCES } },
  deep_read: { type: 'boolean', required: true, description: '本次是否真的产出了深度阅读笔记。' },
}

export const LEARN_CODE_OUTPUT_SCHEMA: ObjectSchema = objectSchema(OUTPUT_PROPERTIES)


// ---------------------------------------------------------------------------
// Render.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Every block carries the banner, so no fragment can be shown without it. */
function bannerBlock(body: string): ContentBlock {
  return { type: 'text', text: `${LEARNING_ONLY_BANNER}\n${body}` }
}

function stripBanner(code: string): string {
  if (!code.startsWith(LEARNING_ONLY_BANNER)) return code
  return code.slice(LEARNING_ONLY_BANNER.length).replace(/^\n/, '')
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function renderOutcome(rawValue: unknown): ContentBlock[] {
  if (!isRecord(rawValue)) {
    return [bannerBlock('工具没有返回结果对象。请重试；若持续出现，请检查 host 侧日志。')]
  }

  const ok = rawValue.ok === true
  const results = asArray(rawValue.results)
  const failures = asArray(rawValue.failures) as readonly Partial<SourceFailure>[]
  const decisions = asArray(rawValue.unresolved_decisions) as readonly Partial<UnresolvedDecision>[]
  const notes = asArray(rawValue.notes) as readonly Partial<LearnNote>[]
  const queried = asArray(rawValue.sources_queried).map((item) => textOf(item)).filter((item) => item.length > 0)

  const blocks: ContentBlock[] = []

  const header: string[] = [
    `query: ${textOf(rawValue.query)}`,
    `ok: ${ok ? 'true' : 'false'}`,
    `已查询：${queried.length > 0 ? queried.map((id) => labelOf(id)).join(' → ') : '（无）'}`,
  ]
  if (failures.length > 0) {
    header.push(
      `失败：${failures
        .map((item) => `${labelOf(textOf(item.source))}=${textOf(item.kind)}`)
        .join('、')}`,
    )
  }
  if (rawValue.degraded === true) header.push('已按用户设置自动降级到下一个源。')
  if (rawValue.reason !== undefined) header.push(`说明：${textOf(rawValue.reason)}`)
  blocks.push(bannerBlock(header.join('\n')))

  results.forEach((item, index) => {
    if (!isRecord(item)) return
    const meta = [
      textOf(item.language).length > 0 ? textOf(item.language) : '语言未知',
      typeof item.stars === 'number' ? `${item.stars} stars` : 'stars 未知',
      textOf(item.updatedAt).length > 0 ? `更新于 ${textOf(item.updatedAt)}` : '更新时间未知',
      `置信度 ${textOf(item.confidence)}`,
    ].join(' · ')
    const body = [
      `[${index + 1}/${results.length}] ${labelOf(textOf(item.source))} · ${textOf(item.title)}`,
      textOf(item.url),
      meta,
      `思路：${textOf(item.learned_summary)}`,
      `代码节选（仅学习参考，禁止直接粘贴进用户项目${item.codeTruncated === true ? '，已截断' : ''}）：`,
      stripBanner(textOf(item.code)),
      `判定理由：${textOf(item.reason)}`,
    ].join('\n')
    blocks.push(bannerBlock(body))
  })

  if (decisions.length > 0) {
    const body = [
      '本工具现在拒绝执行，并且没有发起任何网络请求。请先把下面的问题问用户：',
      ...decisions.map((item) => `- ${textOf(item.ask)}（设置位置：${textOf(item.control)}；缺什么：${textOf(item.detail)}）`),
    ].join('\n')
    blocks.push(bannerBlock(body))
  } else if (!ok) {
    const ask = textOf(rawValue.ask_user)
    blocks.push(bannerBlock(ask.length > 0 ? `需要用户确认：${ask}` : '本次未得到可用结果，请调整关键词或访问方式后重试。'))
  }

  if (notes.length > 0) {
    const body = notes
      .map((note, index) => {
        const lines = [`[笔记 ${index + 1}/${notes.length}] ${textOf(note.title)}`, textOf(note.url)]
        if (textOf(note.approach).length > 0) lines.push(`思路：${textOf(note.approach)}`)
        const sections: readonly (readonly [string, unknown])[] = [
          ['API 契约', note.apiContract],
          ['取舍', note.tradeoffs],
          ['坑', note.pitfalls],
          ['来源', note.sourceUrls],
        ]
        for (const [label, value] of sections) {
          const items = asArray(value).map((item) => textOf(item)).filter((item) => item.length > 0)
          if (items.length > 0) lines.push(`${label}：${items.join('；')}`)
        }
        return lines.join('\n')
      })
      .join('\n\n')
    blocks.push(bannerBlock(body))
  }

  return blocks
}

function labelOf(source: string): string {
  if (source === 'github' || source === 'gitee' || source === 'csdn') return SOURCE_LABELS[source]
  return source
}

// ---------------------------------------------------------------------------
// The tool.
// ---------------------------------------------------------------------------

export interface LearnCodeToolDeps {
  /** The live service. Omitted only for the static `LEARN_CODE_TOOL` instance. */
  readonly service?: CodeSource | undefined
  /** Current limits; the timeout budget comes from here, not from a constant. */
  readonly getLimits?: (() => { readonly timeoutMs: number }) | undefined
}

function refusalOutcome(query: string, reason: string, askUser: string): SearchOutcome {
  return {
    ok: false,
    query,
    results: [],
    notes: [],
    failures: [],
    unresolved_decisions: [],
    ask_user: askUser,
    reason,
    degraded: false,
    merged: false,
    sources_queried: [],
    deep_read: false,
  }
}

/**
 * Build the tool definition.
 *
 * The timeout is composed with `AbortSignal.any([exec.signal, AbortSignal.timeout(limits.timeoutMs)])`
 * (see `composeSignal`), so a caller cancellation and our own budget both stop
 * the request, and the definition-level `timeoutMs` is only the contract's hard
 * cap — a backstop, never a tighter bound than the user's own setting.
 */
export function buildLearnCodeTool(deps: LearnCodeToolDeps = {}): ToolDefinition {
  return {
    name: TOOL_NAME,
    description: LEARN_CODE_TOOL_DESCRIPTION,
    // RAW JSON Schema — never the per-property DSL map. See the "Arguments"
    // section header: `register()` does not compile the DSL, it forwards it, and
    // a root-level `maxItems` key is what broke every conversation.
    parameters: LEARN_CODE_PARAMETERS,
    timeoutMs: HARD_LIMITS.timeoutMs,
    output: {
      schema: LEARN_CODE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): ContentBlock[] => renderOutcome(value),
    },
    execute: async (rawArgs: unknown, exec: ToolExecutionInput): Promise<unknown> => {
      // Caller mistakes throw, and always say where they came from.
      const args = readArgs(rawArgs)

      const service = deps.service
      if (service === undefined) {
        throw new Error('dsh-codehub: codeSource 服务尚未挂载，无法执行查询。')
      }

      const limits = deps.getLimits?.() ?? { timeoutMs: HARD_LIMITS.timeoutMs }
      const signal = composeSignal([exec?.signal, timeoutSignal(limits.timeoutMs)])

      try {
        return await service.search(args.query, {
          ...(args.sources === undefined ? {} : { sources: args.sources }),
          ...(args.deepRead === undefined ? {} : { deepRead: args.deepRead }),
          ...(args.maxItems === undefined ? {} : { maxItems: args.maxItems }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        // A crash is still reported as a value: the model can branch on it.
        const detail = error instanceof Error ? error.message : String(error)
        return refusalOutcome(args.query, `查询过程中出错：${detail}`, '这次查询失败了。要我换个关键词或访问方式再试一次吗？')
      }
    },
  }
}

/**
 * A ready-made instance for import-time inspection (tests read `description`).
 * Its `execute` refuses because no service is wired — which is exactly the
 * "caller used it wrongly" path and therefore a throw, not a silent no-op.
 */
export const LEARN_CODE_TOOL: ToolDefinition = buildLearnCodeTool()
