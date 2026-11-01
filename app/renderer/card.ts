import type { CsvInfo, CsvOptions, ErrorCode, MdBuild, Opened, StructuredInfo } from '../shared/protocol'

export type LensName = 'raw' | 'rendered' | 'grid' | 'tree' | 'rows' | 'table' | 'transcript'

/** Why Rendered stays off, in the switch's tooltip (plan §2.2, Z71, Z34). */
export const RENDERED_OFF = {
  ceiling: 'Rendered shows files of up to 8 MB',
  memory: "Typose's memory budget is full"
} as const

export type RenderedOff = keyof typeof RENDERED_OFF

/** The card's state: brief §7.9's file states, plus what M1 needs around them. */
export type Card =
  | { kind: 'connecting' }
  | { kind: 'empty' }
  /** `slow`: no first screen after 300 ms (brief §7.9's slow open). `atLine`: where a Reopen will put the view. */
  | { kind: 'opening'; path: string; slow: boolean; atLine?: number }
  /** `frozen`: why the document stopped reading (spec §3.1); nothing new shows until Reload. `refused`: the ledger
   *  refused a Reload, so the lens stays at its generation (plan C1, Z34's "keeps Raw"). `atLine`: where Reopen puts
   *  the view (plan C7). */
  | {
      kind: 'open'
      path: string
      opened: Opened
      lines: number
      bytes: number
      indexed: boolean
      frozen?: string
      refused?: true
      atLine?: number
      /** What's showing. Markdown opens in Raw, then Rendered once its build fits (plan §2.2). */
      lens?: LensName
      structured?: StructuredInfo
      structuredOff?: string
      transcriptOff?: string
      csv?: CsvInfo
      csvOptions?: CsvOptions
      gridOff?: string
      /** Set once `render` has finished. Pages come from it. */
      build?: MdBuild
      /** Past 50 ms with the build still running, the status says "Rendering…". */
      rendering?: boolean
      /** Rendered can't show. The tooltip is `RENDERED_OFF`. */
      renderedOff?: RenderedOff
    }
  | {
      kind: 'failed'; path: string; code: ErrorCode; message: string; localOnly?: true
      /** Inactive activation froze, but this tab still owns the native document and its Reload capability. */
      reloadable?: true
    }
  /** Plan C7: the core died. `line` is where its view was; `ready` once a new core is up to Reopen it in. */
  | { kind: 'gone'; path?: string; line?: number; ready: boolean; localOnly?: true }

export type Action = 'Open file…' | 'Locate…' | 'Retry' | 'Reload' | 'Close' | 'Reopen'

/** Display needs scalar identity, never the selected controller's first page or memory lease. */
export type DisplayCard = Exclude<Card, { kind: 'open' }> | (Omit<Extract<Card, { kind: 'open' }>, 'opened'> & {
  opened: Omit<Opened, 'firstPage' | 'reserved'>
})

export interface CardView {
  /** The header's status text. */
  status: string
  /** The thin line under the header: indexing's share done (0–1), indeterminate while opening, or none. */
  progress: number | 'indeterminate' | null
  /** A banner under the header, and its button's label. The button reloads, as Ctrl+R does. */
  banner: { text: string; action: string } | null
  /** The Raw lens, the Rendered lens, or a message with its actions. */
  body: { raw: true } | { rendered: true } | { grid: true } | { structured: true } | { message: string; actions: Action[] }
  /** Markdown's Raw/Rendered switch. `renderedOff` is the disabled tab's tooltip. Null when the file has no switch. */
  lenses: null | { showing: LensName; renderedOff?: string; grid?: true; gridOff?: string; structured?: { id: LensName; label: string; off?: string }[] }
}

export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

