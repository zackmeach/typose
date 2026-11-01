import type { GridSelection } from './grid-interactions'
import { selectionBounds, serializeTsv, tsvByteLength, utf8ByteLength } from './grid-interactions'
import { LARGE_COPY_CONFIRM_BYTES, MAX_CLIPBOARD_BYTES } from '../../shared/protocol'

const COPY_PAGE_RESERVE = 512 << 10
const CELL_REFERENCE_BYTES = 48
const OUTPUT_COPIES = 4
const CHARGE_GRANULARITY = 256 << 10

export interface GridCopyReader {
  sourceRecord(displayRow: number, signal: AbortSignal): Promise<number>
  cellChunks(sourceRecord: number, column: number, signal: AbortSignal): AsyncIterable<string>
}

export interface GridCopyPort extends GridCopyReader {
  reserve(bytes: number, signal: AbortSignal): Promise<boolean>
  confirm(bytes: number, signal: AbortSignal): Promise<boolean>
  write(text: string): Promise<boolean>
  cancelWrite?(): void
  valid(): boolean
}

export type GridCopyResult =
  | { kind: 'copied'; bytes: number }
  | { kind: 'cancelled' }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }

/** A cancellable copy job. It retains at most one row of decoded cell values plus bounded output chunks. */
export class GridCopyJob {
  private readonly controller = new AbortController()
  private reserved = 0

  constructor(private readonly port: GridCopyPort, private readonly rows: number, private readonly columns: number, private readonly hasHeader: boolean) {}

  cancel(): void { this.controller.abort(); this.port.cancelWrite?.() }

  async run(selection: GridSelection): Promise<GridCopyResult> {
    const signal = this.controller.signal
    const current = () => !signal.aborted && this.port.valid()
    const selected = selectionBounds(selection, this.rows, this.columns)
    const rowCount = Math.max(0, selected.lastRow - selected.firstRow)
    const columnCount = Math.max(0, selected.lastColumn - selected.firstColumn)
    const includeHeader = selection.kind === 'column' && this.hasHeader
    if (!rowCount || !columnCount) return { kind: 'refused', reason: 'There are no cells to copy' }
    const cellCount = rowCount * columnCount + (includeHeader ? 1 : 0)
    if (!Number.isSafeInteger(cellCount)) return { kind: 'refused', reason: 'Selection is too large to copy' }
    const minimumBytes = rowCount * Math.max(0, columnCount - 1) + Math.max(0, rowCount - 1) * 2 + (includeHeader ? 1 : 0)
    if (minimumBytes > MAX_CLIPBOARD_BYTES) return { kind: 'refused', reason: 'Selection exceeds the clipboard size limit' }

    const reserve = async (bytes: number): Promise<boolean> => {
      if (!current() || !Number.isSafeInteger(bytes) || bytes < 0) return false
      const rounded = Math.ceil(bytes / CHARGE_GRANULARITY) * CHARGE_GRANULARITY
      if (rounded <= this.reserved) return true
      const granted = await this.port.reserve(rounded + COPY_PAGE_RESERVE, signal).catch(() => false)
      if (!granted || !current()) return false
      this.reserved = rounded
      return true
    }

    const output: string[] = []
    let outputBytes = 0
    let batchLines: string[] = []
    let rowOrdinal = 0
    try {
      if (!await reserve(COPY_PAGE_RESERVE + columnCount * CELL_REFERENCE_BYTES + rowCount * 8))
        return current() ? { kind: 'refused', reason: 'Copy is unavailable · the memory budget is full' } : { kind: 'cancelled' }

      const appendRow = async (sourceRecord: number, firstColumn: number, lastColumn: number): Promise<GridCopyResult | null> => {
        const values: string[] = []
        let sourceBytes = 0
        for (let column = firstColumn; column < lastColumn; column++) {
          if (!current()) return { kind: 'cancelled' }
          const parts: string[] = []
          let fieldBytes = 0
          for await (const chunk of this.port.cellChunks(sourceRecord, column, signal)) {
            if (!current()) return { kind: 'cancelled' }
            fieldBytes += utf8ByteLength(chunk)
            sourceBytes += utf8ByteLength(chunk)
            if (!Number.isSafeInteger(fieldBytes) || outputBytes + sourceBytes + (values.length ? values.length : 0) > MAX_CLIPBOARD_BYTES + 2)
              return { kind: 'refused', reason: 'Selection exceeds the clipboard size limit' }
            const charge = COPY_PAGE_RESERVE + columnCount * CELL_REFERENCE_BYTES + outputBytes * OUTPUT_COPIES + sourceBytes * 3 + parts.length * 24
            if (!await reserve(charge)) return current()
              ? { kind: 'refused', reason: 'Copy is unavailable · the memory budget is full' }
              : { kind: 'cancelled' }
            parts.push(chunk)
          }
          const value = parts.join('')
          values.push(value)
        }
        const rowBytes = tsvByteLength([values])
        const nextBytes = outputBytes + (rowOrdinal ? 2 : 0) + rowBytes
        if (!Number.isSafeInteger(nextBytes) || nextBytes > MAX_CLIPBOARD_BYTES)
          return { kind: 'refused', reason: 'Selection exceeds the clipboard size limit' }
        const charge = COPY_PAGE_RESERVE + columnCount * CELL_REFERENCE_BYTES + nextBytes * OUTPUT_COPIES + sourceBytes * 2
        if (!await reserve(charge)) return current()
          ? { kind: 'refused', reason: 'Copy is unavailable · the memory budget is full' }
          : { kind: 'cancelled' }
        batchLines.push(serializeTsv([values]))
        outputBytes = nextBytes
        rowOrdinal++
        if (batchLines.length === 64) {
          output.push(batchLines.join('\r\n'))
          batchLines = []
        }
        return null
      }

      if (includeHeader) {
        const result = await appendRow(0, selected.firstColumn, selected.lastColumn)
        if (result) return result
      }
      for (let row = selected.firstRow; row < selected.lastRow; row++) {
        if (!current()) return { kind: 'cancelled' }
        const sourceRecord = await this.port.sourceRecord(row, signal)
        if (!current()) return { kind: 'cancelled' }
        const result = await appendRow(sourceRecord, selected.firstColumn, selected.lastColumn)
        if (result) return result
      }
      if (batchLines.length) output.push(batchLines.join('\r\n'))
      if (outputBytes > LARGE_COPY_CONFIRM_BYTES && !await this.port.confirm(outputBytes, signal))
        return current() ? { kind: 'cancelled' } : { kind: 'cancelled' }
      if (!current()) return { kind: 'cancelled' }
      const total = outputBytes
      const finalCharge = COPY_PAGE_RESERVE + total * OUTPUT_COPIES + output.length * 24
      if (!await reserve(finalCharge)) return current()
        ? { kind: 'refused', reason: 'Copy is unavailable · the memory budget is full' }
        : { kind: 'cancelled' }
      const text = output.join('\r\n')
      if (utf8ByteLength(text) !== total || !current()) return { kind: 'cancelled' }
      if (!await this.port.write(text) || !current()) return { kind: 'failed', reason: 'The clipboard write failed' }
      return { kind: 'copied', bytes: total }
    } catch (error) {
      if (!current()) return { kind: 'cancelled' }
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    } finally {
      this.port.cancelWrite?.()
    }
  }
}
