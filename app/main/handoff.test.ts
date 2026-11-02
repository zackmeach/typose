import { describe, expect, it, vi } from 'vitest'
import { type HandoffDeps, handOff, pathRefusal } from './handoff'

const FILE = 'C:\\work\\notes.txt'

function deps(over: Partial<Pick<HandoffDeps, 'resolve' | 'isDirectory'>> & { open?: HandoffDeps['open'] } = {}) {
  return {
    granted: new Set([FILE]),
    resolve: vi.fn(over.resolve ?? (async (_subject: unknown) => FILE)),
    platform: 'win32' as NodeJS.Platform,
    pathext: '.COM;.EXE;.BAT;.CMD;.FOO',
    isDirectory: vi.fn(over.isDirectory ?? (async (_path: string) => false)),
    show: vi.fn((_path: string) => {}),
    open: vi.fn(over.open ?? (async (_path: string) => ''))
  }
}
const DOC = { session: 1, doc: 2, gen: 3 }

describe('Z79: only a plain local path reaches the OS', () => {
  for (const path of ['\\\\server\\share\\notes.txt', '//server/share/notes.txt', '\\\\?\\C:\\work\\notes.txt', '\\\\?\\UNC\\server\\share\\x.txt',
    '\\\\.\\pipe\\x', '\\??\\C:\\x.txt', 'notes.txt', 'C:notes.txt', 'C:\\work\\notes.txt:evil.bat', 'C:\\work\\a\u0007.txt', '', 'C:\\' + 'a'.repeat(32_767)])
    it('refuses ' + JSON.stringify(path.slice(0, 40)), () => expect(pathRefusal(path, 'win32')).not.toBeNull())
  it('accepts drive paths on Windows and absolute paths elsewhere', () => {
    expect(pathRefusal(FILE, 'win32')).toBeNull()
    expect(pathRefusal('C:/work/notes.txt', 'win32')).toBeNull()
    expect(pathRefusal('/home/me/notes.txt', 'linux')).toBeNull()
    expect(pathRefusal('//server/share/notes.txt', 'darwin')).not.toBeNull()
  })
})

describe('Z79: the page names only what Typose holds', () => {
  for (const args of [[], [{ path: FILE }, 'extra'], [null], [FILE], [[FILE]], [7]])
    it('refuses argument shape ' + JSON.stringify(args), async () => {
      const d = deps()
      expect(await handOff('show', args, d)).toMatchObject({ ok: false })
      expect(d.show).not.toHaveBeenCalled()
      expect(d.resolve).not.toHaveBeenCalled()
    })

  it('takes a path only if main handed it to the page', async () => {
    const d = deps()
    expect(await handOff('show', [{ path: 'C:\\Windows\\notepad.exe' }], d)).toEqual({ ok: false, reason: 'Not a file Typose holds' })
    expect(await handOff('show', [{ path: FILE }], d)).toEqual({ ok: true })
    expect(d.show.mock.calls).toEqual([[FILE]])
  })

  it('asks the core host for everything else, with only the fields it reads', async () => {
    const d = deps()
    expect(await handOff('open', [{ ...DOC, path2: 'x', extra: { big: true } }], d)).toEqual({ ok: true })
    expect(d.resolve.mock.calls).toEqual([[{ ...DOC, target: undefined }]])
    const entry = { session: 1, root: '1', node: '4' }
    await handOff('show', [{ entry, doc: 9 }], d)
    expect(d.resolve).toHaveBeenLastCalledWith({ entry })
    expect(d.open.mock.calls).toEqual([[FILE]])
  })

  it("refuses what the core host refuses, and a network path it holds", async () => {
    const refused = deps({ resolve: vi.fn(async () => { throw new Error('no document 9') }) })
    expect(await handOff('show', [{ ...DOC, doc: 9 }], refused)).toEqual({ ok: false, reason: 'Not a file Typose holds · no document 9' })
    const unc = deps({ resolve: vi.fn(async () => '\\\\server\\share\\notes.txt') })
    expect(await handOff('show', [DOC], unc)).toMatchObject({ ok: false, reason: 'Typose doesn’t hand off network or device paths' })
    expect(refused.show).not.toHaveBeenCalled()
    expect(unc.show).not.toHaveBeenCalled()
  })
})

describe('Z79: Open with default app never runs a program or script', () => {
  for (const path of ['C:\\kit\\setup.bat', 'C:\\kit\\SETUP.BAT', 'C:\\kit\\setup.bat. .', 'C:\\kit\\run.ps1', 'C:\\kit\\Tool.lnk', 'C:\\kit\\a.exe',
    'C:\\kit\\x.settingcontent-ms', 'C:\\kit\\x.appref-ms', 'C:\\kit\\help.chm', 'C:\\kit\\.bat', 'C:\\kit\\custom.foo'])
    it('refuses ' + path, async () => {
      const d = deps({ resolve: vi.fn(async () => path) })
      expect(await handOff('open', [DOC], d)).toEqual({ ok: false, reason: 'Typose won’t open programs or scripts · show the file in its folder instead' })
      expect(d.open).not.toHaveBeenCalled()
      expect(await handOff('show', [DOC], d)).toEqual({ ok: true }) // Show in Explorer is allowed for any checked path
      expect(d.show.mock.calls).toEqual([[path]])
    })

  it('refuses a folder, and reports what the OS refused', async () => {
    const folder = deps({ isDirectory: vi.fn(async () => true) })
    expect(await handOff('open', [DOC], folder)).toEqual({ ok: false, reason: 'Open with default app opens files, not folders' })
    expect(folder.open).not.toHaveBeenCalled()
    const failing = deps({ open: vi.fn(async () => 'No application is associated') })
    expect(await handOff('open', [DOC], failing)).toEqual({ ok: false, reason: 'No application is associated' })
    const missing = deps({ isDirectory: vi.fn(async () => { throw new Error('ENOENT') }) })
    expect(await handOff('open', [DOC], missing)).toEqual({ ok: false, reason: 'ENOENT' })
  })
})
