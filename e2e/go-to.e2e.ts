import { expect, type Locator, type Page } from '@playwright/test'
import { finish, fixture, launch, test } from './app'
import { command, ready } from './find-ui'

async function goTo(win: Page, scope: Locator, value: number): Promise<void> {
  await win.keyboard.press(command + '+g')
  const field = scope.getByRole('spinbutton')
  await expect(field).toBeFocused()
  await field.fill(String(value))
  await field.press('Enter')
  await expect(field).toHaveCount(0)
}

test('Go to reaches a source line in Rendered and independently inside a Raw link preview', async () => {
  const lines = Array.from({ length: 800 }, (_, i) => 'Raw entry ' + (i + 1))
  fixture('goto-raw.txt', lines.join('\n'))
  const md = ['# Go to test', '', '[Preview lines](goto-raw.txt)', '']
  let target = 0
  for (let i = 1; i <= 220; i++) {
    if (i === 150) target = md.length + 1
    md.push('## Section ' + i, '', 'Paragraph ' + i, '')
  }
  const live = await launch({ file: fixture('goto-index.md', md.join('\n')) })
  try {
    const win = live.win, source = win.getByRole('region', { name: 'Reader card 1' })
    await expect(source.locator('.md-scroller')).toHaveAttribute('data-ready', '1', ready)
    if (process.platform === 'win32') {
      await source.getByRole('link', { name: 'Preview lines' }).click()
      const preview = win.getByRole('dialog', { name: 'Link preview' })
      await preview.locator('.vl-scroller').focus()
      await goTo(win, preview, 460)
      await expect(preview.getByText('Raw entry 460', { exact: true })).toBeInViewport(ready)
      await preview.getByRole('button', { name: 'Close preview' }).click()
      await expect(preview).toHaveCount(0)
      await expect(source.getByRole('heading', { name: 'Go to test' })).toBeInViewport()
    }
    await source.locator('.md-scroller').focus()
    await goTo(win, source, target)
    await expect(source.getByRole('heading', { name: 'Section 150', exact: true })).toBeInViewport(ready)
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('Go to a Grid record puts the requested row in the viewport', async () => {
  const rows = Array.from({ length: 800 }, (_, i) => (i + 1) + ',Task ' + (i + 1))
  const live = await launch({ file: fixture('goto-tasks.csv', ['id,task', ...rows].join('\n')) })
  try {
    const scope = live.win.getByRole('region', { name: 'Reader card 1' })
    await scope.getByRole('grid').focus()
    await goTo(live.win, scope, 375)
    await expect(scope.getByText('Task 375', { exact: true })).toBeInViewport(ready)
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})
