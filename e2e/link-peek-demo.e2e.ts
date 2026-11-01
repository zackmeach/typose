// Focused local-link preview workflow. The hooks test checks native document reuse;
// the packaged test confirms the visible preview ships without test hooks.
import { expect, type ElementHandle, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { debugStats, finish, fixture, FIXTURES, launch, test, waitIndexed } from './app'
import { closePackaged, launchPackaged, unrequested } from './packaged'

function makeLinkFixtures(sourceName: string, destinationName: string): { source: string; destination: string } {
  const anchor = 'Source place remains visible'
  const paragraphs = Array.from({ length: 24 }, (_, i) => `Source paragraph ${i + 1}.`)
  paragraphs.push(anchor)
  const source = fixture(sourceName, `# Peek source\n\n${paragraphs.join('\n\n')}\n\n[Preview destination](${destinationName})\n`)
  const destination = fixture(destinationName, '# Peek destination B\n\nLocal preview content.\n')
  return { source, destination }
}

async function renderedReady(card: Locator): Promise<void> {
  await expect(card.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
}

interface SourceSnapshot {
  card: ElementHandle<HTMLElement>
  scroller: ElementHandle<HTMLElement>
  anchor: ElementHandle<HTMLElement>
  id: string | null
  generation: string | null
  scrollTop: number
}

async function captureSource(card: Locator): Promise<SourceSnapshot> {
  const cardHandle = await card.elementHandle() as ElementHandle<HTMLElement> | null
  const scroller = card.locator('.md-scroller')
  const scrollerHandle = await scroller.elementHandle() as ElementHandle<HTMLElement> | null
  const anchorHandle = await card.getByText('Source place remains visible', { exact: true }).elementHandle() as ElementHandle<HTMLElement> | null
  if (!cardHandle || !scrollerHandle || !anchorHandle) throw new Error('Source Markdown DOM is not mounted')
  return {
    card: cardHandle,
    scroller: scrollerHandle,
    anchor: anchorHandle,
    id: await card.getAttribute('data-card'),
    generation: await card.locator('.rendered-host').getAttribute('data-gen'),
    scrollTop: await scroller.evaluate(element => element.scrollTop)
  }
}

async function expectSourceStable(card: Locator, source: SourceSnapshot): Promise<void> {
  await expect(card).toHaveAttribute('data-card', source.id!)
  await expect(card.locator('.rendered-host')).toHaveAttribute('data-gen', source.generation!)
  expect(await source.card.evaluate(element => element.isConnected)).toBe(true)
  expect(await source.scroller.evaluate(element => element.isConnected && element.scrollTop)).toBe(source.scrollTop)
  expect(await source.anchor.evaluate(element => element.isConnected)).toBe(true)
}

async function openPreview(page: Page, card: Locator): Promise<{ dialog: Locator; link: Locator; source: SourceSnapshot }> {
  const link = card.getByRole('link', { name: 'Preview destination', exact: true })
  await link.scrollIntoViewIfNeeded()
  const source = await captureSource(card)
  await link.click()
  const dialog = page.getByRole('dialog', { name: 'Link preview', exact: true })
  await expect(dialog).toBeVisible()
  return { dialog, link, source }
}

async function closeHooks(live: Awaited<ReturnType<typeof launch>>): Promise<void> {
  const exit = await finish(live)
  expect(exit).toEqual({ code: 0, signal: null })
  expect(live.pageErrors).toEqual([])
}

test('local-link preview closes with button, Escape, or Ctrl+W and transfers its native document when promoted', async () => {
  const { source: sourcePath } = makeLinkFixtures('peek-source-hooks.md', 'peek-destination-hooks.md')
  let live: Awaited<ReturnType<typeof launch>> | undefined
  try {
    live = await launch({ hooks: true, file: sourcePath })
    const { win } = live
    await waitIndexed(win)
    const card = win.locator('.reader-card').first()
    await card.getByRole('tab', { name: 'Rendered', exact: true }).click()
    await renderedReady(card)
    const anchor = card.getByText('Source place remains visible', { exact: true })
    const originalIds = Object.keys((await debugStats(win)).charges).sort()
    expect(originalIds).toHaveLength(1)

    let { dialog, link, source: sourceState } = await openPreview(win, card)
    await expect(dialog.getByRole('heading', { name: 'Peek destination B', exact: true })).toBeVisible()
    await renderedReady(dialog)
    await expectSourceStable(card, sourceState)
    let previewIds = Object.keys((await debugStats(win)).charges).sort()
    expect(previewIds).toHaveLength(2)
    expect(previewIds).toContain(originalIds[0])
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expectSourceStable(card, sourceState)
    await expect.poll(async () => Object.keys((await debugStats(win)).charges).sort()).toEqual(originalIds)

    const escapePreview = await openPreview(win, card)
    dialog = escapePreview.dialog
    link = escapePreview.link
    sourceState = escapePreview.source
    await expect(dialog.getByRole('heading', { name: 'Peek destination B', exact: true })).toBeVisible()
    await renderedReady(dialog)
    await expectSourceStable(card, sourceState)
    await win.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(link).toBeFocused()
    await expectSourceStable(card, sourceState)
    await expect.poll(async () => Object.keys((await debugStats(win)).charges).sort()).toEqual(originalIds)

    const shortcutPreview = await openPreview(win, card)
    dialog = shortcutPreview.dialog
    link = shortcutPreview.link
    sourceState = shortcutPreview.source
    await expect(dialog.getByRole('heading', { name: 'Peek destination B', exact: true })).toBeVisible()
    await renderedReady(dialog)
    await expectSourceStable(card, sourceState)
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W')
    await expect(dialog).toHaveCount(0)
    await expect(link).toBeFocused()
    await expectSourceStable(card, sourceState)
    await expect.poll(async () => Object.keys((await debugStats(win)).charges).sort()).toEqual(originalIds)

    const tabPreview = await openPreview(win, card)
    dialog = tabPreview.dialog
    sourceState = tabPreview.source
    await expect(dialog.getByRole('heading', { name: 'Peek destination B', exact: true })).toBeVisible()
    await renderedReady(dialog)
    await expectSourceStable(card, sourceState)
    previewIds = Object.keys((await debugStats(win)).charges).sort()
    expect(previewIds).toHaveLength(2)
    expect(previewIds).toContain(originalIds[0])
    await dialog.getByRole('button', { name: 'Open as tab', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(card.locator('.card-name')).toHaveText('peek-destination-hooks.md')
    await renderedReady(card)
    const promotedIds = Object.keys((await debugStats(win)).charges).sort()
    expect(promotedIds).toEqual(previewIds)

    const sourceTab = card.getByRole('tab', { name: /peek-source-hooks\.md/ })
    await expect(sourceTab).toBeVisible()
    await sourceTab.click()
    await expect(card.locator('.card-name')).toHaveText('peek-source-hooks.md')
    await expect(anchor).toBeInViewport()
    expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(promotedIds)

    const sidePreview = await openPreview(win, card)
    dialog = sidePreview.dialog
    link = sidePreview.link
    sourceState = sidePreview.source
    await expect(dialog.getByRole('heading', { name: 'Peek destination B', exact: true })).toBeVisible()
    await renderedReady(dialog)
    await expectSourceStable(card, sourceState)
    const beforeSide = Object.keys((await debugStats(win)).charges).sort()
    await dialog.getByRole('button', { name: 'Open to side', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const right = win.getByRole('region', { name: 'Reader card 2', exact: true })
    await expect(right.locator('.card-name')).toHaveText('peek-destination-hooks.md')
    await renderedReady(right)
    await expectSourceStable(card, sourceState)
    expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(beforeSide)
    await right.getByRole('button', { name: 'Close card', exact: true }).click()
    await expect(win.locator('.reader-card')).toHaveCount(1)
    await expectSourceStable(card, sourceState)
    await closeHooks(live)
    live = undefined
  } finally {
    if (live) await finish(live).catch(() => {})
  }
})

test('production package opens a relative tasks.csv as a Grid peek and to the side', async () => {
  const directory = mkdtempSync(join(FIXTURES, 'csv-link-peek-'))
  const source = join(directory, 'source.md')
  writeFileSync(source, `# Peek source\n\nSource place remains visible\n\n[Preview destination](tasks.csv)\n`)
  writeFileSync(join(directory, 'tasks.csv'), 'id,title\r\n001,Write the brief\r\n002,Review the draft\r\n')
  let live: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    live = await launchPackaged({ cdp: true, file: source })
    const win = live.page!
    const rendererErrors: string[] = []
    let rendererCrashed = false
    win.on('pageerror', error => rendererErrors.push(error.message))
    win.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()) })
    win.on('crash', () => { rendererCrashed = true })
    const card = win.locator('.reader-card').first()
    await renderedReady(card)
    const { dialog, link, source: sourceSnapshot } = await openPreview(win, card)
    const previewGrid = dialog.getByRole('grid', { name: 'CSV grid', exact: true })
    await expect(previewGrid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await expect(previewGrid.getByRole('gridcell').filter({ hasText: 'Write the brief' })).toBeVisible()
    await expectSourceStable(card, sourceSnapshot)
    await dialog.getByRole('button', { name: 'Open to side', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const right = win.locator('.reader-card').nth(1)
    await expect(right.locator('.card-name')).toHaveText('tasks.csv')
    await right.getByRole('tab', { name: 'Grid', exact: true }).click()
    const rightGrid = right.getByRole('grid', { name: 'CSV grid', exact: true })
    await expect(rightGrid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await expect(rightGrid.getByRole('gridcell').filter({ hasText: 'Write the brief' })).toBeVisible()
    await expectSourceStable(card, sourceSnapshot)
    await win.screenshot({ path: test.info().outputPath('csv-grid-link-peek-side.png') })
    await right.getByRole('button', { name: 'Close card', exact: true }).click()
    await expect(win.locator('.reader-card')).toHaveCount(1)
    await expect(card.locator('.card-name')).toHaveText('source.md')
    await expectSourceStable(card, sourceSnapshot)

    // Reusing the open Markdown document through a modifier-click promotes its relative CSV into a tab.
    // This used to throw in React Aria's Document collection and leave the window blank.
    await link.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    await expect(card.locator('.card-name')).toHaveText('tasks.csv')
    const tabGrid = card.getByRole('grid', { name: 'CSV grid', exact: true })
    await expect(tabGrid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await expect(tabGrid.getByRole('gridcell').filter({ hasText: 'Write the brief' })).toBeVisible()
    expect(rendererErrors).toEqual([])
    expect(rendererCrashed).toBe(false)
    const exit = await closePackaged(live)
    expect(exit).toEqual({ code: 0, signal: null })
    expect(unrequested(live, exit)).toEqual([])
    live = undefined
  } finally {
    if (live) await closePackaged(live).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})
