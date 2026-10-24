// Plan §2.2: RENDERED_PER_UNIT, measured on wrapped text at the ceiling, and C1's bound after a scroll
// end to end (the renderer's private bytes stay within the reservation + 32 MiB). Numbers are logged, not judged
// beyond that bound (Z65).
import { expect } from '@playwright/test'
import { rmSync } from 'node:fs'
import { type TestHooks, finish, fixture, launch, test } from './app'
import { mib, processMemory } from './memory'

const CEILING = 8 << 20

/** A file of `grapheme` repeated into wrapped paragraphs, as close to the 8 MiB ceiling as it fits. */
function ceiling(name: string, grapheme: string): { path: string; bytes: number } {
  const gBytes = Buffer.byteLength(grapheme)
  const chars = Math.max(1, Math.floor(4000 / gBytes))
  const para = `${grapheme.repeat(chars)}\n\n`
  const n = Math.floor(CEILING / Buffer.byteLength(para))
  let body = para.repeat(n)
  const remain = CEILING - Buffer.byteLength(body)
  const extra = Math.floor(remain / gBytes)
  if (extra > 0) body += grapheme.repeat(extra)
  const bytes = Buffer.byteLength(body)
  if (bytes > CEILING) throw new Error(`${name} is ${bytes} bytes`)
  return { path: fixture(name, body), bytes }
}

const SCRIPTS = [
  { name: 'ascii', grapheme: 'a', file: 'rendered-ascii.md' },
  { name: 'cjk', grapheme: '語', file: 'rendered-cjk.md' },
  { name: 'arabic', grapheme: 'م', file: 'rendered-arabic.md' },
  { name: 'devanagari', grapheme: 'क', file: 'rendered-devanagari.md' }
]

for (const script of SCRIPTS) {
  test(`wrapped ${script.name} at the ceiling: private bytes stay within the reservation + 32 MiB`, async () => {
    test.setTimeout(10 * 60_000)
    const made = ceiling(script.file, script.grapheme)
    const l = await launch({ hooks: true, file: made.path })
    try {
      const { win } = l
      await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 120_000 })
      const stats = () =>
        win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered?.() ?? null)
      const reserved = await stats()
      expect(reserved, 'the build reserved before it appended').not.toBeNull()
      const cdp = await win.context().newCDPSession(win)
      await cdp.send('HeapProfiler.collectGarbage')
      const renderer = async () => (await processMemory(l.app)).find((p) => p.type === 'Tab')!
      const before = await renderer()
      let peak = before.private ?? 0
      const scrolling = win.evaluate(
        () =>
          new Promise<{ top: number; height: number; client: number }>((resolve) => {
            const el = document.querySelector('.md-scroller') as HTMLElement
            let stuck = 0
            let frames = 0
            const step = () => {
              const max = el.scrollHeight - el.clientHeight
              const next = Math.min(max, el.scrollTop + Math.max(1, el.clientHeight))
              if (el.scrollTop >= max - 1 || next === el.scrollTop || ++frames > 20_000) {
                if (next === el.scrollTop && ++stuck < 3 && frames <= 20_000 && el.scrollTop < max - 1) return requestAnimationFrame(step)
                return resolve({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight })
              }
              stuck = 0
              el.scrollTop = next
              requestAnimationFrame(step)
            }
            requestAnimationFrame(step)
          })
      )
      for (;;) {
        peak = Math.max(peak, (await renderer()).private ?? 0)
        const done = await Promise.race([scrolling.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 250))])
        if (done) break
      }
      const traveled = await scrolling
      peak = Math.max(peak, (await renderer()).private ?? 0)
      expect(traveled.height, 'the column is taller than the view').toBeGreaterThan(traveled.client * 2)
      expect(traveled.top, 'the scroll reached the end').toBeGreaterThan(traveled.height - traveled.client - 2)
      const s = (await stats())!
      const rise = before.private === undefined ? undefined : peak - before.private
      const perUnit = rise === undefined ? undefined : rise / s.units
      const beyondCopies = rise === undefined ? undefined : Math.max(0, rise - 2 * s.htmlBytes) / s.units
      console.log(
        [
          `${script.name}: file ${made.bytes} bytes, ${s.blocks} blocks, ${s.units} units, html ${s.htmlBytes} bytes`,
          `reserved ${mib(s.reserved)}, private ${mib(before.private)} before the scroll, peak ${mib(peak)}, rise ${mib(rise)}`,
          `per unit from the rise ${perUnit?.toFixed(2) ?? 'n/a'} bytes; beyond 2×html ${beyondCopies?.toFixed(2) ?? 'n/a'}`
        ].join('\n')
      )
      if (before.private === undefined) console.log('private bytes: not reported by Electron on this OS; nothing judged')
      else expect(rise!).toBeLessThanOrEqual(s.reserved + (32 << 20))
      expect(l.pageErrors).toEqual([])
    } finally {
      await finish(l)
      rmSync(made.path, { force: true })
    }
  })
}
