// Plan C8's demanded-frame accounting on synthetic traces: each case is the smallest trace that fails if the rule breaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeFrames } from './frames.mjs'

// Builders, in ms on one clock (the renderer's performance.now() is the trace clock here, offset 0). 165 Hz, as on the PC.
const HZ = 165
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
const analyze = (...parts) => analyzeFrames([renderer(1), ...parts.flat(3)], { hz: HZ })

/** A continuous scroll: an input every 5 ms from 0 to `until`, each painted 4 ms later, so each demand overlaps the next. */
const scroll = (until) => Array.from({ length: until / 5 + 1 }, (_, i) => input(i * 5, i * 5 + 4))

/** 21 discrete keypresses 100 ms apart, each answered by one frame presented `after` ms later, its slice begun at `began`. */
const keypresses = (after, began) =>
  Array.from({ length: 21 }, (_, i) => [input(i * 100, i * 100 + after - 5, String(i), 1, 'keydown'), frame(i * 100 + after, { began: i * 100 + began })])

test('a steady scroll at 164 Hz has no long frame and no stall, and nearly every frame is judged', () => {
  const r = analyze(scroll(500), frames(6.1, 520, 6.1))
  assert.equal(r.valid, true)
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
  assert.deepEqual(r.neverPainted, [])
  assert.ok(r.frames > 50)
  assert.equal(r.pass, true)
})

test('a 30 ms hole in presentation during the scroll is one long frame and no stall', () => {
  const r = analyze(scroll(500), frames(6.1, 200, 6.1), frames(232, 520, 6.1))
  assert.equal(r.longFrames, 1)
  assert.deepEqual(r.stalls, [])
})

test('a 60 ms hole in presentation during the scroll is a stall covering it', () => {
  const r = analyze(scroll(500), frames(6.1, 200, 6.1), frames(262, 520, 6.1))
  assert.equal(r.stalls.length, 1)
  assert.ok(r.stalls[0].from <= 200 && r.stalls[0].to >= 262)
})

test('a partially presented frame (compositor only, rows stale) does not end a stall', () => {
  const r = analyze(
    scroll(500),
    frames(6.1, 200, 6.1),
    frame(212, { state: 'STATE_PRESENTED_PARTIAL' }),
    frame(230, { state: 'STATE_DROPPED' }),
    frames(262, 520, 6.1)
  )
  assert.equal(r.stalls.length, 1)
  assert.ok(r.stalls[0].from <= 200 && r.stalls[0].to >= 262)
})

test('a stall opened by a frame already in the pipeline says when that frame began', () => {
  // A block from 200 to 260: the frame begun at 199 still presents at 205, then nothing until 262.
  const r = analyze(scroll(500), frames(6.1, 196, 6.1), frame(205), frames(262, 520, 6.1))
  assert.deepEqual(r.stalls.map(({ from, to, began }) => ({ from, to, began })), [{ from: 205, to: 262, began: 199 }])
})

test('a jump whose first frame comes 70 ms after its input is a stall, from the input', () => {
  const r = analyze(frame(0), input(100, 160), frame(170), frame(176))
  assert.deepEqual(r.stalls, [{ from: 100, to: 170, ms: 70, began: 100, first: true }])
})

test('discrete keypresses: every response frame is judged, on its own production time', () => {
  // A 10 ms response (slice begun 4 ms after the key) passes; all 21 frames count.
  const fast = analyze(keypresses(10, 4))
  assert.equal(fast.frames, 21)
  assert.equal(fast.longFrames, 0)
  assert.equal(fast.pass, true)
  // A 45 ms response fails, whether the frame starts late (a handler blocked first) or takes long to produce.
  for (const began of [39, 1]) {
    const slow = analyze(keypresses(45, began))
    assert.equal(slow.frames, 21)
    assert.equal(slow.longFrames, 21, `slice begun at +${began} ms`)
    assert.deepEqual(slow.stalls, [])
    assert.equal(slow.pass, false)
  }
})

test('an opening frame is excused one refresh of waiting for its BeginFrame, and no more', () => {
  // Slice begun 6 ms after the key (inside one 6.06 ms refresh), presented 6 ms later: 12 ms from the key, 6 ms judged.
  assert.equal(analyze(input(0, 8), frame(12, { began: 6 })).longFrames, 0)
  // Begun 20 ms after the key (a 14 ms block before the frame), presented 6 ms later: judged 26 − 6.06 ≈ 20 ms.
  const r = analyze(input(0, 22, 'x', 1, 'keydown'), frame(26, { began: 20 }))
  assert.deepEqual(r.long, [{ from: 6.061, to: 26, ms: 19.939, began: 0, opening: true }])
})

test('but every later frame of the same demand is judged on its gap: a page 20 ms after the jump frame is long', () => {
  // The jump presents its first frame at 110 (rows still blank), then the rows' frame at 130.
  const r = analyze(input(100, 125), frame(110), frame(130))
  assert.equal(r.longFrames, 1)
  assert.deepEqual(r.long, [{ from: 110, to: 130, ms: 20, began: 104 }])
})

test('idle time is never demanded: a frame long after the view settled is not a gap', () => {
  const r = analyze(input(0, 3), frame(6), frame(500), input(600, 603), frame(606))
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
})

test('a target that never paints fails, and so does one painted after 1 s', () => {
  const never = analyze(frame(0), input(10, null), frame(20))
  assert.deepEqual(never.neverPainted.map((n) => n.at), [10])
  assert.equal(never.pass, false)
  const late = analyze(frame(0), input(10, 1200), frame(1205))
  assert.equal(late.neverPainted.length, 1)
  assert.equal(late.pass, false)
})

test('an input that changes nothing owes no frame, unless its mark is over 50 ms late', () => {
  const r = analyze(input(0, 2, 'k'), frame(5), input(100, 102, 'k'))
  assert.equal(r.unchanged, 1)
  assert.deepEqual(r.neverPainted, [])
  assert.deepEqual(r.stalls, [])
  const late = analyze(input(0, 2, 'k'), frame(5), input(100, 170, 'k'))
  assert.deepEqual(late.stalls, [{ from: 100, to: 170, ms: 70, began: 100, first: true }])
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
    const r = analyzeFrames(events, { hz: HZ })
    assert.equal(r.valid, false, name)
    assert.equal(r.pass, false, name)
    assert.ok(r.reason, name)
  }
})

test('a second renderer is invalid: the frames could belong to another page', () => {
  const r = analyzeFrames([renderer(1), renderer(2), ...frame(0), ...frame(5, { pid: 2 }), ...input(0, 3)], { hz: HZ })
  assert.equal(r.valid, false)
  assert.match(r.reason, /one renderer/)
})

test('the analysis needs the panel refresh rate', () => {
  assert.throws(() => analyzeFrames([renderer(1)]), /refresh rate/)
})
