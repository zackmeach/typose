// What a launch that outlives its close is doing, collected before the harness kills it (`finish` in app.ts,
// `closePackaged` in packaged.ts): whether it logged its quit, whether Electron said it was waiting for its inspector
// client to disconnect (dev layout only: the packaged build has no inspector), its process tree, and its threads where
// the OS lists them without extra tools. It never throws, and every command it runs is bounded: a diagnostic that hung
// a worker would be worse than none.
import { test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The longest a call takes: its commands' timeouts (50 s at most, on macOS) and a few file reads and writes. */
export const LINGER_BUDGET = 55_000
const WAITING = 'Waiting for the debugger to disconnect'
// First, lines marked `#` that the tree's parser skips: the pid's CPU time and its threads, counted by state (and wait
// reason). Then one line per process: pid, parent pid, seconds since it started, command line. Win32_Process leaves
// state empty. The process list goes last so that the exit status is its own.
const winList = (pid: number) =>
  `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
  "if ($p) { '# CPU {0} s, {1} threads' -f [math]::Round($p.TotalProcessorTime.TotalSeconds, 2), $p.Threads.Count; $p.Threads | Group-Object { if ($_.ThreadState -eq 'Wait') { 'Wait/' + $_.WaitReason } else { [string]$_.ThreadState } } | ForEach-Object { '# threads {0}: {1}' -f $_.Name, $_.Count } }; " +
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}s {3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { [int]((Get-Date) - $_.CreationDate).TotalSeconds } else { '?' }), $_.CommandLine }"

export interface Linger {
  pid: number
  /** The pid's `quit` record in its lifecycle log: its exit code, and how many ms before the call it was written. */
  quit: { code: unknown; ago: number } | null
  /** Whether stderr shows Electron's main process at exit, blocked until its inspector client disconnects. */
  waiting: boolean
  /** The pid, if still listed, and its descendants; null if the process list couldn't be read. */
  tree: { pid: number; ppid: number; line: string }[] | null
  /** What the failure message's last line says, inside its parentheses (`lingerError`). */
  summary: string
}

/** Runs a command, killed after `timeout` ms; how it went, and how long it took, as text, is in `report`. */
function run(cmd: string, args: string[], timeout: number): { ok: boolean; out: string; report: string } {
  const start = Date.now()
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 2 ** 20 })
  const how = `${r.error ? String(r.error) : `exit ${r.status ?? r.signal}`}, after ${Date.now() - start} ms`
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
      let e: { t?: string; pid?: number; event?: string; code?: unknown } | null
      try {
        e = JSON.parse(line) as typeof e
      } catch {
        continue
      }
      if (e?.event === 'quit' && e.pid === pid) r.quit = { code: e.code, ago: at - Date.parse(String(e.t)) } // a line may parse to null
    }
  })
  attempt('listing processes', () => {
    const list = process.platform === 'win32'
      ? run('powershell', ['-NoProfile', '-Command', winList(pid)], 10_000)
      : run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,stat=,etime=,args='], 10_000)
    notes.push(list.report, ...list.out.split('\n').filter((line) => line.startsWith('#')).map((line) => line.trim()))
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
  if (process.platform === 'darwin') {
    attempt('listing threads', () => {
      const threads = run('ps', ['-M', '-p', String(pid)], 10_000) // cheap, so thread states land even if `sample` times out
      notes.push(threads.report, threads.out)
    })
    // Without root, `sample` waited out its 20 s on a hosted runner and wrote nothing (runs 43929207660 and
    // 43935222188). Under CI, where sudo asks for no password, it runs as root; never on a developer's Mac. This
    // process may not be allowed to kill a root one, so there the command ends itself: perl's alarm outlives its exec.
    if (out) attempt('sampling', () => {
      const args = ['sample', String(pid), '1', '-mayDie', '-file', join(out, `linger-${pid}.sample.txt`)]
      const sudo = process.env.CI ? run('sudo', ['-n', 'true'], 5_000) : null
      if (sudo) notes.push(sudo.report)
      const sampled = sudo?.ok ? run('sudo', ['-n', 'perl', '-e', 'alarm 20; exec @ARGV', ...args], 25_000) : run(args[0], args.slice(1), 20_000)
      notes.push(sampled.report)
    })
  }

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
  r.summary = `${quit}; ${seen}; ${alive}; ${where}`
  return r
}

/** An exit the diagnostic hid by holding the event loop: one that happened meanwhile lands within the next 100 ms. */
export const exitedMeanwhile = <T>(exited: Promise<T>): Promise<T | null> =>
  Promise.race([exited, new Promise<null>((ok) => setTimeout(() => ok(null), 100))])

/**
 * The failure: its first clause is what CI annotations and records are searched by. `exited` says the process ended
 * by itself during the diagnostic; `stderr`, read after it, may hold the waiting line that came in while it ran.
 */
export function lingerError(r: Linger, exited: boolean, stderr: string): Error {
  const late = !r.waiting && stderr.includes(WAITING) ? `; stderr "${WAITING}": first seen after the diagnostic` : ''
  return new Error(`pid ${r.pid} didn't exit within 15 s of its close, ${exited ? 'and exited during the diagnostic' : 'and was killed'}\n(${r.summary}${late})`)
}
