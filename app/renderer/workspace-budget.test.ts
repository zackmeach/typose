import { expect, it } from 'vitest'
import { WorkspaceBudget, workspaceCharge } from './workspace-budget'

function pending() {
  let resolve!: (granted: boolean) => void
  const promise = new Promise<boolean>((done) => { resolve = done })
  return { promise, resolve }
}

it('pays a persistent maximum until the last tab is removed and carries its peak across sessions', async () => {
  const calls: number[] = []
  const core = { call: async (_: 'reserveWorkspace', p: { bytes: number }) => { calls.push(p.bytes); return true } }
  const bank = new WorkspaceBudget(core, 1)
  expect(await bank.hold(8, 1000)).toBe(true)
  const large = bank.snapshot()
  expect(await bank.hold(1, 20)).toBe(true)
  expect(bank.snapshot()).toEqual(large)
  expect(calls).toEqual([3 * workspaceCharge(8, 1000)])
  expect(await bank.release()).toBe(true)
  expect(bank.snapshot().held).toBe(0)
  const next = new WorkspaceBudget(core, 2, large.peakBytes)
  expect(await next.hold(1, 20)).toBe(true)
  expect(next.snapshot().held).toBe(large.held)
})

it('does not record a refused growth as a paid peak', async () => {
  let granted = false
  const bank = new WorkspaceBudget({ call: async () => granted }, 1)
  expect(await bank.hold(100, 1000)).toBe(false)
  expect(bank.snapshot()).toMatchObject({ held: 0, peakBytes: 0 })
  granted = true
  expect(await bank.hold(1, 1)).toBe(true)
  expect(bank.snapshot().held).toBe(3 * workspaceCharge(1, 1))
})

it('serializes two new publications without losing their larger share', async () => {
  const first = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => {
    calls.push(p.bytes)
    return calls.length === 1 ? first.promise : Promise.resolve(true)
  } }, 1)
  const a = bank.hold(1, 1)
  const b = bank.hold(2, 20)
  await Promise.resolve()
  expect(calls).toHaveLength(1)
  first.resolve(true)
  expect(await a).toBe(true)
  expect(await b).toBe(true)
  expect(calls).toEqual([3 * workspaceCharge(1, 1), 3 * workspaceCharge(2, 20)])
})

it('last-close bypasses a delayed old grant and that grant cannot publish after a new open', async () => {
  const old = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => {
    calls.push(p.bytes)
    return calls.length === 1 ? old.promise : Promise.resolve(true)
  } }, 1)
  const earlier = bank.hold(20, 200)
  await Promise.resolve()
  expect(await bank.release()).toBe(true)
  expect(await bank.hold(1, 10)).toBe(true)
  const current = bank.snapshot()
  old.resolve(true)
  expect(await earlier).toBe(false)
  expect(bank.snapshot()).toEqual(current)
  expect(calls).toEqual([3 * workspaceCharge(20, 200), 0, 3 * workspaceCharge(1, 10)])
})

it('a delayed zero response cannot erase a reopened workspace allowance', async () => {
  const zero = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => {
    calls.push(p.bytes)
    return p.bytes === 0 ? zero.promise : Promise.resolve(true)
  } }, 1)
  await bank.hold(1, 10)
  const closing = bank.release()
  expect(await bank.hold(1, 10)).toBe(true) // must send another grant even though the old acknowledged number matches
  const reopened = bank.snapshot()
  zero.resolve(true)
  await closing
  expect(bank.snapshot()).toEqual(reopened)
  expect(calls).toEqual([reopened.held, 0, reopened.held])
})

it('last-close bypasses old queued grants before the DOM is ready to release its existing allowance', async () => {
  const old = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => {
    calls.push(p.bytes)
    return calls.length === 2 ? old.promise : Promise.resolve(true)
  } }, 1)
  await bank.hold(1, 10)
  const earlier = bank.hold(2, 20)
  const queued = bank.hold(3, 30)
  await Promise.resolve()
  bank.cancelPending()
  expect(await bank.hold(1, 10)).toBe(true)
  expect(bank.snapshot().held).toBe(3 * workspaceCharge(2, 20)) // held old path remains paid until its reply unwinds
  expect(calls).not.toContain(0) // existing DOM remains paid until its independent removal commit
  old.resolve(true)
  expect(await earlier).toBe(false)
  expect(await queued).toBe(false)
  expect(calls).toHaveLength(3)
})

