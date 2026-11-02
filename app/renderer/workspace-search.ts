import type { CoreClient } from './core'
import type { FolderRef, FolderRoot } from '../shared/protocol'
import type { RootView } from './folders'
export interface QuickFile { ref: FolderRef; name: string; path: string; absolute: string }
export interface QuickIndex { files: readonly QuickFile[]; state: string }
/** The core gives each root a 4,096-node table. The walk uses its own throwaway root so it can't spend the sidebar's. */
const SCRATCH_LIMIT = 3_500
/** Without a scratch root the walk shares the sidebar's table, so it leaves most of it free. */
const SHARED_LIMIT = 1_500
/** Traversal by capability; results are opened by their absolute path, since the scratch root is released when the walk ends. */
export async function indexRoot(core: CoreClient, root: RootView, hidden: boolean, excludes: readonly string[], changed: (result: QuickIndex) => void, signal: AbortSignal): Promise<void> {
  let scratch: FolderRoot | undefined
  try { scratch = await core.call('addRoot', { path: root.path }, signal) } catch { /* at the 16-root limit: walk the shared root, shallowly */ }
  if (signal.aborted) { release(core, scratch); return }
  const start = scratch?.ref ?? root.ref, limit = scratch ? SCRATCH_LIMIT : SHARED_LIMIT
  const files: QuickFile[] = [], queue = [{ ref: start, prefix: root.node.name, absolute: root.path.replace(/[\\/]+$/, '') }]
  const excluded = new Set(excludes.map(s => s.toLowerCase()))
  const partial = () => `Quick open shows the first ${limit.toLocaleString()} entries of ${root.node.name}`
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
          if (entry.kind === 'directory') queue.push({ ref: entry.ref, prefix: path, absolute: directory.absolute + '/' + entry.name })
          else if (entry.kind === 'file') files.push({ ref: entry.ref, name: entry.name, path, absolute: directory.absolute + '/' + entry.name })
          visited++
          if (visited >= limit) { changed({ files, state: partial() }); return }
        }
        cursor = page.cursor
        changed({ files: [...files], state: `Indexing ${root.node.name} · ${files.length.toLocaleString()} files` })
      } while (cursor)
    }
    changed({ files, state: `${root.node.name} · ${files.length.toLocaleString()} files` })
  } catch (error) { if (!signal.aborted) changed({ files, state: files.length ? partial() : `Quick open could not read ${root.node.name} · ${error instanceof Error ? error.message : String(error)}` }) }
  finally { release(core, scratch) }
}
function release(core: CoreClient, scratch: FolderRoot | undefined): void {
  if (scratch) void core.call('removeRoot', { root: scratch.ref.root, session: scratch.ref.session }).catch(() => {})
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
