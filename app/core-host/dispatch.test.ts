// Plan C4 at the core host: every numeric parameter against the hostile table, with a spy addon that must not be
// called (and no state change) when a request is refused.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from 'typose-node'
import { limits } from 'typose-node'
import type { Response } from '../shared/protocol'
import { type Addon, makeDispatcher } from './dispatch'
import { HOSTILE, isValid } from './numbers'

// An item whose line goes on, so its token shows the session stamped on the way out.
const item = () => ({ gen: 1, line: 0, offset: 0, text: 'x', more: true, next: { gen: 1, line: 0, offset: 1 } })
const page = vi.fn(() => ({ items: [item()] }))
const piece = vi.fn(item)
const reload = vi.fn()
const startIndex = vi.fn()
const doc = { generation: 1, size: 3, encoding: 'UTF-8', lines: 0, indexed: false, blank: false, page, piece, reload, startIndex } as unknown as Doc
const openDoc = vi.fn(() => doc)
const addon: Addon = { coreVersion: () => '0.0.0', limits, openDoc }
const range = (field: string) => limits().ranges.find((r) => r.field === field)!

let dispatch: (data: unknown) => Response
let nextId: number
const call = (method: string, params: Record<string, unknown>) => dispatch({ id: nextId++, method, params })
beforeEach(() => {
  dispatch = makeDispatcher(addon, 7, () => {})
  nextId = 1
  expect(call('open', { path: 'a.txt', count: 1 })).toMatchObject({ result: { doc: 1 } }) // document 1 exists
  vi.clearAllMocks()
})

const token = { session: 7, doc: 1, gen: 1, line: 0, offset: 1 }

