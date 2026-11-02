import { expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { FIXTURES, finish, launch, test } from './app'
import { armPlaceProbe, readPlaceProbe } from './place-probe'

/** Replace only the native folder picker in this dev-process test; filesystem listing stays real. */
async function stubFolderDialog(app: Awaited<ReturnType<typeof launch>>['app'], selected: string): Promise<void> {
  await app.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showOpenDialog = () => Promise.reject(new Error('the real folder dialog was reached'))
    ipcMain.removeHandler('folder-dialog')
    ipcMain.handle('folder-dialog', () => {
      ;(globalThis as { folderDialogCalls?: number }).folderDialogCalls = ((globalThis as { folderDialogCalls?: number }).folderDialogCalls ?? 0) + 1
      return path
    })
  }, selected)
  await expect(app.evaluate(({ dialog }) => dialog.showOpenDialog({}))).rejects.toThrow('the real folder dialog was reached')
}

const markdownReady = (scope: Page | Locator) =>
  expect(scope.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })

function makeFolderFixture(): string {
  mkdirSync(FIXTURES, { recursive: true })
  const root = mkdtempSync(join(FIXTURES, 'folder-sidebar-'))
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'guide'))
  writeFileSync(join(root, 'docs', 'A.md'), [
    '# Source A',
    ...Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`),
    '[Guide](/guide/B.md)',
    ''
  ].join('\n\n'))
  writeFileSync(join(root, 'guide', 'B.md'), '# Destination B\n')
  writeFileSync(join(root, 'docs', '.hidden.md'), '# Hidden\n')
  writeFileSync(join(root, 'tool.exe'), 'not an executable')
  return root
}

function makeCsvFolderFixture(): string {
  mkdirSync(FIXTURES, { recursive: true })
  const root = mkdtempSync(join(FIXTURES, 'folder-csv-'))
  writeFileSync(join(root, 'launch-plan.md'), '# Launch plan\n\nOpen [tasks.csv](tasks.csv) from the tree or this link.\n')
  writeFileSync(join(root, 'tasks.csv'), 'id,title\r\n001,Write the brief\r\n002,Review the draft\r\n')
  return root
}

async function activateTreeItem(win: Awaited<ReturnType<typeof launch>>['win'], name: string): Promise<void> {
  const item = win.getByRole('treeitem', { name, exact: true })
  await item.focus()
  await win.keyboard.press('Enter')
}

async function expandTreeItem(win: Awaited<ReturnType<typeof launch>>['win'], name: string): Promise<void> {
  const item = win.getByRole('treeitem', { name, exact: true })
  await expect(item).toHaveAttribute('aria-expanded', /^(true|false)$/)
  if (await item.getAttribute('aria-expanded') === 'false') await activateTreeItem(win, name)
}

async function showSidebar(win: Awaited<ReturnType<typeof launch>>['win']): Promise<void> {
  const show = win.getByRole('button', { name: 'Show sidebar', exact: true })
  await expect(show).toBeVisible()
  await show.click()
  await expect(win.getByRole('complementary', { name: 'Files sidebar' })).toBeVisible()
  await expect(win.getByRole('button', { name: /Add folder/ })).toBeVisible()
}

test('folder tree opens CSV from Markdown after a link preview was promoted and its side card closed', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const root = makeCsvFolderFixture()
  let l: Awaited<ReturnType<typeof launch>> | undefined
  try {
    l = await launch({ hooks: true })
    const { win } = l
    await showSidebar(win)
    await stubFolderDialog(l.app, root)
    await win.getByRole('button', { name: /Add folder/ }).click()
    await expect(win.getByRole('treeitem', { name: basename(root), exact: true })).toBeVisible()
    await expandTreeItem(win, basename(root))
    await activateTreeItem(win, 'launch-plan.md')
    await markdownReady(win)

    const source = win.locator('.reader-card').first()
    const link = source.getByRole('link', { name: 'tasks.csv', exact: true })
    await link.click()
    const preview = win.getByRole('dialog', { name: 'Link preview', exact: true })
    await expect(preview.getByRole('grid', { name: 'CSV grid', exact: true })).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await preview.getByRole('button', { name: 'Open to side', exact: true }).click()
    const side = win.getByRole('region', { name: 'Reader card 2', exact: true })
    await expect(side.locator('.card-name')).toHaveText('tasks.csv')
    await side.getByRole('button', { name: 'Close card', exact: true }).click()
    await expect(win.locator('.reader-card')).toHaveCount(1)

    const tasksItem = win.getByRole('treeitem', { name: 'tasks.csv', exact: true })
    await expect(tasksItem).toBeVisible()
    await tasksItem.locator('.folder-row').click()
    const card = win.locator('.reader-card').first()
    await expect(card.locator('.card-name')).toHaveText('tasks.csv')
    const grid = card.getByRole('grid', { name: 'CSV grid', exact: true })
    await expect(grid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await expect(grid.getByRole('gridcell').filter({ hasText: 'Write the brief' })).toBeVisible()
    expect(l.pageErrors).toEqual([])
  } finally {
    if (l) await finish(l)
    rmSync(root, { recursive: true, force: true })
  }
})

test('folder tree opens a nested Markdown link and Back restores the source place', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const root = makeFolderFixture()
  let l: Awaited<ReturnType<typeof launch>> | undefined
  try {
    const live = await launch({ hooks: true })
    l = live
    const { win } = live
    await showSidebar(win)
    await stubFolderDialog(live.app, root)
    await win.getByRole('button', { name: /Add folder/ }).click()
    await expect(win.getByRole('treeitem', { name: basename(root), exact: true })).toBeVisible()
    await expect.poll(() => live.app.evaluate(() => (globalThis as { folderDialogCalls?: number }).folderDialogCalls)).toBe(1)

    await expandTreeItem(win, basename(root))
    await expandTreeItem(win, 'docs')
    await expect(win.getByRole('treeitem', { name: '.hidden.md', exact: true })).toHaveCount(0)
    await activateTreeItem(win, 'A.md')
    await markdownReady(win)
    await expect(win.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible()
    await expect(win.locator('.card-parent')).toContainText(`${basename(root)} / docs`)

    const sourceCard = win.locator('.reader-card').first()
    const guide = sourceCard.getByRole('link', { name: 'Guide', exact: true })
    await guide.scrollIntoViewIfNeeded()
    await armPlaceProbe(guide)
    await guide.click()
    const preview = win.getByRole('dialog', { name: 'Link preview', exact: true })
    await expect(preview).toBeVisible()
    await markdownReady(preview)
    await expect(preview.getByRole('heading', { name: 'Destination B', exact: true })).toBeVisible()
    await expect(preview.locator('.card-parent')).toContainText(`${basename(root)} / guide`)
    const sourceDuringPreview = await readPlaceProbe(guide)
    expect(sourceDuringPreview.sameNodes).toBe(true)
    expect(sourceDuringPreview.scrollTop).toBe(sourceDuringPreview.originScrollTop)
    expect(Math.abs(sourceDuringPreview.anchorTop - sourceDuringPreview.originAnchorTop)).toBeLessThanOrEqual(1)
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect(preview).toHaveCount(0)
    await expect(sourceCard.locator('.card-name')).toHaveText('A.md')
    await markdownReady(sourceCard)
    await expect(win.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible()
    await expect(guide).toBeInViewport()
    await expect(guide).toBeFocused()
    const sourceAfterClose = await readPlaceProbe(guide)
    expect(sourceAfterClose.sameNodes).toBe(true)
    expect(sourceAfterClose.scrollTop).toBe(sourceAfterClose.originScrollTop)
    expect(Math.abs(sourceAfterClose.anchorTop - sourceAfterClose.originAnchorTop)).toBeLessThanOrEqual(1)

    await activateTreeItem(win, 'tool.exe')
    await expect(win.locator('.card-name')).toHaveText('A.md')
    await expect(win.getByRole('status').filter({ hasText: /unsupported/i })).toBeVisible()
    expect(live.pageErrors).toEqual([])
  } finally {
    try { if (l) await finish(l) } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('folder refresh discovers new files, resize stays bounded, and removal retains the open source', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const root = makeFolderFixture()
  let l: Awaited<ReturnType<typeof launch>> | undefined
  try {
    const live = await launch({ hooks: true })
    l = live
    const { win } = live
    await win.setViewportSize({ width: 800, height: 800 })
    const cardBeforeOverlay = await win.locator('.card').boundingBox()
    if (!cardBeforeOverlay) throw new Error('Reader card has no bounding box before showing the sidebar')
    await showSidebar(win)
    await expect(win.getByRole('button', { name: 'Hide sidebar', exact: true })).toBeVisible()
    await expect(win.locator('.folder-sidebar[data-overlay]')).toBeVisible()
    await expect.poll(async () => {
      const after = await win.locator('.card').boundingBox()
      return !!after && Math.abs(after.x - cardBeforeOverlay!.x) < 2 && Math.abs(after.y - cardBeforeOverlay!.y) < 2 &&
        Math.abs(after.width - cardBeforeOverlay!.width) < 2 && Math.abs(after.height - cardBeforeOverlay!.height) < 2
    }).toBe(true)
    await stubFolderDialog(live.app, root)
    await win.getByRole('button', { name: /Add folder/ }).click()
    const rootItem = win.getByRole('treeitem', { name: basename(root), exact: true })
    await expect(rootItem).toBeVisible()
    await expandTreeItem(win, basename(root))
    await expandTreeItem(win, 'docs')
    await activateTreeItem(win, 'A.md')
    await markdownReady(win)

    await showSidebar(win)
    await expect(win.locator('.folder-sidebar[data-overlay]')).toBeVisible()
    const separator = win.getByRole('separator', { name: 'Sidebar width' })
    await separator.focus()
    await win.keyboard.press('End')
    await expect(separator).toHaveAttribute('aria-valuenow', '420')
    await win.keyboard.press('Home')
    await expect(separator).toHaveAttribute('aria-valuenow', '180')
    await win.keyboard.press('ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '196')
    await expect(win.getByRole('tree', { name: 'Files' })).toBeVisible()

    writeFileSync(join(root, 'docs', 'New.md'), '# New file\n')
    await win.getByRole('button', { name: `Refresh ${basename(root)}` }).click()
    await expect(win.getByRole('treeitem', { name: 'docs', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(win.getByRole('treeitem', { name: 'New.md', exact: true })).toBeVisible()

    await win.getByRole('button', { name: `Folder actions for ${basename(root)}` }).click()
    await win.getByRole('menuitem', { name: 'Remove from workspace', exact: true }).click()
    await expect(win.getByRole('treeitem', { name: basename(root), exact: true })).toHaveCount(0)
    await expect(win.locator('.card-name')).toHaveText('A.md')
    await expect(win.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible()
    expect(live.pageErrors).toEqual([])
  } finally {
    try { if (l) await finish(l) } finally { rmSync(root, { recursive: true, force: true }) }
  }
})
