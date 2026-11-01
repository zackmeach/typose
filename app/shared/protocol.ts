// Protocol v1 between the renderer and the core host (spec §3.4). The data types (`PageItem`, `Continuation`,
// `WireMap`, `Limits`) are defined in Rust and exported by napi-rs's typegen as `typose-node`'s index.d.ts, so
// both sides typecheck against the core's own definitions. This file adds the envelope around them, and the
// session the core host stamps into continuation tokens.
import type { Continuation, Limits, MdBuild, MdPage, PageItem as CorePageItem } from 'typose-node'

export type { Limits, MdBuild, MdItem, MdPage, WireMap } from 'typose-node'

/** A continuation token (plan C3): the core issues it and checks it when it comes back; the renderer only echoes it. */
export interface Token extends Continuation {
  /** The core host's session and the token's document (plan C7), stamped on the way out. */
  session: number
  doc: number
}

/** A page item as it travels: the core's, with the session stamped into its token. */
export interface PageItem extends Omit<CorePageItem, 'next'> {
  next?: Token
}

export interface Page {
  items: PageItem[]
}

export const PROTOCOL = 1

/** Typed errors. `CoreGone` is the renderer's own: the core host died with the call pending (plan C7). */
export type ErrorCode =
  | 'InvalidParams'
  | 'UnknownMethod'
  | 'Unsupported'
  | 'NoDocument'
  | 'NotFound'
  | 'PermissionDenied'
  | 'Refused'
  | 'Binary'
  | 'Frozen'
  | 'Stale'
  | 'Io'
  | 'Internal'
  | 'CoreGone'
  /** The request was cancelled (plan C5): the renderer no longer wanted it. */
  | 'Cancelled'
  /** The memory budget refused it (plan C1): the ledger can't hold a document's floor and its open's temporaries.
   *  Nothing changed. */
  | 'Memory'

export interface CoreError {
  code: ErrorCode
  message: string
  /** The offending parameter, for `InvalidParams`. */
  field?: string
}

export interface Hello {
  protocol: number
  core: string
  /** Every core host spawn is a session (plan C7); ids, pages and events from another session are dropped. */
  session: number
  limits: Limits
}

export interface Opened {
  doc: number
  gen: number
  /** Spec §4.1, by the file's extension: `markdown` for `.md` and `.markdown`. */
  format: 'markdown' | 'text'
  size: number
  encoding: string
  /** Lines the index has found so far; `firstPage` doesn't wait for it (Z37). */
  lines: number
  indexed: boolean
  /** Brief §7.9's empty file: 0 bytes, or only whitespace. */
  blank: boolean
  firstPage: Page
  /** Plan C1: what the ledger holds for this lens's page cache. A disposed background Reload returns zero. */
  reserved: number
  /** Derived local navigation keeps its inherited capability for Reload and later links. */
  localOnly?: true
  path?: string
}

/** Session-only authority: display paths and caller flags can never reconstruct this ticket. */
export interface SavedTicket { session: number; id: string }
export type CapturedLocation = { kind: 'manual'; path: string } | { kind: 'derived'; ticket: SavedTicket }

