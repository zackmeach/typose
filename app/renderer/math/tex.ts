// KaTeX hardening (spec §4.6). Shared by the KaTeX worker and its tests.
import katex from 'katex'
import { MATH_MAX_BYTES, MATH_MAX_ELEMENTS, elementCount } from './limits'

/**
 * trust: false refuses \href, \url, \includegraphics and \htmlData/\htmlId/\htmlClass/\htmlStyle; maxSize caps every
 * user-given size (\rule, \kern, \hspace) at 20 em. maxExpand bounds macro expansions, not output: one expansion can
 * copy its argument hundreds of times, so a 231-character \def made 200,010 elements. User macro definitions are
 * refused instead, and the output is capped in elements and bytes.
 */
export const KATEX_OPTIONS = { trust: false, maxExpand: 1000, maxSize: 20, throwOnError: false } as const

/** KaTeX has no \csname, so a definition always spells one of these. */
const MACRO_DEFINITION = /\\(?:[gex]?def|(?:re)?newcommand|providecommand)(?![A-Za-z])/

/** HTML + MathML. Parse errors render as a red .katex-error span; a macro definition or stack exhaustion throws. */
export function renderTex(tex: string, displayMode: boolean): string {
  if (MACRO_DEFINITION.test(tex)) throw new Error('Macro definitions are not rendered')
  return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode })
}

/** The worker's whole job: output within the caps, or why not. */
export function renderBounded(tex: string, displayMode: boolean, maxElements = MATH_MAX_ELEMENTS): { html: string; elements: number } | { error: string } {
  let html: string
  try { html = renderTex(tex, displayMode) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  const elements = elementCount(html)
  if (elements > maxElements || html.length > MATH_MAX_BYTES) return { error: `Math output exceeds ${maxElements} elements` }
  return { html, elements }
}
