import { useEffect, useRef, useState } from 'react'
import { Dialog, Modal, ModalOverlay } from 'react-aria-components'
import { COMMANDS, COMMAND_GROUPS, commandShortcut } from '../shared/commands'
import type { Command } from '../shared/protocol'
import type { RecentLocation } from '../shared/session'
import type { QuickFile, QuickIndex } from './workspace-search'
import { fuzzyScore } from './workspace-search'
import { fileName } from './card'
import { SHOW_IN_FOLDER } from './handoff'
export type QuickChoice = { recent: RecentLocation } | { file: QuickFile }
interface Result { id: string; label: string; path: string; score: number; badge?: string; command?: Command; choice?: QuickChoice }
interface Section { title: string; rows: Result[] }
const BADGES: Record<string, string> = { md: 'MD', markdown: 'MD', csv: 'CSV', tsv: 'CSV', json: 'JSON', jsonc: 'JSON', jsonl: 'JSONL', ndjson: 'JSONL', yaml: 'YAML', yml: 'YAML' }
const badge = (path: string, folder = false): string | undefined => folder ? 'DIR' : BADGES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
const sameFile = (path: string) => path.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase()
const byScore = (a: Result, b: Result) => b.score - a.score
/** Non-empty sections, the best-matching one first (ties keep their natural order), so the first row is always the best match. */
const ranked = (sections: Section[]): Section[] => sections.map(section => ({ ...section, rows: section.rows.filter(row => row.score > -Infinity).sort(byScore) }))
  .filter(section => section.rows.length).sort((a, b) => b.rows[0].score - a.rows[0].score)
export function WorkspaceOverlay({ mode, indexes, recents, close, browse, choose, run, enabled, wrapLines }: {
  mode: 'open' | 'palette'; indexes: readonly QuickIndex[]; recents: readonly RecentLocation[]; close(): void; browse(): void
  choose(choice: QuickChoice, side: boolean): void; run(command: Command): void; enabled(command: Command): boolean; wrapLines: boolean
}) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const recentRows: Result[] = recents.map(recent => ({ id: recent.kind + ':' + recent.path, label: fileName(recent.path), path: recent.path, badge: badge(recent.path, recent.kind === 'folder'),
    choice: { recent } as QuickChoice, score: fuzzyScore(query, recent.path) }))
  const recentFiles = new Set(recents.filter(recent => recent.kind === 'file').map(recent => sameFile(recent.path)))
  const states: Partial<Record<Command, string>> = { 'wrap-lines': wrapLines ? 'On' : 'Off' } // a setting's state, shown after its command
  const sections = ranked(mode === 'palette' ? COMMAND_GROUPS.map(group => ({ title: group.title, rows: group.ids.flatMap(id => {
    const command = COMMANDS.find(item => item.id === id)
    if (!command || !enabled(id)) return []
    const label = id === 'show-in-folder' ? SHOW_IN_FOLDER : command.label
    return [{ id, label, path: commandShortcut(command.shortcut, navigator.platform.startsWith('Mac')), badge: states[id], command: id, score: fuzzyScore(query, label) }]
  }) })) : [
    { title: 'RECENT', rows: recentRows },
    { title: 'IN OPEN FOLDERS', rows: indexes.flatMap(index => index.files).filter(file => !recentFiles.has(sameFile(file.absolute))).map(file => ({ id: file.ref.session + ':' + file.ref.root + ':' + file.ref.node,
      label: file.name, path: file.path, badge: badge(file.name), choice: { file } as QuickChoice, score: fuzzyScore(query, file.path) })) }
  ]).map(section => ({ ...section, rows: section.rows.slice(0, 100) }))
  const matches = sections.flatMap(section => section.rows)
  const current = Math.min(selected, Math.max(0, matches.length - 1))
  useEffect(() => { document.getElementById(`workspace-result-${current}`)?.scrollIntoView({ block: 'nearest' }) }, [current])
  const activate = (index: number, side: boolean) => {
    const row = matches[index]
    if (!row) return
    close()
    if (row.command) run(row.command)
    else if (row.choice) choose(row.choice, side)
  }
  let offset = 0
  return <ModalOverlay isOpen isDismissable className="workspace-overlay" onOpenChange={open => { if (!open) close() }}>
    <Modal className="workspace-search"><Dialog aria-label={mode === 'open' ? 'Quick open' : 'Command palette'}>
      <input ref={input} aria-label={mode === 'open' ? 'Search files' : 'Search commands'} role="combobox" aria-expanded aria-controls="workspace-results" aria-activedescendant={matches[current] ? `workspace-result-${current}` : undefined}
        placeholder={mode === 'open' ? 'Search files across open folders…' : 'Type a command…'} value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length)) }
          else if (event.key === 'Enter') { event.preventDefault(); activate(current, event.shiftKey) }
        }} />
      <div id="workspace-results" role="listbox" aria-label={mode === 'open' ? 'Files' : 'Commands'} className="workspace-results">
        {sections.map(section => {
          const first = offset
          offset += section.rows.length
          return <div key={section.title} role="group" aria-label={section.title}>
            <div className="workspace-heading" aria-hidden="true">{section.title}</div>
            {section.rows.map((result, at) => <div key={result.id} id={`workspace-result-${first + at}`} role="option" aria-selected={first + at === current} aria-label={result.command && result.badge ? `${result.label}, ${result.badge}` : undefined}
              className="workspace-result" onPointerMove={() => setSelected(first + at)} onClick={event => activate(first + at, event.shiftKey)} data-clipboard-copy={result.command === 'copy' ? 'true' : undefined} data-handoff={result.command === 'show-in-folder' || result.command === 'open-default' ? 'true' : undefined}>
              <strong>{result.label}</strong><small>{result.path}</small>{result.badge ? <em className="workspace-badge">{result.badge}</em> : null}
            </div>)}
          </div>
        })}
        {!matches.length ? <p>No matches</p> : null}
      </div>
      {mode === 'open' ? <div className="index-status" role="status">{indexes.map((index, i) => <div key={i}>{index.state}</div>)}</div> : null}
      <footer>{mode === 'open' ? <button onClick={() => { close(); browse() }}>Browse…</button> : <span>Commands apply to the focused card</span>}<span>↑↓ · ↵ {mode === 'open' ? 'open · Shift+↵ open to side' : 'run'} · Esc</span></footer>
    </Dialog></Modal>
  </ModalOverlay>
}
