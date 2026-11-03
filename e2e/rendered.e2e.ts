// Plan (Rendered Markdown slice) PR 2: the Rendered lens, the switch, file states, accessibility and the
// sanitizer's DOM. Links stay inert. Speculative DNS is off; the control withholds that and shows the NetLog catch it.
import AxeBuilder from '@axe-core/playwright'
import { type Page, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RENDERED_OFF } from '../app/renderer/card'
import { viewportCap } from '../app/renderer/lenses/page-cache'
import type { Limits } from '../app/shared/protocol'
import { type TestHooks, assertNetLog, debugStats, expectReleasedDocuments, finish, fixture, launch, lifecycle, stubExternal, test, visibleRows, waitIndexed, waitOpen, workspaceHeld } from './app'
import { command } from './find-ui'

type ReserveProbe = { held: boolean; bRendered: boolean; release?: () => void }
type ShrinkProbe = { held: boolean; bytes?: number; release?: () => void }
type PauseProbe = { held: boolean; release?: () => void }
type ReserveWindow = Window & { renderReserveProbe?: ReserveProbe; shrinkReserveProbe?: ShrinkProbe; renderPause?: PauseProbe }

/** Pause a real render request or its following reservation response; neither result is forged. */
async function pauseRender(win: Page, where: 'request' | 'reserve-response'): Promise<void> {
  await win.evaluate((where) => {
    const core = (window as unknown as {
      typoseTest: { core: { call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> } }
    }).typoseTest.core
    const state: PauseProbe = { held: false }
    ;(window as unknown as ReserveWindow).renderPause = state
    const call = core.call.bind(core)
    let rendered = false
    let claimed = false
    const pause = async () => {
      state.held = true
      await new Promise<void>((done) => { state.release = done })
    }
    core.call = async (method, params, signal) => {
      const selected = !claimed && (where === 'request' ? method === 'render' : method === 'reserve' && rendered)
      if (selected) claimed = true
      if (selected && where === 'request') await pause()
      const reply = await call(method, params, signal)
      if (method === 'render') rendered = true
      if (selected && where === 'reserve-response') await pause()
      return reply
    }
  }, where)
}

const SAMPLE = [
  '# Heading one',
  '',
  'A paragraph with **bold** and a [link](https://example.invalid/a).',
  '',
  '## Heading two',
  '',
  '### Heading three',
  '',
  '#### Heading four',
  '',
  '##### Heading five',
  '',
  '###### Heading six',
  '',
  '- item',
  '- [ ] open task',
  '- [x] done task',
  '',
  '> a quote',
  '',
  '| h | i |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```',
  'code fence',
  '```',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i} wraps.\n`)
].join('\n')

/** Spike C's payloads, as the core's test lists them (`md.rs`), unescaped from the Rust string. */
function rustStrings(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`)
  const end = source.indexOf('];', start)
  const body = source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  const out: string[] = []
  for (const m of body.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    out.push(m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  return out
}

/** The same seven contexts as the core's corpus test, after a heading so none of it is front matter. */
function corpusFile(): string {
  const src = readFileSync(join(__dirname, '../core/typose-core/src/md.rs'), 'utf8')
  const payloads = [...rustStrings(src, 'HOSTILE'), ...rustStrings(src, 'PLANTED'), ...rustStrings(src, 'NAV_PROBES')]
  expect(payloads.length).toBeGreaterThan(80)
  const contexts = (p: string) => [`intro\n\n${p}\n`, `x ${p} y\n`, `- ${p}\n`, `> ${p}\n`, `| a |\n| --- |\n| ${p} |\n`, `# ${p}\n`, `---\n${p}\n---\n`]
  return fixture('corpus.md', ['# Corpus', '', ...payloads.flatMap(contexts)].join('\n'))
}

async function waitRendered(win: Page): Promise<void> {
  await expect(win.locator('.md-scroller')).toBeAttached({ timeout: 30_000 })
  await expect(win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
}

/** The block at the top of the Rendered view, and the source lines it covers (1-based, like Raw's gutter). */
async function topBlock(win: Page): Promise<{ line: number; end: number }> {
  return win.evaluate(() => {
    const scroller = document.querySelector('.md-scroller')!
    const edge = scroller.getBoundingClientRect().top
    const blocks = [...document.querySelectorAll<HTMLElement>('.md-block')]
    const block = blocks.find((b) => b.getBoundingClientRect().bottom > edge + 1) ?? blocks[0]
    const line = Number(block.dataset.line) + 1
    return { line, end: line + Number(block.dataset.lines) - 1 }
  })
}

async function axe(win: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page: win }).setLegacyMode().analyze()
  return violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
}

