// Plan C5 on the test-hooks build: with every chunk read from disk delayed, jump far every frame for 2 s. The lens
// keeps at most 2 page requests out, cancels each one the view leaves behind, and every cancel that finds its read
// running ends it `Cancelled` within one chunk read. Then the final view's page arrives, and no read is left running.
import { type Page, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, type TestHooks, debugStats, finish, fixture, launch, lifecycle, test, visibleRows, waitIndexed, waitOpen } from './app'

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

  // The 2 s of jumps are 2 s of frames. On Linux CI under xvfb an idle page can go seconds without one: in run
  // 40064294325 the loop's first frame came 2.7 s in, with no long task. So first wait for frames to come steadily.
  const steadyAfter = await win.evaluate(
    () =>
      new Promise<number>((done) => {
        const t0 = performance.now()
        let [last, steady] = [t0, 0]
        const frame = (now: number) => {
          steady = now - last < 100 ? steady + 1 : 0
          last = now
          if (steady >= 3) done(performance.now() - t0)
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
  )
  const frames = await win.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('.vl-scroller')!
    const max = el.scrollHeight - el.clientHeight
    const until = performance.now() + 2000
    let n = 0
    await new Promise<void>((done) => {
      const jump = () => {
        el.scrollTop = Math.random() * max // a scrollbar jump: logical mode maps it across the whole file
        n++
        if (performance.now() < until) requestAnimationFrame(jump)
        else done()
      }
      requestAnimationFrame(jump)
    })
    return n
  })

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
    `frames came steadily ${steadyAfter.toFixed(0)} ms after the index was done; ${frames} jumps: at most ${maxPendingPages} page requests out; ${aborts} cancelled by the lens, ${stats.cancels} found their read ` +
      `running, ${stats.cancelled} of those ended Cancelled, the slowest ${stats.cancelMs.toFixed(1)} ms after its cancel ` +
      `(a chunk read waits ${DELAY} ms); ${aborts - stats.cancels} had answered already`
  )
  // TEMP diagnostics (to be reverted): how long the core host's 100 ms sleeps really took, the delivery to its JS
  // thread, the sleeping thread's QoS, and the same 100 ms wait timed here and in main, for comparison.
  console.log(`TEMP stats ${JSON.stringify(stats)}`)
  const waits = () => {
    const cell = new Int32Array(new SharedArrayBuffer(4))
    return Array.from({ length: 5 }, () => {
      const t = performance.now()
      Atomics.wait(cell, 0, 0, 100)
      return Math.round(performance.now() - t)
    })
  }
  const inMain = await l.app.evaluate(waits).then((w) => w.join(', '), (e: unknown) => String(e))
  console.log(`TEMP 100 ms waits: runner ${waits().join(', ')}; main ${inMain}`)
  if (process.platform === 'darwin') {
    const core = lifecycle(l.userData).find((r) => r.event === 'utility-spawn')!.utilityPid as number
    const ps = spawnSync('ps', ['-M', '-p', `${core},${l.pid},${process.pid}`], { encoding: 'utf8' })
    console.log(`TEMP threads of the core host ${core}, main ${l.pid} and the runner ${process.pid}:\n${ps.stdout}${ps.stderr}`)
  }
  expect(maxPendingPages).toBeLessThanOrEqual(2)
  expect(stats.cancels).toBeGreaterThanOrEqual(5) // the run superseded reads mid-flight
  expect(stats.cancelled).toBe(stats.cancels)
  expect(stats.cancelMs).toBeLessThan(DELAY + 50) // within the chunk read under way, not after another
  expect(stats).toMatchObject({ jobs: 0, tasks: 0, docs: 1 })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
