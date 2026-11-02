// KaTeX hardening (spec §4.6). Shared by the KaTeX worker and its tests.
import katex from 'katex'

/**
 * trust: false refuses \href, \url, \includegraphics and \htmlData/\htmlId/\htmlClass/\htmlStyle;
 * maxExpand bounds macro bombs; maxSize caps every user-given size (\rule, \kern, \hspace) at 20 em.
 */
export const KATEX_OPTIONS = { trust: false, maxExpand: 1000, maxSize: 20, throwOnError: false } as const

/** HTML + MathML. Parse errors render as a red .katex-error span; anything else (stack exhaustion) throws. */
export function renderTex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode })
}
