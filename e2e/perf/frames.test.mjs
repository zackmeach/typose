// Plan C8's demanded-frame accounting on synthetic traces: each case is the smallest trace that fails if the rule breaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeFrames } from './frames.mjs'

// Builders, in ms on one clock (the renderer's performance.now() is the trace clock here, offset 0).
const renderer = (pid) => ({ ph: 'M', name: 'process_name', pid, args: { name: 'Renderer' } })
let ids = 0
let frameSeq = 0
/** A renderer frame presented at `t`: its PipelineReporter slice, begun at `began` (one refresh earlier by default), as
 *  frame `seq` (the next by default). */
const frame = (t, { state = 'STATE_PRESENTED_ALL', pid = 1, began = t - 6, seq = ++frameSeq } = {}) => {
  const id2 = { local: `0x${(++ids).toString(16)}` }
  return [
    { name: 'PipelineReporter', ph: 'b', pid, id2, ts: began * 1000, args: { frame_reporter: { state, frame_sequence: seq, frame_source: 1 } } },
    { name: 'PipelineReporter', ph: 'e', pid, id2, ts: t * 1000 }
  ]
}
const stamp = (t, message) => ({ name: 'TimeStamp', pid: 1, ts: t * 1000, args: { data: { message } } })
/** The main thread's AnimationFrame for frame `seq`, from `from` to `to`: a paint mark inside it is that frame's. */
const animationFrame = (from, to, seq) => {
  const id2 = { local: `0x${(++ids).toString(16)}` }
  return [
    { name: 'AnimationFrame', ph: 'b', pid: 1, id2, ts: from * 1000, args: { animation_frame_timing_info: { begin_frame_id: { sequence_number: seq, source_id: 1 } } } },
    { name: 'AnimationFrame', ph: 'e', pid: 1, id2, ts: to * 1000 }
  ]
}
let seq = 0
/**
 * An input at `t` (dispatched `lag` ms later), painted at `paintAt` with view key `key`. The paint mark sits in the
 * AnimationFrame of frame `owner`; left out, analyze() gives it the first frame presented after the mark (the old
 * answer, so the older cases keep their timing), and `owner: null` gives it none (a trace without the linkage).
 */
