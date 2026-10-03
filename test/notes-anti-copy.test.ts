/**
 * 备注③ — 防搬运声明的双写（task-5 §A.3）。
 *
 * The requirement is not merely "the sentence appears twice"; it is that the SAME
 * constant reaches BOTH surfaces — the `learn_code_from_web` tool description and
 * the system-prompt section — so the two copies cannot drift. The assertions are
 * therefore layered:
 *
 *   1. the statement exists and carries the required constraints;
 *   2. `ANTI_COPY_TOOL_CLAUSE` and `PROMPT_SECTION_TEXT` both CONTAIN it;
 *   3. the exported tool definition's `description` contains the CLAUSE, and the
 *      prompt section text contains the STATEMENT — i.e. both real surfaces, not
 *      just the intermediate constants;
 *   4. `src/tool.ts` and `src/prompt.ts` do NOT contain the statement's literal
 *      text — they only reference the constant. This is what proves "one constant,
 *      not two identical copies", and it is the assertion that would fail if
 *      somebody pasted a second copy.
 *
 * Zero network: only module-level constants and one refusal path are touched.
 */

import { describe, expect, it } from 'vitest'

import {
  ANTI_COPY_STATEMENT,
  ANTI_COPY_TOOL_CLAUSE,
  LEARNING_ONLY_BANNER,
  PROMPT_SECTION_ORDER,
  PROMPT_SECTION_TEXT,
  SOURCES,
} from '../src/contract.js'
import { PROMPT_SECTION, PROMPT_SECTION_NAME } from '../src/prompt.js'
import { LEARN_CODE_TOOL, LEARN_CODE_TOOL_DESCRIPTION } from '../src/tool.js'
import { readRepoFile } from './helpers.js'

describe('备注③ — 声明的约束力', () => {
  it('ANTI_COPY_STATEMENT 非空，且含全部关键约束词', () => {
    expect(ANTI_COPY_STATEMENT.length).toBeGreaterThan(50)
    expect(ANTI_COPY_STATEMENT).toContain('搬运')
    expect(ANTI_COPY_STATEMENT).toContain('严禁')
    expect(ANTI_COPY_STATEMENT).toContain('原样粘贴')
    expect(ANTI_COPY_STATEMENT).toContain('重写')
    // 结构上恒为 false 这件事本身也写在声明里，模型才知道该字段的含义。
    expect(ANTI_COPY_STATEMENT).toContain('is_verbatim_copy')
  })

  it('两个中间常量都内嵌同一个 ANTI_COPY_STATEMENT', () => {
    expect(ANTI_COPY_TOOL_CLAUSE).toContain(ANTI_COPY_STATEMENT)
    expect(PROMPT_SECTION_TEXT).toContain(ANTI_COPY_STATEMENT)
    // 链式断言：同一条语句经两个常量分别抵达两处界面。
    expect(ANTI_COPY_TOOL_CLAUSE.includes(ANTI_COPY_STATEMENT) && PROMPT_SECTION_TEXT.includes(ANTI_COPY_STATEMENT)).toBe(
      true,
    )
  })
})

