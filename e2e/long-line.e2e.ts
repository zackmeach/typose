// 1 GiB on one line (Z37): the first piece shows before the scan passes the line's end, and the rest of the line's
// first MiB loads on demand as pieces of their own (brief §5.1, plan C3).
import { expect } from '@playwright/test'
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, finish, fixturesGen, launch, test, waitIndexed, waitOpen } from './app'
import { FIRST_FRAME, MARKS, type Marks, outcome, scanGate, scanMarks, vetoControls } from './z37'

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
  const l = await launch({ file: ONE_LINE })
  const { win } = l
  // Every status text from here on: the scan is too quick to catch by polling.
  await win.evaluate(() => {
    const seen: string[] = []
    const status = () => document.querySelector('.card-status')?.textContent ?? ''
    new MutationObserver(() => seen.at(-1) !== status() && seen.push(status())).observe(document.body, { subtree: true, childList: true, characterData: true })
    Object.assign(window, { statusSeen: seen })
  })
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
    const { fails, line } = outcome(scanGate(marks), process.platform)
    console.log(`scan gate: ${line}`)
    expect(fails, line).toBe(false)
    // The negative control: without the scan-completion mark, or with it out of order, the same run fails the gate.
    for (const [control, m] of vetoControls(marks)) expect(scanGate(m).verdict, control).toBe('fail')
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
