import { expect } from '@playwright/test'
import { debugStats, fixture, launch, recordClipboard, runCommand, stubOpenDialog, test, type TestHooks } from './app'

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
test('JSON Tree preserves duplicate entries and verbatim numeric lexemes from an actual file', async () => {
  const file = fixture('structured-tree.json', '{"big":12345678901234567890,"exact":3.10,"big":1e400,"nest":{"ok":true}}\n')
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="tree"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.tree-number').filter({ hasText: '12345678901234567890' })).toBeVisible()
  await expect(card.locator('.tree-number').filter({ hasText: '3.10' })).toBeVisible()
  await expect(card.locator('.tree-number').filter({ hasText: '1e400' })).toBeVisible()
  await expect(card.locator('.tree-row').filter({ hasText: 'Duplicate key' })).toHaveCount(1)
  await expectDistinctRows(card, '.tree-row')
  await card.getByRole('tab', { name: 'Raw', exact: true }).click()
  await expect(card.locator('[data-lens="raw"]')).toBeVisible()
  await card.getByRole('tab', { name: 'Tree', exact: true }).click()
  await expect(card.locator('[data-lens="tree"]')).toBeVisible()
  expect(live.pageErrors).toEqual([])
})

test('YAML worker Tree retains tags, comments, 1.2 strings and an on-demand recursive alias', async () => {
  const file = fixture('structured-worker.yaml', '# top\nvalue: 3.10 # exact\nnope: no\npower: on\ntagged: !Ref thing\nrecursive: &r [*r]\n')
  const live = await launch({ hooks: true, file })
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
  expect(live.pageErrors).toEqual([])
})

test('YAML with a leading comment keeps its top-level keys at the root, the comment as their first row', async () => {
  const file = fixture('structured-leading-comment.yaml', '# launch plan\nname: pier\nsteps:\n  - survey\n  - move\n')
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="tree"]')).toBeVisible({ timeout: 30_000 })
  const top = card.locator('.tree-row[aria-level="2"]')
  await expect(top).toHaveCount(3)
  await expect(top.nth(0).locator('.tree-comment')).toHaveText('# launch plan')
  await expect(top.nth(1).locator('.tree-key')).toHaveText('name: ')
  await expect(top.nth(2).locator('.tree-key')).toHaveText('steps: ')
  await expect(card.locator('.tree-row[aria-level="1"]')).toHaveText(/\{ 3 items \}/)
  expect(live.pageErrors).toEqual([])
})

test('JSONL counts every source line once and reports a line cut off mid-string as the end of its input', async () => {
  const valid = Array.from({ length: 11 }, (_, index) => JSON.stringify({ ts: `12:04:${String(index).padStart(2, '0')}.100`, type: 'model', msg: `step ${index + 1}` }))
  const source = [...valid.slice(0, 5), '', ...valid.slice(5), '{"ts":"12:04:13.722","type":"model","msg":"Proposed moving the partn'].join('\n') + '\n'
  const live = await launch({ hooks: true, file: fixture('structured-truncated.jsonl', source) })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.card-status')).toHaveText('13 lines · 11 parsed · 1 failed · 1 blank')
  const failed = card.locator('.jsonl-entry[data-line="12"]')
  await expect(failed).toContainText('unexpected end of input')
  await expect(failed).not.toContainText('unescaped control')
  expect(live.pageErrors).toEqual([])
})

test('generic JSONL Rows retains malformed lines and Table exposes source values', async () => {
  const file = fixture('structured-rows.jsonl', '\n{"time":"2026-11-01","type":"info","message":"north pier","amount":3.10}\n{bad\n{"role":"note","text":"south pier","extra":true}\n')
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.jsonl-row').filter({ hasText: 'north pier' })).toBeVisible()
  await expect(card.locator('.jsonl-row.structured-problem')).toContainText('{bad')
  await expectDistinctRows(card, '.jsonl-row')
  await card.getByRole('button', { name: 'Expand row 2', exact: true }).click()
  await expect(card.locator('.tree-number')).toHaveText('3.10')
  await card.getByRole('tab', { name: 'Table', exact: true }).click()
  await expect(card.locator('.jsonl-table')).toBeVisible()
  await expect(card.getByRole('columnheader', { name: 'amount', exact: true })).toBeVisible()
  await expect(card.getByRole('cell', { name: '3.10', exact: true })).toBeVisible()
  expect(live.pageErrors).toEqual([])
})

test('JSONL Rows is one scrolling list: End reaches line 5,000 and Home line 1, with only the viewport mounted', async () => {
  const lines = Array.from({ length: 5000 }, (_, index) => JSON.stringify({ ts: `2026-11-01T09:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index % 1000).padStart(3, '0')}Z`, level: index % 2 ? 'info' : 'debug', msg: `entry ${index + 1}` }))
  const live = await launch({ hooks: true, file: fixture('structured-rows-5000.jsonl', lines.join('\n') + '\n') })
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
  expect(live.pageErrors).toEqual([])
})

test('opening a 17th row closes the oldest, above the view, without moving the rows on screen', async () => {
  const lines = Array.from({ length: 120 }, (_, index) => JSON.stringify({ ts: '2026-11-01T09:00:00.000Z', level: 'info', msg: `entry ${index + 1}`, n: index, tags: ['a', 'b'] }))
  const live = await launch({ hooks: true, file: fixture('structured-rows-expand.jsonl', lines.join('\n') + '\n') })
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
})

