// The complete Rendered interval: empty-card baseline, initial allocation, scroll, accessibility, switches and
// Reload without collecting garbage. Compare each private-byte sample with the ledger held then.
import { expect } from '@playwright/test'
import { rmSync } from 'node:fs'
import { type TestHooks, debugStats, expectReleasedDocuments, finish, fixture, launch, test, waitOpen, waitIndexed } from './app'
import { mib, processMemory } from './memory'

const CEILING = 8 << 20
// Qualify full overlap with a declared synthetic hooks budget; default-budget refusal is tested separately.
const QUALIFICATION_BUDGET = 8 * 2 ** 30

/** These cases qualify replacement/empty intervals; explicitly close the now-inactive permanent tab. */
async function closeInactive(win: Awaited<ReturnType<typeof launch>>['win']): Promise<void> {
  const inactive = win.locator('.file-pill:not([data-selected])')
  for (let remaining = await inactive.count(); remaining > 0; remaining--) {
    await inactive.first().hover()
    await inactive.first().locator('.file-tab-close').click()
    await expect(inactive).toHaveCount(remaining - 1)
  }
}

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

const CASES = [
  ...[
    { name: 'ascii', grapheme: 'a' },
    { name: 'cjk', grapheme: '語' },
    { name: 'arabic', grapheme: 'م' },
    { name: 'devanagari', grapheme: 'क' }
  ].map((s) => ({ name: s.name, make: () => ceiling(`rendered-${s.name}.md`, s.grapheme) })),
  {
    name: 'dense topology',
    make: () => {
      const body = '*x* `x` [x](#x) ![x](local.png)\n\n'.repeat(8000)
      return { path: fixture('rendered-dense-topology.md', body), bytes: Buffer.byteLength(body) }
    }
  }
]

