import { expect, it } from 'vitest'
import { LensBudget } from './lens-budget'

it('keeps worker model and mounted UI charges additive and releases a locked/disposed model', async () => {
  const budget = new LensBudget({ call: async () => true }, 1, 1, 1, 10, 10)
  await budget.reserveModel(1, 100)
  await budget.reserveGrid(1, 32)
  expect(budget.snapshot()).toMatchObject({ model: 100, grid: 32, total: 142 })
  await budget.reserveGrid(1, 16)
  expect(budget.snapshot()).toMatchObject({ model: 100, grid: 32, total: 142 })
  await budget.reserveModel(1, 0)
  expect(budget.snapshot().total).toBe(42)
})

function pending() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => { resolve = done })
  return { promise, resolve }
}

it('serializes Raw and Rendered requests and commits only confirmed shares', async () => {
  const calls: { doc: number; gen: number; bytes: number }[] = []
  const replies = [pending(), pending()]
  const core = { call: (_: 'reserve', params: { doc: number; gen: number; bytes: number }) => {
    calls.push(params)
    return replies[calls.length - 1].promise
  } }
  const budget = new LensBudget(core, 1, 7, 1, 10, 10)
  const raw = budget.reserveRaw(1, 20)
  const rendered = budget.reserveRendered(1, 30)
  await Promise.resolve()
  expect(calls).toEqual([{ doc: 7, gen: 1, bytes: 20 }])
  expect(budget.rawReserved).toBe(10)
  replies[0].resolve(true)
  await raw
  await Promise.resolve()
  expect(calls[1]).toEqual({ doc: 7, gen: 1, bytes: 50 })
  expect(budget.snapshot()).toMatchObject({ raw: 20, rendered: 0, total: 20 })
  replies[1].resolve(false)
  expect(await rendered).toBe(false)
  expect(budget.snapshot()).toMatchObject({ raw: 20, rendered: 0, total: 20 })
})

it('a Raw resize or shrink cannot erase the retained Rendered share', async () => {
  const totals: number[] = []
  const budget = new LensBudget({ call: async (_, p) => { totals.push(p.bytes); return true } }, 1, 1, 1, 10, 10)
  await budget.reserveRendered(1, 100)
  await budget.reserveRaw(1, 20)
  await budget.reserveRaw(1, 5)
  expect(totals).toEqual([110, 120, 105])
  expect(budget.snapshot()).toMatchObject({ raw: 5, rendered: 100, total: 105 })
})

it('simultaneous image leases add, survive lens switches, and enter the retired allowance once', async () => {
  const totals: number[] = []
  const budget = new LensBudget({ call: async (_, p) => { totals.push(p.bytes); return true } }, 1, 1, 1, 10, 10)
  await budget.reserveRendered(1, 100)
  expect(await Promise.all([budget.growRendered(1, 20), budget.growRendered(1, 30)])).toEqual([true, true])
  await budget.reserveRaw(1, 5)
  await budget.ensureRendered(1, 100)
  expect(totals).toEqual([110, 130, 160, 155])
  expect(budget.snapshot().rendered).toBe(150)
  expect(budget.reloadReservation(10).bytes).toBe(310)
})

it('a generation change bypasses an old pending response without letting it alter new shares', async () => {
  const old = pending()
  const calls: { doc: number; gen: number; bytes: number }[] = []
  const budget = new LensBudget({ call: (_, p) => {
    const gen = 'view' in p ? p.view.gen : p.gen
    const doc = 'view' in p ? p.view.doc : p.doc
    calls.push({ doc, gen, bytes: p.bytes })
    return gen === 1 ? old.promise : Promise.resolve(true)
  } }, 4, 1, 1, 10, 10)
  const earlier = budget.reserveRendered(1, 30)
  await Promise.resolve()
  const plan = budget.reloadReservation(15)
  expect(budget.adopt(2, 40, plan)).toBe(true)
  expect(await budget.reserveRendered(2, 35)).toBe(true)
  expect(calls).toEqual([{ doc: 1, gen: 1, bytes: 40 }, { doc: 1, gen: 2, bytes: 50 }])
  old.resolve(true)
  expect(await earlier).toBe(false)
  expect(budget.snapshot()).toEqual({ generation: 2, raw: 15, rendered: 35, grid: 0, retired: 0, total: 50 })
  expect(await budget.reserveRaw(1, 900)).toBe(false)
  expect(budget.adopt(3, 1000, plan)).toBe(false)
})

it('freezes image growth before a transition snapshots the retired tree, including an in-flight grant', async () => {
  const delayed = pending()
  let delay = false
  const budget = new LensBudget({ call: async () => delay ? delayed.promise : true }, 1, 1, 1, 10, 10)
  await budget.reserveRendered(1, 100)
  delay = true
  const growing = budget.growRendered(1, 50)
  await Promise.resolve()
  const plan = budget.reloadReservation(10)
  delayed.resolve(true)
  expect(await growing).toBe(false)
  expect(await budget.growRendered(1, 30)).toBe(false)
  expect(plan.retiredTreeMax).toBe(100)
  expect(budget.snapshot().rendered).toBe(100)
  budget.cancelTransition(plan)
  delay = false
  expect(await budget.growRendered(1, 30)).toBe(true)
  expect(budget.snapshot().rendered).toBe(130)
})

