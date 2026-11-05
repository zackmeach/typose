import { MAX_PRINT_BYTES, MAX_PRINT_PAGES, type Opened, type SourceSpan, type StructuredNode, type StructuredRow } from '../../shared/protocol'
import { CoreCallError, type CoreClient } from '../core'
import { SourceFind } from './source-find'
import type { LensBudget } from './lens-budget'
import type { StructuredSource } from './structured-source'
import { copySourceSpan } from './source-copy'
import { SourceCopyQueue } from './source-copy-queue'
import { TranscriptView } from './transcript-view'
import type { LocalGesture } from '../reader-window'
import { printLines } from './raw'
import { PRINT_LINES_PER_PAGE, type PrintPayload, type PrintPlan } from '../print'
import { spacerHeight, toLogical, toNative } from '../virtual/scrollmath'

export type StructuredMode = 'tree' | 'rows' | 'table' | 'transcript'
/** Rows (Z79): fixed 32 px lines, plus each expanded line's measured detail. Mounted: the viewport and OVERSCAN each way.
 *  Cached: at most CACHE lines' records near the viewport, and at most EXPANDED open details, so memory stays bounded. */
const ROW = 32, OVERSCAN = 20, CACHE = 512, EXPANDED = 16
/** Z80: one stable tint per type, from the CSV pills' six; severities keep their colour. */
const SEVERITY: Record<string, string> = { error: '4', fatal: '4', warn: '3', warning: '3' }
const tint = (type: string): string => {
  let hash = 0
  for (const char of type) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return SEVERITY[type.toLowerCase()] ?? String(hash % 6)
}
/** Z80: HH:MM:SS.mmm, as written, from an ISO-8601 or time-of-day value; anything else unchanged. */
const clock = (value = ''): string => {
  const time = /^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value)
  return time ? `${time[1]}:${time[2]}:${time[3]}.${(time[4] ?? '').padEnd(3, '0').slice(0, 3)}` : value
}
/** A record past 4 KiB offers Copy record in its detail, whether or not its summary was clipped (`more`). */
const large = (record: StructuredRow): boolean => record.more || record.span.end - record.span.start > 4096
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node
}
interface Options {
  budget: LensBudget | null; atLine?: number; notice(message: string): void; onFrozen(reason: string): void; onShowRaw(line: number): void; onRows(line?: number): void
  onOpenLocal?(target: string, path: string, gesture: LocalGesture): Promise<boolean>
}

/** A bounded source-backed view. No source object is reconstructed with JSON.parse. */
export class StructuredLens {
  readonly element = el('div', undefined, 'structured-view')
  readonly find: SourceFind
  private readonly content = el('div', undefined, 'structured-content')
  private readonly abort = new AbortController()
  private selected?: SourceSpan
  private selectedNode?: StructuredNode
  private selectedPath = '$'
  private stopped = false
  private moved = false
  private line = 0
  private lines: number
  private indexed: boolean
  private history: number[] = []
  private serial = 0
  private mounted = 0
  private readonly copies = new SourceCopyQueue(token => window.typose.cancelClipboardWrite(token))
  private context?: HTMLElement
  private readonly unsubscribe?: () => void
  private readonly toggles = new WeakMap<HTMLButtonElement, () => Promise<void>>()
  private columnStart = 0
  /** Rows: records by source line (null: blank), mounted lines, open details and their heights beyond ROW. */
  private readonly records = new Map<number, StructuredRow | null>()
  private readonly mountedRows = new Map<number, HTMLElement>()
  private readonly expanded = new Map<number, HTMLElement>()
  private readonly extra = new Map<number, number>()
  private resize?: ResizeObserver
  private frame = 0
  private filling = false
  private refill = false
  private retryAt = 0
  private focusLine = 0
  private anchor?: number
  private readonly transcript?: TranscriptView

