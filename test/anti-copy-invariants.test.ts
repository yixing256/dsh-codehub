/**
 * 防搬运不变量（task-5 §B）—— 机制层面的证明，不是文案检查。
 *
 * 备注③ asks for a *structural* guarantee: no code path may produce a result that
 * is marked as a permitted verbatim copy. This file proves it four ways:
 *
 *   1. **Type level.** `CodeLearnResult.is_verbatim_copy` is the literal `false`.
 *      A `satisfies false` assignment proves the positive direction, and a
 *      `@ts-expect-error` on `is_verbatim_copy: true` proves the negative one —
 *      if the field were ever widened to `boolean`, the directive would become
 *      unused and `pnpm run typecheck` would fail.
 *   2. **Whole-tree scan.** No line of CODE under `src/` writes the forbidden
 *      literal. `src/contract.ts` *documents* the invariant by quoting
 *      `` is_verbatim_copy: true `` inside a JSDoc block, so comment lines are
 *      excluded — and that exclusion is itself asserted, so the scan cannot
 *      become vacuously true.
 *   3. **Every construction site writes `false`** (adapters, delivery outlet,
 *      type declaration).
 *   4. **The tool's output schema pins it** with `const: false`.
 *
 * `redactForDelivery()` — the single delivery outlet — is asserted in
 * `service-outlet.test.ts`, next to the other service-level invariants.
 */

import { describe, expect, it } from 'vitest'

import type { CodeLearnResult } from '../src/contract.js'
import { LEARN_CODE_OUTPUT_SCHEMA, LEARN_CODE_TOOL } from '../src/tool.js'
import type { ObjectSchema } from '@deepseek-ai/dsh-tools'
import {
  codeLinesContaining,
  isCommentLine,
  listSourceFiles,
  makeRow,
  readAllSourceFiles,
  readRepoFile,
  repoPath,
} from './helpers.js'

describe('防搬运 — 类型层面就是 false', () => {
  it('is_verbatim_copy 的类型是字面量 false（satisfies 编译期断言 + 运行时断言）', () => {
    const row = makeRow()
    const literal = row.is_verbatim_copy satisfies false

    expect(literal).toBe(false)
    expect(row.is_verbatim_copy).toBe(false)
  })

  it('把 true 赋给该字段无法编译 —— 该字段没有「允许的直接复制」这种取值', () => {
    // 这一行必须报错，所以用 @ts-expect-error 压住。若字段某天被放宽成
    // boolean，本指令会变成「未使用」并让 `pnpm run typecheck` 失败。
    // @ts-expect-error CodeLearnResult.is_verbatim_copy 的类型是字面量 false，不接受 true
    const forbidden: CodeLearnResult = { ...makeRow(), is_verbatim_copy: true }

    // 诚实地记录这条防线的作用范围：它拦的是「有类型的代码路径」。运行期把对象
    // 强行拼成 { is_verbatim_copy: true } 仍然是可能的 JS —— 所以 src/ 里每一个
    // 真实构造点都必须写 false，那一条由下面的全树扫描与按文件点名断言覆盖。
    expect(forbidden.is_verbatim_copy).toBe(true)
    expect(Object.keys(forbidden)).toEqual(Object.keys(makeRow()))
  })
})

