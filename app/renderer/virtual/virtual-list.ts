import { ScrollState, isLogical, spacerHeight, visibleRows, wheelPixels } from './scrollmath'

/** One keypress of Left/Right moves this far (px). */
const H_STEP = 40

export class VirtualList {
  readonly state: ScrollState
  /** The scroll container: the element a lens labels and focuses. */
  readonly element: HTMLDivElement
  private readonly layer: HTMLDivElement
  private readonly spacer: HTMLDivElement
  private readonly rows = new Map<number, HTMLDivElement>()
  private readonly observer: ResizeObserver
  private rowCount = 0
  private applied = 0
  /** The position `apply()` last set, until its scroll event arrives. */
  private ownTop: number | null = null
  /** Whether the latest scroll event was the list's own `apply()`, not the reader's (plan C8's paint probe reads it). */
  ownScroll = false
  private pointerDown = false
  /** The widest row painted so far: the horizontal scroll extent only grows, so it doesn't jump while reading. */
  private contentWidth = 0

  /** `maxRows` is the most rows mounted at once (`setMaxRows`). */
  constructor(
    parent: HTMLElement,
    private readonly rowHeight: number,
    private readonly paint: (i: number, el: HTMLDivElement) => void,
    private readonly onRange: (r: { first: number; last: number }) => void,
    private maxRows = Infinity
  ) {
    this.element = Object.assign(document.createElement('div'), { className: 'vl-scroller', tabIndex: 0 })
    this.layer = Object.assign(document.createElement('div'), { className: 'vl-layer' })
    this.spacer = document.createElement('div')
    this.element.append(this.layer, this.spacer)
    parent.append(this.element)
    this.state = new ScrollState({ total: 0, viewport: parent.clientHeight })
    this.resize()
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(parent)
    this.element.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) return // Ctrl+wheel is view zoom, including in logical scrolling mode.
        // Shift turns a vertical wheel horizontal. Native scrolling does that on Windows and Linux, not on macOS.
        const shifted = e.shiftKey && e.deltaX === 0
        if (!shifted && !isLogical(this.state.geometry.total)) return // native scrolling handles both axes
        e.preventDefault()
        const vp = this.state.geometry.viewport
        const [dx, dy] = shifted ? [e.deltaY, 0] : [e.deltaX, e.deltaY]
        if (dx) this.element.scrollLeft += wheelPixels(dx, e.deltaMode, H_STEP, this.element.clientWidth)
        if (dy) this.apply(this.state.moveBy(wheelPixels(dy, e.deltaMode, this.rowHeight, vp)))
      },
      { passive: false }
    )
    this.element.addEventListener('scroll', () => {
      this.ownScroll = this.element.scrollTop === this.ownTop
      this.ownTop = null
      this.applied = this.element.scrollTop
      if (this.state.onNativeScroll(this.element.scrollTop)) this.render()
    })
    this.element.addEventListener('keydown', (e) => this.key(e))
    this.element.addEventListener('pointerdown', () => (this.pointerDown = true))
    // A lost release must not leave the thumb gate shut (plan A:3623).
    for (const type of ['pointerup', 'pointercancel', 'blur'] as const) window.addEventListener(type, this.release)
  }

  dispose(): void {
    this.observer.disconnect()
    for (const type of ['pointerup', 'pointercancel', 'blur'] as const) window.removeEventListener(type, this.release)
    this.element.remove()
  }

  setRowCount(n: number): void {
    // A user scroll not yet dispatched: read it under the mapping it was made in, before the total changes.
    if (isLogical(this.state.geometry.total) && Math.abs(this.element.scrollTop - this.applied) >= 1) this.state.onNativeScroll(this.element.scrollTop)
    this.rowCount = n
    this.state.setTotal(n * this.rowHeight)
    this.layoutSpacer()
    // In logical mode the thumb maps proportionally, so a growing total moves it: re-apply the same logical position,
    // except during a thumb drag, which keeps the thumb under the cursor.
    if (isLogical(this.state.geometry.total) && !this.pointerDown) this.apply(this.state.moveTo(this.state.top))
    else this.render()
  }

  refresh(): void {
    for (const [i, el] of this.rows) this.paint(i, el)
    this.measure(this.rows.values())
  }

  /** Scrolls row `i` to the top, `offset` px into it. */
  scrollToRow(i: number, offset = 0): void {
    this.apply(this.state.moveTo(i * this.rowHeight + offset))
  }

  /**
   * Sets the most rows mounted at once (plan C1: what a lens's reservation covers), then mounts and unmounts rows to
   * match. The overscan, one viewport each way (spec §5.3), shrinks to fit, down to none; past that, the viewport's
   * last rows stay unmounted.
   */
  setMaxRows(n: number): void {
    this.maxRows = n
    this.render()
  }

  /** The mounted row range: the viewport, and its overscan each way as far as `maxRows` allows. */
  visibleRange(): { first: number; last: number } {
    const vp = this.state.geometry.viewport
    const view = Math.ceil(vp / this.rowHeight)
    // A scrolled viewport spans `view + 1` rows; what's left of `maxRows` is split each way.
    const overscan = Math.max(0, Math.min(view, Math.floor((this.maxRows - view - 1) / 2)))
    const r = visibleRows(this.state.top, vp, this.rowHeight, this.rowCount, overscan)
    return { first: r.first, last: Math.min(r.last, r.first + this.maxRows) }
  }

  private readonly release = (): void => {
    this.pointerDown = false
  }

  private key(e: KeyboardEvent): void {
    const vp = this.state.geometry.viewport
    const left = (x: number) => () => {
      this.element.scrollLeft = x
      return null
    }
    const vertical: Record<string, () => number> = {
      ArrowDown: () => this.state.moveBy(this.rowHeight),
      ArrowUp: () => this.state.moveBy(-this.rowHeight),
      PageDown: () => this.state.moveBy(vp),
      PageUp: () => this.state.moveBy(-vp),
      ' ': () => this.state.moveBy(e.shiftKey ? -vp : vp)
    }
    // Home/End and Left/Right are horizontal, for wide lines; Ctrl+Home/End go to the first and last line.
    const moves: Record<string, () => number | null> = e.ctrlKey
      ? { Home: () => this.state.moveTo(0), End: () => this.state.moveTo(Number.MAX_SAFE_INTEGER) }
      : {
          ...vertical,
          ArrowLeft: left(this.element.scrollLeft - H_STEP),
          ArrowRight: left(this.element.scrollLeft + H_STEP),
          Home: left(0),
          End: left(this.element.scrollWidth)
        }
    const move = Object.hasOwn(moves, e.key) ? moves[e.key] : undefined
    if (!move) return
    e.preventDefault()
    const native = move()
    if (native !== null) this.apply(native)
  }

  private apply(native: number): void {
    this.element.scrollTop = native
    this.applied = this.element.scrollTop
    this.ownTop = this.applied
    this.state.confirmNative(this.applied)
    this.render()
  }

  private resize(): void {
    const vp = this.element.clientHeight
    this.layer.style.height = `${vp}px`
    this.state.setViewport(vp)
    this.layoutSpacer()
    this.render()
  }

  private layoutSpacer(): void {
    // The sticky layer takes one viewport of scroll height; the spacer supplies the rest.
    const vp = this.state.geometry.viewport
    this.spacer.style.height = `${Math.max(0, spacerHeight(this.state.geometry.total) - vp)}px`
  }

  /** Widens the layer to the widest of `rows`, so the scroller's horizontal scrollbar reaches it. */
  private measure(rows: Iterable<HTMLDivElement>): void {
    let widest = this.contentWidth
    for (const el of rows) widest = Math.max(widest, el.scrollWidth)
    if (widest > this.contentWidth) {
      this.contentWidth = widest
      this.layer.style.width = `${widest}px`
    }
  }

  private render(): void {
    const range = this.visibleRange()
    for (const [i, el] of this.rows) {
      if (i < range.first || i >= range.last) {
        el.remove()
        this.rows.delete(i)
      }
    }
    const fresh: HTMLDivElement[] = []
    for (let i = range.first; i < range.last; i++) {
      let el = this.rows.get(i)
      if (!el) {
        el = Object.assign(document.createElement('div'), { className: 'vl-row' })
        this.layer.append(el)
        this.rows.set(i, el)
        this.paint(i, el)
        fresh.push(el)
      }
      el.style.transform = `translateY(${i * this.rowHeight - this.state.top}px)`
    }
    this.measure(fresh)
    this.onRange(range)
  }
}
