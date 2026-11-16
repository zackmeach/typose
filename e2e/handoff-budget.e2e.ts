// A hand-off (Reload, Reopen, a folder or link open) freezes the shown tab's lens budget while it waits on the core.
// A share that tab asks for meanwhile is refused by the freeze, not by the ledger: no memory-budget message says it was.
import { type Page, expect } from '@playwright/test'
import { rmSync } from 'node:fs'
import { type Launched, debugStats, fixture, launch, test, waitOpen, waitRendered } from './app'

const ROWS = Array.from({ length: 60 }, (_, i) => JSON.stringify({ ts: '2026-11-01T09:00:00.000Z', type: 'info', msg: `entry ${i + 1}` })).join('\n') + '\n'
const send = (l: Launched, channel: 'open-path' | 'command', value: string) =>
  l.app.evaluate(({ BrowserWindow }, { channel, value }) => BrowserWindow.getAllWindows()[0].webContents.send(channel, value), { channel, value })
/** Holds the page core client's first `method` reply, or its error (or, with `request`, the request before the core
 *  sees it), until `release(win, name)`. Test-hooks build only. */
const hold = (win: Page, method: string, name: string, request = false) => win.evaluate(({ method, name, request }) => {
  const core = (window as unknown as { typoseTest: { core: { call(m: string, p: object, s?: AbortSignal): Promise<unknown> } } }).typoseTest.core
  const call = core.call.bind(core)
  let first = true
  core.call = (m, p, s) => {
    if (m !== method || !first) return call(m, p, s)
    first = false
    const held = () => new Promise<void>(done => { (window as unknown as Record<string, () => void>)[name] = done })
    return request ? held().then(() => call(m, p, s)) : call(m, p, s).finally(held)
  }
}, { method, name, request })
/** Holds the first `reserve` the core refuses until `release(win, name)`. Test-hooks build only. */
const holdRefusal = (win: Page, name: string) => win.evaluate(name => {
  const core = (window as unknown as { typoseTest: { core: { call(m: string, p: object, s?: AbortSignal): Promise<unknown> } } }).typoseTest.core
  const call = core.call.bind(core)
  let first = true
  core.call = async (m, p, s) => {
    const reply = await call(m, p, s)
    if (m === 'reserve' && reply === false && first) {
      first = false
      await new Promise<void>(done => { (window as unknown as Record<string, () => void>)[name] = done })
    }
    return reply
  }
}, name)
const held = (win: Page, name: string) => expect.poll(() => win.evaluate(name => typeof (window as unknown as Record<string, unknown>)[name], name)).toBe('function')
const release = (win: Page, name: string) => win.evaluate(name => (window as unknown as Record<string, () => void>)[name](), name)
const frames = (win: Page) => win.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
/** What the core holds reserved for the renderer's views. */
const viewBytes = async (win: Page) => (await debugStats(win)).surfaces!.bytes

/** Opens a file called `name`, closes its tab and deletes the file, so Reopen's open of it fails. */
async function closedAndDeleted(l: Launched, name: string): Promise<void> {
  const gone = fixture(name, 'Closed, then deleted\n')
  await expect(l.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await send(l, 'open-path', gone)
  await waitOpen(l.win)
  await l.win.getByRole('button', { name: `Close ${name}`, exact: true }).click()
  await expect(l.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  rmSync(gone)
}

/** Rows' keyboard and scroll paths render rows; none may run on a grid share that wasn't granted. */
async function tryRows(win: Page): Promise<void> {
  await win.locator('.structured-view').focus()
  await win.keyboard.press('End')
  await win.locator('.structured-view').evaluate(view => view.dispatchEvent(new Event('scroll')))
  await frames(win)
}

test('Reload while Rows starts: its frozen grid share is no memory-budget message', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await hold(win, 'structuredBuild', 'releaseBuild')
  await hold(win, 'reload', 'releaseReload')
  await send(l, 'open-path', fixture('handoff-reload.jsonl', ROWS))
  await waitOpen(win)
  await held(win, 'releaseBuild')
  await send(l, 'command', 'reload')
  await held(win, 'releaseReload')
  // Rows mounts, and asks for its grid share, while Reload holds the budget frozen.
  await release(win, 'releaseBuild')
  await expect(win.locator('[data-lens="rows"]')).toBeVisible()
  await frames(win)
  expect(await win.locator('.banner, .structured-problem').allTextContents()).toEqual([])
  await release(win, 'releaseReload')
  await expect(win.locator('.jsonl-entry').first()).toBeVisible()
  expect(await win.locator('.banner').allTextContents()).toEqual([])
  expect(l.pageErrors).toEqual([])
})

test('Rows that a failed Reopen froze shows nothing while unpaid, then starts again with its grid share', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await closedAndDeleted(l, 'handoff-gone.txt')
  await hold(win, 'structuredBuild', 'releaseBuild')
  await send(l, 'open-path', fixture('handoff-failed.jsonl', ROWS))
  await waitOpen(win)
  await held(win, 'releaseBuild')
  await hold(win, 'open', 'releaseOpen')
  await send(l, 'command', 'reopen-tab')
  await held(win, 'releaseOpen')
  await release(win, 'releaseBuild')
  await expect(win.locator('[data-lens="rows"]')).toBeVisible()
  await tryRows(win)
  expect(await win.locator('.structured-problem').allTextContents()).toEqual([])
  expect(await win.locator('.jsonl-entry').count()).toBe(0)
  const unpaid = await viewBytes(win)
  // The Reopen fails and thaws the budget: Rows asks again, through the ledger, and renders once it's granted.
  await release(win, 'releaseOpen')
  await expect(win.locator('.banner')).toContainText('Cannot reopen')
  await expect(win.locator('.jsonl-entry').first()).toBeVisible()
  expect(await viewBytes(win) - unpaid).toBeGreaterThanOrEqual(32 << 20)
  expect(await win.locator('.structured-problem').allTextContents()).toEqual([])
  expect(l.pageErrors).toEqual([])
})

