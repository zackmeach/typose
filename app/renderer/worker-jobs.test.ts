import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerJobs } from './worker-jobs'

/** A stand-in Worker that answers only when told to. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  posted: unknown[] = []
  postMessage(input: unknown) { this.posted.push(input) }
  terminate() { this.terminated = true }
  reply(data: unknown) { this.onmessage?.({ data }) }
}

afterEach(() => { vi.useRealTimers() })

describe('worker jobs', () => {
  it('runs one job at a time and reuses the worker', async () => {
    const workers: FakeWorker[] = []
    const run = workerJobs<number, number>(() => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker }, 1500)
    const first = run(1), second = run(2)
    await Promise.resolve()
    expect(workers[0].posted).toEqual([1])
    workers[0].reply(10)
    expect(await first).toBe(10)
    await Promise.resolve()
    expect(workers[0].posted).toEqual([1, 2])
    workers[0].reply(20)
    expect(await second).toBe(20)
    expect(workers).toHaveLength(1)
  })

  it('terminates a job past its timeout, rejects it, and spawns a fresh worker for the next', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const run = workerJobs<string, string>(() => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker }, 1500)
    const stuck = run('bomb'), next = run('ok')
    const failed = expect(stuck).rejects.toThrow('stopped after 1500 ms')
    await vi.advanceTimersByTimeAsync(1500)
    await failed
    expect(workers[0].terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(workers[1].posted).toEqual(['ok'])
    workers[1].reply('done')
    expect(await next).toBe('done')
  })

  it('rejects the job a worker error interrupts', async () => {
    const workers: FakeWorker[] = []
    const run = workerJobs<string, string>(() => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker }, 1500)
    const job = run('x')
    await Promise.resolve()
    workers[0].onerror?.({ message: 'Out of memory', preventDefault() {} })
    await expect(job).rejects.toThrow('Out of memory')
    expect(workers[0].terminated).toBe(true)
  })
})
