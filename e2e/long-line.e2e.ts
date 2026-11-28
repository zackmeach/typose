// 1 GiB on one line (Z37): the first piece shows before the scan passes the line's end, and the rest of the line's
// first MiB loads on demand as pieces of their own (brief §5.1, plan C3).
import { expect } from '@playwright/test'
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, finish, fixture, fixturesGen, launch, runCommand, stubOpenDialog, test, waitIndexed, waitOpen } from './app'
import { FIRST_FRAME, MARKS, type Marks, type Release, heldGate, holdScanEnd, outcome, releaseAfterFirstScreen, scanGate, scanMarks, vetoControls } from './z37'

const ONE_LINE = join(FIXTURES, '1gib-one-line.txt') // .txt: a .jsonl name would open in Rows, and this exercises Raw
/** Brief §8.2's indexing indicator, "Indexing N lines…", with N as the card writes it (compact: "1.2M"). */
const INDEXING = /^Indexing [\d.]+[KMBT]? lines?…$/

test.afterAll(() => rmSync(ONE_LINE, { force: true })) // generated fixtures are deleted when done

test("the veto's controls fail the gate wherever the first screen and the page's first frame land", () => {
  // The open at 1000 and the scan at 1231; the page's first frame before the open, after it, and after the scan.
  for (const frame of [990, 1100, 1300])
    for (const first of [40, 147]) {
      const marks: Marks = { 'typose:open-start': 1000, [FIRST_FRAME]: frame, 'typose:first-screen': 1000 + first, 'typose:line-scan': 1231, 'typose:index-done': 1231 }
      const at = `first screen at ${first} ms, first frame at ${frame - 1000} ms`
      expect(scanGate(marks).verdict, at).toBe(frame === 1300 ? 'not judged' : 'pass')
      for (const [control, m] of vetoControls(marks)) expect(scanGate(m).verdict, `${control}, ${at}`).toBe('fail')
    }
})

test("Z64: the clock starts at the later of the open and the page's first frame", () => {
  const base: Marks = { 'typose:open-start': 1000, 'typose:line-scan': 1231, 'typose:index-done': 1231 }
  // A page that couldn't paint until after the scan: its first screen comes with its first frame, not blamed on the
  // lens, and the run can't tell a waiting lens apart.
  expect(scanGate({ ...base, [FIRST_FRAME]: 1300, 'typose:first-screen': 1305 }).verdict).toBe('not judged')
  // A lens that waits for the line's end still fails, with the first frame after the open but well before the scan.
  expect(scanGate({ ...base, [FIRST_FRAME]: 1100, 'typose:first-screen': 1240 }).verdict).toBe('fail')
  // ... and with the first frame before the open.
  expect(scanGate({ ...base, [FIRST_FRAME]: 990, 'typose:first-screen': 1240 }).verdict).toBe('fail')
  // The first screen is still judged after the real open, whenever the page's first frame came.
  expect(scanGate({ ...base, [FIRST_FRAME]: 1300, 'typose:first-screen': 995 }).verdict).toBe('fail')
  // A first frame that's missing or not a number fails as a missing mark, never passes.
  for (const frame of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = scanGate({ ...base, [FIRST_FRAME]: frame, 'typose:first-screen': 1040 })
    expect([v.verdict, v.reasons[0]], String(frame)).toEqual(['fail', expect.stringMatching(/^missing or invalid marks/)])
  }
})

