// Spec §6.2's accessibility mode is taken only from the preload's own messages: this window, this origin.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { onA11yMode } from './a11y'

const ORIGIN = 'typose://app'
let win: EventTarget & { location: { origin: string } }

beforeEach(() => {
  win = Object.assign(new EventTarget(), { location: { origin: ORIGIN } })
  ;(globalThis as { window?: unknown }).window = win
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

const post = (data: unknown, opts: { source?: unknown; origin?: string } = {}) =>
  win.dispatchEvent(Object.assign(new Event('message'), { data, source: win, origin: ORIGIN, ...opts }))

it("takes the mode from this window's own messages, and ignores another window's or another origin's", () => {
  const seen: boolean[] = []
  onA11yMode((on) => seen.push(on))
  post({ type: 'a11y', on: true }, { source: {} }) // another window's, an iframe's say: ignored
  post({ type: 'a11y', on: true }, { origin: 'https://evil.example' }) // another origin's: ignored
  expect(seen).toEqual([])
  post({ type: 'a11y', on: true })
  post({ type: 'a11y', on: false })
  post({ type: 'a11y', on: 'yes' }) // not a boolean: ignored
  post({ type: 'core-gone', session: 1 }) // another message: ignored
  expect(seen).toEqual([true, false])
})
