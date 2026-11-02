import { expect, it, vi } from 'vitest'
import { limits } from 'typose-node'
import type { Cancel, Doc, Page } from 'typose-node'
import type { Opened, Response, SurfaceRef, ViewRef } from '../shared/protocol'
import { makeDispatcher } from './dispatch'

const first = { items: [] } as Page
function document() {
  const data = { generation: 1, format: 'markdown', size: 10, encoding: 'UTF-8', lines: 1, indexed: true, blank: false,
    cacheActive: true, page: vi.fn(async () => first), render: vi.fn(async () => ({ blocks: 1 })),
    setCacheActive: vi.fn((_gen: number, active: boolean) => { data.cacheActive = active }),
    startIndex: vi.fn(), close: vi.fn(), reload: vi.fn(() => { data.generation++ }) }
  return data
}
function setup() {
  const made: ReturnType<typeof document>[] = []
  const flags: { cancel: ReturnType<typeof vi.fn> }[] = []
  let charged = 0, ceiling = Number.MAX_SAFE_INTEGER
  const reserveCache = vi.fn((bytes: number) => { if (bytes > ceiling) return false; charged = bytes; return true })
  const openDoc = vi.fn(() => { const d = document(); made.push(d); return d as unknown as Doc })
  const dispatch = makeDispatcher({ limits, coreVersion: () => 'test', reserveCache, openDoc,
    cancelFlag: () => { const f = { cancel: vi.fn() }; flags.push(f); return f as unknown as Cancel } }, 7, () => {})
  let id = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: id++, method, params })
  const value = <T>(r: Response): T => { if ('error' in r) throw Error(JSON.stringify(r)); return r.result as T }
  const surface = async () => value<SurfaceRef>(await call('createSurface', {}))
  const open = async (owner: SurfaceRef, bytes: number) => value<Opened>(await call('open', { surface: owner, path: 'same.md', count: 1, bytes }))
  return { call, value, surface, open, made, flags, openDoc, reserveCache, paid: () => charged, limit: (n: number) => { ceiling = n } }
}
const view = (opened: Opened): ViewRef => { expect(opened.view).toBeDefined(); return opened.view! }

it('keeps independent same-path document and view owners additive through Reload', async () => {
  const s = setup(), left = await s.surface(), right = await s.surface()
  const a = await s.open(left, 100), b = await s.open(right, 200)
  expect(a.doc).not.toBe(b.doc)
  expect(s.openDoc).toHaveBeenCalledTimes(2)
  expect(s.made[0].cacheActive && s.made[1].cacheActive).toBe(true)
  expect(await s.call('render', { doc: b.doc, gen: b.gen })).toHaveProperty('result.blocks', 1)
  const before = s.paid()
  expect(await s.call('reserve', { view: view(a), bytes: 150 })).toMatchObject({ result: true })
  expect(s.paid()).toBe(before + 50)
  const reloaded = s.value<Opened>(await s.call('reload', { surface: left, doc: a.doc, count: 1, bytes: 180 }))
  expect(reloaded.gen).toBe(2)
  expect(s.made[1].cacheActive).toBe(true)
  expect(s.made[1].startIndex).toHaveBeenCalledTimes(1)
  expect(await s.call('deactivate', { view: view(a) })).toMatchObject({ result: true })
  expect(s.made[0].cacheActive && s.made[1].cacheActive).toBe(true)
  expect(await s.call('reserve', { view: view(b), bytes: 230 })).toMatchObject({ result: true })
})

it('refuses old A→B→A leases and doc/gen-only cleanup of an explicit surface document', async () => {
  const s = setup(), owner = await s.surface()
  const a = await s.open(owner, 100)
  await s.call('deactivate', { view: view(a) })
  const b = await s.open(owner, 200)
  await s.call('deactivate', { view: view(b) })
  const nextA = s.value<Opened>(await s.call('activate', { surface: owner, doc: a.doc, gen: a.gen, count: 1, bytes: 110 }))
  expect(view(nextA).id).not.toBe(view(a).id)
  const paid = s.paid()
  s.reserveCache.mockClear()
  expect(await s.call('reserve', { view: view(a), bytes: 1 })).toMatchObject({ result: false })
  expect(await s.call('deactivate', { view: view(a) })).toMatchObject({ result: false })
  expect(await s.call('reserve', { doc: a.doc, gen: 1, bytes: 1 })).toMatchObject({ result: false })
  expect(await s.call('deactivate', { doc: a.doc, gen: 1 })).toMatchObject({ result: false })
  expect(await s.call('close', { doc: a.doc })).toMatchObject({ error: { code: 'Stale' } })
  expect(s.reserveCache).not.toHaveBeenCalled()
  expect(s.paid()).toBe(paid)
  expect(s.made[0].cacheActive).toBe(true)
})