test('a Markdown file opens in Rendered, and Raw keeps the top line within one block', async () => {
  const l = await launch({ file: fixture('sample.md', SAMPLE) })
  const { win } = l
  await waitRendered(win)
  await expect(win.locator('main h1')).toHaveText('Heading one')
  for (const level of [1, 2, 3, 4, 5, 6]) await expect(win.locator(`main h${level}`)).toHaveCount(1)
  await expect(win.locator('main ul li')).toHaveCount(3)
  await expect(win.locator('main table')).toHaveCount(1)
  await expect(win.locator('main th')).toHaveCount(2)
  await expect(win.locator('main td')).toHaveCount(2)
  await expect(win.locator('main input[type="checkbox"]')).toHaveCount(2)
  await expect(win.locator('main a')).toHaveAttribute('href', '#')
  await expect(win.locator('main a')).toHaveAttribute('title', 'https://example.invalid/a')
  await expect(win.getByRole('tablist', { name: 'Lens' })).toBeVisible()
  await expect(win.getByRole('tab', { name: 'Rendered', exact: true })).toHaveAttribute('aria-selected', 'true')
  // Offscreen blocks stay mounted and skip their paint, except a heading's (plan §2.2). Linux's accessibility mode is
  // always on, so there every block paints (Z92).
  const visibility = await win.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>('.md-block')]
    const below = blocks.find((b) => b.getBoundingClientRect().top > innerHeight && !b.querySelector('h1, h2, h3, h4, h5, h6'))
    return { count: blocks.length, below: below ? getComputedStyle(below).contentVisibility : '' }
  })
  expect(visibility.count).toBeGreaterThan(10)
  expect(visibility.below).toBe(process.platform === 'linux' ? 'visible' : 'auto')

  const scroller = win.locator('.md-scroller')
  await scroller.evaluate((el) => {
    const block = el.querySelectorAll<HTMLElement>('.md-block')[8]
    el.scrollTop = block.offsetTop
  })
  const before = await topBlock(win)
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await expect(win.locator('.raw-host')).toBeAttached()
  const rawTop = (await visibleRows(win))[0].line
  expect(rawTop).toBeGreaterThanOrEqual(before.line)
  expect(rawTop).toBeLessThanOrEqual(before.end)
  await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
  await waitRendered(win)
  const after = await topBlock(win)
  expect(after.line).toBeLessThanOrEqual(rawTop)
  expect(after.end).toBeGreaterThanOrEqual(rawTop)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a non-Markdown file has no switch, and an empty Markdown file says Empty file', async () => {
  const text = await launch({ file: fixture('plain.txt', 'hello\n') })
  await waitOpen(text.win)
  await expect(text.win.getByRole('tablist', { name: 'Lens', exact: true })).toHaveCount(0)
  await finish(text)
  const empty = await launch({ file: fixture('empty.md', '') })
  await expect(empty.win.locator('.card-message')).toHaveText('Empty file')
  await expect(empty.win.getByRole('tablist', { name: 'Lens', exact: true })).toHaveCount(0)
  await finish(empty)
})