  constructor(host: HTMLElement, private readonly core: CoreClient, private readonly opened: Opened,
    private readonly source: StructuredSource, private readonly mode: StructuredMode, private readonly options: Options) {
    this.lines = opened.lines; this.indexed = opened.indexed
    this.element.tabIndex = 0; this.element.dataset.mode = mode; this.element.setAttribute('aria-label', `${mode === 'tree' ? 'Tree' : mode === 'rows' ? 'Rows' : mode === 'table' ? 'Table' : 'Transcript'} view`)
    this.element.append(this.content); host.append(this.element)
    this.find = new SourceFind(host, this.element, core, opened, options.budget ?? undefined, (line, hit) => this.reveal(line, hit?.start), options.onFrozen)
    this.element.addEventListener('keydown', this.key)
    // Reading by pointer or by keyboard is moving: a lens decided later (Transcript once ready) leaves the reader here.
    for (const type of ['pointerdown', 'keydown']) this.element.addEventListener(type, () => { this.moved = true })
    this.element.addEventListener('scroll', () => { this.moved = true; if (this.mode === 'rows') this.schedule() }, { passive: true })
    if (mode === 'transcript') this.transcript = new TranscriptView(this.content, core, source, opened, this.abort.signal, {
      tree: (node, record, path) => this.treeNode(node, 0, path ?? '$', record, 1), select: (element, span) => this.select(element, span),
      rows: line => options.onRows(line), frozen: error => this.error(error), openLocal: options.onOpenLocal,
      // The document's Rendered share, which JSONL has no other use for: it's set, not a high-water mark like Grid's.
      reserve: bytes => options.budget?.reserveRendered(opened.gen, bytes) ?? Promise.resolve(false)
    })
    this.unsubscribe = source.subscribe?.(() => {
      if (this.stopped || this.mode === 'tree') return
      if (this.mode === 'rows') this.schedule()
      else void (this.transcript ? this.transcript.show() : this.page(this.line)).catch(error => this.error(error))
    })
    void this.start(options.atLine ?? 0)
  }
  private async start(at: number): Promise<void> {
    try {
      if (!await this.options.budget?.reserveGrid(this.opened.gen, 32 << 20) || this.stopped) throw new Error('Structured view unavailable · memory budget is full')
      if (this.mode === 'tree') {
        const root = this.source.info.root
        if (root) {
          this.mounted = 0
          const row = await this.treeNode(root, 0, '$', undefined, 2)
          if (!this.stopped) this.content.append(row)
        }
        this.showProblems()
      } else if (this.mode === 'rows') this.startRows(at)
      else if (this.transcript) await this.transcript.show(0)
      else await this.page(at)
    } catch (error) { this.error(error) }
  }
  private startRows(at: number): void {
    this.content.classList.add('jsonl-list')
    this.content.addEventListener('focusin', event => {
      const entry = (event.target as HTMLElement).closest<HTMLElement>('.jsonl-entry')
      if (entry) this.focusLine = Number(entry.dataset.line)
    })
    this.resize = new ResizeObserver(entries => {
      const heights = new Map<number, number>()
      for (const { target } of entries) {
        const line = Number((target as HTMLElement).dataset.line), px = Math.max(0, (target as HTMLElement).offsetHeight - ROW)
        // A detached detail measures 0: keep the height it had while mounted.
        if (target !== this.element && target.isConnected && this.expanded.get(line) === target && this.extra.get(line) !== px) heights.set(line, px)
      }
      if (heights.size) this.holdView(() => { for (const [line, px] of heights) this.extra.set(line, px) })
      else this.schedule()
    })
    this.resize.observe(this.element)
    this.focusLine = this.anchor = Math.max(0, at)
    this.renderRows()
  }
  private schedule(): void {
    if (!this.frame && !this.stopped) this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderRows() })
  }
  /** Every line either index has seen: Raw's line count leads while the JSONL index catches up, and rows read ahead of it. */
  private total(): number {
    const info = this.source.info
    return Math.max(this.lines, (info.parsed ?? 0) + (info.failed ?? 0) + (info.blank ?? 0))
  }
  /** A line's top in list pixels: ROW per line, plus the open details above it. */
  private top(line: number): number {
    let y = line * ROW
    for (const [at, px] of this.extra) if (at < line) y += px
    return y
  }
  private lineAt(y: number): number {
    let shift = 0
    for (const at of [...this.extra.keys()].sort((a, b) => a - b)) {
      const start = at * ROW + shift, px = this.extra.get(at)!
      if (y < start) break
      if (y < start + ROW + px) return at
      shift += px
    }
    return Math.max(0, Math.floor((y - shift) / ROW))
  }
  /** List pixels map 1:1 onto scrollTop up to the spacer cap; past it, proportionally (scrollmath's logical scrolling).
   *  ponytail: past the cap a wheel notch moves proportionally further; intercept wheel as VirtualList does if that bites. */
  private geometry() { return { total: this.top(this.total()), viewport: this.element.clientHeight } }
  /** Changes open details' heights without moving what's on screen: the first visible line keeps its offset, so a
   *  detail above the view that grows, shrinks or closes doesn't shift the rows below it. Only repositions mounted
   *  rows (no mounting), so it is safe inside a ResizeObserver callback; the next frame mounts what came into view. */
  private holdView(change: () => void): void {
    const y = toLogical(this.element.scrollTop, this.geometry()), line = this.lineAt(y), offset = y - this.top(line)
    change()
    const geometry = this.geometry(), inside = offset < ROW + (this.extra.get(line) ?? 0)
    this.content.style.height = `${spacerHeight(geometry.total)}px`
    // A line whose own detail shrank past the view's top keeps its top edge there.
    this.element.scrollTop = toNative(this.top(line) + (inside ? offset : 0), geometry)
    const shift = this.element.scrollTop - toLogical(this.element.scrollTop, geometry)
    for (const [at, node] of this.mountedRows) node.style.top = `${this.top(at) + shift}px`
    this.schedule()
  }
  private scrollToLine(line: number, from: number): void {
    const geometry = this.geometry()
    this.content.style.height = `${spacerHeight(geometry.total)}px`
    this.element.scrollTop = toNative(Math.max(0, this.top(line) - from), geometry)
    this.renderRows()
  }
  private renderRows(): void {
    if (this.stopped) return
    // A start or Go to line past what's indexed waits until that line exists.
    if (this.anchor !== undefined && this.anchor < this.total()) {
      const at = this.anchor
      this.anchor = undefined
      this.scrollToLine(at, 0)
      return
    }
    const total = this.total(), geometry = this.geometry(), native = this.element.scrollTop
    const y = toLogical(native, geometry), shift = native - y
    this.content.style.height = `${spacerHeight(geometry.total)}px`
    this.content.style.setProperty('--jsonl-digits', String(String(total).length))
    const first = Math.max(0, this.lineAt(y) - OVERSCAN), last = Math.min(total, this.lineAt(y + geometry.viewport) + 1 + OVERSCAN)
    let refocus: number | undefined
    for (const [line, node] of this.mountedRows) {
      if (line >= first && line < last && (node.dataset.state !== 'pending' || !this.records.has(line))) continue
      if (node.contains(document.activeElement)) { refocus = line; this.element.focus({ preventScroll: true }) }
      node.remove(); this.mountedRows.delete(line)
    }
    let previous: HTMLElement | undefined
    for (let line = first; line < last; line++) {
      let node = this.mountedRows.get(line)
      if (!node) {
        node = this.expanded.get(line) ?? this.rowAt(line)
        this.mountedRows.set(line, node)
        if (previous) previous.after(node); else this.content.prepend(node)
        if (line === refocus) node.querySelector<HTMLElement>('.jsonl-row')?.focus({ preventScroll: true })
      }
      node.style.top = `${this.top(line) + shift}px`
      previous = node
    }
    if (total) this.line = Math.min(total - 1, this.lineAt(y))
    if (performance.now() >= this.retryAt) void this.fill()
  }
  /** One structuredRows page at a time, for the first unread line in view; repeats while the view has unread lines. */
  private async fill(): Promise<void> {
    if (this.filling) { this.refill = true; return }
    this.filling = true
    try {
      for (let pass = 0; pass < 32 && !this.stopped; pass++) {
        this.refill = false
        const lines = [...this.mountedRows.keys()].sort((a, b) => a - b)
        const start = lines.find(line => !this.records.has(line))
        if (start === undefined) break
        const result = await this.core.call('structuredRows', { ref: this.source.info.ref, start, count: 128 }, this.abort.signal)
        if (this.stopped) return
        // Read lines without a record are blank; `done` read through to the end of the file.
        const end = result.nextLine ?? (result.done ? Math.max(this.total(), (result.rows.at(-1)?.line ?? start) + 1) : start)
        // Not indexed that far yet: the next index update or line count asks again.
        if (end <= start && !result.rows.length) { this.refill = false; break }
        for (const row of result.rows) this.records.set(row.line, row)
        for (let line = start; line < end; line++) if (!this.records.has(line)) this.records.set(line, null)
        if (this.records.size > CACHE) {
          const low = lines[0]! - CACHE / 2, high = lines.at(-1)! + CACHE / 2
          for (const line of this.records.keys()) if ((line < low || line > high) && !this.expanded.has(line)) this.records.delete(line)
        }
        this.renderRows()
      }
    } catch (error) {
      // Failed rows retry on their own a second later, without waiting for a scroll or an index update.
      this.retryAt = performance.now() + 1000
      setTimeout(() => { this.retryAt = 0; this.schedule() }, 1000)
      if (!this.stopped) { if (error instanceof CoreCallError && error.code === 'Frozen') this.error(error); else this.options.notice(String(error)) }
    } finally {
      this.filling = false
      if (this.refill) this.schedule()
    }
  }
  private rowAt(line: number): HTMLElement {
    const record = this.records.get(line)
    if (record) return this.row(record)
    const wrapper = el('div', undefined, 'jsonl-entry'), row = el('div', undefined, `jsonl-row ${record === null ? 'jsonl-blank' : 'jsonl-pending'}`)
    wrapper.dataset.line = String(line); wrapper.dataset.state = record === null ? 'blank' : 'pending'
    row.tabIndex = 0; row.setAttribute('role', 'row')
    row.append(el('span', undefined, 'jsonl-gap'), el('span', String(line + 1), 'jsonl-number'), el('span', record === null ? 'blank line' : '…', 'text'))
    wrapper.append(row); return wrapper
  }
  /** Keyboard (Z79): focus moves by line, page or to either end, and the list follows it. */
  private focusRow(target: number): void {
    const total = this.total()
    if (!total) return
    const line = Math.max(0, Math.min(total - 1, target)), y = toLogical(this.element.scrollTop, this.geometry()), top = this.top(line)
    this.focusLine = line
    if (top < y) this.scrollToLine(line, 0)
    else if (top + ROW > y + this.element.clientHeight) this.scrollToLine(line, this.element.clientHeight - ROW)
    else this.renderRows()
    this.mountedRows.get(line)?.querySelector<HTMLElement>('.jsonl-row')?.focus({ preventScroll: true })
  }
  private async toggleRow(record: StructuredRow, wrapper: HTMLElement, expand: HTMLButtonElement): Promise<void> {
    if (wrapper.querySelector(':scope > .jsonl-detail')) { this.collapse(record.line, wrapper); return }
    const panel = el('div', undefined, 'jsonl-detail')
    wrapper.append(panel); expand.textContent = '⌄'; expand.setAttribute('aria-expanded', 'true')
    if (this.mode === 'rows') {
      this.expanded.set(record.line, wrapper); this.resize?.observe(wrapper)
      for (const [line, open] of this.expanded) if (this.expanded.size > EXPANDED && line !== record.line) this.collapse(line, open)
    }
    if (record.root) {
      const tree = await this.treeNode(record.root, 0, '$', record.line, 1)
      // The tree's root is a .tree-entry too, and querySelectorAll counts only its descendants.
      if (panel.parentElement !== wrapper) { this.mounted -= tree.querySelectorAll('.tree-entry').length + 1; return }
      panel.append(tree)
    }
    if (large(record)) {
      // A trusted Copy gesture: data-clipboard-copy arms the preload's write, and copySpan takes its token first thing.
      const copy = el('button', `Copy record · ${(record.span.end - record.span.start).toLocaleString()} source bytes`); copy.type = 'button'; copy.dataset.clipboardCopy = 'true'
      copy.onclick = () => { void this.copySpan(record.span) }; panel.append(copy)
    }
  }
  private collapse(line: number, wrapper: HTMLElement): void {
    const panel = wrapper.querySelector(':scope > .jsonl-detail'), expand = wrapper.querySelector<HTMLElement>('.jsonl-expand')
    if (panel) { this.mounted -= panel.querySelectorAll('.tree-entry').length; panel.remove() }
    if (expand) { expand.textContent = expand.dataset.closed ?? '›'; expand.setAttribute('aria-expanded', 'false') }
    if (this.expanded.get(line) !== wrapper) return
    this.expanded.delete(line); this.resize?.unobserve(wrapper)
    if (!this.mountedRows.has(line)) wrapper.remove()
    this.holdView(() => this.extra.delete(line))
  }
  private error(error: unknown): void {
    if (this.stopped) return
    this.options.notice(String(error)); this.content.append(el('p', String(error), 'structured-problem'))
    if (error instanceof CoreCallError && error.code === 'Frozen') this.options.onFrozen(error.message)
  }
  private select(node: HTMLElement, span: SourceSpan, tree?: StructuredNode, path = '$'): void {
    this.copies.cancel()
    this.element.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false')
    node.setAttribute('aria-selected', 'true'); this.selected = span; this.selectedNode = tree; this.selectedPath = path
  }
  private async treeNode(node: StructuredNode, depth: number, path: string, record?: number, automatic = 0): Promise<HTMLElement> {
    this.mounted++
    const wrapper = el('div', undefined, 'tree-entry'), row = el('div', undefined, `tree-row ${node.duplicate ? 'structured-problem' : ''}`)
    wrapper.dataset.start = String(node.keySpan?.start ?? node.span.start); wrapper.dataset.end = String(node.span.end); wrapper.dataset.children = String(node.children ?? 0)
    row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', 'false'); row.tabIndex = 0
    const children = el('div', undefined, 'tree-children')
    const fold = el('button', node.container !== undefined ? '›' : ' ', 'tree-fold')
    fold.type = 'button'; fold.disabled = node.container === undefined || depth >= 100
    fold.setAttribute('aria-label', `Expand ${node.key ?? path}`)
    if (node.key !== undefined) row.append(fold, el('span', node.key + (node.keyMore ? ' … (key preview; Copy key for full source)' : '') + ': ', 'tree-key text'))
    else row.append(fold)
    const summary = node.kind === 'object' ? `{ ${node.children ?? '…'} items }` : node.kind === 'array' ? `[ ${node.children ?? '…'} items ]` : node.text
    row.append(el('span', summary + (node.more ? ' … (preview; copy value for full source)' : ''), `text tree-${node.kind}`))
    if (node.duplicate) row.append(el('span', ' ! Duplicate key', 'structured-problem'))
    if (depth >= 100 && node.container !== undefined) row.append(el('span', ' · Depth limit reached · View in Raw'))
    row.addEventListener('click', () => this.select(row, node.span, node, path))
    row.addEventListener('contextmenu', event => { event.preventDefault(); this.select(row, node.span, node, path); this.menu(event.clientX, event.clientY) })
    let expanded = false, loaded = false
    const load = async (start: number, wholeLevel = false): Promise<void> => {
      if (this.stopped || node.container === undefined) return
      const result = await this.source.children(node.container, start, record)
      if (this.stopped) return
      if (this.mounted + result.nodes.length > 2000) { children.append(el('p', 'Tree display limit reached (2,000 nodes) · View in Raw or copy the source value', 'structured-problem')); return }
      for (const child of result.nodes) children.append(await this.treeNode(child, depth + 1, `${path}${child.key === undefined ? `[${child.ordinal}]` : `[${JSON.stringify(child.key)}]`}`, record, 0))
      if (result.next !== undefined) {
        if (wholeLevel) { await load(result.next, true); return }
        const more = el('button', 'Show more children'); more.type = 'button'
        more.onclick = () => { more.remove(); void load(result.next!).catch(e => this.error(e)) }; children.append(more)
      }
    }
    const toggle = async () => {
      if (node.container === undefined || depth >= 100) return
      expanded = !expanded; fold.textContent = expanded ? '⌄' : '›'; row.setAttribute('aria-expanded', String(expanded)); children.hidden = !expanded
      if (expanded && !loaded) { loaded = true; await load(0, automatic > 0) }
    }
    fold.onclick = event => { event.stopPropagation(); void toggle().catch(e => this.error(e)) }
    this.toggles.set(fold, toggle)
    row.addEventListener('keydown', event => { if (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded) { event.preventDefault(); void toggle() } })
    wrapper.append(row, children); children.hidden = true
    if (automatic > 0 && node.children !== undefined && this.mounted + node.children <= 200) {
      await toggle()
      // The second level is expanded as a whole only if its total visible siblings fit.
      if (automatic > 1) {
        const entries = [...children.children] as HTMLElement[]
        const count = entries.reduce((sum, entry) => sum + Number(entry.dataset.children ?? 0), 0)
        if (this.mounted + count <= 200) for (const entry of entries) {
          const button = entry.querySelector<HTMLButtonElement>('.tree-fold:not(:disabled)')
          if (button) await this.toggles.get(button)?.()
        }
      }
    }
    return wrapper
  }
  private async page(start: number): Promise<void> {
    const epoch = ++this.serial
    const result = await this.core.call('structuredRows', { ref: this.source.info.ref, start, count: 100 }, this.abort.signal)
    if (this.stopped || epoch !== this.serial) return
    this.line = result.rows[0]?.line ?? start; this.mounted = 0
    const pageBody = el('div')
    if (this.mode === 'table') await this.table(result.rows, pageBody)
    else for (const row of result.rows) pageBody.append(this.row(row))
    if (this.stopped || epoch !== this.serial) return
    const nav = el('div', undefined, 'structured-pagination')
    if (this.history.length) { const previous = el('button', 'Previous rows'); previous.onclick = () => { const back = this.history.pop()!; void this.page(back).catch(e => this.error(e)) }; nav.append(previous) }
    if (result.nextLine !== undefined) { const next = el('button', 'Next rows'); next.onclick = () => { this.history.push(start); void this.page(result.nextLine!).catch(e => this.error(e)) }; nav.append(next) }
    nav.append(el('span', `Source lines ${result.rows[0] ? result.rows[0].line + 1 : start + 1}–${result.rows.at(-1) ? result.rows.at(-1)!.line + 1 : start + 1}${result.done ? '' : ' · indexing…'}`)); pageBody.append(nav); this.content.replaceChildren(pageBody)
  }
  private row(record: StructuredRow): HTMLElement {
    const wrapper = el('div', undefined, 'jsonl-entry'), line = el('div', undefined, `jsonl-row ${record.status === 'failed' ? 'structured-problem' : ''}`)
    const chosen = this.selected?.start === record.span.start && this.selected.end === record.span.end
    line.tabIndex = 0; line.setAttribute('role', 'row'); line.setAttribute('aria-selected', String(chosen)); wrapper.dataset.line = String(record.line); wrapper.dataset.state = 'ready'
    const closed = record.status === 'failed' ? '!' : '›', expand = el('button', closed, 'jsonl-expand')
    expand.type = 'button'; expand.dataset.closed = closed; expand.disabled = !record.root && !large(record); expand.setAttribute('aria-label', `Expand row ${record.line + 1}`); expand.setAttribute('aria-expanded', 'false')
    const time = el('time', clock(record.timestamp), 'jsonl-time'), type = el('span', record.type ?? '', 'jsonl-type csv-value-pill')
    if (record.timestamp) time.title = record.timestamp
    if (record.type) type.dataset.tint = tint(record.type)
    line.append(expand, el('span', String(record.line + 1), 'jsonl-number'), time, type)
    if (record.problem) line.append(el('span', `! ${record.problem}`, 'jsonl-problem'))
    line.append(el('span', record.summary + (record.more ? ' … (preview; copy record for full source)' : ''), 'text'))
    line.addEventListener('click', () => { this.select(line, record.span); this.line = record.line })
    line.addEventListener('keydown', event => {
      if (event.key === ' ' && event.shiftKey || event.key === 'Enter') { event.preventDefault(); this.select(line, record.span); this.line = record.line }
    })
    expand.onclick = event => { event.stopPropagation(); void this.toggleRow(record, wrapper, expand).catch(e => this.error(e)) }
    wrapper.append(line); return wrapper
  }
  private async fields(row: StructuredRow, charge?: { bytes: number }): Promise<StructuredNode[]> {
    if (row.root?.container === undefined) return []
    const fields: StructuredNode[] = []; let start: number | undefined = 0
    while (start !== undefined) {
      const page = await this.source.children(row.root.container, start, row.line)
      if (charge) {
        charge.bytes += page.nodes.reduce((sum, node) => sum + 384 + (node.key?.length ?? 0) * 2 + node.text.length * 2, 0)
        if (charge.bytes > 8 << 20) throw new Error('Table source page exceeds its 8 MiB metadata limit · use Rows to inspect or copy the complete record')
      }
      fields.push(...page.nodes); start = page.next
    }
    return fields
  }
  private async table(rows: StructuredRow[], parent: HTMLElement): Promise<void> {
    if (this.source.info.tableOff) throw new Error(this.source.info.tableOff)
    const metadata = await this.core.call('structuredColumns', { ref: this.source.info.ref, start: this.columnStart, count: 50 }, this.abort.signal)
    const projections: { row: StructuredRow; fields: StructuredNode[] }[] = [], charge = { bytes: 0 }
    for (const row of rows) projections.push({ row, fields: await this.fields(row, charge) })
    if (this.stopped) return
    const keys = metadata.columns.map(column => column.key)
    const columns = el('div', undefined, 'structured-pagination')
    if (this.columnStart > 0) { const previous = el('button', 'Previous columns'); previous.onclick = () => { this.columnStart = Math.max(0, this.columnStart - 50); void this.page(this.line).catch(error => this.error(error)) }; columns.append(previous) }
    if (metadata.next !== undefined) { const next = el('button', 'Next columns'); next.onclick = () => { this.columnStart = metadata.next!; void this.page(this.line).catch(error => this.error(error)) }; columns.append(next) }
    columns.append(el('span', `Columns ${metadata.columns.length ? this.columnStart + 1 : 0}–${this.columnStart + metadata.columns.length} of ${metadata.total}${metadata.done ? '' : ' · discovering keys…'}`)); parent.append(columns)
    const table = el('table', undefined, 'jsonl-table'), head = el('thead'), header = el('tr')
    header.append(el('th', 'Line')); for (const key of keys) header.append(el('th', key)); header.append(el('th', '…other keys')); head.append(header); table.append(head)
    const body = el('tbody')
    for (const { row, fields } of projections) {
      const line = el('tr'); line.tabIndex = 0; line.onclick = () => { this.select(line, row.span); this.line = row.line }; line.append(el('th', String(row.line + 1)))
      for (const key of keys) {
        const values = fields.filter(node => (node.key ?? String(node.ordinal)) === key)
        line.append(el('td', values.map(node => node.text + (node.more ? ' … (preview)' : '')).join(' · ')))
      }
      const other = fields.filter(node => !keys.includes(node.key ?? String(node.ordinal)))
      const details = el('td', row.status === 'failed' ? `! ${row.summary}` : other.map(node => `${node.key}: ${node.text}${node.more ? ' … (preview)' : ''}`).join(', '))
      if (row.status === 'failed') details.className = 'structured-problem'
      const inspect = el('button', 'Inspect record'); inspect.onclick = () => { const tree = this.row(row); details.append(tree); inspect.remove() }; details.append(inspect); line.append(details); body.append(line)
    }
    table.append(body); parent.append(el('p', metadata.done ? 'Source column union · Inspect record shows every field.' : 'Columns grow as indexing discovers keys · …other keys preserves fields outside this column window.'), table)
  }
  private showProblems(): void {
    for (const problem of this.source.info.problems) {
      const button = el('button', `! ${problem.message} · View in Raw`, 'structured-problem')
      button.onclick = () => this.options.onShowRaw(Math.max(0, (problem.line ?? 1) - 1)); this.content.append(button)
    }
  }
  private menu(x: number, y: number): void {
    this.context?.remove(); const menu = el('div', undefined, 'structured-context'); menu.setAttribute('role', 'menu'); menu.style.left = `${x}px`; menu.style.top = `${y}px`
    // Each item is a trusted Copy gesture, which arms the preload's one clipboard write.
    const add = (label: string, action: () => void) => { const button = el('button', label); button.dataset.clipboardCopy = 'true'; button.onclick = () => { action(); menu.remove() }; menu.append(button) }
    add('Copy value (source text)', () => { void this.copy() })
    add('Copy key', () => { const span = this.selectedNode?.keySpan; if (span) void this.copySpan(span) })
    add('Copy path', () => {
      this.copies.cancel()
      const token = window.typose.beginClipboardWrite()
      if (token) void window.typose.writeClipboardText(this.selectedPath, token)
      else this.options.notice('Copy unavailable · use Ctrl+C or a Copy action in the reader')
    })
    this.context = menu; this.element.append(menu); (menu.firstElementChild as HTMLElement)?.focus()
  }
  private readonly key = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); void this.copy() }
    if (event.key === ' ' && this.mode !== 'transcript') event.preventDefault()
    const target = event.target as HTMLElement
    if (this.mode === 'rows' && !event.altKey && (target === this.element || target.classList.contains('jsonl-row'))) {
      const page = Math.max(1, Math.floor(this.element.clientHeight / ROW) - 1)
      const step = ({ ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity } as Record<string, number>)[event.key]
      if (step !== undefined) { event.preventDefault(); this.focusRow(this.focusLine + step); return }
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); this.element.scrollBy({ top: (event.key === 'PageDown' ? 1 : -1) * this.element.clientHeight }) }
    if (event.key === 'Escape') this.context?.remove()
  }
  async copy(): Promise<boolean> { return this.selected ? this.copySpan(this.selected) : false }
  private async copySpan(span: SourceSpan): Promise<boolean> {
    // Taken before anything awaits, while the trusted gesture that armed it is still current (as Raw and Grid do).
    const token = window.typose.beginClipboardWrite()
    if (!token) { this.options.notice('Copy unavailable · use Ctrl+C or a Copy action in the reader'); return false }
    const view = this.opened.view, owner = this.options.budget
    if (!view || !owner || this.stopped) { window.typose.cancelClipboardWrite(token); return false }
    try { return await this.copies.run(token, (current, signal) => copySourceSpan({ valid: () => current() && !this.stopped && owner.current(this.opened.gen), reserve: bytes => owner.reserveCopy(this.opened.gen, bytes), read: (start, count, check) => this.core.call('sourceBytes', { view, start, count }, check), verify: check => this.core.call('sourceVerify', { view, ...span }, check), confirm: async bytes => window.confirm(`Copy ${bytes.toLocaleString()} bytes?`), write: text => window.typose.writeClipboardText(text, token), cancelWrite: () => window.typose.cancelClipboardWrite(token), status: this.options.notice }, span.start, span.end, this.opened.encoding, signal), async () => { await owner.reserveCopy(this.opened.gen, 0) }) }
    catch (error) { this.error(error); return false }
  }
  private reveal(line: number, offset?: number): void {
    this.line = line
    if (this.mode === 'rows') { this.focusLine = this.anchor = line; this.renderRows(); return }
    if (this.mode === 'transcript') { this.options.notice('Find and line navigation use the verified source in Raw'); this.options.onShowRaw(line); return }
    if (this.mode !== 'tree') { void this.page(line).catch(e => this.error(e)); return }
    const view = this.opened.view
    if (!view) return
    void this.core.call('sourceLineRange', { view, startLine: line, count: 1 }, this.abort.signal).then(async span => {
      const target = offset ?? span.start
      for (let depth = 0; depth < 100 && !this.stopped; depth++) {
        const entries = [...this.content.querySelectorAll<HTMLElement>('.tree-entry')].filter(entry => Number(entry.dataset.start) <= target && Number(entry.dataset.end) > target)
        const entry = entries.at(-1); if (!entry) return
        const row = entry.firstElementChild as HTMLElement, fold = row.querySelector<HTMLButtonElement>('.tree-fold')
        if (fold && !fold.disabled && row.getAttribute('aria-expanded') !== 'true') await this.toggles.get(fold)?.()
        else { row.scrollIntoView({ block: 'center' }); return }
      }
    }).catch(e => this.error(e))
  }
  goTo(target: number): void { if (Number.isSafeInteger(target) && target >= 1) { this.moved = true; this.reveal(target - 1) } }
  topLine(): number { return this.line }
  readerMoved(): boolean { return this.moved }
  floorBytes(): number { return 32 << 20 }
  focus(): void { this.element.focus() }
  setLineCount(lines: number): void { this.lines = lines; if (this.mode === 'rows') this.schedule() }
  indexDone(): void { this.indexed = true; if (this.mode === 'rows') this.schedule() }
  freeze(): void { this.stopped = true; this.abort.abort(); this.copies.cancel(); this.find.freeze('source changed') }
  yieldReservation(): void { this.copies.cancel() }
  resumeReservation(): void {}
  dispose(): void { this.stopped = true; cancelAnimationFrame(this.frame); this.resize?.disconnect(); this.unsubscribe?.(); this.abort.abort(); this.copies.cancel(); this.find.destroy(); this.context?.remove(); this.element.remove(); if (this.transcript) void this.options.budget?.reserveRendered(this.opened.gen, 0) }
  printPlan(): PrintPlan { const pages = Math.ceil(this.lines / PRINT_LINES_PER_PAGE); return { unit: 'line', total: this.lines, current: this.line, indexed: this.indexed, totalPages: pages, allFits: pages <= MAX_PRINT_PAGES && this.opened.size <= MAX_PRINT_BYTES } }
  printRange(start: number, end: number, signal: AbortSignal): Promise<PrintPayload> {
    return printLines(this.core, this.opened, this.options.budget, start, end, this.lines, () => !this.stopped && this.indexed, signal)
  }
}
