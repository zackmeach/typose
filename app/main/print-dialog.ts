import type { WebContents } from 'electron'
import type { PrintDocumentResult } from '../shared/protocol'

/** Bounds a print that reports nothing. No afterprint fallback runs off Windows, and main admits one print at a time,
 * so a lost callback blocks printing until this. Five minutes outlasts choosing a printer, and the window outlives
 * it, so a late Print still prints. */
const SETTLE_CEILING = 5 * 60_000
/** Electron's callback waits for the spool, which can outlast afterprint, and closing the window cancels the job. Ten
 * minutes is a generous allowance for spooling the largest job (1,000 pages); a callback that never comes frees the
 * window this long after the IPC settles. */
const SPOOL_CEILING = 10 * 60_000

/** Resolves to `value` after `ms` unless `signal` aborts first. Global timers, so tests can fake them. */
function after<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
  return new Promise(resolve => {
    if (signal.aborted) return
    const timer = setTimeout(() => resolve(value), ms)
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })
}

/** `result` settles the IPC. `spooled` says when the print window may close, which can be long after `dialog-closed`. */
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
    complete, after<PrintDocumentResult>(SETTLE_CEILING, { kind: 'refused', reason: 'The OS print dialog did not complete' }, fallback.signal),
    ...(afterPrint ? [afterPrint.then(() => after<PrintDocumentResult>(500, { kind: 'dialog-closed' }, fallback.signal))] : [])
  ]).catch((): PrintDocumentResult => ({ kind: 'refused', reason: 'The OS print dialog did not complete' })).finally(() => fallback.abort())
  const spooled = Promise.race([complete, result.then(() => after(SPOOL_CEILING, undefined, spool.signal))]).catch(() => undefined).finally(() => spool.abort())
  return { result, spooled }
}
