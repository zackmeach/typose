import { contextBridge, ipcRenderer } from 'electron'
import type { MainMessage, TyposeApi } from '../shared/protocol'

// The sandboxed page can't receive a MessagePort over contextBridge, so main's messages are forwarded with
// window.postMessage, to this page's own origin only (the spike posted with '*'). The page accepts them only
// from `event.source === window` (plan C7).
const forward = (message: MainMessage, ports?: MessagePort[]) => window.postMessage(message, window.location.origin, ports)
ipcRenderer.on('core-port', (event, { session }: { session: number }) => forward({ type: 'core-port', session }, event.ports))
ipcRenderer.on('core-gone', (_event, { session }: { session: number }) => forward({ type: 'core-gone', session }))

const typose: TyposeApi = {
  launchPath: () => ipcRenderer.invoke('launch-path'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  mark: (name, t) => ipcRenderer.send('mark', name, t)
}
contextBridge.exposeInMainWorld('typose', typose)
