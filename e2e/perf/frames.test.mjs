// Plan C8's demanded-frame accounting on synthetic traces: each case is the smallest trace that fails if the rule breaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeFrames } from './frames.mjs'

// Builders, in ms on one clock (the renderer's performance.now() is the trace clock here, offset 0).
const renderer = (pid) => ({ ph: 'M', name: 'process_name', pid, args: { name: 'Renderer' } })
let ids = 0
/** A renderer frame presented at `t`: its PipelineReporter slice, begun at `began` (one refresh earlier by default). */
const frame = (t, { state = 'STATE_PRESENTED_ALL', pid = 1, began = t - 6 } = {}) => {
  const id2 = { local: `0x${(++ids).toString(16)}` }
  return [
    { name: 'PipelineReporter', ph: 'b', pid, id2, ts: began * 1000, args: { frame_reporter: { state } } },
    { name: 'PipelineReporter', ph: 'e', pid, id2, ts: t * 1000 }
  ]
}
const stamp = (t, message) => ({ name: 'TimeStamp', ts: t * 1000, args: { data: { message } } })
let seq = 0
/** An input at `t` (dispatched `lag` ms later), painted at `paintAt` with view key `key`. */
const input = (t, paintAt, key = String(t), lag = 1, kind = 'wheel') => {
  seq++
  return [stamp(t + lag, `typose:input ${seq} ${kind} ${t} ${t + lag}`), ...(paintAt === null ? [] : [stamp(paintAt, `typose:painted ${seq} ${key}`)])]
}
const frames = (from, to, every) => Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, i) => frame(from + i * every))
const analyze = (...parts) => analyzeFrames([renderer(1), ...parts.flat(3)])

/** A continuous scroll: an input every 5 ms from 0 to `until`, each painted 4 ms later, so each demand overlaps the next. */
const scroll = (until) => Array.from({ length: until / 5 + 1 }, (_, i) => input(i * 5, i * 5 + 4))

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
  const r = analyze(scroll(500), frames(6.1, 200, 6.1), frames(232, 520, 6.1))
  assert.equal(r.longFrames, 1)
  assert.deepEqual(r.stalls, [])
})

test('a 60 ms hole in presentation during the scroll is a stall covering it, and fails cadence', () => {
  const r = analyze(scroll(500), frames(6.1, 200, 6.1), frames(262, 520, 6.1))
  assert.ok(r.stalls.some((s) => !s.first && s.from <= 200 && s.to >= 262))
  assert.equal(r.cadence, 'fail')
})

test('a partially presented frame (compositor only, rows stale) does not end a stall', () => {
  const r = analyze(
    scroll(500),
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

test('but every later frame of the same demand is judged on its gap: a page 20 ms after the jump frame is long', () => {
  // The jump presents its first frame at 110 (rows still blank), then the rows' frame at 130.
  const r = analyze(input(100, 125), frame(110), frame(130))
  assert.equal(r.longFrames, 1)
  assert.deepEqual(r.long, [{ from: 110, to: 130, ms: 20, began: 104 }])
  assert.equal(r.cadence, 'fail')
  assert.equal(r.responsiveness, 'pass')
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
