// `diagnoseLinger` runs only when a launch outlives its close, which no healthy run does; this runs it on a live app,
// so each system's CI runs its commands, and prints what it wrote, so the CI log shows how each of them went.
import { expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { finish, launch, test } from './app'
import { LINGER_BUDGET, diagnoseLinger } from './linger'

test('the linger diagnostic on a live app names its pid, finds no quit logged and lists the pid, within its budget', async () => {
  const l = await launch()
  const started = Date.now()
  const r = diagnoseLinger(l.pid, l.userData, l.stderr())
  const elapsed = Date.now() - started
  // Printed before anything is asserted, so a failing run's log still shows how each command went.
  const file = test.info().outputPath(`linger-${l.pid}.txt`)
  console.log(existsSync(file) ? readFileSync(file, 'utf8') : `linger-${l.pid}.txt: not written`)
  expect(elapsed).toBeLessThanOrEqual(LINGER_BUDGET)
  expect(r.summary).toContain(`details in linger-${l.pid}.txt`)
  expect(r.quit).toBeNull()
  expect(r.tree?.map((p) => p.pid)).toContain(l.pid)
  await finish(l)
})
