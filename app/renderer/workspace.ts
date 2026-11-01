import type { Card } from './card'
import type { CapturedLocation, Opened, ProgressEvent } from '../shared/protocol'

export type TabId = string
export type LensChoice = 'raw' | 'rendered' | null
/** A saved location owns scalar metadata and, for derived files, one native route ticket. */
export interface SavedLocation {
  readonly location: CapturedLocation
  readonly path: string
  readonly anchor: number
  readonly lens: LensChoice
}
type OpenCard = Extract<Card, { kind: 'open' }>
type FinishedCard = Extract<Card, { kind: 'open' | 'failed' }>

/** Inactive tabs retain metadata, never a first-page payload or a viewport reservation. */
export type StoredOpenCard = Readonly<Omit<OpenCard, 'opened'> & {
  opened: Readonly<Omit<Opened, 'firstPage' | 'reserved'>>
}>
export type StoredCard = StoredOpenCard | Readonly<Exclude<Card, { kind: 'open' | 'empty' | 'connecting' }>>

export interface WorkspaceTab {
  readonly id: TabId
  /** Supplied by the caller. This store does no filesystem canonicalization. */
  readonly key: string
  readonly path: string
  /** The native session that produced this tab's current metadata. */
  readonly session: number
  readonly card: StoredCard
  /** Zero-based source line, captured before the selected controller is disposed. */
  readonly anchor?: number
  /** Null retains Markdown's automatic first-lens choice; a user choice belongs to this tab. */
  readonly preferredLens: LensChoice
  readonly back?: readonly SavedLocation[]
}

export interface WorkspaceSnapshot {
  readonly session: number
  readonly ready: boolean
  readonly tabs: readonly WorkspaceTab[]
  readonly selected: TabId | null
}

/** A native open/reload/replacement completion may update only the operation that requested it. */
export interface TabTicket { readonly tab: TabId; readonly version: number; readonly session: number }
/** A late activation cannot take the screen after A -> B -> A or a core restart. */
export interface SelectionTicket { readonly tab: TabId; readonly version: number; readonly session: number }
export interface DocumentRef { readonly session: number; readonly doc: number; readonly gen: number }

/** Controller work can wait for native grants; closing the last tab starts a new queue without waiting for them. */
export class WorkspaceMetadataQueue {
  private epoch = 0
  private serial = Promise.resolve()
  private pendingCount = 0

  get pending(): number { return this.pendingCount }

  run<T>(work: (current: () => boolean) => Promise<T>, valid: () => boolean): Promise<T | null> {
    const epoch = this.epoch
    this.pendingCount++
    const current = () => epoch === this.epoch && valid()
    const result = this.serial.then(() => current() ? work(current) : null).then((value) => current() ? value : null)
      .finally(() => { this.pendingCount-- })
    this.serial = result.then(() => {}, () => {})
    return result
  }

  invalidate(): void {
    this.epoch++
    this.serial = Promise.resolve()
  }
}

export type OpenRequest =
  | { kind: 'unavailable' }
  | { kind: 'existing'; tab: TabId; selection: SelectionTicket }
  | { kind: 'open'; ticket: TabTicket; selection: SelectionTicket }

function retainOpened(opened: StoredOpenCard['opened']): StoredOpenCard['opened'] {
  const { doc, gen, format, size, encoding, lines, indexed, blank, localOnly, path, folder } = opened
  return Object.freeze({ doc, gen, format, size, encoding, lines, indexed, blank,
    ...(localOnly ? { localOnly } : {}), ...(path !== undefined ? { path } : {}),
    ...(folder ? { folder: { ...folder, segments: [...folder.segments] } } : {}) })
}

function retain(card: FinishedCard): StoredCard {
  if (card.kind !== 'open') return Object.freeze({ ...card })
  return Object.freeze({
    ...card,
    opened: retainOpened(card.opened),
    ...(card.build ? { build: Object.freeze({ ...card.build }) } : {})
  })
}

