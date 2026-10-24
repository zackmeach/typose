// Protocol v1 between the renderer and the core host (spec §3.4). The data types (`PageItem`, `Continuation`,
// `WireMap`, `Limits`) are defined in Rust and exported by napi-rs's typegen as `typose-node`'s index.d.ts, so
// both sides typecheck against the core's own definitions. This file adds the envelope around them, and the
// session the core host stamps into continuation tokens.
import type { Continuation, Limits, PageItem as CorePageItem } from 'typose-node'

export type { Limits, WireMap } from 'typose-node'

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
  /** The memory budget refused the open (plan C1; the ledger that sends it arrives in PR 6). */
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
  size: number
  encoding: string
  /** Lines the index has found so far; `firstPage` doesn't wait for it (Z37). */
  lines: number
  indexed: boolean
  /** Brief §7.9's empty file: 0 bytes, or only whitespace. */
  blank: boolean
  firstPage: Page
}

export interface Methods {
  hello: { params: { protocol: number }; result: Hello }
  open: { params: { path: string; count: number }; result: Opened }
  /** A window of lines of generation `gen`, or the one piece a continuation token names (plan C3). */
  page: {
    params: { doc: number; lens: 'raw'; gen: number; start: number; count: number } | { doc: number; lens: 'raw'; continuation: Token }
    result: Page
  }
  /** Ctrl+R (spec §3.1): the document's next generation, opened again, with its first page. */
  reload: { params: { doc: number; count: number }; result: Opened }
  close: { params: { doc: number }; result: boolean }
}

export type Method = keyof Methods

export interface Request<M extends Method = Method> {
  id: number
  method: M
  params: Methods[M]['params']
}

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

/** The page's whole API into main, from the preload. Only `mark` takes arguments, which main validates (plan C4). */
export interface TyposeApi {
  /** The file named on the command line, if any. */
  launchPath(): Promise<string | null>
  /** The OS Open dialog; null when cancelled. */
  openDialog(): Promise<string | null>
  /** A startup mark at a wall-clock time (ms); main records it only under the TYPOSE_MARKS hook (plan C8). */
  mark(name: StartupMark, t: number): void
  /** Called once, when main has shown the window; main only tells the page under the TYPOSE_MARKS hook (plan C8). */
  onShown(cb: () => void): void
}

/** The renderer's startup marks (plan C8, §5). */
export const STARTUP_MARKS = [
  'navigationStart',
  'bundleEvaluated',
  'titlebarPainted',
  'titlebarPresented',
  'shownPresented',
  'openRequested',
  'rawUsable'
] as const
export type StartupMark = (typeof STARTUP_MARKS)[number]
