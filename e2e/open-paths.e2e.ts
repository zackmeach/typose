// Z79's ways in, and Z78's restore. A drop of files and folders opens them as Open file… and Open folder… do, and a
// UNC path is refused unopened; a folder named on the command line becomes a sidebar root; Raw's Wrap lines wraps to
// the card as continuation rows; and a file the core died reading comes back unopened after a restart.
import { type Page, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { emptySession } from '../app/shared/session'
import { FIXTURES, type Launched, type TestHooks, debugStats, finish, fixture, launch, lifecycle, test, visibleRows, waitIndexed, waitOpen } from './app'
import { command, query } from './find-ui'

type Item = { path: string; folder: boolean }
/** The core refuses folder browsing off Windows, so a dropped or named folder becomes a root only there. */
const FOLDERS = process.platform === 'win32'

/**
 * A drag over the window (`enter`) or its drop, as a page script's DragEvents. A script's File has no path, so the
 * test-hooks preload takes the items a script's drop lists. A string drags plain text instead of files.
 */
const drag = (win: Page, phase: 'enter' | 'drop', items: Item[] | string) => win.evaluate(({ phase, items }) => {
  const data = new DataTransfer()
  if (typeof items === 'string') data.setData('text/plain', items)
  else {
    data.items.add(new File(['x'], 'x'))
    data.setData('application/x-typose-test-drop', JSON.stringify(items))
  }
  const target = document.querySelector('.card-row') ?? document.body
  const fire = (type: string) => target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
  if (phase === 'enter') fire('dragenter')
  fire('dragover')
  if (phase === 'drop') fire('drop')
}, { phase, items })

function folderFixture(name: string, files: Record<string, string>): string {
  mkdirSync(FIXTURES, { recursive: true })
  const root = mkdtempSync(join(FIXTURES, name + '-'))
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
  return root
}

const tabs = (win: Page) => win.locator('.file-tab-name')

test('a drop shows its target, opens files as tabs in the focused card and folders as sidebar roots, several at once', async () => {
  const first = fixture('open-paths-drop.md', '# Dropped\n\nfirst file\n')
  const second = fixture('open-paths-drop-2.txt', 'second file\n')
  const root = folderFixture('open-paths-drop-root', { 'inside.md': '# Inside\n' })
  const other = folderFixture('open-paths-drop-other', { 'other.csv': 'a,b\n1,2\n' })
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('heading', { name: 'Drop files or folders anywhere' })).toBeVisible({ timeout: 30_000 })

  await drag(win, 'enter', [{ path: first, folder: false }])
  await expect(win.locator('.drop-target')).toBeVisible()
  await expect(win.locator('.drop-target')).toContainText('Drop to open')
  await drag(win, 'drop', [{ path: first, folder: false }])
  await expect(win.locator('.drop-target')).toHaveCount(0)
  await expect(tabs(win)).toHaveText(['open-paths-drop.md'], { timeout: 30_000 })
  await expect(win.getByRole('heading', { name: 'Dropped' })).toBeVisible({ timeout: 30_000 })

  if (FOLDERS) {
    await drag(win, 'drop', [{ path: root, folder: true }])
    await expect(win.getByRole('treeitem', { name: basename(root), exact: true })).toBeVisible()
    await expect(win.getByRole('treeitem', { name: 'inside.md', exact: true })).toBeVisible()
    expect(await tabs(win).count()).toBe(1) // a folder opens no tab
  }

  await drag(win, 'drop', [{ path: second, folder: false }, ...(FOLDERS ? [{ path: other, folder: true }] : [])])
  await expect(tabs(win)).toHaveText(['open-paths-drop.md', 'open-paths-drop-2.txt'])
  if (FOLDERS) {
    await expect(win.getByRole('treeitem', { name: basename(other), exact: true })).toBeVisible()
    await expect(win.getByRole('treeitem', { name: 'other.csv', exact: true })).toBeVisible()
  }
  await waitOpen(win)
  expect(win.url()).toBe('typose://app/index.html') // the window never navigated to a dropped file
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a real drop, in the shipping build, opens a file as a tab and a folder as a root', async () => {
  const file = fixture('open-paths-cdp.txt', 'dropped for real\n')
  const root = folderFixture('open-paths-cdp-root', { 'real.md': '# Real\n' })
  const l = await launch() // no test hooks: only a trusted drop's files have paths
  const { win } = l
  await expect(win.getByRole('heading', { name: 'Drop files or folders anywhere' })).toBeVisible({ timeout: 30_000 })
  const cdp = await win.context().newCDPSession(win)
  const box = (await win.locator('.card-row').boundingBox())!
  // Chromium's own drag input, as the OS's would arrive: its files are real paths.
  const drop = async (files: string[]) => {
    const data = { items: [], files, dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
      await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data })
  }
  await drop([file])
  await expect(tabs(win)).toHaveText(['open-paths-cdp.txt'], { timeout: 30_000 })
  await waitOpen(win)
  expect((await visibleRows(win))[0]).toEqual({ line: 1, text: 'dropped for real' })
  if (FOLDERS) {
    await drop([root])
    await expect(win.getByRole('treeitem', { name: basename(root), exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(win.getByRole('treeitem', { name: 'real.md', exact: true })).toBeVisible()
  }
  await expect(tabs(win)).toHaveText(['open-paths-cdp.txt'])
  expect(win.url()).toBe('typose://app/index.html')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a UNC drop is refused before anything opens it, and text or link drags are ignored', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('heading', { name: 'Drop files or folders anywhere' })).toBeVisible({ timeout: 30_000 })
  const unc = '\\\\example.invalid\\share\\x.md' // never a real host: the refusal is main's, before any access
  await drag(win, 'drop', [{ path: unc, folder: false }, { path: '\\\\example.invalid\\share', folder: true }])
  await expect(win.locator('.banner')).toHaveText(`Can't open ${unc}, \\\\example.invalid\\share · UNC share, device and virtual paths can't be dropped`)
  await expect(tabs(win)).toHaveCount(0)
  await expect(win.getByRole('treeitem')).toHaveCount(0)
  expect(await debugStats(win)).toMatchObject({ docs: 0 })
  // Over 256 items, a drop opens none of them, and says so.
  const many = fixture('open-paths-many.txt', 'many\n')
  await drag(win, 'drop', Array.from({ length: 257 }, () => ({ path: many, folder: false })))
  await expect(win.locator('.banner')).toHaveText("Can't open 257 items at once · drop at most 256")
  await expect(tabs(win)).toHaveCount(0)

  await drag(win, 'enter', 'some text')
  await expect(win.locator('.drop-target')).toHaveCount(0)
  await drag(win, 'drop', 'https://example.invalid/x.md')
  await win.waitForTimeout(300)
  await expect(tabs(win)).toHaveCount(0)
  expect(win.url()).toBe('typose://app/index.html')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a folder named on the command line becomes a sidebar root, and a file beside it still opens as a tab', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  const file = fixture('open-paths-argv.md', '# Argv file\n')
  const root = folderFixture('open-paths-argv-root', { 'notes.md': '# Notes\n' })
  const l = await launch({ file: [file, root] })
  const { win } = l
  await expect(win.getByRole('treeitem', { name: basename(root), exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(win.getByRole('treeitem', { name: 'notes.md', exact: true })).toBeVisible()
  await expect(tabs(win)).toHaveText(['open-paths-argv.md'])
  await expect(win.getByText('refused: a folder')).toHaveCount(0)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a FIFO named on the command line stays a refused tab, never a root', async () => {
  test.skip(process.platform === 'win32', 'Windows has no FIFOs')
  const directory = mkdtempSync(join(tmpdir(), 'typose-fifo-'))
  const fifo = join(directory, 'named.fifo')
  try {
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    const l = await launch({ file: [fifo] })
    const { win } = l
    await expect(win.locator('.card-message p')).toHaveText(`Can't open ${fifo} · refused: not a regular file`, { timeout: 30_000 })
    await expect(win.getByRole('treeitem')).toHaveCount(0)
    expect(l.pageErrors).toEqual([])
    await finish(l)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a second-instance open while Settings shows switches the card back to the opened file, and Wrap lines is a palette command', async () => {
  const first = fixture('open-paths-settings-a.txt', 'first' + String.fromCharCode(10))
  const second = fixture('open-paths-settings-b.txt', 'second' + String.fromCharCode(10))
  const l = await launch({ file: first })
  const { win, app } = l
  await waitOpen(win)
  await win.keyboard.press(command + '+,')
  const settings = win.getByRole('tab', { name: '⚙ Settings', exact: true })
  await expect(settings).toHaveAttribute('aria-selected', 'true')
  // main's second-instance handler sends exactly this for a path named on a later command line.
  await app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), second)
  await expect(win.getByRole('tab', { name: 'open-paths-settings-b.txt' })).toHaveAttribute('aria-selected', 'true')
  await expect(settings).toHaveAttribute('aria-selected', 'false')
  await win.keyboard.press(command + '+K')
  await win.getByRole('combobox', { name: 'Search commands' }).fill('Wrap lines')
  await win.keyboard.press('Enter')
  await expect(win.locator('html')).toHaveAttribute('data-wrap-lines', 'true')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Raw wraps a 10,000-character line and CJK to the card when Wrap lines is on, and Find and Go to land on the line', async () => {
  // Line 2: 1,000 ten-character segments. Line 3: CJK, wide and astral, 600 graphemes of 1,200 columns.
  const long = Array.from({ length: 1000 }, (_, i) => `seg${String(i).padStart(6, '0')} `).join('')
  const cjk = '漢字𠀋かな'.repeat(120)
  const text = ['first', long, cjk, ...Array.from({ length: 200 }, (_, i) => `line ${i + 4}`)].join('\n') + '\n'
  const l = await launch({ hooks: true, file: fixture('open-paths-wrap.txt', text) })
  const { win } = l
  await waitOpen(win)
  await waitIndexed(win)
  const rows = (line: number) => win.locator(`.vl-row[data-line="${line}"]`)
  const texts = (line: number) => rows(line).evaluateAll(els => els.sort((a, b) => Number((a as HTMLElement).dataset.sub) - Number((b as HTMLElement).dataset.sub))
    .map(el => el.querySelector('.text')?.textContent ?? ''))
  const overflow = () => win.locator('.vl-scroller').evaluate(el => el.scrollWidth - el.clientWidth)
  const cache = () => win.evaluate(() => (window as unknown as { typoseTest: TestHooks & { client: { cache: (() => { charged: number; cap: number }) | null } } }).typoseTest.client.cache!())

  // Off: Z66's rows of at most 2,048 units, wider than the card.
  await expect(rows(1)).toHaveCount(5)
  expect(await overflow()).toBeGreaterThan(0)

  await win.evaluate(() => { document.documentElement.dataset.wrapLines = 'true' })
  await expect.poll(() => rows(1).count()).toBeGreaterThan(5)
  await expect.poll(overflow).toBeLessThanOrEqual(0)
  const shown = await texts(1)
  const whole = shown[0].length // as many whole 10-character segments as fit: a row breaks after a space, never inside a segment
  expect(whole).toBeGreaterThan(20)
  expect(whole % 10).toBe(0)
  expect(shown.every((row, i) => row === long.slice(i * whole, (i + 1) * whole))).toBe(true)
  await expect(rows(1).first().locator('.more')).toHaveText('↪') // Z66's continuation marker: the line goes on
  const charged = await cache()
  expect(charged.charged).toBeGreaterThan(0)
  expect(charged.charged).toBeLessThanOrEqual(charged.cap)

  const goTo = async (line: number) => {
    await win.locator('.vl-scroller').focus()
    await win.keyboard.press(command + '+g')
    const input = win.getByRole('form', { name: 'Go to line' }).getByRole('spinbutton')
    await input.fill(String(line))
    await input.press('Enter')
  }
  await goTo(3)
  await expect(rows(2).first()).toBeInViewport()
  const wide = await texts(2)
  expect(wide.join('')).toBe(cjk.slice(0, wide.join('').length))
  for (const row of wide.slice(0, -1)) {
    expect([...row].length * 2, row).toBeLessThan(whole + 10) // two columns each; the card holds from whole to whole + 9 columns
    expect([...row].length * 2, row).toBeGreaterThanOrEqual(whole)
    expect(row, 'no surrogate pair split').not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  }

  await goTo(150)
  await expect(win.locator('.vl-row[data-line="149"][data-sub="0"]')).toBeInViewport()
  await expect(win.locator('.vl-row[data-line="149"] .text')).toHaveText('line 150')

  // Find lands on line 2, on the row that shows the match.
  await query(win, win.getByRole('region', { name: 'Reader card 1' }), 'seg000999')
  await expect(win.locator('.raw-find-excerpt')).toContainText('line 2')
  await expect.poll(async () => (await win.locator('.vl-row').evaluateAll(els => {
    const box = document.querySelector('.vl-scroller')!.getBoundingClientRect()
    const top = els.map(el => ({ el: el as HTMLElement, at: el.getBoundingClientRect().top })).filter(r => r.at >= box.top - 1).sort((a, b) => a.at - b.at)[0]
    return `${top.el.dataset.line}:${top.el.dataset.sub}`
  }))).toBe(`1:${Math.floor(9990 / whole)}`)
  await win.keyboard.press('Escape')

  // A narrower window wraps again, narrower.
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
  await goTo(2)
  await expect.poll(async () => (await texts(1))[0]?.length).toBeLessThan(whole)
  await expect.poll(overflow).toBeLessThanOrEqual(0)

  // Off again: back to Z66's rows.
  await win.evaluate(() => { document.documentElement.dataset.wrapLines = 'false' })
  await expect(rows(1)).toHaveCount(5)
  expect((await visibleRows(win))[0]).toEqual({ line: 2, text: long.slice(0, (await texts(1))[0].length) })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

/** Kills the newest session's core host by its pid, as core-death.e2e.ts does. */
function killCore(l: Launched): void {
  const spawned = lifecycle(l.userData).filter(r => r.event === 'utility-spawn').at(-1)!
  process.kill(spawned.utilityPid as number)
}

test("a file the core died reading comes back unopened after a restart, and opens only when asked", async () => {
  const file = fixture('open-paths-crash.txt', Array.from({ length: 50 }, (_, i) => `crash line ${i + 1}`).join('\n') + '\n')
  // Every chunk read waits 4 s, so the open is surely reading when the core dies.
  const first = await launch({ hooks: true, env: { TYPOSE_TEST_READ_DELAY: '4000' }, file })
  await expect(first.win.locator('.card-status')).toHaveText('Opening…', { timeout: 30_000 })
  killCore(first)
  await expect(first.win.locator('.card-message .open-button')).toHaveText(['Reopen']) // this session: as before
  const saved = () => existsSync(join(first.userData, 'session.json')) ? JSON.parse(readFileSync(join(first.userData, 'session.json'), 'utf8')).cards[0].tabs[0] : null
  await expect.poll(saved, { timeout: 10_000 }).toMatchObject({ location: { kind: 'manual', path: file }, crashed: true })
  expect(await finish(first, true)).toEqual({ code: 0, signal: null })

  const second = await launch({ hooks: true, userData: first.userData })
  const { win } = second
  await expect(win.locator('.card-message p')).toHaveText("Typose's core stopped while reading this file.", { timeout: 30_000 })
  await expect(win.locator('.card-message .open-button')).toHaveText(['Open anyway'])
  await expect(tabs(win)).toHaveText(['open-paths-crash.txt'])
  await win.waitForTimeout(500)
  expect(await debugStats(win)).toMatchObject({ docs: 0 }) // never opened, so the core can't die on it again
  expect(lifecycle(second.userData).filter(r => r.pid === second.pid && r.event === 'utility-exit')).toEqual([])

  await win.locator('.card-message .open-button').click()
  await waitOpen(win)
  expect((await visibleRows(win))[0]).toEqual({ line: 1, text: 'crash line 1' })
  expect(await debugStats(win)).toMatchObject({ docs: 1 })
  expect(second.pageErrors).toEqual([])
  expect(await finish(second, true)).toEqual({ code: 0, signal: null })
  expect(saved().crashed).toBeUndefined() // opened, so it's no longer marked
  rmSync(second.userData, { recursive: true, force: true })
})

test('the crash mark reaches the session even when a second death keeps the next core away until the window closes', async () => {
  const file = fixture('open-paths-crash-twice.txt', 'twice\n')
  const first = await launch({ hooks: true, env: { TYPOSE_TEST_READ_DELAY: '4000' }, file })
  await expect(first.win.locator('.card-status')).toHaveText('Opening…', { timeout: 30_000 })
  killCore(first)
  // The respawn dies as soon as it's spawned: within 60 s of the last respawn, no third core comes before the quit.
  const spawns = () => lifecycle(first.userData).filter(r => r.event === 'utility-spawn').length
  for (let i = 0; i < 1000 && spawns() < 2; i++) await new Promise(done => setTimeout(done, 5))
  killCore(first)
  await expect.poll(() => lifecycle(first.userData).some(r => r.event === 'core-stopped')).toBe(true)
  expect(await finish(first, true)).toEqual({ code: 0, signal: null })

  const second = await launch({ hooks: true, userData: first.userData })
  await expect(second.win.locator('.card-message p')).toHaveText("Typose's core stopped while reading this file.", { timeout: 30_000 })
  expect(await debugStats(second.win)).toMatchObject({ docs: 0 })
  expect(second.pageErrors).toEqual([])
  await finish(second)
})

test('a restored record that names a folder opens as a refused tab, never a root, and is saved for reselection', async () => {
  const folder = folderFixture('open-paths-restore-dir', { 'inside.md': '# Inside\n' })
  const userData = mkdtempSync(join(tmpdir(), 'typose-restore-dir-'))
  // A folder saved as a manual file record, as a refused tab from an older build was.
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ ...emptySession(), cards: [{ tabs: [
    { location: { kind: 'manual', path: folder }, anchor: 5, lens: null }
  ], selected: 0, weight: 1 }] }))
  const l = await launch({ hooks: true, userData })
  const { win } = l
  await expect(win.locator('.card-message p')).toHaveText(`Can't open ${folder} · refused: a folder`, { timeout: 30_000 })
  await win.waitForTimeout(500)
  await expect(win.getByRole('treeitem')).toHaveCount(0)
  expect(l.pageErrors).toEqual([])
  expect(await finish(l, true)).toEqual({ code: 0, signal: null })
  const saved = JSON.parse(readFileSync(join(userData, 'session.json'), 'utf8'))
  expect(saved.roots).toEqual([])
  expect(saved.cards[0].tabs.find((tab: { location: { path: string } }) => tab.location.path === folder).location.kind).toBe('reselect')
  rmSync(userData, { recursive: true, force: true })
})
