// Plan C1 and PR 6's memory acceptance, on the test-hooks build: the renderer cache's reservation, under a budget that
// holds only the viewport too, the deterministic multi-document exhaustion test, the memory metrics, and the refusal on
// open. Memory is read per process (`memory.ts`), every metric on its own.
import { type Page, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync, statSync, truncateSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GARBAGE_PER_UNIT, WRAP, capFor, rowCost, rowsFor } from '../app/renderer/lenses/page-cache'
import type { Limits, Opened, Page as CorePage } from '../app/shared/protocol'
import { FIXTURES, type Launched, type TestHooks, debugStats, finish, fixture, launch, sparseFixture, test, visibleRows, waitIndexed, waitOpen } from './app'
import { mib, processMemory, summed } from './memory'

type CacheStats = { charged: number; cap: number; reserved: number }
type Hooked = { typoseTest: TestHooks & { client: { cache: (() => CacheStats) | null } } }
const cacheStats = (win: Page) => win.evaluate(() => (window as unknown as Hooked).typoseTest.client.cache?.() ?? null)

/** 400 lines of 70,000 ASCII bytes: each line's first piece is 65,536 units, over 32 rows of 2,048 (Z66). */
const ascii64k = () => fixture('ascii-64k.txt', Array.from({ length: 400 }, () => 'a'.repeat(70_000)).join('\n') + '\n')

/** Sets the window's size; returns its content size and the screen's work area, which may hold it smaller. */
const resize = (l: Launched, width: number, height: number) =>
  l.app.evaluate(
    ({ BrowserWindow, screen }, [width, height]) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(width, height)
      return { content: w.getContentSize(), screen: screen.getPrimaryDisplay().workAreaSize }
    },
    [width, height] as const
  )

const cp = (c: number) => String.fromCodePoint(c)
/**
 * Z66's gate's scripts (PR 6b): seeded words, a line of them within one 60,000-byte piece (C2). A unit a byte for
 * ASCII; 3 bytes a unit for CJK and Devanagari, 2 for Arabic, 4 bytes per 2 units for emoji. Devanagari's runs with
 * accessibility on, so its rows' AX tree is laid out too.
 */
const SCRIPTS: { script: string; units: number; space: boolean; ax?: boolean; word: (r: (n: number) => number) => string }[] = [
  { script: 'ASCII', units: 60_000, space: true, word: (r) => Array.from({ length: 2 + r(9) }, () => 'abcdefghijklmnopqrstuvwxyz0123456789{}":,'[r(41)]).join('') },
  { script: 'CJK', units: 20_000, space: false, word: (r) => Array.from({ length: 1 + r(6) }, () => cp(0x4e00 + r(0x51a5))).join('') },
  { script: 'emoji', units: 30_000, space: true, word: (r) => Array.from({ length: 1 + r(3) }, () => cp(0x1f300 + r(0x150)) + (r(4) === 0 ? cp(0x1f3fb + r(5)) : '')).join('') },
  { script: 'Arabic', units: 30_000, space: true, word: (r) => Array.from({ length: 2 + r(7) }, () => cp(0x0628 + r(0x23))).join('') },
  {
    script: 'Devanagari',
    units: 20_000,
    space: true,
    ax: true,
    word: (r) => Array.from({ length: 1 + r(4) }, () => cp(0x0915 + r(0x25)) + (r(3) === 0 ? `्${cp(0x0915 + r(0x25))}` : '') + (r(2) ? cp(0x093e + r(0xf)) : '')).join('')
  }
]

/** 40 lines of a script's words, the same each run. */
function scriptFile(s: (typeof SCRIPTS)[number]): string {
  let seed = 1
  const r = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % n
  return Array.from({ length: 40 }, () => {
    let line = ''
    while (line.length < s.units) line += s.word(r) + (s.space ? ' ' : '')
    return line
  }).join('\n') + '\n'
}

for (const s of SCRIPTS)
  test(`${s.script}${s.ax ? ', with accessibility on' : ''}: Raw's rows, once collected, raise the renderer's private bytes by no more than the reservation holds for them, and a Reload leaves no more garbage than it reserves (Z66)`, () =>
    layoutGate(s))

