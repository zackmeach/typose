/** A contiguous run of `count` scalars, each `width` source bytes and `per` UTF-16 units (2 for a surrogate pair). */
interface Run { width: number; per: number; count: number }
type UnitMap =
  | { kind: 'L'; start: number; width: number; units: number }
  | { kind: 'R'; start: number; end: number; units: number }
  | { kind: 'S'; start: number; runs: Run[]; units: number }
  | { kind: 'pairs'; pairs: Array<[number, number]>; units: number }

const RUN = /^(\d+)(p?)(?:\*(\d+))?$/

/** Reads one native map (md.rs `source_map`): `L:s:w:n`, `S:s:tokens`, `R:s:e:n`, or `s:e` per unit. */
function parseMap(encoded: string): UnitMap | undefined {
  const safe = (...values: number[]) => values.every(value => Number.isSafeInteger(value) && value >= 0)
  let m = /^L:(\d+):(\d+):(\d+)$/.exec(encoded)
  if (m) {
    const [start, width, units] = m.slice(1).map(Number)
    return safe(start, width, units, start + width * units) && width > 0 ? { kind: 'L', start, width, units } : undefined
  }
  m = /^R:(\d+):(\d+):(\d+)$/.exec(encoded)
  if (m) {
    const [start, end, units] = m.slice(1).map(Number)
    return safe(start, end, units) && end >= start ? { kind: 'R', start, end, units } : undefined
  }
  m = /^S:(\d+):([\dp*,]+)$/.exec(encoded)
  if (m) {
    const start = Number(m[1]), runs: Run[] = []
    let units = 0, bytes = start
    for (const token of m[2].split(',')) {
      const run = RUN.exec(token)
      if (!run) return
      const width = Number(run[1]), per = run[2] ? 2 : 1, count = Number(run[3] ?? 1)
      units += per * count
      bytes += width * count
      if (!safe(width, count, units, bytes) || count < 1) return
      runs.push({ width, per, count })
    }
    return safe(start) ? { kind: 'S', start, runs, units } : undefined
  }
  if (!encoded) return
  const pairs: Array<[number, number]> = []
  for (const text of encoded.split(',')) {
    const pair = /^(\d+):(\d+)$/.exec(text)
    if (!pair) return
    const start = Number(pair[1]), end = Number(pair[2])
    if (!safe(start, end) || end < start) return
    pairs.push([start, end])
  }
  return { kind: 'pairs', pairs, units: pairs.length }
}

/** The source-byte range of display unit `index`. */
function unitRange(map: UnitMap, index: number): [number, number] {
  if (map.kind === 'L') return [map.start + index * map.width, map.start + (index + 1) * map.width]
  if (map.kind === 'R') return [map.start, map.end]
  if (map.kind === 'pairs') return map.pairs[index]
  let unit = 0, byte = map.start
  for (const run of map.runs) {
    if (index < unit + run.per * run.count) {
      const start = byte + Math.floor((index - unit) / run.per) * run.width
      return [start, start + run.width]
    }
    unit += run.per * run.count
    byte += run.width * run.count
  }
  return [byte, byte]
}

/** A selection boundary `offset` units into a run, snapped outward to whole source scalars and atoms. */
export function mappedBoundary(encoded: string, offset: number, side: 'start' | 'end'): number | undefined {
  const map = parseMap(encoded)
  if (!map || !map.units || !Number.isSafeInteger(offset) || offset < 0 || offset > map.units) return
  const [start, end] = unitRange(map, side === 'start' ? Math.min(offset, map.units - 1) : Math.max(0, offset - 1))
  return side === 'start' ? offset === map.units ? end : start : offset === 0 ? start : end
}

/** The map of the same run once its first `units` display units are removed (a callout's `[!KIND]` marker). */
export function dropMappedUnits(encoded: string, units: number): string {
  const map = parseMap(encoded)
  if (!map || units <= 0) return encoded
  if (units >= map.units) return ''
  if (map.kind === 'L') return `L:${map.start + units * map.width}:${map.width}:${map.units - units}`
  if (map.kind === 'R') return `R:${map.start}:${map.end}:${map.units - units}`
  if (map.kind === 'S') {
    let skip = units, byte = map.start
    const runs = map.runs.map(run => ({ ...run }))
    while (skip > 0 && runs.length) {
      const run = runs[0], span = run.per * run.count
      if (skip >= span) { skip -= span; byte += run.width * run.count; runs.shift(); continue }
      if (skip % run.per) break // inside a surrogate pair: list what remains per unit
      run.count -= skip / run.per
      byte += (skip / run.per) * run.width
      skip = 0
    }
    if (!skip) return `S:${byte}:` + runs.map(run => `${run.width}${run.per === 2 ? 'p' : ''}${run.count > 1 ? `*${run.count}` : ''}`).join(',')
  }
  return Array.from({ length: map.units - units }, (_, i) => unitRange(map, units + i).join(':')).join(',')
}

function endpoint(root: HTMLElement, node: Node, offset: number, side: 'start' | 'end'): number | undefined {
  if (!root.contains(node)) return
  const element = node instanceof Element ? node : node.parentElement
  let run = element?.closest<HTMLElement>('[data-source-map]')
  if (!run && node instanceof Element) {
    const child = node.childNodes[side === 'start' ? offset : offset - 1]
    const candidate = child instanceof Element ? child : child?.parentElement
    run = candidate?.matches('[data-source-map]') ? candidate as HTMLElement :
      (side === 'start' ? candidate?.querySelector<HTMLElement>('[data-source-map]') : [...candidate?.querySelectorAll<HTMLElement>('[data-source-map]') ?? []].at(-1))
    if (run && root.contains(run)) return mappedBoundary(run.dataset.sourceMap ?? '', side === 'start' ? 0 : run.textContent?.length ?? 0, side)
  }
  if (!run || !root.contains(run)) return
  const prefix = document.createRange()
  prefix.selectNodeContents(run)
  try { prefix.setEnd(node, offset) } catch { return }
  return mappedBoundary(run.dataset.sourceMap ?? '', prefix.toString().length, side)
}

/** Uses parser provenance, never a search/re-encode of the rendered text. Generated UI is refused. */
export function renderedSelection(root: HTMLElement, selection: Selection | null): { start: number; end: number } | undefined {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  const start = endpoint(root, range.startContainer, range.startOffset, 'start')
  const end = endpoint(root, range.endContainer, range.endOffset, 'end')
  if (start === undefined || end === undefined || end <= start) return
  return { start, end }
}
