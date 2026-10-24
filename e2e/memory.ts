// Plan §5's memory metrics, each process's on its own and summed across processes, kept separate (PR 6): none stands in
// for another. Private bytes and the working set come from Electron's `app.getAppMetrics()` on Windows. On Linux
// they're read from /proc/<pid>/smaps_rollup, which also gives PSS. Electron reports no private bytes on macOS, so
// there they're missing, never replaced by another metric.
import { readFileSync } from 'node:fs'
import type { ElectronApplication } from '@playwright/test'

export interface ProcessMemory {
  type: string
  name: string
  pid: number
  /** Bytes; undefined where the OS API doesn't report it. */
  private?: number
  /** The working set (Windows) or resident set (RSS: Linux, macOS). */
  resident: number
  pss?: number
}

/** The kB fields of /proc/<pid>/smaps_rollup, in bytes. */
function smaps(pid: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').split('\n')) {
    const m = /^(\w+):\s+(\d+) kB/.exec(line)
    if (m) out[m[1]] = Number(m[2]) * 1024
  }
  return out
}

/** Every process of the app, with its memory. */
export async function processMemory(app: ElectronApplication): Promise<ProcessMemory[]> {
  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? m.serviceName ?? '', pid: m.pid, ws: m.memory.workingSetSize * 1024, priv: m.memory.privateBytes }))
  )
  return metrics.map((m) => {
    if (process.platform === 'linux') {
      const s = smaps(m.pid)
      return { type: m.type, name: m.name, pid: m.pid, private: s.Private_Clean + s.Private_Dirty, resident: s.Rss, pss: s.Pss }
    }
    return { type: m.type, name: m.name, pid: m.pid, private: m.priv === undefined ? undefined : m.priv * 1024, resident: m.ws }
  })
}

/** Each metric summed across processes; a metric any process lacks is missing from the sum too. */
export function summed(all: ProcessMemory[]): { private?: number; resident: number; pss?: number } {
  const sum = (f: (p: ProcessMemory) => number | undefined) =>
    all.every((p) => f(p) !== undefined) ? all.reduce((n, p) => n + f(p)!, 0) : undefined
  return { private: sum((p) => p.private), resident: sum((p) => p.resident)!, pss: sum((p) => p.pss) }
}

export const mib = (n: number | undefined): string => (n === undefined ? 'not reported' : `${(n / 2 ** 20).toFixed(1)} MiB`)
