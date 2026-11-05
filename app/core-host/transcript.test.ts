// Transcript queries through the core host, over the M5 synthetic fixtures (a Claude Code session and an OpenAI
// fine-tuning dataset): every page, group, tool, result, text block and content array, walked as diag's drive.cjs
// walked the parked addon, which crashed the core host on the first text, tools or group query.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Cancel, Doc, coreVersion, limits, reserveCache, setBudget } from 'typose-node'
import type { Opened, StructuredChildren, StructuredInfo, StructuredNode, StructuredRef, StructuredRows, SurfaceRef, TranscriptPage, TranscriptText, TranscriptTools } from '../shared/protocol'
import { makeDispatcher } from './dispatch'
import { transcriptInfo } from './structured-validation'

/** session-7f3a.jsonl: a fork at u5 (u9, then u10, the latest leaf), a sidechain u6-u7, a summary and a system event. */
const SESSION = [
  String.raw`{"type": "summary", "summary": "Rollout date conflicts", "leafUuid": "u9"}`,
  String.raw`{"type": "user", "uuid": "u1", "parentUuid": null, "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:07.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "user", "content": "Read launch-plan.md and tasks.csv. Do the rollout dates conflict with any task deadlines?"}}`,
  String.raw`{"type": "assistant", "uuid": "u2", "parentUuid": "u1", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:09.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "assistant", "model": "claude-opus", "content": [{"type": "thinking", "thinking": "Need both files.\nRead plan first.\nThen tasks."}, {"type": "text", "text": "I'll read both files first."}, {"type": "tool_use", "id": "toolu_01", "name": "Read", "input": {"file_path": "/work/pulse-launch/launch-plan.md"}}]}}`,
  String.raw`{"type": "user", "uuid": "u3", "parentUuid": "u2", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:10.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_01", "content": "# Pulse 2.0 \u2013 launch plan\n...\n(26 lines)"}]}}`,
  String.raw`{"type": "assistant", "uuid": "u4", "parentUuid": "u3", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:11.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_02", "name": "Read", "input": {"file_path": "/work/pulse-launch/tasks.csv"}}]}}`,
  String.raw`{"type": "user", "uuid": "u5", "parentUuid": "u4", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:12.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_02", "content": "task,status,owner,due\n...\n(15 lines)"}]}}`,
  String.raw`{"type": "user", "uuid": "u6", "parentUuid": "u5", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:13.000Z", "isSidechain": true, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "user", "content": "Search for other date references"}}`,
  String.raw`{"type": "assistant", "uuid": "u7", "parentUuid": "u6", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:15.000Z", "isSidechain": true, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "assistant", "content": [{"type": "text", "text": "No other date references found."}]}}`,
  String.raw`{"type": "system", "uuid": "u8", "parentUuid": "u5", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:16.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "system", "content": "Context compacted"}, "subtype": "compact_boundary"}`,
  String.raw`{"type": "assistant", "uuid": "u9", "parentUuid": "u5", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:21.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "assistant", "content": [{"type": "text", "text": "Yes, one conflict. The rollout sets **everyone: Nov 10**, and three tasks are due that same day:\n\n- Email the waitlist \u00b7 Priya Rao\n- Support macros \u00b7 Ana Silva\n- Status page note \u00b7 Theo Brandt\n\nI'd move *Status page note* to Nov 9 so it ships before traffic arrives."}]}}`,
  String.raw`{"type": "assistant", "uuid": "u10", "parentUuid": "u5", "sessionId": "7f3a0000-0000-4000-8000-000000000001", "timestamp": "2026-10-18T12:01:22.000Z", "isSidechain": false, "cwd": "/work/pulse-launch", "version": "2.1.0", "message": {"role": "assistant", "content": [{"type": "text", "text": "(alternate branch) Let me check the calendar first."}]}}`,
].join('\n') + '\n'

