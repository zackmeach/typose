// Z79's hand-offs to the OS: Show in Explorer and Open with default app. The page only names what Typose holds; main
// (or the core host, for main) turns that into a path, and checks the path before any shell call.
import { isExecutable } from '../shared/handoff'
import type { HandoffResult } from '../shared/protocol'

export type HandoffAction = 'show' | 'open'

export interface HandoffDeps {
  /** Paths main itself handed the page: a launch's, a second instance's, macOS's open-file, Open file…'s. */
  granted: ReadonlySet<string>
  /** The core host's path for a document, folder entry or link it holds; rejects with its refusal. */
  resolve(subject: unknown): Promise<string>
  platform: NodeJS.Platform
  /** Windows' PATHEXT, added to the shared list. */
  pathext: string
  isDirectory(path: string): Promise<boolean>
  show(path: string): void
  /** shell.openPath: an error message, or '' once the OS took it. */
  open(path: string): Promise<string>
}

// oxlint-disable-next-line no-control-regex -- Control characters never reach the OS.
const controls = /[\u0000-\u001f\u007f-\u009f]/

/** Why a path can't go to the OS at all, or null: only a plain local absolute path can (no UNC, `\\?\`, `\\.\` or stream). */
export function pathRefusal(path: string, platform: NodeJS.Platform): string | null {
  if (path.length === 0 || path.length > 32_767 || controls.test(path)) return 'Typose can’t hand off this path'
  if (/^[\\/]{2}/.test(path)) return 'Typose doesn’t hand off network or device paths'
  const local = platform === 'win32' ? /^[a-z]:[\\/]/i.test(path) && !path.includes(':', 2) : path.startsWith('/')
  return local ? null : 'Typose hands off only local paths'
}

const refuse = (reason: string): HandoffResult => ({ ok: false, reason })
const message = (e: unknown) => e instanceof Error ? e.message : String(e)

/** The caller is already checked (the app's main frame). `args` is exactly what the page sent. */
export async function handOff(action: HandoffAction, args: unknown[], deps: HandoffDeps): Promise<HandoffResult> {
  const subject = args[0] as Record<string, unknown> | null
  if (args.length !== 1 || typeof subject !== 'object' || subject === null || Array.isArray(subject)) return refuse('Not a file Typose holds')
  let path: string
  if (Object.hasOwn(subject, 'path')) {
    if (typeof subject.path !== 'string' || !deps.granted.has(subject.path)) return refuse('Not a file Typose holds')
    path = subject.path
  } else {
    const { entry, session, doc, gen, target } = subject // only the fields the core host reads cross to it
    try { path = await deps.resolve(entry !== undefined ? { entry } : { session, doc, gen, target }) }
    catch (e) { return refuse(`Not a file Typose holds · ${message(e)}`) }
  }
  const why = pathRefusal(path, deps.platform) ??
    (action === 'open' && isExecutable(path, deps.pathext) ? 'Typose won’t open programs or scripts · show the file in its folder instead' : null)
  if (why) return refuse(why)
  try {
    if (action === 'show') deps.show(path)
    else if (await deps.isDirectory(path)) return refuse('Open with default app opens files, not folders')
    else {
      const error = await deps.open(path)
      if (error) return refuse(error)
    }
    return { ok: true }
  } catch (e) {
    return refuse(message(e))
  }
}