test('a record over 4 KiB offers Copy record in its detail, whatever its summary', async () => {
  const big = JSON.stringify({ level: 'info', msg: 'short', blob: 'x'.repeat(5 << 20) })
  const live = await launch({ hooks: true, file: fixture('structured-rows-big.jsonl', `${big}\n{"msg":"after"}\n`) })
  const card = live.win.getByRole('region', { name: 'Reader card 1' }), row = (line: number) => card.locator(`.jsonl-entry[data-line="${line}"]`)
  await expect(row(0).locator('.text')).toHaveText('short', { timeout: 30_000 })
  await card.getByRole('button', { name: 'Expand row 1', exact: true }).click()
  await expect(row(0).getByRole('button', { name: /^Copy record · [\d,. ]+ source bytes$/ })).toBeVisible()
  await card.getByRole('button', { name: 'Expand row 2', exact: true }).click()
  await expect(row(1).locator('.jsonl-detail .tree-row')).toHaveCount(2)
  await expect(row(1).getByRole('button', { name: /^Copy record/ })).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
})

test('JSONL Rows compose readable summaries, tinted type pills and clock times, never the raw record', async () => {
  const records = [
    { ts: '2026-11-01T12:04:13.722Z', type: 'tool', name: 'read_file', input: { path: 'docs/launch-plan.md' } },
    { time: '12:04:14.5', level: 'info', user: 42, ok: true, detail: { nested: 1 } },
    { created_at: 1730462653, event: 'note', summary: 'Pier survey booked' },
    { level: 'error', msg: 'Crane offline' },
    { name: 'read', arguments: JSON.stringify({ path: '/etc/hosts' }) },
    { name: 'fetch', args: JSON.stringify({ q: 'x/z' }) }
  ]
  const live = await launch({ hooks: true, file: fixture('structured-summaries.jsonl', records.map(record => JSON.stringify(record)).join('\n') + '\n') })
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
  // OpenAI-style JSON-encoded arguments: the path is read from inside them, and their JSON never shows.
  await expect(row(4).locator('.text')).toHaveText(`read hosts · ${Buffer.byteLength(JSON.stringify(records[4]))} B`)
  await expect(row(5).locator('.text')).toHaveText(`fetch · ${Buffer.byteLength(JSON.stringify(records[5]))} B`)
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
  await expect(card.locator('.card-status')).toHaveText('6 lines · 6 parsed · 0 failed · 0 blank')
  expect(live.pageErrors).toEqual([])
})

test('a Claude-session-shaped JSONL reads in Rows, Table and Raw without stopping the core', async () => {
  const records = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: 'Read the launch plan and summarise it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-11-01T09:00:01.250Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\work\\pulse\\launch-plan.md' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 's1', timestamp: '2026-11-01T09:00:01.900Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# Launch plan\nMove the pier on Tuesday.' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: 's1', timestamp: '2026-11-01T09:00:03.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Short plan.' }, { type: 'text', text: 'The plan moves the pier on Tuesday.' }] } },
    { type: 'summary', summary: 'Launch plan review', leafUuid: 'a2' },
    { type: 'user', uuid: 'u3', parentUuid: 'a2', sessionId: 's1', timestamp: '2026-11-01T09:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'Pier schedule confirmed' }] }] } }
  ]
  const live = await launch({ hooks: true, file: fixture('structured-claude-shaped.jsonl', records.map(record => JSON.stringify(record)).join('\n') + '\n') })
  const card = live.win.getByRole('region', { name: 'Reader card 1' }), row = (line: number) => card.locator(`.jsonl-entry[data-line="${line}"]`)
  // A detected session opens in Transcript (brief §5.4).
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  await card.getByRole('tab', { name: 'Rows', exact: true }).click()
  await expect(card.locator('[data-lens="rows"]')).toBeVisible()
  await expect(row(0).locator('.text')).toHaveText('Read the launch plan and summarise it')
  await expect(row(1).locator('.text')).toHaveText(`Read launch-plan.md · ${Buffer.byteLength(JSON.stringify(records[1]))} B`)
  await expect(row(2).locator('.text')).toHaveText('# Launch plan Move the pier on Tuesday.')
  await expect(row(3).locator('.text')).toHaveText('The plan moves the pier on Tuesday.')
  await expect(row(4).locator('.text')).toHaveText('Launch plan review')
  // A tool_result whose content is an array of text blocks: array hops don't count toward the depth bound.
  await expect(row(5).locator('.text')).toHaveText('Pier schedule confirmed')
  await expect(row(1).locator('.jsonl-type')).toHaveText('assistant')
  await expect(row(1).locator('.jsonl-time')).toHaveText('09:00:01.250')
  await expect(card.locator('.card-status')).toHaveText('6 lines · 6 parsed · 0 failed · 0 blank')
  await card.getByRole('tab', { name: 'Table', exact: true }).click()
  await expect(card.locator('.jsonl-table')).toBeVisible()
  await card.getByRole('tab', { name: 'Raw', exact: true }).click()
  await expect(card.locator('[data-lens="raw"]')).toBeVisible()
  await card.getByRole('tab', { name: 'Rows', exact: true }).click()
  await expect(row(4).locator('.text')).toHaveText('Launch plan review')
  await expect(live.win.getByText("Typose's core stopped")).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
})

