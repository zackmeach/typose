import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { limits } from 'typose-node'
import type { Cancel, Doc, Page } from 'typose-node'
import type { CapturedLocation, Response, SavedTicket } from '../shared/protocol'
import { type Addon, makeDispatcher } from './dispatch'

const nativeError = (code: string) => Object.assign(new Error(code), { code })
const first = { items: [] } as Page
// One compatibility surface, one live view and one candidate slot retain their paid table capacity.
const surfaceTable = 3 * ((64 << 10) + 4096 + 2 * 1024)
function deferred() {
  let resolve!: (page: Page) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Page>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve: () => resolve(first), reject }
}
function document(localOnly = false) {
  return { generation: 1, localOnly, path: localOnly ? 'C:\\docs\\target.txt' : 'C:\\owned\\manual.md', format: 'text',
    size: 3, encoding: 'UTF-8', lines: 1, indexed: true, blank: false,
    page: vi.fn(async () => first), startIndex: vi.fn(), close: vi.fn(), setCacheActive: vi.fn(),
    saveRoute: vi.fn(), openLocal: vi.fn(), reload: vi.fn() }
}
function setup(source = document(), id: () => string = randomUUID) {
  const flags: { cancel: ReturnType<typeof vi.fn> }[] = []
  const reserveCache = vi.fn(() => true)
  const openDoc = vi.fn(() => source as unknown as Doc)
  const cancelFlag = vi.fn(() => { const flag = { cancel: vi.fn() }; flags.push(flag); return flag as unknown as Cancel })
  const addon: Addon = { limits, coreVersion: () => 'test', openDoc, reserveCache, cancelFlag }
  const emit = vi.fn()
  const dispatch = makeDispatcher(addon, 7, emit, id)
  let next = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: next++, method, params })
  const open = () => call('open', { path: 'caller-display.md', count: 1, bytes: 100 })
  return { call, dispatch, flags, reserveCache, openDoc, open, source, cancelFlag, emit }
}
function route(target = document(true)) {
  const resource = { open: vi.fn(() => target as unknown as Doc), release: vi.fn(() => true) }
  return { target, resource }
}
function ticket(response: Response): SavedTicket {
  expect(response).toHaveProperty('result.kind', 'derived')
  const result = (response as { result: CapturedLocation }).result
  if (result.kind !== 'derived') throw Error('expected derived location')
  return result.ticket
}

