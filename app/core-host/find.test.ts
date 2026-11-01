import { describe, expect, it, vi } from 'vitest'
import { limits, type Cancel, type Doc, type CsvCell as NativeCsvCell } from 'typose-node'
import { makeDispatcher } from './dispatch'
import type { Opened, SourceFindInfo, Response, CsvInfo, CsvOrderInfo, CsvFindInfo } from '../shared/protocol'

const GRID_INTERACTION = '00000000-0000-4000-8000-000000000001'
const NEW_GRID_INTERACTION = '00000000-0000-4000-8000-000000000002'

const hit = (text = 'x', unitBytes = 1) => ({ start: 0, end: text.length * unitBytes, line: 0, lineStart: 0, text,
  map: { uniform: true, start: 0, end: text.length * unitBytes, units: text.length, unitBytes, points: new Uint32Array() }, matchStart: 0, matchEnd: text.length })

function setup() {
  const flags: Array<{ cancel: ReturnType<typeof vi.fn> }> = []
  let find = 0
  let order = 0, csvFind = 0
  const gridHit: { dataRow: number; sourceRecord: number; column: number; start: number; end: number; text?: string; matchStart?: number; matchEnd?: number }
    = { dataRow: 1, sourceRecord: 2, column: 0, start: 5, end: 6 }
  const doc = {
    generation: 1, path: 'a.csv', format: 'csv', size: 100, encoding: 'UTF-8', lines: 1, indexed: true, blank: false,
    page: vi.fn(async () => ({ items: [] })), setCacheActive: vi.fn(), startIndex: vi.fn(), close: vi.fn(),
    reload: vi.fn(() => { doc.generation++ }),
    sourceFindStart: vi.fn(() => ({ id: ++find, count: 0, scannedBytes: 0, complete: false })),
    sourceFindScan: vi.fn(async () => ({ count: 1, scannedBytes: 100, complete: true, hits: [hit()] })),
    sourceFindSeek: vi.fn(async () => ({ hit: hit(), wrapped: true, ordinal: 1 })), sourceFindClose: vi.fn(() => true),
    csvConfigure: vi.fn(async () => ({ revision: 1, status: 'ready', delimiter: ',', header: true, encoding: 'UTF-8',
      sourceRecords: 2, indexedBytes: 100, done: true, expectedColumns: 2, maxColumnsKnown: 2, metadataDone: true })),
    csvSort: vi.fn(async (_gen: number, _revision: number, column: number, direction: string) => ({ id: ++order, rows: 2, column, direction })),
    csvOrderClose: vi.fn(() => true), csvOrderedPage: vi.fn(async () => ({ rows: [], completeRect: true, indexing: false })),
    csvOrderLocate: vi.fn(async () => ({ dataRow: 1 })),
    csvCell: vi.fn(async (_gen: number, _revision: number, sourceRecord: number, column: number): Promise<NativeCsvCell> => ({ column, value: { sourceRecord, column,
      span: { start: 0, end: 1 }, pieceSpan: { start: 0, end: 1 }, text: 'x', map: hit().map, replacements: 0 } })),
    csvFindStart: vi.fn(() => ({ id: ++csvFind, count: 0, scannedBytes: 0, complete: false })),
    csvFindClose: vi.fn(() => true), csvFindScan: vi.fn(async () => ({ count: 1, scannedBytes: 100, complete: true, hits: [gridHit] })),
    csvFindSeek: vi.fn(async () => ({ hit: gridHit, ordinal: 1, wrapped: true })),
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
  it('freeze closes native Find ownership and rejects further scans', async () => {
    const s = setup(), opened = await s.open(), found = await s.start(opened.view)
    s.doc.sourceFindScan.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'Frozen' }))
    expect(await s.call('sourceFindScan', { ref: found.ref })).toMatchObject({ error: { code: 'Frozen' } })
    expect(s.doc.sourceFindClose).toHaveBeenCalledWith(1, found.ref.id)
    expect(await s.call('sourceFindScan', { ref: found.ref })).toMatchObject({ error: { code: 'Stale' } })
  })
})

