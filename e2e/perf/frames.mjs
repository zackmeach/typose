// Plan C8's frame instrument: reads a Chromium trace (JSON) taken while the app was driven, and judges presented
// frames within demanded intervals. Pinned to Electron 44.9.2, where these events were checked:
// - PipelineReporter (cc; category disabled-by-default-devtools.timeline.frame), in the renderer process: one async
//   slice per frame, from its BeginFrame to its presentation, with `frame_reporter.state` on the begin event. A frame
//   counts as presented at its slice's end when its state is STATE_PRESENTED_ALL. STATE_PRESENTED_PARTIAL frames are
//   compositor-only updates (a scrollbar thumb moving) shown while the main thread's update was still pending: they
//   show stale rows, so they don't end a gap. These ends coincide with viz's Display::FrameDisplayed. Two
//   STATE_PRESENTED_ALL slices, for different frame_sequences, can end at the same ts; the earlier sequence often also
//   has a FORKED slice. Why Chromium reports one present twice is unverified. One present is one frame, begun when its
//   earliest slice began. Each slice carries its `frame_sequence` and `frame_source`.
// - AnimationFrame (devtools.timeline): the renderer main thread's animation frames, each naming the frame it renders
//   (`begin_frame_id`: sequence and source). A paint mark fires inside one; that frame's presented slice is the answer.
// - TimeStamp (devtools.timeline): the renderer's console.timeStamp() marks from app/renderer/perf.ts:
//   `typose:input <seq> <kind> <inputMs> <dispatchMs>` and `typose:painted <seq> <key>`, both in performance.now() ms.
//   `typose:painted 0 <key>` is the baseline: the view as it stood when the trace began (drive.ts), so the first input's
//   mark is judged against it.
// - FireAnimationFrame (devtools.timeline): rAF callbacks, printed beside the judged figures and never judged.
export const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame']

const LONG_MS = 16.7 // §10.2's frame threshold, absolute (ruling OQ-6)
const STALL_MS = 50
const NEVER_MS = 1000

const rendererPids = (events) => new Set(events.filter((e) => e.ph === 'M' && e.name === 'process_name' && e.args?.name === 'Renderer').map((e) => e.pid))

/** The renderer's fully presented frames (trace µs), one per present: when it was presented, its earliest begin, and
 *  the frames (sequence and source) it presents. */
export function presentedFrames(events) {
  const renderers = rendererPids(events)
  const reporters = events.filter((e) => e.name === 'PipelineReporter' && renderers.has(e.pid)).sort((a, b) => a.ts - b.ts)
  const pids = new Set(reporters.map((e) => e.pid))
  if (pids.size !== 1) throw new Error(`expected one renderer reporting frames, found ${pids.size}`)
  const open = new Map()
  const frames = []
  for (const e of reporters) {
    const key = e.id2?.local ?? e.id
    const r = e.args?.frame_reporter
    if (e.ph === 'b') open.set(key, { state: r?.state, began: e.ts, seq: { seq: r?.frame_sequence, source: r?.frame_source } })
    else if (e.ph === 'e' && open.has(key)) {
      const { state, began, seq } = open.get(key)
      if (state === 'STATE_PRESENTED_ALL') frames.push({ at: e.ts, began, seqs: [seq] })
      open.delete(key)
    }
  }
  frames.sort((a, b) => a.at - b.at)
  const presents = []
  for (const f of frames) {
    const last = presents.at(-1)
    if (last && last.at === f.at) {
      last.began = Math.min(last.began, f.began)
      last.seqs.push(...f.seqs)
    } else presents.push(f)
  }
  return presents
}

/** The renderer main thread's animation frames (trace µs): when each ran, and the frame it renders. */
function animationFrames(events) {
  const renderers = rendererPids(events)
  const open = new Map()
  const out = []
  for (const e of events.filter((e) => e.name === 'AnimationFrame' && renderers.has(e.pid)).sort((a, b) => a.ts - b.ts)) {
    const key = e.id2?.local ?? e.id
    const frame = e.args?.animation_frame_timing_info?.begin_frame_id
    if (e.ph === 'b') open.set(key, { b: e.ts, seq: frame?.sequence_number, source: frame?.source_id })
    else if (e.ph === 'e' && open.has(key)) {
      out.push({ ...open.get(key), e: e.ts })
      open.delete(key)
    }
  }
  return out
}

/** Nearest-rank percentile of `values` (ms), or undefined when there are none. */
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] : undefined
}

