// Plan §5's read-only measurement hook and plan C8's startup marks. TYPOSE_MARKS names a local file; main appends each
// mark to it as a JSON line, on the wall clock. Without the hook, marks are dropped. Validated per C4: a refused or
// failing path is logged and never stops startup.
import { appendFileSync, statSync } from 'node:fs'
import { isValid } from '../core-host/numbers'
import { STARTUP_MARKS, type StartupMark } from '../shared/protocol'
import type { Log } from './lifecycle'

export type Mark = (mark: string, data?: Record<string, unknown>) => void

/** Why TYPOSE_MARKS can't be used, or null. Checked as a string before anything touches the file system. */
function refusal(path: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    // A drive path only: `\\server\share` would connect over SMB (spec §7.3, Z43), and `\\.\` and `\\?\` reach devices.
    if (!/^[A-Za-z]:[\\/]/.test(path)) return 'must be a drive path (X:\\…), not UNC, device, drive-relative or relative'
    // A reserved device name as the file (CON, NUL.jsonl, COM1 .txt) opens the device, not a file, in any directory.
    const stem = path.split(/[\\/]/).at(-1)!.split('.')[0].trimEnd()
    if (/^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i.test(stem)) return `names the reserved device ${stem.toUpperCase()}, not a file`
  } else if (!path.startsWith('/')) {
    return 'must be an absolute path'
  }
  try {
    const st = statSync(path, { throwIfNoEntry: false })
    if (st && !st.isFile()) return 'names something other than a regular file'
  } catch (e) {
    return `can't be checked: ${String(e)}`
  }
  return null
}

/** The hook's writer, or undefined when unset or refused. The first failed write logs once and turns the hook off. */
export function marksHook(path: string | undefined, log: Log, platform: NodeJS.Platform = process.platform): Mark | undefined {
  if (path === undefined) return undefined
  const refused = refusal(path, platform)
  if (refused) {
    log('hook-refused', { hook: 'TYPOSE_MARKS', reason: `TYPOSE_MARKS ${refused}` })
    return undefined
  }
  let failed = false
  return (mark, data = {}) => {
    if (failed) return
    try {
      appendFileSync(path, JSON.stringify({ mark, t: Date.now(), ...data }) + '\n')
    } catch (e) {
      failed = true
      log('hook-failed', { hook: 'TYPOSE_MARKS', error: String(e) })
    }
  }
}

/** A renderer mark is a known name at a wall-clock time in whole ms (C4: a safe integer, never clamped). */
export const isMark = (name: unknown, t: unknown): name is StartupMark =>
  STARTUP_MARKS.includes(name as StartupMark) && isValid(t, 0, Number.MAX_SAFE_INTEGER)

/** A test-hooks delay (ms) from the environment: unset is 0; anything but a whole number in [0, 10000] is refused. */
export function delayHook(name: string, value: string | undefined): number {
  if (value === undefined) return 0
  const ms = /^\d+$/.test(value) ? Number(value) : NaN
  if (!isValid(ms, 0, 10_000)) throw new Error(`${name} must be a whole number of ms in [0, 10000]`)
  return ms
}
