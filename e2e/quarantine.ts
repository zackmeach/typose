// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
// An entry is for a test that failed its try and its retry in one run, or was flaky in two runs. A test that is flaky
// once fails its job (failOnFlakyTests); re-run that job.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = [
  // Both entries are product bugs, fixed on branch fix/menu-and-close-capture, which drops them.
  // Flaky in two runs, 42869369349 and 42889988308.
  {
    title: 'the keyboard reaches ☰ and Raw, ☰ runs its commands from the keyboard, and the focus ring shows',
    os: 'linux', reason: '☰ shows Reload disabled for up to 300 ms after a document opens, and the typeahead skips it', expires: '2026-12-10'
  },
  // Flaky in three runs, 42869369349, 42898377896 and 42898891669.
  {
    title: 'native-derived capture remains a reselect record across an actual restart',
    os: 'win32', reason: "close's session capture is refused when the new tab's Markdown build lands during it", expires: '2026-12-10'
  }
]
