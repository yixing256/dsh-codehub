/**
 * dsh-codehub — runtime check of the HOST half.
 *
 * WHY THIS EXISTS
 * ---------------
 * The failure that took the plugin down was invisible to typecheck, to the build
 * and to the whole unit suite, because none of them ever looked at the object the
 * runtime is actually handed:
 *
 *   Invalid schema for function 'learn_code_from_web':
 *   {"type":"integer","description":"…"} is not of type "integer"
 *
 * `ToolRuntime.register()` validates `output.schema` and NOTHING ELSE — it never
 * touches `parameters`. Only `defineTool()` compiles the author-facing
 * per-property DSL. So a hand-built definition that passes the DSL map ships a
 * schema whose ROOT KEYS are the parameter names, the provider reads the
 * `maxItems` property as the `maxItems` keyword, and it rejects every request in
 * the session.
 *
 * This script loads the REAL built host bundle, mounts it on a minimal Cordis
 * context, captures the definition `tools.register()` receives, and checks it
 * with the runtime's OWN schema validators — then calls the tool once to prove the
 * decision gate still refuses without touching the network.
 *
 * Run: node scripts/check-host-mount.mjs   (after `pnpm run build`)
 */

import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const notes = []
const failures = []
const ok = (label) => notes.push(`  ok   ${label}`)
const fail = (label) => failures.push(label)
const check = (condition, label) => (condition ? ok(label) : fail(label))

/**
 * ISOLATE `$DSH_HOME` BEFORE LOADING THE PLUGIN — this check must be hermetic.
 *
 * `service.resolve()` merges `$DSH_HOME/dsh-codehub.json` (the fallback snapshot
 * kept for runtimes whose settings namespace is read-only) on top of the config
 * it is handed. On a machine that has really used the plugin, that file carries
 * ANSWERED decisions, so mounting with `{}` no longer means "four decisions
 * unset" — the gate legitimately opens and the refusal assertion below fails.
 *
 * That is a property of the reader's machine, not of the code, so the check pins
 * `DSH_HOME` at an empty temp directory. `resolveDshHome()` reads the env var per
 * call, which is exactly why this works after import — but the env must be set
 * before the bundle is imported so no cached path can win.
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-codehub-store-check-'))

// ---------------------------------------------------------------------------
// Mount the built host bundle on a minimal context
// ---------------------------------------------------------------------------

const plugin = await import('../lib/index.mjs')

const registered = []
const routes = []
const promptSections = []
const effects = []
const providedServices = []

const ctx = {
  effect(body, label) {
    const dispose = body()
    effects.push(label ?? '(unlabelled)')
    return typeof dispose === 'function' ? dispose : () => {}
  },
  /**
   * `Cordis.Service`'s constructor is `ctx.reflect.provide(name, this, check)`, so
   * a context without `reflect` cannot construct the plugin's service at all. This
   * is the one piece of real context machinery the harness has to supply.
   */
  reflect: {
    provide(name, instance) {
      providedServices.push(name)
      return () => {}
    },
  },
  get(name) {
    if (name === 'tools') {
      return {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      }
    }
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {}
        },
        registerUpgrade: () => () => {},
        registerFallback: () => () => {},
      }
    }
    if (name === 'systemPrompt') {
      return {
        section(section) {
          promptSections.push(section)
          return () => {}
        },
      }
    }
    // `web` (the harness web service) is optional and legitimately absent.
    return undefined
  },
  on: () => () => {},
}

let mounted = true
try {
  // The plugin logs its mount diagnostics through console.warn — wanted in the
  // app, noise here. The captured facts are asserted below instead.
  const realWarn = console.warn
  console.warn = () => {}
  try {
    plugin.apply(ctx, {})
    ok('apply() ran without throwing')
  } finally {
    console.warn = realWarn
  }
} catch (error) {
  mounted = false
  fail(`apply() threw: ${error instanceof Error ? error.message : String(error)}`)
}

// ---------------------------------------------------------------------------
// The tool definition the runtime is handed
// ---------------------------------------------------------------------------

