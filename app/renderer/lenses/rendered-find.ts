import { EMPTY_FIND, FindSignal, literalMatches, type FindController, type FindQuery } from '../find'
import { highlightFind } from '../find-highlight'
import type { LensBudget } from './lens-budget'

// One bounded block projection, scalar-offset maps, current range and at most 128 visible ranges.
const SEARCH_BYTES = 16 << 20
const MAX_BLOCK_UNITS = 256 << 10
/** The reader's own scrolling, which ends a reveal's follow (`reveal`), as it ends the lens's own placement. */
const FOLLOW_STOPS = ['wheel', 'keydown', 'pointerdown'] as const
interface Run { start: number; end: number; first: Text; firstOffset: number; last: Text; lastOffset: number; linear: boolean }
interface Projection { text: string; runs: Run[] }
interface Hit { block: HTMLElement; start: number; end: number }
const blockTags = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE'])

/** Displayed text only: inline tags concatenate; block/line boundaries separate; loaded images add no text. */
export function projectRenderedBlock(block: HTMLElement): Projection {
  let text = ''
  const runs: Run[] = []
  let space: { first: Text; firstOffset: number; last: Text; lastOffset: number } | undefined
  const separator = (value: string) => { space = undefined; if (text && !text.endsWith(value)) text += value }
  const append = (node: Text, start: number, end: number) => {
    if (space && text && !/[\n\t]$/.test(text)) {
      runs.push({ start: text.length, end: text.length + 1, ...space, linear: false }); text += ' '
    }
    space = undefined
    const at = text.length
    text += node.data.slice(start, end)
    runs.push({ start: at, end: text.length, first: node, firstOffset: start, last: node, lastOffset: end, linear: true })
  }
  const visit = (node: Node, pre = false): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const source = node as Text
      let value = source.data
      if (node.parentElement?.classList.contains('md-note')) value = value.slice(0, Number(block.dataset.findNoteUnits ?? 0))
      if (pre) { if (value) append(source, 0, value.length); return }
      const chunks = /[\t\n\r\f ]+|[^\t\n\r\f ]+/g
      for (const chunk of value.matchAll(chunks)) {
        const start = chunk.index, end = start + chunk[0].length
        if (/^[\t\n\r\f ]/.test(chunk[0])) {
          space ??= { first: source, firstOffset: start, last: source, lastOffset: end }
          space.last = source; space.lastOffset = end
        } else append(source, start, end)
      }
      return
    }
    if (!(node instanceof HTMLElement) || node.hidden || node.getAttribute('aria-hidden') === 'true' || ['SCRIPT', 'STYLE'].includes(node.tagName)) return
    if (node.tagName === 'BR') { separator('\n'); return }
    if (blockTags.has(node.tagName)) separator('\n')
    if (node.tagName === 'TD' || node.tagName === 'TH') separator('\t')
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, pre || node.tagName === 'PRE' || node.tagName === 'CODE')
    if (blockTags.has(node.tagName)) separator('\n')
  }
  for (let child = block.firstChild; child; child = child.nextSibling) visit(child)
  if (text.length > MAX_BLOCK_UNITS) throw new Error('This rendered block exceeds the Find projection limit')
  return { text, runs }
}

function rangeAt(projection: Projection, hit: { start: number; end: number }): Range | undefined {
  const first = projection.runs.find(run => run.end > hit.start && run.start <= hit.start)
  const last = projection.runs.find(run => run.end >= hit.end && run.start < hit.end)
  if (!first || !last || !first.first.isConnected || !last.last.isConnected) return undefined
  const range = document.createRange()
  range.setStart(first.first, first.linear ? first.firstOffset + hit.start - first.start : first.firstOffset)
  range.setEnd(last.last, last.linear ? last.firstOffset + hit.end - last.start : last.lastOffset)
  return range
}

