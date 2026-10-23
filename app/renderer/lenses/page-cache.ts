import type { PageItem } from '../../shared/protocol'

/** What an item costs in the renderer (plan C1): its text at 2 bytes per UTF-16 unit, plus its map's bytes. */
export const charge = (item: PageItem): number => 2 * item.text.length + item.map.points.byteLength

/** The elastic part of the cap: room for scrolling back without refetching (~40,000 short lines). */
const ELASTIC = 16 << 20

/** A line's first piece is keyed by its line number; a further piece by `line:k`, its k-th continuation. */
export type Key = number | string

/**
 * Raw's items by key, bounded in charged bytes rather than a count (plan C1; PR 6's ledger reserves the cap).
 * Mounted items count twice, for their DOM copy, and are never evicted, so the cap reserves room for the most a
 * mounted window can hold: rows × 2 × (2 × pieceBytes + mapMax), plus the elastic part.
 */
export class PageCache {
  private readonly items = new Map<Key, PageItem>()
  private cached = 0
  private mounted = new Set<Key>()
  private mountedCharge = 0
  cap = ELASTIC

  constructor(private readonly maxItemCharge: number) {}

  get(key: Key): PageItem | undefined {
    return this.items.get(key)
  }

  has(key: Key): boolean {
    return this.items.has(key)
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

  /** The keys of the items now mounted, one per mounted row. */
  setMounted(keys: Iterable<Key>): void {
    this.mounted = new Set(keys)
    this.mountedCharge = 0
    for (const key of this.mounted) {
      const item = this.items.get(key)
      if (item) this.mountedCharge += charge(item)
    }
    this.evict()
  }

  /** First pieces, keyed by line. */
  add(items: readonly PageItem[]): void {
    for (const item of items) this.put(item.line, item)
    this.setMounted(this.mounted)
  }

  /** A further piece of a line. */
  addPiece(key: string, item: PageItem): void {
    this.put(key, item)
    this.setMounted(this.mounted)
  }

  private put(key: Key, item: PageItem): void {
    const old = this.items.get(key)
    if (old) this.cached -= charge(old)
    this.items.delete(key) // re-inserted last: eviction goes oldest-first
    this.items.set(key, item)
    this.cached += charge(item)
  }

  /** Oldest first, never a mounted item. ponytail: insertion order, not distance from the viewport. */
  private evict(): void {
    if (this.charged <= this.cap) return
    for (const [key, item] of this.items) {
      if (this.charged <= this.cap) return
      if (this.mounted.has(key)) continue
      this.items.delete(key)
      this.cached -= charge(item)
    }
  }
}
