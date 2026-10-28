/** The only privileged link action: an allowed URL from this window's current app main frame. */
interface Frame {
  readonly url: string
}

interface AppWindow {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    readonly mainFrame: Frame
  }
}

interface Caller {
  readonly sender: unknown
  readonly senderFrame: Frame | null
}

const MAX_URL = 32 << 10
const controls = /[\x00-\x1f\x7f-\x9f]/u
const fits = (url: string) => url.length <= MAX_URL && Buffer.byteLength(url, 'utf8') <= MAX_URL

function target(win: AppWindow, event: Caller, args: unknown[]): string | null {
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents) return null
    const frame = event.senderFrame
    if (!frame || frame !== win.webContents.mainFrame) return null
    const page = new URL(frame.url)
    if (page.protocol !== 'typose:' || page.host !== 'app' || page.username || page.password || page.pathname !== '/index.html') return null
    if (args.length !== 1 || typeof args[0] !== 'string' || !fits(args[0]) || controls.test(args[0])) return null
    const url = new URL(args[0])
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
    return fits(url.href) ? url.href : null
  } catch {
    return null // a malformed URL, or a frame that was destroyed before its properties could be read
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
