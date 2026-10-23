// Launching the dev-layout app for e2e (plan §5: `_electron.launch` is for the dev layout only). Every launch gets
// a private --user-data-dir, so runs never share the app profile, and records the main process's externally
// observed exit status. `finish` keeps each run's lifecycle log, exit status and any new dumps (plan C9); a test
// that fails before calling it gets the same from the `test` exported here.
import { type ElectronApplication, type Page, test as base, _electron as electron, expect } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

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

/** Playwright's `test`, plus: every launch a test leaves open is finished when it ends, pass or fail. */
export const test = base.extend<{ finishLaunches: void }>({
  finishLaunches: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this pattern
    async ({}, use) => {
      await use()
      for (const l of running) await finish(l)
    },
    { auto: true }
  ]
})

export async function launch(opts: { file?: string; userData?: string; netlog?: string } = {}): Promise<Launched> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'typose-e2e-'))
  const args = [APP_DIR, `--user-data-dir=${userData}`]
  if (opts.netlog) args.push(`--log-net-log=${opts.netlog}`)
  if (opts.file) args.push(opts.file)
  const app = await electron.launch({ args })
  const proc = app.process()
  const exited = new Promise<Exit>((ok) => {
    if (proc.exitCode !== null) ok({ code: proc.exitCode, signal: proc.signalCode })
    else proc.once('exit', (code, signal) => ok({ code, signal }))
  })
  const pid = await app.evaluate(() => process.pid)
  const win = await app.firstWindow()
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
  const out = base.info().outputPath()
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `exit-${l.pid}.json`), JSON.stringify(exit)) // one test may launch twice
  for (const name of ['lifecycle.jsonl', 'lifecycle.1.jsonl']) {
    const log = join(l.userData, 'logs', name)
    if (existsSync(log)) copyFileSync(log, join(out, `${l.pid}-${name}`))
  }
  for (const dump of dumps(l.userData)) copyFileSync(dump, join(out, basename(dump)))
  if (!keep) rmSync(l.userData, { recursive: true, force: true })
  return exit
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

export function fixture(name: string, bytes: string | Uint8Array): string {
  mkdirSync(FIXTURES, { recursive: true })
  const path = join(FIXTURES, name)
  writeFileSync(path, bytes)
  return path
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
