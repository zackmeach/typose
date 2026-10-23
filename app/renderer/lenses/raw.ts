import type { Limits, Opened, PageItem, Token } from '../../shared/protocol'
import { type CoreClient, CoreCallError } from '../core'
import { VirtualList } from '../virtual/virtual-list'
import { type Key, PageCache } from './page-cache'

/** Brief §6.1's mono line: 13px at 1.55, rounded to whole pixels so row math stays exact. */
export const ROW_HEIGHT = 20

/** A long line the reader expanded (brief §5.1): `tokens[k]` fetches its piece k + 1, which gets a row of its own. */
interface Expansion {
  tokens: Token[]
}

/** What a row shows: a line's first piece (`piece` 0) or one of its further pieces. */
interface Slot {
  line: number
  piece: number
  key: Key
}

export interface RawOptions {
  /** A page came back `Frozen` (spec §3.1): the lens has stopped asking for more. */
  onFrozen(why: string): void
  /** The line to start at (Reload keeps the reading position). */
  atLine?: number
}

const mb = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })
const size = (bytes: number) => (bytes >= 1e6 ? `${mb.format(bytes / 1e6)} MB` : `${Math.max(1, Math.ceil(bytes / 1e3))} KB`)

/**
 * Raw (brief §5.1) on the virtualizer: a labelled, focusable region whose gutter is hidden from assistive tech
 * (plan §7 proposal 4). Lines wider than the card scroll horizontally; wrapping is M4. A line longer than a piece
 * shows its first piece with a marker; expanding it mounts the further pieces as rows of their own, fetched with
 * the core's continuation tokens as they come into view, up to the line's first 1 MiB (plan C3).
 */
export class RawLens {
  readonly list: VirtualList
  private readonly cache: PageCache
  private readonly expanded = new Map<number, Expansion>()
  /** The expanded lines, ascending. ponytail: row lookups scan them, fine for the few lines a reader expands. */
  private expandedLines: number[] = []
  private lineCount = 0
  private atLine: number | undefined
  private wanted: { first: number; last: number } | null = null
  /** Keys with a request in flight. */
  private readonly requested = new Set<Key>()
  private inflight = 0
  private scheduled = false
  /** Disposed, or frozen: nothing new is asked for or shown. */
  private stopped = false

  constructor(
    private readonly host: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    label: string,
    private readonly limits: Limits,
    private readonly options: RawOptions
  ) {
    this.cache = new PageCache(2 * limits.pieceBytes + limits.mapMax)
    this.sizeCache()
    this.cache.add(opened.firstPage.items)
    this.list = new VirtualList(host, ROW_HEIGHT, (i, el) => this.paint(i, el), (r) => this.want(r))
    Object.assign(this.list.element, { role: 'region', ariaLabel: `${label}, Raw` })
    // Reload's reading position, reached once the new index has found that line, unless the reader moves first.
    this.atLine = options.atLine
    for (const type of ['wheel', 'keydown', 'pointerdown'] as const)
      this.list.element.addEventListener(type, () => (this.atLine = undefined), { passive: true })
    this.setLineCount(opened.lines)
    // Z37's first screen: the first frame that shows the first page has painted (rAF, then a task). Once per open.
    if (opened.firstPage.items.length > 0 && performance.getEntriesByName('typose:first-screen').length === 0)
      requestAnimationFrame(() => setTimeout(() => performance.mark('typose:first-screen')))
  }

  /** Lines known so far: the index's count, but never fewer than the first page already showed (Z37). */
  setLineCount(lines: number): void {
    this.lineCount = Math.max(lines, this.opened.firstPage.items.length)
    this.list.setRowCount(this.rowCount())
    if (this.atLine !== undefined && this.lineCount > this.atLine) {
      this.list.scrollToRow(this.atLine) // a new lens has nothing expanded: rows are lines
      this.atLine = undefined
    }
  }

  /** The line at the top of the viewport. */
  topLine(): number {
    return this.slot(Math.floor(this.list.state.top / ROW_HEIGHT)).line
  }

  /** The document froze (spec §3.1): keep what's shown, ask for nothing more. */
  freeze(): void {
    this.stopped = true
  }

  dispose(): void {
    this.stopped = true
    this.list.dispose()
  }

  private rowCount(): number {
    let rows = this.lineCount
    for (const e of this.expanded.values()) rows += e.tokens.length
    return rows
  }

  private slot(row: number): Slot {
    let extra = 0
    for (const line of this.expandedLines) {
      const first = line + extra // the expanded line's first row
      if (row < first) break
      const pieces = this.expanded.get(line)!.tokens.length
      if (row <= first + pieces) {
        const piece = row - first
        return { line, piece, key: piece === 0 ? line : `${line}:${piece}` }
      }
      extra += pieces
    }
    return { line: row - extra, piece: 0, key: row - extra }
  }

