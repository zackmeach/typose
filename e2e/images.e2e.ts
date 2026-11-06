import { type Page, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { type TestHooks, assertNetLog, debugStats, expectReleasedDocuments, finish, fixture, holdReply, launch, test, waitRendered } from './app'
import { imageGif, imageJpeg, imageJpegIcc, imagePng, imagePngPhys, imageWebp } from './image-fixtures'
import { processMemory } from './memory'

const open = (l: Awaited<ReturnType<typeof launch>>, path: string) => l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), path)
const stats = (win: Page) => win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered?.())

test('three supported local formats render from canonical blobs; WebP, remote, unsafe and malformed images remain labelled without network', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('image-static.png', imagePng(160, 32))
  fixture('image-static.gif', imageGif)
  fixture('image-static.jpg', imageJpeg(128, 32))
  const webp = fixture('image-static.webp', imageWebp)
  fixture('image-bad.png', Buffer.from('not an image'))
  const source = fixture('image-profiles.md', [
    '# Local images', '', '![PNG](image-static.png) ![GIF](image-static.gif) ![JPEG](image-static.jpg)', '',
    `![WebP](${pathToFileURL(webp).href})`, '',
    '![Remote](https://example.invalid/image.png) ![Share](file://example.invalid/share/a.png) ![Bad](image-bad.png)', ''
  ].join('\n'))
  const log = test.info().outputPath('images-netlog.json')
  const l = await launch({ file: source, netlog: log })
  const { win } = l
  await waitRendered(win)
  for (const name of ['PNG', 'GIF', 'JPEG']) {
    const img = win.getByRole('img', { name, exact: true })
    await expect(img).toBeVisible()
    await expect(img).toHaveAttribute('src', /^blob:/)
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  }
  await expect(win.locator('.tp-img').filter({ hasText: 'WebP' })).toContainText('WebP images are not supported yet')
  await expect(win.locator('.tp-img').filter({ hasText: 'Remote' })).toContainText('Remote image not loaded')
  await expect(win.locator('.tp-img').filter({ hasText: 'Share' })).toContainText('Unsupported image target')
  await expect(win.locator('.tp-img').filter({ hasText: 'Bad' })).not.toContainText('Image not loaded')
  expect(await win.locator('img').evaluateAll((images) => images.every((img) => img.getAttribute('src')?.startsWith('blob:')))).toBe(true)
  await win.screenshot({ path: test.info().outputPath('local-formats.png') })
  expect(l.pageErrors).toEqual([])
  await finish(l)
  expect(assertNetLog(log)).toContain('PASS')
})

/** A PNG whose header declares 4097 × 4097 pixels, over Z43's 16,777,216-pixel cap: refused before any pixel. */
function overCapPng(): Buffer {
  const png = imagePng()
  png.writeUInt32BE(4097, 16)
  png.writeUInt32BE(4097, 20)
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29) // IHDR's type and data
  return png
}

