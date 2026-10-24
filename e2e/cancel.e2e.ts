// Plan C5 on the test-hooks build: with every chunk read from disk delayed, jump far every frame for 2 s. The lens
// keeps at most 2 page requests out, cancels each one the view leaves behind, and every cancel that finds its read
// running ends it `Cancelled` within one chunk read. Then the final view's page arrives, and no read is left running.
import { type Page, expect } from '@playwright/test'
import { closeSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, type TestHooks, debugStats, finish, fixture, launch, test, visibleRows, waitIndexed, waitOpen } from './app'

/** The delay before each chunk read from disk (TYPOSE_TEST_READ_DELAY). */
const DELAY = 100
/** 256 MiB of 100-byte lines, so a far jump almost always lands in a chunk the core hasn't cached (it keeps 64). */
const LINES = Math.floor((256 << 20) / 100)
const text = (line: number) => `${String(line).padStart(10, '0')} ${'x'.repeat(88)}`
const path = join(FIXTURES, 'cancel-256mib.txt')

test.afterEach(() => rmSync(path, { force: true }))

function writeFixture(): string {
  fixture('cancel-256mib.txt', '')
  const fd = openSync(path, 'w')
  for (let start = 0; start < LINES; start += 10_000) {
    const end = Math.min(LINES, start + 10_000)
    writeSync(fd, Array.from({ length: end - start }, (_, k) => `${text(start + k)}\n`).join(''))
  }
  closeSync(fd)
  return path
}

const client = (win: Page) =>
  win.evaluate(() => {
    const { maxPendingPages, aborts } = (window as unknown as { typoseTest: TestHooks }).typoseTest.client
    return { maxPendingPages, aborts }
  })

test('jump far every frame for 2 s: ≤ 2 requests out, superseded reads end Cancelled within a chunk read, the last page arrives, 0 tasks', async () => {
  test.setTimeout(3 * 60_000)
  const l = await launch({ hooks: true, env: { TYPOSE_TEST_READ_DELAY: String(DELAY) }, file: writeFixture() })
  const { win } = l
  await waitOpen(win)
  expect(await waitIndexed(win)).toBe(LINES)

  // TEMP DIAGNOSTIC (to be reverted): per-frame timestamps, long tasks and visibility, for Linux CI.
  const diag = await win.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('.vl-scroller')!
    const max = el.scrollHeight - el.clientHeight
    const t0 = performance.now()
    const until = t0 + 2000
    const at: number[] = []
    const longs: string[] = []
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longs.push(`${Math.round(e.startTime - t0)}+${Math.round(e.duration)}`)
    })
    po.observe({ type: 'longtask' })
    let n = 0
    await new Promise<void>((done) => {
      const jump = () => {
        at.push(Math.round(performance.now() - t0))
        el.scrollTop = Math.random() * max // a scrollbar jump: logical mode maps it across the whole file
        n++
        if (performance.now() < until) requestAnimationFrame(jump)
        else done()
      }
      requestAnimationFrame(jump)
    })
    await new Promise((ok) => setTimeout(ok, 500))
    po.disconnect()
    return { n, at, longs, visibility: document.visibilityState, focus: document.hasFocus(), max, total: Math.round(performance.now() - t0) }
  })
  console.log(`TEMP jump diag: ${JSON.stringify(diag)}`)
  const frames = diag.n

  // The view settles where the last jump left it: every row on screen shows its own line.
  await expect
    .poll(async () => {
      const rows = await visibleRows(win)
      return rows.length > 10 && rows.every((r) => r.text === text(r.line - 1))
    })
    .toBe(true)
  await expect.poll(async () => (await debugStats(win)).tasks).toBe(0)
  const stats = await debugStats(win)
  const { maxPendingPages, aborts } = await client(win)
  console.log(
    `${frames} jumps: at most ${maxPendingPages} page requests out; ${aborts} cancelled by the lens, ${stats.cancels} found their read ` +
      `running, ${stats.cancelled} of those ended Cancelled, the slowest ${stats.cancelMs.toFixed(1)} ms after its cancel ` +
      `(a chunk read waits ${DELAY} ms); ${aborts - stats.cancels} had answered already`
  )
  expect(maxPendingPages).toBeLessThanOrEqual(2)
  expect(stats.cancels).toBeGreaterThanOrEqual(5) // the run superseded reads mid-flight
  expect(stats.cancelled).toBe(stats.cancels)
  expect(stats.cancelMs).toBeLessThan(DELAY + 50) // within the chunk read under way, not after another
  expect(stats).toMatchObject({ jobs: 0, tasks: 0, docs: 1 })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