it('retries another card from the fresh aggregate after a pending workspace grant is cancelled', async () => {
  const old = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => {
    calls.push(p.bytes)
    return calls.length === 1 ? old.promise : Promise.resolve(true)
  } }, 1)
  const closingCard = bank.hold(4, 40)
  const otherCard = bank.hold(3, 30)
  await Promise.resolve()
  const beforeCancel = bank.reservationEpoch
  bank.cancelPending()
  expect(bank.reservationEpoch).toBe(beforeCancel + 1)

  const retry = bank.hold(5, 50) // recomputed aggregate includes the other card and current tabs
  expect(await retry).toBe(true)
  const committed = bank.snapshot()
  expect(committed.peakBytes).toBe(workspaceCharge(5, 50))
  old.resolve(true)
  expect(await closingCard).toBe(false)
  expect(await otherCard).toBe(false)
  expect(bank.snapshot()).toEqual(committed)
  expect(calls).toEqual([3 * workspaceCharge(4, 40), 3 * workspaceCharge(5, 50)])
})

it('core death invalidates old grants without a zero RPC into the next session', async () => {
  const reply = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => { calls.push(p.bytes); return reply.promise } }, 1)
  const holding = bank.hold(1, 10)
  await Promise.resolve()
  bank.invalidate()
  expect(await bank.release()).toBe(false)
  expect(await bank.hold(1, 10)).toBe(false)
  reply.resolve(true)
  expect(await holding).toBe(false)
  expect(calls).toHaveLength(1)
  expect(bank.snapshot().peakBytes).toBe(workspaceCharge(1, 10)) // the interrupted request's retained graph must be recharged
})

it('refuses unsafe sizes before contacting the core', async () => {
  let calls = 0
  const bank = new WorkspaceBudget({ call: async () => { calls++; return true } }, 1)
  for (const [count, units] of [[-1, 0], [1.5, 0], [1, Infinity], [1, Number.MAX_SAFE_INTEGER], [0, 1]])
    expect(await bank.hold(count, units)).toBe(false)
  expect(calls).toBe(0)
})

// A zero charge is another card's (or the window's) aggregate with nothing in it, computed before this open publishes.
it("a zero charge does not cancel another card's queued open", async () => {
  const grant = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => { calls.push(p.bytes); return calls.length === 1 ? grant.promise : Promise.resolve(true) } }, 1)
  const open = bank.hold(1, 10)
  await Promise.resolve()
  expect(await bank.hold(0, 0)).toBe(true)
  grant.resolve(true)
  expect(await open).toBe(true)
  expect(bank.snapshot()).toMatchObject({ held: 3 * workspaceCharge(1, 10), settled: true })
  expect(calls).toEqual([3 * workspaceCharge(1, 10)])
})

it('a zero charge does not cancel a hold still waiting behind another', async () => {
  const grant = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => { calls.push(p.bytes); return calls.length === 1 ? grant.promise : Promise.resolve(true) } }, 1)
  const a = bank.hold(1, 10)
  const b = bank.hold(2, 20)
  await Promise.resolve()
  expect(await bank.hold(0, 0)).toBe(true)
  grant.resolve(true)
  expect([await a, await b]).toEqual([true, true])
  expect(calls).toEqual([3 * workspaceCharge(1, 10), 3 * workspaceCharge(2, 20)])
  expect(bank.snapshot().held).toBe(3 * workspaceCharge(2, 20))
})

