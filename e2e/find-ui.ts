import { expect, type Locator, type Page } from '@playwright/test'

export const command = process.platform === 'darwin' ? 'Meta' : 'Control'
export const ready = { timeout: 30_000 }

export async function query(page: Page, reader: Locator, value: string) {
  await page.keyboard.press(command + '+f')
  const bar = reader.getByRole('search')
  const field = bar.getByRole('searchbox')
  await expect(field).toBeFocused()
  await field.fill(value)
  return bar
}
