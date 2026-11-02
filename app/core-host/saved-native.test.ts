import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Cancel, Doc, SavedRoute, limits, setBudget } from 'typose-node'
import type { Addon } from './dispatch'
import { makeDispatcher } from './dispatch'
import { reserveCache, coreVersion } from 'typose-node'

setBudget(totalmem())
const dir = mkdtempSync(join(tmpdir(), 'typose-saved-native-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const windows = it.skipIf(process.platform !== 'win32')
const pageText = async (doc: Doc) => (await doc.page(1, 0, 10, new Cancel())).items.map((item) => item.text).join('\n')
const addon: Addon = { limits, coreVersion, openDoc: (path) => Doc.open(path), reserveCache, cancelFlag: () => new Cancel() }

it('SavedRoute cannot be constructed by JS', () => {
  expect(() => Reflect.construct(SavedRoute, [])).toThrow()
})

for (const extension of ['md', 'txt', 'csv']) {
  it(`manual ${extension} captures an owned path and never becomes a saved route`, async () => {
    const path = join(dir, 'manual.' + extension)
    writeFileSync(path, 'a,b\n')
    const source = Doc.open(path)
    try {
      expect(source.localOnly).toBe(false)
      expect(() => source.saveRoute(1)).toThrow(expect.objectContaining({ code: 'Refused' }))
      const dispatch = makeDispatcher(addon, 4, () => {})
      await dispatch({ id: 1, method: 'open', params: { path, count: 1, bytes: 0 } })
      expect(await dispatch({ id: 2, method: 'captureLocation', params: { doc: 1, gen: 1, localOnly: true } }))
        .toMatchObject({ result: { kind: 'manual', path } })
      await dispatch({ id: 3, method: 'close', params: { doc: 1 } })
    } finally { source.close() }
  })
}

windows('manual Markdown whose optional route capture fails still captures manual origin', async () => {
  const real = join(dir, 'manual-real'), alias = join(dir, 'manual-alias')
  mkdirSync(real)
  writeFileSync(join(real, 'source.md'), '# Source\n')
  symlinkSync(real, alias, 'junction')
  const path = join(alias, 'source.md')
  const source = Doc.open(path)
  const dispatch = makeDispatcher(addon, 4, () => {})
  try {
    await source.render(1, new Cancel())
    expect(() => source.localPath(1, 'next.txt')).toThrow(expect.objectContaining({ code: 'Refused' }))
    await dispatch({ id: 1, method: 'open', params: { path, count: 1, bytes: 0 } })
    expect(await dispatch({ id: 2, method: 'captureLocation', params: { doc: 1, gen: 1 } }))
      .toMatchObject({ result: { kind: 'manual', path } })
  } finally {
    source.close()
    await dispatch({ id: 3, method: 'close', params: { doc: 1 } })
  }
})

describe('derived saved native routes', () => {
  windows('capture derived TXT without a build, including frozen source, then reopen fresh bytes without old owners', async () => {
    const sourcePath = join(dir, 'source.md'), targetPath = join(dir, 'target.txt')
    writeFileSync(sourcePath, '# Source\n')
    writeFileSync(targetPath, 'old\n')
    const source = Doc.open(sourcePath)
    await source.render(1, new Cancel())
    const target = source.openLocal(1, 'target.txt')
    source.close()
    expect(target.localOnly).toBe(true)
    expect(() => target.saveRoute(2)).toThrow(expect.objectContaining({ code: 'Stale' }))
    for (const gen of [NaN, Infinity, -1, 0, 1.5, 2 ** 32])
      expect(() => target.saveRoute(gen)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
    writeFileSync(targetPath, 'changed current bytes\n')
    await expect(target.page(1, 0, 1, new Cancel())).rejects.toMatchObject({ code: 'Frozen' })
    const saved = target.saveRoute(1)
    target.close()
    const current = saved.open()
    try {
      expect(current.generation).toBe(1)
      expect(current.localOnly).toBe(true)
      expect(await pageText(current)).toBe('changed current bytes')
    } finally { current.close() }
    rmSync(targetPath)
    expect(() => saved.open()).toThrow(expect.objectContaining({ code: 'NotFound' }))
    writeFileSync(targetPath, 'replacement file\n')
    const replacement = saved.open()
    try { expect(await pageText(replacement)).toBe('replacement file') } finally { replacement.close() }
    expect(saved.release()).toBe(true)
    expect(saved.release()).toBe(false)
    expect(() => saved.open()).toThrow(expect.objectContaining({ code: 'NoDocument' }))
  })

  windows('retargeted ancestors are refused instead of reopening the display path', async () => {
    const root = join(dir, 'route-root'), moved = join(dir, 'route-moved'), other = join(dir, 'route-other')
    mkdirSync(root)
    mkdirSync(other)
    writeFileSync(join(root, 'target.txt'), 'original\n')
    writeFileSync(join(other, 'target.txt'), 'wrong manual target\n')
    const sourcePath = join(dir, 'retarget-source.md')
    writeFileSync(sourcePath, '# Source\n')
    const source = Doc.open(sourcePath)
    await source.render(1, new Cancel())
    const target = source.openLocal(1, 'route-root/target.txt')
    const saved = target.saveRoute(1)
    target.close()
    source.close()
    renameSync(root, moved)
    symlinkSync(other, root, 'junction')
    try {
      expect(() => saved.open()).toThrow(expect.objectContaining({ code: 'Refused' }))
      const manual = Doc.open(join(root, 'target.txt'))
      try { expect(await pageText(manual)).toBe('wrong manual target') } finally { manual.close() }
    } finally { saved.release() }
  })

  windows('binary replacement refusal leaves the route reusable', async () => {
    const sourcePath = join(dir, 'binary-source.md'), targetPath = join(dir, 'binary-target.txt')
    writeFileSync(sourcePath, '# Source\n')
    writeFileSync(targetPath, 'text\n')
    const source = Doc.open(sourcePath)
    await source.render(1, new Cancel())
    const target = source.openLocal(1, 'binary-target.txt'), saved = target.saveRoute(1)
    source.close()
    target.close()
    writeFileSync(targetPath, Buffer.alloc(100))
    expect(() => saved.open()).toThrow(expect.objectContaining({ code: 'Binary' }))
    writeFileSync(targetPath, 'text again\n')
    const reopened = saved.open()
    try { expect(await pageText(reopened)).toBe('text again') } finally { reopened.close(); saved.release() }
  })
})
