// 1 GiB on one line (Z37): the first piece shows before the scan passes the line's end, and the rest of the line's
// first MiB loads on demand as pieces of their own (brief §5.1, plan C3).
import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURES, finish, launch, test, waitIndexed, waitOpen } from './app'

const ONE_LINE = join(FIXTURES, '1gib-one-line.jsonl')
const MARKS = ['typose:open-start', 'typose:first-screen', 'typose:line-scan', 'typose:index-done'] as const
type Marks = Partial<Record<(typeof MARKS)[number], number>>
/** Z37's first-screen budget: PC 50 ms, Mac 100 ms (plan §5). */
const BUDGET_MS = process.platform === 'darwin' ? 100 : 50

test.afterAll(() => rmSync(ONE_LINE, { force: true })) // generated fixtures are deleted when done

/**
 * Plan A's veto (`afc58f9`) on Z37's gate: a missing, invalid or misordered scan mark fails it, never passes it or
 * reads as "not judged". Then the gate itself: the first piece shows before the scan passes the line's end. Only a
 * scan that finishes inside the first-screen budget is exempt, since there a lens that waits for the line's end
 * can't be told apart. Returns the failures.
 */
function scanGate(m: Marks): string[] {
  const [open, first, scan, done] = MARKS.map((name) => m[name])
  if (![open, first, scan, done].every((t) => typeof t === 'number' && Number.isFinite(t))) return [`missing or invalid marks: ${JSON.stringify(m)}`]
  const [o, f, s, d] = [open!, first!, scan!, done!]
  const failures: string[] = []
  if (!(f > o)) failures.push(`first screen ${f} isn't after the open ${o}`)
  if (!(s > o && s <= d)) failures.push(`line scan ${s} isn't after the open ${o} and no later than index done ${d}`)
  if (s - o > BUDGET_MS && !(f < s)) failures.push(`the first screen (${f - o} ms) waited for the line's end (${s - o} ms)`)
  return failures
}

/** The veto's negative controls: a run's marks with the scan-completion mark missing, after index done, or before
 *  the first screen. The last is placed past the budget's exemption, so it fails however fast the first screen was.
 *  The gate must fail each. */
function vetoControls(m: Marks): [control: string, marks: Marks][] {
  const o = m['typose:open-start']!
  const late = { 'typose:line-scan': o + BUDGET_MS + 2, 'typose:first-screen': o + BUDGET_MS + 3 }
  return [
    ['line-scan missing', { ...m, 'typose:line-scan': undefined }],
    ['line-scan after index-done', { ...m, 'typose:line-scan': m['typose:index-done']! + 1 }],
    ['line-scan before first-screen', { ...m, ...late, 'typose:index-done': Math.max(m['typose:index-done']!, o + BUDGET_MS + 2) }]
  ]
}

test("the veto's controls fail the gate wherever the first screen lands", () => {
  for (const first of [40, 147]) {
    const marks: Marks = { 'typose:open-start': 1000, 'typose:first-screen': 1000 + first, 'typose:line-scan': 1231, 'typose:index-done': 1231 }
    expect(scanGate(marks), `first screen at ${first} ms`).toEqual([])
    for (const [control, m] of vetoControls(marks)) expect(scanGate(m), `${control}, first screen at ${first} ms`).not.toEqual([])
  }
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
  // TEMP (reverted): diagnostics for PR 2's Linux CI failure.
  const diag = await win.evaluate(async () => {
    const marks = () => performance.getEntriesByType('mark').map((m) => `${m.name}@${m.startTime.toFixed(1)}`)
    const before = marks()
    const raf = await new Promise<string>((ok) => {
      const t0 = performance.now()
      requestAnimationFrame(() => ok(`raf after ${(performance.now() - t0).toFixed(1)} ms`))
      setTimeout(() => ok('no raf in 3 s'), 3000)
    })
    return { timeOrigin: performance.timeOrigin, now: performance.now(), visibility: document.visibilityState, focus: document.hasFocus(), before, raf, after: marks(), rows: document.querySelectorAll('.vl-row').length }
  })
  const shell = await l.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { visible: w?.isVisible(), minimized: w?.isMinimized(), focused: w?.isFocused(), bounds: w?.getBounds() }
  })
  console.log(`DIAG ${JSON.stringify({ seen, ...diag, shell, openStartWall: new Date(diag.timeOrigin + Number(diag.before.find((m) => m.startsWith('typose:open-start'))?.split('@')[1])).toISOString() })}`)
  console.log(`DIAG lifecycle ${readFileSync(join(l.userData, 'logs', 'lifecycle.jsonl'), 'utf8')}`)
  expect(seen).toContain('Indexing 1 line…') // brief §8.2's indicator, while the scan was on

  await test.step("Z37's gate on the scan marks, with the veto's negative control", async () => {
    const marks: Marks = await win.evaluate(
      (names) => Object.fromEntries(names.map((n) => [n, performance.getEntriesByName(n)[0]?.startTime])),
      [...MARKS]
    )
    console.log(`scan marks (ms after open): ${MARKS.map((n) => `${n} ${((marks[n] ?? NaN) - marks['typose:open-start']!).toFixed(1)}`).join(', ')}`)
    expect(scanGate(marks)).toEqual([])
    // The negative control: without the scan-completion mark, or with it out of order, the same run fails the gate.
    for (const [control, m] of vetoControls(marks)) expect(scanGate(m), control).not.toEqual([])
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
