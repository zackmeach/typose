import { describe, expect, it } from 'vitest'
import { physicalPageCount, validatePrintDocument } from './print-validation'

describe('print document validation', () => {
  it('accepts semantic Markdown trees but rejects active tags and attributes', () => {
    expect(validatePrintDocument('guide.md', [{ tag: 'h2', children: [{ text: 'Guide' }] }, { tag: 'table', children: [] }], 2).ok).toBe(true)
    expect(validatePrintDocument('bad', [{ tag: 'script', children: [{ text: 'alert(1)' }] }], 1).ok).toBe(false)
    expect(validatePrintDocument('bad', [{ tag: 'a', href: 'https://example.test', children: [{ text: 'link' }] }], 1).ok).toBe(false)
  })

  it('rejects remote images, extra image keys, and over-limit page counts', () => {
    expect(validatePrintDocument('bad', [{ tag: 'img', src: 'https://example.test/x.png' }], 1).ok).toBe(false)
    expect(validatePrintDocument('bad', [{ tag: 'img', src: 'data:image/png;base64,AA==', children: [{ text: 'ignored' }] }], 1).ok).toBe(false)
    expect(validatePrintDocument('bad', [], 1001)).toMatchObject({ ok: false })
  })

  it('counts physical Page objects and falls back to the PDF page-tree count', () => {
    expect(physicalPageCount(Buffer.from('%PDF /Type /Page /Type /Pages /Count 4 /Type /Page'))).toBe(2)
    expect(physicalPageCount(Buffer.from('%PDF /Type /Pages /Count 17'))).toBe(17)
    expect(physicalPageCount(Buffer.from('%PDF empty'))).toBeNull()
  })

  it('accepts static generated MathML and refuses namespace escape, URL attributes and layout bombs', () => {
    const math = { tag: 'math', children: [{ tag: 'msup', children: [{ tag: 'mi', children: [{ text: 'x' }] }, { tag: 'mn', children: [{ text: '2' }] }] }] }
    expect(validatePrintDocument('math', [{ tag: 'math', math }], 1).ok).toBe(true)
    for (const malicious of [
      { tag: 'annotation-xml', children: [{ tag: 'script', children: [{ text: 'alert(1)' }] }] },
      { tag: 'mi', attrs: { href: 'https://evil.invalid/' } },
      { tag: 'mstyle', attrs: { style: 'background:url(https://evil.invalid/)' } },
      { tag: 'mspace', attrs: { width: '100000000em' } },
      { tag: 'mtd', attrs: { columnspan: '100000000' } },
      { tag: 'mi', attrs: { onclick: 'run' } }
    ]) expect(validatePrintDocument('bad', [{ tag: 'math', math: malicious }], 1).ok).toBe(false)
  })

  // KaTeX's MathML for common TeX, as it emits it: the strict tree refuses each, so markdown-rich-print prints that
  // formula's source as text instead of failing the document.
  it('refuses the MathML of \\tag, \\rule, \\hline and \\fcolorbox, and accepts their TeX fallback', () => {
    const mi = (text: string) => ({ tag: 'mi', children: [{ text }] })
    const cases: Array<[string, unknown]> = [
      [String.raw`x \tag{1}`, { tag: 'mtable', attrs: { width: '100%' }, children: [{ tag: 'mtr', children: [{ tag: 'mtd', attrs: { width: '50%' } }, { tag: 'mtd', children: [mi('x')] }] }] }],
      [String.raw`\rule{1em}{1em}`, { tag: 'mpadded', attrs: { height: '0em', voffset: '0em' }, children: [{ tag: 'mspace', attrs: { mathbackground: 'black', width: '1em', height: '1em' } }] }],
      [String.raw`\begin{array}{|c|c|}\hline a & b \\ \hline\end{array}`, { tag: 'menclose', attrs: { notation: 'top bottom left right' }, children: [{ tag: 'mtable', attrs: { rowspacing: '0.16em', columnalign: 'center center', columnlines: 'solid', columnspacing: '1em' }, children: [{ tag: 'mtr', children: [{ tag: 'mtd', children: [mi('a')] }, { tag: 'mtd', children: [mi('b')] }] }] }] }],
      [String.raw`\fcolorbox{red}{yellow}{x}`, { tag: 'mpadded', attrs: { width: '+6pt', height: '+6pt', lspace: '3pt', voffset: '3pt', style: 'border: 0.04em solid red', mathbackground: 'yellow' }, children: [{ tag: 'mtext', children: [{ text: 'x' }] }] }]
    ]
    expect(validatePrintDocument('math', [{ tag: 'p', children: [{ tag: 'math', math: { tag: 'math', children: [mi('x')] } }] }], 1).ok).toBe(true)
    for (const [tex, tree] of cases) {
      expect(validatePrintDocument('math', [{ tag: 'p', children: [{ tag: 'math', math: { tag: 'math', children: [tree] } }] }], 1).ok, tex).toBe(false)
      expect(validatePrintDocument('math', [{ tag: 'p', children: [{ text: 'Before ' }, { text: tex }, { text: ' after' }] }], 1).ok, tex).toBe(true)
    }
  })
})
