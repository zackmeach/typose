import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components'
import type { Command, Limits, MdBuild, Opened } from '../shared/protocol'
import { type Action, type Card, fileName, view } from './card'
import { type CoreClient, CoreCallError } from './core'
import { RenderedLens, renderedCharge } from './lenses/rendered'
import { LensBudget, type ReloadReservation } from './lenses/lens-budget'
import { ROW_HEIGHT, RawLens, viewportCap } from './lenses/raw'
import { AppMenu, LINUX } from './menu'
import { inputMark, markNow, markPainted } from './perf'

/** macOS has its native menu bar and traffic lights in place of the glyph and ☰ (brief §3.1). */
const MAC = navigator.platform.startsWith('Mac')

/** Z37's scan marks (plan A's veto, `afc58f9`), on the renderer's User Timing timeline: the gate reads them. */
const MARKS = ['typose:open-start', 'typose:first-screen', 'typose:line-scan', 'typose:index-done']
const markOnce = (name: string) => performance.getEntriesByName(name).length === 0 && performance.mark(name)

/** Enough lines for the first screen and its overscan (Z37); the rest follow as pages. */
const firstCount = (l: Limits) => Math.min(l.maxItems, 3 * Math.ceil(window.innerHeight / ROW_HEIGHT) + 1)

/** The test-hooks build's way in for the e2e tests (plan m8): App's own close, as the empty card's would do it. */
export const appHooks: { close?: () => void } = {}

const failed = (path: string, e: unknown): Extract<Card, { kind: 'failed' }> => ({
  kind: 'failed',
  path,
  code: e instanceof CoreCallError ? e.code : 'Internal',
  message: e instanceof Error ? e.message : String(e)
})

/** What App asks of the lens on screen. Raw and Rendered both answer. */
interface ShownLens {
  topLine(): number
  readerMoved(): boolean
  floorBytes(): number
  focus(): void
  element: HTMLElement
  setLineCount(lines: number): void
  indexDone(): void
  freeze(): void
  yieldReservation(): void
  resumeReservation(): void
  dispose(release?: boolean): void
}

interface RetainedRendered {
  session: number
  doc: number
  gen: number
  view: RenderedLens
}

/**
 * The M1 chrome (brief §3.1): the title bar region and one card. React renders the frame; a lens is a
 * framework-free controller mounted into the card body (spec §5.1, Z26). Markdown's switch is React Aria's
 * tablist (brief §9).
 */
