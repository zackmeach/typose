import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from 'react'
import type { HandoffSubject } from '../shared/protocol'
export { SHOW_IN_FOLDER } from './menu'

export type HandoffKind = 'copy' | 'show' | 'open'

const COPIED = 'Path copied'

/** What to do with a hand-off's message: `setNotice` shows it, and a confirmation clears itself after 3 s unless a newer notice has replaced it. An error stays. */
export function useHandOffNotice(setNotice: Dispatch<SetStateAction<string>>): (message: string) => void {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return useCallback((message: string) => {
    if (!message) return
    setNotice(message)
    if (message !== COPIED) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setNotice(now => now === message ? '' : now), 3000)
  }, [setNotice])
}

/** One hand-off, and what to tell the user: '' when there is nothing to say. Main checks every subject itself. */
export async function handOff(kind: HandoffKind, subject: HandoffSubject, path: string): Promise<string> {
  try {
    if (kind === 'copy') { await navigator.clipboard.writeText(path); return COPIED }
    const result = await (kind === 'show' ? window.typose.showInFolder(subject) : window.typose.openWithDefault(subject))
    return result.ok ? '' : result.reason
  } catch (e) {
    return (kind === 'copy' ? 'Copy failed · ' : '') + (e instanceof Error ? e.message : String(e))
  }
}
