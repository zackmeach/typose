import type { FolderEntry, FolderRef, FolderRoot } from '../shared/protocol'
import type { FolderNodeView, FolderRootView } from './folder-sidebar'

export interface FolderNode extends Omit<FolderNodeView, 'children'> {
  ref: FolderRef
  children?: readonly FolderNode[]
  cursor?: string
}
export interface RootView extends Omit<FolderRootView, 'node'> {
  ref: FolderRef
  node: FolderNode
  identity?: string
}

export const rootView = (root: FolderRoot): RootView => ({ id: root.ref.root, ref: root.ref, path: root.path, identity: root.identity,
  node: { id: root.ref.node, ref: root.ref, name: root.label, kind: 'directory', expanded: true } })
export const entryView = (entry: FolderEntry): FolderNode => ({ id: entry.ref.node, ref: entry.ref, name: entry.name, kind: entry.kind })

export function folderNode(root: RootView, id: string): FolderNode | undefined {
  const find = (node: FolderNode): FolderNode | undefined => node.id === id ? node : node.children?.map(find).find(Boolean)
  return find(root.node)
}

/** A loaded entry's display path, for Copy path and the hand-off sheet only: hand-offs name its ref, never this. */
export function nodePath(root: RootView, id: string): string | undefined {
  const names = (node: FolderNode): string[] | undefined => {
    if (node.id === id) return []
    for (const child of node.children ?? []) {
      const below = names(child)
      if (below) return [child.name, ...below]
    }
  }
  const found = names(root.node)
  // ponytail: '\\' because folder roots are Windows-only today; take the root path's separator once they aren't.
  return found && [root.path.replace(/[\\/]+$/, ''), ...found].join('\\')
}

export function updateFolder(roots: readonly RootView[], root: string, node: string, update: (before: FolderNode) => FolderNode): readonly RootView[] {
  const change = (before: FolderNode): FolderNode => before.id === node ? update(before) : before.children ? { ...before, children: before.children.map(change) } : before
  return roots.map(item => item.id === root ? { ...item, node: change(item.node) } : item)
}

/** Loaded rows and scalar labels remain paid even when collapsed. The workspace adds its retired graph allowance. */
export function foldersCharge(roots: readonly RootView[]): number {
  let bytes = 0
  const charge = (node: FolderNode) => {
    bytes += 16_384 + 128 * (node.name.length + node.ref.root.length + node.ref.node.length + (node.cursor?.length ?? 0) + (node.error?.length ?? 0))
    node.children?.forEach(charge)
  }
  for (const root of roots) { bytes += 128 * root.path.length; charge(root.node) }
  return Number.isSafeInteger(bytes) ? bytes : Infinity
}
