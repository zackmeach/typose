import { BrowserWindow, MessageChannelMain, app, crashReporter, dialog, ipcMain, protocol, screen, session, utilityProcess } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import coreHostPath from '../core-host/index?modulePath'
import { startLifecycle } from './lifecycle'
import { delayHook, isMark, marksHook } from './marks'

const mainStart = Date.now() // plan C8's first startup mark: read now, written once the hook is set up below

// Plan C9: armed before anything else. Minidumps stay on this machine (spec §7.3).
crashReporter.start({ uploadToServer: false })
const log = startLifecycle()
// Plan C8's startup controls, compiled only into the test-hooks build: show() a set delay after both
// ready-to-show and the title bar's paint, or delay React's mount.
const showDelay = __TEST_HOOKS__ ? delayHook('TYPOSE_TEST_DELAY_SHOW', process.env.TYPOSE_TEST_DELAY_SHOW) : 0
const mountDelay = __TEST_HOOKS__ ? delayHook('TYPOSE_TEST_DELAY_MOUNT', process.env.TYPOSE_TEST_DELAY_MOUNT) : 0
// Plan C5's per-read delay, for the test-hooks addon: every chunk the core reads from disk waits this long first.
const readDelay = __TEST_HOOKS__ ? delayHook('TYPOSE_TEST_READ_DELAY', process.env.TYPOSE_TEST_READ_DELAY) : 0
let titlebarPainted: () => void = () => {}

// No proxy resolution at all: with Windows' "Automatically detect settings" on, Chromium otherwise runs WPAD
// (a DNS lookup for "wpad") at startup in every network context, though Typose requests nothing (spec §7.3).
app.commandLine.appendSwitch('no-proxy-server')

// Plan §5's read-only measurement hook. A refused path, or a write that fails, is logged and never stops startup.
const mark = marksHook(process.env.TYPOSE_MARKS, log)
mark?.('mainStart', { t: mainStart })

// TEMP diagnostics (to be reverted): AppKit's will-finish-launching, and Electron's own ready, which Playwright's loader
// holds back from the app until it has attached (the app's `ready` below is the one it lets through).
app.on('will-finish-launching', () => log('will-finish-launching'))
const emit = app.emit.bind(app)
app.emit = (event: string | symbol, ...args: unknown[]) => {
  if (event === 'ready') log('ready-native')
  return emit(event, ...args)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'typose', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } }
])

const ORIGIN = 'typose://app'
const ALLOWED = app.isPackaged ? /^(typose|data|blob):/ : /^(typose|data|blob|devtools):/
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}
// Spec §7.1, sent as a header on every app response rather than a meta tag. No inline script; inline style stays
// allowed, as in the spike, because React Aria injects a style element.
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** The file named on the command line: the last argument that isn't a switch (PR 8 normalizes the rest). */
function launchPath(): string | null {
  const plain = process.argv.slice(1).filter((a) => !a.startsWith('-'))
  const file = (process.defaultApp ? plain.slice(1) : plain).at(-1) // `electron <app> <file>` in development
  return file ? resolve(file) : null
}

function serveApp(): void {
  const rendererDir = join(__dirname, '../renderer')
  // Read with fs, not net.fetch: net.fetch(file:) would itself be cancelled by the network guard below.
  protocol.handle('typose', async (req) => {
    const file = join(rendererDir, decodeURIComponent(new URL(req.url).pathname))
    if (!file.startsWith(rendererDir + sep)) return new Response('bad path', { status: 400 })
    try {
      const body = await readFile(file)
      const type = MIME[extname(file)] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'content-type': type, 'content-security-policy': CSP } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !ALLOWED.test(details.url) })
  })
}

/** Plan C7: the core host is respawned at most once in this long. */
const RESPAWN_EVERY = 60_000
let sessions = 0
let respawned = -Infinity
let quitting = false
app.on('before-quit', () => (quitting = true))

/**
 * Spawns the core host as a new session (plan C7) and hands one end of a fresh channel to each side. When it dies,
 * the renderer is told (it fails every pending call with CoreGone), the session's port and listeners are torn
 * down, and a new session is spawned: at once, or, after a second death within 60 s, once 60 s have passed since
 * the last respawn. Until then the app shows the stopped state.
 */
