import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'react-aria-components'
import type { Limits, Opened } from '../shared/protocol'
import { type Action, type Card, fileName, view } from './card'
import { type CoreClient, CoreCallError } from './core'
import { ROW_HEIGHT, RawLens, viewportCap } from './lenses/raw'
import { inputMark, markNow, markPainted } from './perf'

/** Z37's scan marks (plan A's veto, `afc58f9`), on the renderer's User Timing timeline: the gate reads them. */
const MARKS = ['typose:open-start', 'typose:first-screen', 'typose:line-scan', 'typose:index-done']
const markOnce = (name: string) => performance.getEntriesByName(name).length === 0 && performance.mark(name)

/** Enough lines for the first screen and its overscan (Z37); the rest follow as pages. */
const firstCount = (l: Limits) => Math.min(l.maxItems, 3 * Math.ceil(window.innerHeight / ROW_HEIGHT) + 1)

/** The test-hooks build's way in for the e2e tests (plan m8): App's own close, as the empty card's would do it. */
export const appHooks: { close?: () => void } = {}

const failed = (path: string, e: unknown): Card => ({
  kind: 'failed',
  path,
  code: e instanceof CoreCallError ? e.code : 'Internal',
  message: e instanceof Error ? e.message : String(e)
})

/**
 * The M1 chrome (brief §3.1): the title bar region and one card. React renders the frame; the Raw lens is a
 * framework-free controller mounted into the card body (spec §5.1, Z26).
 */
