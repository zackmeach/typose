import type { Limits, PageItem } from '../../shared/protocol'

/** What an item costs in the renderer (plan C1): its text at 2 bytes per UTF-16 unit, plus its map's bytes. */
export const charge = (item: PageItem): number => 2 * item.text.length + item.map.points.byteLength

/** Z66: a row shows at most this many UTF-16 units; a longer piece goes on in the next row. */
export const WRAP = 2048

/**
 * What a mounted row's layout costs per UTF-16 unit it shows, once garbage is collected: the DOM's copy of its text, its
 * layout and paint. Measured on rows of 2,048 units (plan §7, PR 6b): 20 bytes for ASCII, 137 for CJK, 148 for Arabic,
 * 247 for emoji, 262 for Devanagari; PR 6's review measured ≤ 143 for Tibetan, Zalgo, harakat and Thai. 320 leaves a
 * fifth over the worst.
 */
export const LAYOUT_PER_UNIT = 320

/**
 * The garbage a mounted row's layout leaves until a GC, per unit it shows: the rows a scroll unmounts, and the lens a
 * Reload replaces. Measured over six runs of Z66's gate, per unit mounted, in a 480 px window (plan §7, PR 6b): at most
 * 800 bytes scrolling 10 viewports (Devanagari, accessibility on; Arabic 777) and 575 in a Reload's handover (emoji).
 * 960 leaves a fifth over the worst. Reserved, never charged.
 */
export const GARBAGE_PER_UNIT = 960

/** The renderer's fixed allowance, reserved with the view: font and glyph caches, which don't scale with rows (PR 6's
 *  review measured +20.7 to +22.8 MiB across scripts in one session). */
export const FIXED = 24 << 20

/** The elastic part of the cap: room for scrolling back without refetching (~40,000 short lines). */
const ELASTIC = 16 << 20

type Bounds = Pick<Limits, 'pieceBytes' | 'mapMax'>

/** The most a cached item costs: a unit per source byte at most (C2), and its map. */
const itemMax = (l: Bounds): number => 2 * l.pieceBytes + l.mapMax

/**
 * The most a mounted row costs, layout and garbage included. An item shown whole costs at most this per row: its text
 * at 2 bytes a unit, and its map's share, 6 bytes per source byte (`map_max`) for at most 3 source bytes a unit.
 */
export const rowCost = (l: Bounds): number =>
  2 * WRAP + 8 + Math.ceil(((l.mapMax - 8) * 3 * WRAP) / l.pieceBytes) + WRAP * (LAYOUT_PER_UNIT + GARBAGE_PER_UNIT)

/** What a view costs whatever its rows: the fixed allowance, and the two items only partly mounted, at its ends. */
const fixedCost = (l: Bounds): number => FIXED + 2 * itemMax(l)

/** The reservation for a mounted window of `rows` rows (plan C1), with the elastic part or without. */
export const capFor = (l: Bounds, rows: number, elastic = true): number => fixedCost(l) + rows * rowCost(l) + (elastic ? ELASTIC : 0)

/** The rows a reservation covers, at a row's most. */
export const rowsFor = (l: Bounds, reserved: number): number => Math.max(0, Math.floor((reserved - fixedCost(l)) / rowCost(l)))

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const breaks = new WeakMap<PageItem, number[]>()

/** The grapheme boundaries in (`from`, `to`] of `text`, read from `from`: `from` itself isn't one. */
function boundaries(text: string, from: number, to: number): number[] {
  const out: number[] = []
  for (const { index } of graphemes.segment(text.slice(from, to + 1))) if (index > 0 && from + index <= to) out.push(from + index)
  return out
}

/**
 * Z66: where `text` breaks into rows of at most `WRAP` units. A break follows a space within 64 units of the limit,
 * else falls at the last grapheme boundary before it, so a cluster never splits (a Devanagari conjunct, an emoji
 * sequence, a letter and its marks). Boundaries are read with 32 units of context before the 64; a cluster longer than
 * that is looked for from the row's start, and only one longer than a row is cut, at the limit and never inside a
 * surrogate pair. Blink lays each row out whole, with its own bidi. Returns the rows' starts, then the text's length.
 */
export function rowBreaks(text: string): number[] {
  const out = [0]
  for (let start = 0; text.length - start > WRAP; ) {
    const limit = start + WRAP
    let near = boundaries(text, Math.max(start, limit - 96), limit).filter((b) => b > start)
    if (near.length === 0) near = boundaries(text, start, limit)
    const spaced = near.filter((b) => b >= limit - 64 && text[b - 1] === ' ')
    let at = spaced.at(-1) ?? near.at(-1) ?? limit
    if (near.length === 0 && /[\uDC00-\uDFFF]/.test(text[at])) at-- // one cluster longer than a row
    out.push(at)
    start = at
  }
  out.push(text.length)
  return out
}

/** An item's row breaks, once per item. */
export function rowsOf(item: PageItem): number[] {
  let b = breaks.get(item)
  if (!b) breaks.set(item, (b = rowBreaks(item.text)))
  return b
}

/** A line's first piece is keyed by its line number; a further piece by `line:k`, its k-th continuation. */
export type Key = number | string

/** A mounted row: its item's key, and which of the item's rows it shows. */
export interface Mounted {
  key: Key
  sub: number
}

/**
 * Raw's items by key, bounded in charged bytes rather than a count (plan C1). A mounted row also costs its layout
 * (`LAYOUT_PER_UNIT` for each unit it shows), and its item is never evicted. The core's ledger reserves the view's cap
 * (`capFor`) before the cache grows into it (`RawLens`); the cache keeps within that, less the fixed allowance and the
 * garbage reserved for the rows the reservation covers.
 */
export class PageCache {
  private readonly items = new Map<Key, PageItem>()
  private cached = 0
  private mounted: Mounted[] = []
  private mountedKeys = new Set<Key>()
  private mountedCharge = 0
  /** What the cache may charge. */
  cap = ELASTIC

  constructor(private readonly bounds: Bounds) {}

  get(key: Key): PageItem | undefined {
    return this.items.get(key)
  }

  has(key: Key): boolean {
    return this.items.has(key)
  }

  /** Every cached item, for the test-hooks build. */
  all(): IterableIterator<[Key, PageItem]> {
    return this.items.entries()
  }

  /** The charged total: every cached item, and mounted rows' layout besides. */
  get charged(): number {
    return this.cached + this.mountedCharge
  }

  /** Sets what the cache may charge from the view's reservation, then evicts down to it. */
  setCap(reserved: number): void {
    this.cap = reserved - FIXED - rowsFor(this.bounds, reserved) * WRAP * GARBAGE_PER_UNIT
    this.evict()
  }

  /** The rows now mounted. */
  setMounted(rows: Iterable<Mounted>): void {
    this.mounted = [...rows]
    this.mountedKeys = new Set(this.mounted.map((r) => r.key))
    this.mountedCharge = 0
    for (const { key, sub } of this.mounted) {
      const item = this.items.get(key)
      if (!item) continue
      const b = rowsOf(item)
      if (sub + 1 < b.length) this.mountedCharge += LAYOUT_PER_UNIT * (b[sub + 1] - b[sub])
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
      if (this.mountedKeys.has(key)) continue
      this.items.delete(key)
      this.cached -= charge(item)
    }
  }
}
