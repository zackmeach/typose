// TEMP (to be reverted): the macOS launch whose window never came. On main (run 40067408502) it came twice, each time
// 1-3 s after packaged.e2e.ts's last test closed the packaged build. So, round after round: that test's launch, then
// the dev-layout launches shell.e2e.ts and states.e2e.ts make, timed, with any of our processes still running listed.
import { expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { OURS, finish, fixture, launch, test, waitIndexed } from './app'
import { closePackaged, launchPackaged } from './packaged'

const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 8)
const ours = (): string[] =>
  process.platform === 'win32'
    ? []
    : spawnSync('ps', ['-axo', 'pid,ppid,stat,etime,command'], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((l) => OURS.test(l))

test('the packaged NetLog launch, then four dev-layout launches, round after round', async () => {
  test.setTimeout(8 * 60_000)
  const file = fixture('stress-net.txt', Array.from({ length: 3000 }, (_, i) => `line ${i} café 語 😀`).join('\n'))
  const blank = fixture('stress-blank.txt', ' \r\n\t\n  \n')
  for (let round = 0; round < ROUNDS; round++) {
    const p = await launchPackaged({ cdp: true, netlog: test.info().outputPath(`netlog-${round}.json`), file })
    await waitIndexed(p.page!)
    await p.page!.locator('.vl-scroller').focus()
    for (const key of ['PageDown', 'PageDown', 'Control+End', 'Control+Home', 'End']) await p.page!.keyboard.press(key)
    await closePackaged(p)
    const closed = Date.now()
    for (let i = 0; i < 4; i++) {
      const left = ours()
      const at = Date.now()
      const l = await launch(i % 2 ? { file: blank } : {})
      const shown = Date.now() - at
      await expect(l.win.locator(i % 2 ? '.card-message' : '.open-button')).toBeVisible()
      console.log(`round ${round}, launch ${i}: ${at - closed} ms after the packaged close, its window in ${shown} ms${left.length ? `; still running:\n${left.join('\n')}` : ''}`)
      await finish(l)
    }
  }
})