test('Claude Transcript uses the full graph, nests tool results and preserves literal command tags', async () => {
  const records = [
    { type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'Please **inspect** <command-name>literal</command-name>.' }] } },
    { type: 'system', uuid: 'event1', parentUuid: 'u0', detail: 'Session metadata fixture' },
    { type: 'assistant', uuid: 'a1', parentUuid: 'event1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'read', input: { amount: 3.1, file: 'local.md', path: 'C:\\Users\\me\\f1.md' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '**matched result**' }] } },
    { type: 'assistant', uuid: 'old', parentUuid: 'u1', message: { role: 'assistant', content: 'Old branch fixture' } },
    { type: 'assistant', uuid: 'new', parentUuid: 'u1', message: { role: 'assistant', content: 'Latest leaf fixture' } },
    { type: 'assistant', uuid: 'side', parentUuid: 'a1', isSidechain: true, message: { role: 'assistant', content: 'Sidechain fixture' } },
    { type: 'queue-operation', operation: 'fixture' }
  ]
  const source = records.map(record => JSON.stringify(record).replace('"amount":3.1', '"amount":3.10')).join('\n') + '\n{bad\n'
  const live = await launch({ hooks: true, file: fixture('structured-claude.jsonl', source) })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.transcript-markdown strong').filter({ hasText: 'inspect' })).toBeVisible()
  await expect(card.locator('.transcript-markdown').first()).toContainText('<command-name>literal</command-name>')
  await expect(card.getByText('Latest leaf fixture', { exact: true })).toBeVisible()
  await expect(card.getByText('Old branch fixture', { exact: true })).toHaveCount(0)
  await card.getByText('1 message on another branch', { exact: true }).click()
  await expect(card.getByText('Old branch fixture', { exact: true })).toBeVisible()
  await card.getByText('Sidechain · 1 message', { exact: true }).click()
  await expect(card.getByText('Sidechain fixture', { exact: true })).toBeVisible()
  // Their members sit apart from the main chain: indented, on a guide line, as a tool's results are.
  const guides = (scope: import('@playwright/test').Locator) => scope.locator('.transcript-conversation > div').evaluateAll(groups =>
    groups.map(group => { const style = getComputedStyle(group); return `${style.marginLeft} ${style.borderLeftWidth} ${style.paddingLeft}` }))
  expect(await guides(card)).toEqual(['16px 1px 12px', '16px 1px 12px'])
  const tool = card.locator('.transcript-tool[data-tool-id="tool1"]')
  // Brief §5.4's `name(args summary)`: the input's first fields, a number as written and a string decoded.
  await expect(tool.locator('summary')).toHaveText('read(amount: 3.10, file: "local.md", path: "C:\\Users\\me\\f1.md")')
  await tool.locator('summary').click()
  await expect(tool.locator('.tree-number')).toHaveText('3.10')
  await expect(tool.locator('.transcript-tool-result strong').filter({ hasText: 'matched result' })).toBeVisible()
  await expect(card.locator('.transcript-turn > h3').filter({ hasText: /^User$/ })).toHaveCount(1)
  await expect(card.getByRole('button', { name: '1 lines couldn’t be parsed · View in Rows', exact: true })).toBeVisible()
  await card.getByRole('checkbox', { name: 'Show 2 session events', exact: true }).check()
  await expect(card.locator('.session-event')).toHaveCount(2)
  expect(live.pageErrors).toEqual([])
})

test('OpenAI dataset Transcript keeps conversations separate and tool results under their matching calls', async () => {
  const line = JSON.stringify({ messages: [{ role: 'system', content: 'System fixture' }, { role: 'user', content: 'Question fixture' }, { role: 'assistant', content: null, tool_calls: [{ id: 'reused', type: 'function', function: { name: 'lookup', arguments: '{"exact":3.10}' } }] }, { role: 'tool', tool_call_id: 'reused', content: 'Dataset result fixture' }], metadata: { fixture: true } })
  const single = JSON.stringify({ messages: [{ role: 'user', content: 'Single turn fixture' }] })
  const live = await launch({ hooks: true, file: fixture('structured-openai-dataset.jsonl', [line, line, line, single].join('\n') + '\n') })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.transcript-conversation')).toHaveCount(4)
  await expect(card.getByText('Conversation 1 · line 1 · 3 turns', { exact: true })).toBeVisible()
  await expect(card.getByText('Conversation 4 · line 4 · 1 turn', { exact: true })).toBeVisible()
  await expect(card.getByText('System prompt', { exact: true })).toHaveCount(3)
  // Line metadata holds a line's other keys, not its conversation, on the divider; a line with none has none (§5.4).
  await expect(card.getByText('Line metadata', { exact: true })).toHaveCount(3)
  const first = card.locator('.transcript-conversation').first(), metadata = first.locator('> details')
  expect(await first.evaluate(group => [...group.children].map(child => child.tagName))).toEqual(['SUMMARY', 'DETAILS', 'DIV'])
  await metadata.locator('> summary').click()
  await expect(metadata.locator('.tree-key')).toHaveText(['metadata: ', 'fixture: '])
  // A dataset's conversations are the file's own, not off a chain: no indent.
  expect(await card.locator('.transcript-conversation > div').evaluateAll(groups => groups.map(group => getComputedStyle(group).borderLeftWidth)))
    .toEqual(['0px', '0px', '0px', '0px'])
  const tool = card.locator('.transcript-tool[data-tool-id="reused"]').first()
  // The arguments are parsed from their JSON string (§5.4): summarised and shown as a Claude call's input is.
  await expect(tool.locator('> summary')).toHaveText('lookup(exact: 3.10)')
  await tool.locator('summary').click()
  await expect(tool.locator('.tree-key')).toHaveText(['exact: '])
  await expect(tool.locator('.tree-number')).toHaveText('3.10')
  await expect(tool.locator('.transcript-tool-result').getByText('Dataset result fixture', { exact: true })).toBeVisible()
  await expect(card.locator('.transcript-turn > h3').filter({ hasText: /^Tool$/ })).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
})