test('a ledger refusal that lands inside a freeze says the budget is full once the failed hand-off thaws', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await closedAndDeleted(l, 'handoff-gone-late.txt')
  await hold(win, 'structuredBuild', 'releaseBuild')
  await send(l, 'open-path', fixture('handoff-late-refusal.jsonl', ROWS))
  await waitOpen(win)
  await held(win, 'releaseBuild')
  const { ledger } = await debugStats(win)
  // Room for less than the grid share's 32 MiB: the core refuses it, and that reply is held.
  const tight = async () => debugStats(win, { limit: (await debugStats(win)).ledger.used + (20 << 20) })
  await tight()
  await holdRefusal(win, 'releaseRefusal')
  await release(win, 'releaseBuild')
  await held(win, 'releaseRefusal')
  // Reopen's workspace precharge needs room; the ask after the thaw gets none.
  await debugStats(win, { limit: ledger.limit })
  await hold(win, 'open', 'releaseOpen')
  await send(l, 'command', 'reopen-tab')
  await held(win, 'releaseOpen')
  await tight()
  await release(win, 'releaseRefusal')
  await frames(win)
  await release(win, 'releaseOpen')
  await expect(win.locator('.banner')).toContainText('Cannot reopen')
  await expect(win.locator('.structured-problem')).toHaveText('Error: Structured view unavailable · memory budget is full')
  await tryRows(win)
  expect(await win.locator('.jsonl-entry').count()).toBe(0)
  await debugStats(win, { limit: ledger.limit })
  expect(l.pageErrors).toEqual([])
})

test('a grid share the ledger refuses still says the budget is full, and Rows renders nothing on it', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await hold(win, 'structuredBuild', 'releaseBuild')
  await send(l, 'open-path', fixture('handoff-refused.jsonl', ROWS))
  await waitOpen(win)
  await held(win, 'releaseBuild')
  const { ledger } = await debugStats(win)
  await debugStats(win, { limit: ledger.used })
  await release(win, 'releaseBuild')
  await expect(win.locator('.banner')).toHaveText('Error: Structured view unavailable · memory budget is full')
  await expect(win.locator('.structured-problem')).toHaveText('Error: Structured view unavailable · memory budget is full')
  await tryRows(win)
  expect(await win.locator('.jsonl-entry').count()).toBe(0)
  await debugStats(win, { limit: ledger.limit })
  expect(l.pageErrors).toEqual([])
})

test('a failed Reopen leaves the Grid it froze without a memory-budget message', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await closedAndDeleted(l, 'handoff-gone-csv.txt')
  await hold(win, 'csvConfigure', 'releaseCsv')
  await send(l, 'open-path', fixture('handoff-failed.csv', 'name,count\n' + Array.from({ length: 40 }, (_, i) => `row ${i},${i}\n`).join('')))
  await waitOpen(win)
  await held(win, 'releaseCsv')
  await hold(win, 'open', 'releaseOpen')
  await send(l, 'command', 'reopen-tab')
  await held(win, 'releaseOpen')
  await release(win, 'releaseCsv')
  await expect(win.locator('[data-lens="grid"]')).toBeVisible()
  await release(win, 'releaseOpen')
  await expect(win.locator('.banner')).toContainText('Cannot reopen')
  await frames(win)
  expect(await win.locator('.csv-status').textContent()).not.toContain('memory budget')
  expect(l.pageErrors).toEqual([])
})