/**
 * Z66's deterministic gate (PR 6b): the rise in the renderer's private bytes from the empty card, after a forced GC, is
 * within what Raw's reservation holds for what stays (all of it but the garbage part: the fixed allowance, the two items
 * partly mounted, each row's charge and the elastic part), after the open and after 10 viewports down. A Reload's
 * handover, read without a GC, leaves at most the garbage part.
 */
async function layoutGate(s: (typeof SCRIPTS)[number]): Promise<void> {
  test.setTimeout(5 * 60_000)
  const path = fixture(`z66-${s.script}.txt`, scriptFile(s))
  const l = await launch({ hooks: true })
  try {
    const { app, win } = l
    await expect(win.locator('.open-button')).toHaveText('Open file…') // the empty card: no lens yet
    if (s.ax) await app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true))
    const size = await resize(l, 1280, 480) // the smallest window brief §9 allows
    const hello = await core<{ limits: Limits }>(win, 'hello', { protocol: 1 })
    if (!('ok' in hello)) throw new Error(`hello: ${hello.code}`)
    const L = hello.ok.limits
    const cdp = await win.context().newCDPSession(win)
    const renderer = async () => (await processMemory(app)).find((p) => p.type === 'Tab')!.private
    const collected = async () => {
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage')
      await win.waitForTimeout(300)
      return (await renderer())!
    }
    if ((await renderer()) === undefined) return console.log('private bytes: not reported by Electron on this OS; nothing judged') // macOS
    const base = await collected()
    // As a second launch would open it (spec §8.1): no dialog.
    await app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), path)
    /** Raw at `gen` holds its reservation for its height, as the core does, and every mounted row has its text. */
    const settled = async (gen: string) => {
      await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', gen, { timeout: 30_000 })
      const host = await win.evaluate(() => document.querySelector('.raw-host')!.clientHeight)
      const reserved = capFor(L, 3 * Math.ceil(host / 20) + 1)
      await expect.poll(async () => (await cacheStats(win))?.reserved, { timeout: 30_000 }).toBe(reserved)
      expect((await debugStats(win)).ledger.rendererCache).toBe(reserved)
      await expect.poll(() => win.evaluate(() => [...document.querySelectorAll('.vl-row')].every((r) => r.querySelector('.text'))), { timeout: 60_000 }).toBe(true)
      const c = (await cacheStats(win))!
      expect(c.charged, JSON.stringify(c)).toBeLessThanOrEqual(c.cap)
      return reserved
    }
    const units = () => win.evaluate(() => [...document.querySelectorAll('.vl-row .text')].map((t) => t.textContent!.length))
    const garbagePart = (reserved: number) => rowsFor(L, reserved) * WRAP * GARBAGE_PER_UNIT
    /** After a GC, the rise is within the reservation's formula at the rows mounted, less their garbage part. */
    const check = async (step: string, reserved: number) => {
      const rise = (await collected()) - base
      const u = await units()
      const bound = capFor(L, u.length) - u.length * WRAP * GARBAGE_PER_UNIT
      console.log(
        `${s.script} ${step}: rise ${mib(rise)} after GC, within ${mib(bound)} for ${u.length} rows mounted (${u.reduce((a, b) => a + b, 0)} units, ` +
          `the longest ${Math.max(...u)}); reserved ${mib(reserved)} for ${rowsFor(L, reserved)} rows`
      )
      expect(rise, step).toBeLessThanOrEqual(bound)
      return rise
    }
    let reserved = await settled('1')
    console.log(`window content ${size.content.join('×')} px; Raw ${await win.evaluate(() => document.querySelector('.raw-host')!.clientHeight)} px`)
    await check('open', reserved)
    const top = () => win.evaluate(() => document.querySelector('.vl-scroller')!.scrollTop)
    await win.locator('.vl-scroller').focus()
    let scrolled = 0 // the most the rise reaches on the way down, without a GC: logged
    for (let i = 0; i < 10; i++) {
      const was = await top()
      await win.keyboard.press('PageDown')
      await expect.poll(top).toBeGreaterThan(was)
      reserved = await settled('1')
      scrolled = Math.max(scrolled, (await renderer())! - base)
    }
    const down = await check('10 viewports down', reserved)
    console.log(`${s.script} scrolling: rise ${mib(scrolled)} at most before a GC, ${mib(scrolled - down)} over what stays`)
    // The Reload's handover: the next lens mounted, the last one's rows left for a GC.
    await win.keyboard.press('F5')
    reserved = await settled('2')
    const peak = (await renderer())! - base
    const after = (await collected()) - base
    console.log(`${s.script} Reload: rise ${mib(peak)} before a GC, ${mib(after)} after: garbage ${mib(peak - after)}, within ${mib(garbagePart(reserved))} reserved for it`)
    expect(peak - after).toBeLessThanOrEqual(garbagePart(reserved))
    expect(after).toBeLessThanOrEqual(reserved - garbagePart(reserved))
    expect(l.pageErrors).toEqual([])
  } finally {
    await finish(l)
    rmSync(path, { force: true })
  }
}

