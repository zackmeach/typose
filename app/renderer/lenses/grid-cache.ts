import type { CsvCell, CsvCellPiece } from '../../shared/protocol'

export const GRID_TEXT_UNITS = 128
export const MAX_GRID_CELLS = 512
export interface GridRange { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }
export type GridCellPreview = Extract<CsvCell, { kind: 'missing' }> | Omit<CsvCellPiece, 'map'> & { partial: boolean }
/** A copied preview cannot retain a giant page string/map behind a small DOM cell. */
export const gridTextPreview = (text: string) => text.slice(0, GRID_TEXT_UNITS).split('').join('')

export function gridCellPreview(cell: CsvCell): GridCellPreview {
  return cell.kind === 'missing' ? { kind: 'missing', column: cell.column } : {
    kind: 'value', sourceRecord: cell.sourceRecord, column: cell.column, span: cell.span, pieceSpan: cell.pieceSpan,
    text: gridTextPreview(cell.text), replacements: cell.replacements, next: cell.next,
    partial: !!cell.next || cell.text.length > GRID_TEXT_UNITS
  }
}

/** Partial replies leave holes; request the first absent cell, not the next requested rectangle. */
export function nextGridCell(range: GridRange, has: (row: number, column: number) => boolean,
  active: { row: number; column: number }, rowCount: number, columnCount: number): { row: number; column: number } | undefined {
  if (active.row < rowCount && active.column < columnCount && !has(active.row, active.column)) return active
  for (let row = range.firstRow; row < range.lastRow; row++) for (let column = range.firstColumn; column < range.lastColumn; column++) {
    if (!has(row, column)) return { row, column }
  }
  return undefined
}
