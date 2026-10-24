// Plan §5's cold verdicts on synthetic batches: each case is the smallest batch that fails if the rule breaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coldVerdict } from './cold.mjs'

/** One restart's record: its launches, the first being the cold one. */
const restart = (...launches) => ({ key: 'cold:startup', samples: launches.map((l) => ({ valid: true, shellVisible: 150, openToUsable: 120, firstContent: 400, ...l })) })
const batch = (n, first = {}) => Array.from({ length: n }, () => restart(first))

test('five valid restarts under the budgets pass, judged on the worst', () => {
  const v = coldVerdict([...batch(4), restart({ shellVisible: 199.9, openToUsable: 149.9 })], 'win32')
  assert.equal(v.n, 5)
  assert.deepEqual([v.shellVisible.verdict, v.openToUsable.verdict, v.firstContent.verdict], ['pass', 'pass', 'informational'])
  assert.deepEqual([v.shellVisible.worst, v.openToUsable.worst], [199.9, 149.9])
})

test('one restart over a budget fails it: shell visible at 200 ms, first screen at 150 ms', () => {
  assert.equal(coldVerdict([...batch(4), restart({ shellVisible: 200 })], 'win32').shellVisible.verdict, 'fail')
  const slow = coldVerdict([...batch(4), restart({ openToUsable: 150 })], 'win32')
  assert.deepEqual([slow.shellVisible.verdict, slow.openToUsable.verdict], ['pass', 'fail'])
})

test('fewer than five valid restarts is pending, never a pass, and an invalid one is kept with its reason', () => {
  const v = coldVerdict([...batch(4), restart({ valid: false, reason: 'no presentation after the show' })], 'win32')
  assert.equal(v.n, 4)
  assert.deepEqual([v.shellVisible.verdict, v.openToUsable.verdict, v.firstContent.verdict], ['pending', 'pending', 'pending'])
  assert.deepEqual(v.invalid, ['no presentation after the show'])
})

test("a second launch after the same restart isn't cold: only each record's first counts", () => {
  const v = coldVerdict(Array.from({ length: 5 }, () => restart({}, { shellVisible: 900 })), 'win32')
  assert.equal(v.n, 5)
  assert.equal(v.shellVisible.worst, 150)
  assert.equal(v.shellVisible.verdict, 'pass')
})

test('an exit the test did not ask for fails the batch, whatever the timings (Z56)', () => {
  const v = coldVerdict([...batch(4), { ...restart({}), exits: ['pid 1 quit with {"code":1,"signal":null}'] }], 'win32')
  assert.deepEqual([v.shellVisible.verdict, v.openToUsable.verdict], ['fail', 'fail'])
})

test('on the Mac, shell visible is judged at 400 ms and the cold first screen is reported', () => {
  const v = coldVerdict([...batch(4), restart({ shellVisible: 399, openToUsable: 900 })], 'darwin')
  assert.deepEqual([v.shellVisible.threshold, v.shellVisible.verdict, v.openToUsable.verdict], [400, 'pass', 'reported'])
  assert.equal(coldVerdict([...batch(4), restart({ shellVisible: 400 })], 'darwin').shellVisible.verdict, 'fail')
})

test('other keys in the log are ignored', () => {
  assert.equal(coldVerdict([...batch(5), { key: 'warm:startup', samples: [{ valid: true, shellVisible: 9999 }] }], 'win32').shellVisible.worst, 150)
})
