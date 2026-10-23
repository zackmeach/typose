import { describe, expect, it } from 'vitest'
import { SPACER_CAP, ScrollState, toLogical, toNative, visibleRows, wheelPixels } from './scrollmath'

const ROW = 24
const VIEWPORT = 800

describe('native mode (content within the spacer cap)', () => {
  it('maps 1:1 and ignores its own scroll echo', () => {
    const s = new ScrollState({ total: 100_000 * ROW, viewport: VIEWPORT })
    expect(s.moveBy(100)).toBe(100)
    expect(s.onNativeScroll(100)).toBe(false)
    expect(s.onNativeScroll(500)).toBe(true)
    expect(s.top).toBe(500)
  })
})

describe('logical mode (50M rows × 24px = 1.2e9 px over a 16M px spacer)', () => {
  const total = 50_000_000 * ROW

  it('moves a wheel notch the same distance deep in the file as at the top (Astra R3)', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    const notches = (start: number) => {
      s.moveTo(start)
      for (let i = 0; i < 10; i++) s.moveBy(wheelPixels(120, 0, ROW, VIEWPORT))
      return s.top - start
    }
    expect(notches(0)).toBe(1200)
    expect(notches(40_000_000 * ROW)).toBe(1200)
  })

  it('pages exactly one viewport', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    s.moveTo(40_000_000 * ROW)
    const before = s.top
    s.moveBy(VIEWPORT)
    expect(s.top - before).toBe(VIEWPORT)
  })

  it('treats an unexpected native scroll as a coarse proportional jump', () => {
    const g = { total, viewport: VIEWPORT }
    const s = new ScrollState(g)
    const native = (SPACER_CAP - VIEWPORT) / 2
    expect(s.onNativeScroll(native)).toBe(true)
    expect(s.top).toBeCloseTo((total - VIEWPORT) / 2, -1)
    expect(toNative(toLogical(native, g), g)).toBeCloseTo(native, 6)
  })

  it('ignores the echo of its own scrollbar update', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    const native = s.moveBy(1200)
    expect(s.onNativeScroll(native + 0.4)).toBe(false)
    expect(s.top).toBe(1200)
  })

  it('matches the echo against the offset the browser actually applied', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    s.moveTo(40_000_000 * ROW)
    const target = s.moveBy(120)
    s.confirmNative(Math.round(target / 2) * 2 + 2) // a 2px-quantized offset more than 1px from the target
    expect(s.onNativeScroll(Math.round(target / 2) * 2 + 2)).toBe(false)
    expect(s.top).toBe(40_000_000 * ROW + 120)
  })

  it('reaches the true last row', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    s.moveTo(Number.MAX_SAFE_INTEGER)
    expect(s.top).toBe(total - VIEWPORT)
    expect(visibleRows(s.top, VIEWPORT, ROW, 50_000_000, 0).last).toBe(50_000_000)
  })
})

describe('wheelPixels', () => {
  it('converts line and page deltas', () => {
    expect(wheelPixels(3, 1, ROW, VIEWPORT)).toBe(72)
    expect(wheelPixels(1, 2, ROW, VIEWPORT)).toBe(VIEWPORT)
  })
})
