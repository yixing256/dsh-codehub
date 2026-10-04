/**
 * Minimal Electron ASAR reader — enough to list and extract a file.
 *
 * WHY: the DSH runtime (including the SDK packages the client half imports, the
 * slot ledger and the client service roster) ships inside
 * `resources/app.asar`, which is not a directory. The repo's hand-written type
 * shim was mirrored from a specific version, so when the live runtime drifts, the
 * only way to see what is REALLY provided — package versions and exported names —
 * is to read the archive.
 *
 * ASAR layout: [UInt32LE pickle size][UInt32LE json size][json header][file data].
 * Header JSON: { files: { name: { files: {...} } | { offset, size } } }.
 * A file's data begins at `dataStart + offset`.
 *
 * CLI:
 *   node scripts/asar-read.mjs list  <prefix>          # list entries under a path
 *   node scripts/asar-read.mjs poke  <file> <needle>   # print matching lines of one file
 *   node scripts/asar-read.mjs head  <file> <lines>    # print the first N lines
 */

import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const ARCHIVE = process.env.DSH_ASAR ?? 'D:\\deepseek_desktop\\resources\\app.asar'

/**
 * Open the archive and return its parsed header plus the data offset.
 *
 * Layout, established by probing the real file (not guessed):
 *   [0..4)   UInt32LE  4
 *   [4..8)   UInt32LE  4 + jsonSize
 *   [8..12)  UInt32LE  4 + jsonSize
 *   [12..16) UInt32LE  jsonSize      — length of the header JSON
 *   [16..)   the header JSON, then the file data
 * `dataStart = 8 + readUInt32LE(4)` = `16 + jsonSize`; every entry's `offset` is
 * relative to it.
 */
export async function openArchive(archive = ARCHIVE) {
  const handle = await open(archive, 'r')
  const prefix = Buffer.alloc(16)
  await handle.read(prefix, 0, 16, 0)
  const jsonSize = prefix.readUInt32LE(12)
  if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) {
    throw new Error(`implausible asar header size ${jsonSize} — not an asar archive?`)
  }
  const headerBuf = Buffer.alloc(jsonSize)
  await handle.read(headerBuf, 0, jsonSize, 16)
  const header = JSON.parse(headerBuf.toString('utf8'))
  const dataStart = 8 + prefix.readUInt32LE(4)
  return { handle, header, dataStart, archive }
}

/** Walk the header tree, yielding `{ path, offset, size }` for every file. */
export function* walk(node, prefix = '') {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = `${prefix}${name}`
    if (entry.files !== undefined) yield* walk(entry, `${path}/`)
    // Offsets arrive as STRINGS in some archives; coerce so arithmetic cannot
    // silently become string concatenation.
    else yield { path, offset: Number(entry.offset), size: Number(entry.size) }
  }
}

/** Read one file out of the archive as UTF-8. */
export async function readFileFromArchive(ctx, target) {
  for (const entry of walk(ctx.header)) {
    if (entry.path === target) {
      const buffer = Buffer.alloc(entry.size)
      await ctx.handle.read(buffer, 0, entry.size, ctx.dataStart + entry.offset)
      return buffer.toString('utf8')
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const command = argv[0]

/** True when this module was invoked directly rather than imported. */
const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (command !== undefined && isMain) {
  const ctx = await openArchive()
  const entries = [...walk(ctx.header)]

  if (command === 'list') {
    const prefix = argv[1] ?? ''
    const matches = entries.filter((entry) => entry.path.includes(prefix))
    console.log(`${matches.length} entries matching ${JSON.stringify(prefix)}:`)
    for (const entry of matches.slice(0, Number(argv[2] ?? 60))) console.log(`  ${entry.path}  (${entry.size}B)`)
  } else if (command === 'poke' || command === 'head') {
    const text = await readFileFromArchive(ctx, argv[1])
    if (text === undefined) {
      console.log(`not found: ${argv[1]}`)
      process.exitCode = 1
    } else if (command === 'poke') {
      const needle = argv[2]
      const lines = text.split(/\r?\n/).filter((line) => line.includes(needle))
      console.log(`${lines.length} matching lines:`)
      for (const line of lines.slice(0, Number(argv[3] ?? 40))) console.log(`  ${line.trim().slice(0, 400)}`)
    } else {
      const lines = text.split(/\r?\n/).slice(0, Number(argv[2] ?? 60))
      console.log(lines.join('\n'))
    }
  } else {
    console.log('usage: list <prefix> [n] | poke <file> <needle> [n] | head <file> [n]')
  }

  await ctx.handle.close()
}
