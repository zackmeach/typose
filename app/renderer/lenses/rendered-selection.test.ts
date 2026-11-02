import { describe, expect, it } from 'vitest'
import { mappedBoundary } from './rendered-selection'

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
  })
})