it('holds a closed surface pending candidate charge until unwind without closing the other card', async () => {
  const s = setup(), left = await s.surface(), right = await s.surface()
  const a = await s.open(left, 100)
  let finish!: (p: Page) => void
  s.openDoc.mockImplementationOnce(() => { const d = document(); d.page.mockImplementationOnce(() => new Promise<Page>((ok) => { finish = ok })); s.made.push(d); return d as unknown as Doc })
  const opening = s.call('open', { surface: right, path: 'pending.md', count: 1, bytes: 300 })
  const paid = s.paid(), pendingFlag = s.flags.at(-1)!
  expect(await s.call('releaseSurface', { surface: right, retiredBytes: 0 })).toMatchObject({ result: true })
  expect(s.paid()).toBe(paid)
  expect(pendingFlag.cancel).toHaveBeenCalledOnce()
  finish(first)
  expect(await opening).toMatchObject({ error: { code: expect.stringMatching(/Stale|Cancelled/) } })
  expect(s.paid()).toBe(paid - 300)
  expect(s.made[1].close).toHaveBeenCalledOnce()
  expect(s.made[1].startIndex).not.toHaveBeenCalled()
  expect(s.made[0].close).not.toHaveBeenCalled()
  expect(await s.call('reserve', { view: view(a), bytes: 100 })).toMatchObject({ result: true })
})

it('refuses additive split pressure without opening or changing the source', async () => {
  const s = setup(), left = await s.surface(), right = await s.surface()
  const a = await s.open(left, 100)
  const baseline = s.paid()
  s.limit(baseline + 199)
  s.openDoc.mockClear()
  expect(await s.call('open', { surface: right, path: 'next.md', count: 1, bytes: 200 })).toMatchObject({ error: { code: 'Memory' } })
  expect(s.paid()).toBe(baseline)
  expect(s.openDoc).not.toHaveBeenCalled()
  expect(s.made[0].cacheActive).toBe(true)
  expect(await s.call('reserve', { view: view(a), bytes: 100 })).toMatchObject({ result: true })
})

it('moves an inactive document without reopening/index restart and rejects old-owner destructive calls', async () => {
  const s = setup(), left = await s.surface(), right = await s.surface()
  const a = await s.open(left, 100)
  expect(await s.call('transferDoc', { from: left, to: right, doc: a.doc, gen: a.gen })).toMatchObject({ error: { code: 'Refused' } })
  await s.call('reserveWorkspace', { bytes: 100 })
  await s.call('deactivate', { view: view(a) })
  expect(await s.call('transferDoc', { from: left, to: right, doc: a.doc, gen: a.gen })).toMatchObject({ result: true })
  expect(await s.call('close', { surface: left, doc: a.doc })).toMatchObject({ error: { code: 'Stale' } })
  expect(await s.call('releaseSurface', { surface: left, retiredBytes: 100 })).toMatchObject({ result: true })
  const activated = s.value<Opened>(await s.call('activate', { surface: right, doc: a.doc, gen: a.gen, count: 1, bytes: 100 }))
  expect(activated.doc).toBe(a.doc)
  expect(s.openDoc).toHaveBeenCalledTimes(1)
  expect(s.made[0].startIndex).toHaveBeenCalledTimes(1)
  expect(s.made[0].close).not.toHaveBeenCalled()
})

it('requires retirement precharge and releases closed-card live shares without accumulating full budgets', async () => {
  const s = setup(), left = await s.surface()
  const a = await s.open(left, 100)
  let right = await s.surface(), b = await s.open(right, 200)
  expect(await s.call('releaseSurface', { surface: right, retiredBytes: 200 })).toMatchObject({ error: { code: 'Memory' } })
  expect(s.made[1].close).not.toHaveBeenCalled()
  await s.call('reserveWorkspace', { bytes: 300 })
  const before = s.paid()
  expect(await s.call('releaseSurface', { surface: right, retiredBytes: 200 })).toMatchObject({ result: true })
  const baseline = s.paid()
  expect(baseline).toBe(before - 200)
  const old = right
  for (let n = 0; n < 3; n++) {
    right = await s.surface(); b = await s.open(right, 200)
    expect(s.paid()).toBe(baseline + 200)
    expect(await s.call('releaseSurface', { surface: old, retiredBytes: 200 })).toMatchObject({ result: false })
    expect(await s.call('reserve', { view: view(b), bytes: 200 })).toMatchObject({ result: true })
    await s.call('releaseSurface', { surface: right, retiredBytes: 200 })
    expect(s.paid()).toBe(baseline)
  }
  expect(s.made[0].close).not.toHaveBeenCalled()
  expect(await s.call('reserve', { view: view(a), bytes: 100 })).toMatchObject({ result: true })
})

it('unwinds only a superseded pending share when its newer open failed, preserving the mounted source', async () => {
  const s = setup(), owner = await s.surface()
  const a = await s.open(owner, 100)
  let finish!: (p: Page) => void
  const target = document()
  target.page.mockImplementationOnce(() => new Promise<Page>((ok) => { finish = ok }))
  s.openDoc.mockReturnValueOnce(target as unknown as Doc)
  const older = s.call('open', { surface: owner, path: 'old.md', count: 1, bytes: 300 })
  s.openDoc.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'NotFound' }) })
  expect(await s.call('open', { surface: owner, path: 'new.md', count: 1, bytes: 200 })).toMatchObject({ error: { code: 'NotFound' } })
  const before = s.paid()
  finish(first)
  expect(await older).toMatchObject({ result: { reserved: 0 } })
  expect(s.paid()).toBe(before - 300)
  expect(target.cacheActive).toBe(false)
  expect(target.startIndex).toHaveBeenCalledOnce()
  expect(s.made[0].cacheActive).toBe(true)
  expect(await s.call('reserve', { view: view(a), bytes: 100 })).toMatchObject({ result: true })
})