describe('Grid interactions host bridge', () => {
  const ready = async () => {
    const s = setup(), opened = await s.open(), info = await s.configure()
    const order = { csv: info.ref, id: 0 }
    const sort = (direction = 'asc', interactionId = GRID_INTERACTION) => s.value<CsvOrderInfo>(s.call('csvSort', { view: opened.view, ref: info.ref, interactionId, column: 0, direction }))
    const find = (current = order) => s.value<CsvFindInfo>(s.call('csvFindStart', { view: opened.view, order: current, query: 'x', matchCase: false }))
    return { ...s, opened, info, order, sort, find, interactionId: GRID_INTERACTION }
  }
  it('supports identity order, publishes exact sort refs, locates source records, and reads header cells', async () => {
    const s = await ready()
    expect(await s.call('csvOrderedPage', { order: s.order, rowStart: 0, rowCount: 2, columnStart: 0, columnCount: 2 })).toMatchObject({ result: { ref: s.info.ref } })
    const sorted = await s.sort('desc')
    expect(sorted).toMatchObject({ order: { csv: s.info.ref, id: 1 }, direction: 'desc', rows: 2 })
    expect(await s.call('csvOrderedPage', { order: s.order, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 })).toMatchObject({ error: { code: 'Stale' } })
    expect(await s.call('csvOrderLocate', { order: sorted.order, sourceRecord: 2 })).toMatchObject({ result: { dataRow: 1 } })
    expect(s.doc.csvOrderLocate).toHaveBeenCalledWith(1, 1, 1, 2, expect.anything())
    expect(await s.call('csvCell', { ref: s.info.ref, sourceRecord: 0, column: 1 })).toMatchObject({ result: { kind: 'value', sourceRecord: 0, column: 1, text: 'x' } })
  })
  it('rejects malformed sort/rectangles/Find references and forged revision before native code', async () => {
    const s = await ready()
    for (const params of [{ view: s.opened.view, ref: s.info.ref, column: -1, direction: 'asc' },
      { view: s.opened.view, ref: s.info.ref, column: 0, direction: 'sideways' },
      { view: s.opened.view, ref: { ...s.info.ref, revision: 2 }, column: 0, direction: 'asc' }])
      expect(await s.call('csvSort', { ...params, interactionId: s.interactionId })).toHaveProperty('error')
    expect(s.doc.csvSort).not.toHaveBeenCalled()
    expect(await s.call('csvOrderedPage', { order: s.order, rowStart: 0, rowCount: 129, columnStart: 0, columnCount: 1 })).toMatchObject({ error: { code: 'InvalidParams' } })
    expect(s.doc.csvOrderedPage).not.toHaveBeenCalled()
    expect(await s.call('csvFindStart', { view: { ...s.opened.view, gen: 2 }, order: s.order, query: 'x', matchCase: false })).toMatchObject({ error: { code: 'Stale' } })
    expect(s.doc.csvFindStart).not.toHaveBeenCalled()
  })
  it('retires a sorted Grid lens and lets the same view return to identity order', async () => {
    const s = await ready(), sorted = await s.sort(), found = await s.find(sorted.order)
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: sorted.order, interactionId: s.interactionId })).toMatchObject({ result: true })
    expect(s.doc.csvOrderClose).toHaveBeenCalledWith(1, 1, sorted.order.id)
    expect(s.doc.csvFindClose).toHaveBeenCalledWith(1, 1, found.ref.id)
    expect(await s.call('csvFindScan', { ref: found.ref })).toMatchObject({ error: { code: 'Stale' } })
    expect(await s.call('csvOrderedPage', { order: sorted.order, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 }))
      .toMatchObject({ error: { code: 'Stale' } })
    expect(await s.call('csvOrderedPage', { order: s.order, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 }))
      .toMatchObject({ result: { ref: s.info.ref } })
  })
  it('does not retire a newer order or accept a forged closing view/ref', async () => {
    const s = await ready(), older = await s.sort(), newer = await s.sort('desc', NEW_GRID_INTERACTION), found = await s.find(newer.order)
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: older.order, interactionId: s.interactionId })).toMatchObject({ result: false })
    expect(await s.call('csvOrderClose', { view: { ...s.opened.view, id: 99 }, order: newer.order, interactionId: NEW_GRID_INTERACTION })).toHaveProperty('error')
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: { ...newer.order, csv: { ...s.info.ref, revision: 2 } }, interactionId: NEW_GRID_INTERACTION })).toHaveProperty('error')
    expect(s.doc.csvOrderClose).not.toHaveBeenCalled()
    expect(s.doc.csvFindClose).not.toHaveBeenCalled()
    expect(await s.call('csvFindScan', { ref: found.ref })).toHaveProperty('result')
  })
  it('invalidates a pending sort on lens retirement without affecting the next Grid sort', async () => {
    const s = await ready()
    let finish!: (value: { id: number; rows: number; column: number; direction: string }) => void
    s.doc.csvSort.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = s.call('csvSort', { view: s.opened.view, ref: s.info.ref, interactionId: s.interactionId, column: 0, direction: 'asc' })
    const flag = s.flags.at(-1)!
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: s.order, interactionId: s.interactionId })).toMatchObject({ result: true })
    expect(flag.cancel).toHaveBeenCalled()
    const newer = await s.sort('desc', NEW_GRID_INTERACTION)
    finish({ id: 99, rows: 2, column: 0, direction: 'asc' })
    expect(await pending).toHaveProperty('error')
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: s.order, interactionId: s.interactionId })).toMatchObject({ result: false })
    expect(await s.call('csvOrderLocate', { order: newer.order, sourceRecord: 1 })).toHaveProperty('result')
    expect(s.doc.csvOrderClose).toHaveBeenCalledTimes(1)
  })
  it('closes its authoritative committed order even when the renderer only observed identity order', async () => {
    const s = await ready(), sorted = await s.sort()
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: s.order, interactionId: s.interactionId }))
      .toMatchObject({ result: true })
    expect(s.doc.csvOrderClose).toHaveBeenCalledWith(1, 1, sorted.order.id)
    expect(await s.call('csvOrderedPage', { order: s.order, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 })).toHaveProperty('result')
  })
  it('cannot cancel a newer Grid instance pending sort using the prior instance committed order', async () => {
    const s = await ready(), older = await s.sort()
    let finish!: (value: { id: number; rows: number; column: number; direction: string }) => void
    s.doc.csvSort.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = s.call('csvSort', { view: s.opened.view, ref: s.info.ref, interactionId: NEW_GRID_INTERACTION, column: 0, direction: 'desc' })
    const flag = s.flags.at(-1)!
    expect(await s.call('csvOrderClose', { view: s.opened.view, order: older.order, interactionId: s.interactionId }))
      .toMatchObject({ result: false })
    expect(flag.cancel).not.toHaveBeenCalled()
    expect(s.doc.csvOrderClose).not.toHaveBeenCalled()
    finish({ id: 2, rows: 2, column: 0, direction: 'desc' })
    const newer = await s.value<CsvOrderInfo>(pending)
    expect(await s.call('csvOrderLocate', { order: newer.order, sourceRecord: 1 })).toHaveProperty('result')
  })
  it('rejects missing or malformed Grid instance ownership before native sort or cleanup', async () => {
    const s = await ready()
    for (const interactionId of [undefined, '', 'not-a-uuid', 7, '00000000-0000-0000-0000-000000000000']) {
      expect(await s.call('csvSort', { view: s.opened.view, ref: s.info.ref, interactionId, column: 0, direction: 'asc' }))
        .toMatchObject({ error: { code: 'InvalidParams', field: 'interactionId' } })
      expect(await s.call('csvOrderClose', { view: s.opened.view, order: s.order, interactionId }))
        .toMatchObject({ error: { code: 'InvalidParams', field: 'interactionId' } })
    }
    expect(s.doc.csvSort).not.toHaveBeenCalled()
    expect(s.doc.csvOrderClose).not.toHaveBeenCalled()
  })
  it('preserves order and Find state on native sort refusal, then closes Find when sort succeeds', async () => {
    const s = await ready(), found = await s.find()
    s.doc.csvSort.mockRejectedValueOnce(Object.assign(new Error('budget'), { code: 'Memory' }))
    expect(await s.call('csvSort', { view: s.opened.view, ref: s.info.ref, interactionId: s.interactionId, column: 0, direction: 'asc' })).toMatchObject({ error: { code: 'Memory' } })
    expect(s.doc.csvFindClose).not.toHaveBeenCalled()
    expect(await s.call('csvFindScan', { ref: found.ref })).toMatchObject({ result: { ref: found.ref, hits: [{ sourceRecord: 2 }] } })
    await s.sort()
    expect(s.doc.csvFindClose).toHaveBeenCalledWith(1, 1, found.ref.id)
    expect(await s.call('csvFindSeek', { ref: found.ref, direction: 'next' })).toMatchObject({ error: { code: 'Stale' } })
  })
  it('cancels superseded sorts and rejects late ordered pages', async () => {
    const s = await ready()
    let finishSort!: (value: { id: number; rows: number; column: number; direction: string }) => void
    s.doc.csvSort.mockImplementationOnce(() => new Promise((resolve) => { finishSort = resolve }))
    const pendingSort = s.call('csvSort', { view: s.opened.view, ref: s.info.ref, interactionId: s.interactionId, column: 0, direction: 'asc' }), oldFlag = s.flags.at(-1)!
    const sorted = await s.sort('desc')
    expect(oldFlag.cancel).toHaveBeenCalled()
    finishSort({ id: 99, rows: 2, column: 0, direction: 'asc' })
    expect(await pendingSort).toHaveProperty('error')
    let finishPage!: (value: { rows: never[]; completeRect: boolean; indexing: boolean }) => void
    s.doc.csvOrderedPage.mockImplementationOnce(() => new Promise((resolve) => { finishPage = resolve }))
    const pendingPage = s.call('csvOrderedPage', { order: sorted.order, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 })
    await s.sort()
    finishPage({ rows: [], completeRect: true, indexing: false })
    expect(await pendingPage).toHaveProperty('error')
  })
  it('binds Find to its exact order/view/query, validates hit offsets, and closes state on detach', async () => {
    const s = await ready(), found = await s.find()
    expect(await s.call('csvFindSeek', { ref: found.ref, direction: 'previous' })).toMatchObject({ result: { ordinal: 1, wrapped: true } })
    expect(await s.call('csvFindSeek', { ref: found.ref, direction: 'next', from: { dataRow: 0, sourceRecord: 1, column: 0, start: 5, end: 4 } })).toMatchObject({ error: { code: 'InvalidParams' } })
    let finish!: (value: Awaited<ReturnType<typeof s.doc.csvFindScan>>) => void
    s.doc.csvFindScan.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = s.call('csvFindScan', { ref: found.ref }), flag = s.flags.at(-1)!
    await s.call('deactivate', { view: s.opened.view })
    expect(flag.cancel).toHaveBeenCalled()
    expect(s.doc.csvFindClose).toHaveBeenCalledWith(1, 1, 1)
    expect(s.doc.csvOrderClose).toHaveBeenCalledWith(1, 1, 0)
    finish({ count: 0, scannedBytes: 100, complete: true, hits: [] })
    expect(await pending).toHaveProperty('error')
  })
  it('retiring an old lease cannot close a newer view Find/order', async () => {
    const s = await ready()
    await s.sort()
    const active = await s.value<Opened>(s.call('activate', { doc: 1, gen: 1, count: 1, bytes: 0 }))
    expect(s.doc.csvOrderClose).toHaveBeenCalledTimes(1)
    const found = await s.value<CsvFindInfo>(s.call('csvFindStart', { view: active.view, order: s.order, query: 'x', matchCase: true }))
    await s.call('deactivate', { view: s.opened.view })
    expect(s.doc.csvOrderClose).toHaveBeenCalledTimes(1)
    expect(await s.call('csvFindScan', { ref: found.ref })).toHaveProperty('result')
  })
  it('transports ragged missing cells and enforces the native CSV decoder-lookahead bound', async () => {
    const s = await ready()
    s.doc.csvCell.mockResolvedValueOnce({ column: 2 })
    expect(await s.call('csvCell', { ref: s.info.ref, sourceRecord: 1, column: 2 })).toMatchObject({ result: { kind: 'missing', column: 2 } })
    const piece = (length: number) => ({ column: 0, value: { sourceRecord: 1, column: 0, span: { start: 0, end: length },
      pieceSpan: { start: 0, end: length }, text: 'x'.repeat(length), map: hit('x'.repeat(length)).map, replacements: 0 } })
    s.doc.csvCell.mockResolvedValueOnce(piece(4096 + 4))
    expect(await s.call('csvCell', { ref: s.info.ref, sourceRecord: 1, column: 0 })).toMatchObject({ result: { kind: 'value', text: 'x'.repeat(4100) } })
    s.doc.csvCell.mockResolvedValueOnce(piece(4096 + 5))
    expect(await s.call('csvCell', { ref: s.info.ref, sourceRecord: 1, column: 0 })).toMatchObject({ error: { code: 'Internal' } })
  })
  it('transports bounded deep-cell navigation excerpts and rejects malformed/oversized excerpts', async () => {
    const s = await ready(), found = await s.find()
    const hit = { dataRow: 1, sourceRecord: 2, column: 0, start: 5, end: 6, text: 'needle context', matchStart: 0, matchEnd: 6 }
    s.doc.csvFindSeek.mockResolvedValueOnce({ hit, wrapped: false, ordinal: 1 })
    expect(await s.call('csvFindSeek', { ref: found.ref, direction: 'next' })).toMatchObject({ result: { hit } })
    for (const bad of [{ ...hit, matchEnd: 99 }, { ...hit, text: 'x'.repeat((32 << 10) + 1) }, { ...hit, matchStart: 1 }]) {
      s.doc.csvFindSeek.mockResolvedValueOnce({ hit: bad, wrapped: false, ordinal: 1 })
      expect(await s.call('csvFindSeek', { ref: found.ref, direction: 'next' })).toMatchObject({ error: { code: 'Internal' } })
    }
  })
  it('surface release closes both lens Find owners and the Grid order', async () => {
    const s = setup(), surface = await s.value<{ session: number; id: number }>(s.call('createSurface', {}))
    const opened = await s.value<Opened>(s.call('open', { surface, path: 'a.csv', count: 1, bytes: 0 }))
    const info = await s.value<CsvInfo>(s.call('csvConfigure', { surface, doc: opened.doc, gen: 1, options: { delimiter: ',', header: true } }))
    await s.start(opened.view)
    await s.call('csvFindStart', { view: opened.view, order: { csv: info.ref, id: 0 }, query: 'x', matchCase: false })
    expect(await s.call('releaseSurface', { surface, retiredBytes: 0 })).toMatchObject({ result: true })
    expect(s.doc.sourceFindClose).toHaveBeenCalledWith(1, 1)
    expect(s.doc.csvFindClose).toHaveBeenCalledWith(1, 1, 1)
    expect(s.doc.csvOrderClose).toHaveBeenCalledWith(1, 1, 0)
    expect(s.doc.close).toHaveBeenCalled()
  })
})
