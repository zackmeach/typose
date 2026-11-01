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

// One use of the narrow clipboard writer follows only a trusted copy shortcut on a Grid cell. Text controls and
// arbitrary renderer calls cannot arm it; main still authenticates the app's exact main frame and byte bounds.
let clipboardGesture = false
let clipboardTokenSerial = 0
let clipboardToken: string | undefined
window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.isComposing || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey) || !(event.target instanceof Element)) return
  const target = event.target
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
  if (target.closest('[role="grid"][aria-label="CSV grid"]')) {
    clipboardGesture = true
    setTimeout(() => { clipboardGesture = false }, 0)
  }
}, { capture: true })
window.addEventListener('click', event => {
  if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('.csv-context-menu [data-clipboard-copy="true"]')) return
  clipboardGesture = true
  setTimeout(() => { clipboardGesture = false }, 0)
}, { capture: true })

const typose: TyposeApi = {
  launchPath: () => ipcRenderer.invoke('launch-path'),
  launchPaths: () => ipcRenderer.invoke('launch-paths'),
  onOpenPath: (cb) => {
    const listener = (_event: unknown, path: string) => cb(path)
    ipcRenderer.on('open-path', listener)
    return () => void ipcRenderer.off('open-path', listener)
  },
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  folderDialog: () => ipcRenderer.invoke('folder-dialog'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  beginClipboardWrite: () => {
    if (!clipboardGesture) return null
    clipboardGesture = false
    const token = `${++clipboardTokenSerial}:${crypto.randomUUID()}`
    clipboardToken = token
    return token
  },
  cancelClipboardWrite: (token) => { if (clipboardToken === token) clipboardToken = undefined },
  writeClipboardText: (text, token) => {
    if (clipboardToken !== token) return Promise.resolve(false)
    clipboardToken = undefined
    return ipcRenderer.invoke('write-clipboard', text)
  },
  mark: (name, t) => ipcRenderer.send('mark', name, t),
  onShown: (cb) => void ipcRenderer.once('shown', () => cb()),
  onCommand: (cb) => {
    const listener = (_event: unknown, command: Command) => cb(command)
    ipcRenderer.on('command', listener)
    return () => void ipcRenderer.off('command', listener)
  }
}
contextBridge.exposeInMainWorld('typose', typose)
