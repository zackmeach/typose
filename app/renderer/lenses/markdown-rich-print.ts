import DOMPurify from 'dompurify'
import type { PrintNode } from '../../shared/protocol'
import { markdownExtras } from './markdown-extras'
import { MATH_PRINT_TAGS, validMathAttribute, type MathPrintNode, type MathPrintTag } from '../../shared/math-print'
import { markdownPrintNodes } from './markdown-print'

const rasterPurify = DOMPurify(window)
rasterPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (['href', 'xlink:href', 'src'].includes(data.attrName)) data.keepAttr = false
  if (data.attrName === 'style' && /url\(|@|\\/i.test(data.attrValue)) data.keepAttr = false
})

/** Converts generated KaTeX MathML to an inert tree. Its TeX annotation and HTML sibling never cross IPC. */
function mathPrintTree(math: Element): MathPrintNode {
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

async function diagramImage(frame: HTMLIFrameElement): Promise<string> {
  const source = frame.getAttribute('src') ?? ''
  const encoded = /^data:text\/html;(?:charset=UTF-8;)?base64,(.*)$/is.exec(source)?.[1]
  if (!encoded || encoded.length > 2 << 20) throw new Error('Diagram exceeds the print image input limit')
  const html = new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)))
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const diagram = parsed.querySelector('svg')
  if (!diagram) throw new Error('Diagram has no printable SVG')
  const view = diagram.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const width = Math.min(1400, Math.max(1, view?.[2] ?? Number.parseFloat(diagram.getAttribute('width') ?? '800')))
  const height = Math.min(1800, Math.max(1, view?.[3] ?? Number.parseFloat(diagram.getAttribute('height') ?? '600')))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > 4_000_000) throw new Error('Diagram print dimensions are invalid')
  diagram.setAttribute('width', String(width)); diagram.setAttribute('height', String(height))
  // Generated SVG is sanitized again. No foreignObject, links, images, scripts or URL paints survive.
  const safe = rasterPurify.sanitize(diagram.outerHTML, { USE_PROFILES: { svg: true },
    FORBID_TAGS: ['foreignObject', 'image', 'a', 'script', 'style', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'src'], ALLOW_DATA_ATTR: false })
    .replace(/url\((?!#[\w-]+\))[^)]*\)/gi, 'none')
    .replace(/(<svg\b[^>]*>)/, '$1<style>text,tspan{fill:#111;font:14px Arial,sans-serif}rect,circle,ellipse,polygon{fill:#f1f3f5;stroke:#343a40}path,line,polyline{stroke:#343a40;fill:none}marker path{fill:#343a40}</style>')
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safe)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width); canvas.height = Math.ceil(height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Diagram print canvas unavailable')
  context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height)
  const result = canvas.toDataURL('image/png')
  canvas.width = canvas.height = 0
  if (result.length > 2 << 20) throw new Error('Diagram exceeds the print image output limit')
  return result
}

/** Builds rich print from this requested source block even when its screen block is offscreen or not mounted. */
export async function markdownRichPrintNodes(html: string, note: string | undefined, current: () => boolean, reserve: (bytes: number) => Promise<boolean>): Promise<PrintNode[]> {
  if (note || !/tp-math|language-mermaid|data-frontmatter|data-callout/.test(html)) return markdownPrintNodes(html, note)
  const staging = document.createElement('div')
  staging.className = 'md-print-staging'
  staging.style.cssText = 'position:fixed;left:-20000px;top:0;width:700px;background:white;color:black;pointer-events:none'
  staging.setAttribute('aria-hidden', 'true')
  staging.innerHTML = html
  document.body.append(staging)
  // Each formula's TeX, before KaTeX replaces it: the print fallback for MathML the strict print tree can't carry.
  const sources = new Map([...staging.querySelectorAll('.tp-math')].map(math => [math, math.textContent ?? '']))
  try {
    await markdownExtras(staging, current, reserve)
    if (!current()) throw new Error('Markdown print source changed')
    const rich = new Map<string, PrintNode>()
    let next = 0
    for (const math of staging.querySelectorAll('.tp-math')) {
      const generated = math.querySelector('math')
      if (!generated) continue
      const key = `TYPOSE_PRINT_RICH_${next++}_END`
      let printed: PrintNode
      // \tag, \rule, \hline and \fcolorbox emit attributes the print tree refuses (width, mathbackground, columnlines,
      // style): that one formula prints as its source, not the whole document failing.
      try { printed = { tag: 'math', math: mathPrintTree(generated) } } catch { printed = { text: sources.get(math) ?? '' } }
      rich.set(key, printed)
      math.replaceWith(document.createTextNode(key))
    }
    for (const frame of staging.querySelectorAll('iframe')) {
      const key = `TYPOSE_PRINT_RICH_${next++}_END`
      rich.set(key, { tag: 'img', src: await diagramImage(frame), alt: 'Mermaid diagram' })
      frame.replaceWith(document.createTextNode(key))
    }
    const blocks = markdownPrintNodes(staging.innerHTML)
    const replace = (nodes: PrintNode[]): PrintNode[] => nodes.flatMap(node => {
      if ('text' in node) {
        return node.text.split(/(TYPOSE_PRINT_RICH_\d+_END)/).filter(Boolean).map(text => rich.get(text) ?? { text })
      }
      return [{ ...node, ...(node.children ? { children: replace(node.children) } : {}) }]
    })
    return replace(blocks)
  } finally { staging.remove() }
}
