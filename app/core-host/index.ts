// The core host (spec §2.1): a utilityProcess that loads the Rust core and serves the renderer over the
// MessagePort main hands it. Main's first message carries the port and this spawn's session id (plan C7).
import { totalmem } from 'node:os'
import type * as Core from 'typose-node'
import type { Charges, DebugStats } from '../shared/protocol'
import { makeDispatcher } from './dispatch'

declare const __TEST_HOOKS__: boolean

/** What only the test-hooks addon has (plan m8): its index.d.ts is generated with it, after the typecheck runs. */
interface Hooks {
  debugStats(): Pick<DebugStats, 'jobs' | 'tasks' | 'handles' | 'delayMs' | 'ledger'>
  setReadDelay(ms: number): void
  setLimit(bytes: number): void
  resetHigh(): void
  docCharges(doc: Core.Doc): Charges
}

/** napi-rs's `--platform` name for each build target (spec §12.1). */
const TARGETS: Record<string, string> = { 'win32-x64': 'win32-x64-msvc', 'darwin-arm64': 'darwin-arm64', 'linux-x64': 'linux-x64-gnu' }
const target = TARGETS[`${process.platform}-${process.arch}`]
if (!target) throw new Error(`no Typose core is built for ${process.platform}-${process.arch}`)
// The addon's own binary, by its known name, not through napi-rs's generated index.js: that loader would load whatever
// NAPI_RS_NATIVE_LIBRARY_PATH names, or go looking for a WASI build (spec §7.1). It sits unpacked beside the asar,
// outside its integrity check, and is no longer read. The test-hooks build loads the test-hooks addon, which the release
// build neither loads nor ships.
const binary = `typose-node/${__TEST_HOOKS__ ? 'hooks/' : ''}typose-node.${target}.node`
const addon: typeof Core & Partial<Hooks> = require(binary)

/** The test-hooks build's forced GC (plan C1's measurements): V8's own `gc`, exposed after startup. */
function exposeGc(): () => void {
  require('node:v8').setFlagsFromString('--expose-gc')
  return require('node:vm').runInNewContext('gc') as () => void
}

process.parentPort.once('message', (e) => {
  const { session, readDelay, budget } = e.data as { session: number; readDelay?: number; budget?: number }
  // Plan C1: the ledger's limit, before anything can open: a quarter of physical RAM (Z34), or, in the test-hooks build,
  // the budget override from TYPOSE_TEST_BUDGET (validated in main, and again in Rust).
  if (__TEST_HOOKS__ && budget) addon.setLimit!(budget)
  else addon.setBudget(totalmem())
  // Plan C5's per-read delay, validated in main (from TYPOSE_TEST_READ_DELAY) and again in Rust.
  if (__TEST_HOOKS__) addon.setReadDelay!(readDelay ?? 0)
  const port = e.ports[0]
  const core = {
    coreVersion: addon.coreVersion,
    limits: addon.limits,
    openDoc: (path: string) => addon.Doc.open(path),
    cancelFlag: () => new addon.Cancel(),
    reserveCache: addon.reserveCache
  }
  const hooks = __TEST_HOOKS__ ? { debugStats: addon.debugStats, docCharges: addon.docCharges, gc: exposeGc(), resetHigh: addon.resetHigh, setLimit: addon.setLimit } : {}
  const dispatch = makeDispatcher({ ...core, ...hooks }, session, (event) => port.postMessage(event))
  port.on('message', ({ data }) => void dispatch(data).then((response) => port.postMessage(response)))
  port.start()
})
