import { type Page, expect } from '@playwright/test'
import { join } from 'node:path'
import { HOSTILE_HTML, HOSTILE_MERMAID, HOSTILE_TEX, MATH_BOMB, MATH_BOMB_3 } from '../app/renderer/math/hostile'
import { FIXTURES, type Launched, type TestHooks, assertNetLog, fixture, launch, test, waitIndexed } from './app'
import { processMemory } from './memory'

/**
 * Until the returned stop: the worst eval round-trip from the test, the renderer's longest task, and the most a 25 ms
 * page timer ran late (GC pauses included). A round-trip also crosses the browser process and this test's own loop.
 */
async function responsiveness(win: Page): Promise<() => Promise<{ worstRoundTrip: number; longestTask: number; timerLate: number }>> {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(() => {
    const w = window as unknown as { longTasks: number[]; timerLate: number }
    w.longTasks = []
    w.timerLate = 0
    new PerformanceObserver(list => { for (const entry of list.getEntries()) w.longTasks.push(entry.duration) }).observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    setInterval(() => { const now = performance.now(); w.timerLate = Math.max(w.timerLate, now - last - 25); last = now }, 25)
  })
  let running = true, worstRoundTrip = 0
  const sampling = (async () => {
    while (running) {
      const start = Date.now()
      if (await win.evaluate(() => 0).catch(() => null) === null) return
      worstRoundTrip = Math.max(worstRoundTrip, Date.now() - start)
      await new Promise(done => setTimeout(done, 25))
    }
  })()
  return async () => {
    running = false
    await sampling
    const page = await win.evaluate(() => { const w = window as unknown as { longTasks: number[]; timerLate: number }; return { longestTask: Math.max(0, ...w.longTasks), timerLate: Math.round(w.timerLate) } })
    return { worstRoundTrip, ...page }
  }
}

/** Rendered's extras share: the lens's rendered reservation less what the build itself pays (renderedCharge). */
const extrasReserved = (win: Page) => win.evaluate(() => {
  const r = (window as unknown as { typoseTest: TestHooks }).typoseTest.client.rendered!()
  return r.reserved - ((6 << 20) + 128 * (r.units + r.noteUnits) + 16384 * r.nodes + 2 * r.htmlBytes)
})

/** Common TeX whose MathML carries attributes the print tree refuses (width, mathbackground, columnlines, style). */
const PRINT_FALLBACK_TEX = [String.raw`x \tag{1}`, String.raw`\rule{1em}{1em}`, String.raw`\begin{array}{|c|c|}\hline a & b \\ \hline\end{array}`, String.raw`\fcolorbox{red}{yellow}{x}`]

