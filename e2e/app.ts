// Launching the dev-layout app for e2e (plan §5: `_electron.launch` is for the dev layout only). Every launch gets
// a private --user-data-dir, so runs never share the app profile, and records the main process's externally
// observed exit status. `finish` keeps each run's lifecycle log, exit status and any new dumps (plan C9); a test
// that fails before calling it gets the same from the `test` exported here.
import { type ElectronApplication, type Page, test as base, _electron as electron, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { DebugStats } from '../app/shared/protocol'

export const APP_DIR = resolve(__dirname, '../app')
/** Generated fixtures; gitignored, and the big ones are deleted after their tests. */
export const FIXTURES = resolve(__dirname, '../.fixtures')

export interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface Launched {
  app: ElectronApplication
  win: Page
  userData: string
  /** The Electron main process's own pid (what its lifecycle log records). */
  pid: number
  /** The launched process's exit code and signal, as the OS reports them. */
  exited: Promise<Exit>
  /** Uncaught errors and unhandled rejections in the page. */
  pageErrors: string[]
}

const running = new Set<Launched>()
/** Other launches to finish when the test ends (the packaged build's, from packaged.ts). */
export const cleanups = new Set<() => Promise<unknown>>()

/** Playwright's `test`, plus: every launch a test leaves open is finished when it ends, pass or fail. */
export const test = base.extend<{ finishLaunches: void }>({
  finishLaunches: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this pattern
    async ({}, use) => {
      await use()
      try {
        for (const l of running) await finish(l)
      } finally {
        for (const cleanup of cleanups) await cleanup().catch(() => {}) // each removes itself, which a Set allows mid-loop
      }
    },
    { auto: true }
  ]
})

// TEMP diagnostics (to be reverted): the macOS launch whose window never comes.
export const OURS = /Electron\.app|Typose\.app/
async function diagnoseNoWindow(app: ElectronApplication, pid: number): Promise<void> {
  const out = base.info().outputPath()
  mkdirSync(out, { recursive: true })
  const state = await Promise.race([
    app
      .evaluate(({ app, BrowserWindow, webContents }) => {
        const safe = (f: () => unknown) => {
          try {
            return f()
          } catch (e) {
            return String(e)
          }
        }
        return {
          realReady: safe(() => (Object.getPrototypeOf(app) as { isReady(): boolean }).isReady.call(app)),
          patchedReady: safe(() => app.isReady()),
          windows: safe(() => BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible() }))),
          contents: safe(() => webContents.getAllWebContents().map((c) => ({ id: c.id, url: c.getURL(), loading: c.isLoading(), crashed: c.isCrashed(), pid: c.getOSProcessId() }))),
          metrics: safe(() => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name, serviceName: m.serviceName })))
        }
      })
      .catch((e: unknown) => `evaluate failed: ${String(e)}`),
    new Promise((ok) => setTimeout(() => ok('evaluate timed out after 5 s'), 5000))
  ])
  console.log(`TEMP no window from pid ${pid}: ${JSON.stringify(state)}`)
  if (process.platform !== 'darwin') return
  const ps = spawnSync('ps', ['-axo', 'pid,ppid,pri,stat,lstart,etime,command'], { encoding: 'utf8' }).stdout
  writeFileSync(join(out, `ps-${pid}.txt`), ps)
  const rows = ps.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/))
  const kids = rows.filter((r) => r[1] === String(pid)).map((r) => r[0])
  console.log(`TEMP ${rows.length} processes; pid ${pid}'s children: ${kids.join(', ') || 'none'}`)
  console.log(ps.split('\n').filter((l, i) => i === 0 || OURS.test(l)).join('\n'))
  for (const p of [String(pid), ...kids.slice(0, 6)]) spawnSync('sample', [p, '2', '-file', join(out, `sample-${p}.txt`)], { encoding: 'utf8', timeout: 60_000 })
  const predicate = [pid, ...kids].map((p) => `processID == ${p}`).join(' OR ')
  const logs = spawnSync('log', ['show', '--last', '45s', '--style', 'compact', '--predicate', predicate], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 })
  writeFileSync(join(out, `log-${pid}.txt`), `${logs.stdout}\n${logs.stderr}`)
  const wide = spawnSync('log', ['show', '--last', '45s', '--style', 'compact', '--predicate', 'messageType == error OR messageType == fault'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 })
  writeFileSync(join(out, 'log-errors.txt'), `${wide.stdout}\n${wide.stderr}`)
  process.kill(pid, 'SIGKILL') // so the worker's teardown doesn't wait 5 min on it
}

/** `hooks` launches the test-hooks build (`npm run build:hooks`, plan m8), with `env` added to the environment. */
export async function launch(opts: { file?: string; userData?: string; netlog?: string; hooks?: boolean; env?: Record<string, string> } = {}): Promise<Launched> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'typose-e2e-'))
  const args = [opts.hooks ? join(APP_DIR, 'out-hooks/main/index.js') : APP_DIR, `--user-data-dir=${userData}`]
  if (opts.netlog) args.push(`--log-net-log=${opts.netlog}`)
  if (opts.file) args.push(opts.file)
  const app = await electron.launch({ args, ...(opts.env ? { env: { ...process.env, ...opts.env } as Record<string, string> } : {}) })
  const proc = app.process()
  const exited = new Promise<Exit>((ok) => {
    if (proc.exitCode !== null) ok({ code: proc.exitCode, signal: proc.signalCode })
    else proc.once('exit', (code, signal) => ok({ code, signal }))
  })
  const pid = await app.evaluate(() => process.pid)
  const win = await app.firstWindow().catch(async (e: unknown) => {
    await diagnoseNoWindow(app, pid) // TEMP diagnostics
    throw e
  })
  const pageErrors: string[] = []
  win.on('pageerror', (e) => pageErrors.push(e.message))
  const l = { app, win, userData, pid, exited, pageErrors }
  running.add(l)
  return l
}

