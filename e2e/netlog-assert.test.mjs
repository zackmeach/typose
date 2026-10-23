import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkNetLog, parseNetLog } from './netlog-assert.mjs'

const constants = {
  logEventTypes: { URL_REQUEST_START_JOB: 1, HOST_RESOLVER_MANAGER_JOB: 2, TCP_CONNECT: 3, SOCKET_ALIVE: 4 }
}
const allow = ['typose', 'data', 'blob']

test('app-scheme requests, end events and non-request events are clean', () => {
  const events = [
    { type: 1, phase: 1, params: { url: 'typose://app/index.html' } },
    { type: 1, phase: 2 },
    { type: 1, params: { url: 'data:image/png;base64,AAAA' } },
    { type: 4, params: {} }
  ]
  assert.deepEqual(checkNetLog({ constants, events }, allow), [])
})

test('outside requests, DNS and sockets are violations', () => {
  const events = [
    { type: 1, params: { url: 'https://example.com/x.png' } },
    { type: 2, params: { host: 'example.com' } },
    { type: 3, params: { address: '93.184.216.34:443' } }
  ]
  assert.equal(checkNetLog({ constants, events }, allow).length, 3)
})

test('proxy auto-detection, DNS transactions, connect attempts, QUIC and foreign blobs are violations', () => {
  const c = {
    logEventTypes: {
      WPAD_DHCP_WIN_FETCH: 1,
      PAC_FILE_DECIDER: 2,
      DNS_TRANSACTION: 3,
      TCP_CONNECT_ATTEMPT: 4,
      QUIC_SESSION: 5,
      URL_REQUEST_START_JOB: 6,
      QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS: 7
    }
  }
  const events = [1, 2, 3, 4, 5].map((type) => ({ type, params: {} }))
  events.push({ type: 6, params: { url: 'blob:https://evil.example/uuid' } })
  assert.equal(checkNetLog({ constants: c, events }, allow).length, 6)
  const clean = [
    { type: 6, params: { url: 'blob:typose://app/uuid' } },
    { type: 7, params: {} }
  ]
  assert.deepEqual(checkNetLog({ constants: c, events: clean }, allow), [])
})

test('a log cut off mid-write still parses', () => {
  const text = '{"constants":{"logEventTypes":{"TCP_CONNECT":3}},"events":[{"type":3,"params":{}},\n'
  const json = parseNetLog(text)
  assert.equal(json.events.length, 1)
})
