import type { SourceSpan, StructuredChildren, StructuredInfo, StructuredNode, StructuredProblem, StructuredRef } from '../shared/protocol'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
  throw Object.assign(new Error(`The core returned invalid structured ${message}`), { code: 'Internal' })
}

function number(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid('number')
  return value
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) invalid('text')
  return value
}

export function structuredSpan(value: unknown, size: number): SourceSpan {
  if (!record(value)) invalid('source span')
  const start = number(value.start, size)
  return { start, end: number(value.end, size, start) }
}

export function structuredNode(value: unknown, size: number): StructuredNode {
  if (!record(value) || !['object', 'array', 'string', 'number', 'boolean', 'null', 'alias', 'comment'].includes(String(value.kind))) invalid('node')
  if (typeof value.more !== 'boolean' || typeof value.duplicate !== 'boolean') invalid('node flags')
  const result: StructuredNode = {
    ordinal: number(value.ordinal), kind: value.kind as StructuredNode['kind'], span: structuredSpan(value.span, size),
    text: text(value.text, 16 << 10), more: value.more, duplicate: value.duplicate
  }
  if (value.key != null) result.key = text(value.key, 4096)
  if (value.keySpan != null) result.keySpan = structuredSpan(value.keySpan, size)
  if (value.container != null) result.container = number(value.container, 0xffff_ffff)
  if (value.children != null) result.children = number(value.children)
  return result
}

function problem(value: unknown, size: number): StructuredProblem {
  if (!record(value)) invalid('problem')
  return { kind: text(value.kind, 64), count: number(value.count), message: text(value.message, 2048), first: structuredSpan(value.first, size),
    ...(value.line == null ? {} : { line: number(value.line) }), ...(value.column == null ? {} : { column: number(value.column) }) }
}

export function structuredInfo(value: unknown, base: Omit<StructuredRef, 'revision'>, size: number): StructuredInfo {
  if (!record(value) || !['json', 'jsonl', 'yaml'].includes(String(value.format)) ||
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
  for (const key of ['rows', 'parsed', 'failed', 'blank'] as const) if (value[key] != null) info[key] = number(value[key])
  return info
}

export function structuredChildren(value: unknown, size: number): StructuredChildren {
  if (!record(value) || !Array.isArray(value.nodes) || value.nodes.length > 128) invalid('child page')
  const nodes = value.nodes.map((node) => structuredNode(node, size))
  return { nodes, ...(value.next == null ? {} : { next: number(value.next) }) }
}
