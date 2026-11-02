import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// Explicit entries for spec §2.2's layout; electron-vite's defaults assume src/{main,preload,renderer}. The core
// host is built as main's `?modulePath` import. Everything loads from typose:// (no dev server: the network
// guard blocks http://localhost), so `npm start` builds and runs the app.
export default defineConfig(({ mode }) => {
  // Behaviour-changing test hooks exist only in the `--mode test-hooks` build, in out-hooks/ (plan §5). Everywhere
  // else they're constant-false dead code, which the bundler drops.
  const hooks = mode === 'test-hooks'
  const define = { __TEST_HOOKS__: JSON.stringify(hooks) }
  const outDir = (part: string) => (hooks ? { outDir: resolve(__dirname, 'out-hooks', part) } : {})
  return {
    main: { define, build: { ...outDir('main'), rolldownOptions: { input: { index: resolve(__dirname, 'main/index.ts') } } } },
    preload: { define, build: { ...outDir('preload'), rolldownOptions: { input: { index: resolve(__dirname, 'preload/index.ts') } } } },
    renderer: {
      root: resolve(__dirname, 'renderer'),
      define,
      build: { ...outDir('renderer'), rolldownOptions: { input: resolve(__dirname, 'renderer/index.html') } },
      plugins: [react()]
    }
  }
})