it('repeated Reload keeps Raw and the maximum retired tree separate, with bounded totals', async () => {
  const budget = new LensBudget({ call: async () => true }, 1, 1, 1, 10, 10)
  await budget.reserveRendered(1, 100)
  for (let gen = 2; gen <= 6; gen++) {
    const plan = budget.reloadReservation(10)
    expect(plan.bytes).toBe(210)
    expect(budget.adopt(gen, budget.snapshot().total, plan)).toBe(true)
    expect(budget.rawReserved).toBe(10)
    await budget.reserveRendered(gen, 100)
    expect(budget.retiredTreeMax).toBe(100)
    expect(budget.snapshot()).toEqual({ generation: gen, raw: 10, rendered: 100, grid: 0, retired: 200, total: 310 })
  }
  budget.invalidate()
  expect(await budget.reserveRaw(6, 50)).toBe(false)
})

it('a replacement carries the maximum Rendered allowance separately from Raw through resize and Reload', async () => {
  const totals: number[] = []
  const budget = new LensBudget({ call: async (_, p) => { totals.push(p.bytes); return true } }, 2, 1, 1, 10, 210, 100)
  expect(budget.snapshot()).toEqual({ generation: 1, raw: 10, rendered: 0, grid: 0, retired: 200, total: 210 })
  await budget.reserveRaw(1, 5)
  await budget.reserveRendered(1, 30)
  const plan = budget.reloadReservation(10)
  expect(plan.bytes).toBe(210)
  expect(budget.adopt(2, 235, plan)).toBe(true)
  await budget.reserveRaw(2, 5)
  expect(totals).toEqual([205, 235, 205])
  expect(budget.snapshot()).toEqual({ generation: 2, raw: 5, rendered: 0, grid: 0, retired: 200, total: 205 })
})

it('Grid peak stays paid through Raw switches and a refused Reload, then enters retirement on adoption', async () => {
  const totals: number[] = []
  const budget = new LensBudget({ call: async (_, p) => { totals.push(p.bytes); return true } }, 1, 4, 1, 10, 10)
  await budget.reserveGrid(1, 80)
  await budget.reserveRaw(1, 15)
  await budget.reserveGrid(1, 20)
  expect(budget.snapshot()).toMatchObject({ raw: 15, grid: 80, total: 95 })
  const refused = budget.reloadReservation(20)
  expect(refused.bytes).toBe(180)
  budget.cancelTransition(refused)
  expect(budget.snapshot()).toMatchObject({ grid: 80, total: 95 })
  await budget.reserveRaw(1, 10)
  const next = budget.reloadReservation(20)
  expect(budget.adopt(2, next.bytes, next)).toBe(true)
  expect(budget.snapshot()).toMatchObject({ raw: 20, grid: 0, retired: 160, total: 180 })
  await budget.reserveGrid(2, 60)
  expect(budget.snapshot()).toMatchObject({ raw: 20, grid: 60, retired: 160, total: 240 })
  expect(totals).toEqual([90, 95, 90, 240])
})

it('Find has an independent charged share and retires with the replaced view', async () => {
  const totals: number[] = []
  const budget = new LensBudget({ call: async (_, params) => { totals.push(params.bytes); return true } }, 1, 1, 1, 10, 10)
  expect(await budget.reserveSearch(1, 40)).toBe(true)
  await budget.reserveRaw(1, 20)
  await budget.reserveRendered(1, 30)
  expect(budget.snapshot()).toMatchObject({ raw: 20, rendered: 30, search: 40, total: 90 })
  const transition = budget.reloadReservation(10)
  expect(transition.bytes).toBe(150)
  expect(await budget.reserveSearch(1, 0)).toBe(false)
  budget.cancelTransition(transition)
  await budget.reserveSearch(1, 0)
  expect(budget.snapshot().total).toBe(50)
  expect(totals).toEqual([50, 60, 90, 50])
})

it('large copies reserve a transient share, release it, and retire only while buffers are pending', async () => {
  const totals: number[] = []
  const budget = new LensBudget({ call: async (_, params) => { totals.push(params.bytes); return true } }, 1, 1, 1, 20, 20)
  await budget.reserveGrid(1, 100)
  expect(await budget.reserveCopy(1, 12 << 20)).toBe(true)
  expect(budget.snapshot()).toMatchObject({ grid: 100, copy: 12 << 20, total: 20 + 100 + (12 << 20) })
  expect(await budget.reserveCopy(1, 13 << 20)).toBe(true)
  expect(budget.snapshot().total).toBe(20 + 100 + (13 << 20))
  expect(await budget.reserveCopy(1, 0)).toBe(true)
  expect(budget.snapshot().total).toBe(120)
  expect(await budget.reserveCopy(1, 13 << 20)).toBe(true)
  expect(budget.reloadReservation(20).retiredTreeMax).toBe(100 + (13 << 20))
  expect(await budget.reserveCopy(1, 0)).toBe(false)
  const next = budget.reloadReservation(20)
  expect(budget.adopt(2, next.bytes, next)).toBe(true)
  expect(budget.snapshot()).toMatchObject({ grid: 0, retired: 2 * (100 + (13 << 20)) })
  expect(budget.snapshot()).not.toHaveProperty('copy')
  expect(totals).toEqual([120, 20 + 100 + (12 << 20), 20 + 100 + (13 << 20), 120, 20 + 100 + (13 << 20)])
})
