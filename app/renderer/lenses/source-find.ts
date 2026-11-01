import type { Opened, SourceFindRef, SourceHit } from '../../shared/protocol'
import { CoreCallError, type CoreClient } from '../core'
import { EMPTY_FIND, FindSignal, literalMatches, type FindController, type FindQuery } from '../find'
import { highlightFind } from '../find-highlight'
import type { LensBudget } from './lens-budget'

const SEARCH_BYTES = 16 << 20
/** Native scanning owns whole-file progress. Renderer retains one bounded source excerpt and visible ranges. */
export class SourceFind implements FindController {
  private readonly signal = new FindSignal()
  readonly subscribe = this.signal.subscribe
  readonly snapshot = this.signal.snapshot
  private query: FindQuery = { text: '', matchCase: false }
  private epoch = 0
  private abort = new AbortController()
  private ref?: SourceFindRef
  private hit?: SourceHit
  private ordinal: number | null = null
  private pending?: 1 | -1
  private navigation = Promise.resolve()
  private readonly excerpt: HTMLElement
  private frame = false
  private readonly observer: MutationObserver
  private destroyed = false
  private paid = false

  constructor(private readonly host: HTMLElement, private readonly scroller: HTMLElement,
    private readonly core: CoreClient, private readonly opened: Opened, private readonly budget: LensBudget | undefined,
    private readonly revealLine: (line: number, hit?: SourceHit) => void, private readonly onFrozen: (reason: string) => void) {
    this.excerpt = document.createElement('div')
    this.excerpt.className = 'raw-find-excerpt'
    this.excerpt.setAttribute('aria-label', 'Source match')
    this.observer = new MutationObserver(this.scheduleHighlights)
    this.observer.observe(scroller, { subtree: true, childList: true, characterData: true })
    scroller.addEventListener('scroll', this.scheduleHighlights, { passive: true })
  }