/**
 * Waits for Raw to hold the viewport-only reservation for its height and show the viewport's rows, then checks it
 * mounts the viewport and no overscan, and its cache is charged within the reservation, which the core holds.
 */
async function viewportOnly(win: Page, L: Limits, step: string): Promise<void> {
  const view = () =>
    win.evaluate(() => ({
      host: document.querySelector('.raw-host')!.clientHeight,
      viewport: document.querySelector('.vl-scroller')!.clientHeight,
      mounted: document.querySelectorAll('.vl-row').length
    }))
  await expect.poll(async () => (await cacheStats(win))?.reserved === capFor(L, Math.ceil((await view()).host / 20) + 1, false), { timeout: 30_000 }).toBe(true)
  const shown = async () => {
    const rows = await visibleRows(win)
    return rows.length >= Math.floor((await view()).viewport / 20) && rows.every((r) => r.text.length === WRAP)
  }
  await expect.poll(shown, { timeout: 60_000 }).toBe(true)
  const { host, viewport, mounted } = await view()
  const s = (await cacheStats(win))!
  console.log(`${step}: Raw ${host} px (${viewport} px of rows), ${mounted} rows mounted; cache charged ${mib(s.charged)} of ${mib(s.reserved)} reserved`)
  expect(mounted, step).toBeLessThanOrEqual(Math.ceil(viewport / 20) + 1) // the viewport's rows, no overscan
  expect(s.charged, step).toBeLessThanOrEqual(s.reserved)
  expect((await debugStats(win)).ledger.rendererCache, step).toBe(s.reserved)
}

/**
 * Plan C1's refusals, under a budget that holds the pool, the document and the open's viewport-only floor, with room for
 * the document's cache to grow, and not the overscan: Raw mounts only the viewport and is charged within its
 * reservation, after the open, a Reload, and a resize down and back up. Once the ledger has room, the next resize, even
 * one that doesn't change the row count, reserves the overscan again.
 */
test('under a budget that holds only the viewport, Raw mounts only the viewport, within its reservation, after open, Reload and resize', async () => {
  test.setTimeout(5 * 60_000)
  const path = ascii64k()
  try {
    // Calibration, without the override: the pool, the document's charges once indexed, and the window's height.
    const probe = await launch({ hooks: true, file: path })
    await waitOpen(probe.win)
    await waitIndexed(probe.win)
    const hello = await core<{ limits: Limits }>(probe.win, 'hello', { protocol: 1 })
    if (!('ok' in hello)) throw new Error(`hello: ${hello.code}`)
    const { ledger, charges } = await debugStats(probe.win)
    const inner = await probe.win.evaluate(() => window.innerHeight)
    await finish(probe)
    const L = hello.ok.limits
    const floor = capFor(L, Math.ceil(inner / 20) + 1, false) // the open's viewport-only cap, at the window's height
    const budget = ledger.pool + charges[1].total + L.openTemp + floor + statSync(path).size + rowCost(L)
    console.log(`budget ${mib(budget)}: pool ${mib(ledger.pool)}, document ${mib(charges[1].total)}, view ${mib(floor)} (${inner} px of window)`)
    const l = await launch({ hooks: true, file: path, env: { TYPOSE_TEST_BUDGET: String(budget) } })
    const { win } = l
    await waitOpen(win)
    await viewportOnly(win, L, 'open')
    await win.locator('.vl-scroller').focus()
    await win.keyboard.press('F5')
    await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
    await viewportOnly(win, L, 'Reload')
    console.log(`window ${(await resize(l, 1280, 600)).content.join('×')} px`)
    await viewportOnly(win, L, 'resized down')
    console.log(`window ${(await resize(l, 1280, 800)).content.join('×')} px`)
    await viewportOnly(win, L, 'resized up')
    // Room again: a resize that keeps the row count reserves the overscan and the elastic part, and mounts them.
    await debugStats(win, { limit: 8 * GIB })
    await resize(l, 1200, 800)
    // Raw's height read with the reservation, not once after the resize: on macOS the window settles after setSize
    // returns (main-macos run 40097653559 read 509 px, then the lens reserved for a host of 581-600 px).
    const raw = () => win.evaluate(() => document.querySelector('.raw-host')!.clientHeight)
    const full = (host: number) => capFor(L, 3 * Math.ceil(host / 20) + 1)
    await expect.poll(async () => (await cacheStats(win))?.reserved === full(await raw()), { timeout: 30_000 }).toBe(true)
    const host = await raw()
    await expect.poll(() => win.evaluate(() => document.querySelectorAll('.vl-row').length)).toBeGreaterThan(Math.ceil(host / 20) + 1)
    expect(l.pageErrors).toEqual([])
    await finish(l)
  } finally {
    rmSync(path, { force: true })
  }
})

