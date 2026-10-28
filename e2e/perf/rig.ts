// What every perf run records with its figures (Z49): the machine's CPU load and the panel's refresh rate, plus a
// results log per host. These runs are informational until plan §5's qualification (M1 close).
import { type TestInfo } from '@playwright/test'
import { appendFileSync, mkdirSync } from 'node:fs'
import { cpus, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { percentile } from './frames.mjs'

export { percentile }

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

export function summary(samples: number[]) {
  // A duration is never zero or negative; one that is means the measurement itself is broken.
  if (samples.length === 0 || samples.some((s) => !(s > 0))) throw new Error(`invalid samples: ${JSON.stringify(samples)}`)
  return { n: samples.length, p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples), samples }
}

/**
 * Appends one run to this host's results log (`m1-<host>.jsonl`). Nothing is ever overwritten: a failed or invalid run
 * stays beside its reruns, with its reason (Z49, spec §10.3).
 */
export function record(key: string, value: Record<string, unknown>): void {
  mkdirSync(RESULTS, { recursive: true })
  appendFileSync(join(RESULTS, `m1-${hostname()}.jsonl`), JSON.stringify({ key, at: new Date().toISOString(), ...value }) + '\n')
}

/**
 * Records a test's run once it has ended, with Playwright's verdict as its status and its failure as `testError`: the
 * value's own `reason` (why a run is invalid) is a different fact, and neither overwrites the other. Each error is
 * kept whole, with its expected and received lines and without terminal colour codes, up to 4,000 characters (a
 * coverage assertion's message carries the whole run).
 */
export function recordOutcome(info: TestInfo, key: string, value: Record<string, unknown>): void {
  const errors = info.errors.map((e) => stripVTControlCharacters(e.message ?? '').trim().slice(0, 4000)).filter(Boolean)
  const testError = errors.join('\n\n') || undefined
  record(key, { ...value, status: info.status, testError })
}
