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
})
