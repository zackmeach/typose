// Plan PR 7's accessibility gates (Z39, spec §6.3): the accessibility mode main forwards (§6.2), Raw and the chrome
// in the accessibility trees (CDP, and UIA on Windows), focus, the keyboard, axe, and 200% zoom. No screen-reader
// claim: real-reader testing stays parked.
import AxeBuilder from '@axe-core/playwright'
import { type Page, expect } from '@playwright/test'
import { closeSync, openSync, writeSync } from 'node:fs'
import { type Launched, finish, fixture, launch, test, visibleRows, waitIndexed, waitOpen } from './app'
import { HT, hitTest, uiaNodes, uiaTree } from './win32'

const MAC = process.platform === 'darwin'
/** Electron's accessibility-support API and event are macOS's and Windows' (Z28 gates accessibility there). */
const MODE = process.platform !== 'linux'
const EXIT = process.platform === 'linux' ? 'Quit' : 'Exit' // brief §3.2
/** Lines with no digit in them, so a digit in Raw's accessible text could only be the gutter's. Line 3 is wide, in
 *  one row: Z66 wraps a row at 2,048 units, and End goes to the widest row's end. */
const letters = (n: number): string => (n < 26 ? '' : letters(Math.floor(n / 26) - 1)) + String.fromCharCode(97 + (n % 26))
const LINES = Array.from({ length: 5000 }, (_, i) => (i === 2 ? `wide ${'x'.repeat(2000)} end` : `line ${letters(i)} text`))
const RAW = 'a11y.txt, Raw'

async function opened(): Promise<Launched> {
  const l = await launch({ file: fixture('a11y.txt', LINES.join('\n')) })
  await waitOpen(l.win)
  return l
}

interface AXNode {
  nodeId: string
  ignored: boolean
  role?: { value: string }
  name?: { value: string }
  properties?: { name: string; value: { value: unknown } }[]
  childIds?: string[]
}

/** The page's accessibility tree as Chromium builds it, read over CDP. */
async function axTree(win: Page) {
  const cdp = await win.context().newCDPSession(win)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] }
  await cdp.detach()
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const under = (n: AXNode): AXNode[] => (n.childIds ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!, ...under(byId.get(id)!)] : []))
  const find = (role: string, name?: string) => nodes.filter((n) => !n.ignored && n.role?.value === role && (name === undefined || n.name?.value === name))
  const prop = (n: AXNode, name: string) => n.properties?.find((p) => p.name === name)?.value.value
  /** The text a reader gets inside `n`: its static text. */
  const text = (n: AXNode) => under(n).filter((c) => !c.ignored && c.role?.value === 'StaticText').map((c) => c.name?.value ?? '').join('\n')
  return { nodes, under, find, prop, text }
}

test('the accessibility mode comes from main at load and on every change, and only from the page’s own window', async () => {
  test.skip(!MODE, 'Electron has no accessibility-support API on Linux (Z28)')
  const l = await launch()
  const { app, win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  const mode = win.locator('html')
  const initial = await app.evaluate(({ app }) => app.isAccessibilitySupportEnabled())
  await expect(mode).toHaveAttribute('data-a11y', initial ? 'on' : 'off')
  for (const on of [true, false, true, false]) {
    await app.evaluate(({ app }, on) => app.setAccessibilitySupportEnabled(on), on)
    await expect(mode).toHaveAttribute('data-a11y', on ? 'on' : 'off')
  }
  // The same message from another window (an iframe's) is ignored. The unit test (a11y.test.ts) covers the rest.
  await win.evaluate(() => {
    const frame = document.body.appendChild(document.createElement('iframe'))
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'a11y', on: true }, origin: location.origin, source: frame.contentWindow }))
    frame.remove()
  })
  await win.waitForTimeout(200)
  await expect(mode).toHaveAttribute('data-a11y', 'off')
  await finish(l)
})

