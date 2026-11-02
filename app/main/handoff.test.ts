import { describe, expect, it, vi } from 'vitest'
import { type HandoffDeps, gestures, handOff, pathRefusal } from './handoff'

const FILE = 'C:\\work\\notes.txt'
const TOKEN = '0a1b2c3d-0000-4000-8000-00000000000e'
const GESTURE = 'Hand-offs need a click or key press on a Typose control'
const PROGRAM = 'Typose won’t open programs or scripts · show the file in its folder instead'

function deps(over: Partial<Pick<HandoffDeps, 'resolve' | 'isDirectory'>> & { open?: HandoffDeps['open'] } = {}) {
  return {
    takeGesture: vi.fn((token: unknown) => token === TOKEN),
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
/** A hand-off as the preload sends it after a trusted press: the subject and the armed token. */
const ask = (action: 'show' | 'open', subject: unknown, d: HandoffDeps) => handOff(action, [subject, TOKEN], d)

describe('Z79: a hand-off needs a fresh user gesture', () => {
  it('refuses a call without the armed token, before asking anyone for a path', async () => {
    const d = deps()
    for (const args of [[{ path: FILE }], [{ path: FILE }, undefined], [{ path: FILE }, 'forged'], [{ path: FILE }, TOKEN, 'extra']])
      expect(await handOff('show', args, d), JSON.stringify(args)).toEqual({ ok: false, reason: GESTURE })
    expect(d.show).not.toHaveBeenCalled()
    expect(d.resolve).not.toHaveBeenCalled()
    expect(await ask('show', { path: FILE }, d)).toEqual({ ok: true })
  })

  it('arms one token at a time, once, for a second', () => {
    let now = 0
    const g = gestures(() => now)
    g.arm(TOKEN)
    expect(g.take('00000000-0000-4000-8000-000000000002')).toBe(false) // a wrong token also spends the armed one
    expect(g.take(TOKEN)).toBe(false)
    g.arm(TOKEN)
    now = 1000
    expect(g.take(TOKEN)).toBe(true)
    expect(g.take(TOKEN)).toBe(false)
    g.arm(TOKEN)
    now = 2001
    expect(g.take(TOKEN)).toBe(false)
    for (const bad of [undefined, 7, 'not-a-uuid', TOKEN.toUpperCase()]) {
      g.arm(bad)
      expect(g.take(bad)).toBe(false)
    }
  })
})

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
  for (const subject of [null, FILE, [FILE], 7])
    it('refuses subject shape ' + JSON.stringify(subject), async () => {
      const d = deps()
      expect(await ask('show', subject, d)).toMatchObject({ ok: false })
      expect(d.show).not.toHaveBeenCalled()
      expect(d.resolve).not.toHaveBeenCalled()
    })

  it('takes a path only if main handed it to the page', async () => {
    const d = deps()
    expect(await ask('show', { path: 'C:\\Windows\\notepad.exe' }, d)).toEqual({ ok: false, reason: 'Not a file Typose holds' })
    expect(await ask('show', { path: FILE }, d)).toEqual({ ok: true })
    expect(d.show.mock.calls).toEqual([[FILE]])
  })

  it('asks the core host for everything else, with only the fields it reads', async () => {
    const d = deps()
    expect(await ask('open', { ...DOC, path2: 'x', extra: { big: true } }, d)).toEqual({ ok: true })
    expect(d.resolve.mock.calls).toEqual([[{ ...DOC, target: undefined }]])
    const entry = { session: 1, root: '1', node: '4' }
    await ask('show', { entry, doc: 9 }, d)
    expect(d.resolve).toHaveBeenLastCalledWith({ entry })
    expect(d.open.mock.calls).toEqual([[FILE]])
  })

  it('refuses what the core host refuses, and a network path it holds', async () => {
    const refused = deps({ resolve: vi.fn(async () => { throw new Error('no document 9') }) })
    expect(await ask('show', { ...DOC, doc: 9 }, refused)).toEqual({ ok: false, reason: 'Not a file Typose holds · no document 9' })
    const unc = deps({ resolve: vi.fn(async () => '\\\\server\\share\\notes.txt') })
    expect(await ask('show', DOC, unc)).toMatchObject({ ok: false, reason: 'Typose doesn’t hand off network or device paths' })
    expect(refused.show).not.toHaveBeenCalled()
    expect(unc.show).not.toHaveBeenCalled()
  })
})

describe('Z79: Open with default app never runs a program or script', () => {
  for (const path of ['C:\\kit\\setup.bat', 'C:\\kit\\SETUP.BAT', 'C:\\kit\\run.ps1', 'C:\\kit\\Tool.lnk', 'C:\\kit\\a.exe', 'C:\\kit\\x.settingcontent-ms',
    'C:\\kit\\help.chm', 'C:\\kit\\.bat', 'C:\\kit\\custom.foo'])
    it('refuses the program or script ' + path, async () => {
      const d = deps({ resolve: vi.fn(async () => path) })
      expect(await ask('open', DOC, d)).toEqual({ ok: false, reason: PROGRAM })
      expect(d.open).not.toHaveBeenCalled()
      expect(await ask('show', DOC, d)).toEqual({ ok: true }) // Show in Explorer is allowed for any checked path
      expect(d.show.mock.calls).toEqual([[path]])
    })

  it('refuses a folder, and reports what the OS refused', async () => {
    const folder = deps({ isDirectory: vi.fn(async () => true) })
    expect(await ask('open', DOC, folder)).toEqual({ ok: false, reason: 'Open with default app opens files, not folders' })
    expect(folder.open).not.toHaveBeenCalled()
    const failing = deps({ open: vi.fn(async () => 'No application is associated') })
    expect(await ask('open', DOC, failing)).toEqual({ ok: false, reason: 'No application is associated' })
    const missing = deps({ isDirectory: vi.fn(async () => { throw new Error('ENOENT') }) })
    expect(await ask('open', DOC, missing)).toEqual({ ok: false, reason: 'ENOENT' })
  })
})
