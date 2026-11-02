// The KaTeX worker (spec §4.6): TeX in, KaTeX's HTML+MathML out within its caps. The main thread sanitizes before the
// DOM sees it, and terminates this worker if a job runs past its watchdog.
import { WORKER_READY } from '../worker-jobs'
import { renderBounded } from './tex'

self.onmessage = (e: MessageEvent<{ tex: string; displayMode: boolean; maxElements: number }>) => {
  self.postMessage(renderBounded(e.data.tex, e.data.displayMode, e.data.maxElements))
}
self.postMessage(WORKER_READY)
