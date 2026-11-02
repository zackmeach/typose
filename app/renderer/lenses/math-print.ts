import { MATH_PRINT_TAGS, validMathAttribute, type MathPrintNode, type MathPrintTag } from '../../shared/math-print'

/** Converts generated KaTeX MathML to an inert tree. Its TeX annotation and HTML sibling never cross IPC. */
export function mathPrintTree(math: Element): MathPrintNode {
  const convert = (node: Node, depth: number): MathPrintNode[] => {
    if (depth > 32) throw new Error('Math print nesting exceeds 32 levels')
    if (node.nodeType === Node.TEXT_NODE) return [{ text: node.textContent ?? '' }]
    if (!(node instanceof Element)) return []
    const tag = node.localName as MathPrintTag
    if (tag === ('annotation' as string) || tag === ('annotation-xml' as string)) return []
    if (tag === ('semantics' as string)) return [...node.childNodes].flatMap(child => convert(child, depth + 1))
    if (!MATH_PRINT_TAGS.includes(tag)) throw new Error(`Unsupported generated MathML tag: ${tag}`)
    const attrs: Record<string, string> = {}
    for (const attribute of node.attributes) {
      if (attribute.name === 'xmlns') continue
      if (!validMathAttribute(tag, attribute.name, attribute.value)) throw new Error(`Unsupported generated MathML attribute: ${attribute.name}`)
      attrs[attribute.name] = attribute.value
    }
    return [{ tag, ...(Object.keys(attrs).length ? { attrs } : {}), children: [...node.childNodes].flatMap(child => convert(child, depth + 1)) }]
  }
  return convert(math, 0)[0]
}