// Each method's numeric fields, with valid values for the others. `continuation.x` is a token's field.
const TABLE: [method: string, field: string, base: Record<string, unknown>][] = [
  ['hello', 'protocol', {}],
  ['open', 'count', { path: 'b.txt' }],
  ['page', 'doc', { lens: 'raw', gen: 1, start: 0, count: 1 }],
  ['page', 'gen', { doc: 1, lens: 'raw', start: 0, count: 1 }],
  ['page', 'start', { doc: 1, lens: 'raw', gen: 1, count: 1 }],
  ['page', 'count', { doc: 1, lens: 'raw', gen: 1, start: 0 }],
  ['page', 'continuation.session', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.doc', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.gen', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.line', { doc: 1, lens: 'raw', continuation: token }],
  ['page', 'continuation.offset', { doc: 1, lens: 'raw', continuation: token }],
  ['reload', 'doc', { count: 1 }],
  ['reload', 'count', { doc: 1 }],
  ['close', 'doc', {}]
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
    const { min, max } = range(field.replace('continuation.', ''))
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${method}.${field} = ${String(value)}`, () => {
        const response = call(method, withValue(base, field, value))
        if (isValid(value, min, max)) {
          // In range: not refused for its range (a token of another document is still refused, as such).
          expect(response).not.toMatchObject({ error: { code: 'InvalidParams', field, message: expect.stringContaining('must be an integer') } })
          return
        }
        expect(response).toMatchObject({ id: nextId - 1, session: 7, error: { code: 'InvalidParams', field } })
        for (const spy of [openDoc, page, piece, reload, startIndex]) expect(spy).not.toHaveBeenCalled()
        // No state change: document 1 is still open, and the next open is document 2.
        expect(call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 })).toHaveProperty('result')
        expect(call('open', { path: 'c.txt', count: 1 })).toMatchObject({ result: { doc: 2 } })
      })
    }
  }
})

describe('continuation tokens (plan C3)', () => {
  it('leave stamped with this session and their document, from a window and from a piece', () => {
    const stamped = { result: { items: [{ next: { session: 7, doc: 1 } }] } }
    expect(call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 })).toMatchObject(stamped)
    expect(call('page', { doc: 1, lens: 'raw', continuation: token })).toMatchObject(stamped)
    expect(piece).toHaveBeenCalledWith(1, 0, 1)
  })

  it("from another session are Stale, and the addon isn't asked", () => {
    expect(call('page', { doc: 1, lens: 'raw', continuation: { ...token, session: 6 } })).toMatchObject({ error: { code: 'Stale' } })
    expect(piece).not.toHaveBeenCalled()
  })

  it("from another document are refused, and the addon isn't asked (plan C7: tokens carry their doc)", () => {
    expect(call('open', { path: 'b.txt', count: 1 })).toMatchObject({ result: { doc: 2 } })
    vi.clearAllMocks()
    for (const [doc, tokenDoc] of [
      [2, 1],
      [1, 2]
    ])
      expect(call('page', { doc, lens: 'raw', continuation: { ...token, doc: tokenDoc } })).toMatchObject({
        error: { code: 'InvalidParams', field: 'continuation.doc' }
      })
    expect(piece).not.toHaveBeenCalled()
  })

  it('must be an object', () => {
    for (const continuation of [null, 7, 'token', [1, 2]])
      expect(call('page', { doc: 1, lens: 'raw', continuation })).toMatchObject({ error: { code: 'InvalidParams', field: 'continuation' } })
    expect(piece).not.toHaveBeenCalled()
  })
})

it('reload opens the next generation, starts its index and returns its first page', () => {
  expect(call('reload', { doc: 1, count: 5 })).toMatchObject({ result: { doc: 1, gen: 1, blank: false, firstPage: { items: [{ next: { session: 7 } }] } } })
  expect(reload).toHaveBeenCalledOnce()
  expect(page).toHaveBeenCalledWith(1, 0, 5)
  expect(startIndex).toHaveBeenCalledOnce()
  reload.mockImplementationOnce(() => {
    throw Object.assign(new Error('io: not found'), { code: 'NotFound' })
  })
  expect(call('reload', { doc: 1, count: 5 })).toMatchObject({ error: { code: 'NotFound' } })
  expect(call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 })).toHaveProperty('result') // still open
})

it('a request id is validated too, and the reply then carries id null', () => {
  const { min, max } = range('id')
  for (const id of [...HOSTILE, min, max, max + 1]) {
    const response = dispatch({ id, method: 'close', params: { doc: 9 } })
    if (isValid(id, min, max)) expect(response).toMatchObject({ id, result: false })
    else expect(response).toMatchObject({ id: null, error: { code: 'InvalidParams', field: 'id' } })
  }
})

it('methods resolve by own property only', () => {
  for (const method of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'nope', 42])
    expect(dispatch({ id: 1, method, params: {} })).toMatchObject({ error: { code: 'UnknownMethod' } })
  expect(openDoc).not.toHaveBeenCalled()
})

it('a lens other than raw, a bad path and an unknown document are typed errors', () => {
  expect(call('page', { doc: 1, lens: 'rows', start: 0, count: 1 })).toMatchObject({ error: { code: 'InvalidParams', field: 'lens' } })
  for (const path of ['', 'a\0b', 7, null, 'x'.repeat(32_768)])
    expect(call('open', { path, count: 1 })).toMatchObject({ error: { code: 'InvalidParams', field: 'path' } })
  expect(call('page', { doc: 9, lens: 'raw', gen: 1, start: 0, count: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
  expect(call('hello', { protocol: 2 })).toMatchObject({ error: { code: 'Unsupported' } })
  expect(openDoc).not.toHaveBeenCalled()
})

it('an addon error keeps its typed code, and anything else is Internal', () => {
  openDoc.mockImplementationOnce(() => {
    throw Object.assign(new Error('refused: a device path'), { code: 'Refused' })
  })
  expect(call('open', { path: '\\\\.\\NUL', count: 1 })).toMatchObject({ error: { code: 'Refused', message: 'refused: a device path' } })
  openDoc.mockImplementationOnce(() => {
    throw Object.assign(new Error('boom'), { code: 'GenericFailure' })
  })
  expect(call('open', { path: 'x', count: 1 })).toMatchObject({ error: { code: 'Internal' } })
})
