import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { printWithDialog, spoolKeeper } from './print-dialog'

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
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled.settled).toBe(false)
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

it('frees the window ten minutes after dialog-closed when no callback comes', async () => {
  const { contents, closeDialog } = nativePrint()
  const { result, spooled } = await printWithDialog(contents, 3, true)
  const closable = watch(spooled)
  closeDialog()
  await vi.advanceTimersByTimeAsync(500)
  await expect(result).resolves.toEqual({ kind: 'dialog-closed' })
  await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
  expect(closable.settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(closable.settled).toBe(true)
})

it.each([true, false])('stays pending while nothing reports back, since the dialog may still be open (afterprint watched: %s)', async watchAfterPrint => {
  const { contents } = nativePrint()
  const { result, spooled } = await printWithDialog(contents, 3, watchAfterPrint)
  const settled = watch(result), closable = watch(spooled)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(settled.settled).toBe(false)
  expect(closable.settled).toBe(false)
})

it('settles refused and frees the window at once when print throws', async () => {
  const { contents } = nativePrint()
  contents.print.mockImplementation(() => { throw new Error('No printer') })
  const { result, spooled } = await printWithDialog(contents, 3, true)
  await expect(result).resolves.toEqual({ kind: 'refused', reason: 'The OS print dialog did not complete' })
  await expect(spooled).resolves.toBeUndefined()
})

it('settles refused and frees the window at once when the afterprint watch rejects', async () => {
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Window gone'))
  const { result, spooled } = await printWithDialog({ executeJavaScript, print: vi.fn<WebContents['print']>() }, 3, true)
  const closable = watch(spooled)
  await expect(result).resolves.toEqual({ kind: 'refused', reason: 'The OS print dialog did not complete' })
  await vi.advanceTimersByTimeAsync(0)
  expect(closable.settled).toBe(true)
})

it('keeps at most two windows waiting on their spool, closing the oldest', () => {
  const keep = spoolKeeper(), never = new Promise<void>(() => {})
  const first = vi.fn(), second = vi.fn(), third = vi.fn()
  keep(first, never)
  keep(second, never)
  expect(first).not.toHaveBeenCalled()
  keep(third, never)
  expect(first).toHaveBeenCalledOnce()
  expect(second).not.toHaveBeenCalled()
  expect(third).not.toHaveBeenCalled()
  const fourth = vi.fn()
  keep(fourth, never)
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(third).not.toHaveBeenCalled()
})

it('stops counting a window once its spool ends', async () => {
  const keep = spoolKeeper(), never = new Promise<void>(() => {})
  let finish!: () => void
  const first = vi.fn(), second = vi.fn(), third = vi.fn(), fourth = vi.fn()
  keep(first, never)
  keep(second, new Promise<void>(resolve => { finish = resolve }))
  finish()
  await vi.advanceTimersByTimeAsync(0)
  keep(third, never)
  expect(first).not.toHaveBeenCalled()
  keep(fourth, never)
  expect(first).toHaveBeenCalledOnce()
  expect(second).not.toHaveBeenCalled()
  expect(third).not.toHaveBeenCalled()
})
