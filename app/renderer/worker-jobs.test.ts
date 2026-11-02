import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKER_READY, workerJobs } from './worker-jobs'

/** A stand-in Worker that is ready after `readyIn` ms (never, if null) and answers only when told to. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  posted: unknown[] = []
  constructor(readyIn: number | null) { if (readyIn !== null) setTimeout(() => this.reply(WORKER_READY), readyIn) }
  postMessage(input: unknown) { this.posted.push(input) }
  terminate() { this.terminated = true }
  reply(data: unknown) { this.onmessage?.({ data }) }
}

const pool = (readyIn: number | null = 0) => {
  const workers: FakeWorker[] = []
  return { workers, spawn: () => { const w = new FakeWorker(readyIn); workers.push(w); return w as unknown as Worker } }
}

afterEach(() => { vi.useRealTimers() })

describe('worker jobs', () => {
  it('runs one job at a time on one worker, once it is ready', async () => {
    vi.useFakeTimers()
    const { workers, spawn } = pool()
    const run = workerJobs<number, number>(spawn, 1500)
    const first = run(1), second = run(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(workers[0].posted).toEqual([1])
    workers[0].reply(10)
    expect(await first).toBe(10)
    await vi.advanceTimersByTimeAsync(0)
    expect(workers[0].posted).toEqual([1, 2])
    workers[0].reply(20)
    expect(await second).toBe(20)
    expect(workers).toHaveLength(1)
  })

  it('starts the watchdog only once the worker is ready, so cold start is not the job’s time', async () => {
    vi.useFakeTimers()
    const { workers, spawn } = pool(1400)
    const run = workerJobs<string, string>(spawn, 1500)
    const job = run('32 KB of TypeScript')
    await vi.advanceTimersByTimeAsync(1400)
    expect(workers[0].posted).toEqual(['32 KB of TypeScript'])
    await vi.advanceTimersByTimeAsync(1400) // 2.8 s after the call, 1.4 s into the job
    workers[0].reply('tokens')
    expect(await job).toBe('tokens')
    expect(workers[0].terminated).toBe(false)
  })

  it('terminates a job past its timeout, rejects it, and spawns a fresh worker for the next', async () => {
    vi.useFakeTimers()
    const { workers, spawn } = pool()
    const run = workerJobs<string, string>(spawn, 1500)
    const stuck = run('bomb'), next = run('ok')
    const failed = expect(stuck).rejects.toThrow('stopped after 1500 ms')
    await vi.advanceTimersByTimeAsync(1500)
    await failed
    expect(workers[0].terminated).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers).toHaveLength(2)
    expect(workers[1].posted).toEqual(['ok'])
    workers[1].reply('done')
    expect(await next).toBe('done')
  })

  it('bounds a start that never finishes, and retries the start for the next job', async () => {
    vi.useFakeTimers()
    const { workers, spawn } = pool(null)
    const run = workerJobs<string, string>(spawn, 1500, 15_000)
    const failed = expect(run('x')).rejects.toThrow('worker did not start within 15000 ms')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
    expect(workers[0].terminated).toBe(true)
    void run('y').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(2)
  })

  it('rejects the job a worker error interrupts', async () => {
    vi.useFakeTimers()
    const { workers, spawn } = pool()
    const run = workerJobs<string, string>(spawn, 1500)
    const job = run('x')
    await vi.advanceTimersByTimeAsync(0)
    workers[0].onerror?.({ message: 'Out of memory', preventDefault() {} })
    await expect(job).rejects.toThrow('Out of memory')
    expect(workers[0].terminated).toBe(true)
  })
})
