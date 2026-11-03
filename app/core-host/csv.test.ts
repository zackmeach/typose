import { describe, expect, it, vi } from 'vitest'
import type { Cancel, Doc } from 'typose-node'
import { limits } from 'typose-node'
import type { CsvInfo, CsvPage, Response, SurfaceRef } from '../shared/protocol'
import { makeDispatcher } from './dispatch'

type Flag = { cancel: ReturnType<typeof vi.fn> }
type TestPiece = { sourceRecord: number; column: number; span: { start: number; end: number }; pieceSpan: { start: number; end: number }; text: string; map: object; replacements: number; next?: { sourceRecord: number; column: number; offset: number } }
type TestPage = { rows: Array<{ dataRow: number; sourceRecord: number; sourceLine: number; span: { start: number; end: number }; fieldCount: number; cells: Array<{ column: number; value?: TestPiece }>; complete: boolean }>; completeRect: boolean; nextRow?: number; nextColumn?: number; indexing: boolean }

function nativeInfo(revision = 1, delimiter = ';') {
  return { revision, status: 'indexing', delimiter, header: true, encoding: 'UTF-8', sourceRecords: 2,
    done: false, expectedColumns: 2, maxColumnsKnown: 2, metadataDone: false } as const
}

function setup(path = 'tasks.csv') {
  const flags: Flag[] = []
  const flag = () => {
    const value = { cancel: vi.fn() }
    flags.push(value)
    return value as unknown as Cancel
  }
  const doc = {
    path,
    generation: 1,
    format: 'csv',
    size: 24,
    encoding: 'UTF-8',
    lines: 0,
    indexed: false,
    blank: false,
    page: vi.fn(async () => ({ items: [] })),
    piece: vi.fn(async () => ({ items: [] })),
    setCacheActive: vi.fn(),
    startIndex: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    csvConfigure: vi.fn(async () => nativeInfo()),
    csvPage: vi.fn(async (): Promise<TestPage> => ({ rows: [], completeRect: true, indexing: false })),
    csvPiece: vi.fn(async () => ({ sourceRecord: 1, column: 0, span: { start: 8, end: 14 }, pieceSpan: { start: 8, end: 14 }, text: '001', map: {}, replacements: 0 })),
    csvColumns: vi.fn(async () => ({ columns: [], metadataDone: false })),
    csvLocate: vi.fn(async () => ({ kind: 'pending' as const }))
  }
  const openDoc = vi.fn(() => doc as unknown as Doc)
  const dispatcher = makeDispatcher({ coreVersion: () => 'test', limits, openDoc, cancelFlag: flag, reserveCache: () => true }, 9, () => {})
  let nextId = 1
  const call = (method: string, params: Record<string, unknown>) => dispatcher({ id: nextId++, method, params })
  const value = async <T>(response: Promise<Response>): Promise<T> => {
    const result = await response
    if ('error' in result) throw new Error(JSON.stringify(result.error))
    return result.result as T
  }
  return { dispatcher, call, value, doc, flags }
}

async function openCsv(s: ReturnType<typeof setup>, surface?: SurfaceRef): Promise<number> {
  const opened = await s.value<{ doc: number; gen: number; format: string }>(s.call('open', {
    ...(surface ? { surface } : {}), path: 'tasks.csv', count: 1, bytes: 0
  }))
  expect(opened.format).toBe('csv')
  return opened.doc
}

async function configure(s: ReturnType<typeof setup>, doc = 1, surface?: SurfaceRef): Promise<CsvInfo> {
  return s.value<CsvInfo>(s.call('csvConfigure', {
    ...(surface ? { surface } : {}), doc, gen: 1, options: { delimiter: ';', header: true }
  }))
}

