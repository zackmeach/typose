// Plan PR 7's title bars and menus (brief §3.1, §3.2; spec §9): WCO on Windows, the traffic lights on macOS, ☰, and
// Electron's default menu gone.
import { expect } from '@playwright/test'
import { type Launched, finish, fixture, launch, lifecycle, osFocus, pressAsOS, stubOpenDialog, test, waitOpen } from './app'
import { HT, doubleClickMessage, hitTest, reaches, realMouse } from './win32'

const MAC = process.platform === 'darwin'
const center = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/**
 * A Windows launch at a known place on the work area, 900 × 600 and above every other window (so real input lands
 * on the bar), with points on its bar: the glyph, the title, empty bar between ☰ and the title, ☰, and the three
 * caption buttons, which share what WCO's title-bar area leaves at the right.
 */
async function placed() {
  const l = await launch()
  const { app, win } = l
  await expect(win.locator('.open-button')).toBeVisible()
  await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const area = screen.getPrimaryDisplay().workArea
    w.setBounds({ x: area.x + 40, y: area.y + 40, width: 900, height: 600 })
    w.setAlwaysOnTop(true)
  })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(900)
  const overlay = await win.evaluate(() => (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay.getTitlebarAreaRect().toJSON() as DOMRect)
  const button = (900 - overlay.x - overlay.width) / 3
  const y = overlay.height / 2
  const title = center((await win.locator('.title').boundingBox())!)
  const menu = center((await win.locator('.menu-button').boundingBox())!)
  const points = {
    glyph: center((await win.locator('.glyph').boundingBox())!),
    title,
    bar: { x: (menu.x + title.x) / 2, y },
    menu,
    minimize: { x: 900 - 2.5 * button, y },
    maximize: { x: 900 - 1.5 * button, y },
    close: { x: 900 - 0.5 * button, y }
  }
  return { l, overlay, points }
}

const maximized = (l: Launched) => l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())

test('Windows: the bar is the window’s caption except ☰, the caption buttons are WCO’s, and a double click on the bar maximizes', async () => {
  test.skip(process.platform !== 'win32', 'WCO is the Windows title bar (spec §9)')
  const { l, overlay, points: p } = await placed()
  const { app, win } = l
  expect(overlay.height).toBe(40) // WCO at 40 logical px
  // What Windows asks before every mouse event. HTCAPTION drags the window and maximizes it on a double click;
  // HTMAXBUTTON is what brings up Snap Layouts.
  const hits = await hitTest(app, [p.glyph, p.title, p.bar, p.menu, { x: 450, y: 300 }, p.minimize, p.maximize, p.close])
  expect(hits).toEqual([HT.CAPTION, HT.CAPTION, HT.CAPTION, HT.CLIENT, HT.CLIENT, HT.MINBUTTON, HT.MAXBUTTON, HT.CLOSE])
  // While ☰ is open, React Aria's underlay covers the window, and a click on it closes the menu: the bar is the page's
  // then, not a drag.
  await win.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(win.getByRole('menu')).toBeVisible()
  await expect.poll(() => hitTest(app, [p.bar, p.title])).toEqual([HT.CLIENT, HT.CLIENT])
  await win.keyboard.press('Escape')
  await expect(win.getByRole('menu')).toHaveCount(0)
  await expect.poll(() => hitTest(app, [p.bar])).toEqual([HT.CAPTION])
  // A double click on the bar, as Windows delivers it to the frame, maximizes, and another restores. (On ☰, HTCLIENT,
  // Windows sends the page's own double click instead.)
  await doubleClickMessage(app, p.bar)
  await expect.poll(() => maximized(l)).toBe(true)
  await doubleClickMessage(app, p.bar)
  await expect.poll(() => maximized(l)).toBe(false)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Windows, real input: dragging the bar moves the window, and double-clicking it maximizes', async () => {
  test.skip(process.platform !== 'win32', 'WCO is the Windows title bar (spec §9)')
  // Real input moves the real mouse, so never on a desktop someone may be using.
  test.skip(!process.env.CI && process.env.TYPOSE_REAL_INPUT !== '1', 'real input moves the real mouse: CI or TYPOSE_REAL_INPUT=1 only')
  const { l, points: p } = await placed()
  const { app } = l
  // Real input goes to whatever is under the cursor; win-input.ps1 checks again before every press.
  const reach = await reaches(app, p.bar)
  test.skip(!reach.reached, `real input can't reach the window: ${reach.under} is over its bar`)
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  const before = await bounds()
  await realMouse(app, 'drag', [p.bar, { x: p.bar.x + 60, y: p.bar.y + 40 }])
  const after = await bounds()
  // Within a few px: Windows' move loop can trail the cursor's last steps (57, 38 on PR CI's first run).
  expect(Math.abs(after.x - before.x - 60), `moved ${after.x - before.x}, ${after.y - before.y}`).toBeLessThanOrEqual(4)
  expect(Math.abs(after.y - before.y - 40), `moved ${after.x - before.x}, ${after.y - before.y}`).toBeLessThanOrEqual(4)
  expect(after.width).toBe(900)
  await realMouse(app, 'dblclick', [p.bar])
  await expect.poll(() => maximized(l)).toBe(true)
  await realMouse(app, 'dblclick', [p.bar])
  await expect.poll(() => maximized(l)).toBe(false)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('macOS: the traffic lights are centred in the 40 px bar, which has no ☰, and a long title keeps clear of them', async () => {
  test.skip(!MAC, 'the traffic lights are macOS’s')
  const l = await launch({ file: fixture(`${'a-long-file-name-'.repeat(14)}.txt`, 'text\n') }) // a title wider than the bar
  const { app, win } = l
  await waitOpen(win)
  // AppKit's window buttons are 14 px tall: centred in 40 px, they start 13 px down. Spike A placed them there.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition())).toEqual({ x: 14, y: (40 - 14) / 2 })
  expect((await win.locator('.titlebar').boundingBox())!.height).toBe(40)
  await expect(win.locator('.menu-button')).toHaveCount(0)
  // The lights take the first 68 px (x 14, three buttons); the title ellipsizes after 80.
  const title = (await win.locator('.title').boundingBox())!
  expect(title.x).toBeGreaterThanOrEqual(80)
  expect(title.x + title.width).toBeLessThanOrEqual((await win.evaluate(() => innerWidth)) - 80)
  await finish(l)
})

/** The app menu as main left it: each menu's role or label, and its items'. */
const appMenu = (l: Launched) =>
  l.app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()
    return m && m.items.map((i) => ({ label: i.label, role: i.role, items: i.submenu?.items.map((s) => s.role ?? s.label) }))
  })
