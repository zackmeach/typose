// 1 GiB on one line (Z37): the first piece shows before the scan passes the line's end, and the rest of the line's
// first MiB loads on demand as pieces of their own (brief §5.1, plan C3).
import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURES, finish, launch, test, waitIndexed, waitOpen } from './app'

const ONE_LINE = join(FIXTURES, '1gib-one-line.jsonl')
/**
 * The page's own first frame (Z64): the renderer marks it in a rAF scheduled when its bundle evaluates. Paint
 * timing's `first-paint` isn't used: it comes with the window's first presentation, here 150–200 ms after the page's
 * frames had begun, which would excuse ordinary runs.
 */
const FIRST_FRAME = 'typose:first-frame'
const MARKS = ['typose:open-start', FIRST_FRAME, 'typose:first-screen', 'typose:line-scan', 'typose:index-done'] as const
type Marks = Partial<Record<(typeof MARKS)[number], number>>
/** Z37's first-screen budget: PC 50 ms, Mac 100 ms (plan §5). */
const BUDGET_MS = process.platform === 'darwin' ? 100 : 50
/** How long the marks may take to arrive: a late mark is judged as late, and only one that never comes is missing. */
const MARKS_TIMEOUT_MS = 10_000
/** Brief §8.2's indexing indicator, "Indexing N lines…", with N as the card writes it (compact: "1.2M"). */
const INDEXING = /^Indexing [\d.]+[KMBT]? lines?…$/

test.afterAll(() => rmSync(ONE_LINE, { force: true })) // generated fixtures are deleted when done

/** Z64: Z37's clock starts at the later of the open and the page's first frame. */
const clockStart = (m: Marks) => Math.max(m['typose:open-start']!, m[FIRST_FRAME]!)

type Verdict = { verdict: 'pass' | 'fail' | 'not judged'; reasons: string[] }
const ms = (t: number) => t.toFixed(1)

/**
 * Plan A's veto (`afc58f9`) on Z37's gate: a missing, invalid or misordered mark fails it, never passes it or reads
 * as "not judged". The page's first frame is one of the required marks. Then the gate itself: the first piece shows
 * before the scan passes the line's end. A scan that finishes inside the first-screen budget can't tell a lens that
 * waits for the line's end apart, so that run is not judged. The budget's clock starts at the later of the open and
 * the page's first frame (Z64): a page that can't paint yet is a startup problem (Z59's gates), not the lens's.
 */
function scanGate(m: Marks): Verdict {
  const [open, frame, first, scan, done] = MARKS.map((name) => m[name])
  if (![open, frame, first, scan, done].every((t) => typeof t === 'number' && Number.isFinite(t))) return { verdict: 'fail', reasons: [`missing or invalid marks: ${JSON.stringify(m)}`] }
  const [o, f, s, d] = [open!, first!, scan!, done!]
  const start = clockStart(m)
  const failures: string[] = []
  if (!(f > o)) failures.push(`first screen ${f} isn't after the open ${o}`)
  if (!(s > o && s <= d)) failures.push(`line scan ${s} isn't after the open ${o} and no later than index done ${d}`)
  if (failures.length) return { verdict: 'fail', reasons: failures }
  const from = start === o ? 'the open' : "the page's first frame"
  if (s - start <= BUDGET_MS) {
    const when = s < start ? `${ms(start - s)} ms before` : `${ms(s - start)} ms after`
    return { verdict: 'not judged', reasons: [`the scan ended ${when} the clock start (${from}), inside the ${BUDGET_MS} ms budget`] }
  }
  if (!(f < s)) return { verdict: 'fail', reasons: [`the first screen (${ms(f - start)} ms) waited for the line's end (${ms(s - start)} ms), from ${from}`] }
  return { verdict: 'pass', reasons: [`the first screen (${ms(f - start)} ms) came before the line's end (${ms(s - start)} ms), from ${from}`] }
}

/**
 * What a verdict means for the test on `platform`. Windows and macOS gate (Z28), so a run there must be decisive: not
 * judged fails, and the fixture must grow if that ever happens. Linux is smoke-only (Z28): not judged is logged, and
 * passes.
 */
