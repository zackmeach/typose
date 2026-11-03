// Plan C6 on the test-hooks build: what close and a failure release, read from the core's debug stats, the ledger's
// included (plan C1). With readers and history closed, only the pool and retained host table capacities remain. The
// 10 GiB fixture is sparse: 2,000 lines of text, then zeros the disk doesn't store but the index still reads.
import { expect } from '@playwright/test'
import { rmSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, type TestHooks, debugStats, expectReleasedDocuments, finish, launch, sparseFixture, test, waitOpen } from './app'

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

/** Runs entirely in the page: close, then time how long the core takes to release everything. */
const closeAndWait = async () => {
  const { core, app } = (window as unknown as { typoseTest: TestHooks }).typoseTest
  const t0 = performance.now()
  app.close!()
  for (;;) {
    const s = (await core.call('debugStats', {})) as { jobs: number; tasks: number; handles: number; docs: number }
    if (s.jobs + s.tasks + s.handles + s.docs === 0) return performance.now() - t0
    if (performance.now() - t0 > 5000) throw new Error(`still held after 5 s: ${JSON.stringify(s)}`)
  }
}

test('close mid-index on 10 GiB: the job stops within 50 ms, and 0 jobs, 0 tasks and 0 handles remain', async () => {
  const l = await midIndex()
  // From App's own close (the card leaves Raw, which closes the document) until the core holds nothing.
  const stoppedMs = await l.win.evaluate(closeAndWait)
  console.log(`close mid-index: everything released ${stoppedMs.toFixed(1)} ms after close`)
  expect(stoppedMs).toBeLessThan(50)
  expect(await debugStats(l.win)).toMatchObject({ jobs: 0, tasks: 0, handles: 0, docs: 0 })
  // The ledger is back to its baseline, byte for byte: the document's charges and the lens's cache are released.
  await expectReleasedDocuments(l.win)
  await expect(l.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
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
  // The ledger: the baseline, the frozen lens's cache, and exactly the document's retained charges, as itemized.
  const frozen = await debugStats(l.win)
  const { hashes, checkpoints, cache, metadata, total } = frozen.charges[1]
  expect(hashes + checkpoints + cache + metadata).toBe(total)
  expect(frozen.ledger.used).toBe(frozen.ledger.pool + frozen.ledger.rendererCache + total)
  console.log(`frozen: ${total} bytes retained (${hashes} hashes, ${checkpoints} checkpoints, ${cache} cache, ${metadata} metadata)`)
  await l.win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.app.close!())
  await expect.poll(() => debugStats(l.win)).toMatchObject({ jobs: 0, tasks: 0, handles: 0, docs: 0 })
  await expectReleasedDocuments(l.win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a double Reload mid-index on 10 GiB keeps one index job, and close then leaves 0 jobs and 0 handles within 50 ms', async () => {
  const l = await midIndex()
  // Two Reloads in one task, so the second reaches the core host while the first's first page is being read. They're
  // sent from the page's core client: App starts no Reload while one is under way (plan C1).
  await l.win.evaluate(() => {
    const { core } = (window as unknown as { typoseTest: TestHooks }).typoseTest
    const call = core.call.bind(core)
    core.call = (method, params) => {
      if (method !== 'reload') return call(method, params)
      core.call = call
      const first = call(method, params), second = call(method, params)
      const result = (reply: Promise<unknown>) => reply.then(r => (r as { gen: number }).gen, (e: { code: string }) => e.code)
      const state = window as unknown as { doubleReload: Promise<unknown[]> }
      state.doubleReload = Promise.all([result(first), result(second)])
      return second
    }
  })
  await l.win.keyboard.press('ControlOrMeta+r')
  await l.win.waitForFunction(() => 'doubleReload' in window)
  const replies = await l.win.evaluate(() => (window as unknown as { doubleReload: Promise<unknown[]> }).doubleReload)
  // The first ends Stale, or Frozen when generation 3 supersedes its first page's read; the second gives generation 3.
  expect(['Stale', 'Frozen']).toContain(replies[0])
  expect(replies[1]).toBe(3)
  // While generation 3 indexes (1–3 s), at most one job runs: the superseded generations' end within a block.
  await l.win.waitForTimeout(100)
  for (let i = 0; i < 5; i++) {
    const s = await debugStats(l.win)
    expect(s.jobs, JSON.stringify(s)).toBeLessThanOrEqual(1)
    expect(s).toMatchObject({ handles: 1, docs: 1 })
    await l.win.waitForTimeout(50)
  }
  expect((await debugStats(l.win)).jobs).toBe(1) // still mid-index: close stops it
  const releasedMs = await l.win.evaluate(closeAndWait)
  console.log(`double Reload, then close: everything released ${releasedMs.toFixed(1)} ms after close`)
  expect(releasedMs).toBeLessThan(50)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