test('OpenAI arguments parse from their JSON string, numbers as written, and what isn’t JSON shows as the string', async () => {
  // Each call's arguments, under its name: what parses, hostile inputs, and what stays as it is.
  const calls: [string, unknown][] = [
    ['numbers', '{"exact":3.10,"huge":1e400,"digits":123456789012345678901234567890}'],
    ['keys', '{"__proto__":{"polluted":true},"a":1,"a":2}'],
    // A lone surrogate escaped in the JSON, and one in the string itself, which only the outer escape can hold.
    ['surrogates', '{"escaped":"\\ud800","decoded":"\ud800"}'],
    ['nuls', '{"escaped":"\\u0000"}'],
    // A NUL in the string itself is a raw control character in the JSON it holds: not JSON.
    ['nul', '{"decoded":"\u0000"}'],
    // JSON in JSON: one level is parsed, so the value is a string.
    ['nested', JSON.stringify(JSON.stringify({ a: 1 }))],
    // A key past the 4 KiB a node's key shows.
    ['longkey', JSON.stringify({ ['k'.repeat(5000)]: 1 })],
    // 64 KiB of source, quotes included: in the bound, but deeper than the scanner nests.
    ['deep', '['.repeat(65_534)],
    ['big', JSON.stringify({ big: 'x'.repeat(70_000) })],
    ['invalid', '{"a":'],
    ['empty', ''],
    ['object', {}],
    ['none', null]
  ]
  const lines = [{ role: 'user', content: 'Arguments fixture' }, ...calls.map(([name, args]) =>
    ({ role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: args } }] }))]
  const live = await launch({ hooks: true, file: fixture('transcript-arguments.jsonl', lines.map(line => JSON.stringify(line)).join('\n') + '\n') })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  const open = async (name: string, summary: string | RegExp) => {
    const tool = card.locator(`.transcript-tool[data-tool-id="${name}"]`)
    await expect(tool.locator('> summary')).toHaveText(summary)
    await tool.locator('> summary').click()
    return tool
  }
  let tool = await open('numbers', 'numbers(exact: 3.10, huge: 1e400, digits: 123456789012345678901234567890)')
  await expect(tool.locator('.tree-object')).toHaveText('{ 3 items }')
  await expect(tool.locator('.tree-number')).toHaveText(['3.10', '1e400', '123456789012345678901234567890'])
  tool = await open('keys', 'keys(__proto__: {…}, a: 1, a: 2)')
  await expect(tool.locator('.tree-key')).toHaveText(['__proto__: ', 'a: ', 'a: '])
  await expect(tool.locator('.tree-row').filter({ hasText: 'Duplicate key' })).toHaveCount(1)
  expect(await live.win.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined()
  tool = await open('surrogates', /^surrogates\(escaped: ".", decoded: "\uFFFD+"\)$/u)
  await expect(tool.locator('.tree-string')).toHaveText(['"\\ud800"', /^"\uFFFD+"$/u])
  tool = await open('nuls', 'nuls(escaped: "\u0000")')
  await expect(tool.locator('.tree-string')).toHaveText('"\\u0000"')
  tool = await open('nested', 'nested({"a":1})')
  await expect(tool.locator('.tree-key')).toHaveCount(0)
  await expect(tool.locator('.tree-string')).toHaveText('"{\\"a\\":1}"')
  // A parsed key isn't in the source as such, so its preview promises no Copy key.
  tool = await open('longkey', `longkey(${'k'.repeat(80)} …)`)
  await expect(tool.locator('.tree-key')).toHaveText(/^k{4095} … \(key preview\): $/)
  // Not parsed: the string, as before.
  for (const [name, summary] of [['nul', 'nul({"decoded":"\u0000"})'], ['deep', `deep(${'['.repeat(80)} …)`],
    ['big', `big({"big":"${'x'.repeat(72)} …)`], ['invalid', 'invalid({"a":)'], ['empty', 'empty()']] as const) {
    tool = await open(name, summary)
    await expect(tool.locator('.tree-key')).toHaveCount(0)
    await expect(tool.locator('.tree-string')).toHaveCount(1)
  }
  // Their long strings wrap in the reading column: the Transcript doesn't scroll sideways.
  const { scrollWidth, clientWidth } = await card.locator('.structured-view').evaluate(view => ({ scrollWidth: view.scrollWidth, clientWidth: view.clientWidth }))
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  // Arguments that aren't a string show as they are.
  tool = await open('object', 'object()')
  await expect(tool.locator('.tree-object')).toHaveText('{ 0 items }')
  tool = await open('none', 'none(null)')
  await expect(tool.locator('.tree-null')).toHaveText('null')
  expect(live.pageErrors).toEqual([])
})

