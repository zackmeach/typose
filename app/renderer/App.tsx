import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Dialog, Modal, ModalOverlay } from 'react-aria-components'
import type { Command, Hello, Opened } from '../shared/protocol'
import { CoreCallError, type CoreClient } from './core'
import { AppIcon, FileIcon } from './file-icon'
import { fileName } from './card'
import { AppMenu, LINUX } from './menu'
import { markPainted } from './perf'
import { ReaderCard } from './ReaderCard'
import { WorkspaceStore, WorkspaceMetadataQueue, type WorkspaceTab } from './workspace'
import { WorkspaceBudget } from './workspace-budget'
import { FolderSidebar } from './folder-sidebar'
import { entryView, folderNode, foldersCharge, rootView, updateFolder, type RootView } from './folders'
import type { ClosedLocation, LocalGesture, ReaderGroup, ReaderHandle, ReaderWindow } from './reader-window'
import './split-cards.css'
import './link-preview.css'
import { sessionWorkspace, type RecentLocation, type SessionWorkspace } from '../shared/session'
import './workspace-controls.css'

interface LinkPreview extends ReaderGroup { sourceId: string; trigger: HTMLElement; width: number; right: number }

const MAC = navigator.platform.startsWith('Mac')
export const appHooks: { close?: () => void; workspace?: () => ReturnType<WorkspaceBudget['snapshot']> | null } = {}

