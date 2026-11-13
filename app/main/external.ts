/** Main's trust boundary for the page: every IPC channel's sender check, and the one privileged link action, an allowed URL from that sender. */
interface Frame {
  readonly url: string
  /** "null" for an opaque origin: Chromium's error page in the app page's place keeps the app page's `url`. */
  readonly origin: string
}

export interface AppWindow {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    readonly mainFrame: Frame
  }
}

export interface Caller {
  readonly sender: unknown
  readonly senderFrame: Frame | null
}

/** Every IPC channel's sender check (plan C4): this live window's app page, typose://app/index.html at its own origin, in
 *  its main frame. */
export function fromMainApp(win: AppWindow, event: Caller): boolean {
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents) return false
    const frame = event.senderFrame
    if (!frame || frame !== win.webContents.mainFrame || frame.origin !== 'typose://app' || !frame.url.startsWith('typose://app/')) return false
    const page = new URL(frame.url)
    return page.protocol === 'typose:' && page.host === 'app' && !page.username && !page.password && page.pathname === '/index.html'
  } catch {
    return false // a frame that was destroyed before its properties could be read
  }
}

const MAX_URL = 32 << 10
// oxlint-disable-next-line no-control-regex -- URL control characters must be refused before invoking the OS.
const controls = /[\x00-\x1f\x7f-\x9f]/u
const fits = (url: string) => url.length <= MAX_URL && Buffer.byteLength(url, 'utf8') <= MAX_URL

function target(win: AppWindow, event: Caller, args: unknown[]): string | null {
  try {
    if (!fromMainApp(win, event) || args.length !== 1 || typeof args[0] !== 'string' || !fits(args[0]) || controls.test(args[0])) return null
    const url = new URL(args[0])
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
    return fits(url.href) ? url.href : null
  } catch {
    return null // a malformed URL
  }
}

/** Validation and dispatch stay together, with no asynchronous gap before invoking the OS handler. */
export async function openExternal(win: AppWindow, event: Caller, args: unknown[], open: (url: string) => Promise<void>): Promise<boolean> {
  const url = target(win, event, args)
  if (url === null) return false
  try {
    await open(url)
    return true
  } catch {
    return false
  }
}
