import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { finish, fixture, launch, test, type TestHooks, waitIndexed, waitOpen } from './app'
import { closePackaged, launchPackaged } from './packaged'

async function wheel(page: Page, delta: number, control: boolean, app?: ElectronApplication): Promise<void> {
  if (app) {
    await app.evaluate(({ BrowserWindow }, { delta, control }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const [width, height] = win.getContentSize()
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: width / 2, y: height / 2, deltaY: -delta, modifiers: control ? ['control'] : [] })
    }, { delta, control })
    return
  }
  if (control) await page.keyboard.down('Control')
  try { await page.mouse.wheel(0, delta) }
  finally { if (control) await page.keyboard.up('Control') }
}

for (const kind of ['native Raw', 'logical Raw', 'Rendered'] as const) {
  test('Ctrl+wheel zooms ' + kind + ' without scrolling or reloading; plain wheel still scrolls', async () => {
    const markdown = kind === 'Rendered'
    const source = markdown ? '# Wheel zoom\n\n' + 'A paragraph to read.\n\n'.repeat(400) : 'line\n'.repeat(kind === 'logical Raw' ? 1_000_000 : 2000)
    const l = await launch({ file: fixture('zoom-' + kind.replaceAll(' ', '-') + (markdown ? '.md' : '.txt'), source) })
    const { app, win } = l
    if (!markdown) await waitOpen(win)
    await waitIndexed(win)
    const scroller = win.locator(markdown ? '.md-scroller' : '.vl-scroller')
    await expect(scroller).toBeVisible()
    if (markdown) await expect(scroller).toHaveAttribute('data-ready', '1')
    if (kind === 'logical Raw') await expect.poll(() => scroller.evaluate(el => el.scrollHeight)).toBe(16_000_000)
    await scroller.focus()
    const box = (await scroller.boundingBox())!
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.evaluate(() => Object.assign(window, { zoomLifetime: 'same page' }))
    const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
    const top = () => scroller.evaluate(el => el.scrollTop)
    const beforeTop = await top()
    expect(await zoom()).toBe(1)
    await wheel(win, -120, true, app)
    await expect.poll(zoom).toBeCloseTo(1.1, 5)
    if (!markdown) await expect.poll(top).toBe(beforeTop)
    else await expect(win.getByRole('heading', { name: 'Wheel zoom', exact: true })).toBeVisible()
    await wheel(win, 120, true, app)
    await expect.poll(zoom).toBeCloseTo(1, 5)
    await expect.poll(async () => Math.abs(await top() - beforeTop)).toBeLessThanOrEqual(1)
    const beforeScroll = await top()
    await wheel(win, 120, false, app)
    await expect.poll(top).toBeGreaterThan(beforeScroll)
    expect(await zoom()).toBeCloseTo(1, 5)
    expect(await win.evaluate(() => (window as unknown as { zoomLifetime: string }).zoomLifetime)).toBe('same page')
    await expect(win.locator(markdown ? '.rendered-host' : '.raw-host')).toHaveAttribute('data-gen', '1')
    expect(l.pageErrors).toEqual([])
    await finish(l)
  })
}

test('Raw Ctrl+wheel down to 50% grows its viewport only within the paid cache reservation', async () => {
  const l = await launch({ hooks: true, file: fixture('zoom-raw-cache.txt', ('x'.repeat(2048) + '\n').repeat(4000)) })
  const { app, win } = l
  await waitOpen(win)
  await waitIndexed(win)
  type CacheHooks = TestHooks & { client: { cache: () => { charged: number; cap: number; reserved: number } } }
  const cache = () => win.evaluate(() => (window as unknown as { typoseTest: CacheHooks }).typoseTest.client.cache())
  await expect.poll(async () => (await cache()).cap).toBeGreaterThan(0)
  const before = await cache()
  await win.locator('.vl-scroller').focus()
  await win.locator('.vl-scroller').hover()
  const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
  for (let i = 0; i < 9; i++) {
    await wheel(win, 120, true, app)
    await expect.poll(zoom).toBeCloseTo(Math.max(0.5, 1 / 1.1 ** (i + 1)), 5)
  }
  await expect.poll(async () => (await cache()).cap).toBeGreaterThan(before.cap)
  const after = await cache()
  expect(after.charged).toBeLessThanOrEqual(after.cap)
  expect(after.cap).toBeLessThanOrEqual(after.reserved)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('zoom steps one task apart all land', async () => {
  const l = await launch({ file: fixture('zoom-steps.txt', ('x'.repeat(2048) + '\n').repeat(4000)) })
  const { app, win } = l
  await waitOpen(win)
  // The browser's echo of a step can arrive between two. When the page stepped its own copy of the factor, the echo
  // reset that copy, and a step was lost: 4 times in 4 (Windows), as zoom.e2e.ts's wheel test lost one on Linux.
  await win.evaluate(async () => {
    const { zoom } = (window as unknown as { typose: { zoom(action: 'out'): void } }).typose
    for (let i = 0; i < 5; i++) {
      zoom('out')
      await new Promise((done) => setTimeout(done))
    }
  })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1 / 1.1 ** 5, 5)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('packaged Ctrl+wheel clamps at 50–200% and zooming out reverses the maximum immediately', async () => {
  const l = await launchPackaged({ cdp: true, marks: false, file: fixture('zoom-packaged.md', '# Packaged zoom\n\n' + 'Readable text.\n\n'.repeat(100)) })
  const page = l.page!
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const scroller = page.locator('.md-scroller')
  await expect(scroller).toBeVisible()
  await expect(scroller).toHaveAttribute('data-ready', '1')
  const originalRatio = await page.evaluate(() => devicePixelRatio)
  const zoom = () => page.evaluate(original => devicePixelRatio / original, originalRatio)
  for (let i = 0; i < 9; i++) {
    await scroller.hover()
    await wheel(page, -120, true)
    await expect.poll(zoom).toBeCloseTo(Math.min(2, 1.1 ** (i + 1)), 5)
  }
  await expect.poll(zoom).toBeCloseTo(2, 5)
  await page.screenshot({ path: test.info().outputPath('zoom-200.png') })
  await scroller.hover()
  await wheel(page, 120, true)
  await expect.poll(zoom).toBeCloseTo(2 / 1.1, 5)
  for (let i = 0; i < 16; i++) {
    await scroller.hover()
    await wheel(page, 120, true)
    await expect.poll(zoom).toBeCloseTo(Math.max(0.5, 2 / 1.1 ** (i + 2)), 5)
  }
  await expect.poll(zoom).toBeCloseTo(0.5, 5)
  await page.screenshot({ path: test.info().outputPath('zoom-50.png') })
  await scroller.hover()
  await wheel(page, -120, true)
  await expect.poll(zoom).toBeCloseTo(0.55, 5)
  expect(errors).toEqual([])
  expect(await closePackaged(l)).toEqual({ code: 0, signal: null })
})
