import { BrowserWindow, Menu, MessageChannelMain, app, crashReporter, dialog, ipcMain, protocol, screen, session, systemPreferences, utilityProcess } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import coreHostPath from '../core-host/index?modulePath'
import type { Command } from '../shared/protocol'
import { handoff, launchPath } from './launch'
import { startLifecycle } from './lifecycle'
import { envWhole, isMark, marksHook } from './marks'

const mainStart = Date.now() // plan C8's first startup mark: read now, written once the hook is set up below

// Plan C9: armed before anything else. Minidumps stay on this machine (spec §7.3).
crashReporter.start({ uploadToServer: false })
// Spec §8.1: one instance per profile. A second launch hands the first its own argv and cwd (the event's `argv` is
// Chromium's re-parse: switches moved first, whitespace trimmed) and exits 0 here, before it logs or writes a
// `running` marker (C9). Before the message loop, app.exit ends the process at once; app.quit would still emit ready.
if (!app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() })) app.exit(0)
const log = startLifecycle()
// Plan C8's startup controls, compiled only into the test-hooks build: show() a set delay after both
// ready-to-show and the title bar's paint, or delay React's mount.
const showDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_DELAY_SHOW', process.env.TYPOSE_TEST_DELAY_SHOW, 'ms') : 0
const mountDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_DELAY_MOUNT', process.env.TYPOSE_TEST_DELAY_MOUNT, 'ms') : 0
// Plan C5's per-read delay, for the test-hooks addon: every chunk the core reads from disk waits this long first.
const readDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_READ_DELAY', process.env.TYPOSE_TEST_READ_DELAY, 'ms') : 0
// Plan C1's budget override, for the test-hooks addon: the ledger's limit in bytes, in place of a quarter of RAM.
const budget = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_BUDGET', process.env.TYPOSE_TEST_BUDGET, 'bytes') : 0
let titlebarPainted: () => void = () => {}

// No proxy resolution at all: with Windows' "Automatically detect settings" on, Chromium otherwise runs WPAD
// (a DNS lookup for "wpad") at startup in every network context, though Typose requests nothing (spec §7.3).
app.commandLine.appendSwitch('no-proxy-server')

// macOS: no window restoration. Typose restores no window through AppKit, yet after a crash AppKit asks at the next
// launch whether to reopen its windows, in a modal that holds the launch short of ready until someone answers it: on
// CI, for good (main-macos runs 40067408502 and 40072658390, after lifecycle.e2e.ts's deliberate crash). It's set
// before the run loop starts: AppKit restores windows, and asks, from inside it.
if (process.platform === 'darwin') systemPreferences.registerDefaults({ ApplePersistenceIgnoreState: true })

// Plan §5's read-only measurement hook. A refused path, or a write that fails, is logged and never stops startup.
const mark = marksHook(process.env.TYPOSE_MARKS, log)
mark?.('mainStart', { t: mainStart })

protocol.registerSchemesAsPrivileged([
  { scheme: 'typose', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } }
])

const ORIGIN = 'typose://app'
const ALLOWED = app.isPackaged ? /^(typose|data|blob):/ : /^(typose|data|blob|devtools):/
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css'
}
// Spec §7.1, sent as a header on every app response rather than a meta tag. No inline script; inline style stays
// allowed, as in the spike, because React Aria injects a style element.
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** The newest file named: by this launch, a second one, or macOS's open-file. M1's one card shows it. */
let newest = launchPath(process.argv, process.cwd(), !!process.defaultApp)
/** Until the page asks for its first file, a newer one replaces it; after, main sends each to the page. */
let deliver = (path: string) => void (newest = path)
// macOS names files through open-file, not argv: before ready for the file a launch opens, and after.
app.on('open-file', (event, path) => {
  event.preventDefault()
  deliver(path)
})

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
  core.postMessage(__TEST_HOOKS__ ? { session: id, readDelay, budget } : { session: id }, [port1])
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

