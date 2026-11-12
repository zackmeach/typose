import { expect, type Locator, type Page } from '@playwright/test'

export const ready = { timeout: 30_000 }

export async function query(page: Page, reader: Locator, value: string) {
  // Find focuses its field in a frame callback, and a window not yet shown has no frames: hosted Linux showed none for
  // the 5 s the field was awaited (run 42911389323). Wait for a frame first.
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.keyboard.press('ControlOrMeta+f')
  const bar = reader.getByRole('search')
  const field = bar.getByRole('searchbox')
  await expect(field).toBeFocused()
  await field.fill(value)
  return bar
}
