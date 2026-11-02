// A generated 1 GiB JSONL file (200-byte lines): over 5M lines, so 107M px of rows and logical scrolling (§5.3).
import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURES, finish, launch, test, visibleRows, waitIndexed, waitOpen } from './app'

const GIB = join(FIXTURES, '1gib.txt') // .txt: a .jsonl name would open in Rows, and this exercises Raw
const LINE = 200

test.afterAll(() => rmSync(GIB, { force: true })) // generated fixtures are deleted when done

/** The file's last line, read straight from disk. */
function lastLine(): string {
  const buf = Buffer.alloc(LINE)
  const fd = openSync(GIB, 'r')
  readSync(fd, buf, 0, LINE, statSync(GIB).size - LINE)
  closeSync(fd)
  return buf.toString('utf8').replace(/\n$/, '')
}

test('1 GiB: Ctrl+End reaches the last line, the wheel moves 1:1 in logical mode, and Shift+wheel scrolls sideways', async () => {
  test.setTimeout(10 * 60_000)
  execFileSync('cargo', ['run', '--release', '-q', '-p', 'fixtures-gen', '--', 'jsonl', '--out', GIB, '--bytes', String(1 << 30), '--line', String(LINE)], {
    cwd: resolve(__dirname, '../core'),
    stdio: 'inherit'
  })
  const l = await launch({ file: GIB })
  const { win } = l
  await waitOpen(win)
  const total = await waitIndexed(win)
  expect(total).toBe(Math.ceil((1 << 30) / LINE))
  expect(total * 20).toBeGreaterThan(16_000_000) // past the native cap: logical scrolling
  const scroller = win.locator('.vl-scroller')
  await scroller.focus()
  const top = async () => (await visibleRows(win))[0]?.line
  const bottom = async () => (await visibleRows(win)).at(-1)

  await test.step('Ctrl+End reaches the last line, and Ctrl+Home the first', async () => {
    await win.keyboard.press('Control+End')
    await expect.poll(bottom, { timeout: 10_000 }).toEqual({ line: total, text: lastLine() })
    await win.keyboard.press('Control+Home')
    await expect.poll(top).toBe(1)
  })

  await test.step('the wheel moves 1:1, at the top and deep in the file', async () => {
    const box = (await scroller.boundingBox())!
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.wheel(0, 120) // 120 px = 6 rows of 20 px; a proportional mapping would move ~40 rows
    await expect.poll(top).toBe(7)
    await win.keyboard.press('Control+End')
    await expect.poll(async () => (await bottom())?.line).toBe(total)
    const deep = (await top())!
    await win.mouse.wheel(0, -120)
    await expect.poll(top).toBe(deep - 6)
  })

  await test.step('Shift+wheel scrolls the 199-character lines sideways', async () => {
    const before = await scroller.evaluate((el) => el.scrollLeft)
    await win.keyboard.down('Shift')
    await win.mouse.wheel(0, 120)
    await win.keyboard.up('Shift')
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before)
  })
  expect(l.pageErrors).toEqual([])
  await finish(l)
})
