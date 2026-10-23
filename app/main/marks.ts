// Plan §5's read-only measurement hook and plan C8's startup marks. TYPOSE_MARKS names an absolute file; main
// appends each mark to it as a JSON line, on the wall clock. Without the hook, marks are dropped. Validated per C4.
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isValid } from '../core-host/numbers'
import { STARTUP_MARKS, type StartupMark } from '../shared/protocol'

export type Mark = (mark: string, data?: Record<string, unknown>) => void

/** The hook's writer, or why the hook is refused. Unset means off. */
export function marksHook(path: string | undefined): Mark | { refused: string } | null {
  if (path === undefined) return null
  if (!isAbsolute(path)) return { refused: 'TYPOSE_MARKS must be an absolute path' }
  return (mark, data = {}) => appendFileSync(path, JSON.stringify({ mark, t: Date.now(), ...data }) + '\n')
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
