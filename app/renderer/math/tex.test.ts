import { describe, expect, it } from 'vitest'
import { HOSTILE_TEX, MATH_BOMB, MATH_BOMB_3 } from './hostile'
import { MATH_MAX_ELEMENTS, elementCount } from './limits'
import { KATEX_OPTIONS, renderBounded, renderTex } from './tex'

/** Attributes or tags in KaTeX's own output that would load, link or carry data. TeX source echoed as text is escaped. */
const UNSAFE = [/<(a|img|script|iframe|object|style)[\s>]/, /\s(href|src|xlink:href)=/, /\sdata-[\w-]+=/, /\son\w+=/, /style="[^"]*(url\(|@import)/]

describe('KaTeX worker output (spec §4.6)', () => {
  it('runs with trust off, bounded expansion and a finite maxSize', () => {
    expect(KATEX_OPTIONS).toEqual({ trust: false, maxExpand: 1000, maxSize: 20, throwOnError: false })
  })

  it('emits nothing that loads, links or carries data for the hostile corpus, before any sanitizer', () => {
    const found: string[] = []
    for (const tex of HOSTILE_TEX)
      for (const displayMode of [false, true]) {
        let html = ''
        try {
          html = renderTex(tex, displayMode)
        } catch {
          continue // a macro definition or stack exhaustion: the renderer keeps the source with the reason
        }
        const tags = (html.match(/<[^>]*>/g) ?? []).join('\n') // KaTeX escapes < > " in text and attribute values
        for (const re of UNSAFE) if (re.test(tags)) found.push(`${re} in ${tex.slice(0, 40)}`)
      }
    expect(found).toEqual([])
  })

  it('refuses macro definitions, so a 231-character bomb never reaches 200,010 elements', () => {
    expect(MATH_BOMB).toHaveLength(231)
    for (const tex of [MATH_BOMB, MATH_BOMB_3, String.raw`\def\a{\a\a}\a`, String.raw`\newcommand{\zz}{\zz\zz}\zz`, String.raw`\global\gdef\b{x}\b`]) {
      let html = ''
      try { html = renderTex(tex, true) } catch { html = '' }
      expect(elementCount(html), tex.slice(-24)).toBeLessThan(MATH_MAX_ELEMENTS)
      expect(renderBounded(tex, true)).toEqual({ error: 'Macro definitions are not rendered' })
    }
    expect('html' in renderBounded(String.raw`\operatorname{define} x`, false)).toBe(true)
  })

  it('caps output in elements before it leaves the worker', () => {
    const row = Array.from({ length: 6 }, (_, i) => String.raw`\frac{a_${i}}{b_${i}}`).join(' & ')
    const matrix = String.raw`\begin{pmatrix}` + Array(6).fill(row).join(String.raw`\\`) + String.raw`\end{pmatrix}`
    const rendered = renderBounded(matrix, true)
    expect('html' in rendered && rendered.elements).toBe(2340)
    expect(renderBounded(matrix, true, 2339)).toEqual({ error: 'Math output exceeds 2339 elements' })
  })

  it('caps sizes at maxSize', () => {
    expect(renderTex(String.raw`\rule{100000em}{100000em}`, false)).toContain('width="20em" height="20em"')
  })
})