/** The lens on screen has its reservation settled, and the core holds exactly that for it. */
async function holdsItsReservation(win: Page): Promise<boolean> {
  const [s, { ledger }] = [await cacheStats(win), await debugStats(win)]
  return s !== null && s.reserved > 0 && s.reserved === ledger.rendererCache
}

/**
 * Z34's "keeps Raw" and Z47 (plan C1): a Reload the ledger can't hold is refused and leaves the document, its lens and
 * the lens's reservation at their generation, under a banner offering Retry. With room again, Retry reloads.
 */
test('a Reload the ledger refuses keeps Raw at its generation, with a banner, and Retry reloads once there is room', async () => {
  const path = fixture('reload-refused.txt', HEAD)
  try {
    const l = await launch({ hooks: true, file: path })
    const { win } = l
    await waitOpen(win)
    await waitIndexed(win)
    await expect.poll(() => holdsItsReservation(win)).toBe(true)
    const { ledger } = await debugStats(win)
    await debugStats(win, { limit: ledger.used + (1 << 20) }) // no room for the next generation's floor
    await win.locator('.vl-scroller').focus()
    await win.keyboard.press('F5')
    await expect(win.locator('.banner')).toHaveText("Can't reload: Typose's memory budget is full · Retry (Ctrl+R)")
    await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '1')
    const after = await debugStats(win)
    expect(after.docs).toBe(1)
    expect(after.ledger.used).toBeLessThanOrEqual(ledger.used) // the refusal took nothing (the banner's height can give back rows)
    const rows = await visibleRows(win)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.text === `line ${r.line - 1}`)).toBe(true) // still showing, gutter numbers from 1
    const s = (await cacheStats(win))!
    expect(s.charged).toBeLessThanOrEqual(s.reserved)
    expect((await debugStats(win)).ledger.rendererCache).toBe(s.reserved) // given back to the lens that stayed
    await debugStats(win, { limit: ledger.limit })
    await win.locator('.banner-button').click()
    await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
    await expect(win.locator('.banner')).toHaveCount(0)
    expect(l.pageErrors).toEqual([])
    await finish(l)
  } finally {
    rmSync(path, { force: true })
  }
})

/**
 * Plan C1: Reloads never overlap at the core. A second F5 while a Reload is under way starts none: overlapping ones
 * could leave the renderer cache's reservation with the wrong lens.
 */
test('a second F5 while a Reload is under way starts no second Reload', async () => {
  const path = fixture('reload-twice.txt', HEAD)
  try {
    const l = await launch({ hooks: true, file: path })
    const { win } = l
    await waitOpen(win)
    // Every `reload` the page sends is counted, and the first reaches the core 1 s late: the second F5 lands meanwhile.
    await win.evaluate(() => {
      const w = window as unknown as { reloads: number }
      w.reloads = 0
      const post = MessagePort.prototype.postMessage
      MessagePort.prototype.postMessage = function (this: MessagePort, message: unknown, ...rest: never[]) {
        if ((message as { method?: string })?.method !== 'reload') return post.call(this, message, ...rest)
        if (w.reloads++ > 0) return post.call(this, message, ...rest)
        setTimeout(() => post.call(this, message, ...rest), 1000)
      } as typeof post
    })
    await win.locator('.vl-scroller').focus()
    await win.keyboard.press('F5')
    await win.waitForTimeout(200)
    await win.keyboard.press('F5')
    await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
    expect(await win.evaluate(() => (window as unknown as { reloads: number }).reloads)).toBe(1)
    await expect.poll(() => holdsItsReservation(win)).toBe(true) // the new lens's
    expect(l.pageErrors).toEqual([])
    await finish(l)
  } finally {
    rmSync(path, { force: true })
  }
})

