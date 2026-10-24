import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  // `--mode test-hooks` runs only the test-hooks addon's tests (`npm run test:hooks`, after its build; plan m8).
  const hooks = mode === 'test-hooks'
  return {
    // Unit tests run the release behaviour; the test-hooks build's is the e2e tests'.
    define: { __TEST_HOOKS__: 'false' },
    test: {
      include: [hooks ? 'app/**/*.hooks.test.ts' : 'app/**/*.test.ts'],
      exclude: [...configDefaults.exclude, ...(hooks ? [] : ['app/**/*.hooks.test.ts'])]
    }
  }
})
