/** Sparse metadata refines widths without allocating or mounting every column's cells. */
export class GridColumns {
  private readonly widths = new Map<number, number>()
  private positions = new Float64Array(1)
  private count = -1
  private dirty = true
  update(column: number, widthUnits: number): void {
    const width = Math.max(72, Math.min(360, Math.ceil(widthUnits * 8 + 32)))
    if (Number.isFinite(width) && this.widths.get(column) !== width) { this.widths.set(column, width); this.dirty = true }
  }
  resize(count: number): void {
    if (count !== this.count) { this.count = count; this.dirty = true }
    if (!this.dirty) return
    if (count < 0 || count > 100_000) throw new Error('Grid exceeds the supported column extent')
    this.positions = new Float64Array(count + 1)
    for (let column = 0; column < count; column++) this.positions[column + 1] = this.positions[column]! + this.width(column)
    this.dirty = false
  }
  width(column: number): number { return this.widths.get(column) ?? 160 }
  left(column: number): number { return this.positions[Math.max(0, Math.min(column, this.count))] ?? 0 }
  at(offset: number): number {
    let low = 0, high = Math.max(0, this.count)
    while (low < high) { const mid = (low + high + 1) >>> 1; if (this.positions[mid]! <= offset) low = mid; else high = mid - 1 }
    return Math.min(Math.max(0, this.count - 1), low)
  }
}
