// Plan C7 on the test-hooks build: the core host killed by its pid while idle, during a pending page and mid-index.
// Every pending call rejects with CoreGone within 1 s and none goes unhandled; main lives on and logs the exit; Reopen
// opens the file again, in the new session, at the same line; a second death within 60 s leaves the stopped state;
// and what the dead session sent, held back by the test hook until after Reopen, changes nothing.
import { type Page, expect } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, type Launched, type TestHooks, debugStats, finish, fixture, killCore, launch, lifecycle, runCommand, sparseFixture, stubOpenDialog, test, visibleRows, waitIndexed, waitOpen } from './app'

const hooks = (win: Page) => win.evaluate(() => (({ held, ...rest }) => ({ ...rest, held: held.length }))((window as unknown as { typoseTest: TestHooks }).typoseTest.client))
/** Holds back what `session`'s core host sends from now on, until `deliverHeld`. */
const hold = (win: Page, session: number) => win.evaluate((session) => ((window as unknown as { typoseTest: TestHooks }).typoseTest.client.holding = session), session)
const deliverHeld = (win: Page) => win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.held.splice(0).forEach((deliver) => deliver()))
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'
const sparse = join(FIXTURES, 'core-death-10gib.txt')

test.afterEach(() => rmSync(sparse, { force: true }))

/** The death of `session` was reported, and pending calls rejected, within 1 s of `at`; main lives and logged it. */
async function diedWithin1s(l: Launched, { session, at }: { session: number; at: number }): Promise<number> {
  await expect(l.win.locator('.card-message p')).toHaveText("Typose's core stopped")
  const gone = (await hooks(l.win)).gone!
  console.log(`session ${session}: CoreGone ${gone.at - at} ms after the kill, rejecting ${gone.rejected} pending call(s)`)
  expect(gone.at - at).toBeLessThan(1000)
  expect(await l.app.evaluate(() => process.pid)).toBe(l.pid)
  await expect.poll(() => lifecycle(l.userData).find((r) => r.event === 'utility-exit' && r.session === session)).toMatchObject({ code: expect.any(Number) })
  expect(lifecycle(l.userData).find((r) => r.event === 'child-process-gone')).toMatchObject({ type: 'Utility', name: 'typose-core', reason: expect.any(String) })
  return gone.rejected
}

const top = async (win: Page) => (await visibleRows(win))[0]

