import { createRoot } from 'react-dom/client'
import type { TyposeApi } from '../shared/protocol'
import { onA11yMode } from './a11y'
import { App, appHooks } from './App'
import { CoreClient, testHooks } from './core'
import { markBundleEvaluated, markNow, markPresentations } from './perf'
import './style.css'

declare global {
  interface Window {
    typose: TyposeApi
  }
}

markBundleEvaluated()
markPresentations()
// Z64: the page's own first frame, on the User Timing clock beside Z37's marks. Z37's first-screen clock starts no
// earlier. Paint timing's first-paint isn't used: it comes with the window's first presentation, frames later. The same
// frame is a startup mark too (`firstFrame`, under main's TYPOSE_MARKS hook), so a launch without CDP can read it.
requestAnimationFrame(() => {
  performance.mark('typose:first-frame')
  markNow('firstFrame')
})
// Spec §6.2: nothing in M1 renders differently with a screen reader on; the mode is kept on the root for the lenses
// that will (Rendered and Transcript's wide window, M4–M5).
onA11yMode((on) => (document.documentElement.dataset.a11y = on ? 'on' : 'off'))
const core = new CoreClient()
// The test-hooks build's handle for the e2e tests (plan m8): the client, its hooks, and App's.
if (__TEST_HOOKS__) Object.assign(window, { typoseTest: { core, client: testHooks, app: appHooks } })
const mount = () => createRoot(document.getElementById('root')!).render(<App core={core} />)
// Plan C8's startup control: main passes the delay in the URL, from TYPOSE_TEST_DELAY_MOUNT.
const delay = __TEST_HOOKS__ ? Number(new URLSearchParams(location.search).get('delayMount') ?? 0) : 0
if (delay > 0) setTimeout(mount, delay)
else mount()
