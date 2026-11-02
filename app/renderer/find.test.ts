import { afterEach, expect, it, vi } from 'vitest'
import { findStatus, foldFind, literalMatches } from './find'
import { projectRenderedBlock } from './lenses/rendered-find'

it('matches literal Unicode scalar lowercase without losing original UTF-16 bounds', () => {
  expect(foldFind('ÉΣİ🙂')).toBe('éσi\u0307🙂')
  expect([...literalMatches('Été İ 🙂', { text: 'éTÉ', matchCase: false })]).toEqual([{ start: 0, end: 3 }])
  expect([...literalMatches('İ', { text: 'i', matchCase: false })]).toEqual([{ start: 0, end: 1 }])
  expect([...literalMatches('i\u0307', { text: 'İ', matchCase: false })]).toEqual([{ start: 0, end: 2 }])
  expect([...literalMatches('a🙂b🙂', { text: '🙂', matchCase: true })]).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }])
  expect([...literalMatches('aaaa', { text: 'aa', matchCase: true })]).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
  expect([...literalMatches('North north', { text: 'north', matchCase: true })]).toEqual([{ start: 6, end: 11 }])
})

it('keeps incomplete counts visibly incomplete and errors explicit', () => {
  expect(findStatus('dock', { count: 12, complete: false, current: 3, busy: true })).toBe('3 of >= 12…')
  expect(findStatus('dock', { count: 12, complete: true, current: 3, busy: false })).toBe('3 of 12')
  expect(findStatus('dock', { count: 0, complete: true, current: null, busy: false })).toBe('No matches')
  expect(findStatus('dock', { count: 0, complete: false, current: null, busy: false, message: 'Frozen' })).toBe('Frozen')
})

// A deliberately small DOM-shaped fixture exercises the projection without adding a second HTML parser.
class TextFixture {
  readonly nodeType = 3
  parentElement?: ElementFixture
  nextSibling: TextFixture | ElementFixture | null = null
  constructor(readonly data: string) {}
}
class ElementFixture {
  readonly nodeType = 1
  parentElement?: ElementFixture
  nextSibling: TextFixture | ElementFixture | null = null
  hidden = false
  dataset: Record<string, string> = {}
  classList = { contains: (name: string) => name === this.className }
  className = ''
  constructor(readonly tagName: string, readonly children: (TextFixture | ElementFixture)[] = []) {
    children.forEach((node, index) => { node.parentElement = this; node.nextSibling = children[index + 1] ?? null })
  }
  get firstChild() { return this.children[0] ?? null }
  getAttribute() { return null }
}
const text = (value: string) => new TextFixture(value)
const element = (tag: string, ...children: (TextFixture | ElementFixture)[]) => new ElementFixture(tag, children)
function project(block: ElementFixture) {
  vi.stubGlobal('Node', { TEXT_NODE: 3 })
  vi.stubGlobal('HTMLElement', ElementFixture)
  try { return projectRenderedBlock(block as unknown as HTMLElement) }
  finally { vi.unstubAllGlobals() }
}
afterEach(() => vi.unstubAllGlobals())

it('projects soft line breaks and cross-inline/entity text as displayed, keeping original text-node offsets', () => {
  const first = text('  north\n  '), bold = text('pier'), tail = text(' & quay  ')
  const projection = project(element('DIV', element('P', first, element('STRONG', bold), tail)))
  expect(projection.text).toBe('north pier & quay\n')
  expect([...literalMatches(projection.text, { text: 'north pier & quay', matchCase: true })]).toEqual([{ start: 0, end: 17 }])
  expect(projection.runs[0]).toMatchObject({ first: first, firstOffset: 2, start: 0, end: 5 })
  expect(projection.runs[1]).toMatchObject({ first: first, firstOffset: 7, lastOffset: 10, start: 5, end: 6, linear: false })
})

it('preserves preformatted code, separates blocks/table cells and excludes hidden text and note chrome', () => {
  const hidden = element('SPAN', text('secret')); hidden.hidden = true
  const button = element('BUTTON', text('Large block · Show in Raw at line 1')); button.className = 'md-note'
  const block = element('DIV', element('P', text('north')), element('P', text('pier')), hidden,
    element('PRE', element('CODE', text('a  b\nc'))), element('TABLE', element('TR', element('TD', text('left')), element('TD', text('right')))), button)
  block.dataset.findNoteUnits = String('Large block'.length)
  const projection = project(block)
  expect(projection.text).toContain('north\npier\n')
  expect(projection.text).toContain('a  b\nc')
  expect(projection.text).toContain('left\tright')
  expect(projection.text).not.toContain('secret')
  expect(projection.text).toContain('Large block')
  expect(projection.text).not.toContain('Show in Raw')
  expect([...literalMatches(projection.text, { text: 'north pier', matchCase: false })]).toEqual([])
})
