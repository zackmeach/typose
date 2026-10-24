import type { PageItem } from '../../shared/protocol'

/** What an item costs in the renderer (plan C1): its text at 2 bytes per UTF-16 unit, plus its map's bytes. */
export const charge = (item: PageItem): number => 2 * item.text.length + item.map.points.byteLength

/**
 * What a mounted item costs besides, per UTF-16 unit: the DOM's copy of its text, its layout and paint, and the garbage
 * scrolling leaves until a GC. Measured on 64 KiB rows at 2,160 px (plan §7, PR 6): 64–66 bytes at the peak for CJK and
 * ASCII, and less for emoji, Arabic and Devanagari; 80 leaves a fifth to spare.
 */
export const MOUNTED_PER_UNIT = 80

/** A mounted item's charge besides its cached one. */
const mountedCharge = (item: PageItem): number => MOUNTED_PER_UNIT * item.text.length

/** The elastic part of the cap: room for scrolling back without refetching (~40,000 short lines). */
const ELASTIC = 16 << 20

/** A line's first piece is keyed by its line number; a further piece by `line:k`, its k-th continuation. */
export type Key = number | string

/**
 * Raw's items by key, bounded in charged bytes rather than a count (plan C1). A mounted item also costs its layout
 * (`MOUNTED_PER_UNIT`), and is never evicted, so the cap holds the most a mounted window can: rows × (2 × pieceBytes +
 * mapMax + MOUNTED_PER_UNIT × pieceBytes), plus the elastic part. The core's ledger reserves the cap before the cache
 * grows into it (`RawLens`).
 */
export class PageCache {
  private readonly items = new Map<Key, PageItem>()
  private cached = 0
  private mounted = new Set<Key>()
  private mountedCharge = 0
  cap = ELASTIC

  /** `maxItemCharge` and `maxItemUnits` bound one item (plan C2): its charge, and its UTF-16 units. */
  constructor(
    private readonly maxItemCharge: number,
    private readonly maxItemUnits: number
  ) {}

  get(key: Key): PageItem | undefined {
    return this.items.get(key)
  }

  has(key: Key): boolean {
    return this.items.has(key)
  }

  /** The charged total: every cached item, and mounted ones' layout besides. */
  get charged(): number {
    return this.cached + this.mountedCharge
  }

  /** The cap for a mounted window of `rows` rows (the C1 formula), with its elastic part or without. */
  capFor(rows: number, elastic = true): number {
    return rows * (this.maxItemCharge + MOUNTED_PER_UNIT * this.maxItemUnits) + (elastic ? ELASTIC : 0)
  }

  /** Sets the cap, then evicts down to it. */
  setCap(cap: number): void {
    this.cap = cap
    this.evict()
  }

  /** Sizes the cap for a mounted window of `rows` rows, then evicts down to it. */
  setMountedRows(rows: number): void {
    this.setCap(this.capFor(rows))
  }

  /** The keys of the items now mounted, one per mounted row. */
  setMounted(keys: Iterable<Key>): void {
    this.mounted = new Set(keys)
    this.mountedCharge = 0
    for (const key of this.mounted) {
      const item = this.items.get(key)
      if (item) this.mountedCharge += mountedCharge(item)
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

  /** Drops every item `test` picks, mounted or not, so it's fetched again; returns how many. */
  drop(test: (item: PageItem) => boolean): number {
    let dropped = 0
    for (const [key, item] of this.items) {
      if (!test(item)) continue
      this.items.delete(key)
      this.cached -= charge(item)
      dropped++
    }
    this.setMounted(this.mounted)
    return dropped
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