const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`

// Z43: no local capability is involved, so this runs on every platform.
test('inline data: images render from canonical blobs; SVG, malformed and over-cap ones keep alt text and reason without network', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>')
  const malformed = imagePng(16, 16).toString('base64').replace(/.$/, '*')
  const screenshot = imagePng(640, 160, true) // about 300 KB: its paragraph is far over 64 KiB, nearly all URL (D17)
  expect(screenshot.length).toBeGreaterThan(300_000)
  const urls: Record<string, string> = {
    PNG: dataUrl('image/png', imagePng(160, 32)), GIF: dataUrl('image/gif', imageGif), JPEG: dataUrl('IMAGE/JPEG', imageJpeg(128, 32)),
    WebP: dataUrl('image/webp', imageWebp), SVG: dataUrl('image/svg+xml', svg), Malformed: `data:image/png;base64,${malformed}`,
    'Over cap': dataUrl('image/png', overCapPng()), reference: dataUrl('image/png', imagePng(48, 48)),
    Screenshot: dataUrl('image/png', screenshot)
  }
  const source = fixture('embedded-images.md', [
    '# Embedded images', '',
    ...['PNG', 'GIF', 'JPEG', 'WebP'].flatMap((name) => [`![${name}](${urls[name]})`, '']),
    '![Reference PNG][png]', '',
    ...['SVG', 'Malformed', 'Over cap', 'Screenshot'].flatMap((name) => [`![${name}](${urls[name]})`, '']),
    `[png]: ${urls.reference}`, ''
  ].join('\n'))
  const log = test.info().outputPath('embedded-netlog.json')
  const l = await launch({ hooks: true, file: source, netlog: log })
  const { win } = l
  await waitRendered(win)
  for (const name of ['PNG', 'GIF', 'JPEG', 'Reference PNG', 'Screenshot']) {
    const img = win.getByRole('img', { name, exact: true })
    await expect(img).toBeVisible()
    await expect(img).toHaveAttribute('src', /^blob:/)
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  }
  for (const [name, reason] of [
    ['WebP', 'WebP images are not supported yet'],
    ['SVG', 'SVG images are not supported'],
    ['Malformed', 'Embedded image is not strict base64'],
    ['Over cap', 'PNG dimensions exceed the image limit']
  ]) await expect(win.locator('.tp-img').filter({ hasText: name })).toHaveText(`${name} · ${reason}`)
  // Each placeholder names its URL's source bytes; no URL or payload reaches the DOM.
  await expect(win.locator('.tp-img[data-embedded]')).toHaveCount(9)
  await expect(win.locator('.tp-img[data-src]')).toHaveCount(0)
  const html = await win.content()
  for (const url of Object.values(urls)) expect(html).not.toContain(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 17))
  expect(html).not.toContain('data:image')
  for (const colorScheme of ['light', 'dark'] as const) {
    await win.emulateMedia({ colorScheme })
    await win.screenshot({ path: test.info().outputPath(`embedded-${colorScheme}.png`) })
  }
  await win.locator('.file-pill[data-selected] .file-tab-close').click()
  await expectReleasedDocuments(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
  expect(assertNetLog(log, ['typose', 'blob'])).toContain('PASS') // no data: URL reached the network stack either
})

// A camera JPEG's ICC profile and a screenshot PNG's pHYs are ignored, not refused. Inline, so every platform runs it.
test('a JPEG with an ICC profile and a PNG with pHYs both load', async () => {
  const source = fixture('image-metadata.md', [
    '# Image metadata', '',
    `![ICC JPEG](${dataUrl('image/jpeg', imageJpegIcc(128, 32))})`, '',
    `![pHYs PNG](${dataUrl('image/png', imagePngPhys(160, 32))})`, ''
  ].join('\n'))
  const l = await launch({ file: source })
  const { win } = l
  await waitRendered(win)
  for (const name of ['ICC JPEG', 'pHYs PNG']) {
    const img = win.getByRole('img', { name, exact: true })
    await expect(img).toBeVisible()
    await expect(img).toHaveAttribute('src', /^blob:/)
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  }
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('two image loads at most; hidden and resumed trees retain their blobs and confirmed allowances', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('image-queue.png', imagePng(64, 64))
  const file = fixture('image-queue.md', '# Queue\n\n![First](image-queue.png) ![Second](image-queue.png) ![Third](image-queue.png)\n')
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    const state = { starts: 0, active: 0, max: 0, release: [] as (() => void)[] }
    ;(window as unknown as { imageQueue: typeof state }).imageQueue = state
    core.call = async (method, params) => {
      if (method === 'prepareImage') {
        state.starts++
        state.max = Math.max(state.max, ++state.active)
        const reply = await call(method, params)
        await new Promise<void>((done) => state.release.push(done))
        state.active--
        return reply
      }
      return call(method, params)
    }
  })
  await open(l, file)
  await waitRendered(win)
  await expect.poll(() => win.evaluate(() => (window as unknown as { imageQueue: { release: unknown[] } }).imageQueue.release.length)).toBe(2)
  expect(await win.evaluate(() => (window as unknown as { imageQueue: { starts: number } }).imageQueue.starts)).toBe(2)
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await win.evaluate(() => (window as unknown as { imageQueue: { release: (() => void)[] } }).imageQueue.release.splice(0).forEach((done) => done()))
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
  await expect.poll(() => win.evaluate(() => (window as unknown as { imageQueue: { starts: number } }).imageQueue.starts)).toBe(3)
  await expect.poll(() => win.evaluate(() => (window as unknown as { imageQueue: { release: unknown[] } }).imageQueue.release.length)).toBe(1)
  await win.evaluate(() => (window as unknown as { imageQueue: { release: (() => void)[] } }).imageQueue.release.splice(0).forEach((done) => done()))
  await expect(win.locator('.tp-img[data-loaded]')).toHaveCount(3)
  const urls = await win.locator('img').evaluateAll((images) => images.map((img) => img.getAttribute('src')))
  const held = (await stats(win))!.reserved
  for (let i = 0; i < 3; i++) {
    await win.getByRole('tab', { name: 'Raw', exact: true }).click()
    await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
    await waitRendered(win)
    expect((await stats(win))!.reserved).toBe(held)
    expect(await win.locator('img').evaluateAll((images) => images.map((img) => img.getAttribute('src')))).toEqual(urls)
  }
  expect(await win.evaluate(() => (window as unknown as { imageQueue: { starts: number; max: number } }).imageQueue)).toMatchObject({ starts: 3, max: 2 })
  await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.app.close?.())
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await expect.poll(async () => { const s = await debugStats(win); return [s.docs, s.jobs, s.tasks, s.handles] }).toEqual([0, 0, 0, 0])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a tight image budget keeps alt text and the reader; a delayed resource cannot populate a replacement', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('image-delayed.png', imagePng(128, 128))
  const file = fixture('image-delayed.md', '# Delayed\n\n![Delayed image](image-delayed.png)\n')
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await holdReply(win, 'prepareImage', 'releaseImageTest')
  await open(l, file)
  await waitRendered(win)
  const held = () => expect.poll(() => win.evaluate(() => typeof (window as unknown as { releaseImageTest?: () => void }).releaseImageTest)).toBe('function')
  const release = () => win.evaluate(() => { const state = window as unknown as { releaseImageTest?: () => void }; state.releaseImageTest?.(); delete state.releaseImageTest })
  await held()
  await debugStats(win, { limit: (await debugStats(win)).ledger.used })
  await release()
  await expect(win.locator('.tp-img')).toContainText('Delayed image · Memory budget is full')
  await expect(win.getByRole('heading', { name: 'Delayed', exact: true })).toBeVisible()
  // Restore a normal test limit; Reload has a new resource generation.
  await debugStats(win, { limit: 2 ** 30 })
  await win.keyboard.press('ControlOrMeta+r')
  await held()
  await open(l, fixture('image-replacement.md', '# Replacement\n'))
  await waitRendered(win)
  await release()
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  await expect(win.getByRole('heading', { name: 'Replacement', exact: true })).toBeVisible()
  await expect(win.locator('img')).toHaveCount(0)
  await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.app.close?.())
  await expect(win.getByRole('heading', { name: 'Delayed', exact: true })).toBeVisible()
  await expect.poll(async () => (await debugStats(win)).docs).toBe(1)
  await win.locator('.file-pill[data-selected] .file-tab-close').click()
  await expect.poll(async () => { const s = await debugStats(win); return [s.docs, s.jobs, s.tasks, s.handles] }).toEqual([0, 0, 0, 0])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('close cancels active and queued image reads within the measured chunk delay and releases native ownership', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('image-cancel.png', imagePng(2048, 2048))
  const file = fixture('image-cancel.md', '# Cancel images\n\n![First](image-cancel.png) ![Second](image-cancel.png)\n')
  const l = await launch({ hooks: true, env: { TYPOSE_TEST_READ_DELAY: '500' } })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await win.evaluate(() => {
    const state = window as unknown as { typoseTest: TestHooks & { core: { call(method: string, params: object, signal?: AbortSignal): Promise<unknown> } }; pendingImagePrepares: number }
    const core = state.typoseTest.core
    const call = core.call.bind(core)
    state.pendingImagePrepares = 0
    core.call = async (method, params, signal?: AbortSignal) => {
      const image = method === 'prepareImage'
      if (image) state.pendingImagePrepares++
      try { return await call(method, params, signal) }
      finally { if (image) state.pendingImagePrepares-- }
    }
  })
  await open(l, file)
  await waitRendered(win)
  const active = await win.evaluate(async () => {
    const state = window as unknown as { typoseTest: TestHooks; pendingImagePrepares: number }
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline) {
      const s = await state.typoseTest.core.call('debugStats', {}) as { jobs: number; tasks: number; handles: number }
      // Source + local root + active target snapshot, with both image prepares still pending.
      if (s.jobs === 0 && s.tasks >= 2 && s.handles === 3 && state.pendingImagePrepares === 2) {
        state.typoseTest.app.close!() // no browser-driver roundtrip between observation and close
        return s
      }
      await new Promise(done => setTimeout(done, 5))
    }
    throw new Error('Did not observe an active target snapshot and two pending image prepares')
  })
  expect(active.handles).toBe(3)
  await expect.poll(async () => { const s = await debugStats(win); return [s.docs, s.jobs, s.tasks, s.handles] }).toEqual([0, 0, 0, 0])
  const after = await debugStats(win)
  expect(after.cancels).toBeGreaterThanOrEqual(2)
  expect(after.cancelled).toBe(after.cancels)
  expect(after.cancelMs).toBeLessThan(after.delayMs + 50)
  await expectReleasedDocuments(win)
  console.log(`image close: ${after.cancelled} cancelled, ${after.cancelMs.toFixed(3)}ms after cancel, measured read delay ${after.delayMs.toFixed(3)}ms; native ownership at baseline`)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('an image request rechecks its Markdown source and raises the source-change banner', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('image-source.png', imagePng())
  const file = fixture('image-source.md', '# Original\n\n![Source image](image-source.png)\n')
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      if (method === 'prepareImage') await new Promise<void>((done) => { (window as unknown as { sourceImageHeld: () => void }).sourceImageHeld = done })
      return call(method, params)
    }
  })
  await open(l, file)
  await waitRendered(win)
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { sourceImageHeld?: () => void }).sourceImageHeld)).toBe('function')
  writeFileSync(file, '# Changed source\n')
  await win.evaluate(() => (window as unknown as { sourceImageHeld: () => void }).sourceImageHeld())
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await expect(win.getByRole('heading', { name: 'Original', exact: true })).toBeVisible()
  await expect(win.locator('img')).toHaveCount(0)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

for (const method of ['reload', 'openLocal'] as const) test(`${method} freezes late image growth before taking its retired allowance`, async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture(`image-handoff-${method}.png`, imagePng(128, 128))
  fixture(`image-handoff-${method}-target.md`, '# Navigation target\n')
  const source = fixture(`image-handoff-${method}.md`, `# Handoff\n\n[Next](image-handoff-${method}-target.md)\n\n![Late image](image-handoff-${method}.png)\n`)
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await win.evaluate((heldMethod) => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    const state = { first: true, chunks: 0, image: undefined as (() => void) | undefined, handoff: undefined as (() => void) | undefined }
    ;(window as unknown as { imageHandoff: typeof state }).imageHandoff = state
    core.call = async (method, params) => {
      if (method === heldMethod) await new Promise<void>((done) => { state.handoff = done })
      if (method === 'imageChunk') state.chunks++
      const reply = await call(method, params)
      if (method === 'prepareImage' && state.first) {
        state.first = false
        await new Promise<void>((done) => { state.image = done })
      }
      return reply
    }
  }, method)
  await open(l, source)
  await waitRendered(win)
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { imageHandoff: { image?: () => void } }).imageHandoff.image)).toBe('function')
  if (method === 'reload') await win.keyboard.press('ControlOrMeta+r')
  else await win.getByRole('link', { name: 'Next', exact: true }).click({ modifiers: ['Control'] })
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { imageHandoff: { handoff?: () => void } }).imageHandoff.handoff)).toBe('function')
  await win.evaluate(() => (window as unknown as { imageHandoff: { image: () => void } }).imageHandoff.image())
  await expect(win.locator('.tp-img')).toContainText('Memory budget is full')
  expect(await win.evaluate(() => (window as unknown as { imageHandoff: { chunks: number } }).imageHandoff.chunks)).toBe(0)
  await win.evaluate(() => (window as unknown as { imageHandoff: { handoff: () => void } }).imageHandoff.handoff())
  await waitRendered(win)
  if (method === 'reload') await expect(win.getByRole('img', { name: 'Late image', exact: true })).toBeVisible()
  else await expect(win.getByRole('heading', { name: 'Navigation target', exact: true })).toBeVisible()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

