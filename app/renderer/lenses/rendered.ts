import { MAX_CLIPBOARD_BYTES, MAX_PRINT_BYTES, MAX_PRINT_PAGES, type Limits, type MdBuild, type MdItem, type Opened } from '../../shared/protocol'
import { type CoreClient, CoreCallError, testHooks } from '../core'
import { renderedCharge } from './rendered-charge'
import { viewportCap } from './raw'
import type { LensBudget } from './lens-budget'
import { RenderedImages } from './images'
import type { LocalGesture } from '../reader-window'
import { RenderedFind } from './rendered-find'
import { markdownPrintNodes } from './markdown-print'
import { PRINT_LINES_PER_PAGE, type PrintPayload, type PrintPlan } from '../print'
import { utf8ByteLength } from './grid-interactions'
import { copySourceSpan } from './source-copy'

export { RENDERED_PER_UNIT, renderedCharge } from './rendered-charge'

export interface RenderedOptions {
  /** Where to put the view, as a source line (the lens switch, Reload). */
  atLine?: number
  /** A page came back `Frozen`. Rendered keeps what it has; App raises the banner. */
  onFrozen(why: string): void
  /** The note under an oversized block: show its source in Raw at this line. */
  onShowRaw(line: number): void
  /** Opens through this source document's local capability; false leaves the reader in place. */
  onOpenLocal?(target: string, path: string, gesture: LocalGesture): Promise<boolean>
  budget?: LensBudget
}

interface Flight {
  abort: AbortController
}

/**
 * Rendered (brief §5.2) for one Markdown build. Every block is mounted; Chromium skips offscreen work
 * (`content-visibility`), and the blocks stay in the accessibility tree (plan §2.2, Z72). The core already sanitized
 * the HTML. This lens never parses Markdown. Link destinations are resolved by the core; browser navigation stays off.
 */
export class RenderedLens {
  readonly element: HTMLElement
  readonly find: RenderedFind
  private readonly scroller: HTMLElement
  private readonly column: HTMLElement
  private readonly images: RenderedImages
  private readonly flight: Flight[] = []
  /** The next block to ask for. A page ends where the 256 KiB cap stops it, so that start isn't known ahead of the answer. */
  private cursor = 0
  private readonly blocks: number
  private scheduled = false
  private stopped = false
  private paused = false
  /** Set once the reader scrolls, or presses a key, or points: a late page doesn't move them. */
  private moved = false
  private atLine: number | undefined
  /** The source line last seen at the top, while the view was on screen. */
  private shown: number
  /** A newer placement supersedes one still aligning. */
  private placeGen = 0
  private interaction = 0
  private linkGeneration = 0
  private focusJump = false
  private readonly reserved: number
  private indexed: boolean
  private totalLines: number
  private copyAll = false
  private copyAbort: AbortController | undefined
  private copyToken: string | null = null
  private copyStatus: HTMLDivElement

