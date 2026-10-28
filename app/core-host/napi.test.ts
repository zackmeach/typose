// Plan C4 at the napi layer: the addon itself refuses every hostile number, whatever the core host checked. And
// plan C3's forged-token table, at the boundary a token crosses, and C5's cancel and C6's close.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    offset: (v: unknown) => doc.piece(1, 0, v as number, new Cancel()),
    'render gen': (v: unknown) => doc.render(v as number, new Cancel()),
    'mdPage gen': (v: unknown) => doc.mdPage(v as number, 0, 1, new Cancel()),
    'mdPage start': (v: unknown) => doc.mdPage(1, v as number, 1, new Cancel()),
    'mdPage count': (v: unknown) => doc.mdPage(1, 0, v as number, new Cancel())
  }
  for (const [name, call] of Object.entries(params)) {
    const field = name.split(' ').at(-1)!
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
  const calls = [
    () => doc.generation,
    () => doc.lines,
    () => doc.format,
    () => doc.path,
    () => doc.localOnly,
    () => doc.localPath(1, 'other.md'),
    () => doc.openLocal(1, 'other.md'),
    () => doc.page(1, 0, 1, new Cancel()),
    () => doc.startIndex(new Cancel(), () => {}),
    () => doc.reload(),
    () => doc.render(1, new Cancel()),
    () => doc.mdPage(1, 0, 1, new Cancel())
  ]
  for (const call of calls) expect(thrown(call)).toMatchObject({ code: 'NoDocument' })
  doc.close() // twice is fine
})