test('Raw is a named region whose text leaves out the gutter, and ☰ exposes menu roles, through CDP and UIA', async () => {
  const l = await opened()
  const { app, win } = l
  if (MODE) {
    await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true)) // as a screen reader turns it on
    await expect(win.locator('html')).toHaveAttribute('data-a11y', 'on')
  }
  const shown = await visibleRows(win)
  expect(shown.length).toBeGreaterThan(10)

  const cdp = await axTree(win)
  const [region] = cdp.find('region', RAW)
  expect(region).toBeDefined()
  const said = cdp.text(region)
  for (const r of shown) expect(said).toContain(r.text)
  expect(said).not.toMatch(/\d/) // the gutter's numbers aren't read
  if (!MAC) {
    const [trigger] = cdp.find('button', 'Menu')
    expect({ popup: cdp.prop(trigger, 'hasPopup'), expanded: cdp.prop(trigger, 'expanded') }).toEqual({ popup: 'menu', expanded: false })
    await win.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(win.getByRole('menu')).toBeVisible()
    const open = await axTree(win)
    const [menu] = open.find('menu')
    expect(open.under(menu).filter((n) => n.role?.value === 'menuitem').map((n) => n.name?.value)).toEqual(['Open file…', 'Open folder…', 'Toggle sidebar', 'Split right', 'Move tab right', 'Close card', 'Reload', 'Find in file…', 'Next match', 'Previous match', 'Close tab', 'Reopen closed tab', 'Clear recently closed tabs', EXIT])
    await win.keyboard.press('Escape')
  }

  if (process.platform === 'win32') {
    const tree = uiaNodes(await uiaTree(app))
    const raw = tree.find((n) => n.localized === 'region' && n.name === RAW)
    expect(raw).toBeDefined()
    const uiaSaid = uiaNodes(raw!).filter((n) => n.type === 'Text').map((n) => n.name).join('\n')
    for (const r of shown) expect(uiaSaid).toContain(r.text)
    expect(uiaSaid).not.toMatch(/\d/)
    expect(tree.find((n) => n.name === 'Menu')).toMatchObject({ type: 'Button', expand: 'Collapsed' })
    await win.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(win.getByRole('menu')).toBeVisible()
    const menu = uiaNodes(await uiaTree(app)).find((n) => n.type === 'Menu')
    expect(menu?.children?.filter((n) => n.type === 'MenuItem').map((n) => n.name)).toEqual(['Open file…', 'Open folder…', 'Toggle sidebar', 'Split right', 'Move tab right', 'Close card', 'Reload', 'Find in file…', 'Next match', 'Previous match', 'Close tab', 'Reopen closed tab', 'Clear recently closed tabs', EXIT])
    await win.keyboard.press('Escape')
  }
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('focus stays in Raw across scrolling, far jumps and page replacement', async () => {
  const l = await opened()
  const { app, win } = l
  if (MODE) {
    await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true)) // as a screen reader turns it on
    await expect(win.locator('html')).toHaveAttribute('data-a11y', 'on')
  }
  expect(await waitIndexed(win)).toBe(5000)
  const scroller = win.locator('.vl-scroller')
  await scroller.focus()
  /** Focus is on Raw: in the DOM, and in Chromium's accessibility tree; in UIA too while the window has the OS's
   *  focus, the only time UIA reports keyboard focus (spike B's uia-element.ps1). Another window, or the lock screen,
   *  can hold it: on CI every step must be checked, and locally at least one. UIA's tree can trail the page's, so it's
   *  polled. */
  let uiaUnchecked = 0
  const inRaw = async (when: string) => {
    expect(await scroller.evaluate((el) => el === document.activeElement), when).toBe(true)
    const cdp = await axTree(win)
    const focused = cdp.nodes.filter((n) => cdp.prop(n, 'focused') === true && n.role?.value !== 'RootWebArea') // the page, around it
    expect(focused.map((n) => `${n.role?.value} ${n.name?.value}`), when).toEqual([`region ${RAW}`])
    if (process.platform !== 'win32') return
    if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()))
      await expect.poll(async () => uiaNodes(await uiaTree(app)).find((n) => n.name === RAW)?.focus, { message: when }).toBe(true)
    else uiaUnchecked++
  }
  const first = await visibleRows(win)
  await inRaw('opened')
  for (let i = 0; i < 3; i++) await win.keyboard.press('PageDown')
  await win.mouse.move(400, 400)
  await win.mouse.wheel(0, 600)
  await expect.poll(async () => (await visibleRows(win))[0].line).toBeGreaterThan(first.at(-1)!.line)
  await inRaw('scrolled')
  // A far jump: every row on screen is replaced, by pages fetched for it.
  await win.keyboard.press('Control+End')
  await expect.poll(async () => (await visibleRows(win)).at(-1)).toEqual({ line: 5000, text: LINES[4999] })
  expect((await visibleRows(win)).every((r) => r.text === LINES[r.line - 1])).toBe(true)
  await inRaw('after Ctrl+End')
  await win.keyboard.press('Control+Home')
  await expect.poll(async () => (await visibleRows(win))[0]).toEqual({ line: 1, text: LINES[0] })
  await inRaw('after Ctrl+Home')
  // Reload replaces every page with the next generation's (a new lens).
  await win.keyboard.press('Control+R')
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await expect.poll(async () => (await visibleRows(win))[0]).toEqual({ line: 1, text: LINES[0] })
  await inRaw('after Reload')
  if (uiaUnchecked) test.info().annotations.push({ type: 'unchecked', description: `UIA's focus, ${uiaUnchecked} of 5 times: the window hadn't the OS's focus` })
  if (process.platform === 'win32') expect(uiaUnchecked, 'steps whose UIA focus went unchecked').toBeLessThanOrEqual(process.env.CI ? 0 : 4)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Reload from the "Changed on disk" banner leaves the focus in Raw', async () => {
  // 60,000 lines of 64 bytes, and a same-size write near the end, then a far jump to it: the document freezes before
  // anything there was read (as in states.e2e.ts).
  const line = (n: number) => `line ${n}`.padEnd(63, '.')
  const file = fixture('a11y-banner.txt', Array.from({ length: 60_000 }, (_, n) => `${line(n)}\n`).join(''))
  const l = await launch({ file })
  const { win } = l
  await waitOpen(win)
  expect(await waitIndexed(win)).toBe(60_000)
  const fd = openSync(file, 'r+')
  writeSync(fd, 'CHANGED'.padEnd(63, '!'), 59_990 * 64)
  closeSync(fd)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End')
  await expect(win.locator('.banner')).toBeVisible()
  // The banner's button, from the keyboard: it goes with the banner, so the focus must land in the new lens.
  await win.locator('.banner-button').focus()
  await win.keyboard.press('Enter')
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await expect(win.locator('.banner')).toHaveCount(0)
  await expect(win.locator('.vl-scroller')).toBeFocused()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

