// Plan C8's frame instrument and its controls, on the packaged build over CDP, with accessibility on and off: a
// 30 ms busy-wait during a scroll is long frames and no stall, 60 ms is a stall (during a scroll, and in the first
// frame after a scrollbar jump), a control run is neither, and a jump whose target never renders fails.
import { type CDPSession, type Page, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { fixture, test, waitIndexed, waitOpen } from '../app'
import { type PackagedLaunch, closePackaged, launchPackaged, waitMarks } from '../packaged'
import { CATEGORIES, analyzeFrames } from './frames.mjs'
import { cpuLoad, cpuTimes, record } from './rig'

type Analysis = ReturnType<typeof analyzeFrames>
type Span = { from: number; to: number }

// 1M lines × 20 px is past the 16M px native cap, so Raw scrolls logically: every wheel goes through the main thread.
const LINES = 1_000_000
let file: string
test.beforeAll(() => {
  file = fixture('frames.txt', Array.from({ length: LINES }, (_, i) => `${i} ${'frame '.repeat(i % 12)}`).join('\n'))
})

/** Traces `drive` (Chromium tracing over CDP, C8's pinned categories) and analyzes it; also returns the busy spans. */
async function traced(l: PackagedLaunch, drive: (page: Page, cdp: CDPSession) => Promise<void>) {
  const page = l.page!
  const cdp = await page.context().newCDPSession(page)
  const from = cpuTimes()
  await l.browser!.startTracing(page, { categories: [...CATEGORIES, ...(process.env.TRACE_EXTRA?.split(',') ?? [])] })
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

/** Arms a busy-wait in the handler of the `nth` wheel event from now. */
const busyOnWheel = (page: Page, nth: number, ms: number) =>
  page.evaluate(
    ([nth, ms]) => {
      let n = 0
      const onWheel = () => {
        if (++n < nth) return
        window.removeEventListener('wheel', onWheel, true)
        ;(window as unknown as Busy).typoseBusy(ms)
      }
      window.addEventListener('wheel', onWheel, true)
    },
    [nth, ms] as const
  )

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

const covers = (stall: Span, busy: Span) => stall.from <= busy.from && stall.to >= busy.to

for (const a11y of ['on', 'off'] as const) {
  test.describe(`accessibility ${a11y}`, () => {
    let l: PackagedLaunch
    test.beforeEach(async () => {
      l = await launchPackaged({ cdp: true, file, args: [a11y === 'on' ? '--force-renderer-accessibility' : '--disable-renderer-accessibility'] })
      await waitOpen(l.page!)
      await waitIndexed(l.page!)
      await l.page!.locator('.vl-scroller').focus()
      await installBusy(l.page!)
    })
    test.afterEach(async () => {
      const hz = (await waitMarks(l, ['show'])).show.hz
      await closePackaged(l)
      test.info().annotations.push({ type: 'hz', description: String(hz) })
    })
    const keep = (name: string, r: { analysis: Analysis; busy: Span[]; load: number }) => {
      const { inputToPaint, ...a } = r.analysis
      record(`frames:${name}:a11y-${a11y}`, { ...a, inputToPaintMaxMs: Math.max(0, ...inputToPaint.map((p) => p.ms)), busy: r.busy, load: r.load })
      console.log(name, `a11y ${a11y}`, JSON.stringify({ frames: a.frames, long: a.long, stalls: a.stalls, never: a.neverPainted.length, busy: r.busy, raf: a.raf, load: r.load }))
    }

    test('control: a scroll with no injection has no long frame and no stall', async () => {
      const r = await traced(l, (_page, cdp) => scroll(cdp))
      keep('control', r)
      expect(r.analysis.frames).toBeGreaterThan(50)
      expect(r.analysis.longFrames).toBe(0)
      expect(r.analysis.stalls).toEqual([])
      expect(r.analysis.neverPainted).toEqual([])
    })

    test('a 30 ms busy-wait during a scroll registers as long frames and no stall', async () => {
      const r = await traced(l, async (page, cdp) => {
        await busyOnWheel(page, 20, 30)
        await scroll(cdp)
      })
      keep('busy30', r)
      expect(r.busy).toHaveLength(1)
      expect(r.analysis.long.some((s) => covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
      expect(r.analysis.stalls).toEqual([])
    })

    test('a 60 ms busy-wait during a scroll is detected as a stall covering it', async () => {
      const r = await traced(l, async (page, cdp) => {
        await busyOnWheel(page, 20, 60)
        await scroll(cdp)
      })
      keep('busy60', r)
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
      expect(r.analysis.neverPainted.length).toBeGreaterThanOrEqual(1)
      expect(r.analysis.pass).toBe(false)
    })
  })
}
