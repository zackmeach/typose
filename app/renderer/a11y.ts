/**
 * Spec §6.2's accessibility mode, as the preload forwards it from main: taken only from this window, at this origin
 * (plan C7's rule for main's messages). Spike B's took any window's message (`spike/b a11y/mode.ts:2-6`).
 */
export function onA11yMode(cb: (on: boolean) => void): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin) return
    if (e.data?.type === 'a11y' && typeof e.data.on === 'boolean') cb(e.data.on)
  })
}