describe('备注③ — 两处真实界面', () => {
  it('agent tool 的 description 含该声明（surface #1）', () => {
    expect(LEARN_CODE_TOOL.name).toBe('learn_code_from_web')
    expect(LEARN_CODE_TOOL.description).toContain(ANTI_COPY_STATEMENT)
    expect(LEARN_CODE_TOOL.description).toContain(ANTI_COPY_TOOL_CLAUSE)
    expect(LEARN_CODE_TOOL_DESCRIPTION).toBe(LEARN_CODE_TOOL.description)
  })

  it('系统提示词段含该声明（surface #2）', () => {
    expect(PROMPT_SECTION_NAME).toBe('plugin:dsh-codehub')
    expect(PROMPT_SECTION.order).toBe(PROMPT_SECTION_ORDER)
    expect(PROMPT_SECTION.text).toBe(PROMPT_SECTION_TEXT)
    expect(PROMPT_SECTION.text).toContain(ANTI_COPY_STATEMENT)
  })

  it('两处引用的是同一个常量，而不是两份内容相同的副本', () => {
    const toolSource = readRepoFile('src/tool.ts')
    const promptSource = readRepoFile('src/prompt.ts')
    const contractSource = readRepoFile('src/contract.ts')

    // 定义点只有契约文件一处。注意 contract.ts 里那句话是用 `+` 拼接的多段字面量
    // （为了源码可读性），所以**文件原文里不可能出现完整句子** —— 「同一个常量」
    // 由下面两组证据共同证明：
    //   (a) 两个消费者都按名字从 './contract.js' 导入自己用的那个常量；
    //   (b) 两个消费者都没有把那段声明再写一遍。
    expect(contractSource).toContain('export const ANTI_COPY_STATEMENT =')
    expect(contractSource).toContain('export const ANTI_COPY_TOOL_CLAUSE =')
    expect(contractSource).toContain('export const PROMPT_SECTION_TEXT =')

    expect(toolSource).toMatch(/import\s*\{[^}]*ANTI_COPY_TOOL_CLAUSE[^}]*\}\s*from\s*'\.\/contract\.js'/)
    expect(promptSource).toMatch(/import\s*\{[^}]*PROMPT_SECTION_TEXT[^}]*\}\s*from\s*'\.\/contract\.js'/)

    expect(toolSource).not.toContain(ANTI_COPY_STATEMENT)
    expect(promptSource).not.toContain(ANTI_COPY_STATEMENT)
  })

  it('从第一句到最后一句都抵达了两处界面（不是被截断或过期的半份）', () => {
    const tail = '不得作为交付物转述。'

    expect(ANTI_COPY_STATEMENT.endsWith(tail)).toBe(true)
    expect(LEARN_CODE_TOOL.description).toContain(tail)
    expect(PROMPT_SECTION.text).toContain(tail)
  })
})

describe('备注③ — 渲染与拒绝路径也不豁免', () => {
  it('工具输出的每一行渲染都带 LEARNING_ONLY_BANNER', () => {
    const render = LEARN_CODE_TOOL.output?.render
    expect(typeof render).toBe('function')

    const blocks = render?.(
      // The shim types `render` with `never` inputs; the runtime value is what matters.
      undefined as never,
      {
        ok: true,
        query: 'vue 响应式',
        results: [
          {
            source: 'github',
            url: 'https://github.com/vuejs/core',
            title: 'vuejs/core',
            language: 'TypeScript',
            code: 'const x = 1',
            codeTruncated: false,
            learned_summary: '先建索引再查询。',
            is_verbatim_copy: false,
            stars: 1,
            updatedAt: null,
            confidence: 'high',
            reason: '测试',
          },
        ],
        notes: [],
        failures: [],
        unresolved_decisions: [],
        ask_user: '',
        reason: '',
        degraded: false,
        merged: false,
        sources_queried: ['github'],
        deep_read: false,
      } as never,
    )

    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks !== undefined && blocks.length > 0).toBe(true)
    for (const block of blocks ?? []) {
      expect(block.type).toBe('text')
      expect(block.text).toContain(LEARNING_ONLY_BANNER)
    }
  })

  it('未挂载 service 时 execute 抛错，且消息以 dsh-codehub: 开头（调用方用错才 throw）', async () => {
    const execute = LEARN_CODE_TOOL.execute
    await expect(
      // The shim types `execute` with `never` inputs; the runtime value is what matters.
      execute({ query: 'vue' } as never, {} as never),
    ).rejects.toThrow(/^dsh-codehub: /)
  })

  it('入参错误也在 throw 路径上以 dsh-codehub: 开头', async () => {
    const execute = LEARN_CODE_TOOL.execute
    await expect(execute({} as never, {} as never)).rejects.toThrow('dsh-codehub: 缺少必填参数')
    await expect(execute({ query: 'vue', sources: ['nope'] } as never, {} as never)).rejects.toThrow(
      new RegExp(`dsh-codehub: .*${SOURCES.join(' / ')}`),
    )
  })
})
