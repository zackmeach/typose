import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterAll, expect, it } from 'vitest'
import type * as Core from 'typose-node'
import type { Addon } from './dispatch'
import type { CapturedLocation, DebugStats } from '../shared/protocol'
import { makeDispatcher } from './dispatch'

interface Hooks {
  debugStats(): Pick<DebugStats, 'jobs' | 'tasks' | 'handles' | 'delayMs' | 'ledger'>
  setLimit(bytes: number): void
  savedStats(): { wrappers: number; wrapperBytes: number }
  savedRouteBytes(route: Core.SavedRoute): number
}
const core = createRequire(import.meta.url)('typose-node/hooks') as typeof Core & Hooks
core.setBudget(totalmem())
const dir = mkdtempSync(join(tmpdir(), 'typose-saved-hooks-'))
afterAll(() => { core.reserveCache(0); rmSync(dir, { recursive: true, force: true }) })
setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
const collect = async () => { gc(); await setImmediate(); gc(); await setImmediate() }
const heap = () => { const m = process.memoryUsage(); return m.heapUsed + m.external }
async function derived(name: string) {
  const sourcePath = join(dir, name + '.md'), targetPath = join(dir, name + '.txt')
  writeFileSync(sourcePath, '# Source\n')
  writeFileSync(targetPath, 'target\n')
  const source = core.Doc.open(sourcePath)
  await source.render(1, new core.Cancel())
  const target = source.openLocal(1, name + '.txt')
  source.close()
  return target
}
const windows = it.skipIf(process.platform !== 'win32')

windows('release drops route/root charges immediately while residual wrapper bytes stay paid until Drop', async () => {
  await collect()
  const before = core.debugStats(), wrappers = core.savedStats()
  let held: Core.SavedRoute[] = []
  const doc = await derived('release')
  held.push(doc.saveRoute(1))
  const routeBytes = core.savedRouteBytes(held[0])
  expect(routeBytes).toBeGreaterThan(0)
  doc.close()
  expect(core.debugStats().handles).toBe(before.handles + 1) // only the held capability root
  const paid = core.savedStats().wrapperBytes - wrappers.wrapperBytes
  expect(paid).toBeGreaterThan(0)
  expect(core.debugStats().ledger.used - before.ledger.used).toBe(routeBytes + paid)
  expect(held[0].release()).toBe(true)
  expect(core.debugStats().handles).toBe(before.handles)
  expect(core.savedRouteBytes(held[0])).toBe(0)
  await collect()
  expect(core.debugStats().ledger.used - before.ledger.used).toBe(paid)
  expect(() => held[0].open()).toThrow(expect.objectContaining({ code: 'NoDocument' })) // wrapper is still reachable
  held = []
  await collect()
  await expect.poll(() => core.savedStats().wrapperBytes).toBe(wrappers.wrapperBytes)
  expect(core.debugStats().ledger.used).toBe(before.ledger.used)
})

windows('low-budget capture/reopen refuse without losing route authority or leaking native document owners', async () => {
  await collect()
  const doc = await derived('budget')
  const initial = core.debugStats(), initialWrappers = core.savedStats()
  try {
    core.setLimit(initial.ledger.used)
    expect(() => doc.saveRoute(1)).toThrow(expect.objectContaining({ code: 'Memory' }))
    expect(core.debugStats().ledger.used).toBe(initial.ledger.used)
    expect(core.savedStats()).toEqual(initialWrappers)
  } finally { core.setLimit(initial.ledger.limit) }
  const saved = doc.saveRoute(1)
  doc.close()
  const retained = core.debugStats()
  try {
    core.setLimit(retained.ledger.used)
    expect(() => saved.open()).toThrow(expect.objectContaining({ code: 'Memory' }))
    expect(core.debugStats().handles).toBe(retained.handles)
    expect(core.debugStats().ledger.used).toBe(retained.ledger.used)
  } finally { core.setLimit(initial.ledger.limit) }
  const reopened = saved.open()
  reopened.close()
  saved.release()
})

windows('registered saved-open cancellation composes with the actual native flag and releases its unpublished document', async () => {
  await collect()
  const doc = await derived('cancel')
  const dispatch = makeDispatcher({ coreVersion: core.coreVersion, limits: core.limits, openDoc: () => doc,
    cancelFlag: () => new core.Cancel(), reserveCache: core.reserveCache }, 9, () => {})
  let id = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: id++, method, params })
  try {
    await call('open', { path: 'owned', count: 1, bytes: 100 })
    await expect.poll(() => core.debugStats().jobs).toBe(0)
    const reply = await call('captureLocation', { doc: 1, gen: 1 })
    if (!('result' in reply)) throw Error(JSON.stringify(reply))
    const location = reply.result as Extract<CapturedLocation, { kind: 'derived' }>
    const baseline = core.debugStats(), wrappers = core.savedStats()
    const opening = dispatch({ id: 1000, method: 'openSaved', params: { ticket: location.ticket, count: 1, bytes: 300 } })
    expect(await call('cancel', { id: 1000 })).toMatchObject({ result: true })
    expect(await opening).toMatchObject({ error: { code: 'Cancelled' } })
    await expect.poll(() => { const s = core.debugStats(); return [s.jobs, s.tasks, s.handles, s.ledger.used] })
      .toEqual([baseline.jobs, baseline.tasks, baseline.handles, baseline.ledger.used])
    expect(core.savedStats()).toEqual(wrappers)
    expect(await call('page', { doc: 1, gen: 1, lens: 'raw', start: 0, count: 1 })).toHaveProperty('result.items')
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 100 })).toMatchObject({ result: true })
    expect(await call('openSaved', { ticket: location.ticket, count: 1, bytes: 100 })).toHaveProperty('result.doc', 2)
    await call('close', { doc: 2 })
    await call('releaseSaved', { ticket: location.ticket })
  } finally { await call('close', { doc: 1 }); core.reserveCache(0) }
})

