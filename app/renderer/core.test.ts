// Plan C7's rejection path in the renderer: the port is taken only from this window, calls are matched by
// session, and when main reports the core gone every pending call, and every later one, fails with CoreGone.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CoreCallError, CoreClient } from './core'

const ORIGIN = 'typose://app'
let win: EventTarget & { location: { origin: string } }
let channel: MessageChannel
let requests: { id: number; method: string }[]

beforeEach(() => {
  win = Object.assign(new EventTarget(), { location: { origin: ORIGIN } })
  ;(globalThis as { window?: unknown }).window = win
  channel = new MessageChannel()
  requests = []
  // The core side: answers hello for session 3 and leaves everything else pending.
  channel.port2.onmessage = (e: MessageEvent) => {
    requests.push(e.data)
    if (e.data.method === 'hello') channel.port2.postMessage({ id: e.data.id, session: 3, result: { protocol: 1, session: 3 } })
  }
})
afterEach(() => {
  channel.port1.close()
  channel.port2.close()
  delete (globalThis as { window?: unknown }).window
})

/** What the preload posts: a message event from this window, at this origin. */
const post = (data: unknown, opts: { source?: unknown; origin?: string; ports?: MessagePort[] } = {}) =>
  win.dispatchEvent(Object.assign(new Event('message'), { data, source: win, origin: ORIGIN, ports: [], ...opts }))

async function connected(): Promise<CoreClient> {
  const client = new CoreClient()
  const hello = client.connect()
  post({ type: 'core-port', session: 3 }, { source: {}, ports: [channel.port1] }) // another window's: ignored
  post({ type: 'core-port', session: 3 }, { origin: 'https://evil.example', ports: [channel.port1] }) // another origin's: ignored
  post({ type: 'core-port', session: 3 }, { ports: [channel.port1] })
  await expect(hello).resolves.toMatchObject({ session: 3 })
  return client
}

function abortListeners(signal: AbortSignal): () => number {
  const added = vi.spyOn(signal, 'addEventListener')
  const removed = vi.spyOn(signal, 'removeEventListener')
  return () => {
    const active = new Set(added.mock.calls.filter(([type]) => type === 'abort').map(([, callback]) => callback))
    for (const [type, callback] of removed.mock.calls) if (type === 'abort') active.delete(callback)
    return active.size
  }
}

it('rejects every pending call with CoreGone when the core goes, and every later call at once', async () => {
  const client = await connected()
  const pending = [client.call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 10 }), client.call('close', { doc: 1 })]
  await expect.poll(() => requests.length).toBe(3)
  post({ type: 'core-gone', session: 2 }) // an older session's death changes nothing
  post({ type: 'core-gone', session: 3 })
  for (const p of pending) await expect(p).rejects.toMatchObject({ code: 'CoreGone' })
  await expect(client.call('close', { doc: 1 })).rejects.toBeInstanceOf(CoreCallError)
  expect(requests).toHaveLength(3) // nothing more was sent
})

it("drops a response from another session, and resolves its own session's", async () => {
  const client = await connected()
  let settled = false
  const call = client.call('close', { doc: 1 }).finally(() => (settled = true))
  await expect.poll(() => requests.length).toBe(2)
  const id = requests[1].id
  channel.port2.postMessage({ id, session: 2, result: 'stale' })
  await new Promise((r) => setTimeout(r, 50))
  expect(settled).toBe(false)
  channel.port2.postMessage({ id, session: 3, result: true })
  await expect(call).resolves.toBe(true)
})

it('a core that died before its port arrived fails the handshake with CoreGone', async () => {
  const client = new CoreClient()
  const hello = client.connect()
  post({ type: 'core-gone', session: 4 })
  post({ type: 'core-port', session: 4 }, { ports: [channel.port1] })
  await expect(hello).rejects.toMatchObject({ code: 'CoreGone' })
})

/** A core host for `session` on a channel of its own: it answers hello, records the rest, and can send anything. */
function coreFor(session: number) {
  const ch = new MessageChannel()
  const requests: { id: number; method: string; params: unknown }[] = []
  ch.port2.onmessage = (e: MessageEvent) => {
    requests.push(e.data)
    if (e.data.method === 'hello') ch.port2.postMessage({ id: e.data.id, session, result: { protocol: 1, session } })
  }
  return { port: ch.port1, requests, send: (data: unknown) => ch.port2.postMessage(data), close: () => (ch.port1.close(), ch.port2.close()) }
}

