// Plan C6 on the test-hooks build: what close and a failure release, read from the core's debug stats. The 10 GiB
// fixture is sparse: 2,000 lines of text, then zeros the disk doesn't store but the index still reads.
import { expect } from '@playwright/test'
import { rmSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, type TestHooks, debugStats, finish, launch, sparseFixture, test, waitOpen } from './app'

const GIB = 2 ** 30
const HEAD = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n'
const path = join(FIXTURES, 'close-10gib.txt')

test.afterEach(() => rmSync(path, { force: true }))

/** Opens the 10 GiB fixture and waits until its index job is running. */
async function midIndex() {
  const l = await launch({ hooks: true, file: sparseFixture('close-10gib.txt', 10 * GIB, HEAD) })
  await waitOpen(l.win)
  await expect(l.win.locator('.card-status')).toHaveText(/^Indexing /)
  expect(await debugStats(l.win)).toMatchObject({ jobs: 1, handles: 1, docs: 1 })
  return l
}

test('close mid-index on 10 GiB: the job stops within 50 ms, and 0 jobs, 0 tasks and 0 handles remain', async () => {
  const l = await midIndex()
  // From App's own close (the card leaves Raw, which closes the document) until the core holds nothing.
  const stoppedMs = await l.win.evaluate(async () => {
    const { core, app } = (window as unknown as { typoseTest: TestHooks }).typoseTest
    const t0 = performance.now()
    app.close!()
    for (;;) {
      const s = (await core.call('debugStats', {})) as { jobs: number; tasks: number; handles: number; docs: number }
      if (s.jobs + s.tasks + s.handles + s.docs === 0) return performance.now() - t0
      if (performance.now() - t0 > 5000) throw new Error(`still held after 5 s: ${JSON.stringify(s)}`)
    }
  })
  console.log(`close mid-index: everything released ${stoppedMs.toFixed(1)} ms after close`)
  expect(stoppedMs).toBeLessThan(50)
  expect(await debugStats(l.win)).toMatchObject({ jobs: 0, tasks: 0, handles: 0, docs: 0 })
  await expect(l.win.locator('.open-button')).toHaveText('Open file…') // the empty card
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a truncation mid-index freezes the document: 0 jobs and 0 tasks remain, it keeps its handle, and close releases it', async () => {
  const l = await midIndex()
  truncateSync(path, 2 ** 20) // the index's next read runs past the end
  await expect(l.win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await expect(l.win.locator('.card-status')).toHaveText(/^Indexing stopped at /)
  // The document keeps what it holds (its handle, here) until close; the job and any reads are gone.
  await expect.poll(() => debugStats(l.win)).toMatchObject({ jobs: 0, tasks: 0, handles: 1, docs: 1 })
  await l.win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.app.close!())
  await expect.poll(() => debugStats(l.win)).toMatchObject({ jobs: 0, tasks: 0, handles: 0, docs: 0 })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