/** finetune-support.jsonl, byte for byte: 40 conversations of system, user, a tool call, its result, and a reply. */
const DATASET = Array.from({ length: 40 }, (_, i) => String.raw`{"messages": [{"role": "system", "content": "You are a support agent for an online store.\nBe brief.\nUse tools for order lookups."}, {"role": "user", "content": "Where is my order A-${1001 + i}?"}, {"role": "assistant", "content": null, "tool_calls": [{"id": "call_${i + 1}", "type": "function", "function": {"name": "lookup_order", "arguments": "{\"order_id\": \"A-${1001 + i}\"}"}}]}, {"role": "tool", "tool_call_id": "call_${i + 1}", "content": "{\"status\": \"shipped\", \"carrier\": \"UPS\", \"eta\": \"2026-10-22\", \"weight_kg\": 1.4}"}, {"role": "assistant", "content": "It shipped yesterday with UPS and should arrive Thursday, Oct 22. Want the tracking link?"}]}` + '\n').join('')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function client() {
  setBudget(totalmem())
  const directory = mkdtempSync(join(tmpdir(), 'typose-transcript-'))
  const dispatcher = makeDispatcher({ coreVersion, limits, reserveCache, cancelFlag: () => new Cancel(), openDoc: (path) => Doc.open(path) }, 602, () => {})
  let next = 1
  const call = (method: string, params: Record<string, unknown>) => dispatcher({ id: next++, method, params })
  const value = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const response = await call(method, params)
    if ('error' in response) throw Object.assign(new Error(response.error.message), response.error)
    return response.result as T
  }
  const surface = await value<SurfaceRef>('createSurface', {})
  const docs: number[] = []
  cleanup.push(async () => {
    for (const doc of docs) await call('close', { surface, doc })
    rmSync(directory, { recursive: true, force: true })
  })
  /** Opens `bytes` as `name`, indexed: its structured build done, and Raw's line index, which record scopes need. */
  const open = async (name: string, bytes: string) => {
    const path = join(directory, name)
    writeFileSync(path, bytes)
    const opened = await value<Opened>('open', { surface, path, count: 1, bytes: 0 })
    docs.push(opened.doc)
    const deadline = Date.now() + 10_000
    let info = await value<StructuredInfo>('structuredBuild', { view: opened.view })
    while (!info.done && Date.now() < deadline) info = await value<StructuredInfo>('structuredBuild', { view: opened.view })
    const lines = bytes.split('\n').length - 1
    while (!(await value<StructuredRows>('structuredRows', { ref: info.ref, start: lines - 1, count: 1 })).done && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    return { info, path }
  }
  return { open, value, call }
}

/** The core's own description of `path`, read without the core host. */
async function nativeTranscript(path: string) {
  const doc = Doc.open(path)
  try {
    let info = await doc.structuredBuild(doc.generation, new Cancel())
    while (!info.done) info = await doc.structuredBuild(doc.generation, new Cancel())
    return transcriptInfo(info.transcript)
  } finally { doc.close() }
}

type Client = Awaited<ReturnType<typeof client>>
/** drive.cjs's walk: each page with events off then on, each group, each turn's tools and each call's results, each
 * text block's Markdown and each content array's text blocks. */