/**
 * Z62: the 16.7 ms / ≥ 99% frame gate judges cadence, and the first frame after an input is judged by responsiveness.
 * - An input's answer is the frame that owns its paint (the coordinator's rulings, PR 9): the presented slice of the
 *   frame whose main-thread AnimationFrame contains the input's painted mark (`begin_frame_id` = `frame_sequence`). The
 *   mark fires inside its own frame, which began before it. If that frame never presents (dropped, or partial only),
 *   the answer is the next presented frame after it, which carries the change (`ownerUnpresented` counts them). A
 *   trace with no AnimationFrame around a mark is invalid: the answer can't be told, and nothing falls back.
 * - A frame is demanded from an input until its answer. Demanded intervals that overlap merge, so a continuous gesture
 *   is one interval. Only an input that changes the view opens one: an input whose first mark is a later input's is
 *   folded into it (`folded`). Like an input that changes nothing, it's timed to that mark and reported apart in
 *   `unanswered`: the later input is the one judged on its answer.
 * - Cadence: a merged interval's frames start at its first answer. Presents between an input and its answer are
 *   compositor or pipeline frames that can't carry the response, and the input's latency covers that span. Every
 *   present after the first answer is judged on its gap from the one before it: long at ≥ 16.7 ms, a stall over
 *   50 ms. A run where no interval has a present after its first answer (discrete keypresses, each answered by one
 *   frame) reports cadence as 'n/a', never as passed.
 * - Responsiveness: each input that changes the view is judged on input → its answer, a stall over 50 ms (plan §5's
 *   input latency, `inputToPaint`). The distribution of these answered inputs is reported (`firstFrame`). An input
 *   whose target isn't painted within 1 s fails as never painted. An input that changes nothing on screen (its painted
 *   mark repeats the previous one) owes no frame: it's timed to its mark and reported apart (`unanswered`), and is a
 *   stall if the mark is over 50 ms late.
 * - Each long frame and stall says when the work behind it began (`began`): a frame begun before a block can still
 *   present during it.
 * - A trace that can't be judged (no renderer frames, more than one renderer, no inputs, nothing demanded, a demanded
 *   interval with no presented frame) is `valid: false`, and judges nothing.
 */
export function analyzeFrames(events) {
  const ms = (us) => Math.round(us) / 1000
  const none = { inputs: 0, folded: 0, ownerUnpresented: 0, unanswered: { n: 0 }, demandedMs: 0, frames: 0, longFrames: 0, longShare: 0, long: [], stalls: [], neverPainted: [], inputToPaint: [], firstFrame: { n: 0 }, raf: { maxGapMs: 0 } }
  const invalid = (reason) => ({ ...none, valid: false, reason, cadence: 'invalid', responsiveness: 'invalid' })
  let presented
  try {
    presented = presentedFrames(events)
  } catch (e) {
    return invalid(e.message)
  }
  const owners = animationFrames(events)
  /** The answer to a paint mark: its owning frame's present, or the next present after an owner that never presented. */
  const answerOf = (mark) => {
    const af = owners.filter((o) => o.b <= mark.ts && mark.ts <= o.e && o.seq !== undefined).sort((x, y) => y.b - x.b)[0]
    if (!af) return { missing: true }
    const sameSource = (f) => f.source === undefined || af.source === undefined || f.source === af.source
    const own = presented.find((p) => p.seqs.some((f) => f.seq === af.seq && sameSource(f)))
    if (own) return { at: own.at }
    const next = presented.find((p) => p.at > mark.ts && p.seqs.some((f) => f.seq > af.seq && sameSource(f)))
    return next ? { at: next.at, unpresented: true } : {}
  }

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
  let folded = 0
  let ownerUnpresented = 0
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
    if (mark && mark.seq !== input.seq) {
      // Only an input that changes the view opens a demanded interval (the coordinator's rulings, PR 9). This one's first
      // mark is a later input's: nothing of its own reached the screen before that input came (a scrollbar pointerdown
      // before the drag's scroll, or Control before End). It's folded into the later input, which is the one judged on
      // its answer; like an input that changes nothing, it's timed to the mark, reported apart, and a stall if late.
      folded++
      const late = mark.ts - input.at
      unanswered.push(ms(late))
      if (late > STALL_MS * 1000) stalls.push({ from: ms(input.at), to: ms(mark.ts), ms: ms(late), began: ms(input.at), first: true })
      continue
    }
    const answer = mark ? answerOf(mark) : {}
    if (answer.missing) return invalid(`no AnimationFrame around input ${input.seq}'s paint mark at ${ms(mark.ts)} ms: its answer's frame can't be told`)
    if (answer.unpresented) ownerUnpresented++
    const settle = answer.at
    if (settle === undefined || settle - input.at > NEVER_MS * 1000) {
      neverPainted.push({ seq: input.seq, kind: input.kind, at: ms(input.at) })
      continue
    }
    // Responsiveness: the input is answered by the frame that owns its paint (plan §5's input latency).
    const latency = settle - input.at
    inputToPaint.push({ seq: input.seq, kind: input.kind, ms: ms(latency) })
    demanded.push([input.at, settle])
    if (latency > STALL_MS * 1000) stalls.push({ from: ms(input.at), to: ms(settle), ms: ms(latency), began: ms(input.at), first: true })
  }
  if (demanded.length === 0 && neverPainted.length === 0) return invalid('nothing was demanded: every input changed nothing')

  // Merge overlapping demanded intervals, each from its input to its answer; a merged interval's frames start at its
  // first answer.
  demanded.sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [a, s] of demanded) {
    const last = merged.at(-1)
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], s)
      last[2] = Math.min(last[2], s)
    } else merged.push([a, s, s])
  }

  // Cadence: each present after a merged interval's first answer, on its gap from the one before it.
  let judged = 0
  const long = []
  let demandedUs = 0
  for (const [a, s, first] of merged) {
    demandedUs += s - a
    const inside = presented.filter((f) => f.at >= first && f.at <= s)
    if (inside.length === 0) return invalid(`the demanded interval ${ms(a)}..${ms(s)} ms has no presented frame`)
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
    folded,
    ownerUnpresented,
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
