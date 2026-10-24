// The core host's side of protocol v1. Every request is validated before anything acts on it (plan C4):
// numbers against the core's own range table, methods by own property only, and no addon call on a refusal.
import type { Cancel, Doc, IndexProgress, Limits, Page as CorePage, PageItem as CorePageItem } from 'typose-node'
import {
  PROTOCOL,
  type Charges,
  type CoreError,
  type DebugStats,
  type ErrorCode,
  type Hello,
  type Opened,
  type Page,
  type PageItem,
  type ProgressEvent,
  type Response
} from '../shared/protocol'
import { isValid } from './numbers'

declare const __TEST_HOOKS__: boolean

/** The slice of `typose-node` the core host calls; tests pass a spy. */
export interface Addon {
  coreVersion(): string
  limits(): Limits
  openDoc(path: string): Doc
  /** A new cancel flag, for one page read or one index job (plan C5, C6). */
  cancelFlag(): Cancel
  /** Plan C1: sets the renderer cache's reservation in the ledger; false if the ledger refused it. */
  reserveCache(bytes: number): boolean
  /** The test-hooks addon's live jobs, tasks and file handles, and its ledger (plan m8, C1). */
  debugStats?(): Pick<DebugStats, 'jobs' | 'tasks' | 'handles' | 'ledger'>
  /** The test-hooks addon's itemized charges of one document (plan C1, C6). */
  docCharges?(doc: Doc): Charges
  /** The test-hooks build's forced GC of the core host's heap (plan C1's measurements). */
  gc?(): void
  /** The test-hooks addon's reset of the ledger's high-water mark (plan C1's exhaustion test). */
  resetHigh?(): void
  /** The test-hooks addon's budget override (plan C1): the ledger's limit, in bytes. */
  setLimit?(bytes: number): void
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
const ADDON_CODES = new Set<string>(['InvalidParams', 'NotFound', 'PermissionDenied', 'Refused', 'Binary', 'Frozen', 'Stale', 'Io', 'Cancelled', 'NoDocument', 'Memory'])

type Params = Record<string, unknown>
const isRecord = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v)
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code