test('Rendered that a hand-off froze is not turned off for memory: its tab renders when selected again', async () => {
  const next = fixture('handoff-next.txt', 'Reopened\n')
  const l = await launch({ hooks: true, file: next })
  const { win } = l
  await waitOpen(win)
  await win.getByRole('button', { name: 'Close handoff-next.txt', exact: true }).click()
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await hold(win, 'render', 'releaseRender')
  await send(l, 'open-path', fixture('handoff.md', '# Handoff\n\nA paragraph.\n'))
  await waitOpen(win)
  await held(win, 'releaseRender')
  await hold(win, 'open', 'releaseOpen')
  await send(l, 'command', 'reopen-tab')
  await held(win, 'releaseOpen')
  // Rendered's build arrives, and asks for its share, while Reopen holds the budget frozen.
  await release(win, 'releaseRender')
  await frames(win)
  await release(win, 'releaseOpen')
  await expect(win.locator('.card-name')).toHaveText('handoff-next.txt')
  await waitOpen(win)
  await win.getByRole('tab', { name: 'handoff.md', exact: true }).click()
  await expect(win.locator('.lens-tab-tip[title]')).toHaveCount(0)
  await waitRendered(win)
  expect(l.pageErrors).toEqual([])
})

test('Rendered that a failed hand-off froze finishes its build, and its tab shows it without Reload', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await closedAndDeleted(l, 'handoff-gone-md.txt')
  await hold(win, 'render', 'releaseRender')
  await send(l, 'open-path', fixture('handoff-failed.md', '# Handoff\n\nA paragraph.\n'))
  await waitOpen(win)
  await held(win, 'releaseRender')
  await hold(win, 'open', 'releaseOpen')
  await send(l, 'command', 'reopen-tab')
  await held(win, 'releaseOpen')
  await release(win, 'releaseRender')
  await frames(win)
  await release(win, 'releaseOpen')
  await expect(win.locator('.banner')).toContainText('Cannot reopen')
  await expect(win.locator('.card-status')).not.toHaveText('Rendering…')
  await expect(win.locator('.lens-tab-tip[title]')).toHaveCount(0)
  await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
  await waitRendered(win, 10_000)
  expect(l.pageErrors).toEqual([])
})

test('a Reopen that fails during a Reload leaves the Reload\'s freeze on: nothing is granted or rendered until it lands', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await closedAndDeleted(l, 'handoff-gone-overlap.txt')
  await hold(win, 'structuredBuild', 'releaseBuild')
  await hold(win, 'reload', 'releaseReload', true)
  await send(l, 'open-path', fixture('handoff-overlap.jsonl', ROWS))
  await waitOpen(win)
  await held(win, 'releaseBuild')
  // Reload freezes the budget and its request waits in the page, so the core hasn't started it.
  await send(l, 'command', 'reload')
  await held(win, 'releaseReload')
  await hold(win, 'open', 'releaseOpen')
  await send(l, 'command', 'reopen-tab')
  await held(win, 'releaseOpen')
  await release(win, 'releaseBuild')
  await expect(win.locator('[data-lens="rows"]')).toBeVisible()
  await frames(win)
  const frozen = await viewBytes(win)
  // The Reopen fails and ends its own freeze. The Reload's is still out: no share is granted, nothing renders.
  await release(win, 'releaseOpen')
  await expect(win.locator('.banner')).toContainText('Cannot reopen')
  expect(await viewBytes(win)).toBe(frozen)
  await tryRows(win)
  expect(await win.locator('.jsonl-entry').count()).toBe(0)
  expect(await viewBytes(win)).toBe(frozen)
  // The Reload lands. Its Raw settles first, then its Rows renders on a granted grid share. With the first build done
  // (no more polls of it), the next structuredBuild held is the new generation's.
  await expect(win.locator('.card-status')).toHaveText('60 lines · 60 parsed · 0 failed · 0 blank')
  await hold(win, 'structuredBuild', 'releaseBuild2')
  await release(win, 'releaseReload')
  await held(win, 'releaseBuild2')
  await waitOpen(win)
  let raw = -1
  await expect.poll(async () => { const now = await viewBytes(win), same = now === raw; raw = now; return same }).toBe(true)
  await release(win, 'releaseBuild2')
  await expect(win.locator('.jsonl-entry').first()).toBeVisible()
  expect(await viewBytes(win) - raw).toBeGreaterThanOrEqual(32 << 20)
  expect(await win.locator('.structured-problem').allTextContents()).toEqual([])
  expect(l.pageErrors).toEqual([])
})
