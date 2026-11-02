// Math on the main thread (spec §4.6): KaTeX runs in a worker, and its output passes DOMPurify before it reaches the DOM.
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

// Our own instance: the default one is shared with Mermaid, which must not inherit this hook.
const purify = DOMPurify(window)
// KaTeX's inline styles are plain declarations (sizes, margins, colors). Parentheses, quotes, backslash escapes
// or @ could load something (url(), image-set(), @import), so a style containing any of them is dropped.
const SAFE_STYLE = /^[\w\s:;.,#%-]*$/
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && !SAFE_STYLE.test(data.attrValue)) data.keepAttr = false
})
// The MathML profile, plus HTML for KaTeX's layout spans and SVG for its radicals and stretchy glyphs;
// minus anything that can load or navigate. KaTeX with trust: false never emits a link or an image.
const CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['href', 'xlink:href', 'src'],
  ALLOW_DATA_ATTR: false
}

export function sanitizeMath(html: string): string {
  return purify.sanitize(html, CONFIG)
}

type Result = { id: number; html?: string; error?: string }
let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, (r: Result) => void>()

function katexWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./katex.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<Result>) => {
    pending.get(e.data.id)?.(e.data)
    pending.delete(e.data.id)
  }
  w.onerror = (e) => {
    for (const [id, done] of pending) done({ id, error: e.message || 'KaTeX worker failed' })
    pending.clear()
    w.terminate()
    worker = undefined
  }
  return (worker = w)
}

function showProblem(el: HTMLElement, tex: string, message: string): void {
  const marker = document.createElement('span')
  marker.className = 'problem'
  marker.title = message
  marker.textContent = '⚠'
  el.replaceChildren(marker, tex)
}

/** Renders TeX into `el`. A render error shows the source with a problem marker (brief §4.6). */
export async function renderMath(el: HTMLElement, tex: string, displayMode = false): Promise<void> {
  const w = katexWorker()
  const id = nextId++
  const result = await new Promise<Result>((ok) => {
    pending.set(id, ok)
    w.postMessage({ id, tex, displayMode })
  })
  if (result.error !== undefined) return showProblem(el, tex, result.error)
  el.innerHTML = sanitizeMath(result.html ?? '')
  const parseError = el.querySelector('.katex-error')
  if (parseError) showProblem(el, tex, parseError.getAttribute('title') ?? 'KaTeX parse error')
}
