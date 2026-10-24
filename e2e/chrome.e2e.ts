// Plan PR 7's title bars and menus (brief §3.1, §3.2; spec §9): WCO on Windows, the traffic lights on macOS, ☰, and
// Electron's default menu gone.
import { expect } from '@playwright/test'
import { type Launched, finish, fixture, launch, lifecycle, test, waitOpen } from './app'
import { HT, doubleClickMessage, hitTest, reaches, realMouse } from './win32'

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
  const { app } = l
  expect(overlay.height).toBe(40) // WCO at 40 logical px
  // What Windows asks before every mouse event. HTCAPTION drags the window and maximizes it on a double click;
  // HTMAXBUTTON is what brings up Snap Layouts.
  const hits = await hitTest(app, [p.glyph, p.title, p.bar, p.menu, { x: 450, y: 300 }, p.minimize, p.maximize, p.close])
  expect(hits).toEqual([HT.CAPTION, HT.CAPTION, HT.CAPTION, HT.CLIENT, HT.CLIENT, HT.MINBUTTON, HT.MAXBUTTON, HT.CLOSE])
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
  const { l, points: p } = await placed()
  const { app } = l
  // Real input goes to whatever is under the cursor. Locally that can be the lock screen; the test then can't run.
  const reach = await reaches(app, p.bar)
  test.skip(!reach.reached, `real input can't reach the window: ${reach.under} is over its bar`)
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  const before = await bounds()
  await realMouse(app, 'drag', [p.bar, { x: p.bar.x + 60, y: p.bar.y + 40 }])
  const after = await bounds()
  expect({ dx: after.x - before.x, dy: after.y - before.y, width: after.width }).toEqual({ dx: 60, dy: 40, width: 900 })
  await realMouse(app, 'dblclick', [p.bar])
  await expect.poll(() => maximized(l)).toBe(true)
  await realMouse(app, 'dblclick', [p.bar])
  await expect.poll(() => maximized(l)).toBe(false)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('macOS: the traffic lights are centred in the 40 px bar, which has no ☰ (the native menu bar is the menu)', async () => {
  test.skip(process.platform !== 'darwin', 'the traffic lights are macOS’s')
  const l = await launch()
  const { app, win } = l
  await expect(win.locator('.open-button')).toBeVisible()
  // AppKit's window buttons are 14 px tall: centred in 40 px, they start 13 px down. Spike A placed them there.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition())).toEqual({ x: 14, y: (40 - 14) / 2 })
  expect((await win.locator('.titlebar').boundingBox())!.height).toBe(40)
  await expect(win.locator('.menu-button')).toHaveCount(0)
  await finish(l)
})

