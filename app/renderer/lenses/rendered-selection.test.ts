import { describe, expect, it } from 'vitest'
import { dropMappedUnits, mappedBoundary } from './rendered-selection'

describe('native Markdown selection boundaries', () => {
  it('snaps UTF-16 surrogate and source entity units outward', () => {
    expect(mappedBoundary('3:7,3:7,7:12', 1, 'start')).toBe(3)
    expect(mappedBoundary('3:7,3:7,7:12', 1, 'end')).toBe(7)
    expect(mappedBoundary('3:7,3:7,7:12', 3, 'end')).toBe(12)
    expect(mappedBoundary('3:7,3:7,7:12', 2, 'start')).toBe(7)
  })
  it('refuses invalid offsets and malformed provenance', () => {
    expect(mappedBoundary('1:4', 2, 'start')).toBeUndefined()
    expect(mappedBoundary('4:1', 0, 'start')).toBeUndefined()
    expect(mappedBoundary('', 0, 'start')).toBeUndefined()
    expect(mappedBoundary('S:0:1*x', 0, 'start')).toBeUndefined()
    expect(mappedBoundary('S:0:1*0', 0, 'start')).toBeUndefined()
    expect(mappedBoundary('R:5:4:1', 0, 'start')).toBeUndefined()
  })
  it('walks one-width (L), segmented (S) and snapped (R) maps', () => {
    expect(mappedBoundary('L:10:3:4', 2, 'start')).toBe(16)
    expect(mappedBoundary('L:10:3:4', 4, 'end')).toBe(22)
    // "café ·" in UTF-8 from byte 0: c a f é(2) space ·(2)
    const cafe = 'S:0:1*3,2,1,2'
    expect([0, 1, 2, 3, 4, 5, 6].map(offset => mappedBoundary(cafe, offset, 'start'))).toEqual([0, 1, 2, 3, 5, 6, 8])
    expect([0, 1, 2, 3, 4, 5, 6].map(offset => mappedBoundary(cafe, offset, 'end'))).toEqual([0, 1, 2, 3, 5, 6, 8])
    // "A😀B" in UTF-16 after a BOM: the pair's two units share bytes 4–8, so a boundary between them snaps outward.
    const emoji = 'S:2:2,4p,2'
    expect(mappedBoundary(emoji, 2, 'start')).toBe(4)
    expect(mappedBoundary(emoji, 2, 'end')).toBe(8)
    expect(mappedBoundary(emoji, 3, 'start')).toBe(8)
    expect(mappedBoundary(emoji, 4, 'end')).toBe(10)
    expect(mappedBoundary('R:3:8:2', 1, 'start')).toBe(3)
    expect(mappedBoundary('R:3:8:2', 1, 'end')).toBe(8)
  })
  it('drops a leading marker from each form', () => {
    expect(dropMappedUnits('L:10:1:9', 3)).toBe('L:13:1:6')
    expect(dropMappedUnits('S:0:1*3,2,1,2', 2)).toBe('S:2:1,2,1,2')
    expect(dropMappedUnits('S:0:1*3,2,1,2', 4)).toBe('S:5:1,2')
    expect(dropMappedUnits('S:2:2,4p,2', 2)).toBe('4:8,8:10') // inside the pair: per unit
    expect(dropMappedUnits('R:3:8:4', 1)).toBe('R:3:8:3')
    expect(dropMappedUnits('3:7,3:7,7:12', 1)).toBe('3:7,7:12')
  })
})
