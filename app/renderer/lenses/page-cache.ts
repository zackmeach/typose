import type { PageItem } from '../../shared/protocol'

/** What an item costs in the renderer (plan C1): its text at 2 bytes per UTF-16 unit, plus its map's bytes. */
export const charge = (item: PageItem): number => 2 * item.text.length + item.map.points.byteLength

/** The elastic part of the cap: room for scrolling back without refetching (~40,000 short lines). */
const ELASTIC = 16 << 20

/**
 * Raw's items by line, bounded in charged bytes rather than a count (plan C1; PR 6's ledger reserves the cap).
 * Mounted items count twice, for their DOM copy, and are never evicted, so the cap reserves room for the most a
 * mounted window can hold: rows × 2 × (2 × pieceBytes + mapMax), plus the elastic part.
 */
export class PageCache {
  private readonly items = new Map<number, PageItem>()
  private cached = 0
  private mounted = { first: 0, last: 0 }
  private mountedCharge = 0
  cap = ELASTIC

  constructor(private readonly maxItemCharge: number) {}

  get(line: number): PageItem | undefined {
    return this.items.get(line)
  }

  has(line: number): boolean {
    return this.items.has(line)
  }

  /** The charged total: every cached item, and mounted ones a second time. */
  get charged(): number {
    return this.cached + this.mountedCharge
  }

  /** Sizes the cap for a mounted window of `rows` rows (the C1 formula), then evicts down to it. */
  setMountedRows(rows: number): void {
    this.cap = rows * 2 * this.maxItemCharge + ELASTIC
    this.evict()
  }

  /** The lines now mounted, `[first, last)`. */
  setMounted(first: number, last: number): void {
    this.mounted = { first, last }
    this.mountedCharge = 0
    for (let line = first; line < last; line++) {
      const item = this.items.get(line)
      if (item) this.mountedCharge += charge(item)
    }
    this.evict()
  }

  add(items: readonly PageItem[]): void {
    for (const item of items) {
      const old = this.items.get(item.line)
      if (old) this.cached -= charge(old)
      this.items.delete(item.line) // re-inserted last: eviction goes oldest-first
      this.items.set(item.line, item)
      this.cached += charge(item)
    }
    this.setMounted(this.mounted.first, this.mounted.last)
  }

  /** Oldest first, never a mounted line. ponytail: insertion order, not distance from the viewport. */
  private evict(): void {
    if (this.charged <= this.cap) return
    for (const [line, item] of this.items) {
      if (this.charged <= this.cap) return
      if (line >= this.mounted.first && line < this.mounted.last) continue
      this.items.delete(line)
      this.cached -= charge(item)
    }
  }
}
