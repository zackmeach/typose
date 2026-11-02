// The core host's side of protocol v1. Every request is validated before anything acts on it (plan C4):
// numbers against the core's own range table, methods by own property only, and no addon call on a refusal.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  Cancel, Doc, IndexProgress, Limits, SavedRoute, FolderRoot as NativeFolderRoot, Page as CorePage,
  CsvInfo as NativeCsvInfo, CsvCellPiece as NativeCsvPiece, CsvPage as NativeCsvPage,
} from 'typose-node'
import {
  PROTOCOL,
  type Charges,
  type CapturedLocation,
  type CoreError,
  type CsvCell,
  type CsvCellPiece,
  type CsvColumn,
  type CsvColumnPage,
  type CsvInfo,
  type CsvLocated,
  type CsvPage,
  type CsvRef,
  type CsvSource,
  type CsvOrderRef,
  type CsvOrderInfo,
  type CsvFindRef,
  type CsvFindInfo,
  type CsvFindPage,
  type CsvFindSeek,
  type CsvFindHit,
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
  type SourceFindRef,
  type SourceFindInfo,
  type SourceFindPage,
  type SourceFindSeek,
  type ViewRef,
  type StructuredRef
} from '../shared/protocol'
import { isValid } from './numbers'
import { boundedLink, decodedLocalTarget, localTarget } from './local-target'
import { isExecutable } from '../shared/handoff'
import { structuredChildren, structuredColumns, structuredInfo, structuredRows } from './structured-validation'
import { findNumber, findProgress, sourceHit, sourceHits, csvFindHit, csvFindHits } from './find-validation'

declare const __TEST_HOOKS__: boolean