it('after a death, takes the next session from this window only, never an older one, and tells onReady (plan C7)', async () => {
  const client = await connected()
  const ready: number[] = []
  client.onReady((hello) => ready.push(hello.session))
  post({ type: 'core-gone', session: 3 })
  const [old, next, spoof] = [coreFor(2), coreFor(4), coreFor(5)]
  post({ type: 'core-port', session: 2 }, { ports: [old.port] }) // older than the dead one: refused
  post({ type: 'core-port', session: 5 }, { source: {}, ports: [spoof.port] }) // another window's: refused
  post({ type: 'core-port', session: 4 }, { ports: [next.port] })
  await expect.poll(() => ready).toEqual([4])
  expect([old.requests, spoof.requests]).toEqual([[], []])
  // The new session serves calls. An answer stamped with the dead session, to the same id, is dropped.
  const call = client.call('close', { doc: 1 })
  await expect.poll(() => next.requests.length).toBe(2)
  const id = next.requests[1].id
  const events: unknown[] = []
  client.onProgress((e) => events.push(e))
  next.send({ id, session: 3, result: 'from the dead session' })
  next.send({ event: 'progress', session: 3, doc: 1, gen: 1, lines: 9, bytes: 9, done: false })
  next.send({ id, session: 4, result: true })
  await expect(call).resolves.toBe(true)
  expect(events).toEqual([])
  for (const c of [old, next, spoof]) c.close()
})

it('aborting a pending call cancels it in the core; aborting after its answer sends nothing (plan C5)', async () => {
  const client = await connected()
  const abort = new AbortController()
  void client.call('page', { doc: 1, lens: 'raw', gen: 1, start: 0, count: 1 }, abort.signal).catch(() => {})
  await expect.poll(() => requests.length).toBe(2)
  abort.abort()
  await expect.poll(() => requests.at(-1)).toMatchObject({ method: 'cancel', params: { id: requests[1].id } })
  const answered = new AbortController()
  const done = client.call('close', { doc: 1 }, answered.signal)
  await expect.poll(() => requests.length).toBe(4)
  channel.port2.postMessage({ id: requests[3].id, session: 3, result: true })
  await expect(done).resolves.toBe(true)
  answered.abort()
  await new Promise((r) => setTimeout(r, 50))
  expect(requests).toHaveLength(4)
})

it("a newer session's port that comes before the old one's core-gone still fails the old session's calls (plan C7)", async () => {
  const client = await connected()
  const gone: number[] = []
  client.onGone(() => gone.push(1))
  const pending = client.call('close', { doc: 1 })
  await expect.poll(() => requests.length).toBe(2)
  const next = coreFor(4)
  post({ type: 'core-port', session: 4 }, { ports: [next.port] }) // core-gone for 3 is a separate IPC message
  await expect(pending).rejects.toMatchObject({ code: 'CoreGone' })
  expect(gone).toEqual([1])
  post({ type: 'core-gone', session: 3 }) // late: changes nothing
  void client.call('close', { doc: 1 }).catch(() => {}) // the new session serves calls
  await expect.poll(() => next.requests.map((r) => r.method)).toEqual(['hello', 'close'])
  expect(gone).toEqual([1])
  next.close()
})

it('releases shared abort listeners on successful and failed replies across many sequential reads', async () => {
  const client = await connected()
  const controller = new AbortController()
  const listeners = abortListeners(controller.signal)
  let count = 0
  channel.port2.onmessage = (event: MessageEvent) => {
    count++
    channel.port2.postMessage({ id: event.data.id, session: 3,
      ...(count % 2 ? { result: true } : { error: { code: 'Refused', message: 'fixture refusal' } }) })
  }
  for (let i = 0; i < 64; i++) {
    await client.call('close', { doc: 1 }, controller.signal).catch(() => {})
    expect(listeners()).toBe(0)
  }
  expect(count).toBe(64)
})

it('releases abort listeners when a session dies or posting the request fails', async () => {
  const client = await connected()
  const controller = new AbortController()
  const listeners = abortListeners(controller.signal)
  await expect(client.call('close', { doc: 1, uncloneable: () => {} }, controller.signal)).rejects.toMatchObject({ name: 'DataCloneError' })
  expect(listeners()).toBe(0)
  const pending = client.call('close', { doc: 1 }, controller.signal)
  expect(listeners()).toBe(1)
  post({ type: 'core-gone', session: 3 })
  await expect(pending).rejects.toMatchObject({ code: 'CoreGone' })
  expect(listeners()).toBe(0)
})

it('sends cancellation for an already-aborted request using the same port protocol', async () => {
  const client = await connected()
  const controller = new AbortController()
  const listeners = abortListeners(controller.signal)
  controller.abort()
  const pending = client.call('close', { doc: 1 }, controller.signal)
  await expect.poll(() => requests.map((r) => r.method)).toEqual(['hello', 'close', 'cancel'])
  channel.port2.postMessage({ id: requests[1].id, session: 3, error: { code: 'Cancelled', message: 'cancelled' } })
  await expect(pending).rejects.toMatchObject({ code: 'Cancelled' })
  expect(listeners()).toBe(0)
})