test('Line metadata pages a wide line only up to the Tree’s 2,000-node limit, so a later Tree still expands', async () => {
  // 2,500 other keys around the conversation, and a second `messages`, which is other data.
  const conversation = JSON.stringify([{ role: 'user', content: 'Wide fixture' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'later', type: 'function', function: { name: 'later', arguments: '{"a":1,"b":2,"c":3}' } }] }])
  const keys = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `"k${from + i}":${from + i}`).join(',')
  const wide = `{${keys(0, 5)},"messages":${conversation},"messages":[{"role":"user","content":"duplicate"}],${keys(5, 2500)}}`
  const single = JSON.stringify({ messages: [{ role: 'user', content: 'Single fixture' }] })
  const live = await launch({ hooks: true, file: fixture('transcript-wide-metadata.jsonl', [wide, single, single].join('\n') + '\n') })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  const group = card.locator('.transcript-conversation').first(), metadata = group.locator('> details')
  await metadata.locator('> summary').click()
  const more = metadata.getByRole('button', { name: 'Show more line metadata', exact: true })
  const limit = metadata.getByText('Tree display limit reached (2,000 nodes) · View in Raw or copy the source value', { exact: true })
  await expect(more.or(limit)).toBeVisible()
  while (await more.isVisible()) {
    await more.click()
    await expect(more.or(limit)).toBeVisible()
  }
  await expect(limit).toBeVisible()
  expect(await metadata.locator(':scope > .tree-entry').count()).toBeLessThanOrEqual(2000)
  // The second `messages` shows; the first, the conversation, doesn't.
  await expect(metadata.locator(':scope > .tree-entry > .tree-row > .tree-key').filter({ hasText: /^messages: $/ })).toHaveCount(1)
  const tool = group.locator('.transcript-tool[data-tool-id="later"]')
  await tool.locator('> summary').click()
  await tool.locator('.tree-fold').first().click()
  await expect(tool.locator('.tree-key')).toHaveText(['a: ', 'b: ', 'c: '])
  expect(live.pageErrors).toEqual([])
})

/** A Claude Code session of `turns` on one chain: each turn's record the child of the one before. */
const claudeSession = (turns: { role: 'user' | 'assistant'; content: unknown }[]): string =>
  turns.map((message, i) => JSON.stringify({ type: message.role, uuid: `t${i}`, parentUuid: i ? `t${i - 1}` : null, message })).join('\n') + '\n'

test('Transcript shows a refused Markdown block as literal text, and a failing item never fails its page', async () => {
  // One 48 KB paragraph: under the text query's 64 KiB, but its HTML passes the core's display bound, so it's refused.
  const long = 'refused '.repeat(6000)
  const file = fixture('transcript-refused.jsonl', claudeSession([
    { role: 'user', content: 'Before fixture' },
    { role: 'assistant', content: [{ type: 'text', text: long }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool9', name: 'read', input: { file: 'local.md' } }] },
    { role: 'user', content: 'After fixture' }
  ]))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('After fixture', { exact: true })).toBeVisible()
  expect(await card.locator('pre.transcript-text').textContent()).toBe(long)
  // One item's query fails (injected here): that item says so, and the rest of its page shows.
  await live.win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core, call = core.call.bind(core)
    core.call = (...args: Parameters<typeof call>) => args[0] === 'structuredTranscriptTools' ? Promise.reject(new Error('tools fixture failure')) : call(...args)
  })
  await card.getByRole('tab', { name: 'Rows', exact: true }).click()
  await card.getByRole('tab', { name: 'Transcript', exact: true }).click()
  await expect(card.getByRole('button', { name: 'This item couldn’t be shown · tools fixture failure · View in Rows', exact: true })).toBeVisible()
  await expect(card.getByText('Before fixture', { exact: true })).toBeVisible()
  await expect(card.getByText('After fixture', { exact: true })).toBeVisible()
  expect(live.pageErrors).toEqual([])
})

test('Transcript reserves the mounted page’s HTML, flat to the last page, and releases it when it unmounts', async () => {
  // Five pages of 20 identical turns: each page's HTML is the same size.
  const text = 'Bounded page fixture '.repeat(48)
  const file = fixture('transcript-pages.jsonl', claudeSession(Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: text }))))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  // What the renderer holds reserved for its one document's view.
  const held = async () => (await debugStats(live.win)).surfaces!.bytes
  await expect(card.getByText('1–20 of 100', { exact: true })).toBeVisible({ timeout: 30_000 })
  const first = await held()
  for (let page = 1; page < 5; page++) {
    await card.getByRole('button', { name: 'Next turns', exact: true }).click()
    await expect(card.getByText(`${page * 20 + 1}–${page * 20 + 20} of 100`, { exact: true })).toBeVisible()
  }
  // Each page replaces the one before and its charge: the fifth holds what the first did.
  await expect.poll(held).toBe(first)
  await card.getByRole('tab', { name: 'Rows', exact: true }).click()
  await expect(card.locator('[data-lens="rows"]')).toBeVisible()
  await expect.poll(held).toBeLessThan(first)
  expect(live.pageErrors).toEqual([])
})

