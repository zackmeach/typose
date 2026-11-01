import { MAX_PRINT_BYTES, MAX_PRINT_PAGES, type CsvCellPiece, type CsvColumn, type CsvFindHit, type CsvFindRef, type CsvInfo, type CsvOptions, type CsvOrderRef, type CsvRef, type CsvRow, type Limits, type Opened, type PrintNode } from '../../shared/protocol'
import { type CoreClient, CoreCallError } from '../core'
import { EMPTY_FIND, FindSignal, type FindController, type FindQuery } from '../find'
import { ScrollState, isLogical, spacerHeight, visibleRows, wheelPixels } from '../virtual/scrollmath'
import type { LensBudget } from './lens-budget'
import { viewportCap } from './page-cache'
import { GRID_TEXT_UNITS as TEXT_UNITS, MAX_GRID_CELLS as MAX_CELLS, gridCellPreview, gridTextPreview as preview, nextGridCell, type GridCellPreview, type GridRange } from './grid-cache'
import { extendSelection, nextGridSort, selectCell, type GridSelection, type GridSort, selectionBounds } from './grid-interactions'
import { GridCopyJob, type GridCopyJob as GridCopyJobType } from './grid-copy'
import { PRINT_LINES_PER_PAGE, type PrintPayload, type PrintPlan } from '../print'
import { utf8ByteLength } from './grid-interactions'

const ROW = 28
const HEADER = 28
const GUTTER = 52
const WIDTH = 160
// Bounded summaries/row metadata/column names plus two decoded maximum-size pending replies.
const CACHE_BYTES = 4 << 20
const FIND_BYTES = 1 << 20
const cellKey = (row: number, column: number) => `${row}:${column}`
const sameRef = (a: CsvRef, b: CsvRef) => a.session === b.session && a.doc === b.doc && a.gen === b.gen && a.revision === b.revision
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => Object.assign(document.createElement(tag), { className })

export interface GridOptions {
  atLine?: number
  budget: LensBudget | null
  options: CsvOptions
  onFrozen(reason: string): void
  onShowRaw(line: number): void
  onInfo(info: CsvInfo): void
}

interface CachedRow { sourceLine: number; sourceRecord: number; fieldCount: number }

/** A concrete CSV viewport; no React cell tree, full-file values or renderer parser. */
export class GridLens {
  readonly element = make('div', 'csv-grid')
  readonly find: FindController
  private readonly interactionId = crypto.randomUUID()
  private readonly spacer = make('div', 'csv-spacer')
  private readonly layer = make('div', 'csv-layer')
  private readonly headers = make('div', 'csv-header-row')
  private readonly rowHeading = make('div', 'csv-gutter csv-heading')
  private readonly status = make('div', 'csv-status')
  private readonly findExcerpt = make('div', 'csv-find-excerpt')
  private readonly actionsButton = make('button', 'csv-actions-button')
  private readonly state = new ScrollState({ total: 0, viewport: 0 })
  private readonly observer: ResizeObserver
  private readonly cells = new Map<string, GridCellPreview>()
  private readonly rows = new Map<number, CachedRow>()
  private readonly columns = new Map<number, CsvColumn>()
  private readonly mounted = new Map<string, HTMLDivElement>()
  private readonly rowElements = new Map<number, HTMLDivElement>()
  private readonly headerElements = new Map<number, HTMLDivElement>()
  private readonly abort = new AbortController()
  private info: CsvInfo
  private order: CsvOrderRef | undefined
  private sortColumn = -1
  private sortDirection: GridSort = 'none'
  private sortAbort: AbortController | undefined
  private sortNavigation: Promise<void> = Promise.resolve()
  private findCell: { row: number; column: number } | undefined
  private readonly findSignal = new FindSignal()
  private findQuery: FindQuery = { text: '', matchCase: false }
  private findRef: CsvFindRef | undefined
  private findHit: CsvFindHit | undefined
  private findEpoch = 0
  private findAbort: AbortController | undefined
  private pendingFind = false
  private findNavigation: Promise<void> = Promise.resolve()
  private readonly findHits = new Map<number, CsvFindHit>()
  private copyJob: GridCopyJobType | undefined
  private copyPending = false
  private copyDialog: HTMLDivElement | undefined
  private contextMenu: HTMLDivElement | undefined
  private contextTrigger: HTMLElement | undefined
  private lastGridFocus: HTMLElement | undefined
  private copySourceRange: { first: number; last: number; order: CsvOrderRef; records: Map<number, number> } | undefined
  private range: GridRange = { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 }
  private active = { row: 0, column: 0 }
  private selection: GridSelection = selectCell(this.active, 1, 1)
  private focusWanted = false
  private dragging = false
  private stopped = false
  private disposed = false
  private yielded = false
  private moved = false
  private pumping = false
  private wake = false
  private paid = false
  private sizing = Promise.resolve()
  private reserved: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private atLine: number | undefined
  private atRow: number | undefined
  private shownLine: number
  private messageHoldUntil = 0
  private inspector: HTMLDivElement | null = null
  private inspectorPeak = false
  private inspecting = false
  private inspectAbort: AbortController | undefined

