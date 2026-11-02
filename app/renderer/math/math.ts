// Math on the main thread (spec §4.6): KaTeX runs in a worker, and its output passes DOMPurify before it reaches the DOM.
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import { workerJobs } from '../worker-jobs'
import { MATH_MAX_BYTES, MATH_MAX_ELEMENTS, elementCount } from './limits'

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
  FORBID_TAGS: ['style', 'form', 'image'],
  FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'poster', 'background', 'action'],
  ALLOW_DATA_ATTR: false
}

export function sanitizeMath(html: string): string {
  return purify.sanitize(html, CONFIG)
}
if (__TEST_HOOKS__) Object.assign(window, { typoseSanitizeMath: sanitizeMath })

/**
 * Renderer bytes a rendered formula keeps, charged before the DOM sees any: a fixed part plus one per element. 30 dense
 * 6×6 matrices (2,340 elements each) raised the renderer's private bytes by 156.6 MiB, and 2,000 inline `$x_i$` (28
 * each) by 292 MiB: 2,358 B an element and 87,064 B a formula. Each ×1.25, rounded up to 64 B.
 */
export const MATH_ELEMENT_BYTES = 2944
export const MATH_FORMULA_BYTES = 108_864
/** A formula still in the worker after this is a runaway: the worker is terminated and respawned for the next. */
const MATH_TIMEOUT_MS = 1500

const katexJob = workerJobs<{ tex: string; displayMode: boolean; maxElements: number }, { html: string } | { error: string }>(
  () => new Worker(new URL('./katex.worker.ts', import.meta.url), { type: 'module' }), MATH_TIMEOUT_MS)

function showProblem(el: HTMLElement, tex: string, message: string): void {
  const marker = document.createElement('span')
  marker.className = 'problem'
  marker.title = message
  marker.textContent = '⚠'
  el.replaceChildren(marker, tex)
}

/**
 * Renders TeX into `el`, after `admit` grants the output's measured cost. A refusal (a macro definition, output over
 * the caps, the watchdog, the budget) keeps the source with the reason in its tooltip; a TeX error also shows a problem
 * marker (brief §4.6).
 */
export async function renderMath(el: HTMLElement, tex: string, displayMode = false, admit: (bytes: number) => Promise<boolean> = async () => true): Promise<void> {
  const kept = (why: string) => { el.title = `Math source kept · ${why}` }
  let result: { html: string } | { error: string }
  try { result = await katexJob({ tex, displayMode, maxElements: MATH_MAX_ELEMENTS }) } catch (error) { return kept(error instanceof Error ? error.message : String(error)) }
  if ('error' in result) return kept(result.error)
  // The worker's caps again, before this thread parses anything.
  const elements = elementCount(result.html)
  if (result.html.length > MATH_MAX_BYTES || elements > MATH_MAX_ELEMENTS) return kept(`Math output exceeds ${MATH_MAX_ELEMENTS} elements`)
  if (!await admit(MATH_FORMULA_BYTES + elements * MATH_ELEMENT_BYTES)) return kept('rendering budget exceeded')
  el.innerHTML = sanitizeMath(result.html)
  const parseError = el.querySelector('.katex-error')
  if (parseError) showProblem(el, tex, parseError.getAttribute('title') ?? 'KaTeX parse error')
}
