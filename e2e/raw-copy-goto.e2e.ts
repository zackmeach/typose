import { expect } from '@playwright/test'
import { finish, fixture, launch, recordClipboard, test, waitIndexed, waitOpen } from './app'

test('Raw Ctrl+A/Ctrl+C copies exact source bytes and Ctrl+G goes to a distant line', async () => {
  const source = Array.from({ length: 240 }, (_, index) => `line ${index + 1} · café`).join('\r\n') + '\r\n'
  const file = fixture('raw-copy-goto.txt', source)
  const live = await launch({ file, hooks: true })
  try {
    const clipboard = await recordClipboard(live.app)
    const copied = async () => (await clipboard()).at(-1)
    await waitOpen(live.win)
    await waitIndexed(live.win)
    const scroller = live.win.locator('.vl-scroller')
    await scroller.click()
    await live.win.keyboard.press('ControlOrMeta+a')
    await live.win.keyboard.press('ControlOrMeta+c')
    await expect.poll(copied).toBe(source)

    await live.win.keyboard.press('ControlOrMeta+g')
    const goTo = live.win.getByRole('form', { name: 'Go to line' })
    const input = goTo.getByRole('spinbutton')
    await expect(input).toBeFocused()
    await input.fill('200')
    await input.press('Enter')
    await expect(live.win.locator('.vl-row .text').filter({ hasText: 'line 200 · café' }).first()).toBeInViewport()
    expect(live.pageErrors).toEqual([])
  } finally {
    await finish(live)
  }
})
