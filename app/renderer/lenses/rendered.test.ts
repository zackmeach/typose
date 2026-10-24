// Plan §2.2: the ledger charge before any block is appended.
import { expect, it } from 'vitest'
import { RENDERED_PER_UNIT, renderedCharge } from './rendered-charge'

it('charges layout per text unit, and two copies of the HTML', () => {
  expect(renderedCharge(0, 0)).toBe(0)
  expect(renderedCharge(10, 4)).toBe(RENDERED_PER_UNIT * 10 + 8)
  expect(Number.isSafeInteger(renderedCharge(8 << 20, 8 << 20))).toBe(true)
})
