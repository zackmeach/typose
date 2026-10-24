// Driving the packaged build under plan C8's frame instrument: a CDP trace around a drive, and the drives PR 3's
// controls and the M1 runner share (frames.perf.ts, m1.perf.ts).
import type { CDPSession, Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { test } from '../app'
import type { PackagedLaunch } from '../packaged'
import { CATEGORIES, analyzeFrames } from './frames.mjs'
import { cpuLoad, cpuTimes } from './rig'

export type Analysis = ReturnType<typeof analyzeFrames>
export type Span = { from: number; to: number }
/** `inputs`: the input marks in the trace, counted by kind, so a run can tell inputs it didn't send. */
export type Run = { analysis: Analysis; busy: Span[]; load: number; inputs: Record<string, number> }

type TraceEvent = { name: string; ts: number; args?: { data?: { message?: string } } }

/** The trace's `typose:input` marks, counted by kind. */
export function inputKinds(events: TraceEvent[]): Record<string, number> {
  const kinds: Record<string, number> = {}
  for (const e of events) {
    const m = e.name === 'TimeStamp' ? e.args?.data?.message : undefined
    if (m?.startsWith('typose:input ')) kinds[m.split(' ')[2]] = (kinds[m.split(' ')[2]] ?? 0) + 1
  }
  return kinds
}

/**
 * Traces `drive` (Chromium tracing over CDP, C8's pinned categories) and analyzes it; also returns the busy spans. The
 * trace is kept as `<name>.json` in the test's output, so each run of a test that traces several keeps its own.
 */
export async function traced(l: PackagedLaunch, drive: (page: Page, cdp: CDPSession) => Promise<void>, name = 'trace'): Promise<Run> {
  const page = l.page!
  const cdp = await page.context().newCDPSession(page)
  const from = cpuTimes()
  await l.browser!.startTracing(page, { categories: CATEGORIES })
  await page.waitForTimeout(500) // the first frame after tracing starts can take 120 ms: keep it out of the run
  // The baseline: the view as it stands, marked painted, so the drive's first input is judged against it (C8).
  await page.evaluate(() => window.dispatchEvent(new Event('typose:baseline')))
  await drive(page, cdp)
  await page.waitForTimeout(500) // let the last input settle inside the trace
  const trace = await l.browser!.stopTracing()
  writeFileSync(test.info().outputPath(`${name}.json`), trace) // the evidence, beside the run's lifecycle log
  const events = JSON.parse(trace.toString()).traceEvents as TraceEvent[]
  const load = cpuLoad(from)
  const at = (m: string) => events.filter((e) => e.name === 'TimeStamp' && e.args?.data?.message === m).map((e) => e.ts / 1000)
  const busy: Span[] = at('typose:busy-start').map((from, i) => ({ from, to: at('typose:busy-end')[i] }))
  return { analysis: analyzeFrames(events), busy, load, inputs: inputKinds(events) }
}

/** A smooth mouse-wheel scroll down, synthesized by the browser at the display's rate. */
export async function scroll(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.synthesizeScrollGesture', { x: 400, y: 400, yDistance: -6000, speed: 3000, gestureSourceType: 'mouse' })
}

/** 21 discrete ArrowDown presses, 100 ms apart: each scrolls one row, so each is answered by one frame. */
export async function keypresses(page: Page): Promise<void> {
  for (let i = 0; i < 21; i++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(100)
  }
}

/** Drags the scrollbar thumb from the top to near the bottom in one move: a far jump. */
export async function jump(page: Page): Promise<void> {
  const box = (await page.locator('.vl-scroller').boundingBox())!
  // The thumb starts just below the up-arrow button, which is as tall as the scrollbar is wide.
  const bar = await page.locator('.vl-scroller').evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)
  const x = box.x + box.width - bar / 2
  await page.mouse.move(x, box.y + bar + 8)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height * 0.8)
  await page.mouse.up()
}
