import { expect, it } from 'vitest'
import type { Card } from './card'
import type { Opened } from '../shared/protocol'
import { WorkspaceMetadataQueue, WorkspaceStore, type TabTicket } from './workspace'

const opened = (doc: number, gen = 1, over: Partial<Opened> = {}): Opened => ({ doc, gen, format: 'markdown',
  size: 12, encoding: 'UTF-8', lines: 3, indexed: false, blank: false, reserved: 999,
  firstPage: { items: [] }, ...over })
const card = (path: string, result: Opened): Extract<Card, { kind: 'open' }> => ({ kind: 'open', path,
  opened: result, lines: result.lines, bytes: 0, indexed: result.indexed, lens: 'raw' })
function begin(store: WorkspaceStore, path: string): TabTicket {
  const request = store.beginOpen(path, path)
  if (request.kind !== 'open') throw Error('expected new tab')
  return request.ticket
}
function ready() { const store = new WorkspaceStore(); store.coreReady(1); return store }

it('last-close invalidates a held metadata grant and queued requests without blocking a new workspace', async () => {
  const queue = new WorkspaceMetadataQueue()
  let release!: () => void
  const grant = new Promise<void>((done) => { release = done })
  const published: string[] = []
  const held = queue.run(async (current) => {
    await grant
    if (current()) published.push('B')
    return 'B'
  }, () => true)
  const queued = queue.run(async () => { published.push('D'); return 'D' }, () => true)
  expect(queue.pending).toBe(2)
  await Promise.resolve()
  queue.invalidate()
  expect(queue.pending).toBe(2) // invalidated controllers retain their old paths until they unwind
  const fresh = queue.run(async (current) => { if (current()) published.push('C'); return 'C' }, () => true)
  expect(await fresh).toBe('C')
  expect(queue.pending).toBe(2)
  expect(published).toEqual(['C'])
  release()
  expect(await held).toBeNull()
  expect(await queued).toBeNull()
  expect(queue.pending).toBe(0)
  expect(published).toEqual(['C'])
})

it('a session invalidated while a queued metadata callback waits cannot publish afterward', async () => {
  const queue = new WorkspaceMetadataQueue()
  let session = 1
  let release!: () => void
  const grant = new Promise<void>((done) => { release = done })
  let published = false
  const result = queue.run(async (current) => {
    await grant
    if (current()) published = true
    return 'old session'
  }, () => session === 1)
  await Promise.resolve()
  session = 2
  release()
  expect(await result).toBeNull()
  expect(published).toBe(false)
})

it('deduplicates caller keys while an open is pending and keeps stable snapshots for no-ops', () => {
  const store = ready()
  let notifications = 0
  const off = store.subscribe(() => notifications++)
  const a = begin(store, 'a.md')
  const before = store.getSnapshot()
  const duplicate = store.beginOpen('a.md', 'alias ignored by caller key')
  expect(duplicate.kind).toBe('existing')
  expect(store.getSnapshot()).toBe(before)
  expect(store.close('absent')).toBeUndefined()
  expect(store.getSnapshot()).toBe(before)
  expect(notifications).toBe(1)
  off()
  store.markSlow(a)
  expect(notifications).toBe(1)
})

it('projects inactive metadata without retaining payload arrays, viewport leases or mutable build objects', () => {
  const store = ready()
  const ticket = begin(store, 'a.md')
  const payload = opened(4)
  const build = { blocks: 2, units: 12, htmlBytes: 40, nodes: 6, noteUnits: 0 }
  expect(store.complete(ticket, 'a.md', { ...card('a.md', payload), build })).toBe(true)
  begin(store, 'b.md')
  const saved = store.tab(ticket.tab)!.card
  expect(saved.kind).toBe('open')
  if (saved.kind !== 'open') throw Error('open')
  expect(saved.opened).not.toHaveProperty('firstPage')
  expect(saved.opened).not.toHaveProperty('reserved')
  expect(saved.build).not.toBe(build)
  payload.lines = 50
  build.units = 900
  expect(saved.opened.lines).toBe(3)
  expect(saved.build?.units).toBe(12)
  expect(Object.isFrozen(saved.opened)).toBe(true)
})

it('keeps independent operation and selection epochs through A to B to A', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  const first = store.selection()!
  const b = begin(store, 'b.md')
  const back = store.select(a.tab)!
  expect(store.selected(first)).toBe(false)
  expect(store.selected(back)).toBe(true)
  expect(store.current(a)).toBe(true)
  expect(store.complete(b, 'b.md', card('b.md', opened(2)))).toBe(true)
  expect(store.getSnapshot().selected).toBe(a.tab)
  expect(store.complete(a, 'a.md', card('a.md', opened(1)))).toBe(true)
  expect(store.current(a)).toBe(false)
  expect(store.selected(back)).toBe(true)
  const retry = store.select(a.tab, true)!
  expect(store.selected(back)).toBe(false)
  expect(store.selected(retry)).toBe(true)
})

it('invalidates closed and replaced requests without closing any borrowed document itself', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  const b = begin(store, 'b.md')
  const removed = store.close(a.tab)
  expect(removed?.card.kind).toBe('opening')
  expect(store.complete(a, 'a.md', card('a.md', opened(1)))).toBe(false)
  store.complete(b, 'b.md', card('b.md', opened(2)))
  const reload = store.begin(b.tab)!
  const replace = store.begin(b.tab)!
  expect(store.complete(reload, 'b.md', card('b.md', opened(2, 2)))).toBe(false)
  expect(store.complete(replace, 'local:3', card('c.md', opened(3)))).toBe(true)
  const closed = store.close(b.tab)!
  expect(closed.card.kind === 'open' && closed.card.opened.doc).toBe(3)
  expect(store.close(b.tab)).toBeUndefined()
})