describe('local-file links keep inherited native routes', () => {
  const windows = process.platform === 'win32' ? it : it.skip

  windows('normalizes without target access, opens nested Markdown/text, and retains routes after source close and Reload', async () => {
    const folder = join(dir, 'local-chain')
    mkdirSync(join(folder, 'nested'), { recursive: true })
    const sourcePath = join(folder, 'source.md')
    const childPath = join(folder, 'nested', 'child.MARKDOWN')
    const textPath = join(folder, 'last.txt')
    writeFileSync(sourcePath, '# Source\n')
    writeFileSync(childPath, '# Child\n')
    writeFileSync(textPath, 'last\n')
    const source = Doc.open(sourcePath)
    expect(source.localOnly).toBe(false)
    expect(() => source.localPath(1, 'nested/child.MARKDOWN')).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    await source.render(1, new Cancel())
    expect(source.localPath(1, 'missing.txt')).toBe(join(folder, 'missing.txt')) // no target stat/open
    expect(source.localPath(1, './nested/../nested/child.MARKDOWN')).toBe(childPath)
    const child = source.openLocal(1, 'nested/child.MARKDOWN')
    source.close()
    try {
      expect(child.localOnly).toBe(true)
      expect(child.path).toBe(childPath)
      expect((await child.page(1, 0, 1, new Cancel())).items[0].text).toBe('# Child')
      await child.render(1, new Cancel())
      const text = child.openLocal(1, '../last.txt')
      try {
        expect(text.localOnly).toBe(true)
        expect(text.path).toBe(textPath)
        expect(text.format).toBe('text')
        text.reload()
        expect(text.generation).toBe(2)
        expect(text.localOnly).toBe(true)
        expect((await text.page(2, 0, 1, new Cancel())).items[0].text).toBe('last')
        expect(() => text.localPath(2, 'source.md')).toThrow(expect.objectContaining({ code: 'Refused' }))
      } finally {
        text.close()
      }
      child.reload()
      expect(child.localOnly).toBe(true)
      expect(() => child.openLocal(1, '../last.txt')).toThrow(expect.objectContaining({ code: 'Stale' }))
      expect(() => child.openLocal(2, '../last.txt')).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    } finally {
      child.close()
      source.close()
    }
  })

  windows('refuses unsupported extensions before target access, freezes changed source/target, and reloads the target through its route', async () => {
    const folder = join(dir, 'local-mutation')
    mkdirSync(folder)
    const sourcePath = join(folder, 'source.md')
    const targetPath = join(folder, 'target.txt')
    writeFileSync(sourcePath, '# Source\n')
    writeFileSync(targetPath, 'old\n')
    const source = Doc.open(sourcePath)
    await source.render(1, new Cancel())
    const target = source.openLocal(1, 'target.txt')
    try {
      for (const file of ['not-present.exe', 'not-present.png', 'not-present']) {
        expect(() => source.localPath(1, file)).toThrow(expect.objectContaining({ code: 'Refused' }))
        expect(() => source.openLocal(1, file)).toThrow(expect.objectContaining({ code: 'Refused' }))
      }
      renameSync(targetPath, join(folder, 'old.txt'))
      writeFileSync(targetPath, 'new target\n')
      expect(await refused(() => target.page(1, 0, 1, new Cancel()))).toMatchObject({ code: 'Frozen' })
      expect(source.localPath(1, 'target.txt')).toBe(targetPath) // a target freeze leaves its source usable
      target.reload()
      expect(target.localOnly).toBe(true)
      expect((await target.page(2, 0, 1, new Cancel())).items[0].text).toBe('new target')
      writeFileSync(sourcePath, '# Changed source\n')
      expect(() => source.localPath(1, 'target.txt')).toThrow(expect.objectContaining({ code: 'Frozen' }))
      expect(() => source.openLocal(1, 'target.txt')).toThrow(expect.objectContaining({ code: 'Frozen' }))
    } finally {
      target.close()
      source.close()
    }
  })

  it('requires current rendered Markdown and validates generations/decoded target bounds independently', async () => {
    const sourcePath = join(dir, 'local-params.md')
    writeFileSync(sourcePath, '# Source\n')
    const source = Doc.open(sourcePath)
    const text = Doc.open(path)
    try {
      expect(() => text.openLocal(1, 'other.txt')).toThrow(expect.objectContaining({ code: 'Refused' }))
      expect(() => source.openLocal(1, 'other.txt')).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
      await source.render(1, new Cancel())
      for (const gen of [...HOSTILE, range('gen').max + 1]) {
        if (isValid(gen, range('gen').min, range('gen').max)) continue
        expect(() => source.localPath(gen as number, 'other.txt')).toThrow()
        expect(() => source.openLocal(gen as number, 'other.txt')).toThrow()
      }
      for (const target of ['', 'a\0b.txt', 'a\nb.txt', 'a\u0085b.txt', 'x'.repeat(32_769), `${'é'.repeat(16_385)}.txt`]) {
        expect(() => source.localPath(1, target)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
        expect(() => source.openLocal(1, target)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
      }
      if (process.platform !== 'win32')
        expect(() => source.openLocal(1, 'other.txt')).toThrow(expect.objectContaining({ code: 'Refused' }))
      source.reload()
      expect(() => source.localPath(1, 'other.txt')).toThrow(expect.objectContaining({ code: 'Stale' }))
      expect(() => source.localPath(2, 'other.txt')).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    } finally {
      text.close()
      source.close()
    }
  })
})

describe('plan (Rendered Markdown slice) §2.1: render builds the blocks, and mdPage pages them', () => {
  const mdPath = join(dir, 'doc.MD')
  writeFileSync(mdPath, '# Title\n\nSee [x](javascript:alert(1)), [y](other.md) and <script>s</script>.\n\n- a\n- b\n')

  it("the format is the extension's", () => {
    expect([Doc.open(mdPath).format, Doc.open(path).format]).toEqual(['markdown', 'text'])
  })

  it('every block, sanitized, with its lines, slug and index', async () => {
    const doc = Doc.open(mdPath)
    expect(await doc.render(1, new Cancel())).toEqual({ blocks: 3, units: 45, htmlBytes: 153, nodes: 24, noteUnits: 0 })
    expect((await doc.mdPage(1, 0, 10, new Cancel())).items).toEqual([
      { block: 0, line: 0, lines: 1, html: '<h1>Title</h1>\n', slug: 'title' },
      { block: 1, line: 2, lines: 1, html: '<p>See <a href="#">x</a>, <a href="#" data-href="other.md">y</a> and &lt;script&gt;s&lt;/script&gt;.</p>\n' },
      { block: 2, line: 4, lines: 2, html: '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n' }
    ])
    expect((await doc.mdPage(1, 2, 10, new Cancel())).items.map((i) => i.block)).toEqual([2])
    expect((await doc.mdPage(1, 3, 10, new Cancel())).items).toEqual([])
  })

  it('headingLine resolves held headings and reserved footnotes without reading the file', async () => {
    const linkPath = join(dir, 'links.md')
    writeFileSync(linkPath, '# Note\n\n# Note\n\nText[^NOTE] and [^a%20b].\n\n[^note]: Body\n\n[^a%20b]: Percent\n')
    const doc = Doc.open(linkPath)
    expect(() => doc.headingLine(1, 'note')).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    await doc.render(1, new Cancel())
    expect(doc.headingLine(1, 'note')).toBe(0)
    expect(doc.headingLine(1, 'note-1')).toBe(2)
    expect(doc.headingLine(1, 'typose-footnote:NOTE')).toBe(6)
    expect(doc.headingLine(1, 'typose-footnote:a%20b')).toBe(8)
    expect(doc.headingLine(1, 'missing')).toBeNull()
    doc.reload()
    expect(() => doc.headingLine(1, 'note')).toThrow(expect.objectContaining({ code: 'Stale' }))
    expect(() => doc.headingLine(2, 'note')).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    await doc.render(2, new Cancel())
    rmSync(linkPath)
    expect(doc.headingLine(2, 'note')).toBe(0) // metadata lookup, even after the path disappeared
    doc.close()
    expect(() => doc.headingLine(2, 'note')).toThrow(expect.objectContaining({ code: 'NoDocument' }))
  })

  it('headingLine refuses hostile generations and oversized/control-containing fragments', async () => {
    const doc = Doc.open(mdPath)
    await doc.render(1, new Cancel())
    const { min, max } = range('gen')
    for (const value of [...HOSTILE, max + 1]) {
      if (isValid(value, min, max)) continue
      expect(() => doc.headingLine(value as number, 'title')).toThrow()
    }
    for (const fragment of ['x'.repeat(32_769), 'é'.repeat(16_385), 'a\0b', 'a\nb', 'a\u0085b'])
      expect(() => doc.headingLine(1, fragment)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    expect(doc.headingLine(1, 'x'.repeat(32_768))).toBeNull()
  })

  it('a page before any build is InvalidParams, an old generation Stale, and over 8 MiB is Refused', async () => {
    const doc = Doc.open(mdPath)
    expect(await refused(() => doc.mdPage(1, 0, 1, new Cancel()))).toMatchObject({ code: 'InvalidParams', message: expect.stringContaining('render it first') })
    await doc.render(1, new Cancel())
    doc.reload()
    expect(await refused(() => doc.mdPage(1, 0, 1, new Cancel()))).toMatchObject({ code: 'Stale' })
    expect(await refused(() => doc.render(1, new Cancel()))).toMatchObject({ code: 'Stale' })
    expect(await refused(() => doc.mdPage(2, 0, 1, new Cancel()))).toMatchObject({ code: 'InvalidParams' }) // Reload dropped the build
    const big = join(dir, 'big.md')
    writeFileSync(big, Buffer.alloc((8 << 20) + 1, 'x'))
    expect(await refused(() => Doc.open(big).render(1, new Cancel()))).toMatchObject({ code: 'Refused', message: expect.stringContaining('over 8 MiB') })
  })

  it('a cancelled build rejects with Cancelled, and keeps nothing', async () => {
    const doc = Doc.open(mdPath)
    const cancel = new Cancel()
    cancel.cancel()
    expect(await refused(() => doc.render(1, cancel))).toMatchObject({ code: 'Cancelled' })
    expect(await refused(() => doc.mdPage(1, 0, 1, new Cancel()))).toMatchObject({ code: 'InvalidParams' })
  })
})
