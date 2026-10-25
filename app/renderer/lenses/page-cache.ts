import type { Limits, PageItem } from '../../shared/protocol'

/** What an item costs in the renderer (plan C1): its text at 2 bytes per UTF-16 unit, plus its map's bytes. */
export const charge = (item: PageItem): number => 2 * item.text.length + item.map.points.byteLength

/** Z66: a row shows at most this many UTF-16 units; a longer piece goes on in the next row. */
export const WRAP = 2048

/**
 * What a mounted row's layout costs per UTF-16 unit it shows, once garbage is collected: the DOM's copy of its text, its
 * layout and paint. Measured as the slope between rows laying out 512 and 4,096 units (plan §7, PR 6b): 20 bytes for
 * ASCII, 137 for CJK, 148 for Arabic, 247 for emoji, 262 for Devanagari; PR 6's review measured ≤ 143 for Tibetan,
 * Zalgo, harakat and Thai. 320 leaves a fifth over the worst.
 */
export const LAYOUT_PER_UNIT = 320

/**
 * The garbage a mounted row's layout leaves until a GC, per unit it shows: the rows a scroll unmounts, and the lens a
 * Reload replaces. Measured in Z66's gate, per unit mounted, in a 480 px window (plan §7, PR 6b): at most 800 bytes
 * scrolling 10 viewports (five runs; Devanagari, accessibility on; Arabic 777), and 575 in a Reload's handover (six
 * runs; emoji). 960 leaves a fifth over the worst. Reserved, never charged.
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

/**
 * The grapheme boundaries in (`from`, `to`] of `text`, read from `from`: `from` itself isn't one. `extra` units past
 * `to` are in the slice (and one more, when that would end on a high surrogate) so the grapheme containing `to` is
 * whole; only boundaries ≤ `to` are returned. A grapheme of at most a row that contains `to` ends within `to + WRAP`.
 */
function boundaries(text: string, from: number, to: number, extra = 0): number[] {
  let end = Math.min(text.length, to + 1 + extra)
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end++
  const out: number[] = []
  for (const { index } of graphemes.segment(text.slice(from, end))) if (index > 0 && from + index <= to) out.push(from + index)
  return out
}

/** The unit at `at` may belong to the grapheme before it, so a scan that ends on it can report a false boundary. */
function mayContinue(text: string, at: number): boolean {
  const u = text.charCodeAt(at)
  if (u >= 0xd800 && u <= 0xdfff) return true // a surrogate: the code point isn't whole yet
  if (u === 0x200d || u === 0x200c) return true
  if (u >= 0xfe00 && u <= 0xfe0f) return true
  if (u >= 0x0300 && u <= 0x036f) return true
  if (u >= 0x1ab0 && u <= 0x1aff) return true
  if (u >= 0x1dc0 && u <= 0x1dff) return true
  if (u >= 0x20d0 && u <= 0x20ff) return true
  if (u >= 0xfe20 && u <= 0xfe2f) return true
  return false
}

const mark = /\p{M}/u

/** A mark or joiner at `i`. A virama is a mark, and so is the unit before the consonant that continues the conjunct. */
function continuesAt(text: string, i: number): boolean {
  if (i < 0 || i >= text.length) return false
  const u = text.charCodeAt(i)
  if (u < 0x80) return false
  if (u === 0x200d || u === 0x200c) return true
  const start = u >= 0xdc00 && u <= 0xdfff && i > 0 ? i - 1 : i
  const cp = text.codePointAt(start)
  return cp !== undefined && mark.test(String.fromCodePoint(cp))
}

/**
 * Where the grapheme that starts at `from` ends. The window doubles while the first segment fills it, so finding the
 * end does not copy the rest of the line.
 */
function graphemeEnd(text: string, from: number): number {
  const rest = text.length - from
  let span = Math.min(rest, 256)
  for (;;) {
    let end = Math.min(text.length, from + span)
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end++
    const slice = text.slice(from, end)
    const next = graphemes.segment(slice)[Symbol.iterator]().next()
    if (next.done) return from
    if (next.value.segment.length < slice.length || end >= text.length) return from + next.value.segment.length
    const grown = Math.min(rest, span * 2)
    if (grown === span) return from + next.value.segment.length
    span = grown
  }
}