test('a file over the ceiling opens in Raw, with Rendered disabled and the reason in its tooltip', async () => {
  const l = await launch({ file: fixture('over.md', 'a'.repeat((8 << 20) + 1)) })
  const { win } = l
  await waitOpen(win)
  const rendered = win.getByRole('tab', { name: 'Rendered', exact: true })
  await expect(rendered).toBeDisabled()
  await expect(rendered.getByTitle(RENDERED_OFF.ceiling)).toBeVisible()
  await expect(win.locator('.md-scroller')).toHaveCount(0)
  await expect(win.locator('.vl-row .text').first()).toBeAttached()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Ctrl+R keeps the reader on the same block', async () => {
  const l = await launch({ file: fixture('reload.md', SAMPLE) })
  const { win } = l
  await waitRendered(win)
  await win.locator('.md-scroller').evaluate((el) => {
    const block = el.querySelectorAll<HTMLElement>('.md-block')[6]
    el.scrollTop = block.offsetTop
  })
  const before = await topBlock(win)
  await win.locator('.md-scroller').focus()
  await win.keyboard.press(command + '+r')
  await expect(win.locator('[data-lens="rendered"]')).toHaveAttribute('data-gen', '2')
  await waitRendered(win)
  const after = await topBlock(win)
  expect(after.line).toBeLessThanOrEqual(before.end)
  expect(after.end).toBeGreaterThanOrEqual(before.line)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a second file opens at its start, not at the line the previous file was scrolled to', async () => {
  // The lens host keeps one reading position for the switch and Reload. A later file must not inherit it.
  // `open-path` is what a second launch delivers (main). No Open dialog, and no real pointer or key.
  const body = (name: string) => Array.from({ length: 400 }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n'
  const l = await launch({ file: fixture('place-a.txt', body('A')) })
  const { win } = l
  await waitOpen(win)
  await waitIndexed(win)
  await win.locator('.vl-scroller').evaluate((el) => {
    el.scrollTop = 200 * 20 // line 201; Raw's row is 20px
  })
  await expect.poll(async () => (await visibleRows(win))[0]).toEqual({ line: 201, text: 'A line 201' })
  const second = fixture('place-b.txt', body('B'))
  await l.app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0].webContents.send('open-path', path)
  }, second)
  await expect(win.locator('.card-name')).toHaveText('place-b.txt')
  await waitOpen(win)
  await waitIndexed(win)
  // The index has to know line 201 before a restored position can scroll there. Read the top after that.
  await expect.poll(() => win.locator('.vl-scroller').evaluate((el) => el.scrollHeight)).toBeGreaterThan(200 * 20)
  const after = (await visibleRows(win))[0]
  console.log(`file A top line 201; file B top line ${after?.line} (${after?.text})`)
  expect(after?.line).toBe(1)
  expect(after?.text).toBe('B line 1')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a different file after a core restart starts at its first line despite reused document ids', async () => {
  const body = (name: string) => Array.from({ length: 400 }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n'
  const l = await launch({ hooks: true, file: fixture('session-place-a.txt', body('A')) })
  const { win } = l
  await waitOpen(win)
  await waitIndexed(win)
  await win.locator('.vl-scroller').evaluate((el) => { el.scrollTop = 200 * 20 })
  await expect.poll(async () => (await visibleRows(win))[0]).toEqual({ line: 201, text: 'A line 201' })
  const spawned = lifecycle(l.userData).filter((r) => r.event === 'utility-spawn').at(-1)!
  process.kill(spawned.utilityPid as number)
  await expect(win.locator('.card-message p')).toHaveText("Typose's core stopped")
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), fixture('session-place-b.txt', body('B')))
  await expect(win.locator('.card-name')).toHaveText('session-place-b.txt')
  await waitOpen(win)
  await waitIndexed(win)
  await expect.poll(() => win.locator('.vl-scroller').evaluate((el) => el.scrollHeight)).toBeGreaterThan(200 * 20)
  await expect.poll(async () => (await visibleRows(win))[0]).toEqual({ line: 1, text: 'B line 1' })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a delayed old Rendered reservation response does not block a replacement file', async () => {
  const a = fixture('pending-reserve-a.md', '# A\n\nParagraph A.\n\n'.repeat(12))
  const b = fixture('pending-reserve-b.md', '# B\n\nParagraph B.\n\n'.repeat(12))
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await win.evaluate(({ a, b }) => {
    const core = (window as unknown as {
      typoseTest: { core: { call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> } }
    }).typoseTest.core
    const state: ReserveProbe = { held: false, bRendered: false }
    ;(window as unknown as ReserveWindow).renderReserveProbe = state
    const call = core.call.bind(core)
    let aDoc = 0
    let bDoc = 0
    let aRendered = false
    let delayed = false
    core.call = async (method, params, signal) => {
      // Hold the answer, after the core has acted. Only a request issued after A's render answer is eligible, so an
      // earlier Raw sizing request can't be mistaken for Rendered's reservation, whatever its charge formula is.
      const delay = method === 'reserve' && (params.view as { doc?: number } | undefined)?.doc === aDoc && aRendered && !delayed
      if (delay) delayed = true
      const result = await call(method, params, signal)
      if (method === 'open') {
        if (params.path === a) aDoc = (result as { doc: number }).doc
        if (params.path === b) bDoc = (result as { doc: number }).doc
      }
      if (method === 'render') {
        if (params.doc === aDoc) aRendered = true
        if (params.doc === bDoc) state.bRendered = true
      }
      if (delay) {
        state.held = true
        await new Promise<void>((done) => { state.release = done })
      }
      return result
    }
  }, { a, b })
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), a)
  await expect.poll(() => win.evaluate(() => (window as unknown as ReserveWindow).renderReserveProbe?.held)).toBe(true)
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), b)
  await expect(win.locator('.card-name')).toHaveText('pending-reserve-b.md')
  await expect.poll(() => win.evaluate(() => (window as unknown as ReserveWindow).renderReserveProbe?.bRendered)).toBe(true)
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await win.evaluate(() => (window as unknown as ReserveWindow).renderReserveProbe?.release?.())
  await waitRendered(win)
  await expect(win.getByRole('tab', { name: 'Rendered', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(win.locator('main h1').first()).toHaveText('B')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('reading Raw during a delayed Rendered reservation keeps Raw and releases the unmounted tree allowance', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await pauseRender(win, 'reserve-response')
  const file = fixture('read-during-reserve.md', Array.from({ length: 400 }, (_, i) => `Paragraph ${i}.\n\n`).join(''))
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), file)
  await expect.poll(() => win.evaluate(() => (window as unknown as ReserveWindow).renderPause?.held)).toBe(true)
  await waitOpen(win)
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('PageDown')
  await expect.poll(() => win.locator('.vl-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await win.evaluate(() => (window as unknown as ReserveWindow).renderPause!.release!())
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(win.getByRole('tab', { name: 'Raw', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(win.locator('.md-scroller')).toHaveCount(0)
  await expect.poll(async () => {
    const raw = await win.evaluate(() => (window as unknown as { typoseTest: { client: { cache: () => { reserved: number } } } }).typoseTest.client.cache())
    return (await debugStats(win)).ledger.rendererCache - raw.reserved - await workspaceHeld(win)
  }).toBe(0)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a render that detects a write after indexing freezes Raw with the Reload banner', async () => {
  const l = await launch({ hooks: true })
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await pauseRender(win, 'request')
  const file = fixture('write-before-render.md', '# First version\n\nA paragraph.\n')
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), file)
  await expect.poll(() => win.evaluate(() => (window as unknown as ReserveWindow).renderPause?.held)).toBe(true)
  await waitOpen(win)
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  writeFileSync(file, '# Other version\n\nA paragraph.\n')
  await win.evaluate(() => (window as unknown as ReserveWindow).renderPause!.release!())
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await expect(win.locator('.vl-row .text').first()).toContainText('# First version')
  await expect(win.locator('.md-scroller')).toHaveCount(0)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a write Raw finds raises the banner, and Rendered keeps what it showed', async () => {
  const lines = ['# Original heading', '', ...Array.from({ length: 400 }, (_, i) => `line ${i} stays`)]
  const file = fixture('freeze.md', lines.join('\n') + '\n')
  const l = await launch({ file })
  const { win } = l
  await waitRendered(win)
  await expect(win.locator('main h1')).toHaveText('Original heading')
  // Same size, so the identity check is the mtime, not the length. Raw's next page finds it (plan §2.2).
  writeFileSync(file, ['# Original heading', '', ...Array.from({ length: 400 }, () => 'CHANGED line stays!!')].join('\n') + '\n')
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await waitOpen(win)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End')
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
  await waitRendered(win)
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await expect(win.locator('main h1')).toHaveText('Original heading')
  await expect(win.locator('.md-column')).not.toContainText('CHANGED')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('a low memory budget refuses Rendered, and Raw stays', async () => {
  const file = fixture('budget.md', `# section\n\n${'word '.repeat(40)}\n\n`.repeat(200))
  const probe = await launch({ hooks: true, file })
  await waitRendered(probe.win)
  const hello = await probe.win.evaluate(async () => {
    const { core } = (window as unknown as { typoseTest: TestHooks }).typoseTest
    return core.call('hello', { protocol: 1 }) as Promise<{ limits: Limits }>
  })
  const inner = await probe.win.evaluate(() => window.innerHeight)
  const { ledger, charges } = await debugStats(probe.win)
  const workspace = await workspaceHeld(probe.win)
  await finish(probe)
  // `total` includes the held Markdown build. This launch's open holds only Raw's floor, so the budget is sized from
  // that: the slack stays under a render's temporary, Rendered is refused, and Raw stays.
  const floor = charges[1].hashes + charges[1].checkpoints + charges[1].cache + charges[1].metadata
  expect(charges[1].total).toBeGreaterThan(floor)
  const view = viewportCap(hello.limits, inner)
  const budget = ledger.pool + floor + hello.limits.openTemp + view + (1 << 20) + workspace
  console.log(`rendered budget ${budget} (pool ${ledger.pool}, floor ${floor}, build ${charges[1].total - floor}, view ${view}, window ${inner}px)`)
  const l = await launch({ hooks: true, file, env: { TYPOSE_TEST_BUDGET: String(budget) } })
  const { win } = l
  await waitOpen(win)
  const rendered = win.getByRole('tab', { name: 'Rendered', exact: true })
  await expect(rendered).toBeDisabled({ timeout: 30_000 })
  await expect(rendered.getByTitle(RENDERED_OFF.memory)).toBeVisible()
  await expect(win.locator('.md-scroller')).toHaveCount(0)
  await expect(win.locator('.vl-row .text').first()).toBeAttached()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('switching back to Raw under a tight budget retains its confirmed allowance and the Rendered tree', async () => {
  const l = await launch({ hooks: true, file: fixture('tight-switch.md', '# Small\n\nA short paragraph.\n\n'.repeat(8)) })
  const { win } = l
  await waitRendered(win)
  await expect.poll(async () => (await debugStats(win)).jobs).toBe(0)
  await win.locator('.md-scroller').evaluate((el) => { (el as HTMLElement).dataset.reused = 'same tree' })
  const before = await debugStats(win)
  await debugStats(win, { limit: before.ledger.used })
  for (let i = 0; i < 3; i++) {
    await win.getByRole('tab', { name: 'Raw', exact: true }).click()
    await waitOpen(win)
    await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const cache = await win.evaluate(() => (window as unknown as { typoseTest: { client: { cache: () => { charged: number; cap: number; reserved: number } } } }).typoseTest.client.cache())
    const { ledger } = await debugStats(win)
    expect(cache.charged).toBeLessThanOrEqual(cache.cap)
    expect(cache.cap).toBeLessThanOrEqual(cache.reserved)
    expect(cache.reserved).toBeLessThanOrEqual(ledger.rendererCache)
    await win.getByRole('tab', { name: 'Rendered', exact: true }).click()
    await waitRendered(win)
    await expect(win.locator('.md-scroller')).toHaveAttribute('data-reused', 'same tree')
  }
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('Raw shrinks its local cache before a delayed shared-reservation response returns', async () => {
  const l = await launch({ hooks: true, file: fixture('shrink-switch.md', '# Shrink\n\nA paragraph.\n\n'.repeat(80)) })
  const { win } = l
  await waitRendered(win)
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await waitOpen(win)
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  const before = await debugStats(win)
  await win.evaluate((total) => {
    const core = (window as unknown as {
      typoseTest: { core: { call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> } }
    }).typoseTest.core
    const state: ShrinkProbe = { held: false }
    ;(window as unknown as ReserveWindow).shrinkReserveProbe = state
    const call = core.call.bind(core)
    core.call = async (method, params, signal) => {
      const reply = await call(method, params, signal)
      if (method === 'reserve' && typeof params.bytes === 'number' && params.bytes < total && !state.held) {
        state.held = true
        state.bytes = params.bytes
        await new Promise<void>((done) => { state.release = done })
      }
      return reply
    }
  }, before.ledger.rendererCache)
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 480))
  await expect.poll(() => win.evaluate(() => (window as unknown as ReserveWindow).shrinkReserveProbe?.held)).toBe(true)
  const during = await win.evaluate(() => {
    const client = (window as unknown as { typoseTest: TestHooks & { client: { cache: () => { charged: number; cap: number; reserved: number } } } }).typoseTest.client
    return { cache: client.cache(), rendered: client.rendered!() }
  })
  const actual = await debugStats(win)
  expect(actual.ledger.rendererCache).toBeLessThan(before.ledger.rendererCache)
  expect(during.cache.charged).toBeLessThanOrEqual(during.cache.cap)
  expect(actual.ledger.rendererCache).toBeGreaterThanOrEqual(during.cache.reserved + during.rendered.reserved + during.rendered.retiredReserved)
  await win.evaluate(() => (window as unknown as ReserveWindow).shrinkReserveProbe?.release?.())
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('all-note Markdown reserves the mounted fallback controls and their text', async () => {
  const l = await launch({ hooks: true, file: fixture('all-notes.md', `${'>'.repeat(65)} x\n\n`.repeat(300)) })
  const { win } = l
  await waitRendered(win)
  const built = await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered!())
  const notes = await win.locator('.md-note').evaluateAll((els) => ({ count: els.length, units: els.reduce((n, el) => n + (el.textContent?.length ?? 0), 0) }))
  expect(notes.count).toBe(built.blocks)
  expect(notes.count).toBeGreaterThan(0)
  expect(built.nodes).toBeGreaterThan(0)
  expect(built.noteUnits).toBeGreaterThanOrEqual(notes.units)
  expect(built.reserved).toBeGreaterThan(0)
  expect((await debugStats(win)).ledger.rendererCache).toBeGreaterThanOrEqual(built.reserved + built.rawReserved)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('retired Rendered allowance survives Close, refused open and core restart without accumulating totals', async () => {
  const file = fixture('retired-retry.md', '# Retained allowance\n\nA paragraph.\n\n'.repeat(40))
  const text = fixture('retired-restart.txt', 'A fresh plain text view.\n')
  const l = await launch({ hooks: true, file })
  const { win } = l
  await waitRendered(win)
  const original = await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered!())
  const first = await debugStats(win)
  const firstWorkspace = await workspaceHeld(win)
  await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.app.close!())
  await expectReleasedDocuments(win)
  await debugStats(win, { limit: first.ledger.pool + firstWorkspace })
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), file)
  await expect(win.locator('.card-message p')).toContainText("Typose's memory budget is full")
  expect((await debugStats(win)).docs).toBe(0)
  await expect.poll(async () => {
    const { ledger } = await debugStats(win)
    return ledger.used - ledger.pool
  }).toBe(firstWorkspace)
  await debugStats(win, { limit: first.ledger.limit })
  await win.getByRole('button', { name: 'Retry', exact: true }).click()
  await waitRendered(win)
  const reopened = await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered!())
  expect(reopened.retiredReserved).toBe(2 * original.reserved)
  expect(reopened.totalReserved).toBe(reopened.rawReserved + reopened.reserved + 2 * original.reserved)
  const spawned = lifecycle(l.userData).filter((r) => r.event === 'utility-spawn').at(-1)!
  process.kill(spawned.utilityPid as number)
  await expect(win.locator('.card-message p')).toHaveText("Typose's core stopped")
  await l.app.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', path), text)
  await expect(win.locator('.card-name')).toHaveText('retired-restart.txt')
  await waitOpen(win)
  await waitIndexed(win)
  await expect.poll(async () => {
    const raw = await win.evaluate(() => (window as unknown as { typoseTest: { client: { cache: () => { reserved: number } } } }).typoseTest.client.cache())
    return (await debugStats(win)).ledger.rendererCache - raw.reserved - await workspaceHeld(win)
  }).toBe(2 * original.reserved)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('terminal Reload failure disposes the retained Rendered tree and releases the document', async () => {
  const file = fixture('reload-deleted.md', '# Deleted before Reload\n\nA paragraph.\n')
  const l = await launch({ hooks: true, file })
  const { win } = l
  await waitRendered(win)
  rmSync(file)
  await win.locator('.md-scroller').focus()
  await win.keyboard.press(command + '+R')
  await expect(win.locator('.card-message p')).toContainText('File not found')
  expect(await win.evaluate(() => (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered)).toBeNull()
  await expect.poll(async () => (await debugStats(win)).docs).toBe(0)
  await expect.poll(async () => {
    const { ledger } = await debugStats(win)
    return ledger.used - ledger.pool
  }).toBe(await workspaceHeld(win))
  await win.locator('.file-tab-close').click()
  await expectReleasedDocuments(win)
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('axe finds nothing in Rendered, at 200% zoom too, and every heading of a long file is in the tree', async () => {
  const l = await launch({ file: fixture('axe.md', SAMPLE) })
  const { win, app } = l
  await waitRendered(win)
  const report: Record<string, string[]> = {}
  report.rendered = await axe(win)
  const width = await win.evaluate(() => innerWidth)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(width / 2)
  report.zoom = await axe(win)
  expect(report).toEqual({ rendered: [], zoom: [] })
  await finish(l)

  const headings = Array.from({ length: 2000 }, (_, i) => `# Heading ${i}\n`).join('\n')
  const deep = await launch({ file: fixture('headings.md', headings) })
  await waitRendered(deep.win)
  expect(await deep.win.locator('h1').count()).toBe(2000)
  // No scroll. Accessibility support forces every block visible, which is what puts them in the tree (plan §2.2).
  if (process.platform !== 'linux') await deep.app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true))
  if (process.platform !== 'linux') await expect(deep.win.locator('html')).toHaveAttribute('data-a11y', 'on')
  const cdp = await deep.win.context().newCDPSession(deep.win)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[] }
  await cdp.detach()
  const axHeadings = nodes.filter((n) => n.role?.value === 'heading' && !n.ignored)
  const names = new Set(axHeadings.map((n) => n.name?.value))
  expect(names.has('headings.md')).toBe(true) // the visible file title is a heading in the reader chrome
  expect(names.size).toBe(2001)
  for (let i = 0; i < 2000; i++) expect(names.has(`Heading ${i}`), `heading ${i}`).toBe(true)
  expect(deep.pageErrors).toEqual([])
  await finish(deep)
})

test('the fade-in is 90 ms, and reduced motion drops it', async () => {
  const l = await launch({ file: fixture('motion.md', '# Hello\n') })
  await waitRendered(l.win)
  // The 90 ms fade has finished by the time the build is on screen. The duration is the rule's, not a live animation.
  const duration = await l.win.evaluate(() => getComputedStyle(document.querySelector('.md-scroller')!).animationDuration)
  expect(duration === '0.09s' || duration === '90ms').toBe(true)
  await finish(l)
  const still = await launch({ file: fixture('motion.md', '# Hello\n') })
  await waitRendered(still.win)
  await still.win.emulateMedia({ reducedMotion: 'reduce' })
  // The lens is already in. Mount the same class the way the reduced-motion test reads the progress line.
  const running = await still.win.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.md-scroller')!
    el.classList.remove('md-in')
    void el.offsetWidth
    el.classList.add('md-in')
    return el.getAnimations().length
  })
  expect(running).toBe(0)
  await finish(still)
})

const FORBIDDEN = new Set(['LINK', 'META', 'BASE', 'STYLE', 'SCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'IMG', 'EMBED', 'FORM', 'VIDEO'])

test("Spike C's corpus and the planted cases make no request, and a planted link would", async () => {
  test.setTimeout(5 * 60_000)
  const log = test.info().outputPath('rendered-netlog.json')
  const l = await launch({ file: corpusFile(), netlog: log })
  const { win } = l
  await stubExternal(l.app)
  await waitRendered(win)
  await win.locator('.md-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const clicks = await win.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('.md-column a')]
    let drags = 0
    for (const a of links) {
      a.scrollIntoView({ block: 'nearest' })
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }))
      a.click()
      const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true })
      a.dispatchEvent(drag)
      if (drag.defaultPrevented) drags++
    }
    return { clicks: links.length, drags }
  })
  expect(clicks.clicks).toBeGreaterThan(0)
  expect(clicks.drags).toBe(clicks.clicks)
  const problems = await win.evaluate((forbidden) => {
    const bad: string[] = []
    const tags = new Set(forbidden)
    for (const el of document.querySelectorAll('.md-column *')) {
      if (tags.has(el.tagName)) bad.push(`tag ${el.tagName}`)
      for (const attr of el.attributes) {
        const n = attr.name.toLowerCase()
        if (n.startsWith('on')) bad.push(`on ${n}`)
        if (n === 'src' || n === 'srcset' || n === 'action' || n === 'formaction') bad.push(n)
        if (n === 'href' && attr.value !== '#') bad.push(`href ${attr.value}`)
        if (n === 'style') {
          const own = el.classList.contains('md-block') && /^contain-intrinsic-size:\s*auto\s+\d+px;?$/i.test(attr.value)
          if (!own || /url\s*\(/i.test(attr.value)) bad.push(`style ${attr.value}`)
        }
      }
    }
    return bad
  }, [...FORBIDDEN])
  expect(problems).toEqual([])
  expect(l.pageErrors).toEqual([])
  await finish(l)
  expect(assertNetLog(log)).toContain('PASS')
})

test('Ctrl+R keeps keyboard focus on the Rendered scroller', async () => {
  const l = await launch({ file: fixture('focus.md', SAMPLE) })
  const { win } = l
  await waitRendered(win)
  const scroller = win.locator('.md-scroller')
  await scroller.focus()
  await expect(scroller).toBeFocused()
  await win.keyboard.press(command + '+r')
  await expect(win.locator('[data-lens="rendered"]')).toHaveAttribute('data-gen', '2')
  await waitRendered(win)
  const focused = await win.evaluate(() => document.activeElement?.className ?? '')
  console.log(`focus after Ctrl+R: ${focused}`)
  await expect(win.locator('.md-scroller')).toBeFocused()
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test('with accessibility on, every link and heading is in the tree without scrolling', async () => {
  const n = 120
  const parts = ['# Top heading']
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) parts.push('', `## Section ${i}`, '')
    parts.push(`Paragraph ${i} with a [link ${i}](https://example.invalid/${i}).`, '')
  }
  const l = await launch({ file: fixture('ax-links.md', parts.join('\n')) })
  await waitRendered(l.win)
  expect(await l.win.locator('main a').count()).toBe(n)
  if (process.platform !== 'linux') await l.app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true))
  if (process.platform !== 'linux') await expect(l.win.locator('html')).toHaveAttribute('data-a11y', 'on')
  const cdp = await l.win.context().newCDPSession(l.win)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[] }
  await cdp.detach()
  const links = nodes.filter((node) => node.role?.value === 'link' && !node.ignored)
  const headings = nodes.filter((node) => node.role?.value === 'heading' && !node.ignored)
  const linkNames = new Set(links.map((node) => node.name?.value))
  const headingNames = new Set(headings.map((node) => node.name?.value))
  const missingLinks = Array.from({ length: n }, (_, i) => i).filter((i) => !linkNames.has(`link ${i}`))
  const missingHeadings = ['Top heading', ...Array.from({ length: n / 10 }, (_, k) => `Section ${k * 10}`)].filter((name) => !headingNames.has(name))
  console.log(`ax links ${links.length}/${n} headings ${headings.length}; missing links ${missingLinks.length} headings ${missingHeadings.length}`)
  expect(missingLinks, `links in the tree ${links.length}/${n}`).toEqual([])
  expect(missingHeadings, `headings in the tree ${headings.length}`).toEqual([])
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

/** How many NetLog events name `host`. A hit is the speculative lookup the guard never sees. */
function netlogHits(log: string, host: string): number {
  return readFileSync(log, 'utf8').split(host).length - 1
}

test('an inserted dns-prefetch is not in the NetLog when speculative networking is off', async () => {
  const log = test.info().outputPath('speculative-off-netlog.json')
  const l = await launch({ netlog: log })
  const host = `dns${Date.now().toString(36)}.invalid`
  const pre = `pre${Date.now().toString(36)}.invalid`
  await expect(l.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await l.win.evaluate(
    ({ host, pre }) => {
      for (const [rel, name] of [
        ['dns-prefetch', host],
        ['preconnect', pre]
      ] as const) {
        const link = document.createElement('link')
        link.rel = rel
        link.href = `https://${name}/`
        document.head.append(link)
      }
    },
    { host, pre }
  )
  await l.win.waitForTimeout(3000)
  await finish(l)
  const dnsHits = netlogHits(log, host)
  const preHits = netlogHits(log, pre)
  console.log(`speculative off dnsHits=${dnsHits} preHits=${preHits} host=${host}`)
  expect(dnsHits, host).toBe(0)
  expect(preHits, pre).toBe(0)
  expect(assertNetLog(log)).toContain('PASS')
})

test('with the speculative switch withheld, an inserted dns-prefetch is in the NetLog', async () => {
  // The leak this rules out. An unguarded net.request is a real HTTP request on a session the guard does not cover,
  // which is a different class, so it is not the control. Preconnect from the renderer is not in this NetLog at all.
  const log = test.info().outputPath('speculative-on-netlog.json')
  const host = `dns${Date.now().toString(36)}.invalid`
  const l = await launch({ hooks: true, netlog: log, env: { TYPOSE_TEST_ALLOW_SPECULATIVE: '1' } })
  await expect(l.win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  await l.win.evaluate((host) => {
    const link = document.createElement('link')
    link.rel = 'dns-prefetch'
    link.href = `https://${host}/`
    document.head.append(link)
  }, host)
  await l.win.waitForTimeout(3000)
  await finish(l)
  const hits = netlogHits(log, host)
  console.log(`speculative withheld dnsHits=${hits} host=${host}`)
  expect(hits, host).toBeGreaterThan(0)
  const run = spawnSync(process.execPath, [join(__dirname, 'netlog-assert.mjs'), log], { encoding: 'utf8' })
  expect(run.status, run.stdout + run.stderr).not.toBe(0)
  expect(run.stdout).toMatch(new RegExp(`dns .*${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})
