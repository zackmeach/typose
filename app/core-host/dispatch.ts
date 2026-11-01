// The core host's side of protocol v1. Every request is validated before anything acts on it (plan C4):
// numbers against the core's own range table, methods by own property only, and no addon call on a refusal.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Cancel, Doc, IndexProgress, Limits, SavedRoute, FolderRoot as NativeFolderRoot, Page as CorePage } from 'typose-node'
import {
  PROTOCOL,
  type Charges,
  type CapturedLocation,
  type CoreError,
  type DebugStats,
  type ErrorCode,
  type Hello,
  type ImageRef,
  type PreparedImage,
  type LinkTarget,
  type MdBuild,
  type MdPage,
  type Opened,
  type Page,
  type ProgressEvent,
  type Response,
  type SavedTicket,
  type FolderRef,
  type FolderRoot,
  type FolderPage,
  type SurfaceRef,
  type ViewRef
} from '../shared/protocol'
import { isValid } from './numbers'
import { boundedLink, decodedLocalTarget, localTarget } from './local-target'

declare const __TEST_HOOKS__: boolean

/** The slice of `typose-node` the core host calls; tests pass a spy. */
export interface Addon {
  coreVersion(): string
  limits(): Limits
  openDoc(path: string): Doc
  captureFolder?(path: string, id: string): NativeFolderRoot
  /** A new cancel flag, for one page read or one index job (plan C5, C6). */
  cancelFlag(): Cancel
  /** Plan C1: sets the renderer cache's reservation in the ledger; false if the ledger refused it. */
  reserveCache(bytes: number): boolean
  /** The test-hooks addon's live jobs, tasks and file handles, its slowest read delay, and its ledger (plan m8, C1). */
  debugStats?(): Pick<DebugStats, 'jobs' | 'tasks' | 'handles' | 'delayMs' | 'ledger'>
  /** The test-hooks addon's itemized charges of one document (plan C1, C6). */
  docCharges?(doc: Doc): Charges
  /** The test-hooks build's forced GC of the core host's heap (plan C1's measurements). */
  gc?(): void
  /** The test-hooks addon's reset of the ledger's high-water mark (plan C1's exhaustion test). */
  resetHigh?(): void
  /** The test-hooks addon's budget override (plan C1): the ledger's limit, in bytes. */
  setLimit?(bytes: number): void
  savedStats?(): { wrappers: number; wrapperBytes: number }
  savedRouteBytes?(route: SavedRoute): number
}

class Refusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message)
  }
}

/** The addon's own codes (`typose-node`'s `Code`), passed through; anything else thrown is `Internal`. */
const ADDON_CODES = new Set<string>(['InvalidParams', 'NotFound', 'NotDirectory', 'PermissionDenied', 'Refused', 'Binary', 'Frozen', 'Stale', 'Io', 'Cancelled', 'NoDocument', 'Memory'])

type Params = Record<string, unknown>
const isRecord = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v)
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code