test('offline Markdown extras render securely and offscreen math/diagrams reach normalized print', async () => {
  const source = ['---', 'title: Markdown candidate', 'owner: Zack', 'tags: [alpha, beta]', '---', '# Markdown extras', '',
    '[Top](#markdown-extras) [Gone](#no-such-heading) [Risks](markdown-extras-risks.md) [[Team roster]]', '',
    '> [!NOTE]', '> A native callout.', '', '## Formatted code', '', '```typescript', 'const answer = 42', "const config = { key: 'value', list: [1, 2] }", '```', '',
    '$x^2 + y^2$', '', ...PRINT_FALLBACK_TEX.flatMap(tex => ['$$' + tex + '$$', '']), '```mermaid', 'flowchart LR', '  A[Source] --> B[Reader]', '```', '',
    '<iframe src="data:text/html,<script>top.location=\'https://example.invalid/\'</script>"></iframe>', '',
    ...Array.from({ length: 60 }, (_, index) => `Offscreen paragraph ${index}.\n`),
    '## Offscreen math', '', '$$\\frac{1}{2} + \\sqrt{x}$$', ''].join('\n')
  const file = fixture('markdown-extras.md', source)
  const netlog = join(FIXTURES, 'markdown-extras.netlog.json')
  const live = await launch({ file, netlog, hooks: true, env: { TYPOSE_TEST_PRINT: '1' } })
  await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
  await waitIndexed(live.win)
  await expect(live.win.locator('.md-properties')).toContainText('Markdown candidate')
  await expect(live.win.locator('.md-properties dd').filter({ hasText: 'alpha' })).toHaveText('[alpha, beta]')
  await expect(live.win.locator('.md-callout[data-tint="blue"]')).toContainText('A native callout.')
  await expect(live.win.locator('code[data-highlighted="1"]')).toContainText('const answer = 42', { timeout: 30_000 })
  // Every colored token stays readable on the code block in both themes, and a theme switch repaints without a re-tokenize.
  const tokens = () => live.win.evaluate(() => {
    const luminance = (color: string) => {
      const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(v => Number(v) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return r * 0.2126 + g * 0.7152 + b * 0.0722
    }
    const code = document.querySelector('code[data-highlighted="1"]')!
    const background = luminance(getComputedStyle(code.closest('pre')!).backgroundColor)
    const colors = [...code.querySelectorAll('.tp-token')].filter(token => token.textContent!.trim()).map(token => getComputedStyle(token).color)
    const ratios = colors.map(color => { const l = luminance(color); return (Math.max(l, background) + 0.05) / (Math.min(l, background) + 0.05) })
    return { colors, min: Math.min(...ratios) }
  })
  const light = (on: boolean) => live.win.evaluate(on => {
    // What the settings controller applies for Typose Light.
    const root = document.documentElement, tokens = { canvas: '#f7f7f7', surface: '#ffffff', 'surface-raised': '#f0f0f2', border: '#dcdce0', text: '#202024', text2: '#64646d', accent: '#285ac9' }
    if (on) root.dataset.theme = 'light'; else delete root.dataset.theme
    for (const [key, value] of Object.entries(tokens)) {
      if (on) root.style.setProperty('--' + key, value)
      else root.style.removeProperty('--' + key)
    }
  }, on)
  await live.win.emulateMedia({ colorScheme: 'dark' }) // the System theme follows the OS; this baseline is the dark one
  await expect(live.win.locator('html')).toHaveAttribute('data-theme', 'dark')
  const dark = await tokens()
  expect(dark.colors.length).toBeGreaterThan(8)
  expect(dark.min).toBeGreaterThanOrEqual(3)
  await light(true)
  const lit = await tokens()
  expect(lit.min).toBeGreaterThanOrEqual(3)
  expect(lit.colors).not.toEqual(dark.colors)
  await light(false)
  expect((await tokens()).colors).toEqual(dark.colors)
  await expect(live.win.locator('.tp-math .katex')).toHaveCount(2 + PRINT_FALLBACK_TEX.length, { timeout: 30_000 })
  const frame = live.win.locator('.md-diagram iframe')
  await expect(frame).toHaveAttribute('sandbox', '', { timeout: 30_000 })
  await expect(frame).toHaveAttribute('title', 'Mermaid diagram')
  expect(await live.win.locator('iframe').count()).toBe(1)
  expect(live.win.url()).toContain('typose://')
  await live.win.locator('.md-outline summary').click()
  await expect(live.win.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: 'Offscreen math' })).toBeVisible()
  await live.win.locator('.md-outline summary').click()
  await live.app.evaluate(({ BrowserWindow }) => {
    const state = globalThis as unknown as { richPrint?: { math: number; namespace: string | null; images: number; external: number; text: string } }
    const proto = Object.getPrototypeOf(BrowserWindow.getAllWindows()[0].webContents)
    const original = proto.printToPDF
    proto.printToPDF = async function (options: unknown) {
      state.richPrint = await this.executeJavaScript(`({math:document.querySelectorAll('math').length,namespace:document.querySelector('math')?.namespaceURI,images:document.images.length,external:document.querySelectorAll('[href],[src^="http"],iframe,script').length,text:document.body.textContent})`)
      return original.call(this, options)
    }
  })
  await live.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'print'))
  const sheet = live.win.getByRole('dialog', { name: 'Print markdown-extras.md' })
  await sheet.getByRole('radio', { name: 'All' }).check()
  await sheet.getByRole('button', { name: 'Continue to print…' }).click()
  await expect(live.win.getByRole('status').filter({ hasText: 'Print job sent' })).toBeVisible({ timeout: 60_000 })
  const { text, ...printed } = await live.app.evaluate(() => (globalThis as unknown as { richPrint: { text: string } }).richPrint)
  expect(printed).toEqual({ math: 2, namespace: 'http://www.w3.org/1998/Math/MathML', images: 1, external: 0 })
  // MathML the strict print tree refuses prints as that formula's TeX; the rest of the document still prints.
  for (const tex of PRINT_FALLBACK_TEX) expect(text).toContain(tex)
  const windows = await live.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const refused = await live.win.evaluate(async () => {
    const api = (window as unknown as { typose: { printDocument(title: string, blocks: unknown[], pages: number, confirmed: boolean): Promise<{ kind: string }> } }).typose
    return Promise.all([
      { tag: 'annotation-xml', children: [{ tag: 'script', children: [{ text: 'alert(1)' }] }] },
      { tag: 'mi', attrs: { href: 'https://example.invalid/' }, children: [{ text: 'x' }] },
      { tag: 'mstyle', attrs: { style: 'background:url(https://example.invalid/)' } }
    ].map(math => api.printDocument('hostile MathML', [{ tag: 'math', math }], 1, false)))
  })
  expect(refused.map(result => result.kind)).toEqual(['refused', 'refused', 'refused'])
  expect(await live.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows)
  // A wiki link has nothing to resolve it; a missing heading or local file is known once following it fails.
  const link = (name: string) => live.win.getByRole('link', { name, exact: true })
  await expect(link('Team roster')).toHaveClass(/md-unresolved/)
  await expect(link('Team roster')).toHaveAttribute('title', 'Not found: Team roster')
  expect(await link('Team roster').evaluate(a => getComputedStyle(a).textDecorationStyle)).toBe('dashed')
  await link('Gone').click()
  await expect(link('Gone')).toHaveAttribute('title', 'Not found: #no-such-heading')
  await expect(link('Gone')).toHaveClass(/md-unresolved/)
  if (process.platform === 'win32') {
    await link('Risks').click()
    await expect(link('Risks')).toHaveAttribute('title', 'Not found: markdown-extras-risks.md', { timeout: 30_000 })
    await expect(link('Risks')).toHaveClass(/md-unresolved/)
  }
  await expect(link('Top')).not.toHaveClass(/md-unresolved/)
  expect(live.pageErrors).toEqual([])
  expect(assertNetLog(netlog)).toContain('PASS: no Chromium network-stack activity')
})

