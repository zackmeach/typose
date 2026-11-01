import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as addon from 'typose-node'
import { makeDispatcher } from './dispatch'
import type { CsvFindInfo, CsvFindPage, CsvFindSeek, CsvInfo, CsvOrderInfo, CsvPage, Opened, SourceFindInfo, SourceFindPage } from '../shared/protocol'

it('real native host bridge searches source and sorted cells, then releases exact view owners', async () => {
  addon.setBudget(8 * 1024 ** 3)
  const dir = mkdtempSync(join(tmpdir(), 'typose-find-host-'))
  const path = join(dir, 'data.csv')
  writeFileSync(path, 'key,value\nz,検索 needle\na,検索 needle\nm,other\n')
  const dispatch = makeDispatcher({ coreVersion: addon.coreVersion, limits: addon.limits, openDoc: (file) => addon.Doc.open(file),
    cancelFlag: () => new addon.Cancel(), reserveCache: addon.reserveCache }, 9, () => {})
  let request = 0, opened: Opened | undefined
  const call = async <T>(method: string, params: object): Promise<T> => {
    const response = await dispatch({ id: ++request, method, params })
    if ('error' in response) throw new Error(JSON.stringify(response.error))
    return response.result as T
  }
  try {
    opened = await call<Opened>('open', { path, count: 10, bytes: 0 })
    const source = await call<SourceFindInfo>('sourceFindStart', { view: opened.view, query: '検索', matchCase: true })
    const page = await call<SourceFindPage>('sourceFindScan', { ref: source.ref })
    expect(page.complete).toBe(true)
    expect(page.count).toBe(2)
    expect(page.hits[0].text).toContain('検索')

    let csv!: CsvInfo
    for (let tries = 0; tries < 100; tries++) {
      csv = await call<CsvInfo>('csvConfigure', { doc: opened.doc, gen: opened.gen, options: { delimiter: ',', header: true } })
      if (csv.done) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(csv.done).toBe(true)
    const sorted = await call<CsvOrderInfo>('csvSort', { view: opened.view, ref: csv.ref, interactionId: '00000000-0000-4000-8000-000000000001', column: 0, direction: 'asc' })
    const rows = await call<CsvPage>('csvOrderedPage', { order: sorted.order, rowStart: 0, rowCount: 3, columnStart: 0, columnCount: 2 })
    expect(rows.rows.map((row) => row.sourceRecord)).toEqual([2, 3, 1])
    expect(await call('csvOrderLocate', { order: sorted.order, sourceRecord: 1 })).toEqual({ dataRow: 2 })
    expect(await call('csvCell', { ref: csv.ref, sourceRecord: 0, column: 0 })).toMatchObject({ kind: 'value', text: 'key' })

    const found = await call<CsvFindInfo>('csvFindStart', { view: opened.view, order: sorted.order, query: 'needle', matchCase: false })
    const hits = await call<CsvFindPage>('csvFindScan', { ref: found.ref })
    expect(hits.complete).toBe(true)
    expect(hits.count).toBe(2)
    const next = await call<CsvFindSeek>('csvFindSeek', { ref: found.ref, direction: 'next' })
    expect(next.hit).toMatchObject({ dataRow: 0, sourceRecord: 2, column: 1 })
    expect(await call('deactivate', { view: opened.view })).toBe(true)
    const active = await call<Opened>('activate', { doc: opened.doc, gen: opened.gen, count: 10, bytes: 0 })
    const identity = await call<CsvPage>('csvOrderedPage', { order: { csv: csv.ref, id: 0 }, rowStart: 0, rowCount: 3, columnStart: 0, columnCount: 1 })
    expect(identity.rows.map((row) => row.sourceRecord)).toEqual([1, 2, 3])
    expect(await call('deactivate', { view: active.view })).toBe(true)
  } finally {
    if (opened) await call('close', { doc: opened.doc })
    rmSync(dir, { recursive: true, force: true })
  }
})