/** A core call from the page, as the renderer's client makes it: its result, or its error's code. */
async function core<T>(win: Page, method: string, params: object): Promise<{ ok: T } | { code: string }> {
  return win.evaluate(
    async ([method, params]) => {
      try {
        return { ok: await (window as unknown as { typoseTest: TestHooks }).typoseTest.core.call(method, params) }
      } catch (e) {
        return { code: (e as { code: string }).code }
      }
    },
    [method, params] as const
  ) as Promise<{ ok: T } | { code: string }>
}

const GIB = 2 ** 30
const LINE = 100
const LINES = 81_920 // 8,192,000 bytes a document
const HEAD = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n'
const lineText = (i: number) => `${i}`.padEnd(LINE - 1, '.')

/** One cycle's account, for comparing cycles. */
interface Cycle {
  refused: string | null
  /** The documents' charges: the frozen one's, then each one's once indexed, when its checkpoints' room ahead is back. */
  floors: number[]
  high: number
  limit: number
  baseline: number
  /** The core host's private bytes after a forced GC, once everything has closed. */
  private?: number
}

/**
 * One launch: `cycles` cycles, each closing a document mid-index and truncating another mid-index (C6: what each
 * releases), then opening and indexing documents one at a time until the ledger refuses the next, then closing them all.
 */
async function exhaust(docs: string[], budget: number | null, cycles: number): Promise<{ cycles: Cycle[]; openTemp: number }> {
  const l = await launch({ hooks: true, env: budget ? { TYPOSE_TEST_BUDGET: String(budget) } : {} })
  const { win } = l
  await expect(win.locator('.open-button')).toHaveText('Open file…') // the empty card: no lens, so no cache reserved
  const hello = await core<{ limits: { openTemp: number } }>(win, 'hello', { protocol: 1 })
  if (!('ok' in hello)) throw new Error(`hello: ${hello.code}`)
  const open = async (path: string) => {
    const opened = await core<Opened>(win, 'open', { path, count: 64, bytes: 0 }) // no lens: no view to reserve
    return 'ok' in opened ? opened.ok : opened.code
  }
  const jobs = (n: number) => expect.poll(async () => (await debugStats(win)).jobs, { intervals: [5], timeout: 30_000 }).toBe(n)
  const out: Cycle[] = []
  for (let cycle = 0; cycle < cycles; cycle++) {
    const [closing, truncating] = ['exhaust-close.txt', 'exhaust-truncate.txt'].map((name) => sparseFixture(name, 10 * GIB, HEAD))
    try {
      const baseline = (await debugStats(win, { resetHigh: true })).ledger.used
      // C6: close mid-index returns every reservation.
      const a = await open(closing)
      if (typeof a === 'string') throw new Error(`open: ${a}`)
      await jobs(1)
      await core(win, 'close', { doc: a.doc })
      await jobs(0)
      expect((await debugStats(win)).ledger.used).toBe(baseline)
      // C6: a truncation mid-index freezes the document, which keeps exactly its charges.
      const t = await open(truncating)
      if (typeof t === 'string') throw new Error(`open: ${t}`)
      await jobs(1)
      truncateSync(truncating, 2 ** 20)
      await jobs(0)
      const frozen = await debugStats(win)
      expect(frozen.ledger.used).toBe(baseline + frozen.charges[t.doc].total)
      // Documents one at a time, each indexed before the next, until the ledger refuses one.
      const floors = [frozen.charges[t.doc].total]
      const opened = [t.doc]
      let refused: string | null = null
      for (const path of docs) {
        const before = (await debugStats(win)).ledger.used
        const d = await open(path)
        if (typeof d === 'string') {
          refused = d
          expect((await debugStats(win)).ledger.used).toBe(before) // the refused open changed nothing
          break
        }
        opened.push(d.doc)
        expect(d.firstPage.items[0]).toMatchObject({ line: 0, text: lineText(0) }) // Raw's first screen
        await jobs(0)
        floors.push((await debugStats(win)).charges[d.doc].total)
        const last = await core<CorePage>(win, 'page', { doc: d.doc, lens: 'raw', gen: 1, start: LINES - 1, count: 1 })
        expect(last).toMatchObject({ ok: { items: [{ line: LINES - 1, text: lineText(LINES - 1) }] } })
        const middle = await core<CorePage>(win, 'page', { doc: d.doc, lens: 'raw', gen: 1, start: LINES / 2, count: 64 })
        expect(middle).toMatchObject({ ok: { items: expect.arrayContaining([expect.objectContaining({ line: LINES / 2 })]) } })
      }
      // Every document indexed before the refusal still reads.
      for (const doc of opened.slice(1)) expect(await core(win, 'page', { doc, lens: 'raw', gen: 1, start: LINES - 64, count: 64 })).toHaveProperty('ok')
      const full = await debugStats(win)
      for (const doc of opened) await core(win, 'close', { doc })
      const after = await debugStats(win, { gc: true })
      expect(after).toMatchObject({ jobs: 0, tasks: 0, handles: 0, docs: 0 })
      expect(after.ledger.used).toBe(baseline) // byte-exact
      const coreHost = (await processMemory(l.app)).find((p) => p.name === 'typose-core')!
      out.push({ refused, floors, high: full.ledger.high, limit: full.ledger.limit, baseline: after.ledger.used, private: coreHost.private })
    } finally {
      for (const path of [closing, truncating]) rmSync(path, { force: true })
    }
  }
  expect(l.pageErrors).toEqual([])
  await finish(l)
  return { cycles: out, openTemp: hello.ok.limits.openTemp }
}

