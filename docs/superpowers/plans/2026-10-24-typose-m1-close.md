# Typose M1 · Close summary

**Status:** M1's code is complete once [PR #17](https://github.com/zackmeach/typose/pull/17) (plan PR 6b, Raw rows ≤ 2,048 UTF-16 units, Z66) merges. Closure follows [Z65](docs/superpowers/specs/2026-10-20-typose-tech-design.md): record what is still open, don't chase it in M1, then start the first formatted lens (Z68).

**Implements:** spec §13.2's M1 row; M1 plan §3 "M1 close · Qualification run".

## Recorded gaps (debt)

Each item stays on the books until a later milestone or an explicit owner decision closes it.

- **Mac acceptance** on friends' Apple-silicon Macs (Z58, Z55).
- **Quiet-PC qualification pass** under Z49 (CPU < 10% for a minute before each timing run, load recorded, Defender on), on an unlocked, displayed session (Z67).
- **Cold batch after OS restarts** (Z54, Z67): five restarts per reference platform, build launched first after each restart.
- **macOS and Linux CI debt:** `main` has not been verified on macOS or Linux since PR 7 merged (`6f27e0a`) — macOS tests from PR 7 (traffic lights, native menu), PR 10 and later never ran on hosted macOS; the first Linux run after Actions minutes return may hit runner-image drift (`ubuntu-latest` → Ubuntu 26 from 2026-10-19).
- **Existing-profile cold instrument** for shell-visible startup (Z67; plan §7, PR 10 — `e2e/packaged.ts` still uses a new profile every launch).
- **`showInactive` −30 ms** (plan PR 10 review).
- **PR 6b CJK finding:** drawing text across all 20,901 CJK ideographs holds the renderer 3.7–7.3 s on odd PageDowns; cause unknown; carried to the frame gates.
- **Windows timing flakes:** `encoding::tests::a_random_megabyte_decodes_in_bounded_time` (5 s bound); `states.e2e.ts:115`; `long-line.e2e.ts:72`.
- **PR 9 informational product misses on the loaded PC:** first far jump after launch 75.3 ms; fetch p95 3.4 ms vs the 3 ms gate; open-then-scroll 50–62 ms; input latency while indexing with accessibility on.
- **Z37 not judged on Linux runners** (Z28, Z64).
- **M7 requirement (carried):** a non-batch entry point (`typose.ps1` or an exe shim), because `typose.cmd` from PowerShell can execute `a&b.txt`.
- **CI cost trims:** a test-hooks override of the 60 s respawn window; scoping `test:hooks`' `cargo run`.

## Open owner questions (recorded, not answered)

- **UNC via CLI/argv:** if a UNC path reaches SMB without a click, does that count as "the click"? (PR 8 review.)
- **D15 / spec §8.1 elevated launch:** elevated-launch text likely needs amending — an elevated launch probably does reach the non-elevated instance (PR 8).
- **M1 plan proposal 2:** after a second core death within 60 s, the core respawns unattended after 60 s, which could loop on a core that dies at every start.
- **Z62 key-repeat cadence:** 33 ms repeat answered at 45 ms reads every frame long; decide before qualification.
- **M1 plan §7 proposals 1, 3, 4, 5** (implicitly accepted, never explicitly): memory-refused open state; Raw wrapping deferred to M4; Raw a11y gutter pattern; no AppKit window restoration on macOS.
