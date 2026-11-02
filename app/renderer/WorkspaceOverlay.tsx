import { useEffect, useRef, useState } from 'react'
import { Dialog, Modal, ModalOverlay } from 'react-aria-components'
import { COMMANDS, commandShortcut } from '../shared/commands'
import type { Command } from '../shared/protocol'
import type { RecentLocation } from '../shared/session'
import type { QuickFile, QuickIndex } from './workspace-search'
import { fuzzyScore } from './workspace-search'
import { fileName } from './card'
export type QuickChoice = { recent: RecentLocation } | { file: QuickFile }
interface Result { id: string; label: string; path: string; score: number; command?: Command; choice?: QuickChoice }
export function WorkspaceOverlay({ mode, indexes, recents, close, browse, choose, run, enabled }: {
  mode: 'open' | 'palette'; indexes: readonly QuickIndex[]; recents: readonly RecentLocation[]; close(): void; browse(): void
  choose(choice: QuickChoice, side: boolean): void; run(command: Command): void; enabled(command: Command): boolean
}) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const rows: Result[] = mode === 'palette' ? COMMANDS.filter(command => command.id !== 'palette' && enabled(command.id)).map(command => ({ id: command.id, label: command.label, path: commandShortcut(command.shortcut, navigator.platform.startsWith('Mac')), command: command.id, score: fuzzyScore(query, command.label) })) : [
    ...recents.map(recent => ({ id: recent.kind + ':' + recent.path, label: fileName(recent.path), path: recent.path, choice: { recent } as QuickChoice, score: query ? fuzzyScore(query, recent.path) + 10 : 100 })),
    ...indexes.flatMap(index => index.files).map(file => ({ id: file.ref.session + ':' + file.ref.root + ':' + file.ref.node, label: file.name, path: file.path, choice: { file } as QuickChoice, score: fuzzyScore(query, file.path) }))
  ]
  const matches = rows.filter(row => row.score > -Infinity).sort((a, b) => b.score - a.score).slice(0, 100)
  const current = Math.min(selected, Math.max(0, matches.length - 1))
  useEffect(() => { document.getElementById(`workspace-result-${current}`)?.scrollIntoView({ block: 'nearest' }) }, [current])
  const activate = (index: number, side: boolean) => {
    const row = matches[index]
    if (!row) return
    close()
    if (row.command) run(row.command)
    else if (row.choice) choose(row.choice, side)
  }
  return <ModalOverlay isOpen isDismissable className="workspace-overlay" onOpenChange={open => { if (!open) close() }}>
    <Modal className="workspace-search"><Dialog aria-label={mode === 'open' ? 'Quick open' : 'Command palette'}>
      <input ref={input} aria-label={mode === 'open' ? 'Search files' : 'Search commands'} role="combobox" aria-expanded aria-controls="workspace-results" aria-activedescendant={matches[current] ? `workspace-result-${current}` : undefined}
        placeholder={mode === 'open' ? 'Search files across open folders…' : 'Type a command…'} value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length)) }
          else if (event.key === 'Enter') { event.preventDefault(); activate(current, event.shiftKey) }
        }} />
      <div id="workspace-results" role="listbox" aria-label={mode === 'open' ? 'Files' : 'Commands'} className="workspace-results">
        {matches.map((result, index) => <div key={result.id} id={`workspace-result-${index}`} role="option" aria-selected={index === current}
          className="workspace-result" onPointerMove={() => setSelected(index)} onClick={event => activate(index, event.shiftKey)} data-clipboard-copy={result.command === 'copy' ? 'true' : undefined}>
          <strong>{result.label}</strong><small>{result.path}</small>
        </div>)}
        {!matches.length ? <p>No matches</p> : null}
      </div>
      {mode === 'open' ? <div className="index-status" role="status">{indexes.map((index, i) => <div key={i}>{index.state}</div>)}</div> : null}
      <footer>{mode === 'open' ? <button onClick={() => { close(); browse() }}>Browse…</button> : null}<span>↑↓ · ↵ {mode === 'open' ? 'open · Shift+↵ open to side' : 'run'} · Esc</span></footer>
    </Dialog></Modal>
  </ModalOverlay>
}
