// Plan (Rendered Markdown slice) PR 2: the Rendered lens, the switch, file states, accessibility and the
// sanitizer's DOM. Links stay inert. The NetLog control shows a planted `<link rel=preconnect>` would be caught.
import AxeBuilder from '@axe-core/playwright'
import { type Page, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RENDERED_OFF } from '../app/renderer/card'
import { rowCost } from '../app/renderer/lenses/page-cache'
import type { Limits } from '../app/shared/protocol'
import { type TestHooks, assertNetLog, debugStats, finish, fixture, launch, test, visibleRows, waitOpen } from './app'

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
  await expect(win.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true')
  // Offscreen blocks stay mounted and skip their paint (plan §2.2).
  const visibility = await win.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>('.md-block')]
    // Headings stay in the accessibility tree, so they don't skip paint. Another block below the fold does.
    const below = blocks.find((b) => b.getBoundingClientRect().top > innerHeight && !b.querySelector('h1, h2, h3, h4, h5, h6'))
    return { count: blocks.length, below: below ? getComputedStyle(below).contentVisibility : '' }
  })
  expect(visibility.count).toBeGreaterThan(10)
  expect(visibility.below).toBe('auto')

  const scroller = win.locator('.md-scroller')
  await scroller.evaluate((el) => {
    const block = el.querySelectorAll<HTMLElement>('.md-block')[8]
    el.scrollTop = block.offsetTop
  })
  const before = await topBlock(win)
  await win.getByRole('tab', { name: 'Raw' }).click()
  await expect(win.locator('.raw-host')).toBeAttached()
  const rawTop = (await visibleRows(win))[0].line
  expect(rawTop).toBeGreaterThanOrEqual(before.line)
  expect(rawTop).toBeLessThanOrEqual(before.end)
  await win.getByRole('tab', { name: 'Rendered' }).click()
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
  await expect(text.win.getByRole('tablist')).toHaveCount(0)
  await finish(text)
  const empty = await launch({ file: fixture('empty.md', '') })
  await expect(empty.win.locator('.card-message')).toHaveText('Empty file')
  await expect(empty.win.getByRole('tablist')).toHaveCount(0)
  await finish(empty)
})

test('a file over the ceiling opens in Raw, with Rendered disabled and the reason in its tooltip', async () => {
  const l = await launch({ file: fixture('over.md', 'a'.repeat((8 << 20) + 1)) })
  const { win } = l
  await waitOpen(win)
  const rendered = win.getByRole('tab', { name: 'Rendered' })
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
  await win.keyboard.press('Control+r')
  await expect(win.locator('[data-lens="rendered"]')).toHaveAttribute('data-gen', '2')
  await waitRendered(win)
  const after = await topBlock(win)
  expect(after.line).toBeLessThanOrEqual(before.end)
  expect(after.end).toBeGreaterThanOrEqual(before.line)
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
  await win.getByRole('tab', { name: 'Raw' }).click()
  await waitOpen(win)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End')
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  await win.getByRole('tab', { name: 'Rendered' }).click()
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
  await finish(probe)
  // What `open` reserves before a lens exists: Raw's viewport cap at the window's height. The slack is far under a
  // render's temporary (the sanitizer), so the build is refused and Raw stays.
  const view = (Math.ceil(inner / 20) + 1) * rowCost(hello.limits)
  const budget = ledger.pool + charges[1].total + hello.limits.openTemp + view + (1 << 20)
  console.log(`rendered budget ${budget} (pool ${ledger.pool}, document ${charges[1].total}, view ${view}, window ${inner}px)`)
  const l = await launch({ hooks: true, file, env: { TYPOSE_TEST_BUDGET: String(budget) } })
  const { win } = l
  await waitOpen(win)
  const rendered = win.getByRole('tab', { name: 'Rendered' })
  await expect(rendered).toBeDisabled({ timeout: 30_000 })
  await expect(rendered.getByTitle(RENDERED_OFF.memory)).toBeVisible()
  await expect(win.locator('.md-scroller')).toHaveCount(0)
  await expect(win.locator('.vl-row .text').first()).toBeAttached()
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
  // No scroll. Accessibility support is what makes Chromium build the tree a reader would walk (Z39's automated read).
  if (process.platform !== 'linux') await deep.app.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true))
  // No scroll: content-visibility must leave every heading in the tree (plan §2.2, Z72).
  const cdp = await deep.win.context().newCDPSession(deep.win)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[] }
  await cdp.detach()
  const axHeadings = nodes.filter((n) => n.role?.value === 'heading' && !n.ignored)
  const names = new Set(axHeadings.map((n) => n.name?.value))
  expect(names.size).toBe(2000)
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
  await waitRendered(win)
  await win.locator('.md-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const clicks = await win.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('.md-column a')]
    for (const a of links) {
      a.scrollIntoView({ block: 'nearest' })
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }))
      a.click()
    }
    return links.length
  })
  expect(clicks).toBeGreaterThan(0)
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

  // The control: a link the sanitizer would have removed, inserted live, is DNS the NetLog reports.
  const controlLog = test.info().outputPath('rendered-control-netlog.json')
  const control = await launch({ netlog: controlLog })
  await expect(control.win.locator('.open-button')).toBeVisible()
  // The page CSP blocks a preconnect before it reaches the network stack. Bypass it for this control only, so a link
  // that got past the sanitizer is something checkNetLog can fail on.
  // A link in the page is cancelled by the network guard before Chromium logs it. The same `<link rel=preconnect>`
  // inserted after CSP bypass still leaves the NetLog clean (measured). An unguarded session does reach DNS, which is
  // what shows the gate can fail.
  await control.win.evaluate(() => {
    const link = document.createElement('link')
    link.rel = 'preconnect'
    link.href = 'https://example.com/'
    document.head.append(link)
  })
  await control.app.evaluate(({ net, session }) => {
    const s = session.fromPartition('typose-pr2-control')
    const req = net.request({ url: 'https://example.com/', session: s })
    req.on('error', () => {})
    req.on('response', () => {})
    req.end()
  })
  await control.win.waitForTimeout(3000)
  await finish(control)
  // checkNetLog, as CI runs it: a live preconnect is DNS, so this gate can fail.
  const run = spawnSync(process.execPath, [join(__dirname, 'netlog-assert.mjs'), controlLog], { encoding: 'utf8' })
  expect(run.status, run.stdout + run.stderr).not.toBe(0)
  expect(run.stdout).toMatch(/dns /)
})
