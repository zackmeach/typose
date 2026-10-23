import { defineConfig } from '@playwright/test'

// Plan C8's instruments and their controls: local runs on a reference rig, never CI (spec §10.3: CI is too noisy).
export default defineConfig({
  testDir: '.',
  testMatch: '*.perf.ts',
  timeout: 10 * 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../../test-results/perf'
})
