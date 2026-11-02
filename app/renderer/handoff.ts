import type { HandoffSubject } from '../shared/protocol'
import { LINUX } from './menu'

/** Z79's names for revealing a file, per platform. */
export const SHOW_IN_FOLDER = navigator.platform.startsWith('Mac') ? 'Show in Finder' : LINUX ? 'Show in folder' : 'Show in Explorer'

export type HandoffKind = 'copy' | 'show' | 'open'

/** One hand-off, and what to tell the user: '' when there is nothing to say. Main checks every subject itself. */
export async function handOff(kind: HandoffKind, subject: HandoffSubject, path: string): Promise<string> {
  try {
    if (kind === 'copy') { await navigator.clipboard.writeText(path); return 'Path copied' }
    const result = await (kind === 'show' ? window.typose.showInFolder(subject) : window.typose.openWithDefault(subject))
    return result.ok ? '' : result.reason
  } catch (e) {
    return (kind === 'copy' ? 'Copy failed · ' : '') + (e instanceof Error ? e.message : String(e))
  }
}
