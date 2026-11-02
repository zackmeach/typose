import { expect } from '@playwright/test'
import { finish, launch, test } from './app'

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
