import { describe, expect, it } from 'vitest'
import type { PageItem } from '../../shared/protocol'
import { FIXED, GARBAGE_PER_UNIT, LAYOUT_PER_UNIT, PageCache, WRAP, capFor, charge, rowBreaks, rowCost, rowsFor, rowsOf, wrapBreaks } from './page-cache'

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

  it('does not cut a grapheme whose next code point starts on the row limit', () => {
    // The scan used to end on the limit, so a surrogate pair starting there was only a high surrogate.
    const samples: [string, string][] = [
      ['skin', `${'a'.repeat(2046)}👨🏻`],
      ['zwj', `${'a'.repeat(2045)}👨‍👩`],
      ['flag', `${'a'.repeat(2046)}🇦🇧`],
      ['tag', `${'a'.repeat(2046)}🏴\u{E0067}\u{E0062}\u{E007F}`]
    ]
    const bad: string[] = []
    for (const [name, text] of samples) {
      const b = rowBreaks(text)
      const ok = clusters(text)
      const lens = rows(text).map((x) => x.length)
      if (Math.max(...lens) > WRAP || rows(text).join('') !== text) bad.push(`${name} rows ${lens.join(',')}`)
      for (const at of b.slice(1, -1)) {
        if (!ok.has(at)) bad.push(`${name} breaks ${b.join(',')} at ${at}`)
        if (at < text.length && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff) bad.push(`${name} splits a surrogate at ${at}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('keeps one grapheme whole wherever it sits across the limit', () => {
    // Seeded, so the set of clusters is fixed. Every offset 2030..2050, a few hundred strings.
    let seed = 0x5eed
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed
    }
    const zwj = (men: number) => `${'\u{1F468}\u200D'.repeat(men)}\u{1F469}`
    const men = new Set([1, 2, 6, 16, 33, 40, 66, 132])
    while (men.size < 12) men.add(1 + (next() % 132)) // lengths 5..398, inside 2..400
    const graphemes = [
      '👨🏻',
      '🇦🇧',
      '🏴\u{E0067}\u{E0062}\u{E007F}',
      ...[...men].map(zwj),
      `e${'́'.repeat(1)}`,
      `e${'́'.repeat(10)}`,
      `e${'́'.repeat(40)}`,
      `e${'́'.repeat(399)}`
    ]
    const bad: string[] = []
    let seen = 0
    for (const g of graphemes) {
      for (let offset = 2030; offset <= 2050; offset++) {
        seen++
        const text = `${'a'.repeat(offset)}${g}`
        const b = rowBreaks(text)
        const parts = [...segmenter.segment(text)]
        const ok = new Set(parts.map((s) => s.index))
        const lens = b.slice(0, -1).map((at, i) => b[i + 1] - at)
        if (lens.some((n) => n > WRAP) || rows(text).join('') !== text) {
          bad.push(`offset ${offset} len ${g.length} rows ${lens.join(',')}`)
          continue
        }
        for (let i = 1; i < b.length; i++) {
          const at = b[i]
          if (at < text.length && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff) bad.push(`offset ${offset} splits a surrogate at ${at}`)
        }
        for (const at of b.slice(1, -1)) {
          if (ok.has(at)) continue
          const owner = parts.find((s) => s.index < at && s.index + s.segment.length > at)
          if (owner && owner.segment.length > WRAP) continue
          bad.push(`offset ${offset} len ${g.length} breaks ${b.join(',')} at ${at}`)
        }
      }
    }
    // Virama chains, seeded lengths in 2..400, at every offset 1900..2050.
    let virSeed = 0xc0de
    const virNext = () => {
      virSeed = (Math.imul(virSeed, 1103515245) + 12345) & 0x7fffffff
      return virSeed
    }
    const linkers: [number, number][] = [
      [0x0915, 0x094d],
      [0x0995, 0x09cd],
      [0x0a95, 0x0acd],
      [0x0b15, 0x0b4d],
      [0x0c15, 0x0c4d],
      [0x0d15, 0x0d4d],
      [0x1000, 0x1039],
      [0x1780, 0x17d2]
    ]
    const virLengths = new Set([2, 99, 399])
    while (virLengths.size < 6) {
      const n = 1 + (virNext() % 199) // (consonant, virama) × n + consonant → 3..399
      virLengths.add(2 * n + 1)
    }
    const virChain = (ka: number, vir: number, units: number) => {
      if (units === 2) return String.fromCodePoint(ka, vir)
      const pairs = (units - 1) / 2
      return `${String.fromCodePoint(ka, vir).repeat(pairs)}${String.fromCodePoint(ka)}`
    }
    for (const [ka, vir] of linkers) {
      for (const units of virLengths) {
        const g = virChain(ka, vir, units)
        for (let offset = 1900; offset <= 2050; offset++) {
          seen++
          const text = `${'a'.repeat(offset)}${g}`
          const b = rowBreaks(text)
          const parts = [...segmenter.segment(text)]
          const ok = new Set(parts.map((s) => s.index))
          const lens = b.slice(0, -1).map((at, i) => b[i + 1] - at)
          if (lens.some((n) => n > WRAP) || rows(text).join('') !== text) {
            bad.push(`vir offset ${offset} len ${g.length} rows ${lens.join(',')}`)
            continue
          }
          for (const at of b.slice(1, -1)) {
            if (ok.has(at)) continue
            const owner = parts.find((s) => s.index < at && s.index + s.segment.length > at)
            if (owner && owner.segment.length > WRAP) continue
            bad.push(`vir offset ${offset} len ${g.length} breaks ${b.join(',')} at ${at}`)
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(300)
    expect(bad.slice(0, 8)).toEqual([])
  })

  it('does not cut a virama conjunct that straddles the row', () => {
    const chain = (ka: number, vir: number) => `${String.fromCodePoint(ka, vir).repeat(49)}${String.fromCodePoint(ka)}`
    const samples: [string, string][] = [
      ['deva', `${'a'.repeat(1951)}${chain(0x0915, 0x094d)}`],
      ['beng', `${'a'.repeat(1951)}${chain(0x0995, 0x09cd)}`],
      ['gujr', `${'a'.repeat(1951)}${chain(0x0a95, 0x0acd)}`],
      ['orya', `${'a'.repeat(1951)}${chain(0x0b15, 0x0b4d)}`],
      ['telu', `${'a'.repeat(1951)}${chain(0x0c15, 0x0c4d)}`],
      ['mlym', `${'a'.repeat(1951)}${chain(0x0d15, 0x0d4d)}`],
      ['mymr', `${'a'.repeat(1951)}${chain(0x1000, 0x1039)}`],
      ['khmr', `${'a'.repeat(1951)}${chain(0x1780, 0x17d2)}`]
    ]
    const bad: string[] = []
    for (const [name, text] of samples) {
      const parts = [...segmenter.segment(text)]
      const cluster = parts.find((s) => s.index === 1951)
      if (!cluster || cluster.segment.length !== 99) bad.push(`${name} is not one 99-unit grapheme`)
      const b = rowBreaks(text)
      const ok = new Set(parts.map((s) => s.index))
      for (const at of b.slice(1, -1)) if (!ok.has(at)) bad.push(`${name} breaks ${b.join(',')} at ${at}`)
      if (Math.max(...rows(text).map((x) => x.length)) > WRAP) bad.push(`${name} row over ${WRAP}`)
    }
    expect(bad).toEqual([])
  })

  it('cuts a virama chain longer than a row on the 2,048 grid', () => {
    const text = `a${'\u0915\u094D'.repeat(1200)}\u0915`
    expect(text.length).toBe(2402)
    const parts = [...segmenter.segment(text)]
    expect(parts.map((s) => s.segment.length)).toEqual([1, 2401])
    const b = rowBreaks(text)
    const inside = b.filter((at) => at > 1 && at < text.length)
    const off = inside.filter((at) => {
      const rel = at - 1
      return rel % 2048 !== 0 && rel % 2048 !== 2047
    })
    expect(off, `breaks ${b.join(',')}`).toEqual([])
    expect(inside.length, `breaks ${b.join(',')}`).toBeGreaterThan(0)
    expect(Math.max(...rows(text).map((x) => x.length))).toBeLessThanOrEqual(WRAP)
    expect(rows(text).join('')).toBe(text)
  })

  it('keeps cutting a cluster longer than a row at the surrogate-safe limit', () => {
    const text = `${'\u{1F468}\u200D'.repeat(2000)}\u{1F469}`
    expect(text.length).toBe(6002)
    const b = rowBreaks(text)
    const lens = rows(text).map((x) => x.length)
    expect(lens.filter((n) => n === 1), `breaks ${b.join(',')} lengths ${lens.join(',')}`).toEqual([])
    for (const n of lens.slice(0, -1)) expect(n, `lengths ${lens.join(',')}`).toBeGreaterThanOrEqual(2047)
    expect(Math.max(...lens)).toBeLessThanOrEqual(WRAP)
    for (const at of b.slice(1, -1)) expect(text.charCodeAt(at) < 0xdc00 || text.charCodeAt(at) > 0xdfff).toBe(true)
    expect(rows(text).join('')).toBe(text)
  })

  it('remembers an item’s breaks', () => {
    const item = cjk(0)
    expect(rowsOf(item)).toBe(rowsOf(item))
    expect(rowsOf(item).length - 1).toBe(Math.ceil(21_845 / WRAP))
    // Wrapping has its own breaks per width, and turning it off gives Z66's again.
    expect(rowsOf(item, 100).length - 1).toBe(Math.ceil(21_845 / 50))
    expect(rowsOf(item).length - 1).toBe(Math.ceil(21_845 / WRAP))
  })
})

describe('wrapBreaks (Wrap lines)', () => {
  const wrapped = (text: string, cols: number) => {
    const b = wrapBreaks(text, cols)
    return b.slice(0, -1).map((at, i) => text.slice(at, b[i + 1]))
  }
  it('fills rows to the column count, a wide character two columns', () => {
    expect(wrapBreaks('', 10)).toEqual([0, 0])
    expect(wrapped('a'.repeat(25), 10).map(r => r.length)).toEqual([10, 10, 5])
    expect(wrapped('語'.repeat(12), 10).map(r => r.length)).toEqual([5, 5, 2])
    expect(wrapped('ab語cd語ef', 4)).toEqual(['ab語', 'cd語', 'ef'])
  })
  it('takes a tab on to the next multiple of 8, and counts emoji and VS16 presentations two columns', () => {
    expect(wrapped('ab\tcdef', 10)).toEqual(['ab\tcd', 'ef'])
    expect(wrapped('abcdefghi\tx', 10)).toEqual(['abcdefghi', '\tx']) // a tab past the edge starts the next row
    expect(wrapped('\u{1FAE0}'.repeat(6), 4).map(r => r.length)).toEqual([4, 4, 4]) // U+1FA00 block: two emoji a row
    expect(wrapped('\u2764\uFE0F'.repeat(4), 4)).toEqual(['\u2764\uFE0F\u2764\uFE0F', '\u2764\uFE0F\u2764\uFE0F'])
  })
  it('never splits a surrogate pair or a grapheme cluster', () => {
    const text = 'a\u{20000}e\u0301\u{1F468}\u200D\u{1F469}\u200D\u{1F467}x'.repeat(40)
    for (const cols of [2, 3, 7, 80]) {
      const b = wrapBreaks(text, cols)
      for (const at of b.slice(1, -1)) expect(clusters(text).has(at), `cols ${cols} at ${at}`).toBe(true)
      expect(wrapped(text, cols).join('')).toBe(text)
    }
  })
  it('keeps every row within 2,048 units, cutting one grapheme longer than that outside its surrogate pairs', () => {
    const marks = 'a' + '\u0301'.repeat(5000)
    expect(Math.max(...wrapped(marks + 'b', 80).map(r => r.length))).toBeLessThanOrEqual(WRAP)
    const zwj = `${'\u{1F468}\u200D'.repeat(2000)}\u{1F469}`
    const b = wrapBreaks(zwj, 80)
    expect(Math.max(...wrapped(zwj, 80).map(r => r.length))).toBeLessThanOrEqual(WRAP)
    for (const at of b.slice(1, -1)) expect(zwj.charCodeAt(at) < 0xdc00 || zwj.charCodeAt(at) > 0xdfff).toBe(true)
    expect(wrapped(zwj, 80).join('')).toBe(zwj)
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
