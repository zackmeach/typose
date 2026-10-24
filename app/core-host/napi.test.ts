// Plan C4 at the napi layer: the addon itself refuses every hostile number, whatever the core host checked. And
// plan C3's forged-token table, at the boundary a token crosses, and C5's cancel and C6's close.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Cancel, Doc, limits, reserveCache, setBudget } from 'typose-node'
import { HOSTILE, isValid } from './numbers'

// Plan C1: nothing opens until the ledger has its limit, as the core host sets it first.
setBudget(totalmem())

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

/** The error a read throws or rejects with, or a failure if it resolved. */
async function refused(call: () => unknown): Promise<unknown> {
  try {
    await call()
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
    gen: (v: unknown) => doc.page(v as number, 0, 1, new Cancel()),
    start: (v: unknown) => doc.page(1, v as number, 1, new Cancel()),
    count: (v: unknown) => doc.page(1, 0, v as number, new Cancel()),
    'piece gen': (v: unknown) => doc.piece(v as number, 0, 2, new Cancel()),
    line: (v: unknown) => doc.piece(1, v as number, 2, new Cancel()),
    offset: (v: unknown) => doc.piece(1, 0, v as number, new Cancel())
  }
  for (const [name, call] of Object.entries(params)) {
    const field = name.replace('piece ', '')
    const { min, max } = range(field)
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${name} = ${String(value)}`, async () => {
        if (isValid(value, min, max)) {
          // In range, so not refused for its type: what's left is the core's own judgement of the value, a page or a
          // rejection.
          const outcome = await call(value).then((page) => page, (e: unknown) => e)
          expect(outcome).toBeTypeOf('object')
          expect(outcome).not.toMatchObject({ message: expect.stringContaining(`${field} must be`) })
          return
        }
        // Refused before any read: it throws, and no promise is made.
        const error = thrown(() => call(value))
        expect(error, 'accepted').toBeInstanceOf(Error)
        // A number reaches Rust's check, which names the field. Anything else napi refuses before Rust runs.
        if (typeof value === 'number') expect(error).toMatchObject({ code: 'InvalidParams', message: expect.stringContaining(field) })
      })
    }
  }
})

it('Doc.open refuses a path that is empty, holds a NUL or is longer than the core opens', () => {
  for (const bad of ['', 'a\0b', 'x'.repeat(3 * 32_767 + 1)]) expect(() => Doc.open(bad)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
})

it('plan C1: setBudget and reserveCache refuse every number that is not an integer in range', () => {
  for (const [name, call, field] of [
    ['setBudget', setBudget, 'totalmem'],
    ['reserveCache', reserveCache, 'bytes']
  ] as const) {
    const { min, max } = range(field)
    for (const value of [...HOSTILE, min, max, max + 1]) {
      if (isValid(value, min, max)) continue // a valid budget or reservation changes the ledger: napi.hooks.test.ts
      const error = thrown(() => call(value as number))
      expect(error, `${name}(${String(value)})`).toBeInstanceOf(Error)
      if (typeof value === 'number') expect(error).toMatchObject({ code: 'InvalidParams', message: expect.stringContaining(field) })
    }
  }
  expect(reserveCache(1 << 20)).toBe(true)
  expect(reserveCache(0)).toBe(true)
})

// A 70,000-byte line of 3-byte characters, then a short line: the first piece ends at 65,535, a character's end.
const long = join(dir, 'long.txt')
writeFileSync(long, `${'語'.repeat(23_334)}\nsecond\n`)
const longDoc = Doc.open(long)
const next = (await longDoc.page(1, 0, 1, new Cancel())).items[0].next!

describe("plan C3's forged-token table: each row is refused with a typed error", () => {
  const doc = longDoc
  it('the issued token is accepted, and names the next piece', async () => {
    expect(next).toEqual({ gen: 1, line: 0, offset: 65_535 })
    expect((await doc.piece(next.gen, next.line, next.offset, new Cancel())).items).toMatchObject([{ offset: 65_535, text: '語'.repeat(1_489), more: false }])
  })
  // The file: 70,002 bytes of line 0, its newline, then "second" at 70,003 and a newline: 70,010 bytes.
  const rows: [row: string, call: () => unknown, code: string, why: string][] = [
    ['a mid-sequence offset', () => doc.piece(1, 0, next.offset + 1, new Cancel()), 'InvalidParams', 'not an element boundary'],
    ["another line's offset", () => doc.piece(1, 0, 70_005, new Cancel()), 'InvalidParams', 'in another line'],
    ['an offset past the end', () => doc.piece(1, 0, 70_010, new Cancel()), 'InvalidParams', 'past the end of the file'],
    ['a non-integer', () => doc.piece(1, 0, next.offset + 0.5, new Cancel()), 'InvalidParams', 'offset must be an integer'],
    ['a generation not yet issued', () => doc.piece(2, 0, next.offset, new Cancel()), 'Stale', 'stale']
  ]
  for (const [row, call, code, why] of rows) it(row, async () => expect(await refused(call)).toMatchObject({ code, message: expect.stringContaining(why) }))

  it('an odd UTF-16 offset', async () => {
    const utf16 = join(dir, 'utf16.txt')
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x'.repeat(40_000), 'utf16le')]))
    const u = Doc.open(utf16)
    const t = (await u.page(1, 0, 1, new Cancel())).items[0].next!
    expect(t.offset % 2).toBe(0)
    expect((await u.piece(1, 0, t.offset, new Cancel())).items[0].offset).toBe(t.offset)
    expect(await refused(() => u.piece(1, 0, t.offset + 1, new Cancel()))).toMatchObject({ code: 'InvalidParams', message: expect.stringContaining('not an element boundary') })
  })

  it('an old gen: after Reload, every old token and page is Stale', async () => {
    doc.reload()
    expect(doc.generation).toBe(2)
    expect(await refused(() => doc.piece(next.gen, next.line, next.offset, new Cancel()))).toMatchObject({ code: 'Stale' })
    expect(await refused(() => doc.page(1, 0, 1, new Cancel()))).toMatchObject({ code: 'Stale' })
    expect((await doc.piece(2, 0, next.offset, new Cancel())).items[0].gen).toBe(2)
  })
})

it('plan C5: a read cancelled before it runs rejects with Cancelled, and the document reads on', async () => {
  const doc = Doc.open(path)
  const cancel = new Cancel()
  cancel.cancel()
  expect(await refused(() => doc.page(1, 0, 3, cancel))).toMatchObject({ code: 'Cancelled' })
  expect(await refused(() => doc.page(1, 0, 3, cancel))).toMatchObject({ code: 'Cancelled' }) // a flag stays set
  expect((await doc.page(1, 0, 3, new Cancel())).items.map((i) => i.text)).toEqual(['one', 'two', 'three'])
})

it('a cancel flag must be a Cancel', () => {
  const doc = Doc.open(path)
  for (const cancel of [undefined, null, {}, { cancel: () => {} }]) expect(() => doc.page(1, 0, 1, cancel as Cancel), String(cancel)).toThrow()
})

it('plan C6: a closed document refuses everything with NoDocument', async () => {
  const doc = Doc.open(path)
  doc.close()
  for (const call of [() => doc.generation, () => doc.lines, () => doc.page(1, 0, 1, new Cancel()), () => doc.startIndex(new Cancel(), () => {}), () => doc.reload()])
    expect(thrown(call)).toMatchObject({ code: 'NoDocument' })
  doc.close() // twice is fine
})
