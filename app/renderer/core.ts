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
 * The test-hooks build's view of the client (plan m8). Every message from session `holding`'s core host waits in
 * `held` until a test delivers it (plan C7's delayed old-session events). The rest is what the e2e tests read.
 */
export const testHooks = {
  holding: 0,
  held: [] as (() => void)[],
  /** The most page calls pending at once (plan C5: at most 2 per lens, and M1 has one lens). */
  maxPendingPages: 0,
  /** Cancels sent for calls still pending (plan C5). */
  aborts: 0,
  /** When the last core death was reported (wall clock, ms), and how many pending calls it rejected. */
  gone: null as { at: number; rejected: number } | null,
  /** What arrived from another session, or after its core's death, and was dropped: an event or a response. */
  dropped: [] as ('event' | 'response')[]
}

/**
 * The renderer's end of protocol v1. One session at a time (plan C7): responses and events from any other session
 * are dropped, and when main reports the core gone, every pending call rejects with `CoreGone`. A port is taken only
 * from this window, and only for a newer session than the last: main respawns the core as a new session.
 */
export class CoreClient {
  private port: MessagePort | null = null
  private session = 0
  private gone = false
  /** Sessions main reported gone before their port arrived. */
  private readonly lost = new Set<number>()
  private nextId = 1
  private readonly pending = new Map<number, { method: Method; ok: (v: unknown) => void; fail: (e: CoreCallError) => void }>()
  private readonly progress = new Set<(e: ProgressEvent) => void>()
  private readonly goneListeners = new Set<() => void>()
  private readonly readyListeners = new Set<(hello: Hello) => void>()
  private hello: Promise<Hello> | null = null
  /** `connect`'s promise, until the first session's handshake settles it. */
  private first: { ok: (h: Hello) => void; fail: (e: unknown) => void } | null = null

  /** Waits for main's first port, then shakes hands. Each later session shakes hands too, and tells `onReady`. */
  connect(): Promise<Hello> {
    this.hello ??= new Promise<Hello>((ok, fail) => {
      this.first = { ok, fail }
      window.addEventListener('message', (e: MessageEvent) => {
        // Only what the preload forwards: this window, this origin, a known shape (plan C7).
        if (e.source !== window || e.origin !== window.location.origin || !isMainMessage(e.data)) return
        const { type, session } = e.data
        if (type === 'core-port' && session > this.session && e.ports.length === 1) this.attach(session, e.ports[0])
        else if (type === 'core-gone' && session === this.session && !this.gone) this.coreGone()
        else if (type === 'core-gone' && session > this.session) this.lost.add(session) // its port isn't here yet
      })
    })
    return this.hello
  }

  /** Calls `method`. Aborting `signal` cancels the request in the core (plan C5); its promise then rejects with
   *  `Cancelled`, unless the result was already on its way. */
  call<M extends Method>(method: M, params: Methods[M]['params'], signal?: AbortSignal): Promise<Methods[M]['result']> {
    return new Promise((ok, fail) => {
      if (this.gone || !this.port) return fail(new CoreCallError('CoreGone', "Typose's core stopped"))
      const id = this.nextId++
      this.pending.set(id, { method, ok: ok as (v: unknown) => void, fail })
      this.port.postMessage({ id, method, params })
      if (__TEST_HOOKS__ && method === 'page') {
        const pages = [...this.pending.values()].filter((c) => c.method === 'page').length
        testHooks.maxPendingPages = Math.max(testHooks.maxPendingPages, pages)
      }
      const cancel = () => {
        if (!this.pending.has(id)) return // answered already, or its core is gone
        if (__TEST_HOOKS__) testHooks.aborts++
        void this.call('cancel', { id }).catch(() => {})
      }
      signal?.addEventListener('abort', cancel, { once: true })
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

  /** Called for each session that has shaken hands: the first, and every respawn after a core death (plan C7). */
  onReady(cb: (hello: Hello) => void): () => void {
    this.readyListeners.add(cb)
    return () => this.readyListeners.delete(cb)
  }

  private attach(session: number, port: MessagePort): void {
    if (this.port) this.port.onmessage = null // a dead session's: `coreGone` closed it
    this.session = session
    this.port = port
    this.gone = false
    port.onmessage = (m) => (__TEST_HOOKS__ && testHooks.holding === session ? testHooks.held.push(() => this.receive(m.data)) : this.receive(m.data))
    if (this.lost.has(session)) this.coreGone() // it died before its port got here
    const shaken = this.handshake()
    if (this.first) shaken.then(this.first.ok, this.first.fail)
    else shaken.catch(() => {}) // a respawn's: `onReady` hears of it
    this.first = null
  }

  private async handshake(): Promise<Hello> {
    const hello = await this.call('hello', { protocol: PROTOCOL })
    for (const cb of this.readyListeners) cb(hello)
    return hello
  }

  private receive(data: Response | ProgressEvent): void {
    if (data.session !== this.session || this.gone) {
      if (__TEST_HOOKS__) testHooks.dropped.push('event' in data ? 'event' : 'response')
      return
    }
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
    if (__TEST_HOOKS__) testHooks.gone = { at: Date.now(), rejected: pending.length }
    for (const call of pending) call.fail(new CoreCallError('CoreGone', "Typose's core stopped"))
    for (const cb of this.goneListeners) cb()
  }
}
