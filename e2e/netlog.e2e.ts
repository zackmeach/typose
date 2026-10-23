// Spec §7.3's NetLog assertion, with the crash reporter armed (it always is, plan C9): open files of two
// encodings, scroll, then fail on any outside-scheme request, DNS lookup, proxy probe or socket connect.
import { expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { finish, fixture, launch, test, waitIndexed } from './app'

/** Runs netlog-assert.mjs on a log, as CI does. */
function assertNetLog(log: string): string {
  expect(statSync(log).size).toBeGreaterThan(0) // a NetLog always holds metadata; emptiness isn't the test
  const run = spawnSync(process.execPath, [join(__dirname, 'netlog-assert.mjs'), log], { encoding: 'utf8' })
  expect(run.status, run.stdout + run.stderr).toBe(0)
  return run.stdout
}

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
  expect(await l.app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())).toBe(false)
  // Hunspell (Linux for every language, Windows for those it lacks, such as `sh`; never macOS) fetches dictionaries
  // through a loader the network guard doesn't see. Ask for one: nothing may serve it, and the NetLog judges where it went.
  if (process.platform !== 'darwin') {
    const fetched = await l.app.evaluate(
      ({ session }) =>
        new Promise<string>((done) => {
          // Linux's startup en-US load may still be settling; wait for sh's own outcome.
          session.defaultSession.on('spellcheck-dictionary-download-success', (_e, lang) => {
            if (lang === 'sh') done('success')
          })
          session.defaultSession.on('spellcheck-dictionary-download-failure', (_e, lang) => {
            if (lang === 'sh') done('failure')
          })
          session.defaultSession.setSpellCheckerLanguages(['sh'])
        })
    )
    expect(fetched).toBe('failure')
  }
  await finish(l)
  const second = await launch({ file: files[1], netlog: logs[1] })
  await waitIndexed(second.win)
  await finish(second)
  for (const log of logs) expect(assertNetLog(log)).toContain('PASS')
})