const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
const lifetime = (l: Launched) => l.win.evaluate(() => (window as unknown as { pageLifetime?: string }).pageLifetime)

test('macOS: a minimal native menu, and Cmd+R is the page’s Reload', async () => {
  test.skip(!MAC, 'the native menu bar is macOS’s (brief §3.2)')
  const l = await launch({ file: fixture('accelerators.txt', lines.join('\n')) })
  const { win } = l
  await waitOpen(win)
  // Spec §9's minimal native menu: ☰'s commands and Close Window in File, and the menus every Mac app has. It has no
  // reload, developer-tools or zoom roles. (Whether sendInputEvent's keys reach a Mac menu is unverified, so the
  // dead-key test below is Windows' and Linux's.)
  const menu = await appMenu(l)
  expect(menu?.map((m) => m.role ?? m.label)).toEqual(['appmenu', 'File', 'editmenu', 'windowmenu'])
  expect(menu?.[1].items).toEqual(['Open File…', 'Open Folder…', 'Toggle Sidebar', 'Split Right', 'Move Tab Right', 'Close Card', 'Reload', 'Close Tab', 'Reopen Closed Tab', 'Clear Recently Closed Tabs', 'close'])
  await win.evaluate(() => Object.assign(window, { pageLifetime: 'the first page' }))
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '1')
  await pressAsOS(l, 'R', ['meta'])
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  expect(await lifetime(l)).toBe('the first page')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Electron’s default menu is gone: Force Reload and its other accelerators do nothing, and Ctrl+R is Reload', async () => {
  test.skip(MAC, 'macOS has its own minimal menu (above)')
  const l = await launch({ file: fixture('accelerators.txt', lines.join('\n')) })
  const { app, win } = l
  await waitOpen(win)
  expect(await appMenu(l)).toBeNull()
  await win.evaluate(() => Object.assign(window, { pageLifetime: 'the first page' }))
  // With the OS's focus and the bar allowed to show, a live menu's accelerators answer: the control below shows it.
  await osFocus(l)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMenuBarVisibility(true))
  // Positive control: here and now, a menu's accelerator is reached. A throwaway menu counts Force Reload's key; then,
  // gone again as main leaves it, the same key and the default menu's others do nothing.
  const presses = () => app.evaluate(() => (globalThis as { controlPresses?: number }).controlPresses ?? 0)
  await app.evaluate(({ Menu }) => {
    const count = () => void ((globalThis as { controlPresses?: number }).controlPresses = ((globalThis as { controlPresses?: number }).controlPresses ?? 0) + 1)
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Control', submenu: [{ label: 'Count', accelerator: 'Shift+CmdOrCtrl+R', click: count }] }]))
  })
  await pressAsOS(l, 'R', ['control', 'shift'])
  await expect.poll(presses).toBe(1)
  await app.evaluate(({ Menu }) => Menu.setApplicationMenu(null))
  await win.locator('.vl-scroller').focus()
  await pressAsOS(l, 'R', ['control', 'shift']) // Force Reload
  await pressAsOS(l, 'I', ['control', 'shift']) // Toggle Developer Tools
  await pressAsOS(l, 'Plus', ['control']) // Zoom In
  await pressAsOS(l, 'F11', []) // Toggle Full Screen
  await win.waitForTimeout(1000) // a page reload, the dev tools or a zoom would have begun by now
  expect(await presses()).toBe(1)
  expect(await lifetime(l)).toBe('the first page')
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { devTools: w.webContents.isDevToolsOpened(), zoom: w.webContents.getZoomFactor(), fullScreen: w.isFullScreen() }
    })
  ).toEqual({ devTools: false, zoom: 1, fullScreen: false })
  // Select All stays: the page's own editing key on Windows and Linux. (Copy is the same key table's, untested here:
  // it would write this desktop's clipboard.)
  await pressAsOS(l, 'A', ['control'])
  expect(await win.evaluate(() => getSelection()!.toString())).toContain('line 0')
  await win.evaluate(() => getSelection()!.removeAllRanges())
  // Ctrl+R is the page's own Reload (PR 4): the document's next generation, in the same page.
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '1')
  await pressAsOS(l, 'R', ['control'])
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  expect(await lifetime(l)).toBe('the first page')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