export function App({ core }: { core: CoreClient }) {
  const [card, setCard] = useState<Card>({ kind: 'connecting' })
  const [limits, setLimits] = useState<Limits | null>(null)
  const [session, setSession] = useState(0)
  const currentSession = useRef(0)
  const latest = useRef({ card, limits })
  latest.current = { card, limits }
  /** The open or reload in progress; a newer one, or Close, abandons it. */
  const attempt = useRef(0)
  /** A Reload under way: Ctrl+R, F5 and Retry wait for it, so Reloads never overlap at the core (plan C1). */
  const reloading = useRef(false)
  /** The document and generation on screen, set as soon as its reply arrives (progress events can't wait for React). */
  const live = useRef<{ doc: number; gen: number } | null>(null)
  /** The lens on screen, if any: where Reopen goes back to after a core death (plan C7). */
  const lens = useRef<ShownLens | null>(null)
  /** The lens the reader chose. Null until they use the switch: a move in Raw then keeps Raw (plan §2.2). */
  const picked = useRef<'raw' | 'rendered' | null>(null)
  /** A note's "Show in Raw" jump, read when the lens unmounts. */
  const jumpTo = useRef<number | undefined>(undefined)
  /** The previous lens's line, scoped to its core session and document: ids repeat after a core restart. */
  const place = useRef<{ session: number; doc: number; line: number } | undefined>(undefined)
  /** Whether that lens had the focus, so the next one takes it (plan PR 7). */
  const hadFocus = useRef(false)
  /** Reload recorded that the lens had focus, before show() unmounted the scroller. */
  const restoreFocus = useRef(false)
  /** One reservation for Rendered per open; an old response must not block a replacement document. */
  const holding = useRef<Opened | null>(null)
  const budget = useRef<LensBudget | null>(null)
  /** Single-tree high water. Each next view pays two empirical allowances for disposed trees awaiting GC. */
  const retiredRendered = useRef(0)
  const rendered = useRef<RetainedRendered | null>(null)
  /** A file chosen before the core first came up: it's opened then, ahead of the command line's. */
  const waiting = useRef<string | null>(null)
  /** Plan C1: the next lens's viewport-only cache cap, reserved with the open's floor: the shown lens's height, else the
   *  window's, which bounds the card's. */
  const floorBytes = (l: Limits) => lens.current?.floorBytes() ?? viewportCap(l, window.innerHeight)
  const path = 'path' in card ? card.path : undefined
  const title = path ? `${fileName(path)} — Typose` : 'Typose'
  const shown = view(card)
  const openedNow = card.kind === 'open' ? card.opened : null

  const budgetFor = (opened: Opened): LensBudget | null => {
    const owner = budget.current
    return owner?.session === currentSession.current && owner.doc === opened.doc && owner.current(opened.gen) ? owner : null
  }
  const discardRendered = () => {
    rendered.current?.view.dispose()
    rendered.current = null
  }
  const retireBudget = () => {
    const owner = budget.current
    if (!owner) return
    retiredRendered.current = Math.max(retiredRendered.current, owner.snapshot().rendered, owner.retiredTreeMax)
    owner.invalidate()
  }

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
      retireBudget()
      discardRendered()
      setCard((c) => ({ kind: 'gone', path: 'path' in c ? c.path : undefined, line: top ?? ('atLine' in c ? c.atLine : 'line' in c ? c.line : undefined), ready: false,
        localOnly: c.kind === 'open' ? c.opened.localOnly : 'localOnly' in c ? c.localOnly : undefined }))
    })
    const offReady = core.onReady((hello) => {
      currentSession.current = hello.session
      setSession(hello.session)
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
    // Ctrl+R and F5 are Reload (spec §3.1, brief §7.2). Electron's default menu, whose Ctrl+R and Ctrl+Shift+R
    // reloaded the page, is gone (main).
    const onKey = (e: KeyboardEvent) => {
      const modified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey
      // Brief §7.2: Ctrl+Q quits on Linux, as ☰'s Quit does.
      if (LINUX && e.key.toLowerCase() === 'q' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return run('exit')
      const ctrlR = e.key.toLowerCase() === 'r' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
      if (!ctrlR && (e.key !== 'F5' || modified)) return
      e.preventDefault()
      // show() unmounts the scroller before the lens's cleanup can see document.activeElement. Record it now.
      if (lens.current?.element.contains(document.activeElement)) restoreFocus.current = true
      void reload()
    }
    window.addEventListener('keydown', onKey)
    const offOpenPath = window.typose.onOpenPath(openNamed)
    const offCommand = window.typose.onCommand(run) // macOS's native menu
    void core.connect().then(
      async (hello) => {
        setLimits(hello.limits)
        latest.current.limits = hello.limits // `open` below runs before React re-renders
        const launched = await window.typose.launchPath()
        const initial = waiting.current ?? launched
        if (initial) void open(initial)
        else setCard({ kind: 'empty' })
      },
      async () => {
        // The first core died before its handshake: keep the file named, for Reopen.
        const launched = (await window.typose.launchPath()) ?? undefined
        const initial = waiting.current ?? launched
        setCard((c) => (c.kind === 'gone' ? { ...c, path: c.path ?? initial } : { kind: 'gone', path: initial, ready: false }))
      }
    )
    return () => {
      offGone()
      offReady()
      offProgress()
      offOpenPath()
      offCommand()
      window.removeEventListener('keydown', onKey)
    }
  }, [core])

  // Plan §2.2: `open` has already returned Raw's first page. `render` runs at once. Within 50 ms, Rendered mounts
  // with no "Rendering…". After that, Raw says "Rendering…" and switches when the build fits, unless the reader moved.
  useEffect(() => {
    if (!openedNow || openedNow.format !== 'markdown' || openedNow.blank) return
    const opened = openedNow
    picked.current = null
    const ac = new AbortController()
    let alive = true
    const slow = window.setTimeout(() => {
      setCard((c) => (c.kind === 'open' && c.opened === opened && !c.build && !c.renderedOff ? { ...c, rendering: true } : c))
    }, 50)
    void (async () => {
      try {
        const build = await core.call('render', { doc: opened.doc, gen: opened.gen }, ac.signal)
        if (!alive) return
        const moved = lens.current?.readerMoved() ?? false
        const go = picked.current === 'rendered' || (picked.current !== 'raw' && !moved)
        if (!go) {
          if (restoreFocus.current) {
            lens.current?.focus()
            restoreFocus.current = false
          }
          setCard((c) => (c.kind === 'open' && c.opened === opened ? { ...c, build, rendering: false } : c))
          return
        }
        const held = await holdRendered(opened, build)
        if (!alive || held === 'stale') return
        // Raw may have moved while the reservation was in flight. Only an explicit Rendered choice overrides that.
        if (picked.current === 'raw' || (picked.current !== 'rendered' && lens.current?.readerMoved())) {
          void budgetFor(opened)?.reserveRendered(opened.gen, 0)
          lens.current?.resumeReservation()
          if (restoreFocus.current) {
            lens.current?.focus()
            restoreFocus.current = false
          }
          setCard((c) => (c.kind === 'open' && c.opened === opened ? { ...c, build, rendering: false, lens: 'raw' } : c))
          return
        }
        if (held === 'memory' && restoreFocus.current) {
          lens.current?.focus()
          restoreFocus.current = false
        }
        setCard((c) =>
          c.kind === 'open' && c.opened === opened
            ? held === 'memory'
              ? { ...c, build, rendering: false, renderedOff: 'memory', lens: 'raw' }
              : { ...c, build, rendering: false, lens: 'rendered' }
            : c
        )
      } catch (e) {
        if (!alive) return
        const off = e instanceof CoreCallError && e.code === 'Refused' ? 'ceiling' : e instanceof CoreCallError && e.code === 'Memory' ? 'memory' : undefined
        if (off && restoreFocus.current) {
          lens.current?.focus()
          restoreFocus.current = false
        }
        const frozen = e instanceof CoreCallError && e.code === 'Frozen' ? e.message : undefined
        setCard((c) => (c.kind === 'open' && c.opened === opened ? { ...c, rendering: false, renderedOff: off ?? c.renderedOff, frozen: c.frozen ?? frozen, lens: 'raw' } : c))
        if (!off && !(e instanceof CoreCallError && (e.code === 'Cancelled' || e.code === 'Stale' || e.code === 'CoreGone' || e.code === 'Frozen')))
          console.error('render failed', e)
      }
    })()
    return () => {
      alive = false
      ac.abort()
      window.clearTimeout(slow)
    }
  }, [openedNow, core])

  /**
   * Reserve Rendered's charge on the one lens holder (plan §2.2) before any block is appended. Refused, the caller
   * keeps Raw. `stale` when this document was replaced while the call was out.
   */
  async function holdRendered(opened: Opened, build: MdBuild): Promise<'ok' | 'memory' | 'stale'> {
    if (holding.current === opened) return 'stale'
    holding.current = opened
    const before = lens.current
    before?.yieldReservation()
    let ok = false
    try {
      ok = await (budgetFor(opened)?.ensureRendered(opened.gen, renderedCharge(build)) ?? Promise.resolve(false))
    } catch {
      ok = false
    } finally {
      if (holding.current === opened) holding.current = null
    }
    const now = latest.current.card
    if (now.kind !== 'open' || now.opened !== opened) return 'stale'
    if (!ok) {
      if (lens.current === before) before?.resumeReservation()
      return 'memory'
    }
    return 'ok'
  }

  /** The switch. Rendered before its build exists is remembered; the effect mounts it when the build fits. */
  function onLens(key: string | number): void {
    if (key !== 'raw' && key !== 'rendered') return
    const c = latest.current.card
    if (c.kind !== 'open' || (c.lens ?? 'raw') === key) return
    picked.current = key
    if (key === 'raw') {
      setCard((d) => (d.kind === 'open' && d.opened === c.opened ? { ...d, lens: 'raw' } : d))
      return
    }
    if (c.renderedOff || !c.build) return
    const build = c.build
    void holdRendered(c.opened, build).then((held) => {
      if (held === 'stale') return
      setCard((d) => {
        if (d.kind !== 'open' || d.opened !== c.opened) return d
        return held === 'memory' ? { ...d, renderedOff: 'memory', lens: 'raw' } : { ...d, lens: 'rendered' }
      })
    })
  }

  /** Opens `path`; Reopen passes the line to go back to. */
  async function open(path: string, atLine?: number): Promise<void> {
    const l = latest.current.limits
    if (!l) return void (waiting.current = path) // the core isn't up yet: opened once it is
    const rawBytes = floorBytes(l)
    const mine = ++attempt.current
    retireBudget()
    const retired = retiredRendered.current
    discardRendered()
    live.current = null
    for (const m of MARKS) performance.clearMarks(m)
    performance.mark('typose:open-start')
    markNow('openRequested')
    inputMark('open', performance.now()) // an open-then-scroll interval starts here (plan C8)
    setCard({ kind: 'opening', path, slow: false, atLine })
    // Brief §7.9's slow open: "Opening…" only once 300 ms pass without a first screen.
    const slow = setTimeout(() => setCard((c) => (c.kind === 'opening' && attempt.current === mine ? { ...c, slow: true } : c)), 300)
    try {
      const opened = await core.call('open', { path, count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (attempt.current !== mine) return void core.call('close', { doc: opened.doc }).catch(() => {}) // closed meanwhile
      show(path, opened, atLine, rawBytes, undefined, retired)
    } catch (e) {
      if (attempt.current === mine && !(e instanceof CoreCallError && e.code === 'CoreGone')) setCard(failed(path, e)) // onGone shows that
    } finally {
      clearTimeout(slow)
    }
  }

  /** Keep the source alive until the capability-relative open has returned its first page. */
  async function openLocal(source: Opened, target: string): Promise<boolean> {
    const { card: c, limits: l } = latest.current
    if (c.kind !== 'open' || c.opened !== source || !l || reloading.current) return false
    const mine = ++attempt.current
    const sourceSession = currentSession.current
    const rawBytes = floorBytes(l)
    const owner = budgetFor(source)
    const plan = owner?.reloadReservation(rawBytes)
    const retired = Math.max(retiredRendered.current, plan?.retiredTreeMax ?? 0)
    try {
      const opened = await core.call('openLocal', { doc: source.doc, gen: source.gen, target, count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (attempt.current !== mine || currentSession.current !== sourceSession || latest.current.card.kind !== 'open' || latest.current.card.opened !== source) {
        if (currentSession.current === sourceSession) void core.call('close', { doc: opened.doc }).catch(() => {})
        return false
      }
      retireBudget()
      discardRendered()
      restoreFocus.current = true
      show(opened.path!, opened, undefined, rawBytes, undefined, retired)
      return true
    } catch (e) {
      if (attempt.current === mine && e instanceof CoreCallError && e.code === 'Frozen')
        setCard((d) => d.kind === 'open' && d.opened === source ? { ...d, frozen: d.frozen ?? e.message } : d)
      return false // no replacement: the source and its reservation remain usable
    } finally {
      if (plan) owner?.cancelTransition(plan)
    }
  }

  /** Ctrl+R: the next generation of the open document, or another try at a file that failed to open. */
  async function reload(): Promise<void> {
    if (!restoreFocus.current && lens.current?.element.contains(document.activeElement)) restoreFocus.current = true
    const { card: c, limits: l } = latest.current
    if (c.kind === 'failed') return c.localOnly ? pick() : open(c.path)
    if (c.kind !== 'open' || !l || reloading.current) return
    const mine = ++attempt.current
    reloading.current = true
    const rawBytes = floorBytes(l)
    const owner = budgetFor(c.opened)
    const plan = owner?.reloadReservation(rawBytes)
    try {
      const opened = await core.call('reload', { doc: c.opened.doc, count: firstCount(l), bytes: plan?.bytes ?? rawBytes })
      if (attempt.current === mine) show(c.path, opened, lens.current?.topLine() ?? c.atLine, rawBytes, plan)
    } catch (e) {
      if (attempt.current !== mine || (e instanceof CoreCallError && e.code === 'CoreGone')) return // onGone shows that
      // Plan C1: the ledger refused it. The lens stays at its generation, under a banner offering Retry (Z34's "keeps Raw").
      if (e instanceof CoreCallError && e.code === 'Memory') setCard((d) => (d.kind === 'open' && d.opened === c.opened ? { ...d, refused: true } : d))
      else {
        retireBudget()
        discardRendered()
        setCard({ ...failed(c.path, e), localOnly: c.opened.localOnly }) // a lost local route requires explicit selection
      }
    } finally {
      if (plan) owner?.cancelTransition(plan)
      reloading.current = false
    }
  }

  function show(path: string, opened: Opened, atLine: number | undefined, rawBytes: number, plan?: ReloadReservation, retired = 0): void {
    discardRendered()
    if (opened.format === 'markdown' || retired > 0 || plan) {
      const previous = budget.current
      if (!previous || previous.session !== currentSession.current || previous.doc !== opened.doc || !plan || !previous.adopt(opened.gen, opened.reserved, plan)) {
        previous?.invalidate()
        budget.current = new LensBudget(core, currentSession.current, opened.doc, opened.gen, rawBytes, opened.reserved, Math.max(retired, plan?.retiredTreeMax ?? 0))
      }
    } else {
      budget.current?.invalidate()
      budget.current = null
    }
    live.current = { doc: opened.doc, gen: opened.gen }
    // Raw's first page is already in the reply (Z37). Markdown switches to Rendered once `render` fits.
    setCard({ kind: 'open', path, opened, lines: opened.lines, bytes: 0, indexed: opened.indexed, atLine, lens: 'raw' })
  }

  async function pick(): Promise<void> {
    const chosen = await window.typose.openDialog()
    if (!chosen) return
    const c = latest.current.card
    if (c.kind === 'gone' && c.localOnly && c.ready) void open(chosen)
    else openNamed(chosen)
  }

  /**
   * A file named after the first (spec §8.1: a second launch, macOS's open-file) or chosen in the Open dialog: it
   * replaces the card's. While the core is stopped, it's the file Reopen opens.
   */
  function openNamed(path: string): void {
    if (latest.current.card.kind === 'gone') setCard((c) => (c.kind === 'gone' ? { ...c, path, line: undefined, localOnly: undefined } : c))
    else void open(path)
  }

  /** The menu's commands: ☰'s, and macOS's native menu's (spec §9). */
  function run(command: Command): void {
    if (command === 'open') void pick()
    else if (command === 'reload') void reload()
    else if (command === 'exit') window.close() // the last window's close quits (main's window-all-closed)
  }

  /** Close leaves the empty card; an open still on its way is closed when it arrives. */
  function close(): void {
    attempt.current++
    retireBudget()
    discardRendered()
    live.current = null
    setCard({ kind: 'empty' })
  }
  if (__TEST_HOOKS__) appHooks.close = close

  const actions: Record<Action, () => void> = {
    'Open file…': () => void pick(),
    'Locate…': () => void pick(),
    Retry: () => card.kind === 'failed' && card.localOnly ? void pick() : path && void open(path),
    Close: close,
    Reopen: () => card.kind === 'gone' && !card.localOnly && card.path && void open(card.path, card.line)
  }
  const frozen = card.kind === 'open' ? card.frozen : undefined

  const header = (
    <div className="card-header">
      <span className="card-name">{path ? fileName(path) : 'No file open'}</span>
      <span className="card-status">{shown.status}</span>
      {shown.lenses ? (
        <TabList aria-label="Lens" className="lens-switch">
          <Tab id="rendered" className="lens-tab" isDisabled={!!shown.lenses.renderedOff}>
            {/* `Tab` doesn't take a DOM `title`. The span carries the reason, which is the tooltip (Z71, Z34). */}
            <span className="lens-tab-tip" title={shown.lenses.renderedOff}>
              Rendered
            </span>
          </Tab>
          <Tab id="raw" className="lens-tab">
            Raw
          </Tab>
        </TabList>
      ) : null}
      {card.kind === 'open' || card.kind === 'failed' ? (
        <Button className="open-button" onPress={() => void pick()}>
          Open file…
        </Button>
      ) : null}
    </div>
  )
  const progress = shown.progress === null ? null : <ProgressLine value={shown.progress} />
  const banner = shown.banner ? (
    <div className="banner" role="status" title={frozen}>
      {`${shown.banner.text} · `}
      <Button
        className="banner-button"
        onPress={() => {
          restoreFocus.current = true // the click focuses the button; show() would then drop the scroller's focus
          void reload()
        }}
      >
        {shown.banner.action}
      </Button>
    </div>
  ) : null
  const message = (
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
  )

  const body =
    card.kind === 'open' && limits && 'raw' in shown.body ? (
      <LensHost
        core={core}
        session={session}
        budget={budgetFor(card.opened)}
        retained={rendered}
        lens={lens}
        jumpTo={jumpTo}
        place={place}
        hadFocus={hadFocus}
        restoreFocus={restoreFocus}
        atLine={card.atLine}
        opened={card.opened}
        name={fileName(card.path)}
        lines={card.lines}
        indexed={card.indexed}
        limits={limits}
        frozen={frozen !== undefined}
        mode="raw"
        onFrozen={(why) => setCard((c) => (c.kind === 'open' && c.opened === card.opened ? { ...c, frozen: c.frozen ?? why } : c))}
        onShowRaw={() => {}}
        onOpenLocal={(target) => openLocal(card.opened, target)}
      />
    ) : card.kind === 'open' && limits && 'rendered' in shown.body && card.build ? (
      <LensHost
        core={core}
        session={session}
        budget={budgetFor(card.opened)}
        retained={rendered}
        lens={lens}
        jumpTo={jumpTo}
        place={place}
        hadFocus={hadFocus}
        restoreFocus={restoreFocus}
        atLine={card.atLine}
        opened={card.opened}
        name={fileName(card.path)}
        lines={card.lines}
        indexed={card.indexed}
        limits={limits}
        frozen={frozen !== undefined}
        mode="rendered"
        build={card.build}
        onFrozen={(why) => setCard((c) => (c.kind === 'open' && c.opened === card.opened ? { ...c, frozen: c.frozen ?? why } : c))}
        onShowRaw={(line) => {
          jumpTo.current = line
          picked.current = 'raw'
          setCard((c) => (c.kind === 'open' && c.opened === card.opened ? { ...c, lens: 'raw' } : c))
        }}
        onOpenLocal={(target) => openLocal(card.opened, target)}
      />
    ) : (
      message
    )

  return (
    <>
      <header className={MAC ? 'titlebar mac' : 'titlebar'}>
        {MAC ? null : (
          <span className="titlebar-start">
            <span className="glyph" aria-hidden="true">
              ▣
            </span>
            <AppMenu run={run} />
          </span>
        )}
        {/* Element Timing: shellVisible is when this text reaches the screen (plan C8). */}
        <span className="title" {...{ elementtiming: 'titlebar' }}>
          {title}
        </span>
      </header>
      <main className="card">
        {card.kind === 'open' ? (
          <DocLifetime doc={card.opened.doc} core={core} lens={lens}>
            {shown.lenses ? (
              <Tabs className="card-tabs" selectedKey={shown.lenses.showing} onSelectionChange={onLens}>
                {header}
                {progress}
                {banner}
                <div className="card-body">
                  <TabPanel id="rendered" className="lens-panel">
                    {shown.lenses.showing === 'rendered' ? body : null}
                  </TabPanel>
                  <TabPanel id="raw" className="lens-panel">
                    {shown.lenses.showing === 'raw' ? body : null}
                  </TabPanel>
                </div>
              </Tabs>
            ) : (
              <>
                {header}
                {progress}
                {banner}
                <div className="card-body">{body}</div>
              </>
            )}
          </DocLifetime>
        ) : (
          <>
            {header}
            {progress}
            {banner}
            <div className="card-body">{message}</div>
          </>
        )}
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

/** Closes the document when the card stops showing it. A lens switch stays inside, so it doesn't close (plan C6). */
function DocLifetime({ doc, core, lens, children }: { doc: number; core: CoreClient; lens: RefObject<ShownLens | null>; children: ReactNode }) {
  useEffect(
    () => () => {
      lens.current = null
      void core.call('close', { doc }).catch(() => {})
    },
    [core, doc, lens]
  )
  return children
}

interface LensHostProps {
  core: CoreClient
  /** The immutable session of this host's document, captured by its cleanup. */
  session: number
  budget: LensBudget | null
  retained: RefObject<RetainedRendered | null>
  /** The lens on screen, for App: null while none is. */
  lens: RefObject<ShownLens | null>
  /** A line to open at, set just before a switch (a note's "Show in Raw"). */
  jumpTo: RefObject<number | undefined>
  /** A switch or Reload reuses this document's line only within the same core session. */
  place: RefObject<{ session: number; doc: number; line: number } | undefined>
  /** Whether that lens had the focus. */
  hadFocus: RefObject<boolean>
  /** Reload recorded focus before the scroller unmounted. Cleared once the lens that stays has taken it. */
  restoreFocus: RefObject<boolean>
  /** The line to open at (Reopen, plan C7). */
  atLine: number | undefined
  opened: Opened
  name: string
  lines: number
  indexed: boolean
  limits: Limits
  frozen: boolean
  mode: 'raw' | 'rendered'
  build?: MdBuild
  onFrozen(why: string): void
  onShowRaw(line: number): void
  onOpenLocal(target: string): Promise<boolean>
}

/** Mounts Raw or Rendered into the card body. A switch or Reload of this document keeps the previous lens's top line. */
function LensHost({ core, session, budget, retained, lens, jumpTo, place, hadFocus, restoreFocus, atLine, opened, name, lines, indexed, limits, frozen, mode, build, onFrozen, onShowRaw, onOpenLocal }: LensHostProps) {
  const host = useRef<HTMLDivElement>(null)
  const onFrozenNow = useRef(onFrozen)
  onFrozenNow.current = onFrozen
  const onShowRawNow = useRef(onShowRaw)
  onShowRawNow.current = onShowRaw
  const onOpenLocalNow = useRef(onOpenLocal)
  onOpenLocalNow.current = onOpenLocal
  useEffect(() => {
    // `place` outlives the document. Use it only for the document that saved it, so a second file opens at `atLine`
    // (or the top). Clear it only after that check: Reload is the same document, and its line has to survive.
    const saved = place.current?.session === session && place.current.doc === opened.doc ? place.current.line : undefined
    const at = saved ?? jumpTo.current ?? atLine
    if (saved !== undefined) place.current = undefined
    jumpTo.current = undefined
    const onFrozenHere = (why: string) => onFrozenNow.current(why)
    let view: ShownLens
    if (mode === 'rendered' && build) {
      const kept = retained.current
      if (kept?.session === session && kept.doc === opened.doc && kept.gen === opened.gen) {
        view = kept.view
        kept.view.resume(host.current!, at)
      } else {
        kept?.view.dispose()
        const made = new RenderedLens(host.current!, core, opened, build, limits, {
          onFrozen: onFrozenHere, atLine: at, onShowRaw: (line) => onShowRawNow.current(line),
          onOpenLocal: (target) => onOpenLocalNow.current(target), budget: budget ?? undefined
        })
        retained.current = { session, doc: opened.doc, gen: opened.gen, view: made }
        view = made
      }
    } else view = new RawLens(host.current!, core, opened, name, limits, { onFrozen: onFrozenHere, atLine: at, budget: budget ?? undefined })
    lens.current = view
    // A Markdown reload mounts Raw first, then Rendered. Focusing Raw would consume the flag before Rendered exists.
    const interim = restoreFocus.current && mode === 'raw' && opened.format === 'markdown' && !opened.blank
    if (!interim && (hadFocus.current || restoreFocus.current)) view.focus()
    if (restoreFocus.current && !interim) restoreFocus.current = false
    return () => {
      hadFocus.current = view.element.contains(document.activeElement)
      // A note's Show in Raw wins over the line on screen for the lens this cleanup mounts next.
      place.current = { session, doc: opened.doc, line: jumpTo.current ?? view.topLine() }
      jumpTo.current = undefined
      if (lens.current === view) lens.current = null
      if (view instanceof RenderedLens && budget?.current(opened.gen) && retained.current?.view === view) view.pause()
      else view.dispose(false)
    }
  }, [core, session, budget, retained, opened, name, limits, lens, atLine, mode, build, jumpTo, place, hadFocus, restoreFocus])
  useEffect(() => lens.current?.setLineCount(lines), [lines])
  useEffect(() => {
    if (indexed) lens.current?.indexDone()
  }, [indexed])
  useEffect(() => {
    if (frozen) lens.current?.freeze()
  }, [frozen])
  return <div className={mode === 'rendered' ? 'rendered-host' : 'raw-host'} ref={host} data-gen={opened.gen} data-lens={mode} />
}
