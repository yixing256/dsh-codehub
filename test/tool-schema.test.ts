/**
 * `learn_code_from_web` 的 `parameters` 必须是 raw JSON Schema。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The plugin shipped the author-facing SUGAR map as `parameters`:
 *
 *     parameters: { query: {…}, sources: {…}, deepRead: {…}, maxItems: {…} }
 *
 * `defineTool()` compiles that DSL. `tools.register()` does NOT — it forwards the
 * object to the provider verbatim, and `ToolSchema.parameters` (dsh-llm) is
 * documented as "JSON Schema object for the arguments". So the schema the
 * provider received had the PARAMETER NAMES as its ROOT KEYS, and the provider
 * read the `maxItems` PROPERTY as the `maxItems` KEYWORD — which must be an
 * integer. Every request in the session died with:
 *
 *   Invalid schema for function 'learn_code_from_web':
 *   {"type":"integer","description":"本次最多返回多少条。…"} is not of type "integer"
 *
 * That is a total outage, not a broken tool: the request carrying the tool schema
 * is rejected, so the agent cannot talk at all. typecheck, build and the whole
 * unit suite stayed green through it, because none of them ever looked at the
 * object the runtime actually forwards.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   1. the root is `{ type: 'object', properties, required, additionalProperties }`;
 *   2. NO parameter name appears at the root — so no name can ever collide with a
 *      JSON-Schema keyword;
 *   3. the collision is REAL, not hypothetical: one of our parameter names is
 *      itself a JSON-Schema integer keyword (`maxItems`), asserted as a non-empty
 *      list so this rule cannot quietly become decoration;
 *   4. `required` is the top-level ARRAY form, and no property carries the
 *      boolean form.
 */

import { describe, expect, it } from 'vitest'

import { SOURCES } from '../src/contract.js'
import {
  LEARN_CODE_PARAMETERS,
  LEARN_CODE_PARAM_NAMES,
  LEARN_CODE_REQUIRED_PARAMS,
  LEARN_CODE_TOOL,
} from '../src/tool.js'

/**
 * JSON-Schema validation keywords whose value must be an INTEGER.
 *
 * A parameter of one of these names left at the schema root is read as the
 * keyword, and the provider rejects the whole tool. This is the exact class of
 * failure that took the plugin down.
 */
const INTEGER_VALIDATION_KEYWORDS = [
  'maxItems',
  'minItems',
  'maxLength',
  'minLength',
  'minimum',
  'maximum',
  'minProperties',
  'maxProperties',
  'multipleOf',
] as const

type AnySchema = Record<string, any>

const parameters = LEARN_CODE_TOOL.parameters as AnySchema
const properties = parameters['properties'] as Record<string, AnySchema>

describe('learn_code_from_web — parameters 是 raw JSON Schema', () => {
  it('根节点是 {type:object, properties, required, additionalProperties}', () => {
    expect(parameters['type']).toBe('object')
    expect(parameters['additionalProperties']).toBe(false)
    expect(Array.isArray(parameters['required'])).toBe(true)
    expect(typeof parameters['properties']).toBe('object')
    // The root carries the schema KEYWORDS and nothing else. A stray key is a
    // keyword candidate, which is precisely the bug being guarded here.
    expect(Object.keys(parameters).sort()).toEqual(['additionalProperties', 'properties', 'required', 'type'])
  })

  it('没有任何参数名出现在根节点（sugar 映射的形态就是根节点直接挂参数名）', () => {
    for (const name of LEARN_CODE_PARAM_NAMES) {
      expect(
        parameters[name],
        `参数 ${name} 出现在 schema 根节点 —— 那是 sugar DSL 的形态，register() 不会编译它`,
      ).toBeUndefined()
      expect(Object.keys(properties), `${name} 应在 properties 里`).toContain(name)
    }
  })

  it('回归：maxItems 只作为 properties 的属性名，绝不是根级关键字', () => {
    expect(parameters['maxItems']).toBeUndefined()
    expect(properties['maxItems']).toMatchObject({ type: 'integer' })
    expect(typeof properties['maxItems']?.['description']).toBe('string')
    expect((properties['maxItems']?.['description'] as string).length).toBeGreaterThan(0)
  })

  it('任何一个 JSON Schema 整型关键字都不在根节点上', () => {
    for (const keyword of INTEGER_VALIDATION_KEYWORDS) {
      expect(parameters[keyword], `根级 ${keyword} 会被当作 JSON Schema 关键字，而不是参数`).toBeUndefined()
    }
  })

  it('这条规则不是多余的：我们的参数名里确实有一个整型关键字', () => {
    const collisions = LEARN_CODE_PARAM_NAMES.filter((name) =>
      (INTEGER_VALIDATION_KEYWORDS as readonly string[]).includes(name),
    )
    // Non-vacuity. If `maxItems` were ever renamed, this test fails and the
    // nesting rule gets re-justified instead of silently staying in place.
    expect(collisions).toEqual(['maxItems'])
  })

  it('工具实际发出的就是 LEARN_CODE_PARAMETERS 本身（没有 second copy）', () => {
    expect(parameters).toBe(LEARN_CODE_PARAMETERS)
  })
})

describe('learn_code_from_web — 参数声明完整且形状正确', () => {
  it('参数名与 contract 顺序一致', () => {
    expect([...LEARN_CODE_PARAM_NAMES]).toEqual(['query', 'sources', 'deepRead', 'maxItems'])
  })

  it('required 用顶层数组形式，且只含 query', () => {
    expect([...LEARN_CODE_REQUIRED_PARAMS]).toEqual(['query'])
    expect([...(parameters['required'] as string[])]).toEqual(['query'])
    for (const name of parameters['required'] as string[]) {
      expect(Object.keys(properties)).toContain(name)
    }
  })

  it('没有属性带布尔 required（属性级 required 是另一种 schema 方言）', () => {
    for (const [name, spec] of Object.entries(properties)) {
      expect(spec, `${name} 不得带属性级 required`).not.toHaveProperty('required')
    }
  })

  it('每个参数都有类型和非空 description，模型才可能用对', () => {
    for (const [name, spec] of Object.entries(properties)) {
      expect(typeof spec['type'], `${name} 缺 type`).toBe('string')
      expect(typeof spec['description'], `${name} 缺 description`).toBe('string')
      expect((spec['description'] as string).length, `${name} 的 description 为空`).toBeGreaterThan(0)
    }
  })

  it('sources 只接受三个真实源，且 items.enum 就是 contract 的 SOURCES', () => {
    expect(properties['sources']?.['type']).toBe('array')
    expect(properties['sources']?.['items']).toMatchObject({ type: 'string' })
    expect([...(properties['sources']?.['items']?.['enum'] as string[])]).toEqual([...SOURCES])
  })

  it('deepRead 是布尔', () => {
    expect(properties['deepRead']).toMatchObject({ type: 'boolean' })
  })
})
