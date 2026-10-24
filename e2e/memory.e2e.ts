// Plan C1 and PR 6's memory acceptance, on the test-hooks build: the renderer cache's reservation, under a budget that
// holds only the viewport too, the deterministic multi-document exhaustion test, the memory metrics, and the refusal on
// open. Memory is read per process (`memory.ts`), every metric on its own.
import { type Page, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync, statSync, truncateSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MOUNTED_PER_UNIT } from '../app/renderer/lenses/page-cache'
import type { Opened, Page as CorePage } from '../app/shared/protocol'
import { FIXTURES, type Launched, type TestHooks, debugStats, finish, fixture, launch, sparseFixture, test, visibleRows, waitIndexed, waitOpen } from './app'
import { mib, processMemory, summed } from './memory'

type CacheStats = { charged: number; cap: number; reserved: number }
type Hooked = { typoseTest: TestHooks & { client: { cache: (() => CacheStats) | null } } }
const cacheStats = (win: Page) => win.evaluate(() => (window as unknown as Hooked).typoseTest.client.cache?.() ?? null)

/** The most a mounted row costs (plan C1's formula, with C2's bounds): a whole 64 KiB piece and its layout. */
const ROW = 2 * 65_536 + 393_224 + MOUNTED_PER_UNIT * 65_536
/** 400 lines of 70,000 ASCII bytes: each row shows a first piece of 65,536 units, the most a row holds. */
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

const BOUND = "raise the renderer's private bytes by ≤ its cache's reservation + 32 MiB"
const GATES: { title: string; height: number; units: number; file: () => string; judged: boolean }[] = [
  // 1,300 lines of 65,535 bytes: 21,845 three-byte characters each, so every line is one whole piece.
  {
    title: `10 viewports of 64 KiB CJK lines in a 2160 px window ${BOUND}`,
    height: 2160,
    units: 21_845,
    file: () => fixture('cjk-64k.txt', Array.from({ length: 1300 }, () => '語'.repeat(21_845)).join('\n') + '\n'),
    judged: true
  },
  // A unit a byte, so a row holds 65,536 units: the most C2 allows. A small window keeps CI's layout time down. Logged,
  // not judged: its peak without a GC is mostly garbage not yet collected, and varies about 2× between runs (CI rose
  // 113.8 MiB on Windows and 194.8 MiB on Linux; local runs, 311–533 MiB). PR 6b asserts it, with a method that holds.
  { title: "10 viewports of 64 KiB ASCII rows in a 400 px window: the renderer's private bytes, logged for PR 6b", height: 400, units: 65_536, file: ascii64k, judged: false }
]

for (const g of GATES) test(g.title, () => rendererGate(g))

