import type { CsvOptions } from './protocol'

/** Restart records contain scalar presentation metadata, never native document/route capabilities. */
export interface SessionTab {
  location: { kind: 'manual' | 'reselect'; path: string } | { kind: 'folder'; path: string; root: { path: string; identity: string }; segments: string[] }
  anchor: number
  lens: 'raw' | 'rendered' | 'grid' | 'tree' | 'rows' | 'table' | 'transcript' | null
  csvOptions?: CsvOptions
}
export interface SessionCard { tabs: SessionTab[]; selected: number; weight: number }
export interface RecentLocation { kind: 'file' | 'folder'; path: string }
export interface SessionRoot { path: string; identity?: string }
export interface SessionWorkspace {
  version: 1
  roots: SessionRoot[]
  cards: SessionCard[]
  focused: number
  sidebar: { open: boolean; width: number }
  recents: RecentLocation[]
}
export interface SessionBounds { x?: number; y?: number; width: number; height: number; maximized: boolean }
export interface StoredSession extends SessionWorkspace { window?: SessionBounds }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// oxlint-disable-next-line no-control-regex -- Persisted paths must reject NUL and other control characters.
const path = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32_767 && !/[\u0000-\u001f]/.test(v)
// A drive path (`C:\` or `C:/`), a UNC path, or a POSIX one: a relative or drive-relative path would resolve against
// whatever directory the next launch happens to have. Only a folder tab's own path, display text, may be relative.
const absolute = (v: unknown): v is string => path(v) && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(v)
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const identity = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}-[0-9a-f]{32}$/.test(v)
// oxlint-disable-next-line no-control-regex -- Native root-relative components reject controls and separators.
const component = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255 && v !== '.' && v !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/.test(v)
export const emptySession = (): SessionWorkspace => ({ version: 1, roots: [], cards: [{ tabs: [], selected: -1, weight: 1 }], focused: 0, sidebar: { open: false, width: 240 }, recents: [] })

/** Reconstruct every accepted field; unknown keys/capabilities can never survive a disk round trip. */
export function sessionWorkspace(value: unknown): SessionWorkspace | null {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.roots) || value.roots.length > 16
    || !Array.isArray(value.cards) || !value.cards.length || value.cards.length > 16 || !Array.isArray(value.recents) || value.recents.length > 8
    || !record(value.sidebar) || typeof value.sidebar.open !== 'boolean' || !integer(value.sidebar.width, 180, 420)
    || !integer(value.focused, 0, value.cards.length - 1)) return null
  const roots: SessionRoot[] = []
  for (const root of value.roots) {
    if (absolute(root)) { roots.push({ path: root }); continue } // Existing sessions predate root identity capture.
    if (!record(root) || !absolute(root.path) || root.identity !== undefined && !identity(root.identity)) return null
    roots.push({ path: root.path, ...(root.identity ? { identity: root.identity as string } : {}) })
  }
  let total = 0
  const cards: SessionCard[] = []
  for (const card of value.cards) {
    if (!record(card) || !Array.isArray(card.tabs) || (total += card.tabs.length) > 256 || !integer(card.selected, card.tabs.length ? 0 : -1, card.tabs.length - 1)
      || typeof card.weight !== 'number' || !Number.isFinite(card.weight) || card.weight <= 0 || card.weight > 100_000) return null
    const tabs: SessionTab[] = []
    for (const tab of card.tabs) {
      if (!record(tab) || !record(tab.location) || !['manual', 'reselect', 'folder'].includes(tab.location.kind as string) || !(tab.location.kind === 'folder' ? path : absolute)(tab.location.path)
        || !integer(tab.anchor, 0, Number.MAX_SAFE_INTEGER) || ![null, 'raw', 'rendered', 'grid', 'tree', 'rows', 'table', 'transcript'].includes(tab.lens as null | string)) return null
      let csvOptions: CsvOptions | undefined
      if (tab.csvOptions !== undefined) {
        if (!record(tab.csvOptions) || !['auto', ',', '\t', ';', '|'].includes(tab.csvOptions.delimiter as string)
          || !['auto', true, false].includes(tab.csvOptions.header as string | boolean)) return null
        csvOptions = { delimiter: tab.csvOptions.delimiter as CsvOptions['delimiter'], header: tab.csvOptions.header as CsvOptions['header'] }
      }
      let location: SessionTab['location'] = { kind: tab.location.kind as 'manual' | 'reselect', path: tab.location.path }
      if (tab.location.kind === 'folder') {
        if (!record(tab.location.root) || !absolute(tab.location.root.path) || !identity(tab.location.root.identity) || !Array.isArray(tab.location.segments)
          || !tab.location.segments.length || tab.location.segments.length > 256 || !tab.location.segments.every(component)) return null
        const rootPath = tab.location.root.path, rootIdentity = tab.location.root.identity
        if (!roots.some(root => root.path === rootPath && root.identity === rootIdentity)) return null
        location = { kind: 'folder', path: tab.location.path, root: { path: tab.location.root.path, identity: tab.location.root.identity }, segments: [...tab.location.segments] }
      }
      tabs.push({ location, anchor: tab.anchor,
        lens: tab.lens as SessionTab['lens'], ...(csvOptions ? { csvOptions } : {}) })
    }
    cards.push({ tabs, selected: card.selected, weight: card.weight })
  }
  const recents: RecentLocation[] = []
  for (const recent of value.recents) {
    if (!record(recent) || !['file', 'folder'].includes(recent.kind as string) || !absolute(recent.path)) return null
    recents.push({ kind: recent.kind as 'file' | 'folder', path: recent.path })
  }
  return { version: 1, roots, cards, focused: value.focused,
    sidebar: { open: value.sidebar.open, width: value.sidebar.width }, recents }
}

export function sessionBounds(value: unknown): SessionBounds | undefined {
  if (!record(value) || !integer(value.width, 720, 16_384) || !integer(value.height, 480, 16_384) || typeof value.maximized !== 'boolean'
    || value.x !== undefined && !integer(value.x, -100_000, 100_000) || value.y !== undefined && !integer(value.y, -100_000, 100_000)) return undefined
  return { width: value.width, height: value.height, maximized: value.maximized,
    ...(value.x === undefined ? {} : { x: value.x as number }), ...(value.y === undefined ? {} : { y: value.y as number }) }
}
