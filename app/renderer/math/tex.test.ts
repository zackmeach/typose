import { describe, expect, it } from 'vitest'
import { HOSTILE_TEX } from './hostile'
import { KATEX_OPTIONS, renderTex } from './tex'

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
          continue // stack exhaustion on deep nesting: the renderer shows the source with a problem marker
        }
        const tags = (html.match(/<[^>]*>/g) ?? []).join('\n') // KaTeX escapes < > " in text and attribute values
        for (const re of UNSAFE) if (re.test(tags)) found.push(`${re} in ${tex.slice(0, 40)}`)
      }
    expect(found).toEqual([])
  })

  it('stops macro bombs at maxExpand and caps sizes at maxSize', () => {
    expect(renderTex(String.raw`\def\a{\a\a}\a`, false)).toContain('Too many expansions')
    expect(renderTex(String.raw`\rule{100000em}{100000em}`, false)).toContain('width="20em" height="20em"')
  })
})

