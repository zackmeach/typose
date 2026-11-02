// Focused split-surface workflow smoke. Native IDs are checked in the hooks build; the production package
// confirms that the visible Raw/Rendered split and card merge work without test hooks.
import { expect, type Locator } from '@playwright/test'
import { fixture, finish, launch, debugStats, stubOpenDialog, test } from './app'
import { closePackaged, launchPackaged, unrequested } from './packaged'

async function splitRight(win: Awaited<ReturnType<typeof launch>>['win']): Promise<void> {
  await win.getByRole('button', { name: 'Menu', exact: true }).click()
  await win.getByRole('menuitem', { name: 'Split right', exact: true }).click()
}

async function renderedReady(card: Locator): Promise<void> {
  await expect(card.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
}

async function rawReady(card: Locator): Promise<void> {
  await expect(card.locator('.vl-row .text').first()).toBeAttached({ timeout: 30_000 })
}

async function cardIndexed(card: Locator): Promise<void> {
  await expect(card.locator('.card-status')).toHaveText(/^[\d,]+ lines? · /, { timeout: 120_000 })
}

function splitSource(name: string): string {
  const anchor = 'Split source anchor stays visible'
  const paragraphs = Array.from({ length: 36 }, (_, i) => `Source paragraph ${i + 1}.`)
  paragraphs.splice(20, 0, anchor)
  const a = fixture(name, `# Split source\n\n${paragraphs.join('\n\n')}\n`)
  return a
}

test('split clones the source place, opens into the focused card, and preserves native documents on merge', async () => {
  const a = splitSource('split-source-a.md')
  const b = fixture('split-destination-b.md', '# Split destination B\n\nA second tab for the right card.\n')
  let live: Awaited<ReturnType<typeof launch>> | undefined
  try {
    live = await launch({ hooks: true, file: a })
    const { win } = live
    const left = win.getByRole('region', { name: 'Reader card 1', exact: true })
    await renderedReady(left)
    await cardIndexed(left)
    await left.getByRole('tab', { name: 'Raw', exact: true }).click()
    await rawReady(left)
    const anchorText = left.getByText('Split source anchor stays visible', { exact: true })
    await anchorText.scrollIntoViewIfNeeded()
    await expect(anchorText).toBeInViewport()
    const before = Object.keys((await debugStats(win)).charges).sort()
    expect(before).toHaveLength(1)

    await splitRight(win)
    const right = win.getByRole('region', { name: 'Reader card 2', exact: true })
    await expect(right).toHaveAttribute('data-focused', 'true')
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    await expect(right.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    const afterSplit = Object.keys((await debugStats(win)).charges).sort()
    expect(afterSplit).toHaveLength(2)
    expect(afterSplit).toContain(before[0])
    const clonedSourceId = afterSplit.find((id) => id !== before[0])
    expect(clonedSourceId).toBeDefined()
    const clonedId = clonedSourceId!

    await right.getByRole('tab', { name: 'Rendered', exact: true }).click()
    await renderedReady(right)
    await expect(left.getByRole('tab', { name: 'Raw', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(right.getByRole('tab', { name: 'Rendered', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    await expect(right.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()

    const sourceIds = Object.keys((await debugStats(win)).charges).sort()
    const leftRawGeneration = await left.locator('.raw-host').getAttribute('data-gen')
    const rightRendered = right.locator('.rendered-host')
    const rightGeneration = Number(await rightRendered.getAttribute('data-gen'))
    await win.getByRole('button', { name: 'Menu', exact: true }).click()
    await win.getByRole('menuitem', { name: 'Reload', exact: true }).click()
    await expect(rightRendered).toHaveAttribute('data-gen', String(rightGeneration + 1), { timeout: 30_000 })
    await expect(right.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await expect(left.locator('.raw-host')).toHaveAttribute('data-gen', leftRawGeneration!)
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(sourceIds)
    await expect.poll(async () => (await debugStats(win)).surfaces?.views).toBe(2)

    const leftBeforeResize = await left.boundingBox()
    const rightBeforeResize = await right.boundingBox()
    if (!leftBeforeResize || !rightBeforeResize) throw new Error('Split card has no bounding box before divider resize')
    const divider = win.getByRole('separator', { name: 'Card divider', exact: true })
    await divider.focus()
    await win.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await left.boundingBox())?.width ?? 0).toBeLessThan(leftBeforeResize.width)
    await expect.poll(async () => {
      const leftBox = await left.boundingBox()
      const rightBox = await right.boundingBox()
      return !!leftBox && !!rightBox && leftBox.width >= 320 && rightBox.width >= 320
    }).toBe(true)
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()

    await stubOpenDialog(live.app, b)
    await win.getByRole('button', { name: 'Menu', exact: true }).click()
    await win.getByRole('menuitem', { name: 'Open file…', exact: true }).click()
    await win.getByRole('button', { name: 'Browse…', exact: true }).click()
    await expect(right.locator('.card-name')).toHaveText('split-destination-b.md')
    await cardIndexed(right)
    await expect(right.locator('.md-scroller, .vl-row .text').first()).toBeAttached({ timeout: 30_000 })
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    const afterDestination = Object.keys((await debugStats(win)).charges).sort()
    expect(afterDestination).toHaveLength(3)
    expect(afterDestination).toContain(before[0])
    expect(afterDestination).toContain(clonedId)
    const destinationId = afterDestination.find((id) => id !== before[0] && id !== clonedId)
    expect(destinationId).toBeDefined()

    await right.getByRole('button', { name: 'Close card', exact: true }).click()
    await expect(win.getByRole('region', { name: 'Reader card 2', exact: true })).toHaveCount(0)
    await expect(left.locator('.card-name')).toHaveText('split-source-a.md')
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    const destinationTab = left.getByRole('tab', { name: /split-destination-b\.md/ })
    await expect(destinationTab).toBeVisible()
    expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(afterDestination)
    await destinationTab.click()
    await expect(left.locator('.card-name')).toHaveText('split-destination-b.md')
    await expect(left.locator('.md-scroller, .vl-row .text').first()).toBeAttached({ timeout: 30_000 })
    expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(afterDestination)
    expect(live.pageErrors).toEqual([])
  } finally {
    if (live) await finish(live)
  }
})

test('production package displays both lenses in split cards and merges the closed card tabs', async () => {
  const a = splitSource('split-package-source.md')
  let live: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    live = await launchPackaged({ cdp: true, file: a })
    const win = live.page!
    await renderedReady(win.getByRole('region', { name: 'Reader card 1', exact: true }))
    const left = win.getByRole('region', { name: 'Reader card 1', exact: true })
    await left.getByRole('tab', { name: 'Raw', exact: true }).click()
    await rawReady(left)
    const anchorText = left.getByText('Split source anchor stays visible', { exact: true })
    await anchorText.scrollIntoViewIfNeeded()
    await expect(anchorText).toBeInViewport()

    await splitRight(win)
    const right = win.getByRole('region', { name: 'Reader card 2', exact: true })
    await expect(right).toHaveAttribute('data-focused', 'true')
    await right.getByRole('tab', { name: 'Rendered', exact: true }).click()
    await renderedReady(right)
    await expect(left.getByRole('tab', { name: 'Raw', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(right.getByRole('tab', { name: 'Rendered', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    await expect(right.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    await win.screenshot({ path: test.info().outputPath('split-raw-rendered.png') })

    await right.getByRole('button', { name: 'Close card', exact: true }).click()
    await expect(win.getByRole('region', { name: 'Reader card 2', exact: true })).toHaveCount(0)
    await expect(left.getByRole('tab', { name: /split-package-source\.md/ })).toHaveCount(2)
    await expect(left.getByText('Split source anchor stays visible', { exact: true })).toBeInViewport()
    await closePackaged(live).then((exit) => expect(exit).toEqual({ code: 0, signal: null }))
    expect(unrequested(live, await live.exited)).toEqual([])
    live = undefined
  } finally {
    if (live) await closePackaged(live).catch(() => {})
  }
})
