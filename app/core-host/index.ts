// The core host (spec §2.1): a utilityProcess that loads the Rust core and serves the renderer over the
// MessagePort main hands it. Main's first message carries the port and this spawn's session id (plan C7).
import type * as Core from 'typose-node'
import { makeDispatcher } from './dispatch'

declare const __TEST_HOOKS__: boolean

/** What only the test-hooks addon has (plan m8): its index.d.ts is generated with it, after the typecheck runs. */
interface Hooks {
  debugStats(): { jobs: number; tasks: number; handles: number }
  setReadDelay(ms: number): void
}

// The test-hooks build loads the test-hooks addon, which the release build neither loads nor ships.
const addon: typeof Core & Partial<Hooks> = __TEST_HOOKS__ ? require('typose-node/hooks') : require('typose-node')

process.parentPort.once('message', (e) => {
  const { session } = e.data as { session: number }
  // Plan C5's per-read delay, validated in main (from TYPOSE_TEST_READ_DELAY) and again in Rust.
  if (__TEST_HOOKS__) addon.setReadDelay!((e.data as { readDelay: number }).readDelay)
  const port = e.ports[0]
  const core = { coreVersion: addon.coreVersion, limits: addon.limits, openDoc: (path: string) => addon.Doc.open(path), cancelFlag: () => new addon.Cancel() }
  const dispatch = makeDispatcher(__TEST_HOOKS__ ? { ...core, debugStats: addon.debugStats } : core, session, (event) => port.postMessage(event))
  port.on('message', ({ data }) => void dispatch(data).then((response) => port.postMessage(response)))
  port.start()
})
