import { MAX_PRINT_BYTES, MAX_PRINT_PAGES, type Limits, type Opened, type PageItem, type Token } from '../../shared/protocol'
import { type CoreClient, CoreCallError, testHooks } from '../core'
import { inputMark, markPainted, setPaintProbe } from '../perf'
import { VirtualList } from '../virtual/virtual-list'
import { type Key, type Mounted, PageCache, ROW_HEIGHT, WRAP, capFor, rowsFor, rowsOf, viewportCap } from './page-cache'
import type { LensBudget } from './lens-budget'
import { SourceFind } from './source-find'
import { copySourceSpan } from './source-copy'
import { SourceCopyQueue } from './source-copy-queue'
import { sourceByteAt } from './source-map'
import { PRINT_LINES_PER_PAGE, type PrintPayload, type PrintPlan } from '../print'
import { utf8ByteLength } from './grid-interactions'

export { ROW_HEIGHT, viewportCap }

/**
 * A line with more than one row. Z66: a piece's text shows over rows of at most 2,048 units, `rows[k]` of them for its
 * piece k (1 until the piece is here). A line the reader expanded (brief §5.1) has its further pieces too: `tokens[k]`
 * fetches piece k + 1.
 */
interface LongLine {
  rows: number[]
  tokens: Token[]
}

const total = (l: LongLine) => l.rows.reduce((n, r) => n + r, 0)

/** A page request in flight (plan C5): the keys it fetches, and how to cancel it. */
interface Request {
  keys: Key[]
  abort: AbortController
}

/** What a row shows: row `sub` of a line's first piece (`piece` 0) or of one of its further pieces. */
interface Slot {
  line: number
  piece: number
  sub: number
  key: Key
}

export interface RawOptions {
  /** A page came back `Frozen` (spec §3.1): the lens has stopped asking for more. */
  onFrozen(why: string): void
  /** The line to start at (Reload keeps the reading position). */
  atLine?: number
  /** Markdown keeps Raw's confirmed share beside its retained Rendered tree. */
  budget?: LensBudget
  notice?(message: string): void
}

const mb = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })
const size = (bytes: number) => (bytes >= 1e6 ? `${mb.format(bytes / 1e6)} MB` : `${Math.max(1, Math.ceil(bytes / 1e3))} KB`)

/**
 * Raw (brief §5.1) on the virtualizer: a labelled, focusable region whose gutter is hidden from assistive tech
 * (plan §7 proposal 4). Rows wider than the card scroll horizontally, but a row shows at most 2,048 units, and a
 * longer piece goes on in the next rows (Z66); with Wrap lines on (`<html data-wrap-lines="true">`), a row shows at
 * most the card's width, and the line goes on in the next rows the same way. A line longer than a piece shows its first
 * piece with a marker; expanding it mounts the further pieces' rows, fetched with the core's continuation tokens as they
 * come into view, up to the line's first 1 MiB (plan C3).
 */
export class RawLens {
  readonly list: VirtualList
  readonly find: SourceFind
  private readonly cache: PageCache
  /** Only lines of more than one row, and only while their items are cached: an evicted item's line is forgotten, and
   *  counted again once it's fetched again. */
  private readonly long = new Map<number, LongLine>()
  /** Wrap lines' width in columns, or 0 for Z66's rows. */
  private cols = 0
  /** Items whose rows are counted at this width. Wrapping counts a line's rows only once it's mounted. */
  private counted = new WeakSet<PageItem>()
  /** Keys the cache evicted, for `forget` to drop from `long` at the next re-placing. */
  private readonly evicted: Key[] = []
  private readonly wrapSetting: MutationObserver
  private readonly wrapWidth: ResizeObserver
  private wrapTimer: ReturnType<typeof setTimeout> | undefined
  /** The long lines, ascending, and each one's rows past one in the lines before it: rows are found by bisection. */
  private longLines: number[] = []
  private before: number[] = []
  private extraRows = 0
  private lineCount = 0
  private findLineFloor = 0
  private atLine: number | undefined
  /** The reader scrolled, or pressed a key, or pointed: an open stays in Raw instead of switching to Rendered. */
  private moved = false
  /** The line last at the top while the view was on screen. Hiding the panel resets scroll before dispose. */
  private shownLine = 0
  /** A Rendered switch is about to take the reservation. In-flight sizing must not write over it. */
  private yielded = false
  private wanted: { first: number; last: number } | null = null
  /** The keys of the wanted range's rows: a request for none of them is stale. */
  private wantedKeys = new Set<Key>()
  /** Keys with a request in flight. */
  private readonly requested = new Set<Key>()
  /** At most 2 (spec §3.4). A cancelled request keeps its place until it ends, a chunk read later at most. */
  private readonly inflight = new Set<Request>()
  private scheduled = false
  /** Disposed, or frozen: nothing new is asked for or shown. */
  private stopped = false
  /** The freeze has reached the screen: App's banner is up (plan C8's paint probe). */
  private frozen = false
  /** Plan C1: what the core holds reserved for the cache, and the card size and mounted rows it was last sized for. */
  private reserved: number
  private sizedTo = ''
  private sizedRows = 0
  private sizings = 0
  private sizing = Promise.resolve()
  /** No page is fetched until the cache's first reservation has settled: its growth is charged first. */
  private reservedOnce = false
  private copyAll = false
  private readonly copies = new SourceCopyQueue(token => window.typose.cancelClipboardWrite(token))
  private indexed: boolean