for (const side of [1024, 2048]) test(`local image ${side}px allocation, switches and Reload fit the held renderer allowance`, async () => {
  test.skip(process.platform !== 'win32', 'private-byte qualification and local backend currently Windows-only')
  fixture(`image-memory-${side}.png`, imagePng(side, side))
  const file = fixture(`image-memory-${side}.md`, `# Image memory\n\n![Memory image](image-memory-${side}.png)\n`)
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('HeapProfiler.collectGarbage')
  const renderer = async () => (await processMemory(l.app)).find((p) => p.type === 'Tab')!
  const baseline = (await renderer()).private!
  await holdReply(win, 'prepareImage', 'memoryImageHeld', true)
  await open(l, file)
  await waitRendered(win)
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { memoryImageHeld?: () => void }).memoryImageHeld)).toBe('function')
  const imageBaseline = (await renderer()).private!
  const baseRendered = (await stats(win))!.reserved
  await win.evaluate(() => (window as unknown as { memoryImageHeld: () => void }).memoryImageHeld())
  await expect(win.getByRole('img', { name: 'Memory image' })).toBeVisible()
  const sample = async (stage: string) => {
    const before = (await debugStats(win)).ledger.rendererCache
    const memory = (await renderer()).private!
    const after = (await debugStats(win)).ledger.rendererCache
    expect(after).toBe(before)
    const tree = (await stats(win))!
    const imagesAndRetired = tree.reserved + tree.retiredReserved - baseRendered
    console.log(JSON.stringify({ side, stage, baseline, imageBaseline, private: memory, reserved: after, imagesAndRetired }))
    expect(memory - baseline).toBeLessThanOrEqual(after + (32 << 20))
    // Raw's large viewport reservation cannot hide a missing image allowance.
    expect(memory - imageBaseline).toBeLessThanOrEqual(imagesAndRetired + (32 << 20))
  }
  await sample('loaded')
  for (let i = 0; i < 3; i++) {
    await win.getByRole('tab', { name: 'Raw', exact: true }).click()
    await sample(`raw-${i}`)
    await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
    await expect(win.getByRole('img', { name: 'Memory image' })).toBeVisible()
    await sample(`rendered-${i}`)
  }
  for (let i = 0; i < 2; i++) {
    const previous = await win.getByRole('img', { name: 'Memory image' }).getAttribute('src')
    await win.keyboard.press('ControlOrMeta+r')
    await expect(win.getByRole('img', { name: 'Memory image' })).toBeVisible()
    await expect(win.getByRole('img', { name: 'Memory image' })).not.toHaveAttribute('src', previous!)
    await expect.poll(async () => (await stats(win))!.retiredReserved).toBeGreaterThan(0)
    await sample(`reload-${i}`)
  }
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
