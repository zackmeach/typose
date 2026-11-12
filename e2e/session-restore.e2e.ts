import { expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { FIXTURES, type TestHooks, debugStats, finish, fixture, launch, runCommand, sparseFixture, stubOpenDialog, test, waitOpen } from './app'
import { emptySession } from '../app/shared/session'

test('actual restart preserves cards, selected tabs, lenses and anchors, and keeps missing locations visible', async () => {
  const first = fixture('session-first.md', Array.from({ length: 150 }, (_, line) => `Source line ${line + 1}`).join('\n'))
  const second = fixture('session-second.md', '# Second tab\n')
  const csv = fixture('session-grid.csv', 'name,value\na,1\nb,2\nc,3\n')
  const userData = mkdtempSync(join(tmpdir(), 'typose-session-restart-'))
  const absentRoot = join(userData, 'missing-root')
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ ...emptySession(), roots: [absentRoot], focused: 1,
    cards: [
      { tabs: [{ location: { kind: 'manual', path: first }, anchor: 30, lens: 'raw' }, { location: { kind: 'manual', path: second }, anchor: 0, lens: 'rendered' }], selected: 0, weight: 1 },
      { tabs: [{ location: { kind: 'manual', path: csv }, anchor: 0, lens: 'grid', csvOptions: { delimiter: ',', header: true } }], selected: 0, weight: 1 }
    ] }))
  const live = await launch({ userData })
  const cards = live.win.getByRole('region', { name: /^Reader card/ })
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0).getByRole('tab', { name: 'session-first.md' })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await expect(cards.nth(0).locator('.raw-host')).toBeVisible()
  await expect.poll(() => cards.nth(0).locator('.vl-scroller').evaluate(node => node.scrollTop)).toBeGreaterThan(300)
  await expect(cards.nth(1).getByRole('grid', { name: 'CSV grid' })).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
  await expect(cards.nth(1)).toHaveAttribute('data-focused', 'true')
  expect(live.pageErrors).toEqual([])
  expect(await finish(live, true)).toEqual({ code: 0, signal: null })
  const saved = JSON.parse(readFileSync(join(userData, 'session.json'), 'utf8'))
  expect(saved.cards).toHaveLength(2)
  expect(saved.cards[0].tabs[0].anchor).toBeGreaterThanOrEqual(29)
  expect(saved.cards[1].tabs[0].lens).toBe('grid')
  expect(saved.roots).toEqual([{ path: absentRoot }])
  expect(saved.recents).toContainEqual({ kind: 'file', path: csv })
  rmSync(csv)
  const resumed = await launch({ userData })
  const restored = resumed.win.getByRole('region', { name: /^Reader card/ })
  await expect(restored).toHaveCount(2)
  await expect(restored.nth(0).getByRole('tab', { name: 'session-first.md' })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await expect(restored.nth(1)).toContainText('File not found at ' + csv)
  await expect(restored.nth(1).getByRole('button', { name: 'Locate…', exact: true })).toBeVisible()
  await expect(restored.nth(1).getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  const replacement = fixture('session-located.csv', 'name,value\nFound again,27\n')
  await stubOpenDialog(resumed.app, replacement)
  await restored.nth(1).getByRole('button', { name: 'Locate…', exact: true }).click()
  await expect(restored.nth(1).getByRole('tab', { name: 'session-located.csv', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(restored.nth(1).getByText('Found again', { exact: true })).toBeInViewport()
  await expect(restored.nth(1).getByRole('tab', { name: 'session-grid.csv', exact: true })).toHaveCount(0)
  expect(resumed.pageErrors).toEqual([])
  expect(await finish(resumed)).toEqual({ code: 0, signal: null })
})

test('a tab saved in Transcript whose graph is off restores in Rows, with Transcript disabled', async () => {
  // A parent cycle (the core's own fixture) turns the transcript graph off; Rows remains.
  const file = fixture('session-transcript-cycle.jsonl', [
    { type: 'user', uuid: 'a', parentUuid: 'b', message: { role: 'user', content: 'a' } },
    { type: 'assistant', uuid: 'b', parentUuid: 'a', message: { role: 'assistant', content: 'b' } },
    { type: 'user', uuid: 'z', parentUuid: null, message: { role: 'user', content: 'z' } }
  ].map(record => JSON.stringify(record)).join('\n') + '\n')
  const userData = mkdtempSync(join(tmpdir(), 'typose-session-transcript-'))
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ ...emptySession(),
    cards: [{ tabs: [{ location: { kind: 'manual', path: file }, anchor: 0, lens: 'transcript' }], selected: 0, weight: 1 }] }))
  const live = await launch({ hooks: true, userData })
  const card = live.win.getByRole('region', { name: 'Reader card 1' })
  await expect(card.locator('[data-lens="rows"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByRole('tab', { name: 'Transcript', exact: true })).toBeDisabled()
  await expect(card.locator('[data-lens="transcript"]')).toHaveCount(0)
  await expect(card.locator('.structured-problem')).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
})

test('a network share in the saved session stays unopened until a click', async () => {
  test.skip(process.platform !== 'win32', 'UNC shares are Windows paths')
  const share = String.raw`\\example.invalid\typose-probe-no-such-share`
  const file = share + String.raw`\a.md`
  const userData = mkdtempSync(join(tmpdir(), 'typose-network-restart-'))
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ ...emptySession(), roots: [share], sidebar: { open: true, width: 240 },
    cards: [{ tabs: [{ location: { kind: 'manual', path: file }, anchor: 0, lens: 'raw' }], selected: 0, weight: 1 }] }))
  const live = await launch({ userData })
  const card = live.win.getByRole('region', { name: 'Reader card 1', exact: true })
  // Any open of the path would replace this placeholder with an opening or failed card.
  await expect(card).toContainText(`${file} is on a network share · Not opened at launch. Retry to connect.`, { timeout: 30_000 })
  await expect(live.win.getByRole('status').filter({ hasText: 'Network folder · not opened at launch' })).toBeVisible()
  await expect(live.win.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await expect(live.win.getByText('Folder not found', { exact: false })).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
  expect(await finish(live, true)).toEqual({ code: 0, signal: null })
  // Unclicked, both stay what they were: a manual tab and a root, for the next launch to leave alone again.
  const saved = JSON.parse(readFileSync(join(userData, 'session.json'), 'utf8'))
  expect(saved.cards[0].tabs[0].location).toEqual({ kind: 'manual', path: file })
  expect(saved.roots).toEqual([{ path: share }])
  const resumed = await launch({ userData })
  const again = resumed.win.getByRole('region', { name: 'Reader card 1', exact: true })
  await expect(again).toContainText('Not opened at launch', { timeout: 30_000 })
  await again.getByRole('button', { name: 'Retry', exact: true }).click()
  // The click is what opens it: the share doesn't exist, so the card shows that open's own failure.
  await expect(again).not.toContainText('Not opened at launch', { timeout: 90_000 })
  await expect(again.getByRole('button', { name: 'Close', exact: true })).toBeVisible({ timeout: 90_000 })
  expect(resumed.pageErrors).toEqual([])
  expect(await finish(resumed)).toEqual({ code: 0, signal: null })
  rmSync(userData, { recursive: true, force: true })
})

