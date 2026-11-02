import { MAX_PRINT_BYTES, MAX_PRINT_PAGES, type Opened, type SourceSpan, type StructuredNode, type StructuredRow } from '../../shared/protocol'
import { CoreCallError, type CoreClient } from '../core'
import { SourceFind } from './source-find'
import type { LensBudget } from './lens-budget'
import type { StructuredSource } from './structured-source'
import { copySourceSpan } from './source-copy'
import { SourceCopyQueue } from './source-copy-queue'
import { PRINT_LINES_PER_PAGE, type PrintPayload, type PrintPlan } from '../print'

export type StructuredMode = 'tree' | 'rows' | 'table' | 'transcript'
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node
}
const decoded = (node: StructuredNode | undefined): string => {
  if (!node) return ''
  if (node.kind !== 'string') return node.text
  try { return JSON.parse(node.text) as string } catch { return node.text }
}
interface Options { budget: LensBudget | null; atLine?: number; notice(message: string): void; onFrozen(reason: string): void; onShowRaw(line: number): void; onRows(): void }

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

  constructor(host: HTMLElement, private readonly core: CoreClient, private readonly opened: Opened,
    private readonly source: StructuredSource, private readonly mode: StructuredMode, private readonly options: Options) {
    this.lines = opened.lines; this.indexed = opened.indexed
    this.element.tabIndex = 0; this.element.setAttribute('aria-label', `${mode === 'tree' ? 'Tree' : mode === 'rows' ? 'Rows' : mode === 'table' ? 'Table' : 'Transcript'} view`)
    this.element.append(this.content); host.append(this.element)
    this.find = new SourceFind(host, this.element, core, opened, options.budget ?? undefined, (line, hit) => this.reveal(line, hit?.start), options.onFrozen)
    this.element.addEventListener('keydown', this.key)
    this.element.addEventListener('pointerdown', () => { this.moved = true })
    this.element.addEventListener('scroll', () => { this.moved = true }, { passive: true })
    this.unsubscribe = source.subscribe?.(() => { if (!this.stopped && this.mode !== 'tree') void this.page(this.line).catch(error => this.error(error)) })
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
      } else await this.page(at)
    } catch (error) { this.error(error) }
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
    else if (this.mode === 'transcript') await this.transcript(result.rows, pageBody)
    else for (const row of result.rows) pageBody.append(this.row(row))
    if (this.stopped || epoch !== this.serial) return
    const nav = el('div', undefined, 'structured-pagination')
    if (this.history.length) { const previous = el('button', 'Previous rows'); previous.onclick = () => { const back = this.history.pop()!; void this.page(back).catch(e => this.error(e)) }; nav.append(previous) }
    if (result.nextLine !== undefined) { const next = el('button', 'Next rows'); next.onclick = () => { this.history.push(start); void this.page(result.nextLine!).catch(e => this.error(e)) }; nav.append(next) }
    nav.append(el('span', `Source lines ${result.rows[0] ? result.rows[0].line + 1 : start + 1}–${result.rows.at(-1) ? result.rows.at(-1)!.line + 1 : start + 1}${result.done ? '' : ' · indexing…'}`)); pageBody.append(nav); this.content.replaceChildren(pageBody)
  }
  private row(record: StructuredRow): HTMLElement {
    const wrapper = el('div', undefined, 'jsonl-entry'), line = el('div', undefined, `jsonl-row ${record.status === 'failed' ? 'structured-problem' : ''}`)
    line.tabIndex = 0; line.setAttribute('role', 'row'); line.setAttribute('aria-selected', 'false'); wrapper.dataset.line = String(record.line)
    const expand = el('button', record.status === 'failed' ? '!' : '›'); expand.disabled = !record.root; expand.setAttribute('aria-label', `Expand row ${record.line + 1}`)
    line.append(expand, el('span', String(record.line + 1), 'jsonl-number'), el('time', record.timestamp ?? ''), el('span', record.type ?? '', 'jsonl-type'), el('span', record.summary + (record.more ? ' … (preview; copy record for full source)' : ''), 'text'))
    line.addEventListener('click', () => { this.select(line, record.span); this.line = record.line })
    line.addEventListener('keydown', event => {
      if (event.key === ' ' && event.shiftKey || event.key === 'Enter') { event.preventDefault(); this.select(line, record.span); this.line = record.line }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const sibling = event.key === 'ArrowDown' ? wrapper.nextElementSibling : wrapper.previousElementSibling
        sibling?.querySelector<HTMLElement>('.jsonl-row')?.focus()
      }
    })
    let tree: HTMLElement | undefined
    expand.onclick = () => { void (async () => { if (tree) { tree.hidden = !tree.hidden; return }; if (!record.root) return; tree = await this.treeNode(record.root, 0, '$', record.line, 1); wrapper.append(tree) })().catch(e => this.error(e)) }
    if (record.problem) wrapper.append(el('p', record.problem, 'structured-problem'))
    if (record.more) { const copy = el('button', `Copy record · ${(record.span.end - record.span.start).toLocaleString()} source bytes`); copy.dataset.clipboardCopy = 'true'; copy.onclick = () => { void this.copySpan(record.span) }; wrapper.append(copy) }
    wrapper.prepend(line); return wrapper
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
  private async transcript(rows: StructuredRow[], parent: HTMLElement): Promise<void> {
    const failed = rows.filter(row => row.status === 'failed')
    if (failed.length || this.source.info.failed) { const button = el('button', `${this.source.info.failed ?? failed.length} lines couldn’t be parsed · View in Rows`, 'structured-problem'); button.onclick = this.options.onRows; parent.append(button) }
    const adapter = this.source.info.transcript?.adapter
    for (const row of rows) {
      if (row.status === 'failed') continue
      const fields = await this.fields(row)
      const get = (key: string) => fields.find(node => node.key === key)
      if (adapter === 'claude-code-v1') {
        const type = decoded(get('type')), message = get('message')
        if (!message || !['user', 'assistant'].includes(type)) {
          const event = el('details', undefined, 'session-event'); event.append(el('summary', `Session event · ${type || 'unknown'} · line ${row.line + 1}`), this.row(row)); parent.append(event); continue
        }
        const side = decoded(get('isSidechain')) === 'true'
        const turn = side ? el('details', undefined, 'transcript-turn') : el('section', undefined, 'transcript-turn')
        if (side) turn.append(el('summary', 'Sidechain · expand message'))
        turn.append(el('h3', `${type === 'user' ? 'User' : 'Assistant'} · ${row.timestamp ?? ''}`))
        const messageFields = message.container !== undefined ? (await this.source.children(message.container, 0, row.line)).nodes : []
        await this.contentBlock(turn, messageFields.find(node => node.key === 'content'), row.line)
        const metadata = el('details'); metadata.append(el('summary', 'Message metadata / branch references'), this.row(row)); turn.append(metadata)
        parent.append(turn)
      } else {
        const messages = get('messages')
        if (messages?.container !== undefined) {
          const conversation = el('details', undefined, 'transcript-conversation'); conversation.open = true
          const nodes = (await this.source.children(messages.container, 0, row.line)).nodes
          conversation.append(el('summary', `Conversation ${row.line + 1} · line ${row.line + 1} · ${messages.children ?? nodes.length} turns`))
          for (const node of nodes) await this.openAiTurn(conversation, node, row.line)
          const metadata = el('details'); metadata.append(el('summary', 'Line metadata'), this.row(row)); conversation.append(metadata); parent.append(conversation)
        } else await this.openAiFields(parent, fields, row.line)
      }
    }
  }
  private async openAiTurn(parent: HTMLElement, node: StructuredNode, record: number): Promise<void> {
    const fields = node.container === undefined ? [] : (await this.source.children(node.container, 0, record)).nodes
    await this.openAiFields(parent, fields, record)
  }
  private async openAiFields(parent: HTMLElement, fields: StructuredNode[], record: number): Promise<void> {
    const role = decoded(fields.find(n => n.key === 'role'))
    const turn = ['system', 'developer'].includes(role) ? el('details', undefined, 'transcript-turn') : el('section', undefined, 'transcript-turn')
    turn.dataset.line = String(record)
    turn.append(el(turn.tagName === 'DETAILS' ? 'summary' : 'h3', ['system', 'developer'].includes(role) ? 'System prompt' : role ? role[0]!.toUpperCase() + role.slice(1) : 'Unknown message'))
    await this.contentBlock(turn, fields.find(node => node.key === 'content'), record)
    for (const extra of fields.filter(node => !['role', 'content'].includes(node.key ?? ''))) { const detail = el('details'); detail.append(el('summary', extra.key ?? extra.kind), await this.treeNode(extra, 0, '$', record)); turn.append(detail) }
    parent.append(turn)
  }
  private async contentBlock(parent: HTMLElement, node: StructuredNode | undefined, record: number): Promise<void> {
    if (!node) return
    if (node.kind === 'string') { parent.append(el('pre', decoded(node) + (node.more ? ' … (preview; inspect source for full content)' : ''), 'transcript-text text')); return }
    if (node.kind === 'array' && node.container !== undefined) {
      const blocks = (await this.source.children(node.container, 0, record)).nodes
      for (const block of blocks) {
        const fields = block.container !== undefined ? (await this.source.children(block.container, 0, record)).nodes : []
        const type = decoded(fields.find(field => field.key === 'type'))
        const text = fields.find(field => field.key === 'text')
        if (type === 'text' && text) await this.contentBlock(parent, text, record)
        else { const disclosure = el('details'); disclosure.append(el('summary', type === 'thinking' ? 'Thinking' : type || block.kind), await this.treeNode(block, 0, '$', record)); parent.append(disclosure) }
      }
      if ((node.children ?? 0) > blocks.length) parent.append(el('p', 'More content blocks · inspect record in Rows'))
    } else { const disclosure = el('details'); disclosure.append(el('summary', 'Content'), await this.treeNode(node, 0, '$', record)); parent.append(disclosure) }
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
  setLineCount(lines: number): void { this.lines = lines }
  indexDone(): void { this.indexed = true }
  freeze(): void { this.stopped = true; this.abort.abort(); this.copies.cancel(); this.find.freeze('source changed') }
  yieldReservation(): void { this.copies.cancel() }
  resumeReservation(): void {}
  dispose(): void { this.stopped = true; this.unsubscribe?.(); this.abort.abort(); this.copies.cancel(); this.find.destroy(); this.context?.remove(); this.element.remove() }
  printPlan(): PrintPlan { const pages = Math.ceil(this.lines / PRINT_LINES_PER_PAGE); return { unit: 'line', total: this.lines, current: this.line, indexed: this.indexed, totalPages: pages, allFits: pages <= MAX_PRINT_PAGES && this.opened.size <= MAX_PRINT_BYTES } }
  async printRange(start: number, end: number, signal: AbortSignal): Promise<PrintPayload> {
    const view = this.opened.view, owner = this.options.budget
    if (!view || !owner || this.stopped || !this.indexed) throw new Error('Print unavailable')
    const span = await this.core.call('sourceLineRange', { view, startLine: start, count: end - start }, signal)
    if (span.end - span.start > MAX_PRINT_BYTES || !await owner.reserveCopy(this.opened.gen, (1 << 20) + (span.end - span.start) * 12)) throw new Error('Print range exceeds memory or size limit')
    try {
      const decoder = new TextDecoder(this.opened.encoding), parts: string[] = []
      for (let offset = span.start; offset < span.end; offset += 65536) { if (this.stopped || signal.aborted) throw new Error('Print cancelled'); parts.push(decoder.decode(await this.core.call('sourceBytes', { view, start: offset, count: Math.min(65536, span.end - offset) }, signal), { stream: true })) }
      parts.push(decoder.decode()); const text = parts.join('')
      if (new TextEncoder().encode(JSON.stringify(text)).length > MAX_PRINT_BYTES) throw new Error('Print output exceeds size limit')
      return { blocks: [{ tag: 'pre', children: [{ text }] }], pages: Math.ceil((end - start) / PRINT_LINES_PER_PAGE), verify: check => !this.stopped && !check.aborted ? this.core.call('sourceVerify', { view, ...span }, check) : Promise.resolve(false), release: async () => { await owner.reserveCopy(this.opened.gen, 0) } }
    } catch (error) { await owner.reserveCopy(this.opened.gen, 0); throw error }
  }
}
