import { describe, expect, it, vi } from 'vitest'
import { limits, type Cancel, type Doc } from 'typose-node'
import { makeDispatcher } from './dispatch'
import type { Opened, SourceFindInfo, Response, CsvInfo } from '../shared/protocol'

const hit = (text = 'x', unitBytes = 1) => ({ start: 0, end: text.length * unitBytes, line: 0, lineStart: 0, text,
  map: { uniform: true, start: 0, end: text.length * unitBytes, units: text.length, unitBytes, points: new Uint32Array() }, matchStart: 0, matchEnd: text.length })

function setup() {
  const flags: Array<{ cancel: ReturnType<typeof vi.fn> }> = []
  let find = 0
  const doc = {
    generation: 1, path: 'a.csv', format: 'csv', size: 100, encoding: 'UTF-8', lines: 1, indexed: true, blank: false,
    page: vi.fn(async () => ({ items: [] })), setCacheActive: vi.fn(), startIndex: vi.fn(), close: vi.fn(),
    reload: vi.fn(() => { doc.generation++ }),
    sourceFindStart: vi.fn(() => ({ id: ++find, count: 0, scannedBytes: 0, complete: false })),
    sourceFindScan: vi.fn(async () => ({ count: 1, scannedBytes: 100, complete: true, hits: [hit()] })),
    sourceFindSeek: vi.fn(async () => ({ hit: hit(), wrapped: true, ordinal: 1 })), sourceFindClose: vi.fn(() => true),
    csvConfigure: vi.fn(async () => ({ revision: 1, status: 'ready', delimiter: ',', header: true, encoding: 'UTF-8',
      sourceRecords: 2, indexedBytes: 100, done: true, expectedColumns: 2, maxColumnsKnown: 2, metadataDone: true })),
  }
  const dispatcher = makeDispatcher({ limits, coreVersion: () => 'test', openDoc: () => doc as unknown as Doc,
    reserveCache: () => true, cancelFlag: () => { const flag = { cancel: vi.fn() }; flags.push(flag); return flag as unknown as Cancel } }, 9, () => {})
  let id = 0
  const call = (method: string, params: object) => dispatcher({ id: ++id, method, params })
  const value = async <T>(response: Promise<Response>): Promise<T> => {
    const result = await response
    if ('error' in result) throw new Error(JSON.stringify(result.error))
    return result.result as T
  }
  const open = () => value<Opened>(call('open', { path: 'a.csv', count: 1, bytes: 0 }))
  const start = (view: Opened['view']) => value<SourceFindInfo>(call('sourceFindStart', { view, query: 'x', matchCase: false }))
  const configure = () => value<CsvInfo>(call('csvConfigure', { doc: 1, gen: 1, options: { delimiter: ',', header: true } }))
  return { doc, flags, call, value, open, start, configure }
}

describe('exact-view source Find host bridge', () => {
  it('stamps source hits and accepts uniform CJK UTF-8 maps', async () => {
    const s = setup(), opened = await s.open(), found = await s.start(opened.view)
    s.doc.sourceFindScan.mockResolvedValue({ count: 1, scannedBytes: 100, complete: true, hits: [hit('検索', 3)] })
    expect(await s.call('sourceFindScan', { ref: found.ref })).toMatchObject({ result: { ref: found.ref, hits: [{ text: '検索', map: { unitBytes: 3 } }] } })
    expect(await s.call('sourceFindSeek', { ref: found.ref, direction: 'previous', from: 100 })).toMatchObject({ result: { wrapped: true, ordinal: 1 } })
    expect(s.doc.sourceFindSeek).toHaveBeenCalledWith(1, 1, 100, true, expect.anything())
  })
  it('rejects invalid queries, forged leases and navigation before entering native code', async () => {
    const s = setup(), opened = await s.open()
    for (const query of ['', 'x'.repeat(513), String.fromCharCode(0xd800), 8])
      expect(await s.call('sourceFindStart', { view: opened.view, query, matchCase: false })).toMatchObject({ error: { code: 'InvalidParams' } })
    for (const field of ['session', 'surface', 'id', 'doc', 'gen'])
      expect(await s.call('sourceFindStart', { view: { ...opened.view, [field]: 99 }, query: 'x', matchCase: false })).toMatchObject({ error: { code: 'Stale' } })
    expect(s.doc.sourceFindStart).not.toHaveBeenCalled()
    const found = await s.start(opened.view)
    for (const params of [{ direction: 'sideways' }, { direction: 'next', from: 101 }, { direction: 'next', from: -1 }])
      expect(await s.call('sourceFindSeek', { ref: found.ref, ...params })).toMatchObject({ error: { code: 'InvalidParams' } })
    expect(s.doc.sourceFindSeek).not.toHaveBeenCalled()
  })
  it('cancels and rejects an old scan when the query is replaced; stale close cannot close its replacement', async () => {
    const s = setup(), opened = await s.open(), found = await s.start(opened.view)
    let finish!: (v: Awaited<ReturnType<typeof s.doc.sourceFindScan>>) => void
    s.doc.sourceFindScan.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = s.call('sourceFindScan', { ref: found.ref }), flag = s.flags.at(-1)!
    const next = await s.start(opened.view)
    expect(flag.cancel).toHaveBeenCalled()
    finish({ count: 1, scannedBytes: 100, complete: true, hits: [hit()] })
    expect(await pending).toMatchObject({ error: { code: 'Cancelled' } })
    expect(await s.call('sourceFindClose', { ref: found.ref })).toMatchObject({ error: { code: 'Stale' } })
    expect(await s.call('sourceFindScan', { ref: next.ref })).toHaveProperty('result')
  })
  it('preserves the old query when the native ledger refuses its replacement', async () => {
    const s = setup(), opened = await s.open(), found = await s.start(opened.view)
    s.doc.sourceFindStart.mockImplementationOnce(() => { throw Object.assign(new Error('budget'), { code: 'Memory' }) })
    expect(await s.call('sourceFindStart', { view: opened.view, query: 'new', matchCase: true })).toMatchObject({ error: { code: 'Memory' } })
    expect(await s.call('sourceFindScan', { ref: found.ref })).toHaveProperty('result')
    expect(s.doc.sourceFindClose).not.toHaveBeenCalled()
  })
  it.each(['deactivate', 'reload', 'close'])('closes exact native Find state on %s', async (method) => {
    const s = setup(), opened = await s.open(), found = await s.start(opened.view)
    const params = method === 'deactivate' ? { view: opened.view } : method === 'close' ? { doc: 1 } : { doc: 1, count: 1, bytes: 0 }
    expect(await s.call(method, params)).toHaveProperty('result')
    expect(s.doc.sourceFindClose).toHaveBeenCalledWith(1, found.ref.id)
    expect(await s.call('sourceFindScan', { ref: found.ref })).toHaveProperty('error')
  })
  it('drops oversized/malformed native result envelopes', async () => {
    const s = setup(), opened = await s.open(), found = await s.start(opened.view)
    s.doc.sourceFindScan.mockResolvedValueOnce({ count: 1, scannedBytes: 101, complete: true, hits: [] })
    expect(await s.call('sourceFindScan', { ref: found.ref })).toMatchObject({ error: { code: 'Internal' } })
    s.doc.sourceFindScan.mockResolvedValueOnce({ count: 129, scannedBytes: 100, complete: true, hits: Array.from({ length: 129 }, () => hit()) })
    expect(await s.call('sourceFindScan', { ref: found.ref })).toMatchObject({ error: { code: 'Internal' } })
  })
})
