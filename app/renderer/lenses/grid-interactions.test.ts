import { expect, it } from 'vitest'
import { extendSelection, nextGridSort, quoteTsv, selectCell, selectColumn, selectRow, selectionBounds, serializeTsv, tsvByteLength, utf8ByteLength } from './grid-interactions'

it('cycles a column through stable ascending, descending and unsorted order', () => {
  expect(nextGridSort('none')).toBe('asc')
  expect(nextGridSort('asc')).toBe('desc')
  expect(nextGridSort('desc')).toBe('none')
})

it('extends cell ranges from their anchor and supports full row/column selection bounds', () => {
  const cell = selectCell({ row: 4, column: 2 }, 10, 8)
  expect(selectionBounds(extendSelection(cell, { row: 1, column: 5 }, 10, 8), 10, 8))
    .toEqual({ firstRow: 1, lastRow: 5, firstColumn: 2, lastColumn: 6 })
  expect(selectionBounds(selectRow(3, 6), 10, 6)).toEqual({ firstRow: 3, lastRow: 4, firstColumn: 0, lastColumn: 6 })
  expect(selectionBounds(selectColumn(4, 10), 10, 6)).toEqual({ firstRow: 0, lastRow: 10, firstColumn: 4, lastColumn: 5 })
})

it('serializes exact cell values as quoted TSV and counts encoded bytes without a byte-array copy', () => {
  const rows = [['plain', 'one\ttwo', 'two\nlines', 'say "yes"'], ['😀', 'é']]
  const text = 'plain\t"one\ttwo"\t"two\nlines"\t"say ""yes"""\r\n😀\té'
  expect(quoteTsv('a\rb')).toBe('"a\rb"')
  expect(serializeTsv(rows)).toBe(text)
  expect(tsvByteLength(rows)).toBe(new TextEncoder().encode(text).byteLength)
  expect(utf8ByteLength('\uD800')).toBe(3)
  expect(utf8ByteLength('🌊')).toBe(4)
})