const input = (t, paintAt, key = String(t), lag = 1, kind = 'wheel', { owner } = {}) => {
  seq++
  const marks = [stamp(t + lag, `typose:input ${seq} ${kind} ${t} ${t + lag}`)]
  if (paintAt === null) return marks
  const paint = stamp(paintAt, `typose:painted ${seq} ${key}`)
  if (owner === undefined) return [...marks, Object.assign(paint, { owner: 'auto' })]
  return [...marks, paint, ...(owner === null ? [] : animationFrame(paintAt - 0.5, paintAt + 0.1, owner))]
}
const frames = (from, to, every) => Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, i) => frame(from + i * every))
/** Analyzes a synthetic trace, giving each paint mark left without an owner the first full frame presented after it. */
const analyze = (...parts) => {
  const events = [renderer(1), ...parts.flat(3)]
  const states = new Map(events.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b').map((e) => [e.id2.local, e.args.frame_reporter]))
  const presents = events
    .filter((e) => e.name === 'PipelineReporter' && e.ph === 'e' && states.get(e.id2.local).state === 'STATE_PRESENTED_ALL')
    .map((e) => ({ at: e.ts, seq: states.get(e.id2.local).frame_sequence }))
    .sort((a, b) => a.at - b.at)
  for (const paint of events.filter((e) => e.owner === 'auto')) {
    // No frame after it: a frame that never presents, so the target never paints.
    const next = presents.find((f) => f.at > paint.ts)
    events.push(...animationFrame(paint.ts / 1000 - 0.5, paint.ts / 1000 + 0.1, next ? next.seq : 1e9))
  }
  return analyzeFrames(events)
}

/** A continuous scroll: an input every 5 ms from 0 to `until`, each painted 4 ms later, so each demand overlaps the next. */
const scroll = (until) => Array.from({ length: until / 5 + 1 }, (_, i) => input(i * 5, i * 5 + 4))
/** One gesture: inputs every 5 ms, each painted 6 ms later, so every answer comes after the next input and the whole
 *  gesture is one demanded interval, as live scrolls are (PR 3: 289–329 judged frames per 2 s scroll). */
const gesture = (until) => Array.from({ length: until / 5 + 1 }, (_, i) => input(i * 5, i * 5 + 6))

/** 21 discrete keypresses 100 ms apart, each answered by one frame presented `after` ms later. */
const keypresses = (after) => Array.from({ length: 21 }, (_, i) => [input(i * 100, i * 100 + after - 5, String(i), 1, 'keydown'), frame(i * 100 + after)])

test('a steady scroll at 164 Hz has no long frame and no stall, and nearly every frame is judged on cadence', () => {
  const r = analyze(scroll(500), frames(6.1, 520, 6.1))
  assert.equal(r.valid, true)
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
  assert.deepEqual(r.neverPainted, [])
  assert.ok(r.frames > 50)
  assert.equal(r.cadence, 'pass')
  assert.equal(r.responsiveness, 'pass')
  // Every input is answered by the first frame after its rows paint: 4 ms after it, plus at most one 6.1 ms refresh.
  assert.equal(r.firstFrame.n, 101)
  assert.ok(r.firstFrame.max > 4 && r.firstFrame.max <= 10.1)
})

test('responsiveness times the answer, not the next frame: frames flow every refresh, the target paints 40 ms late', () => {
  // A frame every 6 ms throughout; the input at 50 has its rows painted at 89, so the frame at 90 answers it.
  const r = analyze(frames(6, 300, 6), input(50, 89))
  assert.deepEqual(r.firstFrame, { n: 1, p50: 40, p95: 40, max: 40 })
  assert.deepEqual(r.stalls, [])
  assert.equal(r.responsiveness, 'pass')
})

test('an answer 60 ms after the input is a stall while frames flow every refresh', () => {
  const r = analyze(frames(6, 300, 6), input(48, 107))
  assert.deepEqual(r.firstFrame, { n: 1, p50: 60, p95: 60, max: 60 })
  assert.deepEqual(r.stalls, [{ from: 48, to: 108, ms: 60, began: 48, first: true }])
  assert.equal(r.responsiveness, 'fail')
})

test('a 30 ms hole in presentation during the scroll is one long frame and no stall', () => {
  const r = analyze(gesture(500), frames(6.1, 200, 6.1), frames(232, 520, 6.1))
  assert.equal(r.longFrames, 1)
  assert.deepEqual(r.stalls, [])
})

test('a 60 ms hole in presentation during the scroll is a stall covering it, and fails cadence', () => {
  const r = analyze(gesture(500), frames(6.1, 200, 6.1), frames(262, 520, 6.1))
  assert.ok(r.stalls.some((s) => !s.first && s.from <= 200 && s.to >= 262))
  assert.equal(r.cadence, 'fail')
})

test('a partially presented frame (compositor only, rows stale) does not end a stall', () => {
  const r = analyze(
    gesture(500),
    frames(6.1, 200, 6.1),
    frame(212, { state: 'STATE_PRESENTED_PARTIAL' }),
    frame(230, { state: 'STATE_DROPPED' }),
    frames(262, 520, 6.1)
  )
  assert.ok(r.stalls.some((s) => !s.first && s.from <= 200 && s.to >= 262))
})

test('a stall opened by a frame already in the pipeline says when that frame began', () => {
  // A block from 200 to 260: the frame begun at 199 still presents at 205, then nothing until 262.
  const r = analyze(scroll(500), frames(6.1, 196, 6.1), frame(205), frames(262, 520, 6.1))
  const cadence = r.stalls.filter((s) => !s.first)
  assert.deepEqual(cadence.map(({ from, to, began }) => ({ from, to, began })), [{ from: 205, to: 262, began: 199 }])
})

test('a jump whose first frame comes 70 ms after its input is a stall, from the input', () => {
  const r = analyze(frame(0), input(100, 160), frame(170), frame(176))
  assert.deepEqual(r.stalls, [{ from: 100, to: 170, ms: 70, began: 100, first: true }])
  assert.equal(r.responsiveness, 'fail')
})

test('discrete keypresses each answered by one frame: cadence is not applicable, and responsiveness is judged', () => {
  for (const after of [10, 45]) {
    const r = analyze(keypresses(after))
    assert.equal(r.valid, true)
    assert.equal(r.frames, 0, `${after} ms: no frame is judged on cadence`)
    assert.equal(r.cadence, 'n/a', `${after} ms`)
    assert.equal(r.pass, undefined, `${after} ms: no overall pass stands in for the frame gate`)
    assert.deepEqual(r.stalls, [], `${after} ms`)
    assert.equal(r.responsiveness, 'pass', `${after} ms`)
    assert.deepEqual(r.firstFrame, { n: 21, p50: after, p95: after, max: after })
  }
  // A 61 ms response is a stall on every key.
  const slow = analyze(keypresses(61))
  assert.equal(slow.cadence, 'n/a')
  assert.equal(slow.stalls.length, 21)
  assert.ok(slow.stalls.every((s) => s.first && s.ms === 61 && s.began === s.from))
  assert.equal(slow.responsiveness, 'fail')
})

test('a present reported by two slices (two frame sequences, one display frame) is one frame, begun when the earlier began', () => {
  // As seen on keypresses: a slice begun 5 ms before the key and the key's own slice both end at the present at 13.
  const r = analyze(input(0, 1, 'x', 1, 'keydown'), frame(13, { began: -5 }), frame(13, { began: 8 }))
  assert.equal(r.frames, 0)
  assert.equal(r.cadence, 'n/a')
  assert.deepEqual(r.firstFrame, { n: 1, p50: 13, p95: 13, max: 13 })
  // In a scroll, the doubled present is neither a judged frame nor a gap: 61 presents in the demand judge 60 gaps.
  const scrolling = analyze(scroll(360), frames(6, 372, 6), frame(186, { began: 170 }))
  assert.equal(scrolling.frames, 60)
  // A stall opened by that present says when its earliest slice began.
  const stall = analyze(scroll(360), frames(6, 180, 6), frame(186, { began: 170 }), frame(186), frames(250, 372, 6))
  assert.deepEqual(stall.stalls.filter((s) => !s.first).map(({ from, to, began }) => ({ from, to, began })), [{ from: 186, to: 250, began: 170 }])
})

test('the first frame is judged on input to present, never on its slice: a frame begun late is not a long frame', () => {
  // Begun 20 ms after the key (a block before the frame), presented 6 ms later: a 26 ms response and nothing on cadence.
  const r = analyze(input(0, 22, 'x', 1, 'keydown'), frame(26, { began: 20 }))
  assert.deepEqual(r.long, [])
  assert.equal(r.cadence, 'n/a')
  assert.deepEqual(r.firstFrame, { n: 1, p50: 26, p95: 26, max: 26 })
})

test("a frame presented between a jump and its answer isn't judged: the interval starts at the answer", () => {
  // The coordinator's ruling (PR 9): the jump presents a frame at 110 with its rows still blank, then the rows' frame
  // at 130, its answer. The 110 frame can't carry the response, and the 30 ms latency covers it. (PR 3's version judged
  // the 20 ms gap from 110 as long.)
  const r = analyze(input(100, 125), frame(110), frame(130))
  assert.equal(r.frames, 0)
  assert.deepEqual(r.long, [])
  assert.equal(r.cadence, 'n/a')
  assert.deepEqual(r.firstFrame, { n: 1, p50: 30, p95: 30, max: 30 })
  assert.equal(r.responsiveness, 'pass')
})

test("a pointerdown folded into the drag's scroll doesn't anchor the interval: the thumb frame between them isn't judged", () => {
  // The coordinator's anchoring ruling (PR 9). The pointerdown at 0 has no mark of its own: the drag's scroll at 7 came
  // first. A frame begun at 5 presents the thumb at 12; the rows' frame (begun 20), which owns the paint, at 40.
  const r = analyze(input(0, null, 'x', 1, 'pointerdown'), input(7, 21, 'k', 1, 'scroll', { owner: 41 }), frame(12, { began: 5, seq: 40 }), frame(40, { began: 20, seq: 41 }))
  assert.equal(r.folded, 1)
  assert.equal(r.frames, 0)
  assert.deepEqual(r.long, [])
  assert.equal(r.cadence, 'n/a')
  // Both are judged on responsiveness, on the rows' frame (the coordinator's round-5 ruling): the pointerdown 40 ms,
  // the scroll 33 ms.
  assert.deepEqual(r.inputToPaint.map((p) => [p.kind, p.ms]), [['pointerdown', 40], ['scroll', 33]])
  assert.equal(r.unanswered.n, 0)
  // Control before End (Ctrl+End) folds the same way, and a discrete keypress stays n/a.
  const key = analyze(input(100, null, 'y', 1, 'keydown'), input(101, 104, 'end', 1, 'keydown'), frame(108, { began: 102 }))
  assert.deepEqual([key.folded, key.frames, key.cadence], [1, 0, 'n/a'])
})

test('the answer is the frame that owns the paint: a keypress answered by its own frame, begun before the paint', () => {
  // As in PR 3's keypress control: the key at 0, its paint at 0.3 inside frame 101's AnimationFrame. Frame 101 began at
  // -1.6 and presents at 6.2. A pipeline frame presents at 2 before the paint, and frame 102, begun after it, at 12.
  const r = analyze(input(0, 0.3, 'k', 0.1, 'keydown', { owner: 101 }), frame(2, { began: -8, seq: 100 }), frame(6.2, { began: -1.6, seq: 101 }), frame(12, { began: 5, seq: 102 }))
  assert.deepEqual(r.firstFrame, { n: 1, p50: 6.2, p95: 6.2, max: 6.2 })
  assert.equal(r.cadence, 'n/a')
})

test('the first jump after launch is answered by its paint\'s frame, and the compositor frame before it is not judged', () => {
  // A trace kept from PR 9's jump control (ms from the pointerdown): the drag's scroll at 7.8, its paint at 19.8 in
  // frame 150's AnimationFrame. Frame 149 (begun 5.3) presents at 20.8 without the rows; frame 150 has a dropped slice
  // and its presented one, at 44.0. The first present after the paint, at 20.8, isn't the answer.
  const r = analyze(
    input(0, null, 'x', 0.3, 'pointerdown'),
    input(7.8, 19.8, 'k', 0.3, 'scroll', { owner: 150 }),
    frame(5.3, { began: -4.7, seq: 148 }),
    frame(20.8, { began: 5.3, seq: 149 }),
    frame(19.8, { began: 12.6, seq: 150, state: 'STATE_DROPPED' }),
    frame(44.0, { began: 12.6, seq: 150 })
  )
  assert.deepEqual(r.inputToPaint.map((p) => [p.kind, p.ms]), [['pointerdown', 44], ['scroll', 36.2]])
  assert.deepEqual([r.folded, r.frames, r.cadence, r.ownerUnpresented], [1, 0, 'n/a', 0])
  assert.deepEqual(r.long, [])
})

test("a frame that never presents: the next presented frame carries the change, and it's counted", () => {
  const r = analyze(input(0, 3, 'k', 1, 'wheel', { owner: 301 }), frame(8, { began: 2, seq: 301, state: 'STATE_DROPPED' }), frame(14, { began: 8, seq: 302 }))
  assert.deepEqual(r.firstFrame, { n: 1, p50: 14, p95: 14, max: 14 })
  assert.equal(r.ownerUnpresented, 1)
})

test('a paint mark with no AnimationFrame around it makes the run invalid: its answer is never guessed', () => {
  const r = analyze(input(0, 3, 'k', 1, 'wheel', { owner: null }), frame(6), frame(12))
  assert.equal(r.valid, false)
  assert.match(r.reason, /^input \d+: no AnimationFrame around the paint mark at 3 ms/)
  assert.deepEqual([r.cadence, r.responsiveness], ['invalid', 'invalid'])
})

test("a run is invalid when its answer's linkage is wrong: another process's AnimationFrame, or an answer before the mark", () => {
  // The reviewer's P1b: an AnimationFrame of a second renderer (pid 2) is the one around the mark.
  const foreign = analyze(renderer(2), input(0, 20, 'k', 1, 'wheel', { owner: 50 }), animationFrame(19.8, 20.05, 40).map((e) => ({ ...e, pid: 2 })), frame(-30, { seq: 40 }), frame(30, { seq: 50 }))
  assert.equal(foreign.valid, false)
  assert.match(foreign.reason, /^input \d+: the AnimationFrame around the paint mark at 20 ms is another process's \(pid 2, the mark's 1\)/)
  // P1c: the owning frame presented 900 ms before the mark.
  const early = analyze(input(0, 20, 'k', 1, 'wheel', { owner: 50 }), frame(-890, { began: -900, seq: 50 }), frame(30, { seq: 51 }))
  assert.equal(early.valid, false)
  assert.match(early.reason, /^input \d+: frame 50, around the paint mark at 20 ms, presented before it, at -890 ms/)
})

