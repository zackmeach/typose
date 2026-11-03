// Spec §8.1: files a launch names, from its argv and cwd: this launch's own, or a second instance's; and what a drop names.
import { resolve } from 'node:path'
import { MAX_DROP, type DroppedPaths } from '../shared/protocol'

/** Windows' command-line limit, in characters. A real launch's argv and cwd fit in it. */
const MAX_CHARS = 32_767
/** Keep second-instance batches bounded on every platform. */
const MAX_ARGS = 4096

/**
 * Every file a launch names, in argument order, resolved against its cwd. Every argument after the first `--` is a path,
 * whatever it looks like; before it, switches aren't. It's a path, never a URL: what it names is opened like any other,
 * so the core's checks and refusals apply (plan C4, spec §3.3). `defaultApp`: `electron <app> <file>` in development.
 */
export function launchPaths(argv: string[], cwd: string, defaultApp: boolean): string[] {
  const end = argv.indexOf('--', 1)
  const plain = argv.slice(1, end < 0 ? undefined : end).filter((a) => !a.startsWith('-'))
  const paths = [...(defaultApp ? plain.slice(1) : plain), ...(end < 0 ? [] : argv.slice(end + 1))]
  return paths.filter(Boolean).map((file) => resolve(cwd, file))
}

/**
 * What a second instance sent (its argv and cwd), if it has the shape and size of a real launch's; otherwise null.
 * It's untrusted: the length is checked before any element is read, so a huge sparse array costs nothing.
 */
export function handoff(data: unknown): { argv: string[]; cwd: string } | null {
  const { argv, cwd } = (data ?? {}) as { argv?: unknown; cwd?: unknown }
  if (!Array.isArray(argv) || argv.length > MAX_ARGS || typeof cwd !== 'string' || cwd.length > MAX_CHARS) return null
  let chars = 0
  for (const a of argv as unknown[]) if (typeof a !== 'string' || (chars += a.length) > MAX_CHARS) return null // a hole is undefined
  return { argv: argv as string[], cwd }
}

/**
 * A drop is an explicit choice, as Open file… and Open folder… are, of what the preload read from it (untrusted): items
 * of `{ path, folder }`, or null when the message has another shape. A drop of more than `MAX_DROP` items opens nothing
 * and says how many it held. UNC, device, relative and empty paths are refused here, before anything touches them: a
 * manual open would reach a UNC share's host. A drive letter mapped to a share passes, as it does through Open file…;
 * files then take that manual-open policy, and folders Open folder…'s capture, which refuses network, reparse and
 * cloud-backed folders.
 */
export function dropPaths(items: unknown, windows = process.platform === 'win32'): DroppedPaths | null {
  if (!Array.isArray(items)) return null
  if (items.length > MAX_DROP) return { files: [], folders: [], refused: [], tooMany: items.length }
  const drop: DroppedPaths = { files: [], folders: [], refused: [] }
  for (const item of items as unknown[]) {
    const { path, folder } = (item ?? {}) as { path?: unknown; folder?: unknown }
    if (typeof path !== 'string' || path.length > MAX_CHARS || typeof folder !== 'boolean') return null
    // oxlint-disable-next-line no-control-regex -- a path with a control character names nothing to open
    const local = !/[\u0000-\u001f]/.test(path) && (windows ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/') && !path.startsWith('//'))
    if (!local) drop.refused.push(path)
    else (folder ? drop.folders : drop.files).push(path)
  }
  return drop
}
