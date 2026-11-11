// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
// An entry is for a test that failed its try and its retry in one run, or was flaky in two runs. A test that is flaky
// once fails its job (failOnFlakyTests); re-run that job.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = [
  {
    title: 'close mid-index on 10 GiB: the job stops within 50 ms, and 0 jobs, 0 tasks and 0 handles remain',
    os: 'darwin', reason: 'hosted runner: 77 ms against the 50 ms bound', expires: '2026-12-10'
  },
  {
    title: 'a double Reload mid-index on 10 GiB keeps one index job, and close then leaves 0 jobs and 0 handles within 50 ms',
    os: 'darwin', reason: 'hosted runner: over the 50 ms bound', expires: '2026-12-10'
  },
  // Flaky in two runs, 42869369349 and 42889988308: the focus never arrives on the first try.
  {
    title: 'the keyboard reaches ☰ and Raw, ☰ runs its commands from the keyboard, and the focus ring shows',
    os: 'linux', reason: 'flaky twice: ☰ is not focused on the first try', expires: '2026-12-10'
  },
  // Flaky in three runs, 42869369349, 42898377896 and 42898891669.
  {
    title: 'native-derived capture remains a reselect record across an actual restart',
    os: 'win32', reason: 'flaky three times: session.json is read once, before the derived tab is saved', expires: '2026-12-10'
  }
]