test('an owning frame with no update to present answers nothing: the input changed nothing on screen', () => {
  // The reviewer's P5, a scrollbar jump while indexing: the pointerdown's own mark has the top view with a grown row
  // count, so its key changed, but its frame (100) had no update. The progress line's frame (101) presents at 8, and the
  // drag's scroll at 6 paints in frame 102, presented at 52.
  const jump = (progress) =>
    analyze(
      stamp(-30, 'typose:painted 0 0,0,1000'),
      input(0, 1, '0,0,1500', 0.5, 'pointerdown', { owner: 100 }),
      input(progress ? 6 : 8, 45, '5000,0,1500', 0.5, 'scroll', { owner: 102 }),
      frame(-5, { began: -20, seq: 99 }),
      frame(3, { began: -2, seq: 100, state: 'STATE_NO_UPDATE_DESIRED' }),
      progress ? frame(8, { began: 2, seq: 101 }) : [],
      frame(progress ? 52 : 51, { began: 38, seq: 102 })
    )
  const r = jump(true)
  assert.deepEqual(r.unanswered, { n: 1, max: 1 })
  assert.deepEqual(r.inputToPaint.map((p) => [p.kind, p.ms]), [['scroll', 46]])
  assert.deepEqual([r.frames, r.cadence, r.responsiveness, r.ownerUnpresented], [0, 'n/a', 'pass', 0])
  // P5b: with nothing presented before the drag's frame (51), the fallback would answer the pointerdown 51 ms after it.
  const b = jump(false)
  assert.deepEqual(b.inputToPaint.map((p) => [p.kind, p.ms]), [['scroll', 43]])
  assert.deepEqual([b.cadence, b.responsiveness], ['n/a', 'pass'])
  // A dropped owner still falls back to the next presented frame.
  const dropped = analyze(input(0, 3, 'k', 1, 'wheel', { owner: 301 }), frame(8, { began: 2, seq: 301, state: 'STATE_DROPPED' }), frame(14, { began: 8, seq: 302 }))
  assert.deepEqual([dropped.firstFrame.max, dropped.ownerUnpresented], [14, 1])
})

