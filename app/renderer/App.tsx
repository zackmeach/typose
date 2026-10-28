import { type RefObject, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components'
import type { Command, Limits, MdBuild, Opened } from '../shared/protocol'
import { type Action, type Card, fileName, view } from './card'
import { type CoreClient, CoreCallError } from './core'
import { RenderedLens, renderedCharge } from './lenses/rendered'
import { LensBudget, type ReloadReservation } from './lenses/lens-budget'
import { ROW_HEIGHT, RawLens, viewportCap } from './lenses/raw'
import { AppMenu, LINUX } from './menu'
import { inputMark, markNow, markPainted } from './perf'
import { WorkspaceStore, WorkspaceMetadataQueue, type SelectionTicket, type TabId, type WorkspaceTab } from './workspace'
import { FileTabs } from './file-tabs'
import { WorkspaceBudget } from './workspace-budget'

/** macOS has its native menu bar and traffic lights in place of the glyph and ☰ (brief §3.1). */
const MAC = navigator.platform.startsWith('Mac')

/** Z37's scan marks (plan A's veto, `afc58f9`), on the renderer's User Timing timeline: the gate reads them. */
const MARKS = ['typose:open-start', 'typose:first-screen', 'typose:line-scan', 'typose:index-done']
const markOnce = (name: string) => performance.getEntriesByName(name).length === 0 && performance.mark(name)

/** Enough lines for the first screen and its overscan (Z37); the rest follow as pages. */
const firstCount = (l: Limits) => Math.min(l.maxItems, 3 * Math.ceil(window.innerHeight / ROW_HEIGHT) + 1)

/** The test-hooks build's way in for the e2e tests (plan m8): App's own close, as the empty card's would do it. */
export const appHooks: { close?: () => void; workspace?: () => ReturnType<WorkspaceBudget['snapshot']> | null } = {}

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
 * One-card workspace (brief §3.1, §3.6). React renders permanent file pills and the frame; one lens is a
 * framework-free controller mounted into the card body (spec §5.1, Z26). Markdown's switch is React Aria's
 * tablist (brief §9).
 */
export function App({ core }: { core: CoreClient }) {
  const [workspace] = useState(() => new WorkspaceStore())
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const [card, setCardState] = useState<Card>({ kind: 'connecting' })
  const [limits, setLimits] = useState<Limits | null>(null)
  const [workspaceNotice, setWorkspaceNotice] = useState('')
  const workspaceBudget = useRef<WorkspaceBudget | null>(null)
  const workspacePeak = useRef(0)
  const [metadataQueue] = useState(() => new WorkspaceMetadataQueue())
  /** Pending local replacements pay their metadata alongside all already published tabs. */
  const pendingWorkspace = useRef(new Map<TabId, { units: number }>())
  const pendingNative = useRef(new Set<symbol>())
  const [session, setSession] = useState(0)
  const currentSession = useRef(0)
  const displayed = useRef<TabId | null>(null)
  const latest = useRef({ card, limits })
  latest.current = { card, limits }
  /** Reloads serialize per native document, without blocking another tab. */
  const reloading = useRef(new Set<TabId>())
  const activationFailed = useRef(new Set<TabId>())
  /** The document and generation on screen, set as soon as its reply arrives (progress events can't wait for React). */
  const live = useRef<{ session: number; doc: number; gen: number } | null>(null)
  /** Retained activation can be canceled before a lens exists and before its first-page reply reaches App. */
  const pendingActivation = useRef<{ session: number; doc: number; gen: number; operation: symbol; selection: SelectionTicket } | null>(null)
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
  /** Files named before the first handshake retain arrival order. */
  const waiting = useRef<string[]>([])
  /** Plan C1: the next lens's viewport-only cache cap, reserved with the open's floor: the shown lens's height, else the
   *  window's, which bounds the card's. */
  const floorBytes = (l: Limits) => lens.current?.floorBytes() ?? viewportCap(l, window.innerHeight)
  const path = 'path' in card ? card.path : undefined
  const title = path ? `${fileName(path)} — Typose` : 'Typose'
  const shown = view(card)
  const openedNow = card.kind === 'open' ? card.opened : null

  /** Selected payload lives here alone; the workspace stores only scalar metadata. */
  function setCard(update: Card | ((before: Card) => Card)): void {
    const next = typeof update === 'function' ? update(latest.current.card) : update
    latest.current.card = next
    setCardState(next)
    if (next.kind === 'open') workspace.updateDocument({ session: currentSession.current, doc: next.opened.doc, gen: next.opened.gen },
      (stored) => ({ ...next, opened: stored.opened }))
  }

  function display(id: TabId | null, next: Card): void {
    if (id !== displayed.current) picked.current = id ? workspace.tab(id)?.preferredLens ?? null : null
    displayed.current = id
    setCard(next)
  }

  function displays(tab: WorkspaceTab): boolean {
    const current = latest.current.card
    return displayed.current === tab.id && current.kind === 'open' && tab.card.kind === 'open' &&
      live.current?.session === tab.session && live.current.doc === tab.card.opened.doc && live.current.gen === tab.card.opened.gen &&
      current.opened.doc === tab.card.opened.doc && current.opened.gen === tab.card.opened.gen
  }

  const budgetFor = (opened: Pick<Opened, 'doc' | 'gen'>): LensBudget | null => {
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

  /** Freeze image grants before snapshotting the retired tree; inactive tabs retain no lens DOM. */
  function leave(): void {
    const native = live.current ?? pendingActivation.current // replacement metadata may already name a different document
    hadFocus.current = lens.current?.element.contains(document.activeElement) ?? false
    const id = displayed.current
    if (id) {
      const tab = workspace.tab(id)
      if (tab && displays(tab)) workspace.remember(id, lens.current?.topLine() ?? tab.anchor ?? 0, picked.current)
    }
    const owner = budget.current
    if (owner) owner.reloadReservation(owner.rawReserved)
    lens.current?.yieldReservation()
    retireBudget()
    discardRendered()
    lens.current?.dispose(false)
    lens.current = null
    live.current = null
    holding.current = null
    if (native && native.session === currentSession.current && workspace.getSnapshot().ready)
      void core.call('deactivate', { doc: native.doc, gen: native.gen }).catch(() => {})
  }

  function closeNative(tab: WorkspaceTab): void {
    if (tab.session === currentSession.current && tab.card.kind === 'open')
      void core.call('close', { doc: tab.card.opened.doc }).catch(() => {})
  }

  /** A fresh open that missed selection remains owned, but must not retain the one active cache share. */
  function deactivateInactive(native: { session: number; doc: number; gen: number }): void {
    if (native.session !== currentSession.current || !workspace.getSnapshot().ready) return
    const selected = workspace.getSnapshot().selected
    const tab = selected ? workspace.tab(selected) : undefined
    const matches = (ref: { session: number; doc: number; gen: number } | null) =>
      ref?.session === native.session && ref.doc === native.doc && ref.gen === native.gen
    const activating = pendingActivation.current
    if (tab?.session === native.session && tab.card.kind === 'open' && tab.card.opened.doc === native.doc && tab.card.opened.gen === native.gen &&
      (matches(live.current) || matches(activating) && activating && workspace.selected(activating.selection))) return
    void core.call('deactivate', { doc: native.doc, gen: native.gen }).catch(() => {})
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
      leave()
      if (workspaceBudget.current) workspacePeak.current = Math.max(workspacePeak.current, workspaceBudget.current.snapshot().peakBytes)
      workspaceBudget.current?.invalidate()
      workspaceBudget.current = null
      metadataQueue.invalidate()
      pendingWorkspace.current.clear()
      pendingNative.current.clear()
      workspace.coreGone(currentSession.current)
      const selected = workspace.getSnapshot().selected
      const tab = selected ? workspace.tab(selected) : undefined
      display(selected, tab?.card.kind === 'gone' ? tab.card : { kind: 'gone', ready: false })
    })
    const offReady = core.onReady((hello) => {
      const reconnect = currentSession.current !== 0
      currentSession.current = hello.session
      setSession(hello.session)
      latest.current.limits = hello.limits
      setLimits(hello.limits)
      workspace.coreReady(hello.session)
      workspaceBudget.current = new WorkspaceBudget(core, hello.session, workspacePeak.current)
      if (workspace.getSnapshot().tabs.length) void metadata((current) => chargeWorkspace(workspace.getSnapshot().tabs, current))
      reloading.current.clear()
      activationFailed.current.clear()
      setCard((c) => (c.kind === 'gone' ? { ...c, ready: true } : c))
      if (reconnect) {
        const paths = waiting.current.splice(0)
        void (async () => { for (const path of paths) await open(path) })()
      }
    })
    // Subscribed before any open, so no event is missed between the open reply and the lens mounting.
    const offProgress = core.onProgress((e) => {
      workspace.progress(e)
      if (live.current?.session !== e.session || live.current.doc !== e.doc || live.current.gen !== e.gen) return // another document's, or an old generation's
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
      const command = MAC ? e.metaKey : e.ctrlKey
      if (command && e.key.toLowerCase() === 'w' && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (workspace.getSnapshot().selected) close()
        else if (MAC) window.close()
        return
      }
      const next = e.ctrlKey && e.key === 'Tab' && !e.metaKey && !e.altKey ? (e.shiftKey ? -1 : 1)
        : !MAC && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'PageDown' || e.key === 'PageUp') ? (e.key === 'PageDown' ? 1 : -1)
          : MAC && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === ']' || e.key === '[') ? (e.key === ']' ? 1 : -1) : 0
      if (next) {
        e.preventDefault()
        const state = workspace.getSnapshot()
        const index = state.tabs.findIndex((tab) => tab.id === state.selected)
        if (state.tabs.length) void selectTab(state.tabs[(index + next + state.tabs.length) % state.tabs.length].id)
        return
      }
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
        const launched = await window.typose.launchPaths()
        const initial = [...launched, ...waiting.current]
        waiting.current = []
        if (initial.length) for (const path of initial) await open(path)
        else setCard({ kind: 'empty' })
      },
      async () => {
        // The first core died before its handshake: keep the file named, for Reopen.
        const initial = [...await window.typose.launchPaths(), ...waiting.current]
        waiting.current = []
        for (const path of initial) openNamed(path)
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
    const ac = new AbortController()
    let alive = true
    const slow = window.setTimeout(() => {
      setCard((c) => (c.kind === 'open' && c.opened === opened && !c.build && !c.renderedOff ? { ...c, rendering: true } : c))
    }, 50)
    void (async () => {
      try {
        const saved = displayed.current ? workspace.tab(displayed.current)?.card : undefined
        if (saved?.kind === 'open' && saved.renderedOff) return
        const build = saved?.kind === 'open' && saved.opened.doc === opened.doc && saved.opened.gen === opened.gen && saved.build
          ? saved.build : await core.call('render', { doc: opened.doc, gen: opened.gen }, ac.signal)
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
    const id = displayed.current
    if (id) workspace.remember(id, lens.current?.topLine() ?? 0, key)
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

  const manualKey = (path: string) => 'manual:' + path
  const pathUnits = (tabs: readonly Pick<WorkspaceTab, 'key' | 'path'>[]) => tabs.reduce((units, tab) => units + tab.key.length + tab.path.length, 0)

  /** Serialize precharge plus publication, not native opens: two callers cannot spend the same workspace allowance. */
  function metadata<T>(run: (current: () => boolean) => Promise<T>): Promise<T | null> {
    const ownerSession = currentSession.current
    return metadataQueue.run(run, () => ownerSession === currentSession.current && workspace.getSnapshot().ready)
      .finally(() => releaseEmptyWorkspace())
  }

  async function chargeWorkspace(tabs: readonly Pick<WorkspaceTab, 'key' | 'path'>[], current: () => boolean): Promise<boolean> {
    const bank = workspaceBudget.current
    const ownerSession = currentSession.current
    if (!bank || !workspace.getSnapshot().ready || !current()) return false
    const pending = [...pendingWorkspace.current.values()]
    const held = await bank.hold(tabs.length + pending.length, pathUnits(tabs) + pending.reduce((units, item) => units + item.units, 0))
    if (!current() || bank !== workspaceBudget.current || ownerSession !== currentSession.current || !workspace.getSnapshot().ready) return false
    if (!held) setWorkspaceNotice("Can't open another tab: Typose's memory budget is full")
    else setWorkspaceNotice('')
    return held
  }

  /** Empty means both the committed pills and every async controller have stopped retaining their metadata. */
  function releaseEmptyWorkspace(): void {
    window.requestAnimationFrame(() => {
      const bank = workspaceBudget.current
      if (!bank || workspace.getSnapshot().tabs.length || metadataQueue.pending || pendingNative.current.size || pendingWorkspace.current.size) return
      if (document.querySelector('.file-pill')) { releaseEmptyWorkspace(); return }
      void bank.release().then((released) => {
        if (released && bank === workspaceBudget.current && !workspace.getSnapshot().tabs.length) workspacePeak.current = 0
      })
    })
  }

  function pendingCard(tab: WorkspaceTab): Card {
    if (tab.card.kind !== 'open') return tab.card
    return { kind: 'opening', path: tab.path, slow: false, atLine: tab.anchor }
  }

  /** A selected retained document borrows its native identity. A stale activation must never close it. */
  async function selectTab(id: TabId, force = false): Promise<void> {
    const ready = workspace.getSnapshot().ready
    const selected = workspace.getSnapshot().selected
    const tab = workspace.tab(id)
    if (!tab) return
    if (!force && selected === id && displays(tab)) return
    leave()
    const selection = workspace.select(id, true)
    if (!selection) return
    picked.current = tab.preferredLens
    display(id, pendingCard(tab))
    if (tab.card.kind !== 'open' || !ready || !latest.current.limits) return
    if (!await metadata((current) => chargeWorkspace(workspace.getSnapshot().tabs, current)) || !workspace.selected(selection)) return
    const l = latest.current.limits
    const rawBytes = viewportCap(l, window.innerHeight)
    const retired = retiredRendered.current
    const operation = Symbol()
    pendingNative.current.add(operation)
    try {
      pendingActivation.current = { session: tab.session, doc: tab.card.opened.doc, gen: tab.card.opened.gen, operation, selection }
      const opened = await core.call('activate', { doc: tab.card.opened.doc, gen: tab.card.opened.gen,
        count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (!workspace.selected(selection)) return
      const current = workspace.tab(id)
      if (current?.card.kind !== 'open' || current.card.opened.doc !== opened.doc || current.card.opened.gen !== opened.gen) return
      show(id, opened, current, rawBytes, undefined, retired)
    } catch (e) {
      if (!workspace.selected(selection) || e instanceof CoreCallError && e.code === 'CoreGone') return
      if (e instanceof CoreCallError && e.code === 'Memory') activationFailed.current.add(id)
      else activationFailed.current.delete(id)
      // The tab still owns its native document. Retry activates it; Close releases it even while this message shows.
      display(id, { ...failed(tab.path, e), ...(tab.card.opened.localOnly ? { localOnly: true } : {}),
        ...(e instanceof CoreCallError && e.code === 'Frozen' ? { reloadable: true } : {}) })
    } finally {
      if (pendingActivation.current?.operation === operation) pendingActivation.current = null
      pendingNative.current.delete(operation)
      releaseEmptyWorkspace()
    }
  }

  /** Manual paths create permanent tabs; an equal caller key focuses the existing tab. */
  async function open(path: string, atLine?: number, replace?: TabId): Promise<void> {
    if (!latest.current.limits || !workspace.getSnapshot().ready) {
      waiting.current.push(path)
      if (currentSession.current) setWorkspaceNotice('Queued until the core restarts: ' + fileName(path))
      return
    }
    const request = await metadata(async (current) => {
      const state = workspace.getSnapshot()
      const existing = workspace.find(manualKey(path))
      if (existing && existing.id !== replace) {
        void selectTab(existing.id)
        return null
      }
      if (replace) {
        const tab = workspace.tab(replace)
        if (!tab || !await chargeWorkspace(state.tabs.map((item) => item.id === replace ? { key: manualKey(path), path } : item), current) || !current()) return null
        const ticket = workspace.begin(replace)
        if (!ticket) return null
        leave()
        const selection = workspace.select(replace)!
        display(replace, { kind: 'opening', path, slow: false, atLine })
        return { ticket, selection, key: manualKey(path), previous: tab }
      }
      if (!await chargeWorkspace([...state.tabs, { key: manualKey(path), path }], current) || !current()) return null
      leave()
      const result = workspace.beginOpen(manualKey(path), path)
      if (result.kind !== 'open') return null
      display(result.ticket.tab, { kind: 'opening', path, slow: false, atLine })
      return { ticket: result.ticket, selection: result.selection, key: manualKey(path), previous: undefined }
    })
    if (!request) return
    const { ticket, selection, key, previous } = request
    const l = latest.current.limits!
    const rawBytes = viewportCap(l, window.innerHeight)
    const retired = retiredRendered.current
    const operation = Symbol()
    pendingNative.current.add(operation)
    for (const mark of MARKS) performance.clearMarks(mark)
    performance.mark('typose:open-start')
    markNow('openRequested')
    inputMark('open', performance.now())
    const slow = window.setTimeout(() => {
      workspace.markSlow(ticket)
      if (workspace.selected(selection)) setCard((c) => c.kind === 'opening' ? { ...c, slow: true } : c)
    }, 300)
    try {
      const opened = await core.call('open', { path, count: firstCount(l), bytes: rawBytes + 2 * retired })
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path, opened, lines: opened.lines, bytes: 0,
        indexed: opened.indexed, atLine, lens: 'raw' }
      if (!workspace.complete(ticket, key, next)) {
        if (ticket.session === currentSession.current) void core.call('close', { doc: opened.doc }).catch(() => {})
        return
      }
      if (previous) closeNative(previous)
      const tab = workspace.tab(ticket.tab)!
      if (workspace.selected(selection)) show(ticket.tab, opened, tab, rawBytes, undefined, retired)
      else if (workspace.getSnapshot().selected === ticket.tab) void selectTab(ticket.tab)
      else deactivateInactive({ session: ticket.session, doc: opened.doc, gen: opened.gen })
    } catch (e) {
      if (!workspace.current(ticket) || e instanceof CoreCallError && e.code === 'CoreGone') return
      const error = failed(path, e)
      // Reopen/Locate keeps an already owned document on failure; a new tab keeps the bounded error metadata.
      if (previous?.card.kind === 'open') workspace.cancel(ticket)
      else workspace.complete(ticket, key, error)
      if (workspace.selected(selection)) display(ticket.tab, error)
    } finally {
      window.clearTimeout(slow)
      pendingNative.current.delete(operation)
      releaseEmptyWorkspace()
    }
  }

  /** Capability checks always precede replacement, even if a privileged manual tab has the same display path. */
  async function openLocal(source: Opened, target: string, resolvedPath: string): Promise<boolean> {
    const id = displayed.current
    const { card: c, limits: l } = latest.current
    if (!id || c.kind !== 'open' || c.opened !== source || !l || reloading.current.has(id) || pendingWorkspace.current.has(id)) return false
    const tab = workspace.tab(id)
    const selection = workspace.selection()
    if (!tab || !selection) return false
    const sourceSession = currentSession.current
    const keyBound = 'local:' + sourceSession + ':' + Number.MAX_SAFE_INTEGER
    const pending = { units: keyBound.length + resolvedPath.length }
    pendingWorkspace.current.set(id, pending)
    let plan: ReloadReservation | undefined
    let owner: LensBudget | null = null
    try {
      // Count the pending path in every concurrent precharge, before any native holder changes.
      const paid = await metadata(async (current) => workspace.selected(selection) && latest.current.card.kind === 'open' &&
        latest.current.card.opened === source && await chargeWorkspace(workspace.getSnapshot().tabs, current) && current())
      if (!paid || !workspace.selected(selection) || latest.current.card.kind !== 'open' || latest.current.card.opened !== source) return false
      const ticket = workspace.begin(id)
      if (!ticket) return false
      const rawBytes = floorBytes(l)
      owner = budgetFor(source)
      plan = owner?.reloadReservation(rawBytes)
      const retired = Math.max(retiredRendered.current, plan?.retiredTreeMax ?? 0)
      try {
        const opened = await core.call('openLocal', { doc: source.doc, gen: source.gen, target,
          count: firstCount(l), bytes: rawBytes + 2 * retired })
        const key = 'local:' + sourceSession + ':' + opened.doc
        const accepted = workspace.current(ticket) && workspace.selected(selection) &&
          opened.path === resolvedPath && key.length <= keyBound.length
        if (!accepted) {
          if (workspace.selected(selection)) {
            workspace.cancel(ticket)
            if (opened.path !== resolvedPath || key.length > keyBound.length) setWorkspaceNotice("Local file changed while opening; source kept")
            void selectTab(id, true) // disposes the source before closing the temporary holder
          }
          if (sourceSession === currentSession.current) void core.call('close', { doc: opened.doc }).catch(() => {})
          return false
        }
        const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path: resolvedPath, opened, lines: opened.lines,
          bytes: 0, indexed: opened.indexed, lens: 'raw' }
        leave()
        if (!workspace.complete(ticket, key, next)) {
          if (sourceSession === currentSession.current) void core.call('close', { doc: opened.doc }).catch(() => {})
          return false
        }
        restoreFocus.current = true
        show(id, opened, workspace.tab(id)!, rawBytes, undefined, retired)
        closeNative(tab)
        return true
      } catch (e) {
        workspace.cancel(ticket)
        if (workspace.selected(selection) && e instanceof CoreCallError && e.code === 'Frozen')
          setCard((d) => d.kind === 'open' && d.opened === source ? { ...d, frozen: d.frozen ?? e.message } : d)
        return false
      }
    } finally {
      if (pendingWorkspace.current.get(id) === pending) pendingWorkspace.current.delete(id)
      if (plan) owner?.cancelTransition(plan)
      releaseEmptyWorkspace()
    }
  }

  async function reload(): Promise<void> {
    const id = workspace.getSnapshot().selected
    const tab = id ? workspace.tab(id) : undefined
    const { card: c, limits: l } = latest.current
    if (!id || !tab) return
    if (c.kind === 'failed') {
      if (tab.card.kind === 'open' && activationFailed.current.has(id)) return selectTab(id)
      if (tab.card.kind !== 'open') return c.localOnly ? pick() : open(c.path, tab.anchor, id)
    }
    const source = c.kind === 'open' ? c : c.kind === 'failed' && tab.card.kind === 'open' ? tab.card : undefined
    if (!source || !l || reloading.current.has(id)) return
    if (lens.current?.element.contains(document.activeElement)) restoreFocus.current = true
    const ticket = workspace.begin(id)
    const selection = workspace.selection()
    if (!ticket || !selection) return
    reloading.current.add(id)
    const atLine = lens.current?.topLine() ?? tab.anchor
    workspace.remember(id, atLine ?? 0, picked.current)
    const rawBytes = floorBytes(l)
    const owner = budgetFor(source.opened)
    const plan = owner?.reloadReservation(rawBytes)
    const operation = Symbol()
    pendingNative.current.add(operation)
    try {
      const opened = await core.call('reload', { doc: source.opened.doc, count: firstCount(l), bytes: plan?.bytes ?? rawBytes + 2 * retiredRendered.current })
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path: source.path, opened, lines: opened.lines, bytes: 0,
        indexed: opened.indexed, atLine, lens: 'raw' }
      if (!workspace.complete(ticket, tab.key, next)) return // borrowed native document, never close
      if (workspace.selected(selection)) show(id, opened, workspace.tab(id)!, rawBytes, plan)
      else if (workspace.getSnapshot().selected === id) void selectTab(id)
      else deactivateInactive({ session: ticket.session, doc: opened.doc, gen: opened.gen })
    } catch (e) {
      if (!workspace.current(ticket) || e instanceof CoreCallError && e.code === 'CoreGone') return
      if (e instanceof CoreCallError && e.code === 'Memory') {
        workspace.cancel(ticket)
        workspace.updateDocument({ session: ticket.session, doc: source.opened.doc, gen: source.opened.gen }, (stored) => ({ ...stored, refused: true }))
        if (workspace.getSnapshot().selected !== id) return
        if (latest.current.card.kind === 'open')
          setCard((d) => d.kind === 'open' && d.opened.doc === source.opened.doc && d.opened.gen === source.opened.gen ? { ...d, refused: true } : d)
        else display(id, { ...failed(source.path, e), ...(source.opened.localOnly ? { localOnly: true } : {}) })
      } else if (e instanceof CoreCallError && (e.code === 'Stale' || e.code === 'Cancelled')) {
        workspace.cancel(ticket) // selection cancellation is not a terminal filesystem failure
        if (workspace.getSnapshot().selected === id) {
          if (displayed.current === id) leave()
          display(id, { ...failed(source.path, e), ...(source.opened.localOnly ? { localOnly: true } : {}), reloadable: true })
        }
      } else {
        const error: Extract<Card, { kind: 'failed' }> = { ...failed(source.path, e), ...(source.opened.localOnly ? { localOnly: true } : {}) }
        const selected = workspace.getSnapshot().selected === id
        if (selected && displayed.current === id) leave()
        if (!workspace.complete(ticket, tab.key, error)) return
        closeNative(tab) // current ticket and session still own this native document, even when the tab is inactive
        if (selected) display(id, error)
      }
    } finally {
      if (plan) owner?.cancelTransition(plan)
      reloading.current.delete(id)
      pendingNative.current.delete(operation)
      releaseEmptyWorkspace()
    }
  }

  function show(id: TabId, opened: Opened, tab: WorkspaceTab, rawBytes: number, plan?: ReloadReservation, retired = retiredRendered.current): void {
    activationFailed.current.delete(id)
    discardRendered()
    const previous = budget.current
    if (!previous || previous.session !== currentSession.current || previous.doc !== opened.doc || !plan || !previous.adopt(opened.gen, opened.reserved, plan)) {
      previous?.invalidate()
      budget.current = new LensBudget(core, currentSession.current, opened.doc, opened.gen, rawBytes, opened.reserved,
        Math.max(retired, plan?.retiredTreeMax ?? 0))
    }
    live.current = { session: currentSession.current, doc: opened.doc, gen: opened.gen }
    picked.current = tab.preferredLens
    place.current = undefined
    jumpTo.current = undefined
    const saved = tab.card.kind === 'open' ? tab.card : undefined
    display(id, { ...saved, kind: 'open', path: tab.path, opened, lines: saved?.lines ?? opened.lines,
      bytes: saved?.bytes ?? 0, indexed: saved?.indexed ?? opened.indexed, atLine: tab.anchor ?? saved?.atLine, lens: 'raw', rendering: false })
  }

  async function pick(): Promise<void> {
    const chosen = await window.typose.openDialog()
    if (!chosen) return
    const tab = workspace.getSnapshot().selected
    const c = latest.current.card
    // Recovery replaces the unusable slot but obtains new manual authority from the real dialog.
    await open(chosen, undefined, tab && (c.kind === 'gone' || c.kind === 'failed') && c.localOnly ? tab : undefined)
  }

  function openNamed(path: string): void {
    if (!workspace.getSnapshot().ready) { waiting.current.push(path); return }
    void open(path)
  }

  function run(command: Command): void {
    if (command === 'open') void pick()
    else if (command === 'close-tab') {
      if (workspace.getSnapshot().selected) close()
      else if (MAC) window.close()
    } else if (command === 'reload') void reload()
    else if (command === 'exit') window.close()
  }

  /** Tab ownership closes native documents; changing the displayed card never does. */
  function close(id = workspace.getSnapshot().selected): void {
    if (!id) return
    const selected = workspace.getSnapshot().selected === id
    if (selected) leave()
    const removed = workspace.close(id)
    if (!removed) return
    if (!workspace.getSnapshot().tabs.length) {
      metadataQueue.invalidate()
      workspaceBudget.current?.cancelPending()
    }
    activationFailed.current.delete(id)
    closeNative(removed)
    if (selected) {
      const next = workspace.getSnapshot().selected
      display(null, { kind: 'empty' })
      if (next) void selectTab(next)
    }
    // UI removal commits before a zero workspace share can be released; a held precharge cannot block this.
    releaseEmptyWorkspace()
    window.requestAnimationFrame(() => {
      const next = workspace.getSnapshot().selected
      if (selected && next) document.getElementById('file-' + next)?.focus()
      else if (selected) document.querySelector<HTMLElement>('.card-state button')?.focus()
    })
  }
  if (__TEST_HOOKS__) {
    appHooks.close = () => close()
    appHooks.workspace = () => workspaceBudget.current?.snapshot() ?? null
  }

  const actions: Record<Action, () => void> = {
    'Open file…': () => void pick(),
    'Locate…': () => void pick(),
    Retry: () => void reload(),
    Reload: () => void reload(),
    Close: () => close(),
    Reopen: () => {
      const id = workspace.getSnapshot().selected
      if (id && card.kind === 'gone' && !card.localOnly && card.path) void open(card.path, card.line, id)
    }
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
        onOpenLocal={(target, path) => openLocal(card.opened, target, path)}
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
        onOpenLocal={(target, path) => openLocal(card.opened, target, path)}
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
      <FileTabs tabs={snapshot.tabs} selected={snapshot.selected} onSelect={(id) => void selectTab(id)} onClose={(id) => close(id)} />
      <main className="card">
        <div className="file-card-panel" id="file-card" role={snapshot.selected ? 'tabpanel' : undefined} aria-labelledby={snapshot.selected ? `file-label-${snapshot.selected}` : undefined}>
        {workspaceNotice ? <div className="banner" role="status">{workspaceNotice}</div> : null}
        {card.kind === 'open' ? (
          <>
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
          </>
        ) : (
          <>
            {header}
            {progress}
            {banner}
            <div className="card-body">{message}</div>
          </>
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
  onOpenLocal(target: string, path: string): Promise<boolean>
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
          onOpenLocal: (target, path) => onOpenLocalNow.current(target, path), budget: budget ?? undefined
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
      if (view.element.isConnected) hadFocus.current = view.element.contains(document.activeElement)
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
