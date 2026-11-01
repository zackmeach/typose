import { Composer, Parser, isAlias, isMap, isScalar, isSeq, type Document, type Node } from 'yaml'
import type { StructuredChildren, StructuredInfo, StructuredNode, StructuredProblem } from '../../shared/protocol'

export const YAML_MAX_BYTES = 8 << 20
const MAX_NODES = 100_000
const MAX_DEPTH = 100
/** CST-backed projection. Aliases remain references; never call toJS/toJSON. */
export function yamlModel(source: string, encoding = 'utf-8', bom = 0) {
  const offsets = new Uint32Array(source.length + 1)
  let bytes = bom
  for (let i = 0; i < source.length; i++) {
    offsets[i] = bytes
    const code = source.codePointAt(i)!
    const width = encoding.toLowerCase().startsWith('utf-16') ? (code > 0xffff ? 4 : 2) : code < 128 ? 1 : code < 2048 ? 2 : code > 0xffff ? 4 : 3
    if (code > 0xffff) { offsets[++i] = bytes; bytes += width } else bytes += width
  }
  offsets[source.length] = bytes
  const containers = new Map<number, StructuredNode[]>()
  const anchors = new Map<string, Node>()
  const aliases = new Map<number, Node | undefined>()
  const projected = new Map<Node, StructuredNode>()
  const parents = new Map<StructuredNode, StructuredNode>()
  const problems: StructuredProblem[] = []
  let serial = 0, count = 0
  const span = (start: number, end: number) => ({ start: offsets[Math.min(start, source.length)]!, end: offsets[Math.min(end, source.length)]! })
  const problem = (kind: string, message: string, start: number, end: number) => {
    const line = source.slice(0, start).split('\n').length
    problems.push({ kind, count: 1, message, first: span(start, end), line })
  }
  // Adapted from the spike's CST token walk: regex cannot distinguish block scalars from comments.
  const comments: { offset: number; source: string }[] = [], tags: { offset: number; source: string }[] = []
  const documents: Document.Parsed[] = []
  const composer = new Composer({ version: '1.2', schema: 'core', keepSourceTokens: true, uniqueKeys: false, strict: true })
  for (const cst of new Parser().parse(source)) {
    const stack: unknown[] = [cst]
    while (stack.length) {
      const token = stack.pop()
      if (!token || typeof token !== 'object') continue
      if (Array.isArray(token)) { stack.push(...token); continue }
      const part = token as Record<string, unknown>
      if (part.type === 'comment' || part.type === 'tag') (part.type === 'comment' ? comments : tags).push(part as unknown as { offset: number; source: string })
      for (const key of ['start', 'sep', 'end', 'items', 'key', 'value', 'props']) if (part[key] && typeof part[key] === 'object') stack.push(part[key])
    }
    documents.push(...composer.next(cst))
  }
  documents.push(...composer.end())
  function node(value: Node | null, ordinal: number, depth: number, key?: Node | null): StructuredNode {
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error('YAML Tree structural limit exceeded (100,000 nodes / 100 levels)')
    const range = value?.range ?? [key?.range?.[1] ?? 0, key?.range?.[1] ?? 0]
    const start = range[0], end = range[1]
    const text = source.slice(start, end)
    const kind = isMap(value) ? 'object' : isSeq(value) ? 'array' : isAlias(value) ? 'alias' : isScalar(value) ? value.value === null ? 'null' : typeof value.value === 'boolean' ? 'boolean' : typeof value.value === 'number' || typeof value.value === 'bigint' ? 'number' : 'string' : 'null'
    const item: StructuredNode = { ordinal, kind, span: span(start, end), text: text.slice(0, 4096), more: text.length > 4096 }
    if (value) projected.set(value, item)
    if (key?.range) { item.key = source.slice(key.range[0], key.range[1]); item.keySpan = span(key.range[0], key.range[1]) }
    if (value?.tag) {
      const tag = tags.filter(token => token.offset < start && !source.slice(token.offset + token.source.length, start).includes('\n')).at(-1)
      if (tag) item.text = `${tag.source} ${item.text}`
    }
    if (value && 'anchor' in value && value.anchor) anchors.set(value.anchor, value)
    if (isMap(value) || isSeq(value)) {
      item.container = ++serial
      const children: StructuredNode[] = []
      if (isMap(value)) {
        const keys = new Set<string>()
        for (const pair of value.items) {
          const entry = node(pair.value as Node | null, children.length, depth + 1, pair.key as Node | null)
          const keyNode = pair.key as Node | null
          const identity = isScalar(keyNode) ? `${typeof keyNode.value}:${String(keyNode.value)}` : entry.key ?? ''
          if (keys.has(identity)) { entry.duplicate = true; problem('duplicate-key', 'Duplicate key', keyNode?.range?.[0] ?? start, keyNode?.range?.[1] ?? end) }
          keys.add(identity)
          children.push(entry)
          parents.set(entry, item)
        }
      } else for (const child of value.items) { const entry = node(child as Node | null, children.length, depth + 1); children.push(entry); parents.set(entry, item) }
      item.children = children.length
      containers.set(item.container, children)
    } else if (isAlias(value)) {
      item.container = ++serial; item.children = 1; aliases.set(item.container, anchors.get(value.source))
      if (!anchors.has(value.source)) problem('alias', `Unknown anchor ${value.source}`, start, end)
    }
    return item
  }
  const roots: StructuredNode[] = []
  for (const doc of documents) {
    anchors.clear()
    for (const error of doc.errors) problem('parse', error.message, error.pos[0], error.pos[1])
    if (doc.contents) roots.push(node(doc.contents, roots.length, 0))
  }
  // Comments have source spans and remain visible, including comments between documents.
  const values = [...projected.values()].sort((a, b) => a.span.start - b.span.start)
  const endings = [...values].sort((a, b) => a.span.end - b.span.end)
  const preceding = (items: StructuredNode[], position: number, end: boolean): StructuredNode | undefined => {
    let low = 0, high = items.length
    while (low < high) { const mid = (low + high) >>> 1; if ((end ? items[mid]!.span.end : items[mid]!.span.start) <= position) low = mid + 1; else high = mid }
    return items[low - 1]
  }
  for (const comment of comments) {
    if (++count > MAX_NODES) throw new Error('YAML Tree structural limit exceeded')
    const lineStart = source.lastIndexOf('\n', comment.offset - 1) + 1
    const fullLine = source.slice(lineStart, comment.offset).trim() === ''
    if (!fullLine) {
      const owner = preceding(endings, offsets[comment.offset]!, true)
      if (owner) { owner.text += ` ${comment.source}`; continue }
    }
    const entry: StructuredNode = { ordinal: 0, kind: 'comment', span: span(comment.offset, comment.offset + comment.source.length), text: comment.source, more: false }
    let owner = preceding(values, entry.span.start, false)
    while (owner && (owner.container === undefined || owner.kind === 'alias' || owner.span.end < entry.span.end)) owner = parents.get(owner)
    if (owner) { const children = containers.get(owner.container!)!; children.push(entry); children.sort((a, b) => a.span.start - b.span.start); owner.children = children.length }
    else roots.push(entry)
  }
  const root: StructuredNode = roots.length === 1 ? roots[0]! : { ordinal: 0, kind: 'array', span: span(0, source.length), text: 'Documents', more: false, container: ++serial, children: roots.length }
  if (roots.length !== 1) containers.set(root.container!, roots.sort((a, b) => a.span.start - b.span.start))
  return {
    root, problems,
    children(container: number, start: number, size: number): StructuredChildren {
      if (aliases.has(container)) {
        const target = aliases.get(container), value = target && projected.get(target)
        return { nodes: value ? [{ ...value, ordinal: 0, key: undefined, keySpan: undefined }] : [] }
      }
      const all = containers.get(container) ?? [], end = Math.min(all.length, start + Math.min(128, size))
      return { nodes: all.slice(start, end), ...(end < all.length ? { next: end } : {}) }
    }
  }
}

export type YamlModel = ReturnType<typeof yamlModel>
export type YamlInfo = Pick<StructuredInfo, 'root' | 'problems'>
