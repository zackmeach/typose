import { describe, expect, it, vi } from 'vitest'
import { openExternal } from './external'

const HTTPS = 'https://example.invalid/path'

function caller() {
  const frame = { url: 'typose://app/index.html' }
  const contents = { mainFrame: frame, isDestroyed: () => false }
  const win = { webContents: contents, isDestroyed: () => false }
  const event: { sender: unknown; senderFrame: { url: string } | null } = { sender: contents, senderFrame: frame }
  const open = vi.fn(async (_url: string) => undefined)
  return { frame, contents, win, event, open }
}

describe('open-external validates this app main frame before invoking an OS URL handler', () => {
  for (const [input, expected] of [
    ['HTTP://EXAMPLE.INVALID', 'http://example.invalid/'],
    [HTTPS, HTTPS],
    ['mailto:person@example.invalid?subject=Hello%20there', 'mailto:person@example.invalid?subject=Hello%20there'],
    ['https://example.invalid/café', 'https://example.invalid/caf%C3%A9']
  ])
    it('opens ' + input + ' exactly once after URL normalization', async () => {
      const { win, event, open } = caller()
      expect(await openExternal(win, event, [input], open)).toBe(true)
      expect(open.mock.calls).toEqual([[expected]])
    })

  for (const args of [[], [HTTPS, undefined], [HTTPS, 'extra'], [undefined], [null], [false], [3], [{}], [[HTTPS]]])
    it('refuses argument shape ' + JSON.stringify(args), async () => {
      const { win, event, open } = caller()
      expect(await openExternal(win, event, args, open)).toBe(false)
      expect(open).not.toHaveBeenCalled()
    })

  for (const value of ['', 'not a URL', '//example.invalid/path', 'javascript:alert(1)', 'data:text/plain,x', 'file:///C:/file.md', 'smb://host/share', 'tel:123'])
    it('refuses ' + JSON.stringify(value), async () => {
      const { win, event, open } = caller()
      expect(await openExternal(win, event, [value], open)).toBe(false)
      expect(open).not.toHaveBeenCalled()
    })

  for (const n of [0, 1, 9, 10, 13, 31, 127, 128, 159])
    it('refuses raw control ' + n, async () => {
      const { win, event, open } = caller()
      expect(await openExternal(win, event, [HTTPS + String.fromCharCode(n) + 'x'], open)).toBe(false)
      expect(open).not.toHaveBeenCalled()
    })

  it('takes exactly 32 KiB of ASCII, and refuses the next byte', async () => {
    const { win, event, open } = caller()
    const url = HTTPS + 'a'.repeat(32768 - HTTPS.length)
    expect(await openExternal(win, event, [url], open)).toBe(true)
    expect(open.mock.calls).toEqual([[url]])
    open.mockClear()
    expect(await openExternal(win, event, [url + 'a'], open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  for (const value of [HTTPS + 'é'.repeat(20_000), HTTPS + 'é'.repeat(6000)])
    it('refuses an oversized ' + (value.length > 10_000 ? 'UTF-8 input' : 'serialized URL'), async () => {
      const { win, event, open } = caller()
      expect(await openExternal(win, event, [value], open)).toBe(false)
      expect(open).not.toHaveBeenCalled()
    })

  it('refuses a different WebContents even when its frame URL looks right', async () => {
    const { win, event, open, contents } = caller()
    event.sender = { ...contents }
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses a same-origin child or detached frame', async () => {
    const { win, event, open, frame } = caller()
    event.senderFrame = { ...frame }
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    event.senderFrame = null
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  for (const page of [
    'https://app/index.html', 'typose://app.evil/index.html', 'typose://user@app/index.html',
    'typose://app:80/index.html', 'typose://app/other.html', 'typose://app/index.html/extra'
  ])
    it('refuses main frame URL ' + page, async () => {
      const { win, event, open, frame } = caller()
      frame.url = page
      expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
      expect(open).not.toHaveBeenCalled()
    })

  it('accepts the app load query without broadening the allowed page', async () => {
    const { win, event, open, frame } = caller()
    frame.url = 'typose://app/index.html?delayMount=10'
    expect(await openExternal(win, event, [HTTPS], open)).toBe(true)
    expect(open.mock.calls).toEqual([[HTTPS]])
  })

  it('refuses a destroyed window or WebContents', async () => {
    const { win, event, open, contents } = caller()
    win.isDestroyed = () => true
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    win.isDestroyed = () => false
    contents.isDestroyed = () => true
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses a frame whose URL can no longer be read', async () => {
    const { win, event, open, frame } = caller()
    Object.defineProperty(frame, 'url', { get: () => { throw new Error('frame destroyed') } })
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('returns false for an OS handler failure without retrying', async () => {
    const { win, event, open } = caller()
    open.mockRejectedValue(new Error('OS handler failed'))
    expect(await openExternal(win, event, [HTTPS], open)).toBe(false)
    expect(open.mock.calls).toEqual([[HTTPS]])
  })
})
