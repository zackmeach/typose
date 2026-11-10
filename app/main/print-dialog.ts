import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import type { PrintDocumentResult } from '../shared/protocol'

export async function printWithDialog(contents: Pick<WebContents, 'executeJavaScript' | 'print'>, pages: number, watchAfterPrint: boolean): Promise<PrintDocumentResult> {
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
  const fallback = new AbortController()
  try {
    // Windows can close the dialog without delivering Electron's callback. Chromium's
    // afterprint arrives once native print settings return. Give the callback first say.
    return await (afterPrint ? Promise.race([
      complete, afterPrint.then(() => delay<PrintDocumentResult>(500, { kind: 'dialog-closed' }, { signal: fallback.signal }))
    ]) : complete)
  } catch {
    return { kind: 'refused', reason: 'The OS print dialog did not complete' }
  } finally { fallback.abort() }
}
