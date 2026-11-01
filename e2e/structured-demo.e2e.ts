import { expect } from '@playwright/test'
import { fixture, launch, finish, test } from './app'

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
    await card.getByRole('button', { name: 'Expand row 2', exact: true }).click()
    await expect(card.locator('.tree-number')).toHaveText('3.10')
    await card.getByRole('tab', { name: 'Table', exact: true }).click()
    await expect(card.locator('.jsonl-table')).toBeVisible()
    await expect(card.getByRole('columnheader', { name: 'amount', exact: true })).toBeVisible()
    await expect(card.getByRole('cell', { name: '3.10', exact: true })).toBeVisible()
    expect(live.pageErrors).toEqual([])
  } finally { await finish(live) }
})
