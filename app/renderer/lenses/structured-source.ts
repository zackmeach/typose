import type { Opened, StructuredChildren, StructuredInfo } from '../../shared/protocol'
import type { CoreClient } from '../core'
import type { LensBudget } from './lens-budget'
const YAML_MAX_BYTES = 8 << 20

export interface StructuredSource {
  info: StructuredInfo
  children(container: number, start: number, record?: number): Promise<StructuredChildren>
  subscribe?(listener: () => void): () => void
  dispose(): void
}
export async function prepareStructured(core: CoreClient, opened: Opened, budget: LensBudget | null, signal: AbortSignal): Promise<StructuredSource> {
  const view = opened.view
  if (!view) throw new Error('No active view')
  if (opened.format !== 'yaml') {
    const info = await core.call('structuredBuild', { view }, signal)
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const listeners = new Set<() => void>()
    const source: StructuredSource = { info, children: (container, start, record) => core.call('structuredChildren', { ref: source.info.ref, container, start, count: 128, record }, signal),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, dispose() { stopped = true; clearTimeout(timer); listeners.clear() } }
    const poll = async () => {
      if (stopped || signal.aborted || source.info.done || source.info.status === 'locked') return
      try {
        const updated = await core.call('structuredBuild', { view }, signal)
        if (stopped || signal.aborted) return
        source.info = updated; for (const listener of listeners) listener()
      } catch (error) {
        if (!stopped && !signal.aborted) { source.info = { ...source.info, status: 'locked', reason: String(error) }; for (const listener of listeners) listener() }
      }
      if (!stopped && !signal.aborted && !source.info.done && source.info.status !== 'locked') timer = setTimeout(() => { void poll() }, 200)
    }
    signal.addEventListener('abort', () => source.dispose(), { once: true })
    if (!info.done && info.status !== 'locked') timer = setTimeout(() => { void poll() }, 200)
    return source
  }
  const ref = { session: view.session, doc: opened.doc, gen: opened.gen, revision: 1 }
  const locked = (reason: string): StructuredSource => ({ info: { ref, format: 'yaml', status: 'locked', reason, done: true, problems: [] }, children: async () => ({ nodes: [] }), dispose() {} })
  if (opened.size > YAML_MAX_BYTES) return locked('YAML Tree shows files up to 8 MiB')
  // Includes raw bytes, decoded UTF-16, worker transport overlap, byte map, CST and bounded projection.
  if (!budget || !await budget.reserveGrid(opened.gen, (8 << 20) + opened.size * 40)) return locked('YAML Tree unavailable · memory budget is full')
  if (signal.aborted) throw new Error('Cancelled')
  const worker = new Worker(new URL('./yaml.worker.ts', import.meta.url), { type: 'module' })
  let serial = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const dispose = () => { worker.terminate(); for (const job of pending.values()) job.reject(new Error('YAML worker disposed')); pending.clear() }
  signal.addEventListener('abort', dispose, { once: true })
  worker.onmessage = event => { const job = pending.get(event.data.id); if (!job) return; pending.delete(event.data.id); if (event.data.error) job.reject(new Error(event.data.error)); else job.resolve(event.data.result) }
  worker.onerror = event => { for (const job of pending.values()) job.reject(new Error(event.message)); pending.clear() }
  const call = <T>(method: string, params: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve: value => resolve(value as T), reject }); worker.postMessage({ id, method, ...params }) })
  try {
    const decoder = new TextDecoder(opened.encoding, { fatal: true }), parts: string[] = []
    let bom = 0
    if (!await core.call('sourceVerify', { view, start: 0, end: opened.size }, signal)) throw new Error('Source changed; reload before viewing YAML')
    for (let start = 0; start < opened.size; start += 65536) {
      const count = Math.min(65536, opened.size - start), bytes = await core.call('sourceBytes', { view, start, count }, signal)
      if (bytes.length !== count) throw new Error('Source changed while reading YAML')
      if (start === 0) bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0
      parts.push(decoder.decode(bytes, { stream: true }))
    }
    parts.push(decoder.decode())
    if (!await core.call('sourceVerify', { view, start: 0, end: opened.size }, signal)) throw new Error('Source changed; reload before viewing YAML')
    const built = await call<Pick<StructuredInfo, 'root' | 'problems'>>('build', { source: parts.join(''), encoding: opened.encoding, bom })
    const info: StructuredInfo = { ref, format: 'yaml', status: built.problems.some(p => p.kind === 'parse') ? 'partial' : 'ready', done: true, ...built }
    return { info, children: (container, start) => call('children', { container, start, count: 128 }), dispose }
  } catch (error) { dispose(); if (signal.aborted) throw error; return locked(String(error)) }
}
