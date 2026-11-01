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
  type FolderPage
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
  let activeDoc: number | null = null
  /** Each document's index job (plan C6). */
  const jobs = new Map<number, Cancel>()
  /** Page reads in flight, by request id (plan C5). `cancelledAt` is the test-hooks build's. */
  type ReadEntry = { doc?: number; cancel: Cancel; retainOnLeave: boolean; cancelled: boolean; cancelledAt?: number;
    candidate?: true; saved?: SavedRoute; folder?: NativeFolderRoot }
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

  /**
   * Plan C1: the renderer cache's reservation. One renderer talks to a core host and shows one lens at a time, so it's
   * held for one lens: `doc:gen`. An open or Reload takes it at its first step for the lens it opens (`#id` while it's
   * under way), with at least that lens's viewport-only cap, `bytes`: part of the open's floor. The renderer unmounts the
   * lens it replaces one commit before an open's reply, and in the commit that mounts a Reload's new lens, so it holds
   * the larger of the two, not their sum, and what the replaced lens asks for is refused.
   */
  let holder: string | null = null
  let held = 0
  let workspaceBytes = 0
  /** Known retained targets can be disposed while their first page is still running. */
  const pendingViews = new Map<string, { doc: number; gen: number; disposed: boolean }>()
  /** The lens the reservation was last handed to, and its bytes since; null once released. A failed Reload gives it
   *  back. It's never a request: requests only take the reservation, and the takes only grow it. */
  let settled: { lens: string; bytes: number } | null = null
  const hold = (bytes: number): boolean => {
    const total = bytes + workspaceBytes + savedHostBytes + rootHostBytes
    if (!Number.isSafeInteger(total) || !addon.reserveCache(total)) return false
    held = bytes
    return true
  }
  /** Request `req` takes the reservation for the lens it opens; refused, it's `Memory` and nothing has changed. */
  const take = (req: number, bytes: number): string => {
    if (reads.has(req) || pendingViews.has(`#${req}`)) throw new Refusal('InvalidParams', 'request id is already pending', 'id')
    if (!hold(Math.max(held, bytes))) throw new Refusal('Memory', `the memory budget can't hold the view's ${bytes} bytes`)
    return (holder = `#${req}`)
  }
  /** The open or Reload holding the reservation as `key` hands it on: to its lens, `doc:gen`, or, failed, to nobody. */
  const settle = (key: string, lens: string | null): void => {
    if (holder !== key) return // a newer one has taken it
    holder = lens
    settled = lens === null ? null : { lens, bytes: held }
    if (lens === null) hold(0)
  }
  /** A failed Reload, holding the reservation as `key`, gives it back to the last lens it was handed to, which is still
   *  mounted, whatever document it shows. Never more than it holds, so this can't be refused. */
  const giveBack = (key: string): void => {
    if (holder !== key) return // a newer one has taken it
    holder = settled?.lens ?? null
    if ((settled?.bytes ?? 0) !== held) hold(settled?.bytes ?? 0)
  }
  /** Close and freeze cancel all reads. Leaving a view retains Reload's first page for its new metadata/index. */
  const cancelReads = (doc: number, leaving = false) => {
    for (const read of reads.values()) if (read.doc === doc && (!leaving || !read.retainOnLeave)) {
      read.cancelled = true
      read.cancel.cancel()
    }
  }
  /** Inactive tabs keep their document/index, but only the native cache floor. Late reads cannot regrow it. */
  const reclaimInactive = (): void => {
    for (const [id, doc] of docs) if (id !== activeDoc) {
      doc.setCacheActive(doc.generation, false)
      cancelReads(id, true)
    }
  }
  /** Only the winning reservation changes the active tab. A slower fresh open may still become an inactive tab. */
  const handoff = (pending: string, id: number, doc: Doc, gen: number): void => {
    if (holder !== pending) {
      if (activeDoc !== id) doc.setCacheActive(gen, false)
      return
    }
    doc.setCacheActive(gen, true)
    if (activeDoc !== null) {
      if (activeDoc !== id) {
        const previous = docs.get(activeDoc)
        if (previous) previous.setCacheActive(previous.generation, false)
      }
      cancelReads(activeDoc, true) // suspend viewport/build/image work, never a retained Reload or index job
    }
    activeDoc = id
    settle(pending, id + ':' + gen)
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
    const entry: ReadEntry = { doc, cancel: addon.cancelFlag(), retainOnLeave, cancelled: false }
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
  const candidate = async (req: number, pending: string, doc: Doc, count: number, local: LocalInfo,
    valid: () => boolean = () => true, source?: number, route?: SavedRoute, folder?: NativeFolderRoot): Promise<Opened> => {
    let entry: ReadEntry | undefined
    let published = false
    let registered: number | undefined
    let indexed: number | undefined
    try {
      entry = { doc: source, cancel: addon.cancelFlag(), retainOnLeave: true, cancelled: false, candidate: true, saved: route, folder }
      reads.set(req, entry)
      const firstPage = await doc.page(doc.generation, 0, count, entry.cancel)
      if (!valid()) throw new Refusal('Stale', 'the navigation source or saved location was replaced')
      if (entry.cancelled) throw new Refusal('Cancelled', 'the navigation was cancelled')
      const id = nextDoc++ // a partially started index must never alias a later document's id/generation
      indexed = id
      const opened = begin(id, doc, firstPage, local)
      docs.set(id, doc)
      registered = id
      handoff(pending, id, doc, opened.gen) // another holder may win; a fresh background tab remains valid
      published = true
      return { ...opened, reserved: held }
    } catch (e) {
      if (!published) {
        // begin can start an index before a later registration/handoff failure.
        if (indexed !== undefined) { jobs.get(indexed)?.cancel(); jobs.delete(indexed) }
        if (registered !== undefined) docs.delete(registered)
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
    addRoot: (p): FolderRoot => {
      if (typeof p.path !== 'string' || p.path.length === 0 || p.path.length > 32_767 || p.path.includes('\0'))
        throw new Refusal('InvalidParams', 'choose a folder path of at most 32,767 characters', 'path')
      if (!addon.captureFolder) throw new Refusal('Unsupported', 'folder browsing is unavailable in this core')
      if (roots.size >= 16) throw new Refusal('Refused', 'demo limit: remove a root before adding more than 16 folders')
      const peak = Math.max(rootPeak, roots.size + 1)
      // Path + label may be full UTF-16, alongside the Map entry and wrapper metadata/copies.
      const bytes = 3 * ((64 << 10) + (2 * 32_767 + 2 * 255 + (16 << 10)) * peak)
      if (!addon.reserveCache(held + workspaceBytes + savedHostBytes + bytes)) throw new Refusal('Memory', 'the folder table cannot grow')
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
        hold(held)
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
      reclaimInactive()
      const pending = take(req, bytes)
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
      reclaimInactive()
      const pending = take(req, bytes)
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
      const doc = getDoc(id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the tab generation was replaced')
      reclaimInactive()
      const pending = take(req, bytes)
      const view = { doc: id, gen, disposed: false }
      pendingViews.set(pending, view)
      try {
        const local = localInfo(doc)
        const firstPage = await read(req, id, (cancel) => doc.page(gen, 0, count, cancel))
        if (docs.get(id) !== doc || doc.generation !== gen || holder !== pending || view.disposed)
          throw new Refusal('Stale', 'the tab activation was replaced while it opened')
        const opened = describe(id, doc, firstPage, local)
        handoff(pending, id, doc, gen)
        return { ...opened, reserved: held }
      } catch (e) {
        giveBack(pending)
        throw e // the retained document is still owned by its tab, including a failed or stale activation
      } finally {
        if (pendingViews.get(pending) === view) pendingViews.delete(pending)
      }
    },
    deactivate: (p): boolean => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      const doc = getDoc(id)
      const lens = id + ':' + gen
      const current = doc.generation
      const previous = settled?.lens === lens
      // Reload advances the native generation before its old displayed view is disposed.
      if (current !== gen && !previous) throw new Refusal('Stale', 'the tab generation was replaced')
      doc.setCacheActive(current, false)
      cancelReads(id, true)
      if (activeDoc === id) activeDoc = null
      for (const view of pendingViews.values()) if (view.doc === id && (view.gen === gen || previous)) view.disposed = true
      if (holder === lens) settle(lens, null)
      // A pending request keeps its bytes, but its failure cannot restore a view the renderer already disposed.
      if (settled?.lens === lens) settled = null
      return true
    },
    openLocal: async (p, req): Promise<Opened> => {
      const [id, gen, count, bytes] = [int(p, 'doc'), int(p, 'gen'), int(p, 'count'), int(p, 'bytes')]
      if (typeof p.target !== 'string' || !decodedLocalTarget(p.target))
        throw new Refusal('InvalidParams', 'target must be a safe decoded local path of at most 32 KiB', 'target')
      const source = getDoc(id)
      if (source.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced`)
      reclaimInactive()
      const pending = take(req, bytes)
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
      const total = held + workspaceBytes + bytes + rootHostBytes
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
        if (!attempted) { savedHostBytes = previous; hold(held) }
        throw e
      }
    },
    openSaved: (p, req): Promise<Opened> => {
      const ticket = savedTicket(p)
      const [count, bytes] = [int(p, 'count'), int(p, 'bytes')]
      const route = ticket.session === session ? saved.get(ticket.id) : undefined
      if (!route) throw new Refusal('Stale', 'the saved location is unavailable; select the file manually again')
      reclaimInactive()
      const pending = take(req, bytes)
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
      const target = localTarget(p.href)
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
    // A failed reload (the file is gone, say) leaves the document at its old generation, and gives the renderer cache's
    // reservation back to the lens it was last handed to (`settled`), whichever document that lens is showing. A reload
    // that another Reload, or close, overtakes while its first page is read is Stale, and starts nothing: the newer one
    // indexes.
    reload: async (p, req): Promise<Opened> => {
      const [id, count, bytes] = [int(p, 'doc'), int(p, 'count'), int(p, 'bytes')]
      const doc = getDoc(id)
      const previous = doc.generation
      reclaimInactive()
      const pending = take(req, bytes)
      const view = { doc: id, gen: previous, disposed: false }
      pendingViews.set(pending, view)
      try {
        const local = localInfo(doc) // a Memory refusal must precede Reload's generation change
        // A display path selects a candidate only; native binding proves membership before Reload commits.
        const path = !doc.localOnly && !doc.folder && roots.size ? resolve(doc.path).toLocaleLowerCase('en-US') : undefined
        const root = path && [...roots.values()].sort((a, b) => b.path.length - a.path.length)
          .find((r) => path.startsWith(r.path.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US') + '\\'))
        if (root) doc.reloadInFolder(root.native)
        else doc.reload()
        const gen = doc.generation
        view.gen = gen
        const firstPage = await read(req, id, (cancel) => doc.page(gen, 0, count, cancel), true)
        if (docs.get(id) !== doc || doc.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced while it opened`)
        const opened = begin(id, doc, firstPage, local)
        if (view.disposed) {
          if (activeDoc !== id) doc.setCacheActive(gen, false)
          giveBack(pending)
          return { ...opened, reserved: 0 }
        }
        handoff(pending, id, doc, gen)
        return { ...opened, reserved: held }
      } catch (e) {
        if (docs.get(id) === doc) giveBack(pending)
        else settle(pending, null) // closed meanwhile: its lens is gone
        throw e
      } finally {
        if (pendingViews.get(pending) === view) pendingViews.delete(pending)
      }
    },
    // Plan C6: the index job and the page reads stop, and the document's handle closes once they have.
    close: (p) => {
      const id = int(p, 'doc')
      const doc = docs.get(id)
      if (!doc) return false
      jobs.get(id)?.cancel()
      cancelReads(id)
      doc.close()
      if (activeDoc === id) activeDoc = null
      if (__TEST_HOOKS__) closed.push(doc)
      jobs.delete(id)
      if (holder?.startsWith(`${id}:`)) settle(holder, null) // its lens is gone
      if (settled?.lens.startsWith(`${id}:`)) settled = null
      return docs.delete(id)
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
      const [doc, gen, bytes] = [int(p, 'doc'), int(p, 'gen'), int(p, 'bytes')]
      if (holder !== `${doc}:${gen}` || !hold(bytes)) return false
      settled = { lens: holder, bytes }
      return true
    },
    reserveWorkspace: (p) => {
      const bytes = int(p, 'bytes')
      const total = held + bytes + savedHostBytes + rootHostBytes
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
    if (reads.has(id) || pendingViews.has(`#${id}`))
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
