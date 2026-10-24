// Plan C8's frame instrument: reads a Chromium trace (JSON) taken while the app was driven, and judges presented
// frames within demanded intervals. Pinned to Electron 44.9.2, where these events were checked:
// - PipelineReporter (cc; category disabled-by-default-devtools.timeline.frame), in the renderer process: one async
//   slice per frame, from its BeginFrame to its presentation, with `frame_reporter.state` on the begin event. A frame
//   counts as presented at its slice's end when its state is STATE_PRESENTED_ALL. STATE_PRESENTED_PARTIAL frames are
//   compositor-only updates (a scrollbar thumb moving) shown while the main thread's update was still pending: they
//   show stale rows, so they don't end a gap. These ends coincide with viz's Display::FrameDisplayed. Two
//   STATE_PRESENTED_ALL slices, for different frame_sequences, can end at the same ts; the earlier sequence often also
//   has a FORKED slice. Why Chromium reports one present twice is unverified. One present is one frame, begun when its
//   earliest slice began; `lastBegan` is when its latest slice began, for demanded-interval membership (below).
// - TimeStamp (devtools.timeline): the renderer's console.timeStamp() marks from app/renderer/perf.ts:
//   `typose:input <seq> <kind> <inputMs> <dispatchMs>` and `typose:painted <seq> <key>`, both in performance.now() ms.
// - FireAnimationFrame (devtools.timeline): rAF callbacks, printed beside the judged figures and never judged.
export const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame']

const LONG_MS = 16.7 // §10.2's frame threshold, absolute (ruling OQ-6)
const STALL_MS = 50
const NEVER_MS = 1000

/** The renderer's fully presented frames (trace µs), one per present: when it was presented, and its earliest and latest
 *  begins. */
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
      if (state === 'STATE_PRESENTED_ALL') frames.push({ at: e.ts, began, lastBegan: began })
      open.delete(key)
    }
  }
  frames.sort((a, b) => a.at - b.at)
  const presents = []
  for (const f of frames) {
    const last = presents.at(-1)
    if (last && last.at === f.at) {
      last.began = Math.min(last.began, f.began)
      last.lastBegan = Math.max(last.lastBegan, f.lastBegan)
    } else presents.push(f)
  }
  return presents
}

/** Nearest-rank percentile of `values` (ms), or undefined when there are none. */
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] : undefined
}

/**
 * Z62: the 16.7 ms / ≥ 99% frame gate judges cadence, and the first frame after an input is judged by responsiveness.
 * - A frame is demanded from an input until the view settles: the first presented frame after the renderer marked the
 *   input's target rows painted. Demanded intervals that overlap merge, so a continuous gesture is one interval.
 * - Cadence: a present belongs to a merged interval only if it began at or after the interval's first input (the
 *   coordinator's Z62 clarification, PR 9): a frame already in the pipeline can't contain the input. A present reported
 *   by two slices belongs if either began then (`lastBegan`). Every such present after the first is judged on its gap
 *   from the one before it: long at ≥ 16.7 ms, a stall over 50 ms. A run where no interval has a second such present
 *   (discrete keypresses, each answered by one frame) reports cadence as 'n/a', never as passed.
 * - Responsiveness: each input that changes the view is answered by the first present after its target rows painted,
 *   and judged on input → that present, a stall over 50 ms (plan §5's input latency, `inputToPaint`). The distribution
 *   of these answered inputs is reported (`firstFrame`). The next present after an input isn't its answer: while frames
 *   flow, it comes within a refresh whatever it shows. An input whose target isn't painted within 1 s fails as never
 *   painted. An input that changes nothing on screen (its painted mark repeats the previous one) owes no frame: it's
 *   timed to its mark and reported apart (`unanswered`), and is a stall if the mark is over 50 ms late.
 * - Each long frame and stall says when the work behind it began (`began`): a frame begun before a block can still
 *   present during it.
 * - A trace that can't be judged (no renderer frames, more than one renderer, no inputs, nothing demanded, a demanded
 *   interval with no presented frame) is `valid: false`, and judges nothing.
 */