  constructor(
    private readonly host: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    label: string,
    private readonly limits: Limits,
    private readonly options: RawOptions
  ) {
    // Plan C1: the open reserved at least the viewport's cap; only the rows a reservation covers are ever mounted.
    this.reserved = options.budget?.rawReserved ?? opened.reserved
    this.indexed = opened.indexed
    this.cache = new PageCache(limits)
    this.cache.onEvict = key => this.evicted.push(key)
    this.cache.setCap(this.reserved)
    this.cache.add(opened.firstPage.items)
    for (const item of opened.firstPage.items) this.count(item.line, item)
    this.reindex()
    this.list = new VirtualList(host, ROW_HEIGHT, (i, el) => this.paint(i, el), (r) => this.want(r), this.coveredRows())
    this.find = new SourceFind(host, this.list.element, core, opened, options.budget, (line, hit) => {
      this.moved = true
      this.atLine = line
      this.findLineFloor = Math.max(this.findLineFloor, line + 1)
      this.lineCount = Math.max(this.lineCount, this.findLineFloor)
      const sub = hit ? this.wrappedRowAt(line, hit.start) : 0 // counts the line's rows first
      this.list.setRowCount(this.rowCount())
      this.list.scrollToRow(this.rowOf(line) + sub)
      this.shownLine = line
    }, options.onFrozen)
    if (__TEST_HOOKS__) {
      testHooks.cache = () => ({ charged: this.cache.charged, cap: this.cache.cap, reserved: this.reserved })
      testHooks.items = () => [...this.cache.all()].map(([key, item]) => ({ key, text: item.text }))
    }
    Object.assign(this.list.element, { role: 'region', ariaLabel: `${label}, Raw` })
    // Reload's reading position, reached once the new index has found that line, unless the reader moves first.
    this.atLine = options.atLine
    this.shownLine = options.atLine ?? 0
    for (const type of ['wheel', 'keydown', 'pointerdown'] as const)
      this.list.element.addEventListener(type, () => {
        this.atLine = undefined
        this.moved = true
      }, { passive: true })
    this.list.element.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault()
        this.copyAll = true
        this.copies.cancel()
      } else if (!['Control', 'Meta', 'Shift', 'Alt'].includes(event.key) && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c')) this.copyAll = false
    }, { capture: true })
    for (const type of ['pointerdown', 'wheel'] as const) this.list.element.addEventListener(type, () => { this.copyAll = false; this.copies.cancel() }, { passive: true })
    document.addEventListener('selectionchange', this.selectionChanged)
    this.list.element.addEventListener('scroll', () => this.rememberLine(), { passive: true })
    this.setLineCount(opened.lines)
    // Plan C8: every input that can move the view demands frames until its target rows paint. A click can expand a
    // long line; it's marked after the button's own handler has added the rows.
    // A scroll the list applied itself (a wheel or key in logical mode, or the position re-applied as the index grows)
    // isn't an input: the wheel or key behind it is marked already, and a re-apply is the app's own (PR 9).
    for (const type of ['wheel', 'keydown', 'pointerdown', 'scroll', 'click'] as const)
      this.list.element.addEventListener(
        type,
        (e) => {
          if (type !== 'scroll' || !this.list.ownScroll) inputMark(type, e.timeStamp)
        },
        { passive: true }
      )
    setPaintProbe(() => this.paintedKey())
    // Wrap lines: wrapped now, and again as the setting or the fonts change, and once the card's width has settled.
    this.wrapSetting = new MutationObserver(() => this.rewrap())
    this.wrapSetting.observe(document.documentElement, { attributes: true, attributeFilter: ['data-wrap-lines', 'data-fonts'] })
    this.wrapWidth = new ResizeObserver(() => {
      clearTimeout(this.wrapTimer)
      this.wrapTimer = setTimeout(() => this.rewrap(), 100)
    })
    this.wrapWidth.observe(host)
    this.rewrap()
    markPainted('rawUsable') // the first bounded piece is on screen and scrollable (Z37)
    // Z37's first screen: the first frame that shows the first page has painted (rAF, then a task). Once per open.
    if (opened.firstPage.items.length > 0 && performance.getEntriesByName('typose:first-screen').length === 0)
      requestAnimationFrame(() => setTimeout(() => performance.mark('typose:first-screen')))
  }

  /** Plan C1: the viewport-only cap for this card's height, the least the next lens here needs: an open's floor. */
  floorBytes(): number {
    return viewportCap(this.limits, this.host.clientHeight)
  }

  /** Lines known so far: the index's count, but never fewer than the first page already showed (Z37). */
  setLineCount(lines: number): void {
    this.lineCount = Math.max(lines, this.opened.firstPage.items.length, this.findLineFloor)
    this.list.setRowCount(this.rowCount())
    if (this.atLine !== undefined && this.lineCount > this.atLine) {
      const row = this.rowOf(this.atLine)
      this.list.scrollToRow(row) // a source line can span several rows
      this.shownLine = this.atLine // shownLine stays a source line
      // A progressive prefix (or the bottom of Raw) can clamp the scroll before this line reaches the top.
      // Retain the source anchor for later index growth and for an automatic switch back to Rendered.
      if (this.list.state.top >= row * ROW_HEIGHT) this.atLine = undefined
    }
  }

  /** The line at the top of the viewport, or the one this lens was asked to open at until it gets there. */
  topLine(): number {
    this.rememberLine()
    return this.atLine !== undefined ? this.atLine : this.shownLine
  }

  /** A hidden scroller's scroll jumps to 0 before dispose. Keep the line from while it was on screen. */
  private rememberLine(): void {
    const el = this.list.element
    if (el.getClientRects().length === 0 || el.closest('[hidden]')) return
    this.shownLine = this.slot(Math.floor(this.list.state.top / ROW_HEIGHT)).line
  }

  /** The reader has moved the view (plan §2.2): don't switch to Rendered out from under them. */
  readerMoved(): boolean {
    return this.moved
  }

  /** The scroller, for focus. */
  get element(): HTMLElement {
    return this.list.element
  }

  focus(): void {
    this.list.element.focus()
  }

  /** Copies selected decoded Raw text as the original source bytes, or the whole file after Ctrl+A. */
  async copy(): Promise<boolean> {
    this.copies.cancel()
    const token = window.typose.beginClipboardWrite()
    if (!token) { this.options.notice?.('Copy unavailable · use Copy from the reader command menu'); return false }
    const view = this.opened.view
    if (!view) { window.typose.cancelClipboardWrite(token); this.options.notice?.('Copy unavailable · this view is no longer active'); return false }
    const selection = this.copyAll ? null : this.rawSelection()
    if (!this.copyAll && !selection) { window.typose.cancelClipboardWrite(token); this.options.notice?.('Select text in Raw, or press Ctrl+A to copy the whole file'); return false }
    const copyAll = this.copyAll
    const span = selection ? this.selectionBytes(selection) : { start: 0, end: this.opened.size }
    if (!span || span.end < span.start) {
      window.typose.cancelClipboardWrite(token)
      this.options.notice?.('Copy refused · selection exceeds the 16 MiB limit')
      return false
    }
    const generation = this.opened.gen
    const selectionStamp = selection ? this.selectionStamp(selection) : ''
    const sameSelection = () => {
      if (copyAll) return this.copyAll
      const current = this.rawSelection()
      return !!current && current.startContainer === selection?.startContainer && current.startOffset === selection?.startOffset &&
        current.endContainer === selection?.endContainer && current.endOffset === selection?.endOffset && this.selectionStamp(current) === selectionStamp
    }
    this.options.notice?.('Preparing copy…')
    // The queue starts this copy only once the one it cancelled has released its share.
    return this.copies.run(token, async (current, signal) => {
      try {
        const copied = await copySourceSpan({
          valid: () => current() && !this.stopped && !this.yielded && this.options.budget?.current(generation) !== false && sameSelection(),
          reserve: async bytes => this.options.budget ? this.options.budget.reserveCopy(generation, bytes) : bytes <= this.opened.reserved,
          read: (start, count, signal) => this.core.call('sourceBytes', { view, start, count }, signal),
          verify: signal => this.core.call('sourceVerify', { view, start: span!.start, end: span!.end }, signal),
          confirm: async bytes => window.confirm(`Copy ${new Intl.NumberFormat('en').format(bytes)} bytes to the clipboard?`),
          write: text => window.typose.writeClipboardText(text, token),
          cancelWrite: () => window.typose.cancelClipboardWrite(token),
          status: message => this.options.notice?.(message)
        }, span.start, span.end, this.opened.encoding, signal)
        if (copied) this.options.notice?.('Copied source text')
        else if (signal.aborted) this.options.notice?.('Copy cancelled')
        return copied
      } catch (error) {
        this.options.notice?.(error instanceof Error ? `Copy failed · ${error.message}` : 'Copy failed')
        return false
      }
    }, async () => { if (this.options.budget) await this.options.budget.reserveCopy(generation, 0) })
  }

  private readonly selectionChanged = (): void => {
    if (!this.copyAll) this.copies.cancel()
  }

  private rawSelection(): Range | null {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
    return start?.closest('.vl-row')?.closest('.vl-scroller') === this.list.element && end?.closest('.vl-row')?.closest('.vl-scroller') === this.list.element ? range.cloneRange() : null
  }

  private selectionStamp(range: Range): string {
    const row = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement
      const line = element?.closest<HTMLElement>('.vl-row')
      return `${line?.dataset.line ?? ''}:${line?.dataset.piece ?? ''}:${line?.dataset.sub ?? ''}`
    }
    return `${row(range.startContainer)}:${range.startOffset}-${row(range.endContainer)}:${range.endOffset}:${range.toString()}`
  }

  private selectionBytes(range: Range): { start: number; end: number } | null {
    const endpoint = (container: Node, offset: number, side: 'start' | 'end'): number | null => {
      const span = container instanceof Element ? container.closest('.text') : container.parentElement?.closest('.text')
      const row = span?.closest<HTMLElement>('.vl-row')
      if (!span || !row) return null
      const line = Number(row.dataset.line), piece = Number(row.dataset.piece), sub = Number(row.dataset.sub)
      const key: Key = piece === 0 ? line : `${line}:${piece}`
      const item = this.cache.get(key)
      if (!item) return null
      const textNode = span.firstChild
      const inText = container === textNode ? offset : container === span ? (side === 'start' ? 0 : textNode?.textContent?.length ?? 0) : null
      if (inText === null) return null
      const bounds = rowsOf(item, this.cols)
      const unit = bounds[sub] + inText
      return sourceByteAt(item.map, unit, side)
    }
    const start = endpoint(range.startContainer, range.startOffset, 'start')
    const end = endpoint(range.endContainer, range.endOffset, 'end')
    return start === null || end === null ? null : { start, end }
  }

  /** Go to a one-based source line without clamping to a still-growing index. */
  goTo(lineNumber: number): void {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return
    const line = lineNumber - 1
    this.atLine = line
    this.moved = true
    this.list.scrollToRow(this.rowOf(line))
  }

  printPlan(): PrintPlan {
    const pages = Math.ceil(this.lineCount / PRINT_LINES_PER_PAGE)
    return { unit: 'line', total: this.lineCount, current: this.topLine(), indexed: this.indexed, totalPages: pages,
      allFits: this.indexed && pages <= MAX_PRINT_PAGES && this.opened.size <= MAX_PRINT_BYTES }
  }

  async printRange(start: number, end: number, signal: AbortSignal): Promise<PrintPayload> {
    const generation = this.opened.gen, view = this.opened.view, owner = this.options.budget
    const current = () => !signal.aborted && !this.stopped && !this.yielded && this.indexed && !!view && owner?.current(generation) !== false
    if (!view || !owner || !current() || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.lineCount)
      throw new Error('The Raw print range is no longer available')
    if (!await owner.reserveCopy(generation, 512 << 10)) throw new Error('Print is unavailable · the memory budget is full')
    let retained = true
    try {
      const span = await this.core.call('sourceLineRange', { view, startLine: start, count: end - start }, signal)
      const decoder = new TextDecoder(this.opened.encoding, { ignoreBOM: true })
      const parts: string[] = []
      let offset = span.start, inputBytes = 0, outputBytes = 0, charged = 512 << 10
      while (offset < span.end) {
        if (!current()) throw new Error('The Raw print job was cancelled or the source changed')
        const count = Math.min(64 << 10, span.end - offset)
        const nextCharge = (512 << 10) + (inputBytes + count) * 2 + outputBytes * 4
        if (nextCharge > charged && !await owner.reserveCopy(generation, nextCharge)) throw new Error('Print is unavailable · the memory budget is full')
        charged = Math.max(charged, nextCharge)
        const bytes = await this.core.call('sourceBytes', { view, start: offset, count }, signal)
        if (!current() || bytes.length !== count) throw new Error('The Raw print source changed while reading')
        const chunk = decoder.decode(bytes, { stream: true })
        inputBytes += bytes.length
        outputBytes += utf8ByteLength(chunk)
        if (outputBytes > MAX_PRINT_BYTES) throw new Error('The selected print range exceeds the 8 MiB document limit')
        parts.push(chunk)
        offset += count
      }
      const tail = decoder.decode()
      outputBytes += utf8ByteLength(tail)
      if (outputBytes > MAX_PRINT_BYTES || !current()) throw new Error('The selected print range exceeds the bounded print limit')
      parts.push(tail)
      const text = parts.join('')
      const jsonBytes = utf8ByteLength(JSON.stringify(text))
      if (jsonBytes > MAX_PRINT_BYTES || !await owner.reserveCopy(generation, (512 << 10) + inputBytes * 2 + outputBytes * 4 + jsonBytes * 2))
        throw new Error('Print is unavailable · the memory budget is full')
      retained = false
      let released = false
      return {
        blocks: [{ tag: 'pre', children: [{ text }] }],
        pages: Math.ceil((end - start) / PRINT_LINES_PER_PAGE),
        verify: async checkSignal => !checkSignal.aborted && current() && await this.core.call('sourceVerify', { view, start: span.start, end: span.end }, checkSignal),
        release: async () => { if (released) return; released = true; await owner.reserveCopy(generation, 0) }
      }
    } finally {
      if (retained) await owner.reserveCopy(generation, 0)
    }
  }

  /**
   * Stop sizing the cache. An in-flight `reserve` bails when it returns, so a Rendered reservation made after this
   * isn't overwritten. The lens keeps showing until it unmounts.
   */
  yieldReservation(): void {
    this.yielded = true
    this.sizings++
  }

  /** The Rendered reservation was refused: size the cache again. */
  resumeReservation(): void {
    if (this.stopped) return
    this.yielded = false
    this.sizedTo = ''
    this.sizeCache()
  }

  /** The index is done. A last piece fetched before the index knew where its line ends says "More on this line":
   *  drop it, so it's fetched again and says how much more (brief §5.1). Its row shows the old text until then. */
  indexDone(): void {
    this.indexed = true
    if (this.atLine !== undefined) {
      this.atLine = Math.min(this.atLine, Math.max(0, this.lineCount - 1))
      this.setLineCount(this.lineCount)
    }
    if (this.cache.drop((item) => item.more && !item.next && item.rest === undefined) > 0) this.want(this.list.visibleRange())
  }

  /** The document froze (spec §3.1): keep what's shown, ask for nothing more. Called once the banner is up. */
  freeze(): void {
    this.find.freeze('file changed on disk')
    this.stopped = true
    this.frozen = true
  }

  /**
   * `release` drops the cache reservation. A switch to Rendered passes false: that lens already holds it, and zeroing
   * it here would race the hold. Close releases it with the document.
   */
  dispose(release = true): void {
    this.wrapSetting.disconnect()
    this.wrapWidth.disconnect()
    clearTimeout(this.wrapTimer)
    this.copies.cancel()
    document.removeEventListener('selectionchange', this.selectionChanged)
    this.find.destroy()
    this.stopped = true
    for (const q of this.inflight) q.abort.abort()
    setPaintProbe(null)
    this.list.dispose()
    if (__TEST_HOOKS__) testHooks.cache = testHooks.items = null
    if (!release) return
    // Plan C1: the cache is gone. A sizing still under way sends nothing more (`reserveFor`). If an open or Reload has
    // taken the reservation for the next lens, the core ignores this.
    const { doc, gen } = this.opened
    if (this.options.budget) void this.options.budget.reserveRaw(gen, 0)
    else void this.core.call('reserve', this.opened.view ? { view: this.opened.view, bytes: 0 } : { doc, gen, bytes: 0 }).catch(() => {})
  }

  private rowCount(): number {
    return this.lineCount + this.extraRows
  }

  /** Z66: piece `piece` of `line` shows over `rows` rows. Returns whether that changed the line's rows. */
  private setRows(line: number, piece: number, rows: number): boolean {
    let l = this.long.get(line)
    if (!l) {
      if (rows <= 1) return false
      this.long.set(line, (l = { rows: [1], tokens: [] }))
    }
    if (l.rows[piece] === rows) return false
    l.rows[piece] = rows
    if (!l.tokens.length && rows <= 1) this.long.delete(line) // back to one row; an expanded line keeps its pieces
    return true
  }

  /** Counts `item`'s rows at this width, once. Returns whether its line's rows changed. */
  private count(key: Key, item: PageItem): boolean {
    if (this.counted.has(item)) return false
    this.counted.add(item)
    const [line, piece] = typeof key === 'number' ? [key, 0] : key.split(':').map(Number)
    return this.setRows(line, piece, rowsOf(item, this.cols).length - 1)
  }

  /** Forgets the rows of what the cache evicted: a line counts as one row until it's fetched and counted again. */
  private forget(): boolean {
    let changed = false
    for (const key of this.evicted.splice(0)) {
      const [line, piece] = typeof key === 'number' ? [key, 0] : key.split(':').map(Number)
      changed = this.setRows(line, piece, 1) || changed
    }
    return changed
  }

  /** Wrap lines' width in columns: the scroller's width past a row's gutter, its text's end padding and a ↪, in the
   *  mono font's advance, measured on a hidden row. */
  private wrapColumns(): number {
    const probe = Object.assign(document.createElement('div'), { className: 'vl-row' })
    probe.style.visibility = 'hidden'
    const gutter = Object.assign(document.createElement('span'), { className: 'gutter', textContent: String(Math.max(1, this.lineCount)) })
    const text = Object.assign(document.createElement('span'), { className: 'text', textContent: '0'.repeat(100) })
    probe.append(gutter, text)
    this.list.element.append(probe)
    const range = document.createRange()
    range.selectNodeContents(text)
    const advance = range.getBoundingClientRect().width / 100
    const room = this.list.element.clientWidth - gutter.getBoundingClientRect().width - (text.getBoundingClientRect().width - 100 * advance) - advance
    probe.remove()
    return advance > 0 ? Math.max(2, Math.min(WRAP, Math.floor(room / advance))) : 0
  }

  /** With Wrap lines on, which of `line`'s rows shows source byte `byte`, when its first piece is here and holds it;
   *  else 0, its first row. */
  private wrappedRowAt(line: number, byte: number): number {
    const item = this.cache.get(line)
    if (!this.cols || !item || byte < item.map.start || byte >= item.map.end) return 0
    if (this.count(line, item)) this.reindex() // the view moves to it next, so nothing on screen needs keeping
    let [lo, hi] = [0, item.text.length] // the last unit that starts at or before `byte`
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (sourceByteAt(item.map, mid, 'start') <= byte) lo = mid
      else hi = mid - 1
    }
    const b = rowsOf(item, this.cols)
    let sub = 0
    while (sub + 2 < b.length && b[sub + 1] <= lo) sub++
    return sub
  }

  /** Wrap lines went on or off, or its width changed: every line's rows are forgotten, the line at the top is counted
   *  again so the view keeps the text that was there, and the rest count as they're mounted (`want`), so the work is a
   *  screen's, however much is cached. A hidden card keeps its rows until it's shown. Off, nothing is measured. */
  private rewrap(): void {
    const on = document.documentElement.dataset.wrapLines === 'true'
    if (!on && !this.cols || this.list.element.clientWidth === 0) return
    const cols = on ? this.wrapColumns() : 0
    if (cols === this.cols) return
    const was = this.place()
    const top = this.cache.get(was.at.key)
    const unit = top ? rowsOf(top, this.cols)[was.at.sub] ?? 0 : 0
    this.cols = this.cache.cols = cols
    this.counted = new WeakSet()
    this.evicted.length = 0
    for (const [line, l] of this.long) {
      if (l.tokens.length) l.rows = l.rows.map(() => 1) // an expanded line keeps its pieces
      else this.long.delete(line)
    }
    let sub = 0
    if (top) {
      this.count(was.at.key, top)
      const b = rowsOf(top, cols)
      while (sub + 2 < b.length && b[sub + 1] <= unit) sub++
    }
    this.list.resetWidth()
    this.placeRows(true, { at: { ...was.at, sub }, into: was.into }) // mounts the rows again, which counts them
    this.list.refresh()
  }

  /** Rebuilds the long lines' order and their rows before each. */
  private reindex(): void {
    this.longLines = [...this.long.keys()].sort((a, b) => a - b)
    this.before = []
    let extra = 0
    for (const line of this.longLines) {
      this.before.push(extra)
      extra += total(this.long.get(line)!) - 1
    }
    this.extraRows = extra
  }

  /** The index of the last long line starting at or before `row`, or of the last before `line` (`byLine`); else -1. */
  private longBefore(at: number, byLine: boolean): number {
    let [lo, hi, found] = [0, this.longLines.length - 1, -1]
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const start = byLine ? this.longLines[mid] : this.longLines[mid] + this.before[mid]
      if (byLine ? start < at : start <= at) [found, lo] = [mid, mid + 1]
      else hi = mid - 1
    }
    return found
  }

  /** The first row of `line`. */
  private rowOf(line: number): number {
    const i = this.longBefore(line, true)
    return i < 0 ? line : line + this.before[i] + total(this.long.get(this.longLines[i])!) - 1
  }

  private slot(row: number): Slot {
    const i = this.longBefore(row, false)
    if (i < 0) return { line: row, piece: 0, sub: 0, key: row }
    const line = this.longLines[i]
    const l = this.long.get(line)!
    let at = row - line - this.before[i]
    for (let piece = 0; piece < l.rows.length; piece++) {
      if (at < l.rows[piece]) return { line, piece, sub: at, key: piece === 0 ? line : `${line}:${piece}` }
      at -= l.rows[piece]
    }
    const extra = this.before[i] + total(l) - 1
    return { line: row - extra, piece: 0, sub: 0, key: row - extra }
  }

  /** The view's place: the slot at its top, and how far into that row. Taken before pieces' rows change. */
  private place(): { at: Slot; into: number } {
    const top = this.list.state.top
    return { at: this.slot(Math.floor(top / ROW_HEIGHT)), into: top % ROW_HEIGHT }
  }

  /** Z66: pieces' rows have changed; the view keeps its place (`was`) if lines above it grew or shrank. */
  private placeRows(changed: boolean, was: { at: Slot; into: number }): void {
    if (!changed) return
    this.reindex()
    this.list.setRowCount(this.rowCount())
    const { at, into } = was
    const l = this.long.get(at.line)
    const row = this.rowOf(at.line) + (l ? l.rows.slice(0, at.piece).reduce((n, r) => n + r, 0) : 0) + Math.min(at.sub, (l?.rows[at.piece] ?? 1) - 1)
    if (row * ROW_HEIGHT + into !== this.list.state.top) this.list.scrollToRow(row, into)
  }

  private want(r: { first: number; last: number }): void {
    this.sizeCache()
    const rows: Mounted[] = []
    for (let row = r.first; row < r.last; row++) rows.push(this.slot(row))
    // A mounted line's rows are counted now, at the latest (Wrap lines counts no sooner), and what the cache evicted
    // is forgotten. Either can move rows: placing them again mounts this range anew, which comes back here. The list's
    // first render comes from its constructor, before `list` is set; the constructor has counted the first page.
    if (this.list) {
      const was = this.place()
      let changed = this.forget()
      for (const s of rows) {
        const item = this.cache.get(s.key)
        if (item) changed = this.count(s.key, item) || changed
      }
      if (changed) {
        this.placeRows(true, was)
        this.list.refresh()
        return
      }
    }
    this.cache.setMounted(rows)
    this.wanted = r
    this.wantedKeys = new Set(rows.map((s) => s.key))
    this.schedule()
  }

  /** Coalesces viewport requests to one per animation frame (spec §3.4). */
  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** The most rows `visibleRange` mounts here by default: a viewport and one more each way. */
  private mountedRows(): number {
    return 3 * Math.ceil(this.host.clientHeight / ROW_HEIGHT) + 1
  }

  /** The rows the reservation covers, each at a row's most. */
  private coveredRows(): number {
    return rowsFor(this.limits, this.reserved)
  }

  /** Sizes the cache when the card's height changes, and tries again on any resize while the ledger has it cut short. */
  private sizeCache(): void {
    const rows = this.mountedRows()
    const size = `${this.host.clientWidth}x${this.host.clientHeight}`
    if (size === this.sizedTo) return
    this.sizedTo = size
    if (rows === this.sizedRows && this.reserved >= capFor(this.limits, rows)) return
    this.sizedRows = rows
    const n = ++this.sizings
    this.sizing = this.sizing.then(() => this.reserveFor(rows, n))
  }

  /**
   * Plan C1: the core's ledger reserves the cache's cap before the cache may grow into it, for `rows` mounted rows and
   * the elastic part. A refusal drops the elastic part, then the overscan, so only the viewport is mounted. A smaller
   * cap than what's held applies at once, and the rest is released. Refused even for the viewport, the lens keeps what's
   * held and mounts only the rows it covers: the rest of the viewport stays blank, and the cache is never charged past
   * its reservation.
   */
  private async reserveFor(rows: number, n: number): Promise<void> {
    if (n !== this.sizings || this.stopped || this.yielded) return // a later size, or Rendered, has superseded this one
    const { doc, gen } = this.opened
    // The last, if all are refused: what the core already holds.
    const caps = [capFor(this.limits, rows), capFor(this.limits, rows, false), viewportCap(this.limits, this.host.clientHeight), this.reserved]
    for (const cap of caps) {
      const held = cap <= this.reserved
      const granted = held || (this.options.budget
        ? await this.options.budget.reserveRaw(gen, cap)
        : await this.core.call('reserve', this.opened.view ? { view: this.opened.view, bytes: cap } : { doc, gen, bytes: cap }).catch(() => false))
      if (n !== this.sizings || this.stopped || this.yielded) return // disposed, or Rendered took the reservation
      if (!granted) continue
      const shrunk = held && cap < this.reserved
      this.reserved = cap
      this.cache.setCap(cap)
      this.list.setMaxRows(this.coveredRows()) // mounts or unmounts rows now, not at the next scroll
      // Shrink locally before releasing the allowance: even a delayed reserve response must not leave mounted
      // rows or cache entries claiming the old cap after the core has lowered its reservation.
      if (held && this.options.budget) await this.options.budget.reserveRaw(gen, cap)
      else if (shrunk) void this.core.call('reserve', this.opened.view ? { view: this.opened.view, bytes: cap } : { doc, gen, bytes: cap }).catch(() => {})
      break
    }
    this.reservedOnce = true
    this.schedule()
  }

  /**
   * Once a frame: cancels every request the wanted range no longer meets (plan C5), then fetches the range's first
   * missing row, with at most 2 requests in flight (spec §3.4).
   */
  private pump(): void {
    const r = this.wanted
    if (!r || this.stopped || !this.reservedOnce) return
    for (const q of this.inflight) if (!q.keys.some((key) => this.wantedKeys.has(key))) q.abort.abort()
    if (this.inflight.size >= 2) return
    let missing: Slot | null = null
    for (let row = r.first; row < r.last && !missing; row++) {
      const s = this.slot(row)
      if (!this.cache.has(s.key) && !this.requested.has(s.key)) missing = s
    }
    if (!missing) return
    const q: Request = { keys: [], abort: new AbortController() }
    this.inflight.add(q)
    const fetched = missing.piece > 0 ? this.fetchPiece(missing, q) : this.fetchLines(missing.line, this.slot(r.last - 1).line + 1, q)
    void fetched
      .catch((err: unknown) => this.failed(err))
      .finally(() => {
        this.inflight.delete(q)
        this.schedule()
      })
    this.schedule() // the next frame may send the second
  }

  /**
   * What the viewport shows, once settled; else null. That's the scroll position and the row count, which grows as a
   * long line's pieces expand, once every row in the viewport (not the overscan) has its text: a line's first piece
   * or a further one. Once the document has frozen and its banner is up, the view is settled as it stands: rows that
   * never got their text stay blank (spec §3.1).
   */
  private paintedKey(): string | null {
    const { top, geometry } = this.list.state
    const view = `${top},${this.list.element.scrollLeft},${this.rowCount()}`
    if (this.frozen) return `${view},frozen`
    const last = Math.min(geometry.total, top + geometry.viewport) / ROW_HEIGHT
    for (let row = Math.floor(top / ROW_HEIGHT); row < last; row++) if (!this.cache.has(this.slot(row).key)) return null
    return view
  }

  private async fetchLines(start: number, end: number, q: Request): Promise<void> {
    const count = Math.min(Math.max(1, end - start), this.limits.maxItems)
    const keys = (q.keys = Array.from({ length: count }, (_, k) => start + k))
    for (const key of keys) this.requested.add(key)
    try {
      const { doc, gen } = this.opened
      const page = await this.core.call('page', { doc, lens: 'raw', gen, start, count }, q.abort.signal)
      if (this.stopped || q.abort.signal.aborted) return // a result that came after its cancel: ignored (plan C5)
      // A page stops at 256 KiB, so some of the range may still be missing: the next pump asks for the rest. An
      // empty page means there's nothing more there yet; the next scroll asks again.
      if (page.items.length === 0) this.wanted = null
      const items = page.items.filter((item) => item.gen === gen)
      this.cache.add(items)
      const was = this.place()
      let changed = this.forget()
      // Z66's rows count at once; Wrap lines counts only what's to be mounted, and the rest once it is (`want`).
      for (const item of items) if (!this.cols || this.wantedKeys.has(item.line)) changed = this.count(item.line, item) || changed
      this.placeRows(changed, was)
      this.list.refresh()
    } finally {
      for (const key of keys) this.requested.delete(key)
    }
  }

  private async fetchPiece(s: Slot, q: Request): Promise<void> {
    const expansion = this.long.get(s.line)!
    q.keys = [s.key]
    this.requested.add(s.key)
    try {
      const page = await this.core.call('page', { doc: this.opened.doc, lens: 'raw', continuation: expansion.tokens[s.piece - 1] }, q.abort.signal)
      const item = page.items[0]
      if (this.stopped || q.abort.signal.aborted || !item || item.gen !== this.opened.gen) return
      this.cache.addPiece(String(s.key), item)
      const was = this.place()
      let changed = this.forget()
      changed = this.count(s.key, item) || changed
      if (item.next && expansion.tokens.length === s.piece) {
        expansion.tokens.push(item.next) // the line goes on: one more piece below this one
        expansion.rows.push(1)
        changed = true
      }
      this.placeRows(changed, was)
      this.list.refresh()
    } finally {
      this.requested.delete(s.key)
    }
  }

  /** A refused request stops the lens rather than asking again: the document froze, the lens shows a generation
   *  Reload has replaced (`Stale`, dropped), or the request was a bug. A core that's gone is App's to show, and a
   *  cancelled request is one the lens no longer wanted. */
  private failed(err: unknown): void {
    if (err instanceof CoreCallError && (err.code === 'CoreGone' || err.code === 'Cancelled')) return
    this.stopped = true
    if (err instanceof CoreCallError && err.code === 'Frozen') this.options.onFrozen(err.message)
    else if (!(err instanceof CoreCallError && err.code === 'Stale')) console.error('page fetch failed', err)
  }

  private expand(line: number, token: Token): void {
    const l = this.long.get(line) ?? { rows: [1], tokens: [] }
    if (l.tokens.length > 0 || this.stopped) return
    l.tokens.push(token)
    l.rows.push(1)
    this.long.set(line, l)
    this.reindex()
    this.list.setRowCount(this.rowCount())
    this.list.refresh() // the rows below have moved down
  }

  private paint(row: number, el: HTMLDivElement): void {
    const s = this.slot(row)
    const gutter = Object.assign(document.createElement('span'), { className: 'gutter', textContent: s.piece || s.sub ? '' : String(s.line + 1) })
    gutter.setAttribute('aria-hidden', 'true')
    el.replaceChildren(gutter)
    Object.assign(el.dataset, { line: String(s.line), piece: String(s.piece), sub: String(s.sub) })
    const item = this.cache.get(s.key)
    if (!item) return
    const b = rowsOf(item, this.cols)
    if (s.sub + 1 >= b.length) return
    el.append(Object.assign(document.createElement('span'), { className: 'text', textContent: item.text.slice(b[s.sub], b[s.sub + 1]) }))
    // Z66: a piece's rows but its last go on in the next row (brief §5.1's ↪ continuation marker), which assistive tech
    // skips, as it does the gutter: the row's text reads on into the next.
    const marker = s.sub + 2 < b.length ? Object.assign(document.createElement('span'), { className: 'more', textContent: '↪', ariaHidden: 'true' }) : this.marker(s, item)
    if (marker) el.append(marker)
  }

  /** The end of a piece whose line goes on (brief §5.1). */
  private marker(s: Slot, item: PageItem): HTMLElement | null {
    if (!item.more) return null
    const next = item.next
    if (next && s.piece === 0 && !this.long.get(s.line)?.tokens.length) {
      const button = Object.assign(document.createElement('button'), { className: 'more', textContent: '↪ more', title: 'Show more of this line' })
      button.setAttribute('aria-label', `Show more of line ${s.line + 1}`)
      button.addEventListener('click', () => this.expand(s.line, next))
      return button
    }
    const text = next ? '↪' : item.rest === undefined ? 'More on this line' : `+${size(item.rest)} more on this line`
    return Object.assign(document.createElement('span'), { className: 'more', textContent: text })
  }
}
