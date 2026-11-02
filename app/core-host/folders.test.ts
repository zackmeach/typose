import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Cancel, Doc, FolderRoot, limits, reserveCache, setBudget } from 'typose-node'
import type { Page } from 'typose-node'
import { makeDispatcher, type Addon } from './dispatch'
import type { FolderPage, FolderRoot as RootInfo } from '../shared/protocol'

const folders: string[] = []
afterEach(() => { reserveCache(0); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
const scratch = () => { const path = mkdtempSync(join(tmpdir(), 'typose-folder-')); folders.push(path); return path }
const windows = it.skipIf(process.platform !== 'win32')

windows('real NAPI lists root node zero, keeps stable refs, and preserves selected scope after removal/reopen', async () => {
  setBudget(totalmem())
  const path = scratch()
  writeFileSync(join(path, 'source.md'), '# Source\n')
  writeFileSync(join(path, 'data.csv'), 'a,b\n1,2\n')
  expect(() => Reflect.construct(FolderRoot, [])).toThrow()
  const root = FolderRoot.capture(path, '1')
  const page = await root.list(0, undefined, false, new Cancel())
  const entry = page.entries.find((e) => e.name === 'source.md')!
  expect(entry).toBeDefined()
  const refreshed = await root.list(0, undefined, false, new Cancel())
  expect(refreshed.entries.find((e) => e.name === 'source.md')!.id).toBe(entry.id)
  const doc = root.open(entry.id)
  const route = doc.saveRoute(1)
  expect(doc.folder).toMatchObject({ root: '1', label: path.split(/[\\/]/).at(-1), segments: ['source.md'] })
  expect(root.close()).toBe(true)
  expect(root.close()).toBe(false)
  expect(() => root.open(entry.id)).toThrow()
  const reopened = route.open()
  expect(reopened.localOnly).toBe(true)
  await reopened.render(1, new Cancel())
  expect(reopened.localPath(1, '/source.md')).toBe(join(path, 'source.md'))
  expect(() => reopened.localPath(1, '../outside.md')).toThrow(expect.objectContaining({ code: 'Refused' }))
  reopened.reload()
  expect(reopened.folder?.root).toBe('1')
  route.release(); doc.close(); reopened.close()
})

windows('real host remove cancels unpublished child first page while existing document and ticket remain usable', async () => {
  setBudget(totalmem())
  const path = scratch()
  writeFileSync(join(path, 'data.csv'), 'a,b\n1,2\n')
  const dispatch = makeDispatcher({ limits, coreVersion: () => 'test', openDoc: (p) => Doc.open(p),
    captureFolder: (p, id) => FolderRoot.capture(p, id), cancelFlag: () => new Cancel(), reserveCache }, 7, () => {})
  let next = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: next++, method, params })
  const added = await call('addRoot', { path })
  if (!('result' in added)) throw Error(JSON.stringify(added))
  const root = added.result as RootInfo
  const listed = await call('listFolder', { folder: root.ref })
  if (!('result' in listed)) throw Error(JSON.stringify(listed))
  const entry = (listed.result as FolderPage).entries.find((e) => e.name === 'data.csv')!
  expect(await call('openChild', { entry: entry.ref, count: 1, bytes: 100 })).toMatchObject({ result: { doc: 1, localOnly: true, format: 'csv' } })
  const captured = await call('captureLocation', { doc: 1, gen: 1 })
  if (!('result' in captured)) throw Error(JSON.stringify(captured))
  const { ticket } = captured.result as { ticket: unknown }
  const pending = dispatch({ id: 1000, method: 'openChild', params: { entry: entry.ref, count: 1, bytes: 200 } })
  expect(await call('removeRoot', { root: root.ref.root, session: 6 })).toMatchObject({ result: false })
  expect(await call('removeRoot', { root: root.ref.root, session: 7 })).toMatchObject({ result: true })
  expect(await pending).toMatchObject({ error: { code: expect.stringMatching(/Cancelled|Stale/) } })
  expect(await call('page', { doc: 1, gen: 1, lens: 'raw', start: 0, count: 1 })).toHaveProperty('result.items')
  expect(await call('openChild', { entry: entry.ref, count: 1, bytes: 100 })).toMatchObject({ error: { code: 'Stale' } })
  const reopened = await call('openSaved', { ticket, count: 1, bytes: 100 })
  expect(reopened).toHaveProperty('result.folder.root', root.ref.root)
  await call('releaseSaved', { ticket }); await call('close', { doc: 1 })
  if ('result' in reopened) await call('close', { doc: (reopened.result as { doc: number }).doc })
})