/** Brief §3.1's bar, in logical px. macOS centres its traffic lights in it: AppKit's are 14 px tall (spike A's 13). */
const TITLE_BAR = 40
const TRAFFIC_LIGHTS = { x: 14, y: (TITLE_BAR - 14) / 2 }

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720, // brief §9's minimum window
    minHeight: 480,
    show: false,
    backgroundColor: '#111113',
    // Spec §9: on Windows the native caption buttons overlay the bar (WCO, whose maximize button gives Snap Layouts);
    // macOS insets its traffic lights; Linux keeps the native frame, best effort (Z28).
    titleBarStyle: isLinux ? 'default' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: TRAFFIC_LIGHTS }
      : isLinux
        ? {}
        : { titleBarOverlay: { color: '#111113', symbolColor: '#EDEDED', height: TITLE_BAR } }),
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
  // Not once a quit has begun: the window would only flash up as it closes.
  win.once('ready-to-show', () => {
    mark?.('readyToShow')
    if (!showDelay && !quitting) win.show()
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
  // A closed window keeps no listeners. On macOS, one shown just before its quit can get its visibility event after
  // it's destroyed, and Electron's own visibility listener then throws on it, so the app never exits (main-macos runs
  // 40070774628 and 40072219356).
  win.once('closed', () => win.removeAllListeners())
  return win
}

/**
 * macOS's native menu (spec §9): ☰'s commands, which the page runs as ☰'s do, with Close Window (Cmd+W, brief §7.2),
 * and the app, Edit and Window menus of every Mac app (Edit's Copy and Select All are how Cmd+C and Cmd+A reach the
 * page). The page keeps Cmd+R (PR 4), so Reload has no accelerator here.
 */
function macMenu(win: BrowserWindow): Menu {
  const run = (command: Command) => () => win.isDestroyed() || win.webContents.send('command', command)
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [{ label: 'Open File…', click: run('open') }, { label: 'Reload', click: run('reload') }, { role: 'close' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ])
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
  log('ready') // with did-finish-load below, how far a launch whose window never came got (plan C9)
  mark?.('ready')
  // Chromium's hunspell (Linux, and Windows for languages it lacks) loads its dictionaries even with spellcheck off,
  // and downloads a missing one through a loader the network guard never sees. Point those downloads at our own
  // scheme, where nothing serves them, before any window exists (spec §7.3).
  session.defaultSession.setSpellCheckerDictionaryDownloadURL(`${ORIGIN}/no-dictionaries/`)
  session.defaultSession.setSpellCheckerEnabled(false)
  serveApp()
  const win = createWindow()
  // Electron's default menu goes (PR 4's residual): its accelerators, Force Reload's Ctrl+Shift+R among them, were live
  // even with its bar hidden. ☰ is the menu on Windows and Linux; macOS gets a minimal native one (spec §9).
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu(win) : null)
  // Spec §6.2's accessibility mode: Electron's accessibility support, at each load and on every change. Electron has it
  // on macOS and Windows only, where Z28 gates accessibility.
  if (process.platform !== 'linux') {
    const sendA11y = () => win.isDestroyed() || win.webContents.send('a11y', app.isAccessibilitySupportEnabled())
    win.webContents.on('did-finish-load', sendA11y)
    app.on('accessibility-support-changed', sendA11y)
  }
  // The renderer's startup marks (plan C8): a known name and a whole-ms time, from this window's app page (C4).
  ipcMain.on('mark', (event, name: unknown, t: unknown) => {
    if (!fromApp(win, event) || !isMark(name, t)) return
    mark?.(name, { t })
    if (__TEST_HOOKS__ && name === 'titlebarPainted') titlebarPainted()
  })
  if (showDelay) {
    const painted = new Promise<void>((ok) => (titlebarPainted = ok))
    void Promise.all([once(win, 'ready-to-show'), painted]).then(() => setTimeout(() => quitting || win.show(), showDelay))
  }
  const loaded = new Promise<void>((ok) =>
    win.webContents.once('did-finish-load', () => {
      log('did-finish-load')
      ok()
    })
  )
  spawnCore(win, loaded) // in parallel with the page load (spec §2.1)
  // Emitted only after ready. What a second instance sends is untrusted: anything of another shape or size names nothing.
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    if (quitting || win.isDestroyed()) return // a hand-off during a quit opens nothing and shows no window
    const sent = handoff(data)
    const path = sent && launchPath(sent.argv, sent.cwd, !!process.defaultApp)
    if (path) deliver(path)
    if (win.isMinimized()) win.restore()
    if (win.isVisible()) win.focus() // focus() would show a window that isn't shown yet, ahead of plan C8's show
  })
  handle(win, 'launch-path', () => {
    deliver = (path) => {
      newest = path
      if (!win.isDestroyed()) win.webContents.send('open-path', path)
    }
    return newest
  })
  handle(win, 'open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  void win.loadURL(`${ORIGIN}/index.html${mountDelay ? `?delayMount=${mountDelay}` : ''}`)
})

app.on('window-all-closed', () => app.quit())
