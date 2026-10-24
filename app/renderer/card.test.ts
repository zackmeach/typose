// Brief §7.9 and §8.2: what each file state shows. The e2e tests render the states a fixture can trigger; this
// covers them all, the slow open and the memory refusal (plan §7 proposal 1, triggered from PR 6) included.
import { expect, it } from 'vitest'
import type { Opened } from '../shared/protocol'
import { type Card, view } from './card'

const PATH = 'C:\\logs\\run.jsonl'
const opened = (over: Partial<Opened> = {}): Opened => ({
  doc: 1,
  gen: 1,
  size: 1000,
  encoding: 'UTF-8',
  lines: 0,
  indexed: false,
  blank: false,
  firstPage: { items: [] },
  ...over
})
const open = (over: Partial<Extract<Card, { kind: 'open' }>> = {}): Card => ({
  kind: 'open',
  path: PATH,
  opened: opened(),
  lines: 1_234_567,
  bytes: 250,
  indexed: false,
  ...over
})
const failed = (code: Extract<Card, { kind: 'failed' }>['code'], message = ''): Card => ({ kind: 'failed', path: PATH, code, message })

it('shows each file state', () => {
  const rows: [state: string, card: Card, want: Partial<ReturnType<typeof view>>][] = [
    ['no file', { kind: 'empty' }, { body: { message: '', actions: ['Open file…'] } }],
    ['opening, before 300 ms', { kind: 'opening', path: PATH, slow: false }, { status: '', progress: null, body: { message: '', actions: [] } }],
    ['slow open', { kind: 'opening', path: PATH, slow: true }, { status: 'Opening…', progress: 'indeterminate', body: { message: '', actions: ['Close'] } }],
    ['indexing', open(), { status: 'Indexing 1.2M lines…', progress: 0.25, banner: null, body: { raw: true } }],
    ['indexed', open({ indexed: true }), { status: '1,234,567 lines · UTF-8', progress: null, banner: null }],
    ['one line, indexing', open({ lines: 1 }), { status: 'Indexing 1 line…' }],
    ['empty file', open({ opened: opened({ size: 0, blank: true }), lines: 0, indexed: true }), { body: { message: 'Empty file', actions: [] } }],
    ['changed on disk', open({ indexed: true, frozen: 'changed on disk' }), { banner: 'Changed on disk', body: { raw: true } }],
    ['changed on disk mid-index', open({ frozen: 'changed on disk (chunk 3)' }), { status: 'Indexing stopped at 1,234,567 lines', progress: null }],
    ['binary', failed('Binary', 'binary file'), { body: { message: 'Binary file · not shown', actions: [] } }],
    ['missing', failed('NotFound', 'io: not found'), { body: { message: `File not found at ${PATH}`, actions: ['Locate…', 'Close'] } }],
    [
      'permission denied',
      failed('PermissionDenied', 'io: access is denied'),
      { body: { message: `Can't read ${PATH} · permission denied`, actions: ['Retry', 'Close'] } }
    ],
    [
      'memory refused',
      failed('Memory', 'over budget'),
      { body: { message: "Can't open run.jsonl · Typose's memory budget is full. Close a file, then Retry.", actions: ['Retry', 'Close'] } }
    ],
    ['any other failure', failed('Refused', 'refused: a device path'), { body: { message: `Can't open ${PATH} · refused: a device path`, actions: ['Close'] } }],
    // Plan C7: Reopen once a new core is up; until then (60 s after a second death) the stopped state.
    ['core stopped', { kind: 'gone', path: PATH, line: 40, ready: false }, { body: { message: "Typose's core stopped", actions: [] } }],
    ['core stopped, a new one up', { kind: 'gone', path: PATH, line: 40, ready: true }, { body: { message: "Typose's core stopped", actions: ['Reopen'] } }],
    ['core stopped with no file, a new one up', { kind: 'gone', ready: true }, { body: { message: "Typose's core stopped", actions: ['Open file…'] } }]
  ]
  for (const [state, card, want] of rows) expect(view(card), state).toMatchObject(want)
})
