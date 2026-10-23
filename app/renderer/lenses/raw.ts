import type { Limits, Opened } from '../../shared/protocol'
import type { CoreClient } from '../core'
import { VirtualList } from '../virtual/virtual-list'
import { PageCache } from './page-cache'

/** Brief §6.1's mono line: 13px at 1.55, rounded to whole pixels so row math stays exact. */
export const ROW_HEIGHT = 20

/**
 * Raw (brief §5.1) on the virtualizer: a labelled, focusable region whose gutter is hidden from assistive tech
 * (plan §7 proposal 4). Lines wider than the card scroll horizontally; wrapping is M4.
 */
export class RawLens {
  readonly list: VirtualList
  private readonly cache: PageCache
  private wanted: { first: number; last: number } | null = null
  private inflight = 0
  private scheduled = false
  private disposed = false

  constructor(
    private readonly host: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    label: string,
    private readonly limits: Limits
  ) {
    this.cache = new PageCache(2 * limits.pieceBytes + limits.mapMax)
    this.sizeCache()
    this.cache.add(opened.firstPage.items)
    this.list = new VirtualList(host, ROW_HEIGHT, (i, el) => this.paint(i, el), (r) => this.want(r))
    Object.assign(this.list.element, { role: 'region', ariaLabel: `${label}, Raw` })
    this.setLineCount(opened.lines)
  }

  /** Lines known so far: the index's count, but never fewer than the first page already showed (Z37). */
  setLineCount(lines: number): void {
    this.list.setRowCount(Math.max(lines, this.opened.firstPage.items.length))
  }

  dispose(): void {
    this.disposed = true
    this.list.dispose()
  }

  /** Coalesces viewport requests to one per animation frame (spec §3.4). */
  private want(r: { first: number; last: number }): void {
    this.sizeCache()
    this.cache.setMounted(r.first, r.last)
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

  /** At most 2 requests in flight (spec §3.4). */
  private pump(): void {
    const r = this.wanted
    if (!r || this.inflight >= 2 || this.disposed) return
    let start = r.first
    while (start < r.last && this.cache.has(start)) start++
    if (start >= r.last) return
    this.wanted = null
    this.inflight++
    const count = Math.min(r.last - start, this.limits.maxItems)
    void this.core
      .call('page', { doc: this.opened.doc, lens: 'raw', start, count })
      .then(
        (page) => {
          if (this.disposed) return
          // A page stops at 256 KiB, so the range can still have gaps: keep pumping it unless a newer range is wanted.
          this.cache.add(page.items)
          this.list.refresh()
          if (page.items.length > 0) this.wanted ??= r
        },
        (err: unknown) => console.error('page fetch failed', err)
      )
      .finally(() => {
        this.inflight--
        this.pump()
      })
  }

  private paint(i: number, el: HTMLDivElement): void {
    const item = this.cache.get(i)
    const gutter = Object.assign(document.createElement('span'), { className: 'gutter', textContent: String(i + 1) })
    gutter.setAttribute('aria-hidden', 'true')
    el.replaceChildren(gutter)
    if (!item) return
    el.append(Object.assign(document.createElement('span'), { className: 'text', textContent: item.text }))
    // The line goes on past this piece; continuation pieces arrive in PR 4.
    if (item.more) el.append(Object.assign(document.createElement('span'), { className: 'more', textContent: '…', title: 'This line continues' }))
  }
}