export function App({ core }: { core: CoreClient }) {
  const [card, setCard] = useState<Card>({ kind: 'connecting' })
  const [limits, setLimits] = useState<Limits | null>(null)
  const latest = useRef({ card, limits })
  latest.current = { card, limits }
  /** The open or reload in progress; a newer one, or Close, abandons it. */
  const attempt = useRef(0)
  /** The document and generation on screen, set as soon as its reply arrives (progress events can't wait for React). */
  const live = useRef<{ doc: number; gen: number } | null>(null)
  /** The Raw lens on screen, if any: where Reopen goes back to after a core death (plan C7). */
  const lens = useRef<RawLens | null>(null)
  /** Plan C1: the next lens's viewport-only cache cap, reserved with the open's floor: the shown lens's height, else the
   *  window's, which bounds the card's. */
  const floorBytes = (l: Limits) => lens.current?.floorBytes() ?? viewportCap(l, window.innerHeight)
  const path = 'path' in card ? card.path : undefined
  const title = path ? `${fileName(path)} — Typose` : 'Typose'
  const shown = view(card)

  useEffect(() => {
    document.title = title
  }, [title])

  // Plan C8's titlebarPainted, for the startup breakdown: React's first commit of the title bar, once that frame is produced.
  useLayoutEffect(() => markPainted('titlebarPainted'), [])

  useEffect(() => {
    // Plan C7: the card says the core stopped, and offers Reopen at the same line once a new core is up.
    // Without a lens on screen (a Reopen still opening, say), the line is the one the card was going back to.
    const offGone = core.onGone(() => {
      const top = lens.current?.topLine()
      setCard((c) => ({ kind: 'gone', path: 'path' in c ? c.path : undefined, line: top ?? ('atLine' in c ? c.atLine : 'line' in c ? c.line : undefined), ready: false }))
    })
    const offReady = core.onReady((hello) => {
      latest.current.limits = hello.limits
      setLimits(hello.limits)
      setCard((c) => (c.kind === 'gone' ? { ...c, ready: true } : c))
    })
    // Subscribed before any open, so no event is missed between the open reply and the lens mounting.
    const offProgress = core.onProgress((e) => {
      if (live.current?.doc !== e.doc || live.current.gen !== e.gen) return // another document's, or an old generation's
      // The scan has passed the first line's end once it has found a second line, or finished (Z37).
      if (e.lines > 1 || e.done) markOnce('typose:line-scan')
      if (e.done) markOnce('typose:index-done')
      setCard((c) =>
        c.kind === 'open' && c.opened.doc === e.doc && c.opened.gen === e.gen
          ? { ...c, lines: e.lines, bytes: e.bytes, indexed: e.done, frozen: e.error ?? c.frozen } // an index error froze it (plan C6)
          : c
      )
    })
    // Ctrl+R and F5 are Reload (spec §3.1, brief §7.2), not the page reload Electron's default menu binds to
    // Ctrl+R. Ctrl+Shift+R isn't taken over here: the menu is PR 7's.
    const onKey = (e: KeyboardEvent) => {
      const modified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey
      const ctrlR = e.key.toLowerCase() === 'r' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
      if (!ctrlR && (e.key !== 'F5' || modified)) return
      e.preventDefault()
      void reload()
    }
    window.addEventListener('keydown', onKey)
    void core.connect().then(
      async (hello) => {
        setLimits(hello.limits)
        latest.current.limits = hello.limits // `open` below runs before React re-renders
        const initial = await window.typose.launchPath()
        if (initial) void open(initial)
        else setCard({ kind: 'empty' })
      },
      async () => {
        // The first core died before its handshake: keep the file named on the command line, for Reopen.
        const initial = (await window.typose.launchPath()) ?? undefined
        setCard((c) => (c.kind === 'gone' ? { ...c, path: c.path ?? initial } : { kind: 'gone', path: initial, ready: false }))
      }
    )
    return () => {
      offGone()
      offReady()
      offProgress()
      window.removeEventListener('keydown', onKey)
    }
  }, [core])

  /** Opens `path`; Reopen passes the line to go back to. */
  async function open(path: string, atLine?: number): Promise<void> {
    const l = latest.current.limits
    if (!l) return
    const mine = ++attempt.current
    live.current = null
    for (const m of MARKS) performance.clearMarks(m)
    performance.mark('typose:open-start')
    markNow('openRequested')
    inputMark('open', performance.now()) // an open-then-scroll interval starts here (plan C8)
    setCard({ kind: 'opening', path, slow: false, atLine })
    // Brief §7.9's slow open: "Opening…" only once 300 ms pass without a first screen.
    const slow = setTimeout(() => setCard((c) => (c.kind === 'opening' && attempt.current === mine ? { ...c, slow: true } : c)), 300)
    try {
      const opened = await core.call('open', { path, count: firstCount(l), bytes: floorBytes(l) })
      if (attempt.current !== mine) return void core.call('close', { doc: opened.doc }).catch(() => {}) // closed meanwhile
      show(path, opened, atLine)
    } catch (e) {
      if (attempt.current === mine && !(e instanceof CoreCallError && e.code === 'CoreGone')) setCard(failed(path, e)) // onGone shows that
    } finally {
      clearTimeout(slow)
    }
  }

  /** Ctrl+R: the next generation of the open document, or another try at a file that failed to open. */
  async function reload(): Promise<void> {
    const { card: c, limits: l } = latest.current
    if (c.kind === 'failed') return open(c.path)
    if (c.kind !== 'open' || !l) return
    const mine = ++attempt.current
    try {
      const opened = await core.call('reload', { doc: c.opened.doc, count: firstCount(l), bytes: floorBytes(l) })
      if (attempt.current === mine) show(c.path, opened)
    } catch (e) {
      if (attempt.current !== mine || (e instanceof CoreCallError && e.code === 'CoreGone')) return // onGone shows that
      // Plan C1: the ledger refused it. The lens stays at its generation, under a banner offering Retry (Z34's "keeps Raw").
      if (e instanceof CoreCallError && e.code === 'Memory') setCard((d) => (d.kind === 'open' && d.opened === c.opened ? { ...d, refused: true } : d))
      else setCard(failed(c.path, e)) // the file is gone, say: the card says so, and Raw unmounting closes the document
    }
  }

  function show(path: string, opened: Opened, atLine?: number): void {
    live.current = { doc: opened.doc, gen: opened.gen }
    setCard({ kind: 'open', path, opened, lines: opened.lines, bytes: 0, indexed: opened.indexed, atLine })
  }

  async function pick(): Promise<void> {
    const chosen = await window.typose.openDialog()
    if (chosen) void open(chosen)
  }

  /** Close leaves the empty card; an open still on its way is closed when it arrives. */
  function close(): void {
    attempt.current++
    live.current = null
    setCard({ kind: 'empty' })
  }
  if (__TEST_HOOKS__) appHooks.close = close

  const actions: Record<Action, () => void> = {
    'Open file…': () => void pick(),
    'Locate…': () => void pick(),
    Retry: () => path && void open(path),
    Close: close,
    Reopen: () => card.kind === 'gone' && card.path && void open(card.path, card.line)
  }
  const frozen = card.kind === 'open' ? card.frozen : undefined

  return (
    <>
      <header className="titlebar">
        <span className="glyph" aria-hidden="true">
          ▣
        </span>
        {/* Element Timing: shellVisible is when this text reaches the screen (plan C8). */}
        <span className="title" {...{ elementtiming: 'titlebar' }}>
          {title}
        </span>
      </header>
      <main className="card">
        <div className="card-header">
          <span className="card-name">{path ? fileName(path) : 'No file open'}</span>
          <span className="card-status">{shown.status}</span>
          {card.kind === 'open' || card.kind === 'failed' ? (
            <Button className="open-button" onPress={() => void pick()}>
              Open file…
            </Button>
          ) : null}
        </div>
        {shown.progress === null ? null : <ProgressLine value={shown.progress} />}
        {shown.banner ? (
          <div className="banner" role="status" title={frozen}>
            {`${shown.banner.text} · `}
            <Button className="banner-button" onPress={() => void reload()}>
              {shown.banner.action}
            </Button>
          </div>
        ) : null}
        <div className="card-body">
          {'raw' in shown.body && card.kind === 'open' && limits ? (
            <RawHost
              core={core}
              lens={lens}
              atLine={card.atLine}
              opened={card.opened}
              name={fileName(card.path)}
              lines={card.lines}
              indexed={card.indexed}
              limits={limits}
              frozen={frozen !== undefined}
              onFrozen={(why) => setCard((c) => (c.kind === 'open' && c.opened === card.opened ? { ...c, frozen: c.frozen ?? why } : c))}
            />
          ) : (
            <div className="card-message">
              <div className="card-state">
                {'message' in shown.body && shown.body.message ? <p>{shown.body.message}</p> : null}
                {'actions' in shown.body
                  ? shown.body.actions.map((a) => (
                      <Button key={a} className="open-button" onPress={actions[a]}>
                        {a}
                      </Button>
                    ))
                  : null}
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  )
}

/** Brief §8.2's thin line under the header: determinate while indexing, indeterminate while opening. */
function ProgressLine({ value }: { value: number | 'indeterminate' }) {
  const determinate = value !== 'indeterminate'
  return (
    <div
      className={determinate ? 'progress-line' : 'progress-line indeterminate'}
      role="progressbar"
      aria-label={determinate ? 'Indexing' : 'Opening'}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
    >
      <div style={determinate ? { width: `${value * 100}%` } : undefined} />
    </div>
  )
}

interface RawHostProps {
  core: CoreClient
  /** The lens on screen, for App: null while none is. */
  lens: RefObject<RawLens | null>
  /** The line to open at (Reopen, plan C7). */
  atLine: number | undefined
  opened: Opened
  name: string
  lines: number
  indexed: boolean
  limits: Limits
  frozen: boolean
  onFrozen(why: string): void
}

/** Mounts the Raw controller into the card body, and passes it the index's line count as it grows. */
function RawHost({ core, lens, atLine, opened, name, lines, indexed, limits, frozen, onFrozen }: RawHostProps) {
  const host = useRef<HTMLDivElement>(null)
  const onFrozenNow = useRef(onFrozen)
  onFrozenNow.current = onFrozen
  const doc = opened.doc
  // The document closes when the card stops showing it, not when Reload replaces its generation.
  useEffect(
    () => () => {
      lens.current = null
      void core.call('close', { doc }).catch(() => {})
    },
    [core, doc, lens]
  )
  useEffect(() => {
    // Reload keeps the reading position; a new lens starts where it's told to.
    const raw = new RawLens(host.current!, core, opened, name, limits, { onFrozen: (why) => onFrozenNow.current(why), atLine: lens.current?.topLine() ?? atLine })
    lens.current = raw
    return () => raw.dispose()
  }, [core, opened, name, limits, lens, atLine])
  useEffect(() => lens.current?.setLineCount(lines), [lines])
  useEffect(() => {
    if (indexed) lens.current?.indexDone()
  }, [indexed])
  useEffect(() => {
    if (frozen) lens.current?.freeze()
  }, [frozen])
  return <div className="raw-host" ref={host} data-gen={opened.gen} />
}