test('a folded input is judged on the answer of the mark it folded into, and still opens no interval', () => {
  // The reviewer's P3k: two keydowns (key repeat) painted in one frame after a 40 ms block. The first has no mark of its
  // own; frame 70, which owns the second's paint, presents at 57: the first keydown waited 57 ms.
  const keys = analyze(
    stamp(-50, 'typose:painted 0 0,0,9'),
    input(0, null, 'x', 40, 'keydown'),
    input(30, 44, '40,0,9', 10.5, 'keydown', { owner: 70 }),
    frame(-6, { began: -20, seq: 69 }),
    frame(57, { began: 39, seq: 70 })
  )
  assert.deepEqual(keys.inputToPaint.map((p) => [p.kind, p.ms]), [['keydown', 57], ['keydown', 27]])
  assert.deepEqual(keys.stalls.map((s) => `${s.ms}${s.first ? 'r' : 'c'}`), ['57r'])
  assert.deepEqual([keys.folded, keys.frames, keys.cadence, keys.responsiveness], [1, 0, 'n/a', 'fail'])
  // Right after an in-app open, a wheel's first mark can be the native scroll's: the wheel is timed to its answer too.
  const open = analyze(
    stamp(-10, 'typose:painted 0 none'),
    input(0, 30, 'opened', 1, 'open', { owner: 10 }),
    input(45, null, 'x', 1, 'wheel'),
    input(47, 52, 'scrolled', 1, 'scroll', { owner: 12 }),
    frame(40, { began: 25, seq: 10 }),
    frame(58, { began: 50, seq: 12 })
  )
  assert.deepEqual(open.inputToPaint.map((p) => [p.kind, p.ms]), [['open', 40], ['wheel', 13], ['scroll', 11]])
  assert.equal(open.folded, 1)
})

