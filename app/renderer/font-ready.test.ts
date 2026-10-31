import { afterEach, expect, it, vi } from 'vitest'
import { fontsReady } from './font-ready'

afterEach(() => vi.useRealTimers())

it('waits for every shipped face before selecting bundled metrics', async () => {
  let complete!: (faces: FontFace[]) => void
  const pending = new Promise<FontFace[]>((done) => { complete = done })
  const load = vi.fn(() => pending)
  const ready = fontsReady({ load })
  let settled = false
  void ready.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(load.mock.calls).toHaveLength(6)
  complete([{} as FontFace])
  expect(await ready).toBe(true)
})

it('pins fallback when a font is missing or fails', async () => {
  expect(await fontsReady({ load: async () => [] })).toBe(false)
  expect(await fontsReady({ load: async () => { throw new Error('unavailable') } })).toBe(false)
})

it('bounds startup and never switches metrics after a delayed font finishes', async () => {
  vi.useFakeTimers()
  let complete!: (faces: FontFace[]) => void
  const pending = new Promise<FontFace[]>((done) => { complete = done })
  const ready = fontsReady({ load: () => pending })
  await vi.advanceTimersByTimeAsync(1500)
  expect(await ready).toBe(false)
  complete([{} as FontFace])
  expect(await ready).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
