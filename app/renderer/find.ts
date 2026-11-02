/** One active lens owns one query; results never escape their surface/generation. */
export interface FindQuery { text: string; matchCase: boolean }
export interface FindState {
  count: number
  complete: boolean
  /** One-based match ordinal, or null before a match is selected. */
  current: number | null
  busy: boolean
  message?: string
}
export interface FindController {
  subscribe(listener: () => void): () => void
  snapshot(): FindState
  search(query: FindQuery): void
  next(direction: 1 | -1): void
  /** Abort and clear the query/highlight. The controller remains reusable. */
  close(): void
}
export const EMPTY_FIND: FindState = { count: 0, complete: true, current: null, busy: false }
export class FindSignal {
  private state: FindState = EMPTY_FIND
  private readonly listeners = new Set<() => void>()
  readonly snapshot = (): FindState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(state: FindState): void { this.state = state; for (const listener of this.listeners) listener() }
}
export function findStatus(query: string, state: FindState): string {
  if (!query) return 'Enter text to find'
  if (state.message) return state.message
  const count = state.complete ? String(state.count) : `>= ${state.count}…`
  if (!state.count) return state.complete ? 'No matches' : 'Searching…'
  return state.current === null ? count : `${state.current} of ${count}`
}

/** Locale-independent scalar lowercase matches the native scanner, including expanding lowercase scalars. */
export function foldFind(text: string): string {
  let folded = ''
  for (const scalar of text) folded += scalar.toLowerCase()
  return folded
}

/** Non-overlapping literal matches, snapped to original scalar boundaries after case folding. */
export function* literalMatches(text: string, query: FindQuery): Generator<{ start: number; end: number }> {
  if (!query.text) return
  const needle = query.matchCase ? query.text : foldFind(query.text)
  let haystack = text
  let starts: Uint32Array | undefined, ends: Uint32Array | undefined
  if (!query.matchCase) {
    haystack = ''
    starts = new Uint32Array(2 * text.length)
    ends = new Uint32Array(2 * text.length)
    let source = 0, target = 0
    for (const scalar of text) {
      const folded = scalar.toLowerCase()
      haystack += folded
      for (let i = 0; i < folded.length; i++) { starts[target] = source; ends[target++] = source + scalar.length }
      source += scalar.length
    }
  }
  let from = 0, previousEnd = -1
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return
    const start = starts ? starts[index] : index
    const end = ends ? ends[index + needle.length - 1] : index + needle.length
    // Two folded matches inside one expanding scalar address the same original character once.
    if (start >= previousEnd) { yield { start, end }; previousEnd = end }
    from = index + needle.length
  }
}
