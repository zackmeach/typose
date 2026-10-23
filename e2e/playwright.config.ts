import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  timeout: 5 * 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results'
})
