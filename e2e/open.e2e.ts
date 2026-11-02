import { expect } from '@playwright/test'
import { cachedItems, finish, fixture, launch, test, visibleRows, waitIndexed, waitOpen } from './app'

test('a JSONL file named on the command line opens in Rows and reaches its last source line in Raw', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `{"type":"tool","msg":"row ${i}"}`)
  const l = await launch({ file: fixture('open.jsonl', lines.join('\n')) })
  const { win } = l
  await expect(win.getByRole('tab', { name: 'Rows', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await win.getByRole('tab', { name: 'Raw', exact: true }).click()
  await waitOpen(win)
  expect(await win.title()).toBe('open.jsonl — Typose')
  await expect(win.getByRole('region', { name: 'open.jsonl, Raw' })).toBeVisible()
  expect((await visibleRows(win))[0]).toEqual({ line: 1, text: lines[0] })
  expect(await waitIndexed(win)).toBe(5000)
  await win.locator('.vl-scroller').focus()
  await win.keyboard.press('Control+End')
  await expect.poll(async () => (await visibleRows(win)).at(-1)).toEqual({ line: 5000, text: lines[4999] })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

// Each fixture's text as a reference decoder reads it (TextDecoder strips the BOM), split into Raw's lines.
const ENCODINGS: [name: string, label: string, bytes: Buffer][] = [
  ['utf-8.txt', 'utf-8', Buffer.from('café ☕ 語 😀\r\nsecond line\nthird ünïcödé\n', 'utf8')],
  ['windows-1252.txt', 'windows-1252', Buffer.from([...Buffer.from('caf'), 0xe9, 0x20, 0x80, 0x20, 0x93, 0x71, 0x94, 0x0a, ...Buffer.from('na'), 0xef, 0x76, 0x65, 0x0a])],
  ['utf-16le.txt', 'utf-16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café 😀 語\r\nzweite Zeile\nਊ Ċ\n', 'utf16le')])],
  ['utf-16be.txt', 'utf-16be', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('café 😀 語\r\nzweite Zeile\nਊ Ċ\n', 'utf16le').swap16()])]
]

for (const [name, label, bytes] of ENCODINGS) {
  test(`${label} displays the same text as a reference decode`, async () => {
    const want = new TextDecoder(label).decode(bytes).split(/\r?\n/)
    want.pop() // the file ends with a newline
    const l = await launch({ file: fixture(name, bytes) })
    await waitOpen(l.win)
    await expect(l.win.locator('.card-status')).toHaveText(new RegExp(` · ${label === 'windows-1252' ? 'windows-1252' : label.toUpperCase()}$`))
    expect((await visibleRows(l.win)).map((r) => r.text)).toEqual(want)
    await finish(l)
  })
}

test('horizontal scrolling brings a wide line past the viewport into view', async () => {
  const wide = `${'wide '.repeat(400)}MARK` // one row: Z66 wraps at 2,048 units, and End goes to the widest row's end
  const l = await launch({ file: fixture('wide.txt', `short\n${wide}\n`) })
  const { win } = l
  await waitOpen(win)
  const scroller = win.locator('.vl-scroller')
  const markBox = () =>
    win.evaluate(() => {
      const text = [...document.querySelectorAll('.vl-row .text')].find((t) => t.textContent!.endsWith('MARK'))!.firstChild!
      const range = document.createRange()
      range.setStart(text, text.textContent!.length - 4)
      range.setEnd(text, text.textContent!.length)
      const r = range.getBoundingClientRect()
      const v = document.querySelector('.vl-scroller')!.getBoundingClientRect()
      return { inside: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom, left: r.left, right: v.right }
    })
  expect((await markBox()).inside).toBe(false) // beyond the viewport's width at first
  await scroller.focus()
  await win.keyboard.press('End')
  await expect.poll(async () => (await markBox()).inside).toBe(true)
  const left = () => scroller.evaluate((el) => el.scrollLeft)
  await win.keyboard.press('Home')
  await expect.poll(left).toBe(0)
  await win.keyboard.press('ArrowRight')
  await expect.poll(left).toBe(40)
  // Shift+wheel and the horizontal wheel scroll it too.
  const box = (await scroller.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.keyboard.down('Shift')
  await win.mouse.wheel(0, 300)
  await win.keyboard.up('Shift')
  await expect.poll(left).toBeGreaterThan(40)
  const before = await left()
  await win.mouse.wheel(400, 0)
  await expect.poll(left).toBeGreaterThan(before)
  await finish(l)
})

test('no mounted item holds more than 64 KiB of text, and a long line ends at a character', async () => {
  // 70,000 bytes of 3-byte characters: the first piece is cut at a character within 65,536 bytes (C2, C3). Z66 shows
  // it over rows of at most 2,048 units, so the pieces are read from the cache, not the rows.
  const l = await launch({ hooks: true, file: fixture('long-cjk.txt', `${'語'.repeat(23_334)}\nafter\n`) })
  const { win } = l
  await waitOpen(win)
  await expect.poll(async () => (await visibleRows(win)).find((r) => r.line === 2)).toEqual({ line: 2, text: 'after' })
  const items = await cachedItems(win)
  expect(Math.max(...items.map((i) => i.text.length))).toBeLessThanOrEqual(65_536)
  expect(items.find((i) => i.key === 0)?.text).toBe('語'.repeat(21_845)) // 65,535 bytes: no U+FFFD from a split character
  const rows = await win.locator('.vl-row[data-line="0"] .text').allTextContents()
  expect(rows.map((t) => t.length)).toEqual([...Array(10).fill(2048), 21_845 - 10 * 2048])
  expect(rows.join('')).toBe('語'.repeat(21_845))
  // Each row but the piece's last ends in ↪, which assistive tech skips.
  await expect(win.locator('.vl-row[data-line="0"] .more[aria-hidden="true"]')).toHaveText(Array(10).fill('↪'))
  await expect(win.getByRole('button', { name: 'Show more of line 1' })).toHaveCount(1) // on the piece's last row
  // The marker is painted on the row, and a selection across that row doesn't take it.
  const selected = await win.evaluate(() => {
    const row = document.querySelector('.vl-row[data-line="0"]')!
    window.getSelection()!.selectAllChildren(row)
    return window.getSelection()!.toString()
  })
  expect(selected).toContain('語')
  expect(selected).not.toContain('↪')
  await finish(l)
})
