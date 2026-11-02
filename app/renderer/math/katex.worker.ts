// The KaTeX worker (spec §4.6): TeX in, KaTeX's HTML+MathML out. The main thread sanitizes before the DOM sees it.
import { renderTex } from './tex'

self.onmessage = (e: MessageEvent<{ id: number; tex: string; displayMode: boolean }>) => {
  const { id, tex, displayMode } = e.data
  try {
    self.postMessage({ id, html: renderTex(tex, displayMode) })
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}
