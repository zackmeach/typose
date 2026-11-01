// Brief §7.9's file states as a launch shows them, and the freeze: a change on disk, the banner, and Ctrl+R.
import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, finish, fixture, launch, osFocus, pressAsOS, test, visibleRows, waitIndexed, waitOpen } from './app'

test('an empty file and a whitespace-only one show "Empty file"', async () => {
  for (const [name, bytes] of [
    ['empty.txt', ''],
    ['blank.txt', ' \r\n\t\n  \n']
  ]) {
    const l = await launch({ file: fixture(name, bytes) })
    await expect(l.win.locator('.card-message')).toHaveText('Empty file')
    await finish(l)
  }
})

test('a binary file shows the message only', async () => {
  const l = await launch({ file: fixture('binary.zip', Buffer.from('PK\x03\x04\0\0\0\0binary', 'latin1')) })
  await expect(l.win.locator('.card-message')).toHaveText('Binary file · not shown')
  await finish(l)
})

test('a missing file shows where it was looked for, with Locate… and Close', async () => {
  const missing = join(FIXTURES, 'no-such-file.txt')
  rmSync(missing, { force: true })
  const l = await launch({ file: missing })
  const { win } = l
  await expect(win.locator('.card-message p')).toHaveText(`File not found at ${missing}`)
  await expect(win.locator('.card-message .open-button')).toHaveText(['Locate…', 'Close'])
  await win.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(win.locator('.card-message .open-button')).toHaveText(['Open file…'])
  await finish(l)
})

test('a file without read permission shows Retry and Close, and Retry opens it once it can', async () => {
  test.skip(process.platform !== 'win32' && process.getuid?.() === 0, 'root reads any file')
  const file = fixture('locked.txt', 'readable again\n')
  // Deny reading to Everyone (S-1-1-0) on Windows; on Unix, take the mode bits away.
  const lock = (on: boolean) =>
    process.platform === 'win32'
      ? execFileSync('icacls', [file, on ? '/deny' : '/remove:d', on ? '*S-1-1-0:(R)' : '*S-1-1-0'], { stdio: 'ignore' })
      : chmodSync(file, on ? 0o000 : 0o644)
  lock(true)
  try {
    const l = await launch({ file })
    const { win } = l
    await expect(win.locator('.card-message p')).toHaveText(`Can't read ${file} · permission denied`)
    await expect(win.locator('.card-message .open-button')).toHaveText(['Retry', 'Close'])
    lock(false)
    await win.getByRole('button', { name: 'Retry' }).click()
    await waitOpen(win)
    expect((await visibleRows(win))[0]).toEqual({ line: 1, text: 'readable again' })
    await finish(l)
  } finally {
    lock(false)
  }
})

test('a same-size write freezes the document with nothing new shown; Ctrl+R reloads it, not the page', async () => {
  // 60,000 lines of 64 bytes: line n is "line n" padded with dots.
  const line = (n: number) => `line ${n}`.padEnd(63, '.')
  const file = fixture('freeze.txt', Array.from({ length: 60_000 }, (_, n) => `${line(n)}\n`).join(''))
  const l = await launch({ file })
  const { win } = l
  await waitOpen(win)
  expect(await waitIndexed(win)).toBe(60_000)
  await win.evaluate(() => Object.assign(window, { pageLifetime: 'the page that opened the file' }))
  // Electron's default menu bound Ctrl+R to reloading the page, live even with its bar hidden; PR 7 removed it. In
  // case a menu comes back, the window has the OS's focus, which a menu's accelerators need, and its bar is shown, so
  // this fails wherever Ctrl+R could reach one.
  await osFocus(l)
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMenuBarVisibility(true))
  // Ctrl+R, or Cmd+R on macOS.
  const reloadKey = () => pressAsOS(l, 'R', [process.platform === 'darwin' ? 'meta' : 'control'])
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '1')

  // A same-size, in-place write near the end, where nothing has been read yet.
  const fd = openSync(file, 'r+')
  writeSync(fd, 'CHANGED'.padEnd(63, '!'), 59_990 * 64)
  closeSync(fd)

  const scroller = win.locator('.vl-scroller')
  await scroller.focus()
  await win.keyboard.press('Control+End')
  await expect(win.locator('.banner')).toHaveText('Changed on disk · Reload (Ctrl+R)')
  const atEnd = await visibleRows(win) // the banner took some height, so the last row may sit just below the fold
  expect(atEnd.at(-1)!.line).toBeGreaterThan(59_950)
  expect(atEnd.filter((r) => r.text !== '')).toEqual([]) // frozen before anything there was read: nothing new shows

  await reloadKey()
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '2')
  await expect(win.locator('.banner')).toHaveCount(0)
  await expect.poll(async () => (await visibleRows(win)).find((r) => r.line === 59_991)?.text).toBe('CHANGED'.padEnd(63, '!'))
  // Brief §7.2 binds Reload to F5 too.
  await pressAsOS(l, 'F5', [])
  await expect(win.locator('.raw-host')).toHaveAttribute('data-gen', '3')
  expect(await win.evaluate(() => (window as unknown as { pageLifetime?: string }).pageLifetime)).toBe('the page that opened the file')
  expect(l.pageErrors).toEqual([])
  await finish(l)
})

test("the opening line's sweep holds still under reduced motion (brief §6.6, §9)", async () => {
  const l = await launch()
  const { win } = l
  await expect(win.getByRole('button', { name: /^Open file…/ })).toBeVisible()
  // The indeterminate line shows only during a slow open, so the same element is mounted here to read its styles.
  const animations = () =>
    win.evaluate(() => {
      const line = Object.assign(document.createElement('div'), { className: 'progress-line indeterminate' })
      line.append(document.createElement('div'))
      document.querySelector('.card')!.append(line)
      const running = line.firstElementChild!.getAnimations().length
      line.remove()
      return running
    })
  expect(await animations()).toBe(1) // the control: it sweeps by default
  await win.emulateMedia({ reducedMotion: 'reduce' })
  expect(await animations()).toBe(0)
  await finish(l)
})

test('Ctrl+R on a file deleted since it opened shows it missing', async () => {
  const file = fixture('deleted.txt', 'here for now\n')
  const l = await launch({ file })
  const { win } = l
  await waitOpen(win)
  rmSync(file)
  await win.keyboard.press('Control+R')
  await expect(win.locator('.card-message p')).toHaveText(`File not found at ${file}`)
  await finish(l)
})