// A heap measurement: it needs a quiet machine, so CI leaves it to local runs.
for (const peakEntries of [1, 256]) it.skipIf(process.platform !== 'win32' || !!process.env.CI)(`fresh peak-${peakEntries} host measures churn before/after GC with stable accounting samples`, async () => {
  core.reserveCache(0)
  await collect()
  const doc = await derived('churn-' + peakEntries)
  const addon: Addon = { coreVersion: core.coreVersion, limits: core.limits, openDoc: () => doc,
    cancelFlag: () => new core.Cancel(), reserveCache: core.reserveCache }
  const dispatch = makeDispatcher(addon, 9, () => {})
  let request = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: request++, method, params })
  await call('open', { path: 'ignored-owned-document', count: 1, bytes: 0 })
  await expect.poll(() => core.debugStats().jobs).toBe(0)
  const capture = async () => {
    const reply = await call('captureLocation', { doc: 1, gen: 1 })
    if (!('result' in reply)) throw Error(JSON.stringify(reply))
    const location = reply.result as CapturedLocation
    if (location.kind !== 'derived') throw Error('expected derived')
    return location.ticket
  }
  // Warm this fresh host at peak one before baseline. The peak-one run never gets a large-table allowance.
  const viewTableBytes = core.debugStats().ledger.rendererCache
  for (let i = 0; i < 256; i++) await call('releaseSaved', { ticket: await capture() })
  await collect()
  expect(core.debugStats().ledger.rendererCache - viewTableBytes).toBe(3 * ((64 << 10) + (16 << 10)))
  const baseline = heap(), wrapperBase = core.savedStats().wrapperBytes
  let maxRise = 0, maxAllowance = 0, margin = Infinity, samples = 0
  const stable = () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const before = core.savedStats(), ledgerBefore = core.debugStats().ledger
      const currentHeap = heap()
      const after = core.savedStats(), ledgerAfter = core.debugStats().ledger
      if (before.wrapperBytes !== after.wrapperBytes || before.wrappers !== after.wrappers ||
        ledgerBefore.used !== ledgerAfter.used || ledgerBefore.rendererCache !== ledgerAfter.rendererCache) continue
      const hostBytes = ledgerAfter.rendererCache - viewTableBytes
      return { rise: Math.max(0, currentHeap - baseline), allowance: hostBytes + after.wrapperBytes - wrapperBase,
        wrappers: after, hostBytes }
    }
    throw Error('could not obtain stable contemporaneous heap/ledger/wrapper sample')
  }
  const sample = () => {
    const { rise, allowance } = stable()
    samples++
    maxRise = Math.max(maxRise, rise)
    maxAllowance = Math.max(maxAllowance, allowance)
    margin = Math.min(margin, allowance - rise)
    expect(rise).toBeLessThanOrEqual(allowance)
  }
  // Separately exercise actual backing-table growth; this cannot subsidize the independent peak-one test.
  const live = []
  for (let i = 0; i < peakEntries; i++) {
    live.push(await capture())
    if (i % 16 === 0) sample()
  }
  for (const ticket of live) await call('releaseSaved', { ticket })
  live.length = 0
  for (let i = 0; i < 4000; i++) {
    const ticket = await capture()
    await call('releaseSaved', { ticket })
    if (i % 16 === 0) sample() // no forced GC during churn; observe the actual pre-GC rises too
  }
  sample()
  const beforeGc = core.savedStats()
  await collect()
  const post = stable(), afterGc = post.wrappers, afterRise = post.rise, hostBytes = post.hostBytes
  expect(afterRise).toBeLessThanOrEqual(post.allowance)
  expect(hostBytes).toBe(3 * ((64 << 10) + (16 << 10) * peakEntries))
  // Retaining released wrappers must still exhaust the real ledger, even with just one logical ticket at a time.
  const held: Core.SavedRoute[] = []
  const stats = core.debugStats()
  let negativeControl = false
  try {
    core.setLimit(stats.ledger.used + 2 * (16 << 10) + 1024)
    held.push(doc.saveRoute(1)); held[0].release()
    held.push(doc.saveRoute(1)); held[1].release()
    expect(() => doc.saveRoute(1)).toThrow(expect.objectContaining({ code: 'Memory' }))
    negativeControl = true
    expect(core.debugStats().ledger.used).toBeLessThanOrEqual(core.debugStats().ledger.limit)
  } finally { core.setLimit(stats.ledger.limit); held.length = 0 }
  await call('close', { doc: 1 })
  await collect()
  console.log(JSON.stringify({ savedChurn: { iterations: 4000, peakEntries, samples, maxRise, maxAllowance, minMargin: margin,
    beforeGc, afterGc, postGcRise: afterRise, hostBytes, negativeControl } }))
  expect(core.debugStats().handles).toBe(0)
  core.reserveCache(0)
})
