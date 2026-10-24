import { describe, expect, it } from 'vitest'
import type { PageItem } from '../../shared/protocol'
import { FIXED, GARBAGE_PER_UNIT, LAYOUT_PER_UNIT, PageCache, WRAP, capFor, charge, rowBreaks, rowCost, rowsFor, rowsOf } from './page-cache'

const PIECE = 65_536
const MAP_MAX = 393_224
const L = { pieceBytes: PIECE, mapMax: MAP_MAX }
// A 64 KiB line of CJK: 21,845 three-byte characters (a uniform map, so its points are empty).
const cjk = (line: number, points = 0): PageItem => ({
  gen: 1,
  line,
  offset: line * PIECE,
  text: '語'.repeat(21_845),
  more: true,
  map: { uniform: points === 0, start: line * PIECE, end: line * PIECE + 65_535, units: 21_845, unitBytes: 3, points: new Uint32Array(points) }
})
/** Every row of `text` per its breaks. */
const rows = (text: string) => {
  const b = rowBreaks(text)
  return b.slice(0, -1).map((at, i) => text.slice(at, b[i + 1]))
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const clusters = (text: string) => new Set([...segmenter.segment(text)].map((s) => s.index))

describe('rowBreaks (Z66)', () => {
  it('leaves a row of 2,048 units or fewer whole, and cuts longer text into rows of at most 2,048', () => {
    expect(rowBreaks('')).toEqual([0, 0])
    expect(rowBreaks('a'.repeat(WRAP))).toEqual([0, WRAP])
    const r = rows('a'.repeat(5000))
    expect(r.map((x) => x.length)).toEqual([2048, 2048, 904])
  })

  it('breaks after a space within 64 units of the limit, else at the limit', () => {
    const text = `${'a'.repeat(2000)} ${'b'.repeat(3000)}`
    expect(rows(text)[0]).toBe(`${'a'.repeat(2000)} `)
    const far = `${'a'.repeat(1900)} ${'b'.repeat(3000)}` // the space is 147 units back: no
    expect(rows(far)[0].length).toBe(2048)
  })

  it('never splits a grapheme cluster: Devanagari conjuncts, emoji sequences, surrogate pairs, a letter and its marks', () => {
    const scripts = [
      'क्ष'.repeat(1500), // a conjunct: consonant, virama, consonant
      '👩🏽‍💻'.repeat(800), // an emoji ZWJ sequence with a skin tone
      '😀'.repeat(3000), // surrogate pairs
      `e${'́'.repeat(40)}`.repeat(200), // a letter and 40 marks: clusters longer than the 64 units looked at first
      'مرحبا'.repeat(1000) // Arabic with no spaces
    ]
    for (const text of scripts) {
      const b = rowBreaks(text)
      const ok = clusters(text)
      for (const at of b.slice(1, -1)) expect(ok.has(at), `${text.slice(0, 8)}… at ${at}`).toBe(true)
      expect(Math.max(...rows(text).map((x) => x.length))).toBeLessThanOrEqual(WRAP)
      expect(rows(text).join('')).toBe(text)
    }
  })

  it('seeks a ZWJ sequence longer than the 96-unit lookback from the row start', () => {
    // 33 × (man, ZWJ) + woman = 101 units; 40 × = 122. The 96-unit slice starts inside the sequence.
    const cluster = (men: number) => `${'\u{1F468}\u200D'.repeat(men)}\u{1F469}`
    expect([cluster(33).length, cluster(40).length]).toEqual([101, 122])
    for (const text of [cluster(33), cluster(40)].map((c) => `${'a'.repeat(WRAP - 96 - 4)}${c}`)) {
      const b = rowBreaks(text)
      const ok = clusters(text)
      for (const at of b.slice(1, -1)) expect(ok.has(at), `at ${at}`).toBe(true)
      expect(Math.max(...rows(text).map((x) => x.length))).toBeLessThanOrEqual(WRAP)
      expect(rows(text).join('')).toBe(text)
    }
  })

  it('cuts a cluster longer than a row at the limit, but not inside a surrogate pair', () => {
    const zalgo = `a${'́'.repeat(3000)}`
    expect(rows(zalgo)[0].length).toBe(WRAP)
    const astral = `a${'́'.repeat(2046)}${'\u{1D167}'.repeat(10)}` // a combining mark outside the BMP at the limit
    const r = rows(astral)
    expect(r[0].length).toBe(2047)
    expect(r.join('')).toBe(astral)
  })

  it('remembers an item’s breaks', () => {
    const item = cjk(0)
    expect(rowsOf(item)).toBe(rowsOf(item))
    expect(rowsOf(item).length - 1).toBe(Math.ceil(21_845 / WRAP))
  })
})

describe('the reservation (plan C1, Z66)', () => {
  it('holds the fixed allowance, both partly mounted items, and a row’s most per row', () => {
    const row = rowCost(L)
    expect(row).toBe(2 * WRAP + 8 + Math.ceil(((MAP_MAX - 8) * 3 * WRAP) / PIECE) + WRAP * (LAYOUT_PER_UNIT + GARBAGE_PER_UNIT))
    expect(capFor(L, 10, false)).toBe(FIXED + 2 * (2 * PIECE + MAP_MAX) + 10 * row)
    expect(rowsFor(L, capFor(L, 10, false))).toBe(10)
    expect(rowsFor(L, capFor(L, 10, false) - 1)).toBe(9)
    expect(rowsFor(L, 0)).toBe(0)
  })
})

describe('PageCache', () => {
  /** Mounts rows `first` to `last` of a run of 64 KiB CJK lines: each line's 11 rows. */
  const mount = (cache: PageCache, first: number, last: number) => {
    const out = []
    for (let row = first; row < last; row++) out.push({ key: Math.floor(row / 11), sub: row % 11 })
    cache.setMounted(out)
  }

  it('never exceeds its cap in charged bytes, and never evicts a mounted line, under 64 KiB CJK items', () => {
    const cache = new PageCache(L)
    const view = 31 // 3 × ceil(200 px / 20 px) + 1
    cache.setCap(capFor(L, view))
    let seen = 0
    for (let top = 0; top < 4_000; top += 7) {
      mount(cache, top, top + view)
      const [first, last] = [Math.floor(top / 11), Math.floor((top + view - 1) / 11)]
      // Pages of up to 4 such items, as the core sends them; every third item has a dense breakpoint map.
      for (let line = first; line <= last; line += 4)
        cache.add(Array.from({ length: Math.min(4, last + 1 - line) }, (_, k) => cjk(line + k, (line + k) % 3 ? 0 : 12_000)))
      expect(cache.charged).toBeLessThanOrEqual(cache.cap)
      for (let line = first; line <= last; line++) expect(cache.has(line)).toBe(true)
      seen++
    }
    expect(seen).toBeGreaterThan(500)
    expect(cache.cap).toBe(capFor(L, view) - FIXED - rowsFor(L, capFor(L, view)) * WRAP * GARBAGE_PER_UNIT)
  })

  it('charges an item at its text and map bytes, and each mounted row its layout besides', () => {
    const cache = new PageCache(L)
    const item = cjk(0, 100)
    expect(charge(item)).toBe(2 * 21_845 + 400)
    cache.add([item])
    expect(cache.charged).toBe(charge(item))
    cache.setMounted([
      { key: 0, sub: 0 },
      { key: 0, sub: 10 }
    ])
    const b = rowsOf(item)
    expect(cache.charged).toBe(charge(item) + LAYOUT_PER_UNIT * (b[1] - b[0] + b[11] - b[10]))
  })

  it('keeps a first page added before anything is mounted (Z37: no refetch)', () => {
    const cache = new PageCache(L)
    cache.add([cjk(0), cjk(1)])
    expect(cache.has(0) && cache.has(1)).toBe(true)
  })

  it("charges a line's further pieces like first pieces, and evicts them oldest first but never a mounted one", () => {
    const cache = new PageCache(L)
    cache.setCap(capFor(L, 1))
    cache.setMounted([{ key: '0:1', sub: 0 }])
    for (let k = 1; k <= 1000; k++) cache.addPiece(`0:${k}`, cjk(0)) // 1,000 × 43,690 bytes: past the cap
    expect(cache.charged).toBeLessThanOrEqual(cache.cap)
    expect(cache.has('0:1')).toBe(true)
    expect([cache.has('0:2'), cache.has('0:1000')]).toEqual([false, true])
  })

  it('drops the items a test picks, mounted ones too, and charges only what stays', () => {
    const cache = new PageCache(L)
    const tail = cjk(0) // a last piece whose line's end wasn't known: no `next`, no `rest`
    const going = { ...cjk(1), next: { session: 1, doc: 1, gen: 1, line: 1, offset: 65_535 } } // its line goes on
    cache.add([going])
    cache.addPiece('0:15', tail)
    cache.setMounted([
      { key: 1, sub: 0 },
      { key: '0:15', sub: 0 }
    ])
    expect(cache.drop((item) => item.more && !item.next && item.rest === undefined)).toBe(1)
    expect([cache.has('0:15'), cache.has(1)]).toEqual([false, true])
    const b = rowsOf(going)
    expect(cache.charged).toBe(charge(going) + LAYOUT_PER_UNIT * (b[1] - b[0]))
  })
})