export class RenderedFind implements FindController {
  private readonly signal = new FindSignal()
  readonly subscribe = this.signal.subscribe
  readonly snapshot = this.signal.snapshot
  private query: FindQuery = { text: '', matchCase: false }
  private epoch = 0
  private target = 1
  private active?: Hit
  private range?: Range
  private timer?: ReturnType<typeof setTimeout>
  private scrollFrame = false
  private destroyed = false
  private paid = false
  private preserve?: Range
  private revealRequested = true
  private readonly observer: MutationObserver

  constructor(private readonly scroller: HTMLElement, private readonly column: HTMLElement,
    private readonly complete: () => boolean, private readonly budget: LensBudget | undefined, private readonly generation: number) {
    this.observer = new MutationObserver(() => {
      if (!this.query.text || !this.paid) return
      this.epoch++
      if (this.active) {
        this.preserve = this.range?.startContainer.isConnected && this.range.endContainer.isConnected ? this.range.cloneRange() : undefined
        this.revealRequested = false
      }
      this.active?.block.removeAttribute('data-find-current')
      this.active = undefined; this.range = undefined
      highlightFind(this)
      this.signal.publish({ count: 0, complete: false, current: null, busy: true })
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.rescan(), 40)
    })
    this.observer.observe(column, { childList: true, characterData: true, subtree: true })
    scroller.addEventListener('scroll', this.onScroll, { passive: true })
  }

  search(query: FindQuery): void {
    this.close()
    if (!query.text || this.destroyed) return
    this.query = { text: query.text.slice(0, 512), matchCase: query.matchCase }
    this.target = 1
    this.revealRequested = true
    const epoch = ++this.epoch
    this.signal.publish({ count: 0, complete: false, current: null, busy: true })
    void this.budget?.reserveSearch(this.generation, SEARCH_BYTES).then(granted => {
      if (epoch !== this.epoch || this.destroyed) return
      if (!granted) { this.signal.publish({ ...EMPTY_FIND, message: 'Find unavailable · memory budget is full' }); return }
      this.paid = true
      this.rescan()
    })
    if (!this.budget) this.signal.publish({ ...EMPTY_FIND, message: 'Find unavailable · no active reservation' })
  }

  next(direction: 1 | -1): void {
    if (!this.query.text || this.destroyed) return
    const state = this.snapshot()
    if (state.complete && !state.count) return
    this.target = state.current === null ? direction === -1 ? -1 : 1 : state.current + direction
    this.revealRequested = true; this.preserve = undefined
    if (state.complete) this.target = ((this.target - 1 + state.count) % state.count) + 1
    else if (this.target <= 0) this.target = -1
    if (this.paid) this.rescan()
  }

  close(): void {
    this.epoch++
    clearTimeout(this.timer)
    this.query = { text: '', matchCase: false }
    this.paid = false
    this.active?.block.removeAttribute('data-find-current')
    this.active = undefined; this.range = undefined
    this.preserve = undefined
    highlightFind(this)
    this.signal.publish(EMPTY_FIND)
    void this.budget?.reserveSearch(this.generation, 0)
  }

  destroy(): void { this.close(); this.destroyed = true; this.observer.disconnect(); this.scroller.removeEventListener('scroll', this.onScroll) }

  private readonly onScroll = () => {
    if (!this.query.text || this.scrollFrame) return
    this.scrollFrame = true
    requestAnimationFrame(() => { this.scrollFrame = false; if (this.query.text) this.paintVisible() })
  }

  private rescan(): void {
    if (!this.query.text || !this.paid || this.destroyed) return
    const epoch = ++this.epoch
    const query = this.query
    const target = this.target
    const scan = async () => {
      let count = 0, selected: Hit | undefined, first: Hit | undefined, last: Hit | undefined, selectedOrdinal = 0
      let blocks = 0
      this.signal.publish({ ...this.snapshot(), busy: true, message: undefined })
      try {
        for (const child of this.column.children) {
          if (epoch !== this.epoch) return
          const block = child as HTMLElement
          const projection = projectRenderedBlock(block)
          for (const match of literalMatches(projection.text, query)) {
            count++
            const hit = { block, ...match }
            first ??= hit; last = hit
            if (this.revealRequested && count === target) { selected = hit; selectedOrdinal = count }
            else if (this.preserve) {
              const range = rangeAt(projection, match), saved = this.preserve
              if (range && range.startContainer === saved.startContainer && range.startOffset === saved.startOffset && range.endContainer === saved.endContainer && range.endOffset === saved.endOffset) { selected = hit; selectedOrdinal = count }
            }
          }
          if (++blocks % 8 === 0) {
            this.signal.publish({ count, complete: false, current: null, busy: true })
            await new Promise<void>(resolve => setTimeout(resolve, 0))
          }
        }
        if (epoch !== this.epoch) return
        const complete = this.complete()
        let ordinal = selectedOrdinal || target
        if (complete && !selected && this.revealRequested) { selected = target === -1 ? last : first; ordinal = target === -1 ? count : 1 }
        if (!complete && target === -1) selected = undefined
        this.active?.block.removeAttribute('data-find-current')
        this.active = selected
        this.range = undefined
        if (selected) {
          this.target = ordinal
          if (this.revealRequested) this.reveal(selected, epoch)
          else { this.range = rangeAt(projectRenderedBlock(selected.block), selected); selected.block.dataset.findCurrent = '1' }
        }
        else highlightFind(this)
        this.signal.publish({ count, complete, current: selected ? ordinal : null, busy: !complete,
          ...(!selected && !this.revealRequested ? { message: 'Current match changed · choose Next or Previous' } : {}) })
        this.paintVisible()
      } catch (error) {
        if (epoch !== this.epoch) return
        this.signal.publish({ count, complete: false, current: null, busy: false, message: String(error instanceof Error ? error.message : error) })
      }
    }
    void scan()
  }

  private reveal(hit: Hit, epoch: number): void {
    hit.block.dataset.findCurrent = '1'
    hit.block.scrollIntoView({ block: 'center', inline: 'nearest' })
    // content-visibility: auto gives the skipped blocks near the hit their real height a frame or more after the jump,
    // which can push the hit out of view (the lens's own reveal waits this out too). Look again on each of the next 8
    // frames while layout moves the hit, until the reader scrolls: as in the lens, input stops it.
    let top = -1, moved = false
    const input = () => { moved = true }
    for (const type of FOLLOW_STOPS) this.scroller.addEventListener(type, input, { passive: true })
    const follow = (left: number) => requestAnimationFrame(() => {
      const live = epoch === this.epoch && hit.block.isConnected
      if (live && (top === -1 || !moved) && hit.block.offsetTop !== top) {
        top = hit.block.offsetTop
        this.range = rangeAt(projectRenderedBlock(hit.block), hit)
        if (this.range) {
          const box = this.range.getBoundingClientRect(), viewport = this.scroller.getBoundingClientRect()
          if (box.top < viewport.top || box.bottom > viewport.bottom) this.scroller.scrollTop += box.top - viewport.top - viewport.height / 2
        }
        this.paintVisible()
      }
      if (live && !moved && left > 1) follow(left - 1)
      else for (const type of FOLLOW_STOPS) this.scroller.removeEventListener(type, input)
    })
    follow(8)
  }

  private paintVisible(): void {
    if (!this.query.text || this.destroyed) return
    const ranges: Range[] = []
    const viewport = this.scroller.getBoundingClientRect()
    try {
      const blocks = this.column.children
      let low = 0, high = blocks.length
      while (low < high) { const middle = (low + high) >>> 1; if (blocks[middle].getBoundingClientRect().bottom < viewport.top) low = middle + 1; else high = middle }
      for (let index = low; index < blocks.length; index++) {
        const block = blocks[index] as HTMLElement, box = block.getBoundingClientRect()
        if (box.top > viewport.bottom) break
        if (box.bottom < viewport.top || box.top > viewport.bottom) continue
        const projection = projectRenderedBlock(block)
        for (const match of literalMatches(projection.text, this.query)) {
          const range = rangeAt(projection, match)
          if (range) ranges.push(range)
          if (ranges.length === 128) break
        }
        if (ranges.length === 128) break
      }
      highlightFind(this, this.range, ranges)
    } catch { highlightFind(this) }
  }
}