async function walk(c: Client, ref: StructuredRef) {
  const counts = { pages: 0, items: 0, tools: 0, results: 0, texts: 0, children: 0 }
  const html = new Map<number, string[]>()
  const content = async (node: StructuredNode | undefined, record: number): Promise<void> => {
    if (node?.kind === 'string') {
      const text = await c.value<TranscriptText>('structuredTranscriptText', { ref, start: node.span.start, end: node.span.end, block: 0 })
      expect(text.next).toBeUndefined()
      expect(text.html).toHaveLength(text.total)
      html.set(node.span.start, text.html)
      counts.texts++
    } else if (node?.kind === 'array' && node.container !== undefined) {
      const page = await c.value<StructuredChildren>('structuredChildren', { ref, record, container: node.container, start: 0, count: 128 })
      counts.children++
      for (const block of page.nodes) {
        if (block.container === undefined) continue
        const fields = await c.value<StructuredChildren>('structuredChildren', { ref, record, container: block.container, start: 0, count: 128 })
        const text = fields.nodes.find((field) => field.key === 'text')
        if (text?.kind === 'string') await content(text, record)
      }
    }
  }
  const page = async (group?: number): Promise<void> => {
    for (const events of [false, true]) {
      let start: number | undefined = 0
      while (start !== undefined) {
        const p: TranscriptPage = await c.value<TranscriptPage>('structuredTranscript', { ref, start, count: 20, events, ...(group === undefined ? {} : { group }) })
        counts.pages++
        for (const item of p.items) {
          counts.items++
          if (item.kind === 'branch' || item.kind === 'sidechain' || item.kind === 'conversation') { await page(item.id); continue }
          if (item.tools) {
            const tools = await c.value<TranscriptTools>('structuredTranscriptTools', { ref, item: item.id, start: 0, count: 32 })
            counts.tools += tools.tools.length
            for (const tool of tools.tools) {
              if (!tool.results) continue
              const results = await c.value<TranscriptTools>('structuredTranscriptTools', { ref, item: item.id, start: 0, count: 32, call: tool.ordinal })
              counts.results += results.results.length
              for (const result of results.results) await content(result.content ?? result.block, result.record)
            }
          }
          await content(item.content, item.record)
        }
        start = p.next
      }
    }
  }
  await page()
  return { counts, html }
}

const page = (c: Client, ref: StructuredRef, params: Record<string, unknown> = {}) =>
  c.value<TranscriptPage>('structuredTranscript', { ref, start: 0, count: 128, ...params })
const shape = (p: TranscriptPage) => p.items.map((item) => [item.kind, item.role ?? null, item.record])

