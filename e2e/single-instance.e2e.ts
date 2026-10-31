// Plan PR 8 on the packaged build (`npm run package` first): spec §8.1's single instance, argv and open-file, and the
// `typose` launchers. Every launch here gets the test's own --user-data-dir before any other argument, and the lock
// is per profile, so no launch can reach an instance the test didn't start. macOS's `open -a` hands a file to the
// bundle's running instance, so it runs only once the test has checked that the bundle has no instance but its own.
import { type Page, chromium, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { APP_DIR, type Exit, FIXTURES, fixture, keepEvidence, lifecycle, test, waitOpen } from './app'
import { PACKAGED, closePackaged, launchPackaged } from './packaged'

const win = process.platform === 'win32'

/** A second launch of the packaged build on `userData`, the first's profile. It must exit by itself, within 15 s. */
async function second(userData: string, args: string[]): Promise<Exit> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const proc = spawn(PACKAGED.exe, [`--user-data-dir=${userData}`, ...args], { cwd: FIXTURES, env, stdio: 'ignore' })
  const exited = new Promise<Exit>((ok) => proc.once('exit', (code, signal) => ok({ code, signal })))
  const exit = await Promise.race([exited, new Promise<null>((ok) => setTimeout(() => ok(null), 15_000))])
  if (exit) return exit
  proc.kill()
  await exited
  throw new Error(`a second launch with ${JSON.stringify(args)} was still running after 15 s, and was killed`)
}

/** Whether a process this test didn't spawn is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The page's title, and its card's text: the first row of a one-line file, or the card's message. */
const card = async (page: Page) => ({
  title: await page.title(),
  text: await page.evaluate(() => (document.querySelector('.vl-row .text') ?? document.querySelector('.card-message p'))?.textContent)
})

/** The app's own `fileName` (renderer/card.ts), for the title a path gives. */
const fileName = (path: string) => path.split(/[\\/]/).pop() || path

test('a second launch opens its file in the first instance and exits 0, with every path shape; its exit leaves the marker (C9)', async () => {
  const first = await launchPackaged({ cdp: true, file: fixture('si-first.txt', 'first') })
  const page = first.page!
  await waitOpen(page)
  fixture('si-a.txt', 'not the newest')
  // [what it shows, the arguments, the file]. Relative paths are resolved against the second launch's cwd.
  const shapes: [string, string[], string][] = [
    ['a relative path', ['si-relative.txt'], 'si-relative.txt'],
    ['spaces', [join(FIXTURES, 'si a b c.txt')], 'si a b c.txt'],
    ['Unicode', [join(FIXTURES, 'si café 語 😀.txt')], 'si café 語 😀.txt'],
    ['an option-like name after --', ['--', '--si-option=x.txt'], '--si-option=x.txt'],
    ['a dash name after --', ['--', '-si-dash.txt'], '-si-dash.txt'],
    ['%, ^, & and !', [join(FIXTURES, 'si 100% a^b&c!d.txt')], 'si 100% a^b&c!d.txt'],
    ['the newest of several', ['--', 'si-a.txt', 'si-b.txt'], 'si-b.txt'],
  ]
  for (const [label, args, name] of shapes) {
    fixture(name, label)
    expect(await second(first.userData, args), label).toEqual({ code: 0, signal: null })
    await expect.poll(() => card(page), label).toEqual({ title: `${name} — Typose`, text: label })
  }
  await page.getByRole('tab', { name: 'si-a.txt', exact: true }).click()
  await expect.poll(() => card(page)).toEqual({ title: 'si-a.txt — Typose', text: 'not the newest' })
  await page.getByRole('tab', { name: 'si-b.txt', exact: true }).click()
  await expect.poll(() => card(page)).toEqual({ title: 'si-b.txt — Typose', text: 'the newest of several' })
  // C9: no second launch logged anything or left a marker, and the first's is still there.
  expect(readdirSync(join(first.userData, 'logs')).filter((n) => n.startsWith('running-'))).toEqual([`running-${first.pid}.json`])
  expect(lifecycle(first.userData).filter((r) => r.pid !== first.pid)).toEqual([])
  expect(await closePackaged(first)).toEqual({ code: 0, signal: null })
})

