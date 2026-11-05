import type { SourceSpan, StructuredChildren, StructuredColumns, StructuredInfo, StructuredNode, StructuredProblem, StructuredRef, StructuredRows, StructuredRow, TranscriptInfo, TranscriptItem, TranscriptPage, TranscriptTools, TranscriptText } from '../shared/protocol'
import { isRecord, isValid } from './numbers'

function invalid(message: string): never {
  throw Object.assign(new Error(`The core returned invalid structured ${message}`), { code: 'Internal' })
}

function number(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (!isValid(value, min, max)) invalid('number')
  return value
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) invalid('text')
  return value
}

export function structuredSpan(value: unknown, size: number): SourceSpan {
  if (!isRecord(value)) invalid('source span')
  const start = number(value.start, size)
  return { start, end: number(value.end, size, start) }
}

export function structuredNode(value: unknown, size: number): StructuredNode {
  if (!isRecord(value) || !['object', 'array', 'string', 'number', 'boolean', 'null', 'alias', 'comment'].includes(String(value.kind))) invalid('node')
  if (typeof value.more !== 'boolean' || typeof value.duplicate !== 'boolean') invalid('node flags')
  const result: StructuredNode = {
    ordinal: number(value.ordinal), kind: value.kind as StructuredNode['kind'], span: structuredSpan(value.span, size),
    text: text(value.text, 16 << 10), more: value.more, duplicate: value.duplicate
  }
  if (value.key != null) result.key = text(value.key, 4096)
  if (value.keySpan != null) result.keySpan = structuredSpan(value.keySpan, size)
  if (typeof value.keyMore === 'boolean') result.keyMore = value.keyMore
  if (value.container != null) result.container = number(value.container, 0xffff_ffff)
  if (value.children != null) result.children = number(value.children)
  return result
}

function problem(value: unknown, size: number): StructuredProblem {
  if (!isRecord(value)) invalid('problem')
  return { kind: text(value.kind, 64), count: number(value.count), message: text(value.message, 2048), first: structuredSpan(value.first, size),
    ...(value.line == null ? {} : { line: number(value.line) }), ...(value.column == null ? {} : { column: number(value.column) }) }
}

export function structuredInfo(value: unknown, base: Omit<StructuredRef, 'revision'>, size: number): StructuredInfo {
  if (!isRecord(value) || !['json', 'jsonl', 'yaml'].includes(String(value.format)) ||
    !['ready', 'partial', 'indexing', 'locked'].includes(String(value.status)) || typeof value.done !== 'boolean' ||
    !Array.isArray(value.problems) || value.problems.length > 128) invalid('info')
  const info: StructuredInfo = { ref: { ...base, revision: number(value.revision, 0xffff_ffff, 1) },
    format: value.format as StructuredInfo['format'], status: value.status as StructuredInfo['status'], done: value.done,
    problems: value.problems.map((item) => problem(item, size)) }
  if (value.reason != null) info.reason = text(value.reason, 2048)
  if (value.parsedAs != null) {
    if (value.parsedAs !== 'json' && value.parsedAs !== 'jsonc') invalid('parse flavor')
    info.parsedAs = value.parsedAs
  }
  if (value.root != null) info.root = structuredNode(value.root, size)
  for (const key of ['rows', 'parsed', 'failed', 'blank', 'columns'] as const) if (value[key] != null) info[key] = number(value[key])
  if (value.tableOff != null) info.tableOff = text(value.tableOff, 2048)
  if (value.schema != null) info.schema = text(value.schema, 64)
  // Checked, not yet passed on: until the Transcript lens lands (M5 PR 2), the renderer would show every detected
  // session a disabled Transcript tab (card.ts).
  if (value.transcript != null) transcriptInfo(value.transcript)
  return info
}

export function transcriptInfo(value: unknown): TranscriptInfo {
  if (!isRecord(value) || !['claude-code-v1', 'openai-chat-v1'].includes(String(value.adapter)) || !['messages', 'dataset'].includes(String(value.mode)) ||
    typeof value.ready !== 'boolean' || typeof value.confidence !== 'number' || !(value.confidence >= 0 && value.confidence <= 1)) invalid('transcript metadata')
  return { adapter: value.adapter as TranscriptInfo['adapter'], mode: value.mode as TranscriptInfo['mode'], ready: value.ready, confidence: value.confidence,
    messages: number(value.messages), events: number(value.events), branches: number(value.branches), sidechains: number(value.sidechains), calls: number(value.calls),
    matchedResults: number(value.matchedResults), unmatchedResults: number(value.unmatchedResults), ...(value.reason == null ? {} : { reason: text(value.reason, 2048) }) }
}

