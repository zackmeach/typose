// Plan C8's startup instrument, as amended in PR 3. shellVisible is when the title bar reaches the screen: the later
// of main's `show` and the title bar's first presentation (Element Timing), from the spawn, on the wall clock.
// launch→firstContent and open→usable Raw end at Raw's first screen. No launch here passes a debugging switch: every
// mark comes from the TYPOSE_MARKS hook (plan §5).
//   Controls:  npm run build:hooks && npm run package, then `npm run perf -- -g control`
//   Warm:      npm run package, then `npm run perf -- -g warm` (RUNS=30 by default)
//   Cold:      COLD=1 RUNS=1 `npm run perf -- -g warm`, as the first launch after each OS restart (Z54).
import { expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_DIR, FIXTURES, fixture, test } from '../app'
import { type LaunchOptions, closePackaged, launchPackaged, waitMarks } from '../packaged'
import { cpuLoad, cpuTimes, idleLoad, percentile, record, summary } from './rig'

const RUNS = Number(process.env.RUNS ?? 30)
const COLD = process.env.COLD === '1'

/** One launch's startup figures, in ms from the spawn. */
async function startup(opts: LaunchOptions) {
  const from = cpuTimes()
  const l = await launchPackaged(opts)
  const m = await waitMarks(l, ['show', 'titlebarPainted', 'titlebarPresented', ...(opts.file ? ['rawUsable'] : [])])
  const exit = await closePackaged(l)
  expect(exit, 'a measured launch quits cleanly').toEqual({ code: 0, signal: null })
  const at = (name: string) => m[name].t - l.spawnedAt
  return {
    shellVisible: Math.max(at('show'), at('titlebarPresented')),
    firstContent: opts.file ? at('rawUsable') : undefined,
    openToUsable: opts.file ? m.rawUsable.t - m.openRequested.t : undefined,
    marks: Object.fromEntries(Object.keys(m).map((k) => [k, at(k)])),
    hz: m.show.hz as number,
    load: cpuLoad(from)
  }
}
type Sample = Awaited<ReturnType<typeof startup>>

/** The dev layout of `npm run build:hooks`, on the same Electron: only it has the startup controls' hooks. */
const hooksBuild = (env: Record<string, string> = {}): LaunchOptions => ({
  exe: require('electron') as string,
  args: [join(APP_DIR, 'out-hooks/main/index.js')],
  env
})

test.describe('startup controls', () => {
  for (const [control, env] of [
    ['show() delayed 300 ms after both ready-to-show and titlebarPainted', { TYPOSE_TEST_DELAY_SHOW: '300' }],
    ["React's mount delayed 300 ms", { TYPOSE_TEST_DELAY_MOUNT: '300' }]
  ] as const) {
    test(`control: ${control} puts shellVisible ≥ 300 ms after the delay starts`, async () => {
      if (!existsSync(join(APP_DIR, 'out-hooks/main/index.js'))) throw new Error('run `npm run build:hooks` first')
      const base: Sample[] = []
      const delayed: Sample[] = []
      for (let i = 0; i < 5; i++) {
        base.push(await startup(hooksBuild()))
        delayed.push(await startup(hooksBuild(env)))
      }
      // Each delayed run's shellVisible lands ≥ 300 ms after the instant its delay started from (plan C8 as amended):
      // max(ready-to-show, titlebarPainted) for show(), the bundle's evaluation for the mount.
      for (const { shellVisible, marks: m } of delayed)
        expect(shellVisible).toBeGreaterThanOrEqual(('TYPOSE_TEST_DELAY_SHOW' in env ? Math.max(m.readyToShow, m.titlebarPainted) : m.bundleEvaluated) + 300)
      // Across runs, recorded and not judged: the mount delay overlaps the wait for the first frame (see the plan).
      const med = (xs: Sample[]) => percentile(xs.map((s) => s.shellVisible), 50)
      const key = 'TYPOSE_TEST_DELAY_SHOW' in env ? 'delayShow' : 'delayMount'
      record(`control:${key}`, { raisedBy: med(delayed) - med(base), base: base.map((s) => s.marks), delayed: delayed.map((s) => s.marks) })
      console.log(control, JSON.stringify({ base: med(base), delayed: med(delayed) }))
    })
  }

  test("control: titlebarPresented is one of the window's displayed frames in a startup trace", async () => {
    const trace = test.info().outputPath('startup-trace.json')
    const cats = 'disabled-by-default-display.framedisplayed,blink.user_timing'
    const l = await launchPackaged({ args: [`--trace-startup=${cats}`, `--trace-startup-file=${trace}`, '--trace-startup-duration=2', '--trace-startup-format=json'] })
    const m = await waitMarks(l, ['show', 'titlebarPainted', 'titlebarPresented', 'navigationStart'])
    await expect.poll(() => existsSync(trace), { timeout: 15_000 }).toBe(true) // written once the 2 s are up
    await new Promise((ok) => setTimeout(ok, 1000))
    await closePackaged(l)
    const events = (JSON.parse(readFileSync(trace, 'utf8')) as { traceEvents: { name: string; ts: number }[] }).traceEvents
    // The renderer's navigation start is both a trace event and a wall-clock mark: it maps one clock onto the other.
    const nav = events.find((e) => e.name === 'navigationStart')!
    const displayed = events.filter((e) => e.name === 'Display::FrameDisplayed').map((e) => m.navigationStart.t + (e.ts - nav.ts) / 1000)
    const rel = (t: number) => Math.round(t - l.spawnedAt)
    const detail = JSON.stringify({ marks: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rel(v.t)])), displayed: displayed.map(rel) })
    // It's one of the window's displayed frames, to within a refresh interval (the two clocks are mapped through
    // whole-ms marks). An earlier displayed frame can be the browser's own: background and caption buttons, before
    // the page's surface is in it.
    const near = Math.min(...displayed.map((t) => Math.abs(t - m.titlebarPresented.t)))
    expect(near, detail).toBeLessThan(1000 / (m.show.hz as number))
    expect(m.titlebarPresented.t).toBeGreaterThan(m.show.t) // in the app's own path, the frame lands after the show
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
  const pick = (k: 'shellVisible' | 'firstContent' | 'openToUsable') => samples.map((s) => s[k]!)
  const result = {
    shellVisible: summary(pick('shellVisible')),
    firstContent: summary(pick('firstContent')),
    openToUsable: summary(pick('openToUsable')),
    marksP50: Object.fromEntries(Object.keys(samples[0].marks).map((k) => [k, percentile(samples.map((s) => s.marks[k]), 50)])),
    hz: [...new Set(samples.map((s) => s.hz))],
    loadBefore: before,
    loadDuring: cpuLoad(from),
    loadPerRun: samples.map((s) => s.load),
    file: file.replace(FIXTURES, '.fixtures')
  }
  record(COLD ? `cold:startup:${Date.now()}` : 'warm:startup', result)
  const brief = (s: { n: number; p50: number; p95: number; max: number }) => ({ n: s.n, p50: s.p50, p95: s.p95, max: s.max })
  console.log(JSON.stringify({ ...result, shellVisible: brief(result.shellVisible), firstContent: brief(result.firstContent), openToUsable: brief(result.openToUsable) }, null, 1))
})
