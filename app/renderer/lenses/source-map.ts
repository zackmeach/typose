import type { WireMap } from '../../shared/protocol'

/** Converts a UTF-16 offset in a decoded piece to its original source byte boundary. */
export function sourceByteAt(map: WireMap, offset: number, side: 'start' | 'end'): number {
  const u = Math.max(0, Math.min(map.units, Math.trunc(offset)))
  if (map.uniform) {
    let at = u
    if (at > 0 && map.points.includes(at - 1)) at += side === 'start' ? -1 : 1
    return map.start + at * map.unitBytes
  }
  const points = map.points
  if (side === 'start') {
    let lo = 0, hi = points.length / 2
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid * 2] < u) lo = mid + 1; else hi = mid }
    if (lo < points.length / 2 && points[lo * 2] === u) return map.start + points[lo * 2 + 1]
    if (u >= map.units) return map.end
    return map.start + points[(lo - 1) * 2 + 1] + u - points[(lo - 1) * 2]
  }
  if (u >= map.units) return map.end
  let lo = 0, hi = points.length / 2
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid * 2] <= u) lo = mid + 1; else hi = mid }
  const index = Math.max(0, lo - 1)
  return map.start + points[index * 2 + 1] + u - points[index * 2]
}
