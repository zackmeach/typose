import type { CoreClient } from './core'
import type { FolderRef } from '../shared/protocol'
import type { RootView } from './folders'
export interface QuickFile { ref: FolderRef; name: string; path: string }
export interface QuickIndex { files: readonly QuickFile[]; state: string }
/** Capability-only traversal; display paths are never opened as manual paths. */
export async function indexRoot(core: CoreClient, root: RootView, hidden: boolean, excludes: readonly string[], changed: (result: QuickIndex) => void, signal: AbortSignal): Promise<void> {
  const files: QuickFile[] = [], queue = [{ ref: root.ref, prefix: root.node.name }]
  const excluded = new Set(excludes.map(s => s.toLowerCase()))
  let visited = 0
  try {
    for (let at = 0; at < queue.length; at++) {
      const directory = queue[at]
      let cursor: string | undefined
      do {
        if (signal.aborted) return
        const page = await core.call('listFolder', { folder: directory.ref, hidden, ...(cursor ? { cursor } : {}) }, signal)
        if (signal.aborted) return
        for (const entry of page.entries) {
          if (excluded.has(entry.name.toLowerCase())) continue
          const path = directory.prefix + '/' + entry.name
          if (entry.kind === 'directory') queue.push({ ref: entry.ref, prefix: path })
          else if (entry.kind === 'file') files.push({ ref: entry.ref, name: entry.name, path })
          visited++
          if (visited >= 50_000) { changed({ files, state: `Index capped at 50,000 entries in ${root.node.name}` }); return }
        }
        cursor = page.cursor
        changed({ files: [...files], state: `Indexing ${root.node.name} · ${files.length.toLocaleString()} files` })
      } while (cursor)
    }
    changed({ files, state: `${root.node.name} · ${files.length.toLocaleString()} files` })
  } catch (error) { if (!signal.aborted) changed({ files, state: `Index incomplete in ${root.node.name} · ${error instanceof Error ? error.message : String(error)}` }) }
}
export function fuzzyScore(query: string, value: string): number {
  const text = value.toLowerCase(), needle = query.trim().toLowerCase()
  if (!needle) return 0
  const exact = text.indexOf(needle)
  if (exact >= 0) return 1000 - exact - (text.length - needle.length) / 100
  let at = 0, score = 0, previous = -2
  for (const char of needle) {
    at = text.indexOf(char, at)
    if (at < 0) return -Infinity
    score += at === previous + 1 ? 8 : 1
    if (at === 0 || '/\\-_ .'.includes(text[at - 1])) score += 6
    previous = at++
  }
  return score - text.length / 100
}
