import type { Opened, SourceSpan, StructuredNode, TranscriptItem, TranscriptText, TranscriptTool } from '../../shared/protocol'
import { CoreCallError, type CoreClient } from '../core'
import type { LocalGesture } from '../reader-window'
import type { StructuredSource } from './structured-source'
import { mappedRange } from './rendered-selection'
import { RENDERED_PER_UNIT } from './rendered-charge'

const make = (tag: string, text?: string, className?: string): HTMLElement => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}
const string = (node?: StructuredNode): string => {
  if (!node) return ''
  try {
    return node.kind === 'string' ? (JSON.parse(node.text) as string) : node.text
  } catch {
    return node.text
  }
}
/** sanitize.rs's RAW_TAGS: the raw HTML tags the core keeps for Rendered. It escapes every other tag already. */
const RAW_TAG = /<\/?(?:b|i|em|strong|code|kbd|sub|sup|br|hr|details|summary|a|img|table|thead|tbody|tr|th|td)[\t\n\f\r />]/i
/**
 * Whether the core kept or stripped raw HTML in `text`'s Markdown, `html`. md.rs maps each Markdown text run, code
 * included, to its source bytes, and raw HTML never reaches one: an allowlisted tag outside every run is raw HTML.
 * Until `whole`, `html` is only the first pages, and the check stops at their last run.
 */
const interpreted = (text: string, html: string[], whole: boolean): boolean => {
  if (!text.includes('<')) return false
  const bytes = new TextEncoder().encode(text),
    runs = new Uint8Array(bytes.length)
  let last = 0
  for (const block of html)
    for (const [, map] of block.matchAll(/data-source-map="([^"]*)"/g)) {
      const range = mappedRange(map!)
      if (range) {
        runs.fill(1, range[0], range[1])
        last = Math.max(last, range[1])
      }
    }
  let gaps = ''
  for (let i = 0; i < (whole ? bytes.length : last); i++) gaps += runs[i] ? '\0' : String.fromCharCode(bytes[i]!)
  return RAW_TAG.test(gaps)
}
interface Options {
  tree(node: StructuredNode, record: number): Promise<HTMLElement>
  select(element: HTMLElement, span: SourceSpan): void
  rows(record?: number): void
  frozen(error: unknown): void
  openLocal?(target: string, path: string, gesture: LocalGesture): Promise<boolean>
  reserve(bytes: number): Promise<boolean>
}
/** One page's DOM, shown or being built: what its HTML and literal text are charged. */
interface Pane {
  bytes: number
}
/** The snapshot's allowance for one character of mounted HTML: its DOM nodes, its text and the HTML string. Literal
 *  text is one text node: Rendered's allowance for a unit of text (`RENDERED_PER_UNIT`). */
const CHAR_BYTES = 1280
/** Native graph descriptors own ordering and links; this view only presents bounded pages. */
export class TranscriptView {
  private serial = 0
  private start = 0
  private showEvents = false
  private history: number[] = []
  private shown?: Pane
  private building?: Pane
  constructor(
    private readonly host: HTMLElement,
    private readonly core: CoreClient,
    private readonly source: StructuredSource,
    private readonly opened: Opened,
    private readonly signal: AbortSignal,
    private readonly options: Options
  ) {}

