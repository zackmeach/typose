import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Dialog, DialogTrigger, Menu, MenuItem, MenuTrigger, Popover, Tab, TabList, TabPanel, Tabs } from 'react-aria-components'
import type { CapturedLocation, CsvInfo, CsvOptions, Hello, Limits, MdBuild, Methods, Opened, SurfaceRef, ViewRef } from '../shared/protocol'
import { type Action, type Card, fileName, parentName, view } from './card'
import { FileIcon } from './file-icon'
import { type CoreClient, CoreCallError } from './core'
import { RenderedLens, renderedCharge } from './lenses/rendered'
import { LensBudget, type ReloadReservation } from './lenses/lens-budget'
import { ROW_HEIGHT, RawLens, viewportCap } from './lenses/raw'
import { GridLens } from './lenses/grid'
import './grid.css'
import { inputMark, markNow } from './perf'
import { type SavedLocation, type SelectionTicket, type TabId, type WorkspaceStore, type WorkspaceTab } from './workspace'
import { FileTabs } from './file-tabs'
import { folderNode } from './folders'
import type { LocalGesture, ReaderHandle, ReaderWindow } from './reader-window'

/** Z37's scan marks (plan A's veto, `afc58f9`), on the renderer's User Timing timeline: the gate reads them. */
const MARKS = ['typose:open-start', 'typose:first-screen', 'typose:line-scan', 'typose:index-done']
const markOnce = (name: string) => performance.getEntriesByName(name).length === 0 && performance.mark(name)

/** Enough lines for the first screen and its overscan (Z37); the rest follow as pages. */
const firstCount = (l: Limits) => Math.min(l.maxItems, 3 * Math.ceil(window.innerHeight / ROW_HEIGHT) + 1)
const CSV_OPTIONS: CsvOptions = { delimiter: 'auto', header: 'auto' }

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

