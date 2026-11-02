import { expect, it, vi } from 'vitest'
import type { GridCopyPort } from './grid-copy'
import { GridCopyJob } from './grid-copy'
import { selectCell, selectColumn, selectRow } from './grid-interactions'

function port(rows: string[][], options: Partial<Pick<GridCopyPort, 'reserve' | 'confirm' | 'write' | 'valid'>> = {}) {
  const writes: string[] = [], charges: number[] = [], confirmations: number[] = []
  const makePort: GridCopyPort = {
    sourceRecord: async row => row + 1,
    cellChunks: async function* (record, column) { yield rows[record - 1]?.[column] ?? '' },
    reserve: async bytes => { charges.push(bytes); return true },
    confirm: async bytes => { confirmations.push(bytes); return true },
    write: async text => { writes.push(text); return true },
    valid: () => true,
    ...options
  }
  return { port: makePort, writes, charges, confirmations }
}

it('copies a cell range with complete values and TSV quoting after precharging', async () => {
  const long = 'n'.repeat(5000) + '\tcreek'
  const sink = port([['North', long]])
  const job = new GridCopyJob(sink.port, 1, 2, false)
  const result = await job.run({ kind: 'range', anchor: { row: 0, column: 0 }, focus: { row: 0, column: 1 } })
  expect(result).toMatchObject({ kind: 'copied' })
  expect(sink.writes).toEqual([`North\t"${long}"`])
  expect(sink.charges.length).toBeGreaterThan(0)
})

it('copies whole rows and includes the source header for whole-column selection', async () => {
  const rowSink = port([['2', 'South', 'first creek']])
  expect(await new GridCopyJob(rowSink.port, 1, 3, true).run(selectRow(0, 3))).toMatchObject({ kind: 'copied' })
  expect(rowSink.writes).toEqual(['2\tSouth\tfirst creek'])

  const columnSink = port([['North'], ['South'], ['West']])
  columnSink.port.cellChunks = async function* (record, column) { yield record === 0 ? 'task' : [['North'], ['South'], ['West']][record - 1]?.[column] ?? '' }
  expect(await new GridCopyJob(columnSink.port, 3, 1, true).run(selectColumn(0, 3))).toMatchObject({ kind: 'copied' })
  expect(columnSink.writes).toEqual(['task\r\nNorth\r\nSouth\r\nWest'])
})

it('confirms an exact size above 10 MiB, and cancellation prevents a partial clipboard write', async () => {
  const chunk = 'x'.repeat(4096)
  const sink = port([['']])
  sink.port.cellChunks = async function* () { for (let i = 0; i < 2561; i++) yield chunk }
  const job = new GridCopyJob(sink.port, 1, 1, false)
  expect(await job.run(selectCell({ row: 0, column: 0 }, 1, 1))).toMatchObject({ kind: 'copied', bytes: 10 * 1024 * 1024 + 4096 })
  expect(sink.confirmations).toEqual([10 * 1024 * 1024 + 4096])
  expect(sink.writes[0]).toHaveLength(10 * 1024 * 1024 + 4096)

  const pending = port([['safe']])
  let answer!: () => void
  pending.port.confirm = (_bytes, signal) => new Promise(resolve => {
    answer = () => resolve(!signal.aborted)
    signal.addEventListener('abort', () => resolve(false), { once: true })
  })
  pending.port.cellChunks = async function* () { yield 'x'.repeat(10 * 1024 * 1024 + 1) }
  const cancelled = new GridCopyJob(pending.port, 1, 1, false)
  const run = cancelled.run(selectCell({ row: 0, column: 0 }, 1, 1))
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
  cancelled.cancel()
  answer()
  expect(await run).toEqual({ kind: 'cancelled' })
  expect(pending.writes).toEqual([])
})

it('refuses over-cap payloads or a failed reservation without writing', async () => {
  const tooLarge = port([['']])
  tooLarge.port.cellChunks = async function* () { yield 'x'.repeat((16 << 20) + 1) }
  expect(await new GridCopyJob(tooLarge.port, 1, 1, false).run(selectCell({ row: 0, column: 0 }, 1, 1)))
    .toMatchObject({ kind: 'refused' })
  expect(tooLarge.writes).toEqual([])

  const denied = port([['cell']], { reserve: async () => false })
  expect(await new GridCopyJob(denied.port, 1, 1, false).run(selectCell({ row: 0, column: 0 }, 1, 1)))
    .toMatchObject({ kind: 'refused' })
  expect(denied.writes).toEqual([])
})

it('a stale selection or generation never writes after collecting values', async () => {
  const sink = port([['cell']])
  sink.port.valid = () => false
  expect(await new GridCopyJob(sink.port, 1, 1, false).run(selectCell({ row: 0, column: 0 }, 1, 1)))
    .toEqual({ kind: 'cancelled' })
  expect(sink.writes).toEqual([])
})
