// Z37's first-screen gate on the renderer's scan marks, with plan A's veto (`afc58f9`) and Z64's clock start: the M1
// runner's Z37 rows (e2e/perf/m1.perf.ts) judge with this. PR 4's 1 GiB one-line test judges with `heldGate`, which
// holds the scan's end from the page until its first screen, so the page's own pace can't move the verdict.
import type { Page } from '@playwright/test'

/**
 * The page's own first frame (Z64): the renderer marks it in a rAF scheduled when its bundle evaluates. Paint
 * timing's `first-paint` isn't used: it comes with the window's first presentation, here 150–200 ms after the page's
 * frames had begun, which would excuse ordinary runs.
 */
export const FIRST_FRAME = 'typose:first-frame'
export const MARKS = ['typose:open-start', FIRST_FRAME, 'typose:first-screen', 'typose:line-scan', 'typose:index-done'] as const
export type Marks = Partial<Record<(typeof MARKS)[number], number>>
/** Z37's first-screen budget: PC 50 ms, Mac 100 ms (plan §5). */
export const BUDGET_MS = process.platform === 'darwin' ? 100 : 50
/** How long the marks may take to arrive: a late mark is judged as late, and only one that never comes is missing. */
export const MARKS_TIMEOUT_MS = 10_000

/** Z64: Z37's clock starts at the later of the open and the page's first frame. */
export const clockStart = (m: Marks) => Math.max(m['typose:open-start']!, m[FIRST_FRAME]!)

export type Verdict = { verdict: 'pass' | 'fail' | 'not judged'; reasons: string[] }
const ms = (t: number) => t.toFixed(1)

/** Plan A's veto, which both gates apply first: a fail for a missing, invalid or misordered mark, else nothing. */
function veto(m: Marks): Verdict | undefined {
  const [open, frame, first, scan, done] = MARKS.map((name) => m[name])
  if (![open, frame, first, scan, done].every((t) => typeof t === 'number' && Number.isFinite(t))) return { verdict: 'fail', reasons: [`missing or invalid marks: ${JSON.stringify(m)}`] }
  const [o, f, s, d] = [open!, first!, scan!, done!]
  const failures: string[] = []
  if (!(f > o)) failures.push(`first screen ${f} isn't after the open ${o}`)
  if (!(s > o && s <= d)) failures.push(`line scan ${s} isn't after the open ${o} and no later than index done ${d}`)
  return failures.length ? { verdict: 'fail', reasons: failures } : undefined
}

/**
 * Plan A's veto (`afc58f9`) on Z37's gate: a missing, invalid or misordered mark fails it, never passes it or reads
 * as "not judged". The page's first frame is one of the required marks. Then the gate itself: the first piece shows
 * before the scan passes the line's end. A scan that finishes inside the first-screen budget can't tell a lens that
 * waits for the line's end apart, so that run is not judged. The budget's clock starts at the later of the open and
 * the page's first frame (Z64): a page that can't paint yet is a startup problem (Z59's gates), not the lens's.
 */
