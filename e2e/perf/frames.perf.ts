// Plan C8's frame instrument and its controls, on the packaged build over CDP, with accessibility on and off (Z62:
// cadence and responsiveness are judged apart): a 30 ms busy-wait during a scroll is a long frame covering it and no
// stall; 60 ms is a stall covering it, during a scroll, in the handler of one discrete keypress, and in the first frame
// after a scrollbar jump; a control scroll has no stall and passes cadence; control keypresses pass responsiveness and
// report cadence as not applicable; and a jump whose target never renders fails.
//   Run: npm run package, then `npm run perf -- -g accessibility`, and the keypress control 10 times over with
//   `npm run perf -- -g "keypresses with no injection" --repeat-each=10`. Every run is appended to .evidence/m1/perf/.
import { type CDPSession, type Page, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { fixture, test, waitIndexed, waitOpen } from '../app'
import { type PackagedLaunch, closePackaged, launchPackaged, waitMarks } from '../packaged'
import { CATEGORIES, analyzeFrames } from './frames.mjs'
import { cpuLoad, cpuTimes, recordOutcome } from './rig'

type Analysis = ReturnType<typeof analyzeFrames>
type Span = { from: number; to: number }
type Run = { analysis: Analysis; busy: Span[]; load: number }

// 1M lines × 20 px is past the 16M px native cap, so Raw scrolls logically: every wheel goes through the main thread.
const LINES = 1_000_000
let file: string
test.beforeAll(() => {
  file = fixture('frames.txt', Array.from({ length: LINES }, (_, i) => `${i} ${'frame '.repeat(i % 12)}`).join('\n'))
})

/** Traces `drive` (Chromium tracing over CDP, C8's pinned categories) and analyzes it; also returns the busy spans. */
async function traced(l: PackagedLaunch, drive: (page: Page, cdp: CDPSession) => Promise<void>): Promise<Run> {
  const page = l.page!
  const cdp = await page.context().newCDPSession(page)
  const from = cpuTimes()
  await l.browser!.startTracing(page, { categories: CATEGORIES })
  await page.waitForTimeout(500) // the first frame after tracing starts can take 120 ms: keep it out of the run
  await drive(page, cdp)
  await page.waitForTimeout(500) // let the last input settle inside the trace
  const trace = await l.browser!.stopTracing()
  writeFileSync(test.info().outputPath('trace.json'), trace) // the evidence, beside the run's lifecycle log
  const events = JSON.parse(trace.toString()).traceEvents as { name: string; ts: number; args?: { data?: { message?: string } } }[]
  const load = cpuLoad(from)
  const at = (m: string) => events.filter((e) => e.name === 'TimeStamp' && e.args?.data?.message === m).map((e) => e.ts / 1000)
  const busy: Span[] = at('typose:busy-start').map((from, i) => ({ from, to: at('typose:busy-end')[i] }))
  return { analysis: analyzeFrames(events), busy, load }
}

type Busy = Window & { typoseBusy: (ms: number) => void }

/** Installs the injection: a busy-wait of `ms` on the renderer's main thread, bracketed by trace marks. */
const installBusy = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as Busy).typoseBusy = (ms: number) => {
      console.timeStamp('typose:busy-start')
      const start = performance.now()
      while (performance.now() - start < ms);
      console.timeStamp('typose:busy-end')
    }
  })

/** A smooth mouse-wheel scroll down, synthesized by the browser at the display's rate. */
async function scroll(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.synthesizeScrollGesture', { x: 400, y: 400, yDistance: -6000, speed: 3000, gestureSourceType: 'mouse' })
}

/** Arms a busy-wait in the handler of the `nth` event of `type` from now (capture phase, before the app's handler). */
const busyOn = (page: Page, type: 'wheel' | 'keydown', nth: number, ms: number) =>
  page.evaluate(
    ([type, nth, ms]) => {
      let n = 0
      const handler = () => {
        if (++n < nth) return
        window.removeEventListener(type, handler, true)
        ;(window as unknown as Busy).typoseBusy(ms)
      }
      window.addEventListener(type, handler, true)
    },
    [type, nth, ms] as const
  )

/** 21 discrete ArrowDown presses, 100 ms apart: each scrolls one row, so each is answered by one frame. */
async function keypresses(page: Page): Promise<void> {
  for (let i = 0; i < 21; i++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(100)
  }
}

/** Drags the scrollbar thumb from the top to near the bottom in one move: a far jump. */
async function jump(page: Page): Promise<void> {
  const box = (await page.locator('.vl-scroller').boundingBox())!
  // The thumb starts just below the up-arrow button, which is as tall as the scrollbar is wide.
  const bar = await page.locator('.vl-scroller').evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)
  const x = box.x + box.width - bar / 2
  await page.mouse.move(x, box.y + bar + 8)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height * 0.8)
  await page.mouse.up()
}

