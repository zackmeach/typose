// Plan C4 for what PR 3 adds: the preload's `mark(name, t)` and the TYPOSE_* hooks.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOSTILE } from '../core-host/numbers'
import { STARTUP_MARKS } from '../shared/protocol'
import { delayHook, isMark, marksHook } from './marks'

describe("mark's time is a safe integer in [0, 2^53 − 1]; its name is a known mark", () => {
  // 2^32, 2^32 + 1 and 1e12 are in this range; every other hostile value isn't.
  const inRange = new Set<unknown>([2 ** 32, 2 ** 32 + 1, 1e12, 0, Number.MAX_SAFE_INTEGER])
  for (const t of [...HOSTILE, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])
    it(`${inRange.has(t) ? 'takes' : 'refuses'} t = ${String(t)}`, () => expect(isMark('rawUsable', t)).toBe(inRange.has(t)))
  for (const name of ['show', '__proto__', 'constructor', 'toString', '', null, 1]) it(`refuses name ${String(name)}`, () => expect(isMark(name, 1)).toBe(false))
  for (const name of STARTUP_MARKS) it(`takes ${name}`, () => expect(isMark(name, 1)).toBe(true))
})

describe('the test-hooks delays are whole ms in [0, 10000]', () => {
  for (const value of ['NaN', 'Infinity', '-1', '0.5', '1e3', '10001', '', ' 1', '0x10', '4294967296'])
    it(`refuses "${value}"`, () => expect(() => delayHook('TYPOSE_TEST_DELAY_SHOW', value)).toThrow(/TYPOSE_TEST_DELAY_SHOW/))
  it('unset is no delay', () => expect(delayHook('TYPOSE_TEST_DELAY_SHOW', undefined)).toBe(0))
  for (const value of ['0', '300', '10000']) it(`takes "${value}"`, () => expect(delayHook('X', value)).toBe(Number(value)))
})

describe('TYPOSE_MARKS', () => {
  let dir: string
  let logged: { event: string; data?: Record<string, unknown> }[]
  const log = (event: string, data?: Record<string, unknown>) => void logged.push({ event, data })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typose-marks-'))
    logged = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is off when unset, and says nothing', () => {
    expect(marksHook(undefined, log)).toBeUndefined()
    expect(logged).toEqual([])
  })

  // Refused as strings, before anything touches the file system: a UNC path would connect over SMB (§7.3, Z43).
  for (const path of ['', 'marks.jsonl', '\\\\server\\share\\marks.jsonl', '\\\\.\\pipe\\marks', '\\\\?\\C:\\marks.jsonl', '\\marks.jsonl', 'C:marks.jsonl'])
    it(`refuses ${JSON.stringify(path)} on Windows, and logs why`, () => {
      expect(marksHook(path, log, 'win32')).toBeUndefined()
      expect(logged).toEqual([{ event: 'hook-refused', data: { hook: 'TYPOSE_MARKS', reason: expect.stringMatching(/drive path/) } }])
    })
  for (const name of ['CON', 'con.jsonl', 'NUL', 'nul.', 'AUX.tar.gz', 'PRN .txt', 'COM1', 'com9.jsonl', 'LPT1', 'lpt9.log', 'COM¹'])
    it(`refuses the reserved device name ${JSON.stringify(name)} as the file on Windows`, () => {
      expect(marksHook(`C:\\typose-no-such-dir/sub\\${name}`, log, 'win32')).toBeUndefined()
      expect(logged).toEqual([{ event: 'hook-refused', data: { hook: 'TYPOSE_MARKS', reason: expect.stringMatching(/reserved device/) } }])
    })
  for (const name of ['CONSOLE.jsonl', 'COM10.jsonl', 'marks.con', 'nul-marks.jsonl'])
    it(`takes ${JSON.stringify(name)}: a device name only as part of the file name`, () => {
      expect(marksHook(`C:\\typose-no-such-dir\\${name}`, log, 'win32')).toBeTypeOf('function')
      expect(logged).toEqual([])
    })
  for (const path of ['', 'marks.jsonl', './marks.jsonl'])
    it(`refuses the relative path ${JSON.stringify(path)} elsewhere`, () => {
      expect(marksHook(path, log, 'linux')).toBeUndefined()
      expect(logged[0].event).toBe('hook-refused')
    })

  it('refuses a path that exists and is not a regular file (a directory)', () => {
    expect(marksHook(dir, log)).toBeUndefined()
    expect(logged).toEqual([{ event: 'hook-refused', data: { hook: 'TYPOSE_MARKS', reason: expect.stringMatching(/regular file/) } }])
  })

  it('appends one JSON line per mark, on the wall clock', () => {
    const file = join(dir, 'marks.jsonl')
    const mark = marksHook(file, log)!
    const before = Date.now()
    mark('show', { hz: 60 })
    mark('rawUsable', { t: 5 })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ mark: 'show', hz: 60 })
    expect(lines[0].t).toBeGreaterThanOrEqual(before)
    expect(lines[1]).toEqual({ mark: 'rawUsable', t: 5 })
    expect(logged).toEqual([])
  })

  it('a failing write logs once, turns the hook off, and never throws', () => {
    const file = join(dir, 'marks.jsonl')
    const mark = marksHook(file, log)!
    mkdirSync(file) // the path becomes a directory after the check
    expect(() => mark('show')).not.toThrow()
    expect(() => mark('rawUsable')).not.toThrow()
    expect(logged.map((l) => l.event)).toEqual(['hook-failed'])
  })
})
