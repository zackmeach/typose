// Plan C4 at the napi layer: the addon itself refuses every hostile number, whatever the core host checked.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Doc, limits } from 'typose-node'
import { HOSTILE, isValid } from './numbers'

const dir = mkdtempSync(join(tmpdir(), 'typose-napi-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const path = join(dir, 'lines.txt')
writeFileSync(path, 'one\ntwo\nthree\n')
const range = (field: string) => limits().ranges.find((r) => r.field === field)!

describe('Doc.page refuses every number that is not an integer in range', () => {
  const doc = Doc.open(path)
  const params = { start: (v: unknown) => doc.page(v as number, 1), count: (v: unknown) => doc.page(0, v as number) }
  for (const [field, call] of Object.entries(params)) {
    const { min, max } = range(field)
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${field} = ${String(value)}`, () => {
        if (isValid(value, min, max)) {
          expect(call(value).items).toBeInstanceOf(Array)
          return
        }
        let error: unknown
        try {
          call(value)
        } catch (e) {
          error = e
        }
        expect(error, 'accepted').toBeInstanceOf(Error)
        // A number reaches Rust's check, which names the field. Anything else napi refuses before Rust runs.
        if (typeof value === 'number') expect(error).toMatchObject({ code: 'InvalidParams', message: expect.stringContaining(field) })
      })
    }
  }
})

it('Doc.open refuses a path that is empty or holds a NUL', () => {
  for (const bad of ['', 'a\0b']) expect(() => Doc.open(bad)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
})