test("the baseline mark: a first input whose mark repeats it changes nothing, and doesn't open an interval", () => {
  // PR 9's third round: the jump control's failing trace. The view was painted before the trace began (Ctrl+Home), so
  // the pointerdown's own mark repeats it. The drag's scroll comes 30 ms later, and its paint's frame (208) answers at
  // 106. A frame presents at 54.6 in between.
  const run = (baseline) =>
    analyze(
      baseline ? [stamp(-5, 'typose:painted 0 top')] : [],
      input(0, 3, 'top', 1, 'pointerdown'),
      input(30, 46, 'moved', 1, 'scroll', { owner: 208 }),
      frame(54.6, { began: 33, seq: 207 }),
      frame(106, { began: 40, seq: 208 })
    )
  const r = run(true)
  assert.deepEqual(r.unanswered, { n: 1, max: 3 })
  assert.deepEqual(r.inputToPaint.map((p) => [p.kind, p.ms]), [['scroll', 76]])
  assert.deepEqual([r.frames, r.cadence], [0, 'n/a'])
  // The 76 ms answer is the scroll's own: a responsiveness stall, which the row judges.
  assert.equal(r.responsiveness, 'fail')
  // Without the baseline, the pointerdown's mark is the trace's first: it opens an interval, which merges with the
  // scroll's and judges the 51.4 ms gap from 54.6 as a cadence stall.
  const blind = run(false)
  assert.deepEqual([blind.unanswered.n, blind.cadence], [0, 'fail'])
})

