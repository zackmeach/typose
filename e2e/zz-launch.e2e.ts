// DIAG (scratch branch only): launches the app over and over on Linux, and on a launch whose first content never
// shows, prints what the page, main and the lifecycle log saw.
import { expect } from '@playwright/test'
import { finish, launch, lifecycle, test } from './app'

test('zz launch: the first window shows the app', async () => {
  test.skip(process.platform !== 'linux' && !process.env.ZZ_ANY, 'Linux only')
  test.setTimeout(60_000)
  const t0 = Date.now()
  // Alternate arms on one VM: even repeats run the plain build, odd ones load `performance` and undici first thing in
  // main (ZZ_PRELOAD=1).
  const arm = test.info().repeatEachIndex % 2 ? 'preload' : 'plain'
  console.log(`ZZSTART ${arm} ${test.info().repeatEachIndex} retry ${test.info().retry}`)
  const l = await launch(arm === 'preload' ? { env: { ZZ_PRELOAD: '1' } } : {})
  try {
    await expect(l.win.locator(process.env.ZZ_FAIL ? '.no-such-thing' : '.titlebar')).toBeVisible({ timeout: 10_000 })
  } catch (error) {
    const probe = await Promise.race([
      l.win.evaluate(() => ({
        href: location.href, ready: document.readyState, title: document.title,
        root: document.getElementById('root')?.childElementCount ?? -1, html: document.documentElement.outerHTML.length,
        head: document.documentElement.outerHTML.slice(0, 600),
        scripts: [...document.scripts].map((s) => `${s.type} ${s.src.slice(-40)}`),
        resources: performance.getEntriesByType('resource').map((r) => {
          const e = r as PerformanceResourceTiming
          return `${e.name.slice(-40)} ${e.responseStatus} ${Math.round(e.duration)}ms`
        }),
        nav: performance.getEntriesByType('navigation').map((n) => JSON.stringify(n.toJSON()).slice(0, 600)),
        api: Object.keys(window).filter((k) => k.startsWith('typose'))
      })),
      new Promise<string>((ok) => setTimeout(() => ok('page probe timed out after 5 s'), 5000))
    ]).catch((e: unknown) => String(e))
    const main = await l.app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()
      const wc = w[0]?.webContents
      if (!wc) return { windows: w.length }
      const img = await wc.capturePage()
      const bmp = img.toBitmap()
      const colors = new Set<number>()
      for (let i = 0; i < bmp.length; i += 4 * 97) colors.add(bmp.readUInt32LE(i))
      const page = await Promise.race([
        wc.executeJavaScript(`({ href: location.href, ready: document.readyState, titlebar: !!document.querySelector('.titlebar'), root: document.getElementById('root')?.childElementCount ?? -1 })`),
        new Promise((ok) => setTimeout(() => ok('executeJavaScript timed out after 5 s'), 5000))
      ]).catch((e: unknown) => String(e))
      return { windows: w.length, url: wc.getURL(), loading: wc.isLoading(), crashed: wc.isCrashed(), visible: w[0].isVisible(), size: img.getSize(), colors: colors.size, page, frames: wc.mainFrame.framesInSubtree.map((f) => f.url) }
    }).catch((e: unknown) => String(e))
    const pages = l.app.windows().map((p) => p.url())
    await finish(l, true).catch(() => {})
    const log = (() => { try { return lifecycle(l.userData) } catch (e) { return String(e) } })()
    console.log(`ZZLAUNCH ${arm} ${JSON.stringify({ ms: Date.now() - t0, pageErrors: l.pageErrors, pages, probe, main, log })}`)
    throw error
  }
  await finish(l, true)
  const log = lifecycle(l.userData)
  const start = Date.parse(log.find((r) => r.event === 'start')?.t as string)
  const at = (event: string) => { const r = log.find((x) => x.event === event); return r ? Date.parse(r.t as string) - start : -1 }
  if (log.some((r) => /^diag-(recover|globals|console-error)$/.test(r.event))) console.log(`ZZRECOVER ${arm} ${JSON.stringify(log.filter((r) => /^diag-(recover|globals|console-error|fail-load|request-error)|^start$|^did-finish-load$/.test(r.event)))}`)
  const pre = log.find((r) => r.event === 'diag-preload') as { performance?: string; headers?: string; performanceAfter?: string } | undefined
  if (pre && (pre.performance !== 'object' || pre.headers !== 'ok')) console.log(`ZZPRE ${arm} ${JSON.stringify(pre)}`)
  console.log(`ZZOK ${arm} pre ${pre ? `${pre.performance}/${pre.headers === 'ok' ? 'ok' : 'ERR'}` : '-'} load ${at('did-finish-load')} shown ${at('window-shown')} serves ${log.filter((r) => r.event === 'diag-serve').length} navs ${log.filter((r) => r.event === 'diag-start-navigation').length} console ${log.filter((r) => r.event === 'diag-console').length}`)
})
