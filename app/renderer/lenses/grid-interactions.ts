export type GridSort = 'none' | 'asc' | 'desc'
export interface GridPosition { row: number; column: number }
export type GridSelection =
  | { kind: 'cell' | 'range'; anchor: GridPosition; focus: GridPosition }
  | { kind: 'row'; anchor: GridPosition; focus: GridPosition }
  | { kind: 'column'; anchor: GridPosition; focus: GridPosition }
export interface GridBounds { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }

export const nextGridSort = (current: GridSort): GridSort => current === 'none' ? 'asc' : current === 'asc' ? 'desc' : 'none'

const clamp = (value: number, limit: number) => Math.max(0, Math.min(value, Math.max(0, limit - 1)))
const pos = (row: number, column: number, rows: number, columns: number): GridPosition => ({ row: clamp(row, rows), column: clamp(column, columns) })

export const selectCell = (at: GridPosition, rows: number, columns: number): GridSelection => {
  const point = pos(at.row, at.column, rows, columns)
  return { kind: 'cell', anchor: point, focus: point }
}

export const extendSelection = (selection: GridSelection, focus: GridPosition, rows: number, columns: number): GridSelection => ({
  kind: 'range',
  anchor: selection.anchor,
  focus: pos(focus.row, focus.column, rows, columns)
})

export const selectRow = (row: number, columns: number): GridSelection => {
  const index = clamp(row, Number.MAX_SAFE_INTEGER)
  return { kind: 'row', anchor: { row: index, column: 0 }, focus: { row: index, column: Math.max(0, columns - 1) } }
}

export const selectColumn = (column: number, rows: number): GridSelection => {
  const index = clamp(column, Number.MAX_SAFE_INTEGER)
  return { kind: 'column', anchor: { row: 0, column: index }, focus: { row: Math.max(0, rows - 1), column: index } }
}

export function selectionBounds(selection: GridSelection, rows: number, columns: number): GridBounds {
  if (selection.kind === 'row') return { firstRow: selection.anchor.row, lastRow: selection.anchor.row + 1, firstColumn: 0, lastColumn: columns }
  if (selection.kind === 'column') return { firstRow: 0, lastRow: rows, firstColumn: selection.anchor.column, lastColumn: selection.anchor.column + 1 }
  return {
    firstRow: Math.min(selection.anchor.row, selection.focus.row), lastRow: Math.max(selection.anchor.row, selection.focus.row) + 1,
    firstColumn: Math.min(selection.anchor.column, selection.focus.column), lastColumn: Math.max(selection.anchor.column, selection.focus.column) + 1
  }
}

export function quoteTsv(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** UTF-8 size without allocating a second full-size byte array. Lone surrogates encode as U+FFFD. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit <= 0x7f) bytes++
    else if (unit <= 0x7ff) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4; i++
    } else bytes += 3
  }
  return bytes
}

export function tsvByteLength(rows: readonly (readonly string[])[]): number {
  let bytes = 0
  for (let row = 0; row < rows.length; row++) {
    if (row) bytes += 2 // CRLF row separator
    const values = rows[row]
    for (let column = 0; column < values.length; column++) {
      if (column) bytes++ // TAB
      const value = values[column]
      let fieldBytes = 0, quotes = 0, quoted = false
      for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i)
        if (unit <= 0x7f) fieldBytes++
        else if (unit <= 0x7ff) fieldBytes += 2
        else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
          fieldBytes += 4; i++
        } else fieldBytes += 3
        if (unit === 0x09 || unit === 0x0a || unit === 0x0d) quoted = true
        if (unit === 0x22) { quoted = true; quotes++ }
      }
      bytes += fieldBytes + (quoted ? 2 + quotes : 0)
    }
  }
  return bytes
}

export function serializeTsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(quoteTsv).join('\t')).join('\r\n')
}
