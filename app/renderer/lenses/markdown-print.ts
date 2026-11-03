import type { PrintNode, PrintTag } from '../../shared/protocol'

const allowed = new Set<PrintTag>(['p','h1','h2','h3','h4','h5','h6','strong','em','del','code','pre','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','a','br','hr','span','img','dl','dt','dd'])
const voidTags = new Set<PrintTag>(['br','hr'])

/** Converts the native sanitizer's bounded Markdown HTML into a strict, attribute-free print tree. */
export function markdownPrintNodes(html: string, note?: string): PrintNode[] {
  if (html.length > 256 << 10) throw new Error('A Markdown block exceeds the print block limit')
  const root: PrintNode[] = []
  const stack: Array<{ tag: PrintTag | null; children: PrintNode[] }> = [{ tag: null, children: root }]
  let nodes = 0
  const text = (value: string) => {
    if (!value) return
    // Its input is serialized HTML (ammonia's html5ever, or Chromium's innerHTML), which escapes only as &amp; &lt; &gt; &quot; &nbsp;.
    const decoded = value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, entity => {
      const key = entity.slice(1, -1).toLowerCase()
      if (key === 'amp') return '&'
      if (key === 'lt') return '<'
      if (key === 'gt') return '>'
      if (key === 'quot') return '"'
      if (key === 'apos') return "'"
      if (key === 'nbsp') return '\u00a0'
      const n = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : entity
    })
    stack.at(-1)!.children.push({ text: decoded })
    if (++nodes > 100_000) throw new Error('The print document has too many nodes')
  }
  const tokens = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)\b([^>]*)>|([^<]+)|</g
  let match: RegExpExecArray | null
  while ((match = tokens.exec(html))) {
    const token = match[0]
    if (token.startsWith('<!--')) continue
    const tagName = match[1]?.toLowerCase() as PrintTag | undefined
    if (!tagName) { text(token); continue }
    const closing = token.startsWith('</')
    if (!allowed.has(tagName)) continue
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tagName) { stack.length = i; break }
      continue
    }
    if (tagName === 'img') {
      const attrs = match[2] ?? ''
      const alt = /\balt\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] ?? ''
      const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2]
      if (src && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length <= 2 << 20)
        stack.at(-1)!.children.push({ tag: 'img', src, alt })
      else if (alt) text(alt)
      if (++nodes > 100_000) throw new Error('The print document has too many nodes')
      continue
    }
    const children: PrintNode[] = []
    stack.at(-1)!.children.push({ tag: tagName === 'a' ? 'span' : tagName, ...(voidTags.has(tagName) ? {} : { children }) })
    if (++nodes > 100_000) throw new Error('The print document has too many nodes')
    if (!voidTags.has(tagName) && !token.endsWith('/>')) stack.push({ tag: tagName, children })
  }
  if (note) root.push({ tag: 'p', children: [{ text: note }] })
  return root
}
