// Plan C8's renderer marks. Startup marks go to main, which records them only under its TYPOSE_MARKS hook. Frame
// marks are console.timeStamp() calls, which reach a Chromium trace (devtools.timeline) and are otherwise inert:
// e2e/perf/frames.mjs reads them.
import type { StartupMark } from '../shared/protocol'

/** Wall-clock ms on the same clock as main's Date.now(). */
const wall = (): number => Math.round(performance.timeOrigin + performance.now())

export const markNow = (name: StartupMark): void => window.typose.mark(name, wall())

/** The renderer's share of startup: navigation start, then the bundle evaluated up to React's mount. */
export function markBundleEvaluated(): void {
  window.typose.mark('navigationStart', Math.round(performance.timeOrigin))
  markNow('bundleEvaluated')
}

/** Marks `name` at Element Timing's renderTime for the element marked `elementtiming=<id>`, then calls `done`. */
function markRender(id: string, name: StartupMark, done = () => {}): void {
  const observer = new PerformanceObserver((list) => {
    const entry = list.getEntries().find((e) => (e as PerformanceEntry & { identifier?: string }).identifier === id)
    if (!entry) return
    observer.disconnect()
    window.typose.mark(name, Math.round(performance.timeOrigin + (entry as PerformanceEntry & { renderTime: number }).renderTime))
    done()
  })
  observer.observe({ type: 'element', buffered: true })
}

/**
 * Startup's presentation marks (plan C8). `titlebarPresented` is when the frame that first showed the title bar was
 * presented. That's on screen only if it came after the window's `show`; when it came first (a frame presented to the
 * hidden window), `shownPresented` is the first presentation after the show. Main reports the show only under its
 * TYPOSE_MARKS hook, and only then does a probe go in: one character in the background colour, outside React's root,
 * removed once its own presentation is known.
 */
export function markPresentations(): void {
  markRender('titlebar', 'titlebarPresented')
  window.typose.onShown(() => {
    const probe = Object.assign(document.createElement('span'), { textContent: '·' })
    probe.setAttribute('elementtiming', 'shown')
    probe.setAttribute('aria-hidden', 'true')
    Object.assign(probe.style, { position: 'fixed', left: '0', top: '0', color: 'var(--canvas)', pointerEvents: 'none' })
    document.body.append(probe)
    markRender('shown', 'shownPresented', () => probe.remove())
  })
}

/** Marks `name` once the frame holding the DOM as it is now has been produced: the next rAF, then a task. */
export function markPainted(name: StartupMark): void {
  requestAnimationFrame(() => setTimeout(() => markNow(name)))
}

let seq = 0
let deadline = 0
let probe: (() => string | null) | null = null

/** What the view shows once its target rows are all painted (a key that changes when they do), else null. */
export function setPaintProbe(p: (() => string | null) | null): void {
  probe = p
}

// The trace's baseline (PR 9): a test driver that has just started a trace dispatches `typose:baseline` on the window,
// and the view as it stands is marked painted as sequence 0. The analyzer then judges the trace's first input against
// it, so a first input that changes nothing is told apart. Inert otherwise: console.timeStamp only reaches a trace.
window.addEventListener('typose:baseline', () => {
  const key = probe?.() ?? null
  if (key !== null) console.timeStamp(`typose:painted 0 ${key}`)
})

/**
 * An input that demands frames, at its own timestamp (performance.now() ms). Each animation frame after it checks
 * the probe, and the first that finds the target painted marks it; after 2 s it stops looking (never painted).
 */
export function inputMark(kind: string, at: number): void {
  console.timeStamp(`typose:input ${++seq} ${kind} ${at} ${performance.now()}`)
  const idle = deadline === 0
  deadline = performance.now() + 2000
  if (idle) requestAnimationFrame(check)
}

function check(now: number): void {
  const key = probe?.() ?? null
  if (key !== null) {
    deadline = 0
    console.timeStamp(`typose:painted ${seq} ${key}`)
  } else if (now < deadline) {
    requestAnimationFrame(check)
  } else {
    deadline = 0
  }
}