test('every hostile Mermaid diagram type and hostile TeX settle in script-less frames or source, with no request', async () => {
  const source = ['# Hostile', '', ...HOSTILE_MERMAID.flatMap(({ source }) => ['~~~~mermaid', source, '~~~~', '']),
    ...HOSTILE_TEX.slice(0, 8).flatMap(tex => ['$$' + tex + '$$', ''])].join('\n')
  const file = fixture('markdown-extras-hostile.md', source)
  const netlog = join(FIXTURES, 'markdown-extras-hostile.netlog.json')
  const live = await launch({ file, netlog, hooks: true })
  await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
  // A diagram ends as a frame, its source with a problem marker, or its source with the budget note.
  const settled = () => live.win.evaluate(() => [...document.querySelectorAll('.md-diagram')]
    .filter(d => d.querySelector('iframe, .problem') || d.getAttribute('title')).length)
  await expect.poll(settled, { timeout: 180_000 }).toBe(HOSTILE_MERMAID.length)
  const frames = await live.win.evaluate(() => [...document.querySelectorAll('iframe')]
    .map(f => f.getAttribute('sandbox') === '' && !!f.closest('.md-diagram') && !!f.getAttribute('src')?.startsWith('data:text/html;')))
  expect(frames.length).toBeGreaterThan(0)
  expect(frames.every(Boolean)).toBe(true)
  expect(live.win.url()).toContain('typose://')
  expect(live.pageErrors).toEqual([])
  expect(assertNetLog(netlog)).toContain('PASS: no Chromium network-stack activity')
})

