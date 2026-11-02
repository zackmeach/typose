// Checkpoint A's visible local-navigation demo on the production package. This is a short workflow smoke, not the
// authority, lifecycle, or memory qualification suite.
import { expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, test, visibleRows, waitIndexed, waitOpen } from './app'
import { closePackaged, launchPackaged, unrequested } from './packaged'
import { armPlaceProbe, readPlaceProbe } from './place-probe'

const ready = (scope: Page | Locator) =>
  expect(scope.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })

function demoDirectory(prefix: string): string {
  mkdirSync(FIXTURES, { recursive: true })
  return mkdtempSync(join(FIXTURES, `${prefix}-`))
}

async function closeCleanly(l: Awaited<ReturnType<typeof launchPackaged>>): Promise<void> {
  const exit = await closePackaged(l)
  expect(exit).toEqual({ code: 0, signal: null })
  expect(unrequested(l, exit)).toEqual([])
}

async function openMenuItem(win: Page, name: string): Promise<void> {
  await win.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(win.getByRole('menu')).toBeVisible()
  await win.getByRole('menuitem', { name, exact: true }).click()
}

test('packaged local-link peek: B opens C, Back restores B, and closing returns to A', async () => {
  test.skip(process.platform !== 'win32', 'the packaged local-route backend is currently Windows-only')
  const directory = demoDirectory('navigation-back')
  const a = join(directory, 'A.md')
  const b = join(directory, 'B.md')
  const c = join(directory, 'C.txt')
  const middle = (label: string) => Array.from({ length: 36 }, (_, i) => `${label} paragraph ${i + 1}.`).join('\n\n')
  writeFileSync(a, `# A\n\n${middle('A')}\n\n[Continue to B](B.md)\n`)
  writeFileSync(b, `# B\n\n${middle('B')}\n\n[Continue to C](C.txt)\n`)
  writeFileSync(c, Array.from({ length: 300 }, (_, i) => `C line ${i + 1}`).join('\n'))
  let l: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    l = await launchPackaged({ cdp: true, file: a })
    const win = l.page!
    await ready(win)
    const sourceCard = win.locator('.reader-card').first()
    const aLink = sourceCard.getByRole('link', { name: 'Continue to B', exact: true })
    await aLink.scrollIntoViewIfNeeded()
    await armPlaceProbe(aLink)
    await aLink.click()
    const dialog = win.getByRole('dialog', { name: 'Link preview', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await ready(dialog)
    const sourceDuringPreview = await readPlaceProbe(aLink)
    expect(sourceDuringPreview.sameNodes).toBe(true)
    expect(sourceDuringPreview.scrollTop).toBe(sourceDuringPreview.originScrollTop)
    expect(Math.abs(sourceDuringPreview.anchorTop - sourceDuringPreview.originAnchorTop)).toBeLessThanOrEqual(1)
    const bLink = dialog.getByRole('link', { name: 'Continue to C', exact: true })
    await bLink.scrollIntoViewIfNeeded()
    await bLink.click()
    await expect(dialog.getByText('C line 1', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await ready(dialog)
    await expect(dialog.getByRole('link', { name: 'Continue to C', exact: true })).toBeInViewport()
    await win.screenshot({ path: test.info().outputPath('back-restored.png') })
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(sourceCard.locator('.card-name')).toHaveText('A.md')
    await ready(sourceCard)
    await expect(aLink).toBeInViewport()
    await expect(aLink).toBeFocused()
    const sourceAfterClose = await readPlaceProbe(aLink)
    expect(sourceAfterClose.sameNodes).toBe(true)
    expect(sourceAfterClose.scrollTop).toBe(sourceAfterClose.originScrollTop)
    expect(Math.abs(sourceAfterClose.anchorTop - sourceAfterClose.originAnchorTop)).toBeLessThanOrEqual(1)
    expect(await win.title()).toBe('A.md — Typose')
    await closeCleanly(l)
    l = undefined
  } finally {
    if (l) await closePackaged(l).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('packaged Ctrl+Shift+T reopens a closed scrolled text file at the same line', async () => {
  const directory = demoDirectory('navigation-reopen-key')
  const file = join(directory, 'scroll-place.txt')
  writeFileSync(file, Array.from({ length: 1200 }, (_, i) => `Saved line ${i + 1}`).join('\n'))
  let l: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    l = await launchPackaged({ cdp: true, file })
    const win = l.page!
    await waitOpen(win)
    await waitIndexed(win)
    const scroller = win.locator('.vl-scroller')
    await scroller.evaluate((element) => { element.scrollTop = 2400 })
    await expect.poll(async () => (await visibleRows(win))[0]?.line ?? 0).toBeGreaterThan(20)
    const before = await visibleRows(win)
    expect(before[0].line).toBeGreaterThan(20)
    const savedLine = before[0].line

    await win.getByRole('button', { name: 'Close scroll-place.txt', exact: true }).click()
    await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+T' : 'Control+Shift+T')
    await expect(win.locator('.card-name')).toHaveText('scroll-place.txt')
    await waitOpen(win)
    await waitIndexed(win)
    await expect.poll(async () => (await visibleRows(win))[0]?.line ?? 0).toBe(savedLine)
    await win.screenshot({ path: test.info().outputPath('reopen-restored.png') })
    await closeCleanly(l)
    l = undefined
  } finally {
    if (l) await closePackaged(l).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('packaged menu reopens a closed file and Clear recently closed tabs removes it', async () => {
  test.skip(process.platform === 'darwin', 'macOS has a native app menu with a separate command table')
  const directory = demoDirectory('navigation-reopen-menu')
  const file = join(directory, 'menu-reopen.txt')
  writeFileSync(file, 'Reopen through menu\n')
  let l: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    l = await launchPackaged({ cdp: true, file })
    const win = l.page!
    await waitOpen(win)
    await openMenuItem(win, 'Close tab')
    await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()

    await openMenuItem(win, 'Reopen closed tab')
    await expect(win.locator('.card-name')).toHaveText('menu-reopen.txt')
    await waitOpen(win)
    await openMenuItem(win, 'Close tab')
    await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
    await openMenuItem(win, 'Clear recently closed tabs')
    await openMenuItem(win, 'Reopen closed tab')
    await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
    await expect(win.locator('.file-tab')).toHaveCount(0)
    await closeCleanly(l)
    l = undefined
  } finally {
    if (l) await closePackaged(l).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})
