import { expect } from '@playwright/test'
import { rmSync } from 'node:fs'
import { finish, fixture, launch, test } from './app'

test('Grid asks before a 10 MiB copy and writes the full cell only after confirmation', async () => {
  const prefix = 10 * 1024 * 1024
  // First-column values also force a partial native page when mapping the selected display row.
  const rest = Array.from({ length: 35 }, (_, i) => 'y'.repeat(5000) + ',' + (i + 2)).join('\r\n')
  const file = fixture('grid-copy-confirm.csv', 'notes,key\r\n' + 'x'.repeat(prefix) + 'tail,1\r\n' + rest)
  const live = await launch({ file })
  try {
    await live.app.evaluate(({ clipboard }) => {
      clipboard.writeText = async value => {
        (globalThis as { gridCopyProof?: unknown }).gridCopyProof = { length: value.length, tail: value.slice(-4) }
      }
    })
    const readProof = () => live.app.evaluate(() => (globalThis as { gridCopyProof?: unknown }).gridCopyProof ?? null)
    const grid = live.win.getByRole('grid', { name: 'CSV grid' })
    await expect(grid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    const cell = grid.getByRole('gridcell', { name: /^xxx/ }).first()
    const prompt = live.win.getByRole('alertdialog', { name: 'Confirm large copy' })
    const copy = process.platform === 'darwin' ? 'Meta+c' : 'Control+c'

    await cell.click()
    await live.win.keyboard.press(copy)
    await expect(prompt).toBeVisible({ timeout: 90_000 })
    expect(await readProof()).toBeNull()
    await live.win.keyboard.press('Escape')
    await expect(prompt).toHaveCount(0)
    expect(await readProof()).toBeNull()

    await cell.click()
    await live.win.keyboard.press(copy)
    await expect(prompt).toBeVisible({ timeout: 90_000 })
    await prompt.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(readProof).toEqual({ length: prefix + 4, tail: 'tail' })
    expect(live.pageErrors).toEqual([])
  } finally {
    try { await finish(live) } finally { rmSync(file, { force: true }) }
  }
})
