// What every perf run records with its figures (Z49): the machine's CPU load and the panel's refresh rate, plus a
// results file per host. These runs are informational until plan §5's qualification (M1 close).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, hostname } from 'node:os'
import { join, resolve } from 'node:path'

/** Outside test-results/, which every Playwright run empties: cold samples accumulate across restarts. */
export const RESULTS = resolve(__dirname, '../../.evidence/m1/perf')

type CpuTimes = { idle: number; total: number }

export function cpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const { times } of cpus()) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

/** The whole machine's CPU use between two samples, in percent of all cores. */
export const cpuLoad = (from: CpuTimes, to: CpuTimes = cpuTimes()): number =>
  Math.round(1000 * (1 - (to.idle - from.idle) / Math.max(1, to.total - from.total))) / 10

/** The load over `ms` of waiting: what the machine is doing before a run starts. */
export async function idleLoad(ms = 5000): Promise<number> {
  const from = cpuTimes()
  await new Promise((ok) => setTimeout(ok, ms))
  return cpuLoad(from)
}

/** Nearest-rank percentile, as plan A's runner judged (p95 of n = 30 is the 29th value). */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]
}

export function summary(samples: number[]) {
  // A duration is never zero or negative; one that is means the measurement itself is broken.
  if (samples.length === 0 || samples.some((s) => !(s > 0))) throw new Error(`invalid samples: ${JSON.stringify(samples)}`)
  return { n: samples.length, p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples), samples }
}

/** Writes `value` under `key` in this host's results file (cold keys append across restarts; see startup.perf.ts). */
export function record(key: string, value: unknown): void {
  mkdirSync(RESULTS, { recursive: true })
  const file = join(RESULTS, `m1-${hostname()}.json`)
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
  all[key] = value
  writeFileSync(file, JSON.stringify(all, null, 2))
}
