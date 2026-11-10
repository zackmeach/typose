import type { WebContents } from 'electron'
import type { PrintDocumentResult } from '../shared/protocol'

/** Electron's callback waits for the spool, which can outlast afterprint, and closing the window cancels the job. Ten
 * minutes is a generous allowance for spooling the largest job (1,000 pages); a callback that never comes frees the
 * window this long after `dialog-closed`. */
const SPOOL_CEILING = 10 * 60_000
/** At most this many windows wait only on their spool after `dialog-closed`, each holding its laid-out document outside
 * the memory budget. Two, because with one the next job's `dialog-closed` would cut a spool that is still running. */
const SPOOL_WINDOWS = 2

/** Resolves to `value` after `ms` unless `signal` aborts first. Global timers, so tests can fake them. */
function after<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
  return new Promise(resolve => {
    if (signal.aborted) return
    const timer = setTimeout(() => resolve(value), ms)
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })
}

/** Tracks windows kept only for their spool after `dialog-closed`, closing the oldest past SPOOL_WINDOWS. */
export function spoolKeeper(): (close: () => void, spooled: Promise<unknown>) => void {
  const waiting: (() => void)[] = []
  return (close, spooled) => {
    waiting.push(close)
    if (waiting.length > SPOOL_WINDOWS) waiting.shift()!()
    void spooled.then(() => { if (waiting.includes(close)) waiting.splice(waiting.indexOf(close), 1) })
  }
}

/** `result` settles the IPC; while nothing reports back it stays pending, as the dialog may still be open. `spooled`
 * says when the print window may close, which can be long after `dialog-closed`. */
export async function printWithDialog(contents: Pick<WebContents, 'executeJavaScript' | 'print'>, pages: number, watchAfterPrint: boolean): Promise<{ result: Promise<PrintDocumentResult>; spooled: Promise<unknown> }> {
  let afterPrint: Promise<unknown> | undefined
  if (watchAfterPrint) {
    // Arm this after PDF preflight, which has its own print events.
    await contents.executeJavaScript(`void (globalThis.typoseAfterPrint = new Promise(resolve => {
      addEventListener('afterprint', () => resolve(true), { once: true });
    }))`)
    afterPrint = contents.executeJavaScript('globalThis.typoseAfterPrint')
  }

  const complete = new Promise<PrintDocumentResult>(resolve => {
    contents.print({ silent: false, printBackground: true, pageSize: 'Letter', margins: { marginType: 'none' } }, (success, failure) => {
      if (success) resolve({ kind: 'printed', pages })
      else if (!failure || failure === 'Print job canceled') resolve({ kind: 'cancelled' })
      else resolve({ kind: 'refused', reason: failure })
    })
  })
  const fallback = new AbortController(), spool = new AbortController()
  // Windows can close the dialog without delivering Electron's callback. Chromium's
  // afterprint arrives once native print settings return. Give the callback first say.
  const result = Promise.race([
    complete, ...(afterPrint ? [afterPrint.then(() => after<PrintDocumentResult>(500, { kind: 'dialog-closed' }, fallback.signal))] : [])
  ]).catch((): PrintDocumentResult => ({ kind: 'refused', reason: 'The OS print dialog did not complete' })).finally(() => fallback.abort())
  const spooled = Promise.race([complete, result.then(settled => settled.kind === 'dialog-closed' ? after(SPOOL_CEILING, undefined, spool.signal) : undefined)])
    .catch(() => undefined).finally(() => spool.abort())
  return { result, spooled }
}
