import { describe, expect, it, vi } from 'vitest'
import { MAX_CLIPBOARD_BYTES } from '../shared/protocol'
import { writeClipboardText } from './clipboard'

function caller() {
  const frame = { url: 'typose://app/index.html' }
  const contents = { mainFrame: frame, isDestroyed: () => false }
  const win = { webContents: contents, isDestroyed: () => false }
  const event = { sender: contents, senderFrame: frame }
  const write = vi.fn()
  return { frame, contents, win, event, write }
}

describe('renderer clipboard writes are app-main-frame, plain-text and byte bounded', () => {
  it('writes a valid UTF-8 payload exactly once', async () => {
    const { win, event, write } = caller()
    expect(await writeClipboardText(win, event, ['North\tCreek\n'], write)).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('North\tCreek\n')
  })

  it('accepts exactly 16 MiB and refuses a payload above the cap', async () => {
    const { win, event, write } = caller()
    const exact = 'x'.repeat(MAX_CLIPBOARD_BYTES)
    expect(await writeClipboardText(win, event, [exact], write)).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith(exact)
    write.mockClear()
    expect(await writeClipboardText(win, event, [exact + 'x'], write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('bounds UTF-8 bytes, not just code units', async () => {
    const { win, event, write } = caller()
    const text = 'é'.repeat(MAX_CLIPBOARD_BYTES / 2 + 1)
    expect(text.length).toBeLessThan(MAX_CLIPBOARD_BYTES)
    expect(await writeClipboardText(win, event, [text], write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses malformed argument shapes without invoking the OS clipboard', async () => {
    const { win, event, write } = caller()
    for (const args of [[], ['a', 'b'], [null], [23], [{}], [['a']]]) {
      expect(await writeClipboardText(win, event, args, write)).toBe(false)
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses a different WebContents, subframe or non-app path', async () => {
    const { win, event, write, contents, frame } = caller()
    event.sender = { ...contents }
    expect(await writeClipboardText(win, event, ['x'], write)).toBe(false)
    event.sender = contents
    event.senderFrame = { url: frame.url }
    expect(await writeClipboardText(win, event, ['x'], write)).toBe(false)
    event.senderFrame = frame
    frame.url = 'typose://app/other.html'
    expect(await writeClipboardText(win, event, ['x'], write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('reports a failed OS write without claiming success', async () => {
    const { win, event } = caller()
    expect(await writeClipboardText(win, event, ['x'], () => { throw new Error('clipboard unavailable') })).toBe(false)
    expect(await writeClipboardText(win, event, ['x'], async () => { throw new Error('clipboard unavailable') })).toBe(false)
  })
})
