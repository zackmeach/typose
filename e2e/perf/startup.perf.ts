// Plan C8's startup instrument, as amended in PR 3. shellVisible is when the title bar reaches the screen: its first
// presentation after main's `show` (Element Timing), from the spawn, on the wall clock. It's never `show` itself: a run
// that can't establish that presentation is invalid, with its reason. launch→firstContent and open→usable Raw end at
// Raw's first screen. No launch here passes a debugging switch: every mark comes from the TYPOSE_MARKS hook (plan §5).
//   Controls:  npm run build:hooks && npm run package, then `npm run perf -- -g control`
//   Warm:      npm run package, then `npm run perf -- -g warm` (RUNS=30 by default)
//   Cold:      COLD=1 RUNS=1 `npm run perf -- -g warm`, as the first launch after each OS restart (Z54).
// Every run is appended to .evidence/m1/perf/, valid or not.
import { expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_DIR, FIXTURES, fixture, test } from '../app'
import { type LaunchOptions, closePackaged, launchPackaged, readMarks, waitMarks } from '../packaged'
import { cpuLoad, cpuTimes, idleLoad, percentile, recordOutcome, summary } from './rig'

const RUNS = Number(process.env.RUNS ?? 30)
const COLD = process.env.COLD === '1'

let outcome: { key: string; value: Record<string, unknown> } | null = null
test.beforeEach(() => void (outcome = null))
test.afterEach(() => {
  if (outcome) recordOutcome(test.info(), outcome.key, outcome.value)
})

/**
 * One launch's startup figures, in ms from the spawn. The title bar's first presentation counts only if it came
 * after `show`; when it came first (presented to the hidden window), the renderer's probe gives the first presentation
 * after the show (`shownPresented`).
 */
async function startup(opts: LaunchOptions) {
  const from = cpuTimes()
  const l = await launchPackaged(opts)
  let reason: string | undefined
  try {
    await waitMarks(l, ['show', 'titlebarPainted', 'titlebarPresented', 'shownPresented', ...(opts.file ? ['rawUsable'] : [])], 15_000)
  } catch (e) {
    reason = (e as Error).message
  }
  const m = readMarks(l)
  const exit = await closePackaged(l)
  if (!reason && (exit.code !== 0 || exit.signal !== null)) reason = `the launch didn't quit cleanly: ${JSON.stringify(exit)}`
  const at = (name: string) => (m[name] ? m[name].t - l.spawnedAt : NaN)
  const presentedBy = at('titlebarPresented') >= at('show') ? 'titlebarPresented' : 'shownPresented'
  const shellVisible = at(presentedBy)
  if (!reason && !(shellVisible >= at('show'))) reason = 'no presentation after the show'
  return {
    valid: !reason,
    reason,
    shellVisible: reason ? undefined : shellVisible,
    presentedBy,
    firstContent: opts.file && !reason ? at('rawUsable') : undefined,
    openToUsable: opts.file && !reason ? m.rawUsable.t - m.openRequested.t : undefined,
    marks: Object.fromEntries(Object.keys(m).map((k) => [k, at(k)])),
    hz: m.show?.hz as number | undefined,
    load: cpuLoad(from)
  }
}
type Sample = Awaited<ReturnType<typeof startup>>

/** The dev layout of `npm run build:hooks`, on the same Electron: only it has the startup controls' hooks. */
const hooksBuild = (env: Record<string, string> = {}, args: string[] = []): LaunchOptions => ({
  exe: require('electron') as string,
  args: [join(APP_DIR, 'out-hooks/main/index.js'), ...args],
  env
})
const needHooks = () => {
  if (!existsSync(join(APP_DIR, 'out-hooks/main/index.js'))) throw new Error('run `npm run build:hooks` first')
}

