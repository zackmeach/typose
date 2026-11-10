import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { printWithDialog } from './print-dialog'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function nativePrint() {
  let closeDialog!: () => void
  const afterPrint = new Promise<void>(resolve => { closeDialog = resolve })
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>()
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(afterPrint)
  const print = vi.fn<WebContents['print']>()
  return { contents: { executeJavaScript, print }, closeDialog }
}

/** What `promise` has settled to so far; read it after advancing the fake clock, which also drains microtasks. */
function watch(promise: Promise<unknown>) {
  const seen: { settled: boolean; value?: unknown } = { settled: false }
  void promise.then(value => { seen.settled = true; seen.value = value })
  return seen
}

it('settles 500 ms after afterprint fires without an Electron callback', async () => {
  const { contents, closeDialog } = nativePrint()
  const { result } = await printWithDialog(contents, 3, true)
  expect(contents.print).toHaveBeenCalledOnce()
  const settled = watch(result)
  closeDialog()
  await vi.advanceTimersByTimeAsync(499)
  expect(settled.settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled.value).toEqual({ kind: 'dialog-closed' })
})

it.each([
  [true, '', { kind: 'printed', pages: 3 }],
  [false, 'Print job canceled', { kind: 'cancelled' }],
  [false, 'Print job failed', { kind: 'refused', reason: 'Print job failed' }]
] as const)('preserves the Electron callback result (%s, %s)', async (success, failure, expected) => {
  const { contents, closeDialog } = nativePrint()
  const { result } = await printWithDialog(contents, 3, true)
  closeDialog()
  const callback = contents.print.mock.calls[0][1]!
  callback(success, failure)
  await expect(result).resolves.toEqual(expected)
})

it('lets an Electron callback that lands inside the grace after afterprint decide the result', async () => {
  const { contents, closeDialog } = nativePrint()
  const { result } = await printWithDialog(contents, 3, true)
  closeDialog()
  await vi.advanceTimersByTimeAsync(499)
  contents.print.mock.calls[0][1]!(true, '')
  await expect(result).resolves.toEqual({ kind: 'printed', pages: 3 })
})

it('keeps the print window past dialog-closed until the Electron callback arrives', async () => {
  const { contents, closeDialog } = nativePrint()
  const { result, spooled } = await printWithDialog(contents, 3, true)
  const closable = watch(spooled)
  closeDialog()
  await vi.advanceTimersByTimeAsync(500)
  await expect(result).resolves.toEqual({ kind: 'dialog-closed' })
  await vi.advanceTimersByTimeAsync(9 * 60_000)
  expect(closable.settled).toBe(false)
  contents.print.mock.calls[0][1]!(true, '')
  await vi.advanceTimersByTimeAsync(0)
  expect(closable.settled).toBe(true)
})

it('settles after five minutes when nothing reports back, and frees the window ten minutes after that', async () => {
  const { contents } = nativePrint()
  const { result, spooled } = await printWithDialog(contents, 3, false)
  const settled = watch(result), closable = watch(spooled)
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
  expect(settled.settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled.value).toEqual({ kind: 'refused', reason: 'The OS print dialog did not complete' })
  await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
  expect(closable.settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(closable.settled).toBe(true)
})
