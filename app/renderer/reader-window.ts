import type { RefObject } from 'react'
import type { Hello, Opened, SurfaceRef } from '../shared/protocol'
import type { CoreClient } from './core'
import type { RootView } from './folders'
import type { SavedLocation, TabId, WorkspaceMetadataQueue, WorkspaceStore, WorkspaceTab } from './workspace'
import type { WorkspaceBudget } from './workspace-budget'
import type { SessionCard } from '../shared/session'

export interface ReaderGroup { id: string; workspace: WorkspaceStore; weight: number }
export interface ClosedLocation { entry: SavedLocation; index: number; cardId: string }
export interface LocalGesture { mode: 'peek' | 'tab' | 'side'; trigger: HTMLElement }
export interface ReaderHandle {
  ready(): Promise<void>
  open(path: string): void
  openChild(root: string, node: string): Promise<void>
  openIndexed(entry: import('../shared/protocol').FolderEntry): Promise<void>
  openDerived(source: Opened, target: string, path: string): Promise<boolean>
  navigateLocal(source: Opened, target: string, path: string): Promise<boolean>
  pick(): Promise<void>
  reload(): Promise<void>
  back(): Promise<void>
  close(): Promise<void>
  reopen(): Promise<void>
  clearClosed(): void
  cycle(step: number): void
  find(action: 'open' | 'next' | 'previous' | 'close'): boolean
  goTo(): void
  copy(): Promise<boolean>
  print(): void
  switchLens(): void
  captureSession(): Promise<SessionCard | null>
  restoreSession(card: SessionCard): Promise<void>
  selectTab(id: string): Promise<void>
  capture(): Promise<SavedLocation | null>
  restore(entry: SavedLocation): Promise<boolean>
  detach(closing: boolean): Promise<number>
  retirement(): number
  prepareRetirement(): { bytes: number; cancel(): void }
  resume(): Promise<void>
  activateSelected(): Promise<void>
  surface(): SurfaceRef | null
  busy(): boolean
}

/** Window-owned resources shared by the current reader cards; no document payload lives here. */
export interface ReaderWindow {
  settings?: import('../shared/settings').Settings
  core: CoreClient
  hello: RefObject<Hello | null>
  groups: RefObject<readonly ReaderGroup[]>
  closed: RefObject<ClosedLocation[]>
  folders: RefObject<readonly RootView[]>
  pendingFolders: RefObject<Map<symbol, number>>
  budget: RefObject<WorkspaceBudget | null>
  peak: RefObject<number>
  queue: WorkspaceMetadataQueue
  pendingWorkspace: RefObject<Map<TabId, { units: number }>>
  pendingNative: RefObject<Set<symbol>>
  pendingHistory: Map<string, number>
  recharged: RefObject<boolean>
  paid(): Promise<boolean>
  charge(owner: WorkspaceStore | null, tabs: readonly Pick<WorkspaceTab, 'key' | 'path'>[] | null, current: () => boolean): Promise<boolean>
  release(): void
  notice(message: string): void
  opened(): void
  openLink(cardId: string, source: Opened, target: string, path: string, gesture: LocalGesture): Promise<boolean>
  report(cardId: string, title: string, folderNode?: string): void
  register(cardId: string, handle: ReaderHandle): () => void
}
