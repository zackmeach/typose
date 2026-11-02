import { BrowserWindow, Menu, MessageChannelMain, app, clipboard, crashReporter, dialog, ipcMain, protocol, screen, session, shell, systemPreferences, utilityProcess } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { once } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import coreHostPath from '../core-host/index?modulePath'
import { MAX_PRINT_PAGES, type Command, type PrintDocumentResult } from '../shared/protocol'
import { openExternal } from './external'
import { writeClipboardText } from './clipboard'
import { handoff, launchPaths } from './launch'
import { gestures, handOff, type HandoffAction } from './handoff'
import { startLifecycle } from './lifecycle'
import { envWhole, isMark, marksHook } from './marks'
import { SessionStore } from './session-store'
import { MAX_PRINT_PDF_BYTES, physicalPageCount, validatePrintDocument } from './print-validation'

const mainStart = Date.now() // plan C8's first startup mark: read now, written once the hook is set up below

// Plan C9: armed before anything else. Minidumps stay on this machine (spec §7.3).
crashReporter.start({ uploadToServer: false })
// Spec §8.1: one instance per profile. A second launch hands the first its own argv and cwd (the event's `argv` is
// Chromium's re-parse: switches moved first, whitespace trimmed) and exits 0 here, before it logs or writes a
// `running` marker (C9). Before the message loop, app.exit ends the process at once; app.quit would still emit ready.
if (!app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() })) app.exit(0)
const log = startLifecycle()
const sessionStore = new SessionStore(join(app.getPath('userData'), 'session.json'))
app.on('before-quit', () => { sessionStore.flush() })
// Plan C8's startup controls, compiled only into the test-hooks build: show() a set delay after both
// ready-to-show and the title bar's paint, or delay React's mount.
const showDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_DELAY_SHOW', process.env.TYPOSE_TEST_DELAY_SHOW, 'ms') : 0
const mountDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_DELAY_MOUNT', process.env.TYPOSE_TEST_DELAY_MOUNT, 'ms') : 0
const fontDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_DELAY_FONTS', process.env.TYPOSE_TEST_DELAY_FONTS, 'ms') : 0
// Plan C5's per-read delay, for the test-hooks addon: every chunk the core reads from disk waits this long first.
const readDelay = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_READ_DELAY', process.env.TYPOSE_TEST_READ_DELAY, 'ms') : 0
// Plan C1's budget override, for the test-hooks addon: the ledger's limit in bytes, in place of a quarter of RAM.
const budget = __TEST_HOOKS__ ? envWhole('TYPOSE_TEST_BUDGET', process.env.TYPOSE_TEST_BUDGET, 'bytes') : 0
let titlebarPainted: () => void = () => {}

// No proxy resolution at all: with Windows' "Automatically detect settings" on, Chromium otherwise runs WPAD
// (a DNS lookup for "wpad") at startup in every network context, though Typose requests nothing (spec §7.3).
app.commandLine.appendSwitch('no-proxy-server')
// A renderer's `<link rel=dns-prefetch>` bypasses webRequest and CSP (spec §7.3). Blink's setting suppresses that
// speculative DNS before any window exists. Electron 44.9.2's Preconnect path emits a session event without opening
// a socket; Typose installs no handler. The test-hooks build can withhold the DNS setting to prove the NetLog gate.
const speculative = __TEST_HOOKS__ && process.env.TYPOSE_TEST_ALLOW_SPECULATIVE === '1'
if (!speculative) app.commandLine.appendSwitch('blink-settings', 'dnsPrefetchingEnabled=false')

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

