/**
 * SDK 漂移防线：不要把运行时不存在的名字当成能在页面里用的组件。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The desktop app runs DSH **0.2.0-rc.2**, while the repo's hand-written type shim
 * (`types/dsh/index.d.ts`) was mirrored from **0.1.5-rc.3**. On 0.2.0-rc.2 the
 * primitive icon convention changed from `Icon<Name>Outline<16|14>` to
 * `Icon<Name>Outline{Medium|Regular}`. The browser half still imported the old
 * names, so those imports were `undefined` at runtime, rendering `<undefined />`
 * threw, and BOTH the panel and the settings section came up blank — while the
 * sidebar row (a pure inline SVG using no SDK icon) kept rendering.
 *
 * Nothing in the toolchain could see it: `tsc` trusted the stale shim, the whole
 * unit suite never renders the real SDK, and the client harness stubbed every
 * primitives property with a component, so `undefined` was impossible to observe.
 *
 * These tests pin the four things that make that failure impossible to repeat:
 *
 *   1. the browser half imports NO icon from the SDK (glyphs are ours);
 *   2. the shim declares no `Icon*` names, so a re-added import fails `tsc`;
 *   3. every seat is wrapped in a render guard, so a future throw is VISIBLE;
 *   4. the tooling that checks the live runtime exists and is wired into `verify`,
 *      and the client harness allow-lists primitives instead of stubbing blindly.
 */

import { describe, expect, it } from 'vitest'

import { readRepoFile, listSourceFiles, repoPath } from './helpers.js'

/** Every source file, with its text and repo-relative path. */
function sources(): Array<{ path: string; text: string }> {
  return listSourceFiles().map((absolute) => ({
    path: repoPath(absolute),
    text: readRepoFile(repoPath(absolute)),
  }))
}

describe('不再从 SDK 取图标', () => {
  it('src/ 里没有任何 Icon* 值从 primitives 导入', () => {
    const offenders: string[] = []
    for (const file of sources()) {
      for (const [index, line] of file.text.split(/\r?\n/).entries()) {
        if (!line.includes('@deepseek-ai/dsh-client-ui-primitives')) continue
        if (/^\s*(\*|\/\/)/.test(line)) continue
        if (/\bIcon[A-Za-z0-9_]*/.test(line)) {
          offenders.push(`${file.path}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('面板只从 primitives 取 Input / Modal', () => {
    const panel = readRepoFile('src/client/panel.tsx')
    const match = /import\s*\{([^{}]*)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/.exec(panel)
    expect(match, 'panel.tsx 必须从 primitives 导入它真正用到的东西').not.toBeNull()
    const names = (match?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    expect(names.sort()).toEqual(['Input', 'Modal'])
  })

  it('我们自己的 glyph 用 currentColor 画线，不写死颜色', () => {
    const glyph = readRepoFile('src/client/icon.tsx')
    for (const name of ['IconPlus', 'IconClose', 'IconRefresh', 'IconChevronDown']) {
      expect(glyph, `icon.tsx 必须定义 ${name}`).toMatch(new RegExp(`export function ${name}\\(`))
    }
    expect(glyph).toMatch(/stroke="currentColor"|stroke: 'currentColor'/)
    expect(glyph).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })

  it('type shim 不再声明任何 Icon* —— 这样重新引入会直接编译失败', () => {
    const shim = readRepoFile('types/dsh/index.d.ts')
    expect(shim).not.toMatch(/export function Icon/)
    expect(shim).not.toMatch(/interface IconProps/)
    // And the reason is recorded where the next reader will look.
    expect(shim).toMatch(/0\.2\.0-rc\.2/)
  })
})

describe('座位有渲染护栏，失败必须看得见', () => {
  const client = readRepoFile('src/client/index.ts')

  it('每个座位都经 withSeatBoundary 注册', () => {
    for (const seat of ['CodeHubPanelGlyph', 'CodeHubPanel', 'CodeHubSettingsCard', 'LoginOverlay']) {
      expect(client, `${seat} 必须被渲染护栏包住`).toMatch(
        new RegExp(`withSeatBoundary\\(\\s*${seat}\\s*\\)`),
      )
    }
  })

  it('注册进槽位的都是被包住的那个组件', () => {
    // The seats register the guarded identifiers, not the raw components.
    const panellist = client.slice(client.indexOf("'sidebar.panellist'"), client.indexOf("'main'", client.indexOf("'sidebar.panellist'")))
    expect(panellist).toMatch(/GuardedPanelGlyph/)
    expect(client).toMatch(/withSeatBoundary\(CodeHubLoginOverlay\)|GuardedLoginOverlay/)
    expect(client).toMatch(/GuardedSettingsCard satisfies/)
  })

  it('护栏本身不依赖 SDK —— 会加载失败的护栏保护不了任何东西', () => {
    const boundary = readRepoFile('src/client/error-boundary.tsx')
    expect(boundary).not.toMatch(/@deepseek-ai\//)
    expect(boundary).toMatch(/getDerivedStateFromError/)
    expect(boundary).toMatch(/componentDidCatch/)
    // The message must name the check that localises the failure.
    expect(boundary).toMatch(/verify:sdk/)
  })
})

describe('检查工具本身必须在位', () => {
  it('存在针对真实运行时的 SDK 表面检查', () => {
    const checker = readRepoFile('scripts/check-sdk-surface.mjs')
    // It must read the real archive, not a bundled copy.
    expect(checker).toMatch(/app\.asar|DSH_ASAR/)
    expect(checker).toMatch(/openArchive/)
    // Only VALUE imports can break at runtime; type imports are erased.
    expect(checker).toMatch(/typeOnly/)
  })

  it('verify 先跑 SDK 表面检查，再跑产物检查', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['verify']).toMatch(/check-sdk-surface\.mjs/)
    expect(pkg.scripts['verify:sdk']).toMatch(/check-sdk-surface\.mjs/)
    // The surface check must come FIRST: a missing name explains later failures.
    const order = pkg.scripts['verify'] ?? ''
    expect(order.indexOf('check-sdk-surface.mjs')).toBeLessThan(order.indexOf('verify-artifacts.mjs'))
  })

  it('客户端运行时检查用白名单，而不是「任何名字都返回一个组件」', () => {
    const harness = readRepoFile('scripts/check-client-seats.mjs')
    expect(harness).toMatch(/ALLOWED_PRIMITIVES/)
    expect(harness).toMatch(/UNEXPECTED primitives export/)
    // The old shape: a Proxy that answered EVERY property with a stub component.
    // That is exactly why `undefined` was invisible here.
    expect(harness).not.toMatch(/get:\s*\(_target,\s*key\)\s*=>\s*\{[^}]*return componentStub\s*\n?\s*\}/)
  })
})
