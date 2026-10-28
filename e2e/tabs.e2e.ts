import AxeBuilder from '@axe-core/playwright'
import { type Page, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, type TestHooks, debugStats, finish, fixture, launch, lifecycle, osFocus, pressAsOS, stubOpenDialog, test, visibleRows, waitIndexed, waitOpen } from './app'
import { processMemory } from './memory'
import { workspaceCharge } from '../app/renderer/workspace-budget'

const open = (l: Awaited<ReturnType<typeof launch>>, path: string) => l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), path)
const rendered = (win: Page) => expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1')
const tab = (win: Page, name: string) => win.getByRole('tab', { name, exact: true })

test('startup arguments open permanent tabs in order; a duplicate focuses its existing tab', async () => {
  const files = ['a', 'b', 'c'].map((name) => fixture('tabs-startup-' + name + '.txt', name + '\n'))
  const l = await launch({ hooks: true, file: [...files, files[0]] })
  await expect(l.win.locator('.file-tab-name')).toHaveText(['tabs-startup-a.txt', 'tabs-startup-b.txt', 'tabs-startup-c.txt'])
  await expect(l.win.locator('.card-name')).toHaveText('tabs-startup-a.txt')
  await waitOpen(l.win)
  await expect.poll(async () => (await debugStats(l.win)).docs).toBe(3)
  await closeTabs(l.win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Cmd+W closes the selected Mac tab while preserving the window and another tab', async () => {
  test.skip(process.platform !== 'darwin', 'macOS native accelerator')
  const a = fixture('tabs-mac-a.txt', 'A\n')
  const b = fixture('tabs-mac-b.txt', 'B\n')
  const l = await launch({ hooks: true, file: [a, b] })
  await expect(l.win.locator('.file-tab')).toHaveCount(2)
  await waitOpen(l.win)
  await osFocus(l)
  await pressAsOS(l, 'W', ['meta'])
  await expect(l.win.locator('.file-tab')).toHaveCount(1)
  await expect(l.win.locator('.card-name')).toHaveText('tabs-mac-a.txt')
  expect(l.app.windows()).toHaveLength(1)
  await closeTabs(l.win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

async function closeTabs(win: Page): Promise<void> {
  while (await win.locator('.file-tab-close').count()) {
    const before = await win.locator('.file-tab-close').count()
    await win.locator('.file-pill[data-selected] .file-tab-close').click()
    await expect(win.locator('.file-tab-close')).toHaveCount(before - 1)
  }
  await expect(win.locator('.open-button')).toBeVisible()
  await expect.poll(async () => { const s = await debugStats(win); return [s.docs, s.jobs, s.tasks, s.handles] }).toEqual([0, 0, 0, 0])
  await expect.poll(async () => { const final = await debugStats(win); return final.ledger.used - final.ledger.pool }).toBe(0)
}

test('permanent tabs retain document identity, Raw choice and source position; duplicate opens focus the existing tab', async () => {
  const a = fixture('tabs-a.md', '# Source A\n\n' + Array.from({ length: 400 }, (_, i) => 'Paragraph ' + i + '.\n').join('\n'))
  const b = fixture('tabs-b.txt', 'Document B.\n')
  const l = await launch({ hooks: true, file: a })
  const { win } = l
  await rendered(win)
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await waitOpen(win)
  await waitIndexed(win)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End')
  await expect.poll(async () => (await visibleRows(win))[0]?.line ?? 0).toBeGreaterThan(500)
  const before = (await visibleRows(win))[0].line
  await open(l, b)
  await expect(win.locator('.card-name')).toHaveText('tabs-b.txt')
  await waitOpen(win)
  await expect(win.locator('.file-tab')).toHaveCount(2)
  await expect.poll(async () => (await debugStats(win)).docs).toBe(2)
  const identities = Object.keys((await debugStats(win)).charges).sort()
  await tab(win, 'tabs-a.md').click()
  await waitOpen(win)
  await expect(win.getByRole('tab', { name: 'Raw', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => Math.abs((await visibleRows(win))[0].line - before)).toBeLessThanOrEqual(1)
  expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(identities)
  expect(await win.locator('.raw-host').count()).toBe(1)
  await open(l, b)
  await expect(win.locator('.card-name')).toHaveText('tabs-b.txt')
  await expect(win.locator('.file-tab')).toHaveCount(2)
  expect(Object.keys((await debugStats(win)).charges).sort()).toEqual(identities)
  await win.keyboard.press('Control+w')
  await expect(win.locator('.card-name')).toHaveText('tabs-a.md')
  await expect.poll(async () => (await debugStats(win)).docs).toBe(1)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('file pills disambiguate names, support keyboard selection and have no axe findings', async () => {
  for (const name of ['tabs-one', 'tabs-two']) mkdirSync(join(FIXTURES, name), { recursive: true })
  const one = fixture('tabs-one/README.md', '# First readme\n')
  const two = fixture('tabs-two/README.md', '# Second readme\n')
  const l = await launch({ hooks: true, file: one })
  const { win } = l
  await rendered(win)
  await open(l, two)
  await rendered(win)
  await expect(win.locator('.file-tab-parent')).toHaveText([' · tabs-one', ' · tabs-two'])
  await tab(win, 'README.md · tabs-two').focus()
  await win.keyboard.press('ArrowLeft')
  await expect(tab(win, 'README.md · tabs-one')).toBeFocused()
  await expect(win.getByRole('heading', { name: 'First readme' })).toBeVisible()
  const cdp = await win.context().newCDPSession(win)
  const ax = await cdp.send('Accessibility.getFullAXTree')
  const nodes = new Map(ax.nodes.map((node) => [node.nodeId, node]))
  const list = ax.nodes.find((node) => node.role?.value === 'tablist' && node.name?.value === 'Files')
  expect(list).toBeDefined()
  expect(list!.childIds?.map((id) => nodes.get(id)?.role?.value)).toEqual(['tab', 'tab'])
  const fileTabs = list!.childIds!.map((id) => nodes.get(id)!)
  expect(fileTabs.map((node) => node.name?.value)).toEqual(['README.md · tabs-one', 'README.md · tabs-two'])
  expect(fileTabs.flatMap((node) => node.childIds ?? []).some((id) => nodes.get(id)?.role?.value === 'button')).toBe(false)
  expect((await new AxeBuilder({ page: win }).setLegacyMode().analyze()).violations).toEqual([])
  await tab(win, 'README.md · tabs-one').focus()
  await win.keyboard.press('Tab')
  await expect(win.locator('.file-pill[data-selected] .file-tab-close')).toBeFocused()
  await win.keyboard.press('Space')
  await expect(win.locator('.file-tab')).toHaveCount(1)
  await expect(win.getByRole('heading', { name: 'Second readme' })).toBeVisible()
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('an activation overtaken by A-B-A cannot steal the view or close an owned document', async () => {
  const a = fixture('tabs-race-a.txt', 'A original\n' + 'A row\n'.repeat(200))
  const b = fixture('tabs-race-b.txt', 'B original\n' + 'B row\n'.repeat(200))
  const l = await launch({ hooks: true, file: a })
  const { win } = l
  await waitOpen(win)
  await open(l, b)
  await expect(win.locator('.card-name')).toHaveText('tabs-race-b.txt')
  await waitOpen(win)
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    let first = true
    core.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'activate' && first) {
        first = false
        await new Promise<void>((done) => { (window as unknown as { tabsRelease: () => void }).tabsRelease = done })
      }
      return reply
    }
  })
  await tab(win, 'tabs-race-a.txt').click()
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { tabsRelease?: () => void }).tabsRelease)).toBe('function')
  await tab(win, 'tabs-race-b.txt').click()
  await expect(win.locator('.card-name')).toHaveText('tabs-race-b.txt')
  await waitOpen(win)
  await win.evaluate(() => (window as unknown as { tabsRelease: () => void }).tabsRelease())
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End')
  await expect(win.locator('.vl-row .text').last()).toHaveText('B row')
  expect((await debugStats(win)).docs).toBe(2)
  await tab(win, 'tabs-race-a.txt').click()
  await waitOpen(win)
  await expect(win.locator('.vl-row .text').first()).toHaveText('A original')
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('last-close and a new file bypass a delayed old workspace grant before publication', async () => {
  const a = fixture('tabs-grant-a.txt', 'A\n')
  const b = fixture('tabs-grant-b.txt', 'B\n')
  const c = fixture('tabs-grant-c.txt', 'C\n')
  const d = fixture('tabs-grant-d.txt', 'D\n')
  const l = await launch({ hooks: true, file: a })
  const { win } = l
  await waitOpen(win)
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    let first = true
    core.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'reserveWorkspace' && first && (params as { bytes: number }).bytes > 0) {
        first = false
        await new Promise<void>((done) => { (window as unknown as { grantRelease: () => void }).grantRelease = done })
      }
      return reply
    }
  })
  await open(l, b)
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { grantRelease?: () => void }).grantRelease)).toBe('function')
  await open(l, d) // queued behind B, before last-close invalidates both requests
  await win.locator('.file-tab-close').click()
  await expect(win.locator('.file-tab')).toHaveCount(0)
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  expect((await debugStats(win)).ledger.rendererCache).toBeGreaterThan(0) // B/D still retain their prepublication metadata
  await open(l, c)
  await expect(win.locator('.card-name')).toHaveText('tabs-grant-c.txt', { timeout: 10_000 })
  await waitOpen(win)
  await win.evaluate(() => (window as unknown as { grantRelease: () => void }).grantRelease())
  await expect(win.locator('.file-tab')).toHaveCount(1)
  await expect(win.locator('.card-name')).toHaveText('tabs-grant-c.txt')
  await expect.poll(async () => (await debugStats(win)).docs).toBe(1)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a delayed replacement after A-B-A displays the new owned document identity', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend currently Windows-only')
  fixture('tabs-replace-a.md', '# Original A\n')
  const source = fixture('tabs-replace-source.md', '# Source\n\n[Next](tabs-replace-a.md)\n')
  const b = fixture('tabs-replace-b.txt', 'B retained\n')
  const c = fixture('tabs-replace-c.txt', 'C replacement\n')
  const l = await launch({ hooks: true, file: source })
  const { win } = l
  await rendered(win)
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await expect(win.locator('.card-name')).toHaveText('tabs-replace-a.md')
  await rendered(win)
  await open(l, b)
  await waitOpen(win)
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    let failActivation = true
    core.call = async (method, params) => {
      if (method === 'activate' && failActivation) {
        failActivation = false
        return call(method, { ...(params as object), bytes: Number.MAX_SAFE_INTEGER })
      }
      const reply = await call(method, params)
      if (method === 'open') await new Promise<void>((done) => {
        (window as unknown as { replacementRelease: () => void }).replacementRelease = done
      })
      return reply
    }
  })
  await tab(win, 'tabs-replace-a.md').click()
  await expect(win.locator('.card-message p')).toContainText('memory budget')
  await stubOpenDialog(l.app, c)
  await win.locator('.card-header .open-button').click()
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { replacementRelease?: () => void }).replacementRelease)).toBe('function')
  await tab(win, 'tabs-replace-b.txt').click()
  await waitOpen(win)
  await tab(win, 'tabs-replace-a.md').click()
  await rendered(win)
  await expect(win.getByRole('heading', { name: 'Original A' })).toBeVisible()
  await win.evaluate(() => (window as unknown as { replacementRelease: () => void }).replacementRelease())
  await expect(win.locator('.card-name')).toHaveText('tabs-replace-c.txt', { timeout: 10_000 })
  await waitOpen(win)
  await expect(win.locator('.vl-row .text').first()).toHaveText('C replacement')
  await expect(win.locator('.file-tab')).toHaveCount(2)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('an inactive file changed on disk offers Reload and recovers the retained tab', async () => {
  const a = fixture('tabs-frozen-a.txt', 'Original A\n')
  const b = fixture('tabs-frozen-b.txt', 'B\n')
  const l = await launch({ hooks: true, file: a })
  const { win } = l
  await waitOpen(win)
  await waitIndexed(win)
  await open(l, b)
  await expect(win.locator('.card-name')).toHaveText('tabs-frozen-b.txt')
  await waitOpen(win)
  fixture('tabs-frozen-a.txt', 'Changed A, with a different file size\n')
  await tab(win, 'tabs-frozen-a.txt').click()
  await expect(win.locator('.card-message p')).toContainText(/changed|snapshot|frozen/i)
  await win.getByRole('button', { name: 'Reload', exact: true }).click({ timeout: 10_000 })
  await waitOpen(win)
  await expect(win.locator('.vl-row .text').first()).toHaveText('Changed A, with a different file size')
  await expect(win.locator('.file-tab')).toHaveCount(2)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('leaving a pending activation for a failed tab does not leave a hidden active view', async () => {
  const a = fixture('tabs-pending-a.txt', 'A retained\n')
  const missing = join(FIXTURES, 'tabs-pending-missing-' + process.pid + '.txt')
  const l = await launch({ hooks: true, file: a })
  const { win } = l
  await waitOpen(win)
  await open(l, missing)
  await expect(win.locator('.card-message p')).toContainText('File not found')
  const workspace = (await debugStats(win)).ledger.rendererCache
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'activate' && !(window as unknown as { pendingTabRelease?: () => void }).pendingTabRelease) await new Promise<void>((done) => {
        (window as unknown as { pendingTabRelease: () => void }).pendingTabRelease = done
      })
      return reply
    }
  })
  await tab(win, 'tabs-pending-a.txt').click()
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { pendingTabRelease?: () => void }).pendingTabRelease)).toBe('function')
  await win.getByRole('tab', { name: /tabs-pending-missing-/ }).click()
  await expect(win.locator('.card-message p')).toContainText('File not found')
  await expect.poll(async () => (await debugStats(win)).ledger.rendererCache).toBe(workspace)
  await win.evaluate(() => (window as unknown as { pendingTabRelease: () => void }).pendingTabRelease())
  await expect.poll(async () => (await debugStats(win)).ledger.rendererCache).toBe(workspace)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a fresh open completed behind a failed tab retains its document without a hidden active view', async () => {
  const a = fixture('tabs-background-a.txt', 'A retained\n')
  const b = fixture('tabs-background-b.txt', 'B retained\n')
  const missing = join(FIXTURES, 'tabs-background-missing-' + process.pid + '.txt')
  const l = await launch({ hooks: true, file: a })
  const { win } = l
  await waitOpen(win)
  await open(l, missing)
  await expect(win.locator('.card-message p')).toContainText('File not found')
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'open') await new Promise<void>((done) => {
        (window as unknown as { backgroundRelease: () => void }).backgroundRelease = done
      })
      return reply
    }
  })
  await open(l, b)
  await expect.poll(() => win.evaluate(() => typeof (window as unknown as { backgroundRelease?: () => void }).backgroundRelease)).toBe('function')
  await win.getByRole('tab', { name: /tabs-background-missing-/ }).click()
  await win.evaluate(() => (window as unknown as { backgroundRelease: () => void }).backgroundRelease())
  await expect(win.locator('.card-message p')).toContainText('File not found')
  const units = [a, missing, b].reduce((n, path) => n + 2 * path.length + 'manual:'.length, 0)
  await expect.poll(async () => (await debugStats(win)).ledger.rendererCache).toBe(3 * workspaceCharge(3, units))
  expect((await debugStats(win)).docs).toBe(2)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

