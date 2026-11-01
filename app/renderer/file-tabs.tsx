import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { fileName, parentName } from './card'
import { FileIcon } from './file-icon'
import type { TabId, WorkspaceTab } from './workspace'
import './file-tabs.css'

/** Permanent files on the canvas; the selected card alone owns a document lens. */
export function FileTabs({ tabs, selected, onSelect, onClose, panelId = 'file-card' }: {
  tabs: readonly WorkspaceTab[]
  selected: TabId | null
  onSelect(id: TabId): void
  onClose(id: TabId): void
  panelId?: string
}) {
  const row = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  useEffect(() => {
    const element = row.current!
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [tabs])
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])
  const names = new Map<string, number>()
  for (const tab of tabs) names.set(fileName(tab.path), (names.get(fileName(tab.path)) ?? 0) + 1)
  const move = (event: KeyboardEvent, index: number) => {
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onSelect(tabs[next].id)
    row.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }
  return (
    <nav className="file-tabs" aria-label="File tabs">
      {/* ARIA ownership groups only tabs; their visually paired close controls remain separate native buttons. */}
      {tabs.length ? <div className="file-tab-list" role="tablist" aria-label="Files" aria-owns={tabs.map((tab) => `file-${tab.id}`).join(' ')} /> : null}
      <div className="file-tab-scroll" ref={row}>
        {tabs.map((tab, index) => (
          <div className="file-pill" data-selected={tab.id === selected || undefined} key={tab.id}>
            <button type="button" className="file-tab" role="tab" id={`file-${tab.id}`}
              aria-controls={tab.id === selected ? panelId : undefined} aria-labelledby={`file-label-${tab.id}`}
              aria-selected={tab.id === selected} tabIndex={tab.id === selected ? 0 : -1} title={tab.path}
              onClick={() => onSelect(tab.id)} onKeyDown={(event) => {
                if (event.key === 'Delete') {
                  event.preventDefault()
                  onClose(tab.id)
                } else move(event, index) // Enter and Space use the button's native click activation
              }}>
              <span className="file-tab-label" id={`file-label-${tab.id}`}>
                <FileIcon path={tab.path} />
                <span className="file-tab-name">{fileName(tab.path)}</span>
                {(names.get(fileName(tab.path)) ?? 0) > 1 ? <span className="file-tab-parent"> · {parentName(tab.path)}</span> : null}
              </span>
            </button>
            <button type="button" className="file-tab-close" aria-label={`Close ${fileName(tab.path)}`} title="Close tab"
              onClick={(event) => { event.stopPropagation(); onClose(tab.id) }}>×</button>
          </div>
        ))}
      </div>
      {overflow ? (
        <MenuTrigger>
          <Button className="file-tab-chooser" aria-label="All open files">⌄</Button>
          <Popover className="menu-popover" placement="bottom end">
            <Menu className="menu" aria-label="Open files" onAction={(key) => onSelect(String(key))}>
              {tabs.map((tab) => <MenuItem id={tab.id} key={tab.id} className="menu-item" textValue={tab.path}>
                {tab.id === selected ? '✓ ' : ''}{fileName(tab.path)} · {parentName(tab.path)}
              </MenuItem>)}
            </Menu>
          </Popover>
        </MenuTrigger>
      ) : null}
    </nav>
  )
}
