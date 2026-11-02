// Z79's hand-offs: Copy path, Show in Explorer and Open with default app, from the card, the sidebar and the sheets.
// The test-hooks build records main's shell calls under TYPOSE_TEST_SHELL=record; the real shell is also replaced by
// one that throws, so no test here can open Explorer or an app.
import AxeBuilder from '@axe-core/playwright'
import { type ElectronApplication, type Page, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { FIXTURES, finish, fixture, launch, test, waitOpen } from './app'

const SHOW = process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'linux' ? 'Show in folder' : 'Show in Explorer'
const RECORD = { TYPOSE_TEST_SHELL: 'record' }
type Call = { action: 'show' | 'open'; path: string }

/** Main's recorded hand-offs. Reaching the real shell throws, so a missed recorder fails rather than launching. */
async function shellCalls(app: ElectronApplication): Promise<() => Promise<Call[]>> {
  await app.evaluate(({ shell }) => {
    shell.openPath = () => Promise.reject(new Error('the real shell was reached'))
    shell.showItemInFolder = () => { throw new Error('the real shell was reached') }
  })
  return () => app.evaluate(() => (globalThis as { typoseShellCalls?: Call[] }).typoseShellCalls ?? [])
}

/** Copy path writes through navigator.clipboard; record it in the page instead of the shared OS clipboard. */
async function copies(win: Page): Promise<() => Promise<string[]>> {
  await win.evaluate(() => {
    const state = window as unknown as { copied: string[] }
    state.copied = []
    navigator.clipboard.writeText = async (text: string) => { state.copied.push(text) }
  })
  return () => win.evaluate(() => (window as unknown as { copied: string[] }).copied)
}

async function axe(win: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page: win }).setLegacyMode().analyze()
  return violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
}

/**
 * A bridge call from page script during a real click, as an injected control could make one: the gesture is the user's,
 * the subject is whatever the page chose. Returns main's answer.
 */
async function viaGesture(win: Page, action: 'showInFolder' | 'openWithDefault', subject: unknown): Promise<unknown> {
  await win.evaluate(([action, subject]) => {
    let probe = document.getElementById('handoff-probe')
    if (!probe) {
      probe = Object.assign(document.createElement('button'), { id: 'handoff-probe', textContent: 'probe' })
      probe.dataset.handoff = 'true'
      probe.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647'
      document.body.append(probe)
    }
    const state = window as unknown as { typose: Record<string, (subject: unknown) => Promise<unknown>>; probed?: Promise<unknown> }
    probe.onclick = () => { state.probed = state.typose[action as string](subject) }
  }, [action, subject] as const)
  await win.locator('#handoff-probe').click()
  return win.evaluate(() => (window as unknown as { probed: Promise<unknown> }).probed)
}

const notice = (win: Page) => win.locator('.reader-card .banner[role="status"]')
async function fileAction(win: Page, name: string): Promise<void> {
  await win.getByRole('button', { name: 'File actions', exact: true }).click()
  await win.getByRole('menuitem', { name, exact: true }).click()
}

/** The real folder picker never opens: main's handler answers `selected`. */
async function addFolder(app: ElectronApplication, win: Page, selected: string): Promise<void> {
  await app.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showOpenDialog = () => Promise.reject(new Error('the real folder dialog was reached'))
    ipcMain.removeHandler('folder-dialog')
    ipcMain.handle('folder-dialog', () => path)
  }, selected)
  await win.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await win.getByRole('button', { name: /Add folder/ }).click()
  await expect(win.getByRole('treeitem', { name: basename(selected), exact: true })).toBeVisible()
}