/**
 * Closes the app if it's still up, then keeps the run's evidence in the test's output directory: the exit status,
 * the lifecycle log and any crash dumps. Deletes the private profile unless `keep` (a relaunch reuses it).
 */
export async function finish(l: Launched, keep = false): Promise<Exit> {
  running.delete(l)
  const closing = l.app.close().catch(() => {})
  const exit = await l.exited
  await closing
  keepEvidence(l.userData, l.pid, exit, keep)
  return exit
}

/** Copies a run's exit status, lifecycle log and any dumps into the test's output; deletes the profile unless `keep`. */
export function keepEvidence(userData: string, pid: number, exit: Exit, keep: boolean): void {
  const out = base.info().outputPath()
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `exit-${pid}.json`), JSON.stringify(exit)) // one test may launch twice
  for (const name of ['lifecycle.jsonl', 'lifecycle.1.jsonl']) {
    const log = join(userData, 'logs', name)
    if (existsSync(log)) copyFileSync(log, join(out, `${pid}-${name}`))
  }
  for (const dump of dumps(userData)) copyFileSync(dump, join(out, basename(dump)))
  if (!keep) rmSync(userData, { recursive: true, force: true })
}

/** Crashpad dumps under a profile. */
export function dumps(userData: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name.endsWith('.dmp')) found.push(path)
    }
  }
  walk(join(userData, 'Crashpad'))
  return found
}

/** The card is showing a file's lines once its first row has text. */
export async function waitOpen(win: Page): Promise<void> {
  await expect(win.locator('.vl-row .text').first()).toBeAttached({ timeout: 30_000 })
}

/** Waits until the index reports done (the status shows the line count and encoding), and returns the count. */
export async function waitIndexed(win: Page, timeout = 120_000): Promise<number> {
  const status = win.locator('.card-status')
  await expect(status).toHaveText(/^[\d,]+ lines? · /, { timeout })
  return Number((await status.textContent())!.split(' ')[0].replaceAll(',', ''))
}

export type LifecycleRecord = { event: string; [k: string]: unknown }

/** Lifecycle records from a profile's log (plan C9). */
export function lifecycle(userData: string): LifecycleRecord[] {
  const text = readFileSync(join(userData, 'logs', 'lifecycle.jsonl'), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LifecycleRecord)
}

/** Runs netlog-assert.mjs on a log, as CI does. */
export function assertNetLog(log: string): string {
  expect(statSync(log).size).toBeGreaterThan(0) // a NetLog always holds metadata; emptiness isn't the test
  const run = spawnSync(process.execPath, [join(__dirname, 'netlog-assert.mjs'), log], { encoding: 'utf8' })
  expect(run.status, run.stdout + run.stderr).toBe(0)
  return run.stdout
}

export function fixture(name: string, bytes: string | Uint8Array): string {
  mkdirSync(FIXTURES, { recursive: true })
  const path = join(FIXTURES, name)
  writeFileSync(path, bytes)
  return path
}

/**
 * A file of `size` bytes that takes almost no disk: `head`, then zeros, which a sparse file doesn't store. The index
 * still reads every byte of it (zeros, a single long line). On Windows the file is marked sparse first (FSCTL_SET_SPARSE,
 * through fsutil, which needs no elevation); elsewhere growing a file with truncate leaves a hole.
 */
export function sparseFixture(name: string, size: number, head: string): string {
  const path = fixture(name, head)
  if (process.platform === 'win32') {
    const run = spawnSync('fsutil', ['sparse', 'setflag', path], { encoding: 'utf8' })
    expect(run.status, run.stdout + run.stderr).toBe(0)
  }
  truncateSync(path, size)
  return path
}

/** The test-hooks build's `window.typoseTest` (plan m8): the core client, its hooks' state, and App's close. */
export interface TestHooks {
  core: { call(method: string, params: object): Promise<unknown> }
  client: {
    holding: number
    held: (() => void)[]
    maxPendingPages: number
    aborts: number
    gone: { at: number; rejected: number } | null
    dropped: ('event' | 'response')[]
  }
  app: { close?: () => void }
}

/** The core host's debug stats, on the test-hooks build (plan C5, C6). */
export const debugStats = (win: Page): Promise<DebugStats> =>
  win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.core.call('debugStats', {}) as Promise<DebugStats>)

/** The rows on screen, top to bottom: their line numbers (from the gutter) and their text. */
export async function visibleRows(win: Page): Promise<{ line: number; text: string }[]> {
  return win.evaluate(() => {
    const box = document.querySelector('.vl-scroller')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('.vl-row')]
      .map((el) => ({ el, top: el.getBoundingClientRect().top }))
      .filter(({ top }) => top >= box.top - 1 && top < box.bottom - 1)
      .sort((a, b) => a.top - b.top)
      .map(({ el }) => ({ line: Number(el.querySelector('.gutter')!.textContent), text: el.querySelector('.text')?.textContent ?? '' }))
  })
}
