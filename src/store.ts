/**
 * dsh-codehub — local store: `$DSH_HOME/dsh-codehub.json` (0600).
 *
 * WHAT LIVES HERE, AND WHY
 * ------------------------
 * Exactly one class of value: things that are sensitive but are NOT credentials.
 * Today that is the local proxy address (备注① target, docs/DESIGN.md §4) plus a
 * fallback configuration snapshot used while the settings RPC cannot persist our
 * namespace.
 *
 * Credentials never come near this file. `ctx.credentials` owns them, and this
 * module enforces that structurally rather than by convention:
 *
 *   - only three top-level keys are ever written (`localProxy`,
 *     `fallbackConfig`, `updatedAt`);
 *   - every nested key is passed through `isSecretKey()` from `config.ts`, so a
 *     value that reached the store under a name like `giteeToken`,
 *     `csdnCookie` or `authorization` is DROPPED on both write and read;
 *   - the scrubber is depth- and size-bounded, so a hostile or buggy caller
 *     cannot use the store as an unbounded blob either.
 *
 * Hence the counter-example in docs/DESIGN.md §4 — `dsh-ssh` writing an SSH
 * password in plaintext next to its config — is not repeatable here even by
 * accident: there is no code path that copies an arbitrary object into the file.
 *
 * PERMISSIONS
 * -----------
 * Directory `0700`, file `0600`, applied at creation AND re-applied after the
 * atomic rename (`rename` keeps the temp file's mode, but a pre-existing target
 * on some filesystems would otherwise win). Windows ignores POSIX mode bits for
 * anything but the read-only flag, so `chmod` is best-effort and never fatal.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { isSecretKey } from './config.js'
import type { CodehubConfig } from './config.js'

/** File name inside `$DSH_HOME`. */
export const STORE_FILE_NAME = 'dsh-codehub.json'

/** Directory mode for `$DSH_HOME` (only applied when we create it). */
export const STORE_DIR_MODE = 0o700

/** File mode for the store. 0600 = owner read/write only. */
export const STORE_FILE_MODE = 0o600

/** Aliases kept because the project brief names these modes directly. */
export const DIR_MODE = STORE_DIR_MODE
export const FILE_MODE = STORE_FILE_MODE

/** Bounds of the scrubber. Anything larger is truncated rather than trusted. */
export const SCRUB_LIMITS = {
  maxDepth: 4,
  maxArrayItems: 64,
  maxStringChars: 512,
} as const

/** The store's on-disk shape. `fallbackConfig` is a partial `CodehubConfig`. */
export interface LocalConfig {
  /** 备注① target — the only persisted proxy address. Never logged. */
  readonly localProxy?: string
  /** Snapshot used ONLY while the settings service cannot persist our namespace. */
  readonly fallbackConfig?: CodehubConfig
  /** ISO-8601 stamp of the last write, for diagnostics. */
  readonly updatedAt?: string
}

export interface StoreWriteOutcome {
  readonly ok: boolean
  readonly path: string
  readonly value: LocalConfig
  readonly error?: string
}

export interface StoreDiagnostics {
  readonly path: string
  readonly directory: string
  readonly exists: boolean
  readonly readable: boolean
  /** Present when the file exists but could not be parsed. Never contains values. */
  readonly error?: string
}

// ---------------------------------------------------------------------------
// Path resolution. Evaluated per call so tests can point `DSH_HOME` at a temp
// directory after this module has been imported.
// ---------------------------------------------------------------------------

/** `$DSH_HOME`, else `$XDG_CONFIG_HOME/dsh`, else `~/.dsh`. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim())
  const xdg = process.env.XDG_CONFIG_HOME
  if (typeof xdg === 'string' && xdg.trim().length > 0) return join(resolve(xdg.trim()), 'dsh')
  return join(homedir(), '.dsh')
}

export function resolveStorePath(home: string = resolveDshHome()): string {
  return join(home, STORE_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Scrubbing. The guarantee: nothing secret-shaped survives, at any depth.
// ---------------------------------------------------------------------------

/**
 * Depth- and size-bounded, secret-key-dropping JSON scrubber.
 *
 * Exported so tests can prove a token cannot round-trip through the store.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'number') return value
  if (kind === 'string') {
    const text = value as string
    return text.length > SCRUB_LIMITS.maxStringChars ? text.slice(0, SCRUB_LIMITS.maxStringChars) : text
  }
  if (kind !== 'object' || depth >= SCRUB_LIMITS.maxDepth) return undefined

  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value.slice(0, SCRUB_LIMITS.maxArrayItems)) {
      const scrubbed = scrubValue(item, depth + 1)
      if (scrubbed !== undefined) out.push(scrubbed)
    }
    return out
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) continue
    const scrubbed = scrubValue(item, depth + 1)
    if (scrubbed !== undefined) out[key] = scrubbed
  }
  return out
}

/** Trim a proxy address; drop control characters and absurd lengths. */
export function normalizeLocalProxy(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we strip
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned.length === 0) return undefined
  if (/\s/.test(cleaned)) return undefined
  return cleaned.slice(0, SCRUB_LIMITS.maxStringChars)
}

function readTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Whitelist-and-scrub a parsed store file into `LocalConfig`.
 *
 * Unknown top-level keys are dropped, so a hand-edited file cannot introduce a
 * field this plugin would then start trusting.
 */
export function sanitizeLocalConfig(value: unknown): LocalConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>

  const out: {
    localProxy?: string
    fallbackConfig?: CodehubConfig
    updatedAt?: string
  } = {}

  const proxy = normalizeLocalProxy(source.localProxy)
  if (proxy !== undefined) out.localProxy = proxy

  if (typeof source.fallbackConfig === 'object' && source.fallbackConfig !== null) {
    const scrubbed = scrubValue(source.fallbackConfig)
    if (typeof scrubbed === 'object' && scrubbed !== null && !Array.isArray(scrubbed)) {
      out.fallbackConfig = scrubbed as CodehubConfig
    }
  }

  const updatedAt = readTimestamp(source.updatedAt)
  if (updatedAt !== undefined) out.updatedAt = updatedAt

  return out
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode)
  } catch {
    // Windows: only the read-only bit is real. Never fatal.
  }
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

/**
 * Serialised, atomic, permission-tight access to the store file.
 *
 * `write()` merges into whatever is already on disk (so two independent fields
 * cannot clobber each other) and is queued in-process, which makes concurrent
 * PATCH requests from the browser panel safe without a lock file.
 */
export class LocalConfigStore {
  readonly filePath: string

  private queue: Promise<unknown> = Promise.resolve()

  constructor(filePath: string = resolveStorePath()) {
    this.filePath = filePath
  }

  /** Never throws: a missing or corrupt file reads as `{}`. */
  async read(): Promise<LocalConfig> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      return sanitizeLocalConfig(JSON.parse(text))
    } catch {
      return {}
    }
  }

  /** Merge `patch` on top of the current file, scrub, then write atomically. */
  async write(patch: LocalConfig): Promise<StoreWriteOutcome> {
    const run = this.queue.then(
      async (): Promise<StoreWriteOutcome> => {
        const current = await this.read()
        const merged = sanitizeLocalConfig({
          ...current,
          ...(patch.localProxy !== undefined ? { localProxy: patch.localProxy } : {}),
          ...(patch.fallbackConfig !== undefined ? { fallbackConfig: patch.fallbackConfig } : {}),
          updatedAt: new Date().toISOString(),
        })
        return this.persist(merged)
      },
    )
    // Keep the chain alive even when this write failed.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Diagnostics for the `detect` route. Never returns stored values. */
  async diagnostics(): Promise<StoreDiagnostics> {
    const directory = dirname(this.filePath)
    try {
      const text = await readFile(this.filePath, 'utf8')
      try {
        JSON.parse(text)
        return { path: this.filePath, directory, exists: true, readable: true }
      } catch (error) {
        return { path: this.filePath, directory, exists: true, readable: false, error: messageOf(error) }
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') return { path: this.filePath, directory, exists: false, readable: false }
      return { path: this.filePath, directory, exists: false, readable: false, error: messageOf(error) }
    }
  }

  private async persist(value: LocalConfig): Promise<StoreWriteOutcome> {
    const target = this.filePath
    const directory = dirname(target)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      await mkdir(directory, { recursive: true, mode: STORE_DIR_MODE })
      await chmodBestEffort(directory, STORE_DIR_MODE)

      const body = `${JSON.stringify(value, null, 2)}\n`
      await writeFile(temporary, body, { encoding: 'utf8', mode: STORE_FILE_MODE })
      await chmodBestEffort(temporary, STORE_FILE_MODE)
      await rename(temporary, target)
      await chmodBestEffort(target, STORE_FILE_MODE)

      return { ok: true, path: target, value }
    } catch (error) {
      try {
        await unlink(temporary)
      } catch {
        // The temp file never existed, or cleanup itself failed. Nothing to do.
      }
      return { ok: false, path: target, value, error: messageOf(error) }
    }
  }
}