windows('real host resolves and opens root-relative links only through the source selected folder', async () => {
  setBudget(totalmem())
  const path = scratch(), outside = scratch()
  mkdirSync(join(path, 'guide'))
  writeFileSync(join(path, 'source.md'), '# Source\n[Next](/guide/B.md)\n')
  writeFileSync(join(path, 'guide', 'B.md'), '# Target\n')
  writeFileSync(join(outside, 'manual.md'), '# Outside\n')
  const dispatch = makeDispatcher({ limits, coreVersion: () => 'test', openDoc: (p) => Doc.open(p),
    captureFolder: (p, id) => FolderRoot.capture(p, id), cancelFlag: () => new Cancel(), reserveCache }, 7, () => {})
  let next = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: next++, method, params })
  const opened: number[] = []
  let rootId: string | undefined
  try {
    const added = await call('addRoot', { path })
    if (!('result' in added)) throw Error(JSON.stringify(added))
    const root = added.result as RootInfo
    rootId = root.ref.root
    const listed = await call('listFolder', { folder: root.ref })
    if (!('result' in listed)) throw Error(JSON.stringify(listed))
    const source = (listed.result as FolderPage).entries.find((e) => e.name === 'source.md')!
    const sourceReply = await call('openChild', { entry: source.ref, count: 1, bytes: 100 })
    if (!('result' in sourceReply)) throw Error(JSON.stringify(sourceReply))
    const doc = (sourceReply.result as { doc: number }).doc
    opened.push(doc)
    expect(await call('render', { doc, gen: 1 })).toHaveProperty('result.blocks')
    for (const target of ['/guide/B.md', '\\guide\\B.md']) {
      expect(await call('resolve', { doc, gen: 1, href: target })).toMatchObject({ result: { kind: 'local', target, path: join(path, 'guide', 'B.md') } })
      const reply = await call('openLocal', { doc, gen: 1, target, count: 1, bytes: 100 })
      expect(reply).toMatchObject({ result: { localOnly: true, folder: { root: rootId, segments: ['guide', 'B.md'] } } })
      if ('result' in reply) opened.push((reply.result as { doc: number }).doc)
    }
    expect(await call('openLocal', { doc, gen: 1, target: '/../outside.md', count: 1, bytes: 100 })).toMatchObject({ error: { code: 'Refused' } })
    expect(await call('page', { doc, gen: 1, lens: 'raw', start: 0, count: 1 })).toHaveProperty('result.items')
    const manual = await call('open', { path: join(outside, 'manual.md'), count: 1, bytes: 100 })
    if (!('result' in manual)) throw Error(JSON.stringify(manual))
    const manualDoc = (manual.result as { doc: number }).doc
    opened.push(manualDoc)
    expect(await call('resolve', { doc: manualDoc, gen: 1, href: '/guide/B.md' })).toMatchObject({ result: { kind: 'inert' } })
    expect(await call('openLocal', { doc: manualDoc, gen: 1, target: '/guide/B.md', count: 1, bytes: 100, allowRooted: true }))
      .toMatchObject({ error: { code: 'InvalidParams' } })
  } finally {
    for (const doc of opened) await call('close', { doc })
    if (rootId) await call('removeRoot', { root: rootId, session: 7 })
  }
})