function spawnCore(win: BrowserWindow, loaded: Promise<void>): void {
  const id = ++sessions
  const core = utilityProcess.fork(coreHostPath, [], { serviceName: 'typose-core' })
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage(__TEST_HOOKS__ ? { session: id, readDelay } : { session: id }, [port1])
  let exited = false
  void loaded.then(() => {
    if (!exited && !win.isDestroyed()) win.webContents.postMessage('core-port', { session: id }, [port2])
  })
  core.once('spawn', () => log('utility-spawn', { session: id, utilityPid: core.pid }))
  core.once('exit', (code) => {
    exited = true
    log('utility-exit', { session: id, code })
    port1.close()
    port2.close()
    core.removeAllListeners()
    if (quitting || win.isDestroyed()) return
    void loaded.then(() => {
      if (!win.isDestroyed()) win.webContents.send('core-gone', { session: id })
    })
    const wait = Math.max(0, respawned + RESPAWN_EVERY - performance.now()) // monotonic: a clock change can't shorten it
    if (wait > 0) log('core-stopped', { session: id, respawnInMs: wait })
    setTimeout(() => {
      if (quitting || win.isDestroyed()) return
      respawned = performance.now()
      spawnCore(win, loaded)
    }, wait)
  })
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#111113',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#111113', symbolColor: '#EDEDED', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => {
    mark?.('readyToShow')
    if (!showDelay) win.show()
  })
  win.on('show', () => {
    log('window-shown')
    // Plan C8: shellVisible is the title bar's first presentation after this; runs record the refresh rate. Under the
    // hook, the page is told, so it can find that presentation if the title bar was presented while hidden.
    if (!mark) return
    mark('show', { hz: screen.getDisplayMatching(win.getBounds()).displayFrequency })
    win.webContents.send('shown')
  })
  win.on('unresponsive', () => log('unresponsive'))
  win.on('responsive', () => log('responsive'))
  return win
}

const fromApp = (win: BrowserWindow, event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  event.sender === win.webContents && !!event.senderFrame?.url.startsWith(`${ORIGIN}/`)

/** Calls from the preload: only from this window's app page, and with no arguments (plan C4). */
function handle(win: BrowserWindow, channel: string, fn: () => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!fromApp(win, event) || args.length > 0) throw new Error(`refused ${channel}`)
    return fn()
  })
}

void app.whenReady().then(() => {
  log('ready') // TEMP diagnostics
  mark?.('ready')
  // Chromium's hunspell (Linux, and Windows for languages it lacks) loads its dictionaries even with spellcheck off,
  // and downloads a missing one through a loader the network guard never sees. Point those downloads at our own
  // scheme, where nothing serves them, before any window exists (spec §7.3).
  session.defaultSession.setSpellCheckerDictionaryDownloadURL(`${ORIGIN}/no-dictionaries/`)
  session.defaultSession.setSpellCheckerEnabled(false)
  serveApp()
  const win = createWindow()
  // The renderer's startup marks (plan C8): a known name and a whole-ms time, from this window's app page (C4).
  ipcMain.on('mark', (event, name: unknown, t: unknown) => {
    if (!fromApp(win, event) || !isMark(name, t)) return
    mark?.(name, { t })
    if (__TEST_HOOKS__ && name === 'titlebarPainted') titlebarPainted()
  })
  if (showDelay) {
    const painted = new Promise<void>((ok) => (titlebarPainted = ok))
    void Promise.all([once(win, 'ready-to-show'), painted]).then(() => setTimeout(() => win.show(), showDelay))
  }
  win.webContents.once('did-finish-load', () => log('did-finish-load')) // TEMP diagnostics
  const loaded = new Promise<void>((ok) => win.webContents.once('did-finish-load', () => ok()))
  spawnCore(win, loaded) // in parallel with the page load (spec §2.1)
  const initial = launchPath()
  handle(win, 'launch-path', () => initial)
  handle(win, 'open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  void win.loadURL(`${ORIGIN}/index.html${mountDelay ? `?delayMount=${mountDelay}` : ''}`)
})

app.on('window-all-closed', () => app.quit())
