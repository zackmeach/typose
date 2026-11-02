import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Cancel, Doc, coreVersion, limits, reserveCache, setBudget } from 'typose-node'
import type { Opened, StructuredChildren, StructuredColumns, StructuredInfo, StructuredRows, SurfaceRef } from '../shared/protocol'
import { makeDispatcher } from './dispatch'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function client() {
  setBudget(totalmem())
  const directory = mkdtempSync(join(tmpdir(), 'typose-structured-'))
  const files: string[] = []
  const dispatcher = makeDispatcher({ coreVersion, limits, reserveCache, cancelFlag: () => new Cancel(), openDoc: (path) => Doc.open(path) }, 601, () => {})
  let next = 1
  const call = (method: string, params: Record<string, unknown>) => dispatcher({ id: next++, method, params })
  const value = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const response = await call(method, params)
    if ('error' in response) throw Object.assign(new Error(response.error.message), response.error)
    return response.result as T
  }
  const surface = await value<SurfaceRef>('createSurface', {})
  const docs: number[] = []
  cleanup.push(async () => {
    for (const doc of docs) await call('close', { surface, doc })
    for (const file of files) unlinkSync(file)
    rmdirSync(directory)
  })
  const open = async (name: string, bytes: string | Uint8Array) => {
    const path = join(directory, name)
    writeFileSync(path, bytes)
    files.push(path)
    const opened = await value<Opened>('open', { surface, path, count: 1, bytes: 0 })
    docs.push(opened.doc)
    return { opened, path }
  }
  return { open, value, call }
}

