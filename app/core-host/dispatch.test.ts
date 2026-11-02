// Plan C4 at the core host: every numeric parameter against the hostile table, with a spy addon that must not be
// called (and no state change) when a request is refused. And plan C5 and C6's cancels, against the same spy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Cancel, Doc, IndexProgress, Page } from 'typose-node'
import { limits } from 'typose-node'
import type { Response } from '../shared/protocol'
import { type Addon, makeDispatcher } from './dispatch'
import { HOSTILE, isValid } from './numbers'

// An item whose line goes on, so its token shows the session stamped on the way out.
const item = () => ({ gen: 1, line: 0, offset: 0, text: 'x', more: true, next: { gen: 1, line: 0, offset: 1 } })
const page = vi.fn(async (_gen: number, _start: number, _count: number, _cancel: Cancel) => ({ items: [item()] }) as unknown as Page)
const piece = vi.fn(async (_gen: number, _line: number, _offset: number, _cancel: Cancel) => ({ items: [item()] }) as unknown as Page)
const render = vi.fn(async (_gen: number, _cancel: Cancel) => ({ blocks: 1, units: 1, htmlBytes: 8, nodes: 3, noteUnits: 0 }))
const mdPage = vi.fn(async (_gen: number, _start: number, _count: number, _cancel: Cancel) => ({ items: [] }))
const headingLine = vi.fn((_gen: number, _fragment: string): number | null => null)
const localPath = vi.fn((_gen: number, _target: string) => 'C:\\docs\\linked.md')
const openLocal = vi.fn((_gen: number, _target: string): Doc => localDoc)
const prepareImage = vi.fn(async (_gen: number, _target: string, _cancel: Cancel) => ({ id: 1, width: 1, height: 1, encodedBytes: 72, pixelBytes: 4 }))
const imageChunk = vi.fn(async (_gen: number, _id: number, _offset: number, _cancel: Cancel) => new Uint8Array([137, 80, 78, 71]))
const releaseImage = vi.fn((_gen: number, _id: number) => true)
const setCacheActive = vi.fn((_gen: number, _active: boolean) => {})
const reload = vi.fn()
const close = vi.fn()
const startIndex = vi.fn((_cancel: Cancel, _onProgress: (p: IndexProgress) => void) => {})
const doc = {
  generation: 1,
  format: 'text',
  size: 3,
  encoding: 'UTF-8',
  lines: 0,
  indexed: false,
  blank: false,
  page,
  piece,
  render,
  mdPage,
  headingLine,
  localPath,
  openLocal,
  prepareImage,
  imageChunk,
  releaseImage,
  setCacheActive,
  reload,
  close,
  startIndex
} as unknown as Doc
const localDoc = { ...doc, localOnly: true, path: 'C:\\docs\\linked.md' } as unknown as Doc
const openDoc = vi.fn(() => doc)
const reserveCache = vi.fn((_bytes: number) => true)
/** Every cancel flag the dispatcher made, in order. */
let flags: { cancel: ReturnType<typeof vi.fn> }[]
const cancelFlag = () => {
  const flag = { cancel: vi.fn() }
  flags.push(flag)
  return flag as unknown as Cancel
}
const addon: Addon = { coreVersion: () => '0.0.0', limits, openDoc, cancelFlag, reserveCache }
/** Default surface's table is separate from live/pending view bytes; capacity stays paid at its peak. */
const paid = (bytes: number, views = 1, pending = 1) => bytes + 3 * ((64 << 10) + 4096 + 1024 * (views + pending))
const range = (field: string) => limits().ranges.find((r) => r.field === field)!

