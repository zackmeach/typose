/** One lens has one copy selection epoch and one transient memory owner. */
export class SourceCopyQueue {
  private epoch = 0
  private tail = Promise.resolve()
  private active?: { controller: AbortController; token: string }
  constructor(private readonly cancelWrite: (token: string) => void) {}
  cancel(): void {
    this.epoch++
    if (this.active) { this.active.controller.abort(); this.cancelWrite(this.active.token); this.active = undefined }
  }
  run(operation: (current: () => boolean, signal: AbortSignal, token: string) => Promise<boolean>, release: () => Promise<void>): Promise<boolean> {
    this.cancel()
    const epoch = this.epoch, controller = new AbortController(), token = crypto.randomUUID()
    this.active = { controller, token }
    const current = () => epoch === this.epoch && !controller.signal.aborted
    const job = this.tail.then(async () => {
      if (!current()) return false
      try { return await operation(current, controller.signal, token) }
      finally { this.cancelWrite(token); await release(); if (this.active?.token === token) this.active = undefined }
    })
    this.tail = job.then(() => {}, () => {})
    return job
  }
}
