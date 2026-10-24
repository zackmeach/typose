// Plan §5's cold rows, judged on a batch: the first launch after each of five OS restarts (Z54), worst of the five.
// Each restart appends one `cold:startup` record (startup.perf.ts, COLD=1 RUNS=1), with the packaged build's sha256 and
// the OS boot time; this reads a batch's records back.
// - Shell visible < 200 ms on the PC, < 400 ms on the Mac.
// - Raw's first screen, open→usable, < 150 ms on the PC, measured from the open request, not from Z64's later start
//   (plan §7, PR 10: an argv open comes before the page's first frame, so from there it would time one frame); reported
//   on the Mac, where §13.1 sets no cold value.
// - launch→firstContent: informational (the restored-content gate is M2).
export const COLD_RUNS = 5
// ponytail: two records are one boot when their boot times (now − uptime) are within a minute; no restart is that quick.
const SAME_BOOT_MS = 60_000

/**
 * The cold verdicts for one file's records, on `platform`. The batch is the build of the run being judged (the last
 * record): its records with the same exe and asar sha256, one per OS boot (the first; a second run after the same
 * restart isn't cold, Z54). A record without a build or a boot can't be placed, so it isn't counted. Fewer than five
 * valid launches is pending.
 */
export function coldVerdict(records, platform = process.platform) {
  const mac = platform === 'darwin'
  const cold = records.filter((r) => r.key === 'cold:startup' && r.samples?.length)
  const build = cold.at(-1)?.build
  const boots = []
  const batch = cold.filter((r) => {
    const boot = Date.parse(r.boot)
    if (!build || r.build?.exe !== build.exe || r.build?.asar !== build.asar || Number.isNaN(boot)) return false
    if (boots.some((b) => Math.abs(b - boot) < SAME_BOOT_MS)) return false
    boots.push(boot)
    return true
  })
  // Only each record's first launch: a second launch after the same restart isn't cold (Z54).
  const firsts = batch.map((r) => ({ ...r.samples[0], exits: r.exits ?? r.samples[0].exits ?? [] }))
  const valid = firsts.filter((s) => s.valid)
  const exits = firsts.flatMap((s) => s.exits)
  const worst = (k) => (valid.length ? Math.max(...valid.map((s) => s[k])) : undefined)
  // An exit the test didn't ask for fails the batch (Z56); otherwise a verdict waits for five valid launches.
  const judge = (k, budget) => (exits.length ? 'fail' : valid.length < COLD_RUNS ? 'pending' : budget === undefined ? 'reported' : worst(k) < budget ? 'pass' : 'fail')
  return {
    n: valid.length,
    invalid: firsts.filter((s) => !s.valid).map((s) => s.reason),
    exits,
    shellVisible: { worst: worst('shellVisible'), threshold: mac ? 400 : 200, verdict: judge('shellVisible', mac ? 400 : 200) },
    openToUsable: { worst: worst('openToUsable'), threshold: mac ? 'reported' : 150, verdict: judge('openToUsable', mac ? undefined : 150) },
    firstContent: { worst: worst('firstContent'), verdict: judge('firstContent', undefined).replace('reported', 'informational') }
  }
}