export function ReaderCard({ id, label, workspace, window: shared, fonts, focused, onFocus, onCloseCard, windowNotice, preview }: {
  id: string; label: number; workspace: WorkspaceStore; window: ReaderWindow; fonts: Promise<void>; focused: boolean
  onFocus(): void; onCloseCard(): void; windowNotice: string
  preview?: { busy: boolean; onTab(): void; onSide(): void; onClose(): void }
}) {
  const core = shared.core
  const [fontLayoutReady, setFontLayoutReady] = useState(false)
  useEffect(() => { let alive = true; void fonts.then(() => { if (alive) setFontLayoutReady(true) }); return () => { alive = false } }, [fonts])
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const [card, setCardState] = useState<Card>({ kind: 'connecting' })
  const [limits, setLimits] = useState<Limits | null>(null)
  const [workspaceNotice, setWorkspaceNotice] = useState('')
  const closed = shared.closed
  const navigating = useRef(false)
  const [navigationBusy, setNavigationBusy] = useState(false)
  const pendingHistoryBytes = { get current() { return shared.pendingHistory.get(id) ?? 0 }, set current(bytes: number) { shared.pendingHistory.set(id, bytes) } }
  const recharged = shared.recharged
  const folders = shared.folders
  const metadataQueue = shared.queue
  const pendingWorkspace = shared.pendingWorkspace
  const pendingNative = shared.pendingNative
  const [session, setSession] = useState(0)
  const currentSession = useRef(0)
  const surface = useRef<SurfaceRef | null>(null)
  const closing = useRef(false)
  const readyWaiters = useRef<(() => void)[]>([])
  const readyError = useRef<Error | null>(null)
  const abort = useRef(new AbortController())
  const requests = useRef(new Set<Promise<Opened>>())
  const displayed = useRef<TabId | null>(null)
  const latest = useRef({ card, limits })
  latest.current = { card, limits }
  const reloading = useRef(new Set<TabId>())
  const activationFailed = useRef(new Set<TabId>())
  const live = useRef<{ session: number; doc: number; gen: number; view?: ViewRef } | null>(null)
  const pendingActivation = useRef<{ session: number; doc: number; gen: number; operation: symbol; selection: SelectionTicket } | null>(null)
  const lens = useRef<ShownLens | null>(null)
  const picked = useRef<'raw' | 'rendered' | 'grid' | null>(null)
  const [csvChanging, setCsvChanging] = useState(false)
  const csvChangingNow = useRef(false)
  const jumpTo = useRef<number | undefined>(undefined)
  const place = useRef<{ session: number; doc: number; line: number } | undefined>(undefined)
  const hadFocus = useRef(false)
  const restoreFocus = useRef(false)
  const holding = useRef<Opened | null>(null)
  const budget = useRef<LensBudget | null>(null)
  const retiredRendered = useRef(0)
  const rendered = useRef<RetainedRendered | null>(null)
  const waiting = useRef<string[]>([])
  const floorBytes = (l: Limits) => lens.current?.floorBytes() ?? viewportCap(l, 800)
  const path = 'path' in card ? card.path : undefined
  const title = path ? `${fileName(path)} — Typose` : 'Typose'
  const shown = view(card)
  const openedNow = card.kind === 'open' ? card.opened : null
  useEffect(() => { shared.report(id, title, openedNow?.folder?.node ? openedNow.folder.root + ':' + openedNow.folder.node : undefined) }, [title, openedNow])

  function ownerCall<M extends 'open' | 'openLocal' | 'openSaved' | 'openChild' | 'activate' | 'reload'>(method: M, params: Methods[M]['params']): Promise<Opened> {
    if (!surface.current || closing.current) return Promise.reject(new CoreCallError('Stale', 'The reader card is unavailable'))
    const request = core.call(method, { ...params, surface: surface.current }, abort.current.signal) as Promise<Opened>
    requests.current.add(request)
    void request.then(() => requests.current.delete(request), () => requests.current.delete(request))
    return request
  }

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
    const snapshot = owner.snapshot()
    retiredRendered.current = Math.max(retiredRendered.current, snapshot.rendered + snapshot.grid, owner.retiredTreeMax)
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
    if (native && 'view' in native && native.view && native.session === currentSession.current)
      void core.call('deactivate', { view: native.view }).catch(() => {})
  }

  function closeNative(tab: WorkspaceTab): void {
    if (tab.session === currentSession.current && tab.card.kind === 'open')
      void core.call('close', { surface: surface.current!, doc: tab.card.opened.doc }).catch(() => {})
  }

  function disposedView(opened: Opened): void {
    const old = opened.view, active = live.current?.view
    if (old && old.session === currentSession.current && (!active || active.surface !== old.surface || active.id !== old.id))
      void core.call('deactivate', { view: old }).catch(() => {})
  }

  /** A fresh open that missed selection remains owned, but must not retain the one active cache share. */
  function deactivateInactive(native: { session: number; doc: number; gen: number; view?: ViewRef }): void {
    if (native.session !== currentSession.current || !workspace.getSnapshot().ready) return
    const current = live.current?.view
    if (native.view && current && native.view.session === current.session && native.view.surface === current.surface && native.view.id === current.id) return
    if (native.view) void core.call('deactivate', { view: native.view }).catch(() => {})
  }

  useEffect(() => {
    let alive = true
    let requestedSession = 0
    const gone = core.onGone(() => {
      leave()
      surface.current = null
      abort.current.abort()
      workspace.coreGone(currentSession.current)
      const selected = workspace.getSnapshot().selected
      const tab = selected ? workspace.tab(selected) : undefined
      display(selected, tab?.card.kind === 'gone' ? tab.card : { kind: 'gone', ready: false })
    })
    const ready = async (hello: Hello) => {
      if (hello.session <= requestedSession) return
      requestedSession = hello.session
      let made: SurfaceRef
      try { made = await core.call('createSurface', {}); readyError.current = null }
      catch (error) {
        requestedSession = 0
        readyError.current = error instanceof Error ? error : new Error(String(error))
        setWorkspaceNotice('Cannot create reader card · ' + readyError.current.message)
        for (const done of readyWaiters.current.splice(0)) done()
        return
      }
      if (!alive || shared.hello.current?.session !== hello.session) {
        if (shared.hello.current?.session === made.session) void core.call('releaseSurface', { surface: made, retiredBytes: 0 }).catch(() => {})
        return
      }
      surface.current = made
      abort.current = new AbortController()
      currentSession.current = hello.session
      setSession(hello.session)
      latest.current.limits = hello.limits
      setLimits(hello.limits)
      workspace.coreReady(hello.session)
      await shared.paid()
      if (!alive || shared.hello.current?.session !== hello.session) return
      reloading.current.clear()
      activationFailed.current.clear()
      setCard(c => c.kind === 'gone' ? { ...c, ready: true } : c.kind === 'connecting' ? { kind: 'empty' } : c)
      for (const done of readyWaiters.current.splice(0)) done()
      for (const path of waiting.current.splice(0)) await open(path)
    }
    const readyOff = core.onReady(hello => { void ready(hello).catch(e => setWorkspaceNotice(String(e))) })
    if (shared.hello.current) void ready(shared.hello.current).catch(e => setWorkspaceNotice(String(e)))
    const offProgress = core.onProgress((e) => {
      workspace.progress(e)
      if (live.current?.session !== e.session || live.current.doc !== e.doc || live.current.gen !== e.gen) return
      if (e.lines > 1 || e.done) markOnce('typose:line-scan')
      if (e.done) markOnce('typose:index-done')
      setCard(c => c.kind === 'open' && c.opened.doc === e.doc && c.opened.gen === e.gen
        ? { ...c, lines: e.lines, bytes: e.bytes, indexed: e.done, frozen: e.error ?? c.frozen } : c)
    })
    return () => { alive = false; gone(); readyOff(); offProgress(); abort.current.abort(); for (const done of readyWaiters.current.splice(0)) done() }
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

  useEffect(() => {
    if (!openedNow || openedNow.format !== 'csv' || openedNow.blank) return
    const opened = openedNow, ac = new AbortController()
    let alive = true
    const options = latest.current.card.kind === 'open' ? latest.current.card.csvOptions ?? CSV_OPTIONS : CSV_OPTIONS
    void core.call('csvConfigure', { surface: surface.current ?? undefined, doc: opened.doc, gen: opened.gen, options }, ac.signal).then(info => {
      if (!alive) return
      const go = info.status !== 'locked' && (picked.current === 'grid' || picked.current !== 'raw' && !lens.current?.readerMoved())
      setCard(c => c.kind === 'open' && c.opened === opened ? { ...c, csv: info, csvOptions: options,
        gridOff: info.status === 'locked' ? info.reason || 'Grid is unavailable' : undefined, lens: go ? 'grid' : 'raw' } : c)
    }, error => {
      if (alive) setCard(c => c.kind === 'open' && c.opened === opened ? { ...c, gridOff: String(error), lens: 'raw' } : c)
    })
    return () => { alive = false; ac.abort() }
  }, [openedNow, core])

  async function configureCsv(options: CsvOptions): Promise<void> {
    const c = latest.current.card
    if (c.kind !== 'open' || c.opened.format !== 'csv' || csvChangingNow.current) return
    csvChangingNow.current = true
    setCsvChanging(true)
    const before = lens.current
    before?.yieldReservation()
    let changed = false
    try {
      const info = await core.call('csvConfigure', { surface: surface.current ?? undefined, doc: c.opened.doc, gen: c.opened.gen, options })
      changed = latest.current.card.kind === 'open' && latest.current.card.opened === c.opened
      setCard(d => d.kind === 'open' && d.opened === c.opened ? { ...d, csv: info, csvOptions: options,
        gridOff: info.status === 'locked' ? info.reason || 'Grid is unavailable' : undefined,
        lens: info.status === 'locked' ? 'raw' : d.lens } : d)
    } catch (error) { setWorkspaceNotice('Cannot change CSV options · ' + String(error)) }
    finally {
      if (lens.current === before && (!changed || latest.current.card.kind === 'open' && latest.current.card.lens === 'raw')) before?.resumeReservation()
      csvChangingNow.current = false
      setCsvChanging(false)
    }
  }

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
    if (key !== 'raw' && key !== 'rendered' && key !== 'grid') return
    const c = latest.current.card
    if (c.kind !== 'open' || (c.lens ?? 'raw') === key) return
    picked.current = key
    const id = displayed.current
    if (id) workspace.remember(id, lens.current?.topLine() ?? 0, key)
    if (key === 'raw') {
      setCard((d) => (d.kind === 'open' && d.opened === c.opened ? { ...d, lens: 'raw' } : d))
      return
    }
    if (key === 'grid') {
      if (!c.csv || c.gridOff) return
      setCard(d => d.kind === 'open' && d.opened === c.opened ? { ...d, lens: 'grid' } : d)
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
  function metadata<T>(run: (current: () => boolean) => Promise<T>): Promise<T | null> {
    const ownerSession = currentSession.current
    return metadataQueue.run(run, () => !closing.current && ownerSession === currentSession.current && workspace.getSnapshot().ready)
      .finally(() => releaseEmptyWorkspace())
  }
  function chargeWorkspace(tabs: readonly Pick<WorkspaceTab, 'key' | 'path'>[], current: () => boolean): Promise<boolean> {
    return shared.charge(workspace, tabs, current)
  }
  function releaseEmptyWorkspace(): void { shared.release() }

  function pendingCard(tab: WorkspaceTab): Card {
    if (tab.card.kind !== 'open') return tab.card
    return { kind: 'opening', path: tab.path, slow: false, atLine: tab.anchor }
  }

  /** A selected retained document borrows its native identity. A stale activation must never close it. */
  async function selectTab(id: TabId, force = false): Promise<void> {
    if (navigating.current && !force || !recharged.current) return
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
      const opened = await ownerCall('activate', { doc: tab.card.opened.doc, gen: tab.card.opened.gen,
        count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (!workspace.selected(selection)) { deactivateInactive({ session: tab.session, ...opened }); return }
      const current = workspace.tab(id)
      if (current?.card.kind !== 'open' || current.card.opened.doc !== opened.doc || current.card.opened.gen !== opened.gen) { deactivateInactive({ session: tab.session, ...opened }); return }
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
    if (!latest.current.limits || !workspace.getSnapshot().ready || !surface.current) {
      waiting.current.push(path)
      if (currentSession.current) setWorkspaceNotice('Queued until the core restarts: ' + fileName(path))
      return
    }
    if (closing.current || navigating.current || !recharged.current) { setWorkspaceNotice('Finish the current operation before opening another file'); return }
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
      const opened = await ownerCall('open', { path, count: firstCount(l), bytes: rawBytes + 2 * retired })
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path, opened, lines: opened.lines, bytes: 0,
        indexed: opened.indexed, atLine, lens: 'raw' }
      if (!workspace.complete(ticket, key, next)) {
        if (ticket.session === currentSession.current) void core.call('close', { surface: surface.current!, doc: opened.doc }).catch(() => {})
        return
      }
      if (previous) closeNative(previous)
      const tab = workspace.tab(ticket.tab)!
      if (workspace.selected(selection)) show(ticket.tab, opened, tab, rawBytes, undefined, retired)
      else if (workspace.getSnapshot().selected === ticket.tab) void selectTab(ticket.tab)
      else deactivateInactive({ session: ticket.session, doc: opened.doc, gen: opened.gen, view: opened.view })
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
    if (!id || c.kind !== 'open' || c.opened !== source || !l || navigating.current || !recharged.current || reloading.current.has(id) || pendingWorkspace.current.has(id)) return false
    const tab = workspace.tab(id)
    const selection = workspace.selection()
    if (!tab || !selection) return false
    const sourceSession = currentSession.current
    const keyBound = 'local:' + sourceSession + ':' + Number.MAX_SAFE_INTEGER
    const pending = { units: keyBound.length + resolvedPath.length }
    pendingWorkspace.current.set(id, pending)
    let plan: ReloadReservation | undefined
    let owner: LensBudget | null = null
    let captured: CapturedLocation | undefined
    navigating.current = true
    setNavigationBusy(true)
    pendingHistoryBytes.current = historyDraftBytes(l)
    try {
      // Count the pending path in every concurrent precharge, before any native holder changes.
      const paid = await metadata(async (current) => workspace.selected(selection) && latest.current.card.kind === 'open' &&
        latest.current.card.opened === source && await chargeWorkspace(workspace.getSnapshot().tabs, current) && current())
      if (!paid || !workspace.selected(selection) || latest.current.card.kind !== 'open' || latest.current.card.opened !== source) return false
      captured = await core.call('captureLocation', { doc: source.doc, gen: source.gen })
      if (!workspace.selected(selection)) return false
      const ticket = workspace.begin(id)
      if (!ticket) return false
      const rawBytes = floorBytes(l)
      owner = budgetFor(source)
      plan = owner?.reloadReservation(rawBytes)
      const retired = Math.max(retiredRendered.current, plan?.retiredTreeMax ?? 0)
      try {
        const opened = await ownerCall('openLocal', { doc: source.doc, gen: source.gen, target,
          count: firstCount(l), bytes: rawBytes + 2 * retired })
        const key = 'local:' + sourceSession + ':' + opened.doc
        const accepted = workspace.current(ticket) && workspace.selected(selection) &&
          opened.path === resolvedPath && key.length <= keyBound.length
        if (!accepted) {
          if (workspace.selected(selection)) {
            workspace.cancel(ticket)
            if (opened.path !== resolvedPath || key.length > keyBound.length) setWorkspaceNotice("Local file changed while opening; source kept")
            // The single-flight guard keeps this source selected while its native holder is restored.
            const restored = await ownerCall('activate', { doc: source.doc, gen: source.gen, count: firstCount(l), bytes: plan?.bytes ?? rawBytes }).catch(() => null)
            if (restored) deactivateInactive({ session: sourceSession, ...restored })
          }
          if (sourceSession === currentSession.current) void core.call('close', { surface: surface.current!, doc: opened.doc }).catch(() => {})
          return false
        }
        const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path: resolvedPath, opened, lines: opened.lines,
          bytes: 0, indexed: opened.indexed, lens: 'raw' }
        const entry: SavedLocation = { location: captured, path: tab.path, anchor: lens.current?.topLine() ?? tab.anchor ?? 0, lens: picked.current, csvOptions: tab.card.kind === 'open' ? tab.card.csvOptions : undefined }
        if (!workspace.complete(ticket, key, next, { push: entry })) {
          if (sourceSession === currentSession.current) void core.call('close', { surface: surface.current!, doc: opened.doc }).catch(() => {})
          return false
        }
        leave()
        captured = undefined
        restoreFocus.current = true
        show(id, opened, workspace.tab(id)!, rawBytes, undefined, retired)
        closeNative(tab)
        return true
      } catch (e) {
        workspace.cancel(ticket)
        setWorkspaceNotice('Cannot open local file · ' + (e instanceof Error ? e.message : String(e)))
        if (workspace.selected(selection) && e instanceof CoreCallError && e.code === 'Frozen')
          setCard((d) => d.kind === 'open' && d.opened === source ? { ...d, frozen: d.frozen ?? e.message } : d)
        return false
      }
    } catch (e) {
      setWorkspaceNotice('Cannot open local file · ' + (e instanceof Error ? e.message : String(e)))
      return false
    } finally {
      if (captured) releaseLocation(captured)
      if (pendingWorkspace.current.get(id) === pending) pendingWorkspace.current.delete(id)
      if (plan) owner?.cancelTransition(plan)
      pendingHistoryBytes.current = 0
      navigating.current = false
      setNavigationBusy(false)
      releaseEmptyWorkspace()
    }
  }

  function routeLocal(source: Opened, target: string, path: string, gesture: LocalGesture): Promise<boolean> {
    const current = latest.current.card
    if (current.kind !== 'open' || current.opened !== source || navigating.current || closing.current) return Promise.resolve(false)
    return shared.openLink(id, source, target, path, gesture)
  }

  /** A target card opens only through the originating document's held capability, never its display path. */
  async function openDerived(source: Opened, target: string, resolvedPath: string): Promise<boolean> {
    const l = latest.current.limits, ownerSession = currentSession.current
    if (!l || !surface.current || !recharged.current || closing.current || navigating.current || source.view?.session !== ownerSession) return false
    navigating.current = true
    setNavigationBusy(true)
    pendingHistoryBytes.current = historyDraftBytes(l)
    let candidate: Opened | undefined
    const owner = budget.current
    let plan: ReloadReservation | undefined
    try {
      const placeholder = { key: 'local:' + ownerSession + ':' + Number.MAX_SAFE_INTEGER, path: resolvedPath }
      if (!await metadata(current => chargeWorkspace([...workspace.getSnapshot().tabs, placeholder], current))) return false
      const rawBytes = viewportCap(l, window.innerHeight)
      plan = owner?.reloadReservation(rawBytes)
      const retired = Math.max(retiredRendered.current, plan?.retiredTreeMax ?? 0)
      candidate = await ownerCall('openLocal', { doc: source.doc, gen: source.gen, target, count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (closing.current || currentSession.current !== ownerSession || candidate.path !== resolvedPath) return false
      const key = 'local:' + ownerSession + ':' + candidate.doc
      const result = workspace.beginOpen(key, resolvedPath)
      if (result.kind !== 'open') return false
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path: resolvedPath, opened: candidate,
        lines: candidate.lines, bytes: 0, indexed: candidate.indexed, lens: 'raw' }
      if (!workspace.complete(result.ticket, key, next)) return false
      leave()
      const opened = candidate
      candidate = undefined
      restoreFocus.current = true
      show(result.ticket.tab, opened, workspace.tab(result.ticket.tab)!, rawBytes, undefined, retired)
      return true
    } catch (error) {
      setWorkspaceNotice('Cannot open local file · ' + String(error))
      return false
    } finally {
      if (candidate && ownerSession === currentSession.current) void core.call('close', { surface: surface.current!, doc: candidate.doc }).catch(() => {})
      if (plan) owner?.cancelTransition(plan)
      lens.current?.resumeReservation()
      pendingHistoryBytes.current = 0
      navigating.current = false
      setNavigationBusy(false)
      releaseEmptyWorkspace()
    }
  }

  // The workspace's live + two retired graph allowance also pays the draft firstPage while source DOM stays mounted.
  const historyDraftBytes = (l: Limits, page = true) => 16_384 + 128 * 32_767 + (page ?
    256 * 16_384 + 2 * l.pageWireMax + 1024 * l.maxItems + (64 << 10) : 0)

  function releaseLocation(location: CapturedLocation): void {
    if (location.kind === 'derived' && location.ticket.session === currentSession.current)
      void core.call('releaseSaved', { ticket: location.ticket }).catch(() => {})
  }

  function clearClosed(): void {
    if (navigating.current) return
    for (const item of closed.current) releaseLocation(item.entry.location)
    closed.current = []
    setWorkspaceNotice('Recently closed tabs cleared')
    if (!recharged.current && workspace.getSnapshot().ready)
      void metadata(current => chargeWorkspace(workspace.getSnapshot().tabs, current)).then(paid => { recharged.current = !!paid })
    releaseEmptyWorkspace()
  }

  /** Open current verified bytes through the captured arm; display paths never reconstruct a derived route. */
  async function restoreLocation(entry: SavedLocation, replace?: TabId, index?: number): Promise<boolean> {
    const l = latest.current.limits
    if (!l || navigating.current || !recharged.current || !workspace.getSnapshot().ready) return false
    if (entry.location.kind === 'derived' && entry.location.ticket.session !== currentSession.current) {
      setWorkspaceNotice('Cannot reopen this local file after the core restarted · select the file again using Open file…')
      return false
    }
    navigating.current = true
    setNavigationBusy(true)
    pendingHistoryBytes.current = historyDraftBytes(l)
    const ownerSession = currentSession.current
    const source = replace ? workspace.tab(replace) : undefined
    let candidate: Opened | undefined
    let owner: LensBudget | null = null
    let plan: ReloadReservation | undefined
    try {
      if (!await metadata(current => chargeWorkspace(replace ? workspace.getSnapshot().tabs :
        [...workspace.getSnapshot().tabs, { key: 'saved:' + entry.path, path: entry.path }], current))) return false
      const rawBytes = floorBytes(l)
      owner = live.current ? budgetFor(live.current) : null
      plan = owner?.reloadReservation(rawBytes)
      const retired = Math.max(retiredRendered.current, plan?.retiredTreeMax ?? 0)
      const existing = entry.location.kind === 'manual' ? workspace.find(manualKey(entry.location.path)) : undefined
      if (existing && existing.id !== replace && existing.card.kind === 'open') {
        const activated = await ownerCall('activate', { doc: existing.card.opened.doc, gen: existing.card.opened.gen,
          count: firstCount(l), bytes: rawBytes + 2 * retired })
        if (ownerSession !== currentSession.current || closing.current) { deactivateInactive({ session: ownerSession, ...activated }); return false }
        leave()
        workspace.select(existing.id, true)
        workspace.remember(existing.id, entry.anchor, entry.lens)
        workspace.updateDocument({ session: ownerSession, doc: activated.doc, gen: activated.gen }, stored => ({ ...stored, csvOptions: entry.csvOptions }))
        restoreFocus.current = true
        show(existing.id, activated, workspace.tab(existing.id)!, rawBytes, undefined, retired)
        return true
      }
      candidate = entry.location.kind === 'manual'
        ? await ownerCall('open', { path: entry.location.path, count: firstCount(l), bytes: rawBytes + 2 * retired })
        : await ownerCall('openSaved', { ticket: entry.location.ticket, count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (ownerSession !== currentSession.current || closing.current || replace && workspace.tab(replace)?.key !== source?.key) return false
      const key = entry.location.kind === 'manual' ? manualKey(entry.location.path) : 'local:' + ownerSession + ':' + candidate.doc
      const path = candidate.path ?? entry.path
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path, opened: candidate, lines: candidate.lines,
        bytes: 0, indexed: candidate.indexed, atLine: entry.anchor, lens: 'raw', csvOptions: entry.csvOptions }
      const ticket = replace ? workspace.begin(replace) : (() => {
        const opened = workspace.beginOpen(key, path, index)
        return opened.kind === 'open' ? opened.ticket : null
      })()
      if (!ticket) return false
      if (!workspace.complete(ticket, key, next, { ...(replace ? { pop: true } : {}), restore: entry })) return false
      leave()
      const opened = candidate
      candidate = undefined
      restoreFocus.current = true
      show(ticket.tab, opened, workspace.tab(ticket.tab)!, rawBytes, undefined, retired)
      if (source) closeNative(source)
      return true
    } catch (e) {
      setWorkspaceNotice((replace ? 'Cannot go Back · ' : 'Cannot reopen · ') + (e instanceof Error ? e.message : String(e)))
      return false
    } finally {
      if (candidate && ownerSession === currentSession.current) void core.call('close', { surface: surface.current!, doc: candidate.doc }).catch(() => {})
      if (plan) owner?.cancelTransition(plan)
      pendingHistoryBytes.current = 0
      navigating.current = false
      setNavigationBusy(false)
      releaseEmptyWorkspace()
    }
  }

  async function back(): Promise<void> {
    const id = workspace.getSnapshot().selected
    const entry = id ? workspace.tab(id)?.back?.at(-1) : undefined
    if (!id || !entry) return
    if (await restoreLocation(entry, id)) {
      workspace.consumeBack(id, entry) // duplicate manual targets focus their existing tab instead of replacing this one
      releaseLocation(entry.location)
    }
  }

  async function reopenClosed(): Promise<void> {
    const item = closed.current.at(-1)
    if (!item) { setWorkspaceNotice('No recently closed tabs'); return }
    if (await restoreLocation(item.entry, undefined, item.index)) {
      if (closed.current.at(-1) === item) closed.current.pop()
      releaseLocation(item.entry.location)
    }
  }

  async function reload(): Promise<void> {
    if (closing.current || navigating.current || !recharged.current) return
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
      const opened = await ownerCall('reload', { doc: source.opened.doc, count: firstCount(l), bytes: plan?.bytes ?? rawBytes + 2 * retiredRendered.current })
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path: source.path, opened, lines: opened.lines, bytes: 0,
        indexed: opened.indexed, atLine, lens: 'raw', csvOptions: source.csvOptions }
      if (!workspace.complete(ticket, tab.key, next)) { deactivateInactive({ session: ticket.session, ...opened }); return } // borrowed document, release only its unpublished view
      if (workspace.selected(selection)) show(id, opened, workspace.tab(id)!, rawBytes, plan)
      else if (workspace.getSnapshot().selected === id) void selectTab(id)
      else deactivateInactive({ session: ticket.session, doc: opened.doc, gen: opened.gen, view: opened.view })
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
    if (!previous || previous.session !== currentSession.current || previous.doc !== opened.doc || !plan || !previous.adopt(opened.gen, opened.reserved, plan, opened.view)) {
      previous?.invalidate()
      budget.current = new LensBudget(core, currentSession.current, opened.doc, opened.gen, rawBytes, opened.reserved,
        Math.max(retired, plan?.retiredTreeMax ?? 0), opened.view)
    }
    live.current = { session: currentSession.current, doc: opened.doc, gen: opened.gen, view: opened.view }
    picked.current = tab.preferredLens
    place.current = undefined
    jumpTo.current = undefined
    const saved = tab.card.kind === 'open' ? tab.card : undefined
    display(id, { ...saved, kind: 'open', path: tab.path, opened, lines: saved?.lines ?? opened.lines,
      bytes: saved?.bytes ?? 0, indexed: saved?.indexed ?? opened.indexed, atLine: tab.anchor ?? saved?.atLine, lens: 'raw', rendering: false })
  }

  async function openFolderChild(rootId: string, nodeId: string): Promise<void> {
    const root = folders.current.find(root => root.id === rootId)
    const node = root && folderNode(root, nodeId)
    if (!root || !node) return
    if (node.kind !== 'file') { setWorkspaceNotice('Unsupported file · ' + node.name); return }
    const l = latest.current.limits
    if (!l || navigating.current || !recharged.current || root.ref.session !== currentSession.current) return
    const existing = workspace.getSnapshot().tabs.find(tab => tab.session === currentSession.current && tab.card.kind === 'open' &&
      tab.card.opened.folder?.root === rootId && tab.card.opened.folder.node === nodeId)
    if (existing) { await selectTab(existing.id); return }
    navigating.current = true
    setNavigationBusy(true)
    pendingHistoryBytes.current = historyDraftBytes(l)
    const ownerSession = currentSession.current
    let candidate: Opened | undefined
    let owner: LensBudget | null = null
    let plan: ReloadReservation | undefined
    try {
      if (!await metadata(current => chargeWorkspace([...workspace.getSnapshot().tabs, { key: rootId + ':' + nodeId, path: node.name }], current))) return
      const rawBytes = floorBytes(l)
      owner = live.current ? budgetFor(live.current) : null
      plan = owner?.reloadReservation(rawBytes)
      const retired = Math.max(retiredRendered.current, plan?.retiredTreeMax ?? 0)
      candidate = await ownerCall('openChild', { entry: node.ref, count: firstCount(l), bytes: rawBytes + 2 * retired })
      if (ownerSession !== currentSession.current || closing.current || !folders.current.some(root => root.id === rootId)) return
      if (!candidate.path || !candidate.localOnly) throw new Error('Folder open did not return a local document')
      const key = 'folder:' + ownerSession + ':' + rootId + ':' + nodeId
      const request = workspace.beginOpen(key, candidate.path)
      if (request.kind !== 'open') return
      const next: Extract<Card, { kind: 'open' }> = { kind: 'open', path: candidate.path, opened: candidate, lines: candidate.lines,
        bytes: 0, indexed: candidate.indexed, lens: 'raw' }
      if (!workspace.complete(request.ticket, key, next)) return
      leave()
      const opened = candidate
      candidate = undefined
      restoreFocus.current = true
      show(request.ticket.tab, opened, workspace.tab(request.ticket.tab)!, rawBytes, undefined, retired)
      shared.opened()
    } catch (e) {
      setWorkspaceNotice('Cannot open folder file · ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (candidate && ownerSession === currentSession.current) void core.call('close', { surface: surface.current!, doc: candidate.doc }).catch(() => {})
      if (plan) owner?.cancelTransition(plan)
      pendingHistoryBytes.current = 0
      navigating.current = false
      setNavigationBusy(false)
      releaseEmptyWorkspace()
    }
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

  /** Tab ownership closes native documents; changing the displayed card never does. */
  async function close(id = workspace.getSnapshot().selected): Promise<void> {
    if (!id || navigating.current) return
    const tab = workspace.tab(id)
    if (!tab) return
    const idCard = shared.groups.current.find(group => group.workspace === workspace)!.id
    navigating.current = true
    setNavigationBusy(true)
    const ownerSession = currentSession.current
    let captured: CapturedLocation | undefined
    try {
      const l = latest.current.limits
      if (l && tab.session === ownerSession && tab.card.kind === 'open') {
        pendingHistoryBytes.current = historyDraftBytes(l, false)
        if (await metadata(current => chargeWorkspace(workspace.getSnapshot().tabs, current))) {
          captured = await core.call('captureLocation', { doc: tab.card.opened.doc, gen: tab.card.opened.gen })
          if (ownerSession === currentSession.current && workspace.tab(id)) {
            const selected = displayed.current === id
            closed.current.push({ cardId: idCard, index: workspace.getSnapshot().tabs.findIndex(item => item.id === id), entry: {
              location: captured, path: tab.path, anchor: selected ? lens.current?.topLine() ?? tab.anchor ?? 0 : tab.anchor ?? 0,
              lens: selected ? picked.current : tab.preferredLens, csvOptions: tab.card.csvOptions
            } })
            captured = undefined
          }
        } else setWorkspaceNotice('Tab closed · memory budget could not retain Reopen history')
      }
    } catch (e) {
      setWorkspaceNotice('Tab closed · cannot retain Reopen history: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (captured) releaseLocation(captured)
      pendingHistoryBytes.current = 0
      navigating.current = false
      setNavigationBusy(false)
    }
    const selected = workspace.getSnapshot().selected === id
    if (selected) leave()
    const removed = workspace.close(id)
    if (!removed) return
    // Other cards and recently closed locations still own the shared window reservation/metadata queue.
    activationFailed.current.delete(id)
    closeNative(removed)
    for (const entry of removed.back ?? []) releaseLocation(entry.location)
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
  const breadcrumbParent = openedNow?.folder ? [openedNow.folder.label, ...openedNow.folder.segments.slice(0, -1)].join(' / ') : path ? parentName(path) : ''
  const secondaryLens = shown.lenses?.grid ? 'grid' : 'rendered'
  const detectedDelimiter = card.kind === 'open' && card.csv ? { ',': 'Comma', '\t': 'Tab', ';': 'Semicolon', '|': 'Pipe' }[card.csv.delimiter] : undefined

  const header = (
    <div className="card-header">
      <Button className="back-button" aria-label="Back" isDisabled={navigationBusy || !snapshot.ready || !snapshot.tabs.find(tab => tab.id === snapshot.selected)?.back?.length} onPress={() => void back()}><span title="Back">←</span></Button>
      <span className="card-identity" title={path}>
        {path ? <FileIcon path={path} markdown={openedNow?.format === 'markdown'} /> : null}
        <span className="card-breadcrumb">
          {breadcrumbParent ? <span className="card-parent">{breadcrumbParent}<span className="breadcrumb-divider"> / </span></span> : null}
          <span className="card-name" role="heading" aria-level={1}>{path ? fileName(path) : 'No file open'}</span>
        </span>
      </span>
      {shown.lenses ? (
        <>
        <TabList aria-label="Lens" className="lens-switch">
          <Tab id={secondaryLens} className="lens-tab" isDisabled={!!(shown.lenses.grid ? shown.lenses.gridOff : shown.lenses.renderedOff)}>
            {/* `Tab` doesn't take a DOM `title`. The span carries the reason, which is the tooltip (Z71, Z34). */}
            <span className="lens-tab-tip" title={shown.lenses.grid ? shown.lenses.gridOff : shown.lenses.renderedOff}>
              {shown.lenses.grid ? 'Grid' : 'Rendered'}
            </span>
          </Tab>
          <Tab id="raw" className="lens-tab">
            <span className="lens-tab-tip">Raw</span>
          </Tab>
        </TabList>
        <MenuTrigger>
          <Button className="lens-dropdown" aria-label={`Lens: ${shown.lenses.showing === 'grid' ? 'Grid' : shown.lenses.showing === 'rendered' ? 'Rendered' : 'Raw'}`}>
            {shown.lenses.showing === 'grid' ? 'Grid' : shown.lenses.showing === 'rendered' ? 'Rendered' : 'Raw'} <span aria-hidden="true">⌄</span>
          </Button>
          <Popover className="menu-popover" placement="bottom end">
            <Menu className="menu" aria-label="Lens" onAction={onLens} disabledKeys={shown.lenses.gridOff ? ['grid'] : shown.lenses.renderedOff ? ['rendered'] : []}>
              <MenuItem id={shown.lenses.grid ? 'grid' : 'rendered'} className="menu-item" textValue={shown.lenses.grid ? 'Grid' : 'Rendered'}>
                {shown.lenses.grid ? 'Grid' : 'Rendered'}{shown.lenses.gridOff || shown.lenses.renderedOff ? <span className="lens-unavailable"> · {shown.lenses.gridOff || shown.lenses.renderedOff}</span> : null}
              </MenuItem>
              <MenuItem id="raw" className="menu-item">Raw</MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
        </>
      ) : null}
      {card.kind === 'open' && card.opened.format === 'csv' ? <DialogTrigger>
        <Button className="csv-info-button" aria-label="File info">ⓘ</Button>
        <Popover className="csv-info-popover" placement="bottom end">
          <Dialog aria-label="CSV file info">
            <p>{card.csv ? `${Math.max(0, card.csv.sourceRecords - (card.csv.header ? 1 : 0))} rows${card.csv.done ? '' : '…'} · ${card.csv.expectedColumns} columns · ${card.csv.encoding}` : 'Preparing CSV…'}</p>
            <label><input type="checkbox" checked={card.csv?.header ?? false} disabled={csvChanging || !card.csv} onChange={event => void configureCsv({ ...(card.csvOptions ?? CSV_OPTIONS), header: event.target.checked })} /> First row is header</label>
            <label>Delimiter <select aria-label="Delimiter" value={card.csvOptions?.delimiter ?? 'auto'} disabled={csvChanging} onChange={event => void configureCsv({ ...(card.csvOptions ?? CSV_OPTIONS), delimiter: event.target.value as CsvOptions['delimiter'] })}>
              <option value="auto">Auto{detectedDelimiter ? ` (${detectedDelimiter})` : ''}</option><option value=",">Comma</option><option value={'\t'}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option>
            </select></label>
            {card.gridOff ? <p>{card.gridOff}</p> : null}
            <p>Grid preview · Find, sort and range copy are unavailable.</p>
          </Dialog>
        </Popover>
      </DialogTrigger> : null}
      <span className="card-status" title={shown.status} tabIndex={shown.status ? 0 : undefined}>{shown.status}</span>
      <span className="card-status-tooltip" aria-hidden="true">{shown.status}</span>
      {preview ? <span className="preview-actions">
        <Button aria-label="Open as tab" isDisabled={preview.busy || navigationBusy} onPress={preview.onTab}><span aria-hidden="true" title="Open as tab">↗</span><span className="preview-action-label">Open as tab</span></Button>
        <Button aria-label="Open to side" isDisabled={preview.busy || navigationBusy} onPress={preview.onSide}><span aria-hidden="true" title="Open to side">▥</span><span className="preview-action-label">Open to side</span></Button>
        <Button aria-label="Close preview" onPress={preview.onClose}><span aria-hidden="true" title="Close preview">×</span></Button>
      </span> : <Button className="close-card-button" aria-label="Close card" onPress={onCloseCard}>×</Button>}
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
    fontLayoutReady && card.kind === 'open' && limits && 'raw' in shown.body ? (
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
        onOpenLocal={(target, path, gesture) => routeLocal(card.opened, target, path, gesture)}
        onDisposed={disposedView}
      />
    ) : fontLayoutReady && card.kind === 'open' && limits && 'grid' in shown.body && card.csv ? (
      <LensHost core={core} session={session} budget={budgetFor(card.opened)} retained={rendered} lens={lens}
        jumpTo={jumpTo} place={place} hadFocus={hadFocus} restoreFocus={restoreFocus} atLine={card.atLine}
        opened={card.opened} name={fileName(card.path)} lines={card.lines} indexed={card.indexed} limits={limits}
        frozen={frozen !== undefined} mode="grid" csv={card.csv} csvOptions={card.csvOptions ?? CSV_OPTIONS}
        onCsvInfo={info => setCard(c => c.kind === 'open' && c.opened === card.opened && c.csv?.ref.revision === info.ref.revision ? { ...c, csv: info } : c)}
        onFrozen={why => setCard(c => c.kind === 'open' && c.opened === card.opened ? { ...c, frozen: c.frozen ?? why } : c)}
        onShowRaw={line => { jumpTo.current = line; onLens('raw') }}
        onOpenLocal={(target, path, gesture) => routeLocal(card.opened, target, path, gesture)} onDisposed={disposedView} />
    ) : fontLayoutReady && card.kind === 'open' && limits && 'rendered' in shown.body && card.build ? (
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
        onOpenLocal={(target, path, gesture) => routeLocal(card.opened, target, path, gesture)}
        onDisposed={disposedView}
      />
    ) : (
      message
    )

  useEffect(() => {
    const handle: ReaderHandle = {
      ready: () => surface.current || readyError.current ? Promise.resolve() : new Promise<void>(done => readyWaiters.current.push(done)),
      open: openNamed, openChild: openFolderChild, openDerived, navigateLocal: openLocal, pick, reload, back, close: () => close(), reopen: reopenClosed, clearClosed,
      cycle: step => { const state = workspace.getSnapshot(); const index = state.tabs.findIndex(tab => tab.id === state.selected); if (state.tabs.length) void selectTab(state.tabs[(index + step + state.tabs.length) % state.tabs.length].id) },
      capture: async () => {
        const c = latest.current.card
        if (c.kind !== 'open' || navigating.current || !latest.current.limits) return null
        pendingHistoryBytes.current = historyDraftBytes(latest.current.limits, false)
        try {
          if (!await metadata(current => chargeWorkspace(workspace.getSnapshot().tabs, current))) return null
          const location = await core.call('captureLocation', { doc: c.opened.doc, gen: c.opened.gen })
          return { location, path: c.path, anchor: lens.current?.topLine() ?? 0, lens: picked.current, csvOptions: c.csvOptions }
        } finally { pendingHistoryBytes.current = 0 }
      },
      restore: entry => restoreLocation(entry),
      detach: async permanent => {
        closing.current = permanent
        navigating.current = true
        setNavigationBusy(true)
        workspace.invalidateWork()
        const bytes = budget.current?.snapshot().total ?? 2 * retiredRendered.current
        const view = live.current?.view
        leave()
        display(null, { kind: 'empty' })
        abort.current.abort()
        await Promise.allSettled(requests.current)
        if (view && view.session === shared.hello.current?.session) await core.call('deactivate', { view }).catch(() => false)
        if (!permanent) { abort.current = new AbortController(); navigating.current = false; setNavigationBusy(false) }
        return bytes
      },
      retirement: () => budget.current?.snapshot().total ?? 2 * retiredRendered.current,
      prepareRetirement: () => {
        const owner = budget.current
        const bytes = owner?.snapshot().total ?? 2 * retiredRendered.current
        const plan = owner?.reloadReservation(owner.rawReserved)
        const wasNavigating = navigating.current
        navigating.current = true
        setNavigationBusy(true)
        lens.current?.yieldReservation()
        return { bytes: Math.max(bytes, plan?.bytes ?? 0), cancel: () => {
          if (plan) owner?.cancelTransition(plan)
          lens.current?.resumeReservation()
          navigating.current = wasNavigating
          setNavigationBusy(wasNavigating)
        } }
      },
      resume: async () => {
        closing.current = false
        abort.current = new AbortController()
        navigating.current = false
        setNavigationBusy(false)
        const selected = workspace.getSnapshot().selected
        if (selected) await selectTab(selected, true)
      },
      activateSelected: async () => { const selected = workspace.getSnapshot().selected; if (selected) await selectTab(selected, true) },
      surface: () => surface.current,
      busy: () => navigating.current || requests.current.size > 0
    }
    return shared.register(id, handle)
  }, [])

  return <section className={preview ? 'reader-card preview-reader' : 'reader-card'} role="region" aria-label={preview ? 'Preview reader' : 'Reader card ' + label} data-card={id} data-focused={focused || undefined} onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
      {preview ? null : <FileTabs panelId={'file-card-' + id} tabs={snapshot.tabs} selected={snapshot.selected} onSelect={(id) => void selectTab(id)} onClose={(id) => close(id)} />}
      <div className="card">
        <div className="file-card-panel" id={'file-card-' + id} role={snapshot.selected ? 'tabpanel' : undefined} aria-labelledby={snapshot.selected ? `file-label-${snapshot.selected}` : undefined}>
        {(workspaceNotice || focused && windowNotice) ? <div className="banner" role="status">{workspaceNotice || windowNotice}</div> : null}
        {card.kind === 'open' ? (
          <>
            {shown.lenses ? (
              <Tabs className="card-tabs" selectedKey={shown.lenses.showing} onSelectionChange={onLens}>
                {header}
                {progress}
                {banner}
                <div className="card-body">
                  <TabPanel id={secondaryLens} className="lens-panel">
                    {shown.lenses.showing === secondaryLens ? body : null}
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
      </div>
  </section>
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
  mode: 'raw' | 'rendered' | 'grid'
  csv?: CsvInfo
  csvOptions?: CsvOptions
  onCsvInfo?(info: CsvInfo): void
  build?: MdBuild
  onFrozen(why: string): void
  onShowRaw(line: number): void
  onOpenLocal(target: string, path: string, gesture: LocalGesture): Promise<boolean>
  onDisposed(opened: Opened): void
}

/** Mounts Raw or Rendered into the card body. A switch or Reload of this document keeps the previous lens's top line. */
function LensHost({ core, session, budget, retained, lens, jumpTo, place, hadFocus, restoreFocus, atLine, opened, name, lines, indexed, limits, frozen, mode, build, csv, csvOptions, onCsvInfo, onFrozen, onShowRaw, onOpenLocal, onDisposed }: LensHostProps) {
  const host = useRef<HTMLDivElement>(null)
  const onFrozenNow = useRef(onFrozen)
  onFrozenNow.current = onFrozen
  const onShowRawNow = useRef(onShowRaw)
  onShowRawNow.current = onShowRaw
  const onOpenLocalNow = useRef(onOpenLocal)
  onOpenLocalNow.current = onOpenLocal
  const onDisposedNow = useRef(onDisposed)
  onDisposedNow.current = onDisposed
  const onCsvInfoNow = useRef(onCsvInfo)
  onCsvInfoNow.current = onCsvInfo
  useEffect(() => {
    // `place` outlives the document. Use it only for the document that saved it, so a second file opens at `atLine`
    // (or the top). Clear it only after that check: Reload is the same document, and its line has to survive.
    const saved = place.current?.session === session && place.current.doc === opened.doc ? place.current.line : undefined
    const at = saved ?? jumpTo.current ?? atLine
    if (saved !== undefined) place.current = undefined
    jumpTo.current = undefined
    const onFrozenHere = (why: string) => onFrozenNow.current(why)
    let view: ShownLens
    if (mode === 'grid' && csv) {
      view = new GridLens(host.current!, core, opened, csv, limits, { atLine: at, options: csvOptions ?? CSV_OPTIONS,
        onFrozen: onFrozenHere, budget, onInfo: info => onCsvInfoNow.current?.(info),
        onShowRaw: line => onShowRawNow.current(line) })
    } else if (mode === 'rendered' && build) {
      const kept = retained.current
      if (kept?.session === session && kept.doc === opened.doc && kept.gen === opened.gen) {
        view = kept.view
        kept.view.resume(host.current!, at)
      } else {
        kept?.view.dispose()
        const made = new RenderedLens(host.current!, core, opened, build, limits, {
          onFrozen: onFrozenHere, atLine: at, onShowRaw: (line) => onShowRawNow.current(line),
          onOpenLocal: (target, path, gesture) => onOpenLocalNow.current(target, path, gesture), budget: budget ?? undefined
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
      onDisposedNow.current(opened)
    }
  }, [core, session, budget, retained, opened, name, limits, lens, atLine, mode, build, csv?.ref.revision, csvOptions, jumpTo, place, hadFocus, restoreFocus])
  useEffect(() => lens.current?.setLineCount(lines), [lines])
  useEffect(() => {
    if (indexed) lens.current?.indexDone()
  }, [indexed])
  useEffect(() => {
    if (frozen) lens.current?.freeze()
  }, [frozen])
  return <div className={mode === 'grid' ? 'grid-host' : mode === 'rendered' ? 'rendered-host' : 'raw-host'} ref={host} data-gen={opened.gen} data-lens={mode} />
}
