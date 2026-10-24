// Plan §5's cold rows, judged on a batch: the first launch after each of five OS restarts (Z54), worst of the five.
// Each restart appends one `cold:startup` record (startup.perf.ts, COLD=1 RUNS=1); this reads a batch's records back.
// - Shell visible < 200 ms on the PC, < 400 ms on the Mac.
// - Raw's first screen, open→usable, < 150 ms on the PC, measured from the open request (plan §7: a cold launch has no
//   first-frame mark to start Z64's clock); reported on the Mac, where §13.1 sets no cold value.
// - launch→firstContent: informational (the restored-content gate is M2).
export const COLD_RUNS = 5

/** The cold verdicts for one batch's records (one file), on `platform`. Fewer than five valid launches is pending. */
export function coldVerdict(records, platform = process.platform) {
  const mac = platform === 'darwin'
  // Only each record's first launch: a second launch after the same restart isn't cold (Z54).
  const firsts = records.filter((r) => r.key === 'cold:startup' && r.samples?.length).map((r) => ({ ...r.samples[0], exits: r.exits ?? r.samples[0].exits ?? [] }))
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