  search(query: FindQuery): void {
    this.close()
    if (!query.text || this.destroyed) return
    if (!this.opened.view || !this.budget) { this.signal.publish({ ...EMPTY_FIND, message: 'Find unavailable · no active view' }); return }
    this.query = { text: query.text.slice(0, 512), matchCase: query.matchCase }
    const epoch = ++this.epoch, abort = this.abort
    this.signal.publish({ count: 0, complete: false, current: null, busy: true })
    const start = async () => {
      if (!await this.budget!.reserveSearch(this.opened.gen, SEARCH_BYTES)) throw new Error('Find unavailable · memory budget is full')
      if (epoch !== this.epoch) return
      this.paid = true
      const info = await this.core.call('sourceFindStart', { view: this.opened.view!, query: this.query.text, matchCase: this.query.matchCase }, abort.signal)
      if (epoch !== this.epoch) { void this.core.call('sourceFindClose', { ref: info.ref }).catch(() => {}); return }
      this.ref = info.ref
      this.signal.publish({ count: info.count, complete: info.complete, current: null, busy: !info.complete })
      if (this.pending) { const direction = this.pending; this.pending = undefined; this.next(direction) }
      while (epoch === this.epoch && !this.snapshot().complete) {
        const page = await this.core.call('sourceFindScan', { ref: info.ref }, abort.signal)
        if (epoch !== this.epoch) return
        if (!this.hit && !this.pending && page.hits[0]) this.show(page.hits[0], 1)
        this.signal.publish({ count: Math.max(page.count, this.ordinal ?? 0), complete: page.complete, current: this.ordinal, busy: !page.complete })
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      this.scheduleHighlights()
    }
    void start().catch(error => this.failed(error, epoch))
  }

  next(direction: 1 | -1): void {
    if (!this.query.text || this.destroyed) return
    if (!this.ref) { this.pending = direction; return }
    const epoch = this.epoch, ref = this.ref, abort = this.abort
    this.pending = direction
    this.navigation = this.navigation.then(async () => {
      if (epoch !== this.epoch) return
      const from = this.hit?.start, previous = this.ordinal
      const result = await this.core.call('sourceFindSeek', { ref, from, direction: direction === 1 ? 'next' : 'previous' }, abort.signal)
      if (epoch !== this.epoch) return
      if (result.hit) {
        const state = this.snapshot()
        const ordinal = result.ordinal ?? (from === undefined ? direction === 1 ? 1 : state.complete ? state.count : null : result.wrapped ? direction === 1 ? 1 : state.complete ? state.count : null : previous === null ? null : previous + direction)
        this.show(result.hit, ordinal)
        this.signal.publish({ ...state, count: Math.max(state.count, ordinal ?? 0), current: ordinal, message: undefined })
      }
      this.pending = undefined
    }).catch(error => this.failed(error, epoch))
  }

  close(): void {
    this.epoch++
    this.abort.abort(); this.abort = new AbortController()
    if (this.ref) void this.core.call('sourceFindClose', { ref: this.ref }).catch(() => {})
    this.ref = undefined; this.hit = undefined; this.ordinal = null; this.pending = undefined
    this.query = { text: '', matchCase: false }; this.paid = false
    this.navigation = Promise.resolve()
    this.excerpt.replaceChildren(); this.excerpt.remove()
    highlightFind(this)
    this.signal.publish(EMPTY_FIND)
    void this.budget?.reserveSearch(this.opened.gen, 0)
  }

  destroy(): void { this.close(); this.destroyed = true; this.observer.disconnect(); this.scroller.removeEventListener('scroll', this.scheduleHighlights) }
  freeze(reason: string): void { this.close(); this.signal.publish({ ...EMPTY_FIND, message: 'Find unavailable · ' + reason }) }

  private show(hit: SourceHit, ordinal: number | null): void {
    if (hit.text.length > 8192 || hit.matchStart < 0 || hit.matchEnd > hit.text.length || hit.matchEnd <= hit.matchStart) throw new Error('Invalid source match excerpt')
    this.hit = hit; this.ordinal = ordinal
    this.revealLine(hit.line, hit)
    const label = document.createElement('small')
    label.textContent = `Source match · line ${hit.line + 1} · byte ${hit.start}`
    const mark = document.createElement('mark')
    mark.textContent = hit.text.slice(hit.matchStart, hit.matchEnd)
    this.excerpt.replaceChildren(label, document.createTextNode(hit.text.slice(0, hit.matchStart)), mark, document.createTextNode(hit.text.slice(hit.matchEnd)))
    this.host.append(this.excerpt)
    this.scheduleHighlights()
  }

  private readonly scheduleHighlights = () => {
    if (!this.query.text || !this.paid || this.frame) return
    this.frame = true
    requestAnimationFrame(() => {
      this.frame = false
      if (!this.query.text || !this.paid || this.destroyed) return
      const ranges: Range[] = []
      const viewport = this.scroller.getBoundingClientRect()
      for (const element of this.scroller.querySelectorAll<HTMLElement>('.vl-row .text')) {
        const box = element.getBoundingClientRect()
        if (box.bottom < viewport.top || box.top > viewport.bottom) continue
        const node = element.firstChild
        if (!(node instanceof Text)) continue
        for (const match of literalMatches(node.data, this.query)) {
          const range = document.createRange(); range.setStart(node, match.start); range.setEnd(node, match.end); ranges.push(range)
          if (ranges.length === 128) break
        }
        if (ranges.length === 128) break
      }
      highlightFind(this, undefined, ranges)
    })
  }

  private failed(error: unknown, epoch: number): void {
    if (epoch !== this.epoch || error instanceof CoreCallError && (error.code === 'Cancelled' || error.code === 'Stale' || error.code === 'CoreGone')) return
    if (error instanceof CoreCallError && error.code === 'Frozen') this.onFrozen(error.message)
    const message = error instanceof Error ? error.message : String(error)
    this.close()
    this.signal.publish({ ...EMPTY_FIND, message })
  }
}
