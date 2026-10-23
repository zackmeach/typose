// The core host (spec §2.1): a utilityProcess that loads the Rust core and serves the renderer over the
// MessagePort main hands it. Main's first message carries the port and this spawn's session id (plan C7).
import { Doc, coreVersion, limits } from 'typose-node'
import { makeDispatcher } from './dispatch'

process.parentPort.once('message', (e) => {
  const { session } = e.data as { session: number }
  const port = e.ports[0]
  const dispatch = makeDispatcher({ coreVersion, limits, openDoc: (path) => Doc.open(path) }, session, (event) => port.postMessage(event))
  port.on('message', ({ data }) => port.postMessage(dispatch(data)))
  port.start()
})
