// Spec §7.3's NetLog assertion, with the crash reporter armed (it always is, plan C9): open files of two
// encodings, scroll, then fail on any outside-scheme request, DNS lookup, proxy probe or socket connect.
import { expect } from '@playwright/test'
import { assertNetLog, finish, fixture, launch, test, waitIndexed } from './app'

test('the NetLog shows no network activity', async () => {
  const files = [
    fixture('net-utf8.txt', Array.from({ length: 3000 }, (_, i) => `line ${i} café 語 😀`).join('\n')),
    fixture('net-utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb\n', 'utf16le')]))
  ]
  const logs = [test.info().outputPath('netlog-1.json'), test.info().outputPath('netlog-2.json')]
  const l = await launch({ file: files[0], netlog: logs[0] })
  await waitIndexed(l.win)
  await l.win.locator('.vl-scroller').focus()
  for (const key of ['PageDown', 'PageDown', 'Control+End', 'Control+Home', 'End']) await l.win.keyboard.press(key)
  expect(await l.app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer())).toBe(false)
  await finish(l)
  const second = await launch({ file: files[1], netlog: logs[1] })
  await waitIndexed(second.win)
  await finish(second)
  for (const log of logs) expect(assertNetLog(log)).toContain('PASS')
})
