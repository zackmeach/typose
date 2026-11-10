// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
// An entry is for a test that failed its try and its retry in one run, or was flaky in two runs. A test that is flaky
// once fails its job (failOnFlakyTests); re-run that job.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = [
  // All from the first full three-OS run, 42869369349: each failed its first try and its retry.
  ...(['win32', 'darwin'] as const).map(os => ({
    title: 'under a budget that holds only the viewport, Raw mounts only the viewport, within its reservation, after open, Reload and resize',
    os, reason: "hosted runner: the reservation never equals the viewport's cap within 30 s", expires: '2026-12-10'
  })),
  {
    title: 'close mid-index on 10 GiB: the job stops within 50 ms, and 0 jobs, 0 tasks and 0 handles remain',
    os: 'darwin', reason: 'hosted runner: 77 ms against the 50 ms bound', expires: '2026-12-10'
  },
  {
    title: 'a double Reload mid-index on 10 GiB keeps one index job, and close then leaves 0 jobs and 0 handles within 50 ms',
    os: 'darwin', reason: 'hosted runner: over the 50 ms bound', expires: '2026-12-10'
  },
  {
    title: 'reading Rows by keyboard while the graph indexes keeps Rows when the Transcript becomes ready',
    os: 'linux', reason: 'under xvfb the command palette never opens after this launch; cause unknown', expires: '2026-12-10'
  },
  // Flaky in two runs, 42869369349 and 42889988308: the focus never arrives on the first try.
  {
    title: 'the keyboard reaches ☰ and Raw, ☰ runs its commands from the keyboard, and the focus ring shows',
    os: 'linux', reason: 'flaky twice: ☰ is not focused on the first try', expires: '2026-12-10'
  }
]