it("a zero charge after an open's grant leaves it held until the explicit release", async () => {
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: async (_, p) => { calls.push(p.bytes); return true } }, 1)
  expect(await bank.hold(1, 10)).toBe(true) // granted; its tab is not published yet
  expect(await bank.hold(0, 0)).toBe(true)
  expect(bank.snapshot().held).toBe(3 * workspaceCharge(1, 10))
  expect(await bank.release()).toBe(true)
  expect(calls).toEqual([3 * workspaceCharge(1, 10), 0])
})

it("an open after a zero charge's release supersedes it, and the zero charge's retry keeps the open paid", async () => {
  const zero = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => { calls.push(p.bytes); return p.bytes === 0 ? zero.promise : Promise.resolve(true) } }, 1)
  const epoch = bank.reservationEpoch
  const releasing = bank.hold(0, 0)
  expect(await bank.hold(1, 10)).toBe(true)
  zero.resolve(true)
  expect(await releasing).toBe(false) // superseded; App retries once because the epoch moved
  expect(bank.reservationEpoch).not.toBe(epoch)
  expect(await bank.hold(0, 0)).toBe(true)
  expect(calls).toEqual([0, 3 * workspaceCharge(1, 10)])
  expect(bank.snapshot()).toMatchObject({ held: 3 * workspaceCharge(1, 10), peakBytes: workspaceCharge(1, 10), settled: true })
})

it('a zero charge while a last-close unwinds old grants defers to the explicit release', async () => {
  const old = pending()
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: (_, p) => { calls.push(p.bytes); return calls.length === 2 ? old.promise : Promise.resolve(true) } }, 1)
  await bank.hold(1, 10)
  const other = bank.hold(2, 20) // another card's open, waiting on its grant
  await Promise.resolve()
  bank.cancelPending() // last tab closed in this card
  expect(await bank.hold(0, 0)).toBe(true)
  expect(calls).not.toContain(0)
  expect(await bank.release()).toBe(true)
  old.resolve(true)
  expect(await other).toBe(false)
  expect(bank.snapshot()).toMatchObject({ held: 0, peakBytes: 0 })
  expect(calls).toEqual([3 * workspaceCharge(1, 10), 3 * workspaceCharge(2, 20), 0])
})

it('a zero charge on an idle bank still releases the peak carried from the last session', async () => {
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: async (_, p) => { calls.push(p.bytes); return true } }, 2, workspaceCharge(4, 40))
  expect(await bank.hold(0, 0)).toBe(true)
  expect(calls).toEqual([0])
  expect(bank.snapshot()).toMatchObject({ held: 0, peakBytes: 0 })
})

it('a refused open still fails beside a zero charge, and a later open still pays', async () => {
  let granted = false
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: async (_, p) => { calls.push(p.bytes); return p.bytes === 0 || granted } }, 1)
  const open = bank.hold(1, 10)
  expect(await bank.hold(0, 0)).toBe(true)
  expect(await open).toBe(false)
  expect(bank.snapshot()).toMatchObject({ held: 0, peakBytes: 0 })
  granted = true
  expect(await bank.hold(1, 10)).toBe(true)
  expect(bank.snapshot().held).toBe(3 * workspaceCharge(1, 10))
})

// The count of holds under way returns to zero when one settles: else no zero charge would release the bank again.
it('after a refused open settles, a zero charge on the idle bank releases the carried peak', async () => {
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: async (_, p) => { calls.push(p.bytes); return p.bytes === 0 } }, 2, workspaceCharge(4, 40))
  expect(await bank.hold(1, 10)).toBe(false)
  expect(await bank.hold(0, 0)).toBe(true)
  expect(calls.at(-1)).toBe(0)
  expect(bank.snapshot()).toMatchObject({ held: 0, peakBytes: 0 })
})

it('retains charged history and pending page bytes after the last document closes', async () => {
  const calls: number[] = []
  const bank = new WorkspaceBudget({ call: async (_, p) => { calls.push(p.bytes); return true } }, 1)
  expect(await bank.hold(0, 0, 8 << 20)).toBe(true)
  expect(bank.snapshot().held).toBe(3 * ((6 << 20) + (8 << 20)))
  expect(await bank.release()).toBe(true)
  expect(calls.at(-1)).toBe(0)
})
