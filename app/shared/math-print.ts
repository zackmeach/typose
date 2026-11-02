/** Generated static MathML only. No annotation/XML/HTML integration or URL-bearing attributes. */
export const MATH_PRINT_TAGS = ['math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac',
  'msqrt', 'mroot', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose'] as const
export type MathPrintTag = typeof MATH_PRINT_TAGS[number]
export type MathPrintNode = { text: string } | { tag: MathPrintTag; attrs?: Record<string, string>; children?: MathPrintNode[] }

const COMMON = ['mathvariant', 'mathsize', 'mathcolor', 'displaystyle', 'scriptlevel']
const ATTRS: Partial<Record<MathPrintTag, readonly string[]>> = {
  math: ['display'], mo: ['stretchy', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize', 'movablelimits', 'accent'],
  mspace: ['width', 'height', 'depth'], mfrac: ['linethickness', 'bevelled'], mover: ['accent'], munder: ['accentunder'],
  munderover: ['accent', 'accentunder'], mtable: ['columnalign', 'rowalign', 'columnspacing', 'rowspacing'],
  mtd: ['columnalign', 'rowalign', 'columnspan', 'rowspan'], mpadded: ['width', 'height', 'depth', 'lspace', 'voffset'], menclose: ['notation']
}
export function validMathAttribute(tag: MathPrintTag, key: string, value: string): boolean {
  // Restricted scalar values cannot express URLs, CSS, markup, escapes, or event handlers.
  if (!(COMMON.includes(key) || !!ATTRS[tag]?.includes(key)) || value.length > 128 || !/^[\w .+%#-]+$/.test(value)) return false
  const numbers = value.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g)?.map(Number) ?? []
  return numbers.every(number => Number.isFinite(number) && Math.abs(number) <= (key === 'scriptlevel' ? 8 : key === 'mathsize' ? 20 : 1000))
}
