import { expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, finish, fixture, launch, test, waitIndexed, waitOpen } from './app'

const source = '# Launch plan\n\nA reading paragraph with *emphasis* and **`strong code`**.\n\n## Milestones\n\n### Decisions\n\n```ts\nconst shipped = true\n```\n\n' + 'A paragraph to read.\n\n'.repeat(120)

for (const delayed of [1000, 2200]) {
  test(`a ${delayed}ms font delay keeps the core connected and settles the reader without a later metric swap`, async () => {
    const l = await launch({ hooks: true, file: fixture(`reader-font-delay-${delayed}.md`, source), env: { TYPOSE_TEST_DELAY_FONTS: String(delayed) } })
    const { win } = l
    // This indexed metadata came from the real native handshake while lens layout still waits for fonts.
    await waitIndexed(win)
    await expect(win.locator('html')).toHaveAttribute('data-fonts', 'loading')
    await expect(win.locator('.card-name')).toHaveText(`reader-font-delay-${delayed}.md`)
    await expect(win.locator('.md-scroller, .vl-scroller')).toHaveCount(0)
    await expect(win.locator('html')).toHaveAttribute('data-fonts', delayed < 1500 ? 'ready' : 'fallback')
    await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1')
    if (delayed > 1500) {
      const metrics = () => win.locator('.md-column h1').evaluate((element) => ({ font: getComputedStyle(element).fontFamily, height: element.getBoundingClientRect().height }))
      const before = await metrics()
      expect(before.font).not.toContain('Inter')
      await expect.poll(() => win.evaluate(() => document.fonts.check('13px Inter') && document.fonts.check('700 13px "JetBrains Mono"'))).toBe(true)
      await expect(win.locator('html')).toHaveAttribute('data-fonts', 'fallback')
      expect(await metrics()).toEqual(before)
    }
    expect(l.pageErrors).toEqual([])
    await finish(l)
  })
}

test('reader uses bundled typography and fixed Raw geometry before content mounts', async () => {
  const l = await launch({ file: fixture('reader-type.md', source) })
  const { win } = l
  await expect(win.locator('html')).toHaveAttribute('data-fonts', 'ready')
  await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1')
  await waitIndexed(win)
  const type = await win.evaluate(() => {
    const css = (selector: string) => getComputedStyle(document.querySelector(selector)!)
    return {
      ui: css('body').fontFamily, uiSize: css('body').fontSize,
      reading: css('.md-column').fontSize, line: css('.md-column').lineHeight,
      h1: css('.md-column h1').fontSize, h1Line: css('.md-column h1').lineHeight,
      h2: css('.md-column h2').fontSize, h3: css('.md-column h3').fontSize,
      code: css('.md-column pre').fontFamily, codeSize: css('.md-column pre').fontSize,
      codeLine: css('.md-column pre').lineHeight, strong: css('.md-column strong code').fontWeight,
      header: css('.card-header').height
    }
  })
  expect(type).toMatchObject({ uiSize: '13px', reading: '16px', line: '25.6px', h1: '30px', h1Line: '36px', h2: '22px', h3: '18px', codeSize: '13px', header: '44px' })
  expect(type.ui).toContain('Inter')
  expect(type.code).toContain('JetBrains Mono')
  expect(Number(type.strong)).toBeGreaterThanOrEqual(600)
  expect(Number.parseFloat(type.codeLine)).toBeCloseTo(20.15, 2)
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await waitOpen(win)
  const raw = await win.locator('.vl-row').first().evaluate((element) => {
    const css = getComputedStyle(element)
    return { size: css.fontSize, line: css.lineHeight, font: css.fontFamily, height: element.getBoundingClientRect().height }
  })
  expect(raw).toMatchObject({ size: '13px', line: '20px', height: 20 })
  expect(raw.font).toContain('JetBrains Mono')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('long breadcrumbs preserve the filename and working lens controls through narrow zoomed layouts', async () => {
  const parent = 'a-long-parent-directory-for-breadcrumb-shrinking'
  mkdirSync(join(FIXTURES, parent), { recursive: true })
  const path = fixture(join(parent, 'a-long-launch-plan-filename-to-preserve.md'), source)
  const l = await launch({ file: path })
  const { app, win } = l
  await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1')
  await waitIndexed(win)
  await expect(win.locator('.card-identity')).toHaveAttribute('title', path)
  await expect(win.locator('.card-parent')).toHaveText(parent + ' / ')
  await expect(win.locator('.card-header .open-button')).toHaveCount(0)
  for (const zoom of [1, 2, 0.5]) {
    await app.evaluate(({ BrowserWindow }, zoom) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(720, 800)
      window.webContents.setZoomFactor(zoom)
    }, zoom)
    const dropdown = win.locator('.lens-dropdown')
    const narrow = await win.locator('.card').evaluate((element) => element.clientWidth <= 400)
    await expect(narrow ? dropdown : win.locator('.lens-switch')).toBeVisible()
    const geometry = await win.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const header = box('.card-header'), name = box('.card-name')
      const lens = box(getComputedStyle(document.querySelector('.lens-dropdown')!).display === 'none' ? '.lens-switch' : '.lens-dropdown')
      const glyph = box('.card-identity .file-icon')
      const measure = document.createElement('span')
      measure.style.cssText = 'position:absolute;width:10ch;font:inherit'
      document.querySelector('.card-header')!.append(measure)
      const minimum = measure.getBoundingClientRect().width
      measure.remove()
      return { nameWidth: name.width, minimum, nameRight: name.right, lensLeft: lens.left, lensRight: lens.right, headerRight: header.right, glyphRight: glyph.right, nameLeft: name.left }
    })
    expect(geometry.nameWidth).toBeGreaterThanOrEqual(geometry.minimum - 1)
    expect(geometry.nameRight).toBeLessThanOrEqual(geometry.lensLeft)
    expect(geometry.glyphRight).toBeLessThanOrEqual(geometry.nameLeft)
    expect(geometry.lensRight).toBeLessThanOrEqual(geometry.headerRight)
    if (narrow) {
      await dropdown.focus()
      await win.keyboard.press('Enter')
      await win.getByRole('menuitem', { name: 'Raw', exact: true }).click()
      await waitOpen(win)
      await dropdown.click()
      await win.getByRole('menuitem', { name: 'Rendered', exact: true }).click()
    } else {
      await win.getByRole('tab', { name: 'Raw', exact: true }).click()
      await waitOpen(win)
      await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
    }
    await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1')
    await win.keyboard.press('Tab')
    await win.locator('.card-status').focus()
    await expect(win.locator('.card-status-tooltip')).toBeVisible()
    await win.locator('.md-scroller').focus()
  }
  await win.emulateMedia({ reducedMotion: 'reduce' })
  expect(await win.locator('.md-scroller').evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await win.evaluate(() => { document.documentElement.dataset.a11y = 'on' })
  expect(await win.locator('.md-block').last().evaluate((element) => getComputedStyle(element).contentVisibility)).toBe('visible')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