/**
 * Plan C1's deterministic multi-document exhaustion test (Z47), under the test-hooks budget override. Three cycles: the
 * floors, the high-water mark and the baseline are identical, and the core host's private bytes after a forced GC
 * differ by ≤ 16 MiB between cycles 2 and 3.
 */
test('a deterministic multi-document exhaustion test: 3 cycles under the budget override', async () => {
  test.setTimeout(10 * 60_000)
  const body = Array.from({ length: LINES }, (_, i) => lineText(i)).join('\n') + '\n'
  const docs = Array.from({ length: 6 }, (_, i) => fixture(`exhaust-${i}.txt`, body))
  try {
    // A calibration run, without the override, measures one cycle's charges. The budget then holds the pool, the frozen
    // document and four indexed ones, with half a floor to spare: the fifth open, its floor and temporaries, is refused.
    const calibration = await exhaust(docs, null, 1)
    const [{ floors, baseline: pool }] = calibration.cycles
    expect(floors.length).toBe(1 + docs.length) // without the override, nothing was refused
    const budget = Math.floor(pool + floors[0] + 4 * floors[1] + calibration.openTemp + floors[1] / 2)
    const { cycles } = await exhaust(docs, budget, 3)
    for (const [i, c] of cycles.entries())
      console.log(`cycle ${i + 1}: ${c.floors.length} open, then ${c.refused}; charges ${c.floors.join(', ')}; high ${c.high} of ${c.limit}; baseline ${c.baseline}; core host private after GC ${mib(c.private)}`)
    for (const c of cycles) {
      expect(c.refused).toBe('Memory')
      expect(c.floors.length).toBe(5) // the frozen document and four indexed ones
      expect(c.high).toBeLessThanOrEqual(c.limit) // Z34
      expect([c.floors, c.high, c.baseline]).toEqual([cycles[0].floors, cycles[0].high, cycles[0].baseline])
    }
    if (cycles[1].private === undefined) console.log('private bytes: not reported by Electron on this OS; nothing judged')
    else expect(Math.abs(cycles[2].private! - cycles[1].private)).toBeLessThanOrEqual(16 << 20)
  } finally {
    for (const path of docs) rmSync(path, { force: true })
  }
})