test('Transcript shows HTML-like tags in message text as literal text, never interpreted or stripped', async () => {
  const texts = [
    // Raw HTML that Rendered keeps (b, img) or drops (a stray end tag), beside Markdown that renders.
    'Reply <b>bold?</b> <img src="local.png" alt="pic"> stray </i> and **this** stays Markdown',
    // A CommonMark type-6 HTML block.
    '<details>\n<summary>open?</summary>\nhidden?\n</details>',
    // Round 1's bypasses of a renderer-side check: a lone surrogate before the tag, and a source map in the text.
    '\ud800<b>surrogate</b> after a lone surrogate',
    'See data-source-map="L:0:1:9999" then <b>mapped</b>',
    'Code `<b>` stays code'
  ]
  const file = fixture('transcript-tags.jsonl', claudeSession([
    ...texts.map((text, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: [{ type: 'text', text }] })),
    { role: 'assistant', content: 'Done fixture' }
  ]))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('Done fixture', { exact: true })).toBeVisible()
  const markdown = card.locator('.transcript-markdown')
  await expect(markdown).toHaveCount(texts.length + 1)
  await expect(card.locator('pre.transcript-text')).toHaveCount(0)
  await expect(markdown.locator('b, i, details, summary, .tp-img')).toHaveCount(0)
  await expect(markdown.nth(0)).toHaveText('Reply <b>bold?</b> <img src="local.png" alt="pic"> stray </i> and this stays Markdown')
  await expect(markdown.nth(0).locator('strong')).toHaveText('this')
  // The HTML block keeps its lines, as a paragraph of its own.
  const block = markdown.nth(1).locator('.md-block > p')
  await expect(block.locator('br')).toHaveCount(3)
  expect(await block.evaluate(paragraph => (paragraph as HTMLElement).innerText)).toBe('<details>\n<summary>open?</summary>\nhidden?\n</details>')
  await expect(markdown.nth(2)).toContainText('<b>surrogate</b> after a lone surrogate')
  await expect(markdown.nth(3)).toHaveText('See data-source-map="L:0:1:9999" then <b>mapped</b>')
  await expect(markdown.nth(4).locator('code')).toHaveText('<b>')
  expect(live.pageErrors).toEqual([])
})

test('a Transcript graph that is off says why, where a disabled structured lens does', async () => {
  // A parent cycle (the core's own fixture) turns the graph off; Rows remains.
  const file = fixture('transcript-cycle.jsonl', [
    { type: 'user', uuid: 'a', parentUuid: 'b', message: { role: 'user', content: 'a' } },
    { type: 'assistant', uuid: 'b', parentUuid: 'a', message: { role: 'assistant', content: 'b' } },
    { type: 'user', uuid: 'z', parentUuid: null, message: { role: 'user', content: 'z' } }
  ].map(record => JSON.stringify(record)).join('\n') + '\n')
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' }), reason = 'Transcript parent graph contains a cycle; inspect in Rows'
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  const transcript = card.getByRole('tab', { name: 'Transcript', exact: true })
  await expect(transcript).toBeDisabled()
  await expect(transcript.getByTitle(reason)).toBeVisible()
  await card.getByRole('button', { name: 'File info', exact: true }).click()
  await expect(live.win.getByRole('dialog', { name: 'File info' }).getByText(reason, { exact: true })).toBeVisible()
  expect(live.pageErrors).toEqual([])
})

test('a branch whose first record is a hidden tool result is labelled and anchored by what it shows (F6)', async () => {
  // The branch's records in file order: r1b, a results-only record (its result nests under tool1), then b1. 150 session
  // events before them put r1b at line 153, far enough down that Rows opened there wouldn't show line 1.
  const file = fixture('transcript-f6.jsonl', [
    { type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: 'Question fixture' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u0', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'read', input: { file: 'local.md' } }] } },
    ...Array.from({ length: 150 }, () => ({ type: 'queue-operation', operation: 'padding fixture' })),
    { type: 'user', uuid: 'r1b', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'Retried result fixture' }] } },
    { type: 'assistant', uuid: 'b1', parentUuid: 'r1b', message: { role: 'assistant', content: 'Branch reply fixture' } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'Main result fixture' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'r1', message: { role: 'assistant', content: 'Main answer fixture' } }
  ].map(record => JSON.stringify(record)).join('\n') + '\n')
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  const branch = card.locator('.transcript-conversation')
  await expect(branch.locator('summary').first()).toHaveText('1 message on another branch')
  await expect(branch).not.toHaveAttribute('data-line')
  await branch.locator('summary').first().click()
  await expect(branch.locator('.transcript-turn > h3')).toHaveText(['Assistant'])
  await expect(branch.getByText('Branch reply fixture', { exact: true })).toBeVisible()
  const tool = card.locator('.transcript-tool[data-tool-id="tool1"]')
  await tool.locator('summary').click()
  await expect(tool.locator('.transcript-tool-result')).toHaveCount(2)
  // The branch's own load fails (injected): its failure link opens Rows without a line, never at the hidden record's.
  await live.win.evaluate(() => {
    const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core, call = core.call.bind(core)
    core.call = (...args: Parameters<typeof call>) =>
      args[0] === 'structuredTranscript' && (args[1] as { group?: number }).group !== undefined ? Promise.reject(new Error('group fixture failure')) : call(...args)
  })
  await card.getByRole('tab', { name: 'Rows', exact: true }).click()
  await card.getByRole('tab', { name: 'Transcript', exact: true }).click()
  await card.locator('.transcript-conversation > summary').click()
  await card.getByRole('button', { name: 'This item couldn’t be shown · group fixture failure · View in Rows', exact: true }).click()
  await expect(card.locator('[data-lens="rows"]')).toBeVisible()
  await expect(card.locator('.jsonl-entry[data-line="0"]')).toBeVisible()
  expect(live.pageErrors).toEqual([])
})

