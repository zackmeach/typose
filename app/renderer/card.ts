import type { ErrorCode, Opened } from '../shared/protocol'

/** The card's state: brief §7.9's file states, plus what M1 needs around them. */
export type Card =
  | { kind: 'connecting' }
  | { kind: 'empty' }
  /** `slow`: no first screen after 300 ms (brief §7.9's slow open). */
  | { kind: 'opening'; path: string; slow: boolean }
  /** `frozen`: why the document stopped reading (spec §3.1); nothing new shows until Reload. */
  | { kind: 'open'; path: string; opened: Opened; lines: number; bytes: number; indexed: boolean; frozen?: string }
  | { kind: 'failed'; path: string; code: ErrorCode; message: string }
  | { kind: 'gone'; path?: string }

export type Action = 'Open file…' | 'Locate…' | 'Retry' | 'Close'

export interface CardView {
  /** The header's status text. */
  status: string
  /** The thin line under the header: indexing's share done (0–1), indeterminate while opening, or none. */
  progress: number | 'indeterminate' | null
  banner: string | null
  /** The Raw lens, or a message with its actions. */
  body: { raw: true } | { message: string; actions: Action[] }
}

export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const lines = (n: number, format: (n: number) => string) => `${format(n)} line${n === 1 ? '' : 's'}`

/** What the card shows in each state (brief §7.9, §8.2; the memory refusal is plan §7 proposal 1). */
export function view(card: Card): CardView {
  const plain = { status: '', progress: null, banner: null }
  const say = (message: string, ...actions: Action[]): CardView => ({ ...plain, body: { message, actions } })
  switch (card.kind) {
    case 'connecting':
      return say('')
    case 'empty':
      return say('', 'Open file…')
    case 'opening':
      // Nothing for the first 300 ms, so a fast open doesn't flash; then the line, and the file can be closed.
      return card.slow ? { status: 'Opening…', progress: 'indeterminate', banner: null, body: { message: '', actions: ['Close'] } } : say('')
    case 'open': {
      const { opened, frozen } = card
      const count = lines(card.lines, (n) => n.toLocaleString('en'))
      let status = `${count} · ${opened.encoding}`
      if (!card.indexed) status = frozen ? `Indexing stopped at ${count}` : `Indexing ${lines(card.lines, (n) => compact.format(n))}…`
      return {
        status,
        progress: card.indexed || frozen ? null : opened.size > 0 ? card.bytes / opened.size : 0,
        banner: frozen ? 'Changed on disk' : null, // followed by the Reload (Ctrl+R) button
        body: opened.blank ? { message: 'Empty file', actions: [] } : { raw: true }
      }
    }
    case 'failed':
      switch (card.code) {
        case 'Binary':
          return say('Binary file · not shown') // the hand-off (brief §4.6) is M4
        case 'NotFound':
          return say(`File not found at ${card.path}`, 'Locate…', 'Close')
        case 'PermissionDenied':
          return say(`Can't read ${card.path} · permission denied`, 'Retry', 'Close')
        case 'Memory':
          return say(`Can't open ${fileName(card.path)} · Typose's memory budget is full. Close a file, then Retry.`, 'Retry', 'Close')
        default:
          return say(`Can't open ${card.path} · ${card.message}`, 'Close')
      }
    case 'gone':
      return say("Typose's core stopped") // Reopen arrives with respawn (PR 5)
  }
}