test('a persisted derived display path cannot acquire manual file authority on restart', async () => {
  const target = fixture('session-derived.md', '# Must not reopen by display path\n')
  const userData = mkdtempSync(join(tmpdir(), 'typose-derived-restart-'))
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ ...emptySession(), cards: [
    { tabs: [{ location: { kind: 'reselect', path: target, ticket: { session: 1, id: 'expired-native-ticket' } }, anchor: 0, lens: 'rendered' }], selected: 0, weight: 1 }
  ] }))
  const live = await launch({ userData })
  await expect(live.win.getByText('The source must be selected again after restart', { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(live.win.getByRole('button', { name: 'Locate…', exact: true })).toBeVisible()
  await expect(live.win.getByRole('heading', { name: 'Must not reopen by display path' })).toHaveCount(0)
  expect(live.pageErrors).toEqual([])
  expect(await finish(live, true)).toEqual({ code: 0, signal: null })
  const saved = readFileSync(join(userData, 'session.json'), 'utf8')
  expect(saved).not.toContain('expired-native-ticket')
  expect(JSON.parse(saved).cards[0].tabs[0].location.kind).toBe('reselect')
  rmSync(userData, { recursive: true, force: true })
})

test('native-derived capture remains a reselect record across an actual restart', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  fixture('session-native-derived-target.md', '# Native derived target\n')
  const source = fixture('session-native-derived-source.md', '# Native source\n\n[Target](session-native-derived-target.md)\n')
  const live = await launch({ file: source })
  await expect(live.win.getByRole('link', { name: 'Target', exact: true })).toBeVisible({ timeout: 30_000 })
  await live.win.getByRole('link', { name: 'Target', exact: true }).click({ modifiers: ['Control'] })
  await expect(live.win.getByRole('heading', { name: 'Native derived target' })).toBeVisible()
  expect(await finish(live, true)).toEqual({ code: 0, signal: null })
  const saved = JSON.parse(readFileSync(join(live.userData, 'session.json'), 'utf8'))
  const derived = saved.cards.flatMap((card: { tabs: unknown[] }) => card.tabs).find((tab: { location: { path: string } }) => tab.location.path.endsWith('session-native-derived-target.md'))
  expect(derived.location.kind).toBe('reselect')
  const resumed = await launch({ userData: live.userData })
  await expect(resumed.win.getByText('The source must be selected again after restart', { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(resumed.win.getByRole('heading', { name: 'Native derived target' })).toHaveCount(0)
  expect(resumed.pageErrors).toEqual([])
  expect(await finish(resumed)).toEqual({ code: 0, signal: null })
})

test('sidebar tasks.csv restores through its approved root in a split with the same Grid anchor and lens', async () => {
  test.skip(process.platform !== 'win32', 'local capability backend is currently Windows-only')
  mkdirSync(FIXTURES, { recursive: true })
  const root = mkdtempSync(join(FIXTURES, 'session-root-'))
  const source = join(root, 'launch-plan.md')
  writeFileSync(source, '# Launch plan\n')
  writeFileSync(join(root, 'tasks.csv'), 'id,title\n' + Array.from({ length: 500 }, (_, row) => `${row + 1},Task ${row + 1}`).join('\n'))
  const live = await launch({ file: source })
  await expect(live.win.getByRole('heading', { name: 'Launch plan' })).toBeVisible({ timeout: 30_000 })
  await stubOpenDialog(live.app, root, 'folder-dialog')
  await runCommand(live.win, 'Open folder…')
  await expect(live.win.getByRole('treeitem', { name: 'tasks.csv', exact: true })).toBeVisible()
  await runCommand(live.win, 'Split right')
  const right = live.win.getByRole('region', { name: 'Reader card 2', exact: true })
  await expect(right).toHaveAttribute('data-focused', 'true')
  await live.win.getByRole('treeitem', { name: 'tasks.csv', exact: true }).locator('.folder-row').click()
  const grid = right.getByRole('grid', { name: 'CSV grid' })
  await expect(grid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
  await grid.evaluate(node => { node.scrollTop = 28 * 120 })
  await expect(grid.getByRole('gridcell', { name: 'Task 121', exact: true })).toBeInViewport()
  expect(await finish(live, true)).toEqual({ code: 0, signal: null })
  const saved = JSON.parse(readFileSync(join(live.userData, 'session.json'), 'utf8'))
  const tab = saved.cards[1].tabs.find((tab: { location: { path: string } }) => tab.location.path.endsWith('tasks.csv'))
  expect(tab.location).toMatchObject({ kind: 'folder', root: { path: root, identity: expect.stringMatching(/^[0-9a-f]{16}-[0-9a-f]{32}$/) }, segments: ['tasks.csv'] })
  expect(tab.anchor).toBeGreaterThanOrEqual(120)
  expect(tab.lens).toBe('grid')
  const resumed = await launch({ userData: live.userData })
  const resumedGrid = resumed.win.getByRole('region', { name: 'Reader card 2', exact: true }).getByRole('grid', { name: 'CSV grid' })
  await expect(resumedGrid).toHaveAttribute('data-ready', '1', { timeout: 30_000 })
  await expect(resumedGrid.getByRole('gridcell', { name: 'Task 121', exact: true })).toBeInViewport()
  expect(resumed.pageErrors).toEqual([])
  expect(await finish(resumed, true)).toEqual({ code: 0, signal: null })
  const originalRoot = root + '-held'
  renameSync(root, originalRoot)
  mkdirSync(root)
  writeFileSync(join(root, 'tasks.csv'), 'id,title\n1,Replacement authority must not be followed\n')
  const changed = await launch({ userData: live.userData })
  const changedRight = changed.win.getByRole('region', { name: 'Reader card 2', exact: true })
  await expect(changedRight).toContainText('The source must be selected again after restart', { timeout: 30_000 })
  await expect(changedRight.getByRole('grid', { name: 'CSV grid' })).toHaveCount(0)
  await expect(changed.win.getByText('Replacement authority must not be followed', { exact: true })).toHaveCount(0)
  expect(changed.pageErrors).toEqual([])
  expect(await finish(changed)).toEqual({ code: 0, signal: null })
  rmSync(root, { recursive: true, force: true })
  rmSync(originalRoot, { recursive: true, force: true })
})

test('a tab opened while a 64 GiB document indexes is saved without waiting for the index', async () => {
  // Sparse: 2,000 lines of text, then zeros the disk doesn't store but the index still reads: about 27 s locally,
  // against a save on disk 2.2 s after the second tab shows (10 GiB's 3 s index left too thin a margin for a fast runner).
  const big = sparseFixture('session-indexing-64gib.txt', 64 * 2 ** 30, 'line\n'.repeat(2000))
  const small = fixture('session-indexing-small.txt', 'small\n')
  const live = await launch({ hooks: true, file: big })
  try {
    await waitOpen(live.win)
    await expect(live.win.locator('.card-status')).toHaveText(/^Indexing /)
    // Each tab's location takes 150 ms here, as from a busy core, so every capture spans a progress tick.
    await live.win.evaluate(() => {
      const core = (window as unknown as { typoseTest: TestHooks }).typoseTest.core, call = core.call.bind(core)
      core.call = async (...args: Parameters<typeof call>) => {
        if (args[0] === 'captureLocation') await new Promise(done => setTimeout(done, 150))
        return call(...args)
      }
    })
    await stubOpenDialog(live.app, small)
    await runCommand(live.win, 'Open file…')
    await expect(live.win.locator('.vl-row .text').first()).toHaveText('small')
    const saved = () => {
      try {
        const session = JSON.parse(readFileSync(join(live.userData, 'session.json'), 'utf8'))
        return session.cards.flatMap((card: { tabs: { location: { path: string } }[] }) => card.tabs.map(tab => basename(tab.location.path)))
      } catch { return [] }
    }
    // Index progress changes the workspace every 100 ms: it must neither restart the 300 ms save timer nor refuse the
    // capture, or nothing is saved until the index ends. On disk: 300 ms, a capture (here 2 × 150 ms), then main's 1 s
    // write delay.
    await expect.poll(saved, { timeout: 10_000 }).toEqual([basename(big), basename(small)])
    expect((await debugStats(live.win)).jobs).toBe(1)
    expect(live.pageErrors).toEqual([])
  } finally {
    await finish(live)
    rmSync(big, { force: true })
  }
})