/** Bounded traversal through the reader chrome, including sidebar and card controls. */
async function tabTo(win: Page, target: string, key = 'Tab'): Promise<number> {
  for (let n = 1; n <= 10; n++) {
    await win.keyboard.press(key)
    if (await win.locator(target).evaluate((el) => el === document.activeElement)) return n
  }
  throw new Error(`${key} didn't reach ${target} in 10 presses`)
}

/** Blur preserves Chromium's sequential focus position; focus the body to start before the page's first control. */
async function focusStart(win: Page): Promise<void> {
  await win.evaluate(() => {
    const body = document.body
    const before = body.getAttribute('tabindex')
    body.tabIndex = -1
    body.focus({ preventScroll: true })
    if (before === null) body.removeAttribute('tabindex')
    else body.setAttribute('tabindex', before)
  })
}

test('the keyboard reaches ☰ and Raw, ☰ runs its commands from the keyboard, and the focus ring shows', async () => {
  const l = await opened()
  const { win } = l
  await focusStart(win)
  const stops: [selector: string, ringOffset: string][] = [
    ...(!MAC ? [['.menu-button', '2px'] as [string, string]] : []),
    ['.sidebar-toggle', '2px'],
    ['.file-tab[aria-selected="true"]', '2px'],
    ['.file-pill[data-selected] .file-tab-close', '2px'],
    ['.card-header .card-status', '2px'],
    ['.close-card-button', '2px'],
    ['.vl-scroller', '-2px']
  ]
  const atStop = async ([selector, offset]: [string, string]) => {
    await expect(win.locator(selector)).toBeFocused()
    // Brief §9's accent ring: outside the chrome controls and status, inset on Raw.
    expect(await win.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.outlineStyle, style.outlineColor, style.outlineWidth, style.outlineOffset]
    })).toEqual(['solid', 'rgb(143, 176, 255)', '2px', offset])
  }
  for (const stop of stops) {
    await win.keyboard.press('Tab')
    await atStop(stop)
  }
  for (const stop of stops.slice(0, -1).reverse()) {
    await win.keyboard.press('Shift+Tab')
    await atStop(stop)
  }
  if (!MAC) await keyboardMenu(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

/** ☰ from the keyboard, from ☰: Enter opens it on its first item, the arrows move, Enter runs Reload, and focus
 *  comes back to ☰. */
async function keyboardMenu(win: Page): Promise<void> {
  await win.keyboard.press('Enter')
  await expect(win.getByRole('menuitem', { name: 'Open file…' })).toBeFocused()
  await win.keyboard.press('ArrowDown')
  await expect(win.getByRole('menuitem', { name: 'Open folder…' })).toBeFocused()
  await win.keyboard.type('Reload')
  await expect(win.getByRole('menuitem', { name: 'Reload' })).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(win.getByRole('menu')).toHaveCount(0)
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await expect(win.locator('.menu-button')).toBeFocused()
}

/** axe-core on the page: every violation, of any impact, as `impact id: targets`. */
async function axe(win: Page): Promise<string[]> {
  // Legacy mode: the default run opens a second page for its final step, which Electron's context refuses (spike B).
  const { violations } = await new AxeBuilder({ page: win }).setLegacyMode().analyze()
  return violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
}

test('axe finds no violations on the chrome: empty, with Raw, with ☰ open, and at 200% zoom', async () => {
  const report: Record<string, string[]> = {}
  const empty = await launch()
  await expect(empty.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  report.empty = await axe(empty.win)
  await finish(empty)

  const l = await opened()
  const { app, win } = l
  report.raw = await axe(win)
  if (!MAC) {
    await win.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(win.getByRole('menu')).toBeVisible()
    report.menu = await axe(win)
    await win.keyboard.press('Escape')
  }
  const width = await win.evaluate(() => innerWidth)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(width / 2)
  report.zoom = await axe(win)
  expect(report).toEqual({ empty: [], raw: [], ...(MAC ? {} : { menu: [] }), zoom: [] })
  await finish(l)
})

test('axe control: it does flag an unnamed button, so a clean report means something', async () => {
  const l = await launch()
  await expect(l.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await l.win.evaluate(() => document.querySelector('main')!.append(document.createElement('button')))
  expect((await axe(l.win)).join('\n')).toContain('button-name')
  await finish(l)
})

test('at 200% zoom in the smallest window, the chrome and Raw stay reachable, and wide lines still scroll', async () => {
  const l = await opened()
  const { app, win } = l
  // Brief §9: 200% zoom in the 720 × 480 minimum window.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setContentSize(720, 480) // Linux's frame is outside it
    w.webContents.setZoomFactor(2)
  })
  await expect.poll(() => win.evaluate(() => [innerWidth, innerHeight])).toEqual([360, 240])
  const inView = (selector: string) =>
    win.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    })
  expect(await inView('.vl-scroller')).toBe(true)
  await focusStart(win)
  if (!MAC) {
    expect(await inView('.menu-button')).toBe(true)
    if (process.platform === 'win32') {
      // Clear of the caption buttons, and still the page's to click; the bar still drags.
      const area = await win.evaluate(() => (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay.getTitlebarAreaRect().toJSON() as DOMRect)
      const menu = (await win.locator('.menu-button').boundingBox())!
      expect(menu.x + menu.width).toBeLessThanOrEqual(area.x + area.width)
      const glyph = (await win.locator('.glyph').boundingBox())!
      expect(await hitTest(app, [{ x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 }, { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 }])).toEqual([HT.CLIENT, HT.CAPTION])
    }
    await tabTo(win, '.menu-button')
    await win.keyboard.press('Enter')
    await expect(win.getByRole('menuitem')).toHaveText(['Open file…', 'Open folder…', 'Toggle sidebar', 'Split right', 'Move tab right', 'Close card', 'Reload', 'Find in file…', 'Next match', 'Previous match', 'Close tab', 'Reopen closed tab', 'Clear recently closed tabs', EXIT])
    for (const item of await win.getByRole('menuitem').all()) {
      await expect(item).toBeFocused()
      expect(await item.evaluate(el => {
        const rect = el.getBoundingClientRect()
        return rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      })).toBe(true)
      await win.keyboard.press('ArrowDown')
    }
    await win.keyboard.press('Escape')
  }
  await tabTo(win, '.vl-scroller')
  // The wide line's end, beyond the viewport, comes into view with End (horizontal, PR 1).
  const endInView = () =>
    win.evaluate(() => {
      const text = [...document.querySelectorAll('.vl-row .text')].find((t) => t.textContent!.endsWith(' end'))!.firstChild!
      const range = document.createRange()
      range.setStart(text, text.textContent!.length - 3)
      range.setEnd(text, text.textContent!.length)
      const r = range.getBoundingClientRect()
      const v = document.querySelector('.vl-scroller')!.getBoundingClientRect()
      return r.left >= v.left && r.right <= v.right
    })
  expect(await endInView()).toBe(false)
  await win.keyboard.press('End')
  await expect.poll(endInView).toBe(true)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