/** Pure workspace metadata. The controller owns every native call, lens, Blob and memory lease. */
export class WorkspaceStore {
  private state: WorkspaceSnapshot = Object.freeze({ session: 0, ready: false, tabs: Object.freeze([]), selected: null })
  private readonly listeners = new Set<() => void>()
  private readonly versions = new Map<TabId, number>()
  private nextTab = 1
  private selectionVersion = 0

  readonly getSnapshot = (): WorkspaceSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  tab(id: TabId): WorkspaceTab | undefined { return this.state.tabs.find((tab) => tab.id === id) }
  find(key: string): WorkspaceTab | undefined { return this.state.tabs.find((tab) => tab.key === key) }

  beginOpen(key: string, path: string, index = this.state.tabs.length): OpenRequest {
    if (!this.state.ready) return { kind: 'unavailable' }
    const existing = this.find(key)
    if (existing) return { kind: 'existing', tab: existing.id, selection: this.select(existing.id)! }
    const id = `tab-${this.nextTab++}`
    const tab: WorkspaceTab = Object.freeze({ id, key, path, session: this.state.session,
      card: Object.freeze({ kind: 'opening', path, slow: false }), preferredLens: null })
    this.versions.set(id, 1)
    this.selectionVersion++
    const tabs = [...this.state.tabs]
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab)
    this.publish({ ...this.state, tabs, selected: id })
    return { kind: 'open', ticket: { tab: id, version: 1, session: this.state.session }, selection: this.selection()! }
  }

  /** Start Reload, local replacement or Reopen without discarding the currently usable metadata. */
  begin(id: TabId): TabTicket | null {
    if (!this.state.ready || !this.tab(id)) return null
    const version = (this.versions.get(id) ?? 0) + 1
    this.versions.set(id, version)
    return { tab: id, version, session: this.state.session }
  }

  current(ticket: TabTicket): boolean {
    return this.state.ready && ticket.session === this.state.session && this.versions.get(ticket.tab) === ticket.version
  }

  markSlow(ticket: TabTicket): void {
    if (!this.current(ticket)) return
    this.change(ticket.tab, (tab) => tab.card.kind !== 'opening' || tab.card.slow ? tab :
      { ...tab, card: Object.freeze({ ...tab.card, slow: true }) })
  }

  /** False means the caller still owns the returned native resource; the store never closes one. */
  complete(ticket: TabTicket, key: string, card: FinishedCard, navigation?: { push?: SavedLocation; pop?: boolean; restore?: SavedLocation }): boolean {
    if (!this.current(ticket)) return false
    const collision = this.find(key)
    this.versions.set(ticket.tab, ticket.version + 1)
    if (collision && collision.id !== ticket.tab) return false
    this.change(ticket.tab, (tab) => ({ ...tab, key, path: card.path, session: ticket.session, card: retain(card),
      anchor: card.kind === 'open' && card.atLine !== undefined ? card.atLine : tab.key === key ? tab.anchor : undefined,
      preferredLens: navigation?.restore ? navigation.restore.lens : tab.key === key ? tab.preferredLens : null,
      ...(navigation ? { back: Object.freeze(navigation.push ? [...(tab.back ?? []), navigation.push] : navigation.pop ? (tab.back ?? []).slice(0, -1) : tab.back ?? []) } : {}) }))
    return true
  }

  consumeBack(id: TabId, entry: SavedLocation): boolean {
    const tab = this.tab(id)
    if (tab?.back?.at(-1) !== entry) return false
    this.change(id, tab => ({ ...tab, back: Object.freeze(tab.back!.slice(0, -1)) }))
    return true
  }

  /** Abandon a failed handoff while retaining its source tab. */
  cancel(ticket: TabTicket): void {
    if (this.current(ticket)) this.versions.set(ticket.tab, ticket.version + 1)
  }

  select(id: TabId, renew = false): SelectionTicket | null {
    if (!this.tab(id)) return null
    if (this.state.selected !== id || renew) this.selectionVersion++
    if (this.state.selected !== id) {
      this.publish({ ...this.state, selected: id })
    }
    return this.selection()
  }

  selection(): SelectionTicket | null {
    return this.state.selected === null ? null : { tab: this.state.selected, version: this.selectionVersion, session: this.state.session }
  }

  selected(ticket: SelectionTicket): boolean {
    return this.state.ready && ticket.session === this.state.session && ticket.tab === this.state.selected && ticket.version === this.selectionVersion
  }

  remember(id: TabId, anchor: number, preferredLens: LensChoice): void {
    this.change(id, (tab) => tab.anchor === anchor && tab.preferredLens === preferredLens ? tab : { ...tab, anchor, preferredLens })
  }

  updateDocument(ref: DocumentRef, update: (card: StoredOpenCard) => StoredOpenCard): boolean {
    const tab = this.state.tabs.find((tab) => tab.session === ref.session && tab.card.kind === 'open' && tab.card.opened.doc === ref.doc && tab.card.opened.gen === ref.gen)
    if (!tab || !this.state.ready || ref.session !== this.state.session || tab.card.kind !== 'open') return false
    const card = update(tab.card)
    if (card.path !== tab.card.path || card.opened !== tab.card.opened) return false // identity changes use a ticket
    if (card === tab.card) return true
    this.change(tab.id, (tab) => ({ ...tab, card: Object.freeze({ ...card,
      ...(card.build ? { build: Object.freeze({ ...card.build }) } : {}) }) }))
    return true
  }

  progress(event: ProgressEvent): boolean {
    return this.updateDocument(event, (card) => ({ ...card, lines: event.lines, bytes: event.bytes,
      indexed: event.done, ...(event.error !== undefined ? { frozen: event.error } : {}) }))
  }

  /** Return the removed metadata so its owner can close that native document exactly once. */
  close(id: TabId): WorkspaceTab | undefined {
    const index = this.state.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return undefined
    const removed = this.state.tabs[index]
    const tabs = this.state.tabs.filter((tab) => tab.id !== id)
    this.versions.delete(id)
    let selected = this.state.selected
    if (selected === id) {
      selected = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
      this.selectionVersion++
    }
    this.publish({ ...this.state, tabs, selected })
    return removed
  }

  coreGone(session: number): void {
    if (session !== this.state.session || !this.state.ready) return
    for (const tab of this.state.tabs) this.versions.set(tab.id, (this.versions.get(tab.id) ?? 0) + 1)
    this.selectionVersion++
    this.publish({ ...this.state, ready: false, tabs: this.state.tabs.map((tab) => this.gone(tab, false)) })
  }

  coreReady(session: number): void {
    if (session <= this.state.session) return
    for (const tab of this.state.tabs) this.versions.set(tab.id, (this.versions.get(tab.id) ?? 0) + 1)
    this.selectionVersion++
    this.publish({ ...this.state, session, ready: true, tabs: this.state.tabs.map((tab) => this.gone(tab, true)) })
  }

  private gone(tab: WorkspaceTab, ready: boolean): WorkspaceTab {
    const card = tab.card
    const localOnly = card.kind === 'open' ? card.opened.localOnly : card.kind === 'gone' || card.kind === 'failed' ? card.localOnly : undefined
    const line = tab.anchor ?? (card.kind === 'open' || card.kind === 'opening' ? card.atLine : card.kind === 'gone' ? card.line : undefined)
    return Object.freeze({ ...tab, card: Object.freeze({ kind: 'gone', path: tab.path, line, ready, ...(localOnly ? { localOnly } : {}) }) })
  }

  private change(id: TabId, update: (tab: WorkspaceTab) => WorkspaceTab): void {
    const index = this.state.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const before = this.state.tabs[index]
    const next = update(before)
    if (next === before) return
    const tabs = [...this.state.tabs]
    tabs[index] = Object.freeze(next)
    this.publish({ ...this.state, tabs })
  }

  private publish(state: WorkspaceSnapshot): void {
    this.state = Object.freeze({ ...state, tabs: Object.freeze(state.tabs) })
    for (const listener of this.listeners) listener()
  }
}
