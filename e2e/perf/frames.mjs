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
 * input's target rows painted. Demanded intervals that overlap are merged, so a continuous gesture is one interval.
 * Every presented frame inside a demanded interval is judged (long at ≥ 16.7 ms):
 * - a frame after another presented frame of the same interval, on the gap from that frame;
 * - the frame that opens an interval, on its own production time: from its PipelineReporter slice's start to its
 *   presentation, except that a slice starting more than one refresh after the input counts from input + one refresh.
 *   The one refresh is the wait for the next BeginFrame, which no app can avoid; anything later (a handler that blocks
 *   before the frame starts) is counted.
 * A stall is a gap over 50 ms, or an input whose first presented frame comes over 50 ms after the input's timestamp.
 * An input whose target isn't painted within 1 s fails as never painted. An input that changes nothing on screen
 * (its painted mark repeats the previous one) owes no frame: it's counted, and is a stall if its mark is over 50 ms late.
 * Each long frame and stall says when the work behind it began (`began`): a frame begun before a block can still
 * present during it. A trace that can't be judged (no renderer frames, no inputs, nothing judged, a demanded interval
 * with no presented frame) is `valid: false`, and never passes.
 */
export function analyzeFrames(events, { hz } = {}) {
  if (!(hz > 0)) throw new Error('analyzeFrames needs the panel refresh rate: { hz }')
  const refresh = 1e6 / hz // µs
  const ms = (us) => Math.round(us) / 1000
  const none = { inputs: 0, unchanged: 0, demandedMs: 0, frames: 0, longFrames: 0, longShare: 0, long: [], stalls: [], neverPainted: [], inputToPaint: [], raf: { maxGapMs: 0 } }
  const invalid = (reason) => ({ ...none, valid: false, reason, pass: false })
  let presented
  try {
    presented = presentedFrames(events)
  } catch (e) {
    return invalid(e.message)
  }
  const frames = presented.map((f) => f.at)

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
  if (inputs.length === 0) return invalid('no input marks: nothing was demanded')

  const neverPainted = []
  const inputToPaint = []
  const demanded = []
  const stalls = []
  let unchanged = 0
  for (const input of inputs) {
    const i = painted.findIndex((p) => p.seq >= input.seq && p.ts >= input.dispatch)
    const mark = painted[i]
    if (mark && i > 0 && painted[i - 1].key === mark.key) {
      unchanged++
      const late = mark.ts - input.at
      if (late > STALL_MS * 1000) stalls.push({ from: ms(input.at), to: ms(mark.ts), ms: ms(late), began: ms(input.at), first: true })
      continue
    }
    const settle = mark && frames.find((f) => f > mark.ts)
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
  let demandedUs = 0
  for (const [a, s] of merged) {
    demandedUs += s - a
    const inside = presented.filter((f) => f.at > a && f.at <= s)
    if (inside.length === 0) return invalid(`the demanded interval ${ms(a)}..${ms(s)} ms has no presented frame`)
    // The opening frame: its own production time, with at most one refresh of waiting for its BeginFrame excused.
    const first = inside[0]
    const from = Math.min(first.began, a + refresh)
    judged++
    if (first.at - from >= LONG_MS * 1000)
      long.push({ from: ms(from), to: ms(first.at), ms: ms(first.at - from), began: ms(Math.min(first.began, a)), opening: true })
    if (first.at - a > STALL_MS * 1000) stalls.push({ from: ms(a), to: ms(first.at), ms: ms(first.at - a), began: ms(a), first: true })
    for (let k = 1; k < inside.length; k++) {
      const gap = inside[k].at - inside[k - 1].at
      const span = { from: ms(inside[k - 1].at), to: ms(inside[k].at), ms: ms(gap), began: ms(inside[k - 1].began) }
      judged++
      if (gap >= LONG_MS * 1000) long.push(span)
      if (gap > STALL_MS * 1000) stalls.push({ ...span, first: false })
    }
  }
  if (judged === 0 && neverPainted.length === 0) return invalid('no presented frame was judged')

  // rAF intervals on the renderer main thread within the same intervals: printed, never judged.
  const raf = events.filter((e) => e.name === 'FireAnimationFrame').map((e) => e.ts).sort((x, y) => x - y)
  let rafMax = 0
  for (const [a, s] of merged) {
    const inside = raf.filter((t) => t > a && t <= s)
    for (let k = 1; k < inside.length; k++) rafMax = Math.max(rafMax, inside[k] - inside[k - 1])
  }

  return {
    valid: true,
    reason: undefined,
    inputs: inputs.length,
    unchanged,
    demandedMs: ms(demandedUs),
    frames: judged,
    longFrames: long.length,
    longShare: judged ? long.length / judged : 0,
    long,
    stalls,
    neverPainted,
    inputToPaint,
    raf: { maxGapMs: ms(rafMax) },
    pass: neverPainted.length === 0 && stalls.length === 0 && judged > 0 && long.length / judged <= 0.01
  }
}