describe('Transcript through the core host', () => {
  it('a Claude Code session: the latest leaf, its fork, sidechain, events, tools and Markdown', async () => {
    const c = await client()
    const { info, path } = await c.open('session-7f3a.jsonl', SESSION)
    expect(info).toMatchObject({ done: true, schema: 'claude-code-v1' })
    expect(info.transcript).toEqual(await nativeTranscript(path))
    expect(await nativeTranscript(path)).toEqual({ adapter: 'claude-code-v1', mode: 'messages', confidence: 9 / 11, ready: true,
      messages: 9, events: 2, branches: 1, sidechains: 1, calls: 2, matchedResults: 2, unmatchedResults: 0 })

    // u3 and u5 carry only tool results, so they nest under u2's and u4's calls instead of showing as user turns.
    const main = await page(c, info.ref)
    expect(shape(main)).toEqual([['turn', 'user', 1], ['turn', 'assistant', 2], ['turn', 'assistant', 4], ['branch', null, 9], ['sidechain', null, 6], ['turn', 'assistant', 10]])
    expect(main).toMatchObject({ total: 6, events: 2 })
    expect(shape(await page(c, info.ref, { events: true }))).toEqual([['event', null, 0], ['turn', 'user', 1], ['turn', 'assistant', 2], ['turn', 'assistant', 4],
      ['branch', null, 9], ['sidechain', null, 6], ['event', null, 8], ['turn', 'assistant', 10]])
    const [, u2, u4, branch, sidechain] = main.items
    expect(shape(await page(c, info.ref, { group: branch!.id }))).toEqual([['turn', 'assistant', 9]])
    expect(shape(await page(c, info.ref, { group: sidechain!.id }))).toEqual([['turn', 'user', 6], ['turn', 'assistant', 7]])

    for (const [turn, id, result] of [[u2!, 'toolu_01', 3], [u4!, 'toolu_02', 5]] as const) {
      const tools = await c.value<TranscriptTools>('structuredTranscriptTools', { ref: info.ref, item: turn.id, start: 0, count: 32 })
      expect(tools.tools).toMatchObject([{ ordinal: 0, name: 'Read', id, results: 1, input: { kind: 'object' } }])
      const results = await c.value<TranscriptTools>('structuredTranscriptTools', { ref: info.ref, item: turn.id, start: 0, count: 32, call: 0 })
      expect(results).toMatchObject({ total: 1, results: [{ record: result, content: { kind: 'string' } }] })
    }

    const { counts, html } = await walk(c, info.ref)
    expect(counts).toEqual({ pages: 10, items: 26, tools: 4, results: 4, texts: 22, children: 14 }) // drive.cjs's, after the crash fix
    const blocks = [...html.values()]
    expect(blocks).toContainEqual([expect.stringContaining('Read launch-plan.md and tasks.csv.')])
    const answer = blocks.find((text) => text.some((block) => block.includes('everyone: Nov 10')))!
    expect(answer).toHaveLength(3)
    expect(answer[0]).toMatch(/<strong>.*everyone: Nov 10.*<\/strong>/)
    expect(answer[1]).toMatch(/^<ul>/)
  })

  it('an OpenAI dataset: one conversation a line, tool results under their calls', async () => {
    const c = await client()
    const { info, path } = await c.open('finetune-support.jsonl', DATASET)
    expect(info).toMatchObject({ done: true, schema: 'openai-chat-v1' })
    expect(info.transcript).toEqual(await nativeTranscript(path))
    expect(await nativeTranscript(path)).toEqual({ adapter: 'openai-chat-v1', mode: 'dataset', confidence: 1, ready: true,
      messages: 200, events: 0, branches: 0, sidechains: 0, calls: 40, matchedResults: 40, unmatchedResults: 0 })

    const first = await c.value<TranscriptPage>('structuredTranscript', { ref: info.ref, start: 0, count: 20 })
    expect(first).toMatchObject({ total: 40, next: 20 })
    expect(shape(first)).toEqual(Array.from({ length: 20 }, (_, line) => ['conversation', null, line]))
    expect(first.items.every((item) => item.children === 4)).toBe(true)
    // The tool message nests under the call with its tool_call_id, so it isn't a turn of its own.
    const turns = await page(c, info.ref, { group: first.items[0]!.id })
    expect(turns.items.map((item) => item.role)).toEqual(['system', 'user', 'assistant', 'assistant'])
    const call = turns.items[2]!
    expect(await c.value('structuredTranscriptTools', { ref: info.ref, item: call.id, start: 0, count: 32 })).toMatchObject({ total: 1, tools: [{ name: 'lookup_order', id: 'call_1', results: 1 }] })
    expect(await c.value('structuredTranscriptTools', { ref: info.ref, item: call.id, start: 0, count: 32, call: 0 })).toMatchObject({ results: [{ record: 0, content: { kind: 'string' } }] })
    // Its arguments, parsed from their JSON string: their children page with the string's span as the scope.
    const input = (await c.value<TranscriptTools>('structuredTranscriptTools', { ref: info.ref, item: call.id, start: 0, count: 32 })).tools[0]!.input!
    expect(DATASET.slice(input.span.start, input.span.end)).toBe(String.raw`"{\"order_id\": \"A-1001\"}"`)
    expect(input).toMatchObject({ kind: 'object', container: 0, children: 1, scope: input.span })
    const args = await c.value<StructuredChildren>('structuredChildren', { ref: info.ref, record: 0, container: 0, start: 0, count: 128, scope: input.scope })
    expect(args).toEqual({ nodes: [{ ordinal: 0, kind: 'string', key: 'order_id', keyMore: false, text: '"A-1001"', more: false, duplicate: false, span: input.span, scope: input.span }] })

    const { counts, html } = await walk(c, info.ref)
    expect(counts).toEqual({ pages: 164, items: 720, tools: 160, results: 160, texts: 640, children: 0 })
    expect([...html.values()]).toContainEqual([expect.stringContaining('Where is my order A-1040?')])
  })

  it('checks each query field against the core range table, and refuses a file with no transcript', async () => {
    const c = await client()
    const { info } = await c.open('session.jsonl', SESSION)
    const ref = info.ref
    const u2 = (await page(c, ref)).items[1]!
    const text = { ref, start: 1, end: 2, block: 0 }
    for (const [method, params, field] of [
      ['structuredTranscript', { ref, start: 0, count: 20, group: -1 }, 'group'],
      ['structuredTranscript', { ref, start: 0, count: 20, group: 2 ** 32 - 1 }, 'group'],
      ['structuredTranscript', { ref, start: 0, count: 129 }, 'count'],
      ['structuredTranscript', { ref, start: 0.5, count: 20 }, 'start'],
      ['structuredTranscriptTools', { ref, item: 2 ** 32 - 1, start: 0, count: 32 }, 'item'],
      ['structuredTranscriptTools', { ref, item: u2.id, start: 0, count: 33 }, 'count'],
      ['structuredTranscriptTools', { ref, item: u2.id, start: 0, count: 32, call: 1024 }, 'call'],
      ['structuredTranscriptText', { ...text, block: 65_537 }, 'block'],
      ['structuredTranscriptText', { ...text, end: 1 }, 'end'],
      ['structuredTranscriptText', { ...text, end: SESSION.length + 1 }, 'end'],
      ['structuredChildren', { ref, container: 0, start: 0, count: 1, scope: 'span' }, 'scope'],
      ['structuredChildren', { ref, container: 0, start: 0, count: 1, scope: { start: -1, end: 2 } }, 'scope'],
      ['structuredChildren', { ref, container: 0, start: 0, count: 1, scope: { start: 2, end: 2 } }, 'scope'],
      ['structuredChildren', { ref, container: 0, start: 0, count: 1, scope: { start: 0, end: SESSION.length + 1 } }, 'scope'],
    ] as const) expect(await c.call(method, params), `${method} ${field}`).toMatchObject({ error: { code: 'InvalidParams', field } })
    // A scope the core host passes that isn't a JSON string of JSON: refused by the core.
    expect(await c.call('structuredChildren', { ref, container: 0, start: 0, count: 1, scope: { start: 0, end: 10 } }))
      .toMatchObject({ error: { code: 'InvalidParams', message: expect.stringContaining('not a JSON string that holds JSON') } })
    // In range but not in this graph: refused by the core.
    expect(await c.call('structuredTranscript', { ref, start: 0, count: 20, group: 2 ** 32 - 2 })).toMatchObject({ error: { code: 'InvalidParams' } })
    expect(await c.call('structuredTranscriptTools', { ref, item: u2.id, start: 0, count: 32, call: 1023 })).toMatchObject({ error: { code: 'InvalidParams' } })

    const generic = await c.open('generic.jsonl', '{"a":1}\n{"b":2}\n')
    expect(await c.call('structuredTranscript', { ref: generic.info.ref, start: 0, count: 20 }))
      .toMatchObject({ error: { code: 'Refused', message: expect.stringContaining('No supported transcript schema') } })
  })

  it('a record that is both an OpenAI message and a dataset line counts once, and the file opens', async () => {
    const c = await client()
    const line = JSON.stringify({ role: 'user', content: 'hi', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] })
    const { info, path } = await c.open('both.jsonl', `${line}\n`.repeat(5))
    expect(info).toMatchObject({ done: true, schema: 'openai-chat-v1' })
    expect(await nativeTranscript(path)).toMatchObject({ mode: 'dataset', confidence: 1, ready: true, messages: 10 })
  })

  it('a legacy function call named at the 4,096-byte bound: its id fits the Tools bound, and its result nests under it', async () => {
    const c = await client()
    const name = 'f'.repeat(4096)
    const lines = [{ role: 'user', content: 'q' }, { role: 'assistant', content: null, function_call: { name, arguments: '{}' } }, { role: 'function', name, content: 'r' }]
    const { info } = await c.open('legacy-name.jsonl', lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
    const call = (await page(c, info.ref)).items[1]!
    const [tool] = (await c.value<TranscriptTools>('structuredTranscriptTools', { ref: info.ref, item: call.id, start: 0, count: 32 })).tools
    expect(tool).toMatchObject({ name: expect.stringMatching(/^f{4000,4096}$/), results: 1 })
    expect(tool!.id).toBe(`function:${tool!.name}`.slice(0, 4096))
    expect(tool!.id).toHaveLength(4096)
  })
})
