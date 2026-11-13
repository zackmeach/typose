// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
// An entry is for a test that failed its try and its retry in one run, or was flaky in two runs. A test that is flaky
// once fails its job (failOnFlakyTests); re-run that job.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = [
  // Flaky on macOS in two runs on 2026-11-13: run 43501980326 (job 132149850161, #90) and run 43507122703 (job
  // 132167730929, #91). In both, the app loaded normally (did-finish-load about 500 ms after start), the palette's
  // "Open file…" closed, and 30 s later the card still showed "No file open", with no tab and no notice on screen. Why the
  // open never started (the palette's Enter, the stubbed dialog, or the reader's pick before its open) is not yet found.
  {
    title: 'reading Rows by keyboard while the graph indexes keeps Rows when the Transcript becomes ready',
    os: 'darwin', reason: '"Open file…" from the palette opened nothing within 30 s', expires: '2026-12-13'
  }
]