test('math bombs, oversized formulas and hostile sanitizer input stay bounded and keep the reader responsive', async () => {
  const cell = (i: number) => String.raw`\frac{a_${i}}{b_${i}}`
  const matrix = (n: number) => String.raw`\begin{pmatrix}` + Array.from({ length: n }, () => Array.from({ length: n }, (_, i) => cell(i)).join(' & ')).join(String.raw`\\`) + String.raw`\end{pmatrix}`
  const source = ['# Bounded math', '', '$$' + MATH_BOMB + '$$', '', '$$' + MATH_BOMB_3 + '$$', '', '$$' + matrix(10) + '$$', '', '$$' + matrix(12) + '$$', '',
    ...HOSTILE_TEX.flatMap(tex => ['$$' + tex + '$$', '']), '> [!constructor]', '> Not a callout.', ''].join('\n')
  const file = fixture('markdown-extras-bounded-math.md', source)
  const netlog = join(FIXTURES, 'markdown-extras-bounded-math.netlog.json')
  const live = await launch({ file, netlog, hooks: true })
  const stop = await responsiveness(live.win)
  await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
  // Every formula ends rendered, or as its source with the reason in its tooltip. (The 100,001-character nesting
  // fixture is over the 64 KiB block bound, so the core makes it a note, not a formula.)
  await expect.poll(() => live.win.evaluate(() => [...document.querySelectorAll('.tp-math')]
    .filter(m => !m.querySelector('.katex, .problem') && !m.getAttribute('title')).length), { timeout: 60_000 }).toBe(0)
  const { worstRoundTrip, longestTask, timerLate } = await stop()
  const titles = await live.win.evaluate(() => [...document.querySelectorAll('.tp-math')].map(m => m.getAttribute('title')))
  expect(titles.slice(0, 4)).toEqual(['Math source kept · Macro definitions are not rendered', 'Math source kept · Macro definitions are not rendered', null, 'Math source kept · Math output exceeds 8192 elements'])
  await expect(live.win.locator('.tp-math').nth(2).locator('.katex')).toHaveCount(1)
  expect(await live.win.evaluate(() => document.querySelectorAll('*').length)).toBeLessThan(40_000)
  console.log(`bounded math: worst eval round-trip ${worstRoundTrip} ms, longest renderer task ${Math.round(longestTask)} ms, page timer late ${timerLate} ms`)
  expect(worstRoundTrip).toBeLessThan(1000)
  expect(longestTask).toBeLessThan(250)
  expect(timerLate).toBeLessThan(250)
  // An Object.prototype key is not a callout kind.
  expect(await live.win.locator('.md-callout').count()).toBe(0)
  // The math sanitizer, alone, on HTML a KaTeX bug could emit: nothing that loads, links, runs or styles survives.
  const leaks = await live.win.evaluate(corpus => {
    const sanitize = (window as unknown as { typoseSanitizeMath: (html: string) => string }).typoseSanitizeMath
    return corpus.flatMap(html => {
      const t = document.createElement('template')
      t.innerHTML = sanitize(html)
      return [...t.content.querySelectorAll('*')].flatMap(el => [
        ...(['script', 'iframe', 'object', 'embed', 'style', 'foreignobject', 'image', 'use', 'form'].includes(el.localName) ? [`<${el.localName}>`] : []),
        ...[...el.attributes].filter(a => a.name.startsWith('on') || /example\.invalid|javascript:/i.test(a.value) || (a.name === 'style' && /url\(|@import/i.test(a.value)))
          .map(a => `${el.localName}[${a.name}]`)
      ])
    })
  }, HOSTILE_HTML)
  expect(leaks).toEqual([])
  expect(live.pageErrors).toEqual([])
  expect(assertNetLog(netlog)).toContain('PASS: no Chromium network-stack activity')
})

test('dense highlighting pays for its spans before inserting them, and never stalls the reader', async () => {
  const json = (seed: number) => {
    const lines = ['[']
    for (let i = 0, length = 2; length < 31_000; i++) {
      const line = `  {"id": ${seed * 1000 + i}, "ok": true, "n": null, "v": [1, 2.5, -3], "s": "x${i}", "k": {"a": "b"}},`
      lines.push(line)
      length += line.length + 1
    }
    return [...lines, '  {}', ']'].join('\n')
  }
  const blocks = Array.from({ length: 8 }, (_, i) => json(i))
  const markdown = (language: string, ts: string) => ['# Dense', '', ...blocks.flatMap(block => ['```' + language, block, '```', '']),
    '```' + ts, Array(3).fill('a'.repeat(9990)).join('\n'), '```', ''].join('\n')
  const measure = async (name: string, source: string, highlighted: number) => {
    const live = await launch({ file: fixture(name, source), hooks: true, controlledAccessibility: process.env.A11Y_OFF === '1' })
    const stop = await responsiveness(live.win)
    await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
    await expect(live.win.locator('code[data-highlighted="1"]')).toHaveCount(highlighted, { timeout: 60_000 })
    await live.win.waitForTimeout(2000) // the TS block's watchdog, or its plain result
    const timing = await stop()
    const spans = await live.win.locator('.tp-token').count()
    const memory = (await processMemory(live.app)).find(p => p.type === 'Tab')!.private ?? 0
    expect(live.pageErrors).toEqual([])
    return { ...timing, spans, memory, extras: await extrasReserved(live.win) }
  }
  const plain = await measure('markdown-extras-dense-plain.md', markdown('text', 'text'), 0)
  expect(plain.extras).toBe(0) // unlabeled blocks pay nothing
  const lit = await measure('markdown-extras-dense.md', markdown('json', 'ts'), 8)
  const grew = lit.memory - plain.memory
  console.log(`dense highlighting: ${lit.spans} spans, renderer private +${(grew / 2 ** 20).toFixed(1)} MiB against ${(lit.extras / 2 ** 20).toFixed(1)} MiB reserved; ` +
    `worst eval round-trip ${lit.worstRoundTrip} ms, longest renderer task ${Math.round(lit.longestTask)} ms, page timer late ${lit.timerLate} ms`)
  expect(lit.spans).toBe(8 * 2000) // the span cap; each block's rest stays plain text
  expect(grew).toBeLessThan(lit.extras)
  expect(lit.worstRoundTrip).toBeLessThan(1000)
  expect(lit.longestTask).toBeLessThan(250)
  expect(lit.timerLate).toBeLessThan(250)
})

test('blocks that cannot highlight pay nothing, so a formula after a thousand of them still renders', async () => {
  const source = ['# Shell', '', ...Array.from({ length: 1000 }, (_, i) => ['```sh', `echo ${i}`, '```', '']).flat(), '$$x^2$$', ''].join('\n')
  const live = await launch({ file: fixture('markdown-extras-sh.md', source), hooks: true, env: { TYPOSE_TEST_BUDGET: String(1 << 30) } })
  await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
  await expect(live.win.locator('.tp-math .katex')).toHaveCount(1, { timeout: 60_000 })
  expect(await extrasReserved(live.win)).toBeLessThan(4 << 20)
  expect(live.pageErrors).toEqual([])
})

/** The renderer's private bytes after a forced GC, so garbage from settled jobs doesn't count as kept. */
async function keptPrivate(live: Launched): Promise<number> {
  const cdp = await live.win.context().newCDPSession(live.win)
  await cdp.send('HeapProfiler.collectGarbage')
  await live.win.waitForTimeout(2000)
  return (await processMemory(live.app)).find(p => p.type === 'Tab')!.private ?? 0
}

test('two thousand small formulas, or two thousand one-line code blocks, all render within a 2 GiB budget', async () => {
  test.setTimeout(300_000)
  const paragraphs = (item: (i: number) => string) => Array.from({ length: 20 }, (_, p) => Array.from({ length: 100 }, (_, i) => item(p * 100 + i)).join(' ')).join('\n\n')
  const blocks = (language: string) => Array.from({ length: 2000 }, (_, i) => '```' + language + `\nconst value${i} = { id: ${i}, name: 'item' }\n` + '```').join('\n\n')
  const cases = [
    { name: 'formulas', plain: paragraphs(i => `x_${i}`), lit: paragraphs(i => `$x_${i}$`), done: '.tp-math .katex' },
    { name: 'code blocks', plain: blocks('text'), lit: blocks('ts'), done: 'code[data-highlighted="1"]' }
  ]
  for (const { name, plain, lit, done } of cases) {
    const measure = async (variant: string, source: string, count: number) => {
      const file = fixture(`markdown-extras-2000-${name.replace(' ', '-')}-${variant}.md`, '# Many\n\n' + source + '\n')
      const live = await launch({ file, hooks: true, env: { TYPOSE_TEST_BUDGET: String(2 ** 31) } })
      await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
      await expect(live.win.locator(done)).toHaveCount(count, { timeout: 120_000 })
      expect(await live.win.locator('.tp-math[title], code[title]').count()).toBe(0) // nothing refused or stopped
      expect(live.pageErrors).toEqual([])
      return { kept: await keptPrivate(live), extras: await extrasReserved(live.win) }
    }
    const before = await measure('plain', plain, 0)
    const after = await measure('lit', lit, 2000)
    const grew = after.kept - before.kept
    console.log(`2,000 ${name}: ${(after.extras / 2 ** 20).toFixed(1)} MiB reserved against renderer private +${(grew / 2 ** 20).toFixed(1)} MiB`)
    expect(grew).toBeLessThan(after.extras)
  }
})
