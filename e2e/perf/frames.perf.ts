// Plan C8's frame instrument and its controls, on the packaged build over CDP, with accessibility on and off (Z62:
// cadence and responsiveness are judged apart): a 30 ms busy-wait during a scroll is a long frame covering it and no
// cadence stall; 60 ms is a stall covering it, during a scroll, in the handler of one discrete keypress, and in the first frame
// after a scrollbar jump; a control scroll has no stall and passes cadence; control keypresses pass responsiveness and
// report cadence as not applicable; an uninjected jump is n/a or pass; and a jump whose target never renders fails.
// Then, once: expanding a long line and a freeze are each answered by the view they show.
//   Run: npm run package, then `npm run perf -- -g accessibility`, and the keypress control 10 times over with
//   `npm run perf -- -g "keypresses with no injection" --repeat-each=10`. Every run is appended to .evidence/m1/perf/.
import { type Page, expect } from '@playwright/test'
import { closeSync, openSync, writeSync } from 'node:fs'
import { fixture, test, waitIndexed, waitOpen } from '../app'
import { type PackagedLaunch, closePackaged, launchPackaged, waitMarks } from '../packaged'
import { type Run, type Span, jump, keypresses, scroll, traced } from './drive'
import { recordOutcome } from './rig'

// 1M lines × 20 px is past the 16M px native cap, so Raw scrolls logically: every wheel goes through the main thread.
const LINES = 1_000_000
let file: string
test.beforeAll(() => {
  file = fixture('frames.txt', Array.from({ length: LINES }, (_, i) => `${i} ${'frame '.repeat(i % 12)}`).join('\n'))
})

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

