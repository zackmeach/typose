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

// One use of the narrow clipboard writer follows a trusted Copy action in a reader. Text controls and arbitrary
// renderer calls cannot arm it; main still authenticates the app's exact main frame and byte bounds.
let clipboardGesture = false
let clipboardTokenSerial = 0
let clipboardToken: string | undefined
window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.isComposing || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey) || !(event.target instanceof Element)) return
  const target = event.target
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
  if (target.closest('[data-card]')) {
    clipboardGesture = true
    setTimeout(() => { clipboardGesture = false }, 0)
  }
}, { capture: true })
window.addEventListener('click', event => {
  if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-clipboard-copy="true"]')) return
  clipboardGesture = true
  setTimeout(() => { clipboardGesture = false }, 0)
}, { capture: true })
window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.isComposing || event.key !== 'Enter' || !(event.target instanceof Element)) return
  const active = event.target.getAttribute('aria-activedescendant')
  const command = active ? document.getElementById(active) : event.target.closest('[role="menuitem"]')
  if (command?.getAttribute('data-clipboard-copy') !== 'true') return
  clipboardGesture = true
  setTimeout(() => { clipboardGesture = false }, 0)
}, { capture: true })

// Z79: a hand-off needs user activation. A trusted primary-button release, or Enter/Space, on a `data-handoff` control
// arms one token, which main spends on the next hand-off within a second. Both listeners run in the capture phase,
// before React Aria's press handlers call the bridge. Page script can't make a trusted event or read the token.
let handoffToken: string | undefined
const armHandoff = (event: Event) => {
  if (!event.isTrusted || !(event.target instanceof Element)) return
  // A combobox (the palette) names its highlighted row with aria-activedescendant; Enter there is that row's activation.
  const active = event instanceof KeyboardEvent && event.key === 'Enter' ? event.target.getAttribute('aria-activedescendant') : null
  if (!(active ? document.getElementById(active) : event.target)?.closest('[data-handoff="true"]')) return
  if (event instanceof PointerEvent && event.button !== 0) return
  if (event instanceof KeyboardEvent && (event.repeat || event.isComposing || (event.key !== 'Enter' && event.key !== ' '))) return
  const token = crypto.randomUUID()
  handoffToken = token
  ipcRenderer.send('handoff-gesture', token)
  setTimeout(() => { if (handoffToken === token) handoffToken = undefined }, 1000)
}
window.addEventListener('pointerup', armHandoff, { capture: true })
window.addEventListener('keydown', armHandoff, { capture: true })
const takeHandoff = () => {
  const token = handoffToken
  handoffToken = undefined
  return token
}

const typose: TyposeApi = {
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  changeSetting: (key, value, revision) => ipcRenderer.invoke('change-setting', key, value, revision),
  exportTheme: (name, tokens) => ipcRenderer.invoke('export-theme', name, tokens),
  setChromeTheme: (dark, canvas, text) => ipcRenderer.invoke('chrome-theme', dark, canvas, text),
  zoom: action => webFrame.setZoomFactor(action === 'reset' ? 1 : Math.max(0.5, Math.min(2, webFrame.getZoomFactor() * (action === 'in' ? 1.1 : 1 / 1.1)))),
  fullScreen: () => ipcRenderer.invoke('full-screen'),
  loadSession: () => ipcRenderer.invoke('load-session'),
  saveSession: (session) => ipcRenderer.invoke('save-session', session),
  onSessionCapture: (cb) => {
    const listener = (_event: unknown, request: number) => { void Promise.resolve().then(cb).catch(() => false).finally(() => ipcRenderer.send('session-captured', request)) }
    ipcRenderer.on('capture-session', listener)
    return () => void ipcRenderer.off('capture-session', listener)
  },
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
  showInFolder: (subject) => ipcRenderer.invoke('show-in-folder', subject, takeHandoff()),
  openWithDefault: (subject) => ipcRenderer.invoke('open-with-default', subject, takeHandoff()),
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
  printDocument: (title, blocks, pages, confirmed) => ipcRenderer.invoke('print-document', title, blocks, pages, confirmed),
  mark: (name, t) => ipcRenderer.send('mark', name, t),
  onShown: (cb) => void ipcRenderer.once('shown', () => cb()),
  onCommand: (cb) => {
    const listener = (_event: unknown, command: Command) => {
      if (command === 'copy') {
        clipboardGesture = true
        setTimeout(() => { clipboardGesture = false }, 0)
      }
      cb(command)
    }
    ipcRenderer.on('command', listener)
    return () => void ipcRenderer.off('command', listener)
  }
}
contextBridge.exposeInMainWorld('typose', typose)
