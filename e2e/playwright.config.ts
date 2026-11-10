import { defineConfig } from '@playwright/test'
import { quarantine } from './quarantine'

const active = quarantine.filter((q) => !q.os || q.os === process.platform)
for (const q of active) {
  if (Date.now() > Date.parse(q.expires)) throw new Error(`e2e quarantine expired ${q.expires}: "${q.title}" (${q.reason})`)
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  // rendered-memory needs a quiet machine and alone outlasts a macOS step; CI leaves it to local runs.
  testIgnore: process.env.CI ? 'rendered-memory.e2e.ts' : undefined,
  grepInvert: active.length ? new RegExp(active.map((q) => q.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')) : undefined,
  retries: process.env.CI ? 1 : 0,
  timeout: 5 * 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results'
})
