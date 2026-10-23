// Plan C7's rejection path in the renderer: the port is taken only from this window, calls are matched by
// session, and when main reports the core gone every pending call, and every later one, fails with CoreGone.
import { afterEach, beforeEach, expect, it } from 'vitest'
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

it('rejects every pending call with CoreGone when the core goes, and every later call at once', async () => {
  const client = await connected()
  const pending = [client.call('page', { doc: 1, lens: 'raw', start: 0, count: 10 }), client.call('close', { doc: 1 })]
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
