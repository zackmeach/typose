# Typose M1 · Close summary

**Status:** [PR #17](https://github.com/zackmeach/typose/pull/17) has merged (plan PR 6b, Raw's 2,048-unit row wrapping, Z66). M1's implementation is complete; qualification remains pending. Implementation closeout follows [Z65](../specs/2026-10-20-typose-tech-design.md): record what is still open, don't chase it in M1, then start the first formatted lens (Z68).

**Records:** implementation closeout and qualification debt for spec §13.2's M1 row and M1 plan §3 "M1 close · Qualification run". This summary does not claim that qualification ran or passed.

## Recorded gaps (debt)

Each item stays on the books until a later milestone or an explicit owner decision closes it.
Performance figures below are historical observations carried from prior M1 work and PM handoff notes, not fresh qualification measurements.

- **Mac acceptance** on friends' Apple-silicon Macs (Z58, Z55).
- **Quiet-PC qualification pass** under Z49 (CPU < 10% for a minute before each timing run, load recorded, Defender on), on an unlocked, displayed session (Z67).
- **Cold batches after OS restarts** (Z54, Z67; M1 plan §5): two batches per reference platform, each of five OS restarts, with one fixed build launched first after each restart. Batch A opens the 10 GiB file; batch B opens the 1 GiB file.
- **macOS and Linux CI debt (verified 2026-10-28):** current `main` remains unverified on both platforms. The latest `main-macos` [run 40316352834](https://github.com/zackmeach/typose/actions/runs/40316352834) (2026-10-26, `0a5df44`) could not start because of the billing/spending restriction; audit PR #22's [run 40701405511](https://github.com/zackmeach/typose/actions/runs/40701405511) also could not start.
  Last verified macOS success: [run 40100118868](https://github.com/zackmeach/typose/actions/runs/40100118868) at `2aba545` (2026-10-24). Last verified Linux success: [job 120946427143 in run 40101522797](https://github.com/zackmeach/typose/actions/runs/40101522797/job/120946427143) at `18d078d` (2026-10-24).
  The first Linux run after Actions minutes return may hit runner-image drift (`ubuntu-latest` → Ubuntu 26 from 2026-10-19); this is a risk, not a confirmed product failure.
- **Existing-profile cold instrument** for shell-visible startup (Z67; plan §7, PR 10 — `e2e/packaged.ts` still uses a new profile every launch).
- **`showInactive` −30 ms** (plan PR 10 review).
- **PR 6b CJK finding:** drawing text across all 20,901 CJK ideographs holds the renderer 3.7–7.3 s on odd PageDowns; cause unknown; carried to the frame gates.
- **Windows timing flakes:** `encoding::tests::a_random_megabyte_decodes_in_bounded_time` (5 s bound); `states.e2e.ts` — "the opening line's sweep holds still under reduced motion (brief §6.6, §9)"; `long-line.e2e.ts` — "1 GiB on one line: the first piece shows before the scan passes the line's end, and more loads on demand".
- **PR 9 informational product misses on the loaded PC:** first far jump after launch 75.3 ms; fetch p95 3.4 ms vs the 3 ms gate; open-then-scroll 50–62 ms; input latency while indexing with accessibility on.
- **Linux Z37 smoke may remain NOT JUDGED when a run is inconclusive; decisive failures still fail** (Z28, Z64; M1 plan §7, PR 10).
- **M7 requirement (carried):** a non-batch entry point (`typose.ps1` or an exe shim), because `typose.cmd` from PowerShell can execute `a&b.txt`.
- **CI cost trims:** a test-hooks override of the 60 s respawn window; scoping `test:hooks`' workspace `cargo test`.

## Open owner questions (recorded, not answered)

- **UNC via CLI/argv:** if a UNC path reaches SMB without a click, does that count as "the click"? (PR 8 review.)
- **D15 / spec §8.1 elevated launch:** elevated-launch text likely needs amending — an elevated launch probably does reach the non-elevated instance (PR 8).
- **M1 plan proposal 2:** after a second core death within 60 s, the core respawns unattended after 60 s, which could loop on a core that dies at every start.
- **Z62 key-repeat cadence:** 33 ms repeat answered at 45 ms reads every frame long; decide before qualification.
- **M1 plan §7 proposals 1, 3, 4, 5** (implicitly accepted, never explicitly): memory-refused open state; Raw wrapping originally deferred to M4, partly superseded by Z66's 2,048-unit rows; Raw a11y gutter pattern; no AppKit window restoration on macOS.
