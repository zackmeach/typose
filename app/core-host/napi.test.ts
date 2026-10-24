// Plan C4 at the napi layer: the addon itself refuses every hostile number, whatever the core host checked. And
// plan C3's forged-token table, at the boundary a token crosses.
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

/** The thrown error, or a failure if the call returned. */
function thrown(call: () => unknown): unknown {
  try {
    call()
  } catch (e) {
    return e
  }
  return expect.fail('accepted')
}

describe('Doc.page and Doc.piece refuse every number that is not an integer in range', () => {
  const doc = Doc.open(path)
  // A valid value for every other parameter; each call's own field takes the table's values. A valid `offset` for
  // `piece` still isn't a cut of line 0 in general, so `piece` is judged on its `InvalidParams` naming only.
  const params = {
    gen: (v: unknown) => doc.page(v as number, 0, 1),
    start: (v: unknown) => doc.page(1, v as number, 1),
    count: (v: unknown) => doc.page(1, 0, v as number),
    'piece gen': (v: unknown) => doc.piece(v as number, 0, 2),
    line: (v: unknown) => doc.piece(1, v as number, 2),
    offset: (v: unknown) => doc.piece(1, 0, v as number)
  }
  for (const [name, call] of Object.entries(params)) {
    const field = name.replace('piece ', '')
    const { min, max } = range(field)
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${name} = ${String(value)}`, () => {
        if (isValid(value, min, max)) {
          let result: unknown
          try {
            result = call(value)
          } catch (e) {
            // In range, so not refused for its type: what's left is the core's own judgement of the value.
            expect(e).not.toMatchObject({ message: expect.stringContaining(`${field} must be`) })
            return
          }
          expect(result).toBeTypeOf('object')
          return
        }
        const error = thrown(() => call(value))
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

describe("plan C3's forged-token table: each row is refused with a typed error", () => {
  // A 70,000-byte line of 3-byte characters, then a short line: the first piece ends at 65,535, a character's end.
  const long = join(dir, 'long.txt')
  writeFileSync(long, `${'語'.repeat(23_334)}\nsecond\n`)
  const doc = Doc.open(long)
  const first = doc.page(1, 0, 1).items[0]
  const next = first.next!
  it('the issued token is accepted, and names the next piece', () => {
    expect(next).toEqual({ gen: 1, line: 0, offset: 65_535 })
    expect(doc.piece(next.gen, next.line, next.offset)).toMatchObject({ offset: 65_535, text: '語'.repeat(1_489), more: false })
  })
  // The file: 70,002 bytes of line 0, its newline, then "second" at 70,003 and a newline: 70,010 bytes.
  const rows: [row: string, call: () => unknown, code: string, why: string][] = [
    ['a mid-sequence offset', () => doc.piece(1, 0, next.offset + 1), 'InvalidParams', 'not an element boundary'],
    ["another line's offset", () => doc.piece(1, 0, 70_005), 'InvalidParams', 'in another line'],
    ['an offset past the end', () => doc.piece(1, 0, 70_010), 'InvalidParams', 'past the end of the file'],
    ['a non-integer', () => doc.piece(1, 0, next.offset + 0.5), 'InvalidParams', 'offset must be an integer'],
    ['a generation not yet issued', () => doc.piece(2, 0, next.offset), 'Stale', 'stale']
  ]
  for (const [row, call, code, why] of rows) it(row, () => expect(thrown(call)).toMatchObject({ code, message: expect.stringContaining(why) }))

  it('an odd UTF-16 offset', () => {
    const utf16 = join(dir, 'utf16.txt')
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x'.repeat(40_000), 'utf16le')]))
    const u = Doc.open(utf16)
    const t = u.page(1, 0, 1).items[0].next!
    expect(t.offset % 2).toBe(0)
    expect(u.piece(1, 0, t.offset).offset).toBe(t.offset)
    expect(thrown(() => u.piece(1, 0, t.offset + 1))).toMatchObject({ code: 'InvalidParams', message: expect.stringContaining('not an element boundary') })
  })

  it('an old gen: after Reload, every old token and page is Stale', () => {
    doc.reload()
    expect(doc.generation).toBe(2)
    expect(thrown(() => doc.piece(next.gen, next.line, next.offset))).toMatchObject({ code: 'Stale' })
    expect(thrown(() => doc.page(1, 0, 1))).toMatchObject({ code: 'Stale' })
    expect(doc.piece(2, 0, next.offset).gen).toBe(2)
  })
})