if (!mounted) {
  report()
} else {
  check(registered.length === 1, `exactly one tool registered (got ${registered.length})`)

  const tool = registered[0]
  if (tool === undefined) {
    fail('no tool definition captured')
    report()
  } else {
    check(tool.name === 'learn_code_from_web', `tool name is learn_code_from_web (got ${String(tool.name)})`)
    check(typeof tool.description === 'string' && tool.description.length > 0, 'tool carries a description')
    check(
      typeof tool.execute === 'function',
      'tool carries an execute function',
    )

    const parameters = tool.parameters
    check(
      parameters !== null && typeof parameters === 'object',
      'the tool ships a parameters object',
    )

    if (parameters === null || typeof parameters !== 'object') {
      fail('nothing to inspect in `parameters`')
      report()
    } else {
      // ---- the exact shape the provider reads -------------------------------
      check(parameters.type === 'object', `parameters root is type "object" (got ${JSON.stringify(parameters.type)})`)
      check(
        parameters.properties !== null && typeof parameters.properties === 'object',
        'parameters root declares `properties`',
      )
      check(Array.isArray(parameters.required), 'parameters root uses the `required` NAME ARRAY form')

      // The decisive check: a parameter name at the ROOT is a JSON-Schema
      // keyword candidate, and `maxItems` is the name that broke the provider.
      const paramNames = Object.keys(parameters.properties ?? {})
      const leaked = paramNames.filter((name) => Object.hasOwn(parameters, name))
      check(
        leaked.length === 0,
        `no parameter name sits at the schema root (leaked: ${leaked.join(', ') || 'none'})`,
      )
      check(
        paramNames.includes('maxItems') && parameters.properties.maxItems.type === 'integer',
        'maxItems is declared as a property, typed integer',
      )
      check(!/["']?maxItems["']?\s*:/.test(JSON.stringify({ ...parameters, properties: undefined })),
        'the root serialisation contains no `maxItems` key')

      // ---- the runtime's OWN validators -------------------------------------
      // Extra safety: `register()` does not check `parameters` today, so passing
      // this proves the schema is acceptable even if that changes.
      try {
        assertSupportedJsonSchema(parameters)
        ok('the runtime accepts parameters as supported JSON Schema')
      } catch (error) {
        fail(`assertSupportedJsonSchema(parameters) rejected it: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        assertObjectJsonSchema(parameters)
        ok('the runtime accepts parameters as an object-rooted JSON Schema')
      } catch (error) {
        fail(`assertObjectJsonSchema(parameters) rejected it: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        assertSupportedJsonSchema(tool.output?.schema)
        ok('the runtime accepts the output schema')
      } catch (error) {
        fail(`assertSupportedJsonSchema(output.schema) rejected it: ${error instanceof Error ? error.message : String(error)}`)
      }

      // ---- the decision gate still refuses, offline -------------------------
      if (typeof tool.execute === 'function') {
        try {
          const outcome = await tool.execute({ query: 'cordis service 生命周期' }, {})
          check(outcome?.ok === false, 'with the four decisions unset the tool refuses (ok:false)')
          check(
            Array.isArray(outcome?.unresolved_decisions) && outcome.unresolved_decisions.length > 0,
            `the refusal carries the questions to relay (${outcome?.unresolved_decisions?.length ?? 0} decisions)`,
          )
          check(
            Array.isArray(outcome?.results) && outcome.results.length === 0,
            'the refusal returns zero results — no network request was made',
          )
        } catch (error) {
          fail(`execute() threw instead of returning a refusal: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  // ---- the rest of the plugin surface --------------------------------------
  check(promptSections.length === 1, `exactly one system-prompt section (got ${promptSections.length})`)
  const promptText = promptSections[0]?.text ?? ''
  check(promptText.includes('代码用法学习源'), 'the prompt section carries the anti-copy statement')
  check(
    routes.some((route) => String(route.path).startsWith('/api/dsh-codehub')),
    `the loopback route family is registered (${routes.map((route) => route.path).join(', ') || 'none'})`,
  )
  report()
}

function report() {
  console.log('=== dsh-codehub host-half runtime check ===')
  console.log(`  effects registered: ${effects.join(', ')}`)
  console.log(`  services provided: ${providedServices.join(', ') || 'none'}`)
  console.log(
    `  parameters root keys: ${JSON.stringify(Object.keys(registered[0]?.parameters ?? {}))}`,
  )
  for (const line of notes) console.log(line)
  if (failures.length > 0) {
    console.log(`\nFAILED (${failures.length}):`)
    for (const line of failures) console.log(`  FAIL ${line}`)
    process.exitCode = 1
  } else {
    console.log(`\nall ${notes.length} host-half checks passed`)
  }
}
