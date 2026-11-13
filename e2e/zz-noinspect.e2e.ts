// DIAG (scratch branch only): the start-page launch failure without Playwright's launcher, its -r loader, the Node
// inspector or a debugging port. The app (product code as it ships, nothing added) is spawned as a user runs it, with
// a file to open and no TYPOSE_* hook; it counts as up once its session.json names that file, which only the app page
// writes. Then a SIGTERM closes it. Even repeats run the dev layout (electron + app/out), odd ones the packaged,
// fused build.
import { existsSync, readFileSync } from 'node:fs'
import { APP_DIR, fixture, test } from './app'
import { closePackaged, launchPackaged } from './packaged'

const electronPath = require('electron') as unknown as string

test('zz noinspect: a launch without the inspector opens its file', async () => {
  test.skip(process.platform !== 'linux' && !process.env.ZZ_ANY, 'Linux only')
  test.setTimeout(60_000)
  const arm = test.info().repeatEachIndex % 2 ? 'packaged' : 'dev'
  const file = fixture('zz-noinspect.txt', 'opened\n')
  const l = await launchPackaged({ ...(arm === 'dev' ? { exe: electronPath, args: [APP_DIR] } : {}), file, marks: false })
  let stderr = ''
  l.proc.stderr!.on('data', (d: Buffer) => (stderr += d.toString()))
  const sessionFile = `${l.userData}/session.json`
  const named = () => existsSync(sessionFile) && readFileSync(sessionFile, 'utf8').includes('zz-noinspect.txt')
  const until = Date.now() + 15_000
  while (!named() && Date.now() < until) await new Promise((ok) => setTimeout(ok, 100))
  const up = named(), ms = Date.now() - l.spawnedAt
  const exit = await closePackaged(l).catch((e: unknown) => String(e))
  const logFile = test.info().outputPath(`${l.pid}-lifecycle.jsonl`)
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((s) => JSON.parse(s) as { t: string; event: string }) : []
  const start = Date.parse(log.find((r) => r.event === 'start')?.t ?? '')
  const at = (event: string) => { const r = log.find((x) => x.event === event); return r ? Date.parse(r.t) - start : -1 }
  const typeError = /markResourceTiming/.test(stderr)
  if (up) console.log(`ZZB ${arm} ok up ${ms} load ${at('did-finish-load')} shown ${at('window-shown')} typeError ${typeError}`)
  else {
    console.log(`ZZB ${arm} FAIL ${JSON.stringify({ ms, exit, load: at('did-finish-load'), shown: at('window-shown'), typeError, stderr: stderr.slice(0, 3000), log })}`)
    throw new Error(`${arm}: session.json never named the file within 15 s`)
  }
})
