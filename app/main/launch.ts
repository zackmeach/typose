// Spec §8.1: the file a launch names, from its argv and cwd: this launch's own, or a second instance's.
import { resolve } from 'node:path'

/** Windows' command-line limit, in characters. A real launch's argv and cwd fit in it. */
const MAX_CHARS = 32_767
/** ponytail: more files than M1's one card needs; M2's tabs may want more on macOS and Linux, whose limit is higher. */
const MAX_ARGS = 4096

/**
 * The file a launch names: its last path, resolved against its cwd. Every argument after the first `--` is a path,
 * whatever it looks like; before it, switches aren't. It's a path, never a URL: what it names is opened like any other,
 * so the core's checks and refusals apply (plan C4, spec §3.3). `defaultApp`: `electron <app> <file>` in development.
 */
export function launchPath(argv: string[], cwd: string, defaultApp: boolean): string | null {
  const end = argv.indexOf('--', 1)
  const plain = argv.slice(1, end < 0 ? undefined : end).filter((a) => !a.startsWith('-'))
  const paths = [...(defaultApp ? plain.slice(1) : plain), ...(end < 0 ? [] : argv.slice(end + 1))]
  const file = paths.filter(Boolean).at(-1)
  return file ? resolve(cwd, file) : null
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