  constructor(
    private readonly host: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    info: CsvInfo,
    private readonly limits: Limits,
    private readonly options: GridOptions
  ) {
    this.info = info
    this.order = { csv: info.ref, id: 0 }
    this.find = {
      subscribe: this.findSignal.subscribe,
      snapshot: this.findSignal.snapshot,
      search: query => this.searchFind(query),
      next: direction => { void this.nextFind(direction) },
      close: () => this.closeFind()
    }
    this.reserved = 0
    this.atLine = options.atLine
    this.shownLine = options.atLine ?? 0
    this.element.setAttribute('role', 'grid')
    this.element.setAttribute('aria-label', 'CSV grid')
    this.element.setAttribute('aria-multiselectable', 'true')
    this.element.tabIndex = 0
    this.status.setAttribute('role', 'status')
    this.findExcerpt.setAttribute('role', 'status')
    this.findExcerpt.setAttribute('aria-live', 'polite')
    this.findExcerpt.setAttribute('aria-label', 'Current CSV match')
    this.actionsButton.type = 'button'
    this.actionsButton.textContent = '⋯'
    this.actionsButton.setAttribute('aria-label', 'Grid actions')
    this.actionsButton.setAttribute('aria-haspopup', 'menu')
    this.actionsButton.setAttribute('aria-expanded', 'false')
    this.actionsButton.title = 'Grid actions (right-click or Shift+F10 for row and column commands)'
    this.headers.setAttribute('role', 'row')
    this.headers.setAttribute('aria-rowindex', '1')
    this.rowHeading.setAttribute('role', 'columnheader')
    this.rowHeading.setAttribute('aria-colindex', '1')
    this.rowHeading.textContent = 'Row'
    this.spacer.setAttribute('aria-hidden', 'true')
    this.element.append(this.headers, this.spacer, this.layer)
    host.append(this.element, this.status, this.findExcerpt, this.actionsButton)
    this.actionsButton.addEventListener('click', () => {
      const bounds = this.actionsButton.getBoundingClientRect()
      this.openContextMenu(document.activeElement, bounds.left, bounds.bottom)
    })
    this.element.addEventListener('scroll', () => {
      this.state.onNativeScroll(this.element.scrollTop)
      this.rememberLine()
      this.layout()
    }, { passive: true })
    this.element.addEventListener('wheel', event => {
      if (event.ctrlKey) return
      this.moved = true
      this.atLine = undefined
      if (!isLogical(this.state.geometry.total)) return
      event.preventDefault()
      this.element.scrollLeft += wheelPixels(event.deltaX, event.deltaMode, WIDTH, this.element.clientWidth)
      this.apply(this.state.moveBy(wheelPixels(event.deltaY, event.deltaMode, ROW, this.state.geometry.viewport)))
    }, { passive: false })
    this.element.addEventListener('keydown', event => this.key(event))
    this.element.addEventListener('focusin', event => {
      if (event.target instanceof HTMLElement) this.lastGridFocus = event.target
    })
    this.element.addEventListener('contextmenu', event => {
      event.preventDefault()
      this.openContextMenu(event.target, event.clientX, event.clientY)
    })
    this.element.addEventListener('pointerdown', event => this.pointerDown(event))
    this.element.addEventListener('pointerover', event => this.pointerOver(event))
    this.element.addEventListener('pointerup', () => { this.dragging = false })
    this.element.addEventListener('pointerdown', () => { this.moved = true; this.atLine = undefined }, { passive: true })
    window.addEventListener('pointerup', () => { this.dragging = false }, { signal: this.abort.signal })
    window.addEventListener('pointercancel', () => { this.dragging = false }, { signal: this.abort.signal })
    window.addEventListener('pointerdown', event => {
      if (!this.contextMenu || !(event.target instanceof Node) || this.contextMenu.contains(event.target) || this.actionsButton.contains(event.target)) return
      this.closeContextMenu(false)
    }, { capture: true, signal: this.abort.signal })
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || !this.copyPending || this.copyDialog) return
      event.preventDefault(); event.stopPropagation(); this.cancelCopy(); this.message('Copy cancelled', true)
    }, { capture: true, signal: this.abort.signal })
    this.observer = new ResizeObserver(() => { void this.size() })
    this.observer.observe(host)
    void this.size()
  }

  private get rowCount(): number { return Math.max(0, this.info.sourceRecords - (this.info.header ? 1 : 0)) }
  private get columnCount(): number { return Math.max(this.info.expectedColumns, this.info.maxColumnsKnown) }

  /** Provisional conservative limits; qualify Grid-specific layout costs before claiming full memory acceptance. */
  floorBytes(): number { return viewportCap(this.limits, this.host.clientHeight) }

  private gridBytes(): number {
    const rows = Math.ceil(Math.max(0, this.host.clientHeight - HEADER) / ROW) + 2
    const columns = Math.ceil(Math.max(0, this.host.clientWidth - GUTTER) / WIDTH) + 2
    const cells = Math.min(MAX_CELLS, rows * columns + 1)
    return (24 << 20) + CACHE_BYTES + cells * (16_384 + TEXT_UNITS * (320 + 960)) +
      (this.inspectorPeak ? (64 << 10) * (320 + 960) + 16_384 : 0)
  }

  topLine(): number { this.rememberLine(); return this.atLine ?? this.shownLine }
  readerMoved(): boolean { return this.moved }
  focus(): void { this.focusWanted = true; this.layout(); if (!this.mounted.has(cellKey(this.active.row, this.active.column))) this.element.focus() }
  goTo(rowNumber: number): void {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) return
    this.atRow = rowNumber - 1
    this.moved = true
    if (this.rowCount > this.atRow || this.info.done) this.placeAtRow()
    this.request()
  }

  printPlan(): PrintPlan {
    const pages = Math.ceil(this.rowCount / PRINT_LINES_PER_PAGE)
    return { unit: 'row', total: this.rowCount, current: this.active.row, indexed: this.info.done, totalPages: pages,
      allFits: this.info.done && pages <= MAX_PRINT_PAGES && this.opened.size <= MAX_PRINT_BYTES && this.rowCount * this.columnCount <= 30_000 }
  }

  async printRange(start: number, end: number, signal: AbortSignal): Promise<PrintPayload> {
    const ref = this.info.ref, order = this.order, owner = this.options.budget, generation = this.opened.gen
    const current = () => !signal.aborted && !this.stopped && !this.yielded && !this.disposed && this.info.done && !!order &&
      this.valid(ref) && this.order?.id === order.id && owner?.current(generation) !== false
    if (!owner || !order || !current() || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.rowCount ||
      (end - start) * this.columnCount > 30_000) throw new Error('The Grid print range is unavailable or too large')
    if (!await owner.reserveCopy(generation, 512 << 10)) throw new Error('Print is unavailable · the memory budget is full')
    let retained = true
    try {
      const children: PrintNode[] = []
      let bytes = 0, cells = 0
      const cellText = async (sourceRecord: number, column: number): Promise<string> => {
        let cell = await this.core.call('csvCell', { ref, sourceRecord, column }, signal)
        if (!current()) throw new Error('The Grid print job was cancelled or the source changed')
        if (cell.kind === 'missing') return ''
        const parts: string[] = []
        while (true) {
          bytes += utf8ByteLength(cell.text)
          cells++
          if (bytes > MAX_PRINT_BYTES || cells > 30_000 || !await owner.reserveCopy(generation, (512 << 10) + bytes * 4 + cells * 96))
            throw new Error('The selected Grid range exceeds the bounded print budget')
          parts.push(cell.text)
          if (!cell.next) break
          cell = await this.core.call('csvPiece', { continuation: cell.next }, signal)
          if (!current()) throw new Error('The Grid print job was cancelled or the source changed')
        }
        return parts.join('')
      }
      if (this.info.header) {
        const header: PrintNode[] = []
        for (let column = 0; column < this.columnCount; column++) header.push({ tag: 'th', children: [{ text: await cellText(0, column) }] })
        children.push({ tag: 'thead', children: [{ tag: 'tr', children: header }] })
      }
      const rows: PrintNode[] = []
      for (let first = start; first < end; first += 64) {
        const count = Math.min(64, end - first)
        const page = await this.page(ref, first, count, 0, 1, signal, order)
        if (!current() || !sameRef(page.ref, ref)) throw new Error('The Grid print order changed')
        const records = new Map(page.rows.map(row => [row.dataRow, row.sourceRecord]))
        for (let row = first; row < first + count; row++) {
          let sourceRecord = records.get(row)
          if (sourceRecord === undefined) {
            const exact = await this.page(ref, row, 1, 0, 1, signal, order)
            if (!current() || !sameRef(exact.ref, ref)) throw new Error('The Grid print order changed')
            sourceRecord = exact.rows.find(item => item.dataRow === row)?.sourceRecord
          }
          if (sourceRecord === undefined) throw new Error('A selected CSV row is unavailable for print')
          const cells: PrintNode[] = []
          for (let column = 0; column < this.columnCount; column++) cells.push({ tag: 'td', children: [{ text: await cellText(sourceRecord, column) }] })
          rows.push({ tag: 'tr', children: cells })
        }
      }
      children.push({ tag: 'tbody', children: rows })
      const blocks: PrintNode[] = [{ tag: 'table', children }]
      const serialized = JSON.stringify(blocks)
      const serializedBytes = utf8ByteLength(serialized)
      if (!current() || serializedBytes > MAX_PRINT_BYTES || !await owner.reserveCopy(generation, (512 << 10) + bytes * 4 + serializedBytes * 2 + cells * 96))
        throw new Error('The selected Grid range exceeds the bounded print budget')
      retained = false
      let released = false
      return {
        blocks, pages: Math.ceil((end - start) / PRINT_LINES_PER_PAGE),
        verify: async checkSignal => !checkSignal.aborted && current() && !!this.opened.view && await this.core.call('sourceVerify', { view: this.opened.view, start: 0, end: this.opened.size }, checkSignal),
        release: async () => { if (released) return; released = true; await owner.reserveCopy(generation, 0) }
      }
    } finally { if (retained) await owner.reserveCopy(generation, 0) }
  }
  copy(): Promise<boolean> { return this.copySelection() }
  setLineCount(_lines: number): void { this.request() }
  indexDone(): void { this.request() }
  freeze(): void { this.stopped = true; clearTimeout(this.timer); this.abort.abort(); this.sortAbort?.abort(); this.cancelCopy(); this.cancelInspector(); this.closeContextMenu(false); this.closeFind() }
  yieldReservation(): void { this.yielded = true; clearTimeout(this.timer); this.cancelCopy(); this.cancelInspector(); this.closeContextMenu(false); this.closeFind() }
  resumeReservation(): void { if (!this.stopped) { this.yielded = false; void this.size() } }

  dispose(release = true): void {
    this.disposed = true
    this.sortAbort?.abort()
    if (this.opened.view) {
      void this.core.call('csvOrderClose', { view: this.opened.view, order: this.order ?? { csv: this.info.ref, id: 0 }, interactionId: this.interactionId }).catch(() => {})
    }
    this.cancelCopy()
    this.cancelInspector()
    this.closeContextMenu(false)
    this.closeFind()
    this.freeze()
    this.observer.disconnect()
    this.inspector?.remove()
    this.element.remove()
    this.status.remove()
    this.findExcerpt.remove()
    this.actionsButton.remove()
    this.closeContextMenu(false)
    this.cells.clear(); this.rows.clear(); this.columns.clear(); this.mounted.clear(); this.rowElements.clear(); this.headerElements.clear()
    if (release) {
      if (this.options.budget) void this.options.budget.reserveGrid(this.opened.gen, 0)
    }
  }

  private valid(ref = this.info.ref): boolean { return !this.disposed && !this.stopped && !this.yielded && sameRef(ref, this.info.ref) }
  private message(text: string, hold = false): void {
    if (this.disposed || !hold && (Date.now() < this.messageHoldUntil || this.copyPending)) return
    if (hold) this.messageHoldUntil = Date.now() + 5000
    this.status.textContent = text
  }
  private apply(top: number): void { this.element.scrollTop = top; this.state.confirmNative(this.element.scrollTop); this.layout() }

  private placeAtRow(): void {
    if (this.atRow === undefined) return
    const row = Math.max(0, Math.min(this.atRow, this.rowCount - 1))
    this.atRow = undefined
    this.active = { row, column: this.active.column }
    this.selection = selectCell(this.active, this.rowCount, this.columnCount)
    this.apply(this.state.moveTo(row * ROW))
  }

  private async size(): Promise<void> {
    const work = this.sizing.then(async () => {
      if (!this.valid()) return
      if (!this.options.budget) { this.message('Grid is unavailable · its view budget is missing. Open in Raw.'); return }
      const bytes = this.gridBytes()
      const granted = await this.options.budget.reserveGrid(this.opened.gen, bytes)
      if (!this.valid()) return
      if (!granted) { this.message('Grid is unavailable · the viewport exceeds the memory budget. Open in Raw.'); return }
      this.reserved = bytes
      this.paid = true
      this.state.setViewport(Math.max(0, this.element.clientHeight - HEADER))
      this.layout()
    })
    this.sizing = work.catch(error => this.failed(error))
    await this.sizing
  }

  private rememberLine(): void {
    if (!this.element.isConnected || !this.element.getClientRects().length) return
    const row = this.rows.get(Math.floor(this.state.top / ROW))
    if (row) this.shownLine = row.sourceLine
  }

  private wanted(row: number, column: number): boolean {
    const r = this.range
    return row >= r.firstRow && row < r.lastRow && column >= r.firstColumn && column < r.lastColumn || row === this.active.row && column === this.active.column
  }

  private layout(schedule = true): void {
    if (!this.paid || this.disposed) return
    const width = GUTTER + WIDTH * this.columnCount
    // 5,000 columns fit native X; a still wider unsupported extent is visibly refused.
    if (!Number.isSafeInteger(width) || width > 16_000_000) { this.message('Grid is unavailable at this width · open in Raw'); return }
    this.state.setTotal(this.rowCount * ROW)
    this.spacer.style.height = `${spacerHeight(this.state.geometry.total)}px`
    this.spacer.style.width = this.headers.style.width = this.layer.style.width = `${width}px`
    this.element.setAttribute('aria-rowcount', String(this.info.done ? this.rowCount + 1 : -1))
    this.element.setAttribute('aria-colcount', String(this.columnCount + 1))
    const rows = visibleRows(this.state.top, this.state.geometry.viewport, ROW, this.rowCount, 1)
    const firstColumn = Math.max(0, Math.floor((this.element.scrollLeft - GUTTER) / WIDTH))
    const lastColumn = Math.min(this.columnCount, Math.ceil((this.element.scrollLeft + this.element.clientWidth - GUTTER) / WIDTH) + 1)
    if ((rows.last - rows.first) * (lastColumn - firstColumn) + 1 > MAX_CELLS) { this.message('Grid viewport is too large for its cell budget · open in Raw'); return }
    this.range = { firstRow: rows.first, lastRow: rows.last, firstColumn, lastColumn }
    for (const [key, node] of this.mounted) {
      const [row, column] = key.split(':').map(Number)
      if (!this.wanted(row, column)) { node.remove(); this.mounted.delete(key) }
    }
    for (const [key] of this.cells) {
      const [row, column] = key.split(':').map(Number)
      if (!this.wanted(row, column)) this.cells.delete(key)
    }
    for (const [row, node] of this.rowElements) if ((row < rows.first || row >= rows.last) && row !== this.active.row) {
      node.remove(); this.rowElements.delete(row); this.rows.delete(row)
    }
    this.paintHeaders()
    for (let row = rows.first; row < rows.last; row++) for (let column = firstColumn; column < lastColumn; column++) this.paintCell(row, column)
    if (this.cells.has(cellKey(this.active.row, this.active.column))) this.paintCell(this.active.row, this.active.column)
    for (const [row, node] of this.rowElements) node.style.top = `${HEADER + row * ROW - this.state.top + this.element.scrollTop}px`
    const ready = this.rowCount === 0 && this.info.done || this.range.lastRow > this.range.firstRow && this.cells.has(cellKey(this.range.firstRow, firstColumn))
    if (ready) this.element.dataset.ready = '1'
    else delete this.element.dataset.ready
    if (schedule) this.request()
  }

  private paintHeaders(): void {
    if (!this.rowHeading.isConnected) this.headers.append(this.rowHeading)
    const wanted = new Set<number>()
    for (let column = this.range.firstColumn; column < this.range.lastColumn; column++) {
      wanted.add(column)
      let node = this.headerElements.get(column)
      if (!node) {
        node = make('div', 'csv-cell csv-heading')
        node.setAttribute('role', 'columnheader')
        node.setAttribute('aria-haspopup', 'menu')
        node.dataset.column = String(column)
        node.tabIndex = 0
        node.addEventListener('click', event => { if (event.button === 0) void this.requestSort(column) })
        node.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.code !== 'Space') return
          event.preventDefault(); event.stopPropagation(); void this.requestSort(column)
        })
        const before = [...this.headers.children].find(child => Number((child as HTMLElement).dataset.column) > column)
        this.headers.insertBefore(node, before ?? null)
        this.headerElements.set(column, node)
      }
      node.setAttribute('aria-colindex', String(column + 2))
      const meta = this.columns.get(column)
      const name = meta?.name || `Column ${column + 1}`
      if (node.textContent !== name) node.textContent = name
      node.setAttribute('aria-label', name)
      const sort = this.sortColumn === column ? this.sortDirection : 'none'
      node.setAttribute('aria-sort', sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none')
      node.dataset.sort = sort
      node.title = meta?.nameMore ? `${name}… · header continues in Raw` : name
      node.style.left = `${GUTTER + column * WIDTH}px`; node.style.width = `${WIDTH}px`
      node.classList.toggle('csv-selected', this.selection.kind === 'column' && this.selection.anchor.column === column)
      node.setAttribute('aria-selected', String(this.selection.kind === 'column' && this.selection.anchor.column === column))
    }
    for (const [column, node] of this.headerElements) if (!wanted.has(column)) { node.remove(); this.headerElements.delete(column) }
  }

  private requestSort(column: number, direction?: GridSort): Promise<void> {
    const queued = this.sortNavigation.then(() => this.valid() ? this.sortBy(column, direction) : undefined)
    this.sortNavigation = queued.catch(() => {})
    return queued
  }

  private async sortBy(column: number, requestedDirection?: GridSort): Promise<void> {
    this.closeContextMenu(false)
    if (!this.info.done) { this.message('Wait for CSV indexing before sorting'); return }
    if (!this.opened.view || !this.valid()) { this.message('Sorting is unavailable for this view'); return }
    this.cancelCopy()
    this.cancelInspector()
    const query = this.findQuery
    if (query.text) this.closeFind()
    this.sortAbort?.abort()
    const controller = new AbortController()
    this.sortAbort = controller
    const ref = this.info.ref
    const previousOrder = this.order
    const previousActive = { ...this.active }
    const direction = requestedDirection ?? nextGridSort(this.sortColumn === column ? this.sortDirection : 'none')
    this.message('Sorting CSV…')
    try {
      let sourceRecord = this.rows.get(previousActive.row)?.sourceRecord
      if (sourceRecord === undefined) {
        if (!previousOrder) throw new Error('The current Grid row is unavailable')
        const rowPage = await this.page(ref, previousActive.row, 1, 0, 1, controller.signal, previousOrder)
        if (!this.valid(ref) || controller.signal.aborted || this.sortAbort !== controller) return
        sourceRecord = rowPage.rows.find(row => row.dataRow === previousActive.row)?.sourceRecord
        if (sourceRecord === undefined) throw new Error('The current Grid row is unavailable')
      }
      const result = await this.core.call('csvSort', { view: this.opened.view, ref, interactionId: this.interactionId, column, direction }, controller.signal)
      if (!this.valid(ref) || controller.signal.aborted || this.sortAbort !== controller || !sameRef(result.order.csv, ref)) return
      // Publish the successfully created order before the optional anchor lookup. If another sort aborts
      // that lookup, this newest native order remains the renderer's valid read token.
      this.order = result.order
      this.sortColumn = direction === 'none' ? -1 : column
      this.sortDirection = direction
      this.clearRows()
      this.state.setTotal(this.rowCount * ROW)
      this.active = { row: Math.max(0, Math.min(previousActive.row, this.rowCount - 1)), column: Math.min(previousActive.column, this.columnCount - 1) }
      this.selection = selectCell(this.active, this.rowCount, this.columnCount)
      this.apply(this.state.moveTo(this.active.row * ROW))
      this.paintHeaders()
      let row = direction === 'none' ? sourceRecord - (this.info.header ? 1 : 0) : previousActive.row
      if (result.order.id !== 0) {
        const located = await this.core.call('csvOrderLocate', { order: result.order, sourceRecord }, controller.signal)
        if (!this.valid(ref) || controller.signal.aborted || this.sortAbort !== controller) return
        row = located.dataRow
      }
      this.active = { row: Math.max(0, Math.min(row, this.rowCount - 1)), column: Math.min(this.active.column, this.columnCount - 1) }
      this.selection = selectCell(this.active, this.rowCount, this.columnCount)
      this.apply(this.state.moveTo(this.active.row * ROW))
      this.paintHeaders()
      this.message(this.info.done ? this.rowCount ? 'Grid preview · Find and copy are ready' : 'No data records' : 'Indexing CSV…')
      if (query.text) this.searchFind(query)
    } catch (error) {
      if (controller.signal.aborted || error instanceof CoreCallError && error.code === 'Cancelled') return
      this.failed(error)
      if (query.text) this.searchFind(query)
    } finally {
      if (this.sortAbort === controller) this.sortAbort = undefined
    }
  }

  private clearRows(): void {
    for (const node of this.rowElements.values()) node.remove()
    this.cells.clear(); this.rows.clear(); this.mounted.clear(); this.rowElements.clear()
  }

  private page(ref: CsvRef, rowStart: number, rowCount: number, columnStart: number, columnCount: number, signal: AbortSignal, order = this.order) {
    return order && order.id !== 0
      ? this.core.call('csvOrderedPage', { order, rowStart, rowCount, columnStart, columnCount }, signal)
      : this.core.call('csvPage', { ref, rowStart, rowCount, columnStart, columnCount }, signal)
  }

  private paintCell(row: number, column: number): void {
    const key = cellKey(row, column), value = this.cells.get(key), meta = this.rows.get(row)
    let parent = this.rowElements.get(row)
    if (!parent) {
      parent = make('div', 'csv-row'); parent.setAttribute('role', 'row'); parent.setAttribute('aria-rowindex', String(row + 2))
      parent.dataset.row = String(row)
      const gutter = make('div', 'csv-gutter'); gutter.setAttribute('role', 'rowheader'); gutter.setAttribute('aria-colindex', '1')
      parent.append(gutter); this.layer.append(parent); this.rowElements.set(row, parent)
    }
    const bounds = selectionBounds(this.selection, this.rowCount, this.columnCount)
    const rowSelected = this.selection.kind === 'row' && row >= bounds.firstRow && row < bounds.lastRow
    parent.classList.toggle('csv-selected-row', rowSelected)
    parent.setAttribute('aria-selected', String(rowSelected))
    const number = parent.firstElementChild as HTMLDivElement
    number.textContent = String((meta?.sourceRecord ?? row + (this.info.header ? 1 : 0)) - (this.info.header ? 1 : 0) + 1)
    number.title = meta ? `Source record ${meta.sourceRecord + 1} · physical line ${meta.sourceLine + 1}` : 'Indexing…'
    let node = this.mounted.get(key)
    if (!node) {
      node = make('div', 'csv-cell'); node.setAttribute('role', 'gridcell'); node.setAttribute('aria-colindex', String(column + 2))
      node.style.left = `${GUTTER + column * WIDTH}px`; node.style.width = `${WIDTH}px`
      node.addEventListener('focus', () => { this.active = { row, column }; this.focusWanted = false; this.layout() })
      node.addEventListener('click', event => {
        if (event.detail !== 0) return // pointer selection is handled once at pointerdown, before the drag range
        this.setSelection(event.shiftKey ? extendSelection(this.selection, { row, column }, this.rowCount, this.columnCount) : selectCell({ row, column }, this.rowCount, this.columnCount), { row, column })
      })
      node.addEventListener('dblclick', () => { const item = this.cells.get(key); if (item?.kind === 'value' && item.partial) void this.inspect(row, column) })
      parent.append(node); this.mounted.set(key, node)
    }
    node.tabIndex = row === this.active.row && column === this.active.column ? 0 : -1
    node.dataset.row = String(row); node.dataset.column = String(column)
    const selected = row >= bounds.firstRow && row < bounds.lastRow && column >= bounds.firstColumn && column < bounds.lastColumn
    const currentFind = this.findCell?.row === row && this.findCell.column === column
    node.classList.toggle('csv-selected', selected)
    node.classList.toggle('csv-find-current', !!currentFind)
    node.setAttribute('aria-selected', String(selected))
    node.setAttribute('aria-current', currentFind ? 'true' : 'false')
    if (currentFind) node.dataset.findCurrent = 'true'
    else delete node.dataset.findCurrent
    node.classList.toggle('csv-missing', value?.kind === 'missing')
    node.classList.toggle('csv-extra', !!meta && column >= this.info.expectedColumns)
    const text = !value ? '…' : value.kind === 'missing' ? '' : value.text
    node.textContent = text.slice(0, TEXT_UNITS)
    const partial = value?.kind === 'value' && value.partial
    node.title = value?.kind === 'missing' ? 'Missing cell' : partial ? `${text.slice(0, TEXT_UNITS)}… · more text; press Enter to inspect` : text
    node.setAttribute('aria-label', value?.kind === 'missing' ? 'Missing cell' : partial ? `${text.slice(0, TEXT_UNITS)} · more text available` : text || 'Empty cell')
    if (this.focusWanted && node.tabIndex === 0 && value) { this.focusWanted = false; node.focus({ preventScroll: true }) }
  }

  private missing(): { row: number; column: number } | undefined {
    return nextGridCell(this.range, (row, column) => this.cells.has(cellKey(row, column)), this.active, this.rowCount, this.columnCount)
  }

  private setSelection(selection: GridSelection, active: { row: number; column: number }): void {
    this.cancelCopy()
    this.cancelInspector()
    this.closeContextMenu(false)
    this.selection = selection
    this.active = { row: Math.max(0, Math.min(active.row, this.rowCount - 1)), column: Math.max(0, Math.min(active.column, this.columnCount - 1)) }
    this.focusWanted = true
    this.paintHeaders()
    this.layout()
  }

  private cancelCopy(): void {
    this.copyJob?.cancel()
    this.copyJob = undefined
    const dialog = this.copyDialog
    if (dialog) {
      this.copyDialog = undefined
      dialog.dispatchEvent(new Event('grid-copy-cancel'))
      dialog.remove()
    }
  }

  private cancelInspector(): void {
    this.inspectAbort?.abort()
    this.inspectAbort = undefined
    this.inspecting = false
    this.inspector?.remove()
    this.inspector = null
  }

  private confirmCopy(bytes: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const dialog = make('div', 'csv-copy-confirm')
      const title = make('div', 'csv-copy-confirm-title'), text = make('p', 'csv-copy-confirm-text')
      const copy = make('button', 'csv-copy-confirm-copy'), cancel = make('button', 'csv-copy-confirm-cancel')
      title.id = `csv-copy-confirm-title-${this.opened.doc}`
      text.id = `csv-copy-confirm-text-${this.opened.doc}`
      dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', 'Confirm large copy')
      dialog.setAttribute('aria-labelledby', title.id); dialog.setAttribute('aria-describedby', text.id)
      title.textContent = 'Confirm large copy'
      text.textContent = `Copy ${bytes.toLocaleString('en-US')} bytes (${(bytes / (1 << 20)).toFixed(1)} MiB) to clipboard?`
      copy.textContent = 'Copy'; cancel.textContent = 'Cancel'
      let settled = false
      const previous = document.activeElement
      const finish = (accepted: boolean) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', aborted)
        dialog.remove()
        if (this.copyDialog === dialog) this.copyDialog = undefined
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
        else if (this.element.isConnected) this.focus()
        resolve(accepted)
      }
      const aborted = () => finish(false)
      dialog.addEventListener('grid-copy-cancel', aborted, { once: true })
      dialog.addEventListener('keydown', event => {
        if (event.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) }
        else if (event.key === 'Tab') {
          const controls = [copy, cancel]
          const current = controls.indexOf(document.activeElement as HTMLButtonElement)
          const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
          controls[next].focus(); event.preventDefault(); event.stopPropagation()
        } else event.stopPropagation()
      })
      copy.addEventListener('click', () => finish(true))
      cancel.addEventListener('click', () => finish(false))
      dialog.append(title, text, copy, cancel)
      this.host.append(dialog)
      this.copyDialog = dialog
      signal.addEventListener('abort', aborted, { once: true })
      copy.focus()
    })
  }

  private async copySelection(): Promise<boolean> {
    if (this.copyPending) { this.cancelCopy(); this.message('Cancelling the previous copy…'); return false }
    const token = window.typose.beginClipboardWrite()
    if (!token) { this.message('Copy unavailable · use a trusted Copy action in the Grid'); return false }
    if (!this.info.done) { window.typose.cancelClipboardWrite(token); this.message('Copy unavailable · wait for CSV indexing to finish'); return false }
    if (!this.options.budget || !this.order) { window.typose.cancelClipboardWrite(token); this.message('Copy unavailable · the Grid budget or order is missing'); return false }
    this.cancelCopy()
    const selection = { ...this.selection, anchor: { ...this.selection.anchor }, focus: { ...this.selection.focus } } as GridSelection
    const ref = this.info.ref, order = this.order, generation = this.opened.gen
    const rows = this.rowCount, columns = this.columnCount
    const current = () => this.valid(ref) && this.order?.id === order.id && this.sameSelection(this.selection, selection)
    this.copyPending = true
    this.message('Preparing copy…', true)
    this.copySourceRange = { first: 0, last: 0, order, records: new Map() }
    const job = new GridCopyJob({
      valid: current,
      reserve: async (bytes, signal) => {
        if (!current() || signal.aborted) return false
        const granted = await this.options.budget!.reserveCopy(generation, bytes)
        if (!granted || !current() || signal.aborted) return false
        return true
      },
      confirm: (bytes, signal) => this.confirmCopy(bytes, signal),
      write: text => window.typose.writeClipboardText(text, token),
      cancelWrite: () => window.typose.cancelClipboardWrite(token),
      sourceRecord: async (displayRow, signal) => {
        if (!current() || signal.aborted) throw new Error('Copy cancelled')
        if (this.copySourceRange && displayRow >= this.copySourceRange.first && displayRow < this.copySourceRange.last) {
          const known = this.copySourceRange.records.get(displayRow)
          if (known !== undefined) return known
        }
        const first = displayRow, last = Math.min(rows, first + 128)
        const page = await this.page(ref, first, last - first, 0, 1, signal, order)
        if (!current() || signal.aborted || !sameRef(page.ref, ref) || this.order?.id !== order.id) throw new Error('Copy cancelled')
        let records = new Map(page.rows.map(row => [row.dataRow, row.sourceRecord]))
        let sourceRecord = records.get(displayRow)
        if (sourceRecord === undefined && last - first > 1) {
          // Native Grid pages can stop early when a returned cell reaches the bounded wire/unit cap.
          // Retry just the requested display row instead of assuming the requested extent was complete.
          const exact = await this.page(ref, displayRow, 1, 0, 1, signal, order)
          if (!current() || signal.aborted || !sameRef(exact.ref, ref) || this.order?.id !== order.id) throw new Error('Copy cancelled')
          records = new Map(exact.rows.map(row => [row.dataRow, row.sourceRecord]))
          sourceRecord = records.get(displayRow)
          this.copySourceRange = { first: displayRow, last: displayRow + 1, order, records }
        } else if (page.rows.length) {
          const firstReturned = Math.min(...records.keys())
          const lastReturned = Math.max(...records.keys()) + 1
          this.copySourceRange = { first: firstReturned, last: lastReturned, order, records }
        }
        if (sourceRecord === undefined) throw new Error('CSV row is unavailable for copy')
        return sourceRecord
      },
      cellChunks: (sourceRecord, column, signal) => this.copyCellChunks(ref, sourceRecord, column, signal, current)
    }, rows, columns, this.info.header)
    this.copyJob = job
    let result
    try { result = await job.run(selection) }
    finally {
      await this.options.budget.reserveCopy(generation, 0)
      this.copyPending = false
      this.copySourceRange = undefined
    }
    if (this.copyJob !== job) return false
    this.copyJob = undefined
    if (result.kind === 'copied') this.message(`Copied ${result.bytes.toLocaleString('en-US')} bytes`, true)
    else if (result.kind === 'refused' || result.kind === 'failed') this.message(result.reason, true)
    return result.kind === 'copied'
  }

  private async *copyCellChunks(ref: CsvRef, sourceRecord: number, column: number, signal: AbortSignal, current: () => boolean): AsyncGenerator<string> {
    if (!current() || signal.aborted) throw new Error('Copy cancelled')
    const cell = await this.core.call('csvCell', { ref, sourceRecord, column }, signal)
    if (!current() || signal.aborted) throw new Error('Copy cancelled')
    if (cell.kind === 'missing') { yield ''; return }
    yield cell.text
    let continuation = cell.next
    while (continuation) {
      const next = await this.core.call('csvPiece', { continuation }, signal)
      if (!current() || signal.aborted) throw new Error('Copy cancelled')
      yield next.text
      continuation = next.next
    }
  }

  private sameSelection(a: GridSelection, b: GridSelection): boolean {
    return a.kind === b.kind && a.anchor.row === b.anchor.row && a.anchor.column === b.anchor.column && a.focus.row === b.focus.row && a.focus.column === b.focus.column
  }

  private searchFind(query: FindQuery): void {
    this.closeFind()
    if (!query.text || !this.options.budget || !this.opened.view || !this.order || !this.valid()) return
    this.findQuery = { text: query.text.slice(0, 512), matchCase: query.matchCase }
    if (!this.info.done) {
      this.pendingFind = true
      this.findSignal.publish({ count: 0, complete: false, current: null, busy: true, message: 'Searching after CSV indexing…' })
      return
    }
    const epoch = ++this.findEpoch
    const controller = new AbortController()
    this.findAbort = controller
    const current = () => this.findEpoch === epoch && this.findAbort === controller && !controller.signal.aborted && this.valid()
    this.findSignal.publish({ count: 0, complete: false, current: null, busy: true })
    void this.options.budget.reserveSearch(this.opened.gen, FIND_BYTES).then(granted => {
      if (!current()) return
      if (!granted) { this.findSignal.publish({ ...EMPTY_FIND, message: 'Find unavailable · memory budget is full' }); return }
      const ref = this.info.ref, order = this.order!
      void this.core.call('csvFindStart', { view: this.opened.view!, order, query: this.findQuery.text, matchCase: this.findQuery.matchCase }).then(info => {
        if (!current() || !sameRef(info.ref.order.csv, ref) || info.ref.order.id !== order.id) {
          void this.core.call('csvFindClose', { ref: info.ref }).catch(() => {})
          return
        }
        this.findRef = info.ref
        this.findSignal.publish({ count: info.count, complete: info.complete, current: null, busy: !info.complete })
        void this.scanFind(epoch, info.ref, controller)
      }).catch(error => {
        if (!current() || error instanceof CoreCallError && error.code === 'Cancelled') return
        this.findSignal.publish({ ...EMPTY_FIND, message: error instanceof Error ? error.message : String(error) })
      })
    }).catch(error => {
      if (current()) this.findSignal.publish({ ...EMPTY_FIND, message: error instanceof Error ? error.message : String(error) })
    })
  }

  private async scanFind(epoch: number, ref: CsvFindRef, controller: AbortController): Promise<void> {
    const current = () => this.findEpoch === epoch && this.findAbort === controller && !controller.signal.aborted && this.valid(ref.order.csv) && this.order?.id === ref.order.id
    try {
      let info = this.findSignal.snapshot()
      while (current() && !info.complete) {
        const page = await this.core.call('csvFindScan', { ref }, controller.signal)
        if (!current() || page.ref.id !== ref.id || page.ref.order.id !== ref.order.id) return
        const first = Math.max(1, page.count - page.hits.length + 1)
        page.hits.forEach((hit, index) => this.findHits.set(first + index, hit))
        while (this.findHits.size > 128) this.findHits.delete(this.findHits.keys().next().value!)
        info = { count: page.count, complete: page.complete, current: this.findSignal.snapshot().current, busy: !page.complete }
        this.findSignal.publish(info)
        if (!this.findHit && page.hits.length) await this.queueFindSeek(1, epoch, ref, controller)
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (current()) this.findSignal.publish({ ...this.findSignal.snapshot(), complete: true, busy: false })
    } catch (error) {
      if (!current() || error instanceof CoreCallError && error.code === 'Cancelled') return
      this.findSignal.publish({ ...this.findSignal.snapshot(), busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async nextFind(direction: 1 | -1): Promise<void> {
    if (!this.findRef || !this.findAbort || !this.findQuery.text) return
    await this.queueFindSeek(direction, this.findEpoch, this.findRef, this.findAbort)
  }

  private queueFindSeek(direction: 1 | -1, epoch: number, ref: CsvFindRef, controller: AbortController): Promise<void> {
    const queued = this.findNavigation.then(() => {
      if (this.findEpoch !== epoch || this.findRef !== ref || this.findAbort !== controller || controller.signal.aborted) return
      return this.seekFind(direction, epoch, ref, controller)
    })
    this.findNavigation = queued.catch(() => {})
    return queued
  }

  private async seekFind(direction: 1 | -1, epoch: number, ref: CsvFindRef, controller: AbortController): Promise<void> {
    const current = () => this.findEpoch === epoch && this.findAbort === controller && !controller.signal.aborted && this.valid(ref.order.csv) && this.order?.id === ref.order.id
    if (!current()) return
    try {
      const from = this.findHit
      const result = await this.core.call('csvFindSeek', { ref, ...(from ? { from } : {}), direction: direction > 0 ? 'next' : 'previous' }, controller.signal)
      if (!current()) return
      this.findHit = result.hit
      this.findCell = result.hit ? { row: result.hit.dataRow, column: result.hit.column } : undefined
      this.paintFindExcerpt(result.hit)
      if (result.hit) {
        this.cancelCopy()
        this.element.scrollTop = this.state.moveTo(result.hit.dataRow * ROW)
        const left = GUTTER + result.hit.column * WIDTH
        if (left < this.element.scrollLeft + GUTTER || left + WIDTH > this.element.scrollLeft + this.element.clientWidth)
          this.element.scrollLeft = Math.max(0, left - GUTTER)
        this.layout()
      }
      const state = this.findSignal.snapshot()
      this.findSignal.publish({ ...state, count: Math.max(state.count, result.ordinal ?? 0), current: result.ordinal ?? null })
    } catch (error) {
      if (!current() || error instanceof CoreCallError && error.code === 'Cancelled') return
      this.findSignal.publish({ ...this.findSignal.snapshot(), busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private closeFind(): void {
    this.findEpoch++
    this.pendingFind = false
    const controller = this.findAbort
    const ref = this.findRef
    this.findAbort = undefined
    this.findRef = undefined
    this.findQuery = { text: '', matchCase: false }
    this.findHit = undefined
    this.findCell = undefined
    this.paintFindExcerpt(undefined)
    this.findHits.clear()
    controller?.abort()
    if (ref) void this.core.call('csvFindClose', { ref }).catch(() => {})
    this.findSignal.publish(EMPTY_FIND)
    void this.options.budget?.reserveSearch(this.opened.gen, 0)
    this.layout()
  }

  private paintFindExcerpt(hit: CsvFindHit | undefined): void {
    this.findExcerpt.replaceChildren()
    if (!hit?.text) return
    const start = Math.max(0, Math.min(hit.matchStart ?? 0, hit.text.length))
    const end = Math.max(start, Math.min(hit.matchEnd ?? start, hit.text.length))
    this.findExcerpt.append(document.createTextNode(hit.text.slice(0, start)))
    if (end > start) {
      const match = make('mark', 'csv-find-match')
      match.textContent = hit.text.slice(start, end)
      this.findExcerpt.append(match)
    }
    this.findExcerpt.append(document.createTextNode(hit.text.slice(end)))
  }

  private openContextMenu(target: EventTarget | null, clientX: number, clientY: number): void {
    if (this.disposed || !this.valid()) return
    const element = target instanceof Element ? target : this.lastGridFocus
    const header = element?.closest<HTMLElement>('.csv-heading[data-column]')
    const cell = this.cellAt(element ?? null)
    const rowElement = element?.closest<HTMLElement>('.csv-row[data-row]')
    const row = cell?.row ?? (rowElement ? Number(rowElement.dataset.row) : this.active.row)
    const column = header ? Number(header.dataset.column) : cell?.column ?? this.active.column
    this.closeContextMenu(false)
    const menu = make('div', 'csv-context-menu')
    menu.id = `csv-grid-menu-${this.opened.view?.id ?? this.opened.doc}`
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Grid actions')
    const add = (label: string, action: () => void, clipboardCopy = false) => {
      const item = make('button', 'csv-context-menu-item')
      item.type = 'button'; item.textContent = label; item.setAttribute('role', 'menuitem')
      if (clipboardCopy) item.dataset.clipboardCopy = 'true'
      item.addEventListener('click', () => { this.closeContextMenu(true); action() })
      menu.append(item)
    }
    add('Select row', () => this.setSelection({ kind: 'row', anchor: { row, column: 0 }, focus: { row, column: this.columnCount - 1 } }, { row, column: 0 }))
    add('Select column', () => this.setSelection({ kind: 'column', anchor: { row: 0, column }, focus: { row: this.rowCount - 1, column } }, { row, column }))
    add('Copy selection', () => { void this.copySelection() }, true)
    add(`Sort ${header ? 'this column' : 'column'} ascending`, () => { void this.requestSort(column, 'asc') })
    add(`Sort ${header ? 'this column' : 'column'} descending`, () => { void this.requestSort(column, 'desc') })
    add('Clear sort', () => { void this.requestSort(column, 'none') })
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeContextMenu(true); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[(current + delta + items.length) % items.length]?.focus()
      event.preventDefault()
    })
    const bounds = this.host.getBoundingClientRect()
    const left = Math.max(0, Math.min(clientX - bounds.left, this.host.clientWidth - 240))
    const top = Math.max(0, Math.min(clientY - bounds.top, this.host.clientHeight - 220))
    menu.style.left = `${left}px`; menu.style.top = `${top}px`
    this.contextTrigger = element instanceof HTMLElement ? element : this.lastGridFocus
    this.contextMenu = menu
    this.actionsButton.setAttribute('aria-expanded', 'true')
    this.actionsButton.setAttribute('aria-controls', menu.id)
    this.host.append(menu)
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }

  private closeContextMenu(restoreFocus: boolean): void {
    const menu = this.contextMenu
    if (!menu) return
    menu.remove()
    this.contextMenu = undefined
    this.actionsButton.setAttribute('aria-expanded', 'false')
    this.actionsButton.removeAttribute('aria-controls')
    const trigger = this.contextTrigger
    this.contextTrigger = undefined
    if (restoreFocus && trigger?.isConnected) trigger.focus()
  }

  private cellAt(target: EventTarget | null): { row: number; column: number } | undefined {
    if (!(target instanceof Element)) return undefined
    const cell = target.closest<HTMLElement>('.csv-cell[data-row][data-column]')
    return cell ? { row: Number(cell.dataset.row), column: Number(cell.dataset.column) } : undefined
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    if (!(event.target instanceof Element)) return
    const header = event.target.closest<HTMLElement>('.csv-heading[data-column]')
    if (header) return
    const at = this.cellAt(event.target)
    if (at) {
      this.setSelection(event.shiftKey ? { kind: 'range', anchor: this.selection.anchor, focus: at } : selectCell(at, this.rowCount, this.columnCount), at)
      this.dragging = true
      return
    }
    const rowHeader = event.target.closest<HTMLElement>('.csv-row [role="rowheader"]')
    const rowElement = rowHeader?.closest<HTMLElement>('.csv-row')
    if (rowElement) {
      const row = Number(rowElement.dataset.row)
      this.setSelection({ kind: 'row', anchor: { row, column: 0 }, focus: { row, column: this.columnCount - 1 } }, { row, column: 0 })
      this.element.focus({ preventScroll: true })
    }
  }

  private pointerOver(event: PointerEvent): void {
    if (!this.dragging) return
    if ((event.buttons & 1) === 0) { this.dragging = false; return }
    const at = this.cellAt(event.target)
    if (!at || this.selection.focus.row === at.row && this.selection.focus.column === at.column) return
    const selection = extendSelection(this.selection, at, this.rowCount, this.columnCount)
    this.setSelection(selection, at)
  }

  private request(): void {
    if (!this.paid || !this.valid()) return
    this.wake = true
    if (!this.pumping) void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    clearTimeout(this.timer)
    const ref = this.info.ref
    let retryPage = false
    let pageProblem = false
    try {
      while (this.wake && this.valid(ref)) {
        this.wake = false
        const fresh = await this.core.call('csvConfigure', { surface: this.opened.view ? { session: this.opened.view.session, id: this.opened.view.surface } : undefined,
          doc: ref.doc, gen: ref.gen, options: this.options.options }, this.abort.signal)
        if (!this.valid(ref) || !sameRef(fresh.ref, ref)) return
        this.info = fresh; this.options.onInfo(fresh)
        if (fresh.status === 'locked') { this.message(fresh.reason || 'Grid is unavailable · open in Raw'); return }
        if (this.atRow !== undefined && (this.rowCount > this.atRow || fresh.done)) this.placeAtRow()
        if (fresh.done && this.pendingFind) {
          const query = this.findQuery
          this.pendingFind = false
          this.searchFind(query)
        }
        this.layout(false)
        if (this.atLine !== undefined) {
          const place = await this.core.call('csvLocate', { ref, rawLine: this.atLine }, this.abort.signal)
          if (!this.valid(ref)) return
          if (place.kind === 'located') { this.active.row = place.dataRow; this.shownLine = place.sourceLine; this.atLine = undefined; this.apply(this.state.moveTo(place.dataRow * ROW)) }
        }
        this.layout(false)
        const start = this.range.firstColumn, count = Math.min(128, this.range.lastColumn - start)
        if (count > 0 && (!fresh.metadataDone || !this.columns.has(start))) {
          const metadata = await this.core.call('csvColumns', { ref, start, count }, this.abort.signal)
          if (!this.valid(ref) || !sameRef(metadata.ref, ref)) return
          for (const key of this.columns.keys()) if (key < start || key >= start + count) this.columns.delete(key)
          for (const column of metadata.columns) this.columns.set(column.column, { ...column, name: preview(column.name), pills: undefined })
          this.paintHeaders()
        }
        let missing = this.missing()
        while (missing && this.valid(ref)) {
          const columnCount = Math.max(1, Math.min(128, this.range.lastColumn - missing.column || 1))
          const rowCount = Math.max(1, Math.min(this.range.lastRow - missing.row || 1, Math.floor(MAX_CELLS / columnCount)))
          const order = this.order
          const page = await this.page(ref, missing.row, rowCount, missing.column, columnCount, this.abort.signal, order)
          if (!this.valid(ref) || !sameRef(page.ref, ref) || order?.id !== this.order?.id) return
          let added = 0
          for (const row of page.rows) added += this.acceptRow(row)
          this.layout(false)
          if (!added) {
            retryPage = page.indexing
            if (!page.indexing) { pageProblem = true; this.message('The CSV page could not make progress · open in Raw') }
            break
          }
          missing = this.missing()
        }
        if (!pageProblem) this.message(this.info.done ? this.rowCount ? 'Grid preview · Find, sort and range copy are ready' : 'No data records' : 'Indexing CSV…')
      }
    } catch (error) { this.failed(error) }
    finally {
      this.pumping = false
      if (this.valid(ref) && !pageProblem && (!this.info.done || !this.info.metadataDone || retryPage)) this.timer = setTimeout(() => this.request(), 200)
    }
  }

  private acceptRow(row: CsvRow): number {
    let added = 0
    for (const cell of row.cells) if (this.wanted(row.dataRow, cell.column)) {
      const key = cellKey(row.dataRow, cell.column)
      if (!this.cells.has(key) && this.cells.size >= MAX_CELLS) continue
      if (!this.cells.has(key)) added++
      // Keep only bounded previews/locators, never the page maps or giant text backing strings.
      this.cells.set(key, gridCellPreview(cell))
    }
    if (added) this.rows.set(row.dataRow, { sourceLine: row.sourceLine, sourceRecord: row.sourceRecord, fieldCount: row.fieldCount })
    return added
  }

  private key(event: KeyboardEvent): void {
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement || event.isComposing) return
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu' || event.code === 'ContextMenu') {
      event.preventDefault()
      this.openContextMenu(event.target, this.element.getBoundingClientRect().left + 16, this.element.getBoundingClientRect().top + 32)
      return
    }
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 'c') {
      event.preventDefault(); void this.copySelection(); return
    }
    if (event.shiftKey && event.code === 'Space') {
      event.preventDefault()
      const selection = { kind: 'row' as const, anchor: { row: this.active.row, column: 0 }, focus: { row: this.active.row, column: this.columnCount - 1 } }
      this.setSelection(selection, { row: this.active.row, column: 0 })
      return
    }
    if (event.ctrlKey && event.code === 'Space') {
      event.preventDefault()
      const selection = { kind: 'column' as const, anchor: { row: 0, column: this.active.column }, focus: { row: this.rowCount - 1, column: this.active.column } }
      this.setSelection(selection, { row: this.active.row, column: this.active.column })
      return
    }
    if (event.key === 'Enter') {
      const cell = this.cells.get(cellKey(this.active.row, this.active.column))
      if (cell?.kind === 'value') { event.preventDefault(); void this.inspect(this.active.row, this.active.column) }
      return
    }
    let { row, column } = this.active
    switch (event.key) {
      case 'ArrowUp': row--; break
      case 'ArrowDown': row++; break
      case 'ArrowLeft': column--; break
      case 'ArrowRight': column++; break
      case 'PageUp': row -= Math.max(1, Math.floor(this.state.geometry.viewport / ROW)); break
      case 'PageDown': row += Math.max(1, Math.floor(this.state.geometry.viewport / ROW)); break
      case 'Home': column = 0; if (command) row = 0; break
      case 'End': column = this.columnCount - 1; if (command) row = this.rowCount - 1; break
      default: return
    }
    event.preventDefault(); this.moved = true; this.atLine = undefined
    row = Math.max(0, Math.min(row, this.rowCount - 1)); column = Math.max(0, Math.min(column, this.columnCount - 1))
    this.active = { row, column }
    this.selection = event.shiftKey ? extendSelection(this.selection, this.active, this.rowCount, this.columnCount) : selectCell(this.active, this.rowCount, this.columnCount)
    this.cancelCopy()
    this.focusWanted = true
    const top = row * ROW, bottom = top + ROW
    if (top < this.state.top) this.apply(this.state.moveTo(top))
    else if (bottom > this.state.top + this.state.geometry.viewport) this.apply(this.state.moveTo(bottom - this.state.geometry.viewport))
    const left = GUTTER + column * WIDTH, right = left + WIDTH
    if (left < this.element.scrollLeft + GUTTER) this.element.scrollLeft = left - GUTTER
    else if (right > this.element.scrollLeft + this.element.clientWidth) this.element.scrollLeft = right - this.element.clientWidth
    this.layout()
  }

  private async inspect(row: number, column: number): Promise<void> {
    const ref = this.info.ref
    if (this.inspecting) return
    const order = this.order
    if (!order) return
    this.cancelInspector()
    const controller = new AbortController()
    this.inspectAbort = controller
    this.inspecting = true
    this.inspectorPeak = true
    let first: CsvCellPiece | undefined
    let sourceLine: number | undefined
    try {
      await this.size()
      if (!this.valid(ref) || this.reserved < this.gridBytes() || this.order?.id !== order.id || controller.signal.aborted) return
      const page = await this.page(ref, row, 1, 0, 1, controller.signal, order)
      if (!this.valid(ref) || controller.signal.aborted || this.order?.id !== order.id || !sameRef(page.ref, ref)) return
      const source = page.rows.find(item => item.dataRow === row)
      if (!source) return
      sourceLine = source.sourceLine
      const cell = await this.core.call('csvCell', { ref, sourceRecord: source.sourceRecord, column }, controller.signal)
      if (!this.valid(ref) || controller.signal.aborted || this.order?.id !== order.id) return
      if (cell.kind === 'value') first = cell
    } catch (error) { this.failed(error); return }
    finally { if (this.inspectAbort === controller) this.inspecting = false }
    if (!first || !this.valid(ref)) return
    this.inspector?.remove()
    const panel = make('div', 'csv-value-inspector'), text = make('pre', 'csv-value-text'), label = make('div', 'csv-value-label')
    const more = make('button', 'csv-value-more'), close = make('button', 'csv-value-close'), raw = make('button', 'csv-value-raw')
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Cell value')
    more.textContent = 'Next piece'; close.textContent = 'Close value'; raw.textContent = 'Show in Raw'
    let current = first
    const paint = () => { text.textContent = current.text; label.textContent = `Source bytes ${current.pieceSpan.start}–${current.pieceSpan.end}${current.next ? ' · value continues' : ''}`; more.disabled = !current.next }
    more.addEventListener('click', async () => {
      if (!current.next || !this.valid(ref) || this.inspecting || controller.signal.aborted || this.order?.id !== order.id) return
      this.inspecting = true
      more.disabled = true
      try { const next = await this.core.call('csvPiece', { continuation: current.next }, controller.signal); if (this.valid(ref) && this.order?.id === order.id && panel.isConnected) { current = next; paint() } }
      catch (error) { this.failed(error); if (panel.isConnected) more.disabled = false }
      finally { this.inspecting = false }
    })
    const dismiss = () => {
      controller.abort()
      if (this.inspectAbort === controller) this.inspectAbort = undefined
      panel.remove()
      if (this.inspector === panel) this.inspector = null
      this.focus()
    }
    close.addEventListener('click', dismiss)
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss() } })
    raw.addEventListener('click', () => this.options.onShowRaw(sourceLine ?? this.topLine()))
    panel.append(label, text, more, raw, close); this.host.append(panel); this.inspector = panel; paint(); close.focus()
  }

  private failed(error: unknown): void {
    if (this.disposed || error instanceof CoreCallError && error.code === 'Cancelled') return
    if (error instanceof CoreCallError && (error.code === 'Frozen' || error.code === 'CoreGone')) { this.freeze(); this.options.onFrozen(error.message) }
    this.message(error instanceof Error ? error.message : String(error))
  }
}
