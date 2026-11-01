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

/** Observe intended OS handoffs without opening a real browser or mail client. The stub exists only in this test process. */
export async function stubExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { externalCalls: string[] }
    state.externalCalls = []
    shell.openExternal = async (url) => { state.externalCalls.push(url) }
  })
  return () => app.evaluate(() => (globalThis as unknown as { externalCalls: string[] }).externalCalls)
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

/** `hooks` launches the test-hooks build (`npm run build:hooks`, plan m8), with `env` added to the environment. */
export async function launch(opts: { file?: string | string[]; userData?: string; netlog?: string; hooks?: boolean; controlledAccessibility?: boolean; env?: Record<string, string> } = {}): Promise<Launched> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'typose-e2e-'))
  const args = [opts.hooks ? join(APP_DIR, 'out-hooks/main/index.js') : APP_DIR, `--user-data-dir=${userData}`]
  // Windows otherwise auto-enables accessibility after a document opens. The test explicitly switches both native modes.
  if (process.platform === 'win32' && opts.controlledAccessibility) args.push('--disable-renderer-accessibility')
  if (opts.netlog) args.push(`--log-net-log=${opts.netlog}`)
  if (opts.file) args.push(...(Array.isArray(opts.file) ? opts.file : [opts.file]))
  const app = await electron.launch({ args, ...(opts.env ? { env: { ...process.env, ...opts.env } as Record<string, string> } : {}) })
  const proc = app.process()
  const exited = new Promise<Exit>((ok) => {
    if (proc.exitCode !== null) ok({ code: proc.exitCode, signal: proc.signalCode })
    else proc.once('exit', (code, signal) => ok({ code, signal }))
  })
  const pid = await app.evaluate(() => process.pid)
  const win = await app.firstWindow().catch(async (e: unknown) => {
    // Killed, so it can't hold up the worker's teardown, as twice in main-macos run 40067408502; and its evidence kept.
    // Only while it runs: once it has exited, its pid may be another process's.
    if (proc.exitCode === null && proc.signalCode === null) kill(pid)
    keepEvidence(userData, pid, await exited, false)
    throw e
  })
  const pageErrors: string[] = []
  win.on('pageerror', (e) => pageErrors.push(e.message))
  const l = { app, win, userData, pid, exited, pageErrors }
  running.add(l)
  return l
}

/** Main's own pid, not the launched process's: on Windows, Playwright launches Electron through a shell. */
function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * Closes the app if it's still up, then keeps the run's evidence in the test's output directory: the exit status,
 * the lifecycle log and any crash dumps. Deletes the private profile unless `keep` (a relaunch reuses it). An app
 * that hasn't exited 15 s after its close, as one didn't in main-macos run 40070774628, is killed and fails the test.
 */
export async function finish(l: Launched, keep = false): Promise<Exit> {
  running.delete(l)
  const closing = l.app.close().catch(() => {})
  const closed = await Promise.race([l.exited, new Promise<null>((ok) => setTimeout(() => ok(null), 15_000))])
  const exit = closed ?? (kill(l.pid), await l.exited)
  await closing
  keepEvidence(l.userData, l.pid, exit, keep)
  if (!closed) throw new Error(`pid ${l.pid} didn't exit within 15 s of its close, and was killed`)
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

/**
 * Gives the window the OS's focus and waits until it and its page have it. Tests of keys a menu would take, or of
 * UIA's keyboard focus, need it to be able to fail (PR 7's review).
 */
export async function osFocus(l: Launched): Promise<void> {
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await expect
    .poll(() =>
      l.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        return w.isFocused() && w.webContents.isFocused()
      })
    )
    .toBe(true)
}

/** A key as the OS delivers it, through the page and then a menu's accelerators. Playwright's keyboard goes through
 *  CDP, which never reaches the accelerators. */