windows('Z79: real host turns only held documents, listed entries and program links into hand-off paths', async () => {
  setBudget(totalmem())
  const path = scratch()
  writeFileSync(join(path, 'source.md'), '# Source\n[Setup](setup.bat)\n')
  writeFileSync(join(path, 'cover.png'), 'not a png')
  writeFileSync(join(path, 'setup.bat'), '@echo off\n')
  writeFileSync(join(path, 'other.bat'), '@echo off\n')
  const dispatch = makeDispatcher({ limits, coreVersion: () => 'test', openDoc: (p) => Doc.open(p),
    captureFolder: (p, id) => FolderRoot.capture(p, id), cancelFlag: () => new Cancel(), reserveCache }, 7, () => {})
  let next = 1
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: next++, method, params })
  const added = await call('addRoot', { path })
  if (!('result' in added)) throw Error(JSON.stringify(added))
  const root = added.result as RootInfo
  const listed = await call('listFolder', { folder: root.ref })
  if (!('result' in listed)) throw Error(JSON.stringify(listed))
  const entries = (listed.result as FolderPage).entries
  const cover = entries.find((e) => e.name === 'cover.png')!
  expect(cover.kind).toBe('unsupported')
  expect(dispatch.handoffPath({ entry: cover.ref })).toBe(join(path, 'cover.png'))
  expect(() => dispatch.handoffPath({ entry: { ...cover.ref, node: '4095' } })).toThrow()
  const source = entries.find((e) => e.name === 'source.md')!
  const opened = await call('openChild', { entry: source.ref, count: 1, bytes: 100 })
  if (!('result' in opened)) throw Error(JSON.stringify(opened))
  const doc = (opened.result as { doc: number }).doc
  await call('render', { doc, gen: 1 })
  expect(dispatch.handoffPath({ session: 7, doc, gen: 1 })).toBe(join(path, 'source.md'))
  expect(await call('resolve', { doc, gen: 1, href: 'setup.bat' })).toMatchObject({ result: { kind: 'executable', target: 'setup.bat', path: join(path, 'setup.bat') } })
  expect(dispatch.handoffPath({ session: 7, doc, gen: 1, href: 'setup.bat' })).toBe(join(path, 'setup.bat'))
  // An existing program the document doesn't link to: the native build has no such link.
  expect(await call('resolve', { doc, gen: 1, href: 'other.bat' })).toMatchObject({ error: { code: 'Refused' } })
  expect(() => dispatch.handoffPath({ session: 7, doc, gen: 1, href: 'other.bat' })).toThrow('the document doesn\'t link to this target')
  for (const subject of [{ session: 7, doc, gen: 1, href: 'cover.png' }, { session: 7, doc, gen: 1, href: '/../outside.bat' }, { session: 6, doc, gen: 1 },
    { session: 7, doc, gen: 1, href: './setup.bat' }, { session: 7, doc, gen: 1, href: 7 },
    { session: 7, doc, gen: 2 }, { session: 7, doc: doc + 1, gen: 1 }, { path: join(path, 'source.md') }, null])
    expect(() => dispatch.handoffPath(subject), JSON.stringify(subject)).toThrow()
  await call('close', { doc })
  expect(() => dispatch.handoffPath({ session: 7, doc, gen: 1 })).toThrow()
  await call('removeRoot', { root: root.ref.root, session: 7 })
  expect(() => dispatch.handoffPath({ entry: cover.ref })).toThrow()
})

it('precharges root metadata and preserves source across rejected admission and removed pending listing', async () => {
  const page = { items: [] } as Page
  const doc = { generation: 1, format: 'text', size: 0, encoding: 'UTF-8', lines: 0, indexed: true, blank: true,
    page: vi.fn(async () => page), startIndex: vi.fn(), close: vi.fn(), setCacheActive: vi.fn() } as unknown as Doc
  let resolve!: (value: { entries: never[] }) => void
  const native = { path: 'C:\\owned', label: 'owned', list: vi.fn(() => new Promise<{ entries: never[] }>((ok) => { resolve = ok })), open: vi.fn(() => ({ ...doc, localOnly: true, path: 'C:\\owned\\a.txt' })), close: vi.fn() }
  const capture = vi.fn(() => native as unknown as FolderRoot)
  const reserve = vi.fn(() => true)
  const flags: { cancel: ReturnType<typeof vi.fn> }[] = []
  const flag = vi.fn(() => { const f = { cancel: vi.fn() }; flags.push(f); return f as unknown as Cancel })
  const addon: Addon = { limits, coreVersion: () => 'test', openDoc: () => doc, captureFolder: capture, reserveCache: reserve, cancelFlag: flag }
  const dispatch = makeDispatcher(addon, 7, () => {})
  const call = (id: number, method: string, params: Record<string, unknown>) => dispatch({ id, method, params })
  await call(1, 'open', { path: 'source', count: 1, bytes: 100 })
  reserve.mockReturnValueOnce(false)
  expect(await call(2, 'addRoot', { path: 'C:\\owned' })).toMatchObject({ error: { code: 'Memory' } })
  expect(capture).not.toHaveBeenCalled()
  const added = await call(3, 'addRoot', { path: 'C:\\owned' })
  expect(added).toHaveProperty('result.ref.node', '0')
  const ref = { session: 7, root: '1', node: '0' }
  const pending = call(4, 'listFolder', { folder: ref })
  expect(await call(4, 'removeRoot', { root: '1', session: 7 })).toMatchObject({ error: { code: 'InvalidParams' } })
  expect(native.close).not.toHaveBeenCalled()
  expect(await call(5, 'removeRoot', { root: '1', session: 7 })).toMatchObject({ result: true })
  expect(flags.at(-1)!.cancel).toHaveBeenCalledOnce()
  resolve({ entries: [] })
  expect(await pending).toMatchObject({ error: { code: 'Cancelled' } })
  expect(doc.close).not.toHaveBeenCalled()
  expect(await call(6, 'page', { doc: 1, gen: 1, lens: 'raw', start: 0, count: 1 })).toHaveProperty('result.items')
})
