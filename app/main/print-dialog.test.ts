import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { printWithDialog } from './print-dialog'

function nativePrint() {
  let closeDialog!: () => void
  const afterPrint = new Promise<void>(resolve => { closeDialog = resolve })
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>()
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(afterPrint)
  const print = vi.fn<WebContents['print']>()
  return { contents: { executeJavaScript, print }, closeDialog }
}

it('settles when afterprint fires without an Electron callback', async () => {
  const { contents, closeDialog } = nativePrint()
  const result = printWithDialog(contents, 3, true)
  await Promise.resolve()
  expect(contents.print).toHaveBeenCalledOnce()
  closeDialog()
  await expect(result).resolves.toEqual({ kind: 'dialog-closed' })
})

it.each([
  [true, '', { kind: 'printed', pages: 3 }],
  [false, 'Print job canceled', { kind: 'cancelled' }],
  [false, 'Print job failed', { kind: 'refused', reason: 'Print job failed' }]
] as const)('preserves the Electron callback result (%s, %s)', async (success, failure, expected) => {
  const { contents, closeDialog } = nativePrint()
  const result = printWithDialog(contents, 3, true)
  await Promise.resolve()
  closeDialog()
  const callback = contents.print.mock.calls[0][1]!
  callback(success, failure)
  await expect(result).resolves.toEqual(expected)
})
