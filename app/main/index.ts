import { BrowserWindow, MessageChannelMain, app, crashReporter, dialog, ipcMain, protocol, session, utilityProcess } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import coreHostPath from '../core-host/index?modulePath'
import { startLifecycle } from './lifecycle'

// Plan C9: armed before anything else. Minidumps stay on this machine (spec §7.3).
crashReporter.start({ uploadToServer: false })
const log = startLifecycle()

// No proxy resolution at all: with Windows' "Automatically detect settings" on, Chromium otherwise runs WPAD
// (a DNS lookup for "wpad") at startup in every network context, though Typose requests nothing (spec §7.3).
app.commandLine.appendSwitch('no-proxy-server')

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

let sessions = 0

/** Spawns the core host as a new session (plan C7) and hands one end of a fresh channel to each side. */
function spawnCore(win: BrowserWindow, loaded: Promise<void>): void {
  const id = ++sessions
  const core = utilityProcess.fork(coreHostPath, [], { serviceName: 'typose-core' })
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage({ session: id }, [port1])
  void loaded.then(() => win.webContents.postMessage('core-port', { session: id }, [port2]))
  core.once('spawn', () => log('utility-spawn', { session: id, utilityPid: core.pid }))
  core.once('exit', (code) => {
    log('utility-exit', { session: id, code })
    // C7's rejection path: the renderer fails every pending call with CoreGone. Respawn arrives in PR 5.
    if (!win.isDestroyed()) win.webContents.send('core-gone', { session: id })
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
  win.once('ready-to-show', () => win.show())
  win.on('show', () => log('window-shown'))
  win.on('unresponsive', () => log('unresponsive'))
  win.on('responsive', () => log('responsive'))
  return win
}

/** Calls from the preload: only from this window's app page, and with no arguments (plan C4). */
function handle(win: BrowserWindow, channel: string, fn: () => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const fromApp = event.sender === win.webContents && event.senderFrame?.url.startsWith(`${ORIGIN}/`)
    if (!fromApp || args.length > 0) throw new Error(`refused ${channel}`)
    return fn()
  })
}

void app.whenReady().then(() => {
  // Chromium's hunspell (Linux, and Windows for languages it lacks) loads its dictionaries even with spellcheck off,
  // and downloads a missing one through a loader the network guard never sees. Point those downloads at our own
  // scheme, where nothing serves them, before any window exists (spec §7.3).
  session.defaultSession.setSpellCheckerDictionaryDownloadURL(`${ORIGIN}/no-dictionaries/`)
  session.defaultSession.setSpellCheckerEnabled(false)
  serveApp()
  const win = createWindow()
  const loaded = new Promise<void>((ok) => win.webContents.once('did-finish-load', () => ok()))
  spawnCore(win, loaded) // in parallel with the page load (spec §2.1)
  const initial = launchPath()
  handle(win, 'launch-path', () => initial)
  handle(win, 'open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  void win.loadURL(`${ORIGIN}/index.html`)
})

app.on('window-all-closed', () => app.quit())
