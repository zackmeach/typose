import { expect } from '@playwright/test'
import { join } from 'node:path'
import { FIXTURES, assertNetLog, finish, fixture, launch, test, waitIndexed } from './app'

test('offline Markdown extras render securely and offscreen math/diagrams reach normalized print', async () => {
  const source = ['---', 'title: Markdown candidate', 'owner: Zack', '---', '# Markdown extras', '',
    '> [!NOTE]', '> A native callout.', '', '## Formatted code', '', '```typescript', 'const answer = 42', '```', '',
    '$x^2 + y^2$', '', '```mermaid', 'flowchart LR', '  A[Source] --> B[Reader]', '```', '',
    '<iframe src="data:text/html,<script>top.location=\'https://example.invalid/\'</script>"></iframe>', '',
    ...Array.from({ length: 60 }, (_, index) => `Offscreen paragraph ${index}.\n`),
    '## Offscreen math', '', '$$\\frac{1}{2} + \\sqrt{x}$$', ''].join('\n')
  const file = fixture('markdown-extras.md', source)
  const netlog = join(FIXTURES, 'markdown-extras.netlog.json')
  const live = await launch({ file, netlog, hooks: true, env: { TYPOSE_TEST_PRINT: '1' } })
  try {
    await expect(live.win.locator('.md-scroller')).toHaveAttribute('data-ready', '1', { timeout: 60_000 })
    await waitIndexed(live.win)
    await expect(live.win.locator('.md-properties')).toContainText('Markdown candidate')
    await expect(live.win.locator('.md-callout[data-tint="blue"]')).toContainText('A native callout.')
    await expect(live.win.locator('code[data-highlighted="1"]')).toContainText('const answer = 42', { timeout: 30_000 })
    await expect(live.win.locator('.tp-math .katex')).toHaveCount(2, { timeout: 30_000 })
    const frame = live.win.locator('.md-diagram iframe')
    await expect(frame).toHaveAttribute('sandbox', '', { timeout: 30_000 })
    await expect(frame).toHaveAttribute('title', 'Mermaid diagram')
    expect(await live.win.locator('iframe').count()).toBe(1)
    expect(live.win.url()).toContain('typose://')
    await live.win.locator('.md-outline summary').click()
    await expect(live.win.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: 'Offscreen math' })).toBeVisible()
    await live.win.locator('.md-outline summary').click()
    await live.app.evaluate(({ BrowserWindow }) => {
      const state = globalThis as unknown as { richPrint?: { math: number; namespace: string | null; images: number; external: number } }
      const proto = Object.getPrototypeOf(BrowserWindow.getAllWindows()[0].webContents)
      const original = proto.printToPDF
      proto.printToPDF = async function (options: unknown) {
        state.richPrint = await this.executeJavaScript(`({math:document.querySelectorAll('math').length,namespace:document.querySelector('math')?.namespaceURI,images:document.images.length,external:document.querySelectorAll('[href],[src^="http"],iframe,script').length})`)
        return original.call(this, options)
      }
    })
    await live.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'print'))
    const sheet = live.win.getByRole('dialog', { name: 'Print markdown-extras.md' })
    await sheet.getByRole('radio', { name: 'All' }).check()
    await sheet.getByRole('button', { name: 'Continue to print…' }).click()
    await expect(live.win.getByRole('status').filter({ hasText: 'Print job sent' })).toBeVisible({ timeout: 60_000 })
    const printed = await live.app.evaluate(() => (globalThis as unknown as { richPrint: unknown }).richPrint)
    expect(printed).toEqual({ math: 2, namespace: 'http://www.w3.org/1998/Math/MathML', images: 1, external: 0 })
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
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
  expect(assertNetLog(netlog)).toContain('PASS: no Chromium network-stack activity')
})