export function makeDispatcher(addon: Addon, session: number, emit: (event: ProgressEvent) => void): (data: unknown) => Promise<Response> {
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
  /** Each document's index job (plan C6). */
  const jobs = new Map<number, Cancel>()
  /** Page reads in flight, by request id (plan C5). `cancelledAt` is the test-hooks build's. */
  const reads = new Map<number, { doc: number; cancel: Cancel; cancelledAt?: number }>()
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
  /**
   * Plan C1: the renderer cache's reservation. One renderer talks to a core host and shows one lens at a time, so it's
   * held for one lens: `doc:gen`. An open or Reload takes it at its first step for the lens it opens (`#id` while it's
   * under way), with at least that lens's viewport-only cap, `bytes`: part of the open's floor. The lens it replaces is
   * unmounted in the renderer commit that mounts the new one, so it holds the larger of the two, not their sum, and what
   * the replaced lens asks for is refused.
   */
  let holder: string | null = null
  let held = 0
  const hold = (bytes: number): boolean => {
    if (!addon.reserveCache(bytes)) return false
    held = bytes
    return true
  }
  /** Request `req` takes the reservation for the lens it opens; refused, it's `Memory` and nothing has changed. */
  const take = (req: number, bytes: number): string => {
    if (!hold(Math.max(held, bytes))) throw new Refusal('Memory', `the memory budget can't hold the view's ${bytes} bytes`)
    return (holder = `#${req}`)
  }
  /** The open or Reload holding the reservation as `pending` hands it to its lens; failed (`null`), it releases it. */
  const settle = (pending: string, lens: string | null): void => {
    if (holder !== pending) return // a newer one has taken it
    holder = lens
    if (lens === null) hold(0)
  }
  /** Plan C6: close and a freeze cancel the document's page reads in flight. */
  const cancelReads = (doc: number) => {
    for (const read of reads.values()) if (read.doc === doc) read.cancel.cancel()
  }
  // Continuation tokens leave with this session and their document in them, and are refused for any other
  // (plan C3; C7: every token carries `{session, doc, gen}`).
  const stamp = (doc: number, item: CorePageItem): PageItem => {
    if (item.next) Object.assign(item.next, { session, doc })
    return item as PageItem
  }
  const stampPage = (doc: number, page: CorePage): Page => {
    for (const item of page.items) stamp(doc, item)
    return page as Page
  }
  /** Request `id`'s page read of document `doc`, which `cancel` can stop while it runs (plan C5). */
  const read = async (id: number, doc: number, start: (cancel: Cancel) => Promise<CorePage>): Promise<Page> => {
    const entry: { doc: number; cancel: Cancel; cancelledAt?: number } = { doc, cancel: addon.cancelFlag() }
    reads.set(id, entry)
    try {
      return stampPage(doc, await start(entry.cancel))
    } catch (e) {
      if (codeOf(e) === 'Frozen') cancelReads(doc) // a freeze ends the document's other reads too (plan C6)
      if (__TEST_HOOKS__ && codeOf(e) === 'Cancelled' && entry.cancelledAt !== undefined) {
        cancels.cancelled++
        cancels.cancelMs = Math.max(cancels.cancelMs, performance.now() - entry.cancelledAt)
      }
      throw e
    } finally {
      reads.delete(id)
    }
  }
  /** Starts indexing a document's current generation, and describes it with its first page. */
  const begin = (id: number, doc: Doc, firstPage: CorePage): Omit<Opened, 'reserved'> => {
    const gen = doc.generation
    const cancel = addon.cancelFlag()
    jobs.get(id)?.cancel() // the previous generation's job, if it still runs (plan C6)
    jobs.set(id, cancel)
    doc.startIndex(cancel, (e: IndexProgress) => {
      // An index error froze the document (plan C6). An older generation's ends with Reload's freeze, not this one's.
      if (e.error !== undefined && jobs.get(id) === cancel) cancelReads(id)
      const event: ProgressEvent = { event: 'progress', session, doc: id, gen, lines: e.lines, bytes: e.bytes, done: e.done }
      if (e.error !== undefined) event.error = e.error
      emit(event)
    })
    const { size, encoding, lines, indexed, blank } = doc
    return { doc: id, gen, size, encoding, lines, indexed, blank, firstPage: stampPage(id, firstPage) }
  }

  // Each handler checks all of its parameters before it calls the addon or changes state. `id` is the request's.
  const handlers: Record<string, (params: Params, id: number) => unknown> = {
    hello: (p): Hello => {
      if (int(p, 'protocol') !== PROTOCOL) throw new Refusal('Unsupported', `protocol ${String(p.protocol)}; this core speaks ${PROTOCOL}`)
      return { protocol: PROTOCOL, core: addon.coreVersion(), session, limits }
    },
    open: async (p, req): Promise<Opened> => {
      const [count, bytes] = [int(p, 'count'), int(p, 'bytes')]
      if (typeof p.path !== 'string' || p.path.length === 0 || p.path.length > 32_767 || p.path.includes('\0'))
        throw new Refusal('InvalidParams', 'path must be a non-empty string of at most 32,767 characters, without NUL', 'path')
      const pending = take(req, bytes)
      let doc: Doc
      try {
        doc = addon.openDoc(p.path)
      } catch (e) {
        settle(pending, null)
        throw e
      }
      // The first page reads from byte 0, so it doesn't wait for the index (Z37). It's read before the document is
      // registered, and a failure closes it, so nothing is left behind.
      let firstPage: CorePage
      try {
        firstPage = await doc.page(doc.generation, 0, count, addon.cancelFlag())
      } catch (e) {
        doc.close()
        settle(pending, null)
        throw e
      }
      const id = nextDoc++
      docs.set(id, doc)
      settle(pending, `${id}:${doc.generation}`)
      return { ...begin(id, doc, firstPage), reserved: held }
    },
    page: (p, req): Promise<Page> => {
      const id = int(p, 'doc')
      if (p.lens !== 'raw') throw new Refusal('InvalidParams', "lens must be 'raw'", 'lens')
      if (Object.hasOwn(p, 'continuation')) {
        const t = p.continuation
        if (!isRecord(t)) throw new Refusal('InvalidParams', 'continuation must be a token', 'continuation')
        const [tokenSession, tokenDoc, gen, line, offset] = ['session', 'doc', 'gen', 'line', 'offset'].map((f) => int(t, f, `continuation.${f}`))
        const doc = getDoc(id)
        if (tokenSession !== session) throw new Refusal('Stale', `a token of session ${tokenSession}; this is session ${session}`)
        if (tokenDoc !== id) throw new Refusal('InvalidParams', `a token of document ${tokenDoc}, not ${id}`, 'continuation.doc')
        return read(req, id, (cancel) => doc.piece(gen, line, offset, cancel))
      }
      const [gen, start, count] = [int(p, 'gen'), int(p, 'start'), int(p, 'count')]
      const doc = getDoc(id)
      return read(req, id, (cancel) => doc.page(gen, start, count, cancel))
    },
    // A failed reload (the file is gone, say) leaves the document at its old generation. A reload that another
    // Reload, or close, overtakes while its first page is read is Stale, and starts nothing: the newer one indexes.
    reload: async (p, req): Promise<Opened> => {
      const [id, count, bytes] = [int(p, 'doc'), int(p, 'count'), int(p, 'bytes')]
      const doc = getDoc(id)
      const pending = take(req, bytes)
      try {
        doc.reload()
        const gen = doc.generation
        const firstPage = await doc.page(gen, 0, count, addon.cancelFlag())
        if (docs.get(id) !== doc || doc.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced while it opened`)
        settle(pending, `${id}:${gen}`)
        return { ...begin(id, doc, firstPage), reserved: held }
      } catch (e) {
        settle(pending, null)
        throw e
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
      if (__TEST_HOOKS__) closed.push(doc)
      jobs.delete(id)
      if (holder?.startsWith(`${id}:`)) settle(holder, null) // its lens is gone
      return docs.delete(id)
    },
    cancel: (p) => {
      const running = reads.get(int(p, 'id'))
      if (!running) return false
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
      return holder === `${doc}:${gen}` && hold(bytes)
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
            return { ...addon.debugStats!(), docs: docs.size, ...cancels, charges, heap: { rss, heapUsed, external, arrayBuffers } }
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
