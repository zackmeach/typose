// Bounded packaged CSV preview workflows. These are demo smokes, not the parser's native/unit qualification.
import { expect, type Page } from '@playwright/test'
import { fixture, test } from './app'
import { closePackaged, launchPackaged, unrequested } from './packaged'

const grid = (page: Page) => page.getByRole('grid', { name: 'CSV grid', exact: true })
const gridReady = (page: Page) => expect(grid(page)).toHaveAttribute('data-ready', '1', { timeout: 30_000 })

async function closeCleanly(live: Awaited<ReturnType<typeof launchPackaged>>): Promise<void> {
  const exit = await closePackaged(live)
  expect(exit).toEqual({ code: 0, signal: null })
  expect(unrequested(live, exit)).toEqual([])
}

function quotedRaggedCsv(): string {
  return [
    'key;label;note',
    '001;Ada;"first line',
    'second line"',
    '002;Bea;"said ""hello"""',
    '003;Cy',
    '004;Dee;last;extra',
    ''
  ].join('\r\n')
}

test('CSV signature opens Grid; quoted multiline, ragged fields, and header projection stay literal', async () => {
  const file = fixture('csv-manual-quoted-ragged.csv', quotedRaggedCsv())
  let live: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    live = await launchPackaged({ cdp: true, file })
    const page = live.page!
    await expect(page.getByRole('tab', { name: 'Grid', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Grid', exact: true }).click()
    const csvGrid = grid(page)
    await gridReady(page)

    // Automatic detection remains the selected policy while File info exposes the detected delimiter.
    await expect(csvGrid.getByRole('columnheader', { name: 'key', exact: true })).toBeVisible()
    await expect(csvGrid.getByRole('columnheader', { name: 'label', exact: true })).toBeVisible()
    await expect(csvGrid.getByRole('columnheader', { name: 'note', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'File info', exact: true }).click()
    const info = page.getByRole('dialog', { name: 'CSV file info', exact: true })
    const delimiter = info.getByRole('combobox', { name: 'Delimiter', exact: true })
    await expect(delimiter).toHaveValue('auto')
    await expect(delimiter.locator('option:checked')).toHaveText('Auto (Semicolon)')
    const header = info.getByRole('checkbox', { name: 'First row is header', exact: true })
    await expect(header).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    const firstDataRow = csvGrid.getByRole('row').filter({ hasText: '001' })
    await expect(firstDataRow).toContainText('Ada')
    await expect(firstDataRow).toContainText('first line')
    await expect(firstDataRow).toContainText('second line')
    const firstRecordRow = csvGrid.locator('[role="row"][aria-rowindex="2"]')
    await expect(firstRecordRow.locator('[role="gridcell"][aria-colindex="2"]')).toHaveText('001')
    const quotedRecordRow = csvGrid.locator('[role="row"][aria-rowindex="3"]')
    await expect(quotedRecordRow.locator('[role="gridcell"][aria-colindex="4"]')).toContainText('said "hello"')

    const shortRow = csvGrid.getByRole('row').filter({ hasText: '003' })
    await expect(shortRow).toBeVisible()
    // The absent note is still represented as the third data cell (gutter is positional column 1).
    const missingRecordRow = csvGrid.locator('[role="row"][aria-rowindex="4"]')
    await expect(missingRecordRow.locator('[role="gridcell"][aria-colindex="4"]')).toHaveAttribute('aria-label', 'Missing cell')
    const extraRow = csvGrid.getByRole('row').filter({ hasText: '004' })
    await expect(extraRow).toContainText('extra')

    await page.getByRole('button', { name: 'File info', exact: true }).click()
    // The checkbox shows the core's header state, so it changes when csvConfigure answers, not at the click:
    // uncheck()/check() read it once right after the click and lose that race.
    await header.click()
    await expect(header).not.toBeChecked()
    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    await expect(csvGrid.getByRole('columnheader', { name: 'key', exact: true })).toHaveCount(0)
    await expect(csvGrid.getByRole('row').filter({ hasText: 'key' })).toBeVisible()
    await page.getByRole('button', { name: 'File info', exact: true }).click()
    await header.click()
    await expect(header).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    await expect(csvGrid.getByRole('columnheader', { name: 'key', exact: true })).toBeVisible()
    await expect(firstDataRow).toBeVisible()

    await closeCleanly(live)
    live = undefined
  } finally {
    if (live) await closePackaged(live).catch(() => {})
  }
})

test('Grid keyboard far-seeks to data column 5,000', async () => {
  const header = Array.from({ length: 5000 }, (_, i) => `column-${String(i).padStart(4, '0')}`).join(',')
  const row = Array.from({ length: 5000 }, (_, i) => `value-${String(i).padStart(4, '0')}`).join(',')
  const file = fixture('csv-wide-5000.csv', `${header}\r\n${row}\r\n`)
  let live: Awaited<ReturnType<typeof launchPackaged>> | undefined
  try {
    live = await launchPackaged({ cdp: true, file })
    const page = live.page!
    const gridTab = page.getByRole('tab', { name: 'Grid', exact: true })
    await expect(gridTab).toBeVisible()
    await gridTab.click()
    const csvGrid = grid(page)
    await gridReady(page)
    await page.getByRole('button', { name: 'File info', exact: true }).click()
    const info = page.getByRole('dialog', { name: 'CSV file info', exact: true })
    const headerOption = info.getByRole('checkbox', { name: 'First row is header', exact: true })
    if (!await headerOption.isChecked()) await headerOption.check()
    await expect(headerOption).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    const firstRow = csvGrid.locator('[role="row"][aria-rowindex="2"]')
    const firstCell = firstRow.locator('[role="gridcell"][aria-colindex="2"]')
    await expect(firstCell).toHaveText('value-0000')
    await expect(firstCell).toBeVisible()
    await firstCell.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')

    const lastCell = csvGrid.locator('[role="gridcell"][aria-colindex="5001"]')
    await expect(lastCell).toContainText('value-4999')
    await expect(lastCell).toHaveAttribute('aria-colindex', '5001', { timeout: 30_000 })
    await expect(lastCell).toBeFocused()
    await expect(lastCell).toBeInViewport()
    await closeCleanly(live)
    live = undefined
  } finally {
    if (live) await closePackaged(live).catch(() => {})
  }
})
