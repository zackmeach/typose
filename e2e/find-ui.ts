import { expect, type Locator, type Page } from '@playwright/test'

export const ready = { timeout: 30_000 }

export async function query(page: Page, reader: Locator, value: string) {
  await page.keyboard.press('ControlOrMeta+f')
  const bar = reader.getByRole('search')
  const field = bar.getByRole('searchbox')
  await expect(field).toBeFocused()
  await field.fill(value)
  return bar
}
