import { describe, expect, it } from 'vitest'
import type { PageItem } from '../../shared/protocol'
import { PageCache, charge } from './page-cache'

const PIECE = 65_536
const MAP_MAX = 393_224
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
    const cache = new PageCache(2 * PIECE + MAP_MAX)
    const rows = 31 // 3 × ceil(200 px / 20 px) + 1
    cache.setMountedRows(rows)
    let seen = 0
    for (let top = 0; top < 4_000; top += 7) {
      const [first, last] = [Math.max(0, top - 10), top + 21]
      cache.setMounted(first, last)
      // Pages of up to 4 such items, as the core sends them; every third item has a dense breakpoint map.
      for (let line = first; line < last; line += 4)
        cache.add(Array.from({ length: Math.min(4, last - line) }, (_, k) => cjk(line + k, (line + k) % 3 ? 0 : 12_000)))
      expect(cache.charged).toBeLessThanOrEqual(cache.cap)
      for (let line = first; line < last; line++) expect(cache.has(line)).toBe(true)
      seen++
    }
    expect(seen).toBeGreaterThan(500)
    expect(cache.cap).toBe(rows * 2 * (2 * PIECE + MAP_MAX) + (16 << 20))
  })

  it('counts a mounted item twice, and an item at its text and map bytes', () => {
    const cache = new PageCache(2 * PIECE + MAP_MAX)
    const item = cjk(0, 100)
    expect(charge(item)).toBe(2 * 21_845 + 400)
    cache.add([item])
    expect(cache.charged).toBe(charge(item))
    cache.setMounted(0, 1)
    expect(cache.charged).toBe(2 * charge(item))
  })

  it('keeps a first page added before anything is mounted (Z37: no refetch)', () => {
    const cache = new PageCache(2 * PIECE + MAP_MAX)
    cache.add([cjk(0), cjk(1)])
    expect(cache.has(0) && cache.has(1)).toBe(true)
  })
})