for (const a11y of ['on', 'off'] as const) {
  test.describe(`accessibility ${a11y}`, () => {
    let l: PackagedLaunch
    let hz: number
    let run: { name: string; r: Run; extra?: Record<string, unknown> } | null = null
    /**
     * The span covers the injection: it runs past the injection's end, and the work behind it began before the
     * injection did. A frame already in the pipeline when the main thread blocks still presents during the block (seen
     * 3–12 ms in), and nothing begun after the block starts can present until it ends.
     */
    const covers = (span: Span & { began: number }, busy: Span) => span.to >= busy.to && span.began <= busy.from
    const valid = (r: Run) => expect(r.analysis.valid, `invalid run: ${r.analysis.reason}`).toBe(true)
    const keep = (name: string, r: Run, extra?: Record<string, unknown>) => {
      run = { name, r, extra }
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
        recordOutcome(test.info(), `frames:${run.name}:a11y-${a11y}`, { ...a, hz, inputToPaintMaxMs: Math.max(0, ...(inputToPaint ?? []).map((p) => p.ms)), busy: run.r.busy, load: run.r.load, closeError: closed?.message, ...run.extra })
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

    test('a 30 ms busy-wait during a scroll registers a long frame covering it, and no cadence stall', async () => {
      const r = await traced(l, async (page, cdp) => {
        await busyOn(page, 'wheel', 20, 30)
        await scroll(cdp)
      })
      keep('busy30', r)
      valid(r)
      expect(r.busy).toHaveLength(1)
      expect(r.analysis.long.some((s) => covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
      // The block also adds onto one input's answer (about 42 ms here), so responsiveness is recorded as measured, not
      // asserted: on a 60 Hz panel the same answer is a refresh or two later and would cross 50 ms with the instrument right.
      expect(r.analysis.stalls.filter((s) => !s.first)).toEqual([])
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
      // A cadence stall: the assertion the 30 ms control makes fails once the injection is 60 ms.
      expect(r.analysis.stalls.some((s) => !s.first && covers(s, r.busy[0])), JSON.stringify(r)).toBe(true)
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

    test('control: an uninjected scrollbar jump reports cadence n/a or pass, in 10 of 10 runs', async () => {
      // The coordinator's Z62 clarification (PR 9): a frame already in the pipeline at the pointerdown isn't judged on
      // cadence against the jump's answer. Ten jumps from the top, each traced on its own.
      const runs: { cadence: string; frames: number; long: number[]; answers: number[] }[] = []
      let last: Run | undefined
      for (let n = 0; n < 10; n++) {
        await l.page!.keyboard.press('Control+Home')
        await l.page!.waitForTimeout(300)
        last = await traced(l, (page) => jump(page), `trace-jump-${n}`)
        valid(last)
        runs.push({ cadence: last.analysis.cadence, frames: last.analysis.frames, long: last.analysis.long.map((s) => s.ms), answers: last.analysis.inputToPaint.map((p) => p.ms) })
      }
      keep('jump-control', last!, { runs })
      expect(runs.map((r) => r.cadence).filter((c) => c !== 'n/a' && c !== 'pass'), JSON.stringify(runs)).toEqual([])
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

// The paint probe on PR 4's views (plan C8): expanding a long line and a freeze each change what Raw shows, so the
// input behind each is answered by the present that shows it, never judged a no-change or left unpainted.
test.describe('the paint probe on long lines and the freeze', () => {
  let l: PackagedLaunch | undefined
  let run: { name: string; r: Run } | null = null
  const answered = (r: Run, kind: string) => r.analysis.inputToPaint.filter((p) => p.kind === kind)
  test.beforeEach(() => void (run = null))
  test.afterEach(async () => {
    const closed = l ? await closePackaged(l).then(() => undefined, (e: Error) => e) : undefined
    l = undefined
    if (run) {
      const { inputToPaint, ...a } = run.r.analysis
      recordOutcome(test.info(), `frames:probe-${run.name}`, { ...a, inputToPaint, busy: run.r.busy, load: run.r.load, closeError: closed?.message })
    }
    if (closed) throw closed
  })

  test('expanding a long line is an input, answered when its further pieces show', async () => {
    // One 300,000-byte line: five 64 KiB pieces, so its first row ends in "↪ more".
    l = await launchPackaged({ cdp: true, file: fixture('probe-long-line.txt', `${'x'.repeat(300_000)}\nend\n`) })
    const page = l.page!
    await waitOpen(page)
    await waitIndexed(page)
    const r = await traced(l, async (p) => {
      // A key that moves nothing first, so the expansion is judged against a painted view, not the trace's first mark.
      await p.locator('.vl-scroller').focus()
      await p.keyboard.press('ArrowUp')
      await p.waitForTimeout(200)
      await p.getByRole('button', { name: 'Show more of line 1' }).click()
      await expect(p.locator('.vl-row[data-line="0"]')).toHaveCount(5)
    })
    run = { name: 'expand', r }
    console.log('probe expand', JSON.stringify({ valid: r.analysis.valid, unanswered: r.analysis.unanswered, never: r.analysis.neverPainted, answered: r.analysis.inputToPaint }))
    expect(r.analysis.valid, r.analysis.reason).toBe(true)
    expect(answered(r, 'click'), JSON.stringify(r.analysis.inputToPaint)).toHaveLength(1)
    expect(r.analysis.neverPainted).toEqual([])
  })

  test('a freeze is answered by its banner, not left unpainted', async () => {
    // states.e2e.ts's freeze: 60,000 lines of 64 bytes, and a same-size write near the end, where nothing was read.
    const line = (n: number) => `line ${n}`.padEnd(63, '.')
    const file = fixture('probe-freeze.txt', Array.from({ length: 60_000 }, (_, n) => `${line(n)}\n`).join(''))
    l = await launchPackaged({ cdp: true, file })
    const page = l.page!
    await waitOpen(page)
    await waitIndexed(page)
    const fd = openSync(file, 'r+')
    writeSync(fd, 'CHANGED'.padEnd(63, '!'), 59_990 * 64)
    closeSync(fd)
    await page.locator('.vl-scroller').focus()
    const r = await traced(l, async (p) => {
      await p.keyboard.press('Control+End')
      await expect(p.locator('.banner')).toBeVisible()
    })
    run = { name: 'freeze', r }
    console.log('probe freeze', JSON.stringify({ valid: r.analysis.valid, unanswered: r.analysis.unanswered, never: r.analysis.neverPainted, answered: r.analysis.inputToPaint }))
    expect(r.analysis.valid, r.analysis.reason).toBe(true)
    expect(r.analysis.neverPainted, JSON.stringify(r.analysis.inputToPaint)).toEqual([])
    expect(answered(r, 'keydown')).toHaveLength(1)
  })
})
