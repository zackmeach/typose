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