test("a real long frame after the scroll's answer still fails cadence", () => {
  // The scroll at 7 is answered at 15 by its paint's frame; a second scroll at 14 overlaps it, and its rows' frame comes
  // 25 ms later. A compositor frame between the first scroll and its answer (at 10) isn't judged.
  const r = analyze(
    input(0, null, 'x', 1, 'pointerdown'),
    input(7, 13, 'k1', 1, 'scroll', { owner: 202 }),
    input(14, 34, 'k2', 1, 'scroll', { owner: 203 }),
    frame(10, { began: 4, seq: 201 }),
    frame(15, { began: 8, seq: 202 }),
    frame(40, { began: 30, seq: 203 })
  )
  assert.equal(r.folded, 1)
  assert.deepEqual(r.long, [{ from: 15, to: 40, ms: 25, began: 8 }])
  assert.equal(r.cadence, 'fail')
})

test('idle time is never demanded: a frame long after the view settled is not a gap', () => {
  const r = analyze(input(0, 3), frame(6), frame(500), input(600, 603), frame(606))
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
})

test('a target that never paints fails, and so does one painted after 1 s', () => {
  const never = analyze(frame(0), input(10, null), frame(20))
  assert.deepEqual(never.neverPainted.map((n) => n.at), [10])
  assert.equal(never.responsiveness, 'fail')
  const late = analyze(frame(0), input(10, 1200), frame(1205))
  assert.equal(late.neverPainted.length, 1)
  assert.equal(late.responsiveness, 'fail')
})

