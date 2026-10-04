/**
 * dsh-codehub — hand-written contract shims for the DSH/Cordis plugin SDK.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The `@deepseek-ai/dsh-*` packages are NOT installed on disk in this
 * deployment. They ship inside the DSH runtime bundle
 * (`D:\deepseek_desktop\resources\app.asar\dsh\node_modules\@deepseek-ai\...`),
 * which is not readable as a directory. There is therefore no upstream `.d.ts`
 * to import.
 *
 * These shims are typed from the LIVE running runtime via the Cordis Inspect
 * providers (`platform:'host'|'client'`, providers `Service` / `Slots` /
 * `Theme`) and from real shipped TypeScript in installed plugins. They are a
 * structural mirror of that observed surface, not an official declaration.
 *
 * Verified against DSH 0.1.5-rc.3 (web profile).
 *
 * KNOWN GOOD: every signature below was observed live or read out of shipping
 * plugin source. KNOWN LIMITATION: fields neither observed live nor exercised by
 * a shipping plugin are omitted rather than guessed, so a call this file rejects
 * may still be legal upstream. When that happens, widen the shim from observed
 * evidence — never widen it speculatively.
 *
 * CORRECTIONS THIS FILE ENCODES (do not "fix" them back):
 *  - `ToolDefinition.parameters` is RAW JSON Schema. It was typed here as the
 *    sugar `Record<string, ParamSpec> | ObjectSchema`, which is what let a
 *    schema whose root keys are the parameter names ship — and `maxItems` as a
 *    root key made the provider reject the tool ("is not of type integer"),
 *    killing every conversation. Only `defineTool()` compiles the sugar DSL;
 *    `tools.register()` forwards `parameters` verbatim. See the field's own doc.
 *  - `settings` has NO `installSection` and NO `register`. Settings forms are
 *    derived from a plugin's exported schemastery `Config`. dsh-ssh's
 *    `installSection` call site is dead code on this runtime (both `typeof`
 *    guards are false) and is NOT a recipe.
 *  - A client plugin module exports a NAMED `apply` and a NAMED `inject`; it is
 *    not a default export. The bundle is wrapped in
 *    `window.__ModuleLoader__.load({ id, factory })`.
 *  - `ctx.slots.register` THROWS on a slot the ledger has not declared; use
 *    `ctx.slots.inject(slot, cb)` to wait for the declaration.
 *  - There is no host http/fetch/net/proxy/tls service. Outbound calls use
 *    global `fetch` (Node ^22.19.0 || >=24.0.0).
 */

declare module '@deepseek-ai/cordis' {
  /** Opaque per-plugin context handle. */
  export interface Context {
    /**
     * Register a scoped effect. The callback's return value is the disposer,
     * run when this fiber unloads.
     */
    effect(callback: () => void | (() => void), label?: string): () => void
    /** Resolve an optional service. Never throws on a missing name. */
    get<T = unknown>(name: string): T | undefined
    /** Run `callback` once the named services are all available. */
    inject(names: string[], callback: (scoped: Context) => void): () => void
    /** Subscribe to a runtime event. */
    on(event: string, listener: (...args: never[]) => void): () => void
  }

  export type Fiber = unknown

  /** Base class for a service. Registration happens in `super(ctx, key)`. */
  export abstract class Service {
    constructor(ctx: Context, key: string)
  }
}

declare module '@deepseek-ai/dsh-tools' {
  import type { Context } from '@deepseek-ai/cordis'

  /** One content block a tool render may emit. */
  export type ContentBlock = { type: 'text'; text: string }

  /**
   * The sugar parameter DSL. `required` sits ON the property; `parameters` is a
   * bare arg-name -> spec map with no `type`/`properties` wrapper.
   */
  export interface ParamSpec {
    type?: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null'
    description?: string
    required?: boolean
    enum?: readonly unknown[]
    const?: unknown
    /** A nested object schema, or a plain spec. */
    items?: ParamSpec | ObjectSchema
    oneOf?: readonly ParamSpec[]
    properties?: Record<string, ParamSpec | ObjectSchema>
    additionalProperties?: boolean
  }

  /**
   * The full JSON-Schema object form, used for `output.schema`.
   *
   *  `required` is an ARRAY OF PROPERTY NAMES here, not the sugar boolean.
   *  Writing `required: true` on a property of an `output.schema` fails the
   *  whole tool registration with `unsupported JSON schema:
   *  schema.properties.<name>.required is not supported on type "<type>"`. */
  export interface ObjectSchema extends Omit<ParamSpec, 'type' | 'required' | 'items'> {
    type: 'object'
    required?: readonly string[]
    items?: ParamSpec | ObjectSchema
  }