export const pressAsOS = (l: Launched, keyCode: string, modifiers: ('control' | 'meta' | 'shift')[]) =>
  l.app.evaluate(
    ({ BrowserWindow }, { keyCode, modifiers }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      for (const type of ['keyDown', 'char', 'keyUp'] as const)
        if (type !== 'char' || keyCode.length === 1) contents.sendInputEvent({ type, keyCode: type === 'char' ? keyCode.toLowerCase() : keyCode, modifiers })
    },
    { keyCode, modifiers }
  )

/**
 * Open file… without the OS dialog, which must never open on the desktop the tests run on: main's handler is replaced
 * by one that answers `path` and counts its calls (`globalThis.dialogCalls`), and the dialog itself rejects.
 */
export async function stubOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showOpenDialog = () => Promise.reject(new Error('the real dialog was reached'))
    ipcMain.removeHandler('open-dialog')
    ipcMain.handle('open-dialog', () => {
      ;(globalThis as { dialogCalls?: number }).dialogCalls = ((globalThis as { dialogCalls?: number }).dialogCalls ?? 0) + 1
      return path
    })
  }, path)
  await expect(app.evaluate(({ dialog }) => dialog.showOpenDialog({}))).rejects.toThrow('the real dialog was reached')
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
    /** The mounted Rendered lens, when one is. */
    rendered: (() => { units: number; htmlBytes: number; nodes: number; noteUnits: number; reserved: number; rawReserved: number; retiredReserved: number; totalReserved: number; blocks: number; appended: number }) | null
    /** The mounted Raw lens's cached items, when one is. */
    items: (() => { key: number | string; text: string }[]) | null
  }
  app: { close?: () => void; workspace: () => { held: number; peakBytes: number; settled: boolean } | null }
}

/** The mounted Raw lens's cached items, on the test-hooks build: whole pieces, which Z66 shows over rows (PR 6b). */
export const cachedItems = (win: Page): Promise<{ key: number | string; text: string }[]> =>
  win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.items?.() ?? [])

/** The core host's debug stats, on the test-hooks build (plan C5, C6). */
export const debugStats = (win: Page, params: { gc?: boolean; resetHigh?: boolean; limit?: number } = {}): Promise<DebugStats> =>
  win.evaluate((p) => (window as unknown as { typoseTest: TestHooks }).typoseTest.core.call('debugStats', p) as Promise<DebugStats>, params)

/** An empty window can retain history. Clear it, then distinguish the host's paid table capacities from leaked readers. */
export async function expectReleasedDocuments(win: Page): Promise<void> {
  const owner = [...running].find(run => run.win === win)
  if (!owner) throw new Error('Expected an owned Electron window')
  // Some probes initiate Close through a synchronous input hook. Wait until its history entry is published.
  await expect(win.locator('.file-tab')).toHaveCount(0)
  await owner.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'clear-closed'))
  await expect.poll(async () => {
    const stats = await debugStats(win, { gc: true })
    return { docs: stats.docs, jobs: stats.jobs, tasks: stats.tasks, handles: stats.handles, saved: stats.saved.tickets,
      views: stats.surfaces?.views, pending: stats.surfaces?.pending, workspace: stats.surfaces?.workspaceBytes,
      unaccounted: stats.ledger.used - stats.ledger.pool - stats.saved.hostBytes - (stats.surfaces?.hostBytes ?? 0) }
  }).toEqual({ docs: 0, jobs: 0, tasks: 0, handles: 0, saved: 0, views: 0, pending: 0, workspace: 0, unaccounted: 0 })
}

/** Non-lens cache charges: the renderer's bank and distinct native-host table capacities. */
export const workspaceHeld = async (win: Page): Promise<number> => {
  const held = await win.evaluate(() => {
    const bank = (window as unknown as { typoseTest: TestHooks }).typoseTest.app.workspace()
    if (!bank?.settled) throw new Error('workspace reservation is not settled')
    return bank.held
  })
  const stats = await debugStats(win)
  expect(stats.surfaces?.workspaceBytes).toBe(held)
  return held + stats.surfaces!.hostBytes + stats.saved.hostBytes
}

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
