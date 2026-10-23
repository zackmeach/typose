// Protocol v1 between the renderer and the core host (spec §3.4). The data types (`Page`, `PageItem`, `WireMap`,
// `Limits`) are defined in Rust and exported by napi-rs's typegen as `typose-node`'s index.d.ts, so both sides
// typecheck against the core's own definitions. This file adds the envelope around them.
import type { Limits, Page } from 'typose-node'

export type { Limits, Page, PageItem, WireMap } from 'typose-node'

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
  firstPage: Page
}

export interface Methods {
  hello: { params: { protocol: number }; result: Hello }
  open: { params: { path: string; count: number }; result: Opened }
  page: { params: { doc: number; lens: 'raw'; start: number; count: number }; result: Page }
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

/** The page's whole API into main, from the preload. Neither call takes arguments. */
export interface TyposeApi {
  /** The file named on the command line, if any. */
  launchPath(): Promise<string | null>
  /** The OS Open dialog; null when cancelled. */
  openDialog(): Promise<string | null>
}

// PLANT (plan PR 2 acceptance; reverted): a type error, which `npm run check` must fail on.
export const plantedTypeError: number = 'not a number'
