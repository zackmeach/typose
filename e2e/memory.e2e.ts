// Plan C1 and PR 6's memory acceptance, on the test-hooks build: the renderer cache's reservation, the deterministic
// multi-document exhaustion test, the memory metrics, and the refusal on open. Memory is read per process
// (`memory.ts`), every metric on its own.
import { type Page, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync, truncateSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MOUNTED_PER_UNIT } from '../app/renderer/lenses/page-cache'
import type { Opened, Page as CorePage } from '../app/shared/protocol'
import { FIXTURES, type TestHooks, debugStats, finish, fixture, launch, sparseFixture, test, visibleRows, waitIndexed, waitOpen } from './app'
import { mib, processMemory, summed } from './memory'

type CacheStats = { charged: number; cap: number; reserved: number }
type Hooked = { typoseTest: TestHooks & { client: { cache: (() => CacheStats) | null } } }
const cacheStats = (win: Page) => win.evaluate(() => (window as unknown as Hooked).typoseTest.client.cache?.() ?? null)

test("10 viewports of 64 KiB CJK lines in a 2160 px window raise the renderer's private bytes by ≤ its cache's reservation + 32 MiB", async () => {
  test.setTimeout(5 * 60_000)
  // 1,300 lines of 65,535 bytes: 21,845 three-byte characters each, so every line is one whole piece.
  const path = fixture('cjk-64k.txt', Array.from({ length: 1300 }, () => '語'.repeat(21_845)).join('\n') + '\n')
  const l = await launch({ hooks: true, file: path })
  try {
    const { win } = l
    // The tallest the rig allows, recorded: the OS may hold a window to its screen.
    const size = await l.app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(1280, 2160)
      return { content: w.getContentSize(), screen: screen.getPrimaryDisplay().workAreaSize }
    })
    await waitOpen(win)
    await waitIndexed(win)
    const host = await win.evaluate(() => document.querySelector('.raw-host')!.clientHeight)
    console.log(`window content ${size.content.join('×')} px (screen work area ${size.screen.width}×${size.screen.height}); Raw ${host} px tall`)
    // The cap for a viewport and one more each way (plan C1), once the lens has reserved it for this height.
    const rows = 3 * Math.ceil(host / 20) + 1
    const cap = rows * (2 * 65_536 + 393_224 + MOUNTED_PER_UNIT * 65_536) + (16 << 20)
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
      // Each 64 KiB CJK row is a long run of text to lay out: a viewport of them takes seconds to fill here.
      await expect.poll(async () => (await visibleRows(win)).filter((r) => r.text.length !== 21_845).length, { timeout: 60_000 }).toBe(0)
      const s = (await cacheStats(win))!
      expect(s.charged, JSON.stringify(s)).toBeLessThanOrEqual(s.cap)
      peak = Math.max(peak, (await renderer()).private ?? 0)
    }
    const s = (await cacheStats(win))!
    console.log(`renderer private bytes ${mib(before.private)} before, peak ${mib(peak)}; cache charged ${mib(s.charged)} of its cap ${mib(s.cap)}, reserved ${mib(s.reserved)}`)
    if (before.private === undefined) {
      console.log('private bytes: not reported by Electron on this OS; nothing judged') // macOS: never replaced by RSS
    } else {
      expect(peak - before.private).toBeLessThanOrEqual(s.reserved + (32 << 20))
    }
    expect(l.pageErrors).toEqual([])
  } finally {
    await finish(l)
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
  /** The documents' charges once open: the frozen one's, then each indexed one's floor. */
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
    const opened = await core<Opened>(win, 'open', { path, count: 64 })
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
        floors.push((await debugStats(win)).charges[d.doc].total)
        opened.push(d.doc)
        expect(d.firstPage.items[0]).toMatchObject({ line: 0, text: lineText(0) }) // Raw's first screen
        await jobs(0)
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
 * card). The budget override holds the pool and 1 MiB more, so a 10 GiB document's floor (≈ 4.31 MiB) doesn't fit.
 */
test("an open past the budget shows the memory-refused card, and the ledger doesn't change", async () => {
  const probe = await launch({ hooks: true })
  await expect(probe.win.locator('.open-button')).toHaveText('Open file…')
  const pool = (await debugStats(probe.win)).ledger.pool
  await finish(probe)
  const path = sparseFixture('memory-refused.txt', 10 * GIB, HEAD)
  try {
    const l = await launch({ hooks: true, file: path, env: { TYPOSE_TEST_BUDGET: String(pool + (1 << 20)) } })
    await expect(l.win.locator('.card-state p')).toHaveText("Can't open memory-refused.txt · Typose's memory budget is full. Close a file, then Retry.")
    await expect(l.win.locator('.card-state .open-button')).toHaveText(['Retry', 'Close'])
    expect(await debugStats(l.win)).toMatchObject({ docs: 0, handles: 0, jobs: 0, ledger: { used: pool, rendererCache: 0 } })
    expect(l.pageErrors).toEqual([])
    await finish(l)
  } finally {
    rmSync(path, { force: true })
  }
})
