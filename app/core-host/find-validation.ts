import type { SourceHit, CsvFindHit } from '../shared/protocol'

const invalid = (): never => { throw Object.assign(new Error('the core returned invalid Find data'), { code: 'Internal' }) }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export function findNumber(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) invalid()
  return v as number
}
export function findProgress(v: unknown, size: number): { count: number; scannedBytes: number; complete: boolean } {
  if (!record(v) || typeof v.complete !== 'boolean') return invalid()
  return { count: findNumber(v.count), scannedBytes: findNumber(v.scannedBytes, size), complete: v.complete }
}
export function sourceHit(v: unknown, size: number): SourceHit {
  if (!record(v) || typeof v.text !== 'string' || v.text.length > 32 << 10 || !record(v.map)) return invalid()
  const start = findNumber(v.start, size), end = findNumber(v.end, size)
  const line = findNumber(v.line), lineStart = findNumber(v.lineStart, start)
  const matchStart = findNumber(v.matchStart, v.text.length), matchEnd = findNumber(v.matchEnd, v.text.length)
  const m = v.map
  if (end <= start || matchEnd <= matchStart || typeof m.uniform !== 'boolean' || !(m.points instanceof Uint32Array)
    || m.points.length > 64 << 10 || findNumber(m.start, size) > start || findNumber(m.end, size) < end
    || findNumber(m.units) !== v.text.length || ![0, 1, 2, 3, 4].includes(findNumber(m.unitBytes, 4))) return invalid()
  const mapStart = m.start as number, mapEnd = m.end as number, units = m.units as number
  if (mapStart !== start || mapEnd < mapStart) return invalid()
  if (m.uniform) {
    if (m.unitBytes === 0 || mapStart + units * (m.unitBytes as number) !== mapEnd) return invalid()
    let previous = -2
    for (const pair of m.points) {
      if (pair <= previous + 1 || pair + 2 > units) return invalid()
      previous = pair
    }
  } else {
    if (m.unitBytes !== 0 || m.points.length < 2 || m.points.length % 2 !== 0 || m.points[0] !== 0 || m.points[1] !== 0) return invalid()
    let previousUnit = 0, previousByte = 0
    for (let i = 0; i < m.points.length; i += 2) {
      const unit = m.points[i], byte = m.points[i + 1]
      if (unit < previousUnit || unit > units || byte < previousByte || byte > mapEnd - mapStart) return invalid()
      previousUnit = unit; previousByte = byte
    }
  }
  return { start, end, line, lineStart, text: v.text, map: m as unknown as SourceHit['map'], matchStart, matchEnd }
}
export function sourceHits(v: unknown, size: number): SourceHit[] {
  if (!Array.isArray(v) || v.length > 128) return invalid()
  let bytes = 1024
  return v.map((value) => {
    const hit = sourceHit(value, size)
    bytes += 1024 + 6 * hit.text.length + 24 * hit.map.points.length
    if (bytes > 256 << 10) invalid()
    return hit
  })
}
export function csvFindHit(v: unknown, size: number): CsvFindHit {
  if (!record(v)) return invalid()
  const start = findNumber(v.start, size), end = findNumber(v.end, size)
  if (end <= start) return invalid()
  let excerpt: Pick<CsvFindHit, 'text' | 'matchStart' | 'matchEnd'> = {}
  if (v.text !== undefined || v.matchStart !== undefined || v.matchEnd !== undefined) {
    if (typeof v.text !== 'string' || v.text.length > 32 << 10 || v.matchStart !== 0) return invalid()
    const matchEnd = findNumber(v.matchEnd, v.text.length)
    if (matchEnd === 0) return invalid()
    excerpt = { text: v.text, matchStart: 0, matchEnd }
  }
  return { dataRow: findNumber(v.dataRow), sourceRecord: findNumber(v.sourceRecord), column: findNumber(v.column), start, end, ...excerpt }
}
export function csvFindHits(v: unknown, size: number): CsvFindHit[] {
  if (!Array.isArray(v) || v.length > 128) return invalid()
  return v.map((h) => {
    const hit = csvFindHit(h, size)
    if (hit.text !== undefined) return invalid()
    return hit
  })
}
