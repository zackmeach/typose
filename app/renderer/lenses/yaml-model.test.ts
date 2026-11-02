import { describe, expect, it } from 'vitest'
import { yamlModel } from './yaml-model'
import type { StructuredNode } from '../../shared/protocol'

const children = (model: ReturnType<typeof yamlModel>, node = model.root): StructuredNode[] => model.children(node.container!, 0, 128).nodes
describe('YAML 1.2 CST projection', () => {
  it('preserves lexemes, duplicate keys, core strings, tags and trailing comments', () => {
    const source = 'a: 3.10 # exact\n"a": 1e400\nnope: no\npower: on\ntag: !Ref thing\n'
    const model = yamlModel(source), nodes = children(model)
    expect(nodes.map(node => node.text)).toEqual(['3.10 # exact', '1e400', 'no', 'on', '!Ref thing'])
    expect(nodes.map(node => node.kind)).toEqual(['number', 'number', 'string', 'string', 'string'])
    expect(nodes[1]!.duplicate).toBe(true)
    expect(model.problems.some(problem => problem.kind === 'duplicate-key')).toBe(true)
    expect(source.slice(nodes[0]!.span.start, nodes[0]!.span.end)).toBe('3.10')
  })
  it('maps UTF-8 BOM, CRLF and astral characters to original bytes', () => {
    const source = 'k😀: "é"\r\nv: 0x1F\r\n', bytes = new TextEncoder().encode('\uFEFF' + source)
    const model = yamlModel(source, 'utf-8', 3), nodes = children(model)
    const raw = (node: StructuredNode) => new TextDecoder().decode(bytes.slice(node.span.start, node.span.end))
    expect(nodes.map(raw)).toEqual(['"é"', '0x1F'])
    expect(nodes[0]!.keySpan?.start).toBe(3)
  })
  it('maps UTF-16 code units including surrogate pairs without assuming a BOM', () => {
    const source = 'k😀: "é"\r\nv: 3.10\n'
    const model = yamlModel(source, 'utf-16le', 0), nodes = children(model)
    expect(nodes[0]!.span).toEqual({ start: source.indexOf('"é"') * 2, end: (source.indexOf('"é"') + 3) * 2 })
    expect(nodes[1]!.span.start).toBe(source.indexOf('3.10') * 2)
  })
  it('maps a single-byte encoding one byte per character', () => {
    const bytes = Uint8Array.from([...'a: caf', 0xe9, ...' ', 0x80, 0x80, 0x80, 0x80, ...'\nsecret: value\n'].map(c => typeof c === 'number' ? c : c.charCodeAt(0)))
    expect(bytes).toHaveLength(27)
    const source = new TextDecoder('windows-1252').decode(bytes)
    expect(source).toBe('a: café €€€€\nsecret: value\n')
    const nodes = children(yamlModel(source, 'windows-1252', 0))
    expect(nodes[1]!.keySpan).toEqual({ start: 13, end: 19 })
    expect(nodes[1]!.span).toEqual({ start: 21, end: 26 })
  })
  it('places 18,000 comments in one sequence in source order without re-sorting per comment', () => {
    const source = 'items:\n' + Array.from({ length: 18_000 }, (_, i) => `  # note ${i}\n  - ${i}\n`).join('')
    expect(source.length).toBeGreaterThan(360_000)
    const started = performance.now(), model = yamlModel(source)
    expect(performance.now() - started).toBeLessThan(3000) // 5.5 s when each comment re-sorted its container
    // The first note precedes the sequence's own span, so the mapping holds it; the rest sit between items.
    const sequence = children(model).find(node => node.kind === 'array')!, items = children(model, sequence)
    expect(sequence.children).toBe(35_999)
    expect(items.slice(0, 4).map(node => node.text)).toEqual(['0', '# note 1', '1', '# note 2'])
    expect(items.every((node, i) => i === 0 || items[i - 1]!.span.start < node.span.start)).toBe(true)
  })
  it('walks a CST token list of 95,000 comments without spreading it into one call', () => {
    const model = yamlModel('items:\n' + '  # c\n'.repeat(95_000) + '  - 1\n')
    expect(model.root.kind).toBe('object')
    expect(model.root.children).toBe(95_001)
  })
  it('uses CST comments so block-scalar hash lines remain scalar content', () => {
    const model = yamlModel('# top\nbody: |\n  # literal\n  hello\n# end\n')
    const walk = (node: StructuredNode): StructuredNode[] => [node, ...(node.container === undefined ? [] : children(model, node).flatMap(walk))]
    const all = walk(model.root)
    expect(all.filter(node => node.kind === 'comment').map(node => node.text)).toEqual(['# top', '# end'])
    expect(all.some(node => node.kind === 'string' && node.text.includes('# literal'))).toBe(true)
  })
  it('retains document separation and reports parse error source locations', () => {
    const model = yamlModel('a: 1\n---\nb: [bad\n')
    expect(children(model).filter(node => node.kind === 'object')).toHaveLength(2)
    expect(model.problems.some(problem => problem.kind === 'parse' && problem.line! >= 3)).toBe(true)
  })
  it('keeps recursive alias references immutable without expanding the graph', () => {
    const model = yamlModel('root: &r [*r]\n')
    const sequence = children(model)[0]!, alias = children(model, sequence)[0]!
    expect(alias.kind).toBe('alias')
    for (let i = 0; i < 100; i++) {
      const target = children(model, alias)[0]!
      expect(target.container).toBe(sequence.container)
      expect(children(model, target)[0]!.container).toBe(alias.container)
    }
  })
  it('binds aliases to preceding anchors within their document', () => {
    const model = yamlModel('a: &x first\nb: *x\nc: &x second\nd: *x\n---\ne: *x\n')
    const docs = children(model), first = children(model, docs[0]!), second = children(model, docs[1]!)
    expect(children(model, first[1]!)[0]!.text).toBe('first')
    expect(children(model, first[3]!)[0]!.text).toBe('second')
    expect(children(model, second[0]!)).toEqual([])
    expect(model.problems.some(problem => problem.kind === 'alias')).toBe(true)
  })
  it('refuses structural depth beyond the bounded projection', () => {
    expect(() => yamlModel('['.repeat(110) + '0' + ']'.repeat(110))).toThrow(/structural limit/)
  })
  it('labels bounded key and comment previews while preserving complete source spans', () => {
    const source = 'k'.repeat(5000) + ': 1 #' + 'c'.repeat(5000) + '\n'
    const model = yamlModel(source), node = children(model)[0]!
    expect(node.key).toHaveLength(4096); expect(node.keyMore).toBe(true); expect(node.keySpan?.end).toBe(5000)
    expect(node.text).toHaveLength(4096); expect(node.more).toBe(true)
  })
})