for (const a11y of ['on', 'off'] as const) {
  test.describe(`accessibility ${a11y}`, () => {
    let l: PackagedLaunch
    let hz: number
    let run: { name: string; r: Run } | null = null
    /**
     * The span covers the injection: it runs past the injection's end, and the work behind it began before the
     * injection did. A frame already in the pipeline when the main thread blocks still presents during the block (seen
     * 3–12 ms in), and nothing begun after the block starts can present until it ends.
     */
    const covers = (span: Span & { began: number }, busy: Span) => span.to >= busy.to && span.began <= busy.from
    const valid = (r: Run) => expect(r.analysis.valid, `invalid run: ${r.analysis.reason}`).toBe(true)
    const keep = (name: string, r: Run) => {
      run = { name, r }
      const a = r.analysis
      console.log(name, `a11y ${a11y}`, JSON.stringify({ hz, valid: a.valid, reason: a.reason, cadence: a.cadence, responsiveness: a.responsiveness, frames: a.frames, firstFrame: a.firstFrame, unanswered: a.unanswered, long: a.long, stalls: a.stalls, never: a.neverPainted?.length, busy: r.busy, raf: a.raf, load: r.load }))
    }

    test.beforeEach(async () => {
      run = null
      l = await launchPackaged({ cdp: true, file, args: [a11y === 'on' ? '--force-renderer-accessibility' : '--disable-renderer-accessibility'] })
      await waitOpen(l.page!)
      await waitIndexed(l.page!)
      await l.page!.locator('.vl-scroller').focus()
      await installBusy(l.page!)
      hz = (await waitMarks(l, ['show'])).show.hz as number
    })
    test.afterEach(async () => {
      const closed = await closePackaged(l).then(() => undefined, (e: Error) => e)
      // Kept with its status and reason, pass or fail (Z49), and when the app fails to exit: nothing overwrites an earlier run.
      if (run) {
        const { inputToPaint, ...a } = run.r.analysis
        recordOutcome(test.info(), `frames:${run.name}:a11y-${a11y}`, { ...a, hz, inputToPaintMaxMs: Math.max(0, ...(inputToPaint ?? []).map((p) => p.ms)), busy: run.r.busy, load: run.r.load, closeError: closed?.message })
      }
      if (closed) throw closed
    })

    test('control: a scroll with no injection has no stall and passes cadence and responsiveness', async () => {
      const r = await traced(l, (_page, cdp) => scroll(cdp))
      keep('control', r)
      valid(r)
      expect(r.analysis.frames).toBeGreaterThan(250) // the 2 s gesture is judged as one demanded interval
      expect(r.analysis.stalls).toEqual([])
      expect(r.analysis.neverPainted).toEqual([])
      // Plan C8 as amended: a loaded rig can miss a real refresh (its slice is in the trace), so the control is held
      // to §10.2's ≥ 99% rule, and every long frame it registers is printed above. The injections below must each
      // register a long frame or stall *covering* the injected window, which a stray long frame can't satisfy.
      expect(r.analysis.longShare).toBeLessThanOrEqual(0.01)
      expect(r.analysis.cadence).toBe('pass')
      expect(r.analysis.responsiveness).toBe('pass')
    })

    test('control: discrete keypresses with no injection pass responsiveness, and cadence is not applicable', async () => {
      const r = await traced(l, (page) => keypresses(page))
      keep('keys', r)
      valid(r)
      expect(r.analysis.firstFrame.n).toBeGreaterThanOrEqual(21) // every key is answered: input to the present showing its row
      expect(r.analysis.stalls).toEqual([])
      expect(r.analysis.neverPainted).toEqual([])
      expect(r.analysis.responsiveness).toBe('pass')
      expect(r.analysis.cadence).toBe('n/a') // Z62: each key is answered by one frame, so the frame gate doesn't apply
    })

    test('a 30 ms busy-wait during a scroll registers a long frame covering it, and no stall', async () => {
      const r = await traced(l, async (page, cdp) => {
        await busyOn(page, 'wheel', 20, 30)
        await scroll(cdp)
      })
      keep('busy30', r)
      valid(r)
      expect(r.busy).toHaveLength(1)
      expect(r.analysis.long.some((s) => covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
      expect(r.analysis.stalls).toEqual([])
    })

    test('a 60 ms busy-wait in the handler of one discrete keypress is detected as a stall covering it', async () => {
      const r = await traced(l, async (page) => {
        await busyOn(page, 'keydown', 10, 60)
        await keypresses(page)
      })
      keep('keys-busy60', r)
      valid(r)
      expect(r.busy).toHaveLength(1)
      expect(r.analysis.stalls.some((s) => covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
      expect(r.analysis.responsiveness).toBe('fail')
    })

    test('a 60 ms busy-wait during a scroll is detected as a stall covering it', async () => {
      const r = await traced(l, async (page, cdp) => {
        await busyOn(page, 'wheel', 20, 60)
        await scroll(cdp)
      })
      keep('busy60', r)
      valid(r)
      expect(r.busy).toHaveLength(1)
      expect(r.analysis.stalls.some((s) => covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
    })

    test('a 60 ms busy-wait in the first frame after a scrollbar jump is detected as a stall covering it', async () => {
      const r = await traced(l, async (page) => {
        // The first scroll event of the drag arms one animation frame that blocks.
        await page.evaluate(() => {
          const scroller = document.querySelector('.vl-scroller')!
          scroller.addEventListener('scroll', () => requestAnimationFrame(() => (window as unknown as Busy).typoseBusy(60)), { once: true })
        })
        await jump(page)
      })
      keep('jump60', r)
      valid(r)
      expect(r.busy).toHaveLength(1)
      expect(r.analysis.stalls.some((s) => covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
    })

    test('a jump whose target rows never render fails as never painted', async () => {
      const r = await traced(l, async (page) => {
        // Suppress the target: page requests never reach the core, so the rows past the jump never get their text.
        await page.evaluate(() => {
          const post = MessagePort.prototype.postMessage
          MessagePort.prototype.postMessage = function (this: MessagePort, message: unknown, ...rest: never[]) {
            if ((message as { method?: string })?.method === 'page') return
            return post.call(this, message, ...rest)
          } as typeof post
        })
        await jump(page)
        await page.waitForTimeout(1500)
      })
      keep('suppressed', r)
      valid(r)
      expect(r.analysis.neverPainted.length).toBeGreaterThanOrEqual(1)
      expect(r.analysis.responsiveness).toBe('fail')
    })
  })
}