test('Electron’s default menu is gone: Force Reload and its other accelerators do nothing, and Ctrl+R is Reload', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
  const l = await launch({ file: fixture('accelerators.txt', lines.join('\n')) })
  const { app, win } = l
  await waitOpen(win)
  const menu = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()
    return m && m.items.map((i) => ({ label: i.label, role: i.role, items: i.submenu?.items.map((s) => s.label) }))
  })
  if (process.platform === 'darwin') {
    // Spec §9's minimal native menu: ☰'s commands in File, and the menus every Mac app has.
    expect(menu?.map((m) => m.role ?? m.label)).toEqual(['appmenu', 'File', 'editmenu', 'windowmenu'])
    expect(menu?.[1].items).toEqual(['Open File…', 'Reload'])
  } else expect(menu).toBeNull()
  // Shown, so a menu that came back would be live wherever its bar can be (states.e2e.ts does the same for Ctrl+R).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMenuBarVisibility(true))
  await win.evaluate(() => Object.assign(window, { pageLifetime: 'the first page' }))
  // Keys as the OS delivers them: Playwright's keyboard goes through CDP, which never reaches a menu's accelerators.
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  const press = (keyCode: string, modifiers: ('control' | 'meta' | 'shift')[]) =>
    app.evaluate(
      ({ BrowserWindow }, { keyCode, modifiers }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        for (const type of ['keyDown', 'char', 'keyUp'] as const)
          if (type !== 'char' || keyCode.length === 1) contents.sendInputEvent({ type, keyCode: type === 'char' ? keyCode.toLowerCase() : keyCode, modifiers })
      },
      { keyCode, modifiers }
    )
  await win.locator('.vl-scroller').focus()
  await press('R', [mod, 'shift']) // Force Reload
  await press('I', [mod, 'shift']) // Toggle Developer Tools
  await press('Plus', [mod]) // Zoom In
  await press('F11', []) // Toggle Full Screen
  await win.waitForTimeout(1000) // a page reload, the dev tools or a zoom would have begun by now
  expect(await win.evaluate(() => (window as unknown as { pageLifetime?: string }).pageLifetime)).toBe('the first page')
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { devTools: w.webContents.isDevToolsOpened(), zoom: w.webContents.getZoomFactor(), fullScreen: w.isFullScreen() }
    })
  ).toEqual({ devTools: false, zoom: 1, fullScreen: false })
  // Select All stays: the page's own editing key on Windows and Linux, the native Edit menu's on macOS. (Copy is the
  // same key table's, untested here: it would write this desktop's clipboard.)
  await press('A', [mod])
  expect(await win.evaluate(() => getSelection()!.toString())).toContain('line 0')
  await win.evaluate(() => getSelection()!.removeAllRanges())
  // Ctrl+R is the page's own Reload (PR 4): the document's next generation, in the same page.
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '1')
  await press('R', [mod])
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  expect(await win.evaluate(() => (window as unknown as { pageLifetime?: string }).pageLifetime)).toBe('the first page')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('☰ is a menu of Open file…, Reload and Exit, each wired to its command; the real Open dialog never opens', async () => {
  test.skip(process.platform === 'darwin', 'macOS has the native menu bar instead (brief §3.2)')
  const first = fixture('menu-first.txt', 'first file\n')
  const second = fixture('menu-second.txt', 'second file\n')
  const l = await launch({ file: first })
  const { app, win } = l
  await waitOpen(win)
  // Open file… asks main for the OS dialog. Main's handler is replaced first, so no dialog can open on this desktop, and
  // the dialog itself is made to fail, in case anything else reached it.
  await app.evaluate(({ dialog, ipcMain }, second) => {
    dialog.showOpenDialog = () => Promise.reject(new Error('the real dialog was reached'))
    ipcMain.removeHandler('open-dialog')
    ipcMain.handle('open-dialog', () => {
      ;(globalThis as { dialogCalls?: number }).dialogCalls = ((globalThis as { dialogCalls?: number }).dialogCalls ?? 0) + 1
      return second
    })
  }, second)
  await expect(app.evaluate(({ dialog }) => dialog.showOpenDialog({}))).rejects.toThrow('the real dialog was reached')

  const trigger = win.getByRole('button', { name: 'Menu' })
  const exit = process.platform === 'linux' ? 'Quit' : 'Exit' // brief §3.2
  const opened = async () => {
    await trigger.click()
    await expect(win.getByRole('menu')).toBeVisible()
    await expect(win.getByRole('menuitem')).toHaveText(['Open file…', 'Reload', exit])
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
  // Exit quits the app: a clean quit sequence, exit 0 (plan C9).
  await opened()
  await win.getByRole('menuitem', { name: exit }).click()
  expect(await Promise.race([l.exited, new Promise((ok) => setTimeout(() => ok('no exit within 15 s'), 15_000))])).toEqual({ code: 0, signal: null })
  const log = lifecycle(l.userData)
  const [before, will, quit] = ['before-quit', 'will-quit', 'quit'].map((e) => log.findIndex((r) => r.event === e))
  expect(0 < before && before < will && will < quit).toBe(true)
  expect(log[quit]).toMatchObject({ code: 0 })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
