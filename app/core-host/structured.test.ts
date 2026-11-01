import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Cancel, Doc, coreVersion, limits, reserveCache, setBudget } from 'typose-node'
import type { Opened, StructuredChildren, StructuredInfo, SurfaceRef } from '../shared/protocol'
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
    expect(page.nodes.map((node) => node.text)).toEqual(['12345678901234567890', '3.10', '1e400'])
    expect(page.nodes.map((node) => node.duplicate)).toEqual([false, true, false])
    const second = page.nodes[1]
    const original = await c.value<Uint8Array>('sourceBytes', { view: opened.view, start: second.span.start, count: second.span.end - second.span.start })
    expect(new TextDecoder().decode(original)).toBe('3.10')
  })
})
