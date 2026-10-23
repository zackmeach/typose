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
  private pointerDown = false
  /** The widest row painted so far: the horizontal scroll extent only grows, so it doesn't jump while reading. */
  private contentWidth = 0

  constructor(
    parent: HTMLElement,
    private readonly rowHeight: number,
    private readonly paint: (i: number, el: HTMLDivElement) => void,
    private readonly onRange: (r: { first: number; last: number }) => void
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
        if (!isLogical(this.state.geometry.total)) return // native scrolling handles both axes, Shift+wheel too
        e.preventDefault()
        const vp = this.state.geometry.viewport
        // Shift turns a vertical wheel horizontal, as native scrolling does.
        const [dx, dy] = e.shiftKey && e.deltaX === 0 ? [e.deltaY, 0] : [e.deltaX, e.deltaY]
        if (dx) this.element.scrollLeft += wheelPixels(dx, e.deltaMode, H_STEP, this.element.clientWidth)
        if (dy) this.apply(this.state.moveBy(wheelPixels(dy, e.deltaMode, this.rowHeight, vp)))
      },
      { passive: false }
    )
    this.element.addEventListener('scroll', () => {
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

  scrollToRow(i: number): void {
    this.apply(this.state.moveTo(i * this.rowHeight))
  }

  /** The mounted row range: the viewport plus one viewport of overscan each way (spec §5.3). */
  visibleRange(): { first: number; last: number } {
    const vp = this.state.geometry.viewport
    return visibleRows(this.state.top, vp, this.rowHeight, this.rowCount, Math.ceil(vp / this.rowHeight))
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
