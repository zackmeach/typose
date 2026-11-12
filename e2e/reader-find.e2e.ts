import { expect } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, debugStats, finish, fixture, launch, test } from './app'
import { closePackaged, launchPackaged, unrequested } from './packaged'
import { query, ready } from './find-ui'

test('packaged Raw Find reaches a hit beyond the long-line preview and wraps in both directions', async () => {
  const file = fixture('find-raw-far.txt', 'a'.repeat((1 << 20) + 43) + 'North Pier\nnext line\nnorth pier again\n')
  const live = await launchPackaged({ file, cdp: true })
  const page = live.page!
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  const card = page.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('.vl-scroller')).toBeVisible(ready)
  const bar = await query(page, card, 'north pier')
  const count = bar.getByRole('status')
  await expect(count).toHaveText('1 of 2', ready)
  await expect(card.getByText('North Pier', { exact: true })).toBeInViewport()
  await page.keyboard.press('F3')
  await expect(count).toHaveText('2 of 2')
  await page.keyboard.press('F3')
  await expect(count).toHaveText('1 of 2')
  await page.keyboard.press('Shift+F3')
  await expect(count).toHaveText('2 of 2')
  await bar.getByRole('checkbox', { name: 'Match case' }).check()
  await expect(count).toHaveText('1 of 1', ready)
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  expect(errors).toEqual([])
  const exit = await closePackaged(live)
  expect(unrequested(live, exit)).toEqual([])
})

test('packaged Rendered Find reaches visible text across markup and searches a link preview independently', async () => {
  mkdirSync(FIXTURES, { recursive: true })
  const directory = mkdtempSync(join(FIXTURES, 'find-rendered-'))
  const file = join(directory, 'source.md')
  const filler = Array.from({ length: 150 }, (_, i) => 'Paragraph ' + i + ' has no match.')
  writeFileSync(file, ['# Source', '[Read the appendix](private-target.md)', ...filler, 'The north\n**pier** &amp; wharf.'].join('\n\n'))
  writeFileSync(join(directory, 'private-target.md'), '# Appendix\n\nA different **coastal** project.\n')
  try {
    const live = await launchPackaged({ file, cdp: true, args: ['--disable-renderer-accessibility'] })
    const page = live.page!
    const card = page.getByRole('region', { name: 'Reader card 1' })
    const destination = card.getByText('The north pier & wharf.', { exact: true })
    const sourceLink = card.getByRole('link', { name: 'Read the appendix' })
    await expect(sourceLink).toBeVisible(ready)
    const bar = await query(page, card, 'north pier & wharf')
    await expect(bar.getByRole('status')).toHaveText('1 of 1', ready)
    await expect(destination).toBeInViewport()
    await bar.getByRole('searchbox').fill('private-target.md')
    await expect(bar.getByRole('status')).toHaveText('No matches')
    await page.keyboard.press('Escape')
    if (process.platform === 'win32') { // local file links, and so link previews, are Windows-only for now
      await sourceLink.click()
      const preview = page.getByRole('dialog', { name: 'Link preview' })
      await expect(preview.getByRole('heading', { name: 'Appendix' })).toBeVisible()
      const previewBar = await query(page, preview, 'different coastal project')
      await expect(previewBar.getByRole('status')).toHaveText('1 of 1')
      await page.keyboard.press('Escape')
      await expect(previewBar).toHaveCount(0)
      await expect(preview).toBeVisible()
      await expect(card.getByRole('search')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)
    }
    const exit = await closePackaged(live)
    expect(unrequested(live, exit)).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('replacing an incomplete Raw search in a 101 MiB file shows only the new query', async () => {
  mkdirSync(FIXTURES, { recursive: true })
  const directory = mkdtempSync(join(FIXTURES, 'find-large-'))
  const file = join(directory, 'log.txt')
  writeFileSync(file, 'north\n'.repeat(1000))
  const chunk = Buffer.from(('x'.repeat(1023) + '\n').repeat(1024))
  for (let i = 0; i < 101; i++) appendFileSync(file, chunk)
  appendFileSync(file, 'CAFÉ at the end\n')
  let live: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    live = await launchPackaged({ file, cdp: true })
    const page = live.page!
    const card = page.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('.vl-scroller')).toBeVisible(ready)
    const bar = await query(page, card, 'north')
    await expect(bar.getByRole('status')).toContainText('…', ready)
    await bar.getByRole('searchbox').fill('café at the end')
    await expect(bar.getByRole('status')).toHaveText('1 of 1', { timeout: 120_000 })
    await expect(card.getByText('CAFÉ at the end', { exact: true }).last()).toBeInViewport()
    const exit = await closePackaged(live)
    expect(unrequested(live, exit)).toEqual([])
    live = undefined
  } finally {
    try { if (live) await closePackaged(live) } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('Find recovers from a refused search and cancels its work when the document closes', async () => {
  const file = fixture('find-budget.txt', 'one bright star\n'.repeat(20_000))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('.vl-scroller')).toBeVisible(ready)
  await expect.poll(async () => (await debugStats(live.win)).jobs).toBe(0)
  const base = await debugStats(live.win)
  await debugStats(live.win, { limit: base.ledger.used })
  try {
    const bar = await query(live.win, card, 'bright')
    await expect(bar.getByRole('status')).toContainText(/memory|budget/i, ready)
    await expect(card.locator('.vl-scroller')).toBeVisible()
    await debugStats(live.win, { limit: base.ledger.limit })
    await bar.getByRole('searchbox').fill('star')
    await expect(bar.getByRole('status')).toHaveText('1 of 20000', ready)
    await card.getByRole('button', { name: 'Close find-budget.txt' }).click()
    await expect.poll(async () => {
      const stats = await debugStats(live.win)
      return [stats.docs, stats.jobs, stats.tasks, stats.handles]
    }).toEqual([0, 0, 0, 0])
  } finally {
    await debugStats(live.win, { limit: base.ledger.limit })
  }
  expect(live.pageErrors).toEqual([])
  expect(await finish(live)).toEqual({ code: 0, signal: null })
})
