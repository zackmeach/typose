import type { Opened, SourceSpan, StructuredChildren, StructuredInfo } from '../../shared/protocol'
import type { CoreClient } from '../core'
import { CoreCallError } from '../core'
import type { LensBudget } from './lens-budget'
const YAML_MAX_BYTES = 8 << 20
const YAML_BUILD_MS = 5000

export interface StructuredSource {
  info: StructuredInfo
  /** A container's children; of a value parsed from a JSON string, with its `scope`. */
  children(container: number, start: number, record?: number, scope?: SourceSpan): Promise<StructuredChildren>
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
    const source: StructuredSource = { info, children: (container, start, record, scope) => core.call('structuredChildren', { ref: source.info.ref, container, start, count: 128, record, scope }, signal),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, dispose() { stopped = true; clearTimeout(timer); listeners.clear() } }
    const poll = async () => {
      if (stopped || signal.aborted || source.info.done || source.info.status === 'locked' || source.info.status === 'partial' && source.info.reason) return
      try {
        const updated = await core.call('structuredBuild', { view }, signal)
        if (stopped || signal.aborted) return
        source.info = updated; for (const listener of listeners) listener()
      } catch (error) {
        if (!stopped && !signal.aborted) { source.info = { ...source.info, status: 'locked', reason: String(error) }; for (const listener of listeners) listener() }
      }
      if (!stopped && !signal.aborted && !source.info.done && source.info.status !== 'locked' && !(source.info.status === 'partial' && source.info.reason)) timer = setTimeout(() => { void poll() }, 200)
    }
    signal.addEventListener('abort', () => source.dispose(), { once: true })
    if (!info.done && info.status !== 'locked' && !(info.status === 'partial' && info.reason)) timer = setTimeout(() => { void poll() }, 200)
    return source
  }
  const ref = { session: view.session, doc: opened.doc, gen: opened.gen, revision: 1 }
  const locked = (reason: string): StructuredSource => ({ info: { ref, format: 'yaml', status: 'locked', reason, done: true, problems: [] }, children: async () => ({ nodes: [] }), dispose() {} })
  if (opened.size > YAML_MAX_BYTES) return locked('YAML Tree shows files up to 8 MiB')
  // Includes decoder/transport overlap, UTF-16→byte map, bounded CST/AST/projection and engine object overhead.
  if (!budget || !await budget.reserveModel(opened.gen, (64 << 20) + opened.size * 128)) return locked('YAML Tree unavailable · memory budget is full')
  if (signal.aborted) { await budget.reserveModel(opened.gen, 0); throw new Error('Cancelled') }
  let worker: Worker
  try { worker = new Worker(new URL('./yaml.worker.ts', import.meta.url), { type: 'module' }) }
  catch (error) { await budget.reserveModel(opened.gen, 0); return locked(String(error)) }
  let serial = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const dispose = () => { worker.terminate(); for (const job of pending.values()) job.reject(new Error('YAML worker disposed')); pending.clear(); void budget.reserveModel(opened.gen, 0) }
  signal.addEventListener('abort', dispose, { once: true })
  worker.onmessage = event => { const job = pending.get(event.data.id); if (!job) return; pending.delete(event.data.id); if (event.data.error) job.reject(new Error(event.data.error)); else job.resolve(event.data.result) }
  worker.onerror = event => { for (const job of pending.values()) job.reject(new Error(event.message)); pending.clear() }
  const call = <T>(method: string, params: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve: value => resolve(value as T), reject }); worker.postMessage({ id, method, ...params }, transfer) })
  try {
    const raw = new Uint8Array(opened.size)
    if (!await core.call('sourceVerify', { view, start: 0, end: opened.size }, signal)) throw new Error('Source changed; reload before viewing YAML')
    for (let start = 0; start < opened.size; start += 65536) {
      const count = Math.min(65536, opened.size - start), bytes = await core.call('sourceBytes', { view, start, count }, signal)
      if (bytes.length !== count) throw new Error('Source changed while reading YAML')
      raw.set(bytes, start)
    }
    if (!await core.call('sourceVerify', { view, start: 0, end: opened.size }, signal)) throw new Error('Source changed; reload before viewing YAML')
    // A build that runs away is stopped: the worker is terminated and the Tree is locked with the reason.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const built = await Promise.race([call<Pick<StructuredInfo, 'root' | 'problems'>>('build', { bytes: raw, encoding: opened.encoding }, [raw.buffer]),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => { worker.terminate(); reject(new Error(`YAML Tree took longer than ${YAML_BUILD_MS / 1000} s to build · use Raw`)) }, YAML_BUILD_MS) })])
      .finally(() => clearTimeout(watchdog))
    if (!await core.call('sourceVerify', { view, start: 0, end: opened.size }, signal)) throw new CoreCallError('Frozen', 'Source changed while parsing YAML; reload')
    const info: StructuredInfo = { ref, format: 'yaml', status: built.problems.some(p => p.kind === 'parse') ? 'partial' : 'ready', done: true, ...built }
    return { info, children: (container, start) => call('children', { container, start, count: 128 }), dispose }
  } catch (error) { dispose(); await budget.reserveModel(opened.gen, 0); if (signal.aborted || error instanceof CoreCallError && error.code === 'Frozen') throw error; return locked(String(error)) }
}
