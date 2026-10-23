// The core host's side of protocol v1. Every request is validated before anything acts on it (plan C4):
// numbers against the core's own range table, methods by own property only, and no addon call on a refusal.
import type { Doc, IndexProgress, Limits } from 'typose-node'
import { PROTOCOL, type CoreError, type ErrorCode, type Hello, type Opened, type ProgressEvent, type Response } from '../shared/protocol'
import { isValid } from './numbers'

/** The slice of `typose-node` the core host calls; tests pass a spy. */
export interface Addon {
  coreVersion(): string
  limits(): Limits
  openDoc(path: string): Doc
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
const ADDON_CODES = new Set<string>(['InvalidParams', 'NotFound', 'PermissionDenied', 'Refused', 'Binary', 'Frozen', 'Stale', 'Io'])

type Params = Record<string, unknown>
const isRecord = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v)

export function makeDispatcher(addon: Addon, session: number, emit: (event: ProgressEvent) => void): (data: unknown) => Response {
  const limits = addon.limits()
  const ranges = new Map(limits.ranges.map((r) => [r.field, r]))
  const int = (params: Params, field: string): number => {
    const { min, max } = ranges.get(field)!
    const value = params[field]
    if (!isValid(value, min, max)) throw new Refusal('InvalidParams', `${field} must be an integer in [${min}, ${max}]`, field)
    return value
  }
  const docs = new Map<number, Doc>()
  let nextDoc = 1
  const getDoc = (id: number): Doc => {
    const doc = docs.get(id)
    if (!doc) throw new Refusal('NoDocument', `no document ${id}`)
    return doc
  }

  // Each handler checks all of its parameters before it calls the addon or changes state.
  const handlers: Record<string, (params: Params) => unknown> = {
    hello: (p): Hello => {
      if (int(p, 'protocol') !== PROTOCOL) throw new Refusal('Unsupported', `protocol ${String(p.protocol)}; this core speaks ${PROTOCOL}`)
      return { protocol: PROTOCOL, core: addon.coreVersion(), session, limits }
    },
    open: (p): Opened => {
      const count = int(p, 'count')
      if (typeof p.path !== 'string' || p.path.length === 0 || p.path.length > 32_767 || p.path.includes('\0'))
        throw new Refusal('InvalidParams', 'path must be a non-empty string of at most 32,767 characters, without NUL', 'path')
      const doc = addon.openDoc(p.path)
      // The first page reads from byte 0, so it doesn't wait for the index (Z37). It's read before the document is
      // registered, so a failure leaves nothing behind.
      const firstPage = doc.page(0, count)
      const id = nextDoc++
      docs.set(id, doc)
      const gen = doc.generation
      doc.startIndex((e: IndexProgress) => {
        const event: ProgressEvent = { event: 'progress', session, doc: id, gen, lines: e.lines, bytes: e.bytes, done: e.done }
        if (e.error !== undefined) event.error = e.error
        emit(event)
      })
      return { doc: id, gen, size: doc.size, encoding: doc.encoding, lines: doc.lines, indexed: doc.indexed, firstPage }
    },
    page: (p) => {
      const [id, start, count] = [int(p, 'doc'), int(p, 'start'), int(p, 'count')]
      if (p.lens !== 'raw') throw new Refusal('InvalidParams', "lens must be 'raw'", 'lens')
      return getDoc(id).page(start, count)
    },
    // PR 5 (plan C6) makes close cancel the index and release the handle; here it forgets the document.
    close: (p) => docs.delete(int(p, 'doc'))
  }

  return (data) => {
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
      return { id, session, result: handlers[method](data.params) }
    } catch (e) {
      if (e instanceof Refusal) return fail(id, { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) })
      const code = (e as { code?: unknown }).code
      const message = e instanceof Error ? e.message : String(e)
      return fail(id, { code: typeof code === 'string' && ADDON_CODES.has(code) ? (code as ErrorCode) : 'Internal', message })
    }
  }
}