/** Before folder roots exist, the breadcrumb shows only the immediate parent. Paths remain display-only. */
export const parentName = (path: string): string => {
  const end = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (end < 0) return ''
  const parent = path.slice(0, end)
  return parent.split(/[\\/]/).pop() || path.slice(0, end + 1)
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const lines = (n: number, format: (n: number) => string) => `${format(n)} line${n === 1 ? '' : 's'}`

/** What the card shows in each state (brief §7.9, §8.2; the memory refusal is plan §7 proposal 1). */
export function view(card: DisplayCard): CardView {
  const plain = { status: '', progress: null, banner: null, lenses: null }
  const say = (message: string, ...actions: Action[]): CardView => ({ ...plain, body: { message, actions } })
  switch (card.kind) {
    case 'connecting':
      return say('')
    case 'empty':
      return say('', 'Open file…')
    case 'opening':
      // Nothing for the first 300 ms, so a fast open doesn't flash; then the line, and the file can be closed.
      return card.slow
        ? { status: 'Opening…', progress: 'indeterminate', banner: null, lenses: null, body: { message: '', actions: ['Close'] } }
        : say('')
    case 'open': {
      const { opened, frozen } = card
      const count = lines(card.lines, (n) => n.toLocaleString('en'))
      let status = `${count} · ${opened.encoding}`
      if (!card.indexed) status = frozen ? `Indexing stopped at ${count}` : `Indexing ${lines(card.lines, (n) => compact.format(n))}…`
      // Plan §2.2: Raw shows "Rendering…" until the build is ready. A freeze already has its own status.
      if (card.rendering && !frozen) status = 'Rendering…'
      if (opened.format === 'csv' && card.csv) status = `${Math.max(0, card.csv.sourceRecords - (card.csv.header ? 1 : 0)).toLocaleString('en')} rows${card.csv.done ? '' : '…'} · ${card.csv.encoding}`
      const showing = card.lens ?? 'raw'
      const markdown = opened.format === 'markdown' && !opened.blank
      const parseProblem = card.structured?.problems.find(problem => problem.kind === 'parse')
      const parseFailure = card.structuredOff && !card.structured?.root && parseProblem
      return {
        status,
        progress: card.indexed || frozen ? null : opened.size > 0 ? card.bytes / opened.size : 0,
        banner: card.refused
          ? { text: "Can't reload: Typose's memory budget is full", action: 'Retry (Ctrl+R)' }
          : frozen
            ? { text: 'Changed on disk', action: 'Reload (Ctrl+R)' }
            : parseFailure ? { text: `Couldn’t parse as ${opened.format.toUpperCase()} · showing Raw · ${parseProblem.line ? `line ${parseProblem.line}${parseProblem.column ? `, col ${parseProblem.column}` : ''}` : `byte ${parseProblem.first.start}`}`, action: 'View problem in Raw' } : null,
        body: opened.blank ? { message: 'Empty file', actions: [] } : showing === 'rendered' ? { rendered: true } : showing === 'grid' ? { grid: true } : showing !== 'raw' ? { structured: true } : { raw: true },
        lenses: markdown ? { showing, renderedOff: card.renderedOff ? RENDERED_OFF[card.renderedOff] : undefined } :
          opened.format === 'csv' && !opened.blank ? { showing, grid: true, gridOff: card.gridOff } :
          ['json', 'jsonl', 'yaml'].includes(opened.format) && !opened.blank ? { showing, structured: opened.format === 'jsonl' ? [
            ...(card.structured?.transcript ? [{ id: 'transcript' as const, label: 'Transcript', off: card.transcriptOff ?? card.structuredOff }] : []),
            { id: 'rows', label: 'Rows', off: card.structuredOff }, { id: 'table', label: 'Table', off: card.structuredOff ?? card.structured?.tableOff }
          ] : [{ id: 'tree', label: 'Tree', off: card.structuredOff ?? (!card.structured ? 'Preparing Tree…' : undefined) }] } : null
      }
    }
    case 'failed':
      if (card.reloadable) return say(`Can't open ${card.path} · ${card.message}`, 'Reload', 'Close')
      // A lost local capability cannot be recreated by treating its display path as a manual open.
      if (card.localOnly) return say(`Can't open ${card.path} · ${card.message}`, 'Locate…', 'Close')
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
      // Plan C7: the cached text died with the core. Until a new core is up (60 s after a second death), the stopped
      // state offers nothing.
      if (!card.ready) return say("Typose's core stopped")
      if (card.localOnly) return say("Typose's core stopped · Open the file again to continue", 'Open file…')
      return say("Typose's core stopped", card.path ? 'Reopen' : 'Open file…')
  }
}
