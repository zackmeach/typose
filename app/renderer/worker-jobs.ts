/**
 * One job at a time on a lazily spawned worker. A job past `timeout` ms terminates the worker, so a runaway can't keep
 * its memory or the queue, and rejects; the next job spawns a fresh worker. A worker error rejects its job the same way.
 */
export function workerJobs<I, O>(spawn: () => Worker, timeout: number): (input: I) => Promise<O> {
  let worker: Worker | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const run = (input: I) => new Promise<O>((resolve, reject) => {
    const w = worker ??= spawn()
    const settle = (error?: Error) => {
      clearTimeout(timer)
      w.onmessage = w.onerror = w.onmessageerror = null
      if (!error) return
      w.terminate()
      if (worker === w) worker = undefined
      reject(error)
    }
    const timer = setTimeout(() => settle(new Error(`stopped after ${timeout} ms`)), timeout)
    w.onmessage = (event: MessageEvent<O>) => { settle(); resolve(event.data) }
    w.onerror = event => { event.preventDefault(); settle(new Error(event.message || 'worker failed')) }
    w.onmessageerror = () => settle(new Error('worker reply unreadable'))
    w.postMessage(input)
  })
  return input => {
    const job = tail.then(() => run(input))
    tail = job.catch(() => {})
    return job
  }
}