export function scanGate(m: Marks): Verdict {
  const vetoed = veto(m)
  if (vetoed) return vetoed
  const [o, f, s] = [m['typose:open-start']!, m['typose:first-screen']!, m['typose:line-scan']!]
  const start = clockStart(m)
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
export function outcome(v: Verdict, platform: NodeJS.Platform): { fails: boolean; line: string } {
  const why = v.reasons.join('; ')
  if (v.verdict !== 'not judged') return { fails: v.verdict === 'fail', line: `${v.verdict.toUpperCase()}: ${why}` }
  if (platform === 'linux') return { fails: false, line: `NOT JUDGED (Linux smoke, Z28): ${why}` }
  return { fails: true, line: `NOT JUDGED, which fails on ${platform}, a gating platform (Z28): ${why}` }
}

/** What the page had when `releaseAfterFirstScreen` gave it the scan's end: when (performance.now() ms), whether each
 *  mark was there yet, and how many of the core's messages were held. */
export type Release = { at: number; firstScreen: boolean; lineScan: boolean; held: number }

/**
 * Z37's gate on a held run (`holdScanEnd`): plan A's veto, then the first screen must have come while the page was
 * still without the scan's end. A lens that waits for the line's end, in the page or in the core (whose first page
 * would then come after that end, and be held with it), can't show before the release, however fast the scan; and a
 * page that's slow to paint can't fail, at any pace within the release's wait, since the scan's end waits for its first
 * screen. So every run is decisive: no budget, and no "not judged". The release's flags, not its time, give the order:
 * a mark can share the release's coarse timestamp.
 */
export function heldGate(m: Marks, r: Release): Verdict {
  const vetoed = veto(m)
  if (vetoed) return vetoed
  if (!Number.isFinite(r.at)) return { verdict: 'fail', reasons: [`missing or invalid release: ${JSON.stringify(r)}`] }
  const [o, f, s] = [m['typose:open-start']!, m['typose:first-screen']!, m['typose:line-scan']!]
  const release = `the release (${ms(r.at - o)} ms, ${r.held} held)`
  if (r.lineScan || !(s >= r.at)) return { verdict: 'fail', reasons: [`the line scan (${ms(s - o)} ms) came before ${release}: the scan's end wasn't held`] }
  if (!r.firstScreen || !(f <= r.at)) return { verdict: 'fail', reasons: [`the first screen (${ms(f - o)} ms) waited for the line's end: it came only after ${release}, from the open`] }
  return { verdict: 'pass', reasons: [`the first screen (${ms(f - o)} ms) came with the scan's end held from the page, before ${release}; the line scan at ${ms(s - o)} ms, from the open`] }
}

/** The veto's negative controls: a run's marks with the scan-completion mark or the first frame missing, the scan
 *  mark after index done, or the scan before the first screen. The last is placed past the budget from the clock's
 *  start, so it's judged, and fails, however fast the first screen was and wherever the first frame came. The gate
 *  must fail each, on every platform. */
export function vetoControls(m: Marks): [control: string, marks: Marks][] {
  const start = clockStart(m)
  const late = { 'typose:line-scan': start + BUDGET_MS + 2, 'typose:first-screen': start + BUDGET_MS + 3 }
  return [
    ['line-scan missing', { ...m, 'typose:line-scan': undefined }],
    ['first frame missing', { ...m, [FIRST_FRAME]: undefined }],
    ['line-scan after index-done', { ...m, 'typose:line-scan': m['typose:index-done']! + 1 }],
    ['line-scan before first-screen', { ...m, ...late, 'typose:index-done': Math.max(m['typose:index-done']!, start + BUDGET_MS + 2) }]
  ]
}

/** The page's scan marks (performance.now() ms), each waited for up to `timeout`: a late mark is read as late. */
export function scanMarks(page: Page, timeout = MARKS_TIMEOUT_MS): Promise<Marks> {
  return page.evaluate(
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
    { names: [...MARKS], timeout }
  )
}

type Hold = { on: boolean; armed: number; seen: number; held: unknown[]; receive(data: unknown): void }

/**
 * Holds the scan's end from the page (test-hooks build): from the first progress event past the line's end (the one
 * ReaderCard marks `typose:line-scan` for), every message from the core waits, in the order the core sent it, until
 * `releaseAfterFirstScreen`. The core sends an open's first page before it starts the index, so that page gets through;
 * one it sent only after the scan's end would be held with it. Call it before each open you judge.
 */
export async function holdScanEnd(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { z37Hold?: Hold; typoseTest: { core: { receive(data: unknown): void } } }
    if (!w.z37Hold) {
      const { core } = w.typoseTest
      const hold: Hold = (w.z37Hold = { on: false, armed: 0, seen: 0, held: [], receive: core.receive.bind(core) })
      core.receive = (data) => {
        hold.seen++
        const e = data as { event?: unknown; lines?: number; done?: boolean }
        if (hold.on && (hold.held.length > 0 || (e.event === 'progress' && (e.lines! > 1 || !!e.done)))) hold.held.push(data)
        else hold.receive(data)
      }
    }
    Object.assign(w.z37Hold, { on: true, armed: performance.now(), seen: 0 })
  })
}

/**
 * Waits up to `timeout` (waitOpen's, for the first rows) for the first screen while the scan's end is held, then gives
 * the page what was held, in order, and says what the page had by then. A first screen that waits for the line's end
 * can't come in the wait, at any bound.
 */
export function releaseAfterFirstScreen(win: Page, timeout = 30_000): Promise<Release> {
  return win.evaluate(async (timeout) => {
    const hold = (window as unknown as { z37Hold: Hold }).z37Hold
    // This open's marks only: a mark from an open before the hold was armed stays until the next open clears it.
    const has = (name: string) => performance.getEntriesByName(name).some((e) => e.startTime >= hold.armed)
    const since = performance.now()
    while (!has('typose:first-screen') && performance.now() - since < timeout) await new Promise((ok) => setTimeout(ok, 20))
    const r = { at: performance.now(), firstScreen: has('typose:first-screen'), lineScan: has('typose:line-scan'), held: hold.held.length }
    hold.on = false
    for (const data of hold.held.splice(0)) hold.receive(data)
    // The open's own reply goes through the hold, if the hold is on the client's path at all.
    if (hold.seen === 0) throw new Error("the scan's hold saw no message from the core: it isn't on the client's path")
    return r
  }, timeout)
}
