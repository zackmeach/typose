import { type Page, expect } from '@playwright/test'
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIXTURES, type TestHooks, assertNetLog, debugStats, finish, fixture, launch, lifecycle, stubExternal, stubOpenDialog, test, waitOpen } from './app'

const ready = (win: Page) => expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })

async function holdResolve(win: Page): Promise<void> {
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'resolve') await new Promise<void>((done) => { (window as unknown as { releaseLink: () => void }).releaseLink = done })
      return reply
    }
  })
}

const waitHeld = (win: Page) => expect.poll(() => win.evaluate(() => typeof (window as unknown as { releaseLink?: () => void }).releaseLink)).toBe('function')
const release = (win: Page) => win.evaluate(() => (window as unknown as { releaseLink: () => void }).releaseLink())
const frames = (win: Page) => win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

test('external links hand off once, while unsafe and missing targets keep the reader in place without network requests', async () => {
  const log = test.info().outputPath('links-netlog.json')
  const l = await launch({ file: fixture('links.md', [
    '# Links', '',
    '[HTTPS](https://example.invalid/readme?x=1#target)', '',
    '[HTTP](http://example.invalid/notes)', '',
    '[Mail](mailto:reader@example.invalid?subject=Notes)', '',
    '[Unsafe](javascript:alert(1))', '',
    '[Local](other.md)', '',
    '[Share](file://server/share/file.md)', ''
  ].join('\n')), netlog: log })
  const { win } = l
  const calls = await stubExternal(l.app)
  await ready(win)
  for (const [name, url] of [
    ['HTTPS', 'https://example.invalid/readme?x=1#target'],
    ['HTTP', 'http://example.invalid/notes'],
    ['Mail', 'mailto:reader@example.invalid?subject=Notes']
  ]) {
    const before = await calls()
    await win.getByRole('link', { name, exact: true }).click()
    await expect.poll(calls).toEqual([...before, url])
  }
  for (const name of ['Unsafe', 'Local', 'Share']) await win.getByRole('link', { name, exact: true }).click()
  await expect(win.getByRole('link', { name: 'Local', exact: true })).toHaveAttribute('title', 'Not opened: other.md')
  expect(await calls()).toHaveLength(3)
  await expect(win.locator('.card-name')).toHaveText('links.md')
  expect(l.pageErrors).toEqual([])
  await finish(l)
  expect(assertNetLog(log)).toContain('PASS')
})

