import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'react-aria-components'
import type { Limits, Opened } from '../shared/protocol'
import { type CoreClient, CoreCallError } from './core'
import { ROW_HEIGHT, RawLens } from './lenses/raw'
import { inputMark, markNow, markPainted } from './perf'

type Card =
  | { kind: 'connecting' }
  | { kind: 'empty' }
  | { kind: 'opening'; path: string }
  | { kind: 'open'; path: string; opened: Opened; lines: number; indexed: boolean; error?: string }
  | { kind: 'failed'; path: string; message: string }
  | { kind: 'gone'; path?: string }

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

/**
 * The M1 chrome (brief §3.1): the title bar region and one card. React renders the frame; the Raw lens is a
 * framework-free controller mounted into the card body (spec §5.1, Z26).
 */
export function App({ core }: { core: CoreClient }) {
  const [card, setCard] = useState<Card>({ kind: 'connecting' })
  const [limits, setLimits] = useState<Limits | null>(null)
  const path = 'path' in card ? card.path : undefined
  const title = path ? `${fileName(path)} — Typose` : 'Typose'

  useEffect(() => {
    document.title = title
  }, [title])

  // Plan C8's titlebarPainted, for the startup breakdown: React's first commit of the title bar, once that frame is produced.
  useLayoutEffect(() => markPainted('titlebarPainted'), [])

  useEffect(() => {
    const offGone = core.onGone(() => setCard((c) => ({ kind: 'gone', path: 'path' in c ? c.path : undefined })))
    // Subscribed before any open, so no event is missed between the open reply and the lens mounting.
    const offProgress = core.onProgress((e) =>
      setCard((c) =>
        c.kind === 'open' && c.opened.doc === e.doc && c.opened.gen === e.gen ? { ...c, lines: e.lines, indexed: e.done, error: e.error } : c
      )
    )
    void core.connect().then(
      async (hello) => {
        setLimits(hello.limits)
        const initial = await window.typose.launchPath()
        if (initial) void open(initial, hello.limits)
        else setCard({ kind: 'empty' })
      },
      () => setCard({ kind: 'gone' })
    )
    return () => {
      offGone()
      offProgress()
    }
  }, [core])

  async function open(path: string, l: Limits): Promise<void> {
    markNow('openRequested')
    inputMark('open', performance.now()) // an open-then-scroll interval starts here (plan C8)
    setCard({ kind: 'opening', path })
    // Enough lines for the first screen and its overscan (Z37); the rest follow as pages.
    const count = Math.min(l.maxItems, 3 * Math.ceil(window.innerHeight / ROW_HEIGHT) + 1)
    try {
      const opened = await core.call('open', { path, count })
      setCard({ kind: 'open', path, opened, lines: opened.lines, indexed: opened.indexed })
    } catch (e) {
      if (e instanceof CoreCallError && e.code === 'CoreGone') return // onGone shows it
      setCard({ kind: 'failed', path, message: e instanceof Error ? e.message : String(e) })
    }
  }

  async function pick(): Promise<void> {
    const chosen = await window.typose.openDialog()
    if (chosen && limits) void open(chosen, limits)
  }

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
          <span className="card-status">
            {status(card)}
          </span>
          {card.kind === 'open' || card.kind === 'failed' ? (
            <Button className="open-button" onPress={() => void pick()}>
              Open file…
            </Button>
          ) : null}
        </div>
        <div className="card-body">
          {card.kind === 'open' && limits ? (
            <RawHost core={core} opened={card.opened} name={fileName(card.path)} lines={card.lines} limits={limits} />
          ) : (
            <div className="card-message">
              {card.kind === 'empty' ? (
                <Button className="open-button" onPress={() => void pick()}>
                  Open file…
                </Button>
              ) : (
                message(card)
              )}
            </div>
          )}
        </div>
      </main>
    </>
  )
}

function status(card: Card): string {
  if (card.kind === 'opening') return 'Opening…'
  if (card.kind !== 'open') return ''
  const lines = `${card.lines.toLocaleString()} line${card.lines === 1 ? '' : 's'}`
  if (card.error) return `Indexing stopped: ${card.error}`
  return card.indexed ? `${lines} · ${card.opened.encoding}` : `Indexing… ${lines}`
}

function message(card: Card): string {
  switch (card.kind) {
    case 'connecting':
      return ''
    case 'failed':
      return `Can't open ${card.path} · ${card.message}`
    case 'gone':
      return "Typose's core stopped" // Reopen arrives with respawn (PR 5)
    default:
      return ''
  }
}

interface RawHostProps {
  core: CoreClient
  opened: Opened
  name: string
  lines: number
  limits: Limits
}

/** Mounts the Raw controller into the card body, and passes it the index's line count as it grows. */
function RawHost({ core, opened, name, lines, limits }: RawHostProps) {
  const host = useRef<HTMLDivElement>(null)
  const lens = useRef<RawLens | null>(null)
  useEffect(() => {
    const raw = new RawLens(host.current!, core, opened, name, limits)
    lens.current = raw
    return () => {
      raw.dispose()
      void core.call('close', { doc: opened.doc }).catch(() => {})
    }
  }, [core, opened, name, limits])
  useEffect(() => lens.current?.setLineCount(lines), [lines])
  return <div className="raw-host" ref={host} />
}