describe('saved-location authority and accounting', () => {
  it('returns the owned manual path, regardless of caller origin flags or optional route availability', async () => {
    const s = setup()
    await s.open()
    expect(await s.call('captureLocation', { doc: 1, gen: 1, kind: 'derived', localOnly: true, path: 'attacker.txt' }))
      .toMatchObject({ result: { kind: 'manual', path: s.source.path } })
    expect(s.source.saveRoute).not.toHaveBeenCalled()
    expect(await s.call('captureLocation', { doc: 1, gen: 2 })).toMatchObject({ error: { code: 'Stale' } })
    await s.call('close', { doc: 1 })
    expect(await s.call('captureLocation', { doc: 1, gen: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
  })

  it('retains derived TXT without a build, reopens non-consumingly and keeps host peak after route release', async () => {
    const s = setup(document(true))
    const r = route()
    s.source.saveRoute.mockReturnValue(r.resource)
    await s.open()
    await s.call('reserveWorkspace', { bytes: 200 })
    const saved = ticket(await s.call('captureLocation', { doc: 1, gen: 1 }))
    const hostBytes = 3 * ((64 << 10) + (16 << 10))
    expect(s.reserveCache).toHaveBeenLastCalledWith(surfaceTable + hostBytes + 300)
    await s.call('close', { doc: 1 })
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, localOnly: true, path: r.target.path } })
    await s.call('close', { doc: 2 })
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 100 })).toMatchObject({ result: { doc: 3 } })
    expect(r.resource.open).toHaveBeenCalledTimes(2)
    expect(s.openDoc).toHaveBeenCalledOnce()
    await s.call('close', { doc: 3 })
    expect(await s.call('releaseSaved', { ticket: saved })).toMatchObject({ result: true })
    expect(await s.call('releaseSaved', { ticket: saved })).toMatchObject({ result: false })
    await s.call('reserveWorkspace', { bytes: 0 })
    expect(s.reserveCache).toHaveBeenLastCalledWith(surfaceTable + hostBytes)
    expect(r.resource.release).toHaveBeenCalledOnce()
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 100 })).toMatchObject({ error: { code: 'Stale' } })
  })

  it('refuses malformed, forged and old-session tickets before native work', async () => {
    const s = setup()
    await s.open()
    s.reserveCache.mockClear()
    for (const bad of [null, 3, {}, { session: 7, id: '' }, { session: 7.5, id: randomUUID() }, { session: 7, id: 'x'.repeat(32768) }])
      expect(await s.call('openSaved', { ticket: bad, count: 1, bytes: 0 })).toMatchObject({ error: { code: 'InvalidParams' } })
    const old = { session: 6, id: randomUUID() }
    expect(await s.call('openSaved', { ticket: old, count: 1, bytes: 0 })).toMatchObject({ error: { code: 'Stale' } })
    expect(await s.call('releaseSaved', { ticket: old })).toMatchObject({ result: false })
    expect(await s.call('openSaved', { ticket: { ...old, session: 7 }, count: 1, bytes: 0 })).toMatchObject({ error: { code: 'Stale' } })
    expect(s.reserveCache).not.toHaveBeenCalled()
    expect(s.source.saveRoute).not.toHaveBeenCalled()
  })

  it('preserves an existing ticket on UUID collision and releases only the uninserted route', async () => {
    const id = randomUUID()
    const s = setup(document(true), () => id)
    const a = route(), b = route()
    s.source.saveRoute.mockReturnValueOnce(a.resource).mockReturnValueOnce(b.resource)
    await s.open()
    const saved = ticket(await s.call('captureLocation', { doc: 1, gen: 1 }))
    expect(await s.call('captureLocation', { doc: 1, gen: 1 })).toMatchObject({ error: { code: 'Refused' } })
    expect(b.resource.release).toHaveBeenCalledOnce()
    expect(a.resource.release).not.toHaveBeenCalled()
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 100 })).toHaveProperty('result.doc', 2)
    expect(a.resource.open).toHaveBeenCalledOnce()
    expect(b.resource.open).not.toHaveBeenCalled()
  })

  it('pays table capacity before native capture, and rolls provisional growth back if clone fails', async () => {
    const s = setup(document(true))
    await s.open()
    s.reserveCache.mockReturnValueOnce(false)
    expect(await s.call('captureLocation', { doc: 1, gen: 1 })).toMatchObject({ error: { code: 'Memory' } })
    expect(s.source.saveRoute).not.toHaveBeenCalled()
    s.source.saveRoute.mockImplementationOnce(() => { throw nativeError('Memory') })
    expect(await s.call('captureLocation', { doc: 1, gen: 1 })).toMatchObject({ error: { code: 'Memory' } })
    expect(s.reserveCache).toHaveBeenLastCalledWith(surfaceTable + 100)
    expect(await s.call('reserve', { doc: 1, gen: 1, bytes: 90 })).toMatchObject({ result: true })
    expect(s.source.close).not.toHaveBeenCalled()
  })

  it('target mutation at saved open or first page is refused while the recoverable ticket and source survive', async () => {
    const s = setup(document(true)), r = route()
    s.source.saveRoute.mockReturnValue(r.resource)
    await s.open()
    const saved = ticket(await s.call('captureLocation', { doc: 1, gen: 1 }))
    r.resource.open.mockImplementationOnce(() => { throw nativeError('Frozen') })
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 300 })).toMatchObject({ error: { code: 'Refused' } })
    r.target.page.mockRejectedValueOnce(nativeError('Frozen'))
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 300 })).toMatchObject({ error: { code: 'Refused' } })
    expect(r.target.close).toHaveBeenCalledOnce()
    expect(r.resource.release).not.toHaveBeenCalled()
    expect(s.source.close).not.toHaveBeenCalled()
    expect(await s.call('reserve', { doc: 1, gen: 1, bytes: 90 })).toMatchObject({ result: true })
    expect(await s.call('openSaved', { ticket: saved, count: 1, bytes: 100 })).toHaveProperty('result.doc', 2)
  })
})