  constructor(
    host: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    build: MdBuild,
    private readonly limits: Limits,
    private readonly options: RenderedOptions
  ) {
    this.blocks = build.blocks
    this.indexed = opened.indexed
    this.totalLines = opened.lines
    this.reserved = renderedCharge(build)
    this.atLine = options.atLine
    this.shown = options.atLine ?? 0
    this.scroller = document.createElement('div')
    this.scroller.className = 'md-scroller md-in'
    this.scroller.tabIndex = 0
    this.scroller.setAttribute('aria-label', 'Rendered')
    this.column = document.createElement('div')
    this.column.className = 'md-column'
    this.copyStatus = Object.assign(document.createElement('div'), { className: 'md-copy-status' })
    this.copyStatus.setAttribute('role', 'status')
    this.scroller.append(this.column, this.copyStatus)
    host.append(this.scroller)
    this.element = this.scroller
    this.find = new RenderedFind(this.scroller, this.column, () => this.cursor >= this.blocks, options.budget, opened.gen)
    this.images = new RenderedImages(this.scroller, core, opened, options.budget, options.onFrozen)
    // Every link click, including one a key fires. `href="#"` would otherwise jump. Capture, so it runs first.
    this.scroller.addEventListener('click', this.onLink, true)
    this.scroller.addEventListener('auxclick', this.onLink, true)
    this.scroller.addEventListener('dragstart', this.onLink, true)
    for (const type of ['wheel', 'keydown', 'pointerdown'] as const)
      this.scroller.addEventListener(type, () => {
        this.interaction++
        this.moved = true
        this.atLine = undefined
        this.focusJump = false
      }, { passive: true })
    this.scroller.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault()
        this.copyAll = true
        this.cancelCopy()
        this.copyStatus.textContent = 'All source text selected · press Ctrl+C to copy'
      } else if (!['Control', 'Meta', 'Shift', 'Alt'].includes(event.key) && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c')) {
        this.copyAll = false
        this.cancelCopy()
      }
    }, { capture: true })
    for (const type of ['pointerdown', 'wheel'] as const) this.scroller.addEventListener(type, () => { this.copyAll = false; this.cancelCopy() }, { passive: true })
    // Remember the top line while the view is on screen. Unmount hides the panel first, and every block's box is then
    // empty, so reading geometry in dispose would report the last block.
    this.scroller.addEventListener('scroll', () => this.remember(), { passive: true })
    if (__TEST_HOOKS__)
      testHooks.rendered = () => ({
        units: build.units,
        htmlBytes: build.htmlBytes,
        nodes: build.nodes,
        noteUnits: build.noteUnits,
        reserved: this.options.budget?.snapshot().rendered ?? this.reserved,
        rawReserved: this.options.budget?.snapshot().raw ?? 0,
        retiredReserved: this.options.budget?.snapshot().retired ?? 0,
        totalReserved: this.options.budget?.snapshot().total ?? this.reserved,
        blocks: this.blocks,
        appended: this.column.childElementCount,
        copyAll: this.copyAll
      })
    this.schedule()
  }

  /** The source line at the top of the view, or the one it was asked to open at until the view has moved. */
  topLine(): number {
    this.remember()
    return this.atLine !== undefined ? this.atLine : this.shown
  }

  /** The block at the top of the scroller. A hidden scroller has no boxes; the last remembered line stands. */
  private remember(): void {
    if (this.scroller.getClientRects().length === 0 || this.scroller.closest('[hidden]')) return
    const edge = this.scroller.getBoundingClientRect().top
    for (const child of this.column.children) {
      const block = child as HTMLElement
      if (block.getBoundingClientRect().bottom > edge + 1) {
        this.shown = Number(block.dataset.line)
        return
      }
    }
  }

  readerMoved(): boolean {
    return this.moved
  }

  /** The next open still reserves Raw's viewport (plan C1): Rendered isn't on screen for that open. */
  floorBytes(): number {
    return viewportCap(this.limits, this.scroller.clientHeight)
  }

  focus(): void {
    this.scroller.focus()
  }

  /** Go to a one-based source line; the build's progressive page pump will reach distant blocks. */
  goTo(lineNumber: number): void {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || this.stopped || this.paused) return
    this.atLine = lineNumber - 1
    this.moved = false
    this.focusJump = true
    delete this.scroller.dataset.ready
    this.settle()
    this.schedule()
  }

  /** Ctrl+A then Copy returns the original source; a partial visual selection needs per-run native maps. */
  async copy(): Promise<boolean> {
    this.cancelCopy()
    const token = window.typose.beginClipboardWrite()
    if (!token) { this.copyStatus.textContent = 'Copy unavailable · use the reader Copy command'; return false }
    if (!this.copyAll) {
      window.typose.cancelClipboardWrite(token)
      const selected = window.getSelection()
      const node = selected?.anchorNode instanceof Element ? selected.anchorNode : selected?.anchorNode?.parentElement
      this.copyStatus.textContent = node && this.scroller.contains(node)
        ? 'Partial Rendered copy is unavailable until this selection has a source map'
        : 'Press Ctrl+A in Rendered, then Copy to copy the complete source'
      return false
    }
    const view = this.opened.view, owner = this.options.budget, generation = this.opened.gen
    if (!view || !owner || this.opened.size > MAX_CLIPBOARD_BYTES) {
      window.typose.cancelClipboardWrite(token)
      this.copyStatus.textContent = 'Copy refused · source is unavailable or exceeds the 16 MiB limit'
      return false
    }
    const controller = new AbortController()
    this.copyAbort = controller
    this.copyToken = token
    const current = () => this.copyAbort === controller && !controller.signal.aborted && !this.stopped && !this.paused && this.copyAll && owner.current(generation)
    this.copyStatus.textContent = 'Preparing source copy…'
    try {
      const copied = await copySourceSpan({
        valid: current,
        reserve: bytes => owner.reserveCopy(generation, bytes),
        read: (start, count, signal) => this.core.call('sourceBytes', { view, start, count }, signal),
        verify: signal => this.core.call('sourceVerify', { view, start: 0, end: this.opened.size }, signal),
        confirm: async bytes => window.confirm(`Copy ${new Intl.NumberFormat('en').format(bytes)} bytes to the clipboard?`),
        write: text => window.typose.writeClipboardText(text, token),
        cancelWrite: () => window.typose.cancelClipboardWrite(token),
        status: message => { this.copyStatus.textContent = message }
      }, 0, this.opened.size, this.opened.encoding, controller.signal)
      if (copied) this.copyStatus.textContent = 'Copied source text'
      else if (controller.signal.aborted) this.copyStatus.textContent = 'Copy cancelled'
      return copied
    } catch (error) {
      if (!controller.signal.aborted) this.copyStatus.textContent = error instanceof Error ? `Copy failed · ${error.message}` : 'Copy failed'
      return false
    } finally {
      await owner.reserveCopy(generation, 0)
      if (this.copyAbort === controller) this.copyAbort = undefined
      if (this.copyToken === token) this.copyToken = null
      window.typose.cancelClipboardWrite(token)
    }
  }

  private cancelCopy(): void {
    this.copyAbort?.abort()
    this.copyAbort = undefined
    if (this.copyToken) window.typose.cancelClipboardWrite(this.copyToken)
    this.copyToken = null
  }

  printPlan(): PrintPlan {
    const pages = Math.ceil(this.totalLines / PRINT_LINES_PER_PAGE)
    return { unit: 'line', total: this.totalLines, current: this.topLine(), indexed: this.indexed, totalPages: pages,
      allFits: this.indexed && pages <= MAX_PRINT_PAGES && this.opened.size <= MAX_PRINT_BYTES }
  }

  async printRange(start: number, end: number, signal: AbortSignal): Promise<PrintPayload> {
    const generation = this.opened.gen
    const current = () => !signal.aborted && !this.stopped && !this.paused && this.indexed && this.options.budget?.current(generation) !== false
    if (!current() || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.totalLines)
      throw new Error('The Markdown print range is no longer available')
    const owner = this.options.budget
    if (!owner || !await owner.reserveCopy(generation, 512 << 10)) throw new Error('Print is unavailable · the memory budget is full')
    const blocks: import('../../shared/protocol').PrintNode[] = []
    let jsonBytes = 0, cursor = 0, visited = 0
    let retained = true
    try {
      while (cursor < this.blocks && current()) {
        const page = await this.core.call('page', { doc: this.opened.doc, lens: 'rendered', gen: generation, start: cursor, count: 64 }, signal)
        if (!current() || !('items' in page) || !page.items.length) break
        const items = page.items as MdItem[]
        const last = items.at(-1)!
        if (last.block < cursor) throw new Error('The Markdown print index returned an invalid block')
        cursor = last.block + 1
        for (const item of items) {
          if (item.line >= end || item.line + item.lines <= start) continue
          if (!await owner.reserveCopy(generation, (512 << 10) + jsonBytes * 4 + item.html.length * 8 + visited * 64))
            throw new Error('Print is unavailable · the memory budget is full')
          const rendered = markdownPrintNodes(item.html, item.note)
          const chunkBytes = utf8ByteLength(JSON.stringify(rendered))
          jsonBytes += chunkBytes
          visited += rendered.length
          if (jsonBytes > MAX_PRINT_BYTES || visited > 100_000 || !await owner.reserveCopy(generation, (512 << 10) + jsonBytes * 4 + visited * 64))
            throw new Error('The selected Markdown range exceeds the bounded print budget')
          blocks.push(...rendered)
        }
      }
      if (!current()) throw new Error('The Markdown print job was cancelled or the source changed')
      if (!blocks.length) blocks.push({ tag: 'p', children: [{ text: 'No rendered blocks in this range.' }] })
      const serializedBytes = utf8ByteLength(JSON.stringify(blocks))
      if (serializedBytes > MAX_PRINT_BYTES || !await owner.reserveCopy(generation, (512 << 10) + jsonBytes * 4 + serializedBytes * 2 + visited * 64))
        throw new Error('The selected Markdown range exceeds the bounded print budget')
      retained = false
      let released = false
      return {
        blocks, pages: Math.ceil((end - start) / PRINT_LINES_PER_PAGE),
        verify: async checkSignal => {
          if (checkSignal.aborted || !current() || !this.opened.view) return false
          const range = await this.core.call('sourceLineRange', { view: this.opened.view, startLine: start, count: end - start }, checkSignal)
          return !checkSignal.aborted && current() && await this.core.call('sourceVerify', { view: this.opened.view, start: range.start, end: range.end }, checkSignal)
        },
        release: async () => { if (released) return; released = true; await owner.reserveCopy(generation, 0) }
      }
    } finally {
      if (retained) await owner.reserveCopy(generation, 0)
    }
  }

  /** The line index is Raw's. Rendered's lines come from the build. */
  setLineCount(lines: number): void {
    this.totalLines = Math.max(this.totalLines, lines)
  }

  indexDone(): void {
    this.indexed = true
  }

  /** A freeze keeps what's shown (plan §2.2). Pages of the build don't read the file, so they may finish. */
  freeze(): void {
    /* the build is one verified read */
  }

  /** Raw yields its cache reservation. Rendered's was taken before this lens mounted, and it doesn't resize it. */
  yieldReservation(): void {
    /* held for the whole build */
  }

  resumeReservation(): void {
    /* nothing was yielded */
  }

  /** Keep this generation's DOM, but stop paging and alignment while Raw is on screen. */
  pause(): void {
    this.find.close()
    this.remember()
    this.paused = true
    this.images.pause()
    this.linkGeneration++
    this.focusJump = false
    this.placeGen++
    for (const f of this.flight) f.abort.abort()
    this.scroller.remove()
  }

  /** A lens switch reuses the same tree and aligns it to Raw's source line. */
  resume(host: HTMLElement, atLine?: number): void {
    host.append(this.scroller)
    this.paused = false
    this.images.resume()
    this.moved = false
    this.atLine = atLine
    delete this.scroller.dataset.ready
    this.settle()
    this.schedule()
  }

  /** `release` is Raw's. Closing the document releases the reservation; a lens switch must not zero it first. */
  dispose(_release = true): void {
    this.cancelCopy()
    this.find.destroy()
    this.stopped = true
    this.images.dispose()
    this.placeGen++
    for (const f of this.flight) f.abort.abort()
    this.scroller.removeEventListener('click', this.onLink, true)
    this.scroller.removeEventListener('auxclick', this.onLink, true)
    this.scroller.removeEventListener('dragstart', this.onLink, true)
    this.scroller.remove()
    this.column.replaceChildren()
    if (__TEST_HOOKS__) testHooks.rendered = null
  }

  private onLink = (e: Event): void => {
    const t = e.target
    if (!(t instanceof Element)) return
    const a = t.closest('a')
    if (!a || !this.scroller.contains(a)) return
    e.preventDefault()
    if (e.type === 'click' && (!(e instanceof MouseEvent) || e.button === 0)) void this.follow(a, {
      mode: e instanceof MouseEvent && (e.ctrlKey || e.metaKey) ? 'tab' : e instanceof MouseEvent && e.shiftKey ? 'side' : 'peek', trigger: a
    })
  }

  private async follow(a: HTMLAnchorElement, gesture: LocalGesture): Promise<void> {
    const href = a.getAttribute('data-href')
    if (!href || this.stopped || this.paused) return
    const generation = this.linkGeneration
    const interaction = this.interaction
    try {
      const target = await this.core.call('resolve', { doc: this.opened.doc, gen: this.opened.gen, href })
      if (this.stopped || this.paused || generation !== this.linkGeneration) return
      if (target.kind === 'external') {
        if (!await window.typose.openExternal(target.url)) a.title = `Not opened: ${href}`
      } else if (target.kind === 'local') {
        if (!await this.options.onOpenLocal?.(target.target, target.path, gesture)) a.title = `Not opened: ${href}`
      } else if (target.kind === 'heading' && interaction === this.interaction) {
        this.atLine = target.line
        this.moved = false
        this.focusJump = true
        delete this.scroller.dataset.ready
        this.settle()
      } else if (target.kind === 'inert') a.title = `Not opened: ${href}`
    } catch (err) {
      if (this.stopped || this.paused || generation !== this.linkGeneration) return
      if (err instanceof CoreCallError && err.code === 'Frozen') this.options.onFrozen(err.message)
      a.title = `Not opened: ${href}`
    }
  }

  /** One page per frame, and at most 2 in flight (plan §2.2, C5). */
  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump(): void {
    if (this.stopped || this.paused || this.flight.length >= 2) return
    // The next page begins where this one stops, and the 256 KiB cap chooses that, so a second request would guess it.
    if (this.flight.length >= 1) return
    if (this.cursor >= this.blocks) return this.settle()
    const start = this.cursor
    const flight: Flight = { abort: new AbortController() }
    this.flight.push(flight)
    const { doc, gen } = this.opened
    void this.core
      .call('page', { doc, lens: 'rendered', gen, start, count: this.limits.maxItems }, flight.abort.signal)
      .then((page) => {
        if (this.stopped || flight.abort.signal.aborted) return
        if (page.items.length === 0) {
          this.stopped = true // nothing more there; asking again would spin
          return
        }
        const frag = document.createDocumentFragment()
        for (const item of page.items) frag.append(this.block(item))
        this.column.append(frag)
        this.cursor = start + page.items.length
        this.settle()
      })
      .catch((err: unknown) => this.failed(err))
      .finally(() => {
        const i = this.flight.indexOf(flight)
        if (i >= 0) this.flight.splice(i, 1)
        this.schedule()
      })
  }

  private markReady(): void {
    this.scroller.dataset.ready = '1'
  }

  /** Scroll to the block that contains `atLine` once it, or the nearest block above it, is mounted. */
  private settle(): void {
    const line = this.atLine
    if (line === undefined) {
      if (this.cursor >= this.blocks) this.markReady()
      return
    }
    const blocks = this.column.children
    let fallback: HTMLElement | null = null
    for (const child of blocks) {
      const block = child as HTMLElement
      const start = Number(block.dataset.line)
      const end = start + Math.max(1, Number(block.dataset.lines))
      if (start > line) break
      fallback = block
      if (line < end) {
        this.reveal(block)
        return
      }
    }
    if (this.cursor >= this.blocks) this.reveal(fallback ?? (this.column.lastElementChild as HTMLElement | null))
  }

  /**
   * Put `block` at the top, preserving the reading inset for the first block. `content-visibility` sizes a block
   * for real only once it nears the viewport, so one measurement undershoots; a few frames correct it.
   * `data-ready` waits until that settles.
   */
  private reveal(block: HTMLElement | null): void {
    const gen = ++this.placeGen
    const align = (left: number) => {
      if (gen !== this.placeGen) return
      if (this.stopped || this.paused || this.moved) return this.finishPlace()
      if (block && this.scroller.getClientRects().length > 0) {
        const inset = block === this.column.firstElementChild ? Number.parseFloat(getComputedStyle(this.column).paddingTop) || 0 : 0
        const delta = block.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - inset
        if (Math.abs(delta) >= 2 && left > 0) {
          this.scroller.scrollTop += delta
          requestAnimationFrame(() => align(left - 1))
          return
        }
      }
      this.atLine = undefined
      if (block) this.shown = Number(block.dataset.line)
      if (this.focusJump) {
        this.focusJump = false
        const target = block?.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? block
        if (target) {
          target.tabIndex = -1
          target.focus({ preventScroll: true })
        }
      }
      this.finishPlace()
    }
    requestAnimationFrame(() => align(8))
  }

  private finishPlace(): void {
    if (this.cursor >= this.blocks) this.markReady()
  }

  private block(item: MdItem): HTMLElement {
    const el = document.createElement('div')
    el.className = 'md-block'
    el.dataset.line = String(item.line)
    el.dataset.lines = String(Math.max(item.lines, 1))
    // The estimate until Chromium has drawn the block once (`contain-intrinsic-size: auto`). Our own, not the file's.
    el.style.containIntrinsicSize = `auto ${Math.max(1, item.lines) * 24}px`
    if (item.note) {
      el.dataset.findNoteUnits = String(item.note.length)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'md-note'
      button.textContent = `${item.note} · Show in Raw at line ${item.line + 1}`
      button.addEventListener('click', () => this.options.onShowRaw(item.line))
      el.append(button)
    } else {
      el.innerHTML = item.html
      for (const image of el.querySelectorAll<HTMLElement>('.tp-img')) this.images.add(image)
      for (const a of el.querySelectorAll('a')) {
        const dest = a.getAttribute('data-href')
        if (dest) a.title = dest // the tooltip shows the target (plan §2.4); the href stays "#"
        if (!(a.textContent ?? '').trim()) a.setAttribute('aria-label', dest || 'Link')
      }
      for (const input of el.querySelectorAll('input'))
        if (input instanceof HTMLInputElement && input.type === 'checkbox' && !input.hasAttribute('aria-label'))
          input.setAttribute('aria-label', input.checked ? 'Completed task' : 'Task')
    }
    return el
  }

  /** A refused page stops the lens. `Frozen` reaches App's banner. A replaced generation and a cancel are dropped. */
  private failed(err: unknown): void {
    if (err instanceof CoreCallError && (err.code === 'CoreGone' || err.code === 'Cancelled')) return
    this.stopped = true
    if (err instanceof CoreCallError && err.code === 'Frozen') this.options.onFrozen(err.message)
    else if (!(err instanceof CoreCallError && err.code === 'Stale')) console.error('rendered page failed', err)
  }
}
