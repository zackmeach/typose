import { expect } from '@playwright/test'
import { type TestHooks, fixture, launch, recordClipboard, test } from './app'
import { ready } from './find-ui'
import { writeFileSync } from 'node:fs'

test('Rendered Ctrl+A and partial selections copy source markup, entities and current-generation bytes', async () => {
  const source = '# Source copy\n\nA **bold** line with &amp; markup.\n\n```ts\nconst value = "kept"\n```\n'
  const file = fixture('rendered-copy.md', source)
  const live = await launch({ file, hooks: true })
  const clipboard = await recordClipboard(live.app)
  const copied = async () => (await clipboard()).at(-1)
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  const scroller = card.locator('.md-scroller')
  await expect(scroller).toBeVisible(ready)
  await scroller.click()
  await expect(card).toHaveAttribute('data-focused', 'true')
  await live.win.keyboard.press('ControlOrMeta+a')
  await expect(card.locator('.md-copy-status')).toHaveText('All source text selected · press Ctrl+C to copy')
  expect(await live.win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered?.().copyAll)).toBe(true)
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect(card.locator('.md-copy-status')).toHaveText('Copied source text')
  await expect.poll(copied).toBe(source)

  const renderedText = card.locator('strong [data-source-map]').first()
  await renderedText.dblclick()
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect(card.locator('.md-copy-status')).toHaveText('Copied source text')
  await expect.poll(copied).not.toBe(source)
  await card.locator('.md-column p').first().evaluate(paragraph => {
    const nodes = [...paragraph.querySelectorAll('[data-source-map]')]
    const first = nodes[0].firstChild!, last = nodes.at(-1)!.lastChild!
    const range = document.createRange()
    range.setStart(first, 0); range.setEnd(last, last.textContent!.length)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect.poll(copied).toBe('A **bold** line with &amp; markup.')
  await card.getByRole('button', { name: 'Copy code' }).click()
  await expect.poll(copied).toBe('const value = "kept"\n')
  writeFileSync(file, source.replace('bold', 'changed'))
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect(card.locator('.md-copy-status')).toContainText(/changed|failed|frozen/i)
  await expect.poll(copied).toBe('const value = "kept"\n')
  expect(live.pageErrors).toEqual([])
})

test('Rendered partial selection across distant blocks preserves the intervening source bytes', async () => {
  const paragraphs = Array.from({ length: 150 }, (_, index) => `Paragraph **${index}** &amp; source.`)
  const body = paragraphs.join('\n\n')
  const file = fixture('rendered-copy-distant.md', '# Distant\n\n' + body + '\n')
  const live = await launch({ file, hooks: true })
  await live.app.evaluate(({ clipboard }) => { clipboard.writeText = async text => { (globalThis as { copiedSource?: string }).copiedSource = text } })
  const scroller = live.win.locator('.md-scroller')
  await expect(scroller).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
  await scroller.click()
  await scroller.locator('p').last().scrollIntoViewIfNeeded()
  await scroller.evaluate(root => {
    const paragraphs = root.querySelectorAll('p')
    const first = paragraphs[0].querySelector('[data-source-map]')!.firstChild!
    const runs = paragraphs[paragraphs.length - 1].querySelectorAll('[data-source-map]')
    const last = runs[runs.length - 1].firstChild!
    const range = document.createRange()
    range.setStart(first, 0); range.setEnd(last, last.textContent!.length)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => live.app.evaluate(() => (globalThis as { copiedSource?: string }).copiedSource)).toBe(body)
  expect(live.pageErrors).toEqual([])
})

test('Rendered partial source maps retain UTF-16 BOM offsets and multibyte scalar boundaries', async () => {
  const source = '# Encoding\n\nA **café 😀** &amp; 界.\n'
  const file = fixture('rendered-copy-utf16.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]))
  const live = await launch({ file, hooks: true })
  await live.app.evaluate(({ clipboard }) => { clipboard.writeText = async text => { (globalThis as { copiedSource?: string }).copiedSource = text } })
  const scroller = live.win.locator('.md-scroller').first()
  await expect(scroller).toBeVisible(ready)
  await scroller.click()
  await scroller.locator('p').evaluate(paragraph => {
    const runs = [...paragraph.querySelectorAll('[data-source-map]')]
    const range = document.createRange()
    range.setStart(runs[0].firstChild!, 0)
    range.setEnd(runs.at(-1)!.firstChild!, runs.at(-1)!.textContent!.length)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => live.app.evaluate(() => (globalThis as { copiedSource?: string }).copiedSource)).toBe('A **café 😀** &amp; 界.')
  expect(live.pageErrors).toEqual([])
})

test('Rendered partial selections map exact source bytes across mixed byte widths, in prose and a 25 KB code block', async () => {
  const prose = 'Une crème brûlée, très légère, à côté du café.'
  const code = 'x'.repeat(12_500) + 'café ·' + 'y'.repeat(12_500)
  const file = fixture('rendered-copy-mixed.md', `# Mixed widths\n\n${prose}\n\n\`\`\`text\n${code}\n\`\`\`\n`)
  const live = await launch({ file, hooks: true })
  await live.app.evaluate(({ clipboard }) => { clipboard.writeText = async text => { (globalThis as { copiedSource?: string }).copiedSource = text } })
  const copied = () => live.app.evaluate(() => (globalThis as { copiedSource?: string }).copiedSource)
  const scroller = live.win.locator('.md-scroller').first()
  await expect(scroller).toHaveAttribute('data-ready', '1', ready)
  await expect(scroller.locator('.md-note')).toHaveCount(0) // one `·` no longer makes the block "renders too large"
  await scroller.click()
  // Select `part` inside the one source-mapped run of `selector`, by UTF-16 offsets into its text.
  const select = (selector: string, part: string) => scroller.locator(selector).first().evaluate((host, part) => {
    const run = host.querySelector('[data-source-map]')!
    const text = run.firstChild as Text, at = text.data.indexOf(part)
    const range = document.createRange()
    range.setStart(text, at); range.setEnd(text, at + part.length)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  }, part)
  await select('p', 'brûlée, très légère, à côté')
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect.poll(copied).toBe('brûlée, très légère, à côté')
  await select('pre code', 'xcafé ·y')
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect.poll(copied).toBe('xcafé ·y')
  expect(live.pageErrors).toEqual([])
})