/** The window owns commands, folders and metadata; each keyed ReaderCard owns one live document view. */
export function App({ core, fonts }: { core: CoreClient; fonts: Promise<void> }) {
  const [groups, setGroups] = useState<readonly ReaderGroup[]>(() => [{ id: 'card-1', workspace: new WorkspaceStore('card-1-tab'), weight: 1 }])
  const groupRef = useRef(groups)
  const [preview, setPreviewState] = useState<LinkPreview | null>(null)
  const previewRef = useRef<LinkPreview | null>(null)
  const allGroups = useRef<readonly ReaderGroup[]>(groups)
  const previewWork = useRef<'opening' | 'closing' | 'promoting' | null>(null)
  const previewCloseRequested = useRef(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const nextCard = useRef(2)
  const [focused, setFocused] = useState('card-1')
  const focusedRef = useRef(focused)
  const handles = useRef(new Map<string, ReaderHandle>())
  const readerWaiters = useRef(new Set<{ id: string; start(handle: ReaderHandle): void; cancel(message: string): void }>())
  const reports = useRef(new Map<string, { title: string; node?: string }>())
  const [title, setTitle] = useState('Typose')
  const [activeNode, setActiveNode] = useState<string>()
  const [workspaceNotice, setWorkspaceNotice] = useState('')
  const [folderRoots, setFolderRoots] = useState<readonly RootView[]>([])
  const folders = useRef<readonly RootView[]>([])
  const folderRequests = useRef(new Map<string, number>())
  const pendingFolders = useRef(new Map<symbol, number>())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [sidebarOverlay, setSidebarOverlay] = useState(() => window.matchMedia('(max-width: 999px)').matches)
  const workspaceBudget = useRef<WorkspaceBudget | null>(null)
  const workspacePeak = useRef(0)
  const [metadataQueue] = useState(() => new WorkspaceMetadataQueue())
  const closed = useRef<ClosedLocation[]>([])
  const pendingWorkspace = useRef(new Map<string, { units: number }>())
  const pendingNative = useRef(new Set<symbol>())
  const pendingHistory = useRef(new Map<string, number>())
  const recharged = useRef(false)
  const hello = useRef<Hello | null>(null)
  const currentSession = useRef(0)
  const payment = useRef<Promise<boolean>>(Promise.resolve(false))
  const retiredPeak = useRef(0)
  const pendingSplit = useRef(0)
  const splitBusy = useRef(false)
  const closingCards = useRef(new Set<string>())
  const row = useRef<HTMLElement>(null)
  const waiting = useRef<string[]>([])
  const [recents, setRecents] = useState<RecentLocation[]>([])
  const recentRef = useRef<RecentLocation[]>([])
  const lastRecent = useRef('')
  const sessionReady = useRef(false)
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const sessionSerial = useRef(Promise.resolve(true))
  const captureNow = useRef<() => Promise<boolean>>(async () => false)
  const workspace = { getSnapshot: () => ({ ready: !!hello.current, tabs: allGroups.current.flatMap(group => group.workspace.getSnapshot().tabs) }) }
  const navigating = { get current() { return splitBusy.current || [...handles.current.values()].some(handle => handle.busy()) } }
  const [shared] = useState<ReaderWindow>(() => ({ core, hello, groups: allGroups, closed, folders, pendingFolders,
    budget: workspaceBudget, peak: workspacePeak, queue: metadataQueue, pendingWorkspace, pendingNative,
    pendingHistory: pendingHistory.current, recharged, paid: () => payment.current,
    charge: async () => false, release: () => {}, notice: () => {}, opened: () => {}, openLink: async () => false, report: () => {}, register: () => () => {} }))

  function setPreview(next: LinkPreview | null): void {
    const previous = previewRef.current
    if (previous && previous !== next) cancelReaderWaiters('The preview was closed', previous.id)
    previewRef.current = next
    allGroups.current = next ? [...groupRef.current, next] : groupRef.current
    setPreviewState(next)
  }

  function cancelReaderWaiters(message: string, id?: string): void {
    for (const waiter of readerWaiters.current) if (id === undefined || waiter.id === id) waiter.cancel(message)
  }
  function updateGroups(next: readonly ReaderGroup[]): void {
    for (const group of groupRef.current) if (!next.some(item => item.id === group.id)) cancelReaderWaiters('Reader card was removed', group.id)
    groupRef.current = next
    allGroups.current = previewRef.current ? [...next, previewRef.current] : next
    setGroups(next)
  }
  function focusCard(id: string): void {
    if (!groupRef.current.some(group => group.id === id)) return
    focusedRef.current = id
    setFocused(id)
    setTitle(reports.current.get(id)?.title ?? 'Typose')
    setActiveNode(reports.current.get(id)?.node)
  }
  function focusedReader(): ReaderHandle | undefined { return handles.current.get(focusedRef.current) }

  function rememberRecent(entry: RecentLocation): void {
    const next = [entry, ...recentRef.current.filter(item => item.kind !== entry.kind || item.path !== entry.path)].slice(0, 8)
    if (JSON.stringify(next) === JSON.stringify(recentRef.current)) return
    recentRef.current = next
    setRecents(next)
  }

  async function captureWindowSession(): Promise<boolean> {
    if (!sessionReady.current || !hello.current || splitBusy.current || previewWork.current) return false
    const before = groupRef.current, snapshots = before.map(group => group.workspace.getSnapshot())
    try {
      const cards = []
      for (const group of before) {
        const captured = await handles.current.get(group.id)?.captureSession()
        if (!captured) return false
        cards.push({ ...captured, weight: group.weight })
      }
      if (groupRef.current !== before || before.some((group, index) => group.workspace.getSnapshot() !== snapshots[index])) return false
      const focused = Math.max(0, before.findIndex(group => group.id === focusedRef.current))
      const selected = cards[focused]?.tabs[cards[focused].selected]
      if (selected?.location.kind === 'manual' && lastRecent.current !== selected.location.path) {
        lastRecent.current = selected.location.path
        rememberRecent({ kind: 'file', path: selected.location.path })
      }
      const saved: SessionWorkspace = { version: 1, cards, focused, roots: folders.current.map(root => ({ path: root.path, ...(root.identity ? { identity: root.identity } : {}) })),
        sidebar: { open: sidebarOpen, width: sidebarWidth }, recents: recentRef.current }
      const accepted = await window.typose.saveSession(saved)
      if (!accepted) setWorkspaceNotice('The workspace could not be saved')
      return accepted
    } catch { return false }
  }
  captureNow.current = () => {
    const next = sessionSerial.current.then(captureWindowSession, captureWindowSession)
    sessionSerial.current = next
    return next
  }
  function scheduleSession(): void {
    clearTimeout(sessionTimer.current)
    sessionTimer.current = setTimeout(() => { void captureNow.current() }, 300)
  }

  async function restoreWindowSession(value: SessionWorkspace): Promise<void> {
    const saved = sessionWorkspace(value)
    if (!saved) return
    recentRef.current = saved.recents
    setRecents(saved.recents)
    pendingSplit.current = Math.max(0, saved.cards.length - 1) * 32 * 16_384
    if (!await charge(null, null, () => !!hello.current)) { pendingSplit.current = 0; return }
    const restored = saved.cards.map((card, index) => {
      const group = index === 0 ? groupRef.current[0] : { id: 'card-' + nextCard.current++, workspace: new WorkspaceStore('restored-' + index + '-tab'), weight: card.weight }
      group.workspace.coreReady(currentSession.current)
      return { ...group, weight: card.weight }
    })
    updateGroups(restored)
    pendingSplit.current = 0
    for (const savedRoot of saved.roots) {
      const path = savedRoot.path
      await pickFolder(undefined, path)
      const captured = folders.current.find(root => root.path === path)
      if (captured && savedRoot.identity && captured.identity !== savedRoot.identity) {
        await core.call('removeRoot', { root: captured.id, session: captured.ref.session })
        setFolders(folders.current.map(root => root.id === captured.id ? { ...root, identity: savedRoot.identity, unavailable: true,
          node: { ...root.node, expanded: false, children: undefined, error: 'Folder changed · select it again using Locate…' } } : root))
      } else if (!captured) {
        const id = 'missing-' + folders.current.length
        setFolders([...folders.current, { id, path, identity: savedRoot.identity, ref: { session: 0, root: id, node: '0' }, unavailable: true,
          node: { id: '0', ref: { session: 0, root: id, node: '0' }, name: path.split(/[\\/]/).at(-1) ?? path, kind: 'directory', error: 'Folder not found' } }])
      }
    }
    for (let index = 0; index < restored.length; index++) await (await waitForReader(restored[index].id)).restoreSession(saved.cards[index])
    setSidebarWidth(saved.sidebar.width)
    setSidebarOpen(saved.sidebar.open && !window.matchMedia('(max-width: 999px)').matches)
    focusCard(restored[saved.focused]?.id ?? restored[0].id)
  }

  async function charge(owner: WorkspaceStore | null, override: readonly Pick<WorkspaceTab, 'key' | 'path'>[] | null, current: () => boolean): Promise<boolean> {
    const bank = workspaceBudget.current, session = currentSession.current
    if (!bank || !current()) return false
    const actual = workspace.getSnapshot().tabs
    const tabs = owner ? allGroups.current.flatMap(group => group.workspace === owner ? override ?? [] : group.workspace.getSnapshot().tabs) : override ?? actual
    const entries = [...actual.flatMap(tab => tab.back ?? []), ...closed.current.map(item => item.entry)]
    const text = entries.reduce((sum, entry) => sum + entry.path.length + (entry.location.kind === 'manual' ? entry.location.path.length : entry.location.ticket.id.length), 0)
    const folderBytes = actual.reduce((bytes, tab) => {
      const folder = tab.card.kind === 'open' ? tab.card.opened.folder : undefined
      return bytes + (folder ? 16_384 + 128 * (folder.label.length + folder.root.length + (folder.node?.length ?? 0) + folder.segments.reduce((sum, segment) => sum + segment.length, 0)) + 256 * folder.segments.length : 0)
    }, 0)
    const pending = [...pendingWorkspace.current.values()]
    const extra = entries.length * 16_384 + 128 * text + folderBytes + foldersCharge(folders.current) +
      [...pendingFolders.current.values()].reduce((sum, bytes) => sum + bytes, 0) + [...pendingHistory.current.values()].reduce((sum, bytes) => sum + bytes, 0) +
      Math.max(0, allGroups.current.length - 1) * (32 * 16_384) + retiredPeak.current + pendingSplit.current
    const paid = await bank.hold(tabs.length + pending.length, tabs.reduce((sum, tab) => sum + tab.key.length + tab.path.length, 0) + pending.reduce((sum, item) => sum + item.units, 0), extra)
    if (bank !== workspaceBudget.current || session !== currentSession.current || !current()) return false
    if (!paid) setWorkspaceNotice("Cannot open the view · Typose's memory budget is full")
    return paid
  }
  function chargeWorkspace(tabs: readonly Pick<WorkspaceTab, 'key' | 'path'>[], current: () => boolean): Promise<boolean> { return charge(null, tabs, current) }
  function metadata<T>(work: (current: () => boolean) => Promise<T>): Promise<T | null> {
    const session = currentSession.current
    return metadataQueue.run(work, () => session === currentSession.current && !!hello.current).finally(releaseEmptyWorkspace)
  }
  function releaseEmptyWorkspace(): void {
    requestAnimationFrame(() => {
      if (previewRef.current || groupRef.current.length > 1 || workspace.getSnapshot().tabs.length || closed.current.length || folders.current.length || pendingFolders.current.size || pendingNative.current.size || pendingWorkspace.current.size || [...pendingHistory.current.values()].some(Boolean) || metadataQueue.pending) return
      const bank = workspaceBudget.current
      if (!bank) return
      void bank.release().then(released => {
        if (released && bank === workspaceBudget.current && !workspace.getSnapshot().tabs.length) { retiredPeak.current = 0; workspacePeak.current = 0; recharged.current = true }
      })
    })
  }
  shared.charge = charge
  shared.release = releaseEmptyWorkspace
  shared.notice = setWorkspaceNotice
  shared.opened = () => { if (sidebarOverlay) setSidebarOpen(false) }
  shared.openLink = openLink
  shared.report = (id, text, node) => { reports.current.set(id, { title: text, node }); if (focusedRef.current === id) { setTitle(text); setActiveNode(node) } }
  shared.register = (id, handle) => {
    if (!allGroups.current.some(group => group.id === id)) return () => {}
    handles.current.set(id, handle)
    for (const waiter of readerWaiters.current) if (waiter.id === id) waiter.start(handle)
    if (id === focusedRef.current) for (const path of waiting.current.splice(0)) handle.open(path)
    return () => {
      if (handles.current.get(id) === handle) {
        handles.current.delete(id)
        reports.current.delete(id)
        cancelReaderWaiters('Reader card was unmounted', id)
      }
    }
  }

  useEffect(() => { document.title = title }, [title])
  useEffect(() => {
    const off = groups.map(group => group.workspace.subscribe(scheduleSession))
    const capture = window.typose.onSessionCapture(() => captureNow.current())
    window.addEventListener('scroll', scheduleSession, true)
    return () => { off.forEach(unsubscribe => unsubscribe()); capture(); window.removeEventListener('scroll', scheduleSession, true); clearTimeout(sessionTimer.current) }
  }, [groups])
  useEffect(() => { scheduleSession() }, [sidebarOpen, sidebarWidth, focused, folderRoots])
  useLayoutEffect(() => markPainted('titlebarPainted'), [])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 999px)')
    const resize = () => { setSidebarOverlay(media.matches); if (media.matches) setSidebarOpen(false) }
    const focus = () => refreshFolders()
    media.addEventListener('change', resize)
    window.addEventListener('focus', focus)
    return () => { media.removeEventListener('change', resize); window.removeEventListener('focus', focus) }
  }, [])
  useEffect(() => {
    const gone = core.onGone(() => {
      cancelReaderWaiters('The core stopped while creating the reader card')
      recharged.current = false
      hello.current = null
      folderRequests.current.clear()
      setFolders(folders.current.map(root => ({ ...root, unavailable: true, node: { ...root.node, expanded: false, loading: false, children: undefined, cursor: undefined, error: 'Core restarted · select the folder again' } })))
      workspacePeak.current = Math.max(workspacePeak.current, workspaceBudget.current?.snapshot().peakBytes ?? 0)
      workspaceBudget.current?.invalidate()
      workspaceBudget.current = null
      metadataQueue.invalidate()
    })
    const ready = core.onReady(value => {
      currentSession.current = value.session
      hello.current = value
      for (const group of allGroups.current) group.workspace.coreReady(value.session)
      workspaceBudget.current = new WorkspaceBudget(core, value.session, workspacePeak.current)
      payment.current = charge(null, null, () => hello.current?.session === value.session).then(paid => { if (hello.current?.session === value.session) recharged.current = paid; return paid })
    })
    const openPath = (path: string) => {
      const reader = focusedReader()
      if (previewRef.current || !reader) waiting.current.push(path)
      else reader.open(path)
    }
    const offOpen = window.typose.onOpenPath(openPath)
    const offCommand = window.typose.onCommand(run)
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const command = MAC ? event.metaKey : event.ctrlKey
      const textControl = event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')
      if (command && event.key.toLowerCase() === 'c' && !event.shiftKey && !event.altKey && !textControl) { event.preventDefault(); run('copy'); return }
      if (command && event.key.toLowerCase() === 'g' && !event.shiftKey && !event.altKey) { event.preventDefault(); run('go-to'); return }
      if (command && event.key.toLowerCase() === 'p' && !event.shiftKey && !event.altKey) { event.preventDefault(); run('print'); return }
      if (command && event.key.toLowerCase() === 'f' && !event.shiftKey && !event.altKey) { event.preventDefault(); run('find'); return }
      if (event.key === 'F3' && !command && !event.altKey) { event.preventDefault(); run(event.shiftKey ? 'find-previous' : 'find-next'); return }
      if (command && event.key.toLowerCase() === 'b' && !event.shiftKey && !event.altKey) { event.preventDefault(); run('toggle-sidebar'); return }
      if (command && event.key === '\\' && !event.altKey) { event.preventDefault(); run('split-right'); return }
      if (command && event.key.toLowerCase() === 't' && event.shiftKey && !event.altKey) { event.preventDefault(); run('reopen-tab'); return }
      if (command && event.key.toLowerCase() === 'w' && !event.altKey && !event.shiftKey) { event.preventDefault(); run('close-tab'); return }
      const step = event.ctrlKey && event.key === 'Tab' && !event.altKey ? event.shiftKey ? -1 : 1 : !MAC && event.ctrlKey && !event.shiftKey && !event.altKey && (event.key === 'PageDown' || event.key === 'PageUp') ? event.key === 'PageDown' ? 1 : -1 : 0
      if (step) { event.preventDefault(); if (!previewRef.current) focusedReader()?.cycle(step); return }
      if (LINUX && event.ctrlKey && event.key.toLowerCase() === 'q' && !event.altKey && !event.shiftKey) { run('exit'); return }
      if (command && event.key.toLowerCase() === 'r' && !event.shiftKey && !event.altKey || event.key === 'F5' && !command && !event.shiftKey && !event.altKey) { event.preventDefault(); run('reload') }
    }
    window.addEventListener('keydown', key)
    void core.connect().then(async () => {
      await payment.current
      const [saved, paths] = await Promise.all([window.typose.loadSession(), window.typose.launchPaths()])
      await restoreWindowSession(saved)
      sessionReady.current = true
      for (const path of paths) openPath(path)
      scheduleSession()
    }).catch(error => { sessionReady.current = true; setWorkspaceNotice('Cannot restore workspace · ' + String(error)) })
    return () => { cancelReaderWaiters('The workspace was unmounted'); gone(); ready(); offOpen(); offCommand(); window.removeEventListener('keydown', key) }
  }, [core])

  function setFolders(next: readonly RootView[]): void {
    folders.current = next
    setFolderRoots(next)
  }

  async function pickFolder(replace?: string, chosen?: string): Promise<void> {
    const path = chosen ?? await window.typose.folderDialog()
    if (!path || !workspace.getSnapshot().ready || !recharged.current) return
    const ownerSession = currentSession.current
    const operation = Symbol()
    pendingFolders.current.set(operation, 16_384 + 128 * 32_767)
    let added: RootView | undefined
    try {
      if (!await metadata(current => chargeWorkspace(workspace.getSnapshot().tabs, current))) return
      added = rootView(await core.call('addRoot', { path }))
      if (ownerSession !== currentSession.current || replace && !folders.current.some(root => root.id === replace)) return
      const next = added
      setFolders([...folders.current.filter(root => root.id !== replace && root.id !== next.id), next])
      added = undefined
      if (replace && replace !== next.id) void core.call('removeRoot', { root: replace, session: ownerSession }).catch(() => {})
      setSidebarOpen(true)
      rememberRecent({ kind: 'folder', path })
      void listDirectory(next.id, next.node.id)
    } catch (e) {
      setWorkspaceNotice('Cannot add folder · ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (added && ownerSession === currentSession.current) void core.call('removeRoot', { root: added.id, session: added.ref.session }).catch(() => {})
      pendingFolders.current.delete(operation)
      releaseEmptyWorkspace()
    }
  }

  async function listDirectory(rootId: string, nodeId: string, more = false): Promise<void> {
    const root = folders.current.find(root => root.id === rootId)
    const node = root && folderNode(root, nodeId)
    if (!root || !node || root.ref.session !== currentSession.current || !recharged.current || node.loading || more && !node.cursor) return
    const key = rootId + ':' + nodeId
    const epoch = (folderRequests.current.get(key) ?? 0) + 1
    folderRequests.current.set(key, epoch)
    const valid = () => root.ref.session === currentSession.current && folders.current.some(item => item.id === rootId && folderNode(item, nodeId)) && folderRequests.current.get(key) === epoch
    const operation = Symbol()
    // At most 128 labels/rows and 64KiB names per native page; the workspace adds two retired copies.
    pendingFolders.current.set(operation, 128 * 16_384 + 128 * 65_536)
    setFolders(updateFolder(folders.current, rootId, nodeId, before => ({ ...before, loading: true, error: undefined })))
    try {
      if (!await metadata(async current => valid() && chargeWorkspace(workspace.getSnapshot().tabs, current))) return
      const page = await core.call('listFolder', { folder: node.ref, ...(more ? { cursor: node.cursor } : {}), hidden: false })
      if (!valid()) return
      setFolders(updateFolder(folders.current, rootId, nodeId, before => {
        const entries = page.entries.map(entry => {
          const existing = before.children?.find(child => child.id === entry.ref.node)
          return existing && entry.kind === 'directory' ? { ...existing, ...entryView(entry) } : entryView(entry)
        })
        return { ...before, children: more ? [...(before.children ?? []), ...entries] : entries,
          cursor: page.cursor, hasMore: !!page.cursor, error: undefined }
      }))
    } catch (e) {
      if (valid()) {
        setFolders(updateFolder(folders.current, rootId, nodeId, before => ({ ...before, error: e instanceof Error ? e.message : String(e) })))
        if (nodeId === root.node.id && e instanceof CoreCallError && e.code === 'NotFound')
          setFolders(folders.current.map(item => item.id === rootId ? { ...item, unavailable: true } : item))
      }
    } finally {
      if (valid()) setFolders(updateFolder(folders.current, rootId, nodeId, before => ({ ...before, loading: false })))
      pendingFolders.current.delete(operation)
      releaseEmptyWorkspace()
    }
  }

  function toggleFolder(rootId: string, nodeId: string): void {
    const root = folders.current.find(item => item.id === rootId)
    const node = root && folderNode(root, nodeId)
    if (!root || !node) return
    if (root.ref.session !== currentSession.current) { setWorkspaceNotice('Select the folder again using Locate…'); return }
    const expanded = !node.expanded
    setFolders(updateFolder(folders.current, rootId, nodeId, before => ({ ...before, expanded, ...(!expanded ? { loading: false } : {}) })))
    if (expanded) refreshDirectory(rootId, nodeId)
    else {
      const key = rootId + ':' + nodeId
      folderRequests.current.set(key, (folderRequests.current.get(key) ?? 0) + 1)
    }
  }

  function refreshDirectory(rootId: string, nodeId: string): void {
    const root = folders.current.find(item => item.id === rootId)
    const node = root && folderNode(root, nodeId)
    if (!node) return
    void listDirectory(rootId, nodeId)
    if (node.expanded) node.children?.filter(child => child.kind === 'directory' && child.expanded)
      .forEach(child => refreshDirectory(rootId, child.id))
  }

  function refreshFolders(): void {
    folders.current.filter(root => root.node.expanded).forEach(root => refreshDirectory(root.id, root.node.id))
  }

  function removeFolder(rootId: string): void {
    if (navigating.current) { setWorkspaceNotice('Finish opening the file before removing its folder'); return }
    const root = folders.current.find(item => item.id === rootId)
    setFolders(folders.current.filter(item => item.id !== rootId))
    if (root?.ref.session === currentSession.current) void core.call('removeRoot', { root: rootId, session: root.ref.session }).catch(() => {})
    if (!recharged.current && workspace.getSnapshot().ready)
      void metadata(current => chargeWorkspace(workspace.getSnapshot().tabs, current)).then(paid => { recharged.current = !!paid })
    releaseEmptyWorkspace()
  }



  function focusReader(id: string): void {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"] .csv-grid, [data-card="${CSS.escape(id)}"] .md-scroller, [data-card="${CSS.escape(id)}"] .vl-scroller`)?.focus({ preventScroll: true }))
  }

  function restorePreviewFocus(group: LinkPreview): void {
    focusCard(group.sourceId)
    requestAnimationFrame(() => {
      if (group.trigger.isConnected) group.trigger.focus({ preventScroll: true })
      else focusReader(group.sourceId)
    })
  }

  async function openLink(cardId: string, source: Opened, target: string, path: string, gesture: LocalGesture): Promise<boolean> {
    if (splitBusy.current || previewWork.current || !source.view || source.view.session !== hello.current?.session) return false
    const origin = allGroups.current.find(group => group.id === cardId)
    if (!origin) return false
    const sourceId = previewRef.current?.id === cardId ? previewRef.current.sourceId : cardId
    let created: ReaderGroup | null = null
    let freshPreview: LinkPreview | null = null
    splitBusy.current = true
    previewWork.current = 'opening'
    setPreviewBusy(true)
    try {
      if (gesture.mode === 'peek') {
        if (previewRef.current) {
          if (previewRef.current.id !== cardId) { setWorkspaceNotice('Close the current preview before opening another'); return false }
          return await handles.current.get(cardId)?.navigateLocal(source, target, path) ?? false
        }
        pendingSplit.current = 32 * 16_384 + (8 << 20)
        if (!await charge(null, null, () => true)) return false
        const id = 'preview-' + nextCard.current++
        const store = new WorkspaceStore(id + '-tab')
        if (hello.current) store.coreReady(hello.current.session)
        const rect = document.querySelector<HTMLElement>(`[data-card="${CSS.escape(sourceId)}"]`)?.getBoundingClientRect()
        freshPreview = { id, workspace: store, weight: 1, sourceId, trigger: gesture.trigger,
          width: Math.min(Math.max((rect?.width ?? 800) * .45, 420), window.innerWidth - 32), right: Math.max(16, window.innerWidth - (rect?.right ?? window.innerWidth - 16)) }
        setPreview(freshPreview)
        const reader = await waitForReader(id)
        const opened = await reader.openDerived(source, target, path)
        if (!opened) previewCloseRequested.current = true
        return opened
      }
      let destination = groupRef.current.find(group => group.id === sourceId) ?? groupRef.current[0]
      if (gesture.mode === 'side') {
        const index = groupRef.current.indexOf(destination)
        const neighbor = groupRef.current[index + 1] ?? groupRef.current[index - 1]
        if (neighbor) destination = neighbor
        else { created = await newRight(destination.id); if (created) destination = created }
      }
      const reader = await waitForReader(destination.id)
      if (reader.busy() || closingCards.current.has(destination.id)) return false
      const opened = await reader.openDerived(source, target, path)
      if (opened) { focusCard(destination.id); focusReader(destination.id) }
      return opened
    } catch (error) {
      if (freshPreview) previewCloseRequested.current = true
      if (error instanceof CoreCallError && error.code === 'Frozen') throw error
      setWorkspaceNotice('Cannot open local link · ' + String(error))
      return false
    } finally {
      pendingSplit.current = 0
      splitBusy.current = false
      previewWork.current = null
      setPreviewBusy(false)
      if (created && !created.workspace.getSnapshot().tabs.length) await closeCard(created.id)
      if (previewCloseRequested.current) { previewCloseRequested.current = false; await closePreview() }
    }
  }

  async function closePreview(): Promise<void> {
    const group = previewRef.current
    if (!group) return
    if (previewWork.current) { previewCloseRequested.current = true; return }
    previewWork.current = 'closing'
    setPreviewBusy(true)
    const handle = handles.current.get(group.id)
    let retirement: ReturnType<ReaderHandle['prepareRetirement']> | undefined
    let detached = false
    try {
      if (handle) {
        retirement = handle.prepareRetirement()
        const before = retiredPeak.current
        retiredPeak.current = Math.max(before, retirement.bytes)
        if (hello.current && !await charge(null, null, () => previewRef.current === group)) { retiredPeak.current = before; retirement.cancel(); return }
        await handle.detach(true)
        detached = true
        const surface = handle.surface()
        if (surface && surface.session === hello.current?.session && !await core.call('releaseSurface', { surface, retiredBytes: retirement.bytes })) throw new Error('The preview could not be released')
      }
      for (const tab of group.workspace.getSnapshot().tabs) for (const entry of tab.back ?? []) releaseLocation(entry)
      pendingHistory.current.delete(group.id)
      setPreview(null)
      restorePreviewFocus(group)
      requestAnimationFrame(() => { if (!previewRef.current) for (const path of waiting.current.splice(0)) focusedReader()?.open(path) })
      releaseEmptyWorkspace()
    } catch (error) {
      setWorkspaceNotice('Cannot close preview · ' + String(error))
      if (detached) await handle?.resume()
      else retirement?.cancel()
    } finally { previewWork.current = null; previewCloseRequested.current = false; setPreviewBusy(false) }
  }

  async function promotePreview(side: boolean): Promise<void> {
    const group = previewRef.current, handle = group && handles.current.get(group.id)
    if (!group || !handle || handle.busy() || previewWork.current || splitBusy.current) return
    previewWork.current = 'promoting'; splitBusy.current = true; setPreviewBusy(true)
    let destination = groupRef.current.find(item => item.id === group.sourceId) ?? groupRef.current[0]
    let created: ReaderGroup | null = null
    let target: ReaderHandle | undefined
    let a: ReturnType<ReaderHandle['prepareRetirement']> | undefined
    let b: ReturnType<ReaderHandle['prepareRetirement']> | undefined
    let detached = false, moved = false
    try {
      if (side) {
        const index = groupRef.current.indexOf(destination)
        const neighbor = groupRef.current[index + 1] ?? groupRef.current[index - 1]
        if (neighbor) destination = neighbor
        else { created = await newRight(destination.id); if (created) destination = created }
      }
      if (closingCards.current.has(destination.id)) throw new Error('The destination card is busy')
      closingCards.current.add(destination.id)
      target = await waitForReader(destination.id)
      if (target.busy()) throw new Error('The destination card is busy')
      const tab = group.workspace.tab(group.workspace.getSnapshot().selected ?? '')
      if (!tab || tab.card.kind !== 'open') return
      a = handle.prepareRetirement(); b = target.prepareRetirement()
      const before = retiredPeak.current
      retiredPeak.current = Math.max(before, a.bytes + b.bytes)
      if (!await charge(null, null, () => previewRef.current === group)) { retiredPeak.current = before; return }
      await handle.detach(true)
      detached = true
      const from = handle.surface(), to = target.surface()
      if (!from || !to || !await core.call('transferDoc', { from, to, doc: tab.card.opened.doc, gen: tab.card.opened.gen })) throw new Error('The preview document could not move')
      destination.workspace.adoptTabs(group.workspace.takeTabs([tab.id]))
      destination.workspace.select(tab.id)
      moved = true
      await target.resume()
      if (from.session === hello.current?.session && !await core.call('releaseSurface', { surface: from, retiredBytes: a.bytes })) throw new Error('The empty preview surface could not be released')
      pendingHistory.current.delete(group.id)
      setPreview(null)
      focusCard(destination.id)
      focusReader(destination.id)
      requestAnimationFrame(() => { if (!previewRef.current) for (const path of waiting.current.splice(0)) focusedReader()?.open(path) })
    } catch (error) {
      setWorkspaceNotice('Cannot promote preview · ' + String(error))
      if (detached && !moved) await handle.resume()
      if (moved) { setPreview(null); focusCard(destination.id); focusReader(destination.id) }
    } finally {
      if (!detached) a?.cancel()
      if (!moved) b?.cancel()
      closingCards.current.delete(destination.id)
      pendingSplit.current = 0
      previewWork.current = null; splitBusy.current = false; setPreviewBusy(false)
      if (created && !moved) await closeCard(created.id)
      if (previewCloseRequested.current && previewRef.current === group) { previewCloseRequested.current = false; await closePreview() }
      else previewCloseRequested.current = false
    }
  }

  async function waitForReader(id: string): Promise<ReaderHandle> {
    const session = hello.current?.session
    if (!session || !allGroups.current.some(group => group.id === id)) throw new Error('Reader card is unavailable')
    return new Promise<ReaderHandle>((resolve, reject) => {
      let started = false, settled = false
      const waiter = {
        id,
        cancel(message: string) {
          if (settled) return
          settled = true
          readerWaiters.current.delete(waiter)
          reject(new Error(message))
        },
        start(handle: ReaderHandle) {
          if (started || settled) return
          started = true
          void handle.ready().then(() => {
            if (settled) return
            if (hello.current?.session !== session || handles.current.get(id) !== handle || !allGroups.current.some(group => group.id === id)) {
              waiter.cancel('Reader card changed while creating its surface')
              return
            }
            if (handle.surface()?.session !== session) { waiter.cancel('Reader surface could not be created'); return }
            settled = true
            readerWaiters.current.delete(waiter)
            resolve(handle)
          }, error => waiter.cancel(String(error)))
        }
      }
      readerWaiters.current.add(waiter)
      const handle = handles.current.get(id)
      if (handle) waiter.start(handle)
    })
  }
  function releaseLocation(entry: ClosedLocation['entry']): void {
    if (entry.location.kind === 'derived' && entry.location.ticket.session === currentSession.current) void core.call('releaseSaved', { ticket: entry.location.ticket }).catch(() => {})
  }
  async function newRight(sourceId: string): Promise<ReaderGroup | null> {
    if (!row.current || (groupRef.current.length + 1) * 320 + groupRef.current.length * 16 > row.current.clientWidth) {
      setWorkspaceNotice('Not enough room to split · the file remains in this card as a tab')
      return null
    }
    pendingSplit.current = 32 * 16_384 + (8 << 20)
    if (!await charge(null, null, () => true)) { pendingSplit.current = 0; return null }
    const id = 'card-' + nextCard.current++
    const store = new WorkspaceStore(id + '-tab')
    if (hello.current) store.coreReady(hello.current.session)
    const group = { id, workspace: store, weight: 1 }
    const next = [...groupRef.current]
    next.splice(next.findIndex(item => item.id === sourceId) + 1, 0, group)
    updateGroups(next)
    return group
  }
  async function splitRight(): Promise<void> {
    const sourceId = focusedRef.current, source = handles.current.get(sourceId)
    if (!source || source.busy() || splitBusy.current || closingCards.current.has(sourceId)) return
    splitBusy.current = true
    let entry: ClosedLocation['entry'] | null = null
    let created: ReaderGroup | null = null
    try {
      const group = groupRef.current.find(item => item.id === sourceId)
      const selected = group?.workspace.tab(group.workspace.getSnapshot().selected ?? '')
      entry = await source.capture()
      if (selected?.card.kind === 'open' && !entry) { setWorkspaceNotice('Cannot split · the current location could not be saved'); return }
      created = await newRight(sourceId)
      if (!created) return
      const right = await waitForReader(created.id)
      if (entry && !await right.restore(entry)) { await closeCard(created.id); return }
      if (groupRef.current.some(group => group.id === created!.id)) focusCard(created.id)
    } catch (error) {
      setWorkspaceNotice('Cannot split · ' + String(error))
      if (created) await closeCard(created.id)
    } finally { if (entry) releaseLocation(entry); pendingSplit.current = 0; splitBusy.current = false }
  }
  async function closeCard(id: string): Promise<void> {
    const source = groupRef.current.find(group => group.id === id), handle = handles.current.get(id)
    if (!source || closingCards.current.has(id)) return
    if (!handle) {
      if (groupRef.current.length > 1 && source.workspace.getSnapshot().tabs.length === 0) {
        updateGroups(groupRef.current.filter(group => group.id !== id))
        pendingHistory.current.delete(id)
        if (focusedRef.current === id) focusCard(groupRef.current[0].id)
        releaseEmptyWorkspace()
      }
      return
    }
    if (groupRef.current.length === 1) { await handle.close(); return }
    closingCards.current.add(id)
    const index = groupRef.current.indexOf(source)
    const destination = groupRef.current[index > 0 ? index - 1 : 1]
    if (closingCards.current.has(destination.id)) { closingCards.current.delete(id); return }
    closingCards.current.add(destination.id)
    const wasEmpty = !destination.workspace.getSnapshot().selected
    let target: ReaderHandle | undefined
    let retirement: ReturnType<ReaderHandle['prepareRetirement']> | undefined
    let detached = false
    try {
      target = await waitForReader(destination.id)
      retirement = handle.prepareRetirement()
      const previous = retiredPeak.current
      retiredPeak.current = Math.max(previous, retirement.bytes)
      if (!await charge(null, null, () => groupRef.current.includes(source))) { retiredPeak.current = previous; retirement.cancel(); return }
      await handle.detach(true)
      detached = true
      const from = handle.surface(), to = target.surface()
      for (const tab of source.workspace.getSnapshot().tabs) {
        if (tab.card.kind === 'open' && tab.session === currentSession.current) {
          if (!from || !to || !await core.call('transferDoc', { from, to, doc: tab.card.opened.doc, gen: tab.card.opened.gen })) throw new Error('The document could not move to the neighboring card')
        }
        destination.workspace.adoptTabs(source.workspace.takeTabs([tab.id]))
      }
      if (from && from.session === currentSession.current) await core.call('releaseSurface', { surface: from, retiredBytes: retirement.bytes })
      for (const item of closed.current) if (item.cardId === id) item.cardId = destination.id
      pendingHistory.current.delete(id)
      updateGroups(groupRef.current.filter(group => group.id !== id))
      focusCard(destination.id)
      if (wasEmpty) await target.activateSelected()
    } catch (error) {
      setWorkspaceNotice('Cannot close card · ' + String(error))
      if (detached) await handle.resume()
      else retirement?.cancel()
      if (wasEmpty) await target?.activateSelected()
    } finally { closingCards.current.delete(id); closingCards.current.delete(destination.id) }
  }
  async function moveTabRight(): Promise<void> {
    const source = groupRef.current.find(group => group.id === focusedRef.current), handle = source && handles.current.get(source.id)
    if (!source || !handle || handle.busy() || splitBusy.current || closingCards.current.has(source.id)) return
    splitBusy.current = true
    closingCards.current.add(source.id)
    let created: ReaderGroup | null = null
    let destination: ReaderGroup | undefined
    let target: ReaderHandle | undefined
    let a: ReturnType<ReaderHandle['prepareRetirement']> | undefined
    let b: ReturnType<ReaderHandle['prepareRetirement']> | undefined
    let detached = false
    let moved = false
    try {
      const tab = source.workspace.tab(source.workspace.getSnapshot().selected ?? '')
      if (!tab) return
      destination = groupRef.current[groupRef.current.indexOf(source) + 1]
      if (!destination) { created = await newRight(source.id); if (!created) return; destination = created }
      if (closingCards.current.has(destination.id)) throw new Error('The destination card is busy')
      closingCards.current.add(destination.id)
      target = await waitForReader(destination.id)
      a = handle.prepareRetirement()
      b = target.prepareRetirement()
      const previous = retiredPeak.current
      retiredPeak.current = Math.max(previous, a.bytes + b.bytes)
      if (!await charge(null, null, () => true)) { retiredPeak.current = previous; return }
      await Promise.all([handle.detach(true), target.detach(true)])
      detached = true
      if (tab.card.kind === 'open') {
        const from = handle.surface(), to = target.surface()
        if (!from || !to || !await core.call('transferDoc', { from, to, doc: tab.card.opened.doc, gen: tab.card.opened.gen })) throw new Error('The tab could not move')
      }
      destination.workspace.adoptTabs(source.workspace.takeTabs([tab.id]))
      destination.workspace.select(tab.id)
      moved = true
      await Promise.all([handle.resume(), target.resume()])
      focusCard(destination.id)
    } catch (error) {
      setWorkspaceNotice('Cannot move tab · ' + String(error))
      if (detached) await Promise.all([handle.resume(), target?.resume()])
    } finally {
      if (!detached) { a?.cancel(); b?.cancel() }
      closingCards.current.delete(source.id)
      if (destination) closingCards.current.delete(destination.id)
      if (created && !moved) await closeCard(created.id)
      pendingSplit.current = 0
      splitBusy.current = false
    }
  }
  function run(command: Command): void {
    if (command === 'go-to' || command === 'copy' || command === 'print') {
      const reader = previewRef.current ? handles.current.get(previewRef.current.id) : focusedReader()
      if (command === 'go-to') reader?.goTo()
      else if (command === 'copy') void reader?.copy()
      else reader?.print()
      return
    }
    if (command === 'find' || command === 'find-next' || command === 'find-previous') {
      const reader = previewRef.current ? handles.current.get(previewRef.current.id) : focusedReader()
      reader?.find(command === 'find' ? 'open' : command === 'find-next' ? 'next' : 'previous')
      return
    }
    if (previewRef.current) {
      if (command === 'close-tab' || command === 'close-card') void closePreview()
      else if (command === 'split-right' || command === 'move-tab-right') void promotePreview(true)
      else if (command === 'reload') void handles.current.get(previewRef.current.id)?.reload()
      else if (command === 'exit') window.close()
      else setWorkspaceNotice('Close the preview before changing the workspace')
      return
    }
    const reader = focusedReader()
    if (command === 'open') void reader?.pick()
    else if (command === 'open-folder') void pickFolder()
    else if (command === 'toggle-sidebar') setSidebarOpen(open => !open)
    else if (command === 'refresh-folders') refreshFolders()
    else if (command === 'reload') { refreshFolders(); void reader?.reload() }
    else if (command === 'close-tab') void reader?.close()
    else if (command === 'reopen-tab') void (handles.current.get(closed.current.at(-1)?.cardId ?? '') ?? reader)?.reopen()
    else if (command === 'clear-closed') reader?.clearClosed()
    else if (command === 'split-right') void splitRight()
    else if (command === 'close-card') void closeCard(focusedRef.current)
    else if (command === 'move-tab-right') void moveTabRight()
    else if (command === 'exit') window.close()
  }
  function resizeCards(index: number, delta: number): void {
    const cards = row.current?.querySelectorAll<HTMLElement>('.reader-card')
    if (!cards?.[index + 1]) return
    const left = cards[index].getBoundingClientRect().width, right = cards[index + 1].getBoundingClientRect().width
    const next = Math.max(320, Math.min(left + right - 320, left + delta))
    updateGroups(groupRef.current.map((group, i) => ({ ...group, weight: i === index ? next : i === index + 1 ? left + right - next : cards[i].getBoundingClientRect().width })))
  }
  if (__TEST_HOOKS__) { appHooks.close = () => void focusedReader()?.close(); appHooks.workspace = () => workspaceBudget.current?.snapshot() ?? null }

  return <>
    <header className={MAC ? 'titlebar mac' : 'titlebar'}>
      <span className="titlebar-start">{MAC ? null : <><AppIcon /><AppMenu run={run} /></>}
        <Button className="sidebar-toggle" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onPress={() => setSidebarOpen(open => !open)}>»</Button>
      </span>
      <span className="title" {...{ elementtiming: 'titlebar' }}>{title}</span>
    </header>
    <div className="workspace-canvas" style={{ '--sidebar-offset': `${sidebarOpen && !sidebarOverlay ? sidebarWidth + 16 : 0}px` } as CSSProperties}>
      {sidebarOpen ? <FolderSidebar roots={folderRoots} width={sidebarWidth} overlay={sidebarOverlay} activeNode={activeNode}
        onWidth={setSidebarWidth} onCollapse={() => { setSidebarOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('.sidebar-toggle')?.focus()) }}
        onAdd={() => void pickFolder()} onToggle={toggleFolder} onOpen={(root, node) => void focusedReader()?.openChild(root, node)}
        onRefresh={refreshDirectory} onMore={(root, node) => void listDirectory(root, node, true)} onRemove={removeFolder} onLocate={root => void pickFolder(root)} /> : null}
      <main className="card-row" ref={row}>
        {groups.map((group, index) => <div className="card-slot" style={{ flexGrow: group.weight }} key={group.id}>
          <ReaderCard id={group.id} label={index + 1} workspace={group.workspace} window={shared} fonts={fonts} focused={focused === group.id}
            onFocus={() => focusCard(group.id)} onCloseCard={() => void closeCard(group.id)} windowNotice={workspaceNotice}
            emptyContent={<div className="workspace-empty">
              <h1>Drop files or folders anywhere</h1>
              <div className="workspace-empty-actions"><Button className="open-button" onPress={() => { focusCard(group.id); run('open') }}>Open file… <kbd>{MAC ? '⌘O' : 'Ctrl+O'}</kbd></Button>
                <Button className="open-button" onPress={() => void pickFolder()}>Open folder…</Button></div>
              {recents.length ? <section aria-label="Recent files and folders"><h2>Recent</h2>{recents.map(recent =>
                <button className="recent-location" key={recent.kind + recent.path} title={recent.path} onClick={() => {
                  focusCard(group.id)
                  if (recent.kind === 'folder') void pickFolder(undefined, recent.path)
                  else handles.current.get(group.id)?.open(recent.path)
                }}><FileIcon path={recent.path} /><span>{fileName(recent.path)}<small>{recent.path}</small></span></button>)}</section> : null}
            </div>} />
          {index < groups.length - 1 ? <div className="card-divider" role="separator" aria-label="Card divider" aria-orientation="vertical" tabIndex={0}
            onDoubleClick={() => updateGroups(groupRef.current.map(item => ({ ...item, weight: 1 })))}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeCards(index, event.key === 'ArrowLeft' ? -16 : 16) } }}
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.x = String(event.clientX) }}
            onPointerMove={event => { const x = event.currentTarget.dataset.x; if (x !== undefined) { resizeCards(index, event.clientX - Number(x)); event.currentTarget.dataset.x = String(event.clientX) } }}
            onPointerUp={event => { delete event.currentTarget.dataset.x }} onPointerCancel={event => { delete event.currentTarget.dataset.x }} /> : null}
        </div>)}
      </main>
      {preview ? <ModalOverlay isOpen isDismissable className="link-preview-overlay" onOpenChange={open => { if (!open) void closePreview() }}>
        <Modal className="link-preview-frame" style={{ width: preview.width, right: `min(${preview.right}px, max(16px, calc(100vw - ${preview.width}px - 16px)))` }}>
          <Dialog aria-label="Link preview" className="link-preview-dialog">
            <ReaderCard id={preview.id} label={0} workspace={preview.workspace} window={shared} fonts={fonts} focused
              onFocus={() => {}} onCloseCard={() => void closePreview()} windowNotice={workspaceNotice}
              preview={{ busy: previewBusy, onTab: () => void promotePreview(false), onSide: () => void promotePreview(true), onClose: () => void closePreview() }} />
          </Dialog>
        </Modal>
      </ModalOverlay> : null}
    </div>
  </>
}
