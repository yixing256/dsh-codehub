/**
 * The `inject` lists must name only services the runtime actually provides.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Declaring an unavailable service in `inject` does not degrade — it HARD-FAILS
 * THE WHOLE BOOT. The loader treats `inject` as a hard requirement, so an entry
 * that waits forever on a missing service means the profile aborts with:
 *
 *     Error: web boot: 1 entry did not activate
 *     dsh-codehub: pending (waiting for service: settingsScope)
 *
 * That is exactly what happened: the browser half listed `settingsScope`, which
 * is not in the client service roster on this runtime (observed:
 * layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces),
 * so the plugin took the entire desktop app down on every restart — three times,
 * while typecheck, build and the full unit suite stayed green.
 *
 * The rule this file pins: anything optional must be reached with `ctx.get(...)`
 * and a fallback, NOT listed in `inject`.
 *
 * Asserted against SOURCE TEXT rather than by importing the module: the browser
 * half imports `@deepseek-ai/dsh-client-ui-primitives`, which exists only as an
 * ambient declaration, so importing it under vitest would fail to resolve at run
 * time — the test would then be testing the wrong thing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

/** Pull the literal names out of the `export const inject = [...]` declaration. */
function injectNames(source: string, label: string): string[] {
  const match = /export const inject[^=]*=\s*\[([^\]]*)\]/.exec(source)
  if (match === null) throw new Error(`${label}: no literal \`export const inject = [...]\` found`)
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '')
}

/**
 * Services known to NOT exist on the respective side.
 *
 * `settingsScope` is the one that actually broke the boot. It is kept as a
 * named case rather than a vague "anything unknown" rule so the failure message
 * points straight at the incident.
 */
const NOT_PROVIDED_ON_CLIENT = ['settingsScope', 'webUiSettings']
const NOT_PROVIDED_ON_HOST = ['settingsScope', 'webUiSettings', 'slots', 'locale']

describe('inject 只声明真实存在的服务', () => {
  it('浏览器半边的 inject 不含 settingsScope', () => {
    const inject = injectNames(read('src/client/index.ts'), 'src/client/index.ts')
    expect(inject.length).toBeGreaterThan(0)
    for (const missing of NOT_PROVIDED_ON_CLIENT) {
      expect(
        inject,
        `浏览器半边不得把 ${missing} 写进 inject —— 它不是客户端服务，声明它会让整个 profile 启动失败`,
      ).not.toContain(missing)
    }
    // 仍须声明真正的客户端服务，否则面板根本不会挂载。
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
  })

  it('宿主半边的 inject 不含任何浏览器侧服务', () => {
    const contract = read('src/contract.ts')
    const inject = injectNames(contract, 'src/contract.ts')
    expect(inject.length).toBeGreaterThan(0)
    for (const missing of NOT_PROVIDED_ON_HOST) {
      expect(
        inject,
        `宿主半边不得把 ${missing} 写进 inject —— 那是浏览器侧服务，声明它会让整个 profile 启动失败`,
      ).not.toContain(missing)
    }
    // 宿主半边真正需要的三个服务。
    expect(inject).toEqual(expect.arrayContaining(['tools', 'webServer', 'systemPrompt']))
  })

  it('可选的 settings 镜像走 ctx.get + 兜底，而不是 inject', () => {
    const client = read('src/client/index.ts')
    // 证明「可选」这件事是代码里真的做了，而不只是注释里写的。
    expect(client).toContain("ctx.get<unknown>('webUiSettings')")
    expect(client).toMatch(/settingsScope unavailable|settingsScope probe failed/)
  })
})
