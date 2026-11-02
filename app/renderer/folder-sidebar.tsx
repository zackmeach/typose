import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { FileIcon } from './file-icon'
import './folder-sidebar.css'

export interface FolderNodeView {
  id: string
  name: string
  kind: 'directory' | 'file' | 'unsupported'
  expanded?: boolean
  loading?: boolean
  error?: string
  children?: readonly FolderNodeView[]
  hasMore?: boolean
}

export interface FolderRootView {
  id: string
  path: string
  node: FolderNodeView
  unavailable?: boolean
}

export interface FolderSidebarProps {
  roots: readonly FolderRootView[]
  width: number
  overlay: boolean
  activeNode?: string
  onWidth(width: number): void
  onCollapse(): void
  onAdd(): void
  onToggle(root: string, node: string): void
  onOpen(root: string, node: string): void
  onRefresh(root: string, node: string): void
  onMore(root: string, node: string): void
  onRemove(root: string): void
  onLocate(root: string): void
}

const widthWithinBounds = (width: number) => Math.max(180, Math.min(420, width))

/** Display-only tree. Every action returns opaque root/node IDs to its owner. */
export function FolderSidebar(props: FolderSidebarProps) {
  const tree = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const visibleIds: string[] = []
  const collect = (root: string, node: FolderNodeView) => {
    visibleIds.push(root + ':' + node.id)
    if (node.expanded) node.children?.forEach(child => collect(root, child))
  }
  props.roots.forEach(root => collect(root.id, root.node))
  const tabStop = focused && visibleIds.includes(focused) ? focused : visibleIds[0]
  const focusRow = (root: string, id: string) => {
    const row = [...tree.current!.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(item => item.dataset.node === root + ':' + id)
    row?.focus()
  }
  const key = (event: KeyboardEvent<HTMLDivElement>, root: string, node: FolderNodeView, parent?: string) => {
    if (event.target !== event.currentTarget) return
    const rows = [...tree.current!.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const index = rows.indexOf(event.currentTarget)
    let target: HTMLElement | undefined
    if (event.key === 'ArrowDown') target = rows[index + 1]
    else if (event.key === 'ArrowUp') target = rows[index - 1]
    else if (event.key === 'Home') target = rows[0]
    else if (event.key === 'End') target = rows.at(-1)
    else if (event.key === 'ArrowRight' && node.kind === 'directory') {
      if (!node.expanded) props.onToggle(root, node.id)
      else target = rows[index + 1]
    } else if (event.key === 'ArrowLeft') {
      if (node.kind === 'directory' && node.expanded) props.onToggle(root, node.id)
      else if (parent) focusRow(root, parent)
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (node.kind === 'directory') props.onToggle(root, node.id)
      else props.onOpen(root, node.id)
    } else return
    event.preventDefault()
    event.stopPropagation()
    target?.focus()
  }
  const nodeView = (root: FolderRootView, node: FolderNodeView, level: number, parent?: string) => (
    <div className={level === 1 ? 'folder-root' : 'folder-node'} role="treeitem" key={node.id}
      aria-label={node.name} aria-level={level} aria-expanded={node.kind === 'directory' ? !!node.expanded : undefined}
      aria-selected={node.kind !== 'directory' ? props.activeNode === root.id + ':' + node.id : undefined}
      aria-busy={node.loading || undefined} data-node={root.id + ':' + node.id}
      tabIndex={tabStop === root.id + ':' + node.id ? 0 : -1}
      onFocus={event => { if (event.target === event.currentTarget) setFocused(root.id + ':' + node.id) }}
      onKeyDown={event => key(event, root.id, node, parent)}>
      <div className="folder-row" data-active={props.activeNode === root.id + ':' + node.id || undefined}
        data-unsupported={node.kind === 'unsupported' || undefined} style={{ paddingLeft: 8 + (level - 1) * 16 }}
        title={level === 1 ? root.path : node.name}
        onClick={event => {
          event.stopPropagation()
          focusRow(root.id, node.id)
          if (node.kind === 'directory') props.onToggle(root.id, node.id)
          else props.onOpen(root.id, node.id)
        }}>
        <span className="folder-disclosure" aria-hidden="true">{node.kind === 'directory' ? node.expanded ? '⌄' : '›' : ''}</span>
        {node.kind === 'directory' ? <svg className="folder-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M1.5 4V2.5h5l1.5 2h6.5v9h-13z" /></svg> : <FileIcon path={node.name} />}
        <span className="folder-name">{node.name}</span>
        {level === 1 ? <span className="folder-actions" onClick={event => event.stopPropagation()}>
          <Button className="folder-action" aria-label={'Refresh ' + node.name} onPress={() => props.onRefresh(root.id, node.id)}>⟳</Button>
          <MenuTrigger>
            <Button className="folder-action" aria-label={'Folder actions for ' + node.name}>⋯</Button>
            <Popover className="menu-popover" placement="bottom end">
              <Menu className="menu" onAction={action => {
                if (action === 'refresh') props.onRefresh(root.id, node.id)
                else props.onRemove(root.id)
              }}>
                <MenuItem id="refresh" className="menu-item">Refresh</MenuItem>
                <MenuItem id="remove" className="menu-item">Remove from workspace</MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </span> : null}
      </div>
      {node.error ? <div className="folder-error" role="status">
        {node.error}
        {level === 1 ? <><Button className="folder-inline" onPress={() => props.onLocate(root.id)}>Locate…</Button><Button className="folder-inline" onPress={() => props.onRemove(root.id)}>Remove</Button></> : null}
      </div> : null}
      {node.expanded ? <div role="group">
        {node.children?.map(child => nodeView(root, child, level + 1, node.id))}
        {node.loading ? <div className="folder-loading" role="status">Loading…</div> : null}
        {node.hasMore ? <Button className="folder-more" isDisabled={node.loading} onPress={() => props.onMore(root.id, node.id)}>Load more in {node.name}</Button> : null}
      </div> : null}
    </div>
  )
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, width: props.width }
  }
  return <>
    {props.overlay ? <button type="button" className="folder-scrim" aria-label="Close files overlay" onClick={props.onCollapse} /> : null}
    <aside className="folder-sidebar" style={{ width: props.width }} data-overlay={props.overlay || undefined} aria-label="Files sidebar"
      onKeyDown={event => { if (event.key === 'Escape' && props.overlay) { event.stopPropagation(); props.onCollapse() } }}>
      <div className="folder-heading"><span>FILES</span><Button className="folder-action" aria-label="Collapse sidebar" onPress={props.onCollapse}>«</Button></div>
      <div className="folder-tree" role="tree" aria-label="Files" ref={tree}>
        {props.roots.map(root => nodeView(root, root.node, 1))}
      </div>
      <Button className="folder-add" onPress={props.onAdd}>+ Add folder…</Button>
      <div className="folder-resizer" role="separator" aria-label="Sidebar width" aria-orientation="vertical"
        aria-valuemin={180} aria-valuemax={420} aria-valuenow={Math.round(props.width)} tabIndex={0}
        onPointerDown={startResize} onPointerMove={event => {
          if (drag.current) props.onWidth(widthWithinBounds(drag.current.width + event.clientX - drag.current.x))
        }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        onKeyDown={event => {
          const next = event.key === 'ArrowLeft' ? props.width - 16 : event.key === 'ArrowRight' ? props.width + 16 : event.key === 'Home' ? 180 : event.key === 'End' ? 420 : null
          if (next !== null) { event.preventDefault(); props.onWidth(widthWithinBounds(next)) }
        }} />
    </aside>
  </>
}
