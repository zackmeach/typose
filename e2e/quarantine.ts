// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
// An entry is for a test that failed its try and its retry in one run, or was flaky in two runs. A test that is flaky
// once fails its job (failOnFlakyTests); re-run that job.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = [
  // Flaky on macOS again on 2026-11-16, in the release dry run 43807899478 (job 133102800850). It was flaky there in two
  // runs before (42898377896, 42898553765); #78 put that down to a cold first launch and added a warm-up launch. This
  // time the judged launch was the second: its first screen came 1,661.1 ms after the open, 6 ms after the scan of the
  // line ended (1,655.0 ms). The retry's came in 162.4 ms, against a scan of 492.5 ms. Not yet found: whether the first
  // piece can wait for the scan on a stalled runner, or both waited on the same stall.
  {
    title: "1 GiB on one line: the first piece shows before the scan passes the line's end, and more loads on demand",
    os: 'darwin', reason: 'the first screen came 6 ms after the scan of the line ended, on a warm launch', expires: '2026-12-15'
  }
]
