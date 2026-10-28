// Plan C4 at the core host: every numeric parameter against the hostile table, with a spy addon that must not be
// called (and no state change) when a request is refused. And plan C5 and C6's cancels, against the same spy.
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  reload,
  close,
  startIndex
} as unknown as Doc
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
const range = (field: string) => limits().ranges.find((r) => r.field === field)!

let dispatch: (data: unknown) => Promise<Response>
let nextId: number
const call = (method: string, params: Record<string, unknown>) => dispatch({ id: nextId++, method, params })
beforeEach(async () => {
  flags = []
  dispatch = makeDispatcher(addon, 7, () => {})
  nextId = 1
  expect(await call('open', { path: 'a.txt', count: 1, bytes: 0 })).toMatchObject({ result: { doc: 1 } }) // document 1 exists
  vi.clearAllMocks()
})

const token = { session: 7, doc: 1, gen: 1, line: 0, offset: 1 }

// Each method's numeric fields, with valid values for the others. `continuation.x` is a token's field.
const TABLE: [method: string, field: string, base: Record<string, unknown>][] = [
  ['hello', 'protocol', {}],
  ['open', 'count', { path: 'b.txt', bytes: 0 }],
  ['open', 'bytes', { path: 'b.txt', count: 1 }],
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
    const { min, max } = range(field.replace('continuation.', ''))
    for (const value of [...HOSTILE, min, max, max + 1]) {
      it(`${method}${base.lens === 'rendered' ? ' (rendered)' : ''}.${field} = ${String(value)}`, async () => {
        const response = await call(method, withValue(base, field, value))
        if (isValid(value, min, max)) {
          // In range: not refused for its range (a token of another document is still refused, as such).
          expect(response).not.toMatchObject({ error: { code: 'InvalidParams', field, message: expect.stringContaining('must be an integer') } })
          return
        }
        expect(response).toMatchObject({ id: nextId - 1, session: 7, error: { code: 'InvalidParams', field } })
        for (const spy of [openDoc, page, piece, render, mdPage, reload, close, startIndex, reserveCache]) expect(spy).not.toHaveBeenCalled()
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

describe("the renderer cache's reservation (plan C1)", () => {
  const reserved = () => reserveCache.mock.calls.map(([bytes]) => bytes)

  it("an open takes its view's cap up front; refused, the open is Memory and nothing changes", async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 500 })).toMatchObject({ result: true })
    reserveCache.mockReturnValueOnce(false)
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 900 })).toMatchObject({ error: { code: 'Memory' } })
    expect(openDoc).not.toHaveBeenCalled()
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 400 })).toMatchObject({ result: true }) // still document 1's lens's
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 400 } }) // the larger
    expect(reserved()).toEqual([500, 900, 400, 400])
  })

  it('is held for one lens: the replaced lens is refused, Reload keeps it for the next generation, close releases it', async () => {
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 100 } })
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 0 })).toMatchObject({ result: false }) // document 1's lens is going
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    expect(await call('reload', { doc: 2, count: 1, bytes: 100 })).toMatchObject({ result: { doc: 2, reserved: 300 } })
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true }) // not the lens's document: nothing released
    expect(await call('close', { doc: 2 })).toMatchObject({ result: true })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 300 })).toMatchObject({ result: false })
    expect(reserved()).toEqual([100, 300, 300, 0])
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
    expect(reserved()).toEqual([100, 0, 200, 300, 300])
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
    expect(reserved()).toEqual([300, 500, 300, 200, 900, 100])
  })

  it('a failed Reload of a document not on screen gives it back to the lens that is', async () => {
    expect(await call('open', { path: 'b.txt', count: 1, bytes: 300 })).toMatchObject({ result: { doc: 2, reserved: 300 } })
    reload.mockImplementationOnce(() => {
      throw Object.assign(new Error('the memory budget is full: 4523288 bytes asked, 12 free'), { code: 'Memory' })
    })
    expect(await call('reload', { doc: 1, count: 1, bytes: 100 })).toMatchObject({ error: { code: 'Memory' } })
    expect(await call('reserve', { doc: 2, gen: 1, bytes: 200 })).toMatchObject({ result: true }) // document 2's lens's still
    expect(reserved()).toEqual([300, 300, 200])
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
    expect(reserved()).toEqual([300, 300, 300, 200, 0])
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
    expect(reserved()).toEqual([0, 300, 300, 300, 200, 0])
  })

  it('a Reload whose document closed meanwhile releases it', async () => {
    expect(await call('reserve', { doc: 1, gen: 1, bytes: 300 })).toMatchObject({ result: true })
    const read = pendingRead()
    const reloading = dispatch({ id: 90, method: 'reload', params: { doc: 1, count: 1, bytes: 100 } }) // its first page waits
    expect(await call('close', { doc: 1 })).toMatchObject({ result: true })
    read.end({ items: [item()] })
    expect(await reloading).toMatchObject({ error: { code: 'Stale' } })
    expect(reserved()).toEqual([300, 300, 0])
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