test("Z37's verdict: Windows and macOS need a decisive run, and Linux may go unjudged (Z28)", () => {
  const base: Marks = { 'typose:open-start': 1000, [FIRST_FRAME]: 990, 'typose:line-scan': 1231, 'typose:index-done': 1231 }
  const pass = scanGate({ ...base, 'typose:first-screen': 1040 })
  const waits = scanGate({ ...base, 'typose:first-screen': 1240 })
  // Not judged: the page's first frame after the scan, or a scan inside the budget from the open.
  const unjudged = [
    scanGate({ ...base, [FIRST_FRAME]: 1300, 'typose:first-screen': 1305 }),
    scanGate({ ...base, 'typose:first-screen': 1020, 'typose:line-scan': 1030, 'typose:index-done': 1030 })
  ]
  expect([pass.verdict, waits.verdict, ...unjudged.map((v) => v.verdict)]).toEqual(['pass', 'fail', 'not judged', 'not judged'])
  expect(unjudged[0].reasons[0]).toMatch(/^the scan ended 69\.0 ms before the clock start \(the page's first frame\), inside the \d+ ms budget$/)
  expect(unjudged[1].reasons[0]).toMatch(/^the scan ended 30\.0 ms after the clock start \(the open\), inside the \d+ ms budget$/)
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    expect(outcome(pass, platform).fails, platform).toBe(false)
    expect(outcome(waits, platform).fails, platform).toBe(true)
    for (const v of unjudged) expect(outcome(v, platform).fails, `${platform}: ${v.reasons[0]}`).toBe(platform !== 'linux')
  }
  expect(outcome(unjudged[0], 'linux').line).toMatch(/^NOT JUDGED \(Linux smoke, Z28\): /)
  expect(outcome(unjudged[0], 'win32').line).toMatch(/^NOT JUDGED, which fails on win32/)
  expect(outcome(pass, 'linux').line).toMatch(/^PASS: /)
})

test("Z37's held gate: the first screen comes while the scan's end is held, on every system, or the run fails", () => {
  const marks: Marks = { 'typose:open-start': 1000, [FIRST_FRAME]: 990, 'typose:first-screen': 1040, 'typose:line-scan': 1231, 'typose:index-done': 1231 }
  const held: Release = { at: 1045, firstScreen: true, lineScan: false, held: 1 }
  expect(heldGate(marks, held).verdict).toBe('pass')
  // A page slow to paint passes however slow, its first screen sharing the release's coarse timestamp; and a scan inside
  // the budget is judged, where the timing gate couldn't tell.
  expect(heldGate({ ...marks, 'typose:first-screen': 2500, 'typose:line-scan': 2500, 'typose:index-done': 2500 }, { ...held, at: 2500 }).verdict).toBe('pass')
  const quick: Marks = { ...marks, 'typose:line-scan': 1046, 'typose:index-done': 1046 }
  expect([scanGate(quick).verdict, heldGate(quick, held).verdict]).toEqual(['not judged', 'pass'])
  // A first screen that waits for the line's end comes after the release, whatever its timestamp.
  for (const first of [1230, 1231]) {
    const v = heldGate({ ...marks, 'typose:first-screen': first }, { ...held, at: 1230, firstScreen: false })
    expect([v.verdict, v.reasons[0]], String(first)).toEqual(['fail', expect.stringMatching(/ waited for the line's end: /)])
  }
  // A scan's end that got past the hold, or a release with no time: not the run the gate judges.
  for (const v of [heldGate(marks, { ...held, lineScan: true }), heldGate({ ...marks, 'typose:line-scan': 1042, 'typose:index-done': 1042 }, held)])
    expect([v.verdict, v.reasons[0]]).toEqual(['fail', expect.stringMatching(/: the scan's end wasn't held$/)])
  expect(heldGate(marks, { ...held, at: Number.NaN }).verdict).toBe('fail')
  for (const [control, m] of vetoControls(marks)) expect(heldGate(m, held).verdict, control).toBe('fail')
  for (const platform of ['win32', 'darwin', 'linux'] as const) expect(outcome(heldGate(marks, held), platform).fails, platform).toBe(false)
})

test('the indexing indicator matches at any count, and no other status does', () => {
  for (const s of ['Indexing 0 lines…', 'Indexing 1 line…', 'Indexing 1.2M lines…']) expect(s).toMatch(INDEXING)
  for (const s of ['', '1 line · UTF-8', 'Indexing stopped at 5 lines']) expect(s).not.toMatch(INDEXING)
})

test("1 GiB on one line: the first piece shows before the scan passes the line's end, and more loads on demand", async () => {
  test.setTimeout(10 * 60_000)
  // One JSON record of 1 GiB: a 54-byte head, the payload, then `"}` and a newline.
  const size = 1 << 30
  fixturesGen('jsonl-huge-first', '--out', ONE_LINE, '--first', String(size - 57), '--bytes', '0')
  expect(statSync(ONE_LINE).size).toBe(size)
  // The timing gate this replaces failed when the scan of the line, just written and cached, ended while the page was
  // busy: the page then marked both back to back (runs 42898553765, 42911389323 and 43807899478, 0.8 to 6.1 ms apart).
  // So the open waits for a window that's up and painting, and the scan's end is held from the page until its first
  // screen (`holdScanEnd`): a cold launch or a slow paint can't move the verdict.
  const l = await launch({ hooks: true })
  const { app, win } = l
  const open = win.getByRole('button', { name: /^Open file…/ })
  await expect(open).toBeVisible({ timeout: 30_000 })
  await win.evaluate(() => new Promise(requestAnimationFrame)) // a frame: the window is shown and painting
  // Every status text from here on: the scan is too quick to catch by polling.
  await win.evaluate(() => {
    const seen: string[] = []
    const status = () => document.querySelector('.card-status')?.textContent ?? ''
    new MutationObserver(() => seen.at(-1) !== status() && seen.push(status())).observe(document.body, { subtree: true, childList: true, characterData: true })
    Object.assign(window, { statusSeen: seen })
  })
  await stubOpenDialog(app, ONE_LINE)
  await holdScanEnd(win)
  await open.click()
  const release = await releaseAfterFirstScreen(win)
  await waitOpen(win)
  await waitIndexed(win)
  const seen = await win.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen)
  // Brief §8.2's indicator, while the scan was on, at any count: the last progress event and the done event can come
  // back to back and render once, so "Indexing 1 line…" may never show (Linux CI saw only "Indexing 0 lines…").
  expect(seen.some((s) => INDEXING.test(s)), `statuses seen: ${JSON.stringify(seen)}`).toBe(true)

  await test.step("Z37's gate on the scan marks, with the veto's negative control", async () => {
    // Waits for every mark, up to a bound: one that arrives late is judged as late, and only one that never comes is
    // missing (it then fails the gate).
    const marks: Marks = await scanMarks(win)
    console.log(`scan marks (ms after open): ${MARKS.map((n) => `${n} ${((marks[n] ?? NaN) - marks['typose:open-start']!).toFixed(1)}`).join(', ')}`)
    const { fails, line } = outcome(heldGate(marks, release), process.platform)
    console.log(`scan gate: ${line}`)
    expect(fails, line).toBe(false)
    // The negative control: without the scan-completion mark, or with it out of order, the same run fails the gate.
    for (const [control, m] of vetoControls(marks)) expect(heldGate(m, release).verdict, control).toBe('fail')
  })

  await test.step("the line's first MiB loads on demand, piece by piece, over rows of 2,048 units, then says how much more there is", async () => {
    const rowsOfLine = win.locator('.vl-row[data-line="0"]')
    await expect(rowsOfLine).toHaveCount(32) // Z66: the first piece, 64 KiB of ASCII, over 32 rows of 2,048 units
    await win.getByRole('button', { name: 'Show more of line 1' }).click()
    // Each piece comes as its rows scroll into view: every row's text is read on the way down to the line's end.
    const seen = new Map<string, string>()
    const last = win.locator('.vl-row .more').filter({ hasText: /more on this line$/ })
    await win.locator('.vl-scroller').focus()
    for (let i = 0; i < 100 && (await last.count()) === 0; i++) {
      await expect.poll(() => rowsOfLine.evaluateAll((rows) => rows.every((r) => r.querySelector('.text')))).toBe(true)
      for (const [at, text] of await rowsOfLine.evaluateAll((rows) => rows.map((r) => [`${r.dataset.piece}:${r.dataset.sub}`, r.querySelector('.text')!.textContent!])))
        seen.set(at, text)
      await win.keyboard.press('PageDown')
    }
    await expect(last).toHaveText('+1,072.7 MB more on this line', { timeout: 30_000 })
    await expect.poll(() => rowsOfLine.evaluateAll((rows) => rows.every((r) => r.querySelector('.text')))).toBe(true)
    for (const [at, text] of await rowsOfLine.evaluateAll((rows) => rows.map((r) => [`${r.dataset.piece}:${r.dataset.sub}`, r.querySelector('.text')!.textContent!])))
      seen.set(at, text)
    // Each piece, whole from its rows, in order: 16 of them, each a row's most at a time.
    const texts = Array.from({ length: 16 }, (_, piece) => {
      const rows: string[] = []
      for (let sub = 0; seen.has(`${piece}:${sub}`); sub++) rows.push(seen.get(`${piece}:${sub}`)!)
      return rows
    })
    expect(Math.max(...texts.flat().map((t) => t.length))).toBeLessThanOrEqual(2048) // Z66
    expect(Math.max(...texts.map((rows) => rows.join('').length))).toBeLessThanOrEqual(65_536) // C2: no piece over 64 KiB
    const shown = Buffer.alloc(1 << 20)
    const fd = openSync(ONE_LINE, 'r')
    readSync(fd, shown, 0, shown.length, 0)
    closeSync(fd)
    expect(texts.map((rows) => rows.join('')).join('')).toBe(shown.toString('utf8')) // the pieces, in order, are the line's first MiB
  })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test("Z37's held gate passes a page stalled across the open, and fails a first screen that waits for the line's end", async () => {
  const l = await launch({ hooks: true })
  const { app, win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible({ timeout: 30_000 })
  await win.evaluate(() => new Promise(requestAnimationFrame)) // a frame: the window is shown and painting
  const judge = async (name: string, timeout?: number) => {
    await stubOpenDialog(app, fixture(name, 'one line\n'))
    await holdScanEnd(win)
    await runCommand(win, 'Browse…')
    const release = await releaseAfterFirstScreen(win, timeout)
    await waitIndexed(win)
    const v = heldGate(await scanMarks(win), release)
    console.log(`held gate (${name}): ${v.verdict.toUpperCase()}: ${v.reasons.join('; ')}`)
    return v
  }
  // The hosted failures, forced: the page is busy for 1 s from just after it asks for the file, so the core's reply and
  // the scan's end wait in its queue, and it marks the line scan between mounting the first rows and marking their first
  // screen. Unheld, the timing gate failed every such run on a Windows PC.
  await win.evaluate(() => {
    const mark = performance.mark.bind(performance)
    let stall = true
    performance.mark = ((name: string, options?: PerformanceMarkOptions) => {
      if (name === 'typose:open-start' && stall) {
        stall = false
        setTimeout(() => {
          const from = performance.now()
          while (performance.now() - from < 1000) continue
        })
      }
      return mark(name, options)
    }) as typeof performance.mark
  })
  const stalled = await judge('long-line-stalled.txt')
  expect(stalled.verdict, stalled.reasons.join('; ')).toBe('pass')
  // The real negative control: a first screen marked only once the page has the scan's end, as a lens that waited for
  // the line's end would mark it. It can't come while that end is held, so a short wait will do.
  await win.evaluate(() => {
    const mark = performance.mark.bind(performance)
    let waiting = false
    performance.mark = ((name: string, options?: PerformanceMarkOptions) => {
      if (name === 'typose:first-screen' && performance.getEntriesByName('typose:line-scan').length === 0) {
        waiting = true
        return undefined
      }
      const made = mark(name, options)
      if (name === 'typose:line-scan' && waiting) mark('typose:first-screen')
      return made
    }) as typeof performance.mark
  })
  const waits = await judge('long-line-waits.txt', 1000)
  expect([waits.verdict, waits.reasons[0]]).toEqual(['fail', expect.stringMatching(/^the first screen \([\d.]+ ms\) waited for the line's end/)])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
