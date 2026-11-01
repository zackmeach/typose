import { afterEach, expect, it, vi } from 'vitest'
import { prepareStructured } from './structured-source'
import { LensBudget } from './lens-budget'
import { CoreCallError, type CoreClient } from '../core'
import type { Opened } from '../../shared/protocol'

class WorkerStub {
  static created = 0
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: unknown) => void
  stopped = false
  constructor() { WorkerStub.created++ }
  postMessage(message: { id: number; method: string }) { queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result: { root: { ordinal: 0, kind: 'object', span: { start: 0, end: 4 }, text: '', more: false, container: 1, children: 0 }, problems: [] } } })) }
  terminate() { this.stopped = true }
}
afterEach(() => { vi.unstubAllGlobals(); WorkerStub.created = 0 })
const opened = (size = 4): Opened => ({ doc: 1, gen: 1, format: 'yaml', size, encoding: 'utf-8', lines: 1, indexed: true, blank: false, firstPage: { items: [] }, reserved: 10, view: { session: 1, surface: 1, id: 1, doc: 1, gen: 1 } })
it('keeps Raw above the YAML byte ceiling without creating a worker or reading source', async () => {
  vi.stubGlobal('Worker', WorkerStub)
  const core = { call: vi.fn() } as unknown as CoreClient
  const source = await prepareStructured(core, opened((8 << 20) + 1), null, new AbortController().signal)
  expect(source.info.status).toBe('locked'); expect(source.info.reason).toContain('8 MiB'); expect(WorkerStub.created).toBe(0)
})
it('keeps Raw when the model floor is refused, before allocating parser input', async () => {
  vi.stubGlobal('Worker', WorkerStub)
  const budget = new LensBudget({ call: async () => false }, 1, 1, 1, 10, 10)
  const source = await prepareStructured({ call: vi.fn() } as unknown as CoreClient, opened(), budget, new AbortController().signal)
  expect(source.info.reason).toContain('memory budget'); expect(WorkerStub.created).toBe(0); expect(budget.snapshot().total).toBe(10)
})
it('adds the worker model and UI floors, then releases the worker floor on disposal', async () => {
  vi.stubGlobal('Worker', WorkerStub)
  const budget = new LensBudget({ call: async () => true }, 1, 1, 1, 10, 10)
  const core = { call: async (method: string) => method === 'sourceBytes' ? new TextEncoder().encode('a: 1') : true } as unknown as CoreClient
  const source = await prepareStructured(core, opened(), budget, new AbortController().signal)
  expect(source.info.status).toBe('ready')
  await budget.reserveGrid(1, 32 << 20)
  expect(budget.snapshot().total).toBe(10 + (64 << 20) + 4 * 128 + (32 << 20))
  source.dispose(); await budget.reserveRaw(1, 10)
  expect(budget.snapshot().total).toBe(10 + (32 << 20))
})
it('propagates a changed verified source as Frozen and releases the model reservation', async () => {
  vi.stubGlobal('Worker', WorkerStub)
  const budget = new LensBudget({ call: async () => true }, 1, 1, 1, 10, 10)
  const core = { call: async () => { throw new CoreCallError('Frozen', 'Changed on disk') } } as unknown as CoreClient
  await expect(prepareStructured(core, opened(), budget, new AbortController().signal)).rejects.toMatchObject({ code: 'Frozen' })
  expect(budget.snapshot().total).toBe(10)
})
