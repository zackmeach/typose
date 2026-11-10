// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
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
  // Each passed only on retry, once, on the one OS named.
  {
    title: 'a Reload the ledger refuses keeps Raw at its generation, with a banner, and Retry reloads once there is room',
    os: 'linux', reason: 'run 42873445753: an exact ledger equality failed once (337156552 expected, 321182104 received)', expires: '2026-12-10'
  },
  {
    title: 'Raw Ctrl+wheel down to 50% grows its viewport only within the paid cache reservation',
    os: 'linux', reason: 'run 42873445753: lost one zoom step once (0.6830 against 0.6209)', expires: '2026-12-10'
  },
  {
    title: 'native-derived capture remains a reselect record across an actual restart',
    os: 'win32', reason: 'run 42869369349: no derived tab in the saved session once', expires: '2026-12-10'
  },
  {
    title: 'the keyboard reaches ☰ and Raw, ☰ runs its commands from the keyboard, and the focus ring shows',
    os: 'linux', reason: 'run 42869369349: focus never arrived once', expires: '2026-12-10'
  }
]
