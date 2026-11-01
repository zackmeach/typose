import { expect, it } from 'vitest'
import { SourceCopyQueue } from './source-copy-queue'
import { copySourceSpan } from './source-copy'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
it('changing selection during a delayed source read retains the existing clipboard', async () => {
  const gate = deferred(), started = deferred(), queue = new SourceCopyQueue(() => {})
  let clipboard = 'prior clipboard', released = 0
  const copied = queue.run((current, signal) => copySourceSpan({ valid: current, reserve: async () => true,
    read: async () => { started.resolve(); await gate.promise; return new TextEncoder().encode('new') },
    verify: async () => true, confirm: async () => true, write: async text => { clipboard = text; return true }, cancelWrite() {}
  }, 0, 3, 'utf-8', signal), async () => { released++ })
  await started.promise; queue.cancel(); gate.resolve()
  expect(await copied).toBe(false); expect(clipboard).toBe('prior clipboard'); expect(released).toBe(1)
})
it('settles an old reservation release before a newer copy can reserve', async () => {
  const read = deferred(), started = deferred(), order: string[] = [], queue = new SourceCopyQueue(() => {})
  const first = queue.run(async current => { order.push('old reserve'); started.resolve(); await read.promise; return current() }, async () => { order.push('old release') })
  await started.promise
  const second = queue.run(async current => { order.push('new reserve'); return current() }, async () => { order.push('new release') })
  read.resolve(); expect(await first).toBe(false); expect(await second).toBe(true)
  expect(order).toEqual(['old reserve', 'old release', 'new reserve', 'new release'])
})
it('cancels an old clipboard token immediately while confirmation is pending', async () => {
  const confirmation = deferred(), started = deferred(), cancelled: string[] = []
  const queue = new SourceCopyQueue(token => cancelled.push(token)); let copied = false, oldToken = ''
  const job = queue.run(async (current, _signal, token) => { oldToken = token; started.resolve(); await confirmation.promise; if (current()) copied = true; return current() }, async () => {})
  await started.promise; queue.cancel()
  expect(cancelled).toContain(oldToken)
  confirmation.resolve(); expect(await job).toBe(false); expect(copied).toBe(false)
})
