import { describe, expect, it } from 'vitest'
import { boundedLink, decodedLocalTarget, localTarget } from './local-target'

describe('local link syntax, before any native call', () => {
  it('decodes relative paths and Windows file URLs exactly once', () => {
    for (const [href, target] of [
      ['next.md', 'next.md'], ['../notes/next.markdown', '../notes/next.markdown'],
      ['notes\\next.txt', 'notes\\next.txt'], ['caf%C3%A9.md', 'café.md'],
      ['file:///C:/notes/a%20b.md', 'C:/notes/a b.md'],
      ['FILE:///c:/notes/%25name.md', 'c:/notes/%name.md'],
      ['%252e%252e.md', '%2e%2e.md'], ['a%252fb.md', 'a%2fb.md']
    ]) expect(localTarget(href)).toBe(target)
  })

  it('rejects remote, device, alternate-stream, absolute and ambiguous paths even when encoded', () => {
    for (const href of [
      '', '/a.md', '\\a.md', '//host/share/a.md', '\\\\host\\share\\a.md',
      '\\\\?\\C:\\a.md', '\\\\.\\NUL', 'C:/a.md', 'C:a.md', 'file://host/share/a.md',
      'file://localhost/C:/a.md', 'file:/C:/a.md', 'file:///C|/a.md', 'file:////C:/a.md',
      'file:///C:/a.md:stream', 'a.md:stream', 'a%3amd', '%2f%2fhost/a.md', '%5c%5chost/a.md',
      'file:///C:/%5c%5chost/a.md', 'file:///C:/a%3astream.md', 'file:///C:/a%3fb.md',
      'a.md?x', 'a.md?', 'a.md#title', 'a//b.md', 'a./b.md', 'a /b.md', 'a.md.',
      'NUL.txt', 'a/CON.md', 'COM1.txt', 'LPT².md', 'a|b.md', 'a*.md', 'a<b.md',
      'smb://host/a.md', 'javascript:x', 'https://example.com/a.md', '%', '%FF'
    ]) expect(localTarget(href), href).toBeNull()
  })

  it('rejects raw or decoded controls, malformed UTF-16 and either size overflow', () => {
    for (const n of [0, 1, 9, 10, 31, 127, 128, 159]) {
      expect(localTarget('a' + String.fromCharCode(n) + '.md')).toBeNull()
      expect(localTarget('a' + encodeURIComponent(String.fromCharCode(n)) + '.md')).toBeNull()
    }
    expect(localTarget('a' + String.fromCharCode(0xd800) + '.md')).toBeNull()
    expect(localTarget('x'.repeat(32_769))).toBeNull()
    expect(localTarget('é'.repeat(16_385))).toBeNull()
    expect(localTarget('x'.repeat(32_768))).toHaveLength(32_768)
  })

  it('validates already-decoded open targets without decoding literal percent a second time', () => {
    for (const target of ['next.md', '../next.md', 'C:\\notes\\a.md', 'C:/notes/a.md', 'a%2fb.md', '%00.md'])
      expect(decodedLocalTarget(target)).toBe(true)
    for (const target of ['C:a.md', '\\\\host\\a.md', 'C:\\a.md:stream', 'file:///C:/a.md', 'a?b.md'])
      expect(decodedLocalTarget(target)).toBe(false)
    for (const value of [undefined, null, 0, {}, []]) expect(boundedLink(value)).toBe(false)
  })

  it('allows one leading separator only when the owned source has a selected folder', () => {
    for (const [href, target] of [
      ['/guide/B.md', '/guide/B.md'], ['\\guide\\B.md', '\\guide\\B.md'],
      ['%2fguide/B.md', '/guide/B.md'], ['%5cguide%5cB.md', '\\guide\\B.md']
    ]) {
      expect(localTarget(href)).toBeNull()
      expect(localTarget(href, true)).toBe(target)
      expect(decodedLocalTarget(target)).toBe(false)
      expect(decodedLocalTarget(target, true)).toBe(true)
    }
    for (const href of ['/', '\\', '//host/a.md', '\\\\host\\a.md', '/\\host/a.md', '\\/host/a.md',
      '%2f%2fhost/a.md', '%5c%5chost/a.md', '%2f%5chost/a.md', '\\\\?\\C:\\a.md', '\\\\.\\NUL',
      '/C:/a.md', '/a.md:stream', '/a%3astream.md', '/a%3fb.md', '/a//b.md', '/a/CON.md'])
      expect(localTarget(href, true), href).toBeNull()
    for (const target of ['//host/a.md', '\\\\host\\a.md', '/\\host/a.md', '/C:/a.md', '/a.md:stream', '/a?b.md'])
      expect(decodedLocalTarget(target, true), target).toBe(false)
  })
})
