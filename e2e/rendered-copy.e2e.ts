import { expect } from '@playwright/test'
import { type TestHooks, finish, fixture, launch, test } from './app'
import { command, ready } from './find-ui'

test('Rendered Ctrl+A copies exact source and a partial selection reports the missing source map', async () => {
  const source = '# Source copy\n\nA **bold** line with &amp; markup.\n\n```ts\nconst value = "kept"\n```\n'
  const file = fixture('rendered-copy.md', source)
  const live = await launch({ file, hooks: true })
  try {
    await live.app.evaluate(({ clipboard }) => {
      clipboard.writeText = async value => { (globalThis as { copiedSource?: string }).copiedSource = value }
    })
    const copied = () => live.app.evaluate(() => (globalThis as { copiedSource?: string }).copiedSource)
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    const scroller = card.locator('.md-scroller')
    await expect(scroller).toBeVisible(ready)
    await scroller.click()
    await expect(card).toHaveAttribute('data-focused', 'true')
    await live.win.keyboard.press(command + '+a')
    await expect(card.locator('.md-copy-status')).toHaveText('All source text selected · press Ctrl+C to copy')
    expect(await live.win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered?.().copyAll)).toBe(true)
    await live.win.keyboard.press(command + '+c')
    await expect(card.locator('.md-copy-status')).toHaveText('Copied source text')
    await expect.poll(copied).toBe(source)

    const renderedText = card.getByText('bold line with & markup.', { exact: false }).first()
    await renderedText.dblclick()
    await live.win.keyboard.press(command + '+c')
    await expect(card.locator('.md-copy-status')).toHaveText('Partial Rendered copy is unavailable until this selection has a source map')
    await expect.poll(copied).toBe(source)
    expect(live.pageErrors).toEqual([])
  } finally {
    await finish(live)
  }
})
