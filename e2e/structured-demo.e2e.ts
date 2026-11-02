import { expect } from '@playwright/test'
import { fixture, launch, finish, test } from './app'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

async function expectDistinctRows(card: import('@playwright/test').Locator, selector: string): Promise<void> {
  const boxes = await card.locator(selector).evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0).map(box => ({ top: box.top, bottom: box.bottom })))
  expect(boxes.length).toBeGreaterThan(2)
  for (let index = 1; index < boxes.length; index++) expect(boxes[index]!.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom - 0.5)
  const layout = await card.locator('.card-header').evaluate(header => {
    const bounds = header.getBoundingClientRect(), name = header.querySelector('.card-name')!.getBoundingClientRect()
    return { nameLeft: name.left, nameRight: name.right, headerLeft: bounds.left, headerRight: bounds.right }
  })
  expect(layout.nameLeft).toBeGreaterThanOrEqual(layout.headerLeft)
  expect(layout.nameRight).toBeLessThanOrEqual(layout.headerRight)
}
async function screenshot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const directory = resolve('.evidence/audit/structured-current'); mkdirSync(directory, { recursive: true }); await page.screenshot({ path: resolve(directory, name + '.png') })
}

test('JSON Tree preserves duplicate entries and verbatim numeric lexemes from an actual file', async () => {
  const file = fixture('structured-tree.json', '{"big":12345678901234567890,"exact":3.10,"big":1e400,"nest":{"ok":true}}\n')
  const live = await launch({ hooks: true, file })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('[data-lens="tree"]')).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.tree-number').filter({ hasText: '12345678901234567890' })).toBeVisible()
    await expect(card.locator('.tree-number').filter({ hasText: '3.10' })).toBeVisible()
    await expect(card.locator('.tree-number').filter({ hasText: '1e400' })).toBeVisible()
    await expect(card.locator('.tree-row').filter({ hasText: 'Duplicate key' })).toHaveCount(1)
    await expectDistinctRows(card, '.tree-row')
    await screenshot(live.win, 'json-tree')
    await card.getByRole('tab', { name: 'Raw', exact: true }).click()
    await expect(card.locator('[data-lens="raw"]')).toBeVisible()
    await card.getByRole('tab', { name: 'Tree', exact: true }).click()
    await expect(card.locator('[data-lens="tree"]')).toBeVisible()
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('YAML worker Tree retains tags, comments, 1.2 strings and an on-demand recursive alias', async () => {
  const file = fixture('structured-worker.yaml', '# top\nvalue: 3.10 # exact\nnope: no\npower: on\ntagged: !Ref thing\nrecursive: &r [*r]\n')
  const live = await launch({ hooks: true, file })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('[data-lens="tree"]')).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.tree-number')).toHaveText('3.10 # exact')
    await expect(card.locator('.tree-string').filter({ hasText: /^no$/ })).toBeVisible()
    await expect(card.locator('.tree-string').filter({ hasText: /^on$/ })).toBeVisible()
    await expect(card.locator('.tree-string').filter({ hasText: '!Ref thing' })).toBeVisible()
    await expect(card.locator('.tree-comment')).toHaveText('# top')
    // The map is the root (no Documents wrapper for one document), so its second level opens with it.
    await expect(card.getByRole('button', { name: 'Expand recursive', exact: true })).toHaveText('⌄')
    await expect(card.locator('.tree-alias')).toHaveText('*r')
    await expect(card.locator('.tree-alias')).toBeVisible()
    await expectDistinctRows(card, '.tree-row')
    await screenshot(live.win, 'yaml-tree')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('YAML with a leading comment keeps its top-level keys at the root, the comment as their first row', async () => {
  const file = fixture('structured-leading-comment.yaml', '# launch plan\nname: pier\nsteps:\n  - survey\n  - move\n')
  const live = await launch({ hooks: true, file })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('[data-lens="tree"]')).toBeVisible({ timeout: 30_000 })
    const top = card.locator('.tree-row[aria-level="2"]')
    await expect(top).toHaveCount(3)
    await expect(top.nth(0).locator('.tree-comment')).toHaveText('# launch plan')
    await expect(top.nth(1).locator('.tree-key')).toHaveText('name: ')
    await expect(top.nth(2).locator('.tree-key')).toHaveText('steps: ')
    await expect(card.locator('.tree-row[aria-level="1"]')).toHaveText(/\{ 3 items \}/)
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('JSONL counts every source line once and reports a line cut off mid-string as the end of its input', async () => {
  const valid = Array.from({ length: 11 }, (_, index) => JSON.stringify({ ts: `12:04:${String(index).padStart(2, '0')}.100`, type: 'model', msg: `step ${index + 1}` }))
  const source = [...valid.slice(0, 5), '', ...valid.slice(5), '{"ts":"12:04:13.722","type":"model","msg":"Proposed moving the partn'].join('\n') + '\n'
  const live = await launch({ hooks: true, file: fixture('structured-truncated.jsonl', source) })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.card-status')).toHaveText('13 lines · 11 parsed · 1 failed · 1 blank')
    const failed = card.locator('.jsonl-entry[data-line="12"]')
    await expect(failed).toContainText('unexpected end of input')
    await expect(failed).not.toContainText('unescaped control')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('generic JSONL Rows retains malformed lines and Table exposes source values', async () => {
  const file = fixture('structured-rows.jsonl', '\n{"time":"2026-11-01","type":"info","message":"north pier","amount":3.10}\n{bad\n{"role":"note","text":"south pier","extra":true}\n')
  const live = await launch({ hooks: true, file })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.jsonl-row').filter({ hasText: 'north pier' })).toBeVisible()
    await expect(card.locator('.jsonl-row.structured-problem')).toContainText('{bad')
    await expectDistinctRows(card, '.jsonl-row')
    await screenshot(live.win, 'jsonl-rows')
    await card.getByRole('button', { name: 'Expand row 2', exact: true }).click()
    await expect(card.locator('.tree-number')).toHaveText('3.10')
    await card.getByRole('tab', { name: 'Table', exact: true }).click()
    await expect(card.locator('.jsonl-table')).toBeVisible()
    await expect(card.getByRole('columnheader', { name: 'amount', exact: true })).toBeVisible()
    await expect(card.getByRole('cell', { name: '3.10', exact: true })).toBeVisible()
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('JSONL Rows is one scrolling list: End reaches line 5,000 and Home line 1, with only the viewport mounted', async () => {
  const lines = Array.from({ length: 5000 }, (_, index) => JSON.stringify({ ts: `2026-11-01T09:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index % 1000).padStart(3, '0')}Z`, level: index % 2 ? 'info' : 'debug', msg: `entry ${index + 1}` }))
  const live = await launch({ hooks: true, file: fixture('structured-rows-5000.jsonl', lines.join('\n') + '\n') })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' }), row = (line: number) => card.locator(`.jsonl-entry[data-line="${line}"]`)
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    await expect(row(0).locator('.text')).toHaveText('entry 1')
    await expect(row(0).locator('.jsonl-time')).toHaveText('09:00:00.000')
    await expect(card.getByRole('button', { name: /^(Previous|Next) rows$/ })).toHaveCount(0)
    await expect(card.locator('.card-status')).toHaveText('5,000 lines · 5,000 parsed · 0 failed · 0 blank', { timeout: 30_000 })
    await row(0).locator('.jsonl-row').click()
    await live.win.keyboard.press('End')
    await expect(row(4999).locator('.text')).toHaveText('entry 5000')
    await expect(row(4999).locator('.jsonl-row')).toBeFocused()
    await expect(row(4999)).toBeInViewport()
    expect(await card.locator('.jsonl-entry').count()).toBeLessThan(120)
    await live.win.keyboard.press('Home')
    await expect(row(0).locator('.jsonl-row')).toBeFocused()
    await expect(row(0)).toBeInViewport()
    await live.win.keyboard.press('ArrowDown')
    await expect(row(1).locator('.jsonl-row')).toBeFocused()
    await live.win.keyboard.press('PageDown')
    await expect(card.locator('.jsonl-row:focus')).not.toHaveText(/entry 2$/)
    // The scrollbar reaches the end too, reading rows as they come into view.
    await card.locator('.structured-view').evaluate(view => { view.scrollTop = view.scrollHeight })
    await expect(row(4999).locator('.text')).toHaveText('entry 5000')
    await expect(row(4999)).toBeInViewport()
    expect(await card.locator('.jsonl-entry').count()).toBeLessThan(120)
    await screenshot(live.win, 'jsonl-rows-end')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('opening a 17th row closes the oldest, above the view, without moving the rows on screen', async () => {
  const lines = Array.from({ length: 120 }, (_, index) => JSON.stringify({ ts: '2026-11-01T09:00:00.000Z', level: 'info', msg: `entry ${index + 1}`, n: index, tags: ['a', 'b'] }))
  const live = await launch({ hooks: true, file: fixture('structured-rows-expand.jsonl', lines.join('\n') + '\n') })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' }), row = (line: number) => card.locator(`.jsonl-entry[data-line="${line}"]`)
    const frames = () => live.win.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    for (let line = 0; line < 16; line++) {
      await card.getByRole('button', { name: `Expand row ${line + 1}`, exact: true }).click()
      await expect(row(line).locator('.jsonl-detail .tree-row')).toHaveCount(6)
    }
    const target = row(16).locator('.jsonl-row')
    await target.scrollIntoViewIfNeeded()
    await frames()
    const before = (await target.boundingBox())!.y
    await card.getByRole('button', { name: 'Expand row 17', exact: true }).click()
    await expect(row(16).locator('.jsonl-detail .tree-row')).toHaveCount(6)
    await frames()
    expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThanOrEqual(2)
    await card.locator('.structured-view').evaluate(view => { view.scrollTop = 0 })
    await expect(row(0).locator('.jsonl-expand')).toHaveAttribute('aria-expanded', 'false')
    await expect(row(1).locator('.jsonl-expand')).toHaveAttribute('aria-expanded', 'true')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('JSONL Rows compose readable summaries, tinted type pills and clock times, never the raw record', async () => {
  const records = [
    { ts: '2026-11-01T12:04:13.722Z', type: 'tool', name: 'read_file', input: { path: 'docs/launch-plan.md' } },
    { time: '12:04:14.5', level: 'info', user: 42, ok: true, detail: { nested: 1 } },
    { created_at: 1730462653, event: 'note', summary: 'Pier survey booked' },
    { level: 'error', msg: 'Crane offline' }
  ]
  const live = await launch({ hooks: true, file: fixture('structured-summaries.jsonl', records.map(record => JSON.stringify(record)).join('\n') + '\n') })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' }), row = (line: number) => card.locator(`.jsonl-entry[data-line="${line}"]`)
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    await expect(row(0).locator('.text')).toHaveText(`read_file launch-plan.md · ${Buffer.byteLength(JSON.stringify(records[0]))} B`)
    await expect(row(0).locator('.jsonl-time')).toHaveText('12:04:13.722')
    await expect(row(0).locator('.jsonl-type')).toHaveText('tool')
    await expect(row(0).locator('.jsonl-type')).toHaveAttribute('data-tint', /^[0-5]$/)
    await expect(row(1).locator('.text')).toHaveText('user: 42 · ok: true · detail: {…}')
    await expect(row(1).locator('.jsonl-time')).toHaveText('12:04:14.500')
    await expect(row(2).locator('.text')).toHaveText('Pier survey booked')
    await expect(row(2).locator('.jsonl-time')).toHaveText('1730462653')
    await expect(row(3).locator('.jsonl-type')).toHaveAttribute('data-tint', '4')
    await expect(row(3).locator('.text')).toHaveText('Crane offline')
    await expect(card.locator('.jsonl-row .text').filter({ hasText: '{"' })).toHaveCount(0)
    const expand = card.getByRole('button', { name: 'Expand row 1', exact: true })
    expect(await expand.evaluate(button => [getComputedStyle(button).backgroundColor, getComputedStyle(button).borderStyle])).toEqual(['rgba(0, 0, 0, 0)', 'none'])
    await expand.click()
    await expect(row(0).locator('.jsonl-detail .tree-string').filter({ hasText: '"read_file"' })).toBeVisible()
    // The next line moves below the open detail once it is measured.
    await expect.poll(async () => {
      const detail = await row(0).boundingBox(), next = await row(1).boundingBox()
      return next!.y - (detail!.y + detail!.height)
    }).toBeGreaterThanOrEqual(-0.5)
    expect((await row(0).boundingBox())!.height).toBeGreaterThan(64)
    await expect(card.locator('.card-status')).toHaveText('4 lines · 4 parsed · 0 failed · 0 blank')
    await screenshot(live.win, 'jsonl-rows-summaries')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('a Claude-session-shaped JSONL reads in Rows, Table and Raw without stopping the core', async () => {
  const records = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: 'Read the launch plan and summarise it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-11-01T09:00:01.250Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\work\\pulse\\launch-plan.md' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 's1', timestamp: '2026-11-01T09:00:01.900Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# Launch plan\nMove the pier on Tuesday.' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: 's1', timestamp: '2026-11-01T09:00:03.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Short plan.' }, { type: 'text', text: 'The plan moves the pier on Tuesday.' }] } },
    { type: 'summary', summary: 'Launch plan review', leafUuid: 'a2' }
  ]
  const live = await launch({ hooks: true, file: fixture('structured-claude-shaped.jsonl', records.map(record => JSON.stringify(record)).join('\n') + '\n') })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' }), row = (line: number) => card.locator(`.jsonl-entry[data-line="${line}"]`)
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    await expect(row(0).locator('.text')).toHaveText('Read the launch plan and summarise it')
    await expect(row(1).locator('.text')).toHaveText(`Read launch-plan.md · ${Buffer.byteLength(JSON.stringify(records[1]))} B`)
    await expect(row(2).locator('.text')).toHaveText('# Launch plan Move the pier on Tuesday.')
    await expect(row(3).locator('.text')).toHaveText('The plan moves the pier on Tuesday.')
    await expect(row(4).locator('.text')).toHaveText('Launch plan review')
    await expect(row(1).locator('.jsonl-type')).toHaveText('assistant')
    await expect(row(1).locator('.jsonl-time')).toHaveText('09:00:01.250')
    await expect(card.locator('.card-status')).toHaveText('5 lines · 5 parsed · 0 failed · 0 blank')
    await card.getByRole('tab', { name: 'Table', exact: true }).click()
    await expect(card.locator('.jsonl-table')).toBeVisible()
    await card.getByRole('tab', { name: 'Raw', exact: true }).click()
    await expect(card.locator('[data-lens="raw"]')).toBeVisible()
    await card.getByRole('tab', { name: 'Rows', exact: true }).click()
    await expect(row(4).locator('.text')).toHaveText('Launch plan review')
    await expect(live.win.getByText("Typose's core stopped")).toHaveCount(0)
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('JSONL Table discovers a global key after line 1,000 and retains original source row navigation', async () => {
  const lines = Array.from({ length: 1001 }, (_, index) => `{"common":"row ${index + 1}"}`)
  lines.push('{"common":"last row","late":"revealed"}')
  const file = fixture('structured-global-columns.jsonl', lines.join('\n') + '\n')
  const live = await launch({ hooks: true, file })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' })
    await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
    await card.getByRole('tab', { name: 'Table', exact: true }).click()
    await expect(card.getByRole('columnheader', { name: 'late', exact: true })).toBeVisible({ timeout: 30_000 })
    await live.win.keyboard.press('Control+g')
    await card.locator('.go-to-bar input').fill('1002')
    await card.locator('.go-to-bar input').press('Enter')
    await expect(card.getByRole('cell', { name: '"revealed"', exact: true })).toBeVisible()
    await screenshot(live.win, 'jsonl-table-late-key')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})

test('CSV sampled metadata adds types, fitted widths and stable pills without rewriting values', async () => {
  const lines = ['code,amount,status,note', ...Array.from({ length: 1001 }, (_, index) => `00${index + 1},3.10,${index % 2 ? 'closed' : 'open'},${'a source note '.repeat(5)}`), 'late,1e2,late,new']
  const file = fixture('structured-csv-metadata.csv', lines.join('\n') + '\n')
  const live = await launch({ hooks: true, file })
  try {
    const card = live.win.getByRole('region', { name: 'Reader card 1' }), grid = card.getByRole('grid', { name: 'CSV grid', exact: true })
    await expect(grid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
    await expect(grid.getByRole('columnheader', { name: 'amount', exact: true })).toHaveAttribute('data-type', 'number')
    const first = grid.locator('[role="row"][aria-rowindex="2"]')
    await expect(first.locator('[role="gridcell"][aria-colindex="2"]')).toHaveText('001')
    await expect(first.locator('[role="gridcell"][aria-colindex="3"]')).toHaveText('3.10')
    await expect(first.locator('[role="gridcell"][aria-colindex="3"]')).toHaveClass(/csv-number/)
    await expect(first.locator('[aria-colindex="4"] .csv-value-pill')).toHaveText('open')
    await expect(first.locator('[aria-colindex="4"] .csv-value-pill')).toHaveAttribute('data-tint', '0')
    const width = await grid.getByRole('columnheader', { name: 'note', exact: true }).evaluate(node => node.getBoundingClientRect().width)
    expect(width).toBe(360)
    await screenshot(live.win, 'csv-sampled-metadata')
    await live.win.keyboard.press('Control+g')
    await card.locator('.go-to-bar input').fill('1002'); await card.locator('.go-to-bar input').press('Enter')
    await expect(grid.locator('[role="row"][aria-rowindex="1003"] [aria-colindex="4"] .csv-value-pill')).toHaveText('late')
    await expect(grid.locator('[role="row"][aria-rowindex="1003"] [aria-colindex="4"] .csv-value-pill')).toHaveAttribute('data-tint', 'neutral')
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})
