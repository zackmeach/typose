import { describe, expect, it } from 'vitest'
import { sourceByteAt } from './source-map'

describe('sourceByteAt', () => {
  it('snaps a UTF-16 offset inside a surrogate pair outward', () => {
    const map = { uniform: true, start: 100, end: 108, units: 4, unitBytes: 2, points: new Uint32Array([1]) }
    expect(sourceByteAt(map, 2, 'start')).toBe(102)
    expect(sourceByteAt(map, 2, 'end')).toBe(106)
  })

  it('maps a multibyte breakpoint to the exact source span', () => {
    const map = { uniform: false, start: 50, end: 52, units: 1, unitBytes: 0, points: new Uint32Array([0, 0, 1, 2]) }
    expect(sourceByteAt(map, 0, 'start')).toBe(50)
    expect(sourceByteAt(map, 1, 'end')).toBe(52)
  })

  it('keeps the first start and last end when zero-width mapped bytes share a text offset', () => {
    const map = { uniform: false, start: 10, end: 13, units: 2, unitBytes: 0, points: new Uint32Array([0, 0, 0, 1, 1, 2]) }
    expect(sourceByteAt(map, 0, 'start')).toBe(10)
    expect(sourceByteAt(map, 0, 'end')).toBe(11)
  })
})