for (const stage of ['native read', 'reply'] as const) test('leaving during Reload ' + stage + ' retains the new generation without a hidden active view', async () => {
  const a = fixture('tabs-reload-' + stage + '.txt', 'A retained generation\n')
  const missing = join(FIXTURES, 'tabs-reload-missing-' + process.pid + '.txt')
  const l = await launch({ hooks: true, file: a, ...(stage === 'native read' ? { env: { TYPOSE_TEST_READ_DELAY: '500' } } : {}) })
  const { win } = l
  await waitOpen(win)
  await waitIndexed(win)
  await open(l, missing)
  await expect(win.locator('.card-message p')).toContainText('File not found')
  const workspace = (await debugStats(win)).ledger.rendererCache
  await tab(win, 'tabs-reload-' + stage + '.txt').click()
  await waitOpen(win)
  await win.evaluate((stage) => {
    const state = window as unknown as { reloadStarted: boolean; reloadFinished: boolean; reloadRelease?: () => void }
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      if (method === 'reload') state.reloadStarted = true
      const reply = await call(method, params)
      if (method === 'reload') {
        if (stage === 'reply') await new Promise<void>((done) => { state.reloadRelease = done })
        state.reloadFinished = true
      }
      return reply
    }
  }, stage)
  await win.keyboard.press('Control+r')
  await expect.poll(() => win.evaluate(() => !!(window as unknown as { reloadStarted: boolean }).reloadStarted)).toBe(true)
  if (stage === 'reply') await expect.poll(() => win.evaluate(() => typeof (window as unknown as { reloadRelease?: () => void }).reloadRelease)).toBe('function')
  else await debugStats(win) // ordered after Reload entered the host; its new-generation read is still delayed
  await win.getByRole('tab', { name: /tabs-reload-missing-/ }).click()
  if (stage === 'reply') await win.evaluate(() => (window as unknown as { reloadRelease: () => void }).reloadRelease())
  await expect.poll(() => win.evaluate(() => !!(window as unknown as { reloadFinished: boolean }).reloadFinished)).toBe(true)
  await expect.poll(async () => (await debugStats(win)).ledger.rendererCache).toBe(workspace)
  await tab(win, 'tabs-reload-' + stage + '.txt').click()
  await waitOpen(win)
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await expect(win.locator('.vl-row .text').first()).toHaveText('A retained generation')
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('derived local tabs retain their capability across selection and cannot regain manual privileges after a core restart', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend currently Windows-only')
  fixture('tabs-derived-target.md', '# Derived target\n')
  const source = fixture('tabs-derived-source.md', '# Source\n\n[Next](tabs-derived-target.md)\n')
  const other = fixture('tabs-derived-other.txt', 'Manual other\n')
  const l = await launch({ hooks: true, file: source })
  const { win } = l
  await rendered(win)
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await expect(win.locator('.card-name')).toHaveText('tabs-derived-target.md')
  await rendered(win)
  await open(l, other)
  await waitOpen(win)
  await tab(win, 'tabs-derived-target.md').click()
  await rendered(win)
  await expect(win.getByRole('heading', { name: 'Derived target' })).toBeVisible()
  await tab(win, 'tabs-derived-other.txt').click()
  await waitOpen(win)
  const spawned = lifecycle(l.userData).filter((r) => r.event === 'utility-spawn').at(-1)!
  process.kill(spawned.utilityPid as number)
  await expect(win.locator('.card-message p')).toContainText("Typose's core stopped")
  await tab(win, 'tabs-derived-target.md').click()
  await expect(win.getByRole('button', { name: 'Open file…', exact: true })).toBeEnabled()
  await expect(win.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0)
  await tab(win, 'tabs-derived-other.txt').click()
  await win.getByRole('button', { name: 'Reopen', exact: true }).click()
  await waitOpen(win)
  await tab(win, 'tabs-derived-target.md').click()
  await tab(win, 'tabs-derived-other.txt').click()
  await waitOpen(win)
  await expect(win.locator('.vl-row .text').first()).toHaveText('Manual other')
  expect((await debugStats(win)).docs).toBe(1)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('an unexpected local result path is abandoned and the still-owned source can be reactivated', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend currently Windows-only')
  fixture('tabs-mismatch-target.md', '# Target\n')
  const l = await launch({ hooks: true, file: fixture('tabs-mismatch-source.md', '# Original source\n\n[Next](tabs-mismatch-target.md)\n') })
  const { win } = l
  await rendered(win)
  await win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core
    const call = core.call.bind(core)
    core.call = async (method, params) => {
      const reply = await call(method, params)
      return method === 'openLocal' ? { ...(reply as object), path: 'unexpected different path' } : reply
    }
  })
  await win.getByRole('link', { name: 'Next', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Original source', exact: true })).toBeVisible()
  await expect(win.locator('.file-tab')).toHaveCount(1)
  await expect.poll(async () => (await debugStats(win)).docs).toBe(1)
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

for (const ax of [false, true]) for (const count of [16, 64]) test(count + ' tabs, accessibility ' + ax + ': persistent UI is paid separately from the selected viewport', async () => {
  test.skip(process.platform !== 'win32', 'private-byte qualification currently Windows-only')
  const files = Array.from({ length: count }, (_, i) => fixture('tabs-memory-' + count + '-' + i + '.txt', 'Small file ' + i + '\n'))
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.locator('.open-button')).toBeVisible()
  if (ax) await l.app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true))
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('HeapProfiler.collectGarbage')
  const privateBytes = async () => (await processMemory(l.app)).find((p) => p.type === 'Tab')!.private!
  const baseline = await privateBytes()
  for (const file of files) await open(l, file)
  await expect(win.locator('.file-tab')).toHaveCount(count)
  await expect(win.locator('.card-name')).toHaveText('tabs-memory-' + count + '-' + (count - 1) + '.txt')
  await waitOpen(win)
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  const sample = async (stage: string) => {
    const before = (await debugStats(win)).ledger.rendererCache
    const memory = await privateBytes()
    const raw = await win.evaluate(() => (window as unknown as { typoseTest: { client: { cache: () => { reserved: number } } } }).typoseTest.client.cache().reserved)
    const after = (await debugStats(win)).ledger.rendererCache
    expect(after).toBe(before)
    const workspace = after - raw
    expect(workspace).toBeGreaterThan(0)
    expect(memory - baseline).toBeLessThanOrEqual(workspace)
    const dom = await cdp.send('Memory.getDOMCounters')
    console.log(JSON.stringify({ count, ax, stage, baseline, private: memory, workspace, raw, total: after, dom }))
  }
  await sample('opened')
  await win.getByRole('button', { name: 'All open files', exact: true }).click()
  await expect(win.getByRole('menu', { name: 'All open files', exact: true })).toBeVisible()
  await sample('chooser')
  await win.keyboard.press('Escape')
  for (let i = 0; i < Math.min(count, 8); i++) {
    await tab(win, 'tabs-memory-' + count + '-' + i + '.txt').click()
    await waitOpen(win)
  }
  await sample('switched')
  await closeTabs(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
