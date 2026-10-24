// The test-hooks addon (plan m8) at the napi layer: its debug stats count what a document holds (plan C6), and its
// per-read delay shows a cancelled read stopping within the chunk read it's in (plan C5). Run by `npm run test:hooks`,
// after `npm run build:addon:hooks`; the release addon has none of this.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import type * as Core from 'typose-node'

interface Hooks {
  debugStats(): { jobs: number; tasks: number; handles: number; delayMs: number }
  setReadDelay(ms: number): void
}
const core = createRequire(import.meta.url)('typose-node/hooks') as typeof Core & Hooks
/** The debug stats' counts of what's alive. */
const alive = () => (({ jobs, tasks, handles }) => ({ jobs, tasks, handles }))(core.debugStats())
const dir = mkdtempSync(join(tmpdir(), 'typose-hooks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => core.setReadDelay(0))

const indexed = (doc: Core.Doc) =>
  new Promise<number>((ok, fail) => doc.startIndex(new core.Cancel(), (p) => (p.error ? fail(new Error(p.error)) : p.done && ok(p.lines))))
/** How a read ended: 'resolved', or its rejection's code. */
const ending = (read: Promise<unknown>) => read.then(
  () => 'resolved',
  (e: { code?: string }) => e.code
)

it('debug stats: a document holds a handle, its index a job, a read a task; once they end and it closes, none is left', async () => {
  const path = join(dir, 'stats.txt')
  writeFileSync(path, 'a\nb\n'.repeat(1000))
  expect(alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
  const doc = core.Doc.open(path)
  expect(alive()).toEqual({ jobs: 0, tasks: 0, handles: 1 })
  const done = indexed(doc)
  expect(core.debugStats().jobs).toBe(1)
  await done
  await expect.poll(() => core.debugStats().jobs).toBe(0) // its thread ends just after the last event
  const read = doc.page(1, 0, 10, new core.Cancel())
  expect(core.debugStats().tasks).toBe(1)
  await read
  await expect.poll(() => core.debugStats().tasks).toBe(0)
  doc.close()
  expect(alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
})

it('the read delay takes only whole ms in [0, 10000] (plan C4)', () => {
  for (const ms of [NaN, Infinity, -1, 0.5, 10_001, 2 ** 32, 1e12])
    expect(() => core.setReadDelay(ms), String(ms)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
  for (const ms of [0, 10_000]) core.setReadDelay(ms)
})

it('plan C5: a cancelled read stops within the chunk read under way, and reads no other', async () => {
  const DELAY = 200
  // Six lines of 1 MiB + 100 bytes: each line of a page ends in the next chunk, so a page of four reads four new
  // chunks (the first one is read at open, before the delay is set).
  const path = join(dir, 'long.txt')
  writeFileSync(path, Array.from({ length: 6 }, (_, i) => String(i).repeat((1 << 20) + 100)).join('\n'))
  const read = async (cancelAfter?: number) => {
    const doc = core.Doc.open(path)
    await indexed(doc)
    core.setReadDelay(DELAY)
    const cancel = new core.Cancel()
    const start = performance.now()
    const ended = ending(doc.page(1, 0, 4, cancel))
    let cancelled = NaN
    if (cancelAfter !== undefined) {
      await new Promise((ok) => setTimeout(ok, cancelAfter))
      cancelled = performance.now()
      cancel.cancel()
    }
    const code = await ended
    const end = performance.now()
    const { delayMs } = core.debugStats() // this read's own slowest: setReadDelay, above and just below, starts it over
    core.setReadDelay(0)
    doc.close()
    return { code, total: end - start, afterCancel: end - cancelled, delayMs }
  }
  const whole = await read()
  expect(whole.code).toBe('resolved')
  expect(whole.total).toBeGreaterThanOrEqual(4 * DELAY - 20) // four chunk reads (Windows' timers run a little early)
  // The stats keep the slowest single delay: at least the one asked for, and less than the page's four.
  expect(whole.delayMs).toBeGreaterThanOrEqual(DELAY - 20)
  expect(whole.delayMs).toBeLessThan(whole.total)
  const cut = await read(1.5 * DELAY) // during the second
  console.log(`a page of four chunk reads: ${whole.total.toFixed(0)} ms; cancelled during the second, it ended ${cut.afterCancel.toFixed(0)} ms later (its slowest delay ${cut.delayMs.toFixed(0)} ms)`)
  expect(cut.code).toBe('Cancelled')
  // The rest of the read under way, and no other: under one of its delays, as long as its slowest took here, plus the
  // e2e test's 50 ms for the read, hash and resolve after the sleep. On the macOS runner four 200 ms delays took
  // 903-1086 ms, and in run 40072658390 this came 197 ms after the cancel (plan §7).
  expect(cut.afterCancel).toBeLessThan(cut.delayMs + 50)
})