/**
 * PR 6's memory metrics (plan §5), each on its own and none standing in for another: on 1 GiB, the resident memory
 * summed across processes is < 1 GiB (Spike A's gate); on 1 GiB and 10 GiB the ledger is ≤ its limit (Z34), and private
 * bytes, working set or RSS, and PSS where the OS reports it are logged per process and summed. Measured after an open,
 * a full index and reading across the file, without a forced GC: what a reader's session holds.
 */
for (const size of ['1 GiB', '10 GiB'] as const) {
  test(`memory metrics on the ${size} fixture`, async () => {
    test.setTimeout(10 * 60_000)
    const path =
      size === '1 GiB'
        ? join(FIXTURES, 'memory-1gib.jsonl')
        : sparseFixture('memory-10gib.txt', 10 * GIB, HEAD) // sparse: what's indexed is real, the disk holds little
    try {
      if (size === '1 GiB')
        execFileSync('cargo', ['run', '--release', '-q', '-p', 'fixtures-gen', '--', 'jsonl', '--out', path, '--bytes', String(GIB), '--line', '200'], {
          cwd: resolve(__dirname, '../core'),
          stdio: 'inherit'
        })
      const l = await launch({ hooks: true, file: path })
      const { win } = l
      await waitOpen(win)
      await waitIndexed(win, 5 * 60_000)
      const scroller = win.locator('.vl-scroller')
      await scroller.focus()
      for (const key of ['Control+End', ...Array(10).fill('PageUp'), 'Control+Home', ...Array(10).fill('PageDown')]) {
        await win.keyboard.press(key)
        await win.waitForTimeout(50)
      }
      await expect.poll(async () => (await visibleRows(win)).every((r) => r.text.length > 0)).toBe(true)
      const { ledger } = await debugStats(win)
      const all = await processMemory(l.app)
      const total = summed(all)
      const row = (p: { private?: number; resident: number; pss?: number }) => `private ${mib(p.private)}, resident ${mib(p.resident)}, PSS ${mib(p.pss)}`
      for (const p of all) console.log(`${size}: ${p.type}${p.name ? ` (${p.name})` : ''}: ${row(p)}`)
      console.log(`${size}: summed: ${row(total)}; ledger ${mib(ledger.used)} of its limit ${mib(ledger.limit)} (renderer cache ${mib(ledger.rendererCache)}, pool ${mib(ledger.pool)})`)
      expect(ledger.used).toBeLessThanOrEqual(ledger.limit) // Z34
      if (size === '1 GiB') expect(total.resident).toBeLessThan(GIB) // Spike A's gate
      expect(l.pageErrors).toEqual([])
      await finish(l)
    } finally {
      rmSync(path, { force: true })
    }
  })
}

/**
 * Plan C1: an open the ledger can't hold is refused with `Memory`, and the card says so (plan §7 proposal 1, PR 4's
 * card). The budget override holds the pool and 1 MiB more, so neither a 10 GiB document's floor (≈ 4.31 MiB) nor its
 * view's fits; or 40 MiB more, so the document's would, and only the view's floor, the viewport-only cache cap, doesn't.
 */
for (const over of [1, 40])
  test(`an open with the pool and ${over} MiB as its budget shows the memory-refused card, and the ledger doesn't change`, () => refusedOpen(over))

async function refusedOpen(over: number): Promise<void> {
  const probe = await launch({ hooks: true })
  await expect(probe.win.locator('.open-button')).toHaveText('Open file…')
  const pool = (await debugStats(probe.win)).ledger.pool
  await finish(probe)
  const path = sparseFixture('memory-refused.txt', 10 * GIB, HEAD)
  try {
    const l = await launch({ hooks: true, file: path, env: { TYPOSE_TEST_BUDGET: String(pool + over * (1 << 20)) } })
    await expect(l.win.locator('.card-state p')).toHaveText("Can't open memory-refused.txt · Typose's memory budget is full. Close a file, then Retry.")
    await expect(l.win.locator('.card-state .open-button')).toHaveText(['Retry', 'Close'])
    expect(await debugStats(l.win)).toMatchObject({ docs: 0, handles: 0, jobs: 0, ledger: { used: pool, rendererCache: 0 } })
    expect(l.pageErrors).toEqual([])
    await finish(l)
  } finally {
    rmSync(path, { force: true })
  }
}
