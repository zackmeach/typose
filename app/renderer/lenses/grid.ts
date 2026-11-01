import type { CsvCellPiece, CsvColumn, CsvInfo, CsvOptions, CsvRef, CsvRow, Limits, Opened } from '../../shared/protocol'
import { type CoreClient, CoreCallError } from '../core'
import { ScrollState, isLogical, spacerHeight, visibleRows, wheelPixels } from '../virtual/scrollmath'
import type { LensBudget } from './lens-budget'
import { viewportCap } from './page-cache'
import { GRID_TEXT_UNITS as TEXT_UNITS, MAX_GRID_CELLS as MAX_CELLS, gridCellPreview, gridTextPreview as preview, nextGridCell, type GridCellPreview, type GridRange } from './grid-cache'

const ROW = 28
const HEADER = 28
const GUTTER = 52
const WIDTH = 160
// Bounded summaries/row metadata/column names plus two decoded maximum-size pending replies.
const CACHE_BYTES = 4 << 20
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
  private readonly spacer = make('div', 'csv-spacer')
  private readonly layer = make('div', 'csv-layer')
  private readonly headers = make('div', 'csv-header-row')
  private readonly status = make('div', 'csv-status')
  private readonly state = new ScrollState({ total: 0, viewport: 0 })
  private readonly observer: ResizeObserver
  private readonly cells = new Map<string, GridCellPreview>()
  private readonly rows = new Map<number, CachedRow>()
  private readonly columns = new Map<number, CsvColumn>()
  private readonly mounted = new Map<string, HTMLDivElement>()
  private readonly rowElements = new Map<number, HTMLDivElement>()
  private readonly abort = new AbortController()
  private info: CsvInfo
  private range: GridRange = { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 }
  private active = { row: 0, column: 0 }
  private focusWanted = false
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
  private shownLine: number
  private inspector: HTMLDivElement | null = null
  private inspectorPeak = false
  private inspecting = false

  constructor(
    private readonly host: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    info: CsvInfo,
    private readonly limits: Limits,
    private readonly options: GridOptions
  ) {
    this.info = info
    this.reserved = 0
    this.atLine = options.atLine
    this.shownLine = options.atLine ?? 0
    this.element.setAttribute('role', 'grid')
    this.element.setAttribute('aria-label', 'CSV grid')
    this.element.setAttribute('aria-multiselectable', 'false')
    this.element.tabIndex = 0
    this.status.setAttribute('role', 'status')
    this.headers.setAttribute('role', 'row')
    this.headers.setAttribute('aria-rowindex', '1')
    this.spacer.setAttribute('aria-hidden', 'true')
    this.element.append(this.headers, this.spacer, this.layer)
    host.append(this.element, this.status)
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
    this.element.addEventListener('pointerdown', () => { this.moved = true; this.atLine = undefined }, { passive: true })
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
  setLineCount(_lines: number): void { this.request() }
  indexDone(): void { this.request() }
  freeze(): void { this.stopped = true; clearTimeout(this.timer); this.abort.abort() }
  yieldReservation(): void { this.yielded = true; clearTimeout(this.timer) }
  resumeReservation(): void { if (!this.stopped) { this.yielded = false; void this.size() } }

  dispose(release = true): void {
    this.disposed = true
    this.freeze()
    this.observer.disconnect()
    this.inspector?.remove()
    this.element.remove()
    this.status.remove()
    this.cells.clear(); this.rows.clear(); this.columns.clear(); this.mounted.clear(); this.rowElements.clear()
    if (release) {
      if (this.options.budget) void this.options.budget.reserveGrid(this.opened.gen, 0)
    }
  }

  private valid(ref = this.info.ref): boolean { return !this.disposed && !this.stopped && !this.yielded && sameRef(ref, this.info.ref) }
  private message(text: string): void { if (!this.disposed) this.status.textContent = text }
  private apply(top: number): void { this.element.scrollTop = top; this.state.confirmNative(this.element.scrollTop); this.layout() }

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
    this.headers.replaceChildren()
    const gutter = make('div', 'csv-gutter csv-heading')
    gutter.setAttribute('role', 'columnheader'); gutter.setAttribute('aria-colindex', '1'); gutter.textContent = 'Row'
    this.headers.append(gutter)
    for (let column = this.range.firstColumn; column < this.range.lastColumn; column++) {
      const node = make('div', 'csv-cell csv-heading')
      node.setAttribute('role', 'columnheader'); node.setAttribute('aria-colindex', String(column + 2))
      const meta = this.columns.get(column)
      node.textContent = meta?.name || `Column ${column + 1}`
      node.title = meta?.nameMore ? `${node.textContent}… · header continues in Raw` : node.textContent
      node.style.left = `${GUTTER + column * WIDTH}px`; node.style.width = `${WIDTH}px`
      this.headers.append(node)
    }
  }

  private paintCell(row: number, column: number): void {
    const key = cellKey(row, column), value = this.cells.get(key), meta = this.rows.get(row)
    let parent = this.rowElements.get(row)
    if (!parent) {
      parent = make('div', 'csv-row'); parent.setAttribute('role', 'row'); parent.setAttribute('aria-rowindex', String(row + 2))
      const gutter = make('div', 'csv-gutter'); gutter.setAttribute('role', 'rowheader'); gutter.setAttribute('aria-colindex', '1')
      parent.append(gutter); this.layer.append(parent); this.rowElements.set(row, parent)
    }
    const number = parent.firstElementChild as HTMLDivElement
    number.textContent = String((meta?.sourceRecord ?? row + (this.info.header ? 1 : 0)) - (this.info.header ? 1 : 0) + 1)
    number.title = meta ? `Source record ${meta.sourceRecord + 1} · physical line ${meta.sourceLine + 1}` : 'Indexing…'
    let node = this.mounted.get(key)
    if (!node) {
      node = make('div', 'csv-cell'); node.setAttribute('role', 'gridcell'); node.setAttribute('aria-colindex', String(column + 2))
      node.style.left = `${GUTTER + column * WIDTH}px`; node.style.width = `${WIDTH}px`
      node.addEventListener('focus', () => { this.active = { row, column }; this.focusWanted = false; this.layout() })
      node.addEventListener('click', () => { this.active = { row, column }; this.focusWanted = true; this.layout() })
      node.addEventListener('dblclick', () => { const item = this.cells.get(key); if (item?.kind === 'value' && item.partial) void this.inspect(row, column) })
      parent.append(node); this.mounted.set(key, node)
    }
    node.tabIndex = row === this.active.row && column === this.active.column ? 0 : -1
    node.dataset.row = String(row); node.dataset.column = String(column)
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
          const page = await this.core.call('csvPage', { ref, rowStart: missing.row, rowCount, columnStart: missing.column, columnCount }, this.abort.signal)
          if (!this.valid(ref) || !sameRef(page.ref, ref)) return
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
        if (!pageProblem) this.message(this.info.done ? this.rowCount ? 'Grid preview · Find, sort and range copy are unavailable' : 'No data records' : 'Indexing CSV…')
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
    const command = event.ctrlKey || event.metaKey
    if (command && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'c') || event.shiftKey && event.code === 'Space' || command && event.code === 'Space') {
      event.preventDefault(); this.message('Grid preview · Find, sort and range copy are unavailable'); return
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
    this.active = { row, column }; this.focusWanted = true
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
    this.inspecting = true
    this.inspectorPeak = true
    let first: CsvCellPiece | undefined
    try {
      await this.size()
      if (!this.valid(ref) || this.reserved < this.gridBytes()) return
      const page = await this.core.call('csvPage', { ref, rowStart: row, rowCount: 1, columnStart: column, columnCount: 1 }, this.abort.signal)
      const cell = page.rows[0]?.cells[0]
      if (cell?.kind === 'value') first = cell
    } catch (error) { this.failed(error); return }
    finally { this.inspecting = false }
    if (!first || !this.valid(ref)) return
    this.inspector?.remove()
    const panel = make('div', 'csv-value-inspector'), text = make('pre', 'csv-value-text'), label = make('div', 'csv-value-label')
    const more = make('button', 'csv-value-more'), close = make('button', 'csv-value-close'), raw = make('button', 'csv-value-raw')
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Cell value')
    more.textContent = 'Next piece'; close.textContent = 'Close value'; raw.textContent = 'Show in Raw'
    let current = first
    const paint = () => { text.textContent = current.text; label.textContent = `Source bytes ${current.pieceSpan.start}–${current.pieceSpan.end}${current.next ? ' · value continues' : ''}`; more.disabled = !current.next }
    more.addEventListener('click', async () => {
      if (!current.next || !this.valid() || this.inspecting) return
      this.inspecting = true
      more.disabled = true
      try { const next = await this.core.call('csvPiece', { continuation: current.next }, this.abort.signal); if (this.valid() && panel.isConnected) { current = next; paint() } }
      catch (error) { this.failed(error); if (panel.isConnected) more.disabled = false }
      finally { this.inspecting = false }
    })
    const dismiss = () => { panel.remove(); if (this.inspector === panel) this.inspector = null; this.focus() }
    close.addEventListener('click', dismiss)
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss() } })
    raw.addEventListener('click', () => { const source = this.rows.get(row); this.options.onShowRaw(source?.sourceLine ?? this.topLine()) })
    panel.append(label, text, more, raw, close); this.host.append(panel); this.inspector = panel; paint(); close.focus()
  }

  private failed(error: unknown): void {
    if (this.disposed || error instanceof CoreCallError && error.code === 'Cancelled') return
    if (error instanceof CoreCallError && (error.code === 'Frozen' || error.code === 'CoreGone')) { this.freeze(); this.options.onFrozen(error.message) }
    this.message(error instanceof Error ? error.message : String(error))
  }
}