describe('registered candidate first pages', () => {
  it('burns a failed partial-index identity so late progress cannot address the next successful document', async () => {
    const s = setup(), failed = document(), next = document()
    await s.open()
    let late!: (event: { lines: number; bytes: number; done: boolean }) => void
    failed.startIndex.mockImplementationOnce((_cancel, progress) => { late = progress; throw nativeError('Memory') })
    s.openDoc.mockReturnValueOnce(failed as unknown as Doc).mockReturnValueOnce(next as unknown as Doc)
    expect(await s.call('open', { path: 'failed.txt', count: 1, bytes: 100 })).toMatchObject({ error: { code: 'Memory' } })
    expect(await s.call('open', { path: 'next.txt', count: 1, bytes: 100 })).toHaveProperty('result.doc', 3)
    late({ lines: 9, bytes: 9, done: true })
    expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ doc: 2, gen: 1 }))
    expect(failed.close).toHaveBeenCalledOnce()
    expect(next.close).not.toHaveBeenCalled()
  })

  it('cancel-flag setup failure closes the unopened candidate and restores the mounted source', async () => {
    const s = setup(), target = document()
    await s.open()
    s.openDoc.mockReturnValueOnce(target as unknown as Doc)
    s.cancelFlag.mockImplementationOnce(() => { throw nativeError('Memory') })
    expect(await s.call('open', { path: 'target.txt', count: 1, bytes: 900 })).toMatchObject({ error: { code: 'Memory' } })
    expect(target.page).not.toHaveBeenCalled()
    expect(target.close).toHaveBeenCalledOnce()
    expect(target.startIndex).not.toHaveBeenCalled()
    expect(s.source.close).not.toHaveBeenCalled()
    expect(s.reserveCache).toHaveBeenLastCalledWith(surfaceTable + 100)
    expect(await s.call('reserve', { doc: 1, gen: 1, bytes: 90 })).toMatchObject({ result: true })
  })

  it('handoff failure cancels the candidate index without deleting or closing the source', async () => {
    const s = setup(), target = document()
    await s.open()
    s.openDoc.mockReturnValueOnce(target as unknown as Doc)
    target.setCacheActive.mockImplementationOnce(() => { throw nativeError('Memory') })
    expect(await s.call('open', { path: 'target.txt', count: 1, bytes: 900 })).toMatchObject({ error: { code: 'Memory' } })
    const index = target.startIndex.mock.calls[0]![0] as unknown as { cancel: ReturnType<typeof vi.fn> }
    expect(index.cancel).toHaveBeenCalledOnce()
    expect(target.close).toHaveBeenCalledOnce()
    expect(s.source.close).not.toHaveBeenCalled()
    expect(await s.call('page', { doc: 1, gen: 1, lens: 'raw', start: 0, count: 1 })).toMatchObject({ result: first })
  })

  it('a failed manual candidate restores the still-mounted source share and leaves its reads usable', async () => {
    const s = setup()
    await s.open()
    await s.call('reserveWorkspace', { bytes: 200 })
    s.openDoc.mockImplementationOnce(() => { throw nativeError('NotFound') })
    expect(await s.call('open', { path: 'missing.txt', count: 1, bytes: 900 })).toMatchObject({ error: { code: 'NotFound' } })
    expect(s.reserveCache).toHaveBeenLastCalledWith(surfaceTable + 300)
    expect(s.source.close).not.toHaveBeenCalled()
    expect(await s.call('page', { doc: 1, gen: 1, lens: 'raw', start: 0, count: 1 })).toMatchObject({ result: first })
    expect(await s.call('reserve', { doc: 1, gen: 1, bytes: 90 })).toMatchObject({ result: true })
    expect(s.reserveCache).toHaveBeenLastCalledWith(surfaceTable + 290)
  })

  for (const kind of ['open', 'openLocal', 'openSaved'] as const) {
    it(`${kind}: cancellation after native completion but before publication closes only the candidate`, async () => {
      const s = setup(kind === 'openSaved' ? document(true) : document())
      await s.open()
      const target = document(true), waiting = deferred(), r = route(target)
      target.page.mockReturnValueOnce(waiting.promise)
      s.openDoc.mockReturnValueOnce(target as unknown as Doc)
      s.source.openLocal.mockReturnValue(target)
      s.source.saveRoute.mockReturnValue(r.resource)
      const saved = kind === 'openSaved' ? ticket(await s.call('captureLocation', { doc: 1, gen: 1 })) : undefined
      const params = kind === 'open' ? { path: 'target.txt', count: 1, bytes: 300 } : kind === 'openLocal'
        ? { doc: 1, gen: 1, target: 'target.txt', count: 1, bytes: 300 } : { ticket: saved, count: 1, bytes: 300 }
      const opening = s.dispatch({ id: 50, method: kind, params })
      const flag = s.flags.at(-1)!
      waiting.resolve()
      expect(await s.call('cancel', { id: 50 })).toMatchObject({ result: true })
      expect(await opening).toMatchObject({ error: { code: 'Cancelled' } })
      expect(flag.cancel).toHaveBeenCalledOnce()
      expect(target.startIndex).not.toHaveBeenCalled()
      expect(target.close).toHaveBeenCalledOnce()
      expect(s.source.close).not.toHaveBeenCalled()
      expect(await s.call('reserve', { doc: 1, gen: 1, bytes: 90 })).toMatchObject({ result: true })
      expect(r.resource.release).not.toHaveBeenCalled()
    })
  }

  it('ticket release cancels unpublished candidates but never closes already-published documents', async () => {
    const s = setup(document(true)), r = route(), waiting = deferred()
    s.source.saveRoute.mockReturnValue(r.resource)
    await s.open()
    const saved = ticket(await s.call('captureLocation', { doc: 1, gen: 1 }))
    await s.call('openSaved', { ticket: saved, count: 1, bytes: 100 })
    const another = document(true)
    another.page.mockReturnValueOnce(waiting.promise)
    r.resource.open.mockReturnValueOnce(another as unknown as Doc)
    const pending = s.dispatch({ id: 50, method: 'openSaved', params: { ticket: saved, count: 1, bytes: 100 } })
    await s.call('releaseSaved', { ticket: saved })
    waiting.resolve()
    expect(await pending).toMatchObject({ error: { code: 'Stale' } })
    expect(another.close).toHaveBeenCalledOnce()
    expect(r.target.close).not.toHaveBeenCalled()
    expect(another.startIndex).not.toHaveBeenCalled()
  })

  it('preserves concurrent fresh opens as inactive documents and rejects duplicate pending request IDs', async () => {
    const s = setup(), a = document(), b = document(), waiting = deferred()
    await s.open()
    a.page.mockReturnValueOnce(waiting.promise)
    s.openDoc.mockReturnValueOnce(a as unknown as Doc).mockReturnValueOnce(b as unknown as Doc)
    const earlier = s.dispatch({ id: 50, method: 'open', params: { path: 'a.txt', count: 1, bytes: 300 } })
    const callsBefore = [s.reserveCache.mock.calls.length, s.source.setCacheActive.mock.calls.length, s.openDoc.mock.calls.length]
    for (const method of ['close', 'releaseSaved', 'reload', 'activate']) {
      expect(await s.dispatch({ id: 50, method, params: { doc: 1, gen: 1, count: 1, bytes: 900, ticket: { session: 7, id: randomUUID() } } }))
        .toMatchObject({ error: { code: 'InvalidParams', field: 'id' } })
    }
    expect([s.reserveCache.mock.calls.length, s.source.setCacheActive.mock.calls.length, s.openDoc.mock.calls.length]).toEqual(callsBefore)
    expect(s.source.close).not.toHaveBeenCalled()
    expect(await s.dispatch({ id: 50, method: 'open', params: { path: 'bad.txt', count: 1, bytes: 900 } }))
      .toMatchObject({ error: { code: 'InvalidParams', field: 'id' } })
    expect(await s.call('open', { path: 'b.txt', count: 1, bytes: 500 })).toHaveProperty('result.doc', 2)
    waiting.resolve()
    expect(await earlier).toHaveProperty('result.doc', 3)
    expect(a.setCacheActive).toHaveBeenLastCalledWith(1, false)
    expect(a.close).not.toHaveBeenCalled()
    expect(b.close).not.toHaveBeenCalled()
    expect(await s.call('reserve', { doc: 2, gen: 1, bytes: 400 })).toMatchObject({ result: true })
  })
})
