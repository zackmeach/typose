import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { Command, MainMessage, TyposeApi } from '../shared/protocol'

// Brief §6.5: scale the whole view from 50–200%, before a lens can consume Ctrl+wheel as scrolling.
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || event.deltaY === 0) return
  event.preventDefault()
  const step = event.deltaY < 0 ? 1.1 : 1 / 1.1
  webFrame.setZoomFactor(Math.max(0.5, Math.min(2, webFrame.getZoomFactor() * step)))
}, { capture: true, passive: false })

// The sandboxed page can't receive a MessagePort over contextBridge, so main's messages are forwarded with
// window.postMessage, to this page's own origin only (the spike posted with '*'). The page accepts them only
// from `event.source === window` (plan C7).
const forward = (message: MainMessage, ports?: MessagePort[]) => window.postMessage(message, window.location.origin, ports)
ipcRenderer.on('core-port', (event, { session }: { session: number }) => forward({ type: 'core-port', session }, event.ports))
ipcRenderer.on('core-gone', (_event, { session }: { session: number }) => forward({ type: 'core-gone', session }))
// Spec §6.2's accessibility mode, the same way; the page takes it only from `event.source === window` too.
ipcRenderer.on('a11y', (_event, on: boolean) => window.postMessage({ type: 'a11y', on }, window.location.origin))

const typose: TyposeApi = {
  launchPath: () => ipcRenderer.invoke('launch-path'),
  launchPaths: () => ipcRenderer.invoke('launch-paths'),
  onOpenPath: (cb) => {
    const listener = (_event: unknown, path: string) => cb(path)
    ipcRenderer.on('open-path', listener)
    return () => void ipcRenderer.off('open-path', listener)
  },
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  mark: (name, t) => ipcRenderer.send('mark', name, t),
  onShown: (cb) => void ipcRenderer.once('shown', () => cb()),
  onCommand: (cb) => {
    const listener = (_event: unknown, command: Command) => cb(command)
    ipcRenderer.on('command', listener)
    return () => void ipcRenderer.off('command', listener)
  }
}
contextBridge.exposeInMainWorld('typose', typose)
