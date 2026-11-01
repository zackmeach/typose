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
    await card.getByRole('button', { name: 'Expand recursive', exact: true }).click()
    await expect(card.locator('.tree-alias')).toHaveText('*r')
    await expect(card.locator('.tree-alias')).toBeVisible()
    await expectDistinctRows(card, '.tree-row')
    await screenshot(live.win, 'yaml-tree')
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
