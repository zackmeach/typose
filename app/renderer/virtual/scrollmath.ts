// Native scrolling below the cap, logical above it (spec §5.3).
export const SPACER_CAP = 16_000_000

export interface ScrollGeometry {
  total: number
  viewport: number
}

export const spacerHeight = (total: number): number => Math.min(total, SPACER_CAP)
export const isLogical = (total: number): boolean => total > SPACER_CAP

const ranges = (g: ScrollGeometry): [number, number] => [
  Math.max(1, g.total - g.viewport),
  Math.max(1, SPACER_CAP - g.viewport)
]

export function toNative(top: number, g: ScrollGeometry): number {
  if (!isLogical(g.total)) return top
  const [logical, native] = ranges(g)
  return (top / logical) * native
}

export function toLogical(nativeTop: number, g: ScrollGeometry): number {
  if (!isLogical(g.total)) return nativeTop
  const [logical, native] = ranges(g)
  return (nativeTop / native) * logical
}

export function wheelPixels(deltaY: number, deltaMode: number, rowHeight: number, viewport: number): number {
  if (deltaMode === 1) return deltaY * rowHeight
  if (deltaMode === 2) return deltaY * viewport
  return deltaY
}

export const clampTop = (top: number, g: ScrollGeometry): number =>
  Math.min(Math.max(0, top), Math.max(0, g.total - g.viewport))

export function visibleRows(top: number, viewport: number, rowHeight: number, rowCount: number, overscan: number) {
  return {
    first: Math.max(0, Math.floor(top / rowHeight) - overscan),
    last: Math.min(rowCount, Math.ceil((top + viewport) / rowHeight) + overscan)
  }
}

export class ScrollState {
  top = 0
  private expected: number | null = null

  constructor(private g: ScrollGeometry) {}

  get geometry(): ScrollGeometry {
    return this.g
  }

  setTotal(total: number): void {
    this.g = { ...this.g, total }
    this.top = clampTop(this.top, this.g)
  }

  setViewport(viewport: number): void {
    this.g = { ...this.g, viewport }
    this.top = clampTop(this.top, this.g)
  }

  /** Wheel, trackpad and keys: 1:1 in logical pixels. Returns the native scrollTop to apply. */
  moveBy(px: number): number {
    return this.moveTo(this.top + px)
  }

  moveTo(px: number): number {
    this.top = clampTop(px, this.g)
    this.expected = toNative(this.top, this.g)
    return this.expected
  }

  /** The browser quantizes large scroll offsets (2px steps near 10M px), so the caller reports what it actually applied. */
  confirmNative(applied: number): void {
    this.expected = applied
  }

  /** Our own scrollbar updates echo back and are ignored; anything else is a user jump. */
  onNativeScroll(nativeTop: number): boolean {
    if (this.expected !== null && Math.abs(nativeTop - this.expected) < 1) {
      this.expected = null
      return false
    }
    this.expected = null
    this.top = clampTop(toLogical(nativeTop, this.g), this.g)
    return true
  }
}
