// What a launch that outlives its close is doing, collected before the harness kills it (`finish` in app.ts,
// `closePackaged` in packaged.ts): whether it logged its quit, whether Electron said it was waiting for its inspector
// client to disconnect (dev layout only: the packaged build has no inspector), its process tree, and its threads where
// the OS lists them without extra tools. It never throws, and every command it runs is bounded: a diagnostic that hung
// a worker would be worse than none.
import { test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The longest a call takes: its commands' timeouts (30 s at most, on macOS) and a few file reads and writes. */
export const LINGER_BUDGET = 40_000
const WAITING = 'Waiting for the debugger to disconnect'
// One line per process: pid, parent pid, seconds since it started, command line. Win32_Process leaves state empty.
const WIN_LIST = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}s {3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { [int]((Get-Date) - $_.CreationDate).TotalSeconds } else { '?' }), $_.CommandLine }"

export interface Linger {
  pid: number
  /** The pid's `quit` record in its lifecycle log: its exit code, and how many ms before the call it was written. */
  quit: { code: unknown; ago: number } | null
  /** Whether stderr shows Electron's main process at exit, blocked until its inspector client disconnects. */
  waiting: boolean
  /** The pid, if still listed, and its descendants; null if the process list couldn't be read. */
  tree: { pid: number; ppid: number; line: string }[] | null
  /** One parenthesised line for the failure message. */
  summary: string
}

/** Runs a command, killed after `timeout` ms; how it went, as text, is in `report`. */
function run(cmd: string, args: string[], timeout: number): { ok: boolean; out: string; report: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 2 ** 20 })
  const how = r.error ? String(r.error) : `exit ${r.status ?? r.signal}`
  return { ok: !r.error && r.status === 0, out: r.stdout ?? '', report: `$ ${cmd} ${args.join(' ')}\n(${how})${r.stderr ? `\n${r.stderr.trim()}` : ''}` }
}

/**
 * Collects what `pid` is doing, from its profile `userData` and the `stderr` it wrote so far. Writes the details to
 * linger-<pid>.txt in the test's output, beside what `keepEvidence` keeps (and, on macOS, `sample`'s stacks to
 * linger-<pid>.sample.txt); returns them with a one-line summary.
 */
export function diagnoseLinger(pid: number, userData: string, stderr: string): Linger {
  const at = Date.now()
  const r: Linger = { pid, quit: null, waiting: stderr.includes(WAITING), tree: null, summary: '' }
  const notes: string[] = []
  const attempt = (what: string, f: () => void) => {
    try {
      f()
    } catch (e) {
      notes.push(`${what} failed: ${String(e)}`)
    }
  }
  let out = ''
  attempt('the output directory', () => mkdirSync((out = test.info().outputPath()), { recursive: true }))
  attempt('reading the lifecycle log', () => {
    for (const line of readFileSync(join(userData, 'logs', 'lifecycle.jsonl'), 'utf8').split('\n')) {
      let e: { t?: string; pid?: number; event?: string; code?: unknown }
      try {
        e = JSON.parse(line) as typeof e
      } catch {
        continue
      }
      if (e.event === 'quit' && e.pid === pid) r.quit = { code: e.code, ago: at - Date.parse(String(e.t)) }
    }
  })
  attempt('listing processes', () => {
    const list = process.platform === 'win32'
      ? run('powershell', ['-NoProfile', '-Command', WIN_LIST], 10_000)
      : run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,stat=,etime=,args='], 10_000)
    notes.push(list.report)
    if (!list.ok) return
    const all = list.out.split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\b/.exec(line)
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), line: line.trim() }] : []
    })
    const ids = new Set([pid])
    for (let grew = true; grew; ) {
      grew = false
      for (const p of all) {
        if (ids.has(p.ppid) && !ids.has(p.pid)) {
          ids.add(p.pid)
          grew = true
        }
      }
    }
    r.tree = all.filter((p) => ids.has(p.pid))
  })
  if (process.platform === 'linux') {
    attempt('listing threads', () => {
      const threads = run('ps', ['-L', '-o', 'pid=,lwp=,stat=,wchan:32=,comm=', '-p', r.tree?.map((p) => p.pid).join(',') || String(pid)], 10_000)
      notes.push(threads.report, threads.out)
    })
  }
  if (process.platform === 'darwin' && out) attempt('sampling', () => notes.push(run('sample', [String(pid), '1', '-mayDie', '-file', join(out, `linger-${pid}.sample.txt`)], 20_000).report))

  const quit = r.quit ? `quit logged ${(r.quit.ago / 1000).toFixed(1)} s earlier with code ${String(r.quit.code)}` : 'quit not logged'
  const seen = `stderr "${WAITING}": ${r.waiting ? 'seen' : 'not seen'}`
  const alive = r.tree ? `${r.tree.filter((p) => p.pid !== pid).length} descendant processes alive${r.tree.some((p) => p.pid === pid) ? '' : ', the pid itself not listed'}` : 'the process list failed'
  const file = `linger-${pid}.txt`
  let where = `details in ${file}`
  try {
    if (!out) throw new Error('no output directory')
    const columns = process.platform === 'win32' ? 'pid, parent pid, seconds since start, command line' : 'pid, parent pid, state, elapsed, command line'
    const tree = r.tree ? r.tree.map((p) => p.line) : ['(not listed)']
    writeFileSync(join(out, file), [`pid ${pid}, ${new Date(at).toISOString()}, ${process.platform}`, quit, seen, '', `Process tree (${columns}):`, ...tree, '', ...notes, '', 'stderr, last 4 KiB:', stderr.slice(-4096), ''].join('\n'))
  } catch (e) {
    where = `${file} not written: ${String(e)}`
  }
  r.summary = `(${quit}; ${seen}; ${alive}; ${where})`
  return r
}