/** The slice of `typose-node` the core host calls; tests pass a spy. */
export interface Addon {
  coreVersion(): string
  limits(): Limits
  openDoc(path: string): Doc
  captureFolder?(path: string, id: string): NativeFolderRoot
  setEncodingFallback?(utf8: boolean): void
  /** UNC, or a drive letter the network redirector serves; nothing is opened. */
  networkPath?(path: string): boolean
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

export function makeDispatcher(addon: Addon, session: number, emit: (event: ProgressEvent) => void, ticketId: () => string = randomUUID): ((data: unknown) => Promise<Response>) & { handoffPath(subject: unknown): string } {
  const limits = addon.limits()
  const ranges = new Map(limits.ranges.map((r) => [r.field, r]))
  /** `params[field]`, checked against the core's range for `field`; `name` is how the error names it. */
  const int = (params: Params, field: string, name = field): number => {
    const { min, max } = ranges.get(field)!
    const value = params[field]
    if (!isValid(value, min, max)) throw new Refusal('InvalidParams', `${name} must be an integer in [${min}, ${max}]`, name)
    return value
  }
  const csvRequestNumber = (value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    if (!isValid(value, min, max)) throw new Refusal('InvalidParams', `${field} must be a safe integer in [${min}, ${max}]`, field)
    return value
  }
  const csvResultNumber = (value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    if (!isValid(value, min, max)) throw new Refusal('Internal', `the core returned an invalid CSV ${field}`)
    return value
  }
  const csvFormat = (doc: Doc): boolean => doc.format === 'csv'
  const csvOption = (value: unknown): { delimiter: string; header: number } => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'options must be a CSV options object', 'options')
    const delimiters: Record<string, string> = { auto: 'auto', ',': ',', '\t': '\t', ';': ';', '|': '|' }
    if (typeof value.delimiter !== 'string' || !Object.hasOwn(delimiters, value.delimiter))
      throw new Refusal('InvalidParams', 'options.delimiter must be auto, comma, tab, semicolon, or pipe', 'options.delimiter')
    const header = value.header === 'auto' ? 0 : value.header === true ? 1 : value.header === false ? -1 : undefined
    if (header === undefined) throw new Refusal('InvalidParams', 'options.header must be auto or boolean', 'options.header')
    return { delimiter: delimiters[value.delimiter], header }
  }
  const csvRef = (value: unknown): CsvRef => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'ref must be a CSV reference', 'ref')
    const refSession = int(value, 'session', 'ref.session')
    const doc = int(value, 'doc', 'ref.doc')
    const gen = int(value, 'gen', 'ref.gen')
    const revision = csvRequestNumber(value.revision, 'ref.revision', 1, 0xffff_ffff)
    if (refSession !== session) throw new Refusal('Stale', 'the CSV reference belongs to another core session')
    return { session: refSession, doc, gen, revision }
  }
  const csvForRef = (ref: CsvRef): Doc => {
    const doc = getDoc(ref.doc)
    if (doc.generation !== ref.gen) throw new Refusal('Stale', 'the CSV document generation was replaced')
    if (!csvFormat(doc)) throw new Refusal('Stale', 'the document is no longer a CSV or TSV file')
    const current = csvRevisions.get(ref.doc)
    if (!current || current.generation !== ref.gen || current.revision !== ref.revision)
      throw new Refusal('Stale', 'the CSV configuration was replaced')
    return doc
  }
  const cancelCsvReads = (doc: number, except?: number): void => {
    for (const [req, entry] of reads) if (req !== except && entry.doc === doc && entry.csv) {
      entry.cancelled = true
      entry.cancel.cancel()
    }
  }
  const cancelCsvConfigurations = (doc: number): void => {
    for (const entry of reads.values()) if (entry.doc === doc && entry.csvConfig) {
      entry.cancelled = true
      entry.cancel.cancel()
    }
  }
  const invalidateCsv = (doc: number): void => {
    closeDocumentCsvInteractions(doc)
    cancelCsvReads(doc)
    csvRevisions.delete(doc)
    csvConfigurations.delete(doc)
  }
  const nextCsvConfig = (doc: number): number => {
    if (!isValid(nextCsvConfiguration, 1, Number.MAX_SAFE_INTEGER)) throw new Refusal('Refused', 'CSV configuration identities are exhausted')
    const id = nextCsvConfiguration++
    csvConfigurations.set(doc, id)
    return id
  }
  const currentCsvRead = (req: number, doc: Doc, id: number, gen: number, revision?: number, config?: number): void => {
    const entry = reads.get(req)
    if (!entry || entry.cancelled) throw new Refusal('Cancelled', 'the CSV request was cancelled')
    if (docs.get(id) !== doc || doc.generation !== gen || docOwners.get(id) !== entry.surface)
      throw new Refusal('Stale', 'the CSV document or surface was replaced')
    if (config !== undefined && csvConfigurations.get(id) !== config)
      throw new Refusal('Stale', 'the CSV configuration was replaced while reading')
    if (revision !== undefined) {
      const current = csvRevisions.get(id)
      if (!current || current.generation !== gen || current.revision !== revision)
        throw new Refusal('Stale', 'the CSV configuration was replaced while reading')
    }
  }
  const csvRead = <T>(req: number, id: number, gen: number, revision: number, start: (cancel: Cancel) => Promise<T>): Promise<T> => {
    const doc = getDoc(id)
    return read(req, id, async (cancel) => {
      const result = await start(cancel)
      currentCsvRead(req, doc, id, gen, revision)
      return result
    }, false, true)
  }
  const nativeCsvSpan = (value: unknown): { start: number; end: number } => {
    if (!isRecord(value)) throw new Refusal('Internal', 'the core returned an invalid CSV span')
    const start = csvResultNumber(value.start, 'span start')
    const end = csvResultNumber(value.end, 'span end')
    if (end < start) throw new Refusal('Internal', 'the core returned a reversed CSV span')
    return { start, end }
  }
  const stampCsvPiece = (value: NativeCsvPiece, ref: CsvRef): CsvCellPiece => {
    const sourceRecord = csvResultNumber(value.sourceRecord, 'source record')
    const column = csvResultNumber(value.column, 'column')
    const span = nativeCsvSpan(value.span)
    const pieceSpan = nativeCsvSpan(value.pieceSpan)
    if (pieceSpan.start < span.start || pieceSpan.end > span.end || pieceSpan.end < pieceSpan.start)
      throw new Refusal('Internal', 'the core returned a CSV piece outside its field span')
    const next = value.next == null ? undefined : (() => {
      if (!isRecord(value.next)) throw new Refusal('Internal', 'the core returned an invalid CSV continuation')
      return {
        ref,
        sourceRecord: csvResultNumber(value.next.sourceRecord, 'continuation source record'),
        column: csvResultNumber(value.next.column, 'continuation column'),
        offset: csvResultNumber(value.next.offset, 'continuation offset')
      }
    })()
    if (next && (next.sourceRecord !== sourceRecord || next.column !== column || next.offset <= pieceSpan.start || next.offset >= span.end))
      throw new Refusal('Internal', 'the core returned an invalid CSV piece continuation')
    return { kind: 'value', sourceRecord, column, span, pieceSpan, text: value.text, map: value.map,
      replacements: csvResultNumber(value.replacements, 'replacement count'), ...(next ? { next } : {}) }
  }
  const stampCsvPage = (value: NativeCsvPage, ref: CsvRef, rowStart: number, rowCount: number, columnStart: number, columnCount: number): CsvPage => {
    if (!Array.isArray(value.rows) || value.rows.length > 128 || typeof value.completeRect !== 'boolean' || typeof value.indexing !== 'boolean')
      throw new Refusal('Internal', 'the core returned an invalid CSV page envelope')
    let cellCount = 0
    const rows = value.rows.map((row) => {
      if (!Array.isArray(row.cells) || row.cells.length > columnCount) throw new Refusal('Internal', 'the core returned an invalid CSV row')
      cellCount += row.cells.length
      if (cellCount > 512) throw new Refusal('Internal', 'the core returned too many CSV cells')
      const sourceRecord = csvResultNumber(row.sourceRecord, 'source record')
      const cells: CsvCell[] = row.cells.map((cell) => {
        if (!isRecord(cell)) throw new Refusal('Internal', 'the core returned an invalid CSV cell')
        const column = csvResultNumber(cell.column, 'column')
        if (column < columnStart || column >= columnStart + columnCount)
          throw new Refusal('Internal', 'the core returned a CSV cell outside the requested rectangle')
        if (cell.value == null) return { kind: 'missing', column }
        if (!isRecord(cell.value)) throw new Refusal('Internal', 'the core returned an invalid CSV value cell')
        const piece = stampCsvPiece(cell.value, ref)
        if (piece.column !== column || piece.sourceRecord !== sourceRecord)
          throw new Refusal('Internal', 'the core returned a CSV cell for the wrong row or column')
        return piece
      })
      const complete = row.complete
      if (typeof complete !== 'boolean') throw new Refusal('Internal', 'the core returned an invalid CSV row state')
      const dataRow = csvResultNumber(row.dataRow, 'data row')
      if (dataRow < rowStart || dataRow >= rowStart + rowCount)
        throw new Refusal('Internal', 'the core returned a CSV row outside the requested rectangle')
      return {
        dataRow,
        sourceRecord,
        sourceLine: csvResultNumber(row.sourceLine, 'source line'),
        span: nativeCsvSpan(row.span),
        fieldCount: csvResultNumber(row.fieldCount, 'field count'),
        cells,
        complete
      }
    })
    const nextRow = value.nextRow == null ? undefined : csvResultNumber(value.nextRow, 'next row')
    const nextColumn = value.nextColumn == null ? undefined : csvResultNumber(value.nextColumn, 'next column')
    return { ref, rows, completeRect: value.completeRect, indexing: value.indexing,
      ...(nextRow === undefined ? {} : { nextRow }), ...(nextColumn === undefined ? {} : { nextColumn }) }
  }
  const stampCsvInfo = (value: NativeCsvInfo, id: number, gen: number): CsvInfo => {
    const revision = csvResultNumber(value.revision, 'revision', 1, 0xffff_ffff)
    if (!['indexing', 'ready', 'locked'].includes(value.status) || typeof value.delimiter !== 'string'
      || ![',', '\t', ';', '|'].includes(value.delimiter) || typeof value.header !== 'boolean' || typeof value.encoding !== 'string'
      || typeof value.done !== 'boolean' || typeof value.metadataDone !== 'boolean')
      throw new Refusal('Internal', 'the core returned invalid CSV configuration metadata')
    const reason = value.reason
    if (reason != null && typeof reason !== 'string') throw new Refusal('Internal', 'the core returned an invalid CSV reason')
    const rawProblems = (value as NativeCsvInfo & { problems?: unknown }).problems
    if (rawProblems != null && (!Array.isArray(rawProblems) || rawProblems.length > 2)) throw new Refusal('Internal', 'the core returned invalid CSV problems')
    const problems = (rawProblems as unknown[] | undefined ?? []).map(problem => {
      if (!isRecord(problem) || !['ragged', 'decoding'].includes(String(problem.kind))) throw new Refusal('Internal', 'the core returned invalid CSV problem metadata')
      return { kind: String(problem.kind), count: csvResultNumber(problem.count, 'problem count', 1), first: nativeCsvSpan(problem.first),
        ...(problem.sourceRecord == null ? {} : { sourceRecord: csvResultNumber(problem.sourceRecord, 'problem record') }),
        ...(problem.sourceLine == null ? {} : { sourceLine: csvResultNumber(problem.sourceLine, 'problem line') }) }
    })
    return {
      ref: { session, doc: id, gen, revision }, status: value.status as CsvInfo['status'], ...(reason == null ? {} : { reason }),
      delimiter: value.delimiter as CsvInfo['delimiter'], header: value.header, encoding: value.encoding,
      sourceRecords: csvResultNumber(value.sourceRecords, 'source records'),
      indexedBytes: csvResultNumber(value.indexedBytes, 'indexed bytes'), done: value.done,
      expectedColumns: csvResultNumber(value.expectedColumns, 'expected columns'),
      maxColumnsKnown: csvResultNumber(value.maxColumnsKnown, 'maximum known columns'), metadataDone: value.metadataDone, problems
    }
  }
  const docs = new Map<number, Doc>()
  const docOwners = new Map<number, number>()
  /** Each document's index job (plan C6). */
  const jobs = new Map<number, Cancel>()
  /** Page reads in flight, by request id (plan C5). `cancelledAt` is the test-hooks build's. */
  type ReadEntry = {
    doc?: number; cancel: Cancel; retainOnLeave: boolean; cancelled: boolean; cancelledAt?: number
    candidate?: true; saved?: SavedRoute; folder?: NativeFolderRoot; surface?: number; csv?: true; csvConfig?: true
    findView?: number; findId?: number; findKind?: 'source' | 'csv'; findOp?: 'scan' | 'seek'; csvSort?: true
  }
  const reads = new Map<number, ReadEntry>()
  const saved = new Map<string, SavedRoute>()
  let savedPeak = 0
  let savedHostBytes = 0
  const roots = new Map<string, { native: NativeFolderRoot; path: string }>()
  let nextRoot = 1
  let rootPeak = 0
  let rootHostBytes = 0 // Map capacity remains paid until this host exits, including after removeRoot.
  const csvRevisions = new Map<number, { generation: number; revision: number; order?: number; orderView?: number; sort?: number; sortView?: number; interactionId?: string }>()
  let nextSort = 1
  const csvConfigurations = new Map<number, number>()
  let nextCsvConfiguration = 1
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

  type Lease = { ref: ViewRef; bytes: number; activationId?: string; sourceFind?: number; csvFind?: { id: number; order: CsvOrderRef }; structured?: StructuredRef }
  type SurfaceState = { ref: SurfaceRef; alive: boolean; views: Map<number, Lease>; current?: number; latest?: Pending }
  type Pending = { request: number; surface: SurfaceState; bytes: number; activationId?: string; doc?: number; gen?: number; disposed: boolean; previousView?: number; kind?: 'activate' | 'reload' }
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
    const previous = currentLease(surface)
    if (previous) { closeSourceFind(previous); closeCsvInteractions(previous) }
    surface.views.set(ref.id, { ref, bytes: pending.bytes, ...(pending.activationId ? { activationId: pending.activationId } : {}) })
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
  const findLease = (view: unknown): Lease => {
    if (view === undefined) throw new Refusal('InvalidParams', 'Find requires an exact activation lease', 'view')
    const owned = requestedLease({ view })
    if (!owned || owned.surface.current !== owned.lease.ref.id) throw new Refusal('Stale', 'the Find view was replaced')
    const { lease } = owned
    if (docOwners.get(lease.ref.doc) !== lease.ref.surface || getDoc(lease.ref.doc).generation !== lease.ref.gen)
      throw new Refusal('Stale', 'the Find document or owner was replaced')
    return lease
  }
  const findQuery = (p: Params): string => {
    if (typeof p.query !== 'string' || p.query.length < 1 || p.query.length > 512)
      throw new Refusal('InvalidParams', 'query must contain 1–512 valid UTF-16 units', 'query')
    try { encodeURIComponent(p.query) } catch { throw new Refusal('InvalidParams', 'query contains an unpaired surrogate', 'query') }
    if (typeof p.matchCase !== 'boolean') throw new Refusal('InvalidParams', 'matchCase must be boolean', 'matchCase')
    return p.query
  }
  const structuredReference = (value: unknown): { ref: StructuredRef; lease: Lease; doc: Doc } => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'ref must be a structured reference', 'ref')
    const ref: StructuredRef = { session: int(value, 'session'), doc: int(value, 'doc'), gen: int(value, 'gen'), revision: int({ gen: value.revision }, 'gen', 'revision') }
    if (ref.session !== session) throw new Refusal('Stale', 'the structured reference belongs to another session')
    const owner = docOwners.get(ref.doc)
    const surface = owner === undefined ? undefined : surfaces.get(owner)
    const lease = surface ? currentLease(surface) : undefined
    if (!lease || lease.ref.doc !== ref.doc || lease.ref.gen !== ref.gen || lease.structured?.revision !== ref.revision)
      throw new Refusal('Stale', 'the structured view or index was replaced')
    findLease(lease.ref)
    return { ref, lease, doc: getDoc(ref.doc) }
  }
  const findDirection = (p: Params): boolean => {
    if (p.direction !== 'next' && p.direction !== 'previous') throw new Refusal('InvalidParams', 'direction must be next or previous', 'direction')
    return p.direction === 'previous'
  }
  const sourceFindRef = (value: unknown): { ref: SourceFindRef; lease: Lease; doc: Doc } => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'ref must be a Find reference', 'ref')
    const lease = findLease(value.view)
    const id = int(value, 'id', 'ref.id')
    if (lease.sourceFind !== id) throw new Refusal('Stale', 'the Find query was replaced')
    return { ref: { view: lease.ref, id }, lease, doc: getDoc(lease.ref.doc) }
  }
  const cancelFindReads = (lease: Lease, id: number, kind: 'source' | 'csv' = 'source'): void => {
    for (const entry of reads.values()) if (entry.findView === lease.ref.id && entry.findId === id && entry.findKind === kind) {
      entry.cancelled = true; entry.cancel.cancel()
    }
  }
  const closeSourceFind = (lease: Lease): void => {
    const id = lease.sourceFind
    if (id === undefined) return
    lease.sourceFind = undefined
    cancelFindReads(lease, id)
    const doc = docs.get(lease.ref.doc)
    if (doc?.generation === lease.ref.gen) doc.sourceFindClose(lease.ref.gen, id)
  }
  const closeDocumentFind = (id: number): void => {
    for (const surface of surfaces.values()) for (const lease of surface.views.values()) if (lease.ref.doc === id) closeSourceFind(lease)
  }
  const beginFindRead = (req: number, lease: Lease, id: number, kind: 'source' | 'csv', op: 'scan' | 'seek'): void => {
    for (const [other, entry] of reads) if (other !== req && entry.findView === lease.ref.id && entry.findId === id
      && entry.findKind === kind && entry.findOp === op) { entry.cancelled = true; entry.cancel.cancel() }
    Object.assign(reads.get(req)!, { findView: lease.ref.id, findId: id, findKind: kind, findOp: op })
  }
  const sourceFindRead = <T>(req: number, ref: SourceFindRef, lease: Lease, op: 'scan' | 'seek', start: (cancel: Cancel) => Promise<T>): Promise<T> =>
    read(req, ref.view.doc, async (cancel) => {
      beginFindRead(req, lease, ref.id, 'source', op)
      const result = await start(cancel)
      if (reads.get(req)?.cancelled) throw new Refusal('Cancelled', 'the Find request was cancelled')
      if (findLease(ref.view) !== lease || lease.sourceFind !== ref.id) throw new Refusal('Stale', 'the Find query was replaced while reading')
      return result
    })
  const csvLease = (ref: CsvRef): Lease => {
    csvForRef(ref)
    const owner = docOwners.get(ref.doc)
    const lease = owner === undefined ? undefined : currentLease(surfaces.get(owner)!)
    if (!lease || lease.ref.doc !== ref.doc || lease.ref.gen !== ref.gen) throw new Refusal('Stale', 'the Grid view was replaced')
    return findLease(lease.ref)
  }
  const csvInteractionId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
      throw new Refusal('InvalidParams', 'interactionId must be a Grid UUID', 'interactionId')
    return value
  }
  const orderRef = (value: unknown): { order: CsvOrderRef; lease: Lease; doc: Doc } => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'order must be a Grid order reference', 'order')
    const csv = csvRef(value.csv), id = csvRequestNumber(value.id, 'order.id', 0, 0xffff_ffff)
    const lease = csvLease(csv), doc = csvForRef(csv)
    const config = csvRevisions.get(csv.doc)!
    if ((config.order ?? 0) !== id || (config.orderView !== undefined && config.orderView !== lease.ref.id))
      throw new Refusal('Stale', 'the Grid sort order or view was replaced')
    config.orderView = lease.ref.id
    return { order: { csv, id }, lease, doc }
  }
  const closeCsvFind = (lease: Lease): void => {
    const found = lease.csvFind
    if (!found) return
    lease.csvFind = undefined
    cancelFindReads(lease, found.id, 'csv')
    const doc = docs.get(lease.ref.doc)
    if (doc?.generation === lease.ref.gen) doc.csvFindClose(lease.ref.gen, found.order.csv.revision, found.id)
  }
  const closeCsvInteractions = (lease: Lease): void => {
    closeCsvFind(lease)
    const doc = docs.get(lease.ref.doc), config = csvRevisions.get(lease.ref.doc)
    if (doc?.generation === lease.ref.gen && config?.generation === lease.ref.gen
      && (config.orderView === lease.ref.id || config.sortView === lease.ref.id)) {
      doc.csvOrderClose(lease.ref.gen, config.revision, config.order ?? 0)
      config.order = undefined; config.orderView = undefined; config.sort = undefined; config.sortView = undefined; config.interactionId = undefined
      cancelCsvReads(lease.ref.doc)
    }
  }
  const closeDocumentCsvInteractions = (id: number): void => {
    for (const surface of surfaces.values()) for (const lease of surface.views.values()) if (lease.ref.doc === id) closeCsvInteractions(lease)
  }
  const gridRead = <T>(req: number, order: CsvOrderRef, lease: Lease, start: (cancel: Cancel) => Promise<T>): Promise<T> =>
    csvRead(req, order.csv.doc, order.csv.gen, order.csv.revision, async (cancel) => {
      const value = await start(cancel)
      if (orderRef(order).lease !== lease) throw new Refusal('Stale', 'the Grid view was replaced while reading')
      return value
    })
  const csvSearchRef = (value: unknown): { ref: CsvFindRef; lease: Lease; doc: Doc } => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'ref must be a Grid Find reference', 'ref')
    const { order, lease, doc } = orderRef(value.order)
    const explicit = findLease(value.view), id = csvRequestNumber(value.id, 'ref.id', 1, 0xffff_ffff)
    if (explicit !== lease || lease.csvFind?.id !== id || lease.csvFind.order.id !== order.id)
      throw new Refusal('Stale', 'the Grid Find query or view was replaced')
    return { ref: { view: lease.ref, order, id }, lease, doc }
  }
  const csvFindRead = <T>(req: number, ref: CsvFindRef, lease: Lease, op: 'scan' | 'seek', start: (cancel: Cancel) => Promise<T>): Promise<T> =>
    gridRead(req, ref.order, lease, async (cancel) => {
      beginFindRead(req, lease, ref.id, 'csv', op)
      const value = await start(cancel)
      if (csvSearchRef(ref).lease !== lease) throw new Refusal('Stale', 'the Grid Find query was replaced while reading')
      return value
    })
  const detach = (surface: SurfaceState, lease: Lease): void => {
    closeSourceFind(lease)
    closeCsvInteractions(lease)
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
    closeDocumentFind(id)
    invalidateCsv(id)
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
  const read = async <T>(id: number, doc: number, start: (cancel: Cancel) => Promise<T>, retainOnLeave = false, csv = false, csvConfig = false): Promise<T> => {
    if (reads.has(id)) throw new Refusal('InvalidParams', 'request id is already pending', 'id')
    const source = getDoc(doc)
    const gen = source.generation
    const entry: ReadEntry = { doc, cancel: addon.cancelFlag(), retainOnLeave, cancelled: false, surface: docOwners.get(doc), ...(csv ? { csv: true as const } : {}), ...(csvConfig ? { csvConfig: true as const } : {}) }
    reads.set(id, entry)
    try {
      return await start(entry.cancel)
    } catch (e) {
      if (codeOf(e) === 'Frozen' && docs.get(doc) === source && source.generation === gen) {
        closeDocumentFind(doc)
        closeDocumentCsvInteractions(doc)
        cancelReads(doc)
      }
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
    const format = doc.format as Opened['format'] // the native document classifies markdown, CSV/TSV and text
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
        if (e.error !== undefined && jobs.get(id) === cancel && docs.get(id) === doc && doc.generation === gen) {
          closeDocumentFind(id)
          closeDocumentCsvInteractions(id)
          cancelReads(id)
        }
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
    structuredBuild: (p, req) => {
      const lease = findLease(p.view), doc = getDoc(lease.ref.doc)
      return read(req, lease.ref.doc, async (cancel) => {
        const native = await doc.structuredBuild(lease.ref.gen, cancel)
        if (findLease(lease.ref) !== lease) throw new Refusal('Stale', 'the structured view was replaced while indexing')
        const info = structuredInfo(native, { session, doc: lease.ref.doc, gen: lease.ref.gen }, doc.size)
        lease.structured = info.ref
        return info
      })
    },
    structuredChildren: (p, req) => {
      const { ref, lease, doc } = structuredReference(p.ref)
      const container = csvRequestNumber(p.container, 'container', 0, 0xffff_ffff)
      const start = csvRequestNumber(p.start, 'start')
      const count = csvRequestNumber(p.count, 'count', 1, 128)
      const record = p.record === undefined ? undefined : csvRequestNumber(p.record, 'record')
      return read(req, ref.doc, async (cancel) => {
        const page = await doc.structuredChildren(ref.gen, ref.revision, container, start, count, cancel, record)
        if (structuredReference(ref).lease !== lease) throw new Refusal('Stale', 'the structured index was replaced while reading')
        return structuredChildren(page, doc.size)
      })
    },
    structuredRows: (p, req) => {
      const { ref, lease, doc } = structuredReference(p.ref)
      const start = csvRequestNumber(p.start, 'start')
      const count = csvRequestNumber(p.count, 'count', 1, 128)
      return read(req, ref.doc, async (cancel) => {
        const page = await doc.structuredRows(ref.gen, ref.revision, start, count, cancel)
        if (structuredReference(ref).lease !== lease) throw new Refusal('Stale', 'the structured view was replaced while reading records')
        return structuredRows(page, doc.size)
      })
    },
    structuredColumns: (p, req) => {
      const { ref, lease, doc } = structuredReference(p.ref)
      const start = csvRequestNumber(p.start, 'start')
      const count = csvRequestNumber(p.count, 'count', 1, 128)
      return read(req, ref.doc, async (cancel) => {
        const page = await doc.structuredColumns(ref.gen, ref.revision, start, count, cancel)
        if (structuredReference(ref).lease !== lease) throw new Refusal('Stale', 'the structured view was replaced while reading columns')
        return structuredColumns(page, doc.size)
      })
    },
    sourceBytes: (p,req):Promise<Uint8Array> => {
      const lease = findLease(p.view), doc = getDoc(lease.ref.doc)
      const start = csvRequestNumber(p.start, 'start', 0, doc.size)
      const count = csvRequestNumber(p.count, 'count', 1, 65_536)
      if (count > doc.size - start) throw new Refusal('InvalidParams', 'sourceBytes range is outside the document')
      return read(req, lease.ref.doc, async (cancel) => {
        const bytes = await doc.sourceBytes(lease.ref.gen, start, count, cancel)
        if (findLease(lease.ref) !== lease) throw new Refusal('Stale', 'the source view was replaced while reading')
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== count) throw new Refusal('Internal', 'the core returned invalid source bytes')
        return bytes
      })
    },
    sourceLineRange: (p, req): Promise<{ start: number; end: number }> => {
      const lease = findLease(p.view), doc = getDoc(lease.ref.doc)
      const startLine = csvRequestNumber(p.startLine, 'startLine')
      const count = csvRequestNumber(p.count, 'count', 1)
      return read(req, lease.ref.doc, async (cancel) => {
        const span = await doc.sourceLineRange(lease.ref.gen, startLine, count, cancel)
        if (findLease(lease.ref) !== lease) throw new Refusal('Stale', 'the source view was replaced while reading')
        const start = csvResultNumber(span.start, 'source start', 0, doc.size)
        const end = csvResultNumber(span.end, 'source end', start, doc.size)
        return { start, end }
      })
    },
    sourceVerify: (p, req): Promise<boolean> => {
      const lease = findLease(p.view), doc = getDoc(lease.ref.doc)
      const start = csvRequestNumber(p.start, 'start', 0, doc.size)
      const end = csvRequestNumber(p.end, 'end', start, doc.size)
      return read(req, lease.ref.doc, async (cancel) => {
        const result = await doc.sourceVerify(lease.ref.gen, start, end, cancel)
        if (findLease(lease.ref) !== lease) throw new Refusal('Stale', 'the source view was replaced while verifying')
        if (result !== true) throw new Refusal('Internal', 'the core did not verify the source range')
        return true
      })
    },
    sourceLineAt: (p, req): Promise<{ line: number }> => {
      const lease = findLease(p.view), doc = getDoc(lease.ref.doc)
      const offset = csvRequestNumber(p.offset, 'offset', 0, doc.size)
      return read(req, lease.ref.doc, async (cancel) => {
        const location = await doc.sourceLineAt(lease.ref.gen, offset, cancel)
        if (findLease(lease.ref) !== lease) throw new Refusal('Stale', 'the source view was replaced while locating')
        return { line: csvResultNumber(location.line, 'source line') }
      })
    },
    sourceFindStart: (p): SourceFindInfo => {
      const query = findQuery(p), lease = findLease(p.view)
      const doc = getDoc(lease.ref.doc)
      const native = doc.sourceFindStart(lease.ref.gen, query, p.matchCase as boolean)
      const id = findNumber(native.id, 0xffff_ffff)
      if (id === 0) throw new Refusal('Internal', 'the core returned an invalid Find identity')
      try {
        const progress = findProgress(native, doc.size)
        closeDocumentFind(lease.ref.doc)
        lease.sourceFind = id
        return { ref: { view: lease.ref, id }, ...progress }
      } catch (e) { doc.sourceFindClose(lease.ref.gen, id); throw e }
    },
    sourceFindScan: (p, req): Promise<SourceFindPage> => {
      const { ref, lease, doc } = sourceFindRef(p.ref)
      return sourceFindRead(req, ref, lease, 'scan', async (cancel) => {
        const value = await doc.sourceFindScan(ref.view.gen, ref.id, cancel)
        return { ref, ...findProgress(value, doc.size), hits: sourceHits(value.hits, doc.size) }
      })
    },
    sourceFindSeek: (p, req): Promise<SourceFindSeek> => {
      const previous = findDirection(p)
      const { ref, lease, doc } = sourceFindRef(p.ref)
      const from = p.from === undefined ? undefined : csvRequestNumber(p.from, 'from', 0, doc.size)
      return sourceFindRead(req, ref, lease, 'seek', async (cancel) => {
        const value = await doc.sourceFindSeek(ref.view.gen, ref.id, from, previous, cancel)
        if (typeof value.wrapped !== 'boolean') throw new Refusal('Internal', 'the core returned invalid Find wrap state')
        const hit = value.hit == null ? undefined : sourceHit(value.hit, doc.size)
        const ordinal = value.ordinal == null ? undefined : findNumber(value.ordinal)
        if ((hit === undefined) !== (ordinal === undefined)) throw new Refusal('Internal', 'the core returned invalid Find position')
        return { ...(hit ? { hit, ordinal } : {}), wrapped: value.wrapped }
      })
    },
    sourceFindClose: (p): boolean => {
      const { lease } = sourceFindRef(p.ref)
      closeSourceFind(lease)
      return true
    },
    csvSort: (p, req): Promise<CsvOrderInfo> => {
      const ref = csvRef(p.ref), lease = findLease(p.view)
      if (csvLease(ref) !== lease) throw new Refusal('Stale', 'the sort view does not own this Grid')
      const interactionId = csvInteractionId(p.interactionId)
      const column = csvRequestNumber(p.column, 'column')
      if (!['asc', 'desc', 'none'].includes(p.direction as string)) throw new Refusal('InvalidParams', 'direction must be asc, desc or none', 'direction')
      const config = csvRevisions.get(ref.doc)!, doc = csvForRef(ref)
      if (!Number.isSafeInteger(nextSort)) throw new Refusal('Refused', 'sort intents are exhausted')
      const intent = nextSort++
      config.sort = intent; config.sortView = lease.ref.id; config.interactionId = interactionId
      for (const entry of reads.values()) if (entry.doc === ref.doc && entry.csvSort) { entry.cancelled = true; entry.cancel.cancel() }
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        reads.get(req)!.csvSort = true
        const value = await doc.csvSort(ref.gen, ref.revision, column, p.direction as string, cancel)
        if (csvLease(ref) !== lease || csvRevisions.get(ref.doc) !== config || config.sort !== intent)
          throw new Refusal('Stale', 'the sort request was replaced')
        const id = csvResultNumber(value.id, 'order identity', 1, 0xffff_ffff)
        if (value.column !== column || value.direction !== p.direction) throw new Refusal('Internal', 'the core returned the wrong Grid order')
        const rows = csvResultNumber(value.rows, 'order rows')
        closeCsvFind(lease)
        cancelCsvReads(ref.doc, req)
        config.order = id
        config.orderView = lease.ref.id
        return { order: { csv: ref, id }, rows, column, direction: value.direction as CsvOrderInfo['direction'] }
      })
    },
    csvOrderClose: (p): boolean => {
      if (!isRecord(p.order)) throw new Refusal('InvalidParams', 'order must be a Grid order reference', 'order')
      const ref = csvRef(p.order.csv), interactionId = csvInteractionId(p.interactionId)
      csvRequestNumber(p.order.id, 'order.id', 0, 0xffff_ffff)
      const explicit = findLease(p.view), lease = csvLease(ref)
      if (explicit !== lease) throw new Refusal('Stale', 'the closing view does not own this Grid')
      const config = csvRevisions.get(ref.doc)!
      // A sort may have committed before its reply reached this instance. Its owner may close the host's
      // authoritative native id; an older instance must not cancel a newer instance's pending sort.
      if (config.interactionId !== interactionId || config.orderView !== undefined && config.orderView !== lease.ref.id) return false
      if (config.orderView !== lease.ref.id && config.sortView !== lease.ref.id) return false
      closeCsvInteractions(lease)
      return true
    },
    csvOrderedPage: (p, req): Promise<CsvPage> => {
      const { order, lease, doc } = orderRef(p.order)
      const rowStart = csvRequestNumber(p.rowStart, 'rowStart'), rowCount = csvRequestNumber(p.rowCount, 'rowCount', 1, 128)
      const columnStart = csvRequestNumber(p.columnStart, 'columnStart'), columnCount = csvRequestNumber(p.columnCount, 'columnCount', 1, 128)
      if (!Number.isSafeInteger(rowStart + rowCount) || !Number.isSafeInteger(columnStart + columnCount))
        throw new Refusal('InvalidParams', 'the Grid rectangle exceeds the safe integer range')
      return gridRead(req, order, lease, async (cancel) => stampCsvPage(await doc.csvOrderedPage(order.csv.gen, order.csv.revision,
        order.id, rowStart, rowCount, columnStart, columnCount, cancel), order.csv, rowStart, rowCount, columnStart, columnCount))
    },
    csvOrderLocate: (p, req): Promise<{ dataRow: number }> => {
      const { order, lease, doc } = orderRef(p.order), sourceRecord = csvRequestNumber(p.sourceRecord, 'sourceRecord')
      return gridRead(req, order, lease, async (cancel) => ({ dataRow: csvResultNumber((await doc.csvOrderLocate(order.csv.gen,
        order.csv.revision, order.id, sourceRecord, cancel)).dataRow, 'data row') }))
    },
    csvCell: (p, req): Promise<CsvCell> => {
      const ref = csvRef(p.ref), lease = csvLease(ref), doc = csvForRef(ref)
      const sourceRecord = csvRequestNumber(p.sourceRecord, 'sourceRecord'), column = csvRequestNumber(p.column, 'column')
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        const cell = await doc.csvCell(ref.gen, ref.revision, sourceRecord, column, cancel)
        if (csvLease(ref) !== lease) throw new Refusal('Stale', 'the Grid view was replaced while reading')
        if (cell.column !== column) throw new Refusal('Internal', 'the core returned the wrong Grid cell')
        if (cell.value == null) return { kind: 'missing', column }
        const piece = stampCsvPiece(cell.value, ref)
        // Native CSV reads 4096 bytes plus up to four bytes of decoder lookahead; ASCII can return 4100 units.
        if (piece.sourceRecord !== sourceRecord || piece.column !== column || typeof piece.text !== 'string' || piece.text.length > 4096 + 4
          || !isRecord(piece.map) || !(piece.map.points instanceof Uint32Array) || piece.map.points.length > 16 << 10
          || piece.map.start !== piece.pieceSpan.start || piece.map.end !== piece.pieceSpan.end || piece.map.units !== piece.text.length)
          throw new Refusal('Internal', 'the core returned an invalid Grid cell')
        return piece
      })
    },
    csvFindStart: (p): CsvFindInfo => {
      const query = findQuery(p), explicit = findLease(p.view)
      const { order, lease, doc } = orderRef(p.order)
      if (lease !== explicit) throw new Refusal('Stale', 'the Find view does not own this Grid')
      const value = doc.csvFindStart(order.csv.gen, order.csv.revision, order.id, query, p.matchCase as boolean)
      const id = csvResultNumber(value.id, 'Find identity', 1, 0xffff_ffff)
      try {
        const progress = findProgress(value, doc.size)
        closeCsvFind(lease)
        lease.csvFind = { id, order }
        return { ref: { view: lease.ref, order, id }, ...progress }
      } catch (e) { doc.csvFindClose(order.csv.gen, order.csv.revision, id); throw e }
    },
    csvFindScan: (p, req): Promise<CsvFindPage> => {
      const { ref, lease, doc } = csvSearchRef(p.ref)
      return csvFindRead(req, ref, lease, 'scan', async (cancel) => {
        const value = await doc.csvFindScan(ref.view.gen, ref.order.csv.revision, ref.id, cancel)
        return { ref, ...findProgress(value, doc.size), hits: csvFindHits(value.hits, doc.size) }
      })
    },
    csvFindSeek: (p, req): Promise<CsvFindSeek> => {
      const previous = findDirection(p), { ref, lease, doc } = csvSearchRef(p.ref)
      let from: CsvFindHit | undefined
      if (p.from !== undefined) {
        if (!isRecord(p.from)) throw new Refusal('InvalidParams', 'from must be a Grid Find hit', 'from')
        from = { dataRow: csvRequestNumber(p.from.dataRow, 'from.dataRow'), sourceRecord: csvRequestNumber(p.from.sourceRecord, 'from.sourceRecord'),
          column: csvRequestNumber(p.from.column, 'from.column'), start: csvRequestNumber(p.from.start, 'from.start', 0, doc.size),
          end: csvRequestNumber(p.from.end, 'from.end', 0, doc.size) }
        if (from.end <= from.start) throw new Refusal('InvalidParams', 'from must have a positive source span', 'from.end')
      }
      return csvFindRead(req, ref, lease, 'seek', async (cancel) => {
        const value = await doc.csvFindSeek(ref.view.gen, ref.order.csv.revision, ref.id, from, previous, cancel)
        if (typeof value.wrapped !== 'boolean') throw new Refusal('Internal', 'the core returned invalid Grid Find wrap state')
        const hit = value.hit == null ? undefined : csvFindHit(value.hit, doc.size)
        const ordinal = value.ordinal == null ? undefined : findNumber(value.ordinal)
        if ((hit === undefined) !== (ordinal === undefined)) throw new Refusal('Internal', 'the core returned invalid Grid Find position')
        return { ...(hit ? { hit, ordinal } : {}), wrapped: value.wrapped }
      })
    },
    csvFindClose: (p): boolean => {
      const { lease } = csvSearchRef(p.ref)
      closeCsvFind(lease)
      return true
    },
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
        const identity = (native as NativeFolderRoot & { readonly identity?: string }).identity
        if (identity !== undefined && (typeof identity !== 'string' || !/^[0-9a-f]{16}-[0-9a-f]{32}$/.test(identity)))
          throw new Refusal('Internal', 'the core returned an invalid folder identity')
        rootPeak = peak
        roots.set(id, { native, path })
        return { ref: { session, root: id, node: '0' }, label, path, ...(identity ? { identity } : {}) }
      } catch (e) {
        native?.close()
        rootHostBytes = previous
        account()
        throw e
      }
    },
    preferences: (p): boolean => {
      if (p.encodingFallback !== 'windows-1252' && p.encodingFallback !== 'utf-8') throw new Refusal('InvalidParams', 'invalid encoding fallback')
      const configure = addon.setEncodingFallback
      if (!configure) throw new Refusal('Unsupported', 'encoding preferences are unavailable in this core')
      configure(p.encodingFallback === 'utf-8')
      return true
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
    csvConfigure: (p, req): Promise<CsvInfo> => {
      const [id, gen] = [int(p, 'doc'), int(p, 'gen')]
      const options = csvOption(p.options)
      const surface = requestSurface(p)
      const doc = ownedDoc(surface, id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the CSV document generation was replaced')
      if (!csvFormat(doc)) throw new Refusal('Unsupported', 'Grid is available for .csv and .tsv files')
      cancelCsvConfigurations(id)
      const configuration = nextCsvConfig(id)
      return read(req, id, async (cancel) => {
        const native = await doc.csvConfigure(gen, options.delimiter, options.header, cancel)
        currentCsvRead(req, doc, id, gen, undefined, configuration)
        const info = stampCsvInfo(native, id, gen)
        const previous = csvRevisions.get(id)
        if (!previous || previous.generation !== gen || previous.revision !== info.ref.revision) {
          for (const owner of surfaces.values()) for (const lease of owner.views.values()) if (lease.ref.doc === id) closeCsvFind(lease)
          cancelCsvReads(id, req)
          csvRevisions.set(id, { generation: gen, revision: info.ref.revision })
        }
        return info
      }, false, true, true)
    },
    csvPage: (p, req): Promise<CsvPage> => {
      const ref = csvRef(p.ref)
      const rowStart = csvRequestNumber(p.rowStart, 'rowStart')
      const rowCount = csvRequestNumber(p.rowCount, 'rowCount', 1, 128)
      const columnStart = csvRequestNumber(p.columnStart, 'columnStart')
      const columnCount = csvRequestNumber(p.columnCount, 'columnCount', 1, 128)
      if (!Number.isSafeInteger(rowStart + rowCount) || !Number.isSafeInteger(columnStart + columnCount))
        throw new Refusal('InvalidParams', 'the requested CSV rectangle exceeds the safe integer range', 'rowStart')
      const doc = csvForRef(ref)
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        const page = await doc.csvPage(ref.gen, ref.revision, rowStart, rowCount, columnStart, columnCount, cancel)
        return stampCsvPage(page, ref, rowStart, rowCount, columnStart, columnCount)
      })
    },
    csvPiece: (p, req): Promise<CsvCellPiece> => {
      if (!isRecord(p.continuation)) throw new Refusal('InvalidParams', 'continuation must be a CSV piece token', 'continuation')
      const ref = csvRef(p.continuation.ref)
      const sourceRecord = csvRequestNumber(p.continuation.sourceRecord, 'continuation.sourceRecord')
      const column = csvRequestNumber(p.continuation.column, 'continuation.column')
      const offset = csvRequestNumber(p.continuation.offset, 'continuation.offset')
      const doc = csvForRef(ref)
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        const native = await doc.csvPiece(ref.gen, ref.revision, sourceRecord, column, offset, cancel)
        const piece = stampCsvPiece(native, ref)
        if (piece.sourceRecord !== sourceRecord || piece.column !== column || piece.pieceSpan.start !== offset)
          throw new Refusal('Internal', 'the core returned a CSV piece for the wrong continuation')
        return piece
      })
    },
    csvColumns: (p, req): Promise<CsvColumnPage> => {
      const ref = csvRef(p.ref)
      const start = csvRequestNumber(p.start, 'start')
      const count = csvRequestNumber(p.count, 'count', 1, 128)
      if (!Number.isSafeInteger(start + count)) throw new Refusal('InvalidParams', 'the requested CSV column page exceeds the safe integer range', 'start')
      const doc = csvForRef(ref)
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        const result = await doc.csvColumns(ref.gen, ref.revision, start, count, cancel)
        if (!Array.isArray(result.columns) || result.columns.length > count || typeof result.metadataDone !== 'boolean')
          throw new Refusal('Internal', 'the core returned an invalid CSV column page')
        const columns: CsvColumn[] = result.columns.map((column) => {
          const type = column.type
          if (!['text', 'number', 'date', 'boolean', 'url'].includes(type) || typeof column.name !== 'string'
            || typeof column.nameMore !== 'boolean' || (column.pills != null && (!Array.isArray(column.pills) || column.pills.some((pill) => typeof pill !== 'string'))))
            throw new Refusal('Internal', 'the core returned invalid CSV column metadata')
          const index = csvResultNumber(column.column, 'column')
          if (index < start || index >= start + count) throw new Refusal('Internal', 'the core returned a CSV column outside the requested page')
          return { column: index, name: column.name, nameMore: column.nameMore, type: type as CsvColumn['type'],
            widthUnits: csvResultNumber(column.widthUnits, 'column width'), ...(column.pills == null ? {} : { pills: column.pills }) }
        })
        const nextColumn = result.nextColumn == null ? undefined : csvResultNumber(result.nextColumn, 'next column')
        return { ref, columns, metadataDone: result.metadataDone, ...(nextColumn === undefined ? {} : { nextColumn }) }
      })
    },
    csvLocate: (p, req): Promise<CsvLocated> => {
      const ref = csvRef(p.ref)
      const hasLine = Object.hasOwn(p, 'rawLine')
      const hasOffset = Object.hasOwn(p, 'sourceOffset')
      if (hasLine === hasOffset) throw new Refusal('InvalidParams', 'supply exactly one of rawLine or sourceOffset', 'rawLine')
      const rawLine = hasLine ? csvRequestNumber(p.rawLine, 'rawLine') : undefined
      const sourceOffset = hasOffset ? csvRequestNumber(p.sourceOffset, 'sourceOffset') : undefined
      const doc = csvForRef(ref)
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        const result = await doc.csvLocate(ref.gen, ref.revision, rawLine, sourceOffset, cancel)
        if (result.kind === 'pending') return { kind: 'pending' }
        if (result.kind !== 'located') throw new Refusal('Internal', 'the core returned an invalid CSV location')
        return { kind: 'located', dataRow: csvResultNumber(result.dataRow, 'data row'),
          sourceRecord: csvResultNumber(result.sourceRecord, 'source record'), sourceLine: csvResultNumber(result.sourceLine, 'source line'),
          span: nativeCsvSpan(result.span), ...(result.column == null ? {} : { column: csvResultNumber(result.column, 'column') }) }
      })
    },
    csvSource: (p, req): Promise<CsvSource> => {
      const ref = csvRef(p.ref)
      const sourceRecord = csvRequestNumber(p.sourceRecord, 'sourceRecord')
      const column = p.column === undefined ? undefined : csvRequestNumber(p.column, 'column')
      const doc = csvForRef(ref)
      return csvRead(req, ref.doc, ref.gen, ref.revision, async (cancel) => {
        const result = await doc.csvSource(ref.gen, ref.revision, sourceRecord, column, cancel)
        if (result.kind === 'pending') return { kind: 'pending' }
        if (result.kind !== 'located') throw new Refusal('Internal', 'the core returned an invalid CSV source location')
        return { kind: 'located', span: nativeCsvSpan(result.span), rawLine: csvResultNumber(result.rawLine, 'raw line') }
      })
    },
    networkPath: (p): boolean => {
      if (typeof p.path !== 'string' || p.path.length === 0 || p.path.length > 32_767 || p.path.includes('\0'))
        throw new Refusal('InvalidParams', 'path must be a non-empty string of at most 32,767 characters, without NUL', 'path')
      // Without the native test, only the UNC form is known to be a share.
      return addon.networkPath ? addon.networkPath(p.path) : /^[\\/]{2}/.test(p.path)
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
      if (p.activationId !== undefined && (typeof p.activationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.activationId)))
        throw new Refusal('InvalidParams', 'activationId must be a canonical UUID v4', 'activationId')
      const surface = requestSurface(p)
      const doc = ownedDoc(surface, id)
      if (doc.generation !== gen) throw new Refusal('Stale', 'the tab generation was replaced')
      reclaimInactive()
      const pending = take(req, bytes, surface)
      pending.doc = id; pending.gen = gen; pending.kind = 'activate'; if (typeof p.activationId === 'string') pending.activationId = p.activationId
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
    deactivateActivation: (p): boolean => {
      if (typeof p.activationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.activationId))
        throw new Refusal('InvalidParams', 'activationId must be a canonical UUID v4', 'activationId')
      const surface = surfaceRef(p.surface)
      const lease = currentLease(surface)
      if (lease?.activationId === p.activationId) { detach(surface, lease); return true }
      const pending = surface.latest
      if (pending?.kind !== 'activate' || pending.activationId !== p.activationId) return false
      pending.disposed = true
      const entry = reads.get(pending.request)
      if (entry) { entry.cancelled = true; entry.cancel.cancel() }
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
        try {
          // A link never launches a program or script (Z79): the page shows where it is instead.
          if (isExecutable(target)) return { kind: 'executable', target, path: doc.linkPath(gen, target, p.href) }
          return { kind: 'local', target, path: doc.localPath(gen, target) }
        }
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
        closeDocumentFind(id)
        if (root) doc.reloadInFolder(root.native)
        else doc.reload()
        const gen = doc.generation
        invalidateCsv(id)
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

  /**
   * Z79's hand-off, asked by main and never by the page's port: the path of an entry a sidebar root lists, a document
   * this session holds, or a program or script one of its Markdown links names (`href`, which the native build must
   * hold as a link). Anything else is a Refusal.
   */
  const handoffPath = (value: unknown): string => {
    if (!isRecord(value)) throw new Refusal('InvalidParams', 'a hand-off names a held document, folder entry or link')
    if (value.entry !== undefined) {
      const ref = folderRef(value.entry, 'entry')
      return rootFor(ref).native.entryPath(Number(ref.node))
    }
    if (int(value, 'session') !== session) throw new Refusal('Stale', 'the document belongs to another core session')
    const [id, gen] = [int(value, 'doc'), int(value, 'gen')]
    const doc = getDoc(id)
    if (doc.generation !== gen) throw new Refusal('Stale', `generation ${gen} was replaced`)
    if (value.href === undefined) return doc.path
    // Only the executable sheet asks for a link's path; every other link target opens through openLocal.
    const target = boundedLink(value.href) ? localTarget(value.href, !!doc.folder) : null
    if (target === null || !isExecutable(target))
      throw new Refusal('InvalidParams', 'href must be a link to a program or script', 'href')
    return doc.linkPath(gen, target, value.href as string)
  }

  return Object.assign(async (data: unknown): Promise<Response> => {
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
  }, { handoffPath })
}