test('percent-encoded heading targets and mixed-case footnotes scroll and focus their destination', async () => {
  const file = fixture('jump-links.md', [
    '# Top', '', '[Heading](#caf%C3%A9)', '', 'A note[^NOTE].', '',
    ...Array.from({ length: 160 }, (_, i) => `Paragraph ${i}.\n`),
    '## Café', '', 'Heading destination.', '',
    ...Array.from({ length: 80 }, (_, i) => `After ${i}.\n`),
    '[^note]: Footnote destination.', ''
  ].join('\n'))
  const l = await launch({ file })
  const { win } = l
  await stubExternal(l.app)
  await ready(win)
  await win.getByRole('link', { name: 'Heading', exact: true }).click()
  const heading = win.getByRole('heading', { name: 'Café', exact: true })
  await expect(heading).toBeFocused()
  const top = () => win.locator('.md-scroller').evaluate((el) => el.scrollTop)
  expect(await top()).toBeGreaterThan(0)
  await win.locator('.md-scroller').evaluate((el) => { el.scrollTop = 0 })
  await win.locator('.md-column sup a').first().click()
  await expect.poll(() => win.evaluate(() => document.activeElement?.textContent?.includes('Footnote destination.') ?? false)).toBe(true)
  expect(await top()).toBeGreaterThan(0)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a delayed fragment response cannot override reading after the reader moves', async () => {
  const l = await launch({ hooks: true, file: fixture('delayed-link.md', [
    '# Top', '', '[Jump](#destination)', '',
    ...Array.from({ length: 160 }, (_, i) => `Paragraph ${i}.\n`), '## Destination', ''
  ].join('\n')) })
  const { win } = l
  await ready(win)
  await holdResolve(win)
  await win.getByRole('link', { name: 'Jump', exact: true }).click()
  await waitHeld(win)
  await win.locator('.md-scroller').focus()
  await win.locator('.md-scroller').evaluate((el) => el.addEventListener('scrollend', () => { (el as HTMLElement).dataset.readerSettled = '1' }, { once: true }))
  await win.keyboard.press('PageDown')
  const top = () => win.locator('.md-scroller').evaluate((el) => el.scrollTop)
  await expect(win.locator('.md-scroller')).toHaveAttribute('data-reader-settled', '1')
  expect(await top()).toBeGreaterThan(0)
  const before = await top()
  await release(win)
  await frames(win)
  expect(await top()).toBe(before)
  await expect(win.locator('.md-scroller')).toBeFocused()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a replaced document cannot hand off a delayed external target', async () => {
  const l = await launch({ hooks: true, file: fixture('old-link.md', '# Old\n\n[External](https://example.invalid/old)\n') })
  const { win } = l
  const calls = await stubExternal(l.app)
  await ready(win)
  await holdResolve(win)
  await win.getByRole('link', { name: 'External', exact: true }).click()
  await waitHeld(win)
  const next = fixture('new-link.md', '# New document\n')
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), next)
  await expect(win.locator('.card-name')).toHaveText('new-link.md')
  await ready(win)
  await release(win)
  await frames(win)
  expect(await calls()).toEqual([])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('the release preload refuses invalid external destinations before any OS handoff', async () => {
  const l = await launch()
  const { win } = l
  await expect(win.locator('.open-button')).toBeVisible()
  const calls = await stubExternal(l.app)
  const results = await win.evaluate(async () => {
    const api = (window as unknown as { typose: { openExternal: (url: unknown) => Promise<boolean> } }).typose
    return Promise.all([null, 17, {}, 'javascript:alert(1)', 'file://server/share/x.md', 'https://example.invalid/' + 'a'.repeat(32768), 'https://example.invalid/' + String.fromCharCode(10)]
      .map((url) => api.openExternal(url)))
  })
  expect(results).toEqual([false, false, false, false, false, false, false])
  expect(await calls()).toEqual([])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('local Markdown and text links replace the card, inherit the route, and Reload through it', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('local-next.md', '# Next document\n\n[Text](local-text.txt)\n')
  const text = fixture('local-text.txt', 'First local text\n')
  const l = await launch({ file: fixture('local-start.md', '# Start\n\n[Next](local-next.md)\n') })
  const { win } = l
  await ready(win)
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await expect(win.locator('.card-name')).toHaveText('local-next.md')
  await ready(win)
  await expect(win.getByRole('heading', { name: 'Next document' })).toBeVisible()
  await win.getByRole('link', { name: 'Text', exact: true }).click()
  await expect(win.locator('.card-name')).toHaveText('local-text.txt')
  await waitOpen(win)
  await expect(win.locator('.vl-row .text').first()).toHaveText('First local text')
  writeFileSync(text, 'Second local text\n')
  await win.keyboard.press('Control+r')
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await expect(win.locator('.vl-row .text').first()).toHaveText('Second local text')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a local target cannot regain manual path privileges after a core restart', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const target = fixture('local-restart-next.md', '# Local restart target\n')
  const l = await launch({ hooks: true, file: fixture('local-restart-start.md', '# Start\n\n[Next](local-restart-next.md)\n') })
  const { win } = l
  await ready(win)
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await expect(win.locator('.card-name')).toHaveText('local-restart-next.md')
  await ready(win)
  const spawned = lifecycle(l.userData).filter((r) => r.event === 'utility-spawn').at(-1)!
  process.kill(spawned.utilityPid as number)
  await expect(win.locator('.card-message p')).toContainText("Typose's core stopped")
  await expect(win.locator('.card-message .open-button')).toHaveText(['Open file…'])
  await expect(win.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0)
  await stubOpenDialog(l.app, target)
  await win.locator('.card-message .open-button').click()
  await ready(win)
  await expect(win.getByRole('heading', { name: 'Local restart target' })).toBeVisible()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a source change after local resolution keeps the current view and raises its Reload banner', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('local-race-target.md', '# Target\n')
  const source = fixture('local-race-source.md', '# Original source\n\n[Next](local-race-target.md)\n')
  const l = await launch({ hooks: true, file: source })
  const { win } = l
  await ready(win)
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  await holdResolve(win)
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await waitHeld(win)
  writeFileSync(source, '# Changed source\n')
  await release(win)
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await expect(win.getByRole('heading', { name: 'Original source', exact: true })).toBeVisible()
  await expect(win.locator('.card-name')).toHaveText('local-race-source.md')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('retargeting a local ancestor to a junction refuses Reload without reopening the display path', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const root = join(FIXTURES, 'local-retarget')
  const moved = join(FIXTURES, 'local-retarget-held')
  const other = join(FIXTURES, 'local-retarget-other')
  for (const dir of [root, moved, other]) expect(dirname(dir)).toBe(FIXTURES)
  for (const dir of [root, moved, other]) rmSync(dir, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  mkdirSync(other)
  writeFileSync(join(root, 'next.md'), '# Original local file\n')
  writeFileSync(join(other, 'next.md'), '# Wrong target\n')
  const l = await launch({ file: fixture('local-retarget-start.md', '# Start\n\n[Next](local-retarget/next.md)\n') })
  try {
    const { win } = l
    await ready(win)
    await win.getByRole('link', { name: 'Next', exact: true }).click()
    await ready(win)
    await expect(win.getByRole('heading', { name: 'Original local file' })).toBeVisible()
    const held = join(FIXTURES, 'local-retarget-held.md')
    expect(dirname(held)).toBe(FIXTURES)
    renameSync(join(root, 'next.md'), held)
    renameSync(root, moved)
    renameSync(held, join(moved, 'next.md'))
    symlinkSync(other, root, 'junction')
    await win.keyboard.press('Control+r')
    await expect(win.locator('.card-message p')).toContainText("Can't open")
    await expect(win.locator('.card-message .open-button')).toHaveText(['Locate…', 'Close'])
    await expect(win.locator('.card')).not.toContainText('Wrong target')
    expect(l.pageErrors).toEqual([])
  } finally {
    await finish(l)
    for (const dir of [root, moved, other]) rmSync(dir, { recursive: true, force: true })
  }
})

test('a replacement abandons an already opened local target and closes its document', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('local-delayed-target.md', '# Delayed target\n')
  const l = await launch({ hooks: true, file: fixture('local-delayed-start.md', '# Start\n\n[Next](local-delayed-target.md)\n') })
  const { win } = l
  await ready(win)
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'openLocal') await new Promise<void>((done) => { (window as unknown as { releaseLink: () => void }).releaseLink = done })
      return reply
    }
  })
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await waitHeld(win)
  const replacement = fixture('local-delayed-replacement.md', '# Replacement\n')
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), replacement)
  await expect(win.locator('.card-name')).toHaveText('local-delayed-replacement.md')
  await ready(win)
  await release(win)
  await frames(win)
  await expect.poll(async () => (await debugStats(win)).docs).toBe(2)
  await expect(win.getByRole('heading', { name: 'Replacement', exact: true })).toBeVisible()
  await win.getByRole('tab', { name: 'local-delayed-start.md', exact: true }).click()
  await ready(win)
  await expect(win.getByRole('heading', { name: 'Start', exact: true })).toBeVisible()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
