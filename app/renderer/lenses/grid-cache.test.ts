import { expect, it } from 'vitest'
import type { CsvCellPiece } from '../../shared/protocol'
import { GRID_TEXT_UNITS, MAX_GRID_CELLS, gridCellPreview, nextGridCell } from './grid-cache'

const value = (column = 0): CsvCellPiece => ({ kind: 'value', sourceRecord: 7, column,
  span: { start: 80, end: 1_000_000 }, pieceSpan: { start: 80, end: 65_616 }, text: 'x'.repeat(65_536),
  map: { uniform: true, start: 80, end: 65_616, units: 65_536, unitBytes: 1, points: new Uint32Array() }, replacements: 0,
  next: { ref: { session: 1, doc: 2, gen: 1, revision: 3 }, sourceRecord: 7, column, offset: 65_616 } })

it('a viewport of giant fields retains only bounded summaries and exact refetch locators', () => {
  const source = value()
  const cache = Array.from({ length: MAX_GRID_CELLS }, (_, column) => gridCellPreview({ ...source, column }))
  expect(cache.every(cell => !('map' in cell))).toBe(true)
  expect(cache.reduce((units, cell) => units + (cell.kind === 'value' ? cell.text.length : 0), 0)).toBe(MAX_GRID_CELLS * GRID_TEXT_UNITS)
  const first = cache[0]
  expect(first.kind).toBe('value')
  if (first.kind === 'value') {
    expect(first.partial).toBe(true)
    expect(first.next).toEqual(source.next)
    expect(first.span).toEqual(source.span)
    expect(first.pieceSpan).toEqual(source.pieceSpan)
  }
})

it('missing, empty and a bounded complete value remain different', () => {
  expect(gridCellPreview({ kind: 'missing', column: 2 })).toEqual({ kind: 'missing', column: 2 })
  expect(gridCellPreview({ ...value(), text: '', next: undefined })).toMatchObject({ kind: 'value', text: '', partial: false })
  expect(gridCellPreview({ ...value(), text: '001.00', next: undefined })).toMatchObject({ text: '001.00', partial: false })
})

it('partial rectangles resume their row tail before the following row original columns', () => {
  const loaded = new Set(['0:0', '0:1'])
  const range = { firstRow: 0, lastRow: 2, firstColumn: 0, lastColumn: 3 }
  const next = () => nextGridCell(range, (row, column) => loaded.has(`${row}:${column}`), { row: 0, column: 0 }, 2, 3)
  expect(next()).toEqual({ row: 0, column: 2 })
  loaded.add('0:2')
  expect(next()).toEqual({ row: 1, column: 0 })
  for (let column = 0; column < 3; column++) loaded.add(`1:${column}`)
  expect(next()).toBeUndefined()
  expect(nextGridCell(range, () => false, { row: 90, column: 4_999 }, 100, 5_000)).toEqual({ row: 90, column: 4_999 })
})
