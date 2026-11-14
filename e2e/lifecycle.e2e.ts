// Plan C9's four controlled failures, each told apart by the lifecycle log and the exit status alone.
import { expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dumps, finish, fixture, killCore, launch, lifecycle, test, waitOpen } from './app'

const events = (userData: string) => lifecycle(userData).map((r) => r.event)
const file = () => fixture('lifecycle.txt', Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'))

test('dump discovery traverses directories, skips directory entries and does not follow directory links', () => {
  const profile = test.info().outputPath('dump-profile')
  expect(dumps(profile)).toEqual([])
  const crashpad = join(profile, 'Crashpad')
  const nested = join(crashpad, 'pending', 'nested')
  const directory = join(crashpad, 'directory.dmp')
  mkdirSync(nested, { recursive: true })
  mkdirSync(directory)
  const outside = test.info().outputPath('outside-profile')
  mkdirSync(outside)
  writeFileSync(join(outside, 'outside.dmp'), '')
  symlinkSync(outside, join(crashpad, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const files = [join(crashpad, 'root.dmp'), join(nested, 'nested.dmp'), join(directory, 'inside.dmp')]
  for (const path of [...files, join(nested, 'not-a-dump.txt'), join(crashpad, 'upper.DMP')]) writeFileSync(path, '')
  expect(dumps(profile).sort()).toEqual(files.sort())
})

test('a window close is a clean quit sequence, exit 0', async () => {
  const l = await launch({ file: file() })
  await waitOpen(l.win)
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  expect(await l.exited).toEqual({ code: 0, signal: null })
  const log = events(l.userData)
  const [before, will, quit] = ['before-quit', 'will-quit', 'quit'].map((e) => log.indexOf(e))
  expect(0 < before && before < will && will < quit).toBe(true)
  expect(lifecycle(l.userData)[quit]).toMatchObject({ code: 0 })
  expect(log).not.toContain('render-process-gone')
  expect(log).not.toContain('child-process-gone') // the core host's exit at quit is clean
  expect(existsSync(join(l.userData, 'logs', `running-${l.pid}.json`))).toBe(false) // the marker is gone
  await finish(l)
})

test('forcefullyCrashRenderer() logs render-process-gone with crashed (killed on macOS)', async () => {
  const l = await launch({ file: file() })
  await waitOpen(l.win)
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
  // Electron reports the forced crash as killed on macOS (main-macos run 39977019396), crashed on Windows and Linux.
  const reason = process.platform === 'darwin' ? 'killed' : 'crashed'
  await expect.poll(() => lifecycle(l.userData).find((r) => r.event === 'render-process-gone')).toMatchObject({ reason })
  expect(await l.app.evaluate(() => process.pid)).toBe(l.pid) // main lives on
  await finish(l)
})

test('a core kill (C7): main logs the exit and lives on, and the card shows the core stopped', async () => {
  const l = await launch({ file: file() })
  await waitOpen(l.win)
  killCore(l)
  await expect(l.win.locator('.card-message p')).toHaveText("Typose's core stopped") // then Reopen (core-death.e2e.ts)
  const log = lifecycle(l.userData)
  expect(log.find((r) => r.event === 'utility-exit')).toMatchObject({ session: 1 })
  expect(log.find((r) => r.event === 'child-process-gone')).toMatchObject({ type: 'Utility', name: 'typose-core' })
  expect(await l.app.evaluate(() => process.pid)).toBe(l.pid)
  // Pending calls fail with CoreGone (unit-tested in core.test.ts); none of them goes unhandled.
  await l.win.waitForTimeout(300)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('an armed process.crash() in main: an external crash exit, a dump, and the unclean marker next launch', async () => {
  const path = file()
  const first = await launch({ file: path })
  await waitOpen(first.win)
  const sessionFile = join(first.userData, 'session.json')
  await expect.poll(() => {
    if (!existsSync(sessionFile)) return false
    const saved = JSON.parse(readFileSync(sessionFile, 'utf8')) as { cards?: { tabs: { location: { path: string } }[] }[] }
    return saved.cards?.some(card => card.tabs.some(tab => tab.location.path === path)) ?? false
  }).toBe(true)
  const pid = first.pid
  await first.app.evaluate(() => setTimeout(() => process.crash(), 100))
  const exit = await first.exited
  if (process.platform === 'win32') expect(exit.code).toBe(0xc0000005)
  else expect(exit.signal ?? exit.code).toBeTruthy()
  expect(events(first.userData)).not.toContain('quit')
  if (process.platform === 'win32') await expect.poll(() => dumps(first.userData).length).toBeGreaterThan(0)
  await finish(first, true)

  const second = await launch({ userData: first.userData })
  await waitOpen(second.win)
  await expect(second.win.getByRole('tab', { name: 'lifecycle.txt' })).toHaveAttribute('aria-selected', 'true')
  const unclean = lifecycle(second.userData).find((r) => r.event === 'previous-run-unclean')
  expect(unclean).toMatchObject({ previousPid: pid })
  if (process.platform === 'win32') expect((unclean!.dumps as string[]).length).toBeGreaterThan(0)
  await finish(second)
  rmSync(first.userData, { recursive: true, force: true })
})

// Electron on Linux sometimes fails the start page's request and shows Chromium's error page (main's retry). The
// test-hooks build refuses the start page's first loads in the network guard, which shows the same error page.
test('a start page that fails to load is loaded again, and the app comes up on the retry', async () => {
  const l = await launch({ hooks: true, file: file(), env: { TYPOSE_TEST_FAIL_LOADS: '1' } })
  await waitOpen(l.win) // the file opened, so the core's port reached the app page
  const log = lifecycle(l.userData)
  expect(log.filter((r) => r.event === 'load-retry')).toEqual([expect.objectContaining({ retry: 1, desc: 'ERR_BLOCKED_BY_CLIENT' })])
  expect(log.filter((r) => r.event === 'did-finish-load')).toHaveLength(1)
  expect(events(l.userData).indexOf('load-retry')).toBeLessThan(events(l.userData).indexOf('did-finish-load'))
  await finish(l)
})

test('a start page that never loads is retried 3 times, then Typose quits rather than show a blank window', async () => {
  const l = await launch({ hooks: true, env: { TYPOSE_TEST_FAIL_LOADS: '9' } })
  expect(await Promise.race([l.exited, new Promise<string>((ok) => setTimeout(() => ok('still running after 20 s'), 20_000))])).toEqual({ code: 0, signal: null })
  const log = lifecycle(l.userData)
  expect(log.filter((r) => r.event === 'load-retry').map((r) => r.retry)).toEqual([1, 2, 3])
  expect(log.filter((r) => r.event === 'load-failed')).toEqual([expect.objectContaining({ desc: 'ERR_BLOCKED_BY_CLIENT' })])
  expect(events(l.userData)).not.toContain('did-finish-load')
  await finish(l)
})