for (const sampleCase of CASES)
  test(`${sampleCase.name}: initial mount, switches and Reload stay within the shared reservation + 32 MiB`, async () => {
    test.setTimeout(10 * 60_000)
    const made = sampleCase.make()
    const alternate = sampleCase.name === 'arabic' ? ceiling('memory-alternate-cjk.md', '語') : undefined
    const slug = sampleCase.name.replaceAll(' ', '-')
    const smallMarkdown = fixture(`memory-small-${slug}.md`, '# Small replacement\n\nA paragraph.\n')
    const text = fixture(`memory-text-${slug}.txt`, 'A plain text replacement.\n')
    const l = await launch({ hooks: true, controlledAccessibility: true })
    const { win } = l
    let stage = 'empty'
    let watching = false
    let sampling: Promise<void> | undefined
    let sampleError: unknown
    let discarded = 0
    const samples: { stage: string; private?: number; reserved: number }[] = []
    try {
      await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
      const originalLimit = (await debugStats(win)).ledger.limit
      const qualification = await debugStats(win, { limit: QUALIFICATION_BUDGET })
      expect(qualification.ledger.limit).toBe(QUALIFICATION_BUDGET)
      console.log(`Rendered overlap: default native limit ${originalLimit} bytes; synthetic qualification limit ${qualification.ledger.limit} bytes`)
      const cdp = await win.context().newCDPSession(win)
      // The sole GC: no document or Rendered tree exists yet. Nothing is collected during the measured interval.
      await cdp.send('HeapProfiler.collectGarbage')
      const renderer = async () => (await processMemory(l.app)).find((p) => p.type === 'Tab')!
      const baseline = await renderer()
      const sample = async () => {
        const when = stage
        const before = (await debugStats(win)).ledger
        const memory = await renderer()
        const after = (await debugStats(win)).ledger
        if (before.rendererCache !== after.rendererCache || before.used !== after.used || before.limit !== after.limit) {
          discarded++
          return false
        }
        samples.push({ stage: when, private: memory.private, reserved: after.rendererCache })
        return true
      }
      const stableSample = async () => {
        for (let i = 0; i < 10; i++) {
          if (await sample()) return
          await new Promise((done) => setTimeout(done, 50))
        }
        throw new Error(`${stage}: no stable bracketed reservation sample`)
      }
      const stats = () => win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered?.() ?? null)
      const ready = () => expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 120_000 })
      const frames = () => win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      await stableSample()
      watching = true
      sampling = (async () => {
        try {
          while (watching) {
            await sample()
            await new Promise((done) => setTimeout(done, 100))
          }
        } catch (e) { sampleError = e }
      })()
      stage = 'initial mount'
      await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), made.path)
      await ready()
      const initial = (await stats())!
      expect(initial, 'reserved before anything appends').not.toBeNull()
      expect(initial.reserved).toBeGreaterThan(0)
      expect(initial.rawReserved).toBeGreaterThan(0)
      await stableSample()
      stage = 'scroll'
      const traveled = await win.evaluate(() => new Promise<{ top: number; height: number; client: number }>((done) => {
        const el = document.querySelector('.md-scroller') as HTMLElement
        let frames = 0
        const step = () => {
          const max = el.scrollHeight - el.clientHeight
          if (el.scrollTop >= max - 1 || ++frames > 20_000) return done({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight })
          el.scrollTop = Math.min(max, el.scrollTop + Math.max(1, el.clientHeight))
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }))
      expect(traveled.height).toBeGreaterThan(traveled.client * 2)
      expect(traveled.top).toBeGreaterThan(traveled.height - traveled.client - 2)
      await stableSample()
      stage = 'accessibility'
      for (const on of [true, false]) {
        if (process.platform === 'linux') {
          console.log(`Linux memory probe sets renderer accessibility mode ${on}; native mode delivery remains untested`)
          await win.evaluate((on) => { document.documentElement.dataset.a11y = on ? 'on' : 'off' }, on)
        } else {
          const requested = Date.now()
          const native = await l.app.evaluate(({ app }, on) => {
            app.setAccessibilitySupportEnabled(on)
            return app.isAccessibilitySupportEnabled()
          }, on)
          console.log(`accessibility requested ${on}, native query ${native}, ${Date.now() - requested} ms`)
        }
        await expect(win.locator('html')).toHaveAttribute('data-a11y', on ? 'on' : 'off', { timeout: 120_000 })
        await win.locator('.md-scroller').evaluate((el) => el.scrollHeight)
        await frames()
        await stableSample()
      }
      await win.locator('.md-scroller').evaluate((el) => { (el as HTMLElement).dataset.reused = 'same generation' })
      stage = 'switches'
      for (let i = 0; i < 3; i++) {
        await win.getByRole('tab', { name: 'Raw', exact: true }).click()
        await expect(win.locator('.raw-host')).toBeVisible()
        await frames()
        await stableSample()
        await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
        await ready()
        await expect(win.locator('.md-scroller')).toHaveAttribute('data-reused', 'same generation')
        await stableSample()
      }
      stage = 'Reload'
      for (let gen = 2; gen <= 6; gen++) {
        const requested = Date.now()
        await win.locator('.md-scroller').focus()
        await win.keyboard.press('Control+R')
        if (sampleCase.name === 'dense topology' && gen === 3) {
          const budgetRefusal = win.locator('.banner').filter({ hasText: "Can't reload: Typose's memory budget is full" })
          const active = win.locator('[data-lens="rendered"]')
          await expect.poll(async () => await active.getAttribute('data-gen') === String(gen) || await budgetRefusal.isVisible(), { timeout: 120_000 }).toBe(true)
          if (await budgetRefusal.isVisible()) {
            const refused = await debugStats(win)
            expect(refused.surfaces).toMatchObject({ views: 1, pending: 0 })
            expect(refused.ledger.limit).toBe(QUALIFICATION_BUDGET)
            expect(refused.ledger.used).toBeLessThanOrEqual(QUALIFICATION_BUDGET)
            await expect(active).toHaveAttribute('data-gen', String(gen - 1))
            // The current and incoming leases must both stay paid until the handoff. Keep the 8 GiB refusal
            // visible in the evidence, then give the positive probe one additional live-view allowance.
            const extra = refused.surfaces!.bytes
            const allowance = QUALIFICATION_BUDGET + extra
            expect((await debugStats(win, { limit: allowance })).ledger.limit).toBe(allowance)
            console.log(`Dense handoff refused at ${QUALIFICATION_BUDGET} bytes; retained view ${extra}; positive retry limit ${allowance}`)
            await win.locator('.md-scroller').focus()
            await win.keyboard.press('Control+R')
          }
        }
        await expect(win.locator('[data-lens="rendered"]')).toHaveAttribute('data-gen', String(gen), { timeout: 120_000 })
        await ready()
        console.log(`Reload generation ${gen} ready after ${Date.now() - requested} ms`)
        const current = (await stats())!
        expect(current.retiredReserved).toBe(2 * initial.reserved)
        expect(current.rawReserved).toBeGreaterThan(0)
        await stableSample()
      }
      const final = (await stats())!
      if (alternate) {
        stage = 'alternating scripts'
        for (const path of [alternate.path, made.path, alternate.path, made.path]) {
          await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), path)
          await expect(win.locator('.card-name')).toHaveText(path.split(/[\\/]/).pop()!)
          await ready()
          await closeInactive(win)
          const current = (await stats())!
          expect(current.retiredReserved).toBe(2 * initial.reserved)
          expect(current.totalReserved).toBe(current.rawReserved + current.reserved + current.retiredReserved)
          await stableSample()
        }
      }
      stage = 'small Markdown replacement'
      await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), smallMarkdown)
      await expect(win.locator('.card-name')).toHaveText(`memory-small-${slug}.md`)
      await ready()
      await closeInactive(win)
      expect((await stats())!.retiredReserved).toBe(Math.max(2 * final.reserved, final.retiredReserved))
      await stableSample()
      stage = 'text replacement'
      await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), text)
      await expect(win.locator('.card-name')).toHaveText(`memory-text-${slug}.txt`)
      await waitOpen(win)
      await waitIndexed(win)
      await closeInactive(win)
      await frames()
      await stableSample()
      expect((await debugStats(win)).ledger.rendererCache).toBeGreaterThanOrEqual(final.reserved)
      // C6 still releases every document reservation. Private bytes while empty are not a renderer-live-data bound.
      watching = false
      await sampling
      await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.app.close!())
      await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
      await expectReleasedDocuments(win)
      stage = 'reopen after Close'
      await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), smallMarkdown)
      await expect(win.locator('.card-name')).toHaveText(`memory-small-${slug}.md`)
      await ready()
      // The settled reopened view is judged; no private-byte bound is asserted while the card is empty.
      watching = true
      sampling = (async () => {
        try {
          while (watching) {
            await sample()
            await new Promise((done) => setTimeout(done, 100))
          }
        } catch (e) { sampleError = e }
      })()
      expect((await stats())!.retiredReserved).toBe(Math.max(2 * final.reserved, final.retiredReserved))
      await stableSample()
      watching = false
      await sampling
      if (sampleError) throw sampleError
      const peak = Math.max(...samples.map((s) => s.private ?? 0))
      expect(samples.length, 'stable reservation samples').toBeGreaterThan(5)
      for (const measured of ['initial mount', 'scroll', 'accessibility', 'switches', 'Reload', 'small Markdown replacement', 'text replacement', 'reopen after Close'])
        expect(samples.some((s) => s.stage === measured), `${measured}: stable sample missing`).toBe(true)
      if (alternate) expect(samples.some((s) => s.stage === 'alternating scripts')).toBe(true)
      console.log(`${sampleCase.name}: source ${made.bytes}, blocks ${final.blocks}, units ${final.units}, nodes ${final.nodes}, note units ${final.noteUnits}`)
      console.log(`${samples.length} stable bracketed samples; ${discarded} transition samples discarded`)
      console.log(`empty private ${mib(baseline.private)}, peak ${mib(peak)}, Raw ${mib(final.rawReserved)}, current ${mib(final.reserved)}, retired ${mib(final.retiredReserved)}, total ${mib(final.totalReserved)}`)
      if (baseline.private === undefined) console.log('private bytes not reported on this OS; the memory bound remains unjudged')
      else {
        const checked = samples.filter((s): s is typeof s & { private: number } => s.private !== undefined)
        expect(checked.length).toBeGreaterThan(5)
        const room = (s: typeof checked[number]) => s.reserved + (32 << 20) - (s.private - baseline.private!)
        const worst = checked.reduce((a, b) => room(a) < room(b) ? a : b)
        console.log(`worst bound: ${worst.stage}, rise ${mib(worst.private - baseline.private)}, held ${mib(worst.reserved)}, room ${mib(room(worst))}`)
        expect(worst.private - baseline.private, `${sampleCase.name}: ${worst.stage}`).toBeLessThanOrEqual(worst.reserved + (32 << 20))
      }
      expect(l.pageErrors).toEqual([])
    } catch (error) {
      const state = await win.evaluate(() => ({
        notices: Array.from(document.querySelectorAll('.banner')).map(banner => banner.textContent),
        generation: document.querySelector('[data-lens="rendered"]')?.getAttribute('data-gen'),
        ready: document.querySelector('.md-scroller')?.getAttribute('data-ready'),
        focus: document.activeElement?.className
      })).catch(() => null)
      const ownership = await debugStats(win).catch(() => null)
      console.log(JSON.stringify({ failedStage: stage, state, ledger: ownership?.ledger, surfaces: ownership?.surfaces }))
      throw error
    } finally {
      watching = false
      await sampling
      await finish(l)
      rmSync(made.path, { force: true })
      if (alternate) rmSync(alternate.path, { force: true })
      rmSync(smallMarkdown, { force: true })
      rmSync(text, { force: true })
    }
  })
