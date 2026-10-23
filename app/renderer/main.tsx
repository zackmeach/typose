import { createRoot } from 'react-dom/client'
import type { TyposeApi } from '../shared/protocol'
import { App } from './App'
import { CoreClient } from './core'
import { markBundleEvaluated, markPresentations } from './perf'
import './style.css'

declare global {
  interface Window {
    typose: TyposeApi
  }
}
/** True only in the test-hooks build (`npm run build:hooks`); the shipped bundle has no hook code (plan §5). */
declare const __TEST_HOOKS__: boolean

markBundleEvaluated()
markPresentations()
const mount = () => createRoot(document.getElementById('root')!).render(<App core={new CoreClient()} />)
// Plan C8's startup control: main passes the delay in the URL, from TYPOSE_TEST_DELAY_MOUNT.
const delay = __TEST_HOOKS__ ? Number(new URLSearchParams(location.search).get('delayMount') ?? 0) : 0
if (delay > 0) setTimeout(mount, delay)
else mount()
