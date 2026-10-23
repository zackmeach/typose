// Plan C4 at the core host: every numeric parameter against the hostile table, with a spy addon that must not be
// called (and no state change) when a request is refused.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from 'typose-node'
import { limits } from 'typose-node'
import type { Response } from '../shared/protocol'
import { type Addon, makeDispatcher } from './dispatch'
import { HOSTILE, isValid } from './numbers'

const page = vi.fn(() => ({ items: [] }))
const startIndex = vi.fn()
const doc = { generation: 1, size: 3, encoding: 'UTF-8', lines: 0, indexed: false, page, startIndex } as unknown as Doc
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

// Each method's numeric fields, with valid values for the others.
const TABLE: [method: string, field: string, base: Record<string, unknown>][] = [
  ['hello', 'protocol', {}],
  ['open', 'count', { path: 'b.txt' }],
  ['page', 'doc', { lens: 'raw', start: 0, count: 1 }],
  ['page', 'start', { doc: 1, lens: 'raw', count: 1 }],
  ['page', 'count', { doc: 1, lens: 'raw', start: 0 }],
  ['close', 'doc', {}]
]

describe('every numeric parameter takes only integers in its range', () => {
  for (const [method, field, base] of TABLE) {
    const { min, max } = range(field)
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${method}.${field} = ${String(value)}`, () => {
        const params = value === undefined ? { ...base } : { ...base, [field]: value } // undefined: the field is missing
        const response = call(method, params)
        if (isValid(value, min, max)) {
          expect('error' in response && response.error.code === 'InvalidParams').toBe(false)
          return
        }
        expect(response).toMatchObject({ id: nextId - 1, session: 7, error: { code: 'InvalidParams', field } })
        expect(openDoc).not.toHaveBeenCalled()
        expect(page).not.toHaveBeenCalled()
        expect(startIndex).not.toHaveBeenCalled()
        // No state change: document 1 is still open, and the next open is document 2.
        expect(call('page', { doc: 1, lens: 'raw', start: 0, count: 1 })).toHaveProperty('result')
        expect(call('open', { path: 'c.txt', count: 1 })).toMatchObject({ result: { doc: 2 } })
      })
    }
  }
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
  expect(call('page', { doc: 9, lens: 'raw', start: 0, count: 1 })).toMatchObject({ error: { code: 'NoDocument' } })
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