test('reading Rows by keyboard while the graph indexes keeps Rows when the Transcript becomes ready', async () => {
  const file = fixture('transcript-keyboard.jsonl', claudeSession(Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Keyboard turn ${i}` }))))
  const live = await launch({ hooks: true })
  await live.win.waitForFunction(() => 'typoseTest' in window)
  // The graph is "still indexing" until the test says: the first build reply is marked not ready, and the next waits.
  await live.win.evaluate(() => {
    const w = window as unknown as { typoseTest: TestHooks; ready?: () => void }, core = w.typoseTest.core, call = core.call.bind(core)
    const ready = new Promise<void>(done => { w.ready = done })
    let builds = 0
    core.call = async (...args: Parameters<typeof call>) => {
      const reply = await call(...args) as { done: boolean; transcript?: { ready: boolean } }
      if (args[0] !== 'structuredBuild') return reply
      if (++builds === 1) return { ...reply, done: false, transcript: { ...reply.transcript!, ready: false } }
      await ready
      return reply
    }
  })
  await stubOpenDialog(live.app, file)
  await runCommand(live.win, 'Open file…')
  await live.win.getByRole('button', { name: 'Browse…', exact: true }).click()
  const card = live.win.getByRole('region', { name: 'Reader card 1' }), transcript = card.getByRole('tab', { name: 'Transcript', exact: true })
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  await expect(transcript).toBeDisabled()
  await card.locator('.structured-view').focus()
  await live.win.keyboard.press('ArrowDown')
  await live.win.keyboard.press('ArrowDown')
  await live.win.evaluate(() => (window as unknown as { ready: () => void }).ready())
  await expect(transcript).toBeEnabled()
  await expect(card.locator('[data-lens="rows"]')).toBeVisible()
  await expect(card.locator('[data-lens="transcript"]')).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
})

test('Transcript paging starts each page at its top', async () => {
  const text = 'Bounded page fixture '.repeat(48)
  const file = fixture('transcript-scroll.jsonl', claudeSession(Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i} ${text}` }))))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' }), view = card.locator('.structured-view')
  await expect(card.getByText('1–20 of 100', { exact: true })).toBeVisible({ timeout: 30_000 })
  const bottom = () => view.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop })
  expect(await bottom()).toBeGreaterThan(0)
  await card.getByRole('button', { name: 'Next turns', exact: true }).click()
  await expect(card.getByText('21–40 of 100', { exact: true })).toBeVisible()
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBe(0)
  await expect(card.getByText('Turn 20 ', { exact: false })).toBeInViewport()
  expect(await bottom()).toBeGreaterThan(0)
  await card.getByRole('button', { name: 'Previous turns', exact: true }).click()
  await expect(card.getByText('1–20 of 100', { exact: true })).toBeVisible()
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBe(0)
  expect(live.pageErrors).toEqual([])
})

