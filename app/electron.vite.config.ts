import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// Explicit entries for spec §2.2's layout; electron-vite's defaults assume src/{main,preload,renderer}. The core
// host is built as main's `?modulePath` import. Everything loads from typose:// (no dev server: the network
// guard blocks http://localhost), so `npm start` builds and runs the app.
export default defineConfig({
  main: { build: { rolldownOptions: { input: { index: resolve(__dirname, 'main/index.ts') } } } },
  preload: { build: { rolldownOptions: { input: { index: resolve(__dirname, 'preload/index.ts') } } } },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    build: { rolldownOptions: { input: resolve(__dirname, 'renderer/index.html') } },
    plugins: [react()]
  }
})