export interface Methods {
  /** Decode a local image from this generation's held Markdown. Ref carries no path or URL. */
  prepareImage: { params: { doc: number; gen: number; src: string }; result: PreparedImage }
  /** A fixed aligned chunk of canonical PNG bytes, at most 256 KiB. No count. */
  imageChunk: { params: { doc: number; gen: number; ref: ImageRef; offset: number }; result: Uint8Array }
  /** Release native encoded bytes after assembly or abandonment. Repeated release is harmless. */
  releaseImage: { params: { doc: number; gen: number; ref: ImageRef }; result: boolean }
  hello: { params: { protocol: number }; result: Hello }
  /** `bytes`: the lens's viewport-only cache cap, reserved with the document's floor (plan C1); refused, `Memory`. */
  open: { params: { path: string; count: number; bytes: number }; result: Opened }
  /** First screen of a retained document, without reopening or restarting its index. One renderer lens is active. */
  activate: { params: { doc: number; gen: number; count: number; bytes: number }; result: Opened }
  /** Dispose a current view or Reload's exact old settled view, retaining the document/index. Pending activation cannot hand it back. */
  deactivate: { params: { doc: number; gen: number }; result: boolean }
  /** A window of lines of generation `gen`, or the one piece a continuation token names (plan C3). Rendered: a window of
   *  blocks of the generation's Markdown build (`render`). Cancellable. */
  page: {
    params:
      | { doc: number; lens: 'raw'; gen: number; start: number; count: number }
      | { doc: number; lens: 'raw'; continuation: Token }
      | { doc: number; lens: 'rendered'; gen: number; start: number; count: number }
    result: Page | MdPage
  }
  /** Plan (Rendered Markdown slice) §2.1: builds generation `gen` as Markdown blocks, up to 8 MiB of source, for rendered
   *  pages. `Refused` over 8 MiB, `Memory` when the budget can't hold it. Cancellable. */
  render: { params: { doc: number; gen: number }; result: MdBuild }
  /** This generation's held Markdown links: fragments, external URLs, or capability-checked local paths. */
  resolve: { params: { doc: number; gen: number; href: string }; result: LinkTarget }
  /** Open a decoded local target through the source document's inherited capability. Failure keeps its lens. */
  openLocal: { params: { doc: number; gen: number; target: string; count: number; bytes: number }; result: Opened }
  /** Capture only from an owned generation. Manual paths retain manual-open policy; derived locations retain routes. */
  captureLocation: { params: { doc: number; gen: number }; result: CapturedLocation }
  /** Non-consuming reopen through saved derived authority; never a manual display-path fallback. */
  openSaved: { params: { ticket: SavedTicket; count: number; bytes: number }; result: Opened }
  /** Releases route authority and cancels unpublished reopens; repeated/old-session cleanup is harmless. */
  releaseSaved: { params: { ticket: SavedTicket }; result: boolean }
  /** Ctrl+R (spec §3.1): the document's next generation, opened again, with its first page. `bytes` as for `open`. */
  reload: { params: { doc: number; count: number; bytes: number }; result: Opened }
  /** Plan C6: cancels the document's index and page reads, and releases it. */
  close: { params: { doc: number }; result: boolean }
  /** Plan C5: cancels request `id`'s page read. True if it was still running: it then rejects with `Cancelled`. */
  cancel: { params: { id: number }; result: boolean }
  /** Plan C1: sets the ledger's reservation for the page cache of the lens showing generation `gen` of `doc` to
   *  `bytes`. False when the ledger refuses the growth, which leaves the reservation as it was, and for a lens an open
   *  or Reload has replaced. */
  reserve: { params: { doc: number; gen: number; bytes: number }; result: boolean }
  /** Persistent tab UI and scalar metadata, separate from the active lens, in the same native reservation. */
  reserveWorkspace: { params: { bytes: number }; result: boolean }
  /** The test-hooks build only (plan m8): what's alive in the core host. Elsewhere it's `UnknownMethod`. */
  debugStats: { params: { gc?: boolean; resetHigh?: boolean; limit?: number }; result: DebugStats }
}

export type LinkTarget = { kind: 'heading'; line: number } | { kind: 'external'; url: string } | { kind: 'local'; target: string; path: string } | { kind: 'inert' }

/** The test-hooks build's debug stats (plan C5, C6): the core's live jobs, tasks and file handles, the longest a chunk
 *  read's delay actually waited since the delay was set (`delayMs`), the documents the core host holds, and how its
 *  cancels went: `cancels` found a read running, `cancelled` reads ended `Cancelled`, at most `cancelMs` after their
 *  cancel. Plan C1: the ledger, each open document's charges, and the core host's heap. */
