// The test-hooks addon (plan m8) at the napi layer: its debug stats count what a document holds (plan C6), its
// per-read delay shows a cancelled read stopping within the chunk read it's in (plan C5), and its budget override shows
// the ledger refusing an open it can't hold (plan C1). Run by `npm run test:hooks`, after `npm run build:addon:hooks`;
// the release addon has none of this.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import type * as Core from 'typose-node'
import type { Charges, DebugStats } from '../shared/protocol'

interface Hooks {
  debugStats(): Pick<DebugStats, 'jobs' | 'tasks' | 'handles' | 'delayMs' | 'ledger'>
  setReadDelay(ms: number): void
  setLimit(bytes: number): void
  docCharges(doc: Core.Doc): Charges
}
const core = createRequire(import.meta.url)('typose-node/hooks') as typeof Core & Hooks
/** The debug stats' counts of what's alive. */
const alive = () => (({ jobs, tasks, handles }) => ({ jobs, tasks, handles }))(core.debugStats())
const dir = mkdtempSync(join(tmpdir(), 'typose-hooks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => core.setReadDelay(0))
core.setBudget(totalmem()) // plan C1: as the core host does, before anything opens

const indexed = (doc: Core.Doc) =>
  new Promise<number>((ok, fail) => doc.startIndex(new core.Cancel(), (p) => (p.error ? fail(new Error(p.error)) : p.done && ok(p.lines))))
/** How a read ended: 'resolved', or its rejection's code. */
const ending = (read: Promise<unknown>) => read.then(
  () => 'resolved',
  (e: { code?: string }) => e.code
)

it('debug stats: a document holds a handle, its index a job, a read a task; once they end and it closes, none is left', async () => {
  const path = join(dir, 'stats.txt')
  writeFileSync(path, 'a\nb\n'.repeat(1000))
  expect(alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
  const doc = core.Doc.open(path)
  expect(alive()).toEqual({ jobs: 0, tasks: 0, handles: 1 })
  const done = indexed(doc)
  expect(core.debugStats().jobs).toBe(1)
  await done
  await expect.poll(() => core.debugStats().jobs).toBe(0) // its thread ends just after the last event
  const read = doc.page(1, 0, 10, new core.Cancel())
  expect(core.debugStats().tasks).toBe(1)
  await read
  await expect.poll(() => core.debugStats().tasks).toBe(0)
  doc.close()
  expect(alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
})

it.skipIf(process.platform !== 'win32')('local routes share one persistent root, survive source close, and release every handle/reservation', async () => {
  const sourcePath = join(dir, 'local-source.md')
  const childPath = join(dir, 'local-child.md')
  const textPath = join(dir, 'local-final.txt')
  writeFileSync(sourcePath, '# Source\n')
  writeFileSync(childPath, '# Child\n')
  writeFileSync(textPath, 'final\n')
  const baseline = core.debugStats()
  const source = core.Doc.open(sourcePath)
  let child: Core.Doc | undefined
  let text: Core.Doc | undefined
  try {
    expect(core.debugStats().handles).toBe(baseline.handles + 2) // source store + one held root
    await source.render(1, new core.Cancel())
    child = source.openLocal(1, 'local-child.md')
    expect(core.debugStats().handles).toBe(baseline.handles + 3) // root shared, one more store
    source.close()
    expect(core.debugStats().handles).toBe(baseline.handles + 2)
    await child.render(1, new core.Cancel())
    text = child.openLocal(1, 'local-final.txt')
    child.close()
    expect(core.debugStats().handles).toBe(baseline.handles + 2)
    text.reload()
    expect(text.localOnly).toBe(true)
    expect(core.debugStats().handles).toBe(baseline.handles + 2)
  } finally {
    text?.close()
    child?.close()
    source.close()
  }
  await expect.poll(() => core.debugStats().tasks).toBe(baseline.tasks)
  expect(core.debugStats().handles).toBe(baseline.handles)
  expect(core.debugStats().ledger.used).toBe(baseline.ledger.used)
})

it.skipIf(process.platform !== 'win32')('a refused local open/path reservation releases everything and leaves its source usable', async () => {
  const sourcePath = join(dir, 'local-budget.md')
  const targetPath = join(dir, 'local-budget.txt')
  writeFileSync(sourcePath, '# Source\n')
  writeFileSync(targetPath, 'target\n')
  const source = core.Doc.open(sourcePath)
  await source.render(1, new core.Cancel())
  await expect.poll(() => core.debugStats().tasks).toBe(0)
  const { used, limit } = core.debugStats().ledger
  const handles = core.debugStats().handles
  try {
    core.setLimit(used)
    expect(() => source.localPath(1, 'local-budget.txt')).toThrow(expect.objectContaining({ code: 'Memory' }))
    expect(() => source.openLocal(1, 'local-budget.txt')).toThrow(expect.objectContaining({ code: 'Memory' }))
    expect(core.debugStats().ledger.used).toBe(used)
    expect(core.debugStats().handles).toBe(handles)
  } finally {
    core.setLimit(limit)
  }
  try {
    const target = source.openLocal(1, 'local-budget.txt')
    expect(target.localOnly).toBe(true)
    target.close()
  } finally {
    source.close()
  }
})

it("plan C1: the ledger refuses an open it can't hold with Memory, and nothing stays charged; close returns it all", () => {
  // Four files of 4 MiB + 1 byte: each one's floor holds a 4-chunk cache (plus its hashes, checkpoints and metadata).
  const paths = [0, 1, 2, 3].map((i) => join(dir, `floor-${i}.txt`))
  for (const path of paths) writeFileSync(path, 'a line\n'.repeat(599_187).padEnd((4 << 20) + 1, 'x'))
  const { used: base, limit } = core.debugStats().ledger
  const probe = core.Doc.open(paths[0])
  const floor = core.docCharges(probe).total
  probe.close()
  expect(core.debugStats().ledger.used).toBe(base)
  expect(floor).toBeGreaterThan(4 << 20)
  const { openTemp } = core.limits()
  try {
    core.setLimit(base + 3 * floor + openTemp) // three documents' floors, and one open's temporaries on top
    const docs = paths.slice(0, 3).map((path) => core.Doc.open(path))
    expect(core.debugStats().ledger.used).toBe(base + 3 * floor)
    expect(() => core.Doc.open(paths[3])).toThrow(expect.objectContaining({ code: 'Memory' }))
    expect(core.debugStats().ledger.used).toBe(base + 3 * floor) // the refused open changed nothing
    for (const doc of docs) doc.close()
    expect(core.debugStats().ledger.used).toBe(base) // close returns every reservation (plan C6)
    const last = core.Doc.open(paths[3])
    expect(last.generation).toBe(1) // and the room is there again
    last.close() // not left for GC to release, which would move the ledger under the tests after this one
  } finally {
    core.setLimit(limit)
  }
})

// Plan (Rendered Markdown slice) §2.1: Markdown of many kinds of block, `blocks` times over.
const markdown = (blocks: number) =>
  Array.from({ length: blocks }, (_, i) => `# Heading ${i}\n\nSome *prose* with [a link](x.md) and \`code\`.\n\n- a\n- [ ] b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<b>raw</b> <script>no</script>\n\n`).join('')

it('plan C1, C6: a Markdown build stays charged until close; a tight budget refuses it with Memory, charging nothing', async () => {
  const path = join(dir, 'build.md')
  writeFileSync(path, markdown(2_000))
  const { used: base, limit } = core.debugStats().ledger
  const doc = core.Doc.open(path)
  try {
    const opened = core.debugStats().ledger.used
    try {
      core.setLimit(opened + (8 << 20)) // room for the read, not the parse
      expect(await ending(doc.render(1, new core.Cancel()))).toBe('Memory')
      expect(core.debugStats().ledger.used).toBe(opened)
    } finally {
      core.setLimit(limit)
    }
    const built = await doc.render(1, new core.Cancel())
    expect(built.blocks).toBe(10_000)
    const kept = core.debugStats().ledger.used - opened
    expect(kept).toBeGreaterThan(built.htmlBytes) // the items, as charged
    expect((await doc.render(1, new core.Cancel())).blocks).toBe(10_000)
    expect(core.debugStats().ledger.used - opened).toBe(kept) // a new build replaces the last
  } finally {
    doc.close()
  }
  expect(core.debugStats().ledger.used).toBe(base)
  await expect.poll(() => alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
})

it('plan §2.1, C6: closing mid-build ends the build, in its read or its parse, and releases everything', async () => {
  const path = join(dir, 'cancel.md')
  writeFileSync(path, markdown(30_000)) // about 4 MiB
  const { used: base } = core.debugStats().ledger
  for (const delay of [100, 0]) {
    const doc = core.Doc.open(path)
    core.setReadDelay(delay) // 100 ms a chunk: the cancel lands in the read; without, in the parse
    const cancel = new core.Cancel()
    const built = ending(doc.render(1, cancel))
    await new Promise((ok) => setTimeout(ok, 150))
    const cancelled = performance.now()
    cancel.cancel() // the core host's close: cancel, then close
    doc.close()
    expect(await built).toBe('Cancelled')
    console.log(`a build cancelled after 150 ms (read delay ${delay} ms) ended ${(performance.now() - cancelled).toFixed(0)} ms later`)
    core.setReadDelay(0)
    await expect.poll(() => alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
    expect(core.debugStats().ledger.used).toBe(base)
  }
})

it('the read delay takes only whole ms in [0, 10000] (plan C4)', () => {
  for (const ms of [NaN, Infinity, -1, 0.5, 10_001, 2 ** 32, 1e12])
    expect(() => core.setReadDelay(ms), String(ms)).toThrow(expect.objectContaining({ code: 'InvalidParams' }))
  for (const ms of [0, 10_000]) core.setReadDelay(ms)
})

it('plan C5: a cancelled read stops within the chunk read under way, and reads no other', async () => {
  const DELAY = 200
  // Six lines of 1 MiB + 100 bytes: each line of a page ends in the next chunk, so a page of four reads four new
  // chunks (the first one is read at open, before the delay is set).
  const path = join(dir, 'long.txt')
  writeFileSync(path, Array.from({ length: 6 }, (_, i) => String(i).repeat((1 << 20) + 100)).join('\n'))
  const read = async (cancelAfter?: number) => {
    const doc = core.Doc.open(path)
    await indexed(doc)
    core.setReadDelay(DELAY)
    const cancel = new core.Cancel()
    const start = performance.now()
    const ended = ending(doc.page(1, 0, 4, cancel))
    let cancelled = NaN
    if (cancelAfter !== undefined) {
      await new Promise((ok) => setTimeout(ok, cancelAfter))
      cancelled = performance.now()
      cancel.cancel()
    }
    const code = await ended
    const end = performance.now()
    const { delayMs } = core.debugStats() // this read's own slowest: setReadDelay, above and just below, starts it over
    core.setReadDelay(0)
    doc.close()
    return { code, total: end - start, afterCancel: end - cancelled, delayMs }
  }
  const whole = await read()
  expect(whole.code).toBe('resolved')
  expect(whole.total).toBeGreaterThanOrEqual(4 * DELAY - 20) // four chunk reads (Windows' timers run a little early)
  // The stats keep the slowest single delay: at least the one asked for, and less than the page's four.
  expect(whole.delayMs).toBeGreaterThanOrEqual(DELAY - 20)
  expect(whole.delayMs).toBeLessThan(whole.total)
  const cut = await read(1.5 * DELAY) // during the second
  console.log(`a page of four chunk reads: ${whole.total.toFixed(0)} ms; cancelled during the second, it ended ${cut.afterCancel.toFixed(0)} ms later (its slowest delay ${cut.delayMs.toFixed(0)} ms)`)
  expect(cut.code).toBe('Cancelled')
  // The rest of the read under way, and no other: under one of its delays, as long as its slowest took here, plus the
  // e2e test's 50 ms for the read, hash and resolve after the sleep. On the macOS runner four 200 ms delays took
  // 903-1086 ms, and in run 40072658390 this came 197 ms after the cancel (plan §7).
  expect(cut.afterCancel).toBeLessThan(cut.delayMs + 50)
})

// M5 PR 1: a Claude Code session of `pairs` questions, each answered with a tool call.
const session = (pairs: number) => Array.from({ length: pairs }, (_, i) =>
  JSON.stringify({ type: 'user', uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, message: { role: 'user', content: `question ${i}` } }) + '\n' +
  JSON.stringify({ type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: { path: 'x' } }] } }) + '\n').join('')
const structuredDone = async (doc: Core.Doc) => {
  let info = await doc.structuredBuild(doc.generation, new core.Cancel())
  while (!info.done) info = await doc.structuredBuild(doc.generation, new core.Cancel())
  return info
}
/** A document's charges past Raw's own: its structured index's. */
const structuredBytes = (doc: Core.Doc) => (({ total, hashes, checkpoints, cache, metadata }) => total - hashes - checkpoints - cache - metadata)(core.docCharges(doc))

it('M5 PR 1: a transcript graph stays charged until close, at its structs\' size, and close releases it', async () => {
  const path = join(dir, 'transcript.jsonl'), plain = join(dir, 'transcript-generic.jsonl')
  writeFileSync(path, session(20_000))
  writeFileSync(plain, session(20_000).replaceAll('"type":', '"kind":')) // the same records, with no schema to detect
  const { used: base } = core.debugStats().ledger
  const docs = [core.Doc.open(path), core.Doc.open(plain)]
  try {
    const [info, generic] = [await structuredDone(docs[0]!), await structuredDone(docs[1]!)]
    expect(info.transcript).toMatchObject({ ready: true, messages: 40_000, calls: 20_000, matchedResults: 0 })
    expect(generic.transcript).toBeUndefined()
    const graph = structuredBytes(docs[0]!) - structuredBytes(docs[1]!)
    console.log(`a 40,000-record session's transcript graph: ${graph} bytes, ${(graph / 40_000).toFixed(0)} a record`)
    // At least each record's 200-byte entry (pinned in transcript.rs), and far below the parked graph's guess of 8 KB.
    expect(graph).toBeGreaterThan(40_000 * 200)
    expect(graph).toBeLessThan(40_000 * 1024)
  } finally {
    for (const doc of docs) doc.close()
  }
  await expect.poll(() => alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
  expect(core.debugStats().ledger.used).toBe(base)
})

it('M5 PR 1: closing a session mid-index ends its graph and releases it', async () => {
  const path = join(dir, 'transcript-close.jsonl')
  writeFileSync(path, session(50_000)) // about 12 MiB: 12 chunk reads
  const { used: base } = core.debugStats().ledger
  const doc = core.Doc.open(path)
  core.setReadDelay(50)
  expect((await doc.structuredBuild(doc.generation, new core.Cancel())).done).toBe(false)
  await expect.poll(() => structuredBytes(doc), { timeout: 5_000 }).toBeGreaterThan(1 << 20) // the graph is growing
  expect((await doc.structuredBuild(doc.generation, new core.Cancel())).done).toBe(false)
  doc.close()
  core.setReadDelay(0)
  await expect.poll(() => alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
  expect(core.debugStats().ledger.used).toBe(base)
})

it('M5 PR 1: an index the budget stops releases its half-built graph, and Page says why', async () => {
  const path = join(dir, 'transcript-stopped.jsonl')
  // 40,000 messages the graph takes in, then a record of 3 million arrays the budget can't scan.
  const message = (i: number) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', uuid: `u${i}`, parentUuid: i ? `u${i - 1}` : null, message: { role: i % 2 ? 'assistant' : 'user', content: 'x' } })
  writeFileSync(path, Array.from({ length: 40_000 }, (_, i) => message(i) + '\n').join('') + `[${Array(3_000_000).fill('[]').join(',')}]\n`)
  const { used: base } = core.debugStats().ledger
  const doc = core.Doc.open(path)
  try {
    await indexed(doc)
    const { used, limit } = core.debugStats().ledger
    try {
      core.setLimit(used + (52 << 20)) // the index's temporaries and the graph, not the scan
      await doc.structuredBuild(doc.generation, new core.Cancel())
      await expect.poll(() => core.debugStats().jobs, { timeout: 10_000 }).toBe(0) // the index thread stopped
    } finally {
      core.setLimit(limit)
    }
    const info = await doc.structuredBuild(doc.generation, new core.Cancel())
    const reason = 'Transcript graph stopped with the JSONL index; Rows remains available'
    console.log(`a stopped index: ${structuredBytes(doc)} bytes still charged to the structured index`)
    expect(info).toMatchObject({ done: false, reason: 'The memory budget stopped JSONL indexing', transcript: { ready: false, reason, messages: 0 } })
    expect(structuredBytes(doc)).toBeLessThan(1 << 20) // the JSONL index's own; the half-built graph held 17.6 MB
    expect(await doc.structuredTranscript(doc.generation, info.revision, 0, 20, new core.Cancel()).catch((e: { code: string, message: string }) => [e.code, e.message])).toEqual(['Refused', `refused: ${reason}`])
  } finally {
    doc.close()
  }
  await expect.poll(() => alive()).toEqual({ jobs: 0, tasks: 0, handles: 0 })
  expect(core.debugStats().ledger.used).toBe(base)
})