describe.skipIf(process.platform !== 'win32')('verified structured native bridge', () => {
  it('reads more than 1 KiB and exactly 64 KiB, and rejects stale views and generations', async () => {
    const c = await client()
    const bytes = new Uint8Array(65_540).map((_, index) => 32 + index % 90)
    const { opened, path } = await c.open('source.txt', bytes)
    expect(await c.value('sourceBytes', { view: opened.view, start: 3, count: 2048 })).toEqual(bytes.slice(3, 2051))
    expect(await c.value('sourceBytes', { view: opened.view, start: 0, count: 65_536 })).toEqual(bytes.slice(0, 65_536))
    expect(await c.call('sourceBytes', { view: opened.view, start: 0, count: 65_537 })).toMatchObject({ error: { code: 'InvalidParams' } })
    const native = Doc.open(path)
    try { await expect(native.sourceBytes(native.generation + 1, 0, 1, new Cancel())).rejects.toMatchObject({ code: 'Stale' }) }
    finally { native.close() }
    await c.open('next.txt', 'next')
    expect(await c.call('sourceBytes', { view: opened.view, start: 0, count: 1 })).toMatchObject({ error: { code: 'Stale' } })
  })

  it('verifies a copied source range again and refuses changed bytes', async () => {
    const c = await client()
    const { opened, path } = await c.open('changed.txt', 'first line\nsecond line\n')
    expect(await c.value('sourceBytes', { view: opened.view, start: 0, count: opened.size })).toHaveLength(opened.size)
    expect(await c.value('sourceVerify', { view: opened.view, start: 0, end: opened.size })).toBe(true)
    writeFileSync(path, 'other line\nsecond line\n')
    expect(await c.call('sourceVerify', { view: opened.view, start: 0, end: opened.size })).toMatchObject({ error: { code: 'Frozen' } })
  })

  it('publishes JSONC Tree pages with original number lexemes and duplicate-key problems', async () => {
    const c = await client()
    const { opened } = await c.open('data.json', '{/*comment*/"n":12345678901234567890,"n":3.10,"x":1e400,}')
    expect(opened.format).toBe('json')
    const info = await c.value<StructuredInfo>('structuredBuild', { view: opened.view })
    expect(info).toMatchObject({ parsedAs: 'jsonc', status: 'ready', root: { kind: 'object', children: 3 } })
    expect(info.problems).toMatchObject([{ kind: 'duplicate-key', count: 1 }])
    const page = await c.value<StructuredChildren>('structuredChildren', { ref: info.ref, container: info.root!.container, start: 0, count: 128 })
    expect(page.nodes.map((node) => node.key)).toEqual(['n', 'n', 'x'])
    expect(page.nodes.map((node) => node.text)).toEqual(['12345678901234567890', '3.10', '1e400'])
    expect(page.nodes.map((node) => node.duplicate)).toEqual([false, true, false])
    const second = page.nodes[1]
    const original = await c.value<Uint8Array>('sourceBytes', { view: opened.view, start: second.span.start, count: second.span.end - second.span.start })
    expect(new TextDecoder().decode(original)).toBe('3.10')
  })

  it('keeps physical JSONL record scopes and grows Table columns past the first thousand records', async () => {
    const c = await client()
    const bytes = ['', '{"message":"first","type":"info","timestamp":"2026-11-01","n":3.10,"nested":{"a":1}}', '{bad',
      ...Array.from({ length: 1000 }, (_, index) => `{"same":${index}}`), '{"late":true}'].join('\n')
    const { opened } = await c.open('records.ndjson', bytes)
    expect(opened.format).toBe('jsonl')
    const initial = await c.value<StructuredInfo>('structuredBuild', { view: opened.view })
    let info = initial
    const deadline = Date.now() + 10_000
    while (!info.done && info.status === 'indexing' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      info = await c.value<StructuredInfo>('structuredBuild', { view: opened.view })
      expect(info.ref).toEqual(initial.ref)
    }
    expect(info).toMatchObject({ done: true, parsed: 1002, failed: 1, blank: 1, rows: 1003, columns: 7 })
    expect(info.problems).toMatchObject([{ kind: 'parse', count: 1, line: 3 }])
    const columns = await c.value<StructuredColumns>('structuredColumns', { ref: info.ref, start: 0, count: 128 })
    expect(columns.columns.map((column) => column.key)).toEqual(['message', 'type', 'timestamp', 'n', 'nested', 'same', 'late'])
    expect(columns).toMatchObject({ total: 7, done: true })
    // Rows wait on the Raw line index, which can trail the structured build: an unindexed record end is an empty page.
    let rows = await c.value<StructuredRows>('structuredRows', { ref: info.ref, start: 0, count: 3 })
    while (rows.rows.length < 3 && !rows.done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      rows = await c.value<StructuredRows>('structuredRows', { ref: info.ref, start: 0, count: 3 })
    }
    expect(rows.rows.map((row) => [row.line, row.status])).toEqual([[1, 'valid'], [2, 'failed'], [3, 'valid']])
    expect(rows.rows[0]).toMatchObject({ summary: 'first', type: 'info', timestamp: '2026-11-01' })
    expect(rows.rows[1]?.summary).toBe('{bad')
    expect(rows.nextLine).toBe(4)
    const fields = await c.value<StructuredChildren>('structuredChildren', { ref: info.ref, record: 1, container: 0, start: 0, count: 128 })
    expect(fields.nodes.find((node) => node.key === 'n')?.text).toBe('3.10')
    const nested = fields.nodes.find((node) => node.key === 'nested')!
    const child = await c.value<StructuredChildren>('structuredChildren', { ref: info.ref, record: 1, container: nested.container, start: 0, count: 128 })
    expect(child.nodes).toMatchObject([{ key: 'a', text: '1' }])
    const otherRecord = await c.value<StructuredChildren>('structuredChildren', { ref: info.ref, record: 3, container: 0, start: 0, count: 128 })
    expect(otherRecord.nodes).toMatchObject([{ key: 'same', text: '0' }])
    const last = await c.value<StructuredRows>('structuredRows', { ref: info.ref, start: 1003, count: 128 })
    expect(last).toMatchObject({ rows: [{ line: 1003, status: 'valid' }], done: true })
    const start = Buffer.byteLength(bytes.slice(0, bytes.indexOf('{bad')))
    expect(await c.value('sourceLineAt', { view: opened.view, offset: 0 })).toEqual({ line: 0 })
    expect(await c.value('sourceLineAt', { view: opened.view, offset: start + 2 })).toEqual({ line: 2 })
    expect(await c.value('sourceLineRange', { view: opened.view, startLine: 2, count: 1 })).toEqual({ start, end: start + 5 })
    await c.open('replacement.txt', 'next')
    expect(await c.call('structuredRows', { ref: info.ref, start: 0, count: 1 })).toMatchObject({ error: { code: 'Stale' } })
  })

  it('keeps UTF-16 JSONL available as Raw without advertising a structured preview', async () => {
    const c = await client()
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}\n', 'utf16le')])
    const { opened } = await c.open('utf16.jsonl', bytes)
    const info = await c.value<StructuredInfo>('structuredBuild', { view: opened.view })
    expect(info).toMatchObject({ format: 'jsonl', status: 'locked', done: true })
    expect(info.reason).toContain('UTF-16')
    expect(await c.value('sourceBytes', { view: opened.view, start: 0, count: bytes.length })).toEqual(new Uint8Array(bytes))
  })
})