test('idle: Reopen opens the file again at generation 1, at the same line, in the new session; a second death within 60 s stops', async () => {
  const l = await launch({ hooks: true, file: fixture('core-death.txt', lines(5000)) })
  const { win } = l
  await waitOpen(win)
  expect(await waitIndexed(win)).toBe(5000)
  await win.locator('.vl-scroller').evaluate((el) => (el.scrollTop = 40_000)) // line 2,001 at the top
  await expect.poll(async () => (await top(win))?.text).toBe('line 2000')
  const before = await top(win)

  const first = killCore(l)
  expect(await diedWithin1s(l, first)).toBe(0) // idle: nothing was pending
  await expect(win.locator('.vl-row')).toHaveCount(0) // the cached text went with the core
  await expect(win.locator('.card-message .open-button')).toHaveText(['Reopen'])
  await win.locator('.card-message .open-button').click()
  await waitOpen(win)
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '1')
  await expect.poll(() => top(win)).toEqual(before)
  expect(lifecycle(l.userData).filter((r) => r.event === 'utility-spawn').map((r) => r.session)).toEqual([1, 2])
  expect(await debugStats(win)).toMatchObject({ docs: 1 }) // the new session's core holds it

  const second = killCore(l)
  expect(second.session).toBe(2)
  await diedWithin1s(l, second)
  await expect.poll(() => lifecycle(l.userData).find((r) => r.event === 'core-stopped')).toMatchObject({ session: 2 })
  // The stopped state: no Reopen, and no new core, for the rest of the 60 s.
  await win.waitForTimeout(2000)
  await expect(win.locator('.card-message .open-button')).toHaveCount(0)
  expect(lifecycle(l.userData).filter((r) => r.event === 'utility-spawn')).toHaveLength(2)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('during a pending page: it rejects with CoreGone within 1 s, and nothing goes unhandled', async () => {
  // Every chunk read waits 2 s, so a page outside the first chunk is surely pending when the core dies.
  const l = await launch({ hooks: true, env: { TYPOSE_TEST_READ_DELAY: '2000' }, file: fixture('core-death-pending.txt', lines(1_000_000)) })
  const { win } = l
  await waitOpen(win)
  await waitIndexed(win)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End') // the last lines are in chunk 11 of the 11.9 MB, not read yet
  await expect.poll(async () => (await debugStats(win)).tasks).toBe(1)
  const death = killCore(l)
  expect(await diedWithin1s(l, death)).toBeGreaterThanOrEqual(1)
  await win.waitForTimeout(300)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('mid-index on 10 GiB: what the dead session sent, held until after Reopen, is dropped and changes nothing', async () => {
  const l = await launch({ hooks: true, file: sparseFixture('core-death-10gib.txt', 10 * 2 ** 30, lines(2000)) })
  const { win } = l
  await waitOpen(win)
  await expect(win.locator('.card-status')).toHaveText(/^Indexing /)
  // From here, everything session 1 sends is held back: progress events, and the answer to the page asked for next.
  await hold(win, 1)
  await win.locator('.vl-scroller').evaluate((el) => (el.scrollTop = 30_000)) // line 1,501: past the first page
  await expect.poll(async () => (await hooks(win)).maxPendingPages, { message: 'the page was asked for' }).toBe(1)
  await win.waitForTimeout(500) // for its answer, and more progress, to come (and be held)
  const death = killCore(l)
  expect(await diedWithin1s(l, death)).toBeGreaterThanOrEqual(1) // the page, its answer held back
  expect((await hooks(win)).held).toBeGreaterThanOrEqual(2) // the new session's messages come at once
  await win.locator('.card-message .open-button').click()
  await waitOpen(win)
  const indexed = Date.now()
  await waitIndexed(win, 60_000)
  console.log(`Reopen's index of 10 GiB took ${Date.now() - indexed} ms`)
  const view = { status: await win.locator('.card-status').textContent(), rows: await visibleRows(win) }
  expect(view.rows[0].line).toBe(1501)
  // Session 1's held messages arrive now, after Reopen, and are dropped: the view is unchanged.
  await deliverHeld(win)
  expect((await hooks(win)).dropped).toEqual(expect.arrayContaining(['event', 'response']))
  await win.waitForTimeout(200)
  expect({ status: await win.locator('.card-status').textContent(), rows: await visibleRows(win) }).toEqual(view)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a second death during a Reopen keeps its line: once 60 s have passed, the offered Reopen goes back to it', async () => {
  test.setTimeout(3 * 60_000)
  // Every chunk read waits 1.5 s, so a Reopen's open (its first chunk) is surely pending when the core dies again.
  const l = await launch({ hooks: true, env: { TYPOSE_TEST_READ_DELAY: '1500' }, file: fixture('core-death-reopen.txt', lines(5000)) })
  const { win } = l
  await waitOpen(win)
  expect(await waitIndexed(win)).toBe(5000)
  await win.locator('.vl-scroller').evaluate((el) => (el.scrollTop = 40_000)) // line 2,001 at the top
  await expect.poll(async () => (await top(win))?.text).toBe('line 2000')
  const before = await top(win)

  await diedWithin1s(l, killCore(l))
  await win.locator('.card-message .open-button').click() // Reopen, at line 2,001
  await expect(win.locator('.card-status')).toHaveText('Opening…') // its open waits on its first chunk read
  await diedWithin1s(l, killCore(l)) // the second death, within 60 s: the stopped state
  await expect(win.locator('.card-message .open-button')).toHaveCount(0)
  // Proposal 2 (plan §7): once 60 s have passed since the last respawn, main respawns the core and Reopen is offered.
  await expect(win.locator('.card-message .open-button')).toHaveText(['Reopen'], { timeout: 70_000 })
  expect(lifecycle(l.userData).filter((r) => r.event === 'utility-spawn').map((r) => r.session)).toEqual([1, 2, 3])
  await win.locator('.card-message .open-button').click()
  await waitOpen(win)
  await expect.poll(() => top(win), { timeout: 15_000 }).toEqual(before)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Browse… while the core is stopped acknowledges the queued file and opens a new tab after restart', async () => {
  test.skip(process.platform === 'darwin', 'macOS has the native menu bar instead of ☰')
  test.setTimeout(3 * 60_000)
  const l = await launch({ hooks: true, file: fixture('core-death-first.txt', lines(50)) })
  const { app, win } = l
  await waitOpen(win)
  await stubOpenDialog(app, fixture('core-death-chosen.txt', 'the chosen file\n'))
  await diedWithin1s(l, killCore(l))
  await expect(win.locator('.card-message .open-button')).toHaveText(['Reopen']) // respawned at once
  killCore(l) // a second death within 60 s: stopped, with nothing offered
  await expect(win.locator('.card-message .open-button')).toHaveCount(0)
  await runCommand(win, 'Browse…')
  // The lost document keeps its tab. The explicit manual request is acknowledged, then opens when the core returns.
  await expect(win.locator('.card-name')).toHaveText('core-death-first.txt')
  await expect(win.locator('.card-message p')).toHaveText("Typose's core stopped")
  await expect(win.locator('.banner')).toHaveText('Queued until the core restarts: core-death-chosen.txt')
  await expect(win.locator('.card-name')).toHaveText('core-death-chosen.txt', { timeout: 70_000 })
  await waitOpen(win)
  await expect(win.locator('.file-tab-name')).toHaveText(['core-death-first.txt', 'core-death-chosen.txt'])
  expect((await visibleRows(win))[0]).toEqual({ line: 1, text: 'the chosen file' })
  expect(await app.evaluate(() => (globalThis as { dialogCalls?: number }).dialogCalls)).toBe(1)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
