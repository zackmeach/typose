// Plan C8's demanded-frame accounting on synthetic traces: each case is the smallest trace that fails if the rule breaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRESENTED, analyzeFrames } from './frames.mjs'

// Builders, in ms on one clock (the renderer's performance.now() is the trace clock here, offset 0).
const frame = (t) => ({ name: PRESENTED, pid: 1, tid: 2, ts: t * 1000 })
const stamp = (t, message) => ({ name: 'TimeStamp', ts: t * 1000, args: { data: { message } } })
let seq = 0
/** An input at `t` (dispatched `lag` ms later), painted at `paintAt` with view key `key`. */
const input = (t, paintAt, key = String(t), lag = 1) => {
  seq++
  return [stamp(t + lag, `typose:input ${seq} wheel ${t} ${t + lag}`), ...(paintAt === null ? [] : [stamp(paintAt, `typose:painted ${seq} ${key}`)])]
}
const frames = (from, to, every) => Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, i) => frame(from + i * every))

/** A continuous scroll: an input every 5 ms from 0 to `until`, each painted 4 ms later, so each demand overlaps the next. */
const scroll = (until) => Array.from({ length: until / 5 + 1 }, (_, i) => input(i * 5, i * 5 + 4)).flat()

test('a steady scroll at 164 Hz has no long frame and no stall', () => {
  const r = analyzeFrames([...scroll(500), ...frames(6.1, 520, 6.1)])
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
  assert.deepEqual(r.neverPainted, [])
  assert.ok(r.frames > 50)
  assert.equal(r.pass, true)
})

test('a 30 ms hole in presentation during the scroll is one long frame and no stall', () => {
  const r = analyzeFrames([...scroll(500), ...frames(6.1, 200, 6.1), ...frames(232, 520, 6.1)])
  assert.equal(r.longFrames, 1)
  assert.deepEqual(r.stalls, [])
})

test('a 60 ms hole in presentation during the scroll is a stall covering it', () => {
  const r = analyzeFrames([...scroll(500), ...frames(6.1, 200, 6.1), ...frames(262, 520, 6.1)])
  assert.equal(r.stalls.length, 1)
  assert.ok(r.stalls[0].from <= 200 && r.stalls[0].to >= 262)
})

test('a jump whose first frame comes 70 ms after its input is a stall, from the input', () => {
  const r = analyzeFrames([frame(0), ...input(100, 160), frame(170), frame(176)])
  assert.deepEqual(r.stalls, [{ from: 100, to: 170, ms: 70, first: true }])
})

test('the first frame after an input is not held to 16.7 ms (input pipeline), only to 50', () => {
  const r = analyzeFrames([...input(100, 120), frame(125)])
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
  assert.deepEqual(r.inputToPaint.map((p) => p.ms), [25])
})

test('idle time is never demanded: a frame long after the view settled is not a gap', () => {
  const r = analyzeFrames([...input(0, 3), frame(6), frame(500), ...input(600, 603), frame(606)])
  assert.equal(r.longFrames, 0)
  assert.deepEqual(r.stalls, [])
})

test('a target that never paints fails, and so does one painted after 1 s', () => {
  const never = analyzeFrames([frame(0), ...input(10, null), frame(20)])
  assert.deepEqual(never.neverPainted.map((n) => n.at), [10])
  assert.equal(never.pass, false)
  const late = analyzeFrames([frame(0), ...input(10, 1200), frame(1205)])
  assert.equal(late.neverPainted.length, 1)
})

test('an input that changes nothing settles at its mark, with no frame to wait for', () => {
  const r = analyzeFrames([...input(0, 2, 'k'), frame(5), ...input(100, 102, 'k')])
  assert.deepEqual(r.neverPainted, [])
  assert.deepEqual(r.stalls, [])
})

test('the input timestamp maps onto the trace clock through its dispatch mark', () => {
  // Dispatched 40 ms after the input (a busy main thread): the demand starts at the input, so the stall shows.
  const r = analyzeFrames([frame(0), ...input(100, 145, 'x', 40), frame(160)])
  assert.deepEqual(r.stalls, [{ from: 100, to: 160, ms: 60, first: true }])
})

test('two display compositors are refused: the frames could belong to another window', () => {
  assert.throws(() => analyzeFrames([frame(0), { ...frame(5), tid: 3 }]), /one display compositor/)
})