it('routes inactive progress only by current session, document and generation', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  store.complete(a, 'a.md', card('a.md', opened(1)))
  begin(store, 'b.md')
  const event = { event: 'progress' as const, session: 1, doc: 1, gen: 1, lines: 20, bytes: 100, done: true }
  expect(store.progress({ ...event, session: 0 })).toBe(false)
  expect(store.progress({ ...event, gen: 2 })).toBe(false)
  expect(store.progress(event)).toBe(true)
  expect(store.tab(a.tab)!.card).toMatchObject({ lines: 20, bytes: 100, indexed: true })
  const native = store.tab(a.tab)!.card
  expect(native.kind === 'open' && store.updateDocument(event, (c) => ({ ...c, opened: { ...c.opened, doc: 8 } }))).toBe(false)
})

it('preserves per-tab explicit lens and source anchor on Reload but clears both on local replacement', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  store.complete(a, 'a.md', card('a.md', opened(1)))
  store.remember(a.tab, 200, 'raw')
  store.complete(store.begin(a.tab)!, 'a.md', card('a.md', opened(1, 2)))
  expect(store.tab(a.tab)).toMatchObject({ anchor: 200, preferredLens: 'raw' })
  store.complete(store.begin(a.tab)!, 'local:2', card('child.md', opened(2, 1, { localOnly: true })))
  expect(store.tab(a.tab)).toMatchObject({ anchor: undefined, preferredLens: null })
})

it('publishes a saved-location push and Back pop with their document replacement and restores lens/place', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  store.complete(a, 'a.md', card('a.md', opened(1)))
  const entry = { location: { kind: 'manual' as const, path: 'a.md' }, path: 'a.md', anchor: 120, lens: 'raw' as const }
  let publications = 0
  store.subscribe(() => { publications++ })
  expect(store.complete(store.begin(a.tab)!, 'local:2', card('b.md', opened(2, 1, { localOnly: true })), { push: entry })).toBe(true)
  expect(publications).toBe(1)
  expect(store.tab(a.tab)!.back).toEqual([entry])
  expect(store.complete(store.begin(a.tab)!, 'a.md', { ...card('a.md', opened(3)), atLine: 120 }, { pop: true, restore: entry })).toBe(true)
  expect(publications).toBe(2)
  expect(store.tab(a.tab)).toMatchObject({ back: [], anchor: 120, preferredLens: 'raw' })
})

it('a refused replacement keeps its history and derived authority separate from matching manual paths', () => {
  const store = ready()
  const a = begin(store, 'a.md'), b = begin(store, 'b.md')
  store.complete(a, 'a.md', card('a.md', opened(1)))
  store.complete(b, 'b.md', card('b.md', opened(2)))
  const entry = { location: { kind: 'derived' as const, ticket: { session: 1, id: 'saved-route' } }, path: 'a.md', anchor: 12, lens: null }
  store.complete(store.begin(a.tab)!, 'local:3', card('c.md', opened(3, 1, { localOnly: true })), { push: entry })
  expect(store.complete(store.begin(a.tab)!, 'b.md', card('b.md', opened(4)), { pop: true, restore: entry })).toBe(false)
  expect(store.tab(a.tab)!.back).toEqual([entry])
  expect(store.tab(a.tab)!.path).toBe('c.md')
})

it('keeps a collision source owned and consumes its completion ticket', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  store.complete(a, 'a.md', card('a.md', opened(1)))
  const b = begin(store, 'b.md')
  store.complete(b, 'b.md', card('b.md', opened(2)))
  const replacement = store.begin(a.tab)!
  expect(store.complete(replacement, 'b.md', card('b.md', opened(3)))).toBe(false)
  expect(store.current(replacement)).toBe(false)
  expect(store.tab(a.tab)?.path).toBe('a.md')
  expect(store.tab(b.tab)?.path).toBe('b.md')
})

it('closing an inactive tab preserves selection; closing the active tab selects its adjacent neighbor', () => {
  const store = ready()
  const a = begin(store, 'a.md')
  const b = begin(store, 'b.md')
  const c = begin(store, 'c.md')
  store.select(b.tab)
  const selection = store.selection()!
  store.close(a.tab)
  expect(store.selected(selection)).toBe(true)
  store.close(b.tab)
  expect(store.getSnapshot().selected).toBe(c.tab)
  expect(store.selected(selection)).toBe(false)
  store.close(c.tab)
  expect(store.getSnapshot()).toMatchObject({ selected: null, tabs: [] })
})

it('preserves local-only recovery and anchors across a restart while rejecting reused native ids', () => {
  const store = ready()
  const a = begin(store, 'derived.md')
  store.complete(a, 'derived.md', card('derived.md', opened(1, 1, { localOnly: true })))
  store.remember(a.tab, 19, 'rendered')
  const stale = store.begin(a.tab)!
  const selected = store.selection()!
  store.coreGone(1)
  expect(store.tab(a.tab)?.card).toMatchObject({ kind: 'gone', localOnly: true, line: 19, ready: false })
  expect(store.current(stale)).toBe(false)
  store.coreReady(2)
  expect(store.tab(a.tab)?.card).toMatchObject({ kind: 'gone', localOnly: true, line: 19, ready: true })
  expect(store.selected(selected)).toBe(false)
  expect(store.complete(stale, 'derived.md', card('derived.md', opened(1)))).toBe(false)
  expect(store.progress({ event: 'progress', session: 1, doc: 1, gen: 1, lines: 99, bytes: 99, done: true })).toBe(false)
})