test('Transcript paging ignores Next while a page builds, and each Previous goes back one page', async () => {
  const file = fixture('transcript-paging.jsonl', claudeSession(Array.from({ length: 140 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Paging turn ${i}` }))))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' }), previous = card.getByRole('button', { name: 'Previous turns', exact: true })
  await expect(card.getByText('1–20 of 140', { exact: true })).toBeVisible({ timeout: 30_000 })
  // Five clicks in one task: the first starts page 2, and the rest land while it builds.
  await card.getByRole('button', { name: 'Next turns', exact: true }).evaluate(next => { for (let i = 0; i < 5; i++) (next as HTMLButtonElement).click() })
  await expect(card.getByText('21–40 of 140', { exact: true })).toBeVisible()
  await previous.click()
  await expect(card.getByText('1–20 of 140', { exact: true })).toBeVisible()
  await expect(previous).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
})

test('a Markdown block the core makes a note (nested too deep) shows its text literally', async () => {
  // 70 nested quotes pass md.rs's MAX_DEPTH: the block comes back as a note, with no HTML.
  const deep = '>'.repeat(70) + ' deep content fixture'
  const file = fixture('transcript-deep.jsonl', claudeSession([
    { role: 'user', content: deep },
    { role: 'assistant', content: 'Reply fixture' },
    { role: 'user', content: 'Done fixture' }
  ]))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('Done fixture', { exact: true })).toBeVisible()
  await expect(card.locator('pre.transcript-text')).toHaveText(deep)
  expect(live.pageErrors).toEqual([])
})

test('a Transcript link without a target (javascript:, dropped by the sanitizer) sends nothing to the core', async () => {
  const file = fixture('transcript-links.jsonl', claudeSession([
    { role: 'user', content: 'Run [this link](javascript:alert(1)) now' },
    { role: 'assistant', content: 'Reply fixture' },
    { role: 'user', content: 'Done fixture' }
  ]))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  const link = card.locator('.transcript-markdown a')
  await expect(link).toHaveText('this link')
  await expect(link).not.toHaveAttribute('data-href')
  await live.win.evaluate(() => {
    const w = window as unknown as { typoseTest: TestHooks; calls: string[] }, core = w.typoseTest.core, call = core.call.bind(core)
    w.calls = []
    core.call = (...args: Parameters<typeof call>) => { w.calls.push(args[0]); return call(...args) }
  })
  await link.click()
  // A link's open is asynchronous (a peek card, then the core): give it time to reach the core if it would.
  await live.win.waitForTimeout(1500)
  expect(await live.win.evaluate(() => (window as unknown as { calls: string[] }).calls)).not.toContain('openLocal')
  expect(live.pageErrors).toEqual([])
})

test('a text over 64 KiB previews its decoded start, not its JSON source', async () => {
  const file = fixture('transcript-long.jsonl', claudeSession([
    { role: 'user', content: 'line one\nline "two"\n' + 'z'.repeat(70_000) },
    { role: 'assistant', content: 'Reply fixture' },
    { role: 'user', content: 'Done fixture' },
    // Escaped surrogate pairs, the 4,096-byte preview cut falling between a pair's two escapes.
    { role: 'assistant', content: 'a'.repeat(6) + '@'.repeat(6000) }
  ]).replace(/@/g, '\\uD83D\\uDE00'))
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="transcript"]')).toBeVisible({ timeout: 30_000 })
  const preview = card.locator('pre.transcript-text')
  await expect(preview).toHaveCount(2)
  const text = (await preview.first().textContent())!
  expect(text.slice(0, 24)).toBe('line one\nline "two"\nzzzz')
  expect(text.endsWith('z … (source preview)')).toBe(true)
  // The cut leaves no lone high surrogate.
  expect(await preview.nth(1).textContent()).toBe('a'.repeat(6) + '\u{1F600}'.repeat(340) + ' … (source preview)')
  await expect(card.getByRole('button', { name: 'View complete content in Rows', exact: true })).toHaveCount(2)
  expect(live.pageErrors).toEqual([])
})

test('JSONL Table discovers a global key after line 1,000 and retains original source row navigation', async () => {
  const lines = Array.from({ length: 1001 }, (_, index) => `{"common":"row ${index + 1}"}`)
  lines.push('{"common":"last row","late":"revealed"}')
  const file = fixture('structured-global-columns.jsonl', lines.join('\n') + '\n')
  const live = await launch({ hooks: true, file })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  await card.getByRole('tab', { name: 'Table', exact: true }).click()
  await expect(card.getByRole('columnheader', { name: 'late', exact: true })).toBeVisible({ timeout: 30_000 })
  await live.win.keyboard.press('ControlOrMeta+g')
  await card.locator('.go-to-bar input').fill('1002')
  await card.locator('.go-to-bar input').press('Enter')
  await expect(card.getByRole('cell', { name: '"revealed"', exact: true })).toBeVisible()
  expect(live.pageErrors).toEqual([])
})

test('CSV sampled metadata adds types, fitted widths and stable pills without rewriting values', async () => {
  const lines = ['code,amount,status,note', ...Array.from({ length: 1001 }, (_, index) => `00${index + 1},3.10,${index % 2 ? 'closed' : 'open'},${'a source note '.repeat(5)}`), 'late,1e2,late,new']
  const file = fixture('structured-csv-metadata.csv', lines.join('\n') + '\n')
  const live = await launch({ hooks: true, file })
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
  await live.win.keyboard.press('ControlOrMeta+g')
  await card.locator('.go-to-bar input').fill('1002'); await card.locator('.go-to-bar input').press('Enter')
  await expect(grid.locator('[role="row"][aria-rowindex="1003"] [aria-colindex="4"] .csv-value-pill')).toHaveText('late')
  await expect(grid.locator('[role="row"][aria-rowindex="1003"] [aria-colindex="4"] .csv-value-pill')).toHaveAttribute('data-tint', 'neutral')
  expect(live.pageErrors).toEqual([])
})

for (const [name, source, value, key] of [
  ['structured-copy.json', '{"name":"café","n":3.10}\n', '"café"', '"name"'],
  ['structured-copy.yaml', 'name: café\nn: 3.10\n', 'café', 'name']
] as const) test(`${name.endsWith('.json') ? 'JSON' : 'YAML'} Tree Ctrl+C, Copy value, Copy key and Copy path write source text`, async () => {
  const live = await launch({ hooks: true, file: fixture(name, source) })
  const copied = await recordClipboard(live.app)
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="tree"]')).toBeVisible({ timeout: 30_000 })
  const row = card.locator('.tree-row').filter({ hasText: 'name:' })
  await row.click()
  await live.win.keyboard.press('ControlOrMeta+c')
  await expect.poll(copied).toEqual([value])
  for (const item of ['Copy value (source text)', 'Copy key', 'Copy path']) {
    await row.click({ button: 'right' })
    await card.getByRole('button', { name: item, exact: true }).click()
  }
  await expect.poll(copied).toEqual([value, value, key, '$["name"]'])
  expect(live.pageErrors).toEqual([])
})

test('JSONL Rows Copy record writes the long record’s source text', async () => {
  const long = JSON.stringify({ message: 'north pier '.repeat(500) })
  const live = await launch({ hooks: true, file: fixture('structured-copy-record.jsonl', long + '\n{"message":"short"}\n') })
  const copied = await recordClipboard(live.app)
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  // Rows keeps Copy record in the row's detail.
  await card.getByRole('button', { name: 'Expand row 1', exact: true }).click()
  await card.getByRole('button', { name: `Copy record · ${(long.length + 1).toLocaleString('en-US')} source bytes`, exact: true }).click()
  await expect.poll(async () => (await copied()).map(text => text.replace(/\r?\n$/, ''))).toEqual([long])
  expect(live.pageErrors).toEqual([])
})
