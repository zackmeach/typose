import { expect, it } from 'vitest'
import { GridColumns } from './grid-columns'
it('refines and clamps sampled widths while locating columns across a 5,000-column extent', () => {
  const columns = new GridColumns(); columns.resize(5000)
  expect(columns.left(5000)).toBe(800000)
  columns.update(0, 1); columns.update(1, 1000); columns.update(4999, 12); columns.resize(5000)
  expect(columns.width(0)).toBe(72); expect(columns.width(1)).toBe(360)
  expect(columns.at(71)).toBe(0); expect(columns.at(72)).toBe(1); expect(columns.at(431)).toBe(1); expect(columns.at(432)).toBe(2)
  expect(columns.at(columns.left(4999) + 1)).toBe(4999)
  expect(columns.at(-12)).toBe(0)
})
