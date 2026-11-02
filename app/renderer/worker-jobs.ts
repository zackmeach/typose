/** What a worker posts once its imports and setup are done; only then does a job's watchdog start. */
export const WORKER_READY = 'ready'

/**
 * One job at a time on a lazily spawned worker. A job past `timeout` ms terminates the worker, so a runaway can't keep
 * its memory or the queue, and rejects; the next job spawns a fresh worker. A worker error rejects its job the same way.
 * Cold start (loading the worker and building its state) is not a job's time: it has its own `startup` bound.
 */
export function workerJobs<I, O>(spawn: () => Worker, timeout: number, startup = 15_000): (input: I) => Promise<O> {
  let starting: Promise<Worker> | undefined
  const ready = () => starting ??= new Promise<Worker>((resolve, reject) => {
    const w = spawn()
    const fail = (error: Error) => {
      clearTimeout(timer)
      w.onmessage = w.onerror = null
      w.terminate()
      starting = undefined
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error(`worker did not start within ${startup} ms`)), startup)
    w.onmessage = (event: MessageEvent) => { if (event.data === WORKER_READY) { clearTimeout(timer); w.onmessage = w.onerror = null; resolve(w) } }
    w.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'worker failed to start')) }
  })
  let tail: Promise<unknown> = Promise.resolve()
  const run = async (input: I) => {
    const w = await ready()
    return new Promise<O>((resolve, reject) => {
      const settle = (error?: Error) => {
        clearTimeout(timer)
        w.onmessage = w.onerror = w.onmessageerror = null
        if (!error) return
        w.terminate()
        starting = undefined // jobs run one at a time, so `starting` is this worker's
        reject(error)
      }
      const timer = setTimeout(() => settle(new Error(`stopped after ${timeout} ms`)), timeout)
      w.onmessage = (event: MessageEvent<O>) => { settle(); resolve(event.data) }
      w.onerror = event => { event.preventDefault(); settle(new Error(event.message || 'worker failed')) }
      w.onmessageerror = () => settle(new Error('worker reply unreadable'))
      w.postMessage(input)
    })
  }
  return input => {
    const job = tail.then(() => run(input))
    tail = job.catch(() => {})
    return job
  }
}