function outcome(v: Verdict, platform: NodeJS.Platform): { fails: boolean; line: string } {
  const why = v.reasons.join('; ')
  if (v.verdict !== 'not judged') return { fails: v.verdict === 'fail', line: `${v.verdict.toUpperCase()}: ${why}` }
  if (platform === 'linux') return { fails: false, line: `NOT JUDGED (Linux smoke, Z28): ${why}` }
  return { fails: true, line: `NOT JUDGED, which fails on ${platform}, a gating platform (Z28): ${why}` }
}

/** The veto's negative controls: a run's marks with the scan-completion mark or the first frame missing, the scan
 *  mark after index done, or the scan before the first screen. The last is placed past the budget from the clock's
 *  start, so it's judged, and fails, however fast the first screen was and wherever the first frame came. The gate
 *  must fail each, on every platform. */
function vetoControls(m: Marks): [control: string, marks: Marks][] {
  const start = clockStart(m)
  const late = { 'typose:line-scan': start + BUDGET_MS + 2, 'typose:first-screen': start + BUDGET_MS + 3 }
  return [
    ['line-scan missing', { ...m, 'typose:line-scan': undefined }],
    ['first frame missing', { ...m, [FIRST_FRAME]: undefined }],
    ['line-scan after index-done', { ...m, 'typose:line-scan': m['typose:index-done']! + 1 }],
    ['line-scan before first-screen', { ...m, ...late, 'typose:index-done': Math.max(m['typose:index-done']!, start + BUDGET_MS + 2) }]
  ]
}

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
  execFileSync(
    'cargo',
    ['run', '--release', '-q', '-p', 'fixtures-gen', '--', 'jsonl-huge-first', '--out', ONE_LINE, '--first', String(size - 57), '--bytes', '0'],
    { cwd: resolve(__dirname, '../core'), stdio: 'inherit' }
  )
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
    const marks: Marks = await win.evaluate(
      async ({ names, timeout }) => {
        const read = () => Object.fromEntries(names.map((n) => [n, performance.getEntriesByName(n)[0]?.startTime]))
        const since = performance.now()
        let m = read()
        while (Object.values(m).some((t) => t === undefined) && performance.now() - since < timeout) {
          await new Promise((ok) => setTimeout(ok, 20))
          m = read()
        }
        return m
      },
      { names: [...MARKS], timeout: MARKS_TIMEOUT_MS }
    )
    console.log(`scan marks (ms after open): ${MARKS.map((n) => `${n} ${((marks[n] ?? NaN) - marks['typose:open-start']!).toFixed(1)}`).join(', ')}`)
    const { fails, line } = outcome(scanGate(marks), process.platform)
    console.log(`scan gate: ${line}`)
    expect(fails, line).toBe(false)
    // The negative control: without the scan-completion mark, or with it out of order, the same run fails the gate.
    for (const [control, m] of vetoControls(marks)) expect(scanGate(m).verdict, control).toBe('fail')
  })

  await test.step("the line's first MiB loads on demand, piece by piece, then says how much more there is", async () => {
    const rowsOfLine = win.locator('.vl-row[data-line="0"]')
    await expect(rowsOfLine).toHaveCount(1)
    await win.getByRole('button', { name: 'Show more of line 1' }).click()
    await expect(win.locator('.vl-row .more').filter({ hasText: /more on this line$/ })).toHaveText('+1,072.7 MB more on this line', { timeout: 30_000 })
    await expect(rowsOfLine).toHaveCount(16)
    const texts = await rowsOfLine.evaluateAll((rows) =>
      rows.sort((a, b) => Number(a.dataset.piece) - Number(b.dataset.piece)).map((r) => r.querySelector('.text')?.textContent ?? '')
    )
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThanOrEqual(65_536) // C2: no item over 64 KiB
    const shown = Buffer.alloc(1 << 20)
    const fd = openSync(ONE_LINE, 'r')
    readSync(fd, shown, 0, shown.length, 0)
    closeSync(fd)
    expect(texts.join('')).toBe(shown.toString('utf8')) // the pieces, in order, are the line's first MiB
  })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
