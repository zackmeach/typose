// Plan §2.2: the ledger charge before any block is appended.
import { expect, it } from 'vitest'
import { RENDERED_FIXED, RENDERED_PER_NODE, RENDERED_PER_UNIT, renderedCharge } from './rendered-charge'

it('keeps zero-text notes and empty markup charged before they mount', () => {
  const empty = renderedCharge({ units: 0, htmlBytes: 0, nodes: 0, noteUnits: 0 })
  const note = renderedCharge({ units: 0, htmlBytes: 0, nodes: 3, noteUnits: 62 })
  const emptyHeading = renderedCharge({ units: 1, htmlBytes: 10, nodes: 3, noteUnits: 0 })
  expect(empty).toBe(RENDERED_FIXED)
  expect(note).toBe(empty + 3 * RENDERED_PER_NODE + 62 * RENDERED_PER_UNIT)
  expect(note).toBeGreaterThan(empty)
  expect(emptyHeading).toBe(empty + 3 * RENDERED_PER_NODE + RENDERED_PER_UNIT + 20)
})

it('keeps generated labels separate from HTML text units and charges HTML copies', () => {
  const text = { units: 6, htmlBytes: 22, nodes: 3, noteUnits: 0 }
  expect(renderedCharge(text)).toBe(RENDERED_FIXED + 6 * RENDERED_PER_UNIT + 3 * RENDERED_PER_NODE + 44)
  expect(renderedCharge({ ...text, noteUnits: 70 }) - renderedCharge(text)).toBe(70 * RENDERED_PER_UNIT)
  expect(Number.isSafeInteger(renderedCharge({ units: 8 << 20, htmlBytes: 8 << 20, nodes: 8 << 20, noteUnits: 8 << 20 }))).toBe(true)
})