  export interface ToolDefinition {
    name: string
    description: string
    /**
     * JSON Schema object for the arguments — RAW JSON Schema, not the `ParamSpec`
     * map above.
     *
     * CORRECTION (observed live, 2026-10-03, and the cause of a total outage):
     * `tools.register()` forwards this object to the provider UNCHANGED. Only
     * `defineTool()` compiles the per-property DSL into JSON Schema, via
     * `parameterSchemaSpecToJsonSchema`. A hand-built definition that passes
     * `{ query: {...}, maxItems: {...} }` therefore ships a schema whose root keys
     * are the parameter names, and any name that is also a JSON Schema keyword is
     * read as that keyword. The live failure was:
     *
     *   Invalid schema for function 'learn_code_from_web':
     *   {"type":"integer","description":"…"} is not of type "integer"
     *
     * i.e. the `maxItems` PROPERTY read as the `maxItems` KEYWORD. The earlier
     * `Record<string, ParamSpec>` typing on this field was WRONG and is what let
     * the bug ship; do not restore it.
     */
    parameters?: Record<string, unknown>
    output?: {
      schema: ObjectSchema
      render: (args: never, value: never) => ContentBlock[]
    }
    timeoutMs?: number
    execute: (args: never, exec: ToolExecutionInput) => Promise<unknown>
  }

  /** What `execute` receives alongside its arguments. */
  export interface ToolExecutionInput {
    /** Cancellation signal for the calling turn. */
    readonly signal?: AbortSignal
    /** The live calling agent, when the runtime supplies one. */
    readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
  }

  /** The tool registry service (`ctx.tools`). */
  export interface ToolsService {
    register(definition: ToolDefinition): () => void
    get(name: string, scope?: string): ToolDefinition | undefined
    restrict(filter: unknown): () => void
    guard(guard: unknown): () => void
  }

  export function defineTool<T extends ToolDefinition>(definition: T): T
}

declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  /**
   * One named route. The registry rejects a duplicate `(kind, path)`, so a
   * single handler owns every HTTP method on its path and must dispatch itself.
   */
  export interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }

  export interface WebUpgradeRoute {
    path: string
    handler: (req: IncomingMessage, socket: unknown, head: Uint8Array) => void | Promise<void>
  }

  export interface WebServerService {
    register(route: WebRoute): () => void
    registerUpgrade(route: WebUpgradeRoute): () => void
    registerFallback(handler: WebRoute['handler']): () => void
  }
}

declare module '@deepseek-ai/dsh-system-prompt' {
  /** One prompt fragment contributed by a plugin. */
  export interface PromptSection {
    name: string
    order?: number
    text: string
  }

  export interface SystemPromptService {
    /** Returns the disposer that unregisters the section. */
    section(section: PromptSection): () => void
  }
}

declare module '@deepseek-ai/dsh-settings' {
  import type { Context } from '@deepseek-ai/cordis'

  export type SettingsNamespace = string & { readonly __brand?: 'SettingsNamespace' }

  export type SettingsPathOp =
    | { op: 'set'; path: readonly string[]; value: unknown }
    | { op: 'unset'; path: readonly string[] }

  export interface RedactedSecret {
    path: string[]
    set: boolean
  }

  export interface SettingsDescriptor {
    ns: SettingsNamespace
    autoGenerate: boolean
    schema: unknown
    value: unknown
    revision: number
    base?: unknown
    user?: unknown
    applies: 'live'
    secrets?: RedactedSecret[]
  }

  /**
   * The COMPLETE method list observed live. `installSection` and `register` are
   * absent on purpose — see the file header.
   */
  export interface SettingsService {
    configure(presentation: { auto?: boolean }, owner?: unknown): () => void
    describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>
    replace(ns: string, section: object, expectedRevision?: number): Promise<void>
    mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  }
}

declare module '@deepseek-ai/dsh-credentials' {
  /**
   * A reference into the credential seam. A plain string that doubles as an
   * environment-variable name.
   */
  export type CredentialRef = string & { readonly __brand?: 'CredentialRef' }

  /** Opaque credential key for plugin-owned records. */
  export type CredentialKey = string & { readonly __brand?: 'CredentialKey' }

  export interface ResolvedCredential {
    value: string
    source: string
  }

  export interface CredentialInfo {
    configured: boolean
    source?: string
    writable: boolean
  }

  export interface CredentialRecordEntry {
    key: CredentialKey
    kind: string
  }

  export interface ApiKeyRecord {
    readonly kind: 'api-key'
    readonly key?: string
    readonly env?: Readonly<Record<string, string>>
  }

  export interface GrantRecord {
    readonly kind: 'grant'
    readonly payload: unknown
  }

  export type CredentialRecord = ApiKeyRecord | GrantRecord

  export interface CredentialRecordInfo {
    configured: boolean
    kind?: CredentialRecord['kind']
    writable: boolean
  }

  export interface CredentialsService {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
    describe(ref: CredentialRef): Promise<CredentialInfo>
    set(ref: CredentialRef, value: string): Promise<void>
    unset(ref: CredentialRef): Promise<void>
    readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
    describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>
    listRecords(): Promise<readonly CredentialRecordEntry[]>
    modifyRecord(
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ): Promise<CredentialRecord | undefined>
    deleteRecord(key: CredentialKey): Promise<void>
  }

