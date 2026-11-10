// Tests known to fail on CI, skipped until `expires` (an ISO date). An entry past its date fails the config load, so a
// quarantine is fixed or renewed on purpose, never forgotten. `os` is a process.platform value; omit it for every OS.
export const quarantine: { title: string; os?: NodeJS.Platform; reason: string; expires: string }[] = []