export function transcriptPage(value: unknown, size: number): TranscriptPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 128) invalid('transcript page')
  const items = value.items.map((item: unknown): TranscriptItem => {
    if (!isRecord(item) || !['turn', 'conversation', 'event', 'branch', 'sidechain'].includes(String(item.kind)) || !Array.isArray(item.linkedResults) || item.linkedResults.length > 128) invalid('transcript item')
    return { id: number(item.id), kind: item.kind as TranscriptItem['kind'], record: number(item.record), span: structuredSpan(item.span, size), root: structuredNode(item.root, size),
      children: number(item.children), tools: number(item.tools), linkedResults: item.linkedResults.map((span: unknown) => structuredSpan(span, size)),
      ...(item.role == null ? {} : { role: text(item.role, 4096) }), ...(item.timestamp == null ? {} : { timestamp: text(item.timestamp, 4096) }),
      ...(item.content == null ? {} : { content: structuredNode(item.content, size) }), ...(item.messageContainer == null ? {} : { messageContainer: number(item.messageContainer, 0xffff_ffff) }) }
  })
  return { items, total: number(value.total), events: number(value.events), ...(value.next == null ? {} : { next: number(value.next) }) }
}

export function transcriptTools(value: unknown, size: number): TranscriptTools {
  if (!isRecord(value) || !Array.isArray(value.tools) || !Array.isArray(value.results) || value.tools.length + value.results.length > 32) invalid('transcript tools')
  const tools = value.tools.map((tool: unknown) => {
    if (!isRecord(tool)) invalid('transcript tool')
    return { ordinal: number(tool.ordinal), id: text(tool.id, 4096), name: text(tool.name, 4096), block: structuredNode(tool.block, size), results: number(tool.results),
      ...(tool.input == null ? {} : { input: structuredNode(tool.input, size) }) }
  })
  const results = value.results.map((result: unknown) => {
    if (!isRecord(result)) invalid('transcript result')
    return { record: number(result.record), span: structuredSpan(result.span, size), block: structuredNode(result.block, size),
      ...(result.content == null ? {} : { content: structuredNode(result.content, size) }) }
  })
  return { tools, results, total: number(value.total), ...(value.next == null ? {} : { next: number(value.next) }) }
}

export function transcriptText(value: unknown): TranscriptText {
  if (!isRecord(value) || !Array.isArray(value.html) || value.html.length > 128) invalid('transcript text')
  const html = value.html.map((block: unknown) => text(block, 256 << 10))
  if (html.reduce((units, block) => units + block.length, 0) * 6 > 2 << 20) invalid('transcript text size')
  return { html, total: number(value.total), ...(value.next == null ? {} : { next: number(value.next) }) }
}

export function structuredChildren(value: unknown, size: number): StructuredChildren {
  if (!isRecord(value) || !Array.isArray(value.nodes) || value.nodes.length > 128) invalid('child page')
  const nodes = value.nodes.map((node) => structuredNode(node, size))
  return { nodes, ...(value.next == null ? {} : { next: number(value.next) }) }
}

export function structuredRows(value: unknown, size: number): StructuredRows {
  if (!isRecord(value) || !Array.isArray(value.rows) || value.rows.length > 128 || typeof value.done !== 'boolean') invalid('record page')
  const rows: StructuredRow[] = value.rows.map((row: unknown) => {
    if (!isRecord(row) || row.status !== 'valid' && row.status !== 'failed' || typeof row.more !== 'boolean') invalid('record')
    return { line: number(row.line), span: structuredSpan(row.span, size), status: row.status,
      summary: text(row.summary, 8192), more: row.more,
      ...(row.timestamp == null ? {} : { timestamp: text(row.timestamp, 4096) }),
      ...(row.type == null ? {} : { type: text(row.type, 4096) }),
      ...(row.root == null ? {} : { root: structuredNode(row.root, size) }),
      ...(row.problem == null ? {} : { problem: text(row.problem, 2048) }) }
  })
  return { rows, done: value.done, ...(value.nextLine == null ? {} : { nextLine: number(value.nextLine) }) }
}

export function structuredColumns(value: unknown, size: number): StructuredColumns {
  if (!isRecord(value) || !Array.isArray(value.columns) || value.columns.length > 128 || typeof value.done !== 'boolean') invalid('column page')
  const columns = value.columns.map((column: unknown) => {
    if (!isRecord(column)) invalid('column')
    return { id: number(column.id), key: text(column.key, 4096), ...(column.span == null ? {} : { span: structuredSpan(column.span, size) }) }
  })
  return { columns, total: number(value.total), done: value.done, ...(value.next == null ? {} : { next: number(value.next) }) }
}