/** Waits up to 15 s for the app to exit, and checks it was a clean quit sequence, exit 0 (plan C9). */
async function quitCleanly(l: Launched): Promise<void> {
  expect(await Promise.race([l.exited, new Promise((ok) => setTimeout(() => ok('no exit within 15 s'), 15_000))])).toEqual({ code: 0, signal: null })
  const log = lifecycle(l.userData)
  const [before, will, quit] = ['before-quit', 'will-quit', 'quit'].map((e) => log.findIndex((r) => r.event === e))
  expect(0 < before && before < will && will < quit).toBe(true)
  expect(log[quit]).toMatchObject({ code: 0 })
}

test('☰ is a menu of Open file…, Reload and Exit, each wired to its command; the real Open dialog never opens', async () => {
  test.skip(MAC, 'macOS has the native menu bar instead (brief §3.2)')
  const first = fixture('menu-first.txt', 'first file\n')
  const second = fixture('menu-second.txt', 'second file\n')
  const l = await launch({ file: first })
  const { app, win } = l
  await waitOpen(win)
  await stubOpenDialog(app, second)

  const trigger = win.getByRole('button', { name: 'Menu', exact: true })
  const exit = process.platform === 'linux' ? 'Quit' : 'Exit' // brief §3.2
  const opened = async () => {
    await trigger.click()
    await expect(win.getByRole('menu')).toBeVisible()
    await expect(win.getByRole('menuitem')).toHaveText(['Open file…', 'Open folder…', 'Toggle sidebar', 'Split right', 'Move tab right', 'Close card', 'Reload', 'Close tab', 'Reopen closed tab', 'Clear recently closed tabs', exit])
  }
  // Escape closes it and gives focus back to ☰.
  await opened()
  await win.keyboard.press('Escape')
  await expect(win.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await opened()
  await win.getByRole('menuitem', { name: 'Reload' }).click()
  await expect(win.getByRole('menu')).toHaveCount(0)
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await opened()
  await win.getByRole('menuitem', { name: 'Open file…' }).click()
  await expect(win.locator('.card-name')).toHaveText('menu-second.txt')
  expect(await app.evaluate(() => (globalThis as { dialogCalls?: number }).dialogCalls)).toBe(1)
  await opened()
  await win.getByRole('menuitem', { name: exit }).click()
  await quitCleanly(l)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Ctrl+Q quits on Linux (brief §7.2), as ☰’s Quit does; on Windows it does nothing', async () => {
  test.skip(MAC, 'Cmd+Q is the native app menu’s Quit')
  const l = await launch()
  await expect(l.win.locator('.open-button')).toBeVisible()
  // On Linux the page closes on the keydown, before Playwright sends the keyup (PR CI run 40098228365).
  await l.win.keyboard.press('Control+Q').catch(() => {})
  if (process.platform === 'linux') await quitCleanly(l)
  else {
    await l.win.waitForTimeout(1000)
    expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  }
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