/** Files queued before the page asks for them; subsequent opens are delivered individually. */
let pendingPaths = launchPaths(process.argv, process.cwd(), !!process.defaultApp)
/** Z79: every path main hands the page, which a hand-off may name as it is. */
const granted = new Set(pendingPaths)
let newest = pendingPaths.at(-1) ?? null
let deliver = (path: string) => { granted.add(path); newest = path; pendingPaths.push(path) }
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
const coreStopped = () => Promise.reject(new Error("Typose's core isn't running"))
/** Z79: asks the live core host for the path of something it holds (dispatch.ts's `handoffPath`). */
let askCore: (subject: unknown) => Promise<string> = coreStopped

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
  const asks = new Map<number, { ok(path: string): void; fail(e: Error): void }>()
  let nextAsk = 0
  core.on('message', (reply: { handoff?: unknown; path?: unknown; error?: unknown } | null) => {
    const ask = typeof reply?.handoff === 'number' ? asks.get(reply.handoff) : undefined
    if (!ask) return
    asks.delete(reply!.handoff as number)
    if (typeof reply!.path === 'string') ask.ok(reply!.path)
    else ask.fail(new Error(typeof reply!.error === 'string' ? reply!.error : 'refused'))
  })
  const ask = (subject: unknown) => new Promise<string>((ok, fail) => {
    const n = ++nextAsk
    asks.set(n, { ok, fail })
    core.postMessage({ handoff: n, subject })
  })
  askCore = ask
  core.once('spawn', () => log('utility-spawn', { session: id, utilityPid: core.pid }))
  core.once('exit', (code) => {
    exited = true
    if (askCore === ask) askCore = coreStopped
    for (const pending of asks.values()) pending.fail(new Error("Typose's core stopped"))
    asks.clear()
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
  const saved = sessionStore.snapshot().window
  const reachable = saved?.x !== undefined && saved.y !== undefined && screen.getAllDisplays().some(display =>
    saved.x! + saved.width > display.workArea.x && saved.x! < display.workArea.x + display.workArea.width &&
    saved.y! + saved.height > display.workArea.y && saved.y! < display.workArea.y + display.workArea.height)
  const win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    ...(reachable ? { x: saved!.x, y: saved!.y } : {}),
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
  // View zoom belongs to this window rather than every page with the app's origin.
  win.webContents.setZoomMode('isolated')
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
 * macOS's native menu (spec §9): ☰'s commands, with Cmd+W closing a tab (or the empty window, brief §7.2),
 * and the app, Edit and Window menus of every Mac app (Edit's Copy and Select All are how Cmd+C and Cmd+A reach the
 * page). The page keeps Cmd+R (PR 4), so Reload has no accelerator here.
 */
function macMenu(win: BrowserWindow): Menu {
  const run = (command: Command) => () => win.isDestroyed() || win.webContents.send('command', command)
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Open File…', click: run('open') },
      { label: 'Open Folder…', click: run('open-folder') },
      { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: run('toggle-sidebar') },
      { label: 'Split Right', accelerator: 'Cmd+\\', click: run('split-right') },
      { label: 'Move Tab Right', click: run('move-tab-right') },
      { label: 'Close Card', click: run('close-card') },
      { label: 'Reload', click: run('reload') },
      { label: 'Find in File…', accelerator: 'Cmd+F', click: run('find') },
      { label: 'Next Match', accelerator: 'F3', click: run('find-next') },
      { label: 'Previous Match', accelerator: 'Shift+F3', click: run('find-previous') },
      { label: 'Close Tab', accelerator: 'Cmd+W', click: run('close-tab') },
      { label: 'Reopen Closed Tab', accelerator: 'Cmd+Shift+T', click: run('reopen-tab') },
      { label: 'Clear Recently Closed Tabs', click: run('clear-closed') },
      { role: 'close', accelerator: 'Shift+Cmd+W' }
    ] },
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
  if (sessionStore.snapshot().window?.maximized) win.maximize()
  const rememberBounds = () => { if (!win.isDestroyed()) sessionStore.bounds({ ...win.getNormalBounds(), maximized: win.isMaximized() }) }
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)
  const fromMainApp = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    try {
      const url = new URL(event.senderFrame!.url)
      return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && url.protocol === 'typose:' && url.host === 'app' && url.pathname === '/index.html'
    } catch { return false }
  }
  ipcMain.handle('load-session', (event, ...args: unknown[]) => {
    if (!fromMainApp(event) || args.length) throw new Error('refused load-session')
    const workspace = sessionStore.snapshot()
    delete workspace.window
    return workspace
  })
  ipcMain.handle('save-session', (event, ...args: unknown[]) => {
    if (!fromMainApp(event) || args.length !== 1) return false
    return sessionStore.update(args[0])
  })
  let closeRequest = 0, allowClose = false, finishClose: (() => void) | undefined
  ipcMain.on('session-captured', (event, request: unknown) => {
    if (fromMainApp(event) && request === closeRequest) finishClose?.()
  })
  win.on('close', event => {
    rememberBounds()
    if (allowClose || win.webContents.isDestroyed() || win.webContents.isLoadingMainFrame()) { sessionStore.flush(); return }
    event.preventDefault()
    if (finishClose) return
    const request = ++closeRequest
    const timeout = setTimeout(() => finishClose?.(), 1000)
    finishClose = () => {
      clearTimeout(timeout)
      finishClose = undefined
      sessionStore.flush()
      allowClose = true
      win.close()
    }
    win.webContents.send('capture-session', request)
  })
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
    if (sent) for (const path of launchPaths(sent.argv, sent.cwd, !!process.defaultApp)) deliver(path)
    if (win.isMinimized()) win.restore()
    if (win.isVisible()) win.focus() // focus() would show a window that isn't shown yet, ahead of plan C8's show
  })
  const liveDelivery = () => {
    deliver = (path) => {
      newest = path
      if (!win.isDestroyed()) win.webContents.send('open-path', path)
    }
  }
  handle(win, 'launch-paths', () => {
    liveDelivery()
    const paths = pendingPaths
    pendingPaths = []
    return paths
  })
  handle(win, 'launch-path', () => {
    liveDelivery()
    pendingPaths = []
    return newest
  })
  handle(win, 'open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    const chosen = r.canceled ? null : (r.filePaths[0] ?? null)
    if (chosen) granted.add(chosen)
    return chosen
  })
  handle(win, 'folder-dialog', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('open-external', (event: IpcMainInvokeEvent, ...args: unknown[]) => openExternal(win, event, args, (url) => shell.openExternal(url)))
  // Z79. The test-hooks build never reaches the real shell: under TYPOSE_TEST_SHELL=record it records the call for e2e
  // (`globalThis.typoseShellCalls`), and otherwise refuses.
  const shellCalls: { action: HandoffAction; path: string }[] = []
  const recordShell = __TEST_HOOKS__ && process.env.TYPOSE_TEST_SHELL === 'record'
  if (recordShell) (globalThis as { typoseShellCalls?: typeof shellCalls }).typoseShellCalls = shellCalls
  const viaShell = <T>(action: HandoffAction, path: string, real: () => T, recorded: T): T => {
    if (!__TEST_HOOKS__) return real()
    if (!recordShell) throw new Error('Hand-offs are off in the test-hooks build unless TYPOSE_TEST_SHELL=record')
    shellCalls.push({ action, path })
    return recorded
  }
  const gesture = gestures()
  ipcMain.on('handoff-gesture', (event, token: unknown) => { if (fromMainApp(event)) gesture.arm(token) })
  for (const [channel, action] of [['show-in-folder', 'show'], ['open-with-default', 'open']] as const)
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => fromMainApp(event)
      ? handOff(action, args, {
        takeGesture: token => gesture.take(token),
        granted, resolve: subject => askCore(subject), platform: process.platform, pathext: process.env.PATHEXT ?? '',
        isDirectory: async path => (await stat(path)).isDirectory(),
        show: path => viaShell('show', path, () => shell.showItemInFolder(path), undefined),
        open: path => viaShell('open', path, () => shell.openPath(path), Promise.resolve(''))
      })
      : { ok: false, reason: 'refused' })
  ipcMain.handle('write-clipboard', (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    writeClipboardText(win, event, args, (text) => clipboard.writeText(text)))
  ipcMain.handle('print-document', async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!fromMainApp(event) || args.length !== 4) return { kind: 'refused', reason: 'Invalid print request' } satisfies PrintDocumentResult
    const [title, blocks, pages, confirmed] = args
    const checked = validatePrintDocument(title, blocks, pages)
    if (!checked.ok) return { kind: 'refused', reason: checked.reason } satisfies PrintDocumentResult
    if (typeof confirmed !== 'boolean') return { kind: 'refused', reason: 'Invalid print confirmation' } satisfies PrintDocumentResult
    const target = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      parent: win,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
    })
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    target.webContents.on('will-navigate', e => e.preventDefault())
    try {
      await target.loadURL('about:blank')
      const title64 = Buffer.from(checked.title, 'utf8').toString('base64')
      const blocks64 = Buffer.from(checked.json, 'utf8').toString('base64')
      const install = `(() => {
        const decode = value => new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
        const blocks = JSON.parse(decode('${blocks64}'));
        document.title = decode('${title64}');
        const policy = document.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; base-uri 'none'"; document.head.append(policy);
        const style = document.createElement('style');
        style.textContent = '@page { size: Letter; margin: 16mm } body { box-sizing: border-box; width: 7.2in; margin: 0; color: #111; background: #fff; font: 10pt Arial, sans-serif } h1 { font: 600 15pt Arial, sans-serif; margin: 0 0 12pt } pre, code { font-family: Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere } pre { margin: 0 } table { border-collapse: collapse; width: 100% } th, td { border: 1px solid #888; padding: 3pt 5pt; text-align: left; vertical-align: top } thead { display: table-header-group } tr, pre, blockquote { break-inside: avoid } img { max-width: 100%; max-height: 8in; object-fit: contain }';
        document.head.append(style);
        const heading = document.createElement('h1'); heading.textContent = decode('${title64}'); document.body.append(heading);
        const make = node => {
          if (Object.hasOwn(node, 'text')) return document.createTextNode(node.text);
          if (node.tag === 'img') { const image = document.createElement('img'); image.src = node.src; image.alt = node.alt || ''; return image; }
          const tag = node.tag === 'a' ? 'span' : node.tag; const element = document.createElement(tag);
          for (const child of node.children || []) element.append(make(child)); return element;
        };
        for (const block of blocks) document.body.append(make(block));
      })()`
      await target.webContents.executeJavaScript(install, true)
      const layoutPages = await target.webContents.executeJavaScript(`(() => {
        const pageHeight = 9.74 * 96;
        const imageAllowance = document.images.length * 8 * 96;
        return Math.ceil((document.body.scrollHeight + imageAllowance) / pageHeight * 1.25);
      })()`)
      if (!Number.isSafeInteger(layoutPages) || layoutPages < 1 || layoutPages > MAX_PRINT_PAGES)
        return { kind: 'refused', reason: `Print layout exceeds the ${MAX_PRINT_PAGES.toLocaleString()}-page physical layout bound` } satisfies PrintDocumentResult
      const pdf = await target.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'Letter' })
      if (pdf.byteLength > MAX_PRINT_PDF_BYTES) return { kind: 'refused', reason: 'Print preflight exceeded its 128 MiB memory bound' } satisfies PrintDocumentResult
      const physicalPages = physicalPageCount(pdf)
      if (physicalPages === null) return { kind: 'refused', reason: 'Could not verify the physical page count; nothing was sent to the printer' } satisfies PrintDocumentResult
      if (physicalPages > MAX_PRINT_PAGES) return { kind: 'refused', reason: `Print job has ${physicalPages.toLocaleString()} physical pages; the limit is ${MAX_PRINT_PAGES.toLocaleString()}` } satisfies PrintDocumentResult
      if (__TEST_HOOKS__ && process.env.TYPOSE_TEST_PRINT === '1') return { kind: 'printed', pages: physicalPages } satisfies PrintDocumentResult
      if (physicalPages > 50 && !confirmed) {
        const answer = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Print', 'Cancel'], defaultId: 0, cancelId: 1,
          message: `Print ${physicalPages.toLocaleString()} pages?`, detail: 'Large print jobs can take a long time.' })
        if (answer.response !== 0) return { kind: 'cancelled' } satisfies PrintDocumentResult
      }
      return await new Promise<PrintDocumentResult>(resolve => {
        try {
          target.webContents.print({ silent: false, printBackground: true, pageSize: 'Letter', margins: { marginType: 'none' } }, success => {
            if (!target.isDestroyed()) target.close()
            resolve(success ? { kind: 'printed', pages: physicalPages } : { kind: 'cancelled' })
          })
        } catch {
          if (!target.isDestroyed()) target.close()
          resolve({ kind: 'refused', reason: 'The OS print dialog could not be opened' })
        }
      })
    } catch {
      if (!target.isDestroyed()) target.close()
      return { kind: 'refused', reason: 'The print document could not be prepared' } satisfies PrintDocumentResult
    } finally {
      if (!target.isDestroyed()) target.close()
    }
  })
  const startupQuery = new URLSearchParams()
  if (mountDelay) startupQuery.set('delayMount', String(mountDelay))
  if (fontDelay) startupQuery.set('delayFonts', String(fontDelay))
  void win.loadURL(`${ORIGIN}/index.html${startupQuery.size ? `?${startupQuery}` : ''}`)
})

app.on('window-all-closed', () => app.quit())