  export function credentialRef(value: string): CredentialRef
  export function credentialKey(value: string): CredentialKey
}

declare module '@deepseek-ai/dsh-llm' {
  export type { ContentBlock } from '@deepseek-ai/dsh-tools'
}

declare module '@deepseek-ai/dsh-web' {
  export interface WebFetchBody {
    kind: 'html' | 'text'
    content: string
  }

  export interface WebFetchResult {
    url: string
    statusCode: number
    body: WebFetchBody
    truncated: boolean
  }

  export interface WebService {
    fetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResult>
    search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<unknown>
  }
}

// ---------------------------------------------------------------------------
// Browser half.
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** A component receives whatever the registering `inject` face returns. */
  export type InjectFace<T> = T
  /** Owner props for the seat plus its injected face. */
  export type PropsRuntime<K extends string> = { readonly slot: K }
  /** Locale props: `t` bound to the registration's locale namespace. */
  export type PropsLocale<K extends string> = { readonly t: (key: K, params?: Record<string, unknown>) => string }
  export type Translate = (key: string, params?: Record<string, unknown>) => string
  export type TranslateNS<K extends string> = (key: K, params?: Record<string, unknown>) => string
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export interface InputProps {
    value?: string
    defaultValue?: string
    placeholder?: string
    type?: string
    onChange?: (event: { target: { value: string } }) => void
    disabled?: boolean
    'aria-label'?: string
  }
  export function Input(props: InputProps): ReactNode

  export interface ModalProps {
    open?: boolean
    onClose?: () => void
    title?: ReactNode
    children?: ReactNode
  }
  export function Modal(props: ModalProps): ReactNode

  export function Menu(props: Record<string, unknown>): ReactNode

  /*
   * ICONS ARE DELIBERATELY NOT DECLARED HERE. DO NOT ADD THEM BACK.
   *
   * This block used to declare `IconPlusOutline16`, `IconCloseOutline16`,
   * `IconRefreshOutline16`, `IconChevronDownOutline14` and seven more. Those names
   * exist in NO shipped runtime: the desktop app here is DSH 0.2.0-rc.2 and the
   * primitive icon convention is `Icon<Name>Outline{Medium|Regular}` — numeric
   * suffixes are gone (verified against the live package read out of `app.asar`;
   * all 11 old names are absent, 186 new-style icon names are present).
   *
   * Declaring the stale names here was worse than a doc error: it made `tsc`
   * accept imports that were `undefined` at runtime, and rendering an undefined
   * component throws — which blanked the panel and the settings section entirely
   * while typecheck, build and the whole unit suite stayed green.
   *
   * So the browser half now draws its own glyphs (`src/client/icon.tsx`), and this
   * shim declares only the primitives it really imports. A re-added SDK icon fails
   * `tsc` here, and `scripts/check-sdk-surface.mjs` independently verifies every
   * VALUE imported from `@deepseek-ai/*` against the installed runtime.
   */
}

declare module '@deepseek-ai/dsh-client-locale' {
  export interface LocaleService {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
    subscribe(listener: () => void): () => void
    getSnapshot(): { active: string }
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings' {
  /**
   * The client face of a settings namespace.
   *
   * KNOWN TRAP (observed in shipping code, and it applies here): a refused
   * mutation does not reject. The scope recovers with a fresh host view and
   * resolves either way, so awaiting `mutate` proves nothing — the outcome must
   * be judged by reading the settled snapshot back.
   */
  export interface SettingsScopeSnapshot<S> {
    status: 'ready' | 'loading' | 'unavailable' | string
    writable: boolean
    value: S | undefined
    base: S | undefined
    user: Record<string, unknown>
    revision: number
    mode: string
  }

  export interface SettingsScope<S> {
    getSnapshot(): SettingsScopeSnapshot<S>
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): void | Promise<void>
    mutate(ops: readonly SettingsPathOp[]): Promise<void>
  }

  export interface SettingsScopeSpec<S> {
    namespace: string
    schema?: unknown
    initial?: S
  }

  export interface SettingsScopeBinder {
    bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S>
  }

  export type SettingsPathOp =
    | { op: 'set'; path: readonly string[]; value: unknown }
    | { op: 'unset'; path: readonly string[] }
}

declare module '@deepseek-ai/dsh-client-ui-renderer' {
  /**
   * The slot registry (`ctx.slots`), owned by the renderer since 0.1.2.
   *
   * `register` THROWS if the slot is not declared on the ledger. `inject` is the
   * declaration-aware form: its callback runs synchronously when the slot is
   * already declared, otherwise inside the declaring `register()` call once the
   * declaration commits.
   */
  export interface SlotRegistration {
    name: string
    /** List seats use `id`; keyed seats use `key` instead. */
    id?: string
    key?: string
    order?: number
    priority?: number
    label?: () => string
    locale?: string
    inject?: (ownerArg?: unknown) => object
  }

  export interface SlotsService {
    register(registration: SlotRegistration, component: unknown): () => void
    inject(slot: string, callback: () => void | (() => void)): () => void
  }
}