test('an input that changes nothing owes no frame: timed to its mark, apart from the latency figure', () => {
  // The view is idle after it: the next present comes 500 ms later, which isn't the input's latency.
  const r = analyze(input(0, 2, 'k'), frame(5), input(100, 102, 'k'), frame(600))
  assert.deepEqual(r.unanswered, { n: 1, max: 2 })
  assert.deepEqual(r.firstFrame, { n: 1, p50: 5, p95: 5, max: 5 })
  assert.deepEqual(r.neverPainted, [])
  assert.deepEqual(r.stalls, [])
  assert.equal(r.responsiveness, 'pass')
  // Its mark over 50 ms late is a stall, and fails responsiveness, still outside the latency figure.
  const late = analyze(input(0, 2, 'k'), frame(5), input(100, 170, 'k'))
  assert.deepEqual(late.unanswered, { n: 1, max: 70 })
  assert.equal(late.firstFrame.n, 1)
  assert.deepEqual(late.stalls, [{ from: 100, to: 170, ms: 70, began: 100, first: true }])
  assert.equal(late.responsiveness, 'fail')
})

test('the input timestamp maps onto the trace clock through its dispatch mark', () => {
  // Dispatched 40 ms after the input (a busy main thread): the demand starts at the input, so the stall shows.
  const r = analyze(frame(0), input(100, 145, 'x', 40), frame(160))
  assert.deepEqual(r.stalls, [{ from: 100, to: 160, ms: 60, began: 100, first: true }])
})

test('nothing to judge is invalid, never a pass', () => {
  const P = { state: 'STATE_PRESENTED_PARTIAL' }
  const cases = {
    'an empty trace': [],
    'renderer metadata only': [renderer(1)],
    'inputs but no frames': [renderer(1), ...[input(10, 20), input(100, 120)].flat()],
    'partial frames and no inputs': [renderer(1), ...frame(5, P), ...frame(30, P)],
    'full frames and no inputs': [renderer(1), ...frames(6, 2000, 6).flat()],
    'a 300 ms hole and no inputs': [renderer(1), ...frames(6, 1000, 6).flat(), ...frames(1300, 2000, 6).flat()],
    // The view was already painted as `k` before the trace's inputs, and none of them changes it.
    'only inputs that change nothing': [renderer(1), stamp(-10, 'typose:painted 0 k'), ...frame(5), ...input(0, 2, 'k'), ...input(50, 52, 'k')]
  }
  for (const [name, events] of Object.entries(cases)) {
    const r = analyzeFrames(events)
    assert.equal(r.valid, false, name)
    assert.equal(r.cadence, 'invalid', name)
    assert.equal(r.responsiveness, 'invalid', name)
    assert.ok(r.reason, name)
  }
})

test('a second renderer is invalid: the frames could belong to another page', () => {
  const r = analyzeFrames([renderer(1), renderer(2), ...frame(0), ...frame(5, { pid: 2 }), ...input(0, 3)])
  assert.equal(r.valid, false)
  assert.match(r.reason, /one renderer/)
})