  /** Coalesces viewport requests to one per animation frame (spec §3.4). */
  private want(r: { first: number; last: number }): void {
    this.sizeCache()
    const keys: Key[] = []
    for (let row = r.first; row < r.last; row++) keys.push(this.slot(row).key)
    this.cache.setMounted(keys)
    this.wanted = r
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** Sizes the cache's cap for the most rows `visibleRange` mounts here: a viewport and one more each way. */
  private sizeCache(): void {
    this.cache.setMountedRows(3 * Math.ceil(this.host.clientHeight / ROW_HEIGHT) + 1)
  }

  /** Fetches the first missing row of the wanted range, at most 2 requests in flight (spec §3.4). */
  private pump(): void {
    const r = this.wanted
    if (!r || this.inflight >= 2 || this.stopped) return
    let missing: Slot | null = null
    for (let row = r.first; row < r.last && !missing; row++) {
      const s = this.slot(row)
      if (!this.cache.has(s.key) && !this.requested.has(s.key)) missing = s
    }
    if (!missing) return
    this.inflight++
    const fetched = missing.piece > 0 ? this.fetchPiece(missing) : this.fetchLines(missing.line, this.slot(r.last - 1).line + 1)
    void fetched
      .catch((err: unknown) => this.failed(err))
      .finally(() => {
        this.inflight--
        this.pump()
      })
    this.pump()
  }

  private async fetchLines(start: number, end: number): Promise<void> {
    const count = Math.min(Math.max(1, end - start), this.limits.maxItems)
    const keys = Array.from({ length: count }, (_, k) => start + k)
    for (const key of keys) this.requested.add(key)
    try {
      const { doc, gen } = this.opened
      const page = await this.core.call('page', { doc, lens: 'raw', gen, start, count })
      if (this.stopped) return
      // A page stops at 256 KiB, so some of the range may still be missing: the next pump asks for the rest. An
      // empty page means there's nothing more there yet; the next scroll asks again.
      if (page.items.length === 0) this.wanted = null
      this.cache.add(page.items.filter((item) => item.gen === gen))
      this.list.refresh()
    } finally {
      for (const key of keys) this.requested.delete(key)
    }
  }

  private async fetchPiece(s: Slot): Promise<void> {
    const expansion = this.expanded.get(s.line)!
    this.requested.add(s.key)
    try {
      const page = await this.core.call('page', { doc: this.opened.doc, lens: 'raw', continuation: expansion.tokens[s.piece - 1] })
      const item = page.items[0]
      if (this.stopped || !item || item.gen !== this.opened.gen) return
      this.cache.addPiece(String(s.key), item)
      if (item.next && expansion.tokens.length === s.piece) {
        expansion.tokens.push(item.next) // the line goes on: one more row below this one
        this.list.setRowCount(this.rowCount())
      }
      this.list.refresh()
    } finally {
      this.requested.delete(s.key)
    }
  }

  /** A refused request stops the lens rather than asking again: the document froze, the lens shows a generation
   *  Reload has replaced (`Stale`, dropped), or the request was a bug. A core that's gone is App's to show. */
  private failed(err: unknown): void {
    if (err instanceof CoreCallError && err.code === 'CoreGone') return
    this.stopped = true
    if (err instanceof CoreCallError && err.code === 'Frozen') this.options.onFrozen(err.message)
    else if (!(err instanceof CoreCallError && err.code === 'Stale')) console.error('page fetch failed', err)
  }

  private expand(line: number, token: Token): void {
    if (this.expanded.has(line) || this.stopped) return
    this.expanded.set(line, { tokens: [token] })
    this.expandedLines = [...this.expanded.keys()].sort((a, b) => a - b)
    this.list.setRowCount(this.rowCount())
    this.list.refresh() // the rows below have moved down
  }

  private paint(row: number, el: HTMLDivElement): void {
    const s = this.slot(row)
    const gutter = Object.assign(document.createElement('span'), { className: 'gutter', textContent: s.piece ? '' : String(s.line + 1) })
    gutter.setAttribute('aria-hidden', 'true')
    el.replaceChildren(gutter)
    Object.assign(el.dataset, { line: String(s.line), piece: String(s.piece) })
    const item = this.cache.get(s.key)
    if (!item) return
    el.append(Object.assign(document.createElement('span'), { className: 'text', textContent: item.text }))
    const marker = this.marker(s, item)
    if (marker) el.append(marker)
  }

  /** The end of a piece whose line goes on (brief §5.1). */
  private marker(s: Slot, item: PageItem): HTMLElement | null {
    if (!item.more) return null
    const next = item.next
    if (next && s.piece === 0 && !this.expanded.has(s.line)) {
      const button = Object.assign(document.createElement('button'), { className: 'more', textContent: '↪ more', title: 'Show more of this line' })
      button.setAttribute('aria-label', `Show more of line ${s.line + 1}`)
      button.addEventListener('click', () => this.expand(s.line, next))
      return button
    }
    const text = next ? '↪' : item.rest === undefined ? 'More on this line' : `+${size(item.rest)} more on this line`
    return Object.assign(document.createElement('span'), { className: 'more', textContent: text })
  }
}
