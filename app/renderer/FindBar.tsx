import { useSyncExternalStore } from 'react'
import { EMPTY_FIND, findStatus, type FindController } from './find'
import './find.css'

const subscribeEmpty = () => () => {}
const emptySnapshot = () => EMPTY_FIND
export function FindBar({ controller, query, matchCase, onQuery, onCase, onClose }: {
  controller?: FindController
  query: string
  matchCase: boolean
  onQuery(text: string): void
  onCase(value: boolean): void
  onClose(): void
}) {
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty, controller?.snapshot ?? emptySnapshot)
  return <div className="find-bar" role="search" aria-label="Find in file" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'search') { event.preventDefault(); controller?.next(event.shiftKey ? -1 : 1) }
  }}>
    <input type="search" aria-label="Find in file" placeholder="Find in file" value={query} maxLength={512}
      onChange={event => onQuery(event.target.value)} />
    <label className="find-case"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={event => onCase(event.target.checked)} />Aa</label>
    <button type="button" aria-label="Previous match" title="Previous match (Shift+F3)" disabled={!controller || !query} onClick={() => controller?.next(-1)}>↑</button>
    <button type="button" aria-label="Next match" title="Next match (F3)" disabled={!controller || !query} onClick={() => controller?.next(1)}>↓</button>
    <span role="status" aria-live="polite" className="find-status">{controller ? findStatus(query, state) : 'Find unavailable in this view'}</span>
    <button type="button" aria-label="Close find" title="Close find (Escape)" onClick={onClose}>×</button>
  </div>
}
