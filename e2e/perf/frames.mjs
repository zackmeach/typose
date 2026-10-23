// Plan C8's frame instrument: reads a Chromium trace (JSON) taken while the app was driven, and judges presented
// frames within demanded intervals. Pinned to Electron 44.9.2 (Chromium 146), where these events were checked:
// - Display::FrameDisplayed (viz; category disabled-by-default-display.framedisplayed): one per frame the window
//   put on screen, at its presentation time. The first one of a window can be the browser's own frame (background,
//   caption buttons); during a scroll every frame is the window's.
// - TimeStamp (devtools.timeline): the renderer's console.timeStamp() marks from app/renderer/perf.ts:
//   `typose:input <seq> <kind> <inputMs> <dispatchMs>` and `typose:painted <seq> <key>`, both in performance.now() ms.
// - FireAnimationFrame (devtools.timeline): rAF callbacks, printed beside the judged figures and never judged.
export const CATEGORIES = ['devtools.timeline', 'disabled-by-default-display.framedisplayed']
export const PRESENTED = 'Display::FrameDisplayed'

const LONG_MS = 16.7 // §10.2's frame threshold, absolute (ruling OQ-6)
const STALL_MS = 50
const NEVER_MS = 1000

/**
 * A frame is demanded from an input until the view settles: the first presented frame after the renderer marked the
 * input's target rows painted (or the mark itself, when nothing on screen changed). Within merged demanded intervals,
 * each presented frame's interval from the one before it is judged: long at ≥ 16.7 ms, a stall over 50 ms. The first
 * frame after an interval starts is judged as a stall only: from the input's own timestamp it includes the input
 * pipeline, which isn't a frame interval. An input whose target isn't painted within 1 s fails as never painted.
 */
export function analyzeFrames(events) {
  const ms = (us) => Math.round(us) / 1000
  const displayed = events.filter((e) => e.name === PRESENTED)
  const threads = new Set(displayed.map((e) => `${e.pid}:${e.tid}`))
  if (threads.size !== 1) throw new Error(`expected one display compositor emitting ${PRESENTED}, found ${threads.size}`)
  const frames = displayed.map((e) => e.ts).sort((a, b) => a - b)

  const inputs = []
  const painted = []
  for (const e of events) {
    const message = e.name === 'TimeStamp' ? e.args?.data?.message : undefined
    if (typeof message !== 'string' || !message.startsWith('typose:')) continue
    const [what, seq, a, b, c] = message.split(' ')
    if (what === 'typose:input') {
      // The mark's own ts is the dispatch; the input's timestamp maps onto the trace clock through it.
      inputs.push({ seq: Number(seq), kind: a, at: e.ts - (Number(c) - Number(b)) * 1000, dispatch: e.ts })
    } else if (what === 'typose:painted') {
      painted.push({ seq: Number(seq), key: a, ts: e.ts })
    }
  }
  inputs.sort((x, y) => x.seq - y.seq)
  painted.sort((x, y) => x.ts - y.ts)

  const neverPainted = []
  const inputToPaint = []
  const demanded = []
  for (const input of inputs) {
    const i = painted.findIndex((p) => p.seq >= input.seq && p.ts >= input.dispatch)
    const mark = painted[i]
    const unchanged = mark && i > 0 && painted[i - 1].key === mark.key
    const settle = !mark ? undefined : unchanged ? mark.ts : frames.find((f) => f > mark.ts)
    if (settle === undefined || settle - input.at > NEVER_MS * 1000) {
      neverPainted.push({ seq: input.seq, kind: input.kind, at: ms(input.at) })
      continue
    }
    inputToPaint.push({ seq: input.seq, kind: input.kind, ms: ms(settle - input.at) })
    demanded.push([input.at, settle])
  }

  // Merge overlapping demanded intervals.
  demanded.sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [a, s] of demanded) {
    const last = merged.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], s)
    else merged.push([a, s])
  }

  let judged = 0
  const long = []
  const stalls = []
  let demandedUs = 0
  for (const [a, s] of merged) {
    demandedUs += s - a
    const inside = frames.filter((f) => f > a && f <= s)
    if (inside.length === 0) continue
    if (inside[0] - a > STALL_MS * 1000) stalls.push({ from: ms(a), to: ms(inside[0]), ms: ms(inside[0] - a), first: true })
    for (let k = 1; k < inside.length; k++) {
      const gap = inside[k] - inside[k - 1]
      judged++
      if (gap >= LONG_MS * 1000) long.push({ from: ms(inside[k - 1]), to: ms(inside[k]), ms: ms(gap) })
      if (gap > STALL_MS * 1000) stalls.push({ from: ms(inside[k - 1]), to: ms(inside[k]), ms: ms(gap), first: false })
    }
  }

  // rAF intervals on the renderer main thread within the same intervals: printed, never judged.
  const raf = events.filter((e) => e.name === 'FireAnimationFrame').map((e) => e.ts).sort((x, y) => x - y)
  let rafMax = 0
  for (const [a, s] of merged) {
    const inside = raf.filter((t) => t > a && t <= s)
    for (let k = 1; k < inside.length; k++) rafMax = Math.max(rafMax, inside[k] - inside[k - 1])
  }

  return {
    inputs: inputs.length,
    demandedMs: ms(demandedUs),
    frames: judged,
    longFrames: long.length,
    longShare: judged ? long.length / judged : 0,
    long,
    stalls,
    neverPainted,
    inputToPaint,
    raf: { maxGapMs: ms(rafMax) },
    pass: neverPainted.length === 0 && stalls.length === 0 && (judged === 0 || long.length / judged <= 0.01)
  }
}