test.describe('startup controls', () => {
  for (const [control, env] of [
    ['show() delayed 300 ms after both ready-to-show and titlebarPainted', { TYPOSE_TEST_DELAY_SHOW: '300' }],
    ["React's mount delayed 300 ms", { TYPOSE_TEST_DELAY_MOUNT: '300' }]
  ] as const) {
    test(`control: ${control} puts shellVisible ≥ 300 ms after the delay starts`, async () => {
      needHooks()
      const base: Sample[] = []
      const delayed: Sample[] = []
      for (let i = 0; i < 5; i++) {
        base.push(await startup(hooksBuild()))
        delayed.push(await startup(hooksBuild(env)))
      }
      const key = 'TYPOSE_TEST_DELAY_SHOW' in env ? 'delayShow' : 'delayMount'
      const med = (xs: Sample[]) => percentile(xs.filter((s) => s.valid).map((s) => s.shellVisible!), 50)
      outcome = { key: `control:${key}`, value: { raisedBy: med(delayed) - med(base), base, delayed } }
      console.log(control, JSON.stringify({ base: med(base), delayed: med(delayed), presentedBy: delayed.map((s) => s.presentedBy) }))
      // Every run establishes the presentation after the show; an invalid one fails the control with its reason.
      for (const s of [...base, ...delayed]) expect(s.valid, s.reason).toBe(true)
      // Each delayed run's presentation lands ≥ 300 ms after the instant its delay started from (plan C8 as amended):
      // max(ready-to-show, titlebarPainted) for show(), the bundle's evaluation for the mount.
      for (const { shellVisible, marks: m } of delayed)
        expect(shellVisible).toBeGreaterThanOrEqual(('TYPOSE_TEST_DELAY_SHOW' in env ? Math.max(m.readyToShow, m.titlebarPainted) : m.bundleEvaluated) + 300)
    })
  }

  /** Launches with a startup trace and checks that `name` is one of the window's displayed frames, after the show. */
  async function presentationIsDisplayed(opts: LaunchOptions, name: 'titlebarPresented' | 'shownPresented') {
    const trace = test.info().outputPath(`startup-trace-${name}.json`)
    const cats = 'disabled-by-default-display.framedisplayed,blink.user_timing'
    const traceArgs = [`--trace-startup=${cats}`, `--trace-startup-file=${trace}`, '--trace-startup-duration=2', '--trace-startup-format=json']
    const l = await launchPackaged({ ...opts, args: [...(opts.args ?? []), ...traceArgs] })
    const m = await waitMarks(l, ['show', 'titlebarPainted', 'titlebarPresented', 'shownPresented', 'navigationStart'])
    await expect.poll(() => existsSync(trace), { timeout: 15_000 }).toBe(true) // written once the 2 s are up
    await new Promise((ok) => setTimeout(ok, 1000))
    await closePackaged(l)
    const events = (JSON.parse(readFileSync(trace, 'utf8')) as { traceEvents: { name: string; ts: number }[] }).traceEvents
    // The renderer's navigation start is both a trace event and a wall-clock mark: it maps one clock onto the other.
    const nav = events.find((e) => e.name === 'navigationStart')!
    const displayed = events.filter((e) => e.name === 'Display::FrameDisplayed').map((e) => m.navigationStart.t + (e.ts - nav.ts) / 1000)
    const rel = (t: number) => Math.round(t - l.spawnedAt)
    const detail = JSON.stringify({ marks: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rel(v.t)])), displayed: displayed.map(rel) })
    outcome = { key: `control:presentation:${name}`, value: { marks: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rel(v.t)])), displayed: displayed.map(rel) } }
    // One of the window's displayed frames, to within a refresh interval (the clocks are mapped through whole-ms
    // marks). An earlier displayed frame can be the browser's own: background and caption buttons, without the page.
    const near = Math.min(...displayed.map((t) => Math.abs(t - m[name].t)))
    expect(near, detail).toBeLessThan(1000 / (m.show.hz as number))
    expect(m[name].t, detail).toBeGreaterThanOrEqual(m.show.t)
  }

  test("control: titlebarPresented is one of the window's displayed frames, after the show", async () => {
    await presentationIsDisplayed({}, 'titlebarPresented')
  })

  test("control: with show() delayed, shownPresented is one of the window's displayed frames, after the show", async () => {
    needHooks()
    await presentationIsDisplayed(hooksBuild({ TYPOSE_TEST_DELAY_SHOW: '300' }), 'shownPresented')
  })
})

test(`warm startup on the packaged build, n = ${RUNS} (informational)`, async () => {
  test.setTimeout(30 * 60_000)
  // Plan §5's batches open 1 GiB and 10 GiB files; this informational run opens a small one.
  const file = fixture('startup.jsonl', Array.from({ length: 200_000 }, (_, i) => `{"n":${i},"msg":"startup line ${i}"}`).join('\n'))
  const before = await idleLoad()
  const from = cpuTimes()
  if (!COLD) await startup({ file }) // one warm-up launch, not kept
  const samples: Sample[] = []
  for (let i = 0; i < RUNS; i++) samples.push(await startup({ file }))
  const ok = samples.filter((s) => s.valid)
  const pick = (k: 'shellVisible' | 'firstContent' | 'openToUsable') => ok.map((s) => s[k]!)
  const result = {
    runs: samples.length,
    invalid: samples.filter((s) => !s.valid).map((s) => s.reason),
    shellVisible: ok.length ? summary(pick('shellVisible')) : undefined,
    firstContent: ok.length ? summary(pick('firstContent')) : undefined,
    openToUsable: ok.length ? summary(pick('openToUsable')) : undefined,
    presentedBy: ok.map((s) => s.presentedBy),
    marksP50: ok.length ? Object.fromEntries(Object.keys(ok[0].marks).map((k) => [k, percentile(ok.map((s) => s.marks[k]), 50)])) : undefined,
    hz: [...new Set(samples.map((s) => s.hz))],
    loadBefore: before,
    loadDuring: cpuLoad(from),
    loadPerRun: samples.map((s) => s.load),
    samples,
    file: file.replace(FIXTURES, '.fixtures')
  }
  outcome = { key: COLD ? 'cold:startup' : 'warm:startup', value: result }
  const brief = (s?: { n: number; p50: number; p95: number; max: number }) => s && { n: s.n, p50: s.p50, p95: s.p95, max: s.max }
  const { samples: _all, ...shown } = result
  console.log(JSON.stringify({ ...shown, shellVisible: brief(result.shellVisible), firstContent: brief(result.firstContent), openToUsable: brief(result.openToUsable) }, null, 1))
  expect(result.invalid, 'invalid runs are kept with their reasons above').toEqual([])
})