describe('CSV core-host bridge', () => {
  it('accepts native CSV classification and configures only the owning surface, stamping its ref', async () => {
    const s = setup('TASKS.CSV')
    const surface = await s.value<SurfaceRef>(s.call('createSurface', {}))
    const doc = await openCsv(s, surface)
    expect(doc).toBe(1)
    expect(await s.call('csvConfigure', { doc, gen: 1, options: { delimiter: ';', header: true } }))
      .toMatchObject({ error: { code: 'Stale' } })
    expect(s.doc.csvConfigure).not.toHaveBeenCalled()

    const info = await configure(s, doc, surface)
    expect(s.doc.csvConfigure).toHaveBeenCalledWith(1, ';', 1, expect.anything())
    expect(info).toMatchObject({ ref: { session: 9, doc, gen: 1, revision: 1 }, status: 'indexing', delimiter: ';', header: true,
      sourceRecords: 2, expectedColumns: 2, maxColumnsKnown: 2, metadataDone: false })
    expect(info).not.toHaveProperty('revision')
  })

  it('refuses forged, stale-generation, stale-revision, and oversized rectangles before native calls', async () => {
    const s = setup()
    const doc = await openCsv(s)
    const info = await configure(s, doc)
    const ref = info.ref
    const cases = [
      { ref: { ...ref, session: 10 }, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
      { ref: { ...ref, doc: 88 }, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
      { ref: { ...ref, gen: 2 }, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
      { ref: { ...ref, revision: 2 }, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
      { ref, rowStart: 0, rowCount: 129, columnStart: 0, columnCount: 1 },
      { ref, rowStart: Number.MAX_SAFE_INTEGER + 1, rowCount: 1, columnStart: 0, columnCount: 1 }
    ]
    for (const params of cases) expect(await s.call('csvPage', params)).toHaveProperty('error')
    expect(s.doc.csvPage).not.toHaveBeenCalled()
  })

  it('stamps a bounded partial page and every value continuation with the validated ref', async () => {
    const s = setup()
    const doc = await openCsv(s)
    const { ref } = await configure(s, doc)
    s.doc.csvPage.mockResolvedValueOnce({
      rows: [{ dataRow: 0, sourceRecord: 1, sourceLine: 2, span: { start: 7, end: 15 }, fieldCount: 2,
        cells: [
          { column: 0, value: { sourceRecord: 1, column: 0, span: { start: 7, end: 11 }, pieceSpan: { start: 7, end: 9 },
            text: '01', map: {}, replacements: 0, next: { sourceRecord: 1, column: 0, offset: 9 } } },
          { column: 1 }
        ], complete: false }],
      completeRect: false, nextRow: 1, nextColumn: 2, indexing: true
    })
    const result = await s.value<CsvPage>(s.call('csvPage', { ref, rowStart: 0, rowCount: 128, columnStart: 0, columnCount: 128 }))
    expect(s.doc.csvPage).toHaveBeenCalledWith(1, ref.revision, 0, 128, 0, 128, expect.anything())
    expect(result).toMatchObject({ ref, completeRect: false, nextRow: 1, nextColumn: 2, indexing: true,
      rows: [{ dataRow: 0, sourceRecord: 1, cells: [
        { kind: 'value', next: { ref, sourceRecord: 1, column: 0, offset: 9 } }, { kind: 'missing', column: 1 }
      ] }] })
  })

  it('cancels a pending page read and refuses publication even if native resolves afterward', async () => {
    const s = setup()
    const doc = await openCsv(s)
    const { ref } = await configure(s, doc)
    let resolvePage!: (value: Awaited<ReturnType<typeof s.doc.csvPage>>) => void
    s.doc.csvPage.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve }))
    const pending = s.dispatcher({ id: 77, method: 'csvPage', params: { ref, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 } })
    const readFlag = s.flags.at(-1)!
    expect(await s.call('cancel', { id: 77 })).toMatchObject({ result: true })
    expect(readFlag.cancel).toHaveBeenCalledOnce()
    resolvePage({ rows: [], completeRect: true, indexing: false })
    expect(await pending).toMatchObject({ id: 77, error: { code: 'Cancelled' } })
  })

  it('keeps the old published revision when a replacement configure fails', async () => {
    const s = setup()
    const doc = await openCsv(s)
    const old = await configure(s, doc)
    s.doc.csvConfigure.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'Cancelled' }))
    expect(await s.call('csvConfigure', { doc, gen: 1, options: { delimiter: ',', header: false } }))
      .toMatchObject({ error: { code: 'Cancelled' } })
    expect(await s.call('csvPage', { ref: old.ref, rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 }))
      .toHaveProperty('result.ref.revision', old.ref.revision)
  })

  it('does not cancel an in-flight piece when configure only polls the same revision', async () => {
    const s = setup()
    const doc = await openCsv(s)
    const { ref } = await configure(s, doc)
    let resolvePiece!: (value: Awaited<ReturnType<typeof s.doc.csvPiece>>) => void
    s.doc.csvPiece.mockImplementationOnce(() => new Promise((resolve) => { resolvePiece = resolve }))
    const piece = s.dispatcher({ id: 88, method: 'csvPiece', params: { continuation: { ref, sourceRecord: 1, column: 0, offset: 8 } } })
    const pieceFlag = s.flags.at(-1)!
    const same = await configure(s, doc)
    expect(same.ref).toEqual(ref)
    expect(pieceFlag.cancel).not.toHaveBeenCalled()
    resolvePiece({ sourceRecord: 1, column: 0, span: { start: 8, end: 14 }, pieceSpan: { start: 8, end: 14 }, text: '001', map: {}, replacements: 0 })
    expect(await piece).toMatchObject({ id: 88, result: { kind: 'value', sourceRecord: 1, column: 0, pieceSpan: { start: 8, end: 14 } } })
  })
})
