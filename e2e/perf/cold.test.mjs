// Plan §5's cold verdicts on synthetic batches: each case is the smallest batch that fails if the rule breaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coldVerdict } from './cold.mjs'

const BUILD = { exe: 'e1', asar: 'a1' }
let boots = 0
/** One restart's record: its launches, the first being the cold one, on BUILD, each after its own boot (an hour apart). */
const restart = (...launches) => ({
  key: 'cold:startup',
  build: BUILD,
  boot: new Date(Date.UTC(2026, 9, 24) + ++boots * 3_600_000).toISOString(),
  samples: launches.map((l) => ({ valid: true, shellVisible: 150, openToUsable: 120, firstContent: 400, ...l }))
})
const batch = (n, first = {}) => Array.from({ length: n }, () => restart(first))

test('five valid restarts under the budgets pass, judged on the worst', () => {
  const v = coldVerdict([...batch(4), restart({ shellVisible: 399.9, openToUsable: 149.9 })], 'win32')
  assert.equal(v.n, 5)
  assert.deepEqual([v.shellVisible.verdict, v.openToUsable.verdict, v.firstContent.verdict], ['pass', 'pass', 'informational'])
  assert.deepEqual([v.shellVisible.worst, v.openToUsable.worst], [399.9, 149.9])
})

test('one restart over a budget fails it: shell visible at 400 ms (Z67), first screen at 150 ms', () => {
  assert.equal(coldVerdict([...batch(4), restart({ shellVisible: 400 })], 'win32').shellVisible.verdict, 'fail')
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

test("a batch is one build's restarts: records from an earlier build don't count", () => {
  // The reviewer's case: four restarts recorded against an earlier build, then one on the build being judged.
  const old = batch(4).map((r) => ({ ...r, build: { exe: 'e0', asar: 'a1' } }))
  const v = coldVerdict([...old, restart({})], 'win32')
  assert.deepEqual([v.n, v.shellVisible.verdict], [1, 'pending'])
  // The asar alone differing is another build too.
  assert.equal(coldVerdict([...batch(4).map((r) => ({ ...r, build: { exe: 'e1', asar: 'a0' } })), restart({})], 'win32').n, 1)
})

test('a batch counts one record per boot: a second COLD run after the same restart is left out', () => {
  // The reviewer's case: five records, two of them from one boot (their boot times 15 s apart, as uptime reads them).
  const [a, b, c, d] = batch(4)
  const again = { ...restart({ shellVisible: 190 }), boot: new Date(Date.parse(a.boot) + 15_000).toISOString() }
  const v = coldVerdict([a, again, b, c, d], 'win32')
  assert.deepEqual([v.n, v.shellVisible.verdict, v.shellVisible.worst], [4, 'pending', 150])
})

test("a record without a build or a boot can't be placed in a batch, so it isn't counted", () => {
  const { build: _b, ...noBuild } = restart({})
  const { boot: _t, ...noBoot } = restart({})
  assert.equal(coldVerdict([noBuild, noBoot, ...batch(3), restart({})], 'win32').n, 4)
})

test('other keys in the log are ignored', () => {
  assert.equal(coldVerdict([...batch(5), { key: 'warm:startup', samples: [{ valid: true, shellVisible: 9999 }] }], 'win32').shellVisible.worst, 150)
})
