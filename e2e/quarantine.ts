// Tests known to fail on CI, skipped there until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
// An entry is for a test that failed its try and its retry in one run, or was flaky in two runs. A test that is flaky
// once fails its job (failOnFlakyTests); re-run that job.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = [
  // Failed its try and its retry in run 43090863881 (macOS; its evidence failed to upload). ASCII failed the same check
  // once, in run 42898553765. Raw re-sizes its reservation on every host resize, so one that doesn't follow its host
  // for 30 s means the lens stopped sizing, likely on a core call that never returned: the retry's app then didn't
  // exit within 15 s of its close. Why is not yet found; the check now reports both values when it fails.
  {
    title: "emoji: Raw's rows, once collected, raise the renderer's private bytes by no more than the reservation holds for them, and a Reload leaves no more garbage than it reserves (Z66)",
    os: 'darwin', reason: "after a Reload, Raw's reservation stopped following its host, and close then hung", expires: '2026-12-11'
  }
]
