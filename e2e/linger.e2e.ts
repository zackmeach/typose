// `diagnoseLinger` runs only when a launch outlives its close, which no healthy run does; this runs it on a live app,
// so each system's CI runs its commands, and prints what it wrote, so the CI log shows how each of them went.
import { expect } from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { finish, launch, test } from './app'
import { LINGER_BUDGET, diagnoseLinger } from './linger'

test('the linger diagnostic on a live app names its pid, finds no quit logged and lists the pid, within its budget', async () => {
  const l = await launch()
  const started = Date.now()
  const r = diagnoseLinger(l.pid, l.userData, l.stderr())
  expect(Date.now() - started).toBeLessThanOrEqual(LINGER_BUDGET)
  expect(r.summary).toContain(`details in linger-${l.pid}.txt`)
  expect(r.quit).toBeNull()
  expect(r.tree?.map((p) => p.pid)).toContain(l.pid)
  console.log(readFileSync(test.info().outputPath(`linger-${l.pid}.txt`), 'utf8'))
  if (process.platform === 'darwin') {
    const sample = test.info().outputPath(`linger-${l.pid}.sample.txt`)
    console.log(`linger-${l.pid}.sample.txt: ${existsSync(sample) ? `${statSync(sample).size} bytes` : 'not written'}`)
  }
  await finish(l)
})
