import {
  PROTOCOL,
  type CoreError,
  type ErrorCode,
  type Hello,
  type MainMessage,
  type Method,
  type Methods,
  type ProgressEvent,
  type Response
} from '../shared/protocol'

export class CoreCallError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message)
  }
}

const isMainMessage = (data: unknown): data is MainMessage =>
  typeof data === 'object' && data !== null && ['core-port', 'core-gone'].includes((data as MainMessage).type) && Number.isSafeInteger((data as MainMessage).session)

/**
 * The renderer's end of protocol v1. One session at a time (plan C7): responses and events from any other session
 * are dropped, and when main reports the core gone, every pending call rejects with `CoreGone`.
 */
export class CoreClient {
  private port: MessagePort | null = null
  private session = 0
  private gone = false
  /** A session main reported gone before its port arrived. */
  private lost = 0
  private nextId = 1
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: CoreCallError) => void }>()
  private readonly progress = new Set<(e: ProgressEvent) => void>()
  private readonly goneListeners = new Set<() => void>()
  private hello: Promise<Hello> | null = null

  /** Waits for main's port, then shakes hands. */
  connect(): Promise<Hello> {
    this.hello ??= new Promise<MessagePort>((ok) => {
      window.addEventListener('message', (e: MessageEvent) => {
        // Only what the preload forwards: this window, this origin, a known shape (plan C7).
        if (e.source !== window || e.origin !== window.location.origin || !isMainMessage(e.data)) return
        if (e.data.type === 'core-port' && !this.port && e.ports.length === 1) {
          this.session = e.data.session
          this.port = e.ports[0]
          this.port.onmessage = (m) => this.receive(m.data)
          if (this.lost === this.session) this.coreGone() // it died before its port got here
          ok(this.port)
        } else if (e.data.type === 'core-gone') {
          if (e.data.session === this.session) this.coreGone()
          else if (!this.port) this.lost = e.data.session
        }
      })
    }).then(() => this.call('hello', { protocol: PROTOCOL }))
    return this.hello
  }

  call<M extends Method>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    return new Promise((ok, fail) => {
      if (this.gone || !this.port) return fail(new CoreCallError('CoreGone', "Typose's core stopped"))
      const id = this.nextId++
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail })
      this.port.postMessage({ id, method, params })
    })
  }

  onProgress(cb: (e: ProgressEvent) => void): () => void {
    this.progress.add(cb)
    return () => this.progress.delete(cb)
  }

  onGone(cb: () => void): () => void {
    this.goneListeners.add(cb)
    return () => this.goneListeners.delete(cb)
  }

  private receive(data: Response | ProgressEvent): void {
    if (data.session !== this.session || this.gone) return
    if ('event' in data) {
      for (const cb of this.progress) cb(data)
      return
    }
    if (data.id === null) return
    const call = this.pending.get(data.id)
    this.pending.delete(data.id)
    if (!call) return
    if ('error' in data) {
      const error: CoreError = data.error
      call.fail(new CoreCallError(error.code, error.message, error.field))
    } else {
      call.ok(data.result)
    }
  }

  private coreGone(): void {
    this.gone = true
    if (this.port) this.port.onmessage = null
    this.port?.close()
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const call of pending) call.fail(new CoreCallError('CoreGone', "Typose's core stopped"))
    for (const cb of this.goneListeners) cb()
  }
}
