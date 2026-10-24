import { describe, expect, it } from 'vitest'
import type { PageItem } from '../../shared/protocol'
import { MOUNTED_PER_UNIT, PageCache, charge, rowCost } from './page-cache'

const PIECE = 65_536
const MAP_MAX = 393_224
const ROW = rowCost({ pieceBytes: PIECE, mapMax: MAP_MAX })
// A 64 KiB line of CJK: 21,845 three-byte characters (a uniform map, so its points are empty).
const cjk = (line: number, points = 0): PageItem => ({
  gen: 1,
  line,
  offset: line * PIECE,
  text: '語'.repeat(21_845),
  more: true,
  map: { uniform: points === 0, start: line * PIECE, end: line * PIECE + 65_535, units: 21_845, unitBytes: 3, points: new Uint32Array(points) }
})

describe('PageCache', () => {
  it("never exceeds its cap in charged bytes, and never evicts a mounted line, under 64 KiB CJK items", () => {
    const cache = new PageCache(ROW)
    const rows = 31 // 3 × ceil(200 px / 20 px) + 1
    cache.setCap(cache.capFor(rows))
    let seen = 0
    for (let top = 0; top < 4_000; top += 7) {
      const [first, last] = [Math.max(0, top - 10), top + 21]
      cache.setMounted(Array.from({ length: last - first }, (_, k) => first + k))
      // Pages of up to 4 such items, as the core sends them; every third item has a dense breakpoint map.
      for (let line = first; line < last; line += 4)
        cache.add(Array.from({ length: Math.min(4, last - line) }, (_, k) => cjk(line + k, (line + k) % 3 ? 0 : 12_000)))
      expect(cache.charged).toBeLessThanOrEqual(cache.cap)
      for (let line = first; line < last; line++) expect(cache.has(line)).toBe(true)
      seen++
    }
    expect(seen).toBeGreaterThan(500)
    expect(cache.cap).toBe(rows * (2 * PIECE + MAP_MAX + MOUNTED_PER_UNIT * PIECE) + (16 << 20))
  })

  it('charges an item at its text and map bytes, and a mounted one its layout besides', () => {
    const cache = new PageCache(ROW)
    const item = cjk(0, 100)
    expect(charge(item)).toBe(2 * 21_845 + 400)
    cache.add([item])
    expect(cache.charged).toBe(charge(item))
    cache.setMounted([0])
    expect(cache.charged).toBe(charge(item) + MOUNTED_PER_UNIT * 21_845)
  })

  it('keeps a first page added before anything is mounted (Z37: no refetch)', () => {
    const cache = new PageCache(ROW)
    cache.add([cjk(0), cjk(1)])
    expect(cache.has(0) && cache.has(1)).toBe(true)
  })

  it("charges a line's further pieces like first pieces, and evicts them oldest first but never a mounted one", () => {
    const cache = new PageCache(ROW)
    cache.setCap(cache.capFor(1))
    cache.setMounted(['0:1'])
    for (let k = 1; k <= 1000; k++) cache.addPiece(`0:${k}`, cjk(0)) // 1,000 × 43,690 bytes: past the cap
    expect(cache.charged).toBeLessThanOrEqual(cache.cap)
    expect(cache.has('0:1')).toBe(true)
    expect([cache.has('0:2'), cache.has('0:1000')]).toEqual([false, true])
  })

  it('drops the items a test picks, mounted ones too, and charges only what stays', () => {
    const cache = new PageCache(ROW)
    const tail = cjk(0) // a last piece whose line's end wasn't known: no `next`, no `rest`
    const going = { ...cjk(1), next: { session: 1, doc: 1, gen: 1, line: 1, offset: 65_535 } } // its line goes on
    cache.add([going])
    cache.addPiece('0:15', tail)
    cache.setMounted([1, '0:15'])
    expect(cache.drop((item) => item.more && !item.next && item.rest === undefined)).toBe(1)
    expect([cache.has('0:15'), cache.has(1)]).toEqual([false, true])
    expect(cache.charged).toBe(charge(going) + MOUNTED_PER_UNIT * going.text.length)
  })
})