describe('防搬运 — src/ 全树扫描', () => {
  it('没有任何一行代码把 is_verbatim_copy 写成 true', () => {
    const offenders: string[] = []
    for (const file of readAllSourceFiles()) {
      file.text.split(/\r?\n/).forEach((line, index) => {
        if (!/is_verbatim_copy\s*:\s*true/.test(line)) return
        if (isCommentLine(line)) return
        offenders.push(`${repoPath(file.path)}:${index + 1}: ${line.trim()}`)
      })
    }

    expect(offenders).toEqual([])
  })

  it('该扫描不是恒真：contract.ts 的注释里确实写着这个字面量（所以必须按注释豁免）', () => {
    const contract = readRepoFile('src/contract.ts')
    expect(contract).toContain('is_verbatim_copy: true')

    const offendingLine = contract.split(/\r?\n/).find((line) => line.includes('is_verbatim_copy: true'))
    expect(offendingLine).toBeDefined()
    expect(isCommentLine(offendingLine ?? '')).toBe(true)
  })

  it('每一个代码出现点都是 false 或工具输出 schema 的键', () => {
    expect(listSourceFiles().length).toBeGreaterThanOrEqual(20)

    const sites = codeLinesContaining('is_verbatim_copy').filter((hit) => /is_verbatim_copy\s*:/.test(hit.text))
    // 非空性：交付出口 1 处 + 类型声明 1 处 + 三个适配器 6 处 + 工具 schema 1 处。
    expect(sites.length).toBeGreaterThanOrEqual(6)

    const offenders = sites.filter(
      // A site is legitimate when it pins the literal `false`, or when it is a
      // schema DECLARATION whose `const: false` is asserted elsewhere in this
      // file (`is_verbatim_copy: {` … `const: false`). A bare `is_verbatim_copy:
      // true` can never match and is caught by the scan above.
      (hit) => !/is_verbatim_copy\s*:\s*(?:false\b|required\(|\{)/.test(hit.text),
    )
    expect(offenders).toEqual([])
  })

  it('构造 CodeLearnResult 的适配器与交付出口都写 false（按文件点名）', () => {
    const expected = [
      'src/service.ts',
      'src/sources/csdn.ts',
      'src/sources/gitee.ts',
      'src/sources/github.ts',
    ]
    for (const path of expected) {
      const text = readRepoFile(path)
      const falseCount = text.split(/\r?\n/).filter((line) => line.includes('is_verbatim_copy: false')).length
      expect(falseCount, `${path} 应至少有一处 is_verbatim_copy: false`).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('防搬运 — 工具输出 schema 钉死', () => {
  it('is_verbatim_copy 在 schema 里是 { type: boolean, const: false }', () => {
    const item = LEARN_CODE_OUTPUT_SCHEMA.properties?.['results']?.items
    expect(item?.type).toBe('object')
    expect(item?.properties?.['is_verbatim_copy']?.const).toBe(false)
    expect(item?.properties?.['is_verbatim_copy']?.type).toBe('boolean')
  })

  it('每一行结果都关闭 additionalProperties，因此不存在包外的字段', () => {
    const item = LEARN_CODE_OUTPUT_SCHEMA.properties?.['results']?.items
    expect(item?.additionalProperties).toBe(false)
    expect(LEARN_CODE_OUTPUT_SCHEMA.additionalProperties).toBe(false)
  })

  it('顶层每个属性都在 required 数组里，且 required 与 properties 一一对应', () => {
    const properties = LEARN_CODE_OUTPUT_SCHEMA.properties ?? {}
    // `required` is an ARRAY of names in an output schema, NOT per-property
    // `required: true`. The runtime's validator rejects a boolean `required` on
    // a property of an output schema and fails the ENTIRE tool registration
    // ("unsupported JSON schema: schema.properties.<name>.required is not
    // supported on type \"<type>\""), so the array form is the only correct one
    // — asserting the sugar form here would assert a schema that cannot load.
    expect([...(LEARN_CODE_OUTPUT_SCHEMA.required ?? [])].sort()).toEqual(Object.keys(properties).sort())
    // ...and no property spec may smuggle the rejected boolean back in.
    for (const [key, spec] of Object.entries(properties)) {
      expect(spec, `${key} 不得带属性级 required（运行时会拒绝整个 schema）`).not.toHaveProperty('required')
    }
  })

  it('嵌套对象同样用 required 数组，而不是属性级 required', () => {
    const item = LEARN_CODE_OUTPUT_SCHEMA.properties?.['results']?.items
    if (item === undefined) throw new Error('results.items 缺失')
    // This test asserts schema SHAPE, so it needs the object form. TypeScript
    // will not narrow `ParamSpec | ObjectSchema` (the two overlap and `required`
    // is optional on both), hence the assertion — which the runtime checks below
    // immediately justify by asserting the actual shape.
    const objectItem = item as ObjectSchema
    expect(objectItem.type).toBe('object')
    expect(Array.isArray(objectItem.required)).toBe(true)
    expect([...(objectItem.required ?? [])].sort()).toEqual(Object.keys(objectItem.properties ?? {}).sort())
    for (const [key, spec] of Object.entries(objectItem.properties ?? {})) {
      expect(spec, `${key} 不得带属性级 required`).not.toHaveProperty('required')
    }
  })

  it('可空字段用 oneOf + null，不伪造 0 或空串', () => {
    const item = LEARN_CODE_OUTPUT_SCHEMA.properties?.['results']?.items
    expect(item?.properties?.['stars']?.oneOf).toEqual([{ type: 'integer' }, { type: 'null' }])
    expect(item?.properties?.['updatedAt']?.oneOf).toEqual([{ type: 'string' }, { type: 'null' }])
  })

  it('deepRead 笔记 schema 产出的是思路字段，没有任何「文件内容」字段', () => {
    const notes = LEARN_CODE_OUTPUT_SCHEMA.properties?.['notes']?.items
    const keys = Object.keys(notes?.properties ?? {})
    expect(keys.sort()).toEqual(['apiContract', 'approach', 'pitfalls', 'sourceUrls', 'title', 'tradeoffs', 'url'])
    for (const forbidden of ['content', 'body', 'file', 'text', 'code']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('工具名与描述都对得上（描述本身在 notes-anti-copy.test.ts 里断言）', () => {
    expect(LEARN_CODE_TOOL.name).toBe('learn_code_from_web')
    expect(LEARN_CODE_TOOL.description.length).toBeGreaterThan(0)
  })
})
