import { defineConfig } from '@playwright/test'
import { quarantine } from './quarantine'

// The quarantine applies under CI only: a local run executes everything.
const active = process.env.CI ? quarantine.filter((q) => !q.os || q.os === process.platform) : []
for (const q of active) {
  if (q.title.trim().length < 20) throw new Error(`e2e quarantine title too short to be specific: "${q.title}"`)
  if (!(Date.now() <= Date.parse(q.expires))) throw new Error(`e2e quarantine expired or bad date ${q.expires}: "${q.title}" (${q.reason})`)
  if (!process.env.TEST_WORKER_INDEX) console.log(`e2e quarantine: skipping "${q.title}" (${q.reason}; expires ${q.expires})`)
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  // rendered-memory is known to pass on a hosted Linux runner and alone outlasts a macOS step; hosted Windows is untried.
  // CI runs it on Linux only.
  testIgnore: process.env.CI && process.platform !== 'linux' ? 'rendered-memory.e2e.ts' : undefined,
  grepInvert: active.length ? new RegExp(active.map((q) => q.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').join('|')) : undefined,
  retries: process.env.CI ? 1 : 0,
  // A failure that passes on retry is still a failure: a retry is for evidence, not for a green run.
  failOnFlakyTests: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  timeout: 5 * 60_000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list', // github: failures and the run summary show on the PR
  outputDir: '../test-results'
})
