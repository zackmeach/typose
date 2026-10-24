// Driving the packaged, fused build (plan §5, ruling OQ-2). Playwright's _electron.launch can't: it needs the Node
// inspector, which the fuse turns off. So the executable is spawned directly, with a private --user-data-dir, and
// with `cdp` it gets --remote-debugging-port=0 and is attached with connectOverCDP. Startup marks come from the
// read-only TYPOSE_MARKS hook, so a launch without `cdp` passes no debugging switch at all (a cold launch).
import { type Browser, type Page, chromium } from '@playwright/test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Exit, cleanups, keepEvidence } from './app'

const DIST = resolve(__dirname, '../app/dist')

/** electron-builder --dir's layout per platform: the executable, the binary that holds the fuse wire, and the asar. */
export const PACKAGED = {
  win32: {
    exe: join(DIST, 'win-unpacked/Typose.exe'),
    fuses: join(DIST, 'win-unpacked/Typose.exe'),
    asar: join(DIST, 'win-unpacked/resources/app.asar')
  },
  darwin: {
    exe: join(DIST, 'mac-arm64/Typose.app/Contents/MacOS/Typose'),
    fuses: join(DIST, 'mac-arm64/Typose.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'),
    asar: join(DIST, 'mac-arm64/Typose.app/Contents/Resources/app.asar')
  },
  linux: {
    exe: join(DIST, 'linux-unpacked/typose'),
    fuses: join(DIST, 'linux-unpacked/typose'),
    asar: join(DIST, 'linux-unpacked/resources/app.asar')
  }
}[process.platform as 'win32' | 'darwin' | 'linux']

export interface PackagedLaunch {
  proc: ChildProcess
  pid: number
  userData: string
  /** The TYPOSE_MARKS file this launch writes. */
  marksFile: string
  /** Date.now() just before the spawn: what every startup figure is measured from. */
  spawnedAt: number
  exited: Promise<Exit>
  /** With `cdp`: the browser over CDP and the app's page. */
  browser?: Browser
  page?: Page
  /** Closes this launch if the test ends with it still open (registered with app.ts's fixture). */
  cleanup: () => Promise<unknown>
}

export interface LaunchOptions {
  exe?: string
  /** Arguments before the file, e.g. the app script for a dev-layout electron.exe. */
  args?: string[]
  file?: string
  cdp?: boolean
  netlog?: string
  /** Set TYPOSE_MARKS (the default). `false` launches with the hook unset, as a user's launch is. */
  marks?: boolean
  env?: Record<string, string>
}

export async function launchPackaged(opts: LaunchOptions = {}): Promise<PackagedLaunch> {
  const exe = opts.exe ?? PACKAGED.exe
  if (!existsSync(exe)) throw new Error(`${exe} is missing: run \`npm run package\` first`)
  const userData = mkdtempSync(join(tmpdir(), 'typose-pkg-'))
  const marksFile = join(userData, 'marks.jsonl')
  // Never inherit TYPOSE_* from the shell: a stray hook would change what's measured.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const args = [...(opts.args ?? []), `--user-data-dir=${userData}`]
  if (opts.cdp) args.push('--remote-debugging-port=0')
  if (opts.netlog) args.push(`--log-net-log=${opts.netlog}`)
  if (opts.file) args.push(opts.file)
  const env = { ...base, ...(opts.marks === false ? {} : { TYPOSE_MARKS: marksFile }), ...opts.env }
  const spawnedAt = Date.now()
  const proc = spawn(exe, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const exited = new Promise<Exit>((ok) => proc.once('exit', (code, signal) => ok({ code, signal })))
  let stderr = ''
  proc.stderr!.on('data', (d: Buffer) => (stderr += d.toString()))
  const l: PackagedLaunch = { proc, pid: proc.pid!, userData, marksFile, spawnedAt, exited, cleanup: () => closePackaged(l) }
  cleanups.add(l.cleanup) // a test that fails before closing it still closes it, with its evidence (plan C9)
  if (!opts.cdp) return l
  try {
    const ws = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`no DevTools endpoint after 30 s:\n${stderr}`)), 30_000)
      const seen = () => {
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
        if (m) {
          clearTimeout(timer)
          ok(m[1])
        }
      }
      proc.stderr!.on('data', seen)
      void exited.then((e) => fail(new Error(`exited ${JSON.stringify(e)} before DevTools listened:\n${stderr}`)))
    })
    l.browser = await chromium.connectOverCDP(ws)
    const context = l.browser.contexts()[0]
    l.page = context.pages().find((p) => p.url().startsWith('typose:')) ?? (await context.waitForEvent('page'))
  } catch (e) {
    await closePackaged(l).catch(() => {}) // no orphaned app or profile; the evidence is kept
    throw e
  }
  return l
}

/** Startup marks so far, by name: `t` is the wall clock in ms; `show` also carries the display's refresh rate. */
export function readMarks(l: PackagedLaunch): Record<string, { t: number; [k: string]: unknown }> {
  if (!existsSync(l.marksFile)) return {}
  const marks: Record<string, { t: number }> = {}
  for (const line of readFileSync(l.marksFile, 'utf8').split('\n').filter(Boolean)) {
    const { mark, ...rest } = JSON.parse(line) as { mark: string; t: number }
    marks[mark] ??= rest // the first of each
  }
  return marks
}

/** Polls the marks file until every name is present. */
export async function waitMarks(l: PackagedLaunch, names: string[], timeout = 30_000): Promise<ReturnType<typeof readMarks>> {
  const until = Date.now() + timeout
  for (;;) {
    const marks = readMarks(l)
    if (names.every((n) => n in marks)) return marks
    if (Date.now() > until) throw new Error(`marks missing after ${timeout} ms: ${names.filter((n) => !(n in marks)).join(', ')}`)
    await new Promise((ok) => setTimeout(ok, 20))
  }
}

/**
 * Closes the app the way a user does, without CDP: on Windows, taskkill without /F posts WM_CLOSE to its window;
 * elsewhere, SIGTERM. Then keeps the run's evidence (plan C9) and deletes the profile unless `keep`.
 */
export async function closePackaged(l: PackagedLaunch, keep = false): Promise<Exit> {
  cleanups.delete(l.cleanup)
  await l.browser?.close().catch(() => {}) // disconnects; the app stays up
  if (l.proc.exitCode === null && l.proc.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(l.pid)])
    else l.proc.kill('SIGTERM')
  }
  const closed = await Promise.race([l.exited, new Promise<null>((ok) => setTimeout(() => ok(null), 15_000))])
  const exit = closed ?? (l.proc.kill('SIGKILL'), await l.exited)
  keepEvidence(l.userData, l.pid, exit, keep)
  if (!closed) throw new Error(`pid ${l.pid} didn't exit within 15 s of its close, and was killed`)
  return exit
}
