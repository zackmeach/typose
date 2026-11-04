import { expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, assertNetLog, finish, fixture, launch, test, waitIndexed, waitOpen } from './app'

type PrintApi = {
  typose: { printDocument(title: string, blocks: unknown[], pages: number, confirmed: boolean): Promise<{ kind: string; pages?: number; reason?: string }> }
}

test('Print range UI, strict host document validation, and physical page cap', async () => {
  mkdirSync(FIXTURES, { recursive: true })
  const file = fixture('print-rich.md', '# Print fixture\n\n## Heading\n\nA **bold** paragraph.\n\n- one\n- two\n\n```ts\nconst value = 1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
  const netlog = join(FIXTURES, 'print-host.netlog.json')
  const l = await launch({ file, netlog, hooks: true, env: { TYPOSE_TEST_PRINT: '1' } })
  await expect(l.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
  await waitIndexed(l.win)
  const card = l.win.getByRole('region', { name: 'Reader card 1' })
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'print'))
  const sheet = card.getByRole('dialog', { name: 'Print print-rich.md' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(/estimated \d+ pages/)).toBeVisible()
  await sheet.getByRole('radio', { name: 'All' }).check()
  await sheet.getByRole('button', { name: 'Continue to print…' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'Print job sent' })).toBeVisible({ timeout: 30_000 })

  const before = await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const invalid = await l.win.evaluate(async () => (window as unknown as PrintApi).typose.printDocument('unsafe', [
    { tag: 'img', src: 'https://example.invalid/image.png' }
  ], 1, false))
  expect(invalid).toMatchObject({ kind: 'refused' })
  expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before)

  const cyclic = await l.win.evaluate(async () => {
    const node: { tag: string; src: string; children?: unknown[] } = { tag: 'img', src: 'data:image/png;base64,AA==' }
    node.children = [node]
    return (window as unknown as PrintApi).typose.printDocument('cyclic', [node], 1, false)
  })
  expect(cyclic).toMatchObject({ kind: 'refused' })
  expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before)

  const valid = await l.win.evaluate(async () => (window as unknown as PrintApi).typose.printDocument('safe', [
    { tag: 'h2', children: [{ text: 'Heading' }] },
    { tag: 'p', children: [{ text: 'Readable ' }, { tag: 'strong', children: [{ text: 'Markdown' }] }] },
    { tag: 'table', children: [{ tag: 'thead', children: [{ tag: 'tr', children: [{ tag: 'th', children: [{ text: 'Column' }] }] }] }] }
  ], 1, false))
  expect(valid).toMatchObject({ kind: 'printed', pages: 1 })
  expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before)

  const overLimit = await l.win.evaluate(async () => (window as unknown as PrintApi).typose.printDocument('many pages', [
    { tag: 'pre', children: [{ text: 'x\n'.repeat(120_000) }] }
  ], 1, true))
  expect(overLimit).toMatchObject({ kind: 'refused' })
  expect(overLimit.reason).toMatch(/physical.*(?:pages|bound)|page limit/i)
  expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before)
  expect(l.pageErrors).toEqual([])
  const exit = await finish(l)
  expect(exit.code).toBe(0)
  expect(assertNetLog(netlog)).toContain('PASS: no Chromium network-stack activity')
})

test('Escape cancels the print sheet before any document is built', async () => {
  const file = fixture('print-cancel.txt', Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n'))
  const l = await launch({ file, hooks: true, env: { TYPOSE_TEST_PRINT: '1' } })
  await waitOpen(l.win)
  await waitIndexed(l.win)
  const card = l.win.getByRole('region', { name: 'Reader card 1' })
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'print'))
  const sheet = card.getByRole('dialog', { name: 'Print print-cancel.txt' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused()
  await l.win.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(l.pageErrors).toEqual([])
})

test('the print sheet keeps Tab inside it and gives focus back on Close', async () => {
  const file = fixture('print-focus.txt', Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n'))
  const l = await launch({ file, hooks: true, env: { TYPOSE_TEST_PRINT: '1' } })
  await waitOpen(l.win)
  await waitIndexed(l.win)
  const card = l.win.getByRole('region', { name: 'Reader card 1' })
  const reader = card.locator('.vl-scroller')
  await reader.focus()
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'print'))
  const sheet = card.getByRole('dialog', { name: 'Print print-focus.txt' })
  await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused()
  await sheet.getByRole('button', { name: 'Continue to print…' }).focus()
  await l.win.keyboard.press('Tab') // from the last control
  await expect(sheet.locator(':focus')).toHaveCount(1)
  await sheet.getByRole('radio', { name: 'Pages around current view' }).focus()
  await l.win.keyboard.press('Shift+Tab') // from the first
  await expect(sheet.locator(':focus')).toHaveCount(1)
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(reader).toBeFocused()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('print refuses a source that changes after its Markdown plan was built', async () => {
  const path = fixture('print-source-change.md', '# Stable source\n\nThe original content.\n')
  const l = await launch({ file: path, hooks: true, env: { TYPOSE_TEST_PRINT: '1' } })
  await expect(l.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
  await waitIndexed(l.win)
  fixture('print-source-change.md', '# Changed source\n\nThe bytes changed before print verification.\n')
  const card = l.win.getByRole('region', { name: 'Reader card 1' })
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'print'))
  const sheet = card.getByRole('dialog', { name: 'Print print-source-change.md' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Continue to print…' }).click()
  await expect(card.getByRole('status').filter({ hasText: /Print failed · frozen: changed on disk/ })).toBeVisible()
  expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