async function rendererGate(g: (typeof GATES)[number]): Promise<void> {
  test.setTimeout(5 * 60_000)
  const path = g.file()
  const l = await launch({ hooks: true, file: path })
  try {
    const { win } = l
    // The tallest the rig allows, recorded: the OS may hold a window to its screen.
    const size = await resize(l, 1280, g.height)
    await waitOpen(win)
    await waitIndexed(win)
    const host = await win.evaluate(() => document.querySelector('.raw-host')!.clientHeight)
    console.log(`window content ${size.content.join('×')} px (screen work area ${size.screen.width}×${size.screen.height}); Raw ${host} px tall`)
    // The cap for a viewport and one more each way (plan C1), once the lens has reserved it for this height.
    const rows = 3 * Math.ceil(host / 20) + 1
    const cap = rows * ROW + (16 << 20)
    await expect.poll(async () => (await cacheStats(win))?.reserved, { timeout: 10_000 }).toBe(cap)
    expect((await debugStats(win)).ledger.rendererCache).toBe(cap) // the core holds it in the ledger
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('HeapProfiler.collectGarbage')
    const renderer = async () => (await processMemory(l.app)).find((p) => p.type === 'Tab')!
    const before = await renderer()
    let peak = before.private ?? 0
    await win.locator('.vl-scroller').focus()
    for (let i = 0; i < 10; i++) {
      await win.keyboard.press('PageDown')
      // Each 64 KiB row is a long run of text to lay out: a viewport of them takes seconds to fill here.
      await expect.poll(async () => (await visibleRows(win)).filter((r) => r.text.length !== g.units).length, { timeout: 60_000 }).toBe(0)
      const s = (await cacheStats(win))!
      expect(s.charged, JSON.stringify(s)).toBeLessThanOrEqual(s.cap)
      peak = Math.max(peak, (await renderer()).private ?? 0)
    }
    const s = (await cacheStats(win))!
    console.log(`renderer private bytes ${mib(before.private)} before, peak ${mib(peak)}; cache charged ${mib(s.charged)} of its cap ${mib(s.cap)}, reserved ${mib(s.reserved)}`)
    if (before.private === undefined) {
      console.log('private bytes: not reported by Electron on this OS; nothing judged') // macOS: never replaced by RSS
    } else if (!g.judged) {
      console.log(`a rise of ${mib(peak - before.private)} against ${mib(s.reserved + (32 << 20))}: logged for PR 6b, not judged`)
    } else {
      expect(peak - before.private).toBeLessThanOrEqual(s.reserved + (32 << 20))
    }
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
async function viewportOnly(win: Page, step: string): Promise<void> {
  const view = () =>
    win.evaluate(() => ({
      host: document.querySelector('.raw-host')!.clientHeight,
      viewport: document.querySelector('.vl-scroller')!.clientHeight,
      mounted: document.querySelectorAll('.vl-row').length
    }))
  await expect.poll(async () => (await cacheStats(win))?.reserved === (Math.ceil((await view()).host / 20) + 1) * ROW, { timeout: 30_000 }).toBe(true)
  const shown = async () => {
    const rows = await visibleRows(win)
    return rows.length >= Math.floor((await view()).viewport / 20) && rows.every((r) => r.text.length === 65_536)
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
    const hello = await core<{ limits: { openTemp: number } }>(probe.win, 'hello', { protocol: 1 })
    if (!('ok' in hello)) throw new Error(`hello: ${hello.code}`)
    const { ledger, charges } = await debugStats(probe.win)
    const inner = await probe.win.evaluate(() => window.innerHeight)
    await finish(probe)
    const floor = (Math.ceil(inner / 20) + 1) * ROW // the open's viewport-only cap, at the window's height
    const budget = ledger.pool + charges[1].total + hello.ok.limits.openTemp + floor + statSync(path).size + ROW
    console.log(`budget ${mib(budget)}: pool ${mib(ledger.pool)}, document ${mib(charges[1].total)}, view ${mib(floor)} (${inner} px of window)`)
    const l = await launch({ hooks: true, file: path, env: { TYPOSE_TEST_BUDGET: String(budget) } })
    const { win } = l
    await waitOpen(win)
    await viewportOnly(win, 'open')
    await win.locator('.vl-scroller').focus()
    await win.keyboard.press('F5')
    await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
    await viewportOnly(win, 'Reload')
    console.log(`window ${(await resize(l, 1280, 600)).content.join('×')} px`)
    await viewportOnly(win, 'resized down')
    console.log(`window ${(await resize(l, 1280, 800)).content.join('×')} px`)
    await viewportOnly(win, 'resized up')
    // Room again: a resize that keeps the row count reserves the overscan and the elastic part, and mounts them.
    await debugStats(win, { limit: 8 * GIB })
    await resize(l, 1200, 800)
    // Raw's height read with the reservation, not once after the resize: on macOS the window settles after setSize
    // returns (main-macos run 40097653559 read 509 px, then the lens reserved for a host of 581-600 px).
    const raw = () => win.evaluate(() => document.querySelector('.raw-host')!.clientHeight)
    const full = (host: number) => (3 * Math.ceil(host / 20) + 1) * ROW + (16 << 20)
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