export function makeDispatcher(addon: Addon, session: number, emit: (event: ProgressEvent) => void, ticketId: () => string = randomUUID): (data: unknown) => Promise<Response> {
  const limits = addon.limits()
  const ranges = new Map(limits.ranges.map((r) => [r.field, r]))
  /** `params[field]`, checked against the core's range for `field`; `name` is how the error names it. */
  const int = (params: Params, field: string, name = field): number => {
    const { min, max } = ranges.get(field)!
    const value = params[field]
    if (!isValid(value, min, max)) throw new Refusal('InvalidParams', `${name} must be an integer in [${min}, ${max}]`, name)
    return value
  }
  const docs = new Map<number, Doc>()
  const docOwners = new Map<number, number>()
  /** Each document's index job (plan C6). */
  const jobs = new Map<number, Cancel>()
  /** Page reads in flight, by request id (plan C5). `cancelledAt` is the test-hooks build's. */
  type ReadEntry = { doc?: number; cancel: Cancel; retainOnLeave: boolean; cancelled: boolean; cancelledAt?: number;
    candidate?: true; saved?: SavedRoute; folder?: NativeFolderRoot; surface?: number }
  const reads = new Map<number, ReadEntry>()
  const saved = new Map<string, SavedRoute>()
  let savedPeak = 0
  let savedHostBytes = 0
  const roots = new Map<string, { native: NativeFolderRoot; path: string }>()
  let nextRoot = 1
  let rootPeak = 0
  let rootHostBytes = 0 // Map capacity remains paid until this host exits, including after removeRoot.
  /** The test-hooks build's account of cancels (plan C5's acceptance). */
  const cancels = { cancels: 0, cancelled: 0, cancelMs: 0 }
  /** The test-hooks build keeps closed documents referenced, so only `Doc.close()`, never GC, can release them (C6). */
  const closed: Doc[] = []
  let nextDoc = 1
  const getDoc = (id: number): Doc => {
    const doc = docs.get(id)
    if (!doc) throw new Refusal('NoDocument', `no document ${id}`)
    return doc
  }
  const folderRef = (value: unknown, field: string): FolderRef => {
    if (!isRecord(value) || typeof value.root !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.root)
      || typeof value.node !== 'string' || !/^(0|[1-9][0-9]{0,3})$/.test(value.node) || Number(value.node) >= 4096)
      throw new Refusal('InvalidParams', `${field} must be an opaque folder reference`, field)
    const s = int(value, 'session', `${field}.session`)
    if (s !== session) throw new Refusal('Stale', 'the folder belongs to an earlier core session; add it again')
    return { session: s, root: value.root, node: value.node }
  }
  const rootFor = (ref: FolderRef) => {
    const root = roots.get(ref.root)
    if (!root) throw new Refusal('Stale', 'the folder was removed; add it again')
    return root
  }
  const bindManual = (doc: Doc): void => {
    if (doc.localOnly || doc.folder || roots.size === 0) return
    for (const root of [...roots.values()].sort((a, b) => b.path.length - a.path.length)) if (doc.bindFolder(root.native)) return
  }
  const savedTicket = (p: Params): SavedTicket => {
    if (!isRecord(p.ticket)) throw new Refusal('InvalidParams', 'ticket must be a saved-location ticket', 'ticket')
    const ticketSession = int(p.ticket, 'session', 'ticket.session')
    const id = p.ticket.id
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw new Refusal('InvalidParams', 'ticket.id must be an opaque UUID', 'ticket.id')
    return { session: ticketSession, id }
  }
  const imageRef = (p: Params, id: number, gen: number): ImageRef => {
    if (!isRecord(p.ref)) throw new Refusal('InvalidParams', 'ref must be an image reference', 'ref')
    const [refSession, refDoc, refGen, resource] = ['session', 'doc', 'gen', 'id'].map((field) => int(p.ref as Params, field, 'ref.' + field))
    if (refSession !== session) throw new Refusal('Stale', 'the image reference belongs to another session')
    if (refDoc !== id) throw new Refusal('InvalidParams', 'the image reference belongs to another document', 'ref.doc')
    if (refGen !== gen) throw new Refusal('Stale', 'the image reference belongs to another generation')
    return { session, doc: id, gen, id: resource }
  }

  type Lease = { ref: ViewRef; bytes: number }
  type SurfaceState = { ref: SurfaceRef; alive: boolean; views: Map<number, Lease>; current?: number; latest?: Pending }
  type Pending = { request: number; surface: SurfaceState; bytes: number; doc?: number; gen?: number; disposed: boolean; previousView?: number; kind?: 'activate' | 'reload' }
  // Surface zero is an isolated compatibility owner. Explicit documents never accept its doc/gen-only cleanup.
  const surfaces = new Map<number, SurfaceState>([[0, { ref: { session, id: 0 }, alive: true, views: new Map() }]])
  const pendingViews = new Map<number, Pending>()
  let nextSurface = 1
  let nextView = 1
  let surfacePeak = 0
  let viewPeak = 0
  let pendingPeak = 0
  let surfaceHostBytes = 0
  let workspaceBytes = 0
  const viewBytes = (): number => {
    let bytes = 0
    for (const surface of surfaces.values()) for (const lease of surface.views.values()) bytes += lease.bytes
    for (const pending of pendingViews.values()) bytes += pending.bytes
    return bytes
  }
  const account = (bytes = viewBytes(), hostBytes = surfaceHostBytes): boolean => {
    const total = bytes + workspaceBytes + savedHostBytes + rootHostBytes + hostBytes
    return Number.isSafeInteger(total) && addon.reserveCache(total)
  }
  const surfaceRef = (value: unknown): SurfaceState => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'surface must be a surface reference', 'surface')
    const ownerSession = int(value, 'session', 'surface.session')
    const id = int(value, 'id', 'surface.id')
    const surface = ownerSession === session ? surfaces.get(id) : undefined
    if (!surface?.alive) throw new Refusal('Stale', 'the card surface was closed or belongs to another session')
    return surface
  }
  const requestSurface = (p: Params): SurfaceState => p.surface === undefined ? surfaces.get(0)! : surfaceRef(p.surface)
  const ownedDoc = (surface: SurfaceState, id: number): Doc => {
    const doc = getDoc(id)
    if (docOwners.get(id) !== surface.ref.id) throw new Refusal('Stale', 'the document belongs to another card surface')
    return doc
  }
  const live = (surface: SurfaceState): boolean => surface.alive && surfaces.get(surface.ref.id) === surface
  const viewed = (id: number, generation?: number): boolean => {
    for (const surface of surfaces.values()) for (const lease of surface.views.values())
      if (lease.ref.doc === id && (generation === undefined || lease.ref.gen === generation)) return true
    return false
  }
  const currentLease = (surface: SurfaceState): Lease | undefined => surface.current === undefined ? undefined : surface.views.get(surface.current)
  const reserveTable = (surfaceCount: number, views: number, pending: number, bytes = viewBytes()): boolean => {
    const nextSurfaces = Math.max(surfacePeak, surfaceCount), nextViews = Math.max(viewPeak, views), nextPending = Math.max(pendingPeak, pending)
    const hostBytes = 3 * ((64 << 10) + 4096 * nextSurfaces + 1024 * (nextViews + nextPending))
    if ((hostBytes !== surfaceHostBytes || bytes !== viewBytes()) && !account(bytes, hostBytes)) return false
    surfacePeak = nextSurfaces; viewPeak = nextViews; pendingPeak = nextPending; surfaceHostBytes = hostBytes
    return true
  }
  const leaseCount = (): number => [...surfaces.values()].reduce((n, s) => n + s.views.size, 0)
  const take = (req: number, bytes: number, surface: SurfaceState): Pending => {
    if (reads.has(req) || pendingViews.has(req)) throw new Refusal('InvalidParams', 'request id is already pending', 'id')
    if (!reserveTable(surfaces.size, leaseCount(), pendingViews.size + 1, viewBytes() + bytes))
      throw new Refusal('Memory', `the memory budget cannot hold the pending view's ${bytes} bytes`)
    const pending: Pending = { request: req, surface, bytes, disposed: false, previousView: surface.current }
    pendingViews.set(req, pending)
    const previous = surface.latest
    if (previous?.kind === 'activate') {
      previous.disposed = true
      const entry = reads.get(previous.request)
      if (entry) { entry.cancelled = true; entry.cancel.cancel() }
    }
    surface.latest = pending
    return pending
  }
  const giveBack = (pending: Pending, transferred = false): void => {
    if (pendingViews.get(pending.request) !== pending) return
    pendingViews.delete(pending.request)
    if (pending.surface.latest === pending) pending.surface.latest = undefined
    if (!transferred) account()
  }
  /** Leaving a view retains Reload's first page for its new metadata/index. */
  const cancelReads = (doc: number, leaving = false) => {
    for (const read of reads.values()) if (read.doc === doc && (!leaving || !read.retainOnLeave)) {
      read.cancelled = true
      read.cancel.cancel()
    }
  }
  const reclaimInactive = (): void => {
    for (const [id, doc] of docs) if (!viewed(id, doc.generation) && ![...pendingViews.values()].some((pending) => pending.doc === id)) {
      doc.setCacheActive(doc.generation, false)
      cancelReads(id, true)
    }
  }
  const handoff = (pending: Pending, id: number, doc: Doc, gen: number): Pick<Opened, 'reserved' | 'view'> => {
    const surface = pending.surface
    if (!live(surface) || pending.disposed || surface.latest !== pending) {
      giveBack(pending)
      if (!viewed(id, gen)) doc.setCacheActive(gen, false)
      return { reserved: 0 }
    }
    if (!isValid(nextView, 1, ranges.get('id')!.max)) throw new Refusal('Refused', 'view identities are exhausted')
    if (!reserveTable(surfaces.size, leaseCount() + 1, pendingViews.size)) throw new Refusal('Memory', 'the view lease table cannot grow')
    doc.setCacheActive(gen, true)
    const ref: ViewRef = { session, surface: surface.ref.id, id: nextView++, doc: id, gen }
    surface.views.set(ref.id, { ref, bytes: pending.bytes })
    surface.current = ref.id
    giveBack(pending, true) // the previous view remains paid until its exact lease is detached
    return { reserved: pending.bytes, view: ref }
  }
  const requestedLease = (p: Params, deactivate = false): { surface: SurfaceState; lease: Lease } | undefined => {
    if (p.view !== undefined) {
      if (!isRecord(p.view)) throw new Refusal('InvalidParams', 'view must be an activation lease', 'view')
      const ownerSession = int(p.view, 'session', 'view.session')
      const surfaceId = int({ start: p.view.surface }, 'start', 'view.surface')
      const id = int(p.view, 'id', 'view.id'), doc = int(p.view, 'doc', 'view.doc'), gen = int(p.view, 'gen', 'view.gen')
      const surface = ownerSession === session ? surfaces.get(surfaceId) : undefined
      const lease = surface?.alive ? surface.views.get(id) : undefined
      return surface && lease && lease.ref.doc === doc && lease.ref.gen === gen ? { surface, lease } : undefined
    }
    const id = int(p, 'doc'), gen = int(p, 'gen')
    const doc = deactivate ? getDoc(id) : undefined
    if (docOwners.get(id) !== 0) return undefined
    const surface = surfaces.get(0)!
    const lease = deactivate ? [...surface.views.values()].find((l) => l.ref.doc === id && l.ref.gen === gen) : currentLease(surface)
    if (!lease || lease.ref.doc !== id || lease.ref.gen !== gen) {
      if (doc && doc.generation !== gen) throw new Refusal('Stale', 'the tab generation was replaced')
      return undefined
    }
    return { surface, lease }
  }
  const detach = (surface: SurfaceState, lease: Lease): void => {
    surface.views.delete(lease.ref.id)
    if (surface.current === lease.ref.id) surface.current = undefined
    for (const pending of pendingViews.values()) if (pending.surface === surface && pending.doc === lease.ref.doc
      && (pending.gen === lease.ref.gen || pending.previousView === lease.ref.id)) pending.disposed = true
    const doc = docs.get(lease.ref.doc)
    if (doc && !viewed(lease.ref.doc, doc.generation)) { doc.setCacheActive(doc.generation, false); cancelReads(lease.ref.doc, true) }
    account()
  }
  const closeDoc = (id: number): boolean => {
    const doc = docs.get(id)
    if (!doc) return false
    jobs.get(id)?.cancel()
    cancelReads(id)
    for (const pending of pendingViews.values()) if (pending.doc === id) pending.disposed = true
    for (const surface of surfaces.values()) for (const lease of surface.views.values()) if (lease.ref.doc === id) {
      surface.views.delete(lease.ref.id)
      if (surface.current === lease.ref.id) surface.current = undefined
    }
    doc.close()
    if (__TEST_HOOKS__) closed.push(doc)
    jobs.delete(id); docOwners.delete(id); docs.delete(id)
    account()
    return true
  }

  // Continuation tokens leave with this session and their document in them, and are refused for any other
  // (plan C3; C7: every token carries `{session, doc, gen}`).
  const stampPage = (doc: number, page: CorePage): Page => {
    for (const item of page.items) if (item.next) Object.assign(item.next, { session, doc })
    return page as Page
  }
  /** Request `id`'s read of document `doc`, a page or a Markdown build, which `cancel` can stop while it runs (plan C5). */
  const read = async <T>(id: number, doc: number, start: (cancel: Cancel) => Promise<T>, retainOnLeave = false): Promise<T> => {
    if (reads.has(id)) throw new Refusal('InvalidParams', 'request id is already pending', 'id')
    const source = getDoc(doc)
    const gen = source.generation
    const entry: ReadEntry = { doc, cancel: addon.cancelFlag(), retainOnLeave, cancelled: false, surface: docOwners.get(doc) }
    reads.set(id, entry)
    try {
      return await start(entry.cancel)
    } catch (e) {
      if (codeOf(e) === 'Frozen' && docs.get(doc) === source && source.generation === gen) cancelReads(doc)
      if (__TEST_HOOKS__ && codeOf(e) === 'Cancelled' && entry.cancelledAt !== undefined) {
        cancels.cancelled++
        cancels.cancelMs = Math.max(cancels.cancelMs, performance.now() - entry.cancelledAt)
      }
      throw e
    } finally {
      if (reads.get(id) === entry) reads.delete(id)
    }
  }
  type LocalInfo = { localOnly: true; path: string } | undefined
  const localInfo = (doc: Doc): LocalInfo => doc.localOnly ? { localOnly: true, path: doc.path } : undefined
  const describe = (id: number, doc: Doc, firstPage: CorePage, local?: LocalInfo): Omit<Opened, 'reserved'> => {
    const { generation: gen, size, encoding, lines, indexed, blank } = doc
    const format = doc.format as Opened['format'] // the core's two values
    const folder = doc.folder ?? undefined
    return { doc: id, gen, format, size, encoding, lines, indexed, blank, firstPage: stampPage(id, firstPage), ...local, ...(folder ? { folder } : {}) }
  }
  /** Read fallible metadata before starting a job; a failed start leaves no job registered. */
  const begin = (id: number, doc: Doc, firstPage: CorePage, local?: LocalInfo): Omit<Opened, 'reserved'> => {
    const opened = describe(id, doc, firstPage, local)
    const gen = opened.gen
    const cancel = addon.cancelFlag()
    jobs.get(id)?.cancel() // the previous generation's job, if it still runs (plan C6)
    jobs.set(id, cancel)
    try {
      doc.startIndex(cancel, (e: IndexProgress) => {
        // An index error froze the document (plan C6). An older generation's ends with Reload's freeze, not this one's.
        if (e.error !== undefined && jobs.get(id) === cancel && docs.get(id) === doc && doc.generation === gen) cancelReads(id)
        const event: ProgressEvent = { event: 'progress', session, doc: id, gen, lines: e.lines, bytes: e.bytes, done: e.done }
        if (e.error !== undefined) event.error = e.error
        emit(event)
      })
    } catch (e) {
      cancel.cancel()
      if (jobs.get(id) === cancel) jobs.delete(id)
      throw e
    }
    return opened
  }

  /** Registration spans first-page wait through synchronous publication, not just the native read. */
  const candidate = async (req: number, pending: Pending, doc: Doc, count: number, local: LocalInfo,
    valid: () => boolean = () => true, source?: number, route?: SavedRoute, folder?: NativeFolderRoot): Promise<Opened> => {
    let entry: ReadEntry | undefined
    let published = false
    let registered: number | undefined
    let indexed: number | undefined
    try {
      entry = { doc: source, cancel: addon.cancelFlag(), retainOnLeave: true, cancelled: false, candidate: true, saved: route, folder, surface: pending.surface.ref.id }
      reads.set(req, entry)
      const firstPage = await doc.page(doc.generation, 0, count, entry.cancel)
      if (!live(pending.surface) || !valid()) throw new Refusal('Stale', 'the surface, navigation source or saved location was replaced')
      if (entry.cancelled) throw new Refusal('Cancelled', 'the navigation was cancelled')
      const id = nextDoc++ // a partially started index must never alias a later document's id/generation
      indexed = id
      const opened = begin(id, doc, firstPage, local)
      docs.set(id, doc)
      docOwners.set(id, pending.surface.ref.id)
      registered = id
      const reservation = handoff(pending, id, doc, opened.gen)
      published = true
      return { ...opened, ...reservation }
    } catch (e) {
      if (!published) {
        // begin can start an index before a later registration/handoff failure.
        if (indexed !== undefined) { jobs.get(indexed)?.cancel(); jobs.delete(indexed) }
        if (registered !== undefined) { docs.delete(registered); docOwners.delete(registered) }
        doc.close()
      }
      giveBack(pending)
      if (__TEST_HOOKS__ && codeOf(e) === 'Cancelled' && entry?.cancelledAt !== undefined) {
        cancels.cancelled++
        cancels.cancelMs = Math.max(cancels.cancelMs, performance.now() - entry.cancelledAt)
      }
      if (local && codeOf(e) === 'Frozen') throw new Refusal('Refused', 'navigation target changed while opening')
      throw e
    } finally {
      if (reads.get(req) === entry) reads.delete(req)
    }
  }

  // Each handler checks all of its parameters before it calls the addon or changes state. `id` is the request's.
  const handlers: Record<string, (params: Params, id: number) => unknown> = {
    createSurface: (): SurfaceRef => {
      if (!isValid(nextSurface, 1, ranges.get('id')!.max)) throw new Refusal('Refused', 'surface identities are exhausted')
      if (!reserveTable(surfaces.size + 1, leaseCount(), pendingViews.size)) throw new Refusal('Memory', 'the surface table cannot grow')
      const ref = { session, id: nextSurface++ }
      surfaces.set(ref.id, { ref, alive: true, views: new Map() })
      return ref
    },
    releaseSurface: (p): boolean => {
      const retired = int({ bytes: p.retiredBytes }, 'bytes', 'retiredBytes')
      if (!isRecord(p.surface)) throw new Refusal('InvalidParams', 'surface must be a surface reference', 'surface')
      const ownerSession = int(p.surface, 'session', 'surface.session'), id = int(p.surface, 'id', 'surface.id')
      const surface = ownerSession === session ? surfaces.get(id) : undefined
      if (!surface?.alive) return false
      const liveBytes = [...surface.views.values()].reduce((bytes, lease) => bytes + lease.bytes, 0)
      if (retired < liveBytes) throw new Refusal('Memory', 'the closing card retirement declaration does not cover its remaining views')
      if (workspaceBytes < retired) throw new Refusal('Memory', 'precharge the window retirement allowance before closing this card')
      surface.alive = false
      for (const pending of pendingViews.values()) if (pending.surface === surface) pending.disposed = true
      for (const entry of reads.values()) if (entry.surface === id) { entry.cancelled = true; entry.cancel.cancel() }
      for (const [doc, owner] of docOwners) if (owner === id) closeDoc(doc)
      surface.views.clear()
      surfaces.delete(id)
      account()
      return true
    },
    transferDoc: (p): boolean => {
      const from = surfaceRef(p.from), to = surfaceRef(p.to)
      const id = int(p, 'doc'), gen = int(p, 'gen')
      const doc = ownedDoc(from, id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the document generation was replaced before moving')
      if (from === to) return true
      if (viewed(id) || [...pendingViews.values()].some((pending) => pending.doc === id)
        || [...reads.values()].some((entry) => entry.doc === id && !entry.cancelled))
        throw new Refusal('Refused', 'detach this document and finish its pending work before moving it')
      docOwners.set(id, to.ref.id)
      return true
    },
    addRoot: (p): FolderRoot => {
      if (typeof p.path !== 'string' || p.path.length === 0 || p.path.length > 32_767 || p.path.includes('\0'))
        throw new Refusal('InvalidParams', 'choose a folder path of at most 32,767 characters', 'path')
      if (!addon.captureFolder) throw new Refusal('Unsupported', 'folder browsing is unavailable in this core')
      if (roots.size >= 16) throw new Refusal('Refused', 'demo limit: remove a root before adding more than 16 folders')
      const peak = Math.max(rootPeak, roots.size + 1)
      // Path + label may be full UTF-16, alongside the Map entry and wrapper metadata/copies.
      const bytes = 3 * ((64 << 10) + (2 * 32_767 + 2 * 255 + (16 << 10)) * peak)
      if (!addon.reserveCache(viewBytes() + workspaceBytes + savedHostBytes + bytes + surfaceHostBytes)) throw new Refusal('Memory', 'the folder table cannot grow')
      const previous = rootHostBytes
      rootHostBytes = bytes
      let native: NativeFolderRoot | undefined
      try {
        const id = String(nextRoot++)
        native = addon.captureFolder(p.path, id)
        const label = native.label
        const path = native.path
        rootPeak = peak
        roots.set(id, { native, path })
        return { ref: { session, root: id, node: '0' }, label, path }
      } catch (e) {
        native?.close()
        rootHostBytes = previous
        account()
        throw e
      }
    },
    listFolder: async (p, req): Promise<FolderPage> => {
      const ref = folderRef(p.folder, 'folder')
      if (p.hidden !== undefined && typeof p.hidden !== 'boolean') throw new Refusal('InvalidParams', 'hidden must be boolean', 'hidden')
      if (p.cursor !== undefined && (typeof p.cursor !== 'string' || !/^[1-9][0-9]{0,9}$/.test(p.cursor) || Number(p.cursor) > 0xffff_ffff))
        throw new Refusal('InvalidParams', 'cursor must be an opaque folder continuation', 'cursor')
      const root = rootFor(ref)
      const entry: ReadEntry = { cancel: addon.cancelFlag(), retainOnLeave: true, cancelled: false, folder: root.native }
      reads.set(req, entry)
      try {
        const page = await root.native.list(Number(ref.node), p.cursor === undefined ? undefined : Number(p.cursor), p.hidden === true, entry.cancel)
        if (entry.cancelled) throw new Refusal('Cancelled', 'the folder listing was cancelled')
        if (roots.get(ref.root) !== root) throw new Refusal('Stale', 'the folder was removed while listing')
        return { entries: page.entries.map((e) => ({ ref: { session, root: ref.root, node: String(e.id) }, name: e.name,
          kind: e.kind as 'directory' | 'file' | 'unsupported', hidden: e.hidden })), ...(page.cursor === undefined || page.cursor === null ? {} : { cursor: String(page.cursor) }) }
      } finally { if (reads.get(req) === entry) reads.delete(req) }
    },
    openChild: (p, req): Promise<Opened> => {
      const ref = folderRef(p.entry, 'entry')
      const [count, bytes] = [int(p, 'count'), int(p, 'bytes')]
      const root = rootFor(ref)
      const surface = requestSurface(p)
      reclaimInactive()
      const pending = take(req, bytes, surface)
      let doc: Doc | undefined
      try {
        doc = root.native.open(Number(ref.node))
        const local = localInfo(doc)
        if (!local) throw new Refusal('Internal', 'a folder child returned manual authority')
        return candidate(req, pending, doc, count, local, () => roots.get(ref.root) === root, undefined, undefined, root.native)
      } catch (e) { doc?.close(); giveBack(pending); throw e }
    },
    removeRoot: (p): boolean => {
      const ownerSession = int(p, 'session')
      if (typeof p.root !== 'string' || !/^[1-9][0-9]{0,15}$/.test(p.root)) throw new Refusal('InvalidParams', 'root must be an opaque root identity', 'root')
      if (ownerSession !== session) return false
      const root = roots.get(p.root)
      if (!root) return false
      for (const entry of reads.values()) if (entry.folder === root.native) { entry.cancelled = true; entry.cancel.cancel() }
      roots.delete(p.root)
      root.native.close()
      return true
    },
    hello: (p): Hello => {
      if (int(p, 'protocol') !== PROTOCOL) throw new Refusal('Unsupported', `protocol ${String(p.protocol)}; this core speaks ${PROTOCOL}`)
      return { protocol: PROTOCOL, core: addon.coreVersion(), session, limits }
    },
    open: async (p, req): Promise<Opened> => {
      const [count, bytes] = [int(p, 'count'), int(p, 'bytes')]
      if (typeof p.path !== 'string' || p.path.length === 0 || p.path.length > 32_767 || p.path.includes('\0'))
        throw new Refusal('InvalidParams', 'path must be a non-empty string of at most 32,767 characters, without NUL', 'path')
      const surface = requestSurface(p)
      reclaimInactive()
      const pending = take(req, bytes, surface)
      let doc: Doc | undefined
      try {
        doc = addon.openDoc(p.path)
        bindManual(doc)
        return candidate(req, pending, doc, count, undefined)
      } catch (e) {
        doc?.close()
        giveBack(pending)
        throw e
      }
    },
    activate: async (p, req): Promise<Opened> => {
      const [id, gen, count, bytes] = [int(p, 'doc'), int(p, 'gen'), int(p, 'count'), int(p, 'bytes')]
      const surface = requestSurface(p)
      const doc = ownedDoc(surface, id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the tab generation was replaced')
      reclaimInactive()
      const pending = take(req, bytes, surface)
      pending.doc = id; pending.gen = gen; pending.kind = 'activate'
      try {
        const local = localInfo(doc)
        const firstPage = await read(req, id, (cancel) => doc.page(gen, 0, count, cancel))
        if (!live(surface) || docs.get(id) !== doc || doc.generation !== gen || surface.latest !== pending || pending.disposed)
          throw new Refusal('Stale', 'the tab activation was replaced while it opened')
        const opened = describe(id, doc, firstPage, local)
        return { ...opened, ...handoff(pending, id, doc, gen) }
      } catch (e) {
        giveBack(pending)
        throw e // the retained document is still owned by its tab, including a failed or stale activation
      }
    },
    deactivate: (p): boolean => {
      const owned = requestedLease(p, true)
      if (!owned) {
        if (p.view !== undefined || docOwners.get(p.doc as number) !== 0) return false
        const id = int(p, 'doc'), gen = int(p, 'gen')
        for (const pending of pendingViews.values()) if (pending.surface.ref.id === 0 && pending.doc === id && pending.gen === gen) pending.disposed = true
        if (!viewed(id)) { getDoc(id).setCacheActive(gen, false); cancelReads(id, true) }
        return true
      }
      detach(owned.surface, owned.lease)
      return true
    },
    openLocal: async (p, req): Promise<Opened> => {
      const [id, gen, count, bytes] = [int(p, 'doc'), int(p, 'gen'), int(p, 'count'), int(p, 'bytes')]
      if (typeof p.target !== 'string' || !decodedLocalTarget(p.target, true))
        throw new Refusal('InvalidParams', 'target must be a safe decoded local path of at most 32 KiB', 'target')
      const surface = requestSurface(p)
      const source = getDoc(id)
      if (source.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced`)
      if (/^[\\/]/.test(p.target) && !source.folder)
        throw new Refusal('InvalidParams', 'root-relative links require a source in a selected folder', 'target')
      reclaimInactive()
      const pending = take(req, bytes, surface)
      let doc: Doc | undefined
      try {
        doc = source.openLocal(gen, p.target)
        const local = localInfo(doc)
        return candidate(req, pending, doc, count, local, () => docs.get(id) === source && source.generation === gen, id)
      } catch (e) {
        doc?.close()
        giveBack(pending) // the source lens remains mounted when navigation fails
        if (codeOf(e) === 'Frozen') {
          if (doc) throw new Refusal('Refused', 'local target changed while opening')
          cancelReads(id) // only the source can be Frozen before its openLocal call returns
        }
        throw e
      }
    },
    captureLocation: (p): CapturedLocation => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      const doc = getDoc(id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the saved generation was replaced')
      if (!doc.localOnly) return { kind: 'manual', path: doc.path }
      const peak = Math.max(savedPeak, saved.size + 1)
      const bytes = 3 * ((64 << 10) + (16 << 10) * peak)
      const total = viewBytes() + workspaceBytes + bytes + rootHostBytes + surfaceHostBytes
      if (!Number.isSafeInteger(total) || !addon.reserveCache(total)) throw new Refusal('Memory', 'the saved-location table cannot grow')
      const previous = savedHostBytes
      savedHostBytes = bytes
      let route: SavedRoute | undefined
      let attempted = false
      try {
        route = doc.saveRoute(gen)
        const id = ticketId()
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || saved.has(id))
          throw new Refusal('Refused', 'a unique saved-location identity could not be allocated')
        attempted = true
        savedPeak = peak
        saved.set(id, route)
        return { kind: 'derived', ticket: { session, id } }
      } catch (e) {
        route?.release()
        if (!attempted) { savedHostBytes = previous; account() }
        throw e
      }
    },
    openSaved: (p, req): Promise<Opened> => {
      const ticket = savedTicket(p)
      const [count, bytes] = [int(p, 'count'), int(p, 'bytes')]
      const route = ticket.session === session ? saved.get(ticket.id) : undefined
      if (!route) throw new Refusal('Stale', 'the saved location is unavailable; select the file manually again')
      const surface = requestSurface(p)
      reclaimInactive()
      const pending = take(req, bytes, surface)
      let doc: Doc | undefined
      try {
        doc = route.open()
        const local = localInfo(doc)
        if (!local) throw new Refusal('Internal', 'a saved route returned manual authority')
        return candidate(req, pending, doc, count, local, () => saved.get(ticket.id) === route, undefined, route)
      } catch (e) {
        doc?.close()
        giveBack(pending)
        if (codeOf(e) === 'Frozen') throw new Refusal('Refused', 'navigation target changed while opening')
        throw e
      }
    },
    releaseSaved: (p): boolean => {
      const ticket = savedTicket(p)
      const route = ticket.session === session ? saved.get(ticket.id) : undefined
      if (!route) return false
      for (const entry of reads.values()) if (entry.candidate && entry.saved === route) {
        entry.cancelled = true
        entry.cancel.cancel()
      }
      saved.delete(ticket.id)
      route.release()
      return true
    },
    page: (p, req): Promise<Page | MdPage> => {
      const id = int(p, 'doc')
      if (p.lens !== 'raw' && p.lens !== 'rendered') throw new Refusal('InvalidParams', "lens must be 'raw' or 'rendered'", 'lens')
      if (Object.hasOwn(p, 'continuation')) {
        if (p.lens !== 'raw') throw new Refusal('InvalidParams', 'only a raw page takes a continuation', 'continuation')
        const t = p.continuation
        if (!isRecord(t)) throw new Refusal('InvalidParams', 'continuation must be a token', 'continuation')
        const [tokenSession, tokenDoc, gen, line, offset] = ['session', 'doc', 'gen', 'line', 'offset'].map((f) => int(t, f, `continuation.${f}`))
        const doc = getDoc(id)
        if (tokenSession !== session) throw new Refusal('Stale', `a token of session ${tokenSession}; this is session ${session}`)
        if (tokenDoc !== id) throw new Refusal('InvalidParams', `a token of document ${tokenDoc}, not ${id}`, 'continuation.doc')
        return read(req, id, async (cancel) => stampPage(id, await doc.piece(gen, line, offset, cancel)))
      }
      const [gen, start, count] = [int(p, 'gen'), int(p, 'start'), int(p, 'count')]
      const doc = getDoc(id)
      // A rendered page's `start` and `count` are blocks of the build `render` made (plan: Rendered Markdown slice §2.1).
      if (p.lens === 'rendered') return read(req, id, (cancel) => doc.mdPage(gen, start, count, cancel))
      return read(req, id, async (cancel) => stampPage(id, await doc.page(gen, start, count, cancel)))
    },
    prepareImage: (p, req): Promise<PreparedImage> => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      if (!boundedLink(p.src))
        throw new Refusal('InvalidParams', 'src must be a string of at most 32 KiB without controls', 'src')
      const target = localTarget(p.src)
      if (target === null) throw new Refusal('Refused', 'only supported local image paths can be opened')
      const doc = getDoc(id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the image source generation was replaced')
      return read(req, id, async (cancel) => {
        const image = await doc.prepareImage(gen, target, cancel)
        if (docs.get(id) !== doc || doc.generation !== gen) {
          doc.releaseImage(gen, image.id)
          throw new Refusal('Stale', 'the image source generation was replaced while decoding')
        }
        return {
          ref: { session, doc: id, gen, id: image.id }, width: image.width, height: image.height,
          encodedBytes: image.encodedBytes, pixelBytes: image.pixelBytes,
        }
      })
    },
    imageChunk: (p, req): Promise<Uint8Array> => {
      const [id, gen, offset] = [int(p, 'doc'), int(p, 'gen'), int(p, 'offset')]
      const ref = imageRef(p, id, gen)
      if (offset > 8 << 20 || offset % (256 << 10) !== 0)
        throw new Refusal('InvalidParams', 'offset must be aligned to 256 KiB within 8 MiB', 'offset')
      if (Object.hasOwn(p, 'count')) throw new Refusal('InvalidParams', 'image chunks do not take count', 'count')
      const doc = getDoc(id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the image source generation was replaced')
      return read(req, id, async (cancel) => {
        const bytes = await doc.imageChunk(gen, ref.id, offset, cancel)
        if (docs.get(id) !== doc || doc.generation !== gen)
          throw new Refusal('Stale', 'the image source generation was replaced while reading')
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 << 10)
          throw new Refusal('Internal', 'the core returned an invalid image chunk')
        return bytes
      })
    },
    releaseImage: (p): boolean => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      const ref = imageRef(p, id, gen)
      const doc = docs.get(id)
      return doc !== undefined && doc.generation === gen && doc.releaseImage(gen, ref.id)
    },

    // Plan (Rendered Markdown slice) §2.1: the document's Markdown build of generation `gen`, cancelled as a read is.
    render: (p, req): Promise<MdBuild> => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      const doc = getDoc(id)
      return read(req, id, (cancel) => doc.render(gen, cancel))
    },
    resolve: (p): LinkTarget => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      if (!boundedLink(p.href))
        throw new Refusal('InvalidParams', 'href must be a string of at most 32 KiB, without control characters', 'href')
      const doc = getDoc(id)
      if (doc.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced`)
      if (doc.format !== 'markdown') return { kind: 'inert' }
      if (p.href.startsWith('#')) {
        let fragment: string
        try {
          fragment = decodeURIComponent(p.href.slice(1))
          encodeURIComponent(fragment) // rejects an unpaired UTF-16 surrogate, including an unescaped one
        } catch { return { kind: 'inert' } }
        // oxlint-disable-next-line no-control-regex -- Percent-decoded control characters are refused too.
        if (/[\u0000-\u001f\u007f-\u009f]/.test(fragment)) return { kind: 'inert' }
        const line = doc.headingLine(gen, fragment)
        return line == null ? { kind: 'inert' } : { kind: 'heading', line }
      }
      const target = localTarget(p.href, !!doc.folder)
      if (target !== null) {
        try { return { kind: 'local', target, path: doc.localPath(gen, target) } }
        catch (e) {
          if (codeOf(e) === 'Frozen') cancelReads(id)
          throw e
        }
      }
      try {
        const url = new URL(p.href)
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.href.length > 32 << 10 || Buffer.byteLength(url.href, 'utf8') > 32 << 10) return { kind: 'inert' }
        return { kind: 'external', url: url.href }
      } catch { return { kind: 'inert' } }
    },
    // Reload owns only this surface's pending share. Other live views remain paid and active throughout it.
    reload: async (p, req): Promise<Opened> => {
      const [id, count, bytes] = [int(p, 'doc'), int(p, 'count'), int(p, 'bytes')]
      const surface = requestSurface(p)
      const doc = ownedDoc(surface, id)
      const previous = doc.generation
      reclaimInactive()
      const pending = take(req, bytes, surface)
      pending.doc = id; pending.gen = previous; pending.kind = 'reload'
      try {
        const local = localInfo(doc) // a Memory refusal must precede Reload's generation change
        // A display path selects a candidate only; native binding proves membership before Reload commits.
        const path = !doc.localOnly && !doc.folder && roots.size ? resolve(doc.path).toLocaleLowerCase('en-US') : undefined
        const root = path && [...roots.values()].sort((a, b) => b.path.length - a.path.length)
          .find((r) => path.startsWith(r.path.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US') + '\\'))
        if (root) doc.reloadInFolder(root.native)
        else doc.reload()
        const gen = doc.generation
        pending.gen = gen
        const firstPage = await read(req, id, (cancel) => doc.page(gen, 0, count, cancel), true)
        if (!live(surface) || docs.get(id) !== doc || doc.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced while it opened`)
        const opened = begin(id, doc, firstPage, local)
        if (pending.disposed) {
          if (!viewed(id, gen)) doc.setCacheActive(gen, false)
          giveBack(pending)
          return { ...opened, reserved: 0 }
        }
        return { ...opened, ...handoff(pending, id, doc, gen) }
      } catch (e) {
        giveBack(pending)
        throw e
      }
    },
    // Plan C6: the index job and the page reads stop, and the document's handle closes once they have.
    close: (p) => {
      const id = int(p, 'doc')
      const doc = docs.get(id)
      if (!doc) return false
      ownedDoc(requestSurface(p), id)
      return closeDoc(id)
    },
    cancel: (p) => {
      const running = reads.get(int(p, 'id'))
      if (!running) return false
      running.cancelled = true
      running.cancel.cancel()
      if (__TEST_HOOKS__) {
        cancels.cancels++
        running.cancelledAt ??= performance.now()
      }
      return true
    },
    // Plan C1: the renderer's page cache, reserved in the ledger before the cache may grow into it.
    reserve: (p) => {
      const bytes = int(p, 'bytes')
      const owned = requestedLease(p)
      if (!owned || !account(viewBytes() - owned.lease.bytes + bytes)) return false
      owned.lease.bytes = bytes
      return true
    },
    reserveWorkspace: (p) => {
      const bytes = int(p, 'bytes')
      const total = viewBytes() + bytes + savedHostBytes + rootHostBytes + surfaceHostBytes
      if (!Number.isSafeInteger(total) || !addon.reserveCache(total)) return false
      workspaceBytes = bytes
      return true
    },
    ...(__TEST_HOOKS__
      ? {
          debugStats: (p): DebugStats => {
            if (p.gc === true) addon.gc!()
            if (p.resetHigh === true) addon.resetHigh!()
            if (p.limit !== undefined) addon.setLimit!(int({ bytes: p.limit }, 'bytes', 'limit'))
            const charges: Record<number, Charges> = {}
            for (const [id, doc] of docs) charges[id] = addon.docCharges!(doc)
            const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
            return { ...addon.debugStats!(), docs: docs.size, ...cancels, charges, heap: { rss, heapUsed, external, arrayBuffers },
              surfaces: { count: surfaces.size - 1, views: leaseCount(), pending: pendingViews.size, bytes: viewBytes(), hostBytes: surfaceHostBytes, workspaceBytes },
              saved: { tickets: saved.size, routeBytes: [...saved.values()].reduce((sum, route) => sum + (addon.savedRouteBytes?.(route) ?? 0), 0),
                ...(addon.savedStats?.() ?? { wrappers: 0, wrapperBytes: 0 }), hostBytes: savedHostBytes, peakEntries: savedPeak,
                candidates: [...reads.values()].filter((entry) => entry.candidate).length } }
          }
        }
      : {})
  }

  return async (data) => {
    const fail = (id: number | null, error: CoreError): Response => ({ id, session, error })
    if (!isRecord(data)) return fail(null, { code: 'InvalidParams', message: 'a request is an object', field: 'request' })
    const idRange = ranges.get('id')!
    if (!isValid(data.id, idRange.min, idRange.max))
      return fail(null, { code: 'InvalidParams', message: `id must be an integer in [${idRange.min}, ${idRange.max}]`, field: 'id' })
    const id = data.id
    const method = data.method
    // Own properties only: `handlers[method]` would also find `toString` and `constructor` on Object.prototype.
    if (typeof method !== 'string' || !Object.hasOwn(handlers, method))
      return fail(id, { code: 'UnknownMethod', message: `unknown method ${String(method).slice(0, 64)}` })
    if (!isRecord(data.params)) return fail(id, { code: 'InvalidParams', message: 'params must be an object', field: 'params' })
    if (reads.has(id) || pendingViews.has(id))
      return fail(id, { code: 'InvalidParams', message: 'request id is already pending', field: 'id' })
    try {
      return { id, session, result: await handlers[method](data.params, id) }
    } catch (e) {
      if (e instanceof Refusal) return fail(id, { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) })
      const code = codeOf(e)
      const message = e instanceof Error ? e.message : String(e)
      return fail(id, { code: typeof code === 'string' && ADDON_CODES.has(code) ? (code as ErrorCode) : 'Internal', message })
    }
  }
}
