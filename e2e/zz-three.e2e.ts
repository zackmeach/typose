// DIAG (scratch branch only): the start-page launch failure, three ways on one VM, interleaved: Playwright's launcher
// (its -r loader and the Node inspector attached), the dev layout spawned as a user runs it, and the packaged, fused
// build spawned the same way. Same product code, same criterion: the launch counts as up once its session.json names
// the file it was given, which only the app page writes.
import { existsSync, readFileSync } from 'node:fs'
import { APP_DIR, finish, fixture, launch, lifecycle, test } from './app'
import { closePackaged, launchPackaged } from './packaged'

const electronPath = require('electron') as unknown as string

test('zz three: a launch opens its file', async () => {
  test.skip(process.platform !== 'linux' && !process.env.ZZ_ANY, 'Linux only')
  test.setTimeout(60_000)
  const arm = (['playwright', 'dev', 'packaged'] as const)[test.info().repeatEachIndex % 3]
  const file = fixture('zz-three.txt', 'opened\n')
  let userData: string, pid: number, close: () => Promise<unknown>, stderr = () => ''
  if (arm === 'playwright') {
    const l = await launch({ file })
    userData = l.userData
    pid = l.pid
    close = () => finish(l, true)
  } else {
    const l = await launchPackaged({ ...(arm === 'dev' ? { exe: electronPath, args: [APP_DIR] } : {}), file, marks: false })
    let err = ''
    l.proc.stderr!.on('data', (d: Buffer) => (err += d.toString()))
    userData = l.userData
    pid = l.pid
    stderr = () => err
    close = () => closePackaged(l)
  }
  const spawned = Date.now()
  const sessionFile = `${userData}/session.json`
  const named = () => existsSync(sessionFile) && readFileSync(sessionFile, 'utf8').includes('zz-three.txt')
  while (!named() && Date.now() - spawned < 15_000) await new Promise((ok) => setTimeout(ok, 100))
  const up = named(), ms = Date.now() - spawned
  const exit = await close().catch((e: unknown) => String(e))
  const logFile = test.info().outputPath(`${pid}-lifecycle.jsonl`)
  const log = arm === 'playwright'
    ? (() => { try { return lifecycle(userData) } catch { return [] } })()
    : existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((s) => JSON.parse(s) as { t: string; event: string }) : []
  const start = Date.parse((log.find((r) => r.event === 'start')?.t as string | undefined) ?? '')
  const at = (event: string) => { const r = log.find((x) => x.event === event); return r ? Date.parse(r.t as string) - start : -1 }
  const typeError = /markResourceTiming/.test(stderr())
  if (up) console.log(`ZZ3 ${arm} ok pid ${pid} up ${ms} load ${at('did-finish-load')} shown ${at('window-shown')} typeError ${typeError}`)
  else {
    console.log(`ZZ3 ${arm} FAIL ${JSON.stringify({ pid, ms, exit, load: at('did-finish-load'), shown: at('window-shown'), typeError, stderr: stderr().slice(0, 2000), log })}`)
    throw new Error(`${arm}: session.json never named the file within 15 s`)
  }
})
