// Plan C8's frame instrument: reads a Chromium trace (JSON) taken while the app was driven, and judges presented
// frames within demanded intervals. Pinned to Electron 44.9.2, where these events were checked:
// - PipelineReporter (cc; category disabled-by-default-devtools.timeline.frame), in the renderer process: one async
//   slice per frame, from its BeginFrame to its presentation, with `frame_reporter.state` on the begin event. A frame
//   counts as presented at its slice's end when its state is STATE_PRESENTED_ALL. STATE_PRESENTED_PARTIAL frames are
//   compositor-only updates (a scrollbar thumb moving) shown while the main thread's update was still pending: they
//   show stale rows, so they don't end a gap. These ends coincide with viz's Display::FrameDisplayed.
// - TimeStamp (devtools.timeline): the renderer's console.timeStamp() marks from app/renderer/perf.ts:
//   `typose:input <seq> <kind> <inputMs> <dispatchMs>` and `typose:painted <seq> <key>`, both in performance.now() ms.
// - FireAnimationFrame (devtools.timeline): rAF callbacks, printed beside the judged figures and never judged.
export const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame']

const LONG_MS = 16.7 // §10.2's frame threshold, absolute (ruling OQ-6)
const STALL_MS = 50
const NEVER_MS = 1000

/** The renderer's fully presented frames (trace µs): when each began, and when it was presented. */
export function presentedFrames(events) {
  const renderers = new Set(events.filter((e) => e.ph === 'M' && e.name === 'process_name' && e.args?.name === 'Renderer').map((e) => e.pid))
  const reporters = events.filter((e) => e.name === 'PipelineReporter' && renderers.has(e.pid)).sort((a, b) => a.ts - b.ts)
  const pids = new Set(reporters.map((e) => e.pid))
  if (pids.size !== 1) throw new Error(`expected one renderer reporting frames, found ${pids.size}`)
  const open = new Map()
  const frames = []
  for (const e of reporters) {
    const key = e.id2?.local ?? e.id
    if (e.ph === 'b') open.set(key, { state: e.args?.frame_reporter?.state, began: e.ts })
    else if (e.ph === 'e' && open.has(key)) {
      const { state, began } = open.get(key)
      if (state === 'STATE_PRESENTED_ALL') frames.push({ at: e.ts, began })
      open.delete(key)
    }
  }
  return frames.sort((a, b) => a.at - b.at)
}

/**
 * A frame is demanded from an input until the view settles: the first presented frame after the renderer marked the
 * input's target rows painted (or the mark itself, when nothing on screen changed). Demanded intervals that overlap
 * are merged, so a continuous gesture is one interval. Inside a merged interval, every presented frame after the
 * first is judged on its interval from the frame before it: long at ≥ 16.7 ms, a stall over 50 ms. The first frame
 * of a merged interval is judged from the input's own timestamp, as a stall only: that span includes the input
 * pipeline (OS to browser to the rAF-aligned dispatch, then at least one refresh), so it isn't a frame interval. An
 * input whose target isn't painted within 1 s fails as never painted. Each long frame and stall also says when the
 * work behind its opening frame began (`began`): a frame begun before a block can still present during it.
 */
export function analyzeFrames(events) {
  const ms = (us) => Math.round(us) / 1000
  const presented = presentedFrames(events)
  const frames = presented.map((f) => f.at)
  const began = new Map(presented.map((f) => [f.at, f.began]))

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
    if (inside[0] - a > STALL_MS * 1000) stalls.push({ from: ms(a), to: ms(inside[0]), ms: ms(inside[0] - a), began: ms(a), first: true })
    for (let k = 1; k < inside.length; k++) {
      const gap = inside[k] - inside[k - 1]
      const span = { from: ms(inside[k - 1]), to: ms(inside[k]), ms: ms(gap), began: ms(began.get(inside[k - 1])) }
      judged++
      if (gap >= LONG_MS * 1000) long.push(span)
      if (gap > STALL_MS * 1000) stalls.push({ ...span, first: false })
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