let dispatch: (data: unknown) => Promise<Response>
let nextId: number
const call = (method: string, params: Record<string, unknown>) => dispatch({ id: nextId++, method, params })
beforeEach(async () => {
  localPath.mockReset().mockReturnValue('C:\\docs\\linked.md')
  openLocal.mockReset().mockReturnValue(localDoc)
  flags = []
  dispatch = makeDispatcher(addon, 7, () => {})
  nextId = 1
  expect(await call('open', { path: 'a.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 1 } }) // document 1 exists
  vi.clearAllMocks()
})

const token = { session: 7, doc: 1, gen: 1, line: 0, offset: 1 }
const imageRef = { session: 7, doc: 1, gen: 1, id: 1 }
const savedTicket = { session: 7, id: '00000000-0000-4000-8000-000000000001' }

// Each method's numeric fields, with valid values for the others. `continuation.x` is a token's field.
const TABLE: [method: string, field: string, base: Record<string, unknown>][] = [
  ['prepareImage', 'doc', { gen: 1, src: 'one.png' }],
  ['prepareImage', 'gen', { doc: 1, src: 'one.png' }],
  ['imageChunk', 'doc', { gen: 1, ref: imageRef, offset: 0 }],
  ['imageChunk', 'gen', { doc: 1, ref: imageRef, offset: 0 }],
  ['imageChunk', 'offset', { doc: 1, gen: 1, ref: imageRef }],
  ['imageChunk', 'ref.session', { doc: 1, gen: 1, ref: imageRef, offset: 0 }],
  ['imageChunk', 'ref.doc', { doc: 1, gen: 1, ref: imageRef, offset: 0 }],
  ['imageChunk', 'ref.gen', { doc: 1, gen: 1, ref: imageRef, offset: 0 }],
  ['imageChunk', 'ref.id', { doc: 1, gen: 1, ref: imageRef, offset: 0 }],
  ['releaseImage', 'doc', { gen: 1, ref: imageRef }],
  ['releaseImage', 'gen', { doc: 1, ref: imageRef }],
  ['releaseImage', 'ref.session', { doc: 1, gen: 1, ref: imageRef }],
  ['releaseImage', 'ref.doc', { doc: 1, gen: 1, ref: imageRef }],
  ['releaseImage', 'ref.gen', { doc: 1, gen: 1, ref: imageRef }],
  ['releaseImage', 'ref.id', { doc: 1, gen: 1, ref: imageRef }],
  ['hello', 'protocol', {}],
  ['open', 'count', { path: 'b.txt', bytes: 0 }],
  ['open', 'bytes', { path: 'b.txt', count: 1 }],
  ['activate', 'doc', { gen: 1, count: 1, bytes: 0 }],
  ['activate', 'gen', { doc: 1, count: 1, bytes: 0 }],
  ['activate', 'count', { doc: 1, gen: 1, bytes: 0 }],
  ['activate', 'bytes', { doc: 1, gen: 1, count: 1 }],
  ['deactivate', 'doc', { gen: 1 }],
  ['deactivate', 'gen', { doc: 1 }],
  ['reserveWorkspace', 'bytes', {}],
  ['openLocal', 'doc', { gen: 1, target: 'b.md', count: 1, bytes: 0 }],
  ['openLocal', 'gen', { doc: 1, target: 'b.md', count: 1, bytes: 0 }],
  ['openLocal', 'count', { doc: 1, gen: 1, target: 'b.md', bytes: 0 }],
  ['openLocal', 'bytes', { doc: 1, gen: 1, target: 'b.md', count: 1 }],
  ['captureLocation', 'doc', { gen: 1 }],
  ['captureLocation', 'gen', { doc: 1 }],
  ['openSaved', 'ticket.session', { ticket: savedTicket, count: 1, bytes: 0 }],
  ['openSaved', 'count', { ticket: savedTicket, bytes: 0 }],
  ['openSaved', 'bytes', { ticket: savedTicket, count: 1 }],
  ['releaseSaved', 'ticket.session', { ticket: savedTicket }],
  ['page', 'doc', { lens: 'raw', gen: 1, start: 0, count: 1 }],
  ['page', 'gen', { doc: 1, lens: 'raw', start: 0, count: 1 }],
  ['page', 'start', { doc: 1, lens: 'raw', gen: 1, count: 1 }],
  ['page', 'count', { doc: 1, lens: 'raw', gen: 1, start: 0 }],
  ['page', 'continuation.session', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.doc', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.gen', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.line', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.offset', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'doc', { lens: 'rendered', gen: 1, start: 0, count: 1 }],
  ['page', 'gen', { doc: 1, lens: 'rendered', start: 0, count: 1 }],
  ['page', 'start', { doc: 1, lens: 'rendered', gen: 1, count: 1 }],
  ['page', 'count', { doc: 1, lens: 'rendered', gen: 1, start: 0 }],
  ['render', 'doc', { gen: 1 }],
  ['render', 'gen', { doc: 1 }],
  ['resolve', 'doc', { gen: 1, href: '#title' }],
  ['resolve', 'gen', { doc: 1, href: '#title' }],
  ['reload', 'doc', { count: 1, bytes: 0 }],
  ['reload', 'count', { doc: 1, bytes: 0 }],
  ['reload', 'bytes', { doc: 1, count: 1 }],
  ['close', 'doc', {}],
  ['cancel', 'id', {}],
  ['reserve', 'doc', { gen: 1, bytes: 0 }],
  ['reserve', 'gen', { doc: 1, bytes: 0 }],
  ['reserve', 'bytes', { doc: 1, gen: 1 }]
]

/** `base` with `field` (a token's, for `continuation.x`) set to `value`, or missing for `undefined`. */
function withValue(base: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const [outer, inner] = field.split('.')
  if (inner) return { ...base, [outer]: withValue(base[outer] as Record<string, unknown>, inner, value) }
  const params = { ...base }
  if (value === undefined) delete params[field]
  else params[field] = value
  return params
}

describe('every numeric parameter takes only integers in its range', () => {
  for (const [method, field, base] of TABLE) {
    const { min, max } = range(field.replace(/^(continuation|ref|ticket)\./, ''))
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${method}${base.lens === 'rendered' ? ' (rendered)' : ''}.${field} = ${String(value)}`, async () => {
        const response = await call(method, withValue(base, field, value))
        if (isValid(value, min, max)) {
          // In range: not refused for its range (a token of another document is still refused, as such).
          expect(response).not.toMatchObject({ error: { code: 'InvalidParams', field, message: expect.stringContaining('must be an integer') } })
          return
        }
        expect(response).toMatchObject({ id: nextId - 1, session: 7, error: { code: 'InvalidParams', field } })
        for (const spy of [openDoc, page, piece, render, mdPage, headingLine, localPath, openLocal, prepareImage, imageChunk, releaseImage, setCacheActive, reload, close, startIndex, reserveCache]) expect(spy).not.toHaveBeenCalled()
        // No state change: document 1 is still open, and the next open is document 2.
        expect(await call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 })).toHaveProperty('result')
        expect(await call('open', { path: 'c.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2 } })
      })
    }
  }
})

describe('continuation tokens (plan C3)', () => {
  it('leave stamped with this session and their document, from a window and from a piece', async () => {
    const stamped = { result: { items: [{ next: { session: 7, doc: 1 } }] } }
    expect(await call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 })).toMatchObject(stamped)
    expect(await call('page', { doc: 1, lens: 'raw', continuation: token })).toMatchObject(stamped)
    expect(piece).toHaveBeenCalledWith(1, 0, 1, expect.anything())
  })

  it("from another session are Stale, and the addon isn't asked", async () => {
    expect(await call('page', { doc: 1, lens: 'raw', continuation: { ...token, session: 6 } })).toMatchObject({ error: { code: 'Stale' } })
    expect(piece).not.toHaveBeenCalled()
  })

  it("from another document are refused, and the addon isn't asked (plan C7: tokens carry their doc)", async () => {
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2 } })
    vi.clearAllMocks()
    for (const [doc, tokenDoc] of [
      [2, 1],
      [1, 2]
    ])
      expect(await call('page', { doc, lens: 'raw', continuation: { ...token, doc: tokenDoc } })).toMatchObject({
        error: { code: 'InvalidParams', field: 'continuation.doc' }
      })
    expect(piece).not.toHaveBeenCalled()
  })

  it('must be an object', async () => {
    for (const continuation of [null, 7, 'token', [1, 2]])
      expect(await call('page', { doc: 1, lens: 'raw', continuation })).toMatchObject({ error: { code: 'InvalidParams', field: 'continuation' } })
    expect(piece).not.toHaveBeenCalled()
  })
})

it('reload opens the next generation, starts its index and returns its first page', async () => {
  expect(await call('reload', { doc: 1, count: 5, bytes: 0 })).toMatchObject({ result: { doc: 1, gen: 1, blank: false, firstPage: { items: [{ next: { session: 7 } }] } } })
  expect(reload).toHaveBeenCalledOnce()
  expect(page).toHaveBeenCalledWith(1, 0, 5, expect.anything())
  expect(startIndex).toHaveBeenCalledOnce()
  reload.mockImplementationOnce(() => {
    throw Object.assign(new Error('io: not found'), { code: 'NotFound' })
  })
  expect(await call('reload', { doc: 1, count: 5, bytes: 0 })).toMatchObject({ error: { code: 'NotFound' } })
  expect(await call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 })).toHaveProperty('result') // still open
})

it('a request id is validated too, and the reply then carries id null', async () => {
  const { min, max } = range('id')
  for (const id of [...HOSTILE, min, max, max + 1]) {
    const response = await dispatch({ id, method: 'close', params: { doc: 9 } })
    if (isValid(id, min, max)) expect(response).toMatchObject({ id, result: false })
    else expect(response).toMatchObject({ id: null, error: { code: 'InvalidParams', field: 'id' } })
  }
})

it('methods resolve by own property only, and debugStats is the test-hooks build\'s', async () => {
  for (const method of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'nope', 42, 'debugStats'])
    expect(await dispatch({ id: 1, method, params: {} })).toMatchObject({ error: { code: 'UnknownMethod' } })
  expect(openDoc).not.toHaveBeenCalled()
})

it('a lens other than raw, a bad path and an unknown document are typed errors', async () => {
  expect(await call('page', { doc: 1, lens: 'rows', start: 0, count: 1 })).toMatchObject({ error: { code: 'InvalidParams', field: 'lens' } })
  for (const path of ['', 'a\0b', 7, null, 'x'.repeat(32_768)])
    expect(await call('open', { path, count: 1, bytes: 0 })).toMatchObject({ error: { code: 'InvalidParams', field: 'path' } })
  expect(await call('page', { doc: 9, lens: 'raw', gen: 1, start: 0, count: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
  expect(await call('hello', { protocol: 2 })).toMatchObject({ error: { code: 'Unsupported' } })
  expect(openDoc).not.toHaveBeenCalled()
})

describe('rendered Markdown (plan: Rendered Markdown slice §2.1)', () => {
  it("open and reload report the file's format, as the core decides it", async () => {
    const d = doc as unknown as { format: string }
    d.format = 'markdown'
    try {
      expect(await call('open', { path: 'b.md', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2, format: 'markdown' } })
      expect(await call('reload', { doc: 2, count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2, format: 'markdown' } })
    } finally {
      d.format = 'text'
    }
  })

  it('render builds the generation asked, and a rendered page reads blocks of it', async () => {
    expect(await call('render', { doc: 1, gen: 1 })).toMatchObject({ result: { blocks: 1, units: 1, htmlBytes: 8, nodes: 3, noteUnits: 0 } })
    expect(render).toHaveBeenCalledWith(1, expect.anything())
    expect(await call('page', { doc: 1, lens: 'rendered', gen: 1, start: 2, count: 3 })).toMatchObject({ result: { items: [] } })
    expect(mdPage).toHaveBeenCalledWith(1, 2, 3, expect.anything())
    expect(page).not.toHaveBeenCalled()
  })

  it('a rendered page takes no continuation, and an unknown document is NoDocument', async () => {
    expect(await call('page', { doc: 1, lens: 'rendered', continuation: token })).toMatchObject({ error: { code: 'InvalidParams', field: 'continuation' } })
    expect(await call('render', { doc: 9, gen: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
    expect(await call('page', { doc: 9, lens: 'rendered', gen: 1, start: 0, count: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
    for (const spy of [piece, mdPage, render]) expect(spy).not.toHaveBeenCalled()
  })

  it('a build stops as a read does: cancel and close set its flag (plan C5, C6), and its freeze cancels the reads', async () => {
    let fail = (_e: unknown) => {}
    render.mockImplementationOnce(() => new Promise((_ok, f) => (fail = f)))
    const building = dispatch({ id: 30, method: 'render', params: { doc: 1, gen: 1 } })
    const flag = flags.at(-1)!
    expect(await call('cancel', { id: 30 })).toMatchObject({ result: true })
    expect(flag.cancel).toHaveBeenCalledOnce()
    fail(cancelled())
    expect(await building).toMatchObject({ id: 30, error: { code: 'Cancelled' } })
    // A freeze the build finds cancels the document's other reads.
    const other = pendingRead()
    void dispatch({ id: 31, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 9, count: 1 } })
    const otherFlag = flags.at(-1)!
    render.mockImplementationOnce(async () => {
      throw Object.assign(new Error('frozen: changed on disk'), { code: 'Frozen' })
    })
    expect(await call('render', { doc: 1, gen: 1 })).toMatchObject({ error: { code: 'Frozen' } })
    expect(otherFlag.cancel).toHaveBeenCalledOnce()
    other.fail(cancelled())
    // Close cancels a build under way.
    render.mockImplementationOnce(() => new Promise(() => {}))
    void dispatch({ id: 32, method: 'render', params: { doc: 1, gen: 1 } })
    const last = flags.at(-1)!
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    expect(last.cancel).toHaveBeenCalledOnce()
  })
})

describe('thin Markdown link resolution', () => {
  const mutable = doc as unknown as { format: string; generation: number }
  beforeEach(() => { mutable.format = 'markdown' })
  afterEach(() => {
    mutable.format = 'text'
    mutable.generation = 1
    headingLine.mockReset().mockReturnValue(null)
  })

  it('decodes fragments once and asks the held build for a source line', async () => {
    for (const [href, fragment, line] of [['#title-1', 'title-1', 4], ['#%E8%AA%9E', '語', 8], ['#typose-footnote:NOTE', 'typose-footnote:NOTE', 12], ['#typose-footnote:a%2520b', 'typose-footnote:a%20b', 16]] as const) {
      headingLine.mockReturnValueOnce(line)
      expect(await call('resolve', { doc: 1, gen: 1, href })).toMatchObject({ result: { kind: 'heading', line } })
      expect(headingLine).toHaveBeenLastCalledWith(1, fragment)
    }
    expect(await call('resolve', { doc: 1, gen: 1, href: '#missing' })).toMatchObject({ result: { kind: 'inert' } })
  })

  it('canonicalizes only allowed external schemes without asking the addon or filesystem', async () => {
    for (const [href, url] of [['HTTP://EXAMPLE.COM', 'http://example.com/'], ['https://example.com/a b', 'https://example.com/a%20b'], ['mailto:me@example.com?subject=Hi', 'mailto:me@example.com?subject=Hi']])
      expect(await call('resolve', { doc: 1, gen: 1, href })).toMatchObject({ result: { kind: 'external', url } })
    for (const spy of [openDoc, page, piece, render, mdPage, headingLine]) expect(spy).not.toHaveBeenCalled()
  })

  it('leaves network, device, other-scheme and malformed targets inert', async () => {
    for (const href of ['', '/a.md', 'file://host/share/a.md', '//host/share/a.md', '\\\\host\\share\\a.md', '\\\\?\\C:\\a.md', '%2f%2fhost/a.md', 'a.md%3astream', 'a.md?query', 'file:///C:/a%3astream.md', 'smb://host/share/a.md', 'javascript:alert(1)', 'vbscript:x', 'data:text/plain,x', 'http://%', '#%', '#%FF', '#%00', '#%C2%85', '#\ud800'])
      expect(await call('resolve', { doc: 1, gen: 1, href })).toMatchObject({ result: { kind: 'inert' } })
    for (const spy of [openDoc, page, piece, render, mdPage, headingLine, localPath, openLocal]) expect(spy).not.toHaveBeenCalled()
  })

  it('checks local candidates through the held document without opening the target', async () => {
    for (const [href, target] of [['other.md', 'other.md'], ['../caf%C3%A9.md', '../café.md'], ['file:///C:/a%20b.md', 'C:/a b.md'], ['%252f.md', '%2f.md']]) {
      expect(await call('resolve', { doc: 1, gen: 1, href })).toMatchObject({ result: { kind: 'local', target, path: 'C:\\docs\\linked.md' } })
      expect(localPath).toHaveBeenLastCalledWith(1, target)
    }
    for (const spy of [openDoc, page, piece, render, mdPage, headingLine, openLocal, reserveCache]) expect(spy).not.toHaveBeenCalled()
  })

  it('keeps native local-capability refusals visible', async () => {
    localPath.mockImplementationOnce(() => { throw Object.assign(new Error('local links support only .md, .markdown and .txt files'), { code: 'Refused' }) })
    expect(await call('resolve', { doc: 1, gen: 1, href: 'image.png' })).toMatchObject({ error: { code: 'Refused' } })
    expect(openLocal).not.toHaveBeenCalled()
  })

  it('validates href type, raw controls and both raw/canonical UTF-8 size bounds', async () => {
    for (const href of [undefined, null, 7, [], {}, 'x'.repeat(32_769), 'é'.repeat(16_385), 'https://e/\0x', 'https://e/\nx', '#\u0085'])
      expect(await call('resolve', { doc: 1, gen: 1, href })).toMatchObject({ error: { code: 'InvalidParams', field: 'href' } })
    const exact = 'https://e/' + 'x'.repeat(32_768 - 'https://e/'.length)
    expect(await call('resolve', { doc: 1, gen: 1, href: exact })).toMatchObject({ result: { kind: 'external', url: exact } })
    expect(await call('resolve', { doc: 1, gen: 1, href: 'https://e/' + '語'.repeat(3000) })).toMatchObject({ result: { kind: 'external' } })
    expect(await call('resolve', { doc: 1, gen: 1, href: 'https://e/' + '語'.repeat(4000) })).toMatchObject({ result: { kind: 'inert' } })
    expect(headingLine).not.toHaveBeenCalled()
  })

  it('rejects stale/closed documents and does not resolve a text document', async () => {
    mutable.generation = 2
    expect(await call('resolve', { doc: 1, gen: 1, href: '#title' })).toMatchObject({ error: { code: 'Stale' } })
    mutable.generation = 1
    mutable.format = 'text'
    expect(await call('resolve', { doc: 1, gen: 1, href: 'https://example.com' })).toMatchObject({ result: { kind: 'inert' } })
    await call('close', { doc: 1 })
    expect(await call('resolve', { doc: 1, gen: 1, href: '#title' })).toMatchObject({ error: { code: 'NoDocument' } })
    expect(headingLine).not.toHaveBeenCalled()
  })
})

describe('local image resources', () => {
  it('parses raw src once, stamps a path-free reference and uses binary fixed chunks', async () => {
    expect(await call('prepareImage', { doc: 1, gen: 1, src: 'a%252fb.png' })).toMatchObject({
      result: { ref: imageRef, width: 1, height: 1, encodedBytes: 72, pixelBytes: 4 }
    })
    expect(prepareImage).toHaveBeenCalledWith(1, 'a%2fb.png', expect.anything())
    const reply = await call('imageChunk', { doc: 1, gen: 1, ref: imageRef, offset: 0 })
    expect(reply).toMatchObject({ result: new Uint8Array([137, 80, 78, 71]) })
    expect(imageChunk).toHaveBeenCalledWith(1, 1, 0, expect.anything())
    expect(openDoc).not.toHaveBeenCalled()
    expect(localPath).not.toHaveBeenCalled()
    expect(reserveCache).not.toHaveBeenCalled() // renderer pays for its image assembly before requesting chunks
  })

  it('refuses raw controls, oversized src and remote/ambiguous paths before addon or I/O', async () => {
    for (const src of [null, 0, {}, [], 'a' + String.fromCharCode(0) + '.png', 'é'.repeat(16_385)])
      expect(await call('prepareImage', { doc: 1, gen: 1, src })).toMatchObject({ error: { code: 'InvalidParams', field: 'src' } })
    for (const src of ['https://example.com/a.png', 'data:image/png,x', '//host/a.png', '%5c%5chost/a.png', 'file://host/a.png', 'a.png%3astream', 'a.png?query'])
      expect(await call('prepareImage', { doc: 1, gen: 1, src })).toMatchObject({ error: { code: 'Refused' } })
    expect(prepareImage).not.toHaveBeenCalled()
    expect(localPath).not.toHaveBeenCalled()
  })

  it('binds references to this session, document and generation before native calls', async () => {
    for (const method of ['imageChunk', 'releaseImage']) {
      for (const [ref, code] of [
        [{ ...imageRef, session: 6 }, 'Stale'], [{ ...imageRef, doc: 2 }, 'InvalidParams'], [{ ...imageRef, gen: 2 }, 'Stale']
      ] as const)
        expect(await call(method, { doc: 1, gen: 1, ref, offset: 0 })).toMatchObject({ error: { code } })
      for (const ref of [null, 3, [], {}])
        expect(await call(method, { doc: 1, gen: 1, ref, offset: 0 })).toMatchObject({ error: { code: 'InvalidParams' } })
    }
    expect(imageChunk).not.toHaveBeenCalled()
    expect(releaseImage).not.toHaveBeenCalled()
  })

  it('refuses unaligned or oversized chunks and a caller count', async () => {
    for (const offset of [1, 262_145, 8_650_752])
      expect(await call('imageChunk', { doc: 1, gen: 1, ref: imageRef, offset })).toMatchObject({ error: { code: 'InvalidParams', field: 'offset' } })
    expect(await call('imageChunk', { doc: 1, gen: 1, ref: imageRef, offset: 0, count: 1 })).toMatchObject({ error: { code: 'InvalidParams', field: 'count' } })
    expect(imageChunk).not.toHaveBeenCalled()
  })

  it('does not send an oversized native chunk over the port', async () => {
    imageChunk.mockResolvedValueOnce(new Uint8Array((256 << 10) + 1))
    expect(await call('imageChunk', { doc: 1, gen: 1, ref: imageRef, offset: 0 })).toMatchObject({ error: { code: 'Internal' } })
  })

  it('forwards MAX_SAFE resource ids without a u32 truncation and releases harmlessly after close', async () => {
    const ref = { ...imageRef, id: Number.MAX_SAFE_INTEGER }
    expect(await call('releaseImage', { doc: 1, gen: 1, ref })).toMatchObject({ result: true })
    expect(releaseImage).toHaveBeenCalledWith(1, Number.MAX_SAFE_INTEGER)
    releaseImage.mockReturnValueOnce(false)
    expect(await call('releaseImage', { doc: 1, gen: 1, ref })).toMatchObject({ result: false })
    await call('close', { doc: 1 })
    expect(await call('releaseImage', { doc: 1, gen: 1, ref })).toMatchObject({ result: false })
  })

  it('uses the existing cancellable read path and refuses a result after its source closes', async () => {
    let finish = (_image: { id: number; width: number; height: number; encodedBytes: number; pixelBytes: number }) => {}
    prepareImage.mockImplementationOnce(() => new Promise((ok) => { finish = ok }))
    const preparing = dispatch({ id: 60, method: 'prepareImage', params: { doc: 1, gen: 1, src: 'one.png' } })
    const flag = flags.at(-1)!
    expect(await call('cancel', { id: 60 })).toMatchObject({ result: true })
    expect(flag.cancel).toHaveBeenCalledOnce()
    await call('close', { doc: 1 })
    finish({ id: 1, width: 1, height: 1, encodedBytes: 72, pixelBytes: 4 })
    expect(await preparing).toMatchObject({ error: { code: 'Stale' } })
    expect(releaseImage).toHaveBeenCalledWith(1, 1)
  })

  it('releases a stale prepare result with its original generation after Reload', async () => {
    let finish = (_image: { id: number; width: number; height: number; encodedBytes: number; pixelBytes: number }) => {}
    prepareImage.mockImplementationOnce(() => new Promise((ok) => { finish = ok }))
    const preparing = dispatch({ id: 61, method: 'prepareImage', params: { doc: 1, gen: 1, src: 'one.png' } })
    const mutable = doc as unknown as { generation: number }
    reload.mockImplementationOnce(() => { mutable.generation = 2 })
    try {
      expect(await call('reload', { doc: 1, count: 1, bytes: 0 })).toMatchObject({ result: { gen: 2 } })
      finish({ id: 1, width: 1, height: 1, encodedBytes: 72, pixelBytes: 4 })
      expect(await preparing).toMatchObject({ error: { code: 'Stale' } })
      expect(releaseImage).toHaveBeenCalledWith(1, 1)
      expect(releaseImage).not.toHaveBeenCalledWith(2, 1)
    } finally { mutable.generation = 1 }
  })

  it('does not publish a chunk answered after Reload', async () => {
    let finish = (_bytes: Uint8Array<ArrayBuffer>) => {}
    imageChunk.mockImplementationOnce(() => new Promise((ok) => { finish = ok }))
    const reading = dispatch({ id: 62, method: 'imageChunk', params: { doc: 1, gen: 1, ref: imageRef, offset: 0 } })
    const mutable = doc as unknown as { generation: number }
    reload.mockImplementationOnce(() => { mutable.generation = 2 })
    try {
      expect(await call('reload', { doc: 1, count: 1, bytes: 0 })).toMatchObject({ result: { gen: 2 } })
      finish(new Uint8Array([137, 80, 78, 71]))
      expect(await reading).toMatchObject({ error: { code: 'Stale' } })
    } finally { mutable.generation = 1 }
  })
})

describe('local document navigation', () => {
  const params = { doc: 1, gen: 1, target: 'linked.md', count: 5, bytes: 100 }
  const nativeError = (code: string) => Object.assign(new Error('local navigation failed'), { code })
  const reserved = () => reserveCache.mock.calls.map(([bytes]) => bytes)

  it('uses the native capability and the normal first-page/index registration path', async () => {
    expect(await call('openLocal', { ...params, target: 'a%2fb.md' })).toMatchObject({
      result: { doc: 2, gen: 1, localOnly: true, path: 'C:\\docs\\linked.md', reserved: 100, firstPage: { items: [{ next: { session: 7, doc: 2 } }] } }
    })
    expect(openLocal).toHaveBeenCalledOnce()
    expect(openLocal).toHaveBeenCalledWith(1, 'a%2fb.md') // already decoded: percent is literal
    expect(openDoc).not.toHaveBeenCalled()
    expect(page).toHaveBeenCalledWith(1, 0, 5, expect.anything())
    expect(startIndex).toHaveBeenCalledOnce()
    expect(await call('reload', { doc: 2, count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, localOnly: true, path: 'C:\\docs\\linked.md' } })
  })

  it('keeps manual open replies unchanged', async () => {
    const reply = await call('open', { path: 'chosen.md', count: 1, bytes: 0 })
    expect(reply).not.toHaveProperty('result.localOnly')
    expect(reply).not.toHaveProperty('result.path')
  })

  it('validates the decoded target and source before native calls or reservations', async () => {
    for (const target of [undefined, null, 7, [], {}, '', '//host/a.md', 'C:a.md', 'a.md:stream', 'file:///C:/a.md', 'a?b.md', 'x'.repeat(32_769), 'é'.repeat(16_385), 'a' + String.fromCharCode(0, 0xd800) + '.md'])
      expect(await call('openLocal', { ...params, target })).toMatchObject({ error: { code: 'InvalidParams', field: 'target' } })
    expect(await call('openLocal', { ...params, gen: 2 })).toMatchObject({ error: { code: 'Stale' } })
    expect(await call('openLocal', { ...params, doc: 2 })).toMatchObject({ error: { code: 'NoDocument' } })
    for (const spy of [openDoc, openLocal, page, startIndex, reserveCache]) expect(spy).not.toHaveBeenCalled()
  })

  it('refuses a reservation before native open, leaving the old lens intact', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    reserveCache.mockReturnValueOnce(false)
    expect(await call('openLocal', { ...params, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(openLocal).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(300), paid(800), paid(200)]) // source remains mounted beside the pending target
  })

  it('returns the old reservation when native open fails, without consuming a document id', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    openLocal.mockImplementationOnce(() => { throw nativeError('NotFound') })
    expect(await call('openLocal', { ...params, bytes: 500 })).toMatchObject({ error: { code: 'NotFound' } })
    expect(close).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(300), paid(800), paid(300), paid(200)])
    expect(await call('openLocal', params)).toMatchObject({ result: { doc: 2 } })
  })

  it('closes a target whose path getter refuses memory before registering it or starting an index', async () => {
    const targetClose = vi.fn()
    openLocal.mockReturnValueOnce({
      ...localDoc,
      get path(): string { throw nativeError('Memory') },
      close: targetClose
    } as unknown as Doc)
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    expect(await call('openLocal', { ...params, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(targetClose).toHaveBeenCalledOnce()
    expect(page).not.toHaveBeenCalled()
    expect(startIndex).not.toHaveBeenCalled()
    expect(await call('close', { doc: 2 })).toMatchObject({ result: false })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(300), paid(800), paid(300), paid(200)])
    expect(await call('openLocal', params)).toMatchObject({ result: { doc: 2 } })
  })

  it('collects the derived path before Reload changes its generation', async () => {
    const path = vi.fn(() => 'C:\\docs\\linked.md')
    const targetReload = vi.fn()
    const target = { ...localDoc, get path() { return path() }, generation: 1, reload: targetReload }
    targetReload.mockImplementation(() => { target.generation++ })
    openLocal.mockReturnValueOnce(target as unknown as Doc)
    expect(await call('openLocal', params)).toMatchObject({ result: { doc: 2 } })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    vi.clearAllMocks()
    path.mockImplementationOnce(() => { throw nativeError('Memory') })
    expect(await call('reload', { doc: 2, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(path).toHaveBeenCalledOnce()
    expect(targetReload).not.toHaveBeenCalled()
    expect(target.generation).toBe(1)
    expect(page).not.toHaveBeenCalled()
    expect(startIndex).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(800, 2), paid(300, 2), paid(200, 2)])
  })

  it('cancels and deletes an index job whose start throws before registering a target', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    startIndex.mockImplementationOnce(() => { throw nativeError('Memory') })
    expect(await call('openLocal', { ...params, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    const failedJob = flags.at(-1)!
    expect(failedJob.cancel).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(await call('close', { doc: 2 })).toMatchObject({ result: false })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(300), paid(800), paid(300), paid(200)])
    expect(await call('openLocal', params)).toMatchObject({ result: { doc: 3 } })
    expect(failedJob.cancel).toHaveBeenCalledOnce() // no stale job left under the reused id
  })

  it('closes a failed first page and returns its reservation to the old lens', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    page.mockImplementationOnce(async () => { throw nativeError('Frozen') })
    expect(await call('openLocal', { ...params, bytes: 500 })).toMatchObject({ error: { code: 'Refused' } })
    expect(close).toHaveBeenCalledOnce()
    expect(startIndex).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(300), paid(800), paid(300), paid(200)])
  })

  it('does not cancel source reads when the target freezes', async () => {
    const sourcePage = pendingRead()
    const reading = dispatch({ id: 40, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 } })
    const sourceFlag = flags.at(-1)!
    page.mockImplementationOnce(async () => { throw nativeError('Frozen') })
    expect(await call('openLocal', params)).toMatchObject({ error: { code: 'Refused' } })
    expect(sourceFlag.cancel).not.toHaveBeenCalled()
    sourcePage.end({ items: [item()] })
    expect(await reading).toHaveProperty('result')
  })

  it('keeps a source freeze distinct and cancels its pending reads', async () => {
    const sourcePage = pendingRead()
    const reading = dispatch({ id: 40, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 } })
    const sourceFlag = flags.at(-1)!
    openLocal.mockImplementationOnce(() => { throw nativeError('Frozen') })
    expect(await call('openLocal', params)).toMatchObject({ error: { code: 'Frozen' } })
    expect(sourceFlag.cancel).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    sourcePage.end({ items: [item()] })
    await reading
  })

  it('does not replace a newer reservation when an older local first page fails', async () => {
    const firstPage = pendingRead()
    const opening = dispatch({ id: 80, method: 'openLocal', params: { ...params, bytes: 500 } })
    expect(await call('open', { path: 'chosen.txt', count: 1, bytes: 700 })).toMatchObject({ result: { doc: 2, reserved: 700 } })
    firstPage.fail(nativeError('Io'))
    expect(await opening).toMatchObject({ error: { code: 'Io' } })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 600 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(500), paid(1200, 1, 2), paid(1200, 2, 2), paid(700, 2, 2), paid(600, 2, 2)])
  })

  for (const change of ['reload', 'close']) {
    it('rejects a source ' + change + ' while its target first page waits', async () => {
      const source = doc as unknown as { generation: number }
      const firstPage = pendingRead()
      const opening = dispatch({ id: 90, method: 'openLocal', params })
      try {
        if (change === 'reload') source.generation = 2
        else await call('close', { doc: 1 })
        firstPage.end({ items: [item()] })
        expect(await opening).toMatchObject({ error: { code: 'Stale' } })
        expect(startIndex).not.toHaveBeenCalled()
      } finally { source.generation = 1 }
    })
  }
})

it('an addon error keeps its typed code, and anything else is Internal', async () => {
  openDoc.mockImplementationOnce(() => {
    throw Object.assign(new Error('refused: a device path'), { code: 'Refused' })
  })
  expect(await call('open', { path: '\\\\.\\NUL', count: 1, bytes: 0 })).toMatchObject({ error: { code: 'Refused', message: 'refused: a device path' } })
  // Plan C1: the ledger's refusal reaches the renderer as `Memory`, which its card shows (plan §7 proposal 1).
  openDoc.mockImplementationOnce(() => {
    throw Object.assign(new Error('the memory budget is full: 4523288 bytes asked, 12 free'), { code: 'Memory' })
  })
  expect(await call('open', { path: 'big.txt', count: 1, bytes: 0 })).toMatchObject({ error: { code: 'Memory' } })
  expect(await call('open', { path: 'c.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2 } }) // the refusal took no id
  openDoc.mockImplementationOnce(() => {
    throw Object.assign(new Error('boom'), { code: 'GenericFailure' })
  })
  expect(await call('open', { path: 'x', count: 1, bytes: 0 })).toMatchObject({ error: { code: 'Internal' } })
})

describe('retained tab activation', () => {
  function fixture() {
    const first = vi.fn(async (gen: number, _start: number, _count: number, _cancel: Cancel) => {
      const value = item()
      value.gen = value.next.gen = gen
      return { items: [value] } as unknown as Page
    })
    const index = vi.fn((_cancel: Cancel, _onProgress: (p: IndexProgress) => void) => {})
    const closed = vi.fn()
    const cache = vi.fn((_gen: number, _active: boolean) => {})
    const reloaded = vi.fn(() => { data.generation++ })
    const data = { ...doc, generation: 1, cacheActive: true, page: first, startIndex: index, close: closed, reload: reloaded, setCacheActive: cache }
    cache.mockImplementation((gen, active) => {
      if (gen !== data.generation) throw Object.assign(new Error('stale cache generation'), { code: 'Stale' })
      data.cacheActive = active
    })
    return { native: data as unknown as Doc, data, page: first, index, close: closed, reload: reloaded, cache }
  }
  type Tab = ReturnType<typeof fixture>
  function holdPage(tab: Tab) {
    const ends = {} as { end: () => void; fail: (error: unknown) => void }
    tab.page.mockImplementationOnce((gen) => new Promise<Page>((ok, fail) => Object.assign(ends, {
      end: () => ok({ items: [{ ...item(), gen }] } as unknown as Page), fail
    })))
    return ends
  }
  function holdCancellablePage(tab: Tab) {
    let end = () => {}
    tab.page.mockImplementationOnce((gen, _start, _count, cancel) => new Promise<Page>((ok, fail) => {
      const flag = cancel as unknown as (typeof flags)[number]
      flag.cancel.mockImplementation(() => fail(cancelled()))
      end = () => ok({ items: [{ ...item(), gen }] } as unknown as Page)
    }))
    return { end: () => end() }
  }
  async function tabs() {
    const [a, b] = [fixture(), fixture()]
    flags = []
    dispatch = makeDispatcher(addon, 7, () => {})
    nextId = 1
    openDoc.mockReturnValueOnce(a.native).mockReturnValueOnce(b.native)
    expect(await call('open', { path: 'a.txt', count: 1, bytes: 100 })).toMatchObject({ result: { doc: 1 } })
    const aJob = flags.at(-1)!
    await call('deactivate', { doc: 1, gen: 1 }) // this fixture models one mounted card switching A to B
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 200 })).toMatchObject({ result: { doc: 2 } })
    const bJob = flags.at(-1)!
    vi.clearAllMocks()
    return { a, b, aJob, bJob }
  }
  afterEach(() => { openDoc.mockReset().mockReturnValue(doc) })

  describe('tab deactivation', () => {
    it('trims the disposed active view immediately, cancels its reads, and retains its document, index and workspace share', async () => {
      const { a, b, aJob, bJob } = await tabs()
      expect(await call('reserveWorkspace', { bytes: 100 })).toMatchObject({ result: true })
      const previous = holdPage(b)
      const reading = dispatch({ id: 85, method: 'page', params: { doc: 2, gen: 1, lens: 'raw', start: 9, count: 1 } })
      const previousFlag = flags.at(-1)!
      vi.clearAllMocks()
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      expect(b.data.cacheActive).toBe(false)
      expect(b.cache).toHaveBeenCalledWith(1, false)
      expect(previousFlag.cancel).toHaveBeenCalledOnce()
      for (const spy of [a.cache, a.index, b.index, a.reload, b.reload, a.close, b.close, aJob.cancel, bJob.cancel, openDoc])
        expect(spy).not.toHaveBeenCalled()
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(100)])
      expect(leaving).toMatchObject({ result: true })
      expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: false })
      previous.fail(cancelled())
      expect(await reading).toMatchObject({ error: { code: 'Cancelled' } })
      expect(await call('activate', { doc: 2, gen: 1, count: 1, bytes: 200 })).toMatchObject({ result: { doc: 2, reserved: 200 } })
      expect(b.index).not.toHaveBeenCalled()
    })

    it('deactivates the old cache before a fresh open applies pressure, including an open that fails', async () => {
      const { a, b, bJob } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      let activeAtOpen: boolean | undefined
      openDoc.mockImplementationOnce(() => {
        activeAtOpen = b.data.cacheActive
        throw Object.assign(new Error('missing'), { code: 'NotFound' })
      })
      const opening = await call('open', { path: 'missing.txt', count: 1, bytes: 500 })
      expect(activeAtOpen).toBe(false)
      expect(b.cache.mock.invocationCallOrder[0]).toBeLessThan(reserveCache.mock.invocationCallOrder[0])
      expect(leaving).toMatchObject({ result: true })
      expect(opening).toMatchObject({ error: { code: 'NotFound' } })
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, false])
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(100), paid(600), paid(100)])
      for (const spy of [a.close, b.close, bJob.cancel]) expect(spy).not.toHaveBeenCalled()
    })

    it('keeps the disposed old tab inactive when selecting another tab fails', async () => {
      const { a, b } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      a.page.mockRejectedValueOnce(Object.assign(new Error('first page refused'), { code: 'Memory' }))
      const activating = await call('activate', { doc: 1, gen: 1, count: 1, bytes: 500 })
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, false])
      expect(leaving).toMatchObject({ result: true })
      expect(activating).toMatchObject({ error: { code: 'Memory' } })
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(100), paid(600), paid(100)])
      expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: false })
      expect(b.close).not.toHaveBeenCalled()
    })

    it('validates ownership and generation before changing caches, reads or reservations', async () => {
      const { a, b } = await tabs()
      const previous = holdPage(b)
      const reading = dispatch({ id: 86, method: 'page', params: { doc: 2, gen: 1, lens: 'raw', start: 9, count: 1 } })
      const previousFlag = flags.at(-1)!
      expect(await call('deactivate', { doc: 2, gen: 2 })).toMatchObject({ error: { code: 'Stale' } })
      expect(await call('deactivate', { doc: 3, gen: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
      for (const spy of [a.cache, b.cache, previousFlag.cancel, reserveCache]) expect(spy).not.toHaveBeenCalled()
      expect(b.data.cacheActive).toBe(true)
      previous.end()
      expect(await reading).toHaveProperty('result')
    })

    it('does not release a newer pending activation or cancel that target when the old view leaves', async () => {
      const { a, b } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const delayed = holdPage(a)
      const activating = dispatch({ id: 87, method: 'activate', params: { doc: 1, gen: 1, count: 1, bytes: 500 } })
      const targetFlag = flags.at(-1)!
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      expect(b.data.cacheActive).toBe(false)
      expect(leaving).toMatchObject({ result: true })
      expect(targetFlag.cancel).not.toHaveBeenCalled()
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(800), paid(600)]) // source detach releases its own 200
      delayed.end()
      expect(await activating).toMatchObject({ result: { doc: 1, reserved: 500 } })
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([true, false])
      expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
      expect(reserveCache.mock.calls.at(-1)).toEqual([paid(400)])
    })

    it('forgets a disposed fallback without releasing newer pending bytes, then keeps only workspace if that activation fails', async () => {
      const { a, b } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const delayed = holdPage(a)
      const activating = dispatch({ id: 88, method: 'activate', params: { doc: 1, gen: 1, count: 1, bytes: 500 } })
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      expect(b.data.cacheActive).toBe(false)
      expect(leaving).toMatchObject({ result: true })
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(800), paid(600)])
      delayed.fail(Object.assign(new Error('first page failed'), { code: 'Io' }))
      expect(await activating).toMatchObject({ error: { code: 'Io' } })
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(800), paid(600), paid(100)])
      expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: false })
      expect(b.close).not.toHaveBeenCalled()
    })

    it('leaves a successful local target and its newer reservation active when its old source view leaves', async () => {
      const { a, b, bJob } = await tabs()
      const target = fixture()
      Object.assign(b.data, { openLocal: vi.fn(() => target.native) })
      await call('reserveWorkspace', { bytes: 100 })
      expect(await call('openLocal', { doc: 2, gen: 1, target: 'linked.md', count: 1, bytes: 500 })).toMatchObject({ result: { doc: 3, reserved: 500 } })
      vi.clearAllMocks()
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      expect(target.data.cacheActive).toBe(true)
      expect(target.cache).not.toHaveBeenCalled()
      expect(reserveCache).toHaveBeenLastCalledWith(paid(600, 2)) // only the old source's 200-byte lease was released
      expect(leaving).toMatchObject({ result: true })
      expect(await call('reserve', { doc: 3, gen: 1, bytes: 300 })).toMatchObject({ result: true })
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(600, 2), paid(400, 2)])
      for (const spy of [a.close, b.close, target.close, bJob.cancel]) expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('retained Reload cancellation', () => {
    it('finishes current metadata after leaving and later inactive-cache reclamation when its native read honors cancellation', async () => {
      const { a, b } = await tabs()
      const delayed = holdCancellablePage(b)
      const reloading = dispatch({ id: 97, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const pendingFlag = flags.at(-1)!
      expect(await call('deactivate', { doc: 2, gen: 1 })).toMatchObject({ result: true })
      expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 300 })).toMatchObject({ result: { doc: 1 } })
      const c = fixture()
      openDoc.mockReturnValueOnce(c.native)
      expect(await call('open', { path: 'c.txt', count: 1, bytes: 300 })).toMatchObject({ result: { doc: 3 } })
      await call('deactivate', { doc: 1, gen: 1 }) // the single-card fixture commits C after detaching A
      delayed.end()
      expect(await reloading).toMatchObject({ result: { doc: 2, gen: 2, reserved: 0 } })
      expect(pendingFlag.cancel).not.toHaveBeenCalled()
      expect(b.index).toHaveBeenCalledOnce()
      expect([a.data.cacheActive, b.data.cacheActive, c.data.cacheActive]).toEqual([false, false, true])
      expect(b.close).not.toHaveBeenCalled()
    })

    it('finishes current metadata when a successful tab handoff suspends its previous active view', async () => {
      const { a, b } = await tabs()
      const delayed = holdCancellablePage(b)
      const reloading = dispatch({ id: 98, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const pendingFlag = flags.at(-1)!
      expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 300 })).toMatchObject({ result: { doc: 1 } })
      await call('deactivate', { doc: 2, gen: 1 }) // handoff alone no longer disposes a mounted source
      delayed.end()
      expect(await reloading).toMatchObject({ result: { doc: 2, gen: 2 } })
      expect(pendingFlag.cancel).not.toHaveBeenCalled()
      expect(b.index).toHaveBeenCalledOnce()
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([true, false])
      expect(b.close).not.toHaveBeenCalled()
    })

    it('still cancels a retained Reload first page when its document closes', async () => {
      const { b } = await tabs()
      holdCancellablePage(b)
      const reloading = dispatch({ id: 99, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const pendingFlag = flags.at(-1)!
      expect(await call('close', { doc: 2 })).toMatchObject({ result: true })
      expect(pendingFlag.cancel).toHaveBeenCalledOnce()
      expect(await reloading).toMatchObject({ error: { code: 'Cancelled' } })
      expect(b.index).not.toHaveBeenCalled()
      expect(b.close).toHaveBeenCalledOnce()
    })

    it('still cancels a retained Reload first page when another read freezes the document', async () => {
      const { b } = await tabs()
      holdCancellablePage(b)
      const reloading = dispatch({ id: 100, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const pendingFlag = flags.at(-1)!
      b.page.mockRejectedValueOnce(Object.assign(new Error('changed on disk'), { code: 'Frozen' }))
      expect(await call('page', { doc: 2, gen: 2, lens: 'raw', start: 9, count: 1 })).toMatchObject({ error: { code: 'Frozen' } })
      expect(pendingFlag.cancel).toHaveBeenCalledOnce()
      expect(await reloading).toMatchObject({ error: { code: 'Cancelled' } })
      expect(b.index).not.toHaveBeenCalled()
    })
  })

  describe('generation-scoped freeze cancellation', () => {
    it('keeps the winning Reload read when the superseded first page reports Frozen', async () => {
      const { b } = await tabs()
      const previous = holdPage(b)
      const current = holdCancellablePage(b)
      const first = dispatch({ id: 101, method: 'reload', params: { doc: 2, count: 1, bytes: 300 } })
      const second = dispatch({ id: 102, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const currentFlag = flags.at(-1)!
      expect(b.data.generation).toBe(3)
      previous.fail(Object.assign(new Error('frozen: reloaded'), { code: 'Frozen' }))
      expect(await first).toMatchObject({ error: { code: 'Frozen' } })
      current.end()
      expect(await second).toMatchObject({ result: { doc: 2, gen: 3 } })
      expect(currentFlag.cancel).not.toHaveBeenCalled()
      expect(b.index).toHaveBeenCalledOnce()
      expect(b.close).not.toHaveBeenCalled()
      expect(await call('reserve', { doc: 2, gen: 3, bytes: 250 })).toMatchObject({ result: true })
      expect(await call('reserve', { doc: 2, gen: 2, bytes: 250 })).toMatchObject({ result: false })
    })

    it('ignores an old index freeze while the next generation first page is still pending', async () => {
      const { b } = await tabs()
      expect(await call('reload', { doc: 2, count: 1, bytes: 300 })).toMatchObject({ result: { gen: 2 } })
      const onProgress = b.index.mock.calls.at(-1)![1]
      b.index.mockClear()
      const current = holdCancellablePage(b)
      const reloading = dispatch({ id: 103, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const currentFlag = flags.at(-1)!
      expect(b.data.generation).toBe(3)
      onProgress({ lines: 3, bytes: 0, done: false, elapsedMs: 0, error: 'frozen: reloaded' })
      current.end()
      expect(await reloading).toMatchObject({ result: { doc: 2, gen: 3 } })
      expect(currentFlag.cancel).not.toHaveBeenCalled()
      expect(b.index).toHaveBeenCalledOnce()
      expect(b.close).not.toHaveBeenCalled()
      expect(await call('reserve', { doc: 2, gen: 3, bytes: 250 })).toMatchObject({ result: true })
    })
  })

  describe('pending view disposal', () => {
    it('refuses an activation whose target was disposed even if its cancelled first page returns successfully', async () => {
      const { a, b, aJob, bJob } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const delayed = holdPage(a)
      const activating = dispatch({ id: 91, method: 'activate', params: { doc: 1, gen: 1, count: 1, bytes: 500 } })
      const pendingFlag = flags.at(-1)!
      expect(await call('deactivate', { doc: 1, gen: 1 })).toMatchObject({ result: true })
      expect(pendingFlag.cancel).toHaveBeenCalledOnce()
      delayed.end() // completion won the native cancellation race
      expect(await activating).toMatchObject({ error: { code: 'Stale' } })
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, true])
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(800), paid(300)])
      for (const spy of [a.index, b.index, a.close, b.close, aJob.cancel, bJob.cancel]) expect(spy).not.toHaveBeenCalled()
      expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: false })
      expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: true })
    })

    it('disposes the exact old settled generation during Reload so failure cannot restore its view share', async () => {
      const { a, b, bJob } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const delayed = holdPage(b)
      const reloading = dispatch({ id: 92, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      expect(b.data.generation).toBe(2)
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      delayed.fail(Object.assign(new Error('reloaded page failed'), { code: 'Io' }))
      expect(await reloading).toMatchObject({ error: { code: 'Io' } })
      expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: false })
      expect(leaving).toMatchObject({ result: true })
      expect(b.data.cacheActive).toBe(false)
      expect(b.cache).toHaveBeenCalledWith(2, false)
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(800), paid(600), paid(100)])
      for (const spy of [a.close, b.close, b.index, bJob.cancel]) expect(spy).not.toHaveBeenCalled()
    })

    it('retains a successful background Reload and its index without restoring a disposed view', async () => {
      const { a, b } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const delayed = holdPage(b)
      const reloading = dispatch({ id: 93, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      delayed.end()
      expect(await reloading).toMatchObject({ result: { doc: 2, gen: 2, reserved: 0 } })
      expect(leaving).toMatchObject({ result: true })
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, false])
      expect(b.index).toHaveBeenCalledOnce()
      expect(b.cache).not.toHaveBeenCalledWith(2, true)
      expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(800), paid(600), paid(100)])
      expect(await call('reserve', { doc: 2, gen: 2, bytes: 300 })).toMatchObject({ result: false })
      expect(await call('activate', { doc: 2, gen: 2, count: 1, bytes: 200 })).toMatchObject({ result: { doc: 2, gen: 2, reserved: 200 } })
      expect(b.index).toHaveBeenCalledOnce()
      expect(b.close).not.toHaveBeenCalled()
    })

    it('does not take a newer tab share when a disposed background Reload finishes after that tab activates', async () => {
      const { a, b } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      vi.clearAllMocks()
      const delayed = holdPage(b)
      const reloading = dispatch({ id: 94, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      const leaving = await call('deactivate', { doc: 2, gen: 1 })
      expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 300 })).toMatchObject({ result: { doc: 1 } })
      const beforeReply = reserveCache.mock.calls.length
      delayed.end()
      expect(await reloading).toMatchObject({ result: { doc: 2, gen: 2, reserved: 0 } })
      expect(leaving).toMatchObject({ result: true })
      expect(reserveCache).toHaveBeenCalledTimes(beforeReply + 1) // release only the finished Reload's pending 500
      expect([a.data.cacheActive, b.data.cacheActive]).toEqual([true, false])
      expect(await call('reserve', { doc: 1, gen: 1, bytes: 250 })).toMatchObject({ result: true })
      expect(reserveCache.mock.calls.at(-1)).toEqual([paid(350, 1, 2)])
      expect(b.index).toHaveBeenCalledOnce()
      expect(b.close).not.toHaveBeenCalled()
    })

    it('detaches an old generation lease without deactivating the newer settled generation', async () => {
      const { a, b } = await tabs()
      await call('reserveWorkspace', { bytes: 100 })
      expect(await call('reload', { doc: 2, count: 1, bytes: 500 })).toMatchObject({ result: { doc: 2, gen: 2 } })
      vi.clearAllMocks()
      expect(await call('deactivate', { doc: 2, gen: 1 })).toMatchObject({ result: true })
      for (const spy of [a.cache, b.cache, a.close, b.close]) expect(spy).not.toHaveBeenCalled()
      expect(reserveCache).toHaveBeenLastCalledWith(paid(600, 2))
      expect(b.data.cacheActive).toBe(true)
      expect(await call('reserve', { doc: 2, gen: 2, bytes: 300 })).toMatchObject({ result: true })
      expect(reserveCache.mock.calls.at(-1)).toEqual([paid(400, 2)])
    })

    it('does not deactivate the same target when a newer activation wins before its disposed activation answers', async () => {
      const { a } = await tabs()
      const delayed = holdPage(a)
      const first = dispatch({ id: 95, method: 'activate', params: { doc: 1, gen: 1, count: 1, bytes: 500 } })
      expect(await call('deactivate', { doc: 1, gen: 1 })).toMatchObject({ result: true })
      expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 300 })).toMatchObject({ result: { doc: 1 } })
      const [cacheCalls, reserveCalls] = [a.cache.mock.calls.length, reserveCache.mock.calls.length]
      delayed.end()
      expect(await first).toMatchObject({ error: { code: 'Stale' } })
      expect(a.data.cacheActive).toBe(true)
      expect(a.cache).toHaveBeenCalledTimes(cacheCalls)
      expect(reserveCache).toHaveBeenCalledTimes(reserveCalls + 1) // stale pending bytes unwind separately
      expect(await call('reserve', { doc: 1, gen: 1, bytes: 250 })).toMatchObject({ result: true })
    })

    it('retires only the exact activation owner after its response was committed', async () => {
      const surfaceReply = await call('createSurface', {})
      if (!('result' in surfaceReply)) throw new Error('surface was not created')
      const surface = surfaceReply.result
      const opened = await call('open', { surface, path: 'owned.txt', count: 1, bytes: 0 })
      if (!('result' in opened)) throw new Error('owned document was not opened')
      const docId = (opened.result as { doc: number }).doc
      const firstId = '00000000-0000-4000-8000-000000000001'
      const nextId = '00000000-0000-4000-8000-000000000002'
      const first = await call('activate', { surface, activationId: firstId, doc: docId, gen: 1, count: 1, bytes: 300 })
      if (!('result' in first)) throw new Error(`first activation did not receive a view: ${JSON.stringify(first)}`)
      const view = (first.result as { view?: Record<string, unknown> }).view
      if (!view) throw new Error(`first activation did not receive a view: ${JSON.stringify(first)}`)
      await call('deactivate', { view })
      await call('activate', { surface, activationId: nextId, doc: docId, gen: 1, count: 1, bytes: 300 })

      expect(await call('deactivateActivation', { surface, activationId: firstId })).toMatchObject({ result: false })
      expect(await call('deactivateActivation', { surface, activationId: nextId })).toMatchObject({ result: true })
    })

    it('does not deactivate a newer activation of the same generation when its disposed Reload answers', async () => {
      const { b } = await tabs()
      const delayed = holdPage(b)
      const reloading = dispatch({ id: 96, method: 'reload', params: { doc: 2, count: 1, bytes: 500 } })
      expect(await call('deactivate', { doc: 2, gen: 1 })).toMatchObject({ result: true })
      expect(await call('activate', { doc: 2, gen: 2, count: 1, bytes: 300 })).toMatchObject({ result: { doc: 2, gen: 2 } })
      const [cacheCalls, reserveCalls] = [b.cache.mock.calls.length, reserveCache.mock.calls.length]
      delayed.end()
      expect(await reloading).toMatchObject({ result: { doc: 2, gen: 2, reserved: 0 } })
      expect(b.data.cacheActive).toBe(true)
      expect(b.cache).toHaveBeenCalledTimes(cacheCalls)
      expect(reserveCache).toHaveBeenCalledTimes(reserveCalls + 1)
      expect(b.index).toHaveBeenCalledOnce()
      expect(await call('reserve', { doc: 2, gen: 2, bytes: 250 })).toMatchObject({ result: true })
    })
  })

  it('uses a retained first page and current metadata without reopening, reloading or restarting its index', async () => {
    const { a, b, aJob, bJob } = await tabs()
    expect(await call('activate', { doc: 1, gen: 1, count: 3, bytes: 500 })).toMatchObject({
      result: { doc: 1, gen: 1, reserved: 500, firstPage: { items: [{ next: { session: 7, doc: 1 } }] } }
    })
    expect(a.page).toHaveBeenCalledWith(1, 0, 3, expect.anything())
    await call('deactivate', { doc: 2, gen: 1 })
    for (const spy of [openDoc, a.index, b.index, a.reload, b.reload, a.close, b.close, aJob.cancel, bJob.cancel])
      expect(spy).not.toHaveBeenCalled()
    expect([a.data.cacheActive, b.data.cacheActive]).toEqual([true, false])
    expect(a.cache.mock.invocationCallOrder[0]).toBeLessThan(reserveCache.mock.invocationCallOrder[0]) // reclaim before pressure
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 900 })).toMatchObject({ result: false })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
  })

  it('validates a stale or absent tab before native cache calls or a reservation', async () => {
    const { a, b } = await tabs()
    expect(await call('activate', { doc: 1, gen: 2, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Stale' } })
    expect(await call('activate', { doc: 3, gen: 1, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'NoDocument' } })
    for (const spy of [a.page, b.page, a.cache, b.cache, reserveCache]) expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the active tab and its reservation when activation is refused up front', async () => {
    const { a, b } = await tabs()
    reserveCache.mockReturnValueOnce(false)
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(a.page).not.toHaveBeenCalled()
    expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, true])
    expect(b.cache).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: true })
    expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(700), paid(150)])
  })

  it('gives back a failed first-page reservation and never closes either retained tab', async () => {
    const { a, b } = await tabs()
    a.page.mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'Io' }))
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Io' } })
    expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, true])
    expect(a.close).not.toHaveBeenCalled()
    expect(b.close).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: true })
    expect(reserveCache.mock.calls.map(([bytes]) => bytes)).toEqual([paid(700), paid(200), paid(150)])
  })

  it('gives back a metadata refusal without indexing or losing the retained tab', async () => {
    const { a, b } = await tabs()
    Object.defineProperty(a.data, 'encoding', { configurable: true, get() { throw Object.assign(new Error('metadata memory'), { code: 'Memory' }) } })
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(a.close).not.toHaveBeenCalled()
    expect(a.index).not.toHaveBeenCalled()
    expect([a.data.cacheActive, b.data.cacheActive]).toEqual([false, true])
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: true })
  })

  it('cancels suspended viewport reads while keeping both index jobs', async () => {
    const { a, b, aJob, bJob } = await tabs()
    const previous = holdPage(b)
    const reading = dispatch({ id: 70, method: 'page', params: { doc: 2, gen: 1, lens: 'raw', start: 9, count: 1 } })
    const previousFlag = flags.at(-1)!
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 200 })).toMatchObject({ result: { doc: 1 } })
    await call('deactivate', { doc: 2, gen: 1 })
    expect(previousFlag.cancel).toHaveBeenCalledOnce()
    expect(aJob.cancel).not.toHaveBeenCalled()
    expect(bJob.cancel).not.toHaveBeenCalled()
    previous.fail(cancelled())
    expect(await reading).toMatchObject({ error: { code: 'Cancelled' } })
    expect(a.close).not.toHaveBeenCalled()
  })

  it('leaves active viewport reads running when a different tab fails activation', async () => {
    const { a, b, bJob } = await tabs()
    const previous = holdPage(b)
    const reading = dispatch({ id: 71, method: 'page', params: { doc: 2, gen: 1, lens: 'raw', start: 9, count: 1 } })
    const previousFlag = flags.at(-1)!
    a.page.mockRejectedValueOnce(Object.assign(new Error('page memory'), { code: 'Memory' }))
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(previousFlag.cancel).not.toHaveBeenCalled()
    expect(bJob.cancel).not.toHaveBeenCalled()
    previous.end()
    expect(await reading).toHaveProperty('result')
  })

  it('keeps the newest A selection when slow B answers after A to B to A', async () => {
    const { a, b } = await tabs()
    await call('activate', { doc: 1, gen: 1, count: 1, bytes: 200 })
    await call('deactivate', { doc: 2, gen: 1 })
    vi.clearAllMocks()
    const delayed = holdPage(b)
    const activating = dispatch({ id: 80, method: 'activate', params: { doc: 2, gen: 1, count: 1, bytes: 500 } })
    const delayedFlag = flags.at(-1)!
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 200 })).toMatchObject({ result: { doc: 1 } })
    delayed.end()
    expect(await activating).toMatchObject({ error: { code: 'Stale' } })
    expect(delayedFlag.cancel).toHaveBeenCalledOnce()
    expect([a.data.cacheActive, b.data.cacheActive]).toEqual([true, false])
    expect(a.close).not.toHaveBeenCalled()
    expect(b.close).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 150 })).toMatchObject({ result: true })
  })

  it('lets a slower fresh open register an inactive tab without taking the winning reservation', async () => {
    const { a } = await tabs()
    const c = fixture()
    const delayed = holdPage(c)
    openDoc.mockReturnValueOnce(c.native)
    const opening = dispatch({ id: 81, method: 'open', params: { path: 'c.txt', count: 1, bytes: 500 } })
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 200 })).toMatchObject({ result: { doc: 1 } })
    delayed.end()
    expect(await opening).toMatchObject({ result: { doc: 3 } })
    expect([a.data.cacheActive, c.data.cacheActive]).toEqual([true, false])
    expect(c.index).toHaveBeenCalledOnce()
    expect(c.close).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 3, gen: 1, bytes: 900 })).toMatchObject({ result: false })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 150 })).toMatchObject({ result: true })
  })

  for (const change of ['close', 'reload']) {
    it('refuses an activation overtaken by ' + change + ' without closing a retained tab itself', async () => {
      const { a, b } = await tabs()
      const delayed = holdPage(a)
      const activating = dispatch({ id: 82, method: 'activate', params: { doc: 1, gen: 1, count: 1, bytes: 500 } })
      expect(await call(change, change === 'close' ? { doc: 1 } : { doc: 1, count: 1, bytes: 200 })).toHaveProperty('result')
      delayed.end()
      expect(await activating).toMatchObject({ error: { code: 'Stale' } })
      expect(a.close).toHaveBeenCalledTimes(change === 'close' ? 1 : 0)
      expect(b.close).not.toHaveBeenCalled()
      if (change === 'reload') {
        expect(a.data.generation).toBe(2)
        expect(a.data.cacheActive).toBe(true)
        expect(await call('reserve', { doc: 1, gen: 2, bytes: 150 })).toMatchObject({ result: true })
      } else expect(await call('reserve', { doc: 2, gen: 1, bytes: 150 })).toMatchObject({ result: true })
    })
  }
})

describe("the renderer cache's reservation (plan C1)", () => {
  const reserved = () => reserveCache.mock.calls.map(([bytes]) => bytes)

  it('keeps workspace metadata paid when the active view closes, while Opened.reserved stays view-only', async () => {
    expect(await call('reserveWorkspace', { bytes: 200 })).toMatchObject({ result: true })
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 100 } })
    expect(await call('close', { doc: 2 })).toMatchObject({ result: true })
    expect(await call('reserveWorkspace', { bytes: 0 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(200), paid(300), paid(300, 2), paid(200, 2), paid(0, 2)])
  })

  it('updates the workspace share only after its combined reservation succeeds', async () => {
    expect(await call('reserveWorkspace', { bytes: 100 })).toMatchObject({ result: true })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 50 })).toMatchObject({ result: true })
    reserveCache.mockReturnValueOnce(false)
    expect(await call('reserveWorkspace', { bytes: 200 })).toMatchObject({ result: false })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 60 })).toMatchObject({ result: true })
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([100, 150, 250, 160, 100].map(bytes => paid(bytes)))
  })

  it('preserves the workspace share and retained documents after a failed new-tab open disposes its view', async () => {
    expect(await call('reserveWorkspace', { bytes: 100 })).toMatchObject({ result: true })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    expect(await call('deactivate', { doc: 1, gen: 1 })).toMatchObject({ result: true })
    openDoc.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'NotFound' }) })
    expect(await call('open', { path: 'gone.txt', count: 1, bytes: 500 })).toMatchObject({ error: { code: 'NotFound' } })
    expect(close).not.toHaveBeenCalled()
    expect(reserved()).toEqual([100, 400, 100, 600, 100].map(bytes => paid(bytes)))
    expect(await call('activate', { doc: 1, gen: 1, count: 1, bytes: 200 })).toMatchObject({ result: { doc: 1, reserved: 200 } })
    expect(reserved().at(-1)).toBe(paid(300))
  })

  it('refuses an unsafe combined sum without calling the native reservation or changing either share', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: Number.MAX_SAFE_INTEGER - paid(0) })).toMatchObject({ result: true })
    expect(await call('reserveWorkspace', { bytes: 1 })).toMatchObject({ result: false })
    expect(reserved()).toEqual([Number.MAX_SAFE_INTEGER])
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([Number.MAX_SAFE_INTEGER, paid(0)])
  })

  it('keeps the latest workspace share when an activation gives back its previous view reservation', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    expect(await call('reserveWorkspace', { bytes: 100 })).toMatchObject({ result: true })
    const first = pendingRead()
    const activating = dispatch({ id: 95, method: 'activate', params: { doc: 1, gen: 1, count: 1, bytes: 500 } })
    expect(await call('reserveWorkspace', { bytes: 200 })).toMatchObject({ result: true })
    first.fail(Object.assign(new Error('read failed'), { code: 'Io' }))
    expect(await activating).toMatchObject({ error: { code: 'Io' } })
    expect(reserved()).toEqual([300, 400, 900, 1000, 500].map(bytes => paid(bytes)))
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 250 })).toMatchObject({ result: true })
    expect(reserved().at(-1)).toBe(paid(450))
  })

  it("an open takes its view's cap up front; refused, the open is Memory and nothing changes", async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 500 })).toMatchObject({ result: true })
    reserveCache.mockReturnValueOnce(false)
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 900 })).toMatchObject({ error: { code: 'Memory' } })
    expect(openDoc).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 400 })).toMatchObject({ result: true }) // still document 1's lens's
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 100 } })
    expect(reserved()).toEqual([paid(500), paid(1400), paid(400), paid(500), paid(500, 2)])
  })

  it('pays source and Reload leases until detach or document close, with replies reporting only their own lease', async () => {
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 100 } })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 0 })).toMatchObject({ result: false }) // document 1's lens is going
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    expect(await call('reload', { doc: 2, count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 100 } })
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true }) // not the lens's document: nothing released
    expect(await call('close', { doc: 2 })).toMatchObject({ result: true })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: false })
    expect(reserved()).toEqual([paid(100), paid(100, 2), paid(300, 2), paid(400, 2), paid(400, 3), paid(400, 3), paid(0, 3)])
  })

  it('an open that fails after taking it releases it, unless a newer one has taken it since', async () => {
    openDoc.mockImplementationOnce(() => {
      throw Object.assign(new Error('io: not found'), { code: 'NotFound' })
    })
    expect(await call('open', { path: 'gone.txt', count: 1, bytes: 100 })).toMatchObject({ error: { code: 'NotFound' } })
    const read = pendingRead()
    const first = dispatch({ id: 80, method: 'open', params: { path: 'b.txt', count: 1, bytes: 200 } }) // its first page waits
    expect(await call('open', { path: 'c.txt', count: 1, bytes: 300 })).toMatchObject({ result: { doc: 2, reserved: 300 } })
    read.fail(Object.assign(new Error('frozen: changed while reading'), { code: 'Frozen' }))
    expect(await first).toMatchObject({ error: { code: 'Frozen' } })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: true }) // still document 2's lens's
    expect(reserved()).toEqual([paid(100), paid(0), paid(200), paid(500, 1, 2), paid(500, 2, 2), paid(300, 2, 2), paid(300, 2, 2)])
  })

  it("a Reload that fails gives it back to the lens it would have replaced, with that lens's bytes (Z34: Raw stays)", async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    reload.mockImplementationOnce(() => {
      throw Object.assign(new Error('the memory budget is full: 4523288 bytes asked, 12 free'), { code: 'Memory' })
    })
    expect(await call('reload', { doc: 1, count: 1, bytes: 500 })).toMatchObject({ error: { code: 'Memory' } })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true }) // document 1's lens's again
    reserveCache.mockReturnValueOnce(false) // refused up front: nothing changes
    expect(await call('reload', { doc: 1, count: 1, bytes: 900 })).toMatchObject({ error: { code: 'Memory' } })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 100 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([300, 800, 300, 200, 1100, 100].map(bytes => paid(bytes)))
  })

  it('a failed Reload of a document not on screen gives it back to the lens that is', async () => {
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 300 })).toMatchObject({ result: { doc: 2, reserved: 300 } })
    reload.mockImplementationOnce(() => {
      throw Object.assign(new Error('the memory budget is full: 4523288 bytes asked, 12 free'), { code: 'Memory' })
    })
    expect(await call('reload', { doc: 1, count: 1, bytes: 100 })).toMatchObject({ error: { code: 'Memory' } })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 200 })).toMatchObject({ result: true }) // document 2's lens's still
    expect(reserved()).toEqual([paid(300), paid(300, 2), paid(400, 2), paid(300, 2), paid(200, 2)])
  })

  /** Two Reloads of `id` whose first pages wait: the first ends Stale, then the second fails (`Frozen`, say). */
  async function overlapping(id: number): Promise<void> {
    const d = doc as unknown as { generation: number }
    reload.mockImplementation(() => void d.generation++)
    try {
      const [first, second] = [pendingRead(), pendingRead()]
      const r1 = dispatch({ id: 70, method: 'reload', params: { doc: id, count: 1, bytes: 100 } })
      const r2 = dispatch({ id: 71, method: 'reload', params: { doc: id, count: 1, bytes: 100 } })
      first.end({ items: [item()] })
      expect(await r1).toMatchObject({ id: 70, error: { code: 'Stale' } })
      second.fail(Object.assign(new Error('frozen: changed while reading'), { code: 'Frozen' }))
      expect(await r2).toMatchObject({ id: 71, error: { code: 'Frozen' } })
    } finally {
      d.generation = 1
      reload.mockImplementation(() => {})
    }
  }

  it("overlapping Reloads that end Stale, then failed, give it back to the document's lens, not to a finished request", async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    await overlapping(1)
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    expect(reserved()).toEqual([paid(300), paid(400), paid(500, 1, 2), paid(400, 1, 2), paid(300, 1, 2), paid(200, 1, 2), paid(0, 1, 2)])
  })

  it('…the same with a second document open, its read keeping theirs waiting (G1)', async () => {
    dispatch = makeDispatcher(addon, 7, () => {})
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 1 } }) // the second
    expect(await call('open', { path: 'a.txt', count: 1, bytes: 300 })).toMatchObject({ result: { doc: 2 } }) // the shown one
    const other = pendingRead()
    const reading = dispatch({ id: 60, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 9, count: 1 } })
    await overlapping(2)
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 200 })).toMatchObject({ result: true })
    expect(await call('close', { doc: 2 })).toMatchObject({ result: true })
    other.end({ items: [item()] })
    expect(await reading).toHaveProperty('result')
    expect(reserved()).toEqual([paid(0, 0), paid(0), paid(300), paid(300, 2), paid(400, 2), paid(500, 2, 2), paid(400, 2, 2), paid(300, 2, 2), paid(200, 2, 2), paid(0, 2, 2)])
  })

  it('a Reload whose document closed meanwhile releases it', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    const read = pendingRead()
    const reloading = dispatch({ id: 90, method: 'reload', params: { doc: 1, count: 1, bytes: 100 } }) // its first page waits
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    read.end({ items: [item()] })
    expect(await reloading).toMatchObject({ error: { code: 'Stale' } })
    expect(reserved()).toEqual([paid(300), paid(400), paid(100), paid(0)])
  })
})

/** A page read that runs until the test ends it, with `end` or `fail`. */
function pendingRead(): { end: (r: unknown) => void; fail: (e: unknown) => void } {
  const ends = {} as { end: (r: unknown) => void; fail: (e: unknown) => void }
  page.mockImplementationOnce(() => new Promise<Page>((ok, fail) => Object.assign(ends, { end: ok, fail })))
  return ends
}
const cancelled = () => Object.assign(new Error('cancelled'), { code: 'Cancelled' })

describe('cancels (plan C5, C6)', () => {
  it("cancel sets a running read's flag and says so; the read's Cancelled reaches the renderer", async () => {
    const read = pendingRead()
    const reply = dispatch({ id: 40, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 9, count: 1 } })
    const flag = flags.at(-1)!
    expect(await call('cancel', { id: 40 })).toMatchObject({ result: true })
    expect(flag.cancel).toHaveBeenCalledOnce()
    read.fail(cancelled())
    expect(await reply).toMatchObject({ id: 40, error: { code: 'Cancelled' } })
    expect(await call('cancel', { id: 40 })).toMatchObject({ result: false }) // ended: nothing to cancel
    expect(await call('cancel', { id: 41 })).toMatchObject({ result: false }) // never sent
  })

  it("close cancels the document's index job and its reads, closes it, and forgets it", async () => {
    const job = flags.length // an open makes its first page's flag, then its index job's
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2 } })
    const [ownJob, otherJob] = [flags[job + 1], flags[job - 1]] // doc 2's (after its first page's), and doc 1's
    void pendingRead()
    void dispatch({ id: 50, method: 'page', params: { doc: 2, lens: 'raw', gen: 1, start: 9, count: 1 } })
    const read = flags.at(-1)!
    vi.clearAllMocks()
    expect(await call('close', { doc: 2 })).toMatchObject({ result: true })
    expect([ownJob.cancel, read.cancel, close].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
    expect(otherJob?.cancel).not.toHaveBeenCalled()
    expect(await call('page', { doc: 2, lens: 'raw', gen: 1, start: 0, count: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
    expect(await call('close', { doc: 2 })).toMatchObject({ result: false })
  })

  it("a freeze, from a read or the index, cancels the document's other reads", async () => {
    const [frozen, other] = [pendingRead(), pendingRead()]
    void dispatch({ id: 60, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 9, count: 1 } })
    void dispatch({ id: 61, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 99, count: 1 } })
    const otherFlag = flags.at(-1)!
    frozen.fail(Object.assign(new Error('frozen: changed on disk'), { code: 'Frozen' }))
    await expect.poll(() => otherFlag.cancel.mock.calls.length).toBe(1)
    other.fail(cancelled())
    // The index: its error event, from the current job.
    const onProgress = (await reopen()).onProgress
    void pendingRead()
    void dispatch({ id: 62, method: 'page', params: { doc: 1, lens: 'raw', gen: 1, start: 9, count: 1 } })
    const next = flags.at(-1)!
    onProgress({ lines: 3, bytes: 0, done: false, elapsedMs: 0, error: 'frozen: changed on disk (chunk 2)' })
    expect(next.cancel).toHaveBeenCalledOnce()
  })

  it('a first page that fails closes the document it opened, which never gets an id', async () => {
    page.mockImplementationOnce(async () => {
      throw Object.assign(new Error('frozen: changed while reading'), { code: 'Frozen' })
    })
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 0 })).toMatchObject({ error: { code: 'Frozen' } })
    expect(close).toHaveBeenCalledOnce()
    expect(await call('open', { path: 'c.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 2 } })
  })
})

/** Reloads document 1 and returns its new index job's progress callback. */
async function reopen(): Promise<{ onProgress: (p: IndexProgress) => void }> {
  await call('reload', { doc: 1, count: 1, bytes: 0 })
  return { onProgress: startIndex.mock.calls.at(-1)![1] }
}

it('a Reload that another overtakes starts no index job, and close then cancels every job (plan C6)', async () => {
  const d = doc as unknown as { generation: number }
  reload.mockImplementation(() => void d.generation++)
  try {
    let release = () => {}
    page.mockImplementationOnce(() => new Promise<Page>((ok) => (release = () => ok({ items: [item()] } as unknown as Page))))
    const first = dispatch({ id: 70, method: 'reload', params: { doc: 1, count: 1, bytes: 0 } }) // generation 2; its first page waits
    expect(await call('reload', { doc: 1, count: 1, bytes: 0 })).toMatchObject({ result: { gen: 3 } })
    release() // the first page of generation 2 arrives after generation 3 began
    expect(await first).toMatchObject({ id: 70, error: { code: 'Stale' } })
    expect(startIndex).toHaveBeenCalledOnce() // generation 3's, alone
    const jobs = [flags[1], ...startIndex.mock.calls.map((c) => c[0] as unknown as (typeof flags)[number])] // open's, then generation 3's
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    expect(jobs.map((f) => f.cancel.mock.calls.length)).toEqual([1, 1])
  } finally {
    d.generation = 1
    reload.mockImplementation(() => {})
  }
})
