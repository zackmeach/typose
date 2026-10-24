// The M1 runner (plan §3 PR 9): plan §5's thresholds table on the fused, packaged build, driven as plan §5 says: the
// executable spawned, then CDP, then the read-only TYPOSE_MARKS hook, with main-process figures from OS counters.
// Every row's run is appended to .evidence/m1/perf/ with its figures, its verdict against its threshold and its
// test status (Z49: misses and invalid runs are kept, with their reasons). A miss fails its test; it's never a pass.
//   Run:   npm run package, then `npm run perf -- m1.perf.ts` (warm n = RUNS, 30 by default; FRAME_RUNS frame runs per
//          case, 3 by default; the NetLog row idles IDLE_MS, 5 minutes by default). Each row generates its fixtures with
//          fixtures-gen and deletes them after; a fixture that would take the disk under the 20 GiB floor skips its rows.
//   Cold:  plan §5's cold rows (shell visible, open→usable, launch→firstContent) are startup.perf.ts's, run as the first
//          launch after each OS restart: COLD=1 RUNS=1 FILE=.fixtures/10gib.jsonl `npm run perf -- -g warm` (batch A),
//          and FILE=.fixtures/1gib.jsonl (batch B). Generate each once, before the restarts, and keep it until the
//          batch is done: `npm run fixtures -- jsonl --bytes 10737418240 --out .fixtures/10gib.jsonl`.
//   Not here: the Mac rows run this file on the Mac (Z55, Z58); Snap Layouts is a manual check (PR 7).
import { type CDPSession, type Page, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, statfsSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { FIXTURES, assertNetLog, fixture, test, visibleRows, waitIndexed, waitOpen } from '../app'
import { type PackagedLaunch, closePackaged, launchPackaged, readMarks, waitMarks } from '../packaged'
import { BUDGET_MS, type Marks, clockStart, outcome, scanGate, scanMarks, vetoControls } from '../z37'
import { type Analysis, type Run, inputKinds, jump, keypresses, scroll, traced } from './drive'
import { CATEGORIES, analyzeFrames } from './frames.mjs'
import { cpuLoad, cpuTimes, idleLoad, percentile, recordOutcome } from './rig'

const RUNS = Number(process.env.RUNS ?? 30)
const FRAME_RUNS = Number(process.env.FRAME_RUNS ?? 3)
const IDLE_MS = Number(process.env.IDLE_MS ?? 5 * 60_000)
const MAC = process.platform === 'darwin'
const GIB = 2 ** 30
/** The lanes' disk floor: no fixture may take the disk under it. */
const FLOOR = 20 * GIB
const LINE = 200

type Verdict = 'pass' | 'fail' | 'invalid' | 'pending' | 'reported'
type Row = { row: string; threshold: string; verdict: Verdict; [k: string]: unknown }

let rows: Row[] = []
/** Launches that didn't quit cleanly: never an invalid run, always a failure to explain (plan §5's exit integrity). */
let exits: string[] = []
let loadBefore = 0
let from = cpuTimes()
test.beforeEach(async () => {
  rows = []
  exits = []
  loadBefore = await idleLoad(3000) // what the machine was doing before the row (Z49 records load; this PC is loaded)
  from = cpuTimes()
})
test.afterEach(() => {
  const loadDuring = cpuLoad(from)
  for (const r of rows) {
    recordOutcome(test.info(), `m1:${r.row}`, { ...r, platform: process.platform, loadBefore, loadDuring, exits })
    console.log(`ROW ${JSON.stringify({ row: r.row, verdict: r.verdict, threshold: r.threshold, n: r.n, p50: r.p50, p95: r.p95, max: r.max, hz: r.hz, loadBefore, loadDuring })}`)
  }
  expect(exits, "a launch that didn't quit cleanly (Z56: an exit the test didn't ask for blocks M1)").toEqual([])
})
/** Keeps a row for the results log, and fails the test (softly, so every row is kept) unless it passed. */
function judge(r: Row): void {
  rows.push(r)
  if (r.verdict !== 'pending' && r.verdict !== 'reported') expect.soft(r.verdict, `${r.row}: ${JSON.stringify(r)}`.slice(0, 4000)).toBe('pass')
}

/** Generates a fixture with fixtures-gen, or skips the group when it would take the disk under the floor. */
function generate(name: string, bytes: number, args: string[]): string {
  mkdirSync(FIXTURES, { recursive: true })
  const out = join(FIXTURES, name)
  rmSync(out, { force: true }) // a copy left by an earlier run is regenerated, not trusted
  const { bavail, bsize } = statfsSync(FIXTURES)
  const free = bavail * bsize
  test.skip(free - bytes < FLOOR, `not run: ${name} (${(bytes / GIB).toFixed(1)} GiB) would leave ${((free - bytes) / GIB).toFixed(1)} GiB, under the 20 GiB floor`)
  execFileSync('cargo', ['run', '--release', '-q', '-p', 'fixtures-gen', '--', ...args, '--out', out], { cwd: resolve(__dirname, '../../core'), stdio: 'inherit' })
  return out
}

const hzOf = (l: PackagedLaunch) => readMarks(l).show?.hz as number | undefined
const ms = (t: number) => Math.round(t * 10) / 10
/** n, p50, p95 (nearest rank, as rig.ts) and max, in ms. Signed: the page's first frame can come before the open. */
const brief = (xs: number[]): { n: number; p50?: number; p95?: number; max?: number } =>
  xs.length ? { n: xs.length, p50: ms(percentile(xs, 50)), p95: ms(percentile(xs, 95)), max: ms(Math.max(...xs)) } : { n: 0 }

/** Closes a launch the way a user does; one that doesn't quit cleanly is kept in `exits`, with its pid. */
async function close(l: PackagedLaunch): Promise<void> {
  const exit = await closePackaged(l).catch((e: Error) => e)
  if (exit instanceof Error) exits.push(`pid ${l.pid}: ${exit.message}`)
  else if (exit.code !== 0 || exit.signal !== null) exits.push(`pid ${l.pid}: quit with ${JSON.stringify(exit)}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Raw's first screen (Z37), opened by argv on a fresh launch: plan §5's open→usable, from the renderer's scan marks.
// The clock starts at the later of the open and the page's first frame (Z64). One launch per sample, after one
// warm-up launch that isn't kept.

type Sample = { marks: Marks; hz?: number; reason?: string; extra?: Record<string, unknown> }

async function openSample(file: string, timeout: number, after?: (page: Page) => Promise<Record<string, unknown>>): Promise<Sample> {
  const l = await launchPackaged({ cdp: true, file })
  let marks: Marks = {}
  let reason: string | undefined
  let extra: Record<string, unknown> | undefined
  try {
    marks = await scanMarks(l.page!, timeout)
    extra = await after?.(l.page!)
  } catch (e) {
    reason = (e as Error).message.split('\n')[0]
  }
  const hz = hzOf(l)
  await close(l)
  return { marks, hz, reason, extra }
}

async function samples(file: string, timeout: number, after?: (page: Page) => Promise<Record<string, unknown>>): Promise<Sample[]> {
  await openSample(file, timeout) // warm-up: not kept
  const out: Sample[] = []
  for (let i = 0; i < RUNS; i++) out.push(await openSample(file, timeout, after))
  return out
}

/** A first-screen sample's figures, in ms: from Z64's clock start, and from the open. */
function figures({ marks: m }: Sample) {
  const o = m['typose:open-start']!
  return {
    firstScreen: m['typose:first-screen']! - clockStart(m),
    fromOpen: m['typose:first-screen']! - o,
    firstFrameAfterOpen: m['typose:first-frame']! - o,
    lineScan: m['typose:line-scan']! - o,
    indexDone: m['typose:index-done']! - o
  }
}

/** A sample's marks are present, finite and in order; else why not (plan A's veto: a bad mark never passes). */
function marksInvalid(s: Sample): string | undefined {
  if (s.reason) return s.reason
  const names = ['typose:open-start', 'typose:first-frame', 'typose:first-screen', 'typose:index-done'] as const
  if (!names.every((n) => Number.isFinite(s.marks[n]))) return `missing or invalid marks: ${JSON.stringify(s.marks)}`
  if (!(s.marks['typose:first-screen']! > s.marks['typose:open-start']!)) return `the first screen isn't after the open: ${JSON.stringify(s.marks)}`
}

/** Plan §5's first-screen row: warm p95 under the budget from Z64's clock start, every sample's marks valid. */
function firstScreenRow(row: string, file: string, all: Sample[]): Row {
  const invalid = all.map(marksInvalid).filter(Boolean) as string[]
  const valid = all.filter((s) => !marksInvalid(s))
  const f = valid.map(figures)
  const stats = brief(f.map((x) => x.firstScreen))
  const verdict: Verdict = valid.length && stats.p95! >= BUDGET_MS ? 'fail' : invalid.length || !valid.length ? 'invalid' : 'pass'
  return {
    row,
    threshold: `p95 < ${BUDGET_MS} ms (warm), from max(open, first frame) (Z64)`,
    verdict,
    fixture: file.replace(FIXTURES, '.fixtures'),
    bytes: statSync(file).size,
    ...stats,
    fromOpen: brief(f.map((x) => x.fromOpen)),
    firstFrameAfterOpen: brief(f.map((x) => x.firstFrameAfterOpen)),
    indexDone: brief(f.map((x) => x.indexDone)),
    // Spec §13.1's "without scanning to end of file": the runs whose index was done before their first screen.
    indexDoneAtFirstScreen: valid.filter((s) => s.marks['typose:index-done']! <= s.marks['typose:first-screen']!).length,
    invalid,
    hz: [...new Set(all.map((s) => s.hz))],
    samples: f.map((x) => ({ firstScreen: ms(x.firstScreen), fromOpen: ms(x.fromOpen), firstFrame: ms(x.firstFrameAfterOpen), indexDone: ms(x.indexDone) }))
  }
}

// The named ≤ 100 MB fixture set (§10.2's ready-lens row): one per format, each just under 100 MB, opened in Raw.
const NAMED: [format: string, args: string[]][] = [
  ['md', ['md']],
  ['csv', ['csv']],
  ['tsv', ['tsv']],
  ['json', ['json', '--shape', 'records']],
  ['jsonl', ['jsonl', '--line', String(LINE)]],
  ['yaml', ['yaml']]
]
const NAMED_BYTES = 99_990_000 // every generator stops within one record of this: ≤ 100 MB

test.describe('first screen, the named set (≤ 100 MB, one per format)', () => {
  for (const [format, args] of NAMED) {
    test(`first screen, ready lens: ${format}`, async () => {
      test.setTimeout(30 * 60_000)
      const file = generate(`named.${format}`, NAMED_BYTES, [...args, '--bytes', String(NAMED_BYTES)])
      try {
        judge(firstScreenRow(`first-screen:named:${format}`, file, await samples(file, 10_000)))
      } finally {
        rmSync(file, { force: true })
      }
    })
  }
})

// Oversized first record (Z37): the first piece in the budget, before the scan passes the record's end, with PR 4's
// scan gate and plan A's veto. The veto's negative controls run on every live run's marks: each must fail the gate.
// A run whose scan ends inside the budget from the clock's start can't show a waiting lens, so it isn't judged on
// order. On the huge-first file that's the exemption the veto keeps (packet:476-478): the row rests on the budget. On
// the 1 GiB line it fails on Windows and macOS (PR 4's ruling, plan §7): that fixture is there to be decisive.
test.describe('oversized first record', () => {
  for (const [name, bytes, args, small] of [
    // Spike A's fixture: a 200 MiB first record, then 1 MiB of 200-byte records.
    ['huge-first.jsonl', (200 << 20) + (1 << 20), ['jsonl-huge-first', '--first', String(200 << 20), '--bytes', String(1 << 20)], true],
    // PR 4's: one 1 GiB line.
    ['1gib-one-line.jsonl', GIB, ['jsonl-huge-first', '--first', String(GIB - 57), '--bytes', '0'], false]
  ] as const) {
    test(`oversized first record: ${name}`, async () => {
      test.setTimeout(30 * 60_000)
      const file = generate(name, bytes, [...args])
      try {
        // The small records after the first follow once the scan passes it; no mounted item is over 64 KiB (C2).
        const after = async (page: Page) => {
          if (small) await expect(page.locator('.vl-row .text').filter({ hasText: 'line 0000000000' })).toBeAttached({ timeout: 60_000 })
          return { maxText: await page.locator('.vl-row .text').evaluateAll((els) => Math.max(...els.map((e) => e.textContent?.length ?? 0))) }
        }
        const all = await samples(file, 60_000, after)
        const row = firstScreenRow(`oversized:${name}`, file, all)
        const gates = all.map((s) => {
          const v = scanGate(s.marks)
          return small && v.verdict === 'not judged' ? { fails: false, line: `NOT JUDGED, exempt on this file (packet:476): ${v.reasons.join('; ')}` } : outcome(v, process.platform)
        })
        const controls = all.flatMap((s) => vetoControls(s.marks).map(([c, m]) => [c, scanGate(m).verdict] as const))
        const maxText = Math.max(...all.map((s) => Number(s.extra?.maxText ?? Infinity)))
        const gateFails = gates.filter((g) => g.fails)
        judge({
          ...row,
          threshold: `${row.threshold}; the first piece before the line's end (scan gate${small ? ', where observable' : ', decisive on Windows and macOS'}); no item over 64 KiB`,
          verdict: row.verdict === 'fail' || gateFails.length || !(maxText <= 65_536) ? 'fail' : row.verdict,
          scanGate: Object.fromEntries(['PASS', 'FAIL', 'NOT JUDGED'].map((v) => [v, gates.filter((g) => g.line.startsWith(v)).length])),
          scanGateLines: [...new Set(gates.map((g) => g.line.replace(/[\d.]+ ms/g, '… ms')))],
          scanGateFailures: gateFails.map((g) => g.line).slice(0, 5),
          fullLineScan: brief(all.filter((s) => !marksInvalid(s)).map((s) => figures(s).lineScan)),
          maxText
        })
        // The acceptance's negative control: without the scan mark, or with it out of order, every run fails the gate.
        expect(controls.filter(([, v]) => v !== 'fail'), 'a veto control that the gate didn’t fail').toEqual([])
        console.log(`veto controls: ${controls.length} on ${all.length} live runs, all fail the gate`)
      } finally {
        rmSync(file, { force: true })
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Frames (plan C8, Z62) during scrolling while indexing and far jumps (Z52), with accessibility on from launch and
// off. A run with an input the drive didn't send (the owner's keystroke, say) is invalid, with that reason.

type Drive = 'scroll' | 'keys' | 'jump' | 'ctrl-end' | 'open-scroll'
/** The input kinds each drive sends, and how many. */
const SENT: Record<Drive, Record<string, number>> = {
  scroll: { wheel: Infinity, scroll: Infinity },
  keys: { keydown: 21, scroll: Infinity },
  jump: { pointerdown: 1, click: 1, scroll: Infinity },
  'ctrl-end': { keydown: 2, scroll: Infinity }, // Control, then End
  'open-scroll': { open: 1, wheel: Infinity, scroll: Infinity }
}
type FrameRun = { analysis: Analysis; inputs: Record<string, number>; load: number; hz?: number; stray?: string; whileIndexing?: { driveMs: number; indexDoneAfterDriveStartMs: number | null }; firstFrameAfterOpen?: number; reason?: string }

const flag = (a11y: string) => (a11y === 'on' ? '--force-renderer-accessibility' : '--disable-renderer-accessibility')
const stray = (drive: Drive, inputs: Record<string, number>) =>
  Object.entries(inputs)
    .filter(([k, n]) => !(n <= (SENT[drive][k] ?? 0)))
    .map(([k, n]) => `${n} ${k}`)
    .join(', ') || undefined

/** Open-then-scroll: the open is the launch's own (argv), so the trace is a startup trace; the scroll follows at once. */
async function openThenScroll(file: string, a11y: string, n: number): Promise<FrameRun> {
  const trace = test.info().outputPath(`open-scroll-${n}.json`)
  const startup = [`--trace-startup=${CATEGORIES.join(',')}`, `--trace-startup-file=${trace}`, '--trace-startup-duration=6', '--trace-startup-format=json']
  const t = cpuTimes()
  const l = await launchPackaged({ cdp: true, file, args: [flag(a11y), ...startup] })
  const page = l.page!
  await waitOpen(page)
  await scroll(await page.context().newCDPSession(page))
  const marks = await scanMarks(page)
  // Written once the 6 s are up; read once it parses.
  let events: { name: string; ts: number }[] = []
  await expect
    .poll(() => {
      try {
        events = (JSON.parse(readFileSync(trace, 'utf8')) as { traceEvents: typeof events }).traceEvents
        return true
      } catch {
        return false
      }
    }, { timeout: 30_000 })
    .toBe(true)
  const hz = hzOf(l)
  await close(l)
  return { analysis: analyzeFrames(events), inputs: inputKinds(events), load: cpuLoad(t), hz, firstFrameAfterOpen: marks['typose:first-frame']! - marks['typose:open-start']! }
}

async function frameRun(file: string, drive: Drive, a11y: string, n: number, indexing: boolean): Promise<FrameRun> {
  if (drive === 'open-scroll') return openThenScroll(file, a11y, n)
  const l = await launchPackaged({ cdp: true, file, args: [flag(a11y)] })
  const page = l.page!
  await waitOpen(page)
  if (!indexing) await waitIndexed(page)
  await page.locator('.vl-scroller').focus()
  const hz = (await waitMarks(l, ['show'])).show.hz as number
  const now = () => page.evaluate(() => performance.now())
  let span = [0, 0]
  const run: Run = await traced(l, async (p: Page, cdp: CDPSession) => {
    const t0 = await now()
    if (drive === 'scroll') await scroll(cdp)
    else if (drive === 'keys') await keypresses(p)
    else if (drive === 'jump') await jump(p)
    else await p.keyboard.press('Control+End')
    span = [t0, await now()]
  })
  const done = await page.evaluate(() => performance.getEntriesByName('typose:index-done')[0]?.startTime ?? null)
  await close(l)
  return { ...run, hz, whileIndexing: indexing ? { driveMs: ms(span[1] - span[0]), indexDoneAfterDriveStartMs: done === null ? null : ms(done - span[0]) } : undefined }
}

/** Runs one frames case FRAME_RUNS times and judges it: any failed run fails it, any invalid run keeps it from passing. */
async function framesRow(file: string, label: string, drive: Drive, a11y: string, indexing: boolean): Promise<Row> {
  const runs: FrameRun[] = []
  for (let n = 0; n < FRAME_RUNS; n++) {
    const r = await frameRun(file, drive, a11y, n, indexing)
    r.stray = stray(drive, r.inputs)
    // Scrolling *while indexing* (§10.2): a drive that began after the index was done didn't measure that.
    const late = indexing && (drive === 'scroll' || drive === 'keys') && r.whileIndexing!.indexDoneAfterDriveStartMs !== null && r.whileIndexing!.indexDoneAfterDriveStartMs <= 0
    r.reason ??= !r.analysis.valid ? r.analysis.reason : r.stray ? `stray input the drive didn't send: ${r.stray}` : late ? 'the index was done before the drive began' : undefined
    runs.push(r)
  }
  // An invalid run judges nothing: a stray input or a drive after the index can't fail the case, nor pass it.
  const failed = (r: FrameRun) => !r.reason && (r.analysis.cadence === 'fail' || r.analysis.responsiveness === 'fail')
  const verdict: Verdict = runs.some(failed) ? 'fail' : runs.some((r) => r.reason) ? 'invalid' : 'pass'
  const answers = runs.flatMap((r) => r.analysis.inputToPaint.map((p) => p.ms))
  return {
    row: `frames:${label}:${drive}:a11y-${a11y}`,
    threshold: '≥ 99% of judged frames < 16.7 ms (cadence, Z62), no stall > 50 ms, every target painted',
    verdict,
    fixture: file.replace(FIXTURES, '.fixtures'),
    ...brief(answers), // responsiveness: input → its answer, over every answered input in the case's runs
    answers: answers.map(ms),
    hz: [...new Set(runs.map((r) => r.hz))],
    runs: runs.map(({ analysis: a, ...r }) => ({
      ...r,
      valid: a.valid,
      cadence: a.cadence,
      responsiveness: a.responsiveness,
      frames: a.frames,
      longFrames: a.longFrames,
      longShare: a.longShare,
      firstFrame: a.firstFrame,
      unanswered: a.unanswered,
      stalls: a.stalls,
      neverPainted: a.neverPainted.length,
      long: a.long.slice(0, 10),
      // Which inputs were answered late: during indexing, Raw's own re-applied scroll position marks `scroll` inputs too.
      slowAnswers: a.inputToPaint.filter((p) => p.ms >= 16.7),
      raf: a.raf
    }))
  }
}

/** The app's memory once `file` is indexed and the view has settled for a second. */
async function memory(file: string) {
  const l = await launchPackaged({ cdp: true, file })
  await waitOpen(l.page!)
  const lines = await waitIndexed(l.page!, 10 * 60_000)
  await l.page!.waitForTimeout(1000)
  const m = processMemory(l.pid)
  const hz = hzOf(l)
  await close(l)
  return { ...m, lines, hz, budgetBytes: totalmem() / 4 }
}

type Memory = { workingSet: number; privateBytes: number; pss: string; processes: { id: number; name: string; workingSet: number; privateBytes: number }[] }

/** Working set and private bytes summed over the app's whole process tree (main and every descendant), from the OS. */
function processMemory(pid: number): Memory {
  test.skip(process.platform !== 'win32', 'not run: the process counters here are Windows’; the Mac batch reads its own (Z55)')
  const ps =
    `$ids=@(${pid}); $all=Get-CimInstance Win32_Process; ` +
    'do { $n=$ids.Count; $ids=@($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object ProcessId)) } while ($ids.Count -gt $n); ' +
    'Get-Process -Id $ids | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'
  const out = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })) as { Id: number; ProcessName: string; WorkingSet64: number; PrivateMemorySize64: number }[]
  const processes = [out].flat().map((p) => ({ id: p.Id, name: p.ProcessName, workingSet: p.WorkingSet64, privateBytes: p.PrivateMemorySize64 }))
  const sum = (k: 'workingSet' | 'privateBytes') => processes.reduce((s, p) => s + p[k], 0)
  return { workingSet: sum('workingSet'), privateBytes: sum('privateBytes'), pss: 'n/a: Windows has no PSS', processes }
}

/** The file system and Defender's real-time protection where the fixtures live (the throughput row's conditions). */
function rig(): { fs?: string; defender?: boolean } {
  if (process.platform !== 'win32') return {}
  const ps = `@{ fs = (Get-Volume -DriveLetter ${FIXTURES[0]}).FileSystemType; defender = (Get-MpComputerStatus).RealTimeProtectionEnabled } | ConvertTo-Json -Compress`
  try {
    return JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }))
  } catch {
    return {}
  }
}

const FAR_JUMPS: Drive[] = ['jump', 'ctrl-end', 'open-scroll']

for (const [label, bytes] of [
  ['1gib', GIB],
  ['10gib', 10 * GIB]
] as const) {
  test.describe(`${label} JSONL`, () => {
    let file: string
    test.beforeAll(() => {
      test.setTimeout(10 * 60_000)
      file = generate(`${label}.jsonl`, bytes, ['jsonl', '--bytes', String(bytes), '--line', String(LINE)])
    })
    test.afterAll(() => rmSync(file, { force: true })) // generated fixtures are deleted when done

    test(`first screen: ${label}${label === '10gib' ? ', and the index throughput' : ''}`, async () => {
      test.setTimeout(60 * 60_000)
      const all = await samples(file, 10 * 60_000)
      judge(firstScreenRow(`first-screen:${label}`, file, all))
      if (label !== '10gib') return
      // The line index's throughput, from the same runs: decimal bytes over open → index done, judged at p95 time.
      const elapsed = all.filter((s) => !marksInvalid(s)).map((s) => figures(s).indexDone)
      const t = brief(elapsed)
      const gbps = (msec?: number) => (msec ? Math.round((bytes / 1e9 / (msec / 1000)) * 100) / 100 : undefined)
      const need = MAC ? 0.5 : 1
      judge({ row: 'index-throughput:10gib', threshold: `≥ ${need} GB/s warm (decimal bytes, at the p95 time), NTFS, Defender on`, verdict: !t.n ? 'invalid' : gbps(t.p95)! >= need ? 'pass' : 'fail', elapsedMs: t, gbps: { p50: gbps(t.p50), p95: gbps(t.p95), slowest: gbps(t.max) }, bytes, ...rig() })
    })

    if (label === '1gib') {
      test('64 KiB page fetch, round trip (1 GiB, indexed)', async () => {
        const l = await launchPackaged({ cdp: true, file })
        const page = l.page!
        await waitOpen(page)
        const lines = await waitIndexed(page)
        // The core's port and the document, from the app's own next page request; then 300 pages of 327 lines (64 KiB
        // of 200-byte lines) at random positions, each timed from the request to its reply, as the spike did.
        await page.evaluate(() => {
          const post = MessagePort.prototype.postMessage
          MessagePort.prototype.postMessage = function (this: MessagePort, message: unknown, ...rest: never[]) {
            const m = message as { method?: string; params?: { gen?: number } }
            if (m?.method === 'page' && m.params?.gen !== undefined) {
              MessagePort.prototype.postMessage = post
              Object.assign(window, { typoseFetch: { port: this, params: m.params } })
            }
            return post.call(this, message, ...rest)
          } as typeof post
        })
        await page.locator('.vl-scroller').focus()
        await page.keyboard.press('Control+End')
        await page.waitForFunction(() => 'typoseFetch' in window)
        const out = await page.evaluate(async (lines) => {
          const { port, params } = (window as unknown as { typoseFetch: { port: MessagePort; params: Record<string, unknown> } }).typoseFetch
          const replies = new Map<number, (data: { result?: { items: { text: string }[] }; error?: unknown }) => void>()
          port.addEventListener('message', (e: MessageEvent) => replies.get(e.data?.id)?.(e.data))
          const samples: number[] = []
          let chars = 0
          for (let i = 0; i < 300; i++) {
            const id = 2 ** 40 + i // clear of the app's own ids
            const start = Math.floor(Math.random() * (lines - 400))
            const t0 = performance.now()
            const reply = await new Promise<{ result?: { items: { text: string }[] }; error?: unknown }>((ok) => {
              replies.set(id, ok)
              port.postMessage({ id, method: 'page', params: { ...params, start, count: 327 } })
            })
            samples.push(performance.now() - t0)
            if (!reply.result || reply.result.items.length !== 327) throw new Error(`page ${start}: ${JSON.stringify(reply).slice(0, 300)}`)
            chars += reply.result.items.reduce((s, it) => s + it.text.length, 0)
          }
          return { samples, chars }
        }, lines)
        const hz = hzOf(l)
        await close(l)
        const s = brief(out.samples)
        judge({ row: 'fetch64k:1gib', threshold: 'p95 < 3 ms, round trip', verdict: s.p95! < 3 ? 'pass' : 'fail', ...s, charsPerPage: out.chars / 300, hz, samples: out.samples.map(ms) })
      })

      test('memory (1 GiB, indexed)', async () => {
        const m = await memory(file)
        judge({ row: 'memory:1gib', threshold: 'working set summed across processes < 1 GiB', verdict: m.workingSet < GIB ? 'pass' : 'fail', ...m })
      })
    } else {
      test('deep reading at line 40M (10 GiB)', async () => {
        test.setTimeout(15 * 60_000)
        const l = await launchPackaged({ cdp: true, file })
        const page = l.page!
        await waitOpen(page)
        const lines = await waitIndexed(page, 10 * 60_000)
        const scroller = page.locator('.vl-scroller')
        const box = (await scroller.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        /** The view's logical top (px), from a mounted row: its line × 20 px less its offset in the layer. */
        const top = () =>
          page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('.vl-row')!
            return Number(el.dataset.line) * 20 - Number(/translateY\((-?[\d.e+]+)px\)/.exec(el.style.transform)![1])
          })
        /** Scrolls the thumb to `line` (a scrollbar move, as a reader would), then wheels 10 notches; the lines moved. */
        const notches = async (line: number) => {
          await scroller.evaluate((el, frac) => (el.scrollTop = frac * (el.scrollHeight - el.clientHeight)), (line * 20) / (lines * 20 - (await scroller.evaluate((el) => el.clientHeight))))
          await page.waitForTimeout(300)
          const before = await top()
          for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120)
          await page.waitForTimeout(300)
          return { at: before / 20, moved: ((await top()) - before) / 20 }
        }
        const atTop = await notches(0)
        const deep = await notches(40_000_000)
        // The screen matches the model, and the file: the top row is the line the scroll state says, with its text.
        const shown = (await visibleRows(page))[0]
        const disk = Buffer.alloc(LINE - 1)
        const fd = openSync(file, 'r')
        readSync(fd, disk, 0, LINE - 1, (shown.line - 1) * LINE)
        closeSync(fd)
        // The first fully visible row: a row partly above the top edge isn't counted (app.ts's visibleRows).
        const painted = { gutter: shown.line, expected: Math.ceil(((await top()) - 1) / 20) + 1, textMatchesDisk: shown.text === disk.toString('utf8') }
        await scroller.focus()
        const before = await top()
        await page.keyboard.press('PageDown')
        await page.waitForTimeout(300)
        const pageDown = { moved: (await top()) - before, viewport: await scroller.evaluate((el) => el.clientHeight) }
        const hz = hzOf(l)
        await close(l)
        // 10 × 120 px is 60 rows of 20 px. Float positions near 8e8 px aren't exact, so equal means within a pixel.
        const ok = Math.abs(atTop.moved - 60) < 0.05 && Math.abs(deep.moved - atTop.moved) <= 1 && painted.gutter === painted.expected && painted.textMatchesDisk && Math.abs(pageDown.moved - pageDown.viewport) < 1
        judge({ row: 'deep-reading:10gib', threshold: '10 notches at line 40M move as at line 0 (±1 line); PageDown = 1 viewport', verdict: ok ? 'pass' : 'fail', lines, atTop, deep, painted, pageDown, hz })
        judge({ row: 'trackpad:mac', threshold: 'the trackpad moves ≤ 1 viewport per frame (Mac)', verdict: 'pending', reason: 'Mac only (Z55, Z58)' })
      })

      test('memory (10 GiB, indexed)', async () => {
        const m = await memory(file)
        const ledger = 'pending: the ledger is PR 6 (plan C1), not yet merged'
        judge({ row: 'memory:10gib', threshold: 'ledger ≤ limit; private bytes, working set and PSS reported', verdict: 'pending', ledger, ...m })
      })

      for (const a11y of ['on', 'off'])
        test(`scrolling and keys while indexing, and input latency (10 GiB), a11y ${a11y}`, async () => {
          test.setTimeout(30 * 60_000)
          const scrolled = await framesRow(file, label, 'scroll', a11y, true)
          const keys = await framesRow(file, label, 'keys', a11y, true)
          judge(scrolled)
          judge(keys)
          // Plan §5's input latency while indexing, over every answered input of both cases: each < 50 ms, and every
          // input answered (C8: over 50 ms, or never painted, it's a responsiveness stall).
          const runs = [scrolled, keys].flatMap((r) => r.runs as { valid: boolean; reason?: string; responsiveness: string }[])
          judge({
            row: `input-latency:10gib:a11y-${a11y}`,
            threshold: MAC ? 'reported (Mac)' : 'every input answered < 50 ms (C8, Z62)',
            verdict: MAC ? 'reported' : runs.some((r) => !r.reason && r.responsiveness === 'fail') ? 'fail' : runs.some((r) => r.reason) ? 'invalid' : 'pass',
            ...brief([scrolled, keys].flatMap((r) => r.answers as number[])),
            wheel: { n: scrolled.n, p50: scrolled.p50, p95: scrolled.p95, max: scrolled.max },
            keys: { n: keys.n, p50: keys.p50, p95: keys.p95, max: keys.max }
          })
        })
    }

    for (const a11y of ['on', 'off'])
      test(`far jumps (${label}), a11y ${a11y}`, async () => {
        test.setTimeout(30 * 60_000)
        for (const drive of FAR_JUMPS) judge(await framesRow(file, label, drive, a11y, label === '10gib'))
      })
  })
}

test('NetLog after idle, with a remote-image Markdown file open in Raw', async () => {
  test.setTimeout(IDLE_MS + 5 * 60_000)
  const md = fixture('remote-images.md', '# Remote\n\n![x](https://example.com/a.png)\n\n![y](http://203.0.113.9/b.png)\n')
  const log = test.info().outputPath('idle.netlog.json')
  const l = await launchPackaged({ file: md, netlog: log })
  await waitMarks(l, ['rawUsable'])
  await new Promise((ok) => setTimeout(ok, IDLE_MS))
  await close(l)
  rmSync(md, { force: true })
  let reason: string | undefined
  try {
    assertNetLog(log)
  } catch (e) {
    reason = (e as Error).message.slice(0, 2000)
  }
  judge({ row: 'netlog:idle', threshold: 'no network activity after the idle (spec §7.3)', verdict: reason ? 'fail' : 'pass', reason, idleMs: IDLE_MS })
})