/**
 * The 96-unit window may have opened inside a grapheme. A mark (a virama, a vowel sign) at its start, or the unit
 * just before, is the class that glues; regional indicators are not marks and are left to the window. A 32-unit probe
 * is trusted only when it itself starts outside the cluster — a chain longer than that still confirms from the row.
 */
function openedInside(text: string, start: number, windowFrom: number): boolean {
  if (!continuesAt(text, windowFrom) && !continuesAt(text, windowFrom - 1)) return false
  const probeFrom = Math.max(start, windowFrom - 32)
  if (probeFrom > start && (continuesAt(text, probeFrom) || continuesAt(text, probeFrom - 1))) return true
  return !boundaries(text, probeFrom, Math.min(text.length, windowFrom + 32)).includes(windowFrom)
}

/** The break for the row at `start`, from a scan that reads `extra` units past the limit. */
function choose(text: string, start: number, limit: number, extra: number): { at: number; cutLong: boolean } {
  const windowFrom = Math.max(start, limit - 96)
  let near = boundaries(text, windowFrom, limit, extra).filter((b) => b > start)
  // No boundary in the slice: the cluster is longer than the lookback, so read it from the row's start.
  const sawWindow = near.length > 0 && windowFrom > start
  if (!sawWindow) near = boundaries(text, start, limit, extra)
  const spaced = near.filter((b) => b >= limit - 64 && text[b - 1] === ' ')
  let at = spaced.at(-1) ?? near.at(-1) ?? limit
  // A slice that starts inside a cluster invents a boundary, so "no boundary, rescan" never runs. Confirm from the
  // row start when the window holds a ZWJ, or when it opens on a mark or the unit after one (a virama chain). A run of
  // regional indicators is neither, and stays on the 96-unit slice: past the 32-unit context it can mispair (plan §7,
  // carried), and a scan from the row start would pair it differently.
  let cutLong = near.length === 0
  const confirm = text.slice(windowFrom, limit + 1).includes('\u200D') || openedInside(text, start, windowFrom)
  if (sawWindow && confirm) {
    const full = boundaries(text, start, limit, extra)
    if (!full.includes(at)) {
      const last = full.at(-1)
      at = last ?? limit
      cutLong = last === undefined
    }
  }
  return { at, cutLong }
}

/**
 * Z66: where `text` breaks into rows of at most `WRAP` units. A break follows a space within 64 units of the limit,
 * else falls at the last grapheme boundary before it, so a cluster never splits (a Devanagari conjunct, an emoji
 * sequence, a letter and its marks). Boundaries are read with 32 units of context before the 64; a cluster longer than
 * that is looked for from the row's start, and only one longer than a row is cut, at the limit and never inside a
 * surrogate pair. A cut of such a cluster keeps cutting there until the cluster's real end: a scan that starts on the
 * leftover joiner would take that joiner as its own grapheme. Blink lays each row out whole, with its own bidi.
 * Returns the rows' starts, then the text's length.
 */
export function rowBreaks(text: string): number[] {
  const out = [0]
  // While `start` is inside a cluster that was cut for being longer than a row, the next cuts are the surrogate-safe
  // limit. `forcedUntil` is that cluster's end, measured once from the row where the cut began.
  let forcedUntil = 0
  for (let start = 0; text.length - start > WRAP; ) {
    const limit = start + WRAP
    if (start < forcedUntil) {
      let at = Math.min(limit, forcedUntil)
      if (at < forcedUntil && /[\uDC00-\uDFFF]/.test(text[at] ?? '')) at--
      out.push(at)
      start = at
      continue
    }
    let { at, cutLong } = choose(text, start, limit, 0)
    // The short slice ends on the limit, so a code point that starts there is only its first unit and the segmenter
    // reports a false boundary at the limit. Read the window and the row-start scan again with a row of lookahead.
    // A unit that starts its own grapheme (an ASCII row's limit) stays on the short scan.
    if (at === limit && mayContinue(text, at)) ({ at, cutLong } = choose(text, start, limit, WRAP))
    if (cutLong) {
      const end = graphemeEnd(text, start)
      if (end > at) forcedUntil = end
      if (/[\uDC00-\uDFFF]/.test(text[at] ?? '')) at-- // one cluster longer than a row
    }
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