test('the card menu copies the path, shows the file and opens it, each through one recorded call', async () => {
  const file = fixture('handoff-notes.txt', 'notes\n')
  const l = await launch({ hooks: true, file, env: RECORD })
  const { win } = l
  const calls = await shellCalls(l.app)
  await waitOpen(win)
  const copied = await copies(win)
  await fileAction(win, 'Copy path')
  await expect.poll(copied).toEqual([file])
  await expect(notice(win)).toHaveText('Path copied')
  await fileAction(win, SHOW)
  await expect.poll(calls).toEqual([{ action: 'show', path: file }])
  await fileAction(win, 'Open with default app')
  await expect.poll(calls).toEqual([{ action: 'show', path: file }, { action: 'open', path: file }])
  // The keyboard reaches it: Enter opens the menu on its first item, Escape closes it back to the button.
  await win.getByRole('button', { name: 'File actions', exact: true }).focus()
  await win.keyboard.press('Enter')
  await expect(win.getByRole('menuitem', { name: 'Copy path', exact: true })).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(win.getByRole('menu')).toHaveCount(0)
  await expect(win.getByRole('button', { name: 'File actions', exact: true })).toBeFocused()
  // Enter on a hand-off item is a gesture too.
  await win.keyboard.press('Enter')
  await win.keyboard.press('ArrowDown')
  await expect(win.getByRole('menuitem', { name: SHOW, exact: true })).toBeFocused()
  await win.keyboard.press('Enter')
  await expect.poll(calls).toEqual([{ action: 'show', path: file }, { action: 'open', path: file }, { action: 'show', path: file }])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a hand-off from page script without a user gesture is refused, and a trusted click still works', async () => {
  const file = fixture('handoff-gesture.txt', 'gesture\n')
  const l = await launch({ hooks: true, file, env: RECORD })
  const { win } = l
  const calls = await shellCalls(l.app)
  await waitOpen(win)
  const results = await win.evaluate(async () => {
    const api = (window as unknown as { typose: Record<'showInFolder' | 'openWithDefault', (subject: unknown) => Promise<unknown>> }).typose
    // Page-made events are untrusted, so even a press on a marked control arms nothing.
    const control = Object.assign(document.createElement('div'), { tabIndex: 0 })
    control.dataset.handoff = 'true'
    document.body.append(control)
    control.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    control.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    return [await api.showInFolder({ session: 1, doc: 1, gen: 1 }), await api.openWithDefault({ session: 1, doc: 1, gen: 1 })]
  })
  expect(results).toEqual([{ ok: false, reason: 'Hand-offs need a click or key press on a Typose control' }, { ok: false, reason: 'Hand-offs need a click or key press on a Typose control' }])
  expect(await calls()).toEqual([])
  await fileAction(win, SHOW)
  await expect.poll(calls).toEqual([{ action: 'show', path: file }])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Open with default app refuses programs, scripts and shortcuts with a message, and Show still works', async () => {
  const bat = fixture('setup.bat', '@echo off\necho hi\n')
  const ps1 = fixture('run.ps1', 'Write-Output hi\n')
  const lnk = fixture('Tool.lnk', Buffer.from('L\0\0\0\x01\x14\x02\0', 'latin1'))
  const l = await launch({ hooks: true, file: [bat, ps1, lnk], env: RECORD })
  const { win } = l
  const calls = await shellCalls(l.app)
  for (const name of ['setup.bat', 'run.ps1']) {
    await win.getByRole('tab', { name, exact: true }).click()
    await waitOpen(win)
    await fileAction(win, 'Open with default app')
    await expect(notice(win)).toHaveText('Typose won’t open programs or scripts · show the file in its folder instead')
    expect(await calls()).toEqual([])
  }
  await win.getByRole('tab', { name: 'Tool.lnk', exact: true }).click()
  await expect(win.locator('.card-message')).toContainText('Binary file · not shown')
  await win.getByRole('button', { name: 'Open with default app', exact: true }).click()
  await expect(notice(win)).toHaveText('Typose won’t open programs or scripts · show the file in its folder instead')
  await win.getByRole('button', { name: SHOW, exact: true }).click()
  await expect.poll(calls).toEqual([{ action: 'show', path: lnk }])
  // The page's bridge, called with the path main handed it during a real click, gets the same refusal: main decides.
  expect(await viaGesture(win, 'openWithDefault', { path: lnk })).toEqual({ ok: false, reason: 'Typose won’t open programs or scripts · show the file in its folder instead' })
  expect(await calls()).toEqual([{ action: 'show', path: lnk }])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('the bridge refuses paths Typose never held, other sessions’ documents, and network and device paths', async () => {
  const held = fixture('handoff-held.txt', 'held\n')
  const elsewhere = fixture('handoff-elsewhere.txt', 'never opened\n')
  const device = '\\\\?\\' + fixture('handoff-device.txt', 'device path\n')
  const l = await launch({ hooks: true, file: [held, device], env: RECORD })
  const { win } = l
  const calls = await shellCalls(l.app)
  await expect(win.getByRole('tab')).toHaveCount(2)
  // Each call carries a real click's gesture, so what refuses it is the subject.
  const results: unknown[] = []
  for (const subject of [{ path: elsewhere }, { path: 'C:\\Windows\\notepad.exe' }, { path: '\\\\example.invalid\\share\\x.txt' }, { path: '//example.invalid/share/x.txt' },
    { path: held.toUpperCase() }, held, [held], null, { session: 1, doc: 999, gen: 1 }, { session: 999, doc: 1, gen: 1 }, { session: 1, doc: 1, gen: 999 },
    { session: 1, doc: 1, gen: 1, target: '..\\..\\Windows\\notepad.exe' }, { entry: { session: 1, root: '1', node: '0' } }])
    for (const action of ['showInFolder', 'openWithDefault'] as const) results.push(await viaGesture(win, action, subject))
  expect(results.every((r) => (r as { ok: boolean }).ok === false), JSON.stringify(results)).toBe(true)
  expect(await viaGesture(win, 'showInFolder', { path: held })).toEqual({ ok: true }) // the control: the probe's gesture is accepted
  expect(await calls()).toEqual([{ action: 'show', path: held }])
  await l.app.evaluate(() => { (globalThis as { typoseShellCalls?: unknown[] }).typoseShellCalls!.length = 0 })
  // A network path never gets as far as the OS even when main handed it to the page: `\\?\` is refused at main.
  await win.getByRole('tab', { name: 'handoff-device.txt', exact: true }).click()
  await fileAction(win, SHOW)
  await expect(notice(win)).toHaveText('Typose doesn’t hand off network or device paths')
  expect(await calls()).toEqual([])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a binary file shows why, with Open with default app and Show in folder, and axe finds nothing', async () => {
  const file = fixture('q3-report.csv', Buffer.from('id,amount\n1,\0\0\x01\x02\n', 'latin1'))
  const l = await launch({ hooks: true, file, env: RECORD })
  const { win } = l
  const calls = await shellCalls(l.app)
  const message = win.locator('.card-message')
  await expect(message.locator('p')).toHaveText(['Binary file · not shown', 'It has a .csv name but contains NUL bytes in the first 8 KB.'])
  await expect(message.getByRole('button')).toHaveText(['Open with default app', SHOW])
  expect(await axe(win)).toEqual([])
  await message.getByRole('button', { name: SHOW, exact: true }).click()
  await message.getByRole('button', { name: 'Open with default app', exact: true }).click()
  await expect.poll(calls).toEqual([{ action: 'show', path: file }, { action: 'open', path: file }])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('the sidebar: an unsupported file opens its sheet, a program its executable sheet, and file rows have a menu', async () => {
  test.skip(process.platform !== 'win32', 'folder browsing is currently Windows-only')
  mkdirSync(FIXTURES, { recursive: true })
  const root = mkdtempSync(join(FIXTURES, 'handoff-folder-'))
  writeFileSync(join(root, 'cover.png'), 'not really a png')
  writeFileSync(join(root, 'tool.exe'), 'not really a program')
  writeFileSync(join(root, 'readme.md'), '# Readme\n')
  let l: Awaited<ReturnType<typeof launch>> | undefined
  try {
    l = await launch({ hooks: true, env: RECORD })
    const { win } = l
    const calls = await shellCalls(l.app)
    await addFolder(l.app, win, root)
    const cover = win.getByRole('treeitem', { name: 'cover.png', exact: true })
    await cover.locator('.folder-row').click()
    const sheet = win.getByRole('dialog', { name: 'Typose doesn\'t show PNG files' })
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('code')).toHaveText(join(root, 'cover.png'))
    await expect(sheet.getByRole('button')).toHaveText(['Cancel', 'Open with default app', SHOW])
    await expect(sheet.getByRole('button', { name: SHOW })).toBeFocused()
    expect(await axe(win)).toEqual([])
    await win.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(cover).toBeFocused()
    await cover.locator('.folder-row').click()
    await sheet.getByRole('button', { name: 'Open with default app' }).click()
    await expect(sheet).toHaveCount(0)
    await expect.poll(calls).toEqual([{ action: 'open', path: join(root, 'cover.png') }])

    await win.getByRole('treeitem', { name: 'tool.exe', exact: true }).locator('.folder-row').click()
    const program = win.getByRole('dialog', { name: 'Typose won\'t run tool.exe' })
    await expect(program).toContainText('Scripts and programs are never launched from Typose. You can show the file in its folder instead.')
    await expect(program.getByRole('button')).toHaveText(['Cancel', SHOW])
    await program.getByRole('button', { name: 'Cancel' }).click()
    await expect(program).toHaveCount(0)

    // The row's menu, from the keyboard: Shift+F10 opens it on its first item.
    const copied = await copies(win)
    await cover.focus()
    await win.keyboard.press('Shift+F10')
    const menu = win.getByRole('menu', { name: 'Actions for cover.png' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy path', SHOW, 'Open with default app'])
    await expect(menu.getByRole('menuitem', { name: 'Copy path' })).toBeFocused()
    expect(await axe(win)).toEqual([])
    await win.keyboard.press('Enter')
    await expect.poll(copied).toEqual([join(root, 'cover.png')])
    await expect(cover).toBeFocused()
    await win.getByRole('treeitem', { name: 'tool.exe', exact: true }).locator('.folder-row').click({ button: 'right' })
    await win.getByRole('menuitem', { name: SHOW }).click()
    await win.getByRole('treeitem', { name: 'tool.exe', exact: true }).locator('.folder-row').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Open with default app' }).click()
    await expect(notice(win)).toHaveText('Typose won’t open programs or scripts · show the file in its folder instead')
    await expect.poll(calls).toEqual([{ action: 'open', path: join(root, 'cover.png') }, { action: 'show', path: join(root, 'tool.exe') }])
    expect(l.pageErrors).toEqual([])
  } finally {
    try { if (l) await finish(l) } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('a Rendered link to a script shows the executable sheet, never opens it, and Show reveals it', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const script = fixture('setup.bat', '@echo off\n')
  const source = fixture('handoff-links.md', '# Kit\n\nRun [the installer](setup.bat) first.\n')
  const l = await launch({ hooks: true, file: source, env: RECORD })
  const { win } = l
  const calls = await shellCalls(l.app)
  await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
  const link = win.getByRole('link', { name: 'the installer', exact: true })
  await link.click()
  const sheet = win.getByRole('dialog', { name: 'Typose won\'t run setup.bat' })
  await expect(sheet).toContainText('Scripts and programs are never launched from a link. You can show the file in its folder instead.')
  await expect(sheet.locator('code')).toHaveText(script)
  await expect(sheet.getByRole('button')).toHaveText(['Cancel', SHOW])
  expect(await axe(win)).toEqual([])
  await win.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(link).toBeFocused()
  await link.click()
  await sheet.getByRole('button', { name: SHOW }).click()
  await expect.poll(calls).toEqual([{ action: 'show', path: script }])
  await expect(win.getByRole('dialog', { name: 'Link preview' })).toHaveCount(0)
  await expect(win.locator('.card-name')).toHaveText('handoff-links.md')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