export function analyzeFrames(events) {
  const ms = (us) => Math.round(us) / 1000
  const none = { inputs: 0, unanswered: { n: 0 }, demandedMs: 0, frames: 0, longFrames: 0, longShare: 0, long: [], stalls: [], neverPainted: [], inputToPaint: [], firstFrame: { n: 0 }, raf: { maxGapMs: 0 } }
  const invalid = (reason) => ({ ...none, valid: false, reason, cadence: 'invalid', responsiveness: 'invalid' })
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
  const unanswered = []
  const demanded = []
  const stalls = []
  for (const input of inputs) {
    const i = painted.findIndex((p) => p.seq >= input.seq && p.ts >= input.dispatch)
    const mark = painted[i]
    if (mark && i > 0 && painted[i - 1].key === mark.key) {
      // Changes nothing, so no frame answers it: timed to its mark, and kept out of the latency figure.
      const late = mark.ts - input.at
      unanswered.push(ms(late))
      if (late > STALL_MS * 1000) stalls.push({ from: ms(input.at), to: ms(mark.ts), ms: ms(late), began: ms(input.at), first: true })
      continue
    }
    const settle = mark && frames.find((f) => f > mark.ts)
    if (settle === undefined || settle - input.at > NEVER_MS * 1000) {
      neverPainted.push({ seq: input.seq, kind: input.kind, at: ms(input.at) })
      continue
    }
    // Responsiveness: the input is answered by the first present after its target painted (plan §5's input latency).
    const latency = settle - input.at
    inputToPaint.push({ seq: input.seq, kind: input.kind, ms: ms(latency) })
    demanded.push([input.at, settle])
    if (latency > STALL_MS * 1000) stalls.push({ from: ms(input.at), to: ms(settle), ms: ms(latency), began: ms(input.at), first: true })
  }
  if (demanded.length === 0 && neverPainted.length === 0) return invalid('nothing was demanded: every input changed nothing')

  // Merge overlapping demanded intervals.
  demanded.sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [a, s] of demanded) {
    const last = merged.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], s)
    else merged.push([a, s])
  }

  // Cadence: the presents begun at or after each merged interval's first input, each after the first on its gap from
  // the one before it. A present begun before the input was already in the pipeline: it can't contain the input.
  let judged = 0
  const long = []
  let demandedUs = 0
  for (const [a, s] of merged) {
    demandedUs += s - a
    const ending = presented.filter((f) => f.at > a && f.at <= s)
    if (ending.length === 0) return invalid(`the demanded interval ${ms(a)}..${ms(s)} ms has no presented frame`)
    const inside = ending.filter((f) => f.lastBegan >= a)
    for (let k = 1; k < inside.length; k++) {
      const gap = inside[k].at - inside[k - 1].at
      const span = { from: ms(inside[k - 1].at), to: ms(inside[k].at), ms: ms(gap), began: ms(inside[k - 1].began) }
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

  const longShare = judged ? long.length / judged : 0
  const cadenceStalls = stalls.some((s) => !s.first)
  const latencies = inputToPaint.map((p) => p.ms)
  return {
    valid: true,
    reason: undefined,
    inputs: inputs.length,
    unanswered: { n: unanswered.length, max: unanswered.length ? Math.max(...unanswered) : undefined },
    demandedMs: ms(demandedUs),
    frames: judged,
    longFrames: long.length,
    longShare,
    long,
    cadence: judged === 0 ? 'n/a' : longShare <= 0.01 && !cadenceStalls ? 'pass' : 'fail',
    firstFrame: { n: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : undefined },
    responsiveness: neverPainted.length === 0 && !stalls.some((s) => s.first) ? 'pass' : 'fail',
    stalls,
    neverPainted,
    inputToPaint,
    raf: { maxGapMs: ms(rafMax) }
  }
}
