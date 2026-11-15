// A hand-off (Reload, Reopen, a folder or link open) freezes the shown tab's lens budget while it waits on the core.
// A share that tab asks for meanwhile is refused by the freeze, not by the ledger: no memory-budget message says it was.
import { type Page, expect } from '@playwright/test'
import { rmSync } from 'node:fs'
import { type Launched, debugStats, fixture, launch, test, waitOpen, waitRendered } from './app'

const ROWS = Array.from({ length: 60 }, (_, i) => JSON.stringify({ ts: '2026-11-01T09:00:00.000Z', type: 'info', msg: `entry ${i + 1}` })).join('\n') + '\n'
const send = (l: Launched, channel: 'open-path' | 'command', value: string) =>
  l.app.evaluate(({ BrowserWindow }, { channel, value }) => BrowserWindow.getAllWindows()[0].webContents.send(channel, value), { channel, value })
/** Holds the page core client's first `method` reply, or its error, until `release(win, name)`. Test-hooks build only. */
const hold = (win: Page, method: string, name: string) => win.evaluate(({ method, name }) => {
  const core = (window as unknown as { typoseTest: { core: { call(m: string, p: object, s?: AbortSignal): Promise<unknown> } } }).typoseTest.core
  const call = core.call.bind(core)
  let first = true
  core.call = (m, p, s) => {
    const reply = call(m, p, s)
    if (m !== method || !first) return reply
    first = false
    return reply.finally(() => new Promise<void>(done => { (window as unknown as Record<string, () => void>)[name] = done }))
  }
}, { method, name })
const held = (win: Page, name: string) => expect.poll(() => win.evaluate(name => typeof (window as unknown as Record<string, unknown>)[name], name)).toBe('function')
const release = (win: Page, name: string) => win.evaluate(name => (window as unknown as Record<string, () => void>)[name](), name)
const frames = (win: Page) => win.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))

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

test('a failed Reopen leaves the Rows it froze blank and quiet until Rows is chosen again', async () => {
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
  await release(win, 'releaseOpen')
  await expect(win.locator('.banner')).toContainText('Cannot reopen')
  await tryRows(win)
  expect(await win.locator('.structured-problem').allTextContents()).toEqual([])
  expect(await win.locator('.jsonl-entry').count()).toBe(0)
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await win.getByRole('tab', { name: 'Rows', exact: true }).click()
  await expect(win.locator('.jsonl-entry').first()).toBeVisible()
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