export interface DebugStats {
  jobs: number
  tasks: number
  handles: number
  delayMs: number
  docs: number
  cancels: number
  cancelled: number
  cancelMs: number
  /** In bytes: the limit; what's charged now, the pool and the renderer cache included; the most it's been; and the
   *  pool's and the renderer cache's shares. */
  ledger: { limit: number; used: number; high: number; pool: number; rendererCache: number }
  /** Each open document's charges in bytes, itemized, by document id. */
  charges: Record<number, Charges>
  /** The core host's `process.memoryUsage()`, after a forced GC when the call asked for one (`{ gc: true }`). With
   *  `{ resetHigh: true }`, the ledger's high-water mark starts again from what's charged; `{ limit }` sets its limit. */
  heap: { rss: number; heapUsed: number; external: number; arrayBuffers: number }
  saved: { tickets: number; routeBytes: number; wrappers: number; wrapperBytes: number; hostBytes: number; peakEntries: number; candidates: number }
}

/** What one document holds charged (plan C1): its floor and what's grown since. */
export interface Charges {
  hashes: number
  checkpoints: number
  cache: number
  metadata: number
  total: number
  /** The ledger stopped its line checkpoints: only the byte-bound ones were added after that. */
  linesStopped: boolean
}

export type Method = keyof Methods

/** What a call resolves to: a page's shape follows its lens. */
export type Result<M extends Method, P> = M extends 'page' ? (P extends { lens: 'rendered' } ? MdPage : Page) : Methods[M]['result']

/** `id` is null when the request's own id was invalid. */
export type Response =
  | { id: number | null; session: number; result: unknown }
  | { id: number | null; session: number; error: CoreError }

export interface ProgressEvent {
  event: 'progress'
  session: number
  doc: number
  gen: number
  lines: number
  bytes: number
  done: boolean
  error?: string
}

/** What the preload forwards from main to the page, with `window.postMessage` to its own origin. */
export type MainMessage = { type: 'core-port'; session: number } | { type: 'core-gone'; session: number }

/** The page's whole API into main, from the preload. Main validates arguments and sender (C4); external links require the main frame. */
export interface TyposeApi {
  /** The file named on the command line, if any: the newest named before the page asked (spec §8.1). */
  launchPath(): Promise<string | null>
  /** Every file named at startup, consumed as one batch for serial tab creation. */
  launchPaths(): Promise<string[]>
  /** Called with each file named after that: by a second launch, or macOS's open-file. Returns the unsubscribe. */
  onOpenPath(cb: (path: string) => void): () => void
  /** The OS Open dialog; null when cancelled. */
  openDialog(): Promise<string | null>
  /** A user-activated external link. Main independently checks the app's main frame, size and allowed scheme. */
  openExternal(url: string): Promise<boolean>
  /** A startup mark at a wall-clock time (ms); main records it only under the TYPOSE_MARKS hook (plan C8). */
  mark(name: StartupMark, t: number): void
  /** Called once, when main has shown the window; main only tells the page under the TYPOSE_MARKS hook (plan C8). */
  onShown(cb: () => void): void
  /** Called with each command chosen in macOS's native menu, which the page runs as ☰ does (spec §9). Returns the
   *  unsubscribe. */
  onCommand(cb: (command: Command) => void): () => void
}

/** The menu's commands (brief §3.2's M1 subset): ☰ on Windows and Linux, the native menu on macOS. */
export type Command = 'open' | 'reload' | 'close-tab' | 'reopen-tab' | 'clear-closed' | 'exit'

/** The renderer's startup marks (plan C8, §5). */
export const STARTUP_MARKS = [
  'navigationStart',
  'bundleEvaluated',
  'firstFrame',
  'titlebarPainted',
  'titlebarPresented',
  'shownPresented',
  'openRequested',
  'rawUsable'
] as const
export type StartupMark = (typeof STARTUP_MARKS)[number]


/** Opaque resource identity, echoed without modification. */
export interface ImageRef { session: number; doc: number; gen: number; id: number }
export interface PreparedImage {
  ref: ImageRef
  width: number
  height: number
  encodedBytes: number
  pixelBytes: number
}
