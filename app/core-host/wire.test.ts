// Plan C2's wire bound: the largest pages of each shape, structured-cloned as `v8.serialize` does, fit within
// PAGE_WIRE_MAX, which the core derives from this representation (`pages.rs`).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { afterAll, expect, it } from 'vitest'
import { Doc, type IndexProgress, limits } from 'typose-node'

const { pageWireMax, itemWireFixed, maxItems } = limits()
const dir = mkdtempSync(join(tmpdir(), 'typose-wire-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const utf8 = (s: string) => Buffer.from(s, 'utf8')
const utf16le = (s: string) => Buffer.from(s, 'utf16le')
const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]) // forces UTF-8, so malformed lines decode as UTF-8 (spec §4.1)
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n'

// Each shape has 70 KB lines (4 first pieces fill a page) and short ones (pages that hit MAX_ITEMS or come close).
const SHAPES: Record<string, Buffer> = {
  'all-CJK': utf8(lines(8, () => '語'.repeat(23_400)) + lines(3000, (i) => '語'.repeat(1 + (i % 40)))),
  'all-malformed': Buffer.concat([BOM8, Buffer.from(lines(8, () => '\xE2\x82'.repeat(35_000)) + lines(3000, (i) => '\xE2\x82'.repeat(1 + (i % 9))), 'latin1')]),
  'alternating ASCII/2-byte': utf8(lines(8, () => 'aé'.repeat(23_400)) + lines(3000, (i) => 'aé'.repeat(1 + (i % 30)))),
  'UTF-16 surrogates': Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(lines(8, () => '😀'.repeat(17_500)) + lines(3000, (i) => '😀'.repeat(1 + (i % 20))))]),
  'all-empty': utf8('\n'.repeat(5000)),
  'alternating empty/one-character': utf8(lines(5000, (i) => (i % 2 ? 'x' : ''))),
  // Not in the plan's list: the densest map. All-astral UTF-8 stays a uniform map (2 bytes per unit, pairs listed);
  // one ASCII character first forces breakpoints, 3 per astral character.
  'UTF-8 astral after ASCII (densest map)': utf8(lines(8, () => 'a' + '😀'.repeat(17_500)) + lines(3000, (i) => 'a' + '😀'.repeat(1 + (i % 20))))
}

function indexed(doc: Doc): Promise<number> {
  return new Promise((ok, fail) =>
    doc.startIndex((p: IndexProgress) => (p.error ? fail(new Error(p.error)) : p.done && ok(p.lines)))
  )
}

it("one item's fixed fields fit ITEM_WIRE_FIXED", () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const map = { uniform: false, start: MAX, end: MAX, units: 2 ** 32 - 1, unitBytes: 2 ** 32 - 1, points: new Uint32Array(0) }
  // With a continuation token, the session and document stamped in, and the rest of a long line (plan C3, C7).
  const next = { gen: 2 ** 32 - 1, line: MAX, offset: MAX, session: MAX, doc: MAX }
  const item = { gen: 2 ** 32 - 1, line: MAX, offset: MAX, text: '一', more: true, map, next, rest: MAX }
  const fixed = serialize({ items: [item] }).byteLength - serialize({ items: [] }).byteLength
  expect(fixed).toBeLessThanOrEqual(itemWireFixed)
})

const report: string[] = []
afterAll(() => console.log(`PAGE_WIRE_MAX ${pageWireMax}\n${report.join('\n')}`))

for (const [shape, bytes] of Object.entries(SHAPES)) {
  it(`${shape}: every page serializes within PAGE_WIRE_MAX`, async () => {
    const path = join(dir, `${shape.replace(/\W+/g, '-')}.txt`)
    writeFileSync(path, bytes)
    const doc = Doc.open(path)
    const total = await indexed(doc)
    let [largest, most, start, pages] = [0, 0, 0, 0]
    while (start < total) {
      const page = doc.page(doc.generation, start, maxItems)
      for (const item of page.items) if (item.next) Object.assign(item.next, { session: Number.MAX_SAFE_INTEGER, doc: Number.MAX_SAFE_INTEGER }) // as the core host sends it
      const size = serialize(page).byteLength
      expect(size).toBeLessThanOrEqual(pageWireMax)
      largest = Math.max(largest, size)
      most = Math.max(most, page.items.length)
      start += page.items.length
      pages++
    }
    report.push(`${shape}: ${pages} pages, largest ${largest} bytes, most items ${most}`)
  })
}