  /** Only the shown page and the one being built are reserved: reading to the end holds one page's charge, and the lens
   *  releases it when it unmounts. */
  async show(start = this.start): Promise<void> {
    const epoch = ++this.serial,
      pane: Pane = { bytes: 0 }
    this.building = pane
    try {
      await this.build(start, epoch, pane)
    } finally {
      // The page this one replaced is released, or this one, if a newer page replaced it first.
      if (this.building === pane) this.building = undefined
      if (!this.signal.aborted) void this.options.reserve(this.held())
    }
  }
  private held(): number {
    return (this.shown?.bytes ?? 0) + (this.building?.bytes ?? 0)
  }
  /** Charges `bytes` to `pane` before they mount, unless it's off the screen already; refused, they don't mount. */
  private async charge(pane: Pane, bytes: number): Promise<void> {
    pane.bytes += bytes
    if (this.signal.aborted || (pane !== this.shown && pane !== this.building)) return
    if (await this.options.reserve(this.held())) return
    pane.bytes -= bytes
    throw new Error('Transcript display exceeds the memory budget · use Rows or Raw')
  }
  private async build(start: number, epoch: number, pane: Pane): Promise<void> {
    const page = await this.core.call(
      'structuredTranscript',
      { ref: this.source.info.ref, start, count: 20, events: this.showEvents },
      this.signal
    )
    if (this.signal.aborted || epoch !== this.serial) return
    this.start = start
    const body = make('div', undefined, 'transcript-pane'),
      controls = make('div', undefined, 'transcript-controls')
    if (page.events) {
      const label = make('label'),
        check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = this.showEvents
      check.onchange = () => {
        this.showEvents = check.checked
        this.history = []
        void this.show(0).catch(this.options.frozen)
      }
      label.append(check, document.createTextNode(` Show ${page.events.toLocaleString()} session events`))
      controls.append(label)
    }
    if (this.source.info.failed) {
      const failed = make(
        'button',
        `${this.source.info.failed} lines couldn’t be parsed · View in Rows`,
        'structured-problem'
      )
      failed.onclick = () => this.options.rows()
      controls.append(failed)
    }
    body.append(controls)
    for (const item of page.items) {
      if (this.signal.aborted || epoch !== this.serial) return
      body.append(await this.item(item, pane))
    }
    const navigation = make('div', undefined, 'structured-pagination')
    if (this.history.length) {
      const previous = make('button', 'Previous turns')
      previous.onclick = () => {
        void this.show(this.history.pop()!).catch(this.options.frozen)
      }
      navigation.append(previous)
    }
    if (page.next !== undefined) {
      const next = make('button', 'Next turns')
      next.onclick = () => {
        this.history.push(start)
        void this.show(page.next!).catch(this.options.frozen)
      }
      navigation.append(next)
    }
    navigation.append(
      make('span', `${page.items.length ? start + 1 : 0}–${start + page.items.length} of ${page.total}`)
    )
    body.append(navigation)
    if (!this.signal.aborted && epoch === this.serial) {
      this.host.replaceChildren(body)
      this.shown = pane
    }
  }
  /** One item, or why it couldn't be shown: one item's failure never fails its page. */
  private async item(item: TranscriptItem, pane: Pane): Promise<HTMLElement> {
    try {
      return await this.render(item, pane)
    } catch (error) {
      if (this.signal.aborted || (error instanceof CoreCallError && error.code === 'Frozen')) throw error
      const problem = make(
        'button',
        `This item couldn’t be shown · ${error instanceof Error ? error.message : String(error)} · View in Rows`,
        'structured-problem'
      )
      // A branch or sidechain's record is its first member in file order, which can be a hidden results-only one.
      problem.onclick = () => this.options.rows(item.kind === 'branch' || item.kind === 'sidechain' ? undefined : item.record)
      return problem
    }
  }
  private async render(item: TranscriptItem, pane: Pane): Promise<HTMLElement> {
    if (item.kind === 'branch' || item.kind === 'sidechain' || item.kind === 'conversation') {
      const group = document.createElement('details')
      group.className = 'transcript-conversation'
      group.dataset.transcriptItem = String(item.id)
      group.open = item.kind === 'conversation'
      group.append(
        make(
          'summary',
          item.kind === 'branch'
            ? `${item.children} messages on another branch`
            : item.kind === 'sidechain'
              ? `Sidechain · ${item.children} messages`
              : `Conversation ${item.record + 1} · line ${item.record + 1} · ${item.children} turns`
        )
      )
      const children = make('div')
      group.append(children)
      let loaded = false
      const load = async (start: number) => {
        const page = await this.core.call(
          'structuredTranscript',
          { ref: this.source.info.ref, start, count: 20, group: item.id, events: this.showEvents },
          this.signal
        )
        if (this.signal.aborted) return
        for (const child of page.items) children.append(await this.item(child, pane))
        if (page.next !== undefined) {
          const more = make('button', 'Show more messages')
          more.onclick = () => {
            more.remove()
            void load(page.next!).catch(this.options.frozen)
          }
          children.append(more)
        }
      }
      group.addEventListener('toggle', () => {
        if (group.open && !loaded) {
          loaded = true
          void load(0).catch(this.options.frozen)
        }
      })
      if (group.open) {
        loaded = true
        await load(0)
      }
      if (item.kind === 'conversation') {
        const metadata = document.createElement('details')
        metadata.append(make('summary', 'Line metadata'))
        this.lazyTree(metadata, item.root, item.record)
        group.append(metadata)
      }
      return group
    }
    if (item.kind === 'event') {
      const event = document.createElement('details')
      event.className = 'session-event transcript-turn'
      event.dataset.line = String(item.record)
      event.append(make('summary', `Session event · line ${item.record + 1}`))
      this.lazyTree(event, item.root, item.record)
      return event
    }
    const system = item.role === 'system' || item.role === 'developer'
    const turn = system ? document.createElement('details') : make('section')
    turn.className = 'transcript-turn'
    turn.dataset.line = String(item.record)
    turn.dataset.transcriptItem = String(item.id)
    turn.append(
      make(
        system ? 'summary' : 'h3',
        system
          ? 'System prompt'
          : `${item.role ? item.role[0]!.toUpperCase() + item.role.slice(1) : 'Unknown'}${item.timestamp ? ' · ' + item.timestamp : ''}`
      )
    )
    turn.addEventListener('click', (event) => {
      if (!(event.target as HTMLElement).closest('button,a,summary,input')) this.options.select(turn, item.span)
    })
    let tools: TranscriptTool[] = []
    if (item.tools) {
      const first = await this.core.call(
        'structuredTranscriptTools',
        { ref: this.source.info.ref, item: item.id, start: 0, count: 32 },
        this.signal
      )
      tools = first.tools
      // Further tool pages are always reachable, rather than disappearing behind the preview bound.
      if (first.next !== undefined) {
        const more = make('button', 'Show more tool calls')
        more.onclick = () => {
          more.remove()
          void this.moreTools(turn, item, first.next!, pane).catch(this.options.frozen)
        }
        turn.append(more)
      }
    }
    const used = new Set<number>()
    await this.content(turn, item.content, item.record, pane, item, tools, used)
    for (const tool of tools) if (!used.has(tool.ordinal)) turn.append(this.tool(item, tool, pane))
    const metadata = document.createElement('details')
    metadata.append(make('summary', 'Message metadata'))
    this.lazyTree(metadata, item.root, item.record)
    turn.append(metadata)
    return turn
  }
  private async moreTools(parent: HTMLElement, item: TranscriptItem, start: number, pane: Pane): Promise<void> {
    const page = await this.core.call(
      'structuredTranscriptTools',
      { ref: this.source.info.ref, item: item.id, start, count: 32 },
      this.signal
    )
    for (const tool of page.tools) parent.append(this.tool(item, tool, pane))
    if (page.next !== undefined) {
      const more = make('button', 'Show more tool calls')
      more.onclick = () => {
        more.remove()
        void this.moreTools(parent, item, page.next!, pane).catch(this.options.frozen)
      }
      parent.append(more)
    }
  }
  private tool(item: TranscriptItem, tool: TranscriptTool, pane: Pane): HTMLElement {
    const disclosure = document.createElement('details')
    disclosure.className = 'transcript-tool'
    disclosure.dataset.toolId = tool.id
    const preview = tool.input?.text ? string(tool.input).replace(/\s+/g, ' ').slice(0, 80) : ''
    disclosure.append(make('summary', `${tool.name}(${preview}${tool.input?.more ? ' …' : ''})`))
    let loaded = false
    const results = async (start: number) => {
      const page = await this.core.call(
        'structuredTranscriptTools',
        { ref: this.source.info.ref, item: item.id, call: tool.ordinal, start, count: 32 },
        this.signal
      )
      for (const result of page.results) {
        const block = make('div', undefined, 'transcript-tool-result')
        block.append(make('strong', `Tool result · line ${result.record + 1}`))
        await this.content(block, result.content ?? result.block, result.record, pane)
        disclosure.append(block)
      }
      if (page.next !== undefined) {
        const more = make('button', 'Show more tool results')
        more.onclick = () => {
          more.remove()
          void results(page.next!).catch(this.options.frozen)
        }
        disclosure.append(more)
      }
    }
    disclosure.addEventListener('toggle', () => {
      if (!disclosure.open || loaded) return
      loaded = true
      void (async () => {
        if (tool.input) disclosure.append(await this.options.tree(tool.input, item.record))
        if (tool.results) await results(0)
      })().catch(this.options.frozen)
    })
    return disclosure
  }
  private lazyTree(disclosure: HTMLDetailsElement, node: StructuredNode, record: number): void {
    let loaded = false
    disclosure.addEventListener('toggle', () => {
      if (disclosure.open && !loaded) {
        loaded = true
        void this.options
          .tree(node, record)
          .then((tree) => disclosure.append(tree))
          .catch(this.options.frozen)
      }
    })
  }
  private async fields(node: StructuredNode, record: number): Promise<StructuredNode[]> {
    if (node.container === undefined) return []
    const page = await this.source.children(node.container, 0, record)
    return page.nodes
  }
  private async content(
    parent: HTMLElement,
    node: StructuredNode | undefined,
    record: number,
    pane: Pane,
    item?: TranscriptItem,
    tools: TranscriptTool[] = [],
    used = new Set<number>()
  ): Promise<void> {
    if (!node || this.signal.aborted) return
    if (node.kind === 'string') {
      await this.markdown(parent, node, record, pane)
      return
    }
    if (node.kind !== 'array' || node.container === undefined) {
      if (node.kind !== 'null') {
        const extra = document.createElement('details')
        extra.append(make('summary', 'Content'))
        this.lazyTree(extra, node, record)
        parent.append(extra)
      }
      return
    }
    const blocks = async (start: number) => {
      const page = await this.source.children(node.container!, start, record)
      for (const block of page.nodes) {
        if (this.signal.aborted) return
        if (item?.linkedResults.some((span) => span.start === block.span.start && span.end === block.span.end)) continue
        const fields = await this.fields(block, record),
          type = string(fields.find((field) => field.key === 'type')),
          text = fields.find((field) => field.key === 'text')
        const call = tools.find(
          (tool) => tool.block.span.start === block.span.start && tool.block.span.end === block.span.end
        )
        if (call && item) {
          used.add(call.ordinal)
          parent.append(this.tool(item, call, pane))
          continue
        }
        if ((type === 'text' || type === 'input_text' || type === 'output_text') && text) {
          await this.markdown(parent, text, record, pane)
          continue
        }
        if (type === 'image' || type === 'image_url' || type === 'input_image') {
          await this.image(parent, fields, record)
          continue
        }
        const extra = document.createElement('details')
        extra.append(
          make(
            'summary',
            type === 'thinking' ? 'Thinking' : type === 'tool_result' ? 'Tool result (unmatched)' : type || block.kind
          )
        )
        this.lazyTree(extra, block, record)
        parent.append(extra)
      }
      if (page.next !== undefined) {
        const more = make('button', 'Show more content blocks')
        more.onclick = () => {
          more.remove()
          void blocks(page.next!).catch(this.options.frozen)
        }
        parent.append(more)
      }
    }
    await blocks(0)
  }
  private async image(parent: HTMLElement, fields: StructuredNode[], record: number): Promise<void> {
    const image = fields.find(
      (field) => field.key === 'image_url' || field.key === 'source' || field.key === 'image_url'
    )
    let url = image?.kind === 'string' ? string(image) : ''
    if (image?.container !== undefined) {
      const values = await this.fields(image, record),
        data = values.find((value) => value.key === 'data'),
        media = values.find((value) => value.key === 'media_type')
      if (data && media && !data.more) url = `data:${string(media)};base64,${string(data)}`
      else url = string(values.find((value) => value.key === 'url'))
    }
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url) && url.length <= 2 << 20) {
      const thumbnail = document.createElement('img')
      thumbnail.src = url
      thumbnail.alt = 'Embedded image'
      thumbnail.className = 'transcript-image'
      thumbnail.loading = 'lazy'
      parent.append(thumbnail)
    } else
      parent.append(
        make(
          'p',
          url
            ? 'Remote image · not loaded · inspect the source in Message metadata'
            : 'Image preview unavailable · inspect embedded data in Message metadata',
          'transcript-image-placeholder'
        )
      )
  }
  /** A string node's whole text: its preview when that's all of it, else its source (at most the text query's 64 KiB). */
  private async whole(node: StructuredNode): Promise<string> {
    const view = this.opened.view
    if (!node.more || !view) return string(node)
    const bytes = await this.core.call(
      'sourceBytes',
      { view, start: node.span.start, count: node.span.end - node.span.start },
      this.signal
    )
    return string({ ...node, text: new TextDecoder(this.opened.encoding, { ignoreBOM: true }).decode(bytes) })
  }
  private async markdown(parent: HTMLElement, node: StructuredNode, record: number, pane: Pane): Promise<void> {
    if (node.span.end - node.span.start > 65536) {
      const preview = string(node) + ' … (source preview)'
      await this.charge(pane, preview.length * RENDERED_PER_UNIT)
      parent.append(make('pre', preview, 'transcript-text'))
      const raw = make('button', 'View complete content in Rows')
      raw.onclick = () => this.options.rows(record)
      parent.append(raw)
      return
    }
    const holder = make('div', undefined, 'transcript-markdown md-content')
    parent.append(holder)
    const loaded: string[] = []
    let text: string | undefined
    /** The text, literally and whole, in place of its Markdown. */
    const literal = async () => {
      text ??= await this.whole(node)
      await this.charge(pane, text.length * RENDERED_PER_UNIT)
      holder.replaceWith(make('pre', text, 'transcript-text'))
    }
    const load = async (block: number) => {
      let page: TranscriptText
      try {
        page = await this.core.call(
          'structuredTranscriptText',
          { ref: this.source.info.ref, start: node.span.start, end: node.span.end, block },
          this.signal
        )
      } catch (error) {
        // A block whose HTML passes the core's display bound: the text shows literally, and whole, instead.
        if (!(error instanceof CoreCallError && error.code === 'Refused')) throw error
        await literal()
        return
      }
      if (this.signal.aborted) return
      // Brief §5.4: HTML-like tags in message text are literal, never interpreted or stripped. The core renders the
      // Markdown as Rendered does, keeping allowlisted raw HTML, so a text with any shows literally instead.
      loaded.push(...page.html)
      text ??= await this.whole(node)
      if (interpreted(text, loaded, page.next === undefined)) {
        await literal()
        return
      }
      await this.charge(pane, page.html.reduce((chars, html) => chars + html.length, 0) * CHAR_BYTES)
      for (const html of page.html) {
        const fragment = make('div', undefined, 'md-block')
        fragment.innerHTML = html
        holder.append(fragment)
      }
      if (page.next !== undefined) {
        const more = make('button', 'Show more text')
        more.onclick = () => {
          more.remove()
          void load(page.next!).catch(this.options.frozen)
        }
        holder.append(more)
      }
    }
    holder.addEventListener('click', (event) => {
      const anchor = (event.target as HTMLElement).closest<HTMLElement>('a[data-href],a[href]')
      if (!anchor) return
      event.preventDefault()
      const target = anchor.dataset.href ?? anchor.getAttribute('href') ?? ''
      if (target && this.options.openLocal)
        void this.options
          .openLocal(target, this.opened.path ?? '', {
            mode: (event as MouseEvent).shiftKey
              ? 'side'
              : (event as MouseEvent).ctrlKey || (event as MouseEvent).metaKey
                ? 'tab'
                : 'peek',
            trigger: anchor
          })
          .catch(this.options.frozen)
    })
    await load(0)
  }
}
