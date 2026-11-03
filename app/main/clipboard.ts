/** The only clipboard operation exposed to the renderer: bounded plain-text writes. */
import { MAX_CLIPBOARD_BYTES } from '../shared/protocol'
import { fromMainApp, type AppWindow, type Caller } from './external'

function payload(win: AppWindow, event: Caller, args: unknown[]): string | null {
  if (!fromMainApp(win, event) || args.length !== 1 || typeof args[0] !== 'string') return null
  const text = args[0]
  // UTF-16 units are a cheap lower bound on UTF-8 bytes; reject before measuring an unbounded string.
  if (text.length > MAX_CLIPBOARD_BYTES || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) return null
  return text
}

/** Validate the app main-frame caller and complete bounded write synchronously, with no read surface. */
export async function writeClipboardText(win: AppWindow, event: Caller, args: unknown[], write: (text: string) => Promise<void> | void): Promise<boolean> {
  const text = payload(win, event, args)
  if (text === null) return false
  try {
    await write(text)
    return true
  } catch {
    return false
  }
}