test("a second launch's argv is untrusted: URL-like, device and option-like paths meet the same refusals as any open", async () => {
  const first = await launchPackaged({ cdp: true, file: fixture('si-trusted.txt', 'trusted') })
  const page = first.page!
  await waitOpen(page)
  const real = fixture('si-real.txt', 'opened')
  // A device that answers if it's opened: a named pipe on Windows (where even a stat connects), a FIFO elsewhere.
  const device = win ? `\\\\.\\pipe\\typose-e2e-si-${process.pid}` : join(mkdtempSync(join(tmpdir(), 'typose-si-')), 'fifo')
  let connections = 0
  const server = createServer((socket) => {
    connections++
    socket.destroy()
  })
  if (win) await new Promise<void>((ok) => server.listen(device, ok))
  else expect(spawnSync('mkfifo', [device]).status).toBe(0)
  try {
    // [the arguments, what the card says]: refused or not found, never the file a path only looks like.
    const cases: [string[], RegExp][] = [
      [['--', 'typose://app/index.html'], /^(File not found at|Can't open) /],
      [['--', `file:///${real.replaceAll('\\', '/')}`], /^(File not found at|Can't open) /],
      [['--', device], /refused/],
      [['--', '--disable-web-security'], /^File not found at /],
      [['--inspect=0', '--', '--remote-debugging-port=0'], /^File not found at /], // the switch is the second's own
    ]
    if (win) cases.push([['--', `\\\\?\\${real}`], /refused/], [['--', `\\\\.\\${real}`], /refused/])
    for (const [args, says] of cases) {
      const label = args.join(' ')
      expect(await second(first.userData, args), label).toEqual({ code: 0, signal: null })
      const path = resolve(FIXTURES, args.at(-1)!) // as main resolves it, against the second launch's cwd
      await expect(page, label).toHaveTitle(`${fileName(path)} — Typose`)
      await expect(page.locator('.card-message p'), label).toContainText(path)
      await expect(page.locator('.card-message p'), label).toHaveText(says)
      expect(await page.locator('.vl-row').count(), label).toBe(0) // nothing opened
      expect(connections, label).toBe(0) // and nothing connected to the pipe
    }
    expect(page.url()).toBe('typose://app/index.html')
    expect(await closePackaged(first)).toEqual({ code: 0, signal: null })
  } finally {
    server.close()
    if (!win) rmSync(dirname(device), { recursive: true, force: true })
  }
})

test('the typose launchers ship beside the app, and hand Typose every argument as a path, after --', async () => {
  const name = win ? 'typose.cmd' : 'typose'
  const shipped = join(dirname(PACKAGED.asar), 'bin', name)
  expect(existsSync(shipped)).toBe(true)
  if (!win) expect(statSync(shipped).mode & 0o111).not.toBe(0) // executable
  // A stand-in for Typose that records its pid, cwd and argv, two folders up from the launcher as in the package.
  const root = mkdtempSync(join(FIXTURES, 'launcher-')) // beside node_modules, so the hard links below stay on one drive
  const out = join(root, 'argv.json')
  const bin = join(root, 'resources', 'bin')
  const launcher = join(bin, name)
  mkdirSync(bin, { recursive: true })
  copyFileSync(join(APP_DIR, 'bin', name), launcher)
  const record = "require('fs').writeFileSync(process.env.STUB_OUT, JSON.stringify([process.pid, process.cwd(), ...process.argv.slice(1)]))"
  if (win) {
    // Electron itself as Typose.exe, running a stub app from resources\app that exits before ready: no window.
    const link = (from: string, to: string): void => {
      for (const e of readdirSync(from, { withFileTypes: true })) {
        const target = join(to, e.name === 'electron.exe' ? 'Typose.exe' : e.name)
        if (!e.isDirectory()) linkSync(join(from, e.name), target)
        else {
          mkdirSync(target, { recursive: true })
          link(join(from, e.name), target)
        }
      }
    }
    link(resolve(APP_DIR, '../node_modules/electron/dist'), root)
    mkdirSync(join(root, 'resources', 'app'))
    writeFileSync(join(root, 'resources', 'app', 'package.json'), '{ "main": "main.js" }')
    writeFileSync(join(root, 'resources', 'app', 'main.js'), `${record}; require('electron').app.exit(0)`)
  } else {
    writeFileSync(join(root, 'typose'), `#!/bin/sh\nexec '${process.execPath}' -e "${record}" -- "$@"\n`)
    chmodSync(join(root, 'typose'), 0o755)
    chmodSync(launcher, 0o755)
  }
  const cwd = mkdtempSync(join(tmpdir(), 'typose-cwd-'))
  const env = { ...process.env, STUB_OUT: out }
  /** Runs the launcher, as cmd.exe runs what a user types (`line`) or as a program runs it, and returns what Typose got. */
  const run = async (line: string | string[]): Promise<string[]> => {
    rmSync(out, { force: true })
    const proc =
      typeof line === 'string'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/v:off', '/c', `""${launcher}" ${line}"`], { cwd, env, windowsVerbatimArguments: true, windowsHide: true })
        : spawn(launcher, line, { cwd, env })
    expect(await new Promise((ok) => proc.once('exit', ok)), String(line)).toBe(0)
    const got = (): [number, string, ...string[]] | null => {
      try {
        return JSON.parse(readFileSync(out, 'utf8')) as [number, string, ...string[]]
      } catch {
        return null // not written yet: the launcher doesn't wait for Typose
      }
    }
    await expect.poll(got, { timeout: 15_000 }).not.toBeNull()
    const [pid, at, ...argv] = got()!
    expect(realpathSync(at)).toBe(realpathSync(cwd)) // the user's cwd, which relative paths are resolved against
    // Detached, it may still hold that cwd, and its binary, after it wrote the file: the next run, or the cleanup, waits.
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false)
    return argv
  }
  // [the arguments as typed, what Typose gets after its --]
  const shapes: [string[], string[]][] = [
    [['a b.txt'], ['a b.txt']],
    [['café 語 😀.txt'], ['café 語 😀.txt']],
    [['rel.txt', 'sub/x.txt'], ['rel.txt', 'sub/x.txt']],
    [['-dash.txt', '--opt=x.txt'], ['-dash.txt', '--opt=x.txt']],
    [['--', '-dash.txt'], ['-dash.txt']], // a leading -- is the launcher's own
    [['--', '--'], ['--']],
    [['100%.txt', '50%typose_no_such_var%.txt'], ['100%.txt', '50%typose_no_such_var%.txt']],
    [['a^b.txt', 'a&b.txt', 'wow!.txt', 'x!y!z.txt', '(k)', 'l;m', 'n,o', 'p=q'], ['a^b.txt', 'a&b.txt', 'wow!.txt', 'x!y!z.txt', '(k)', 'l;m', 'n,o', 'p=q']],
  ]
  if (!win) shapes.push([['$HOME', '`id`', '*', `it's "x"`, 'two\nlines'], ['$HOME', '`id`', '*', `it's "x"`, 'two\nlines']])
  try {
    for (const [typed, gets] of shapes) {
      // In cmd.exe, as a user types them: each quoted, with delayed expansion off, as it is by default.
      expect(await run(win ? typed.map((a) => `"${a}"`).join(' ') : typed), typed.join(' ')).toEqual(['--', ...gets])
    }
    // Unquoted, with cmd.exe's own escapes: the launcher gets a&b^c.txt, and passes on just that.
    if (win) expect(await run('a^&b^^c.txt')).toEqual(['--', 'a&b^c.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) // in case a stand-in outlived a failure
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

// macOS names files through open-file, not argv (spec §8.1). `open -a` hands a file to the running instance of the
// bundle, so these tests first check that the only one is their own.
const bundle = dirname(dirname(dirname(PACKAGED.exe))) // …/Typose.app
const instances = (): number[] =>
  spawnSync('pgrep', ['-f', `${bundle}/Contents/MacOS/Typose`], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number)

test('macOS: open-file after ready opens the newest file in the running app', async () => {
  test.skip(process.platform !== 'darwin', 'open-file is macOS')
  const first = await launchPackaged({ cdp: true, file: fixture('of-first.txt', 'first') })
  await waitOpen(first.page!)
  expect(instances()).toEqual([first.pid])
  const file = fixture('of-after-ready.txt', 'after ready')
  expect(spawnSync('open', ['-a', bundle, file]).status).toBe(0)
  await expect.poll(() => card(first.page!)).toEqual({ title: 'of-after-ready.txt — Typose', text: 'after ready' })
  expect(instances()).toEqual([first.pid]) // and no other instance took it
  expect(await closePackaged(first)).toEqual({ code: 0, signal: null })
})

test('macOS: open-file before ready, at a launch to open the file, opens it', async () => {
  test.skip(process.platform !== 'darwin', 'open-file is macOS')
  expect(instances()).toEqual([])
  const userData = mkdtempSync(join(tmpdir(), 'typose-pkg-'))
  const file = fixture('of-before-ready.txt', 'before ready')
  // -n: a new instance, never a running one. The file comes as an Apple Event while it launches; --args is its argv.
  expect(spawnSync('open', ['-n', '-a', bundle, file, '--args', `--user-data-dir=${userData}`, '--remote-debugging-port=0']).status).toBe(0)
  let pid = 0
  try {
    const port = join(userData, 'DevToolsActivePort')
    await expect.poll(() => existsSync(port) && readFileSync(port, 'utf8').includes('\n'), { timeout: 30_000 }).toBe(true)
    pid = lifecycle(userData).find((r) => r.event === 'start')!.pid as number
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${readFileSync(port, 'utf8').split('\n')[0]}`)
    const context = browser.contexts()[0]
    const page = context.pages().find((p) => p.url().startsWith('typose:')) ?? (await context.waitForEvent('page'))
    await expect.poll(() => card(page)).toEqual({ title: 'of-before-ready.txt — Typose', text: 'before ready' })
    await browser.close()
  } finally {
    // Not this test's child: its exit is read from its lifecycle log, where a clean quit logs quit with the code.
    for (const p of pid ? [pid] : instances()) process.kill(p, 'SIGTERM') // without a pid, every instance is this test's
    await expect.poll(instances, { timeout: 15_000 }).toEqual([])
    const quit = existsSync(join(userData, 'logs')) ? lifecycle(userData).find((r) => r.event === 'quit') : undefined
    keepEvidence(userData, pid, { code: typeof quit?.code === 'number' ? quit.code : null, signal: null }, false)
    expect(quit).toMatchObject({ code: 0 })
  }
})
