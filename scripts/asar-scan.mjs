/**
 * Byte-scan the ASAR for needles, without parsing its header.
 *
 * WHY: the SDK packages the client half imports ship inside `app.asar`. The repo
 * carries a hand-written type shim mirrored from ONE version, so the question
 * "does the LIVE runtime still export this name?" can only be answered from the
 * archive. A header parse is unnecessary for that: stream the file and search.
 *
 * CLI: node scripts/asar-scan.mjs <needle> [needle ...]
 */

import { open } from 'node:fs/promises'

const ARCHIVE = process.env.DSH_ASAR ?? 'D:\\deepseek_desktop\\resources\\app.asar'
const CHUNK = 8 * 1024 * 1024

/** Stream the archive, reporting every occurrence of each needle. */
export async function scan(needles, { archive = ARCHIVE, maxHits = 3, context = 90 } = {}) {
  const handle = await open(archive, 'r')
  const { size } = await handle.stat()
  const found = new Map(needles.map((needle) => [needle, []]))
  const buffer = Buffer.alloc(CHUNK)
  let carry = Buffer.alloc(0)

  for (let position = 0; position < size; position += CHUNK) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK, position)
    if (bytesRead === 0) break
    const window = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
    const text = window.toString('latin1')
    for (const needle of needles) {
      const hits = found.get(needle)
      if (hits.length >= maxHits) continue
      let from = 0
      while (hits.length < maxHits) {
        const at = text.indexOf(needle, from)
        if (at === -1) break
        const start = Math.max(0, at - context)
        const end = Math.min(text.length, at + needle.length + context)
        hits.push({ absolute: position - carry.length + at, snippet: text.slice(start, end) })
        from = at + needle.length
      }
    }
    // Overlap so a needle spanning a chunk boundary is still found.
    carry = window.subarray(Math.max(0, window.length - 256))
    if (needles.every((needle) => found.get(needle).length > 0)) break
  }

  await handle.close()
  return { size, found }
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('asar-scan.mjs')
if (isMain) {
  const needles = process.argv.slice(2)
  if (needles.length === 0) {
    console.log('usage: node scripts/asar-scan.mjs <needle> [needle ...]')
    process.exitCode = 2
  } else {
    const { size, found } = await scan(needles)
    console.log(`archive: ${ARCHIVE} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    for (const [needle, hits] of found) {
      console.log(`\n=== ${needle}: ${hits.length === 0 ? 'NOT FOUND' : `${hits.length} hit(s)`}`)
      for (const hit of hits) console.log(`  @${hit.absolute}: …${hit.snippet.replace(/\s+/g, ' ')}…`)
    }
  }
}
