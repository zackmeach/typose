import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { emptySession } from '../shared/session'
import { SessionStore } from './session-store'

it('atomically round trips a two-card session and strips runtime capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'typose-session-'))
  try {
    const file = join(dir, 'session.json'), store = new SessionStore(file)
    const workspace = { ...emptySession(), cards: [
      { tabs: [{ location: { kind: 'manual', path: 'C:\\one.md' }, anchor: 42, lens: 'rendered', doc: 4, ticket: { id: 'secret' } }], selected: 0, weight: 2 },
      { tabs: [{ location: { kind: 'reselect', path: 'C:\\derived.md', ticket: { id: 'secret' } }, anchor: 7, lens: 'raw' }], selected: 0, weight: 1 }
    ], focused: 1 }
    expect(store.update(workspace)).toBe(true)
    expect(store.flush()).toBe(true)
    const reopened = new SessionStore(file).snapshot()
    expect(reopened.cards).toHaveLength(2)
    expect(reopened.cards[0].tabs[0]).toEqual({ location: { kind: 'manual', path: 'C:\\one.md' }, anchor: 42, lens: 'rendered' })
    expect(reopened.cards[1].tabs[0].location.kind).toBe('reselect')
    expect(readFileSync(file, 'utf8')).not.toContain('secret')
    expect(store.update({ ...workspace, cards: [{ ...workspace.cards[0], selected: 7 }] })).toBe(false)
    expect(store.snapshot()).toEqual(reopened)
    // Z78's crash mark survives a round trip as `true` only; any other value refuses the record.
    const crashed = (value: unknown) => ({ ...workspace, cards: [{ ...workspace.cards[0], tabs: [{ ...workspace.cards[0].tabs[0], crashed: value }] }, workspace.cards[1]] })
    expect(store.update(crashed(true))).toBe(true)
    expect(store.snapshot().cards[0].tabs[0]).toEqual({ location: { kind: 'manual', path: 'C:\\one.md' }, anchor: 42, lens: 'rendered', crashed: true })
    for (const value of [false, 1, 'true']) expect(store.update(crashed(value)), String(value)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('ignores malformed disk sessions and preserves validated bounds across workspace saves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'typose-session-'))
  try {
    const file = join(dir, 'session.json')
    writeFileSync(file, '{broken')
    const store = new SessionStore(file)
    expect(store.snapshot()).toEqual(emptySession())
    store.bounds({ width: 1000, height: 700, x: 40, y: 50, maximized: true })
    expect(store.update(emptySession())).toBe(true)
    expect(store.flush()).toBe(true)
    expect(new SessionStore(file).snapshot().window).toEqual({ width: 1000, height: 700, x: 40, y: 50, maximized: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('validates root-relative restart recipes and rejects traversal or mismatched root authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'typose-session-'))
  try {
    const store = new SessionStore(join(dir, 'session.json'))
    const root = { path: 'C:\\approved', identity: '0000000000000001-00000000000000000000000000000001' }
    const recipe = { kind: 'folder', path: 'display-only.csv', root, segments: ['sub', 'tasks.csv'] }
    const saved = { ...emptySession(), roots: [root], cards: [{ tabs: [{ location: recipe, anchor: 120, lens: 'grid' }], selected: 0, weight: 1 }] }
    expect(store.update(saved)).toBe(true)
    for (const segments of [['..', 'outside.csv'], ['C:\\outside.csv'], ['sub/tasks.csv'], []]) {
      expect(store.update({ ...saved, cards: [{ ...saved.cards[0], tabs: [{ ...saved.cards[0].tabs[0], location: { ...recipe, segments } }] }] })).toBe(false)
    }
    expect(store.update({ ...saved, roots: [{ ...root, identity: '0000000000000001-00000000000000000000000000000002' }] })).toBe(false)
    expect(store.snapshot().cards[0].tabs[0].location).toEqual(recipe)
    store.flush()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
