import { expect } from '@playwright/test'
import { finish, launch, osFocus, test } from './app'

test('the app runs from typose:// and cannot reach the network', async () => {
  const l = await launch()
  const { app, win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible() // the empty card, with the core connected
  expect(await win.evaluate(() => location.protocol)).toBe('typose:')
  const outcome = await win.evaluate(() =>
    fetch('https://example.com/').then(
      () => 'reached',
      () => 'blocked'
    )
  )
  expect(outcome).toBe('blocked')
  // The page CSP alone blocks the renderer fetch above; this pins the session guard itself (loopback, unsafe port: no traffic).
  const viaMain = await app.evaluate(({ net }) => net.fetch('http://127.0.0.1:9/').then(() => 'reached', (e: Error) => String(e)))
  expect(viaMain).toContain('ERR_BLOCKED_BY_CLIENT')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('the CSP header forbids inline script, and navigation and new windows are denied', async () => {
  const l = await launch()
  const { app, win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  const csp = await win.evaluate(() => fetch('/index.html').then((r) => r.headers.get('content-security-policy')))
  expect(csp).toContain("default-src 'self'")
  const inline = await win.evaluate(
    () =>
      new Promise<string>((ok) => {
        document.addEventListener('securitypolicyviolation', (e) => ok(`blocked ${e.effectiveDirective}`), { once: true })
        const s = document.createElement('script')
        s.textContent = 'window.__ran = true'
        document.body.append(s)
        setTimeout(() => ok((window as unknown as { __ran?: boolean }).__ran ? 'ran' : 'no event'), 1000)
      })
  )
  expect(inline).toMatch(/^blocked script-src/)
  await win.evaluate(() => {
    window.open('typose://app/index.html')
    location.href = 'typose://app/elsewhere.html'
  })
  await win.waitForTimeout(500)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(win.url()).toBe('typose://app/index.html')
  await finish(l)
})

test("IPC from Chromium's error page in the app page's place is refused, though its frame's URL reads as the app page's", async () => {
  const l = await launch()
  const { app, win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  expect(await win.evaluate(() => (window as unknown as { typose: { loadSession(): Promise<unknown> } }).typose.loadSession().then(() => 'answered', (e: Error) => e.message)))
    .toBe('answered')
  // The page's next load is refused at the network guard, so Chromium's error page takes its place, with its preload.
  await app.evaluate(async ({ BrowserWindow, session }) => {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(typose|data|blob|devtools):/.test(d.url) || d.url.startsWith('typose://app/index.html') }))
    await BrowserWindow.getAllWindows()[0].webContents.loadURL('typose://app/index.html').catch(() => {})
  })
  const frame = () => app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    return { url: contents.mainFrame.url, origin: contents.mainFrame.origin, page: await contents.executeJavaScript('location.href'), bridge: await contents.executeJavaScript('typeof window.typose') }
  })
  await expect.poll(frame).toEqual({ url: 'typose://app/index.html', origin: 'null', page: 'chrome-error://chromewebdata/', bridge: 'object' })
  // A channel through `handle`, one handled on its own, and one sent: the invoke after the send answers once main has read both.
  const sent = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const zoom = contents.getZoomFactor()
    const loadSession = await contents.executeJavaScript('window.typose.loadSession().then(() => "answered", e => e.message)')
    const chromeTheme = await contents.executeJavaScript('window.typose.zoom("in"), window.typose.setChromeTheme(true, "#000000", "#ffffff")')
    return { loadSession, chromeTheme, zoomed: contents.getZoomFactor() !== zoom }
  })
  expect(sent).toEqual({ loadSession: "Error invoking remote method 'load-session': Error: refused load-session", chromeTheme: false, zoomed: false })
  await finish(l)
})

test('the page is refused every permission, asked or checked, but the clipboard write Copy path makes', async () => {
  const l = await launch()
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await osFocus(l) // the async clipboard needs a focused page
  const asked = await win.evaluate(async () => {
    const check = (name: string) => navigator.permissions.query({ name } as unknown as PermissionDescriptor).then((s) => s.state)
    const item = Promise.reject(new Error('item refused'))
    item.catch(() => {}) // the clipboard sees the rejection; the page doesn't report it as unhandled
    return {
      request: await Notification.requestPermission(),
      camera: await check('camera'),
      clipboardRead: await check('clipboard-read'),
      clipboardWrite: await check('clipboard-write'),
      // Copy path's write passes the permission; its item's own rejection ends it, so nothing reaches the OS clipboard.
      write: await navigator.clipboard.write([new ClipboardItem({ 'text/plain': item })]).then(() => 'written', (e: Error) => e.message)
    }
  })
  expect(asked).toEqual({ request: 'denied', camera: 'denied', clipboardRead: 'denied', clipboardWrite: 'granted', write: 'item refused' })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
