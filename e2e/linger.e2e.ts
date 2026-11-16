// `diagnoseLinger` runs only when a launch outlives its close, which no healthy run does; this runs it on a live app,
// so each system's CI runs its commands.
import { expect } from '@playwright/test'
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
  await finish(l)
})
