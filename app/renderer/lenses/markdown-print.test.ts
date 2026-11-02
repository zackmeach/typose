import { describe, expect, it } from 'vitest'
import { markdownPrintNodes } from './markdown-print'

describe('markdownPrintNodes', () => {
  it('keeps semantic Markdown tags while dropping all source attributes', () => {
    expect(markdownPrintNodes('<h2 id="x">Heading</h2><p onclick="evil()"><strong>safe</strong></p>')).toEqual([
      { tag: 'h2', children: [{ text: 'Heading' }] },
      { tag: 'p', children: [{ tag: 'strong', children: [{ text: 'safe' }] }] }
    ])
  })

  it('keeps escaped source markup as literal text', () => {
    expect(markdownPrintNodes('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>')).toEqual([
      { tag: 'pre', children: [{ tag: 'code', children: [{ text: '<script>alert(1)</script>' }] }] }
    ])
  })
})
