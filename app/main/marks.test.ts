// Plan C4 for what PR 3 adds: the preload's `mark(name, t)` and the TYPOSE_* hooks.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  it('is off when unset', () => expect(marksHook(undefined)).toBeNull())
  for (const path of ['', 'marks.jsonl', './marks.jsonl']) it(`refuses the relative path "${path}"`, () => expect(marksHook(path)).toEqual({ refused: expect.any(String) }))
  it('appends one JSON line per mark, on the wall clock', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'typose-marks-')), 'marks.jsonl')
    const mark = marksHook(file)
    if (typeof mark !== 'function') throw new Error('expected a writer')
    const before = Date.now()
    mark('show', { hz: 60 })
    mark('rawUsable', { t: 5 })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ mark: 'show', hz: 60 })
    expect(lines[0].t).toBeGreaterThanOrEqual(before)
    expect(lines[1]).toEqual({ mark: 'rawUsable', t: 5 })
  })
})
