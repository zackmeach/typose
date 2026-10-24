// Plan C9: a bounded lifecycle log and a per-pid `running` marker, so every exit is told apart by the log, the
// exit status and any Crashpad dump. Writes are synchronous: a crash right after an event must not lose it.
import { app } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROTATE_AT = 1 << 20 // 1 MiB; one rotated file is kept beside the current one

export type Log = (event: string, data?: Record<string, unknown>) => void

export function startLifecycle(): Log {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'lifecycle.jsonl')
  const log: Log = (event, data = {}) => {
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= ROTATE_AT) renameSync(file, join(dir, 'lifecycle.1.jsonl'))
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n')
    } catch {
      // Diagnostics never take the app down.
    }
  }

  // A marker per pid: another instance's quit can't clear this one's. Since PR 8, only the instance holding the
  // single-instance lock gets this far.
  for (const name of readdirSync(dir)) {
    const pid = Number(/^running-(\d+)\.json$/.exec(name)?.[1])
    if (!pid || pid === process.pid || alive(pid)) continue
    const marker = join(dir, name)
    let started = 0
    try {
      started = (JSON.parse(readFileSync(marker, 'utf8')) as { started: number }).started
    } catch {
      // An unreadable marker still means an unclean exit.
    }
    log('previous-run-unclean', { previousPid: pid, started, dumps: dumpsSince(started) })
    unlinkSync(marker)
  }
  const marker = join(dir, `running-${process.pid}.json`)
  writeFileSync(marker, JSON.stringify({ started: Date.now() }))

  log('start', { version: app.getVersion(), electron: process.versions.electron })
  app.on('before-quit', () => log('before-quit'))
  app.on('will-quit', () => log('will-quit'))
  app.on('quit', (_e, code) => {
    log('quit', { code })
    try {
      unlinkSync(marker)
    } catch {
      // Already gone.
    }
  })
  app.on('child-process-gone', (_e, details) => log('child-process-gone', { ...details }))
  app.on('render-process-gone', (_e, _contents, details) => log('render-process-gone', { ...details }))
  // The monitor sees the exception without replacing Electron's own handling of it.
  process.on('uncaughtExceptionMonitor', (error, origin) => log('uncaughtException', { origin, stack: String(error?.stack ?? error) }))
  return log
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Crash dumps written since `since` (ms), anywhere under the crashDumps directory. */
function dumpsSince(since: number): string[] {
  const root = app.getPath('crashDumps')
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(path, depth + 1)
      else if (e.isFile() && e.name.endsWith('.dmp') && statSync(path).mtimeMs >= since) found.push(path)
    }
  }
  walk(root, 0)
  return found
}
