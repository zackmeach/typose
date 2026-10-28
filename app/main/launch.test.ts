// Spec §8.1 and plan C4 for what PR 8 adds: the path a launch names, and the untrusted message a second instance sends.
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handoff, launchPath, launchPaths } from './launch'

const cwd = resolve('/launch-cwd')
const exe = 'typose'

describe('launchPaths', () => {
  it('preserves all nonempty file arguments in order, including development and -- rules', () => {
    expect(launchPaths([exe, 'a.txt', 'b.md', ''], cwd, false)).toEqual([resolve(cwd, 'a.txt'), resolve(cwd, 'b.md')])
    expect(launchPaths(['electron', '--switch', 'app', 'a.txt', '--', '-b.md'], cwd, true)).toEqual([resolve(cwd, 'a.txt'), resolve(cwd, '-b.md')])
    expect(launchPaths([exe, '--switch', '--'], cwd, false)).toEqual([])
  })
})

describe('launchPath', () => {
  it('takes the last path, resolved against the cwd', () => expect(launchPath([exe, 'a.txt', 'b.txt'], cwd, false)).toBe(resolve(cwd, 'b.txt')))
  it('skips switches before --, and takes anything after it as a path', () => {
    expect(launchPath([exe, '--user-data-dir=x', 'a.txt', '--flag'], cwd, false)).toBe(resolve(cwd, 'a.txt'))
    expect(launchPath([exe, '--x', '--', '--y=z.txt'], cwd, false)).toBe(resolve(cwd, '--y=z.txt'))
    expect(launchPath([exe, '--', 'a.txt', '--', '-b.txt'], cwd, false)).toBe(resolve(cwd, '-b.txt'))
  })
  it('names nothing without a path, and skips empty ones', () => {
    expect(launchPath([exe, '--x'], cwd, false)).toBeNull()
    expect(launchPath([exe, '--'], cwd, false)).toBeNull()
    expect(launchPath([exe, 'a.txt', ''], cwd, false)).toBe(resolve(cwd, 'a.txt'))
  })
  it('skips the app in development (electron <app> <file>)', () => {
    expect(launchPath(['electron', '--remote-debugging-port=0', 'app', 'a.txt'], cwd, true)).toBe(resolve(cwd, 'a.txt'))
    expect(launchPath(['electron', 'app'], cwd, true)).toBeNull()
  })
  it('reads URL-like and device paths as paths', () => {
    expect(launchPath([exe, '--', 'typose://app/x'], cwd, false)).toBe(resolve(cwd, 'typose://app/x'))
    expect(launchPath([exe, '--', 'file:///etc/passwd'], cwd, false)).toBe(resolve(cwd, 'file:///etc/passwd'))
  })
})

describe("handoff: a second instance's argv and cwd, refused unless they have a real launch's shape and size", () => {
  it('takes a real launch', () => expect(handoff({ argv: [exe, 'a.txt'], cwd })).toEqual({ argv: [exe, 'a.txt'], cwd }))
  it('refuses a sparse array of length 2^32 − 1 at once, without reading it', () => {
    const argv: string[] = []
    argv.length = 2 ** 32 - 1
    const start = performance.now()
    expect(handoff({ argv, cwd })).toBeNull()
    expect(performance.now() - start).toBeLessThan(50)
  })
  it('takes 4,096 arguments and refuses 4,097', () => {
    expect(handoff({ argv: Array(4096).fill('a'), cwd })).not.toBeNull()
    expect(handoff({ argv: Array(4097).fill('a'), cwd })).toBeNull()
  })
  it("takes 32,767 characters of arguments, Windows' command-line limit, and refuses more", () => {
    expect(handoff({ argv: ['a'.repeat(32_766), 'b'], cwd })).not.toBeNull()
    expect(handoff({ argv: ['a'.repeat(32_767), 'b'], cwd })).toBeNull()
    expect(handoff({ argv: [exe], cwd: 'c'.repeat(32_768) })).toBeNull()
  })
  it('refuses holes, non-strings, and anything that is not an argv and a cwd', () => {
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the test
    for (const argv of [[exe, , 'a.txt'], [exe, 1], [exe, null], [exe, ['a.txt']], 'a.txt', { length: 1, 0: 'a.txt' }, null])
      expect(handoff({ argv, cwd }), JSON.stringify(argv)).toBeNull()
    for (const data of [undefined, null, 1, 'x', [], { argv: [exe] }, { argv: [exe], cwd: 1 }, { cwd }])
      expect(handoff(data), JSON.stringify(data)).toBeNull()
  })
})
