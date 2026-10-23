> **Status: FROZEN, NOT CLOSED (2026-10-22, spec Z53).** This is the final text of plan B (scratch `PLAN-B.md`, sha256 `b8bf31ea618589cb…`; the text below this note is byte-identical to it). Its code is on branch `spike/b` (`d83508b`), tag `phase0-snap2/spike-b`. The last executed review (round 3) was APPROVE-WITH-FIXES, and its text fixes plus Z51/Z52 are folded in. Per Z53 there's no further review round.
> - **Open:** the Z52 far-jump G9 case fails today with accessibility on (55–188 ms). Open-then-scroll with accessibility off (up to 73 ms) is measured, not asserted. G4 has unexplained exits on record. Real screen-reader work is parked (Z39).
> - **Evidence:** `.evidence/phase0/snap2/MANIFEST.md`. Phase 0 isn't qualified.

# Typose Phase 0 · Spike B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build throwaway versions of every surface Spike B names, on plan A's harness. Then measure whether virtualized content stays accessible, against the spec's gates:
- a 1M×20 CSV Grid (24M px tall, so in logical scrolling) and a 5,000-column Grid;
- a Rows lens on the 10 GiB JSONL as a treegrid;
- a 20,000-block Rendered document with its Outline and long heading-free stretches;
- a 5,000-turn Transcript feed;
- React Aria tabs and a peek.

**Architecture:**
- **Pages:** each surface is its own renderer page (`grid`, `treegrid`, `doc`, `transcript`, `chrome`), built by electron-vite and picked at launch with `TYPOSE_PAGE`; `TYPOSE_ZOOM` sets the zoom a window opens at (Task B0). Every page reaches the core through plan A's port and RPC (`open`, `lines`, `rows`, `progress`).
- **Grid and Rows** (Tasks B1a–B1d): `role=grid` and `role=treegrid` on plan A's `ScrollState`, so the logical scrolling above 16M px is plan A's. The focused row stays mounted out of view, and keyboard focus waits for the target row's content.
- **Rendered and Transcript** (Tasks B2a–B2e): items in normal flow, with measured heights and `aria-hidden` spacers. Every heading stays mounted. A 500-item window follows the reader while Electron reports a screen reader (spec §6.2).
- **Chrome** (Tasks B3a–B3c): React 19 + React Aria own the card frame, the lens switch and the peek. Plan A's framework-free `LensView` owns the card body.

**Tech Stack:**
- **From plan A:** Electron 44.9.2, electron-vite 6.0.0, Vite 8.3.4, TypeScript 7.0.2, Vitest 5.0.5, Playwright 1.64.1; Rust 1.96 (edition 2024), napi 3.
- **Added here:** react 19.3.1, react-dom 19.3.1, react-aria-components 1.22.1, react-aria 3.53.1, @vitejs/plugin-react 6.1.2, axe-core 4.14.0, @axe-core/playwright 4.14.0 (all Task B3a); serde_json 1 as a `fixtures-gen` dev-dependency (Task B2a).
- **Accessibility probes:** Chromium's DevTools protocol (`Accessibility`, `DOM`, `Runtime`) through Playwright's `newCDPSession`, and Windows UI Automation through a PowerShell script (`UIAutomationClient`, .NET Framework 4.8).

**Spec:** `docs/superpowers/specs/2026-10-20-typose-tech-design.md` (Draft 4): §0.3 (Z31 to Z35; Z35 is superseded), §0.4 (Z39, Z40, Z51, Z52), §5.1–5.3, §6, §10.2, §13.1 Spike B. The design brief, revision 6, is `docs/superpowers/specs/2026-10-20-typose-design-brief.md`: §0.4, §0.5, §3.5, §4.5, §5.2–5.4, §6.5–6.6, §7.2, §7.4, §9.

**Phase 0 plan set:**
1. **Base harness + Spike A:** `2026-10-20-typose-phase0-base-and-spike-a.md`, closed at sha256 `982821e50781010f…` (commit `66da59d`). Its end state (Tasks 1–10) is this plan's starting state.
2. **Spike C:** `2026-10-20-typose-phase0-spike-c.md`, branched from `spike/a`.
3. **This plan:** Spike B, branched from `spike/a`.

**Plan A's Task 12** (the parallel indexer) is conditional, and this plan assumes it did not run. If Task 12 ran, add 1 to every `spike-core` test count below.

**Gates** (spec §13.1 Spike B), with the ids the tasks use. Before launch they are automated: their real-reader parts are parked (spec Z39), and this plan claims only what the automated gates show, not screen-reader support.

| Id | Gate | Where |
|---|---|---|
| G1 | 100% completion of the 20-task screen-reader script | **Parked (spec Z39):** Task B4 is not run before launch |
| G2 | Row and column position announced with totals | Tasks B1b, B1c: the `aria-*` positions and totals in the DOM, CDP and UIA trees; the announcement itself is parked (spec Z39); continuous browse-mode reading of the Grid and Rows is not a requirement (spec Z33) |
| G3 | Ctrl+End reaches the true last row | Tasks B1b, B1c |
| G4 | Zero skipped or duplicated positions across 1,000 rows × 100 columns | Task B1d |
| G5 | 2,000 consecutive blocks or turns read forward and backward, ≥ 4 window recenters each way, the element under the cursor never unmounted, no position lost | Task B2e, with a simulated reading cursor; a real reader's reading is parked (spec Z39) |
| G6 | Heading jumps, through the Outline and the heading key, land on headings outside the mounted window | Task B2e: the Outline, and a simulated heading key over the AX tree; a real reader's heading key is parked (spec Z39) |
| G7 | 100 peek open/close cycles with zero focus loss | Task B3c |
| G8 | Nothing unreachable at 200% zoom | Task B3c (chrome at 1280×800 and 720×480; Rendered and Transcript at 1280×800; Grid and Rows at 1280×800, at their first focus stop: each is one tab stop, and moving through the Grid at 200% is the parked S20 C1) |
| G9 | With accessibility on, ≤ 1% long frames during 10 s of auto-scroll; with accessibility on from launch, no stall over 50 ms on a far jump (spec Z52) | Tasks B1d, B2e; the far-jump case is Task B2e's, and it fails today (Checkpoint item 5) |

**Validated:**
- Each part was built and run in its own scratch lane on Zack's PC: every unit, e2e and perf test and both mutation checks of Task B3c. The Grid/Rows and Rendered/Transcript lanes also rebuilt their tasks from their text alone.
- A review of the merged plan found one blocker, four major and seven minor defects, and four nits. A fix lane fixed all but one nit (left as it is, by ruling), in code and in this text, and showed each new or changed check failing first: on the old code, or on a mutation that breaks what the check guards. Those mutations are the fix lane's; the plan's own are Task B3c's two.
- The fixed plan was then replayed literally in a fresh tree. In that replay Task B1d's G4 with accessibility on passed on its rerun after an unexplained mid-run exit, recorded in `REPLAY.md`, before the diagnostics existed, and the Task B2e runs on the loaded PC failed only G9's apply-time bound on the Transcript, which Task B2e Step 2 rules out by requiring a quiet PC.
- A second review approved that plan with fixes. Round 3 folds them in, with Zack's rulings since (spec Z39, Z40):
  - Task B1d's G4 runner records an exit's diagnostics, and an exit counts as a G4 failure;
  - G9 gains spec §10.2's 50 ms stall check, and its timing bounds are judged on a quiet PC;
  - G4's in-view check sees the sticky header row and row-number column;
  - a test pins the header's `#`;
  - Space no longer pages the Grid.

  The review's three findings on the screen-reader script are parked with it, not fixed (Checkpoint items, Parked). Each new check was shown to fail first:
  - the Space test on the old key handler, and on three narrower mutations;
  - the `#` test on a build that numbers the header row too;
  - G4 on a reveal that leaves cells under the row-number column;
  - the stall check on an injected 300 ms stall.

  G4's diagnostics recorded a window closed 30 s into a shorter snake: the close, the error line, the quit sequence and the exit code.
- The plan as it now reads was then replayed literally in a fresh tree. The base was plan A's Tasks 1–10, applied from plan A's fix-round text (`f55dac02…`), with Task 12 not run:
  - plan A's closed text (`982821e5…`) differs from that only in Task 10's runner, Task 11's report and its Notes, which this plan neither uses nor anchors;
  - the base restores the preserved lockfiles (Global Constraints): its tree equals that of tag `phase0-snap1/spike-a`.

  Task B4 was skipped, as an executor skips it. Every command a step names was run. Every `git add` left `git status` clean, apart from files a later task stages and the results file that later e2e runs rewrite (Task B1d Step 4).
- Every expected result below is one that replay printed, except numbers quoted as "the scratch run gave" and these, on a PC shared with other lanes (CPU sampled every 10 s):
  - Task B1d's G9 printed `18 passed` on its second full run. In the first, one run got 131 wheel events and failed the starvation guard, which makes it invalid by design.
  - Task B1d's G4 printed `3 passed` on its first run, armed, with no exit.
  - Task B2e first printed `9 passed` and `1 failed`: the Transcript's G9 failed the new stall check at 60.7 ms, and two reruns failed it at 60.6 ms. A trace showed the harness causing it: re-enabling accessibility in place (Checkpoint item 4).
- Round 3's follow-up then changed two tests:
  - G9's stress runs each launch fresh;
  - axe's `heading-order` blocks on the app's own headings, and is exempt only inside `main#doc`.

  Each was shown to fail first: the old G9 test fails its stall check, and the old axe test lets an out-of-order heading pass on the chrome page and outside `main#doc`. The changed tasks (B2e to B3c) were replayed literally again, from Task B2d's commit:
  - Task B2e printed `10 passed`, at 25% mean CPU. With each stress run in a fresh launch, the Transcript's stress runs peaked at 18.3 ms (apply 10.0 ms), and the Document's at 24.3 ms (apply 11.6 ms). The stall check still failed on the injected 300 ms stall (291.3 ms).
  - Task B3c's G7 mutation printed `Received: 25` once, and `24` on the rerun (Step 1 allows both).
  - One `npm run e2e` lost a test to the worker-crash flake (Global Constraints), and printed `37 passed` on the rerun.
- A fix check of round 3 approved it with fixes, all text. It found that any replacement of the whole accessibility window stalls, not only the toggle (Checkpoint item 5). It also corrected how the old G4 exits read (item 1) and the round-2 stalls (item 4), and listed three more parked questions.
- Zack then decided P5 and P6 (spec Z51, Z52), which changed code:
  - Rows follows the Grid's key model (Task B1c);
  - G9 gains a far-jump case with accessibility on from launch (Task B2e).

  The new Rows test was shown to fail first: on the old key handler, and on three narrower mutations (Chromium's own Space scroll, no IME guard, no child-control guard). The jump case fails today, as Z52 expects, and its control passes. The changed tasks (B1c to B3c) were replayed literally again, from Task B1b's commit, on a shared PC at 29% mean CPU (88% at most):
  - every step printed what the plan expects, with no stop and no rerun;
  - Task B1d's G4 printed `3 passed`, armed, with no exit;
  - Task B2e printed `10 passed` and `2 failed`: the two jump tests, each on `accessibility on` (Step 2 has the values). The stall check still failed on the injected 300 ms stall (297.2 ms);
  - Task B3c's `npm run e2e` printed `38 passed`.
- Every code block below is byte-identical to the file as its task committed it, or reproduces that file when applied as its step states to the file before.
- Not part of any replay: Task B4, parked (spec Z39; rounds 1 and 2 ran its Step 3 checks, round 3 skips it as an executor does), and the manual "look at it" steps.

Assembling and replaying the lanes found these defects in their text, all fixed below:
1. Each lane rewrote the `pages` list of `electron.vite.config.ts` with its own pages only, and Task B3a replaced the whole file with `['index', 'chrome']`. Every list now carries every earlier page.
2. Expected unit and e2e counts were per lane. They are cumulative now.
3. Task B2a's `main.rs` anchor ("below the `jsonl-huge-first` arm, before `other => panic!`") named two different places once Task B1a had added its arm.
4. Task B3c expected `spike-core`'s `18 passed; 1 ignored`: the lanes' copy of plan A also held a `doc.rs` and Task 12's indexer. Plan A's own count is 16 (14 before its Z37 amendment).
5. Each lane wrote its own screen-reader tasks. Task B4's 20-task script replaces them.
6. Two ranges Task B3c quoted from the lane's runs didn't hold in the replay: G7's probe sample count and axe's pass count. They now include what the replay printed.

## Global Constraints

- **Throwaway code.** Everything lives under `spikes/` on `spike/*` branches and is **never merged to `main`** (spec §13.1). The spike's output is its report and numbers, not the code.
- **Branch:** `spike/b` is cut from `spike/a` (Task B0, Step 1). Commit on it after each task.
- **Staging:** stage explicit paths only and never use `git add -A`. Never stage research files: `astra-research.md`, `fable-research.md`, `docs/research/`.
- **Rule 8 (standing procedure):** whoever writes a file reads the final on-disk version in full before calling the task done.
- **Private profiles:** every scripted launch from Spike B code passes its own `--user-data-dir`. Every spike runs as `spike-app`, and Chromium persists per-host page zoom in the shared `%APPDATA%\spike-app` profile: a 200% zoom left there by any run halves wheel steps and rows per screen in every later one. The Grid/Rows and Rendered/Transcript harnesses also refuse to measure at any zoom but 100%; the chrome harness starts every launch in a fresh profile and deletes it when the app closes. Plan A's own three e2e tests (`roundtrip`, `open`, `shell`) still launch in the shared profile; they neither read nor set the zoom. So do the manual launches (`npx electron .`) of the "look at it" steps, and would those of the parked Task B4's S01–S19 (spec Z39); its S20 opens at 200% with `TYPOSE_ZOOM=2` in a fresh profile, because a zoom persisted in a profile wins over the knob (Task B0).
- **No inherited `TYPOSE_*`:** every harness drops `TYPOSE_*` variables from the environment it launches with, then sets its own.
- **Gate thresholds:** as in plan A. On Zack's PC they are half the budget, unless marked **Mac**, which uses the full budget (spec Z29, §10.2). A long frame is an rAF interval over 20 ms (plan A's `frameStats`).
- **Measurements on a shared machine:** the numbers quoted as "the scratch run gave" come from a PC busy with other work. They are what to expect, not pass criteria. The pass criteria are the gates.
- **Screen readers:** no automated check reaches what NVDA (IAccessible2) announces. The automated gates read the DOM, Chromium's accessibility tree (CDP) and Windows UI Automation (what Narrator consumes). No person listens before launch: screen-reader validation is parked until after launch (spec Z39), and Task B4 with it. So this plan claims what the automated gates show, not screen-reader support.
- **The Grid and Rows have no wide reading window, per spec §5.3 and §6.2 (Z33).** The wide window is for Rendered and Transcript only. The Grid and Rows keep one viewport of overscan each way in every mode (about 94 rows mounted at the default window) and move by the page's own keys, which load the target before moving focus. Every data cell must be reachable that way; continuous "read all" across the Grid and Rows is not a v1 requirement. Browse-mode table reading (say-all, NVDA's Ctrl+Alt+arrows) runs out of mounted rows within about a screen and a half, so the parked Task B4 tests them in focus mode only.
- **Input starvation is invisible to the frame metric.** A long frame is the page's own work. A run whose input stalls before it reaches the page (lane B1 once saw 48 wheel events in 10 s, unreproduced) has an idle page and clean frames. Task B1d's G9 requires at least 200 wheel events per run; Task B2e's auto-scroll has no input to starve.
- **A rare stall in accessibility-mode e2e tests.** Under contention, lane B2 saw `a11y-mode` e2e test 2 stall for minutes, twice in about 12 full runs; once it hung in `app.close()` (main alive, no children). A probe measured close at 0.12–13.1 s with accessibility on (n=6) and 0.07–3.8 s off (n=6). Unresolved. If a run hangs there, stop that test's Electron tree and rerun.
- **G9 measures Electron's accessibility support, not a screen reader.** "Accessibility on" is `app.setAccessibilitySupportEnabled(true)`: Chromium builds and serializes the whole accessibility tree, as it does for a screen reader. But no reader runs, so its own cost (NVDA's IA2 queries and virtual buffer, Narrator's UIA queries) is not in the number. A frame measurement with a reader running is parked with the rest of screen-reader validation (spec Z39; Checkpoint items, Parked).
- **A UIA client reading the Grid during fast key input coincided with app exits.** With UIA read every 100 snake rows, G4 with accessibility on exited mid-run in 2 of 4 runs (`Target page, context or browser has been closed`; unarmed, so no dump could be written) and the runs that finished took 610 s and 852 s against 364–435 s without. Narrator is such a client. Unexplained; a Narrator-on G4 run is parked (spec Z39). The round-2 replay then saw the same exit in 2 of its 5 accessibility-on G4 runs with UIA read only at the end of the run (1.3 and 1.9 min in, at a burst wait; no Application Error or WER event), and each rerun passed. So the test's own mid-run reads don't explain the exits; another UIA client on the shared machine was not ruled out. Such an exit is a G4 failure, not noise: keep `spikes/.fixtures/g4-diag-<key>.log` (exit code, Electron log, child and render process exits, Crashpad reports under `.fixtures/b1-userdata/Crashpad/reports`) and the Application event log for the minutes around it (PowerShell: `Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001, 1002, 1005; StartTime = (Get-Date).AddMinutes(-30) }`), add them to Checkpoint item 1, then rerun to finish the measurement. A passing rerun doesn't cancel the failure: it is investigated before G4 closes. Run G4 with no desktop automation or other UIA client on the session. It is not the worker crash (the worker goes on to the next test) and not a timeout; ten armed runs in the round-2 review did not reproduce it.
- **A rare e2e flake:** 2 of round 1's 15 replayed runs of `npm run e2e` and 1 of round 2's 22 lost one test to `Error: worker process exited unexpectedly (code=3221226505, signal=null)` as the test started; round 2 also saw it once in a single-file run. Playwright's worker process died with a fail-fast exit, and left that test's Electron window running (and, for a chrome test, its `typose-chrome-profile-*` in `TEMP`). The cause wasn't found. Close the stray window and rerun the suite.
- **Commands:** they work in PowerShell and in Git Bash unless a step gives both forms. Run them from the directory each step names.
- **Lockfiles:** Replays restore the preserved lockfiles (tag `phase0-snap1/spike-a`, spec Z41); a fresh resolve on 2026-10-22 picked napi 3.15.0.
- **Fixtures** go in `spikes/.fixtures/` (gitignored): plan A's `1g.jsonl` and `10g.jsonl`, and this plan's Grid, document and transcript fixtures (Tasks B1a, B2a), about 270 MB.

## Checkpoint items

What this plan leaves open for the Phase 0 checkpoint:
1. **G4 with accessibility on exited mid-run, unexplained.** Four exits are on record, each `Target page, context or browser has been closed` at a burst wait, 1.3 to 2.2 min in: 2 of 4 runs with UIA read every 100 rows, and 2 of the round-2 replay's 5 runs with UIA read only at the end. Each rerun passed. Each exit is a G4 failure that the passing rerun doesn't cancel (Global Constraints), and G4 doesn't close until it is investigated. Ten armed runs (round-2 review: full length, 10× the CDP sampling, and an external UIA client reading the window every second) did not reproduce it; the four exits on record read 'closed' and left no WER event. That doesn't rule out a crash: an unarmed main-process crash reads the same and leaves no event (round-3 fix check). Armed, the diagnostics tell a window close, a renderer crash and a main-process crash apart. The round-3 fix check injected each one:
   - a window close logged `window close` and the shell's exit code 0;
   - a renderer crash logged `render-process-gone` and `Target crashed`;
   - a main-process crash logged exit code 3221225477, main gone, and a Crashpad report.

   Round 3's replay ran G4 armed: 3 of 3 runs passed, with no exit, at 18% mean CPU (42% at most) and no Crashpad report.
2. **Tab can outrun the window.** At 200%, with no pause between presses, Tab from the third Transcript article wrapped to the first: the normal window mounts about three tall turns and the next one's fetch hadn't landed. Task B3c's 200% checks Tab at a person's pace, so they pass.
3. **React Aria's bundle,** about 1 MB minified (Task B3a): a cold-start budget question (spec §10), not measured here.
4. **G9's timing checks are judged on a quiet PC** (Task B2e Step 2; spec Z49).
   - Loaded runs failed the apply-time bound on the Transcript only (17.9 to 24.1 ms). Load is the suspected cause, not a proven one: the quiet-PC runs decide. The frame each recenter landed in was never long (6 to 18 ms rAF gaps).
   - Round 2's 42 to 134 ms stalls were in G9 tests that re-enabled accessibility in place (below); load may have lengthened them.
   - **The 60.6 ms stall that round 3 found was the harness, not recenter cost.** At low load, round 3's replay and two reruns of the Transcript's G9 stalled 60.6 to 60.7 ms, every time, in the second stress run with accessibility on. That run began right after the test re-enabled accessibility in place and put the view back at the top.
   - A trace of that run (Electron's `contentTracing`) shows one 78.3 ms task 0.14 s into it, almost all accessibility-tree serialization:
     - `SerializeLifecycleStage` 49.4 ms;
     - `RenderAccessibilityImpl::SendPendingAccessibilityEvents` 17.9 ms;
     - `ProcessDeferredUpdatesLifecycleStage` 9.5 ms.
   - In fresh launches with accessibility on from the start, the same stress run never stalled while scrolling continuously: its longest gap was 18.2 to 24.4 ms in 3 launches, and 30.4 ms for a second run in the same launch.
   - The recenters themselves take 25 to 30 ms frames in every trace, also mostly serialization (15 to 18 ms of `SerializeLifecycleStage`).
   - So each stress run now gets a fresh launch (Task B2e Step 1). In round 3's follow-up replay, at 25% mean CPU, both surfaces passed: the Transcript's stress runs peaked at 18.3 ms, and the Document's at 24.3 ms. The failing runs are kept in `REPLAY.md` as evidence. The quiet-PC qualification is still pending (spec Z49).
5. **Far jumps stall with accessibility on, so G9's jump case fails today (spec Z52: a Phase 0 finding).** A far jump replaces the whole window: a scrollbar jump, an Outline jump, or open-then-scroll. With accessibility on, the renderer then serializes the whole 500-item window at once. Z52 puts far jumps under spec §10.2's "no stall > 50ms", so Task B2e has a jump case per surface: with accessibility on from launch, neither the open run nor the jump run may stall over 50 ms. It fails on both surfaces. The bound isn't loosened, and no product code changes to chase it. Bringing far jumps under budget, for example by replacing the window in smaller pieces, is milestone work (spec Z52).
   - Five runs of the jump case (four in a sandbox, then the replay's), on a shared PC at 29 to 34% mean CPU. With accessibility on, the longest gap per run was:
     - Transcript: 97.1 to 158.0 ms in the open run, and 103.1 to 188.2 ms in the jump run;
     - Document: 54.6 to 91.0 ms in the jump run. In the open run it was 91.1 to 109.2 ms in 4 runs and 18.2 ms in 1: whether the first window's serialization falls inside the measured run varies.
   - Where the gaps fall: one probe run of the same jumps, at 31% mean CPU, recorded each gap's time (`REPLAY.md`):
     - Transcript: the scrollbar jumps 78.9 to 85.0 ms, the `goTo` jumps 103.2 and 151.6 ms;
     - Document: the scrollbar jumps 42.5 to 48.6 ms, the `goTo` jumps 66.7 and 48.5 ms.

     So the Transcript fails on every jump, and the Document on an Outline jump and, in most runs, on opening.
   - The control passes: with accessibility off, the jump runs peaked at 6.2 to 18.2 ms in the five runs. That shows the check can pass.
   - **Opening stalls with accessibility off too.** With accessibility off, the open run's longest gap was 24.4 to 72.8 ms on the Transcript (over 50 ms in 2 of 5 runs) and 36.4 to 48.6 ms on the Document. The gap comes in the first frames after the file opens. So open-then-scroll has a cost besides accessibility, and Z52's "12ms with it off" holds for the jumps, not for opening. The round-3 fix check saw the same frame after opening `10g.jsonl`, 67 to 73 ms with accessibility on and off alike. Spec §10.2's budget covers scrolling with accessibility on or off, but Z52's gate, and so this case, asserts accessibility on only. The case saves the open run with accessibility off without asserting it, so no gate covers that stall.
   - The round-3 fix check's measurements, which Z52 cites (fresh launches, 12 to 27% mean CPU):
     - Transcript, far scrollbar jumps (to 50%, 90% and 10%) after indexing: 78.7 to 85.0 ms, every jump over 50 ms; 12.1 ms at most with accessibility off;
     - Transcript, open and then scroll at once: 103 ms;
     - Document, Outline-style `goTo` jumps: 55 to 61 ms; its scrollbar jumps 42.4 to 42.6 ms.

     Z52's "55–103ms" is that range. The Transcript went higher in the runs above: up to 158.0 ms opening and 188.2 ms in a jump run, with its `goTo` jumps at 103.2 and 151.6 ms in the probe.
   - The toggle is the same work. Turned on in place, as G9's 2,000 px/s runs do, it costs 79 to 91 ms on the Transcript after the first toggle, and once 60.7 ms after a later one (36 to 43 ms on the Document).
   - Traced, each Transcript jump is one renderer-main task of 87.9 to 91.9 ms, the toggle's profile (91.2 ms after the first toggle):
     - `SerializeLifecycleStage` 57.4 to 59.7 ms (toggle: 60.0 ms);
     - `RenderAccessibilityImpl::SendPendingAccessibilityEvents` 19.3 to 20.5 ms (toggle: 19.7 ms);
     - `ProcessDeferredUpdatesLifecycleStage` 10.2 to 10.8 ms (toggle: 10.6 ms).
   - A reader running at launch turns accessibility on from the start, so its user meets this on every far jump. G9's other runs don't: they scroll continuously, and their recenters are incremental (item 4). The 2,000 px/s runs record the toggle's frame but don't assert it.
6. **P5 is decided: Rows follows the Grid's key model (spec Z51).** Space and Shift+Space move nothing in Rows, and Chromium's own Space scroll is prevented; Page Up/Down page. A focused child control and IME composition keep their keys, with the Grid's known limitation (Task B1b). What stays open is selection: Shift+Space selects the row in the product, and that is the Rows milestone's acceptance test (M3, Task B1c).

**Parked (spec Z39).** These need a real screen reader, so they wait for the expansion after launch:
- **A Narrator-on G4 run.** With a UIA client reading the tree every 100 rows, G4 with accessibility on exited mid-run in 2 of 4 runs and ran 1.5–2× slower (Global Constraints).
- **Task B4's speech-log check on a real NVDA log.** It was validated on synthetic logs built from the fixtures, not on a real one. It relies on NVDA's Speech viewer keeping the text's case and punctuation (`(block 5508)`); if the viewer spells symbols out, heading numbers are missed and show as breaks: a false fail, never a false pass.
- **A frame measurement with a screen reader running.** G9 measures Electron's accessibility support, not a reader's own cost (Global Constraints).
- **The round-2 review's findings on the script, parked unfixed:**
  - MAJOR 1: on Narrator and VoiceOver, S11 and S12 have no instrument that can fail them; a block lost between the first and last numbers goes unheard.
  - MINOR 2: the speech-log check passes a start marker set too late, and an S13 whose heading key did nothing.
  - MINOR 3: Z35's shorter milestone test is named, not defined.
- **Spec §6.2's edge-control decision.** The spec leaves it to Spike B to decide whether the edge controls are needed, as the fallback for a screen reader that doesn't scroll. Only a real reader can decide that. The plan builds the controls (Task B2b) and tests them mechanically (Tasks B2c and B2d), but the decision is parked.
- **P4.** Does a screen-reader-driven scroll-into-view in logical scrolling read as a proportional jump (×1.5 at 1M rows, about ×80 at 50M)? It is named only in the parked script (S05).
- **G5's premise.** The simulated cursor stands in for a reader scrolling its cursor into view (Task B2e). Whether NVDA, Narrator and VoiceOver do that in browse mode is what the parked run would show.

---

## File Structure

```
spikes/
  core/fixtures-gen/src/lib.rs          + csv_grid() (B1a), pub mod docs (B2a)
  core/fixtures-gen/src/docs.rs         doc(), transcript(): block-model document and transcript fixtures (B2a)
  core/fixtures-gen/src/main.rs         + kinds csv-grid (B1a), doc, transcript (B2a)
  core/fixtures-gen/tests/docs.rs       (B2a)
  app/package.json                      + React, React Aria, axe (B3a)
  app/electron.vite.config.ts           one renderer entry per page (B0); React's plugin (B3a)
  app/src/main/index.ts                 TYPOSE_PAGE, TYPOSE_ZOOM (B0); accessibility support → renderer, TYPOSE_A11Y (B2c)
  app/src/preload/index.ts              + forwards 'a11y' to the main world (B2c)
  app/src/renderer/grid.html, treegrid.html, doc.html, transcript.html, chrome.html
  app/src/renderer/src/grid/            nav, viewport, row-source, grid, boot, main, grid.css (B1b)
  app/src/renderer/src/treegrid/        outline, treegrid, main, treegrid.css (B1c)
  app/src/renderer/src/a11y/            window-math, flow-window, mode, flow.css (B2b)
  app/src/renderer/src/doc/             blocks, main: the Rendered lens and its Outline (B2b)
  app/src/renderer/src/transcript/      main: the Transcript feed (B2d)
  app/src/renderer/src/chrome/          docs, lenses, LensBody, Card, Peek, App, main, chrome.css (B3a, B3b)
  app/e2e/zoom.e2e.ts                   (B0)
  app/e2e/b1-harness.ts, uia-element.ps1, grid.e2e.ts, treegrid.e2e.ts             (B1b, B1c)
  app/e2e/flow-launch.ts, doc.e2e.ts, a11y-mode.e2e.ts, transcript.e2e.ts          (B2b–B2d)
  app/e2e/chrome-launch.ts, chrome.e2e.ts, chrome-g7.e2e.ts, chrome-g8.e2e.ts, chrome-axe.e2e.ts   (B3a–B3c)
  app/perf/spike-b1.e2e.ts              G4 traversal and G9 frames: Grid and Rows (B1d)
  app/perf/spike-b2.e2e.ts              G5, G6, G9 and the AX findings: Rendered and Transcript (B2e)
  tools/chrome-fixtures.mjs             the chrome page's two small JSONL files (B3a)
  results/spike-b1-<host>.json, spike-b2-<host>.json
  results/sr-script.md, sr-results.md, sr-nvda-<task>.txt   the 20-task screen-reader script and its results (B4: parked, spec Z39; not created in Phase 0)
```

---

## Task B0: One renderer page per surface, picked with TYPOSE_PAGE; a zoom knob

**Files:**
- Modify: `spikes/app/electron.vite.config.ts` (full replacement below)
- Modify: `spikes/app/src/main/index.ts` (one line added, two replaced)
- Test: `spikes/app/e2e/zoom.e2e.ts`

**Interfaces:**
- **Consumes:** plan A Task 1's `electron.vite.config.ts`; plan A Task 8's `main/index.ts`, which loads `typose://app/index.html` and appends `?open=&lens=` from `TYPOSE_OPEN` / `TYPOSE_LENS`.
- **Produces:**
  - `electron.vite.config.ts`: `const pages`, one renderer entry per name (`src/renderer/<name>.html`, built to `out/renderer/<name>.html`). Later tasks change only that line, except Task B3a, which replaces the file to add React's plugin.
  - main: `TYPOSE_PAGE=<name>` loads `typose://app/<name>.html`; unset, it loads `index.html` as before. `TYPOSE_OPEN` still becomes `?open=`.
  - main: `TYPOSE_ZOOM=<factor>` is the page zoom the window opens at (`webPreferences.zoomFactor`); unset, or anything but a number in (0, 5], 1.

**Design notes:**
- **Why a zoom knob.** The window is frameless (plan A Task 8), so Electron's default menu and its Ctrl+= accelerator can't be relied on to zoom. Task B3c's 200% checks of the Grid, Rows, Rendered and Transcript pages launch with `TYPOSE_ZOOM=2` instead, as the parked screen-reader task S20 would (Task B4).
- **The knob is a default, not a per-host setting.** Chromium persists a page zoom set at runtime (`setZoomFactor`, Ctrl+=) per host in the profile, and that persisted zoom wins over the knob. The second test pins this: it reopens a profile holding 200% with `TYPOSE_ZOOM=1`. So the knob is only reliable in a fresh or private profile.
- **No test for the page switch here.** Until a second page exists, nothing a test can see changes. Task B1b's Grid e2e test is the first to use it. It fails at Task B1b Step 3 because `grid.html` doesn't exist yet, so the page is a 404. Without this task, main would load `index.html` instead and the failure would be a different one.

- [ ] **Step 1: Create the branch**

Run (repo root):
```bash
git switch -c spike/b spike/a
```

- [ ] **Step 2: Write the failing zoom test**

`spikes/app/e2e/zoom.e2e.ts`:
```ts
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'typose-zoom-'))

/** Launches plan A's page in `profile` with no inherited TYPOSE_* but `env`, reads its zoom, optionally sets 200%, and closes it. */
async function open(profile: string, env: Record<string, string> = {}, plant = false) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...base, ...env } as Record<string, string> })
  const win = await app.firstWindow()
  await expect(win.locator('#status')).toHaveText('core 0.0.0', { timeout: 30_000 })
  const zoom = await app.evaluate(({ BrowserWindow }, plant) => {
    const w = BrowserWindow.getAllWindows()[0]
    const read = { factor: w.webContents.getZoomFactor(), contentWidth: w.getContentSize()[0] }
    if (plant) w.webContents.setZoomFactor(2) // Chromium persists this per host (typose://app) in the profile
    return read
  }, plant)
  const innerWidth = await win.evaluate(() => innerWidth)
  await app.close()
  return { ...zoom, innerWidth }
}

test('TYPOSE_ZOOM is the zoom a window opens at; unset or not a zoom factor, it is 100%', async () => {
  const z2 = await open(fresh(), { TYPOSE_ZOOM: '2' })
  const z1 = await open(fresh())
  const typo = await open(fresh(), { TYPOSE_ZOOM: 'abc' })
  expect(z2.factor).toBe(2)
  expect(Math.abs(z2.innerWidth - z2.contentWidth / 2)).toBeLessThan(1) // CSS px: half the window's content width
  expect(z1.factor).toBe(1)
  expect(Math.abs(z1.innerWidth - z1.contentWidth)).toBeLessThan(1)
  expect(typo.factor).toBe(1) // not NaN, which opens at Chromium's maximum zoom
})

test('a zoom persisted in the profile wins over the knob: TYPOSE_ZOOM is reliable only in a fresh profile', async () => {
  const profile = fresh()
  await open(profile, {}, true)
  expect((await open(profile, { TYPOSE_ZOOM: '1' })).factor).toBe(2)
})
```

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e zoom`
Expected: FAIL, `1 failed`, `1 passed`. The first test fails at `expect(z2.factor).toBe(2)` with `Expected: 2` and `Received: 1`: main doesn't read `TYPOSE_ZOOM` yet. The second passes already: it pins Chromium's own precedence.

- [ ] **Step 3: One renderer entry per page**

Replace `spikes/app/electron.vite.config.ts`:
```ts
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// One renderer entry per page; TYPOSE_PAGE=<key> loads typose://app/<key>.html.
const pages = ['index']

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: Object.fromEntries(pages.map((p) => [p, resolve(__dirname, `src/renderer/${p}.html`)]))
      }
    }
  }
})
```

- [ ] **Step 4: Let main pick the page and the zoom**

In `spikes/app/src/main/index.ts`, add directly below the line `  const isMac = process.platform === 'darwin'`:
```ts
  const zoom = Number(process.env.TYPOSE_ZOOM) // NaN when unset or a typo
```
Inside `webPreferences`, replace the line `      spellcheck: false` with:
```ts
      spellcheck: false,
      // TYPOSE_ZOOM=2 opens at 200% (Task B4). A default only: a zoom persisted per host in the profile wins over it.
      // Anything but a factor in (0, 5] opens at 100%: NaN would open at Chromium's maximum, 500%.
      zoomFactor: zoom > 0 && zoom <= 5 ? zoom : 1
```
Then replace the line `  const url = new URL('typose://app/index.html')` with:
```ts
  // TYPOSE_PAGE picks a renderer page (Spike B surfaces); every page is an entry in electron.vite.config.ts.
  const url = new URL(`typose://app/${process.env.TYPOSE_PAGE ?? 'index'}.html`)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e zoom`
Expected: the build lists `out/renderer/index.html`; `2 passed`.

Run: `npm run e2e`
Expected: `5 passed` (plan A's 3 + these 2).

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/app/electron.vite.config.ts spikes/app/src/main/index.ts spikes/app/e2e/zoom.e2e.ts
git commit -m "spike(b): one renderer page per surface (TYPOSE_PAGE) and a default zoom (TYPOSE_ZOOM)"
```

---

## Grid and Rows (Tasks B1a–B1d)

Tasks B1a–B1d build on plan A Tasks 1–10 and Task B0:
- `scrollmath.ts`: `ScrollState`, `isLogical`, `spacerHeight`, `wheelPixels`, `visibleRows`;
- `core.ts` (`Core`, `connectCore`), `perf.ts` (`PerfLog`, `percentile`);
- the RPC methods `open`, `lines`, `rows`, `version` and the `progress` event;
- main's page switch (Task B0): `TYPOSE_PAGE=<name>` loads `typose://app/<name>.html`, `TYPOSE_OPEN=<path>` adds `?open=<path>`, and `electron.vite.config.ts` builds one renderer entry per name in `pages`.

**Spike simplifications** (known ceilings):
- The CSV is **unquoted**: no quotes, no embedded delimiters or newlines. Grid rows come through the existing `lines` RPC and are split on `,` in the renderer. Quoted CSV and the CSV record index are Spike C's.
- A Grid row is one line of at most 64 KiB (`MAX_PIECE`). The widest fixture line is 53,892 bytes.
- Columns have a fixed width (120 px); auto-fit (brief §5.3) is M1 work.
- Rows expands one level: a line's top-level keys, with nested values shown as compact JSON.
- Rows totals come from the core's index, never from a constant. The gates run on whatever `spikes/.fixtures/10g.jsonl` holds (plan A Task 2: 53,687,092 lines; the scratch runs used a 1.2 GiB stand-in of 6,442,451 lines). `JSONL_FIXTURE=<path>` points the tests at another file.

**ARIA model** (spec §6.1, §6.2):
- **Grid:** `role=grid`.
  - `aria-rowcount` is the line count including the header line; `aria-colcount` is the CSV column count + 1. Both are `-1` until known: the row count until indexing is done, the column count until the header line loads.
  - ARIA row *r* is file line *r* − 1 (0-based), so row 1 is the header row and the first data record is row 2: `aria-rowindex` is positional. The row-number column shows the record number (spec Z31): 1 for the first data record, so *r* − 1. B1 splits unquoted CSV, where a record is a line; real record numbering is Spike C's record index (C3). Under sorting the number stays the record's (sorting isn't in this spike), and Raw keeps the physical source lines.
  - ARIA column 1 is the row-number column: a `rowheader` in each data row, a `columnheader` ("#") in the header row. CSV column *k* is ARIA column *k* + 1, so the first CSV column is ARIA column 2 (spec Z32).
- **Rows:** `role=treegrid`; rows are the focus unit.
  - A top-level row is a line: `aria-level=1`, `aria-posinset` = line + 1, `aria-setsize` = the line total, or `-1` while indexing.
  - An expanded line's keys follow it as `aria-level=2` rows with their own `aria-posinset`/`aria-setsize`.
  - `aria-rowcount` counts visible rows (lines + shown children), `-1` while indexing.

**What each accessibility layer exposes** (measured in Tasks B1b–B1d; Electron 44.9.2 on Windows 11 26200):

| Layer | role, name, focused | level | expanded | row/col index, row/col count | posinset, setsize |
|---|---|---|---|---|---|
| CDP `Accessibility.getPartialAXTree` (the browser's own tree) | yes | yes | yes | **no** | **no** |
| Windows UI Automation (the platform tree Narrator reads) | yes | not readable from the .NET client | yes (ExpandCollapse) | **yes**: GridItem Row/Column, Grid RowCount/ColumnCount (0-based indices) | **yes**: PositionInSet/SizeOfSet |
| Playwright `ariaSnapshot()` | computed from the DOM by Playwright, not read from the browser, so it proves nothing about the AX tree | | | | |

So the tests check positions and totals in the DOM **and** in the UIA tree, and role, name, focus and level in the CDP tree. NVDA reads IAccessible2, which no automated check here reaches; the manual script (Task B4) would cover it, and is parked (spec Z39). On macOS `uiaByName` returns `null` and those assertions are skipped.

---

## Task B1a: CSV grid fixtures

**Files:**
- Modify: `spikes/core/fixtures-gen/src/lib.rs` (add `csv_grid` and its test)
- Modify: `spikes/core/fixtures-gen/src/main.rs` (add the `csv-grid` subcommand)

**Interfaces:**
- **Produces:**
  - `fixtures_gen::csv_grid<W: Write>(w: &mut W, rows: u64, cols: u32) -> io::Result<u64>`. It writes a `col1,…,colN` header line, then `rows` lines whose cells read `r<row>c<col>` (1-based), and returns the line count including the header.
  - CLI: `fixtures-gen csv-grid --out <path> [--rows N] [--cols N]` (defaults: 1,000,000 rows × 20 columns).
  - Fixtures:
    - `spikes/.fixtures/grid-1m-x20.csv`: 1,000,001 lines, 208,778,031 bytes. At 24 px rows it is 24,000,024 px tall, so it scrolls logically.
    - `spikes/.fixtures/grid-1k-x5000.csv`: 1,001 lines, 48,396,893 bytes; its longest line is 53,892 bytes.

- [ ] **Step 1: Write the failing test**

In `spikes/core/fixtures-gen/src/lib.rs`, add this test inside `mod tests`, directly below `use super::*;`, with a blank line before and after it:
```rust
    #[test]
    fn csv_grid_is_unquoted_with_a_header_row() {
        let mut out = Vec::new();
        assert_eq!(csv_grid(&mut out, 3, 2).unwrap(), 4);
        assert_eq!(String::from_utf8(out).unwrap(), "col1,col2\nr1c1,r1c2\nr2c1,r2c2\nr3c1,r3c2\n");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: FAIL to compile with ``error[E0425]: cannot find function `csv_grid` in this scope``.

- [ ] **Step 3: Implement the generator and the subcommand**

In `spikes/core/fixtures-gen/src/lib.rs`, add directly above `#[cfg(test)]`, followed by a blank line:
```rust
/// Unquoted CSV: a `col1..colN` header, then `rows` records whose cells read `r<row>c<col>` (1-based).
/// No field contains a quote, comma or newline; quoted-CSV parsing is Spike C's job. Returns the line count, header included.
pub fn csv_grid<W: Write>(w: &mut W, rows: u64, cols: u32) -> io::Result<u64> {
    for r in 0..=rows {
        for c in 1..=cols {
            let sep = if c > 1 { "," } else { "" };
            if r == 0 { write!(w, "{sep}col{c}")? } else { write!(w, "{sep}r{r}c{c}")? }
        }
        w.write_all(b"\n")?;
    }
    Ok(rows + 1)
}
```
In `spikes/core/fixtures-gen/src/main.rs`, add this arm directly above `other => panic!("unknown fixture kind {other:?}"),`:
```rust
        Some("csv-grid") => {
            let n = fixtures_gen::csv_grid(&mut w, num("--rows", 1_000_000), num("--cols", 20) as u32)?;
            eprintln!("{out}: {n} lines");
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: `3 passed`.

- [ ] **Step 5: Generate the Grid fixtures**

Run (`spikes/core`):
```bash
cargo run --release -p fixtures-gen -- csv-grid --rows 1000000 --cols 20 --out ../.fixtures/grid-1m-x20.csv
cargo run --release -p fixtures-gen -- csv-grid --rows 1000 --cols 5000 --out ../.fixtures/grid-1k-x5000.csv
```
Expected:
- `../.fixtures/grid-1m-x20.csv: 1000001 lines`
- `../.fixtures/grid-1k-x5000.csv: 1001 lines`

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/core/fixtures-gen/src
git commit -m "spike(b): unquoted CSV grid fixtures, 1M×20 and 1k×5000"
```

---

## Task B1b: Grid — role=grid on logical scrolling, horizontal virtualization, roving focus

**Files:**
- Create: `spikes/app/src/renderer/src/grid/nav.ts`, `spikes/app/src/renderer/src/grid/nav.test.ts`
- Create: `spikes/app/src/renderer/src/grid/viewport.ts`, `spikes/app/src/renderer/src/grid/row-source.ts`, `spikes/app/src/renderer/src/grid/grid.ts`, `spikes/app/src/renderer/src/grid/boot.ts`, `spikes/app/src/renderer/src/grid/main.ts`, `spikes/app/src/renderer/src/grid/grid.css`
- Create: `spikes/app/src/renderer/grid.html`
- Modify: `spikes/app/electron.vite.config.ts` (add the `grid` page)
- Test: `spikes/app/e2e/b1-harness.ts`, `spikes/app/e2e/uia-element.ps1`, `spikes/app/e2e/grid.e2e.ts`

**Interfaces:**
- **Consumes:**
  - plan A: `ScrollState`, `isLogical`, `spacerHeight`, `wheelPixels`, `visibleRows` (`scrollmath.ts`); `Core`, `connectCore` (`core.ts`); `PerfLog` (`perf.ts`);
  - the RPC methods `open {path} → {doc, size}`, `lines {doc, start, count} → JsLine[]`, `version`, and the `progress` event;
  - main's `TYPOSE_PAGE` (Task B0) and `TYPOSE_OPEN` (plan A Task 8);
  - the Task B1a fixtures.
- **Produces:**
  - **nav.ts:**
    - `interface Cell { row: number; col: number }`, in 1-based ARIA indices;
    - `gridTarget(key: string, ctrl: boolean, at: Cell, rows: number, cols: number, page: number): Cell | null`, the APG grid target clamped to the known extent, or `null` for other keys;
    - `fieldStarts(text: string): Int32Array` and `field(text: string, starts: Int32Array, k: number): string` (a ragged row's missing fields read as `''`).
  - **viewport.ts:**
    - `class Viewport`: `constructor(parent: HTMLElement, rowHeight: number, onChange: () => void)`;
      - `readonly state: ScrollState`; `readonly el: HTMLDivElement` (the scroller; the caller gives it its role); `readonly layer: HTMLDivElement` (sticky and viewport-sized; rows go here);
      - getters `left`, `viewWidth`, `viewHeight`;
      - `setContent(rows: number, width: number, top?: (current: number) => number): void`, which re-applies the native thumb (in logical mode its position depends on the total). It first absorbs a user scroll the browser hasn't dispatched yet, under the mapping it was made in; during a pointer drag it leaves the thumb alone; `top` maps the resulting top to the new one;
      - `moveTo(top: number)`, `moveBy(px: number)`, `setLeft(px: number)`.
    - `order(parent: HTMLElement, el: HTMLElement, prev: HTMLElement | null): void` keeps DOM order equal to index order.
  - **row-source.ts:** `interface Range { first: number; last: number }` (`last` exclusive) and `class RowSource<T>`:
    - `constructor(fetch: (start: number, count: number) => Promise<[number, T][]>, onLoad: () => void, keep: number)`;
    - `get(line: number): T | undefined`;
    - `want(r: Range): void`, coalesced to one request per animation frame with at most 2 in flight;
    - `ensure(line: number): Promise<void>`, which loads one line on demand and rejects if it can't be read.
  - **grid.ts:** `class Grid`: `constructor(parent: HTMLElement, core: Core, doc: number, label: string)`; `readonly view: Viewport`; `setLines(n: number, done: boolean): void`.
  - **boot.ts:** `interface LineView { setLines(n: number, done: boolean): void }`; `boot(make: (card: HTMLElement, core: Core, doc: number, name: string) => LineView): Promise<void>`. It sets `window.__spike = { perf, core, view, indexDone? }`.
  - **Page:** `grid.html` (`TYPOSE_PAGE=grid`).
  - **e2e/b1-harness.ts:**
    - `GRID_1M`, `GRID_WIDE`, `JSONL` (`JSONL_FIXTURE` overrides `spikes/.fixtures/10g.jsonl`);
    - `save(key, value)`, into `spikes/results/spike-b1-<host>.json`;
    - `launch(page: 'grid' | 'treegrid', file)`, which drops inherited `TYPOSE_*` variables and gives the app its own profile (`--user-data-dir=spikes/.fixtures/b1-userdata`): every spike run otherwise shares `%APPDATA%\spike-app`, and a zoom level another run persisted there for `typose://app` halves the viewport. It throws unless `webContents.getZoomFactor()` is 1;
    - `waitIndexed(win): Promise<number>`, `focusLog(win, n)`;
    - `recordFocus(win)`: from then on, logs every focus move as [aria-rowindex, aria-colindex (0 on a treegrid row), text], and in `__focusOffscreen` the index of every move that left the focused element not wholly inside its grid's client box, or left a Grid data cell partly under the sticky header row or row-number column;
    - `firstLines(path, n)`, `lastLine(path)`, `countLines(path)`: file reads independent of the core;
    - `cdpFocus(cdp): Promise<AXFocus>`: the focused node in the browser's accessibility tree, with its ancestors;
    - `uiaByName(app, name): Promise<Record<string, any> | null>`: the element with that accessible name in the UIA tree.
  - **e2e/uia-element.ps1 -procId \<pid\> -name \<name\>** prints the UIA view of the element with that accessible name as JSON: `type`, `name`, `hasFocus`, `offscreen`, and when the patterns exist `row`, `col`, `rowCount`, `colCount`, `colHeaders`, `rowHeaders`, `expand`, `posInSet`, `sizeOfSet`. It looks the element up by name, not by `HasKeyboardFocus`: UIA reports keyboard focus only while the window holds the OS focus, which another window can take at any moment.

**Design notes:**
- **Vertical** scrolling is plan A's `ScrollState`: native up to 16M px, logical above. The 1M×20 grid is 24,000,024 px. **Horizontal** scrolling is native: 5,000 × 120 px is about 600,000 px, far below the cap.
- **One sticky layer** (spec §5.3: "positioned, not stacked layers"):
  - The scroller holds a sizer (content width × spacer height). The sizer's only child is a sticky, viewport-sized layer with `overflow: clip`; unlike `hidden`, it can't be scrolled by `scrollIntoView`.
  - Rows are absolutely positioned in the layer. The header row sits at y = 0 and each row-number cell at x = 0. The data cells sit in a per-row container translated by `−scrollLeft`.
  - So every cell stays inside its `role=row`, and no second scrolling layer has to be kept in sync.
- **Overscan** is one viewport each way, vertically and horizontally (spec §5.3): about 94 rows × 31 columns are mounted, in every mode: the Grid and Rows don't read accessibility mode, so there is no 500-row window. That is per spec §5.3 and §6.2 (Z33): the wide window is for Rendered and Transcript; here every cell is reached by keys that load the target before moving focus (Global Constraints).
- **DOM order is table order.** Rows and cells are kept in index order (`order()`). The browser then builds the same table the ARIA indices describe, and browse mode reads in order.
- **A horizontal scroll fires `scroll` too.** Handing it to `ScrollState.onNativeScroll` would re-derive the logical top from the quantized native one and drift it, so only a changed `scrollTop` reaches `ScrollState`.
- **Index updates re-apply the thumb** (plan A's logical-mode rule; in logical mode a growing total moves the thumb for the same top). Two guards, the same as plan A's validated `VirtualList.setRowCount`:
  - `setContent` first absorbs a changed `scrollTop` whose `scroll` event hasn't been dispatched yet, and does it **before** the total changes, under the mapping the scroll was made in. Without the absorb, a scrollbar drag landing in the same frame as a progress event is thrown away. Absorbing after the total changed would read the old offset under the new mapping, and an idle view would jump on every other progress event.
  - During a pointer drag (`pointerdown` on the scroller until `pointerup`) the thumb isn't re-applied, so it stays under the cursor; the drag's next `scroll` maps it anew.
  - The second and third e2e tests pin all three: the undispatched drag is kept; five 10% growths leave an idle view's first row at 500,000; a drag's `scrollTop` is untouched by a growth.
- **Keys** (all `preventDefault`ed, because Chromium's own scrolling is a proportional jump in logical mode):
  - arrows; Home/End within the row; Ctrl+Home/End to the first cell and the true last cell (Cmd+↑/↓ on macOS, brief §7.2);
  - PageUp/PageDown move the focus and the view one page together;
  - Space, Shift+Space and Ctrl+Space move nothing (spec Z40). The fifth e2e test checks Space and Shift+Space. Ctrl+Space and Ctrl+Shift+Space take the same path (`key === ' '`, whatever the modifiers), and the round-3 fix check found they leave the view and the focus alone. No test pins them; adding `Control+Space` to that test's loop is left to the Grid milestone, because changing the test now would rewrite this task's commit and every later one. Space doesn't page-scroll, and Chromium's own Space scroll is prevented too. In the product, Shift+Space selects the row and Ctrl+Space the column. Selection isn't built in the spike, so neither key is claimed here.
  - **Selection is deferred to the Grid milestone (M3, spec §13.2), with this acceptance test:**
    - in a grid of at least 3 × 3, with focus on a data cell, Shift+Space selects the cell's row and Ctrl+Space its column;
    - each selected cell reports `aria-selected="true"` in the DOM and is selected in the UIA tree, and the grid has `aria-multiselectable="true"`;
    - neither key moves the focus or the view, and Space alone changes nothing;
    - a keyboard-reachable command (the row-number cell's menu, the column header's menu) makes the same selections where the OS or an input method owns the shortcut.
- **Only a focused cell's keys are the grid's** (spec Z40). A key from a control inside the grid (a button, checkbox or menu item) is left to it, so Space activates it. So is a key that is part of IME composition (`isComposing`). The spike's grid has no such control; the fifth e2e test puts a button in it to check. **A known spike limitation, for the Grid milestone (M3):** the grid hands every key to a focused child control, arrows included, and gives no key back to cell navigation (no Escape or F2). Z40 only rules that the control keeps Space, so the fifth test's "ArrowDown doesn't move the grid's focus" pins this spike's choice, not Z40.
- **Focus waits for content** (spec §6.2). Keys run through one promise queue, each from the focus the previous one left. A move `ensure`s its target line, then scrolls, renders and focuses. Focus never lands on a placeholder, and each press yields exactly one focus move, in order.
- **The focused row stays mounted** out of view, parked just outside the viewport. It keeps its focused cell even when that column scrolls away, and the header row keeps that column's header, so the cell still has its column header in the accessibility tree.

- [ ] **Step 1: Write the failing unit tests**

`spikes/app/src/renderer/src/grid/nav.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { field, fieldStarts, gridTarget } from './nav'

describe('gridTarget (1-based ARIA indices: row 1 is the header, col 1 the row numbers)', () => {
  const at = { row: 5, col: 3 }

  it('moves one cell per arrow and clamps at the edges', () => {
    expect(gridTarget('ArrowDown', false, at, 10, 6, 8)).toEqual({ row: 6, col: 3 })
    expect(gridTarget('ArrowLeft', false, at, 10, 6, 8)).toEqual({ row: 5, col: 2 })
    expect(gridTarget('ArrowUp', false, { row: 1, col: 1 }, 10, 6, 8)).toEqual({ row: 1, col: 1 })
    expect(gridTarget('ArrowRight', false, { row: 1, col: 6 }, 10, 6, 8)).toEqual({ row: 1, col: 6 })
  })

  it('Home/End stay in the row; with Ctrl they reach the first and the true last cell', () => {
    expect(gridTarget('Home', false, at, 10, 6, 8)).toEqual({ row: 5, col: 1 })
    expect(gridTarget('End', false, at, 10, 6, 8)).toEqual({ row: 5, col: 6 })
    expect(gridTarget('Home', true, at, 10, 6, 8)).toEqual({ row: 1, col: 1 })
    expect(gridTarget('End', true, at, 1_000_001, 21, 8)).toEqual({ row: 1_000_001, col: 21 })
  })

  it('pages by the given row count, clamped', () => {
    expect(gridTarget('PageDown', false, at, 10, 6, 8)).toEqual({ row: 10, col: 3 })
    expect(gridTarget('PageUp', false, { row: 9, col: 3 }, 10, 6, 8)).toEqual({ row: 1, col: 3 })
  })

  it('ignores other keys', () => {
    expect(gridTarget('a', false, at, 10, 6, 8)).toBeNull()
  })
})

describe('unquoted CSV fields', () => {
  it('slices fields by offset, and a ragged row reads missing fields as empty', () => {
    const text = 'a,bb,,ccc'
    const starts = fieldStarts(text)
    expect([0, 1, 2, 3, 4].map((k) => field(text, starts, k))).toEqual(['a', 'bb', '', 'ccc', ''])
  })
})
```

Run (`spikes/app`): `npx vitest run src/renderer/src/grid`
Expected: FAIL with `Error: Cannot find module './nav'`.

- [ ] **Step 2: Implement nav.ts**

`spikes/app/src/renderer/src/grid/nav.ts`:
```ts
/** A grid position in 1-based ARIA indices: row 1 is the header row, col 1 the row-number column. */
export interface Cell {
  row: number
  col: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** The target of a grid navigation key (APG grid), clamped to the known extent; null for keys the grid ignores. */
export function gridTarget(key: string, ctrl: boolean, at: Cell, rows: number, cols: number, page: number): Cell | null {
  let { row, col } = at
  switch (key) {
    case 'ArrowUp': row--; break
    case 'ArrowDown': row++; break
    case 'ArrowLeft': col--; break
    case 'ArrowRight': col++; break
    case 'PageUp': row -= page; break
    case 'PageDown': row += page; break
    case 'Home': if (ctrl) row = 1; col = 1; break
    case 'End': if (ctrl) row = rows; col = cols; break
    default: return null
  }
  return { row: clamp(row, 1, rows), col: clamp(col, 1, cols) }
}

/** Start offset of every field of an unquoted CSV line (spike simplification: no quotes, no embedded delimiters or newlines). */
export function fieldStarts(text: string): Int32Array {
  const starts = [0]
  for (let i = text.indexOf(','); i >= 0; i = text.indexOf(',', i + 1)) starts.push(i + 1)
  return Int32Array.from(starts)
}

/** Field `k` (0-based); a ragged row's missing fields read as empty. */
export function field(text: string, starts: Int32Array, k: number): string {
  if (k >= starts.length) return ''
  return text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] - 1 : text.length)
}
```

Run: `npx vitest run src/renderer/src/grid`
Expected: `5 passed`.

Run: `npm test`
Expected: `Tests 16 passed`.

- [ ] **Step 3: Write the failing e2e test and its harness**

`spikes/app/e2e/b1-harness.ts`:
```ts
import { _electron as electron, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

const FIX = resolve(__dirname, '../../.fixtures')
export const GRID_1M = resolve(FIX, 'grid-1m-x20.csv')
export const GRID_WIDE = resolve(FIX, 'grid-1k-x5000.csv')
export const JSONL = process.env.JSONL_FIXTURE ?? resolve(FIX, '10g.jsonl')
const OUT = resolve(__dirname, `../../results/spike-b1-${hostname()}.json`)

export function save(key: string, value: unknown): void {
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
  all[key] = value
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(all, null, 2))
}

/**
 * Opens a file in one Spike B page. Inherited TYPOSE_* variables are dropped, so a stray TYPOSE_OPEN can't leak in.
 * The app gets a profile of its own: every spike run otherwise shares %APPDATA%/spike-app, where a zoom level another
 * run persisted for typose://app (per_host_zoom_levels) silently halves this page's viewport.
 */
export async function launch(page: 'grid' | 'treegrid', file: string): Promise<{ app: ElectronApplication; win: Page }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_'))) as Record<string, string>
  const app = await electron.launch({ args: ['.', `--user-data-dir=${resolve(FIX, 'b1-userdata')}`], env: { ...env, TYPOSE_PAGE: page, TYPOSE_OPEN: file } })
  const win = await app.firstWindow()
  const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
  if (zoom !== 1) throw new Error(`page zoom is ${zoom}, not 1: measurements would be skewed`)
  await win.waitForFunction(() => (window as any).__spike?.view)
  return { app, win }
}

/** Waits for the index to finish and returns its line count. */
export async function waitIndexed(win: Page): Promise<number> {
  await win.waitForFunction(() => (window as any).__spike.indexDone, null, { timeout: 10 * 60_000 })
  return win.evaluate(() => (window as any).__spike.indexDone.lines as number)
}

/**
 * From now on, logs every focus move as [aria-rowindex, aria-colindex (0 on a treegrid row), text], and in
 * `__focusOffscreen` the index of every move that left the focused element not wholly inside its grid's client box, or
 * left a Grid data cell partly under the sticky header row or row-number column.
 */
export function recordFocus(win: Page): Promise<void> {
  return win.evaluate(() => {
    const log: [number, number, string][] = ((window as any).__focusLog = [])
    const offscreen: number[] = ((window as any).__focusOffscreen = [])
    document.addEventListener('focusin', (e) => {
      const el = e.target as HTMLElement
      const g = el.closest('[role=grid],[role=treegrid]')
      if (g) {
        const r = el.getBoundingClientRect()
        const b = g.getBoundingClientRect()
        const [x, y] = [b.left + g.clientLeft, b.top + g.clientTop]
        // A Grid data cell must also clear the sticky row-number column and header row; treegrid rows have neither.
        const row = el.closest<HTMLElement>('[role=row]')
        const data = Number(el.ariaColIndex) > 1 && Number(row?.ariaRowIndex) > 1
        const left = data ? (row!.querySelector('[role=rowheader]')?.getBoundingClientRect().right ?? x) : x
        const top = data ? (g.querySelector('[role=row][aria-rowindex="1"]')?.getBoundingClientRect().bottom ?? y) : y
        if (r.left < left - 0.5 || r.top < top - 0.5 || r.right > x + g.clientWidth + 0.5 || r.bottom > y + g.clientHeight + 0.5) offscreen.push(log.length)
      }
      log.push([Number(el.closest<HTMLElement>('[role=row]')?.ariaRowIndex), Number(el.ariaColIndex ?? 0), el.textContent ?? ''])
    })
  })
}

/** The focus log once it holds at least `n` moves. */
export async function focusLog(win: Page, n: number): Promise<[number, number, string][]> {
  await win.waitForFunction((k) => (window as any).__focusLog.length >= k, n)
  return win.evaluate(() => (window as any).__focusLog)
}

/** The file's first `n` lines, read from its head (independent of the core). */
export function firstLines(path: string, n: number): string[] {
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(1 << 20)
  const got = readSync(fd, buf, 0, buf.length, 0)
  closeSync(fd)
  return buf.subarray(0, got).toString('utf8').split('\n').slice(0, n)
}

/** The file's last line, read from its tail (independent of the core). */
export function lastLine(path: string): string {
  const fd = openSync(path, 'r')
  const size = fstatSync(fd).size
  const buf = Buffer.alloc(Math.min(size, 1 << 20))
  readSync(fd, buf, 0, buf.length, size - buf.length)
  closeSync(fd)
  return buf.toString('utf8').trimEnd().split('\n').pop()!
}

/** Counts newline-terminated lines by streaming the file (independent of the core's index). */
export async function countLines(path: string): Promise<number> {
  let n = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>)
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, i + 1)) n++
  return n
}

export interface AXFocus {
  role: string
  name: string
  focused: boolean
  level?: number
  expanded?: boolean
  ancestors: string[]
}

/** The focused node in the browser's own accessibility tree (CDP Accessibility domain), with its unignored ancestors. */
export async function cdpFocus(cdp: CDPSession): Promise<AXFocus> {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' })
  const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId })
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: true })
  await cdp.send('Accessibility.disable') // don't leave the renderer's accessibility tree running for the rest of the test
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const self = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId)!
  const prop = (name: string) => self.properties?.find((p) => p.name === name)?.value.value
  const ancestors: string[] = []
  for (let p = byId.get(self.parentId ?? ''); p; p = byId.get(p.parentId ?? ''))
    if (!p.ignored) ancestors.push(p.name?.value ? `${p.role?.value} "${p.name.value}"` : String(p.role?.value))
  return { role: self.role?.value, name: self.name?.value, focused: prop('focused') === true, level: prop('level'), expanded: prop('expanded'), ancestors }
}

/** The element with accessible name `name` in the platform accessibility tree (Windows UI Automation), or null off Windows. */
export async function uiaByName(app: ElectronApplication, name: string): Promise<Record<string, any> | null> {
  if (process.platform !== 'win32') return null
  const pid = await app.evaluate(() => process.pid) // the Electron main process, which owns the window
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-File', resolve(__dirname, 'uia-element.ps1'), '-procId', String(pid), '-name', name], {
    encoding: 'utf8',
    windowsHide: true
  })
  return JSON.parse(out)
}
```

`spikes/app/e2e/uia-element.ps1`:
```powershell
# Prints, as one JSON object, the element named $name in the Electron window owned by process $procId, read from the
# platform accessibility tree (Windows UI Automation: what Narrator consumes). Run by e2e/b1-harness.ts.
# The lookup is by name, not by HasKeyboardFocus: UIA reports keyboard focus only while the window holds the OS focus,
# which another window (another test run, the user) can take at any moment. hasFocus is reported, not relied on.
param([int]$procId, [string]$name)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$P = [System.Windows.Automation.PropertyCondition]
$win = $A::RootElement.FindFirst('Children', (New-Object $P($A::ProcessIdProperty, $procId)))
$el = if ($win) { $win.FindFirst('Descendants', (New-Object $P($A::NameProperty, $name))) }
if (-not $el) { '{}'; exit }
$out = [ordered]@{ type = $el.Current.ControlType.ProgrammaticName; name = $el.Current.Name; hasFocus = $el.Current.HasKeyboardFocus; offscreen = $el.Current.IsOffscreen }
$gi = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.GridItemPattern]::Pattern, [ref]$gi)) {
  $out.row = $gi.Current.Row
  $out.col = $gi.Current.Column
  $grid = $gi.Current.ContainingGrid.GetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern)
  $out.rowCount = $grid.Current.RowCount
  $out.colCount = $grid.Current.ColumnCount
}
$ti = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.TableItemPattern]::Pattern, [ref]$ti)) {
  $out.colHeaders = @($ti.Current.GetColumnHeaderItems() | ForEach-Object { $_.Current.Name })
  $out.rowHeaders = @($ti.Current.GetRowHeaderItems() | ForEach-Object { $_.Current.Name })
}
$ec = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) { $out.expand = "$($ec.Current.ExpandCollapseState)" }
# UIA_PositionInSetPropertyId and UIA_SizeOfSetPropertyId; the managed client (.NET 4.8) knows these two but not Level.
$pos = [System.Windows.Automation.AutomationProperty]::LookupById(30152)
$size = [System.Windows.Automation.AutomationProperty]::LookupById(30153)
if ($pos -and $size) {
  $out.posInSet = $el.GetCurrentPropertyValue($pos)
  $out.sizeOfSet = $el.GetCurrentPropertyValue($size)
}
$out | ConvertTo-Json -Compress
```

`spikes/app/e2e/grid.e2e.ts`:
```ts
import { expect, test, type Page } from '@playwright/test'
import { GRID_1M, GRID_WIDE, cdpFocus, countLines, focusLog, lastLine, launch, recordFocus, save, uiaByName, waitIndexed } from './b1-harness'

const corner = (win: Page) => win.locator('[role=row][aria-rowindex="1"] [aria-colindex="1"]')

test('grid: true totals and the focused position; Ctrl+End reaches the true last row (G2, G3)', async () => {
  const lines = await countLines(GRID_1M)
  const last = lastLine(GRID_1M).split(',')
  const cols = last.length + 1 // + the row-number column
  const { app, win } = await launch('grid', GRID_1M)
  const grid = win.locator('[role=grid]')
  const early = await win.evaluate(() => ({
    rowcount: document.querySelector('[role=grid]')!.getAttribute('aria-rowcount'),
    done: Boolean((window as any).__spike.indexDone)
  }))
  if (!early.done) expect(early.rowcount).toBe('-1') // never a partial count presented as final
  expect(await waitIndexed(win)).toBe(lines)
  await expect(grid).toHaveAttribute('aria-rowcount', String(lines))
  await expect(grid).toHaveAttribute('aria-colcount', String(cols))

  await corner(win).focus()
  await expect(corner(win)).toHaveText('#') // the header line is no record (spec Z31)
  await recordFocus(win)
  await win.keyboard.press('Control+End')
  expect((await focusLog(win, 1))[0]).toEqual([lines, cols, last.at(-1)])
  const record = await win.evaluate(() =>
    [...document.activeElement!.closest('[role=row]')!.querySelectorAll<HTMLElement>('[role=gridcell]')].map((c) => [Number(c.ariaColIndex), c.textContent])
  )
  for (const [col, text] of record) expect(text).toBe(last[(col as number) - 2])
  // The row header is the record number (spec Z31): the header line is no record, so the last record is lines − 1;
  // aria-rowindex stays positional (lines).
  const rowHeader = await win.evaluate(() => document.activeElement!.closest('[role=row]')!.querySelector('[role=rowheader]')!.textContent)
  expect(rowHeader).toBe(String(lines - 1))
  const cdp = await win.context().newCDPSession(win)
  const axEnd = await cdpFocus(cdp)
  expect(axEnd).toMatchObject({ role: 'gridcell', name: last.at(-1), focused: true })
  expect(axEnd.ancestors).toContain('grid "grid-1m-x20.csv"')
  const uiaEnd = await uiaByName(app, last.at(-1)!)
  if (uiaEnd) expect(uiaEnd).toMatchObject({ type: 'ControlType.DataItem', name: last.at(-1), row: lines - 1, col: cols - 1, rowCount: lines, colCount: cols })

  await win.keyboard.press('Control+Home')
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight']) await win.keyboard.press(key)
  expect((await focusLog(win, 7))[6]).toEqual([3, 4, 'r2c3'])
  await expect(win.locator('[role=row][aria-rowindex="2"] [role=rowheader]')).toHaveText('1') // the first data record
  const axMid = await cdpFocus(cdp)
  expect(axMid).toMatchObject({ role: 'gridcell', name: 'r2c3', focused: true })
  const uiaMid = await uiaByName(app, 'r2c3')
  if (uiaMid) expect(uiaMid).toMatchObject({ name: 'r2c3', row: 2, col: 3, rowCount: lines, colCount: cols })

  // Scrolled out of view (by the wheel: Space doesn't page, spec Z40), the focused cell stays mounted and focused; the
  // next arrow brings it back.
  const top = () => win.evaluate(() => (window as any).__spike.view.view.state.top as number)
  const box = (await grid.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.wheel(0, 3000)
  await expect.poll(top).toBeGreaterThan(2000)
  const where = () =>
    win.evaluate(() => {
      const a = document.activeElement as HTMLElement
      const r = a.getBoundingClientRect()
      const g = a.closest('[role=grid]')!.getBoundingClientRect()
      return { text: a.textContent, row: a.closest<HTMLElement>('[role=row]')!.ariaRowIndex, connected: a.isConnected, inView: r.top >= g.top && r.bottom <= g.bottom }
    })
  expect(await where()).toEqual({ text: 'r2c3', row: '3', connected: true, inView: false })
  const uiaAway = await uiaByName(app, 'r2c3')
  if (uiaAway) expect(uiaAway).toMatchObject({ name: 'r2c3', row: 2, col: 3 })
  await win.keyboard.press('ArrowDown')
  expect((await focusLog(win, 8))[7]).toEqual([4, 4, 'r3c3'])
  expect(await where()).toEqual({ text: 'r3c3', row: '4', connected: true, inView: true })
  save('G2G3:grid', { lines, cols, early, axEnd, uiaEnd, axMid, uiaMid, uiaAway })
  await app.close()
})

test('grid: a scrollbar drag that lands in the same frame as an index update is kept', async () => {
  const { app, win } = await launch('grid', GRID_1M)
  const lines = await waitIndexed(win)
  const top = await win.evaluate((n) => {
    const view = (window as any).__spike.view
    const el = view.view.el as HTMLElement
    el.scrollTop = el.scrollHeight / 2 // a thumb drag whose 'scroll' event hasn't been dispatched yet
    view.setLines(n, true) // an index update in the same task re-applies the thumb
    return view.view.state.top as number
  }, lines)
  expect(top).toBeGreaterThan(lines * 24 * 0.4) // about halfway down, not thrown back to the top
  await app.close()
})

test('grid: while the total grows in logical mode, an idle view stays put and a thumb drag keeps the thumb', async () => {
  const { app, win } = await launch('grid', GRID_1M)
  const lines = await waitIndexed(win)
  const out = await win.evaluate(async (n) => {
    const view = (window as any).__spike.view
    const el = view.view.el as HTMLElement
    const frames = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    const firstRow = () => Math.floor(view.view.state.top / 24)
    view.view.moveTo(500_000 * 24)
    await frames()
    const idle = [firstRow()]
    for (let i = 1; i <= 5; i++) {
      view.setLines(Math.round(n * 1.1 ** i), false) // indexing finds 10% more lines
      await frames() // the thumb's own scroll echo arrives
      idle.push(firstRow())
    }
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) // a thumb drag starts
    const before = el.scrollTop
    view.setLines(Math.round(n * 2), false)
    const during = el.scrollTop
    window.dispatchEvent(new PointerEvent('pointerup'))
    view.setLines(n, true)
    return { idle, before, during }
  }, lines)
  expect(out.idle).toEqual(Array(6).fill(500_000))
  expect(out.during).toBe(out.before) // the thumb stays under the cursor
  await app.close()
})

test('grid: 5,000 columns are virtualized horizontally', async () => {
  const last = lastLine(GRID_WIDE).split(',')
  const { app, win } = await launch('grid', GRID_WIDE)
  const lines = await waitIndexed(win)
  await expect(win.locator('[role=grid]')).toHaveAttribute('aria-colcount', '5001')
  await corner(win).focus()
  await recordFocus(win)
  await win.keyboard.press('End')
  await win.keyboard.press('Control+End')
  // Scrolled away sideways, the focused cell and its column header stay mounted.
  const box = (await win.locator('[role=grid]').boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.wheel(-1_000_000, 0)
  await expect.poll(() => win.evaluate(() => (window as any).__spike.view.view.left)).toBe(0)
  const away = await win.evaluate(() => ({
    focused: document.activeElement!.textContent,
    header: document.querySelector('[role=row][aria-rowindex="1"] [aria-colindex="5001"]')?.textContent
  }))
  expect(away).toEqual({ focused: last.at(-1), header: 'col5000' })
  const uiaAway = await uiaByName(app, last.at(-1)!)
  if (uiaAway) expect(uiaAway).toMatchObject({ name: last.at(-1), col: 5000, colHeaders: ['col5000'], offscreen: true })
  await win.keyboard.press('Home')
  expect(await focusLog(win, 3)).toEqual([
    [1, 5001, 'col5000'],
    [lines, 5001, last.at(-1)],
    [lines, 1, String(lines - 1)] // the row header: the record number (spec Z31)
  ])
  const mounted = await win.evaluate(() => ({
    rows: document.querySelectorAll('[role=row]').length,
    cells: document.querySelectorAll('[role=gridcell],[role=columnheader],[role=rowheader]').length
  }))
  save('wideGrid', { mounted, uiaAway })
  expect(mounted.cells).toBeLessThan(mounted.rows * 40) // ~3 viewports of columns per row, not 5,001
  await app.close()
})

test('grid: Space and Shift+Space leave the view alone, PageDown pages; a child control and IME composition keep their keys (spec Z40)', async () => {
  const { app, win } = await launch('grid', GRID_1M)
  await waitIndexed(win)
  await corner(win).focus()
  await recordFocus(win)
  await win.keyboard.press('ArrowDown')
  await win.keyboard.press('ArrowRight')
  await focusLog(win, 2)
  // The view's top and the focused text once the key queue has run and two frames have passed.
  const state = () =>
    win.evaluate(async () => {
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
      return { top: (window as any).__spike.view.view.state.top as number, focused: document.activeElement!.textContent }
    })
  const before = await state()
  expect(before.focused).toBe('r1c1')
  for (const key of ['Space', 'Shift+Space']) {
    await win.keyboard.press(key)
    expect(await state(), key).toEqual(before)
  }
  await win.keyboard.press('PageDown')
  await focusLog(win, 3)
  const paged = await state()
  expect(paged.top).toBeGreaterThan(before.top)
  expect(paged.focused).not.toBe(before.focused)
  // A key that is part of IME composition is the input method's: the grid neither moves nor prevents it.
  const ime = await win.evaluate(async () => {
    const cell = document.activeElement!
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })
    cell.dispatchEvent(e)
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    return { prevented: e.defaultPrevented, stayed: document.activeElement === cell }
  })
  expect(ime).toEqual({ prevented: false, stayed: true })
  // A button inside the grid keeps its keys: Space presses it, and an arrow doesn't move the grid's focus.
  await win.evaluate(() => {
    const b = Object.assign(document.createElement('button'), { id: 'probe', textContent: 'probe' })
    b.addEventListener('click', () => ((window as any).__probeClicks = ((window as any).__probeClicks ?? 0) + 1))
    document.querySelector('[role=grid]')!.append(b)
    b.focus({ preventScroll: true })
  })
  for (const key of ['Space', 'ArrowDown']) await win.keyboard.press(key)
  const child = await win.evaluate(async () => {
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    return { clicks: (window as any).__probeClicks, focused: document.activeElement!.id }
  })
  expect(child).toEqual({ clicks: 1, focused: 'probe' })
  await app.close()
})
```

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e grid`
Expected: FAIL, `5 failed`, each with `TimeoutError: page.waitForFunction: Timeout 30000ms exceeded` in `launch` (`e2e/b1-harness.ts`): `typose://app/grid.html` doesn't exist yet.

- [ ] **Step 4: Implement the Grid page**

`spikes/app/src/renderer/src/grid/viewport.ts`:
```ts
import { ScrollState, isLogical, spacerHeight, wheelPixels } from '../scrollmath'

/**
 * A 2D scroll viewport (spec §5.3). Vertical: ScrollState, native up to 16M px and logical above it.
 * Horizontal: native. Rows are positioned inside one sticky, viewport-sized layer.
 */
export class Viewport {
  readonly state: ScrollState
  readonly el: HTMLDivElement
  readonly layer: HTMLDivElement
  private readonly sizer: HTMLDivElement
  private nativeTop = 0
  private width = 0
  private dragging = false

  constructor(parent: HTMLElement, private readonly rowHeight: number, private readonly onChange: () => void) {
    this.el = Object.assign(document.createElement('div'), { className: 'gv-scroller' })
    this.sizer = Object.assign(document.createElement('div'), { className: 'gv-sizer' })
    this.layer = Object.assign(document.createElement('div'), { className: 'gv-layer' })
    this.sizer.append(this.layer)
    this.el.append(this.sizer)
    parent.append(this.el)
    this.state = new ScrollState({ total: 0, viewport: this.el.clientHeight })
    new ResizeObserver(() => this.resize()).observe(this.el)
    this.el.addEventListener('wheel', (e) => this.wheel(e), { passive: false })
    this.el.addEventListener('scroll', () => {
      this.absorb()
      this.onChange()
    })
    this.el.addEventListener('pointerdown', () => (this.dragging = true))
    window.addEventListener('pointerup', () => (this.dragging = false))
  }

  get left(): number {
    return this.el.scrollLeft
  }

  get viewWidth(): number {
    return this.el.clientWidth
  }

  get viewHeight(): number {
    return this.state.geometry.viewport
  }

  /**
   * In logical mode the thumb's native position depends on the total, so it is re-applied whenever the total changes.
   * A user scroll the browser hasn't dispatched yet is absorbed first, under the mapping it was made in (before the
   * total changes); re-applying the thumb would otherwise discard it. During a thumb drag the thumb isn't moved: the
   * drag's next scroll maps it anew. `top` maps the resulting top to the new one (Rows uses it to keep the reading position).
   */
  setContent(rows: number, width: number, top: (current: number) => number = (t) => t): void {
    this.absorb()
    const next = top(this.state.top)
    this.width = width
    this.state.setTotal(rows * this.rowHeight)
    this.layout()
    if (this.dragging && next === this.state.top) this.onChange()
    else this.moveTo(next)
  }

  moveTo(top: number): void {
    this.el.scrollTop = this.state.moveTo(top)
    this.nativeTop = this.el.scrollTop // Chromium quantizes large offsets: match echoes against what it applied
    this.state.confirmNative(this.nativeTop)
    this.onChange()
  }

  moveBy(px: number): void {
    this.moveTo(this.state.top + px)
  }

  setLeft(px: number): void {
    this.el.scrollLeft = px
    this.onChange()
  }

  private wheel(e: WheelEvent): void {
    if (!isLogical(this.state.geometry.total)) return
    e.preventDefault()
    const sideways = e.shiftKey && e.deltaX === 0 // Shift+wheel on Windows arrives as deltaY
    const dx = sideways ? e.deltaY : e.deltaX
    const dy = sideways ? 0 : e.deltaY
    if (dx) this.el.scrollLeft += wheelPixels(dx, e.deltaMode, this.rowHeight, this.viewWidth)
    if (dy) this.moveBy(wheelPixels(dy, e.deltaMode, this.rowHeight, this.viewHeight))
  }

  /**
   * Hands a changed scrollTop to ScrollState. A horizontal scroll also fires 'scroll'; reading it as a vertical jump
   * would re-derive the logical top from the quantized native one and drift it, so an unchanged scrollTop is ignored.
   */
  private absorb(): void {
    const top = this.el.scrollTop
    if (top === this.nativeTop) return
    this.nativeTop = top
    this.state.onNativeScroll(top)
  }

  private resize(): void {
    this.absorb()
    this.state.setViewport(this.el.clientHeight)
    this.layout()
    this.moveTo(this.state.top)
  }

  private layout(): void {
    this.layer.style.width = `${this.el.clientWidth}px`
    this.layer.style.height = `${this.viewHeight}px`
    this.sizer.style.width = `${this.width}px`
    this.sizer.style.height = `${Math.max(this.viewHeight, spacerHeight(this.state.geometry.total))}px`
  }
}

/** Puts `el` right after `prev` (or first in `parent`) unless it is already there: DOM order is reading and table order. */
export function order(parent: HTMLElement, el: HTMLElement, prev: HTMLElement | null): void {
  if (el.isConnected && el.previousElementSibling === prev) return
  if (prev) prev.after(el)
  else parent.prepend(el)
}
```

`spikes/app/src/renderer/src/grid/row-source.ts`:
```ts
export interface Range {
  first: number
  last: number // exclusive
}

/**
 * A line-keyed page cache. Viewport requests are coalesced to one per animation frame with at most 2 in flight
 * (spec §3.4); `ensure` loads one line on demand, so keyboard focus can wait for real content (spec §6.2).
 */
export class RowSource<T> {
  private readonly cache = new Map<number, T>()
  private readonly waiters = new Map<number, { ok: () => void; fail: (e: unknown) => void }[]>()
  private wanted: Range | null = null
  private inflight = 0
  private scheduled = false

  constructor(
    private readonly fetch: (start: number, count: number) => Promise<[number, T][]>,
    private readonly onLoad: () => void,
    private readonly keep: number
  ) {}

  get(line: number): T | undefined {
    return this.cache.get(line)
  }

  want(r: Range): void {
    this.wanted = r
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** Resolves once `line` is cached. A focus request, so it bypasses the per-frame coalescing. */
  ensure(line: number): Promise<void> {
    if (this.cache.has(line)) return Promise.resolve()
    return new Promise((ok, fail) => {
      const list = this.waiters.get(line)
      if (list) return void list.push({ ok, fail })
      this.waiters.set(line, [{ ok, fail }])
      this.fetch(line, 1)
        .then((items) => this.store(items, { first: line, last: line + 1 }))
        .then(() => {
          if (this.waiters.has(line)) throw new Error(`line ${line} is not available`)
        })
        .catch((err: unknown) => {
          for (const w of this.waiters.get(line) ?? []) w.fail(err)
          this.waiters.delete(line)
        })
    })
  }

  private pump(): void {
    const r = this.wanted
    if (!r || this.inflight >= 2) return
    let start = r.first
    while (start < r.last && this.cache.has(start)) start++
    if (start >= r.last) return
    this.wanted = null
    this.inflight++
    this.fetch(start, r.last - start)
      .then(
        (items) => {
          this.store(items, r)
          // A page stops at 256 KiB, so the range can still have gaps: keep pumping it unless a newer range is wanted.
          if (items.length > 0) this.wanted ??= r
        },
        (err: unknown) => console.error('page fetch failed', err)
      )
      .finally(() => {
        this.inflight--
        this.pump()
      })
  }

  private store(items: [number, T][], r: Range): void {
    for (const [line, item] of items) {
      this.cache.set(line, item)
      for (const w of this.waiters.get(line) ?? []) w.ok()
      this.waiters.delete(line)
    }
    // Mounted rows keep what they painted, so evicting never blanks one; `r` holds every line a waiter just got.
    if (this.cache.size > this.keep)
      for (const line of this.cache.keys()) if (line < r.first - this.keep / 2 || line >= r.last + this.keep / 2) this.cache.delete(line)
    this.onLoad()
  }
}
```

`spikes/app/src/renderer/src/grid/grid.ts`:
```ts
import type { Core } from '../core'
import { visibleRows } from '../scrollmath'
import { type Cell, field, fieldStarts, gridTarget } from './nav'
import { RowSource } from './row-source'
import { Viewport, order } from './viewport'

const ROW = 24
const COL_W = 120 // ponytail: fixed column width; auto-fit from the first 1,000 rows (brief §5.3) is M1 work
const NUM_W = 96 // the row-number column
const KEEP = 600 // cached lines (a 5,000-column line is ~54 KB)

interface Rec {
  text: string
  starts: Int32Array
}

interface RowEl {
  el: HTMLDivElement
  cells: HTMLDivElement // the scrolling part of the row; the row header stays put
  byCol: Map<number, HTMLDivElement>
  rec?: Rec
}

const div = (className: string): HTMLDivElement => Object.assign(document.createElement('div'), { className })

/**
 * Grid lens (spec §6.1): role=grid with true totals or −1, aria-rowindex/colindex on every rendered row and cell,
 * roving focus, the focused row kept mounted. ARIA row r is file line r − 1 (row 1 is the header line);
 * ARIA col 1 is the row-number column, so CSV column k is ARIA col k + 1.
 */
export class Grid {
  readonly view: Viewport
  private readonly source: RowSource<Rec>
  private readonly rows = new Map<number, RowEl>() // by ARIA row index
  private lines = 0
  private cols = 0 // CSV columns, from the header line; 0 until it loads
  private focus: Cell = { row: 1, col: 1 }
  private queue = Promise.resolve()

  constructor(parent: HTMLElement, core: Core, doc: number, label: string) {
    this.view = new Viewport(parent, ROW, () => this.render())
    const g = this.view.el
    g.role = 'grid'
    g.ariaLabel = label
    g.ariaRowCount = '-1'
    g.ariaColCount = '-1'
    g.style.setProperty('--col-w', `${COL_W}px`)
    g.style.setProperty('--num-w', `${NUM_W}px`)
    // Spike simplification: rows come through the `lines` RPC and are split on ',' here; the CSV record index is Spike C's.
    this.source = new RowSource<Rec>(
      (start, count) =>
        core
          .call<{ line: number; text: string }[]>('lines', { doc, start, count })
          .then((ls) => ls.map((l): [number, Rec] => [l.line, { text: l.text, starts: fieldStarts(l.text) }])),
      () => this.loaded(),
      KEEP
    )
    g.addEventListener('keydown', (e) => this.key(e))
    g.addEventListener('focusin', (e) => this.focused(e.target as HTMLElement))
  }

  setLines(n: number, done: boolean): void {
    this.lines = n
    this.view.el.ariaRowCount = done ? String(n) : '-1' // never a partial count presented as final (spec §6.2)
    this.view.setContent(n, NUM_W + this.cols * COL_W)
  }

  private loaded(): void {
    const head = this.source.get(0)
    if (this.cols || !head) return this.render()
    this.cols = head.starts.length
    this.view.el.ariaColCount = String(this.cols + 1)
    this.view.setContent(this.lines, NUM_W + this.cols * COL_W)
  }

  private key(e: KeyboardEvent): void {
    // A focused child control (a button, checkbox or menu item) and IME composition keep their keys (spec Z40).
    if (e.isComposing || !(e.target as HTMLElement).matches('[role=gridcell],[role=rowheader],[role=columnheader]')) return
    const mac = e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') // Cmd+↑/↓: top/bottom on macOS (brief §7.2)
    const key = mac ? (e.key === 'ArrowUp' ? 'Home' : 'End') : e.key
    const ctrlKey = e.ctrlKey || mac
    // Space doesn't page-scroll the grid, Chromium's own Space scroll included (spec Z40); Page Up/Down page. Shift+Space
    // and Ctrl+Space select the row and the column in the product: selection isn't built in the spike.
    if (key === ' ') return e.preventDefault()
    if (!gridTarget(key, ctrlKey, this.focus, 1, 1, 1)) return
    e.preventDefault() // Chromium's own scrolling would be a proportional jump in logical mode
    this.queue = this.queue.then(() => this.move(key, ctrlKey)).catch((err: unknown) => console.error('grid move failed', err))
  }

  /** Keys are applied one at a time, in order, each from the focus the previous one left. */
  private async move(key: string, ctrl: boolean): Promise<void> {
    const page = Math.max(1, Math.floor(this.view.viewHeight / ROW) - 2) // the data rows under the header
    const t = gridTarget(key, ctrl, this.focus, this.lines, this.cols + 1, page)
    if (!t || (t.row === this.focus.row && t.col === this.focus.col)) return
    await this.source.ensure(t.row - 1) // real content first, so focus never lands on a placeholder (spec §6.2)
    if (key === 'PageDown' || key === 'PageUp') this.view.moveBy((t.row - this.focus.row) * ROW)
    this.activate(t)
    this.reveal(t)
    this.render()
    this.cell(t)?.focus({ preventScroll: true })
  }

  private activate(t: Cell): void {
    const old = this.cell(this.focus)
    if (old) old.tabIndex = -1
    this.focus = t
  }

  /** Click or assistive-technology focus moves the roving tab stop too. */
  private focused(target: HTMLElement): void {
    const row = Number(target.closest<HTMLElement>('[role=row]')?.ariaRowIndex)
    const col = Number(target.ariaColIndex)
    if (!row || !col || (row === this.focus.row && col === this.focus.col)) return
    this.activate({ row, col })
    target.tabIndex = 0
  }

  private cell(t: Cell): HTMLDivElement | undefined {
    return this.rows.get(t.row)?.byCol.get(t.col)
  }

  /** The smallest scroll that shows the cell clear of the sticky header row and row-number column. */
  private reveal(t: Cell): void {
    const top = this.view.state.top
    const y = (t.row - 1) * ROW
    if (t.row > 1 && y < top + ROW) this.view.moveTo(y - ROW)
    else if (t.row > 1 && y + ROW > top + this.view.viewHeight) this.view.moveTo(y + ROW - this.view.viewHeight)
    const left = this.view.left
    const x = NUM_W + (t.col - 2) * COL_W
    if (t.col > 1 && x < left + NUM_W) this.view.setLeft(x - NUM_W)
    else if (t.col > 1 && x + COL_W > left + this.view.viewWidth) this.view.setLeft(x + COL_W - this.view.viewWidth)
  }

  private render(): void {
    const { top } = this.view.state
    const vh = this.view.viewHeight
    const vw = this.view.viewWidth
    const left = this.view.left
    // Overscan is one viewport each way (spec §5.3), vertically and horizontally.
    const r = visibleRows(top, vh, ROW, this.lines, Math.ceil(vh / ROW)) // 0-based lines
    const c = visibleRows(left, vw, COL_W, this.cols, Math.ceil(vw / COL_W)) // 0-based CSV columns
    const want = new Set<number>()
    if (this.lines > 0) want.add(1) // the header row
    for (let line = r.first; line < r.last; line++) want.add(line + 1)
    if (this.focus.row <= this.lines) want.add(this.focus.row) // the focused row stays mounted out of view
    for (const [row, it] of this.rows) {
      if (want.has(row)) continue
      it.el.remove()
      this.rows.delete(row)
    }
    let prev: HTMLDivElement | null = null
    for (const row of [...want].sort((a, b) => a - b)) {
      const it = this.rows.get(row) ?? this.mount(row)
      order(this.view.layer, it.el, prev)
      prev = it.el
      const inView = row - 1 >= r.first && row - 1 < r.last
      const y = row === 1 ? 0 : inView ? (row - 1) * ROW - top : row - 1 < r.first ? -2 * ROW : vh + ROW
      it.el.style.transform = `translateY(${y}px)`
      it.cells.style.transform = `translateX(${-left}px)`
      it.rec ??= this.source.get(row - 1)
      if (it.rec) this.fill(it, row, c)
    }
    const active = this.cell(this.focus)
    if (active) active.tabIndex = 0
    if (r.last > r.first) this.source.want(r)
  }

  private mount(row: number): RowEl {
    const el = div(row === 1 ? 'gv-row gv-header' : 'gv-row')
    el.role = 'row'
    el.ariaRowIndex = String(row)
    const head = div('gv-num')
    head.role = row === 1 ? 'columnheader' : 'rowheader'
    head.ariaColIndex = '1'
    head.tabIndex = -1
    // The record number (spec Z31): 1 for the first data record. B1's CSV is unquoted, so a record is a line and its
    // number is the line's less the header's; real record numbering is Spike C's record index (C3).
    head.textContent = row === 1 ? '#' : String(row - 1)
    const cells = div('gv-cells')
    el.append(head, cells)
    const it = { el, cells, byCol: new Map([[1, head]]) }
    this.rows.set(row, it)
    return it
  }

  /** Mounts the cells of the visible columns, plus the focused cell and its column header, and drops the rest. */
  private fill(it: RowEl, row: number, c: { first: number; last: number }): void {
    const focusCol = (row === this.focus.row || row === 1) && this.focus.col > 1 ? this.focus.col : 0
    const inView = (col: number): boolean => col >= c.first + 2 && col < c.last + 2
    for (const [col, cell] of it.byCol) {
      if (col === 1 || inView(col) || col === focusCol) continue
      cell.remove()
      it.byCol.delete(col)
    }
    const cols: number[] = []
    for (let col = c.first + 2; col < c.last + 2; col++) cols.push(col)
    if (focusCol && !inView(focusCol)) cols.push(focusCol)
    let prev: HTMLDivElement | null = null
    for (const col of cols.sort((a, b) => a - b)) {
      let cell = it.byCol.get(col)
      if (!cell) {
        cell = div('gv-cell')
        cell.role = row === 1 ? 'columnheader' : 'gridcell'
        cell.ariaColIndex = String(col)
        cell.tabIndex = -1
        cell.textContent = field(it.rec!.text, it.rec!.starts, col - 2)
        cell.style.left = `${NUM_W + (col - 2) * COL_W}px`
        it.byCol.set(col, cell)
      }
      order(it.cells, cell, prev)
      prev = cell
    }
  }
}
```

`spikes/app/src/renderer/src/grid/boot.ts`:
```ts
import { type Core, connectCore } from '../core'
import { PerfLog } from '../perf'

export interface LineView {
  setLines(n: number, done: boolean): void
}

/** Spike B page boot: connects the core, opens ?open= and feeds index progress to the view that `make` builds. */
export async function boot(make: (card: HTMLElement, core: Core, doc: number, name: string) => LineView): Promise<void> {
  const perf = new PerfLog()
  const spike: Record<string, unknown> = { perf }
  ;(window as any).__spike = spike
  const core = await connectCore()
  spike.core = core
  const status = document.getElementById('status')!
  status.textContent = `core ${await core.call<string>('version')}`
  const path = new URLSearchParams(location.search).get('open')
  if (!path) return
  const { doc } = await core.call<{ doc: number }>('open', { path })
  const view = make(document.getElementById('card')!, core, doc, path.split(/[\\/]/).pop() ?? path)
  spike.view = view
  core.onEvent((e) => {
    if (e.event !== 'progress' || e.doc !== doc) return
    status.textContent = e.error ? `indexing stopped: ${e.error}` : `${e.done ? '' : 'indexing… '}${e.lines} lines`
    view.setLines(e.lines as number, e.done as boolean)
    if (e.done) spike.indexDone = e
  })
}
```

`spikes/app/src/renderer/src/grid/main.ts`:
```ts
import { boot } from './boot'
import { Grid } from './grid'

await boot((card, core, doc, name) => new Grid(card, core, doc, name))
```

`spikes/app/src/renderer/src/grid/grid.css`:
```css
/* Grid page: the scroller, the sticky layer, rows and cells. --col-w and --num-w are set by grid.ts. */
.gv-scroller { position: absolute; inset: 0; overflow: auto; overflow-anchor: none; }
/* One sticky, viewport-sized layer; overflow: clip, unlike hidden, can't be scrolled by scrollIntoView. */
.gv-layer { position: sticky; top: 0; left: 0; overflow: clip; }
.gv-row { position: absolute; top: 0; left: 0; right: 0; height: 24px; font: 13px/24px ui-monospace, monospace; }
.gv-cells { position: absolute; inset: 0; }
.gv-cell, .gv-num { position: absolute; top: 0; height: 24px; padding: 0 8px; box-sizing: border-box; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.gv-cell { width: var(--col-w); }
/* The row-number column and header row are positioned, not separate scrolling layers (spec §5.3). */
.gv-num { left: 0; width: var(--num-w); z-index: 1; text-align: right; color: var(--text2); background: var(--surface); }
.gv-header { z-index: 2; background: var(--surface); font-weight: 600; box-shadow: 0 1px #2c2c30; }
/* Full-bleed rows and cells take a 2px inset focus ring (brief §9). */
.gv-row:focus, .gv-cell:focus, .gv-num:focus { outline: 2px solid #7aa2ff; outline-offset: -2px; }
```

`spikes/app/src/renderer/grid.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>Typose spike · Grid</title>
    <link rel="stylesheet" href="./src/style.css" />
    <link rel="stylesheet" href="./src/grid/grid.css" />
  </head>
  <body>
    <header id="titlebar"><span id="status">connecting…</span></header>
    <main id="card"></main>
    <script type="module" src="./src/grid/main.ts"></script>
  </body>
</html>
```

In `spikes/app/electron.vite.config.ts`, change the `pages` line (Task B0) to:
```ts
const pages = ['index', 'grid']
```

- [ ] **Step 5: Run the tests to verify they pass, then a manual smoke test**

Run (`spikes/app`): `npm test`
Expected: `Tests 16 passed`.

Run: `npm run build`, then `npx playwright test --project=e2e grid`
Expected: `5 passed`.

Run: `npm run e2e`
Expected: `10 passed` (plan A's 3, Task B0's 2, these 5).

Launch the Grid on the 1M×20 fixture. The PowerShell form clears the variables afterwards.
- PowerShell: `$env:TYPOSE_PAGE="grid"; $env:TYPOSE_OPEN="$PWD\..\.fixtures\grid-1m-x20.csv"; npx electron .; Remove-Item Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_PAGE=grid TYPOSE_OPEN="$(cygpath -w "$PWD/../.fixtures/grid-1m-x20.csv")" npx electron .`

Expected:
- the header row and the row numbers stay put while the wheel and Shift+wheel scroll the cells;
- Tab focuses the "#" corner; the arrows move a 2px inset ring; Ctrl+End shows the last record, numbered `1000000` in the row-number column (ARIA row 1,000,001), with `r1000000c20` focused.

Close the window.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/grid spikes/app/src/renderer/grid.html spikes/app/electron.vite.config.ts spikes/app/e2e/b1-harness.ts spikes/app/e2e/uia-element.ps1 spikes/app/e2e/grid.e2e.ts
git commit -m "spike(b): Grid as role=grid on logical scrolling with horizontal virtualization and roving focus"
```
`git status` then still lists `?? spikes/results/spike-b1-<host>.json`, written by `grid.e2e.ts`'s `save()`; Task B1d commits it.

---

## Task B1c: Rows as role=treegrid, with inline expansion

**Files:**
- Create: `spikes/app/src/renderer/src/treegrid/outline.ts`, `spikes/app/src/renderer/src/treegrid/outline.test.ts`
- Create: `spikes/app/src/renderer/src/treegrid/treegrid.ts`, `spikes/app/src/renderer/src/treegrid/main.ts`, `spikes/app/src/renderer/src/treegrid/treegrid.css`
- Create: `spikes/app/src/renderer/treegrid.html`
- Modify: `spikes/app/electron.vite.config.ts` (add the `treegrid` page)
- Test: `spikes/app/e2e/treegrid.e2e.ts`

**Interfaces:**
- **Consumes:**
  - Task B1b: `Viewport`, `order`, `RowSource`, `boot`, `grid.css`, `e2e/b1-harness.ts`, `e2e/uia-element.ps1`;
  - plan A: `visibleRows`; the RPC methods `rows {doc, start, count} → JsRow[]` and `lines`;
  - the JSONL fixture `spikes/.fixtures/10g.jsonl` (plan A Task 2), or `JSONL_FIXTURE`.
- **Produces:**
  - **outline.ts:**
    - `interface Kid { key: string; value: string }`;
    - `interface Item { line: number; child: number }` (`child` is −1 for the line itself);
    - `class Outline`: `lines`, `total`, `kids(line): Kid[] | undefined`, `at(v: number): Item`, `indexOf(it: Item): number`, `expand(line: number, kids: Kid[]): void`, `collapse(line: number): number` (how many rows went away);
    - `keepAnchor(top: number, v: number, count: number, rowHeight: number): number`, the scroll top that keeps the reading position when `count` rows are inserted (> 0) or removed (< 0) right below visible row `v`.
  - **treegrid.ts:** `class TreeGrid`: `constructor(parent: HTMLElement, core: Core, doc: number, label: string)`; `readonly view: Viewport`; `setLines(n: number, done: boolean): void`.
  - **Page:** `treegrid.html` (`TYPOSE_PAGE=treegrid`).

**Design notes:**
- **Rows are the focus unit** (APG treegrid, row mode). Keys:
  - Up/Down, PageUp/PageDown, Home/End (also with Ctrl, and Cmd+↑/↓ on macOS);
  - Space and Shift+Space move nothing (spec Z51, the Grid's model of Z40; the second e2e test). Space doesn't page-scroll, and Chromium's own Space scroll is prevented too. In the product, Shift+Space selects the row (the record). Selection isn't built in the spike, so it isn't claimed.
  - **Selection is deferred to the Rows milestone (M3, spec §13.2), with this acceptance test:**
    - with focus on a row, Shift+Space selects that row: `aria-selected="true"` on it in the DOM, selected in the UIA tree, and `aria-multiselectable="true"` on the treegrid;
    - it moves neither the focus nor the view, and Space alone changes nothing;
    - a keyboard-reachable command (the row's menu) makes the same selection where the OS or an input method owns the shortcut.
  - Only a focused row's keys are Rows' (spec Z51): a key from a control inside the treegrid is left to it, and so is a key that is part of IME composition. The guards are the Grid's (Task B1b), and so is its known limitation: arrows go to the child control too, with no key back to the rows.
  - Right: a collapsed line expands; an expanded line moves to its first child;
  - Left: a child moves to its line; an expanded line collapses.
- **Expanding** fetches the line through `lines` (≤ 64 KiB) and parses it in the renderer. A line that fails to parse, or is cut at 64 KiB, isn't expandable and carries no `aria-expanded`.
- **Variable row count above the viewport.** `Outline` maps visible index ↔ (line, child) in time linear in the number of expanded lines. When rows are inserted or removed entirely above the top, `keepAnchor` shifts the top by the same amount, so the reading position holds; in logical mode the top is exact, so this stays exact deep in the file.
- **Rows are keyed by identity** (`line:child`), not by visible index, so an expansion doesn't remount the rows below it; `aria-rowindex` is refreshed on every render.

- [ ] **Step 1: Write the failing unit tests**

`spikes/app/src/renderer/src/treegrid/outline.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Outline, keepAnchor } from './outline'

const kids = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: `v${i}` }))

describe('Outline (top-level lines plus the inline children of expanded lines)', () => {
  it('maps visible indices to lines and children both ways', () => {
    const o = new Outline()
    o.lines = 10
    o.expand(3, kids(2))
    o.expand(1, kids(1)) // out of order on purpose
    expect(o.total).toBe(13)
    const order = Array.from({ length: 8 }, (_, v) => o.at(v))
    expect(order).toEqual([
      { line: 0, child: -1 },
      { line: 1, child: -1 },
      { line: 1, child: 0 },
      { line: 2, child: -1 },
      { line: 3, child: -1 },
      { line: 3, child: 0 },
      { line: 3, child: 1 },
      { line: 4, child: -1 }
    ])
    order.forEach((it, v) => expect(o.indexOf(it)).toBe(v))
    expect(o.at(12)).toEqual({ line: 9, child: -1 })
  })

  it('collapses, reporting how many rows went away', () => {
    const o = new Outline()
    o.lines = 10
    o.expand(3, kids(2))
    expect(o.collapse(3)).toBe(2)
    expect(o.collapse(3)).toBe(0)
    expect(o.total).toBe(10)
    expect(o.kids(3)).toBeUndefined()
  })
})

describe('keepAnchor (rows inserted or removed right below visible row v)', () => {
  const ROW = 24
  it('shifts the top when the change is entirely above it', () => {
    expect(keepAnchor(100 * ROW, 10, 5, ROW)).toBe(105 * ROW)
    expect(keepAnchor(100 * ROW, 10, -5, ROW)).toBe(95 * ROW)
  })
  it('leaves the top alone when the change starts at or below it', () => {
    expect(keepAnchor(100 * ROW, 100, 5, ROW)).toBe(100 * ROW)
    expect(keepAnchor(100 * ROW + 10, 100, -5, ROW)).toBe(100 * ROW + 10)
  })
  it('lands on the row after the collapsed one when the removed rows straddle the top', () => {
    expect(keepAnchor(12 * ROW, 10, -5, ROW)).toBe(11 * ROW)
  })
})
```

Run (`spikes/app`): `npx vitest run src/renderer/src/treegrid`
Expected: FAIL with `Error: Cannot find module './outline'`.

- [ ] **Step 2: Implement outline.ts**

`spikes/app/src/renderer/src/treegrid/outline.ts`:
```ts
export interface Kid {
  key: string
  value: string
}

/** A visible row: a top-level line (`child` −1) or the `child`-th inline child of an expanded line. */
export interface Item {
  line: number
  child: number
}

/** Top-level lines plus the inline children of expanded lines, addressed by 0-based visible index. */
export class Outline {
  lines = 0
  // ponytail: lookups are linear in the number of expanded lines; a Fenwick tree if people expand thousands.
  private open: { line: number; kids: Kid[] }[] = [] // sorted by line

  get total(): number {
    return this.open.reduce((n, o) => n + o.kids.length, this.lines)
  }

  kids(line: number): Kid[] | undefined {
    return this.open.find((o) => o.line === line)?.kids
  }

  at(v: number): Item {
    let before = 0 // children shown above v
    for (const o of this.open) {
      const parent = o.line + before
      if (v <= parent) break
      if (v <= parent + o.kids.length) return { line: o.line, child: v - parent - 1 }
      before += o.kids.length
    }
    return { line: v - before, child: -1 }
  }

  indexOf(it: Item): number {
    let before = 0
    for (const o of this.open) {
      if (o.line >= it.line) break
      before += o.kids.length
    }
    return it.line + before + it.child + 1
  }

  expand(line: number, kids: Kid[]): void {
    if (this.kids(line)) return
    this.open.push({ line, kids })
    this.open.sort((a, b) => a.line - b.line)
  }

  /** Returns how many child rows went away. */
  collapse(line: number): number {
    const i = this.open.findIndex((o) => o.line === line)
    return i < 0 ? 0 : this.open.splice(i, 1)[0].kids.length
  }
}

/** The new scroll top after `count` rows are inserted (> 0) or removed (< 0) right below visible row `v`, keeping the reading position. */
export const keepAnchor = (top: number, v: number, count: number, rowHeight: number): number =>
  (v + 1) * rowHeight > top ? top : Math.max((v + 1) * rowHeight, top + count * rowHeight)
```

Run: `npm test`
Expected: `Tests 21 passed`.

- [ ] **Step 3: Write the failing e2e test**

`spikes/app/e2e/treegrid.e2e.ts`:
```ts
import { expect, test } from '@playwright/test'
import { JSONL, cdpFocus, firstLines, focusLog, lastLine, launch, recordFocus, save, uiaByName, waitIndexed } from './b1-harness'

test('treegrid: level, posinset and setsize with true totals; expand and collapse keep the anchor (G2)', async () => {
  const kids = Object.keys(JSON.parse(firstLines(JSONL, 5)[4])).length // line 4 is the one this test expands
  const lastMsg = JSON.parse(lastLine(JSONL)).msg.slice(0, 15) // "line 0006442450" on the stand-in
  const { app, win } = await launch('treegrid', JSONL)
  const tg = win.locator('[role=treegrid]')
  await win.locator('[role=row][aria-posinset="1"] [aria-colindex="3"]').waitFor() // the first row has painted
  const early = await win.evaluate(() => ({
    setsize: document.querySelector('[role=row]')!.getAttribute('aria-setsize'),
    rowcount: document.querySelector('[role=treegrid]')!.getAttribute('aria-rowcount'),
    done: Boolean((window as any).__spike.indexDone)
  }))
  if (!early.done) expect(early).toEqual({ setsize: '-1', rowcount: '-1', done: false }) // never a partial count presented as final
  const lines = await waitIndexed(win) // the true total comes from the index, never a constant
  await expect(tg).toHaveAttribute('aria-rowcount', String(lines))

  await win.locator('[role=row][aria-posinset="1"]').focus()
  await recordFocus(win)
  for (let i = 0; i < 4; i++) await win.keyboard.press('ArrowDown')
  expect((await focusLog(win, 4))[3].slice(0, 2)).toEqual([5, 0])
  const row = win.locator(':focus')
  const attrs = () => row.evaluate((el) => ['aria-level', 'aria-posinset', 'aria-setsize', 'aria-expanded'].map((a) => el.getAttribute(a)))
  expect(await attrs()).toEqual(['1', '5', String(lines), 'false'])
  const cdp = await win.context().newCDPSession(win)
  const axTop = await cdpFocus(cdp)
  expect(axTop).toMatchObject({ role: 'row', focused: true, level: 1, expanded: false })
  const uiaTop = await uiaByName(app, axTop.name)
  if (uiaTop) expect(uiaTop).toMatchObject({ posInSet: 5, sizeOfSet: lines, expand: 'Collapsed' })

  await win.keyboard.press('ArrowRight')
  await expect(tg).toHaveAttribute('aria-rowcount', String(lines + kids))
  await win.keyboard.press('ArrowDown')
  expect((await focusLog(win, 5))[4].slice(0, 2)).toEqual([6, 0])
  expect(await attrs()).toEqual(['2', '1', String(kids), null])
  const axKid = await cdpFocus(cdp)
  expect(axKid).toMatchObject({ role: 'row', focused: true, level: 2 })
  const uiaKid = await uiaByName(app, axKid.name)
  if (uiaKid) expect(uiaKid).toMatchObject({ posInSet: 1, sizeOfSet: kids })
  await win.keyboard.press('ArrowLeft') // to the parent
  await win.keyboard.press('ArrowLeft') // collapse
  await expect(tg).toHaveAttribute('aria-rowcount', String(lines))
  expect(await attrs()).toEqual(['1', '5', String(lines), 'false'])

  // Expanding or collapsing a row above the viewport changes the row count above it; the reading position holds.
  const topRow = () =>
    win.evaluate(() => {
      const g = document.querySelector('[role=treegrid]')!.getBoundingClientRect()
      return document.elementFromPoint(g.left + 40, g.top + 12)?.closest<HTMLElement>('[role=row]')?.dataset.key
    })
  await win.keyboard.press('ArrowRight')
  await expect(tg).toHaveAttribute('aria-rowcount', String(lines + kids))
  // Scroll the expanded row above the viewport with the wheel (Space doesn't page Rows, spec Z51).
  const box = (await tg.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.wheel(0, 2_000)
  await expect.poll(() => win.evaluate(() => (window as any).__spike.view.view.state.top as number)).toBe(2_000)
  const before = await topRow()
  await win.keyboard.press('ArrowLeft') // collapse the focused row, now above the viewport
  await expect(tg).toHaveAttribute('aria-rowcount', String(lines))
  expect(await topRow()).toBe(before)
  await win.keyboard.press('ArrowRight')
  await expect(tg).toHaveAttribute('aria-rowcount', String(lines + kids))
  expect(await topRow()).toBe(before)

  await win.keyboard.press('Control+End')
  const [rowindex, , text] = (await focusLog(win, 7))[6] // moves: 4 × down, into the child, back to the parent, Ctrl+End
  expect(rowindex).toBe(lines + kids)
  expect(text).toContain(lastMsg)
  expect(await attrs()).toEqual(['1', String(lines), String(lines), 'false'])
  const axEnd = await cdpFocus(cdp)
  expect(axEnd).toMatchObject({ role: 'row', focused: true, level: 1 })
  const uiaEnd = await uiaByName(app, axEnd.name)
  if (uiaEnd) expect(uiaEnd).toMatchObject({ posInSet: lines, sizeOfSet: lines })
  save('G2:treegrid', { lines, kids, early, axTop, uiaTop, axKid, uiaKid, anchorRow: before, axEnd, uiaEnd })
  await app.close()
})

test('treegrid: Space and Shift+Space leave the view alone, PageDown pages; a child control and IME composition keep their keys (spec Z51)', async () => {
  const { app, win } = await launch('treegrid', JSONL)
  await waitIndexed(win)
  await win.locator('[role=row][aria-posinset="1"]').focus()
  await recordFocus(win)
  await win.keyboard.press('ArrowDown')
  await focusLog(win, 1)
  // The view's top and the focused row once the key queue has run and two frames have passed.
  const state = () =>
    win.evaluate(async () => {
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
      return { top: (window as any).__spike.view.view.state.top as number, focused: document.activeElement!.getAttribute('aria-posinset') }
    })
  const before = await state()
  expect(before.focused).toBe('2')
  for (const key of ['Space', 'Shift+Space']) {
    await win.keyboard.press(key)
    expect(await state(), key).toEqual(before)
  }
  await win.keyboard.press('PageDown')
  await focusLog(win, 2)
  const paged = await state()
  expect(paged.top).toBeGreaterThan(before.top)
  expect(paged.focused).not.toBe(before.focused)
  // A key that is part of IME composition is the input method's: Rows neither moves nor prevents it.
  const ime = await win.evaluate(async () => {
    const row = document.activeElement!
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })
    row.dispatchEvent(e)
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    return { prevented: e.defaultPrevented, stayed: document.activeElement === row }
  })
  expect(ime).toEqual({ prevented: false, stayed: true })
  // A button inside the treegrid keeps its keys: Space presses it, and an arrow doesn't move Rows' focus.
  await win.evaluate(() => {
    const b = Object.assign(document.createElement('button'), { id: 'probe', textContent: 'probe' })
    b.addEventListener('click', () => ((window as any).__probeClicks = ((window as any).__probeClicks ?? 0) + 1))
    document.querySelector('[role=treegrid]')!.append(b)
    b.focus({ preventScroll: true })
  })
  for (const key of ['Space', 'ArrowDown']) await win.keyboard.press(key)
  const child = await win.evaluate(async () => {
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    return { clicks: (window as any).__probeClicks, focused: document.activeElement!.id }
  })
  expect(child).toEqual({ clicks: 1, focused: 'probe' })
  await app.close()
})
```

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e treegrid`
Expected: FAIL, `2 failed`, each with `TimeoutError: page.waitForFunction: Timeout 30000ms exceeded` in `launch`: `typose://app/treegrid.html` doesn't exist yet.

- [ ] **Step 4: Implement the Rows page**

`spikes/app/src/renderer/src/treegrid/treegrid.ts`:
```ts
import type { Core } from '../core'
import { RowSource } from '../grid/row-source'
import { Viewport, order } from '../grid/viewport'
import { visibleRows } from '../scrollmath'
import { type Item, type Kid, Outline, keepAnchor } from './outline'

const ROW = 24
const KEEP = 4000
const KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End'])

interface Summary {
  line: number
  ts?: string
  kind?: string
  summary: string
  more: boolean
  bad: boolean
}

const keyOf = (it: Item): string => `${it.line}:${it.child}`

function set(el: Element, name: string, value: string | number): void {
  const s = String(value)
  if (el.getAttribute(name) !== s) el.setAttribute(name, s)
}

function cell(col: number, text: string, className: string): HTMLDivElement {
  const c = Object.assign(document.createElement('div'), { className, textContent: text })
  c.role = 'gridcell'
  c.ariaColIndex = String(col)
  return c
}

/** One level of children: the record's top-level keys. ponytail: nested values show as compact JSON, not a deeper tree. */
function children(text: string): Kid[] | null {
  try {
    const v: unknown = JSON.parse(text)
    if (v === null || typeof v !== 'object') return null
    return Object.entries(v).map(([key, value]) => ({ key, value: (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200) }))
  } catch {
    return null
  }
}

/**
 * Rows lens as role=treegrid (spec §6.1). Rows are the focus unit. Top-level rows are lines (aria-level 1,
 * aria-setsize = the line total or −1 while indexing); Right expands a line's keys inline as level-2 rows.
 */
export class TreeGrid {
  readonly view: Viewport
  private readonly outline = new Outline()
  private readonly source: RowSource<Summary>
  private readonly rows = new Map<string, HTMLDivElement>() // by keyOf(item)
  private done = false
  private focus: Item = { line: 0, child: -1 }
  private queue = Promise.resolve()

  constructor(parent: HTMLElement, private readonly core: Core, private readonly doc: number, label: string) {
    this.view = new Viewport(parent, ROW, () => this.render())
    const g = this.view.el
    g.role = 'treegrid'
    g.ariaLabel = label
    g.ariaRowCount = '-1'
    g.ariaColCount = '3'
    this.source = new RowSource<Summary>(
      (start, count) => core.call<Summary[]>('rows', { doc, start, count }).then((rs) => rs.map((r): [number, Summary] => [r.line, r])),
      () => this.render(),
      KEEP
    )
    g.addEventListener('keydown', (e) => this.key(e))
    g.addEventListener('focusin', (e) => this.focused(e.target as HTMLElement))
  }

  setLines(n: number, done: boolean): void {
    this.outline.lines = n
    this.done = done
    this.setTotal()
  }

  /** Visible rows changed (indexing, expand, collapse): totals first, then the viewport, which re-renders. */
  private setTotal(top?: (current: number) => number): void {
    this.view.el.ariaRowCount = this.done ? String(this.outline.total) : '-1'
    this.view.setContent(this.outline.total, 0, top)
  }

  private key(e: KeyboardEvent): void {
    // A focused child control (a button, checkbox or menu item) and IME composition keep their keys (spec Z51, as Z40).
    if (e.isComposing || !(e.target as HTMLElement).matches('[role=row]')) return
    const mac = e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') // Cmd+↑/↓: top/bottom on macOS (brief §7.2)
    const key = mac ? (e.key === 'ArrowUp' ? 'Home' : 'End') : e.key
    // Space doesn't page-scroll Rows, Chromium's own Space scroll included (spec Z51); Page Up/Down page. Shift+Space
    // selects the row in the product: selection isn't built in the spike.
    if (key === ' ') return e.preventDefault()
    if (!KEYS.has(key)) return
    e.preventDefault() // Chromium's own scrolling would be a proportional jump in logical mode
    this.queue = this.queue.then(() => this.act(key)).catch((err: unknown) => console.error('treegrid move failed', err))
  }

  /** Keys are applied one at a time, in order, each from the state the previous one left. */
  private async act(key: string): Promise<void> {
    const o = this.outline
    const v = o.indexOf(this.focus)
    const page = Math.max(1, Math.floor(this.view.viewHeight / ROW) - 1)
    switch (key) {
      case 'ArrowDown': return this.goTo(v + 1)
      case 'ArrowUp': return this.goTo(v - 1)
      case 'PageDown': return this.goTo(v + page, page)
      case 'PageUp': return this.goTo(v - page, -page)
      case 'Home': return this.goTo(0)
      case 'End': return this.goTo(o.total - 1)
      case 'ArrowRight':
        if (this.focus.child >= 0) return
        return o.kids(this.focus.line) ? this.goTo(v + 1) : this.expand(this.focus.line)
      case 'ArrowLeft':
        return this.focus.child >= 0 ? this.goTo(o.indexOf({ line: this.focus.line, child: -1 })) : this.collapse(this.focus.line)
    }
  }

  private async goTo(v: number, scrollRows = 0): Promise<void> {
    const o = this.outline
    if (o.total === 0) return
    const it = o.at(Math.min(Math.max(v, 0), o.total - 1))
    await this.source.ensure(it.line) // real content first, so focus never lands on a placeholder (spec §6.2)
    if (scrollRows) this.view.moveBy(scrollRows * ROW)
    const old = this.rows.get(keyOf(this.focus))
    if (old) old.tabIndex = -1
    this.focus = it
    const y = o.indexOf(it) * ROW
    const top = this.view.state.top
    if (y < top) this.view.moveTo(y)
    else if (y + ROW > top + this.view.viewHeight) this.view.moveTo(y + ROW - this.view.viewHeight)
    this.render()
    this.rows.get(keyOf(it))?.focus({ preventScroll: true })
  }

  private async expand(line: number): Promise<void> {
    await this.source.ensure(line) // the summary may have been evicted while the focused row sat out of view
    const s = this.source.get(line)
    if (!s || s.bad || s.more) return
    const [piece] = await this.core.call<{ text: string; more: boolean }[]>('lines', { doc: this.doc, start: line, count: 1 })
    const kids = piece && !piece.more ? children(piece.text) : null
    if (!kids?.length) return
    // Rows inserted above the viewport move what is on screen; keepAnchor shifts the top by the same amount.
    const v = this.outline.indexOf({ line, child: -1 })
    this.outline.expand(line, kids)
    this.setTotal((top) => keepAnchor(top, v, kids.length, ROW))
  }

  private collapse(line: number): void {
    const v = this.outline.indexOf({ line, child: -1 })
    const n = this.outline.collapse(line)
    if (n) this.setTotal((top) => keepAnchor(top, v, -n, ROW))
  }

  /** Click or assistive-technology focus moves the roving tab stop too. */
  private focused(target: HTMLElement): void {
    const row = target.closest<HTMLElement>('[role=row]')
    const key = row?.dataset.key
    if (!row || !key || key === keyOf(this.focus)) return
    const old = this.rows.get(keyOf(this.focus))
    if (old) old.tabIndex = -1
    const [line, child] = key.split(':').map(Number)
    this.focus = { line, child }
    row.tabIndex = 0
  }

  private render(): void {
    const o = this.outline
    const top = this.view.state.top
    const vh = this.view.viewHeight
    // Overscan is one viewport each way (spec §5.3).
    const r = visibleRows(top, vh, ROW, o.total, Math.ceil(vh / ROW))
    const vs: number[] = []
    for (let v = r.first; v < r.last; v++) vs.push(v)
    const fv = o.indexOf(this.focus) // the focused row stays mounted out of view
    if (fv < o.total && fv < r.first) vs.unshift(fv)
    else if (fv < o.total && fv >= r.last) vs.push(fv)
    const items = vs.map((v) => ({ v, it: o.at(v) }))
    const keep = new Set(items.map(({ it }) => keyOf(it)))
    for (const [k, el] of this.rows) {
      if (keep.has(k)) continue
      el.remove()
      this.rows.delete(k)
    }
    let prev: HTMLDivElement | null = null
    for (const { v, it } of items) {
      const el = this.rows.get(keyOf(it)) ?? this.mount(it)
      order(this.view.layer, el, prev)
      prev = el
      const y = v >= r.first && v < r.last ? v * ROW - top : v < r.first ? -2 * ROW : vh + ROW
      el.style.transform = `translateY(${y}px)`
      this.fill(el, it, v)
    }
    const active = this.rows.get(keyOf(this.focus))
    if (active) active.tabIndex = 0
    if (r.last > r.first) this.source.want({ first: o.at(r.first).line, last: o.at(r.last - 1).line + 1 })
  }

  private mount(it: Item): HTMLDivElement {
    const el = Object.assign(document.createElement('div'), { className: it.child < 0 ? 'gv-row tg-row' : 'gv-row tg-row tg-kid', tabIndex: -1 })
    el.role = 'row'
    el.dataset.key = keyOf(it)
    if (it.child >= 0) {
      const kids = this.outline.kids(it.line)!
      el.ariaLevel = '2'
      el.ariaPosInSet = String(it.child + 1)
      el.ariaSetSize = String(kids.length)
      el.append(cell(1, kids[it.child].key, 'tg-key'), cell(2, kids[it.child].value, 'tg-value'))
    } else {
      el.ariaLevel = '1'
      el.ariaPosInSet = String(it.line + 1)
    }
    this.rows.set(keyOf(it), el)
    return el
  }

  private fill(el: HTMLDivElement, it: Item, v: number): void {
    set(el, 'aria-rowindex', v + 1)
    if (it.child >= 0) return
    set(el, 'aria-setsize', this.done ? this.outline.lines : -1) // never a partial count presented as final (spec §6.2)
    const s = this.source.get(it.line)
    if (!el.childElementCount && s) {
      const ts = cell(1, s.ts ?? '', 'tg-ts')
      ts.prepend(Object.assign(document.createElement('span'), { className: 'tg-chev', ariaHidden: 'true', textContent: '›' }))
      el.append(ts, cell(2, s.kind ?? '', 'tg-kind'), cell(3, s.summary + (s.more ? ' …' : ''), s.bad ? 'tg-summary bad' : 'tg-summary'))
      el.dataset.expandable = String(!s.bad && !s.more)
    }
    if (el.dataset.expandable === 'true') set(el, 'aria-expanded', this.outline.kids(it.line) ? 'true' : 'false')
  }
}
```

`spikes/app/src/renderer/src/treegrid/main.ts`:
```ts
import { boot } from '../grid/boot'
import { TreeGrid } from './treegrid'

await boot((card, core, doc, name) => new TreeGrid(card, core, doc, name))
```

`spikes/app/src/renderer/src/treegrid/treegrid.css`:
```css
/* Rows (treegrid) page, on top of grid/grid.css. */
.tg-row { display: flex; gap: 12px; padding: 0 12px; white-space: pre; overflow: hidden; }
.tg-ts { flex: none; width: 30ch; color: var(--text2); }
.tg-chev { display: inline-block; width: 2ch; transition: transform 90ms; }
.tg-row[aria-expanded='true'] .tg-chev { transform: rotate(90deg); }
.tg-row:not([aria-expanded]) .tg-chev { visibility: hidden; }
.tg-kind { flex: none; width: 8ch; color: #a9c1ff; }
.tg-summary { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.tg-summary.bad { color: var(--warn); }
.tg-kid .tg-key { flex: none; width: 30ch; padding-left: 4ch; box-sizing: border-box; color: var(--text2); }
.tg-kid .tg-value { flex: 1; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) { .tg-chev { transition: none; } }
```

`spikes/app/src/renderer/treegrid.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>Typose spike · Rows</title>
    <link rel="stylesheet" href="./src/style.css" />
    <link rel="stylesheet" href="./src/grid/grid.css" />
    <link rel="stylesheet" href="./src/treegrid/treegrid.css" />
  </head>
  <body>
    <header id="titlebar"><span id="status">connecting…</span></header>
    <main id="card"></main>
    <script type="module" src="./src/treegrid/main.ts"></script>
  </body>
</html>
```

In `spikes/app/electron.vite.config.ts`, change the `pages` line to:
```ts
const pages = ['index', 'grid', 'treegrid']
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e treegrid`
Expected: `2 passed`.

Run: `npm run e2e`
Expected: `12 passed`.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/treegrid spikes/app/src/renderer/treegrid.html spikes/app/electron.vite.config.ts spikes/app/e2e/treegrid.e2e.ts
git commit -m "spike(b): Rows as role=treegrid with inline expansion that keeps the reading position"
```
`git status` then still lists `?? spikes/results/spike-b1-<host>.json`, written by `grid.e2e.ts`'s and `treegrid.e2e.ts`'s `save()`; Task B1d commits it.

---

## Task B1d: Gate runner — G4 traversal and G9 long frames

**Files:**
- Create: `spikes/app/perf/spike-b1.e2e.ts`

**Interfaces:**
- **Consumes:** the Task B1b harness; `percentile` (`perf.ts`); Electron's `app.setAccessibilitySupportEnabled` / `app.isAccessibilitySupportEnabled` and `webContents.sendInputEvent`, called through Playwright's main-process `evaluate`, so main needs no switch.
- **Produces:** keys in `spikes/results/spike-b1-<host>.json`:
  - from the e2e tests: `G2G3:grid`, `wideGrid`, `G2:treegrid`;
  - from this runner: `G4:a11y-<off|on>`, `G4:logical:a11y-on`, and `G9:<surface>:a11y-<off|on>:<1|2|3>` for the G9 runs below;
  - and, gitignored, one diagnostics log per G4 run: `spikes/.fixtures/g4-diag-G4-a11y-off.log`, `g4-diag-G4-a11y-on.log`, `g4-diag-G4-logical-a11y-on.log`.

**Design notes:**
- **G4 (zero skipped or duplicated positions across 1,000 rows × 100 columns):**
  - The path is a snake over the 5,000-column fixture, starting at `r1c1`: 99 Right (or Left) per row and a Down between rows. That is 99,999 key presses visiting 100,000 cells. It runs twice: with accessibility support off, then on.
  - **How the keys are sent.** The first 10 snake rows (1,000 presses) go through Playwright's `keyboard.press`, timed. Each of those is a CDP `Input.dispatchKeyEvent` round trip, which took tens of milliseconds a press on Zack's PC under load (numbers below), so 100,000 of them would take 30 minutes to hours. The other 990 rows go through Electron's `webContents.sendInputEvent`: the same trusted keydown/keyup events, entering the browser's input pipeline without a round trip each. They're sent as one burst per 10 snake rows (1,000 keys; 999 in the last); the test then waits for those focus moves (and so at least one animation frame) before the next burst. Rows and cells are processed one key at a time inside a burst; frames and `scroll` events interleave at burst boundaries.
  - Why bursts of 10 rows: each burst is one round trip into Electron's main process, and on the shared PC those stalled for seconds at random. One burst per row made the run take over an hour; inside the page, a key took 2–3 ms throughout.
  - Pacing single keys from a timer in main doesn't work on Windows: with the window in the background, `setTimeout(…, 4)` stretched to about 200 ms a key.
  - The runner turns off Chromium's background throttling for this test (`webContents.setBackgroundThrottling(false)`), a speed knob for the harness: with the PC idle, injected keys otherwise took about 43 ms each.
  - A `focusin` recorder logs `[aria-rowindex, aria-colindex, text]` for every focus move.
  - Pass: exactly one focus move per press; every step differs by exactly one position; every focused cell's text equals its expected `r<row>c<col>` (so focus never landed on a placeholder or an empty cell); 100,000 distinct positions.
  - Every 100 rows the focused cell is read from the CDP tree (and the CDP Accessibility domain is released again, so the "off" run stays off), and at the end once from UIA; each must name the expected cell (UIA: also its row and column).
  - Pass also requires every focused cell to be wholly inside the grid's client box after its move (DOM), a data cell clear of the sticky header row and row-number column too, and UIA's `IsOffscreen` false at the end-of-run read. A cell parked one row below the view otherwise passes every other criterion, and so does a Left move that leaves 80% of the cell under the row-number column (round-2 review).
  - **Logical scrolling:** a third run snakes 200 rows × 20 columns from row 900,000 of the 1M×20 grid (24M px, logical), accessibility on, with the same criteria (4,000 cells).
  - UIA is read only at the end: with a UIA read every 100 rows the accessibility-on run exited mid-run in 2 of 4 runs and ran 1.5–2× slower. The same exit was then seen in 2 of 5 runs without them (Global Constraints); if it happens, record it as Global Constraints says, then rerun.
  - **Every snake run is armed for such an exit** (round-2 review). Electron logs to stderr (`ELECTRON_ENABLE_LOGGING=1`, Step 3), and Crashpad writes under the profile (`crashReporter.start({ uploadToServer: false })`). Main logs child and render process exits, `unresponsive`, the quit sequence, `process` `exit`, `uncaughtException`, and process metrics every 15 s. The test logs the shell's exit code and signal, and Playwright's page `crash`/`close` and app `close` events. All of it is appended to `spikes/.fixtures/g4-diag-<key>.log` (`:` in the key becomes `-`), run after run. A run that throws also logs the error's first line, the shell's exit code and signal, and whether main is still alive, then rethrows. The snake's own lines are unchanged.
- **G9 (≤ 1% long frames with accessibility on):**
  - 10 s of wheel events, 120 px each, on three surfaces: the 1M×20 grid (vertical, logical), the 5,000-column grid (horizontal, native) and Rows on the JSONL fixture (vertical, logical); each with accessibility support off, then on; three runs of each.
  - One wheel event per Playwright round trip plus 16 ms: the scratch run gave 218–320 events per 10 s.
  - Every run must get at least 200 wheel events (see Global Constraints: input starvation); a slowed harness at ~125 events per 10 s showed clean frames.
  - A long frame is a rAF interval over 20 ms (plan A `frameStats`). Each run also records wheel input latency: from the event's timestamp until the frame after it has painted (rAF, then a task), as plan A measures keys.
  - Every run must move exactly `wheels × 120` px; anything else means the page zoom isn't 1 (the harness also refuses to launch at another zoom).
  - Accessibility on means `app.setAccessibilitySupportEnabled(true)`: Chromium builds and serializes the full accessibility tree, as it does when a screen reader runs. Accessibility on is Electron's support, not a running reader (Global Constraints).

- [ ] **Step 1: Write the runner**

`spikes/app/perf/spike-b1.e2e.ts`:
```ts
import { expect, test } from '@playwright/test'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type AXFocus, GRID_1M, GRID_WIDE, JSONL, cdpFocus, focusLog, launch, recordFocus, save, uiaByName, waitIndexed } from '../e2e/b1-harness'
import { percentile } from '../src/renderer/src/perf'

const stats = (ms: number[]) => ({ n: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(...ms) })
// Snake rows driven by Playwright's keyboard.press, each press a CDP round trip of tens of milliseconds; the rest go
// through Electron's webContents.sendInputEvent, the same trusted key events, one burst per BURST_ROWS snake rows.
// Each burst is one round trip into Electron's main process, which stalled for seconds at a time on the shared PC.
const PLAYWRIGHT_ROWS = 10
const BURST_ROWS = 10

/**
 * G4: a snake of key presses over `nRows` × `nCols` cells from ARIA row `startRow`, column 2 (the first CSV column):
 * nCols − 1 steps right, one down, nCols − 1 left, one down, … Every focus move is checked against the path, and the
 * focused cell must be inside the grid's box after every move (DOM) and at the end of the run (UIA `offscreen`).
 * The results are saved under `resultKey`.
 */
async function snake(resultKey: string, file: string, a11y: boolean, startRow: number, nRows: number, nCols: number) {
  const { app, win } = await launch('grid', file)
  // Diagnostics for an exit mid-run (Global Constraints), appended to spikes/.fixtures/g4-diag-<key>.log run after run.
  const DIAG = resolve(__dirname, '../../.fixtures', `g4-diag-${resultKey.replace(/:/g, '-')}.log`)
  const t0 = Date.now()
  const dlog = (s: string) => appendFileSync(DIAG, `${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${s}\n`)
  const proc = app.process()
  dlog(`launched shell pid ${proc.pid}`)
  proc.stdout?.on('data', (d) => dlog('[out] ' + String(d).trimEnd()))
  proc.stderr?.on('data', (d) => dlog('[err] ' + String(d).trimEnd()))
  proc.on('exit', (code, signal) => dlog(`[shell exit] code=${code} signal=${signal}`))
  app.on('close', () => dlog('[playwright app close event]'))
  win.on('crash', () => dlog('[playwright page crash event]'))
  win.on('close', () => dlog('[playwright page close event]'))
  const mainPid = await app.evaluate(({ app: a, BrowserWindow, crashReporter }) => {
    crashReporter.start({ uploadToServer: false })
    const w = BrowserWindow.getAllWindows()[0]
    const L = (s: string) => console.log('DIAG ' + new Date().toISOString() + ' ' + s)
    a.on('child-process-gone', (_e, d) => L('child-process-gone ' + JSON.stringify(d)))
    a.on('render-process-gone', (_e, _wc, d) => L('render-process-gone ' + JSON.stringify(d)))
    a.on('before-quit', () => L('before-quit'))
    a.on('will-quit', () => L('will-quit'))
    a.on('quit', (_e, code) => L('quit ' + code))
    a.on('window-all-closed', () => L('window-all-closed'))
    w.on('close', () => L('window close'))
    w.on('closed', () => L('window closed'))
    w.on('unresponsive', () => L('window unresponsive'))
    w.on('responsive', () => L('window responsive'))
    w.webContents.on('destroyed', () => L('webContents destroyed'))
    process.on('exit', (c) => L('process exit ' + c))
    process.on('uncaughtException', (e) => L('uncaughtException ' + (e && e.stack)))
    setInterval(() => L('metrics ' + a.getAppMetrics().map((p) => `${p.type}:${p.pid}:${Math.round(p.memory.workingSetSize / 1024)}MB:${p.cpu.percentCPUUsage.toFixed(0)}%`).join(' ')), 15000)
    return { pid: process.pid, crashDumps: a.getPath('crashDumps') }
  })
  dlog(`electron main ${JSON.stringify(mainPid)}`)
  try {
  await waitIndexed(win)
  // A harness speed knob, not a product setting: with the PC idle, Chromium otherwise took ~43 ms per injected key.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  if (a11y) await app.evaluate(({ app: a }) => a.setAccessibilitySupportEnabled(true))
  // Scroll the start row into view (a few rows below the header), then focus its first CSV cell.
  await win.evaluate((y) => (window as any).__spike.view.view.moveTo(y), Math.max(0, (startRow - 6) * 24))
  const start = win.locator(`[role=row][aria-rowindex="${startRow}"] [aria-colindex="2"]`)
  await expect(start).toHaveText(`r${startRow - 1}c1`)
  await start.focus() // the snake's start
  const logical = await win.evaluate(() => (window as any).__spike.view.view.state.geometry.total > 16_000_000)
  await recordFocus(win)
  const cdp = await win.context().newCDPSession(win)
  const rows = Array.from({ length: nRows }, (_, r) => [...Array<string>(nCols - 1).fill(r % 2 ? 'ArrowLeft' : 'ArrowRight'), ...(r < nRows - 1 ? ['ArrowDown'] : [])])
  const path: { row: number; col: number }[] = []
  let [row, col] = [startRow, 2]
  for (const key of rows.flat()) {
    if (key === 'ArrowDown') row++
    else col += key === 'ArrowRight' ? 1 : -1
    path.push({ row, col })
  }
  const expected = (i: number): [number, number, string] => [path[i].row, path[i].col, `r${path[i].row - 1}c${path[i].col - 1}`]
  const pressMs: number[] = []
  const ax: { step: number; cdp: AXFocus }[] = []
  const started = Date.now()
  let sent = 0
  for (let r = 0; r < rows.length; ) {
    const batch = r < PLAYWRIGHT_ROWS ? rows[r] : rows.slice(r, r + BURST_ROWS).flat()
    if (r < PLAYWRIGHT_ROWS) {
      for (const key of batch) {
        const t0 = performance.now()
        await win.keyboard.press(key)
        pressMs.push(performance.now() - t0)
      }
      r++
    } else {
      await app.evaluate(({ BrowserWindow }, keys) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents
        for (const keyCode of keys) {
          wc.sendInputEvent({ type: 'keyDown', keyCode })
          wc.sendInputEvent({ type: 'keyUp', keyCode })
        }
      }, batch.map((k) => k.replace('Arrow', '')))
      r += BURST_ROWS
    }
    sent += batch.length
    // Let the batch's moves land (and at least a frame pass) before the next one.
    await win.waitForFunction((n) => (window as any).__focusLog.length >= n, sent, { timeout: 5 * 60_000 })
    // Every 100 rows the focused cell is read from the browser's AX tree.
    if (r % 100 === 0) ax.push({ step: sent, cdp: await cdpFocus(cdp) })
  }
  const wallMs = Date.now() - started
  const end = expected(path.length - 1)
  const uia = await uiaByName(app, end[2]) // the platform tree at the end of the run
  const log = await focusLog(win, path.length)
  const offscreen: number[] = await win.evaluate(() => (window as any).__focusOffscreen)
  let prev: [number, number, string] = [startRow, 2, `r${startRow - 1}c1`]
  let wrong = 0
  let notOneStep = 0
  let empty = 0
  for (let i = 0; i < log.length; i++) {
    const [r, c, text] = log[i]
    if (Math.abs(r - prev[0]) + Math.abs(c - prev[1]) !== 1) notOneStep++
    if (!text) empty++
    if (JSON.stringify(log[i]) !== JSON.stringify(expected(i))) wrong++
    prev = log[i]
  }
  const distinct = new Set([[startRow, 2], ...log].map(([r, c]) => `${r}:${c}`)).size
  const axWrong = ax.filter((s) => !s.cdp.focused || s.cdp.role !== 'gridcell' || s.cdp.name !== expected(s.step - 1)[2]).length
  // The cell named elsewhere in the tree, at another position, or reported off screen (UIA's IsOffscreen) counts as wrong.
  const uiaWrong = uia ? Number(uia.name !== end[2] || uia.row !== end[0] - 1 || uia.col !== end[1] - 1 || uia.offscreen !== false) : 0
  const accessibility = await app.evaluate(({ app: a }) => a.isAccessibilitySupportEnabled())
  save(resultKey, {
    presses: path.length,
    focusMoves: log.length,
    distinct,
    wrong,
    notOneStep,
    empty,
    offscreen: offscreen.length,
    firstOffscreen: offscreen.slice(0, 5).map((i) => log[i]),
    logical,
    axSamples: ax.length,
    axWrong,
    uia,
    uiaWrong,
    wallMs,
    playwrightPress: stats(pressMs),
    accessibilityAtEnd: accessibility
  })
  expect({ moves: log.length, distinct, wrong, notOneStep, empty, offscreen: offscreen.length, axWrong, uiaWrong }).toEqual({
    moves: path.length,
    distinct: nRows * nCols,
    wrong: 0,
    notOneStep: 0,
    empty: 0,
    offscreen: 0,
    axWrong: 0,
    uiaWrong: 0
  })
  await app.close()
  dlog('snake done')
  return { logical }
  } catch (e) {
    let alive = 'unknown'
    try { process.kill(mainPid.pid, 0); alive = 'alive' } catch (k) { alive = 'gone: ' + (k as Error).message }
    dlog(`ERROR ${(e as Error).message.split('\n')[0]} | shell exitCode=${proc.exitCode} signalCode=${proc.signalCode} | electron main pid ${mainPid.pid} ${alive}`)
    throw e
  }
}

for (const a11y of [false, true]) {
  test(`G4: 1,000 rows × 100 columns of key presses, zero skipped or duplicated positions, accessibility ${a11y ? 'on' : 'off'}`, async () => {
    test.setTimeout(120 * 60_000)
    await snake(`G4:a11y-${a11y ? 'on' : 'off'}`, GRID_WIDE, a11y, 2, 1000, 100)
  })
}

test('G4 logical: 200 rows × 20 columns from row 900,000 of the 1M-row grid (logical scrolling), accessibility on', async () => {
  test.setTimeout(30 * 60_000)
  expect((await snake('G4:logical:a11y-on', GRID_1M, true, 900_000, 200, 20)).logical).toBe(true)
})

const SCROLLS = [
  { name: 'grid 1M×20 vertical', page: 'grid', file: GRID_1M, dx: 0, dy: 120 },
  { name: 'grid 1k×5000 horizontal', page: 'grid', file: GRID_WIDE, dx: 120, dy: 0 },
  { name: 'treegrid jsonl vertical', page: 'treegrid', file: JSONL, dx: 0, dy: 120 }
] as const

// Three runs of each, since one 10 s run on a shared machine says little.
for (const s of SCROLLS) {
  for (const a11y of [false, true]) {
    for (const run of [1, 2, 3]) {
      test(`G9: long frames over 10 s of wheel scrolling, ${s.name}, accessibility ${a11y ? 'on' : 'off'}, run ${run}`, async () => {
        const { app, win } = await launch(s.page, s.file)
        await waitIndexed(win)
        // What a running screen reader turns on: Chromium builds and serializes the whole accessibility tree.
        if (a11y) await app.evaluate(({ app: a }) => a.setAccessibilitySupportEnabled(true))
        const enabled = await app.evaluate(({ app: a }) => a.isAccessibilitySupportEnabled())
        expect(enabled).toBe(a11y)
        const box = (await win.locator('[role=grid],[role=treegrid]').boundingBox())!
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await win.waitForTimeout(500)
        await win.evaluate(() => {
          // Input latency: from the wheel event's timestamp until the frame after it has painted (rAF, then a task).
          const latency: number[] = ((window as any).__wheelLatency = [])
          addEventListener('wheel', (e) => requestAnimationFrame(() => setTimeout(() => latency.push(performance.now() - e.timeStamp))), { capture: true, passive: true })
          ;(window as any).__spike.perf.startFrames()
        })
        const started = Date.now()
        let wheels = 0
        while (Date.now() - started < 10_000) {
          await win.mouse.wheel(s.dx, s.dy)
          wheels++
          await win.waitForTimeout(16)
        }
        const frames = await win.evaluate(() => (window as any).__spike.perf.stopFrames())
        const latency: number[] = await win.evaluate(() => (window as any).__wheelLatency)
        await win.waitForTimeout(300) // let a native smooth scroll settle
        const moved = await win.evaluate(() => {
          const v = (window as any).__spike.view.view
          return { top: v.state.top as number, left: v.left as number, mounted: document.querySelectorAll('[role=row]').length }
        })
        save(`G9:${s.name}:a11y-${a11y ? 'on' : 'off'}:${run}`, { ...frames, wheels, wheelLatency: stats(latency), moved, accessibilitySupportEnabled: enabled })
        expect(moved.top + moved.left).toBe(wheels * 120) // 1:1 at zoom 1; a persisted page zoom would show here
        // A starved run (input that never arrived) has an idle page and clean frames: the frame metric can't see it.
        expect(wheels).toBeGreaterThanOrEqual(200)
        expect(frames.longShare).toBeLessThanOrEqual(0.01)
        await app.close()
      })
    }
  }
}
```

- [ ] **Step 2: Run G9**

A qualifying run needs the quiet PC of Task B2e Step 2 (spec Z49). Run (`spikes/app`): `npm run build`, then `npx playwright test --project=perf spike-b1 -g G9`
Expected: `18 passed` (each run with at least 200 wheel events), and 18 `G9:*` keys in the results file.

The scratch run gave (Zack's PC, shared with other jobs, stand-in JSONL of 6,442,451 lines):

| Surface | Accessibility | Long frames per run (of frames) | Long share per run | Max rAF gap per run (ms) | Wheel events per run | Wheel latency p50 / p95 / max per run (ms) |
|---|---|---|---|---|---|---|
| grid 1M×20 vertical | off | 0 of 1651 · 0 of 1645 · 0 of 1636 | 0.00% · 0.00% · 0.00% | 12.2 · 18.2 · 18.3 | 298 · 295 · 296 | 12.7 / 19.7 / 32.7 · 13.0 / 20.7 / 26.7 · 13.2 / 20.5 / 37.8 |
| grid 1M×20 vertical | on | 0 of 1620 · 0 of 1628 · 5 of 1577 | 0.00% · 0.00% · 0.32% | 18.4 · 18.2 · 24.4 | 288 · 293 · 273 | 13.1 / 25.5 / 33.3 · 13.3 / 24.0 / 34.0 · 13.9 / 28.9 / 39.9 |
| grid 1k×5000 horizontal | off | 0 of 1586 · 0 of 1635 · 0 of 1603 | 0.00% · 0.00% · 0.00% | 18.2 · 12.3 · 18.3 | 229 · 256 · 234 | 9.9 / 19.5 / 81.0 · 10.1 / 18.5 / 71.1 · 10.3 / 19.4 / 55.7 |
| grid 1k×5000 horizontal | on | 3 of 1508 · 0 of 1623 · 0 of 1613 | 0.20% · 0.00% · 0.00% | 32.0 · 18.3 · 18.2 | 218 · 255 · 249 | 10.0 / 25.6 / 82.8 · 10.2 / 22.8 / 65.4 · 10.1 / 21.8 / 88.9 |
| treegrid jsonl vertical | off | 0 of 1651 · 0 of 1648 · 0 of 1650 | 0.00% · 0.00% · 0.00% | 7.1 · 6.3 · 6.2 | 318 · 320 · 320 | 10.9 / 13.6 / 14.4 · 10.7 / 13.4 / 14.0 · 10.9 / 13.4 / 14.1 |
| treegrid jsonl vertical | on | 0 of 1649 · 0 of 1648 · 0 of 1649 | 0.00% · 0.00% · 0.00% | 12.2 · 6.3 · 6.3 | 320 · 318 · 317 | 11.1 / 13.8 / 15.0 · 11.0 / 13.7 / 14.8 · 10.9 / 13.9 / 16.1 |

- [ ] **Step 3: Run G4**

Run (`spikes/app`), with Electron's logging on and no other UIA client or desktop automation on the session:
- PowerShell: `$env:ELECTRON_ENABLE_LOGGING = '1'; npx playwright test --project=perf spike-b1 -g G4; Remove-Item Env:ELECTRON_ENABLE_LOGGING`
- Git Bash: `ELECTRON_ENABLE_LOGGING=1 npx playwright test --project=perf spike-b1 -g G4`

Expected: `3 passed`, and keys `G4:a11y-off` and `G4:a11y-on`, each with `focusMoves: 99999`, `distinct: 100000`, `wrong: 0`, `notOneStep: 0`, `empty: 0`, `offscreen: 0`, `axWrong: 0`, `uiaWrong: 0`; and `G4:logical:a11y-on` with `focusMoves: 3999`, `distinct: 4000`, `logical: true` and the same criteria 0. Each run's `spikes/.fixtures/g4-diag-*.log` ends with `snake done`. If a run exits instead, Global Constraints says what to keep.

The scratch run gave (Zack's PC, shared with other jobs, the user away):

- Accessibility off: 99999 presses → 99999 focus moves, 100000 distinct positions; wrong 0, not one step 0, empty 0; CDP samples 10 (wrong 0); UIA at the end: `r1000c1` Row 1000 Column 1 of 1001 × 5001 (wrong 0). Wall time 472 s. Playwright `keyboard.press`: n = 1000, p50 30.3 ms, p95 67.5 ms, max 114.3 ms. `isAccessibilitySupportEnabled()` at the end: false.
- Accessibility on: 99999 presses → 99999 focus moves, 100000 distinct positions; wrong 0, not one step 0, empty 0; CDP samples 10 (wrong 0); UIA at the end: `r1000c1` Row 1000 Column 1 of 1001 × 5001 (wrong 0). Wall time 479 s. Playwright `keyboard.press`: n = 1000, p50 24.2 ms, p95 38.1 ms, max 62.1 ms. `isAccessibilitySupportEnabled()` at the end: true.

- [ ] **Step 4: Read your own work (rule 8), then commit**

```bash
git add spikes/app/perf/spike-b1.e2e.ts spikes/results/spike-b1-*.json
git commit -m "spike(b): Grid and Rows gate runner (G4 traversal, G9 long frames) and results"
```
The results file also holds the e2e tests' keys (`G2G3:grid`, `wideGrid`, `G2:treegrid`), and every later `npm run e2e` rewrites them. Some of their fields depend on timing (`G2G3:grid`'s `early`: whether indexing had finished at the first read), so after a later task's commit `git status` may list `spikes/results/spike-b1-<host>.json` as modified. Leave it unstaged: this commit is the record.

---

## Rendered and Transcript (Tasks B2a–B2e)

**Risk measured:** a screen reader in browse mode sees only what is in the DOM. With a 500-block window (spec §6.2), does the heading key reach headings outside the window, and does continuous reading follow the window without a gap or a duplicate?

**Answer the code below implements and gates:**
- **Every heading stays mounted.** The document's ~1,000 headings are pinned in document order, as real `h1`–`h3` elements. Between them, unmounted runs are `aria-hidden` spacers sized from measured heights (or an estimate). So the heading key always has a next heading to land on, however far outside the window it is. When the screen reader scrolls it into view, the window recenters there. Without the pinned headings, the same heading key finds nothing past the window (measured as a control in Task B2e).
- **The window follows the reader.** Position = the items in the viewport, so any screen reader that scrolls its cursor into view drives it. A mounted node is never moved or recreated while it stays mounted, and every change keeps the reading anchor in place, so the element under the cursor keeps its identity and its place on screen.

**Spec:** §5.2–5.3, §6.1–6.3, §13.1 Spike B. **Brief:** §5.2 (Rendered, Outline), §5.4 (Transcript), §9.

**Builds on:** plan A Tasks 1–10 and Task B0: `electron.vite.config.ts` builds one renderer entry per name in `const pages`, and main loads `typose://app/${process.env.TYPOSE_PAGE ?? 'index'}.html`.

---

## Task B2a: Spike B fixtures — a 20,000-block document and a 5,000-turn transcript

**Files:**
- Create: `spikes/core/fixtures-gen/src/docs.rs`, `spikes/core/fixtures-gen/tests/docs.rs`
- Modify: `spikes/core/fixtures-gen/Cargo.toml` (dev-dependency), `spikes/core/fixtures-gen/src/lib.rs` (`pub mod docs;`), `spikes/core/fixtures-gen/src/main.rs` (two CLI kinds)

**Interfaces:**
- **Consumes:** the `fixtures-gen` crate and CLI from plan A Task 2.
- **Produces:**
  - `fixtures_gen::docs::QUIET: [(u64, u64); 3]`: the heading-free stretches `[3,000, 5,500)`, `[9,000, 11,500)`, `[15,000, 17,500)`.
  - `fixtures_gen::docs::is_heading(i: u64) -> bool`: every 12th block outside `QUIET`.
  - `fixtures_gen::docs::doc<W: Write>(w: &mut W, blocks: u64) -> io::Result<u64>`: `blocks` lines of `{"k":"h1|h2|h3|p|ul|pre|table","t":...}`; `t` is a string, except a string array for `ul` and an array of string rows for `table` (first row = header). Returns the heading count. Every block's text carries its 0-based line number (`Block 4512.`, `Block 4512 item 1:`, `// block 4512`, `Block 4512 row 0`, `Section 251 (block 5508)`).
  - `fixtures_gen::docs::transcript<W: Write>(w: &mut W, turns: u64) -> io::Result<()>`: `turns` lines of `{"role":"user|assistant|tool","t":"Turn <n>. ..."}`, numbered from 1 like `aria-posinset`. Assistant turns have 1–6 paragraphs separated by `\n\n`; tool turns 1–12 lines.
  - CLI: `fixtures-gen doc --out <path> [--blocks N]` and `fixtures-gen transcript --out <path> [--turns N]`.
- Spike B renders a **block model**: parsing real Markdown into blocks is Spike C's job. Rows reach the renderer through plan A's `lines` RPC.

- [ ] **Step 1: Write the failing tests**

Append to `spikes/core/fixtures-gen/Cargo.toml`, after a blank line (below the empty `[dependencies]` table):
```toml
[dev-dependencies]
serde_json = "1"
```
`spikes/core/fixtures-gen/tests/docs.rs`:
```rust
use fixtures_gen::docs::{doc, transcript};
use serde_json::Value;

fn parse(out: &[u8]) -> Vec<Value> {
    let text = std::str::from_utf8(out).unwrap();
    text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn doc_has_about_a_thousand_headings_and_three_long_heading_free_stretches() {
    let mut out = Vec::new();
    let headings = doc(&mut out, 20_000).unwrap();
    let blocks = parse(&out);
    assert_eq!(blocks.len(), 20_000);
    assert_eq!(blocks[0]["k"], "h1");
    let kinds: Vec<&str> = blocks.iter().map(|b| b["k"].as_str().unwrap()).collect();
    let is_h = |k: &str| k.starts_with('h');
    assert_eq!(kinds.iter().filter(|k| is_h(k)).count() as u64, headings);
    assert!((900..=1_100).contains(&headings), "{headings}");
    for k in ["h1", "h2", "h3", "p", "ul", "pre", "table"] {
        assert!(kinds.contains(&k), "no {k}");
    }
    let (mut run, mut long_runs) = (0, 0);
    for k in &kinds {
        if is_h(k) {
            if run >= 2_000 {
                long_runs += 1;
            }
            run = 0;
        } else {
            run += 1;
        }
    }
    assert!(long_runs >= 3, "{long_runs}");
    let sizes: Vec<usize> = blocks.iter().map(|b| b["t"].to_string().len()).collect();
    assert!(sizes.iter().max().unwrap() / sizes.iter().min().unwrap() >= 10, "block sizes barely vary");
}

#[test]
fn transcript_turns_have_roles_numbers_and_varied_lengths() {
    let mut out = Vec::new();
    transcript(&mut out, 5_000).unwrap();
    let turns = parse(&out);
    assert_eq!(turns.len(), 5_000);
    for (n, turn) in turns.iter().enumerate() {
        assert!(["user", "assistant", "tool"].contains(&turn["role"].as_str().unwrap()));
        assert!(turn["t"].as_str().unwrap().starts_with(&format!("Turn {}. ", n + 1)));
    }
    for role in ["user", "assistant", "tool"] {
        assert!(turns.iter().any(|t| t["role"] == role), "no {role}");
    }
    let sizes: Vec<usize> = turns.iter().map(|t| t["t"].as_str().unwrap().len()).collect();
    assert!(sizes.iter().max().unwrap() / sizes.iter().min().unwrap() >= 20, "turn sizes barely vary");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: FAIL to compile with `error[E0432]: unresolved import` for `fixtures_gen::docs` (at `fixtures-gen\tests\docs.rs:1:19`).

- [ ] **Step 3: Implement the generators**

`spikes/core/fixtures-gen/src/docs.rs`:
```rust
//! Spike B fixtures: a block-model document and a chat transcript, one JSON object per line.
//! Spike B renders a block model; parsing real Markdown into blocks is Spike C's job.
use std::io::{self, Write};

/// The heading-free stretches, as block ranges (spec §13.1 Spike B: "long heading-free stretches").
pub const QUIET: [(u64, u64); 3] = [(3_000, 5_500), (9_000, 11_500), (15_000, 17_500)];

const WORDS: [&str; 16] = [
    "typose", "renders", "a", "block", "model", "with", "measured", "heights", "while", "the", "reader", "follows",
    "its", "window", "across", "stretches",
];

/// xorshift64*: deterministic fixtures without a dependency.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) % n
    }

    /// `min..min+spread` words.
    fn words(&mut self, min: u64, spread: u64) -> String {
        let n = min + self.below(spread);
        (0..n).map(|_| WORDS[self.below(16) as usize]).collect::<Vec<_>>().join(" ")
    }
}

/// Outside the quiet stretches, every 12th block is a heading.
pub fn is_heading(i: u64) -> bool {
    i % 12 == 0 && !QUIET.iter().any(|&(a, b)| (a..b).contains(&i))
}

/// `blocks` lines of `{"k":"h1|h2|h3|p|ul|pre|table","t":...}`. Returns the heading count.
pub fn doc<W: Write>(w: &mut W, blocks: u64) -> io::Result<u64> {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut headings = 0u64;
    for i in 0..blocks {
        if is_heading(i) {
            headings += 1;
            let level = if headings % 10 == 1 { 1 } else if headings % 3 == 0 { 3 } else { 2 };
            writeln!(w, r#"{{"k":"h{level}","t":"Section {headings} (block {i})"}}"#)?;
            continue;
        }
        match rng.below(10) {
            0 => {
                let items: Vec<String> =
                    (0..2 + rng.below(5)).map(|n| format!(r#""Block {i} item {}: {}""#, n + 1, rng.words(3, 12))).collect();
                writeln!(w, r#"{{"k":"ul","t":[{}]}}"#, items.join(","))?;
            }
            1 => {
                let lines: Vec<String> = (0..2 + rng.below(13)).map(|n| format!("let v{n} = {};", rng.below(1000))).collect();
                writeln!(w, r#"{{"k":"pre","t":"// block {i}\n{}"}}"#, lines.join("\\n"))?;
            }
            2 => {
                let rows: Vec<String> = (0..2 + rng.below(5))
                    .map(|r| format!(r#"["Block {i} row {r}","{}","{}"]"#, rng.words(1, 3), rng.below(100_000)))
                    .collect();
                writeln!(w, r#"{{"k":"table","t":[["Block","Words","Count"],{}]}}"#, rows.join(","))?;
            }
            _ => writeln!(w, r#"{{"k":"p","t":"Block {i}. {}."}}"#, rng.words(4, 90))?,
        }
    }
    Ok(headings)
}

/// `turns` lines of `{"role":"user|assistant|tool","t":"Turn <n>. ..."}`, numbered from 1 like `aria-posinset`.
/// Roles alternate user → assistant, with tool turns between assistant turns.
pub fn transcript<W: Write>(w: &mut W, turns: u64) -> io::Result<()> {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let mut role = "user";
    for n in 0..turns {
        let t = match role {
            "user" => rng.words(3, 30),
            "tool" => (0..1 + rng.below(12)).map(|_| rng.words(2, 8)).collect::<Vec<_>>().join("\\n"),
            _ => (0..1 + rng.below(6)).map(|_| rng.words(10, 80)).collect::<Vec<_>>().join(".\\n\\n"),
        };
        writeln!(w, r#"{{"role":"{role}","t":"Turn {}. {t}"}}"#, n + 1)?;
        role = match role {
            "assistant" if rng.below(5) < 2 => "tool",
            "assistant" => "user",
            _ => "assistant",
        };
    }
    Ok(())
}
```
Add as the first line of `spikes/core/fixtures-gen/src/lib.rs`, followed by one blank line:
```rust
pub mod docs;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: `test result: ok. 3 passed` for `src\lib.rs` (plan A's two tests and Task B1a's) and `test result: ok. 2 passed` for `tests\docs.rs`.

- [ ] **Step 5: Add the CLI kinds and generate the fixtures**

In `spikes/core/fixtures-gen/src/main.rs`, add directly above `other => panic!("unknown fixture kind {other:?}"),` (below Task B1a's `csv-grid` arm):
```rust
        Some("doc") => {
            let blocks = num("--blocks", 20_000);
            let headings = fixtures_gen::docs::doc(&mut w, blocks)?;
            eprintln!("{out}: {blocks} blocks, {headings} headings");
        }
        Some("transcript") => {
            let turns = num("--turns", 5_000);
            fixtures_gen::docs::transcript(&mut w, turns)?;
            eprintln!("{out}: {turns} turns");
        }
```
Run (`spikes/core`):
```bash
cargo run --release -p fixtures-gen -- doc --blocks 20000 --out ../.fixtures/doc-20k.jsonl
cargo run --release -p fixtures-gen -- transcript --turns 5000 --out ../.fixtures/transcript-5k.jsonl
```
Expected:
- `../.fixtures/doc-20k.jsonl: 20000 blocks, 1040 headings` (5,939,663 bytes)
- `../.fixtures/transcript-5k.jsonl: 5000 turns` (3,482,972 bytes)

Task B2d's indexing test also uses plan A's `../.fixtures/1g.jsonl` (plan A Task 2 Step 5); regenerate it if it's gone.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/core/fixtures-gen spikes/core/Cargo.lock
git commit -m "spike(b): block-model document and transcript fixtures"
```

---

## Task B2b: The measured flow window and the Rendered lens

**Files:**
- Create: `spikes/app/src/renderer/src/a11y/window-math.ts`, `spikes/app/src/renderer/src/a11y/window-math.test.ts`
- Create: `spikes/app/src/renderer/src/a11y/flow-window.ts`, `spikes/app/src/renderer/src/a11y/mode.ts`, `spikes/app/src/renderer/src/a11y/flow.css`
- Create: `spikes/app/src/renderer/src/doc/blocks.ts`, `spikes/app/src/renderer/src/doc/main.ts`, `spikes/app/src/renderer/doc.html`
- Create: `spikes/app/e2e/flow-launch.ts`, `spikes/app/e2e/doc.e2e.ts`
- Modify: `spikes/app/electron.vite.config.ts` (add the `doc` page)

**Interfaces:**
- **Consumes:** `connectCore`/`Core` (`core.ts`), `PerfLog` (`perf.ts`), the `open` and `lines` RPC methods and the `progress` event (plan A Task 7), `TYPOSE_PAGE` (Task B0) and `TYPOSE_OPEN` (plan A Task 8), `.fixtures/doc-20k.jsonl` (Task B2a).
- **Produces:**
  - **window-math.ts:** `A11Y_WINDOW = 500`; `interface Win { w0: number; w1: number }` (mounted items `[w0, w1)`); `nextWindow(cur: Win, first: number, last: number, n: number, a11y: boolean): Win`, which returns `cur` itself when nothing changes; `gapIndexAt(heights: ArrayLike<number>, a: number, b: number, offset: number): { i: number; start: number }`.
  - **flow-window.ts:** `interface FlowOptions { render(i: number, item: unknown): HTMLElement; estimate: number; noun: string; edgesOutside?: boolean }` and `class FlowWindow`:
    - `constructor(scroller: HTMLElement, content: HTMLElement, core: Core, doc: number, opts: FlowOptions)`;
    - `n`, `win: Win`, `a11y`, `stats: { applies, recenters, fetches, corrections, maxCorrection, maxResidual, maxApplyMs, edgeActivations }`;
    - `setCount(n)`, `setPinned(items: Map<number, unknown>)`, `setA11y(on)`;
    - `settled(): Promise<void>` (the readiness hook), `mounted(i): HTMLElement | undefined`;
    - `goTo(i): Promise<HTMLElement | undefined>`: loads the window around `i`, then scrolls `i` to the top and focuses it.
  - **mode.ts:** `onA11yMode(cb: (on: boolean) => void)`: listens for the `{ type: 'a11y', on }` window message. It stays silent until Task B2c adds the sender.
  - **blocks.ts:** `interface Block { k: string; t: unknown }`, `isHeading(b)`, `toBlock(item: unknown): Block`, `renderBlock(i, b): HTMLElement`.
  - **doc page:** `window.__spike = { perf, a11y, core, open(path, opts?: { skeleton?: boolean }), view }`. `open` resolves once the first window is mounted. `skeleton: false` drops the pinned headings (the control in Task B2e). `?open=` (from `TYPOSE_OPEN`) opens at launch.
  - **flow-launch.ts:** `FIX`, `launchPage(page: 'doc' | 'transcript', env?): Promise<{ app, win }>`, `openFixture(win, file, opts?)`, `settle(win)`; `watchBusy(win, selector)`, which from then on counts the children added to or removed from the element and how many of those changes came while it was not `aria-busy="true"`, and `busyReport(win, selector) → { changes, outsideBusy, busyNow }`.

**Design notes:**
- **Items sit in normal flow,** not absolutely positioned, so the accessibility tree reads them as one document in order. Every top-level item has zero vertical margins (spacing is padding), so an item's height is exactly the space it takes. Heights are measured when an item unmounts; while mounted, the flow itself is the measurement.
- **Spacers:** one `aria-hidden` `div` per unmounted run, keyed by its first item. A run that didn't change keeps its spacer, so far-off spacers are never touched.
- **Identity:** a mounted node is never moved or recreated while it stays mounted. New nodes are inserted next to existing ones.
- **The reading anchor** (the focused item if it's in view, else the first mounted item in view, else the estimated item at the top) is measured before and after every change, and `scrollTop` absorbs the difference. That is how an estimate corrected to a real height never moves what the reader is looking at (spec §5.3).
- **Position** is the range of items in the viewport. A screen reader that scrolls the element under its cursor into view therefore drives the window with nothing else. Automation can only stand in for that with `scrollIntoView` (Task B2e); whether NVDA, Narrator and VoiceOver actually scroll is what the screen-reader script (Task B4) would check; it is parked (spec Z39), so this plan doesn't claim it. Focusing an item scrolls it into view too, and a focused item stays mounted wherever the window goes.
- **Windows:** normal mode = the viewport plus one viewport of overscan each way (spec §5.3), recentered when less than half a viewport remains on a side. Accessibility mode = 500 items, recentered when the position enters an outer quarter (spec §6.2): each recenter shifts it by 126 items.
- **aria-busy:** the content element is `aria-busy="true"` from the moment a drain will fetch or change items until it has finished (spec §6.1, the feed pattern: busy while articles are added and removed). A scroll that changes nothing never sets it.
- **Edge controls** (`Continue: previous 500 <noun>` and `Continue: next 500 <noun>`, accessibility mode only, spec §6.2) sit at the window's ends inside the content, unless `edgesOutside`, which puts them just before and after the content: a `role=feed` may contain only articles.
- **Focus rings** on the scroller and on articles are inset (the scroller's `outline: none` plus an inset box-shadow; articles `outline-offset: -2px`): an outer ring would be clipped by the card or by the scroller's edge (found by Task B3c's 200% checks).
- **Native scrolling only:** 20,000 blocks are about 2.6M px (130 px a block, measured over three 500-block windows at a 752px viewport), well under plan A's 16M px cap. A measured layout past the cap would need `scrollmath.ts`'s logical mode (marked `ponytail:` in the code).
- **The Outline:** a `nav` listing every heading. Collapsed, it is visually hidden with `clip-path` (never `display: none`), so it stays in the accessibility tree; focus inside it shows it.

- [ ] **Step 1: Write the failing window-math tests**

`spikes/app/src/renderer/src/a11y/window-math.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { A11Y_WINDOW, gapIndexAt, nextWindow, type Win } from './window-math'

const N = 20_000

describe('accessibility window (spec §6.2)', () => {
  it('mounts 500 items centered on the position', () => {
    expect(nextWindow({ w0: 0, w1: 0 }, 10_000, 10_009, N, true)).toEqual({ w0: 9_755, w1: 10_255 })
  })

  it('keeps the window while the position stays out of the outer quarters', () => {
    const cur = { w0: 9_755, w1: 10_255 }
    expect(nextWindow(cur, 9_880, 9_889, N, true)).toBe(cur)
    expect(nextWindow(cur, 10_120, 10_129, N, true)).toBe(cur)
  })

  it('recenters when the position enters an outer quarter', () => {
    const cur = { w0: 9_755, w1: 10_255 }
    expect(nextWindow(cur, 10_121, 10_130, N, true)).toEqual({ w0: 9_876, w1: 10_376 })
    expect(nextWindow(cur, 9_879, 9_888, N, true)).toEqual({ w0: 9_634, w1: 10_134 })
  })

  it('reading 2,000 items one at a time recenters every 126 items and never loses the cursor', () => {
    let win: Win = { w0: 0, w1: 0 }
    let recenters = 0
    for (let i = 3_000; i < 5_000; i++) {
      const next = nextWindow(win, i, i, N, true)
      if (next !== win && win.w1 > 0) recenters++
      win = next
      expect(i - win.w0).toBeGreaterThanOrEqual(A11Y_WINDOW / 4)
      expect(win.w1 - 1 - i).toBeGreaterThanOrEqual(A11Y_WINDOW / 4 - 1)
    }
    expect(recenters).toBe(15)
  })

  it('clamps at both ends and covers a short document whole', () => {
    expect(nextWindow({ w0: 0, w1: 0 }, 0, 9, N, true)).toEqual({ w0: 0, w1: 500 })
    expect(nextWindow({ w0: 0, w1: 0 }, N - 10, N - 1, N, true)).toEqual({ w0: N - 500, w1: N })
    expect(nextWindow({ w0: 0, w1: 0 }, 5, 9, 120, true)).toEqual({ w0: 0, w1: 120 })
    const start = { w0: 0, w1: 500 }
    expect(nextWindow(start, 0, 9, N, true)).toBe(start)
  })
})

describe('normal window (spec §5.3: viewport plus one viewport of overscan each way)', () => {
  it('mounts three viewports of items around the viewport', () => {
    expect(nextWindow({ w0: 0, w1: 0 }, 100, 109, N, false)).toEqual({ w0: 90, w1: 120 })
  })

  it('keeps the window while half a viewport of overscan remains on each side', () => {
    const cur = { w0: 90, w1: 120 }
    expect(nextWindow(cur, 104, 113, N, false)).toBe(cur)
    expect(nextWindow(cur, 106, 115, N, false)).toEqual({ w0: 96, w1: 126 })
  })

  it('shrinks back to the normal size when accessibility mode ends', () => {
    expect(nextWindow({ w0: 9_755, w1: 10_255 }, 10_000, 10_009, N, false)).toEqual({ w0: 9_990, w1: 10_020 })
  })
})

describe('gapIndexAt', () => {
  it('finds the unmounted item under an offset into a gap, with its estimated start', () => {
    const heights = [10, 20, 30, 40]
    expect(gapIndexAt(heights, 1, 4, 0)).toEqual({ i: 1, start: 0 })
    expect(gapIndexAt(heights, 1, 4, 25)).toEqual({ i: 2, start: 20 })
    expect(gapIndexAt(heights, 1, 4, 1_000)).toEqual({ i: 3, start: 50 })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (`spikes/app`): `npm test`
Expected: FAIL with `Error: Cannot find module './window-math'` (`Test Files  1 failed | 4 passed (5)`, `Tests  21 passed (21)`).

- [ ] **Step 3: Implement the window math**

`spikes/app/src/renderer/src/a11y/window-math.ts`:
```ts
/** With a screen reader active, document lenses mount a wide window of 500 blocks or turns (spec §6.2). */
export const A11Y_WINDOW = 500

/** Mounted items [w0, w1). */
export interface Win {
  w0: number
  w1: number
}

/**
 * The window for a position spanning items [first, last] of n: the viewport, or the element under the cursor.
 * - Accessibility mode: 500 items, recentered only when the position enters an outer quarter (spec §6.2).
 * - Otherwise: the viewport plus one viewport of overscan each way (spec §5.3), recentered when less than
 *   half a viewport of overscan remains on a side, or when the window is over twice that size (as when
 *   accessibility mode ends).
 * Returns `cur` itself when nothing changes.
 */
export function nextWindow(cur: Win, first: number, last: number, n: number, a11y: boolean): Win {
  const span = last - first + 1
  const size = Math.min(n, a11y ? A11Y_WINDOW : 3 * span)
  const margin = a11y ? size / 4 : span / 2
  const keep =
    first >= cur.w0 &&
    last < cur.w1 &&
    (cur.w0 === 0 || first - cur.w0 >= margin) &&
    (cur.w1 === n || cur.w1 - 1 - last >= margin) &&
    (a11y ? cur.w1 - cur.w0 === size : cur.w1 - cur.w0 <= 2 * size)
  if (keep) return cur
  const w0 = Math.min(Math.max(0, Math.round((first + last + 1) / 2 - size / 2)), n - size)
  return { w0, w1: w0 + size }
}

/** The unmounted item at `offset` px into the gap [a, b), and that item's estimated start within the gap. */
export function gapIndexAt(heights: ArrayLike<number>, a: number, b: number, offset: number): { i: number; start: number } {
  let start = 0
  for (let i = a; i < b; i++) {
    if (offset < start + heights[i] || i === b - 1) return { i, start }
    start += heights[i]
  }
  return { i: a, start: 0 }
}
```

Run (`spikes/app`): `npm test`
Expected: `Tests  30 passed (30)` (plan A's 11, Tasks B1b and B1c's 10, plus 9).

- [ ] **Step 4: Write the failing Rendered e2e tests**

`spikes/app/e2e/flow-launch.ts`. It launches with a private Chromium profile: every spike run shares the default one (`%APPDATA%\spike-app`), which can carry a persisted page zoom that skews every scroll and frame number.
```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const FIX = resolve(__dirname, '../../.fixtures')
/** A private Chromium profile: the default one (%APPDATA%\spike-app) is shared by every spike run and can persist a page zoom. */
const PROFILE = join(FIX, '.udd')

/**
 * Launches the app on one Spike B page with a clean environment (inherited TYPOSE_* variables are dropped, then
 * `env` is applied) and a private profile. Waits for the page's readiness hook (`__spike.open`), not a fixed sleep,
 * and refuses to measure at any page zoom but 100%.
 */
export async function launchPage(
  page: 'doc' | 'transcript',
  env: Record<string, string> = {}
): Promise<{ app: ElectronApplication; win: Page }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${PROFILE}`],
    env: { ...clean, TYPOSE_PAGE: page, ...env } as Record<string, string>
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => (window as any).__spike?.open, null, { timeout: 15_000 })
  const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
  if (zoom !== 1) throw new Error(`page zoom is ${zoom}; Spike B measurements need 100%`)
  return { app, win }
}

/** Opens a generated fixture (Task B2a) and waits until its first window is mounted. */
export async function openFixture(win: Page, file: string, opts: Record<string, unknown> = {}): Promise<void> {
  const path = join(FIX, file)
  if (!existsSync(path)) throw new Error(`missing ${path}: generate the Spike B fixtures first (Task B2a)`)
  await win.evaluate(([p, o]) => (window as any).__spike.open(p, o), [path, opts] as const)
}

/** Waits a frame, then for the window to settle. */
export const settle = (win: Page): Promise<void> =>
  win.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await (window as any).__spike.view.settled()
  })

/**
 * From now on, counts the children added to or removed from `selector`, and how many of those changes happened while it
 * was not `aria-busy="true"` (the feed pattern: busy while articles are added and removed). FlowWindow only ever sets
 * aria-busy when it is absent, so each attribute record is a set (old value null) or a removal.
 */
export const watchBusy = (win: Page, selector: string): Promise<void> =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel)!
    const out = { changes: 0, outsideBusy: 0 }
    let busy = el.getAttribute('aria-busy') === 'true'
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') busy = r.oldValue === null
        else if (r.addedNodes.length + r.removedNodes.length > 0) {
          out.changes++
          if (!busy) out.outsideBusy++
        }
      }
    }).observe(el, { childList: true, attributes: true, attributeFilter: ['aria-busy'], attributeOldValue: true })
    ;(window as any).__busy = out
  }, selector)

/** What `watchBusy` counted, and the attribute now. */
export const busyReport = (win: Page, selector: string): Promise<{ changes: number; outsideBusy: number; busyNow: string | null }> =>
  win.evaluate((sel) => ({ ...(window as any).__busy, busyNow: document.querySelector(sel)!.getAttribute('aria-busy') }), selector)
```
`spikes/app/e2e/doc.e2e.ts`:
```ts
import { expect, test } from '@playwright/test'
import { launchPage, openFixture, settle } from './flow-launch'

const DOC = 'doc-20k.jsonl'

test('Rendered: document semantics, every heading mounted, a viewport-sized window', async () => {
  const { app, win } = await launchPage('doc')
  await openFixture(win, DOC)
  // The fixture's first block of each kind (Task B2a), each loaded and checked in turn.
  const tags = await win.evaluate(async () => {
    const v = (window as any).__spike.view
    const out: Record<number, string> = {}
    for (const i of [0, 1, 4, 7, 12, 15, 24]) {
      await v.goTo(i)
      const el = v.mounted(i) as HTMLElement
      out[i] = [el.tagName, ...[...el.children].map((c) => c.tagName)].slice(0, 3).join('>')
    }
    return out
  })
  expect(tags).toEqual({ 0: 'H1', 1: 'UL>LI>LI', 4: 'P', 7: 'PRE>CODE', 12: 'H2', 15: 'TABLE>THEAD>TBODY', 24: 'H3' })
  const s = await win.evaluate(() => {
    const main = document.querySelector('main')!
    const v = (window as any).__spike.view
    return {
      scroller: v.scroller === main && v.content === main,
      h1: main.querySelector(':scope > h1[data-i="0"]')?.textContent,
      th: main.querySelectorAll(':scope > table[data-i="15"] > thead > tr > th').length,
      headings: main.querySelectorAll(':scope > h1, :scope > h2, :scope > h3').length,
      window: v.win.w1 - v.win.w0,
      outlineLinks: document.querySelectorAll('nav#outline a').length
    }
  })
  expect(s.scroller).toBe(true)
  expect(s.h1).toBe('Section 1 (block 0)')
  expect(s.th).toBe(3)
  expect(s.headings).toBe(1_040)
  expect(s.window).toBeLessThan(100)
  expect(s.outlineLinks).toBe(1_040)
  await app.close()
})

test('Outline: visually collapsed but in the accessibility tree, with every heading', async () => {
  const { app, win } = await launchPage('doc')
  await openFixture(win, DOC)
  expect((await win.locator('#outline').boundingBox())!.width).toBeLessThanOrEqual(1)
  const cdp = await win.context().newCDPSession(win)
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#outline' })
  const { node } = await cdp.send('DOM.describeNode', { nodeId })
  const nav = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false })
  const links = await cdp.send('Accessibility.queryAXTree', { backendNodeId: node.backendNodeId, role: 'link' })
  expect([nav.nodes[0].role?.value, nav.nodes[0].name?.value, nav.nodes[0].ignored]).toEqual(['navigation', 'Outline', false])
  expect(links.nodes.filter((n) => !n.ignored).length).toBe(1_040)
  await app.close()
})

test('Outline: Enter on an entry loads the heading, scrolls it into view and focuses it', async () => {
  const { app, win } = await launchPage('doc')
  await openFixture(win, DOC)
  await win.locator('#outline a[data-i="19992"]').focus()
  expect((await win.locator('#outline').boundingBox())!.width).toBeGreaterThan(100) // focus shows the rail
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => (document.activeElement as HTMLElement | null)?.parentElement?.id === 'doc')
  await settle(win)
  const s = await win.evaluate(() => {
    const f = document.activeElement as HTMLElement
    const v = (window as any).__spike.view
    const r = f.getBoundingClientRect()
    const view = v.scroller.getBoundingClientRect()
    return { i: f.dataset.i, tag: f.tagName, inView: r.top >= view.top - 1 && r.top < view.bottom, next: !!v.mounted(19_993), win: v.win }
  })
  expect(s).toMatchObject({ i: '19992', inView: true, next: true })
  expect(s.win.w0).toBeLessThanOrEqual(19_992)
  await app.close()
})

test('estimates corrected while reading upward into unmeasured blocks keep the reading anchor in place', async () => {
  const { app, win } = await launchPage('doc')
  await openFixture(win, DOC)
  await win.evaluate(() => (window as any).__spike.view.goTo(10_000))
  await settle(win)
  const s = await win.evaluate(async () => {
    const v = (window as any).__spike.view
    const c0 = v.stats.corrections
    for (let k = 0; k < 40; k++) {
      v.scroller.scrollTop -= 150
      await new Promise(requestAnimationFrame)
      await v.settled()
    }
    return { corrections: v.stats.corrections - c0, maxResidual: v.stats.maxResidual, maxCorrection: v.stats.maxCorrection }
  })
  expect(s.corrections).toBeGreaterThan(0)
  expect(s.maxCorrection).toBeGreaterThan(10)
  expect(s.maxResidual).toBeLessThan(1)
  await app.close()
})
```

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e doc`
Expected: FAIL, 4 tests, each with `TimeoutError: page.waitForFunction: Timeout 15000ms exceeded.` (`doc.html` doesn't exist yet, so `typose://app/doc.html` is a 404).

- [ ] **Step 5: Implement the flow window and the Rendered lens**

`spikes/app/src/renderer/src/a11y/flow-window.ts`:
```ts
import type { Core } from '../core'
import { A11Y_WINDOW, gapIndexAt, nextWindow, type Win } from './window-math'

interface Line {
  line: number
  text: string
  more: boolean
}

export interface FlowOptions {
  /** The element for item `i`; `item` is its parsed line, or null if it couldn't be parsed. No wrapper element. */
  render(i: number, item: unknown): HTMLElement
  /** Height estimate for an item that has never been measured, in px. */
  estimate: number
  /** For the edge controls: "Continue: next 500 <noun>". */
  noun: string
  /** Edge controls beside the content instead of at the window's ends inside it: a feed may contain only articles. */
  edgesOutside?: boolean
}

/** Parsed lines kept around the window. */
const KEEP = 4 * A11Y_WINDOW

interface Spot {
  i: number
  /** Viewport y of the item's top: real if `el` is set, estimated if the item is unmounted. */
  top: number
  el?: HTMLElement
  node: Element
}

/**
 * Measured variable-height items in normal flow (spec §5.3), with the accessibility window (spec §6.2).
 * - Unmounted runs are spacers, sized from each item's last measured height or else the estimate.
 *   Heights are measured when an item unmounts; while mounted, the flow itself is the measurement.
 * - Pinned items (the document's headings) stay mounted outside the window, in document order.
 * - A mounted node is never moved or recreated while it stays mounted, so the element under a screen
 *   reader's cursor keeps its identity across every shift.
 * - Every change keeps the reading anchor (the focused item, else the first mounted item in view) where it was.
 * ponytail: native scrolling only. Fine below the 16M px cap (20,000 blocks ≈ 2.6M px); a measured layout past
 * the cap needs the logical mode of scrollmath.ts.
 */
export class FlowWindow {
  n = 0
  win: Win = { w0: 0, w1: 0 }
  a11y = false
  readonly stats = {
    applies: 0,
    recenters: 0,
    fetches: 0,
    corrections: 0,
    maxCorrection: 0,
    maxResidual: 0,
    maxApplyMs: 0,
    edgeActivations: 0
  }
  private pinned: number[] = []
  private pinnedData = new Map<number, unknown>()
  private readonly heights: number[] = []
  private readonly nodes = new Map<number, HTMLElement>()
  /** Spacers keyed by the first unmounted item of their run; `b` is the run's end (exclusive). */
  private readonly gaps = new Map<number, { el: HTMLElement; b: number }>()
  private readonly cache = new Map<number, unknown>()
  private readonly prev: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private focused = -1
  private hold = -1
  private stale = true
  private dirty = false
  private busy = false
  private idle: Promise<void> = Promise.resolve()

  constructor(
    readonly scroller: HTMLElement,
    readonly content: HTMLElement,
    private readonly core: Core,
    private readonly doc: number,
    private readonly opts: FlowOptions
  ) {
    this.prev = this.edge(`Continue: previous ${A11Y_WINDOW} ${opts.noun}`, () => this.win.w0 - 1)
    this.next = this.edge(`Continue: next ${A11Y_WINDOW} ${opts.noun}`, () => this.win.w1)
    scroller.addEventListener('scroll', () => this.schedule())
    new ResizeObserver(() => this.schedule()).observe(scroller)
    // The focused item stays mounted wherever the window goes (spec §6.1, as for the Grid's focused row).
    content.addEventListener('focusin', (e) => {
      const item = (e.target as Element).closest<HTMLElement>('[data-i]')
      if (item?.parentElement !== content) return
      this.focused = Number(item.dataset.i)
      this.stale = true
      this.schedule()
    })
    content.addEventListener('focusout', (e) => {
      if (!content.contains(e.relatedTarget as Node | null)) this.focused = -1
    })
  }

  setCount(n: number): void {
    while (this.heights.length < n) this.heights.push(this.opts.estimate)
    this.n = n
    this.stale = true
    this.schedule()
  }

  setPinned(items: Map<number, unknown>): void {
    this.pinnedData = items
    this.pinned = [...items.keys()].sort((a, b) => a - b)
    this.stale = true
    this.schedule()
  }

  setA11y(on: boolean): void {
    this.a11y = on
    this.stale = true
    this.schedule()
  }

  /** Resolves once every scheduled change has been applied (the gates' readiness hook). */
  settled(): Promise<void> {
    return this.idle
  }

  mounted(i: number): HTMLElement | undefined {
    return this.nodes.get(i)
  }

  /** Loads the window around item i before moving: then scrolls i to the top and focuses it (brief §9). */
  async goTo(i: number): Promise<HTMLElement | undefined> {
    const target = Math.min(Math.max(0, i), this.n - 1)
    this.hold = target
    this.schedule()
    await this.idle
    const el = this.nodes.get(target)
    if (el) {
      el.scrollIntoView({ block: 'start' })
      if (!el.hasAttribute('tabindex')) el.tabIndex = -1
      el.focus({ preventScroll: true })
    }
    if (this.hold === target) this.hold = -1
    return el
  }

  private edge(label: string, target: () => number): HTMLButtonElement {
    const b = Object.assign(document.createElement('button'), { className: 'fw-edge', textContent: label })
    b.addEventListener('click', () => {
      this.stats.edgeActivations++
      void this.goTo(target())
    })
    return b
  }

  private schedule(): void {
    this.dirty = true
    if (!this.busy) this.idle = this.drain()
  }

  private async drain(): Promise<void> {
    this.busy = true
    try {
      while (this.dirty) {
        this.dirty = false
        await this.run()
      }
    } catch (err) {
      console.error('flow window', err)
    } finally {
      this.busy = false
      this.content.removeAttribute('aria-busy')
    }
  }

  private async run(): Promise<void> {
    if (this.n === 0) return
    const [first, last] = this.visible()
    const [from, to] = this.hold >= 0 ? [this.hold, this.hold + last - first] : [first, last]
    const target = nextWindow(this.win, from, Math.min(to, this.n - 1), this.n, this.a11y)
    const missing = this.firstMissing(target)
    // Busy while items are fetched, added and removed (the feed pattern, spec §6.1); drain() clears it.
    if ((missing >= 0 || target !== this.win || this.stale) && !this.content.hasAttribute('aria-busy'))
      this.content.setAttribute('aria-busy', 'true')
    if (missing >= 0) {
      // Plan again after the fetch: the position may have moved meanwhile.
      if ((await this.fetch(missing, target.w1, target)) > 0) this.dirty = true
      else this.apply(target)
      return
    }
    if (target !== this.win || this.stale) {
      this.apply(target)
      // Plan once more from the real layout: the first window is planned before anything is mounted.
      this.dirty = true
    }
  }

  private firstMissing(t: Win): number {
    for (let i = t.w0; i < t.w1; i++) if (!this.nodes.has(i) && !this.cache.has(i) && !this.pinnedData.has(i)) return i
    return -1
  }

  /** Pages through the `lines` RPC (bounded pages, spec §3.4). Returns how many lines arrived. */
  private async fetch(start: number, end: number, t: Win): Promise<number> {
    this.stats.fetches++
    let got = 0
    while (start < end) {
      const lines = await this.core.call<Line[]>('lines', { doc: this.doc, start, count: end - start })
      if (lines.length === 0) break
      for (const l of lines) this.cache.set(l.line, parse(l))
      got += lines.length
      start = lines[lines.length - 1].line + 1
    }
    if (this.cache.size > KEEP)
      for (const i of this.cache.keys()) if (i < t.w0 - KEEP / 2 || i >= t.w1 + KEEP / 2) this.cache.delete(i)
    return got
  }

  private visible(): [number, number] {
    const view = this.scroller.getBoundingClientRect()
    return [this.at(view.top)?.i ?? 0, this.at(view.bottom - 1)?.i ?? 0]
  }

  /** The item at viewport y: a mounted node, or an unmounted item inside a spacer. */
  private at(y: number): Spot | null {
    const kids = this.content.children
    if (kids.length === 0) return null
    let lo = 0
    let hi = kids.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (kids[mid].getBoundingClientRect().top <= y) lo = mid
      else hi = mid - 1
    }
    const node = kids[lo] as HTMLElement
    const top = node.getBoundingClientRect().top
    if (node.dataset.i !== undefined) return { i: Number(node.dataset.i), top, el: node, node }
    const gap = node.dataset.gap === undefined ? undefined : this.gaps.get(Number(node.dataset.gap))
    if (gap) {
      const g = gapIndexAt(this.heights, Number(node.dataset.gap), gap.b, y - top)
      return { i: g.i, top: top + g.start, node }
    }
    return { i: node === this.prev ? this.win.w0 : this.win.w1 - 1, top, node }
  }

  /** The reading anchor: the focused item if it's in view, else the first mounted item in view, else the item at the top. */
  private anchor(): Spot | null {
    const view = this.scroller.getBoundingClientRect()
    const f = document.activeElement
    if (f instanceof HTMLElement && f.parentElement === this.content && f.dataset.i !== undefined) {
      const r = f.getBoundingClientRect()
      if (r.bottom > view.top && r.top < view.bottom) return { i: Number(f.dataset.i), top: r.top, el: f, node: f }
    }
    const top = this.at(view.top)
    if (!top || top.el) return top
    for (let c = top.node.nextElementSibling; c && c.getBoundingClientRect().top < view.bottom; c = c.nextElementSibling) {
      if (c instanceof HTMLElement && c.dataset.i !== undefined)
        return { i: Number(c.dataset.i), top: c.getBoundingClientRect().top, el: c, node: c }
    }
    return top
  }

  private apply(t: Win): void {
    const t0 = performance.now()
    const anchor = this.win.w1 > 0 ? this.anchor() : null
    if (this.a11y && this.win.w1 > 0 && (t.w0 !== this.win.w0 || t.w1 !== this.win.w1)) this.stats.recenters++
    this.stats.applies++
    this.win = t
    this.stale = false

    const order = new Set(this.pinned.filter((i) => i < this.n))
    for (let i = t.w0; i < t.w1; i++) order.add(i)
    if (this.focused >= 0 && this.focused < this.n) order.add(this.focused)
    const sorted = [...order].sort((a, b) => a - b)

    // Unmount: read every height first, then remove, so the reads share one layout.
    const gone = [...this.nodes.keys()].filter((i) => !order.has(i))
    for (const i of gone) this.heights[i] = this.nodes.get(i)!.getBoundingClientRect().height
    for (const i of gone) {
      this.nodes.get(i)!.remove()
      this.nodes.delete(i)
    }
    const edgeFocus = [this.prev, this.next].find((b) => b === document.activeElement)
    this.prev.remove()
    this.next.remove()

    // Mount in document order. Existing nodes stay exactly where they are.
    let before: HTMLElement | null = null
    for (const i of sorted) {
      let el = this.nodes.get(i)
      if (!el) {
        el = this.opts.render(i, this.cache.get(i) ?? this.pinnedData.get(i) ?? null)
        el.dataset.i = String(i)
        if (before) before.after(el)
        else this.content.prepend(el)
        this.nodes.set(i, el)
      }
      before = el
    }

    // One spacer per unmounted run; a run that didn't change keeps its spacer.
    const runs = new Map<number, number>()
    let last = -1
    for (const i of sorted) {
      if (i > last + 1) runs.set(last + 1, i)
      last = i
    }
    if (last < this.n - 1) runs.set(last + 1, this.n)
    for (const [a, g] of this.gaps) {
      if (runs.get(a) === g.b) continue
      g.el.remove()
      this.gaps.delete(a)
    }
    for (const [a, b] of runs) {
      let g = this.gaps.get(a)
      if (!g) {
        const el = Object.assign(document.createElement('div'), { className: 'fw-gap' })
        el.dataset.gap = String(a)
        el.setAttribute('aria-hidden', 'true')
        const after = this.nodes.get(b)
        if (after) after.before(el)
        else this.content.append(el)
        g = { el, b }
        this.gaps.set(a, g)
      }
      let h = 0
      for (let i = a; i < b; i++) h += this.heights[i]
      g.el.style.height = `${h}px`
    }

    // Edge controls (spec §6.2): the fallback for a screen reader that doesn't scroll.
    const out = this.opts.edgesOutside
    if (this.a11y && t.w0 > 0) (out ? this.content : this.nodes.get(t.w0))?.before(this.prev)
    if (this.a11y && t.w1 < this.n) (out ? this.content : this.nodes.get(t.w1 - 1))?.after(this.next)
    if (edgeFocus?.isConnected) edgeFocus.focus({ preventScroll: true })

    // Keep the reading anchor in place: estimates that just became real heights must not move it.
    const el = anchor?.el ?? (anchor ? this.nodes.get(anchor.i) : undefined)
    if (anchor && el?.isConnected) {
      const drift = el.getBoundingClientRect().top - anchor.top
      if (Math.abs(drift) >= 0.5) {
        this.stats.corrections++
        this.stats.maxCorrection = Math.max(this.stats.maxCorrection, Math.abs(drift))
        this.scroller.scrollTop += drift
      }
      if (anchor.el) this.stats.maxResidual = Math.max(this.stats.maxResidual, Math.abs(el.getBoundingClientRect().top - anchor.top))
    }
    this.stats.maxApplyMs = Math.max(this.stats.maxApplyMs, performance.now() - t0)
  }
}

/** A line over 64 KiB arrives truncated (`more`) and renders as a placeholder; oversized blocks are Spike C's. */
function parse(l: Line): unknown {
  if (l.more) return null
  try {
    return JSON.parse(l.text)
  } catch {
    return null
  }
}
```
`spikes/app/src/renderer/src/a11y/mode.ts`:
```ts
/** Accessibility mode (spec §6.2): main forwards Electron's accessibility-support state and the preload posts it here. */
export function onA11yMode(cb: (on: boolean) => void): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'a11y') cb(e.data.on === true)
  })
}
```
`spikes/app/src/renderer/src/a11y/flow.css` (it also styles Task B2d's transcript):
```css
.fw-scroller { position: absolute; inset: 0; overflow-y: auto; overflow-anchor: none; outline: none; font: 15px/1.6 system-ui, sans-serif; }
.fw-scroller:focus-visible { outline: none; box-shadow: inset 0 0 0 2px #6e9cff; } /* inset: an outer ring would be clipped by the card */
/* FlowWindow items sit in normal flow with no vertical margins (padding instead), so a measured height is the space it takes. */
.fw-scroller > *, .fw-scroller > [role='feed'] > * { margin-top: 0; margin-bottom: 0; }
.fw-edge { display: block; margin: 0 auto; padding: 6px 12px; font: inherit; color: var(--text); background: #26262a; border: 1px solid #3a3a40; border-radius: 6px; }
:focus-visible { outline: 2px solid #6e9cff; outline-offset: 2px; }

/* Rendered: the centered 70ch reading column (brief §5.2). */
.doc { padding: 0 max(24px, calc(50% - 35ch)); }
.doc > * { padding-block: 6px; }
.doc > h1 { font-size: 28px; line-height: 1.25; padding-block: 24px 8px; }
.doc > h2 { font-size: 21px; line-height: 1.3; padding-block: 18px 6px; }
.doc > h3 { font-size: 17px; line-height: 1.35; padding-block: 12px 4px; }
.doc > ul { padding-left: 24px; }
.doc li { margin: 0; }
.doc > pre { font: 13px/1.5 ui-monospace, monospace; background: #151517; border-radius: 8px; padding: 10px 12px; margin-block: 0; overflow-x: auto; }
.doc > table { border-spacing: 0; padding-block: 8px; }
.doc th, .doc td { text-align: left; padding: 2px 12px 2px 0; border-bottom: 1px solid #2c2c31; }

/* The Outline rail (brief §5.2): overlays the content from the right. Collapsed, it is visually hidden but stays in the accessibility tree (spec §6.2). */
#outline-toggle { position: absolute; right: 16px; bottom: 16px; padding: 6px 14px; border-radius: 999px; font: inherit; color: var(--text); background: #26262a; border: 1px solid #3a3a40; }
.fw-outline { position: absolute; top: 8px; right: 8px; bottom: 60px; width: 232px; overflow-y: auto; background: var(--surface); box-shadow: 0 4px 24px #0008; border-radius: 10px; font: 13px/1.5 system-ui, sans-serif; }
.fw-outline:not(.open):not(:focus-within) { width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.fw-outline ul { list-style: none; margin: 0; padding: 8px; }
.fw-outline a { display: block; color: var(--text2); text-decoration: none; padding: 1px 6px; border-radius: 4px; }
.fw-outline a.h2 { padding-left: 18px; }
.fw-outline a.h3 { padding-left: 30px; }
.fw-outline a:hover, .fw-outline a:focus { color: var(--text); background: #26262a; }

/* Transcript (brief §5.4): turns separated by a hairline, in the same reading column. */
.transcript { padding: 0 max(24px, calc(50% - 35ch)); }
.transcript article { padding-block: 12px; border-top: 1px solid #2c2c31; }
.transcript article:focus-visible { outline-offset: -2px; } /* inset, as for full-bleed rows: an article at the view's edge would clip an outer ring */
/* The edge controls sit beside the feed, at the far ends of its spacers; stuck to the view's edges, focusing one never scrolls there. */
.transcript > .fw-edge { position: sticky; top: 0; bottom: 0; z-index: 1; }
.transcript article h2 { font-size: 13px; font-weight: 600; color: var(--text2); margin: 0 0 6px; }
.transcript article p { margin: 0 0 8px; }
.transcript article pre { font: 13px/1.5 ui-monospace, monospace; background: #151517; border-radius: 8px; padding: 10px 12px; margin: 0; white-space: pre-wrap; }
```
`spikes/app/src/renderer/src/doc/blocks.ts`:
```ts
/** One line of the block-model fixture (Task B2a). Real Markdown blocks come from Spike C. */
export interface Block {
  k: string
  t: unknown
}

export const isHeading = (b: Block): boolean => /^h[1-6]$/.test(b.k)

/** Anything that isn't a block (or couldn't be parsed) renders as a paragraph. */
export function toBlock(item: unknown): Block {
  if (item !== null && typeof item === 'object' && typeof (item as Block).k === 'string') return item as Block
  return { k: 'p', t: item === null ? '…' : item }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v])

function el(tag: string, content?: string): HTMLElement {
  const e = document.createElement(tag)
  if (content !== undefined) e.textContent = content
  return e
}

/** Document semantics (spec §6.1): real h1–h6, lists, code and tables. */
export function renderBlock(i: number, b: Block): HTMLElement {
  if (isHeading(b)) {
    const h = el(b.k, text(b.t))
    h.id = `b-${i}`
    h.tabIndex = -1
    return h
  }
  switch (b.k) {
    case 'ul': {
      const ul = el('ul')
      for (const item of list(b.t)) ul.append(el('li', text(item)))
      return ul
    }
    case 'pre': {
      const pre = el('pre')
      pre.append(el('code', text(b.t)))
      return pre
    }
    case 'table': {
      const [head = [], ...rows] = list(b.t).map(list)
      const row = (cells: unknown[], tag: string): HTMLElement => {
        const tr = el('tr')
        for (const c of cells) tr.append(el(tag, text(c)))
        return tr
      }
      const thead = el('thead')
      thead.append(row(head, 'th'))
      const tbody = el('tbody')
      for (const r of rows) tbody.append(row(r, 'td'))
      const table = el('table')
      table.append(thead, tbody)
      return table
    }
    default:
      return el('p', text(b.t))
  }
}
```
`spikes/app/src/renderer/src/doc/main.ts`:
```ts
import { FlowWindow } from '../a11y/flow-window'
import { onA11yMode } from '../a11y/mode'
import { connectCore } from '../core'
import { PerfLog } from '../perf'
import { isHeading, renderBlock, toBlock, type Block } from './blocks'

interface Line {
  line: number
  text: string
  more: boolean
}

const spike: Record<string, unknown> = { perf: new PerfLog(), a11y: false }
;(window as any).__spike = spike
onA11yMode((on) => {
  spike.a11y = on
  ;(spike.view as FlowWindow | undefined)?.setA11y(on)
})

const core = await connectCore()
spike.core = core
const status = document.getElementById('status')!
const main = document.getElementById('doc')!
const nav = document.getElementById('outline')!
const toggle = document.getElementById('outline-toggle') as HTMLButtonElement

/**
 * The Outline (brief §5.2, spec §6.2): a nav listing every heading. Collapsed, it is only visually hidden, so it
 * stays in the accessibility tree; focus inside it shows it. One tab stop; arrows move between entries.
 */
function buildOutline(headings: Map<number, Block>, go: (i: number) => void): void {
  const list = document.createElement('ul')
  for (const [i, b] of headings) {
    const a = Object.assign(document.createElement('a'), { href: `#b-${i}`, textContent: String(b.t), className: b.k, tabIndex: -1 })
    a.dataset.i = String(i)
    const li = document.createElement('li')
    li.append(a)
    list.append(li)
  }
  const first = list.querySelector('a')
  if (first) first.tabIndex = 0
  list.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a')
    if (!a) return
    e.preventDefault()
    go(Number(a.dataset.i))
  })
  list.addEventListener('keydown', (e) => {
    const li = (e.target as Element).closest('li')
    const to = e.key === 'ArrowDown' ? li?.nextElementSibling : e.key === 'ArrowUp' ? li?.previousElementSibling : null
    const a = to?.querySelector('a')
    if (!a) return
    e.preventDefault()
    list.querySelector<HTMLElement>('a[tabindex="0"]')?.setAttribute('tabindex', '-1')
    a.tabIndex = 0
    a.focus()
  })
  nav.replaceChildren(list)
  toggle.hidden = headings.size < 3
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(open))
    nav.classList.toggle('open', open)
  })
}

/**
 * Opens a block-model JSONL document. Resolves once the first window is mounted: the gates' readiness hook.
 * `skeleton: false` drops the pinned headings, as a control for the heading-key gate.
 */
async function open(path: string, opts: { skeleton?: boolean } = {}): Promise<void> {
  const { doc } = await core.call<{ doc: number }>('open', { path })
  const n = await new Promise<number>((ok, fail) =>
    core.onEvent((e) => {
      if (e.event !== 'progress' || e.doc !== doc) return
      if (e.error) fail(new Error(String(e.error)))
      else if (e.done) ok(e.lines as number)
    })
  )
  // ponytail: the renderer reads every line once to find the headings; the product's core keeps the heading list (spec §3.5).
  const headings = new Map<number, Block>()
  for (let start = 0; start < n; ) {
    const lines = await core.call<Line[]>('lines', { doc, start, count: n - start })
    if (lines.length === 0) break
    for (const l of lines) {
      let b: Block
      try {
        b = toBlock(l.more ? null : JSON.parse(l.text))
      } catch {
        continue
      }
      if (isHeading(b)) headings.set(l.line, b)
    }
    start = lines[lines.length - 1].line + 1
  }
  const view = new FlowWindow(main, main, core, doc, { render: (i, item) => renderBlock(i, toBlock(item)), estimate: 64, noun: 'blocks' })
  spike.view = view
  view.setA11y(spike.a11y === true)
  // Every heading stays mounted, in document order, so a screen reader's heading key can reach it (spec §6.2).
  if (opts.skeleton !== false) view.setPinned(headings)
  view.setCount(n)
  buildOutline(headings, (i) => void view.goTo(i))
  await view.settled()
  status.textContent = `${n} blocks · ${headings.size} headings`
}
spike.open = open

const path = new URLSearchParams(location.search).get('open')
if (path) void open(path)
```
`spikes/app/src/renderer/doc.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>Typose spike · Rendered</title>
    <link rel="stylesheet" href="./src/style.css" />
    <link rel="stylesheet" href="./src/a11y/flow.css" />
  </head>
  <body>
    <header id="titlebar"><span id="status">connecting…</span></header>
    <div id="card">
      <main id="doc" class="fw-scroller doc" tabindex="0"></main>
      <button id="outline-toggle" aria-expanded="false" aria-controls="outline" hidden>Outline</button>
      <nav id="outline" class="fw-outline" aria-label="Outline"></nav>
    </div>
    <script type="module" src="./src/doc/main.ts"></script>
  </body>
</html>
```
In `spikes/app/electron.vite.config.ts`, change the `pages` line to:
```ts
const pages = ['index', 'grid', 'treegrid', 'doc']
```

- [ ] **Step 6: Run the tests to verify they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e doc`
Expected: `4 passed`.

Run: `npm run e2e`
Expected: `16 passed` (plan A's 3, Task B0's 2, Tasks B1b and B1c's 7, plus these 4).

- [ ] **Step 7: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/a11y spikes/app/src/renderer/src/doc spikes/app/src/renderer/doc.html spikes/app/electron.vite.config.ts spikes/app/e2e/flow-launch.ts spikes/app/e2e/doc.e2e.ts
git commit -m "spike(b): measured flow window with pinned headings; Rendered lens and Outline"
```

---

## Task B2c: Accessibility mode — main forwards Electron's accessibility support

**Files:**
- Create: `spikes/app/e2e/a11y-mode.e2e.ts`
- Modify: `spikes/app/src/main/index.ts` (insertion below the `core-port` hand-off), `spikes/app/src/preload/index.ts` (append)

**Interfaces:**
- **Consumes:** `onA11yMode` and `FlowWindow.setA11y` (Task B2b); `watchBusy` and `busyReport` (`flow-launch.ts`, Task B2b), with which test 3 also checks that blocks are added and removed only while `#doc` is `aria-busy`; Electron's `app.isAccessibilitySupportEnabled()`, `app.setAccessibilitySupportEnabled()` and `accessibility-support-changed`.
- **Produces:**
  - the IPC message `'a11y'` (main → preload, `boolean`), re-posted to the main world as `{ type: 'a11y', on: boolean }`; it is sent on every `did-finish-load` and every `accessibility-support-changed`;
  - `TYPOSE_A11Y=1`: main calls `app.setAccessibilitySupportEnabled(true)` before loading the page, as a running screen reader would.
- Verified on Electron 44.9.2: `app.setAccessibilitySupportEnabled()` fires `accessibility-support-changed`, so a runtime toggle reaches the renderer through the event Electron documents for a screen reader starting or stopping.

- [ ] **Step 1: Write the failing tests**

`spikes/app/e2e/a11y-mode.e2e.ts`:
```ts
import { expect, test } from '@playwright/test'
import { busyReport, launchPage, openFixture, settle, watchBusy } from './flow-launch'

const DOC = 'doc-20k.jsonl'
const windowSize = (win: import('@playwright/test').Page) =>
  win.evaluate(() => {
    const w = (window as any).__spike.view.win
    return w.w1 - w.w0
  })

test('main forwards accessibility support to the renderer at load and on every change', async () => {
  const { app, win } = await launchPage('doc')
  await openFixture(win, DOC)
  const initial = await app.evaluate(({ app }) => app.isAccessibilitySupportEnabled())
  await win.waitForFunction((on) => (window as any).__spike.a11y === on, initial, { timeout: 10_000 })
  for (const on of [true, false]) {
    await app.evaluate(({ app }, on) => app.setAccessibilitySupportEnabled(on), on)
    await win.waitForFunction((on) => (window as any).__spike.a11y === on, on, { timeout: 10_000 })
    await settle(win)
    if (on) expect(await windowSize(win)).toBe(500)
    else expect(await windowSize(win)).toBeLessThan(100)
  }
  await app.close()
})

test('TYPOSE_A11Y=1: a 500-block window with edge controls; "Continue" loads the next blocks and moves focus there', async () => {
  const { app, win } = await launchPage('doc', { TYPOSE_A11Y: '1' })
  await win.waitForFunction(() => (window as any).__spike.a11y === true, null, { timeout: 10_000 })
  await openFixture(win, DOC)
  await win.evaluate(() => (window as any).__spike.view.goTo(10_000))
  await settle(win)
  const edges = await win.evaluate(() => {
    const v = (window as any).__spike.view
    const prev = v.mounted(v.win.w0).previousElementSibling as HTMLElement
    const next = v.mounted(v.win.w1 - 1).nextElementSibling as HTMLElement
    return { win: v.win, prev: prev.textContent, next: next.textContent, nextIsButton: next.tagName === 'BUTTON' }
  })
  expect(edges).toMatchObject({ prev: 'Continue: previous 500 blocks', next: 'Continue: next 500 blocks', nextIsButton: true })
  expect(edges.win.w1 - edges.win.w0).toBe(500)
  // Focusing the control scrolls to it, so the window may follow first: the target is the block after the window then.
  await win.getByRole('button', { name: 'Continue: next 500 blocks' }).focus()
  await settle(win)
  const target = await win.evaluate(() => (window as any).__spike.view.win.w1)
  expect(await win.evaluate(() => document.activeElement?.textContent)).toBe('Continue: next 500 blocks')
  await win.keyboard.press('Enter')
  await win.waitForFunction((i) => (document.activeElement as HTMLElement | null)?.dataset.i === String(i), target)
  await settle(win)
  expect(await win.evaluate(() => (window as any).__spike.view.stats.edgeActivations)).toBe(1)
  const w = await win.evaluate(() => (window as any).__spike.view.win)
  expect(target - w.w0).toBeGreaterThanOrEqual(125)
  expect(w.w1 - target).toBeGreaterThanOrEqual(125)
  await app.close()
})

test('a recenter keeps the element under the cursor: same node, connected, positions consecutive', async () => {
  const { app, win } = await launchPage('doc', { TYPOSE_A11Y: '1' })
  await win.waitForFunction(() => (window as any).__spike.a11y === true, null, { timeout: 10_000 })
  await openFixture(win, DOC)
  await win.evaluate(() => (window as any).__spike.view.goTo(3_050))
  await settle(win)
  await watchBusy(win, '#doc')
  const r = await win.evaluate(async () => {
    const v = (window as any).__spike.view
    ;(document.activeElement as HTMLElement).blur()
    const r0 = v.stats.recenters
    let cur = v.mounted(3_050) as HTMLElement
    const out = { wrong: 0, lost: 0, recenters: 0 }
    for (let s = 0; s < 300; s++) {
      const next = cur.nextElementSibling as HTMLElement
      if (Number(next.dataset.i) !== Number(cur.dataset.i) + 1) out.wrong++
      next.scrollIntoView({ block: 'nearest' })
      await new Promise(requestAnimationFrame)
      if (!next.isConnected || v.mounted(Number(next.dataset.i)) !== next) out.lost++
      cur = next
    }
    out.recenters = v.stats.recenters - r0
    return out
  })
  expect(r.wrong).toBe(0)
  expect(r.lost).toBe(0)
  expect(r.recenters).toBeGreaterThanOrEqual(2)
  // As for the feed: blocks are added and removed only while the document is aria-busy.
  const busy = await busyReport(win, '#doc')
  expect(busy.changes).toBeGreaterThan(0)
  expect(busy).toMatchObject({ outsideBusy: 0, busyNow: null })
  await app.close()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e a11y-mode`
Expected: FAIL, 3 tests, each with `TimeoutError: page.waitForFunction: Timeout 10000ms exceeded.` (nothing sends `'a11y'` yet, so `__spike.a11y` never turns true).

- [ ] **Step 3: Forward accessibility support from main to the renderer**

In `spikes/app/src/main/index.ts`, add directly below `win.webContents.once('did-finish-load', () => win.webContents.postMessage('core-port', null, [port2]))`:
```ts
  // Accessibility mode (spec §6.2): forward Electron's accessibility support now and on every change.
  // TYPOSE_A11Y=1 turns it on as a screen reader would, for the Spike B gates.
  if (process.env.TYPOSE_A11Y === '1') app.setAccessibilitySupportEnabled(true)
  const sendA11y = (): void => {
    if (!win.isDestroyed()) win.webContents.send('a11y', app.isAccessibilitySupportEnabled())
  }
  win.webContents.on('did-finish-load', sendA11y)
  app.on('accessibility-support-changed', sendA11y)
```
Append to `spikes/app/src/preload/index.ts`, after a blank line:
```ts
// Accessibility mode (spec §6.2): main sends Electron's accessibility-support state; forward it to the main world.
ipcRenderer.on('a11y', (_event, on: boolean) => window.postMessage({ type: 'a11y', on }, '*'))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e a11y-mode`
Expected: `3 passed`.

Run: `npm run e2e`
Expected: `19 passed`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/main/index.ts spikes/app/src/preload/index.ts spikes/app/e2e/a11y-mode.e2e.ts
git commit -m "spike(b): forward Electron accessibility support to the renderer; TYPOSE_A11Y"
```

---

## Task B2d: The Transcript feed

**Files:**
- Create: `spikes/app/src/renderer/src/transcript/main.ts`, `spikes/app/src/renderer/transcript.html`, `spikes/app/e2e/transcript.e2e.ts`
- Modify: `spikes/app/electron.vite.config.ts` (add the `transcript` page)

**Interfaces:**
- **Consumes:** `FlowWindow`, `onA11yMode`, `flow.css`, `flow-launch.ts` (Task B2b); `.fixtures/transcript-5k.jsonl` (Task B2a); plan A's `.fixtures/1g.jsonl`.
- **Produces:** the transcript page: `role=feed` (named `Transcript`) of `article`s. Each article has `tabindex=0`, `aria-posinset`, `aria-setsize` (the total, or `-1` until indexing is done) and `aria-labelledby` pointing at its role label (`User`, `Assistant`, `Tool`), which starts its `h2` heading (`User · turn 1`). PageDown/PageUp move focus to the next/previous article, loading it first; presses made while a target is still loading count from that target. `window.__spike = { perf, a11y, core, open(path), view }`; `open` resolves once indexing is done and the window is mounted. In accessibility mode the edge controls are `main`'s children, before and after the feed, stuck to the view's top and bottom edges (`position: sticky`), so focusing one never scrolls the view to the feed's far end; the feed is `aria-busy` while turns are added and removed.

- [ ] **Step 1: Write the failing tests**

`spikes/app/e2e/transcript.e2e.ts`:
```ts
import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIX, busyReport, launchPage, openFixture, settle, watchBusy } from './flow-launch'

test('Transcript: a feed of articles named by role, with position and total', async () => {
  const { app, win } = await launchPage('transcript')
  await openFixture(win, 'transcript-5k.jsonl')
  const s = await win.evaluate(() => {
    const feed = document.querySelector('[role="feed"]')!
    const first = feed.querySelector('article')!
    const label = document.getElementById(first.getAttribute('aria-labelledby')!)
    return {
      inMain: feed.parentElement?.tagName,
      children: [...new Set([...feed.children].map((c) => c.tagName))],
      posinset: first.getAttribute('aria-posinset'),
      setsize: first.getAttribute('aria-setsize'),
      name: label?.textContent,
      heading: first.querySelector('h2')?.textContent,
      text: first.querySelector('p')?.textContent?.slice(0, 8)
    }
  })
  expect(s).toEqual({ inMain: 'MAIN', children: ['ARTICLE', 'DIV'], posinset: '1', setsize: '5000', name: 'User', heading: 'User · turn 1', text: 'Turn 1. ' })
  await app.close()
})

test('Transcript: aria-setsize is -1 while indexing, then the true total', async () => {
  const big = join(FIX, '1g.jsonl') // plan A's 1 GiB fixture: indexing takes long enough to observe
  test.skip(!existsSync(big), `needs ${big} (plan A Task 2)`)
  const { app, win } = await launchPage('transcript')
  // Record the first article's aria-setsize as it is inserted: indexing 1 GiB warm takes about a second.
  await win.evaluate((p) => {
    const w = window as any
    new MutationObserver((_, obs) => {
      const a = document.querySelector('article')
      if (!a) return
      w.__firstSetsize = a.getAttribute('aria-setsize')
      obs.disconnect()
    }).observe(document.getElementById('feed')!, { childList: true })
    void w.__spike.open(p)
  }, big)
  await win.waitForFunction(() => (window as any).__firstSetsize !== undefined)
  const during = await win.evaluate(() => (window as any).__firstSetsize)
  await win.waitForFunction(() => document.getElementById('status')!.textContent!.endsWith(' turns'), null, { timeout: 60_000 })
  const after = await win.evaluate(() => [...new Set([...document.querySelectorAll('article')].map((a) => a.getAttribute('aria-setsize')))])
  expect(during).toBe('-1')
  expect(after).toEqual(['5368710'])
  await app.close()
})

test('Transcript: PageDown/PageUp move focus article to article, loading the target first', async () => {
  const { app, win } = await launchPage('transcript')
  await openFixture(win, 'transcript-5k.jsonl')
  await win.locator('article[aria-posinset="1"]').focus()
  for (let k = 0; k < 40; k++) await win.keyboard.press('PageDown')
  await win.waitForFunction(() => document.activeElement?.getAttribute('aria-posinset') === '41')
  for (let k = 0; k < 5; k++) await win.keyboard.press('PageUp')
  await win.waitForFunction(() => document.activeElement?.getAttribute('aria-posinset') === '36')
  const w = await win.evaluate(() => (window as any).__spike.view.win)
  expect(w.w1 - w.w0).toBeLessThan(100) // a normal window: the 40 moves crossed unmounted turns
  await app.close()
})

test('Transcript in accessibility mode: the feed holds only articles, the edge controls sit beside it and stay put, aria-busy while turns change', async () => {
  const { app, win } = await launchPage('transcript', { TYPOSE_A11Y: '1' })
  await win.waitForFunction(() => (window as any).__spike.a11y === true, null, { timeout: 10_000 })
  await openFixture(win, 'transcript-5k.jsonl')
  await watchBusy(win, '#feed')
  await win.evaluate(() => (window as any).__spike.view.goTo(2_500)) // a recenter far from the first window
  await settle(win)
  const s = await win.evaluate(() => {
    const feed = document.getElementById('feed')!
    return {
      children: [...new Set([...feed.children].map((c) => c.tagName + (c.getAttribute('aria-hidden') === 'true' ? ' aria-hidden' : '')))],
      before: feed.previousElementSibling?.textContent,
      after: feed.nextElementSibling?.textContent
    }
  })
  // role=feed allows only articles (the spacers are aria-hidden); the edge controls are its siblings (spec §6.2).
  expect(s).toEqual({ children: ['DIV aria-hidden', 'ARTICLE'], before: 'Continue: previous 500 turns', after: 'Continue: next 500 turns' })
  const busy = await busyReport(win, '#feed')
  expect(busy.changes).toBeGreaterThan(0)
  expect(busy).toMatchObject({ outsideBusy: 0, busyNow: null })
  // Focusing an edge control leaves the view where it is, so it continues from this window, not from the feed's far end.
  const w = await win.evaluate(() => (window as any).__spike.view.win)
  await win.getByRole('button', { name: 'Continue: next 500 turns' }).focus()
  await settle(win)
  expect(await win.evaluate(() => (window as any).__spike.view.win)).toEqual(w)
  await win.keyboard.press('Enter')
  await win.waitForFunction((i) => (document.activeElement as HTMLElement | null)?.dataset.i === String(i), w.w1)
  await app.close()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e transcript`
Expected: FAIL, 4 tests, each with `TimeoutError: page.waitForFunction: Timeout 15000ms exceeded.` (`transcript.html` doesn't exist yet).

- [ ] **Step 3: Implement the feed**

`spikes/app/src/renderer/src/transcript/main.ts`:
```ts
import { FlowWindow } from '../a11y/flow-window'
import { onA11yMode } from '../a11y/mode'
import { connectCore } from '../core'
import { PerfLog } from '../perf'

const ROLES: Record<string, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool' }

const spike: Record<string, unknown> = { perf: new PerfLog(), a11y: false }
;(window as any).__spike = spike
onA11yMode((on) => {
  spike.a11y = on
  ;(spike.view as FlowWindow | undefined)?.setA11y(on)
})

const core = await connectCore()
spike.core = core
const status = document.getElementById('status')!
const main = document.querySelector('main')!
const feed = document.getElementById('feed')!
/** The true total once indexing is done; -1 until then (spec §6.2: never a partial count presented as final). */
let setsize = -1

/** A turn (spec §6.1): an article named by its role label, with its position, a turn heading and the text. */
function renderTurn(i: number, item: unknown): HTMLElement {
  const turn = (item ?? {}) as { role?: unknown; t?: unknown }
  const a = document.createElement('article')
  a.tabIndex = 0
  a.setAttribute('aria-posinset', String(i + 1))
  a.setAttribute('aria-setsize', String(setsize))
  const label = Object.assign(document.createElement('span'), {
    id: `turn-${i}-role`,
    textContent: ROLES[String(turn.role)] ?? String(turn.role ?? 'Unknown')
  })
  a.setAttribute('aria-labelledby', label.id)
  const h = document.createElement('h2')
  h.append(label, ` · turn ${i + 1}`)
  a.append(h)
  const t = typeof turn.t === 'string' ? turn.t : (JSON.stringify(turn.t) ?? '…')
  if (turn.role === 'tool') a.append(Object.assign(document.createElement('pre'), { textContent: t }))
  else for (const para of t.split('\n\n')) a.append(Object.assign(document.createElement('p'), { textContent: para }))
  return a
}

// The feed pattern's keyboard: PageDown/PageUp move focus to the next/previous article, loading it first.
// Presses that arrive while a target is still loading count from that target, so none is lost.
let moving = -1
let moves = 0
feed.addEventListener('keydown', (e) => {
  const article = (e.target as Element).closest('article')
  if (!article || (e.key !== 'PageDown' && e.key !== 'PageUp')) return
  e.preventDefault()
  const view = spike.view as FlowWindow
  moving = Math.min(Math.max(0, (moving >= 0 ? moving : Number(article.dataset.i)) + (e.key === 'PageDown' ? 1 : -1)), view.n - 1)
  const mine = ++moves
  void view.goTo(moving).then(() => {
    if (mine === moves) moving = -1
  })
})

/** Opens a transcript JSONL (Task B2a). Resolves once indexing is done and the window is mounted: the gates' readiness hook. */
async function open(path: string): Promise<void> {
  const { doc } = await core.call<{ doc: number }>('open', { path })
  const view = new FlowWindow(main, feed, core, doc, { render: renderTurn, estimate: 160, noun: 'turns', edgesOutside: true })
  spike.view = view
  view.setA11y(spike.a11y === true)
  await new Promise<void>((ok, fail) =>
    core.onEvent((e) => {
      if (e.event !== 'progress' || e.doc !== doc) return
      if (e.error) return fail(new Error(String(e.error)))
      view.setCount(e.lines as number)
      if (!e.done) return
      setsize = e.lines as number
      for (const a of feed.querySelectorAll('article')) a.setAttribute('aria-setsize', String(setsize))
      ok()
    })
  )
  await view.settled()
  status.textContent = `${setsize} turns`
}
spike.open = open

const path = new URLSearchParams(location.search).get('open')
if (path) void open(path)
```
`spikes/app/src/renderer/transcript.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>Typose spike · Transcript</title>
    <link rel="stylesheet" href="./src/style.css" />
    <link rel="stylesheet" href="./src/a11y/flow.css" />
  </head>
  <body>
    <header id="titlebar"><span id="status">connecting…</span></header>
    <div id="card">
      <main class="fw-scroller transcript"><div id="feed" role="feed" aria-label="Transcript"></div></main>
    </div>
    <script type="module" src="./src/transcript/main.ts"></script>
  </body>
</html>
```
In `spikes/app/electron.vite.config.ts`, change the `pages` line to:
```ts
const pages = ['index', 'grid', 'treegrid', 'doc', 'transcript']
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e transcript`
Expected: `4 passed` (the `-1` test reports `skipped` instead if plan A's `1g.jsonl` is missing).

Run: `npm test`, then `npm run e2e`
Expected: `Tests  30 passed (30)` and `23 passed` (plan A's 3, Task B0's 2, Tasks B1b and B1c's 7, then 4 + 3 + 4).

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/transcript spikes/app/src/renderer/transcript.html spikes/app/electron.vite.config.ts spikes/app/e2e/transcript.e2e.ts
git commit -m "spike(b): Transcript feed on the flow window"
```

---

## Task B2e: The document gates — G5 continuous reading, G6 heading jumps, G9 frames — and the AX findings

**Files:**
- Create: `spikes/app/perf/spike-b2.e2e.ts`

**Interfaces:**
- **Consumes:** everything from Tasks B2a–B2d; `percentile` (`perf.ts`); Chromium's DevTools protocol through Playwright's `newCDPSession` (`DOM`, `Accessibility`, `Runtime` domains).
- **Produces:** `spikes/results/spike-b2-<hostname>.json` with the keys `G5:doc:scroll`, `G5:transcript:scroll`, `G5:transcript:focus`, `G5:doc:ax`, `G5:transcript:ax`, `G6:headingKey`, `G6:headingKey:controlWithoutPinnedHeadings`, `G6:outline`, `G9:doc`, `G9:transcript`, `G9:jumps:doc`, `G9:jumps:transcript`, `AX`.

**What each gate does:**
- **G5, the simulated screen reader:** in accessibility mode, it moves a virtual cursor item by item in DOM order, scrolls each item into view (`block: 'nearest'`, the smallest move: the stand-in for a screen reader scrolling its cursor into view) and waits one frame. It covers 2,000 items forward, the same 2,000 back, and 2,000 back from a region never shown before, on the document (inside the heading-free stretches) and on the transcript; then the transcript again with focus following the cursor. Each step asserts that the next item is exactly one position on, that the cursor element is still connected and is the same node `mounted(i)` returns, and that no edge control was crossed; each walk must cross at least 4 recenters, and across every recenter the item under the cursor must move less than 1 px on screen (`maxCursorShift`).
- **G5 through the AX tree:** the same walk, 600 steps each way, but each next item is taken from the container's AX children (`Accessibility.getChildAXNodes`, ignored nodes dropped): Blink's accessibility tree, from which Chromium builds what IA2/UIA expose to screen readers. Each item is scrolled with `DOM.scrollIntoViewIfNeeded`.
- **G6, the heading key:** from inside a heading-free stretch it takes the next or previous **heading among the document's AX children** (the search NVDA's H/Shift+H run over the browse-mode buffer), and once the next level-3 heading (NVDA's 3 key) from 3,200, an h3 at 5,520. It checks that each heading lies outside the mounted window, scrolls it into view and checks the result: the same node, connected, in view, with both neighbours mounted, and at least 100 items of window on each side. Control: with `skeleton: false`, the same query finds no heading.
- **G6, the Outline:** with the rail collapsed, focus an entry and press Enter, for headings outside the window; the heading must end up focused, mounted and in view.
- **G9:** 10 s of auto-scroll at 2,000 px/s (n=5) and at a stress speed that crosses several recenters (n=2), sampling rAF intervals with `PerfLog`. At 2,000 px/s, Electron's accessibility support is toggled in place between runs (on, off, on, …), so drift on a shared machine hits both alike. Each stress run gets a fresh launch, with accessibility on or off from the start. Re-enabled in place, the renderer serializes a whole new accessibility tree in the run's first frames (60 to 91 ms), which is not recenter cost (Checkpoint items 4 and 5). Gate: with accessibility on, ≤ 1% of frames over 20ms (p50 of the n=5 runs). The 2,000 px/s runs start at the top and never recenter the 500-item window; the stress runs (10,000 px/s doc, 20,000 px/s transcript) do. Each stress run with accessibility on must recenter at least twice, no frame of it may stall over 50 ms (`maxGap`, spec §10.2's "no stall > 50ms"), and no recenter may take 16 ms or more (`maxApplyMs`). The last two are judged on a quiet PC only (Step 2). Accessibility on is Electron's support, not a running screen reader (Global Constraints).
- **G9 jumps (spec Z52):** a far jump replaces the whole window: a scrollbar jump, an Outline jump, or open-then-scroll. Per surface, four fresh launches, with accessibility off and then on from the start:
  - 12 s of auto-scroll at 2,000 px/s right after the file opens (the open run);
  - 12 s of it with five far jumps made during it (the jump run): scrollbar jumps to 50%, 90% and 10% of the content at 2, 4 and 6 s, then `goTo` jumps to the items 75% and 2.5% of the way in at 8 and 10 s, as the Outline makes.

  The measure is G9's stall check, the longest rAF gap (`maxGap`). Gate: with accessibility on, neither run may stall over 50 ms (spec §10.2, Z52). It fails today, a Phase 0 finding (Checkpoint item 5). The bound isn't loosened, and no product code changes to chase it. The control: with accessibility off, the jump run's longest gap must be 50 ms or less, which shows the check can pass. The open run with accessibility off is saved but not asserted, because it stalls too (Checkpoint item 5).
- **AX findings:** the roles, names and properties Electron 44 exposes for each kind of item, and the collapsed Outline's AX node.

- [ ] **Step 1: Write the gate runner**

`spikes/app/perf/spike-b2.e2e.ts`:
```ts
import { expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { launchPage, openFixture, settle } from '../e2e/flow-launch'
import { percentile } from '../src/renderer/src/perf'

const OUT = resolve(__dirname, `../../results/spike-b2-${hostname()}.json`)
const DOC = 'doc-20k.jsonl'
const TRANSCRIPT = 'transcript-5k.jsonl'

const save = (key: string, value: unknown): void => {
  const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
  results[key] = value
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(results, null, 2))
}

/**
 * `start`: where the forward walk begins. `fresh`: where a backward walk into never-measured items begins.
 * `stress`: an auto-scroll speed (px/s) fast enough to cross several 500-item recenters in 10 s.
 */
type Surface = { page: 'doc' | 'transcript'; file: string; start: number; fresh: number; stress: number }
const SURFACES: Surface[] = [
  // Both walks stay inside the 2,500-block heading-free stretches [3,000, 5,500) and [9,000, 11,500).
  { page: 'doc', file: DOC, start: 3_050, fresh: 11_450, stress: 10_000 },
  { page: 'transcript', file: TRANSCRIPT, start: 1_000, fresh: 4_990, stress: 20_000 }
]

async function openWithA11y(s: Surface): Promise<{ app: ElectronApplication; win: Page }> {
  const { app, win } = await launchPage(s.page, { TYPOSE_A11Y: '1' })
  await win.waitForFunction(() => (window as any).__spike.a11y === true)
  await openFixture(win, s.file)
  return { app, win }
}

/** Puts the reading position on item i: Outline-style goTo, then drops focus so the walk is driven by scrolling alone. */
async function startAt(win: Page, i: number): Promise<void> {
  await win.evaluate(async (i) => {
    const v = (window as any).__spike.view
    await v.goTo(i)
    ;(document.activeElement as HTMLElement).blur()
  }, i)
  await settle(win)
}

/**
 * The simulated screen reader (G5): each step moves a virtual cursor to the next/previous item in DOM order,
 * scrolls it into view as screen readers do (optionally focusing it) and waits one frame.
 */
function walk(win: Page, from: number, dir: 1 | -1, steps: number, focus: boolean) {
  return win.evaluate(
    async ([from, dir, steps, focus]) => {
      const v = (window as any).__spike.view
      const content = v.content as HTMLElement
      const r0 = v.stats.recenters
      const out = { steps: 0, wrong: [] as number[][], lost: 0, edgeHits: 0, recenters: 0, from, to: from, maxCursorShift: 0 }
      let cur = content.querySelector<HTMLElement>(`[data-i="${from}"]`)!
      let pos = from
      for (let s = 0; s < steps; s++) {
        let next = (dir > 0 ? cur.nextElementSibling : cur.previousElementSibling) as HTMLElement | null
        while (next && next.dataset.i === undefined) {
          if (next.classList.contains('fw-edge')) out.edgeHits++
          next = (dir > 0 ? next.nextElementSibling : next.previousElementSibling) as HTMLElement | null
        }
        if (!next) {
          out.lost++
          break
        }
        const i = Number(next.dataset.i)
        if (i !== pos + dir) out.wrong.push([pos, i])
        next.scrollIntoView({ block: 'nearest' })
        if (focus) next.focus({ preventScroll: true })
        const before = next.getBoundingClientRect().top
        const rc = v.stats.recenters
        await new Promise(requestAnimationFrame)
        if (v.stats.recenters !== rc) out.maxCursorShift = Math.max(out.maxCursorShift, Math.abs(next.getBoundingClientRect().top - before))
        if (!next.isConnected || content.querySelector(`[data-i="${i}"]`) !== next) out.lost++
        cur = next
        pos = i
        out.steps++
      }
      out.to = pos
      out.recenters = v.stats.recenters - r0
      return { ...out, stats: { ...v.stats } }
    },
    [from, dir, steps, focus] as const
  )
}

for (const s of SURFACES) {
  test(`G5 ${s.page}: 2,000 consecutive items forward and back, scroll-driven, cursor never unmounted`, async () => {
    const { app, win } = await openWithA11y(s)
    await startAt(win, s.start)
    const fwd = await walk(win, s.start, 1, 2_000, false)
    const back = await walk(win, fwd.to, -1, 2_000, false)
    // Backward into items never mounted before: every recenter turns estimates above the cursor into real heights.
    await startAt(win, s.fresh)
    const freshBack = await walk(win, s.fresh, -1, 2_000, false)
    save(`G5:${s.page}:scroll`, { fwd, back, freshBack })
    for (const r of [fwd, back, freshBack]) {
      expect(r.steps).toBe(2_000)
      expect(r.wrong).toEqual([])
      expect(r.lost).toBe(0)
      expect(r.edgeHits).toBe(0)
      expect(r.recenters).toBeGreaterThanOrEqual(4)
      expect(r.maxCursorShift).toBeLessThan(1) // the element under the cursor keeps its place on screen
    }
    expect(back.to).toBe(s.start)
    await app.close()
  })
}

test('G5 transcript: 2,000 turns forward and back with focus following the cursor', async () => {
  const s = SURFACES[1]
  const { app, win } = await openWithA11y(s)
  await startAt(win, s.start)
  const fwd = await walk(win, s.start, 1, 2_000, true)
  const back = await walk(win, fwd.to, -1, 2_000, true)
  save('G5:transcript:focus', { fwd, back })
  for (const r of [fwd, back]) {
    expect(r.wrong).toEqual([])
    expect(r.lost).toBe(0)
    expect(r.recenters).toBeGreaterThanOrEqual(4)
    expect(r.maxCursorShift).toBeLessThan(1)
  }
  await app.close()
})

/** CDP access to the AX tree: the container's AX children, in the order a screen reader's buffer sees them. */
async function axContainer(win: Page, selector: string) {
  const cdp: CDPSession = await win.context().newCDPSession(win)
  await cdp.send('DOM.enable')
  await cdp.send('Accessibility.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  const { node } = await cdp.send('DOM.describeNode', { nodeId })
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false })
  const id = nodes[0].nodeId
  const children = async () => (await cdp.send('Accessibility.getChildAXNodes', { id })).nodes.filter((n) => !n.ignored)
  const call = async (backendNodeId: number, fn: string) => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId })
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId!, functionDeclaration: fn, returnByValue: true })
    return result.value
  }
  const backendOf = async (i: number) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('${selector} > [data-i="${i}"]')` })
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId! })
    return node.backendNodeId
  }
  const frame = () => cdp.send('Runtime.evaluate', { expression: 'new Promise(requestAnimationFrame)', awaitPromise: true })
  return { cdp, children, call, backendOf, frame }
}

for (const [s, selector] of [
  [SURFACES[0], '#doc'],
  [SURFACES[1], '#feed']
] as const) {
  test(`G5 ${s.page} through the AX tree: 600 steps forward and back over the container's AX children`, async () => {
    const { app, win } = await openWithA11y(s)
    await startAt(win, s.start)
    const ax = await axContainer(win, selector)
    const r0 = await win.evaluate(() => (window as any).__spike.view.stats.recenters)
    const out = { steps: 0, wrong: [] as number[][], lost: 0, nonItems: [] as string[], recentersFwd: 0, recentersBack: 0, msPerStep: 0 }
    let backend = await ax.backendOf(s.start)
    let pos = s.start
    const t0 = Date.now()
    for (const dir of [1, -1] as const) {
      for (let step = 0; step < 600; step++) {
        const kids = await ax.children()
        const at = kids.findIndex((k) => k.backendDOMNodeId === backend)
        let next = kids[at + dir]
        while (next && (await ax.call(next.backendDOMNodeId!, 'function () { return this.dataset.i ?? null }')) === null) {
          out.nonItems.push(`${next.role?.value}:${next.name?.value}`)
          next = kids[kids.indexOf(next) + dir]
        }
        if (at < 0 || !next) {
          out.lost++
          break
        }
        const i = Number(await ax.call(next.backendDOMNodeId!, 'function () { return this.dataset.i }'))
        if (i !== pos + dir) out.wrong.push([pos, i])
        await ax.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: next.backendDOMNodeId! })
        await ax.frame()
        if (!(await ax.call(next.backendDOMNodeId!, 'function () { return this.isConnected }'))) out.lost++
        backend = next.backendDOMNodeId!
        pos = i
        out.steps++
      }
      const r = await win.evaluate(() => (window as any).__spike.view.stats.recenters)
      if (dir > 0) out.recentersFwd = r - r0
      else out.recentersBack = r - r0 - out.recentersFwd
    }
    out.msPerStep = (Date.now() - t0) / out.steps
    save(`G5:${s.page}:ax`, out)
    expect(out.steps).toBe(1_200)
    expect(out.wrong).toEqual([])
    expect(out.lost).toBe(0)
    expect(out.nonItems).toEqual([])
    expect(out.recentersFwd).toBeGreaterThanOrEqual(4)
    expect(out.recentersBack).toBeGreaterThanOrEqual(4)
    await app.close()
  })
}

/** The heading key's view (G6): the next/previous heading (of `level`, if given) among the document's AX children, from block `from`. */
async function axHeading(ax: Awaited<ReturnType<typeof axContainer>>, from: number, dir: 1 | -1, level?: number) {
  const backend = await ax.backendOf(from)
  const kids = await ax.children()
  const at = kids.findIndex((k) => k.backendDOMNodeId === backend)
  for (let k = at + dir; k >= 0 && k < kids.length; k += dir)
    if (kids[k].role?.value === 'heading' && (!level || kids[k].properties?.find((p) => p.name === 'level')?.value.value === level)) return kids[k]
  return null
}

const windowState = (win: Page, i: number) =>
  win.evaluate((i) => {
    const v = (window as any).__spike.view
    const el = v.mounted(i) as HTMLElement | undefined
    const r = el?.getBoundingClientRect()
    const view = v.scroller.getBoundingClientRect()
    return {
      win: v.win,
      mounted: !!el?.isConnected,
      neighbours: !!v.mounted(i - 1) && !!v.mounted(i + 1),
      inView: !!r && r.bottom > view.top && r.top < view.bottom,
      focused: document.activeElement === el
    }
  }, i)

test('G6 heading key: from inside a heading-free stretch, next/previous heading in the AX tree lies outside the window and the window follows it', async () => {
  const { app, win } = await openWithA11y(SURFACES[0])
  const ax = await axContainer(win, '#doc')
  const out: Record<string, unknown> = {}
  // [from, direction, the heading it must reach, its level when the key is a level key (NVDA's 1–6)]: h1, h2, h2, h3.
  for (const [from, dir, expected, level] of [
    [3_200, 1, 5_508, 0],
    [5_400, -1, 2_988, 0],
    [9_100, 1, 11_508, 0],
    [3_200, 1, 5_520, 3]
  ] as const) {
    await startAt(win, from)
    const before = await win.evaluate(() => (window as any).__spike.view.win)
    const h = await axHeading(ax, from, dir, level)
    const i = h ? Number(await ax.call(h.backendDOMNodeId!, 'function () { return this.dataset.i }')) : null
    expect(i).toBe(expected)
    const identity = h ? await ax.call(h.backendDOMNodeId!, 'function () { window.__mark = this; return true }') : null
    await ax.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: h!.backendDOMNodeId! })
    await settle(win)
    const after = await windowState(win, expected)
    const same = await win.evaluate((i) => (window as any).__mark === (window as any).__spike.view.mounted(i), expected)
    out[`${from}${level ? ` key ${level}` : dir > 0 ? 'H' : 'Shift+H'}`] = { before, heading: i, name: h?.name?.value, identity, same, after }
    expect(expected < before.w0 || expected >= before.w1).toBe(true)
    expect(after.mounted && after.neighbours && after.inView && same).toBe(true)
    expect(expected - after.win.w0).toBeGreaterThanOrEqual(100)
    expect(after.win.w1 - expected).toBeGreaterThanOrEqual(100)
  }
  save('G6:headingKey', out)
  await app.close()

  // Control: without the pinned headings, the same heading key finds nothing past the window.
  const ctl = await launchPage('doc', { TYPOSE_A11Y: '1' })
  await ctl.win.waitForFunction(() => (window as any).__spike.a11y === true)
  await openFixture(ctl.win, DOC, { skeleton: false })
  const cax = await axContainer(ctl.win, '#doc')
  const control: Record<string, unknown> = {}
  for (const [from, dir] of [
    [3_200, 1],
    [5_400, -1]
  ] as const) {
    await startAt(ctl.win, from)
    const h = await axHeading(cax, from, dir)
    control[`${from}${dir > 0 ? 'H' : 'Shift+H'}`] = h ? await cax.call(h.backendDOMNodeId!, 'function () { return this.dataset.i }') : null
  }
  save('G6:headingKey:controlWithoutPinnedHeadings', control)
  expect(Object.values(control)).toEqual([null, null])
  await ctl.app.close()
})

test('G6 Outline: activating an entry for a heading outside the window mounts it, recenters on it and focuses it', async () => {
  const { app, win } = await openWithA11y(SURFACES[0])
  const out: Record<string, unknown> = {}
  for (const target of [19_992, 5_508, 11_508, 0]) {
    const before = await win.evaluate(() => (window as any).__spike.view.win)
    await win.locator(`#outline a[data-i="${target}"]`).focus()
    await win.keyboard.press('Enter')
    await win.waitForFunction((t) => {
      const f = document.activeElement as HTMLElement | null
      return f?.parentElement?.id === 'doc' && f.dataset.i === String(t)
    }, target)
    await settle(win)
    const after = await windowState(win, target)
    out[target] = { before, after }
    expect(target === 0 || target < before.w0 || target >= before.w1).toBe(true)
    expect(after.mounted && after.inView && after.focused).toBe(true)
    expect(target >= after.win.w0 && target < after.win.w1).toBe(true)
  }
  save('G6:outline', out)
  await app.close()
})

/**
 * G9: `ms` (10 s) of auto-scroll at `speed` px/s, sampling rAF intervals with PerfLog. `jumps` (spec Z52) are far jumps
 * made during it, `at` ms in: a scrollbar jump to `frac` of the content, or an Outline-style jump to item `goTo`.
 */
function autoScroll(win: Page, speed: number, jumps: { at: number; frac?: number; goTo?: number }[] = [], ms = 10_000) {
  return win.evaluate(async ({ speed, jumps, ms }) => {
    const sp = (window as any).__spike
    const s = sp.view.scroller as HTMLElement
    const r0 = sp.view.stats.recenters
    const a0 = sp.view.stats.applies
    sp.view.stats.maxApplyMs = 0
    sp.perf.startFrames(() => s.scrollTop)
    const t0 = performance.now()
    let last = t0
    await new Promise<void>((done) => {
      const tick = (now: number): void => {
        s.scrollTop += (speed * (now - last)) / 1000
        last = now
        while (jumps.length && now - t0 >= jumps[0].at) {
          const j = jumps.shift()!
          if (j.goTo === undefined) s.scrollTop = s.scrollHeight * j.frac!
          else void sp.view.goTo(j.goTo)
        }
        if (now - t0 < ms) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    const f = sp.perf.stopFrames()
    const st = sp.view.stats
    return { ...f, recenters: st.recenters - r0, applies: st.applies - a0, maxApplyMs: st.maxApplyMs, scrolledPx: s.scrollTop }
  }, { speed, jumps: [...jumps], ms })
}

const RUNS = Number(process.env.RUNS ?? 5)

for (const s of SURFACES) {
  test(`G9 ${s.page}: long frames during 10 s of auto-scroll, accessibility on vs off, interleaved`, async () => {
    const { app, win } = await launchPage(s.page)
    await openFixture(win, s.file)
    await win.waitForTimeout(500) // let startup work settle
    // Toggling Electron's accessibility support in place, as a screen reader starting and stopping would,
    // interleaves on and off runs so drift on this shared machine hits both alike.
    const setA11y = async (on: boolean): Promise<boolean> => {
      await app.evaluate(({ app }, on) => app.setAccessibilitySupportEnabled(on), on)
      await win.waitForFunction((on) => (window as any).__spike.a11y === on, on)
      await win.evaluate(() => ((window as any).__spike.view.scroller.scrollTop = 0))
      await settle(win)
      return app.evaluate(({ app }) => app.isAccessibilitySupportEnabled())
    }
    const runs: Record<string, Awaited<ReturnType<typeof autoScroll>>[]> = {}
    for (let r = 0; r < RUNS; r++) {
      for (const on of [true, false]) {
        expect(await setA11y(on)).toBe(on)
        ;(runs[`2000px/s:${on ? 'on' : 'off'}`] ??= []).push(await autoScroll(win, 2_000))
      }
    }
    await app.close()
    // Each stress run gets a fresh launch with accessibility on or off from the start. Re-enabled in place, the renderer
    // serializes a whole new accessibility tree in the run's first frames (60–90 ms), which is not recenter cost.
    for (let r = 0; r < 2; r++) {
      for (const on of [true, false]) {
        const fresh = await launchPage(s.page, on ? { TYPOSE_A11Y: '1' } : {})
        await fresh.win.waitForFunction((on) => (window as any).__spike.a11y === on, on, { timeout: 10_000 })
        await openFixture(fresh.win, s.file)
        await fresh.win.waitForTimeout(500) // let startup work settle
        await settle(fresh.win)
        expect(await fresh.app.evaluate(({ app }) => app.isAccessibilitySupportEnabled())).toBe(on)
        ;(runs[`${s.stress}px/s:${on ? 'on' : 'off'}`] ??= []).push(await autoScroll(fresh.win, s.stress))
        await fresh.app.close()
      }
    }
    const summary = Object.fromEntries(
      Object.entries(runs).map(([k, rs]) => {
        const share = rs.map((r) => r.longShare)
        return [
          k,
          {
            n: rs.length,
            longShareP50: percentile(share, 50),
            longShareMax: Math.max(...share),
            framesP50: percentile(
              rs.map((r) => r.frames),
              50
            ),
            maxGap: Math.max(...rs.map((r) => r.maxGap)),
            recenters: rs.map((r) => r.recenters),
            maxApplyMs: Math.max(...rs.map((r) => r.maxApplyMs)),
            runs: rs
          }
        ]
      })
    )
    save(`G9:${s.page}`, summary)
    expect(summary['2000px/s:on'].longShareP50).toBeLessThanOrEqual(0.01)
    // No stall over 50 ms in the stress runs with accessibility on (spec §10.2): the longest rAF interval.
    expect(summary[`${s.stress}px/s:on`].maxGap).toBeLessThanOrEqual(50)
    // The 2,000 px/s runs never recenter the 500-item window; the stress runs do. One recenter must fit in a frame.
    expect(Math.min(...summary[`${s.stress}px/s:on`].recenters)).toBeGreaterThanOrEqual(2)
    expect(summary[`${s.stress}px/s:on`].maxApplyMs).toBeLessThan(16)
  })
}

// G9 jumps (spec Z52): a far jump replaces the whole window, and with accessibility on the renderer then serializes all of
// it at once. Fresh launches, accessibility off and then on from the start: auto-scroll right after the file opens, and
// auto-scroll with three scrollbar jumps and two Outline-style jumps. The measure is the stall check: the longest rAF gap.
for (const s of SURFACES) {
  test(`G9 jumps ${s.page}: no stall over 50 ms on far jumps, accessibility on from launch (spec Z52)`, async () => {
    test.setTimeout(5 * 60_000)
    const n = s.page === 'doc' ? 20_000 : 5_000
    const jumps = [
      { at: 2_000, frac: 0.5 },
      { at: 4_000, frac: 0.9 },
      { at: 6_000, frac: 0.1 },
      { at: 8_000, goTo: Math.round(n * 0.75) },
      { at: 10_000, goTo: Math.round(n * 0.025) }
    ]
    const out: Record<string, { open: number; jumps: number; runs: Awaited<ReturnType<typeof autoScroll>>[] }> = {}
    for (const on of [false, true]) {
      const runs: Awaited<ReturnType<typeof autoScroll>>[] = []
      for (const jumping of [false, true]) {
        const { app, win } = await launchPage(s.page, on ? { TYPOSE_A11Y: '1' } : {})
        await win.waitForFunction((on) => (window as any).__spike.a11y === on, on, { timeout: 10_000 })
        await openFixture(win, s.file)
        if (jumping) {
          await win.waitForTimeout(1_000)
          await settle(win)
        }
        runs.push(await autoScroll(win, 2_000, jumping ? jumps : [], 12_000))
        await app.close()
      }
      out[on ? 'on' : 'off'] = { open: runs[0].maxGap, jumps: runs[1].maxGap, runs }
    }
    save(`G9:jumps:${s.page}`, out)
    // The control: with accessibility off the same jumps stay under 50 ms, so the check can pass. Opening isn't part of
    // it: with accessibility off, the first frames after opening stalled too (Checkpoint item 5). It is saved, not asserted.
    expect(out.off.jumps, 'accessibility off').toBeLessThanOrEqual(50)
    expect(Math.max(out.on.open, out.on.jumps), 'accessibility on').toBeLessThanOrEqual(50)
  })
}

test('AX findings: what Electron 44 exposes for the document and the feed', async () => {
  const found: Record<string, unknown> = {}
  for (const [s, selector] of [
    [SURFACES[0], '#doc'],
    [SURFACES[1], '#feed']
  ] as const) {
    const { app, win } = await openWithA11y(s)
    const ax = await axContainer(win, selector)
    const kids = await ax.children()
    const byRole: Record<string, unknown> = {}
    for (const k of kids) {
      const role = String(k.role?.value)
      if (byRole[role]) continue
      byRole[role] = {
        name: k.name?.value,
        tag: await ax.call(k.backendDOMNodeId!, 'function () { return this.tagName }'),
        properties: Object.fromEntries((k.properties ?? []).map((p) => [p.name, p.value.value]))
      }
    }
    const { root } = await ax.cdp.send('DOM.getDocument', { depth: 0 })
    const container = await ax.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    const { node } = await ax.cdp.send('DOM.describeNode', { nodeId: container.nodeId })
    const { nodes } = await ax.cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: true })
    found[s.page] = {
      container: nodes.filter((n) => n.backendDOMNodeId === node.backendNodeId).map((n) => ({ role: n.role?.value, name: n.name?.value })),
      axChildren: kids.length,
      domChildren: await win.evaluate((sel) => document.querySelector(sel)!.children.length, selector),
      byRole
    }
    if (s.page === 'doc') {
      const navQ = await ax.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#outline' })
      const nav = await ax.cdp.send('DOM.describeNode', { nodeId: navQ.nodeId })
      const navAx = await ax.cdp.send('Accessibility.getPartialAXTree', { backendNodeId: nav.node.backendNodeId, fetchRelatives: false })
      const links = await ax.cdp.send('Accessibility.queryAXTree', { backendNodeId: nav.node.backendNodeId, role: 'link' })
      const box = await win.locator('#outline').boundingBox()
      found.outlineCollapsed = {
        role: navAx.nodes[0].role?.value,
        name: navAx.nodes[0].name?.value,
        ignored: navAx.nodes[0].ignored,
        links: links.nodes.filter((n) => !n.ignored).length,
        headings: await win.evaluate(() => document.querySelectorAll('#outline a').length),
        box
      }
      expect(navAx.nodes[0].ignored).toBe(false)
      expect(links.nodes.filter((n) => !n.ignored).length).toBe(1_040)
      expect(box!.width).toBeLessThanOrEqual(1)
    }
    await app.close()
  }
  save('AX', found)
})
```

- [ ] **Step 2: Run the gates**

Close other apps and stop other lanes: the CPU must read under 10% for a minute before the run. PowerShell, twelve readings 5 s apart, each under 10: `1..12 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Start-Sleep -Seconds 5 }`. A run on a loaded PC is not a G9 result: the apply-time bound is the maximum of 6 to 8 wall-clock samples, and on the shared PC it failed in 5 of 8 runs (17.9 to 24.1 ms) and passed in 3 (9.9 to 13.0 ms). Run (`spikes/app`): `npm run build`, then `npx playwright test --project=perf spike-b2` (the scratch run took 25.7 minutes on a machine busy with other work; the jump tests, added later, take about 2 more). `RUNS` sets G9's n for the 2,000 px/s runs only; the stress runs stay at 2. PowerShell: `$env:RUNS = '3'; npx playwright test --project=perf spike-b2; Remove-Item Env:RUNS`. Git Bash: `RUNS=3 npx playwright test --project=perf spike-b2`.
Expected: `10 passed` and `2 failed` on the quiet PC; zoom must be 100% (the launch helper refuses otherwise). The two failures are the G9 jump tests, each with `Error: accessibility on` and `Expected: <= 50`. Far jumps stall with accessibility on, and spec Z52 records that as a Phase 0 finding (Checkpoint item 5). `Error: accessibility off` is a different failure: the control failed, so the run doesn't show that the check can pass. Rerun it on a quiet PC.

Round 3's Z52 replay printed `10 passed` and `2 failed` in 11.1 minutes, on a shared PC at 30% mean CPU:
- the jump case with accessibility on: open run 103.3 ms and jump run 66.8 ms on the Document, 103.2 and 103.3 ms on the Transcript;
- with accessibility off: jump runs 6.9 and 6.3 ms;
- the G9 stress runs with accessibility on: 24.4 ms on the Document and 18.3 ms on the Transcript (`maxApplyMs` 7.7 and 12.9).

Before each stress run launched fresh, the Transcript's G9 failed its stall check at 60.7 ms (Checkpoint item 4). The Spike B report takes these from `spikes/results/spike-b2-<hostname>.json`:
- **G5:** for each walk, `steps`, `wrong` (must be `[]`), `lost` (0), `edgeHits` (0), `recenters` (≥ 4), `maxCursorShift` (< 1 px), and the `stats` counters `corrections`, `maxCorrection`, `maxResidual`.
- **G5 AX:** `steps` (1,200), `wrong`, `lost`, `nonItems`, `recentersFwd`/`recentersBack`, `msPerStep`.
- **G6:** each jump's `before` window, the `heading` reached (5508, 2988, 11508 and the h3 5520), `after`; the control's two `null`s; the Outline's four jumps.
- **G9:** per surface and speed, `longShareP50`, `longShareMax`, `framesP50`, `maxGap`, `recenters`, `maxApplyMs`, both with accessibility on and off; the stress runs' `recenters` (each ≥ 2 with accessibility on), `maxGap` (≤ 50 ms) and `maxApplyMs` (< 16).
- **G9 jumps:** per surface, with accessibility `off` and `on`, the open run's and the jump run's `maxGap` (`open`, `jumps`) and both runs' records. With accessibility on they are over 50 ms today (Checkpoint item 5).
- **AX:** the per-role table and `outlineCollapsed`.

- [ ] **Step 3: Read your own work (rule 8), then commit**

```bash
git add spikes/app/perf/spike-b2.e2e.ts spikes/results/spike-b2-*.json
git commit -m "spike(b): document gates G5, G6, G9 and AX findings"
```

---

## Chrome: the React frame, the lens switch and the peek (Tasks B3a–B3c)

Tasks B3a–B3c build on plan A Tasks 1–10 and Task B0, and use plan A's `LensView` (Task 9) unchanged.

**What Tasks B3a–B3c prove (spec §13.1 Spike B):**
- React 19 + React Aria own the card frame, the lens switch (`Tabs`, with a `Select` below 400px) and the peek, while a framework-free lens controller owns everything inside the card body.
- 100 peek open/close cycles lose focus zero times (gate G7).
- Nothing in the chrome or the open peek is unreachable at 200% zoom, at the default window and at the 720×480 minimum, and nothing on the Grid, Rows, Rendered and Transcript pages opened at 200% (gate G8).
- axe-core finds nothing serious or critical and no heading out of order (and, in the measured run, nothing at all) on the chrome page or with the peek open. It finds nothing at all on the Rendered and Transcript pages in accessibility mode, apart from the document author's own heading levels inside `main#doc` (Task B3c).

**Page contract.** `typose://app/chrome.html?open=<card file>|<peek file>`. `main/index.ts` already forwards one `TYPOSE_OPEN` value as `?open=`, so the two paths are joined with `|` (a Windows path cannot contain it). Launch it with `TYPOSE_PAGE=chrome` and `TYPOSE_OPEN=<card file>|<peek file>`. `tools/chrome-fixtures.mjs` writes two small JSONL files and prints that value.

**Pinned versions** (verified on npm 2026-10-20): react 19.3.1, react-dom 19.3.1, react-aria-components 1.22.1, react-aria 3.53.1 (the version npm resolved for react-aria-components 1.22.1; it is imported directly for `FocusScope`, so it is declared), @vitejs/plugin-react 6.1.2, axe-core 4.14.0, @axe-core/playwright 4.14.0.

---

## Task B3a: The chrome page, the card frame, the lens switch, and a lens mounted into the card body

**Files:**
- Modify: `spikes/app/package.json`, `spikes/app/package-lock.json` (generated), `spikes/app/electron.vite.config.ts`
- Create: `spikes/tools/chrome-fixtures.mjs`
- Create: `spikes/app/src/renderer/chrome.html`
- Create: `spikes/app/src/renderer/src/chrome/docs.ts`, `docs.test.ts`, `lenses.ts`, `LensBody.tsx`, `Card.tsx`, `App.tsx`, `main.tsx`, `chrome.css`
- Create: `spikes/app/e2e/chrome-launch.ts`, `spikes/app/e2e/chrome.e2e.ts`
- Do not modify: `lens-view.ts`, `virtual-list.ts`, `core.ts`, anything in `src/main` or `src/preload`.

**Interfaces:**
- **Consumes:**
  - `Core` (`call<T>(method, params)`, `onEvent(cb)`) from `core.ts`;
  - plan A Task 9: `new LensView(parent, core, doc, kind: 'raw' | 'rows', perf)`, `setRowCount(n, done)`, `list.firstVisibleRow()`, `list.scrollToRow(i)`; `PerfLog`;
  - the RPCs `open` (returns `{ doc, size }`), `lines`, `rows`, and the `progress` event `{ doc, lines, done }`;
  - `main/index.ts`: `TYPOSE_PAGE` picks `typose://app/<page>.html` (Task B0); `TYPOSE_OPEN` becomes `?open=` (plan A Task 8).
- **Produces:**
  - **docs.ts:**
    - `interface Progress { lines: number; done: boolean }`;
    - `interface DocHandle { readonly doc: number; readonly path: string; state(): Progress; subscribe(cb: (p: Progress) => void): () => void }`;
    - `class DocStore { constructor(core: Core); open(path: string): Promise<DocHandle> }`: it owns the one `core.onEvent` subscription and keeps progress that arrives before the `open` reply;
    - `splitPath(path): { parent: string; file: string }`.
  - **lenses.ts:**
    - `type LensKind = 'raw' | 'rows' | 'tree'` and `LENSES: { id: LensKind; label: string }[]`;
    - `interface MountedLens { anchor(): number; dispose(): void }`, the slice of spec §5.2's `Lens` this spike needs;
    - `mounted: Set<MountedLens>`;
    - `mountLens(kind, parent, handle, core, perf, anchor = 0): MountedLens`.
  - **LensBody.tsx:** `type Anchor = { doc: number; row: number }`; `LensBody` (props `kind, handle, core, perf, anchor: RefObject<Anchor>`), the one div React renders for a lens.
  - **Card.tsx:** `Card` (props `handle, core, perf, linkLabel, onOpenLink(trigger: HTMLElement), overlayOpen, children`).
  - **App.tsx:** `App` (props `core, perf, version, main, peek`); sets `window.__chrome.ready = true` once the first lens is mounted.
  - **`window.__chrome`:** `{ ready: boolean, perf, lenses: Set<MountedLens>, core, store }`.
  - **e2e/chrome-launch.ts:** `interface Chrome { app; win; profile: string }`; `launchFresh(env): Promise<Chrome>`, which launches with `env` (inherited `TYPOSE_*` dropped) in a fresh profile, deleted when the app closes; `launchChrome(): Promise<Chrome>`, which uses it for the chrome page on the two fixture files; `setViewport(app, win, w, h, zoom)`, `focusEl`, `mouseClick`, `activeInfo`, `startFocusProbe`, `readFocusProbe`.
  - **DOM contract the tests rely on:** classes `.card`, `.card-body`, `.link-trigger`, `.lens-tab`, `.lens-select-btn`, `.breadcrumb`; roles `tablist`, `tab`, `tabpanel`.

**Design notes:**
- **React renders one div per lens, nothing inside it.** `LensBody` is that div. Its layout effect calls `mountLens` and returns `dispose`, so a lens switch is "unmount the old `LensBody` effect, mount the new one". The lens lives in its own child div, so `dispose` removes everything it created.
- **The document outlives its lenses.** `DocStore` holds the progress; a lens mounted after indexing finished reads `handle.state()` because no further `progress` event will come. Progress events can also arrive before the `open` reply, so they are stored per document, not per handle.
- **Anchor hand-off.** `LensBody` writes `{ doc, row: lens.anchor() }` into a ref as its lens unmounts and reads it when the next one mounts, so Raw, Rows and the placeholder keep the reader's place. Here the anchor is the first visible line, which Raw and Rows share. The real `Lens.anchor()` has to be source-mapped (byte offset plus the offset inside the element): a Grid row, a Tree node and a Rendered block are not lines.
- **`Tabs` owns the lens switch; one `TabPanel` owns the body.** The panel's `id` follows the selected tab, which keeps `aria-controls` and `aria-labelledby` valid and lets React Aria make the panel itself a Tab stop when the lens has nothing focusable (the Tree placeholder).
- **Below a 400px card the tab list becomes a `Select`.** Both exist; a container query in `chrome.css` shows one. No resize observer and no remount when the card crosses 400px.
- **Known gaps (marked `ponytail:` in the code):** `LensView` has no `dispose`, so its ResizeObserver and any page request in flight outlive the lens (not measured); documents are never closed; `?open=a|b` stands in for the workspace store.

- [ ] **Step 1: Install the dependencies**

The dependencies are exact versions; `react-aria` is listed because `Peek.tsx` imports `react-aria/FocusScope`.
`spikes/app/package.json`:
```json
{
  "name": "spike-app",
  "version": "0.0.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "build": "electron-vite build",
    "test": "vitest run",
    "e2e": "playwright test --project=e2e",
    "perf:a": "playwright test --project=perf spike-a",
    "pack": "electron-builder --dir"
  },
  "dependencies": {
    "react": "19.3.1",
    "react-aria": "3.53.1",
    "react-aria-components": "1.22.1",
    "react-dom": "19.3.1",
    "spike-node": "file:../core/spike-node"
  },
  "devDependencies": {
    "@axe-core/playwright": "4.14.0",
    "@playwright/test": "1.64.1",
    "@vitejs/plugin-react": "6.1.2",
    "axe-core": "4.14.0",
    "electron": "44.9.2",
    "electron-builder": "26.15.3",
    "electron-vite": "6.0.0",
    "typescript": "7.0.2",
    "vite": "8.3.4",
    "vitest": "5.0.5"
  },
  "build": {
    "appId": "dev.typose.spike",
    "files": ["out/**"],
    "asarUnpack": ["**/*.node"]
  }
}
```

Run (`spikes/app`): `npm install --prefer-offline`
Expected: it finishes without errors and rewrites `package-lock.json` (npm may print an audit summary; ignore it).

Run (`spikes/app`): `npm ls react react-dom react-aria-components react-aria @vitejs/plugin-react axe-core @axe-core/playwright`
Expected: each package resolves once, at the version in `package.json`.

- [ ] **Step 2: Write the failing DocStore tests**

`spikes/app/src/renderer/src/chrome/docs.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { Core, CoreEvent } from '../core'
import { DocStore, splitPath } from './docs'

/** A core whose `open` posts a progress event BEFORE its reply, the order the real core host can produce. */
function fakeCore(): { core: Core; emit: (e: CoreEvent) => void } {
  const listeners: ((e: CoreEvent) => void)[] = []
  const emit = (e: CoreEvent): void => listeners.forEach((l) => l(e))
  const core: Core = {
    call: <T>(method: string): Promise<T> => {
      if (method !== 'open') return Promise.reject(new Error(`unexpected ${method}`))
      emit({ event: 'progress', doc: 7, lines: 40, done: false })
      return Promise.resolve({ doc: 7, size: 1234 } as T)
    },
    onEvent: (cb) => {
      listeners.push(cb)
    }
  }
  return { core, emit }
}

describe('DocStore', () => {
  it('keeps progress that arrives before the open reply', async () => {
    const { core } = fakeCore()
    const handle = await new DocStore(core).open('C:\\x\\a.jsonl')
    expect(handle.doc).toBe(7)
    expect(handle.state()).toEqual({ lines: 40, done: false })
  })

  it('notifies subscribers of its own document until they unsubscribe', async () => {
    const { core, emit } = fakeCore()
    const handle = await new DocStore(core).open('a.jsonl')
    const seen: number[] = []
    const off = handle.subscribe((s) => seen.push(s.lines))
    emit({ event: 'progress', doc: 7, lines: 90, done: true })
    emit({ event: 'progress', doc: 8, lines: 5, done: true }) // another document
    off()
    emit({ event: 'progress', doc: 7, lines: 91, done: true })
    expect(seen).toEqual([90])
    expect(handle.state()).toEqual({ lines: 91, done: true })
  })
})

describe('splitPath', () => {
  it('splits Windows and POSIX paths into parent folder and file', () => {
    expect(splitPath('C:\\Users\\z\\notes\\plan.md')).toEqual({ parent: 'notes', file: 'plan.md' })
    expect(splitPath('/home/z/notes/plan.md')).toEqual({ parent: 'notes', file: 'plan.md' })
    expect(splitPath('plan.md')).toEqual({ parent: '', file: 'plan.md' })
  })
})
```

Run (`spikes/app`): `npx vitest run`
Expected: FAIL: `FAIL  src/renderer/src/chrome/docs.test.ts` with `Error: Cannot find module './docs'`; `Test Files  1 failed | 5 passed (6)` and `Tests  30 passed (30)` (the existing 30 still pass).

- [ ] **Step 3: Implement `docs.ts`**

`spikes/app/src/renderer/src/chrome/docs.ts`:
```ts
import type { Core } from '../core'

export interface Progress {
  lines: number
  done: boolean
}

/** A document the core has open. Lenses mount on it and unmount from it; it outlives both (spec §5.2 `DocHandle`). */
export interface DocHandle {
  readonly doc: number
  readonly path: string
  /** The latest indexing progress. A lens mounted after the index finished never sees another event, so it reads this. */
  state(): Progress
  subscribe(cb: (p: Progress) => void): () => void
}

/**
 * Owns the one `core.onEvent` subscription (Core has no unsubscribe) and fans progress out per document.
 * ponytail: documents are never closed; the real DocHandle ref-counts and closes.
 */
export class DocStore {
  private readonly progress = new Map<number, Progress>()
  private readonly subs = new Map<number, Set<(p: Progress) => void>>()

  constructor(private readonly core: Core) {
    core.onEvent((e) => {
      if (e.event !== 'progress') return
      const doc = e.doc as number
      const p = { lines: e.lines as number, done: e.done as boolean }
      this.progress.set(doc, p) // before the open reply, `doc` is not yet a handle: keep the event for when it is
      for (const cb of this.subs.get(doc) ?? []) cb(p)
    })
  }

  async open(path: string): Promise<DocHandle> {
    const { doc } = await this.core.call<{ doc: number }>('open', { path })
    return {
      doc,
      path,
      state: () => this.progress.get(doc) ?? { lines: 0, done: false },
      subscribe: (cb) => {
        const set = this.subs.get(doc) ?? new Set()
        this.subs.set(doc, set.add(cb))
        return () => void set.delete(cb)
      }
    }
  }
}

/** Breadcrumb parts for a file outside any root: its parent folder and its name (brief §3.5). */
export function splitPath(path: string): { parent: string; file: string } {
  const parts = path.split(/[\\/]/)
  return { parent: parts.length > 1 ? parts[parts.length - 2] : '', file: parts[parts.length - 1] }
}
```

Run (`spikes/app`): `npx vitest run`
Expected: `Test Files  6 passed (6)`, `Tests  33 passed (33)` (30 existing + 3 new).

- [ ] **Step 4: The fixture writer**

`spikes/tools/chrome-fixtures.mjs`:
```js
// Two small JSONL files for the Spike B chrome page: the card's file and the peek's file.
// CLI: `node tools/chrome-fixtures.mjs` writes them to .fixtures/ and prints the TYPOSE_OPEN value.
// No import.meta: Playwright loads this file through its CommonJS transform when an e2e helper imports it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const kinds = ['user', 'assistant', 'tool', 'system']

function jsonl(name, count) {
  return Array.from(
    { length: count },
    (_, i) => `{"ts":"12:${String(i % 60).padStart(2, '0')}","type":"${kinds[i % kinds.length]}","msg":"${name} row ${i}"}`
  ).join('\n')
}

/** Writes both files into `dir` and returns their paths. */
export function writeChromeFixtures(dir) {
  mkdirSync(dir, { recursive: true })
  const main = join(dir, 'chrome-main.jsonl')
  const peek = join(dir, 'chrome-peek.jsonl')
  writeFileSync(main, jsonl('main', 2000))
  writeFileSync(peek, jsonl('peek', 500))
  return { main, peek }
}

if (process.argv[1]?.endsWith('chrome-fixtures.mjs')) {
  const { main, peek } = writeChromeFixtures(resolve(process.argv[1], '../../.fixtures'))
  console.log(`${main}|${peek}`)
}
```

Run (`spikes`): `node tools/chrome-fixtures.mjs`
Expected: it prints one line, `<...>\.fixtures\chrome-main.jsonl|<...>\.fixtures\chrome-peek.jsonl`, and the two files exist (2,000 and 500 lines). `spikes/.fixtures/` is already gitignored.

- [ ] **Step 5: Write the failing e2e tests and their launch helper**

The helper launches the page with `TYPOSE_*` stripped from the inherited environment and in its own temporary profile, deleted when the app closes (`--user-data-dir`: Chromium persists a zoom set with `setZoomFactor` per origin in the profile, so without this every launch after a G8 run starts at 200%, and so would every other page that shares `%APPDATA%\spike-app`). It waits for `window.__chrome.ready` (no fixed sleeps) and carries the focus, click, zoom and probe helpers that Tasks B3b and B3c use.

`spikes/app/e2e/chrome-launch.ts`:
```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeChromeFixtures } from '../../tools/chrome-fixtures.mjs'

export interface Chrome {
  app: ElectronApplication
  win: Page
  /** The launch's private profile directory. */
  profile: string
}

/**
 * Launches the app with `env` in a profile of its own, deleted (~7 MB) when the app closes. Chromium persists a page zoom
 * set with setZoomFactor per origin in the profile, so a shared one would start the next launch (and the other Spike B
 * pages) zoomed. TYPOSE_* is never inherited from the shell: a leftover TYPOSE_OPEN would point the page at someone
 * else's files.
 */
export async function launchFresh(env: Record<string, string>): Promise<Chrome> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const profile = mkdtempSync(join(tmpdir(), 'typose-chrome-profile-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...base, ...env } as Record<string, string> })
  app.on('close', () => rmSync(profile, { recursive: true, force: true, maxRetries: 5 }))
  return { app, win: await app.firstWindow(), profile }
}

/** Launches the Spike B chrome page on the two fixture files and waits for its readiness hook (no fixed sleeps). */
export async function launchChrome(): Promise<Chrome> {
  const { main, peek } = writeChromeFixtures(join(tmpdir(), 'typose-chrome-fixtures'))
  const c = await launchFresh({ TYPOSE_PAGE: 'chrome', TYPOSE_OPEN: `${main}|${peek}` })
  await c.win.waitForFunction(() => (window as any).__chrome?.ready === true)
  await c.win.bringToFront()
  return c
}

/** Sets the content size and the page zoom of the first window, then waits until the page sees the new viewport. */
export async function setViewport(app: ElectronApplication, win: Page, width: number, height: number, zoom: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h, z]) => {
      const bw = BrowserWindow.getAllWindows()[0]
      bw.setContentSize(w, h)
      bw.webContents.setZoomFactor(z)
    },
    [width, height, zoom]
  )
  await win.waitForFunction(
    ([w, h, z]) => Math.abs(innerWidth - w / z) < 1 && Math.abs(innerHeight - h / z) < 1,
    [width, height, zoom]
  )
}

/** `element.focus()` through one evaluate (Playwright's locator actions cost 0.3–4s each on a loaded machine). */
export function focusEl(win: Page, selector: string): Promise<void> {
  return win.evaluate((s) => (document.querySelector(s) as HTMLElement).focus(), selector)
}

/** A real mouse click (CDP Input.dispatchMouseEvent) at an offset inside the element, without Playwright's actionability waits. */
export async function mouseClick(win: Page, selector: string, at?: { x: number; y: number }): Promise<void> {
  const r = await win.evaluate((s) => {
    const b = document.querySelector(s)!.getBoundingClientRect()
    return { x: b.left, y: b.top, w: b.width, h: b.height }
  }, selector)
  await win.mouse.click(r.x + (at?.x ?? r.w / 2), r.y + (at?.y ?? r.h / 2))
}

/** What `document.activeElement` is, in terms the focus assertions need. */
export function activeInfo(win: Page): Promise<{ body: boolean; inPeek: boolean; trigger: boolean; name: string }> {
  return win.evaluate(() => {
    const a = document.activeElement
    return {
      body: !a || a === document.body || a === document.documentElement,
      inPeek: Boolean(a?.closest('[role="dialog"]')),
      trigger: Boolean(a?.classList.contains('link-trigger')),
      name: a ? `${a.tagName.toLowerCase()}.${a.className}` : 'null'
    }
  })
}

/**
 * Starts counting moments at which focus is on <body>: every animation frame, every DOM mutation (a microtask after the
 * mutation, before any frame) and every focusin. A focusout with no new target while the document has focus is counted
 * as a leak. Install it after the first element has been focused.
 */
export function startFocusProbe(win: Page): Promise<void> {
  return win.evaluate(() => {
    const stat = { samples: 0, bodySamples: 0, leaks: 0, log: [] as string[] }
    const sample = (why: string): void => {
      stat.samples++
      const a = document.activeElement
      if (!a || a === document.body || a === document.documentElement) {
        stat.bodySamples++
        if (stat.log.length < 20) stat.log.push(`${why} @${Math.round(performance.now())}`)
      }
    }
    new MutationObserver(() => sample('mutation')).observe(document, { subtree: true, childList: true, attributes: true })
    document.addEventListener('focusin', () => sample('focusin'), true)
    document.addEventListener(
      'focusout',
      (e) => {
        if (e.relatedTarget === null && document.hasFocus()) stat.leaks++
      },
      true
    )
    const tick = (): void => {
      sample('frame')
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    ;(window as any).__probe = stat
  })
}

export function readFocusProbe(win: Page): Promise<{ samples: number; bodySamples: number; leaks: number; log: string[] }> {
  return win.evaluate(() => (window as any).__probe)
}
```

Two tests now; Task B3b appends a third.
`spikes/app/e2e/chrome.e2e.ts`:
```ts
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { activeInfo, launchChrome } from './chrome-launch'

interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value: string }
  name?: { value: string }
  childIds?: string[]
  properties?: { name: string; value: { value: unknown } }[]
}

/** The lens switch as the accessibility tree sees it (CDP `Accessibility.getFullAXTree`). */
async function lensSwitchInAxTree(win: Page): Promise<{ role: string; tabs: { name: string; selected: boolean }[] } | null> {
  const cdp = await win.context().newCDPSession(win)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
  await cdp.detach()
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const list = nodes.find((n) => !n.ignored && n.role?.value === 'tablist')
  if (!list) return null
  // Ignored wrapper nodes are transparent: collect the tabs beneath them.
  const tabs: AxNode[] = []
  const walk = (ids: string[]): void => {
    for (const id of ids) {
      const n = byId.get(id)
      if (!n) continue
      if (!n.ignored && n.role?.value === 'tab') tabs.push(n)
      else walk(n.childIds ?? [])
    }
  }
  walk(list.childIds ?? [])
  return {
    role: list.role!.value,
    tabs: tabs.map((t) => ({ name: t.name?.value ?? '', selected: t.properties?.find((p) => p.name === 'selected')?.value.value === true }))
  }
}

test('the lens switch is a tablist of tabs with selected state, and arrow keys move between tabs', async () => {
  const { app, win, profile } = await launchChrome()
  expect(await lensSwitchInAxTree(win)).toEqual({
    role: 'tablist',
    tabs: [
      { name: 'Raw', selected: true },
      { name: 'Rows', selected: false },
      { name: 'Tree', selected: false }
    ]
  })
  await win.getByRole('tab', { name: 'Raw' }).focus()
  await win.keyboard.press('ArrowRight')
  await expect(win.getByRole('tab', { name: 'Rows' })).toHaveAttribute('aria-selected', 'true')
  expect(await win.evaluate(() => document.activeElement?.getAttribute('aria-selected') + ':' + document.activeElement?.textContent)).toBe('true:Rows')
  expect((await lensSwitchInAxTree(win))?.tabs.map((t) => t.selected)).toEqual([false, true, false])
  await win.keyboard.press('End')
  await expect(win.getByRole('tab', { name: 'Tree' })).toHaveAttribute('aria-selected', 'true')
  await win.keyboard.press('Home')
  await expect(win.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true')
  await app.close()
  expect(existsSync(profile)).toBe(false) // the launch's profile is deleted when the app closes
})

test('switching lens disposes the old lens, mounts the new one, and hands the scroll anchor over', async () => {
  const { app, win } = await launchChrome()
  const lenses = () => win.evaluate(() => (window as any).__chrome.lenses.size as number)
  const anchor = () => win.evaluate(() => [...(window as any).__chrome.lenses][0].anchor() as number)
  await expect(win.locator('.card-body .vl-row').first()).toContainText('main row 0') // Raw: JSON text
  await win.evaluate(() => {
    document.querySelector<HTMLElement>('.card-body .vl-scroller')!.scrollTop = 150 * 24
  })
  await expect.poll(anchor).toBe(150)

  await win.getByRole('tab', { name: 'Rows' }).click()
  await expect(win.locator('.card-body .vl-row .pill').first()).toBeVisible() // Rows: kind pills
  expect(await lenses()).toBe(1)
  expect(await win.locator('.card-body .vl-scroller').count()).toBe(1)
  expect(await anchor()).toBe(150)

  await win.getByRole('tab', { name: 'Tree' }).click()
  await expect(win.locator('.card-body .lens-placeholder')).toBeVisible()
  expect(await win.locator('.card-body .vl-scroller').count()).toBe(0)
  expect(await lenses()).toBe(1)

  await win.getByRole('tab', { name: 'Raw' }).click()
  await expect(win.locator('.card-body .vl-row').first()).toContainText('row ')
  expect(await anchor()).toBe(150) // survived the lens that has no rows
  await app.close()
})

```

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e chrome.e2e`
Expected: FAIL after about 30 seconds: `TimeoutError: page.waitForFunction: Timeout 30000ms exceeded` inside `launchChrome`, because `chrome.html` does not exist yet (the page is a 404) and `window.__chrome` is never set.

- [ ] **Step 6: Implement the page**

`electron.vite.config.ts` gains the React plugin and the `chrome` page (a full replacement; every earlier page stays in `pages`):
`spikes/app/electron.vite.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// One renderer entry per page; TYPOSE_PAGE=<key> loads typose://app/<key>.html.
const pages = ['index', 'grid', 'treegrid', 'doc', 'transcript', 'chrome']

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: Object.fromEntries(pages.map((p) => [p, resolve(__dirname, `src/renderer/${p}.html`)]))
      }
    }
  }
})
```

`spikes/app/src/renderer/chrome.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>Typose chrome spike</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/chrome/main.tsx"></script>
  </body>
</html>
```

`spikes/app/src/renderer/src/chrome/lenses.ts`:
```ts
import type { Core } from '../core'
import { LensView } from '../lens-view'
import type { PerfLog } from '../perf'
import type { DocHandle, Progress } from './docs'

export type LensKind = 'raw' | 'rows' | 'tree'

export const LENSES: { id: LensKind; label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'rows', label: 'Rows' },
  { id: 'tree', label: 'Tree' }
]

/** The slice of spec §5.2's `Lens` this spike needs: `anchor()` and `dispose()`. `mount` is `mountLens`. */
export interface MountedLens {
  /**
   * Where the reader is, for the next lens to start from. Here: the first visible line, which Raw and Rows share.
   * ponytail: the real anchor is source-mapped (byte offset + offset inside the element), because a Grid row, a Tree node
   * and a Rendered block are not lines.
   */
  anchor(): number
  dispose(): void
}

/** Every lens currently mounted. Tests read it to prove a switch disposed the old lens. */
export const mounted = new Set<MountedLens>()

/**
 * Mounts a lens controller into `parent` (React gave us an empty div; React never renders lens content, spec §5.1).
 * The lens lives in its own child div, so `dispose` removes everything it created, including its ResizeObserver target.
 */
export function mountLens(kind: LensKind, parent: HTMLElement, handle: DocHandle, core: Core, perf: PerfLog, anchor = 0): MountedLens {
  const host = Object.assign(document.createElement('div'), { className: 'lens-host' })
  parent.append(host)
  let where = (): number => anchor // the placeholder has no rows of its own: it hands the anchor it was given straight on
  let unsubscribe = (): void => {}
  if (kind === 'tree') {
    host.append(Object.assign(document.createElement('p'), { className: 'lens-placeholder', textContent: 'Tree lens: not built in this spike.' }))
  } else {
    const view = new LensView(host, core, handle.doc, kind, perf)
    const sync = (p: Progress): void => view.setRowCount(p.lines, p.done)
    sync(handle.state()) // a lens mounted after indexing finished gets no further events
    if (anchor > 0) view.list.scrollToRow(anchor)
    unsubscribe = handle.subscribe(sync)
    where = () => view.list.firstVisibleRow()
  }
  // ponytail: LensView has no dispose. Removing its host leaves its ResizeObserver and any page request in flight running
  // until they settle on the detached node (not measured). The real Lens.dispose() must cancel both.
  const lens: MountedLens = {
    anchor: () => where(),
    dispose: () => {
      unsubscribe()
      host.remove()
      mounted.delete(lens)
    }
  }
  mounted.add(lens)
  return lens
}
```

`spikes/app/src/renderer/src/chrome/LensBody.tsx`:
```tsx
import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { Core } from '../core'
import type { PerfLog } from '../perf'
import type { DocHandle } from './docs'
import { mountLens, type LensKind } from './lenses'

/** Where the reader was in which document: an anchor means nothing to another document. */
export type Anchor = { doc: number; row: number }

export interface LensBodyProps {
  kind: LensKind
  handle: DocHandle
  core: Core
  perf: PerfLog
  /** Written when this lens unmounts, read when the next one mounts: the lens-switch hand-off (spec §5.2). */
  anchor: RefObject<Anchor>
}

/**
 * The div a lens controller mounts into. React renders only this div; the lens owns everything inside it.
 * A layout effect, so the lens exists in the same commit as its div and its cleanup runs before the div leaves the DOM.
 */
export function LensBody({ kind, handle, core, perf, anchor }: LensBodyProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const saved = anchor.current
    const lens = mountLens(kind, ref.current!, handle, core, perf, saved.doc === handle.doc ? saved.row : 0)
    return () => {
      anchor.current = { doc: handle.doc, row: lens.anchor() }
      lens.dispose()
    }
  }, [kind, handle, core, perf, anchor])
  return <div ref={ref} className="lens-mount" />
}
```

`spikes/app/src/renderer/src/chrome/Card.tsx`:
```tsx
import { useRef, useState, type ReactNode } from 'react'
import { Button, ListBox, ListBoxItem, Popover, Select, SelectValue, Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components'
import type { Core } from '../core'
import type { PerfLog } from '../perf'
import { splitPath, type DocHandle } from './docs'
import { LensBody, type Anchor } from './LensBody'
import { LENSES, type LensKind } from './lenses'

export interface CardProps {
  handle: DocHandle
  core: Core
  perf: PerfLog
  /** The file the link-like control opens in the peek. */
  linkLabel: string
  /** `trigger` is the control that was pressed; the peek returns focus to it. */
  onOpenLink: (trigger: HTMLElement) => void
  /** While an overlay (the peek) is open the card underneath is inert: not focusable, not in the accessibility tree. */
  overlayOpen: boolean
  /** The overlay slot. */
  children?: ReactNode
}

/**
 * Card frame (brief §3.5): a one-row header (breadcrumb, lens switch) and a body a lens controller mounts into.
 * The lens switch is a Tabs tablist; below a 400px card it collapses into a Select (a container query in chrome.css
 * hides one or the other, so both always exist and both drive the same `lens` state).
 */
export function Card({ handle, core, perf, linkLabel, onOpenLink, overlayOpen, children }: CardProps) {
  const [lens, setLens] = useState<LensKind>('raw')
  const anchor = useRef<Anchor>({ doc: 0, row: 0 })
  const { parent, file } = splitPath(handle.path)
  const pick = (key: Key | null): void => {
    if (key !== null) setLens(key as LensKind)
  }
  return (
    <Tabs className="card" selectedKey={lens} onSelectionChange={pick}>
      <div className="card-under" inert={overlayOpen}>
        <header className="card-header">
          <span className="fmt" aria-hidden="true">
            ▤
          </span>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <ol>
              {parent && <li className="crumb">{parent}</li>}
              <li className="crumb file" aria-current="page">
                {file}
              </li>
            </ol>
          </nav>
          <TabList className="lens-tabs" aria-label="Lens">
            {LENSES.map((l) => (
              <Tab key={l.id} id={l.id} className="lens-tab">
                {l.label}
              </Tab>
            ))}
          </TabList>
          <Select className="lens-select" aria-label="Lens" selectedKey={lens} onSelectionChange={pick}>
            <Button className="lens-select-btn">
              <SelectValue />
              <span aria-hidden="true">⌄</span>
            </Button>
            <Popover className="lens-popover">
              <ListBox className="lens-list">
                {LENSES.map((l) => (
                  <ListBoxItem key={l.id} id={l.id} textValue={l.label} className="lens-option">
                    {l.label}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
        </header>
        {/* ponytail: in the real app this link is inside lens content; the lens calls the same onOpenLink with the element that was activated. */}
        <div className="card-links">
          <Button className="link-trigger" aria-haspopup="dialog" onPress={(e) => onOpenLink(e.target as HTMLElement)}>
            {linkLabel}
          </Button>
        </div>
        <TabPanel id={lens} className="card-body">
          <LensBody kind={lens} handle={handle} core={core} perf={perf} anchor={anchor} />
        </TabPanel>
      </div>
      {children}
    </Tabs>
  )
}
```

No peek yet; Task B3b replaces this file.
`spikes/app/src/renderer/src/chrome/App.tsx`:
```tsx
import { useEffect } from 'react'
import type { Core } from '../core'
import type { PerfLog } from '../perf'
import { Card } from './Card'
import { splitPath, type DocHandle } from './docs'

/** `window.__chrome`: set up by main.tsx; `ready` is the harness's readiness hook. */
const hook = (): { ready: boolean } => (window as any).__chrome

export interface AppProps {
  core: Core
  perf: PerfLog
  version: string
  main: DocHandle
  peek: DocHandle
}

export function App({ core, perf, version, main, peek }: AppProps) {
  useEffect(() => {
    hook().ready = true // child layout effects have run: the first lens is mounted
  }, [])

  return (
    <>
      <header className="titlebar">
        <h1>Typose chrome spike</h1>
        <span id="status">core {version}</span>
      </header>
      <main className="canvas">
        {/* Task B3b wires the link to the peek. */}
        <Card handle={main} core={core} perf={perf} linkLabel={splitPath(peek.path).file} onOpenLink={() => undefined} overlayOpen={false} />
      </main>
    </>
  )
}
```

`spikes/app/src/renderer/src/chrome/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import '../style.css'
import './chrome.css'
import { connectCore } from '../core'
import { PerfLog } from '../perf'
import { App } from './App'
import { DocStore } from './docs'
import { mounted } from './lenses'

const perf = new PerfLog()
const hook = { ready: false, perf, lenses: mounted }
;(window as any).__chrome = hook

const core = await connectCore()
const version = await core.call<string>('version')
// ponytail: `?open=<card file>|<peek file>`, because main/index.ts forwards a single TYPOSE_OPEN value and a Windows path
// cannot contain "|". The real app opens files from the workspace store.
const [mainPath, peekPath = mainPath] = (new URLSearchParams(location.search).get('open') ?? '').split('|')
const root = document.getElementById('root')!
if (!mainPath) {
  root.textContent = 'Launch with TYPOSE_PAGE=chrome and TYPOSE_OPEN=<card file>|<peek file>.'
} else {
  const store = new DocStore(core)
  const [main, peek] = await Promise.all([store.open(mainPath), store.open(peekPath)])
  Object.assign(hook, { core, store })
  createRoot(root).render(<App core={core} perf={perf} version={version} main={main} peek={peek} />)
}
```

The card and the lens switch; Task B3b appends the peek.
`spikes/app/src/renderer/src/chrome/chrome.css`:
```css
/* Tokens: brief §6.2. style.css (imported first) holds the dark values the lens styles use; light overrides follow the OS. */
:root {
  --raised: #232326;
  --border: #26262a;
  --hairline: #202024;
  --accent: #8fb0ff;
  --scrim: rgb(17 17 19 / 55%);
  --shadow: 0 16px 40px rgb(0 0 0 / 45%);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --canvas: #f7f7f7;
    --surface: #fff;
    --raised: #f1f1f3;
    --border: #e8e8e8;
    --hairline: #efefef;
    --text: #111;
    --text2: #6e6e73;
    --warn: #a85309;
    --accent: #2b5bd7;
    --scrim: rgb(17 17 19 / 12%);
    --shadow: 0 16px 48px rgb(17 17 19 / 22%);
  }
}

/* Brief §9: the accent ring, 2px outside the element; full-bleed areas use an inset ring so nothing clips it. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.vl-scroller:focus-visible, .card-body:focus-visible { outline-offset: -2px; }

#root { height: 100%; display: flex; flex-direction: column; }
.titlebar { flex: none; height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 16px; -webkit-app-region: drag; }
.titlebar h1 { margin: 0; font: 600 13px/1 system-ui, sans-serif; }
.titlebar #status { color: var(--text2); }
.canvas { flex: 1; min-height: 0; padding: 0 16px 16px; }

/* Card (brief §3.5). container-type lets the header ask how wide the card is, not the window. */
.card { position: relative; display: flex; height: 100%; box-sizing: border-box; container: card / inline-size; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.card-under { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.card-header { flex: none; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--hairline); }
.fmt { flex: none; color: var(--text2); }
.breadcrumb { flex: 1; min-width: 0; }
.breadcrumb ol { display: flex; margin: 0; padding: 0; list-style: none; min-width: 0; }
.crumb { min-width: 0; flex: 0 10 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text2); }
.crumb + .crumb::before { content: "/" / ""; margin: 0 6px; }
.crumb.file { flex-shrink: 1; min-width: 10ch; color: var(--text); }

.lens-tabs { flex: none; display: flex; gap: 2px; }
.lens-tab { padding: 4px 10px; border-radius: 6px; color: var(--text2); cursor: default; }
.lens-tab[data-hovered] { background: var(--raised); }
.lens-tab[data-selected] { background: var(--raised); color: var(--accent); }
.lens-select { display: none; flex: none; }
.lens-select-btn { display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; border: 0; border-radius: 8px; background: var(--raised); color: var(--text); font: inherit; }
@container card (max-width: 399px) {
  .lens-tabs { display: none; }
  .lens-select { display: block; }
}
.lens-popover { min-width: var(--trigger-width); box-sizing: border-box; padding: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); color: var(--text); box-shadow: var(--shadow); }
.lens-list { outline: none; }
.lens-option { padding: 4px 10px; border-radius: 6px; }
.lens-option[data-focused] { background: var(--hairline); }
.lens-option[data-selected] { color: var(--accent); }

.card-links { flex: none; padding: 8px 12px; border-bottom: 1px solid var(--hairline); }
.link-trigger { padding: 4px 0; border: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
.card-body { position: relative; flex: 1; min-height: 0; }
.lens-mount, .lens-host { position: absolute; inset: 0; }
.lens-placeholder { margin: 0; padding: 16px; color: var(--text2); }

```

- [ ] **Step 7: Run everything**

Run (`spikes/app`): `npm run build`
Expected: it succeeds and lists `out/renderer/chrome.html` and a `chrome-*.js` of about 1,014 kB (React Aria; at about 1 MB minified it is a cold-start budget question for the checkpoint, spec §10, not measured here).

Run (`spikes/app`): `npm test`
Expected: `Tests  33 passed (33)`.

Run (`spikes/app`): `npx playwright test --project=e2e chrome.e2e`
Expected: `2 passed`.

Run (`spikes/app`, with `chrome-g7`, `chrome-g8` and `chrome-axe` not yet created): `npm run e2e`
Expected: `25 passed` (the 23 existing tests + 2 new).

- [ ] **Step 8: Look at it**

Run (`spikes/app`, PowerShell): `$env:TYPOSE_PAGE = 'chrome'; $env:TYPOSE_OPEN = (node ..\tools\chrome-fixtures.mjs); npx electron .; Remove-Item Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
Git Bash: `TYPOSE_PAGE=chrome TYPOSE_OPEN="$(node ../tools/chrome-fixtures.mjs)" npx electron .`

Expected: a card (dark when the OS theme is dark, light otherwise) with the breadcrumb `.fixtures / chrome-main.jsonl` (`tools/chrome-fixtures.mjs` run from `spikes/app` writes to `spikes/.fixtures`; the e2e helper's `typose-chrome-fixtures` is a temp dir), the lens switch `Raw | Rows | Tree` with Raw selected in the accent colour, the link `chrome-peek.jsonl`, and the file's lines below. Arrow keys on the lens switch change the lens and keep the first visible line. Clicking the link does nothing yet. Close the window.

- [ ] **Step 9: Read your own work (rule 8), then commit**

```bash
git add spikes/app/package.json spikes/app/package-lock.json spikes/app/electron.vite.config.ts spikes/tools/chrome-fixtures.mjs spikes/app/src/renderer/chrome.html spikes/app/src/renderer/src/chrome spikes/app/e2e/chrome-launch.ts spikes/app/e2e/chrome.e2e.ts
git commit -m "spike(b): React chrome page with the card frame, Tabs lens switch and lens mounting"
```

---

## Task B3b: The peek

**Files:**
- Create: `spikes/app/src/renderer/src/chrome/Peek.tsx`
- Modify: `spikes/app/src/renderer/src/chrome/App.tsx` (full replacement below)
- Modify: `spikes/app/src/renderer/src/chrome/chrome.css` (append the peek block)
- Modify: `spikes/app/e2e/chrome.e2e.ts` (append the peek test and its `peekInAxTree` helper)

**Interfaces:**
- **Consumes:** `Card` (`onOpenLink`, `overlayOpen`, `children`), `LensBody`, `DocHandle` from Task B3a; `FocusScope` from `react-aria/FocusScope` (props `contain`, `restoreFocus`); React Aria `Button`.
- **Produces:**
  - **Peek.tsx:** `PeekProps { doc, core, perf, closing, onClose(), onOpenAsTab() }`; `Peek`.
  - **App.tsx:** the open/close state machine. `PeekState { key, trigger, closing }`; `close()` is the only way a peek closes (Esc, Ctrl+W, ✕, scrim and Open as tab all call it).
  - **`window.__chrome.syncRestore`:** `false` makes `close()` fall back to React Aria's own focus restore. Only the measurement test G7c sets it.
  - **DOM contract:** classes `.peek-layer`, `.peek`, `.scrim`, `.peek-header`, `.btn`, `.btn.icon`; `role="dialog"` with `aria-modal="true"`; `data-closing` on `.peek-layer` while it fades out.

**Design note: the focus decision.** The peek is a modal dialog:
- Brief §4.5 puts the `scrim` over the card underneath, says "focus is inside" while it is open, and makes Esc, ✕ and a scrim click close it. A card you cannot reach with the mouse (the scrim takes the click) must not be reachable by Tab or by a screen reader's virtual cursor either. So everything outside the dialog is `inert` (the card, and the title bar, which holds the page heading), the dialog has `aria-modal`, and a React Aria `FocusScope` with `contain` traps Tab.
- A non-modal `Dialog` was rejected: it would leave the covered card in the tab order and the accessibility tree.
- **Closing is where focus is lost, and the stock behaviour loses it.** `FocusScope restoreFocus` restores in a `requestAnimationFrame` after the peek unmounts, so for one frame focus is on `<body>`. Measured in G7c: 40 body-focus samples and 20 focus leaks in 20 cycles, 2 and 1 per cycle. So `close()` first commits `closing` with `flushSync` (this lifts `inert` from the card and the title bar, releases the trap with `contain={!closing}`, and leaves the peek on screen to fade), then calls `trigger.focus()`, all in one task. Focus moves from inside the peek straight to the trigger. `restoreFocus` stays on as a backstop for any path that unmounts the peek without `close()`.
- **Opening** moves focus into the dialog in a layout effect, before the browser's next frame, so it never rests on `<body>` either. Focus goes to the dialog element itself, not to its first button: a screen reader would then announce the dialog's name and role first (not heard here: the script's peek tasks, Task B4, are parked under spec Z39), and a stray `Space` key-up cannot press **Open as tab** (a precaution; not measured).
- **The scrim** prevents `mousedown`'s default, because a mouse-down on a non-focusable element moves focus to `<body>` before the click that closes the peek.

- [ ] **Step 1: Append the failing peek test**

Append to the end of `spikes/app/e2e/chrome.e2e.ts`:
```ts
/** The peek as the accessibility tree sees it: the dialog's name and modality, and any tab or card text still exposed. */
async function peekInAxTree(win: Page): Promise<{ dialog: { name?: string; modal?: unknown } | null; outside: string[] }> {
  const cdp = await win.context().newCDPSession(win)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
  await cdp.detach()
  const live = nodes.filter((n) => !n.ignored)
  const d = live.find((n) => n.role?.value === 'dialog')
  return {
    dialog: d ? { name: d.name?.value, modal: d.properties?.find((p) => p.name === 'modal')?.value.value } : null,
    outside: live.filter((n) => n.role?.value === 'tab' || /main row|chrome-main/.test(n.name?.value ?? '')).map((n) => `${n.role?.value}:${n.name?.value}`)
  }
}

test('the peek: modal frame, width rule, focus trap, Open as tab, Ctrl+W and reduced motion', async () => {
  const { app, win } = await launchChrome()
  const trigger = win.locator('.link-trigger')
  const dialog = win.locator('[role="dialog"]')

  await trigger.click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(win.locator('.card-under')).toHaveAttribute('inert', '')
  await expect(win.locator('.titlebar')).toHaveAttribute('inert', '')
  // Role, name and modality from Chromium's own tree, not computed from the DOM; the card underneath is out of it.
  expect(await peekInAxTree(win)).toEqual({ dialog: { name: 'chrome-peek.jsonl', modal: true }, outside: [] })
  await expect(dialog.locator('.vl-row').first()).toContainText('peek row 0') // second LensView, other file
  // Measure the resting box: during the 140ms slide-in the peek is still translated 24px to the right.
  await win.waitForFunction(() => getComputedStyle(document.querySelector('.peek')!).opacity === '1')
  const metrics = await win.evaluate(() => {
    const card = document.querySelector('.card')!
    const peek = document.querySelector('.peek')!.getBoundingClientRect()
    // The peek is positioned in the card's padding box, so measure against that, not the border box.
    return { card: card.clientWidth, peek: peek.width, right: card.getBoundingClientRect().right - card.clientLeft - peek.right, vw: innerWidth }
  })
  expect(Math.abs(metrics.peek - Math.min(Math.max(metrics.card * 0.45, 420), metrics.vw - 32, metrics.card))).toBeLessThan(1) // brief §4.5
  expect(metrics.right).toBe(0)
  expect((await activeInfo(win)).inPeek).toBe(true)

  // Tab is trapped in the peek: dialog → Open as tab → ✕ → body → back to Open as tab.
  const seen: string[] = []
  for (let i = 0; i < 4; i++) {
    await win.keyboard.press('Tab')
    seen.push((await activeInfo(win)).name)
  }
  expect(seen).toEqual(['button.btn', 'button.btn icon', 'div.vl-scroller', 'button.btn'])
  await win.keyboard.press('Shift+Tab')
  await win.keyboard.press('Shift+Tab')
  await win.keyboard.press('Shift+Tab')
  expect((await activeInfo(win)).name).toBe('button.btn') // Shift+Tab from the first control wraps within the peek, not out of it
  await win.keyboard.press('Shift+Tab')
  expect((await activeInfo(win)).name).toBe('div.vl-scroller')

  // Open as tab promotes the peek's file into the card, closes the peek, returns focus to the trigger.
  await win.getByRole('button', { name: 'Open as tab' }).click()
  await expect(win.locator('.breadcrumb')).toContainText('chrome-peek.jsonl')
  await expect(win.locator('.peek-layer')).toHaveCount(0)
  expect((await activeInfo(win)).trigger).toBe(true)

  // Ctrl+W closes the peek, never the window.
  await trigger.focus()
  await win.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await win.keyboard.press('Control+w')
  await expect(win.locator('.peek-layer')).toHaveCount(0)
  expect((await activeInfo(win)).trigger).toBe(true)
  expect(win.isClosed()).toBe(false)
  expect(app.windows().length).toBe(1)

  // Reduced motion turns the 140ms slide into an instant swap (brief §6.6).
  const animation = () => win.evaluate(() => getComputedStyle(document.querySelector('.peek')!).animationName)
  await trigger.focus()
  await win.keyboard.press('Enter')
  expect(await animation()).toBe('peek-in')
  await win.keyboard.press('Escape')
  await expect(win.locator('.peek-layer')).toHaveCount(0)
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await trigger.focus()
  await win.keyboard.press('Enter')
  expect(await animation()).toBe('none')
  await win.keyboard.press('Escape')
  await expect(win.locator('.peek-layer')).toHaveCount(0)
  await app.close()
})
```

Run (`spikes/app`): `npx playwright test --project=e2e chrome.e2e -g "the peek"`
Expected: FAIL after about 5 seconds: `Error: expect(locator).toBeVisible() failed`, `Locator: locator('[role="dialog"]')`, `Expected: visible`, `Timeout: 5000ms`, `Error: element(s) not found`, at the line after `await trigger.click()`. The click works but Task B3a's `App` passes a no-op `onOpenLink`, so no peek appears.

- [ ] **Step 2: Implement the peek**

`spikes/app/src/renderer/src/chrome/Peek.tsx`:
```tsx
import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { Button } from 'react-aria-components'
import { FocusScope } from 'react-aria/FocusScope'
import type { Core } from '../core'
import type { PerfLog } from '../perf'
import { splitPath, type DocHandle } from './docs'
import { LensBody, type Anchor } from './LensBody'

export interface PeekProps {
  doc: DocHandle
  core: Core
  perf: PerfLog
  /** True from the moment a close is requested until the exit animation ends and the parent unmounts the peek. */
  closing: boolean
  onClose: () => void
  onOpenAsTab: () => void
}

/**
 * The peek (brief §4.5): a card over the right side of the current card, with a scrim over the card underneath.
 *
 * Focus (spike B decision): a modal dialog.
 * - `role="dialog" aria-modal`, everything outside it is `inert` (the card in Card, the title bar in App), and a React Aria
 *   `FocusScope` contains Tab.
 * - Focus moves into the dialog in the layout effect of the commit that mounts it, so it never rests on <body>.
 * - Closing is `close()` in App.tsx: it releases the scope (`contain={!closing}`) and focuses the trigger synchronously;
 *   `restoreFocus` stays as the backstop, because its own restore waits one animation frame with focus on <body>.
 * - Esc and Ctrl+W (Cmd+W) are handled here on window; ✕ and the scrim call the same `onClose`.
 */
export function Peek({ doc, core, perf, closing, onClose, onOpenAsTab }: PeekProps) {
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const anchor = useRef<Anchor>({ doc: 0, row: 0 })

  useLayoutEffect(() => {
    dialog.current!.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (closing) return
    const onKey = (e: KeyboardEvent): void => {
      // preventDefault claims the key so no menu accelerator also fires for it. Playwright's injected Ctrl+W never reaches
      // accelerators (unhandled, it left the window open), so a hardware Ctrl+W, and Cmd+W on macOS, is a manual check.
      if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w')) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closing, onClose])

  return (
    <div className="peek-layer" data-closing={closing || undefined} inert={closing}>
      {/* mousedown on a non-focusable scrim would move focus to <body> before the click closes the peek */}
      <div className="scrim" aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onClick={onClose} />
      <FocusScope contain={!closing} restoreFocus>
        <div ref={dialog} className="peek" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <header className="peek-header">
            <h2 id={titleId} className="peek-title">
              {splitPath(doc.path).file}
            </h2>
            <Button className="btn" onPress={onOpenAsTab}>
              Open as tab
            </Button>
            <Button className="btn icon" aria-label="Close peek" onPress={onClose}>
              ✕
            </Button>
          </header>
          <div className="peek-body">
            <LensBody kind="raw" handle={doc} core={core} perf={perf} anchor={anchor} />
          </div>
        </div>
      </FocusScope>
    </div>
  )
}
```

Full replacement.
`spikes/app/src/renderer/src/chrome/App.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Core } from '../core'
import type { PerfLog } from '../perf'
import { Card } from './Card'
import { splitPath, type DocHandle } from './docs'
import { Peek } from './Peek'

const EXIT_MS = 140 // brief §6.6: peek out is a 140ms slide + fade

interface PeekState {
  key: number // a new key per open, so a peek opened over a fading one is a fresh instance
  trigger: HTMLElement
  closing: boolean
}

/** `window.__chrome`: set up by main.tsx; `ready` is the harness's readiness hook, `syncRestore` a measurement switch. */
const hook = (): { ready: boolean; syncRestore?: boolean } => (window as any).__chrome

export interface AppProps {
  core: Core
  perf: PerfLog
  version: string
  main: DocHandle
  peek: DocHandle
}

export function App({ core, perf, version, main: mainDoc, peek: peekDoc }: AppProps) {
  const [main, setMain] = useState(mainDoc)
  const [peek, setPeek] = useState<PeekState | null>(null)
  const latest = useRef(peek)
  latest.current = peek
  const timer = useRef(0)

  useEffect(() => {
    hook().ready = true // child layout effects have run: the first lens is mounted
  }, [])

  const open = useCallback((trigger: HTMLElement) => {
    window.clearTimeout(timer.current)
    setPeek((p) => ({ key: (p?.key ?? 0) + 1, trigger, closing: false }))
  }, [])

  const close = useCallback(() => {
    const p = latest.current
    if (!p || p.closing) return
    if (hook().syncRestore === false) {
      // Measurement only (e2e G7c): leave the restore to React Aria's FocusScope.
      setPeek(null)
      return
    }
    // One synchronous commit lifts `inert` from the card and releases the focus trap while the peek is still on screen...
    flushSync(() => setPeek({ ...p, closing: true }))
    // ...so focus goes from inside the peek straight to the trigger, never through <body>.
    p.trigger.focus({ preventScroll: true })
    timer.current = window.setTimeout(() => setPeek(null), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS)
  }, [])

  const openAsTab = useCallback(() => {
    setMain(peekDoc) // ponytail: there are no tabs in this spike; "Open as tab" swaps the card's document
    close()
  }, [peekDoc, close])

  const modal = peek !== null && !peek.closing // while the peek is open nothing outside it is focusable or in the accessibility tree

  return (
    <>
      <header className="titlebar" inert={modal}>
        <h1>Typose chrome spike</h1>
        <span id="status">core {version}</span>
      </header>
      <main className="canvas">
        <Card handle={main} core={core} perf={perf} linkLabel={splitPath(peekDoc.path).file} onOpenLink={open} overlayOpen={modal}>
          {peek && <Peek key={peek.key} doc={peekDoc} core={core} perf={perf} closing={peek.closing} onClose={close} onOpenAsTab={openAsTab} />}
        </Card>
      </main>
    </>
  )
}
```

Append to the end of `spikes/app/src/renderer/src/chrome/chrome.css`:
```css
/* Peek (brief §4.5): over the right side of the card, a scrim over the card underneath, 140ms in and out (§6.6).
   Width max(45% of the card, 420px), never wider than the window minus 32px. The extra 100% keeps it inside this card, whose
   border makes "window minus 32px" 2px too wide; overlapping neighbouring cards needs a peek layer outside the card's clip. */
.peek-layer { position: absolute; inset: 0; z-index: 10; }
.scrim { position: absolute; inset: 0; background: var(--scrim); animation: scrim-in 140ms ease-out; }
.peek { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(max(45%, 420px), calc(100vw - 32px), 100%); display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow); animation: peek-in 140ms ease-out; }
.peek:focus { outline: none; } /* a programmatic focus target, not a control */
.peek-layer[data-closing] .scrim { animation: scrim-out 140ms ease-in forwards; }
.peek-layer[data-closing] .peek { animation: peek-out 140ms ease-in forwards; }
.peek-header { flex: none; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--hairline); }
.peek-title { flex: 1; min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: 600 13px/1.4 system-ui, sans-serif; }
.peek-body { position: relative; flex: 1; min-height: 0; }
.btn { flex: none; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); color: var(--text); font: inherit; cursor: default; }
.btn.icon { padding: 4px 8px; }
@keyframes peek-in { from { opacity: 0; transform: translateX(24px); } }
@keyframes peek-out { to { opacity: 0; transform: translateX(24px); } }
@keyframes scrim-in { from { opacity: 0; } }
@keyframes scrim-out { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after { animation: none !important; }
}
```

- [ ] **Step 3: Run**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e chrome.e2e`
Expected: `3 passed`.

Run (`spikes/app`, with `chrome-g7`, `chrome-g8` and `chrome-axe` not yet created): `npm run e2e`
Expected: `26 passed`.

Run `npm test`.
Expected: `Tests  33 passed (33)`.

- [ ] **Step 4: Look at it**

Launch as in Task B3a Step 8 and click the link. Expected: a card slides in over the right side (45% of the card, at least 420px), the card underneath dims, focus is inside the peek (Tab cycles Open as tab, ✕, the lines, and back), and Esc, ✕, a click on the dimmed area and Ctrl+W each close it and put the focus ring back on the link. **Open as tab** replaces the card's file with the peek's file (the breadcrumb then reads `.fixtures / chrome-peek.jsonl`). Close the window.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/chrome/Peek.tsx spikes/app/src/renderer/src/chrome/App.tsx spikes/app/src/renderer/src/chrome/chrome.css spikes/app/e2e/chrome.e2e.ts
git commit -m "spike(b): peek as a modal dialog with synchronous focus restore"
```

---

## Task B3c: The automated gates: G7 (100 peek cycles), G8 (200% zoom), axe

**Files:**
- Create: `spikes/app/e2e/chrome-g7.e2e.ts`, `spikes/app/e2e/chrome-g8.e2e.ts`, `spikes/app/e2e/chrome-axe.e2e.ts`

**Interfaces:**
- **Consumes:** the helpers in `chrome-launch.ts`, `launchFresh` among them; `launchPage`, `openFixture` and `settle` from `flow-launch.ts` (Task B2b); `TYPOSE_ZOOM` (Task B0) and `TYPOSE_A11Y` (Task B2c); the fixtures `grid-1m-x20.csv` (Task B1a), `10g.jsonl` (plan A Task 2), `doc-20k.jsonl` and `transcript-5k.jsonl` (Task B2a); `@axe-core/playwright`'s `AxeBuilder`; the DOM contract of Tasks B3a and B3b; `window.__chrome.syncRestore`.
- **Produces:** three Playwright specs. Each prints one JSON line (`gate: "G7" | "G7b" | "G7c" | "G8" | "axe"`) that goes into the Spike B report.

**How the gates measure:**
- **G7.** Each cycle opens the peek by `Enter`, `Space` or a real mouse click, and closes it by `Esc`, ✕ by keyboard (alternating `Enter` and `Space`), a scrim click or `Ctrl+W`. The pairing `open = i % 3`, `close = floor(i / 3) % 4` covers all 12 combinations within 12 cycles. After every open the active element must be inside the dialog; after every close, **immediately** (the peek is still fading out) and again after the exit animation, it must be the trigger. A probe in the page counts the moments focus is on `<body>`: every animation frame, every DOM mutation (a microtask after the mutation, before any frame) and every `focusin`, plus every `focusout` with no new target while the document has focus. G7c is the positive control: with the synchronous restore switched off, the same probe must see the loss.
- **G8.** `webContents.setZoomFactor(2)` halves the CSS viewport: 640×400 at the 1280×800 window and 360×240 at 720×480. The test Tabs around the page and the open peek and checks that every tabbable element is reached, and that at each stop the focused element, **including its focus ring**, lies inside the viewport and inside every ancestor that clips (`overflow` other than `visible`). Focus scrolls clipped content into view even in `overflow: hidden` boxes, so "in the viewport after `focus()`" is not enough: the check also fails if any ancestor had to scroll to show the element (`scrollLeft` ≠ 0, or `scrollTop` ≠ 0 in a box without a scrollbar), and if the page overflows horizontally. The lens switch is checked with arrow keys, or, at 360px, by opening the dropdown and checking its options.
- **G8 on the other pages.** Four more tests open the Grid (`grid-1m-x20.csv`), Rows (`10g.jsonl`), Rendered and Transcript pages with `TYPOSE_ZOOM=2` in a fresh profile (`launchFresh`), as Task B4's S20 does, and Tab through each at a person's pace (a frame and the window's `settled()` between presses) until focus is back on the first stop, or 12 stops on the Transcript, whose every article is a stop. The same checks apply.
- **Taller than the box.** An element taller than a clipping box (a Transcript turn at 200%) must cover the box, and one taller than the viewport must overlap it: Chromium's focus scroll centers such an element. Sideways there is no allowance.
- **Zoom stands in for `--px`.** Brief §6.5 scales a `--px` token while the window keeps its size; Chromium page zoom halves the CSS viewport instead. For flow layout the two are equivalent, and the chrome here uses plain px, so zoom is the faithful test.
- **axe.** Six scans: dark, light, and 200%-compact, each with and without the peek open. The scan runs in axe's legacy mode, because the default run opens a second page for its final merge step and Electron's browser context refuses that. A control test injects an unnamed button and requires the scan to flag it, so that a clean report means something. A third test scans the Rendered and Transcript pages in accessibility mode, window recentered mid-file (so both edge controls are present), and requires zero violations of any impact. On the document it exempts `heading-order` inside `main#doc` only: heading levels in rendered Markdown are the document author's, not Typose's, and Task B2a's fixture skips levels on purpose (it follows some h1s with an h3). Every other rule, and `heading-order` anywhere else, must report nothing on either page.
  - **`heading-order` blocks on the app's own headings** (packet Part 4). `audit()` counts it as blocking beside serious and critical. So the first test fails on an out-of-order heading on the chrome page or in the peek, and the third on one on the Transcript or anywhere on the Rendered page outside `main#doc`.
  - On the Rendered page every heading is inside `main#doc`. Its own controls (the status strip, the `Outline` button and links, the edge controls) carry none.
  - A probe in round 3's replay found `heading-order` passing on the chrome page's `h1`, the open peek's `h2` and the Transcript's 500 mounted turn headings. On the Rendered page, all 35 of its violations are the fixture's own skipped levels inside `main#doc`.
  - Shown red first: an `h4` added after the chrome page's `h1`, and an `h1` and `h3` added to the Rendered page's status strip. The old test passed both; this one fails each.

- [ ] **Step 1: G7**

`spikes/app/e2e/chrome-g7.e2e.ts`:
```ts
import { expect, test, type Page } from '@playwright/test'
import { activeInfo, focusEl, launchChrome, mouseClick, readFocusProbe, startFocusProbe } from './chrome-launch'

const CYCLES = 100
const OPEN = ['enter', 'space', 'click'] as const
const CLOSE = ['esc', 'x', 'scrim', 'ctrl+w'] as const
type OpenMethod = (typeof OPEN)[number]
type CloseMethod = (typeof CLOSE)[number]

async function open(win: Page, how: OpenMethod): Promise<void> {
  if (how === 'click') {
    await focusEl(win, '.card-body .vl-scroller') // focus starts elsewhere; the click must make the trigger the opener
    await mouseClick(win, '.link-trigger')
  } else {
    await focusEl(win, '.link-trigger')
    await win.keyboard.press(how === 'enter' ? 'Enter' : 'Space')
  }
}

async function close(win: Page, how: CloseMethod, i: number): Promise<void> {
  if (how === 'esc') await win.keyboard.press('Escape')
  else if (how === 'ctrl+w') await win.keyboard.press('Control+w')
  else if (how === 'scrim') await mouseClick(win, '.scrim', { x: 24, y: 200 })
  else {
    // ✕ by keyboard: the dialog has focus, so Tab, Tab reaches ✕ (after Open as tab); Enter or Space alternates.
    await win.keyboard.press('Tab')
    await win.keyboard.press('Tab')
    expect((await activeInfo(win)).name).toBe('button.btn icon')
    await win.keyboard.press(i % 2 ? 'Enter' : 'Space')
  }
}

test('G7: 100 peek open/close cycles with zero focus loss', async () => {
  const { app, win } = await launchChrome()
  await focusEl(win, '.link-trigger')
  await startFocusProbe(win)
  const opened: Record<string, number> = {}
  const closed: Record<string, number> = {}
  const pairs = new Set<string>()

  for (let i = 0; i < CYCLES; i++) {
    const o = OPEN[i % OPEN.length]
    const c = CLOSE[Math.floor(i / OPEN.length) % CLOSE.length] // i = 0..11 covers every open × close pair
    await open(win, o)
    const afterOpen = await activeInfo(win)
    expect(afterOpen.inPeek, `cycle ${i} (${o}/${c}): focus after open was ${afterOpen.name}`).toBe(true)
    expect(afterOpen.body).toBe(false)

    await close(win, c, i)
    const afterClose = await activeInfo(win) // immediately: the peek is still fading out, focus must already be back
    expect(afterClose.trigger, `cycle ${i} (${o}/${c}): focus after close was ${afterClose.name}`).toBe(true)
    await win.waitForFunction(() => !document.querySelector('.peek-layer'))
    expect((await activeInfo(win)).trigger, `cycle ${i}: focus after the exit animation`).toBe(true)

    opened[o] = (opened[o] ?? 0) + 1
    closed[c] = (closed[c] ?? 0) + 1
    pairs.add(`${o}/${c}`)
  }

  const probe = await readFocusProbe(win)
  console.log(JSON.stringify({ gate: 'G7', cycles: CYCLES, opened, closed, pairs: pairs.size, probe }))
  expect(pairs.size).toBe(OPEN.length * CLOSE.length)
  expect(probe.bodySamples, `focus was on <body> at: ${probe.log.join(', ')}`).toBe(0)
  expect(probe.leaks).toBe(0)
  await app.close()
})

test('G7b: reopening during the exit animation never loses focus either', async () => {
  const { app, win } = await launchChrome()
  await focusEl(win, '.link-trigger')
  await startFocusProbe(win)
  for (let i = 0; i < 20; i++) {
    await win.keyboard.press('Enter')
    expect((await activeInfo(win)).inPeek).toBe(true)
    await win.keyboard.press('Escape')
    expect((await activeInfo(win)).trigger).toBe(true)
    // no wait: the old peek is still in the DOM, fading; the next Enter opens a fresh one over it
  }
  await win.keyboard.press('Enter')
  await win.keyboard.press('Escape')
  await win.waitForFunction(() => !document.querySelector('.peek-layer'))
  expect((await activeInfo(win)).trigger).toBe(true)
  const probe = await readFocusProbe(win)
  console.log(JSON.stringify({ gate: 'G7b', cycles: 21, probe }))
  expect(probe.bodySamples, `focus was on <body> at: ${probe.log.join(', ')}`).toBe(0)
  await app.close()
})

test('G7c (measurement): restoring focus through React Aria alone, without the synchronous restore', async () => {
  const { app, win } = await launchChrome()
  await win.evaluate(() => ((window as any).__chrome.syncRestore = false))
  await focusEl(win, '.link-trigger')
  await startFocusProbe(win)
  for (let i = 0; i < 20; i++) {
    await win.keyboard.press('Enter')
    expect((await activeInfo(win)).inPeek).toBe(true)
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => !document.querySelector('.peek-layer') && document.activeElement?.classList.contains('link-trigger'))
  }
  const probe = await readFocusProbe(win)
  console.log(JSON.stringify({ gate: 'G7c', cycles: 20, probe }))
  await app.close()
})
```

Run (`spikes/app`): `npx playwright test --project=e2e chrome-g7`
Expected: `3 passed` (G7 takes about 19 seconds on an idle machine and 0.9 to 1.5 minutes when other work shares it) and three JSON lines:
- `G7`: `"cycles":100`, `"opened":{"enter":34,"space":33,"click":33}`, `"closed":{"esc":27,"x":25,"scrim":24,"ctrl+w":24}`, `"pairs":12`, and in `probe`: `"bodySamples":0`, `"leaks":0` (`samples` varies with frame timing: 3,400 to 10,700 across runs);
- `G7b` (reopen during the exit animation, 21 cycles): `"bodySamples":0`;
- `G7c` (stock React Aria restore, 20 cycles): `bodySamples` and `leaks` above zero (observed 40 and 20).

**Check that the gate can fail.** In `Peek.tsx`, delete ` onMouseDown={(e) => e.preventDefault()}` from the scrim `div`, rebuild, and run `npx playwright test --project=e2e chrome-g7 -g "G7: 100"`.
Expected: FAIL: `focus was on <body> at: mutation @...` with `Expected: 0` and `Received: 24`, the 24 scrim-click cycles (and `leaks` 24). `Received` can be a little higher, when a frame samples a scrim-click cycle's loss a second time: the round-3 follow-up's replay printed 25 once, with `leaks` still 24. Restore the line and rebuild.

- [ ] **Step 2: G8**

`spikes/app/e2e/chrome-g8.e2e.ts`:
```ts
import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { launchChrome, launchFresh, setViewport } from './chrome-launch'

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]'

interface Reached {
  name: string
  problems: string[]
}

/**
 * Focuses nothing itself: reads the focused element and reports why a user could not see or reach it.
 * Focus scrolls clipped content into view even in `overflow: hidden` boxes, so "inside the viewport after focus()" is not
 * enough: this also rejects elements clipped by an ancestor, and any ancestor that had to scroll to show the element.
 */
function inspectFocused(): Reached {
  const el = document.activeElement
  if (!el || el === document.body) return { name: 'body', problems: ['focus is on <body>'] }
  const desc = (e: Element): string => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).trim().replace(/\s+/g, '.')}`
  const problems: string[] = []
  const tol = 0.5
  const cs = getComputedStyle(el)
  // The focus ring must be visible too. It spans offset .. offset + width outside the border box, so it grows the box by
  // offset + width: 4px for the standard 2px ring at +2px, 0 for the full-bleed inset ring (offset -2px).
  const ring = cs.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth))
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) problems.push('zero-sized')
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  // An element taller than a box (a long Transcript turn at 200%) can't fit in it. A clipping box it must cover instead, as
  // visible as it can be (Chromium's focus scroll centers it); the viewport it must overlap. Sideways there is no such
  // allowance: the page must never need to scroll sideways.
  const outY = (top: number, bottom: number, min: number, max: number, cover: boolean): boolean =>
    bottom - top <= max - min ? top < min - tol || bottom > max + tol : cover ? top > min + tol || bottom < max - tol : bottom < min + tol || top > max - tol
  if (r.left < -tol || r.right > vw + tol || outY(r.top, r.bottom, 0, vh, false)) problems.push(`outside the viewport ${vw}x${vh}: ${JSON.stringify(r)}`)
  if (r.left - ring < -tol || r.right + ring > vw + tol || outY(r.top - ring, r.bottom + ring, 0, vh, false)) problems.push(`focus ring leaves the viewport (ring ${ring}px)`)
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const acs = getComputedStyle(a)
    const clipX = acs.overflowX !== 'visible'
    const clipY = acs.overflowY !== 'visible'
    if (!clipX && !clipY) continue
    const b = a.getBoundingClientRect()
    const box = { left: b.left + a.clientLeft, top: b.top + a.clientTop, right: b.left + a.clientLeft + a.clientWidth, bottom: b.top + a.clientTop + a.clientHeight }
    if (clipX && (r.left - ring < box.left - tol || r.right + ring > box.right + tol)) problems.push(`clipped horizontally by ${desc(a)}`)
    if (clipY && outY(r.top - ring, r.bottom + ring, box.top, box.bottom, true)) problems.push(`clipped vertically by ${desc(a)}`)
    if (a.scrollLeft !== 0) problems.push(`${desc(a)} had to scroll horizontally`)
    if (acs.overflowY === 'hidden' && a.scrollTop !== 0) problems.push(`${desc(a)} had to scroll in a box with no scrollbar`)
  }
  return { name: `${desc(el)}${el.getAttribute('aria-label') ? ` "${el.getAttribute('aria-label')}"` : ''}${el.textContent && el.children.length === 0 ? ` "${el.textContent.trim().slice(0, 24)}"` : ''}`, problems }
}

/** Presses Tab until focus comes back to the first element it reached; returns every stop with its problems. */
async function tabAround(win: Page, limit = 24): Promise<Reached[]> {
  await win.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    window.scrollTo(0, 0)
  })
  const stops: Reached[] = []
  for (let i = 0; i < limit; i++) {
    await win.keyboard.press('Tab')
    const stop = await win.evaluate(inspectFocused)
    if (stops.length && stop.name === stops[0].name) return stops
    stops.push(stop)
  }
  throw new Error(`Tab did not cycle within ${limit} presses: ${stops.map((s) => s.name).join(' > ')}`)
}

/** The tabbable elements the page should offer in a root, as `desc` names. Runs in the page. */
function expectedTabbables([root, selector]: [string, string]): string[] {
  const scope = document.querySelector(root)!
  const desc = (e: Element): string => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).trim().replace(/\s+/g, '.')}`
  return [...scope.querySelectorAll<HTMLElement>(selector)]
    .filter((e) => e.tabIndex >= 0 && !e.closest('[inert]') && !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden')
    .map(desc)
}

const sizes = [
  { width: 1280, height: 800, label: 'default window' },
  { width: 720, height: 480, label: 'minimum window' }
]

for (const { width, height, label } of sizes) {
  test(`G8: nothing is unreachable at 200% zoom (${label} ${width}x${height})`, async () => {
    const { app, win } = await launchChrome()
    await setViewport(app, win, width, height, 2)
    const css = await win.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, zoomedWidth: document.querySelector('.card')!.getBoundingClientRect().width }))
    const compact = css.zoomedWidth < 400 // brief §3.5: below 400px the lens switch is a dropdown

    // 1. The chrome page.
    const expected = await win.evaluate(expectedTabbables, ['body', FOCUSABLE])
    const stops = await tabAround(win)
    const visited = stops.map((s) => s.name)
    for (const e of expected) expect(visited.some((v) => v.startsWith(e)), `${e} was never reached by Tab (reached: ${visited.join(' > ')})`).toBe(true)
    for (const s of stops) expect(s.problems, `${s.name} at ${css.w}x${css.h} CSS px`).toEqual([])
    const overflow = await win.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth, sx: scrollX }))
    expect(overflow.sw).toBeLessThanOrEqual(overflow.cw) // no horizontal scrolling anywhere on the page
    expect(overflow.sx).toBe(0)

    // 2. The lens switch: arrow-key reachable tabs, or the dropdown's options when it has collapsed.
    const lensStops: Reached[] = []
    if (compact) {
      await win.locator('.lens-select-btn').focus()
      await win.keyboard.press('Enter')
      await expect(win.getByRole('listbox')).toBeVisible()
      const options = await win.evaluate(() =>
        [...document.querySelectorAll('[role="option"]')].map((o) => {
          const r = o.getBoundingClientRect()
          return { name: o.textContent, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
        })
      )
      expect(options).toEqual([
        { name: 'Raw', inside: true },
        { name: 'Rows', inside: true },
        { name: 'Tree', inside: true }
      ])
      await win.keyboard.press('Escape')
      await expect(win.getByRole('listbox')).toHaveCount(0)
      // React Aria hands focus back to the button a frame after the popover unmounts (the same gap G7c measures for the peek).
      await expect.poll(() => win.evaluate(() => document.activeElement?.classList.contains('lens-select-btn'))).toBe(true)
      lensStops.push(await win.evaluate(inspectFocused))
    } else {
      await win.getByRole('tab', { name: 'Raw' }).focus()
      lensStops.push(await win.evaluate(inspectFocused))
      for (let i = 0; i < 2; i++) {
        await win.keyboard.press('ArrowRight')
        lensStops.push(await win.evaluate(inspectFocused))
      }
      expect(lensStops.map((s) => s.name)).toHaveLength(3)
      await win.keyboard.press('Home')
    }
    for (const s of lensStops) expect(s.problems, `${s.name} (lens switch)`).toEqual([])

    // 3. The open peek: everything in it reachable, and Tab stays inside it.
    await win.locator('.link-trigger').focus()
    await win.keyboard.press('Enter')
    await expect(win.locator('[role="dialog"]')).toBeVisible()
    await win.waitForFunction(() => getComputedStyle(document.querySelector('.peek')!).opacity === '1') // after the 140ms slide-in
    const peekExpected = await win.evaluate(expectedTabbables, ['[role="dialog"]', FOCUSABLE])
    expect(peekExpected).toHaveLength(3) // Open as tab, ✕, the lens scroller
    const peekStops: Reached[] = []
    for (let i = 0; i < peekExpected.length + 1; i++) {
      await win.keyboard.press('Tab')
      peekStops.push(await win.evaluate(inspectFocused))
      expect(await win.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), `Tab ${i + 1} left the peek`).toBe(true)
    }
    for (const e of peekExpected) expect(peekStops.some((s) => s.name.startsWith(e)), `${e} was never reached inside the peek`).toBe(true)
    for (const s of peekStops) expect(s.problems, `${s.name} (peek) at ${css.w}x${css.h} CSS px`).toEqual([])
    const peekBox = await win.evaluate(() => {
      const p = document.querySelector('.peek')!.getBoundingClientRect()
      return { left: p.left, right: p.right, top: p.top, bottom: p.bottom, vw: innerWidth, vh: innerHeight }
    })
    expect(peekBox.left).toBeGreaterThanOrEqual(0)
    expect(peekBox.right).toBeLessThanOrEqual(peekBox.vw)
    expect(peekBox.bottom).toBeLessThanOrEqual(peekBox.vh)
    const afterPeek = await win.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }))
    expect(afterPeek.sw).toBeLessThanOrEqual(afterPeek.cw)

    console.log(
      JSON.stringify({
        gate: 'G8',
        window: `${width}x${height}`,
        cssViewport: `${css.w}x${css.h}`,
        compactLensSwitch: compact,
        pageTabStops: visited,
        lensSwitchStops: lensStops.map((s) => s.name),
        peekTabStops: peekStops.map((s) => s.name),
        peekBox
      })
    )
    await app.close()
  })
}

const FIX = resolve(__dirname, '../../.fixtures')
const PAGES = [
  { page: 'grid', file: 'grid-1m-x20.csv' },
  { page: 'treegrid', file: '10g.jsonl' },
  { page: 'doc', file: 'doc-20k.jsonl' },
  { page: 'transcript', file: 'transcript-5k.jsonl' }
]

// The Grid, Rows, Rendered and Transcript pages, opened as Task B4's S20 opens them: TYPOSE_ZOOM=2 in a fresh profile.
for (const { page, file } of PAGES) {
  test(`G8: nothing is unreachable at 200% zoom on the ${page} page (TYPOSE_ZOOM=2, default window)`, async () => {
    const { app, win } = await launchFresh({ TYPOSE_PAGE: page, TYPOSE_OPEN: resolve(FIX, file), TYPOSE_ZOOM: '2' })
    // The status strip's final text: "N lines", "N blocks · M headings" or "N turns", not "core …" or "indexing…".
    await expect(win.locator('#status')).toHaveText(/^\d+ (lines|blocks|turns)/, { timeout: 120_000 })
    const css = await win.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))
    expect(css.dpr).toBe(2) // the knob applied: 640x400 CSS px at the 1280x800 window
    const expected = await win.evaluate(expectedTabbables, ['body', FOCUSABLE])
    // Tab until focus is back on the first stop (the same element: every article has the same name); every Transcript
    // article is a stop, so that one stops at 12.
    const stops: Reached[] = []
    for (let i = 0; i < 12; i++) {
      await win.keyboard.press('Tab')
      // At a person's pace: the Rendered and Transcript windows follow focus after a fetch, and Tab must find the next item.
      await win.evaluate(async () => {
        await new Promise(requestAnimationFrame)
        await (window as any).__spike?.view?.settled?.()
      })
      const back = await win.evaluate((i) => {
        const w = window as any
        if (i === 0) w.__firstStop = document.activeElement
        return i > 0 && document.activeElement === w.__firstStop
      }, i)
      if (back) break
      stops.push(await win.evaluate(inspectFocused))
    }
    const visited = stops.map((s) => s.name)
    if (stops.length < 12) for (const e of expected) expect(visited.some((v) => v.startsWith(e)), `${e} was never reached by Tab (reached: ${visited.join(' > ')})`).toBe(true)
    for (const s of stops) expect(s.problems, `${s.name} at ${css.w}x${css.h} CSS px`).toEqual([])
    const overflow = await win.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth, sx: scrollX }))
    expect(overflow.sw).toBeLessThanOrEqual(overflow.cw) // no horizontal scrolling anywhere on the page
    expect(overflow.sx).toBe(0)
    console.log(JSON.stringify({ gate: 'G8', page, cssViewport: `${css.w}x${css.h}`, pageTabStops: visited }))
    await app.close()
  })
}
```

Run (`spikes/app`): `npx playwright test --project=e2e chrome-g8`
Expected: `6 passed`, with these `G8` lines:
- 1280×800: `"cssViewport":"640x400"`, `"compactLensSwitch":false`, page stops `lens-tab "Raw"`, `link-trigger`, `vl-scroller`; peek stops `Open as tab`, `Close peek`, `vl-scroller`, back to `Open as tab`;
- 720×480: `"cssViewport":"360x240"`, `"compactLensSwitch":true`, page stops `lens-select-btn`, `link-trigger`, `vl-scroller`; the same peek stops; `peekBox` inside 360×240;
- the pages, at 1280×800: `{"gate":"G8","page":"grid","cssViewport":"640x400","pageTabStops":["div.gv-num \"#\""]}`, then `treegrid` `["div.gv-row.tg-row"]`, `doc` `["main.fw-scroller.doc","button. \"Outline\"","a.h1 \"Section 1 (block 0)\""]` and `transcript` 12 × `"article."`.

**Check that the gate can fail.** In `chrome.css`, delete `, 100%` from the `.peek` width (leaving `min(max(45%, 420px), calc(100vw - 32px))`), rebuild, and run the minimum-window test.
Expected: FAIL at 720×480 with `div.vl-scroller (peek) at 360x240 CSS px` and `clipped horizontally by div.card`: "window minus 32px" is 2px wider than the card's padding box. Restore `, 100%`, rebuild, and rerun `chrome-g8` to `6 passed`.

- [ ] **Step 3: axe**

`spikes/app/e2e/chrome-axe.e2e.ts`:
```ts
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { launchChrome, setViewport } from './chrome-launch'
import { launchPage, openFixture, settle } from './flow-launch'

/**
 * Runs axe-core on the page; returns every violation as `impact id (nodes)` and the blocking subset: serious or
 * critical, and `heading-order` on the app's own headings. Inside `authored`, the document author's content, heading
 * levels are the author's, not Typose's, so `heading-order` nodes there are left out.
 */
async function audit(win: Page, authored?: string): Promise<{ all: string[]; blocking: string[]; passes: number }> {
  // Legacy mode: the default run opens a second page for axe's final merge step, which Electron's browser context refuses.
  const results = await new AxeBuilder({ page: win }).setLegacyMode().analyze()
  for (const v of results.violations.filter((v) => authored && v.id === 'heading-order')) {
    const targets = v.nodes.map((n) => n.target.join(' '))
    const inside = await win.evaluate(([ts, a]) => ts.map((t) => !!document.querySelector(t)?.closest(a)), [targets, authored!] as const)
    v.nodes = v.nodes.filter((_, i) => !inside[i])
  }
  const violations = results.violations.filter((v) => v.nodes.length)
  const all = violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'heading-order').map((v) => v.id)
  return { all, blocking, passes: results.passes.length }
}

test('axe: no serious or critical violations and no heading out of order on the chrome page or with the peek open (dark, light, 200% compact)', async () => {
  const { app, win } = await launchChrome()
  const report: Record<string, { violations: string[]; passes: number }> = {}
  const blocking: string[] = []
  const run = async (name: string): Promise<void> => {
    await expect(win.locator('.card-body .vl-row').first()).toBeVisible() // audit painted content, not an empty body
    const r = await audit(win)
    report[name] = { violations: r.all, passes: r.passes }
    blocking.push(...r.blocking.map((id) => `${name}: ${id}`))
  }
  const withPeek = async (name: string): Promise<void> => {
    await win.locator('.link-trigger').focus()
    await win.keyboard.press('Enter')
    await win.waitForFunction(() => getComputedStyle(document.querySelector('.peek')!).opacity === '1') // axe must see final colors, not mid-fade
    await expect(win.locator('.peek .vl-row').first()).toBeVisible()
    await run(name)
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => !document.querySelector('.peek-layer'))
  }

  for (const scheme of ['dark', 'light'] as const) {
    await win.emulateMedia({ colorScheme: scheme })
    await run(`${scheme} chrome`)
    await withPeek(`${scheme} peek open`)
  }
  await win.emulateMedia({ colorScheme: 'dark' })
  await setViewport(app, win, 720, 480, 2) // lens switch collapsed to the dropdown
  await run('dark 720x480 @200% chrome')
  await withPeek('dark 720x480 @200% peek open')

  console.log(JSON.stringify({ gate: 'axe', report }, null, 1))
  expect(blocking, JSON.stringify(report, null, 1)).toEqual([])
  await app.close()
})

test('axe control: the audit does flag an unnamed button, so a clean report above means something', async () => {
  const { app, win } = await launchChrome()
  await win.evaluate(() => document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button></button>'))
  expect((await audit(win)).blocking).toContain('button-name')
  await app.close()
})

test('axe: the Rendered and Transcript pages in accessibility mode, window recentered mid-file, no violations of any impact', async () => {
  const report: Record<string, string[]> = {}
  for (const [page, file, mid] of [
    ['doc', 'doc-20k.jsonl', 10_000],
    ['transcript', 'transcript-5k.jsonl', 2_500]
  ] as const) {
    const { app, win } = await launchPage(page, { TYPOSE_A11Y: '1' })
    await win.waitForFunction(() => (window as any).__spike.a11y === true, null, { timeout: 10_000 })
    await openFixture(win, file)
    await win.evaluate((i) => (window as any).__spike.view.goTo(i), mid) // mid-file: both edge controls are present
    await settle(win)
    // Heading levels inside main#doc are the document author's: the fixture follows some h1s with an h3 (Task B2a), as
    // real files may. Everywhere else heading-order is judged.
    report[page] = (await audit(win, page === 'doc' ? '#doc' : undefined)).all
    await app.close()
  }
  console.log(JSON.stringify({ gate: 'axe', report }))
  expect(report).toEqual({ doc: [], transcript: [] })
})
```

Run (`spikes/app`): `npx playwright test --project=e2e chrome-axe`
Expected: `3 passed`. The printed report has `"violations": []` for all six scans (`passes` 31 to 36 each), and the third test prints `{"gate":"axe","report":{"doc":[],"transcript":[]}}`.

- [ ] **Step 4: The whole suite**

Run (`spikes/app`): `npm test`, `npm run build`, `npm run e2e`
Expected: `Tests  33 passed (33)`; the build succeeds; `38 passed` (23 from plan A and Tasks B0–B2d + 3 in `chrome.e2e.ts` + 3 G7 + 6 G8 + 3 axe).

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `test result: ok. 16 passed; 0 failed; 0 ignored` (plan A's 16, unchanged by this plan).

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/e2e/chrome-g7.e2e.ts spikes/app/e2e/chrome-g8.e2e.ts spikes/app/e2e/chrome-axe.e2e.ts
git commit -m "spike(b): gates G7 (100 peek cycles), G8 (200% zoom) and axe for the chrome"
```

---

## Task B4: The 20-task screen-reader script (parked, spec Z39)

**Parked (spec Z39).** Screen-reader validation is parked until after launch, as an expansion opportunity; Z39 supersedes Z35. Phase 0 doesn't run this task: the executor skips Steps 1 to 7, and no gate, coverage claim or Validated line of this plan rests on it. The script and the results template below are kept as the expansion's starting point (spec §6.3), with the round-2 review's open findings against them (Checkpoint items, Parked). Until the expansion runs them, this plan claims what the automated gates show (Tasks B1b to B3c), not screen-reader support.

Each part of this plan was built with its own screen-reader tasks: 8 for the Grid and Rows, 10 for Rendered and the Transcript, 4 for the chrome. They are merged into the 20 below (spec §6.3 fixes the script at 20). The script's "Lane task" column (B1 G1–G8, B2 D1–D10, B3 C1–C4) names where each one came from.

**Files:**
- Create: `spikes/results/sr-script.md` (the script)
- Create: `spikes/results/sr-results.md` (the results: one row per task × reader)
- Create: `spikes/results/sr-nvda-<task>.txt` (NVDA speech logs for S11, S12, S13 and S15)

**Interfaces:**
- **Consumes:**
  - the pages `grid`, `treegrid` (Tasks B1b, B1c), `doc`, `transcript` (Tasks B2b, B2d) and `chrome` (Tasks B3a, B3b), all listed in `pages` in `spikes/app/electron.vite.config.ts` (`['index', 'grid', 'treegrid', 'doc', 'transcript', 'chrome']`) and built by `npm run build`;
  - main's `TYPOSE_PAGE` (Task B0), `TYPOSE_OPEN` (plan A Task 8) and `TYPOSE_A11Y` (Task B2c), and `TYPOSE_ZOOM` (`webPreferences.zoomFactor`: `TYPOSE_ZOOM` when it is a number in (0, 5], else 1; Task B0);
  - the fixtures `grid-1m-x20.csv` and `grid-1k-x5000.csv` (Task B1a), `doc-20k.jsonl` and `transcript-5k.jsonl` (Task B2a), `10g.jsonl` (plan A Task 2), and `spikes/tools/chrome-fixtures.mjs` (Task B3a).
- **Produces:** the two files above, when the expansion runs this task. The script's gate, parked with it (spec Z39), is the Spike B line "100% completion of the 20-task script" (spec §13.1): all 20 tasks pass on NVDA and Narrator (PC) and on VoiceOver (Mac).

**Open decision this script depends on (the Grid, Task B1b; not decided here):** screen-reader scroll-into-view in logical scrolling, P4 in the script; it touches S05. Decided since:
- the row-number column is ARIA column 1 and shows the record number, 1 for the first data record (spec Z31, Z32), which S01–S05 expect;
- Space doesn't page the Grid (spec Z40, the script's P3), so S05 scrolls with the wheel.

**Test depth: parked (spec Z35, superseded by Z39).** Z35 had Phase 0 run the full reading test, 2,000 blocks forward and backward (S11, S12), on NVDA, Narrator and VoiceOver, and routine milestones a shorter one. Z39 parks both until after launch, and the expansion sets the depth again. The round-2 review's findings on it are parked with it: on Narrator and VoiceOver the full test has no instrument that can fail it, and the milestone depth is named, not defined (Checkpoint items, Parked).

- [ ] **Step 1: Create the script**

`spikes/results/sr-script.md`:
````markdown
# Spike B screen-reader script: 20 tasks (S01–S20)

**Parked (spec Z39).** Screen-reader validation is parked until after launch. This script is kept for that expansion: it has not been run on any reader, and Phase 0 claims nothing from it.

The fixed 20-task script of spec §6.3 and §13.1 (Spike B). Run it on **NVDA** (IA2) and **Narrator** (UIA) on the PC, and on **VoiceOver** in the Mac batch. Gate: 100% completion, which means all 20 tasks pass on every reader.

A task passes only if every "Pass when" line holds and no "Fail when" line happens. Wording differs per reader ("tab" or "tab control", "1 of 3" or "tab 1 of 3", "1,000,001" or "1000001"): the **content** in "Must hear" is what is judged, in any phrasing. Nothing here has been heard on a real screen reader yet; the first run on each reader fills in the wording. Record every run in `spikes/results/sr-results.md` (template at the end).

Surfaces and tasks:

| Tasks | Surface | Page (`TYPOSE_PAGE`) | File |
|---|---|---|---|
| S01–S05 | Grid | `grid` | `grid-1m-x20.csv`, `grid-1k-x5000.csv` |
| S06–S08 | Rows (treegrid) | `treegrid` | `10g.jsonl` |
| S09–S13 | Rendered | `doc` | `doc-20k.jsonl` |
| S14–S16 | Transcript | `transcript` | `transcript-5k.jsonl` |
| S17–S20 | Chrome: tabs and peek | `chrome` | `chrome-main.jsonl`, `chrome-peek.jsonl` |

## Coverage: task to gate, and where each task came from

Gates are the Spike B items of spec §13.1 that a person with a screen reader can observe. "Lane task" names the task in the lane that produced it (B1: G1–G8, B2: D1–D10, B3: C1–C4).

| Gate | Evidenced by |
|---|---|
| **POS**: row and column position announced, with totals | S01, S02, S04, S06, S07 |
| **END**: Ctrl+End reaches the true last row | S03 (Grid), S08 (Rows) |
| **READ**: blocks or turns read forward and backward across window recenters, no position lost | S11 (forward, 2,000 blocks), S12 (backward, 2,000 blocks), S15 (forward, 760 turns) |
| **HEAD-O**: heading jump through the Outline lands outside the mounted window | S09 |
| **HEAD-K**: heading jump through the reader's heading key lands outside the mounted window | S10 (Rendered, 2,520 blocks away, both ways), S15 (Transcript) |
| **PEEK**: peek focus | S18, S19 (5 cycles heard; the 100-cycle count is the automated gate) |
| **ZOOM**: nothing unreachable at 200% zoom | S20 |
| **FEED**: the Transcript feed | S14, S15, S16 |
| 100% completion of the 20-task script | all 20 |

Not observable by a person, so not in this script: zero skipped or duplicated positions across 1,000 rows × 100 columns (automated G4; S02 is a spot check of 5 moves), 100 peek open/close cycles (automated G7), and the long-frame gate (automated G9).

| Task | Surface | Gate(s) | Lane task(s) | Depends on |
|---|---|---|---|---|
| S01 | Grid | POS | B1 G1 | |
| S02 | Grid | POS | B1 G2 | |
| S03 | Grid | END, POS | B1 G3 | |
| S04 | Grid | POS (5,000 columns) | B1 G4 | |
| S05 | Grid | focused row kept mounted (§6.1) | B1 G5 | P4 |
| S06 | Rows | POS (unknown total, then true total) | B1 G6 | |
| S07 | Rows | POS (level, position, set size) | B1 G7 | |
| S08 | Rows | END | B1 G8 | |
| S09 | Rendered | HEAD-O (Outline in the tree, activation) | B2 D1 + D5 | |
| S10 | Rendered | HEAD-K | B2 D2 | |
| S11 | Rendered | READ forward; edge controls (§6.2) | B2 D3 + D6 | |
| S12 | Rendered | READ backward | B2 D4 | |
| S13 | Rendered | accessibility mode on mid-session (§6.2) | B2 D7 | |
| S14 | Transcript | FEED | B2 D8 | |
| S15 | Transcript | FEED, HEAD-K, READ | B2 D9 | |
| S16 | Transcript | FEED | B2 D10 | |
| S17 | Chrome | tabs semantics (§6.1) | B3 C1 | |
| S18 | Chrome | PEEK | B3 C3 | |
| S19 | Chrome | PEEK | B3 C4 | |
| S20 | Chrome, Grid, Rendered | ZOOM; collapsed lens switch | B3 C2 + new 200% steps | |

Merged: B2 D1 into S09 (D1's element-list checks are the first half of D5's activation path), B2 D6 into S11 (D6's "no `Continue:` in the log" is already a pass line of D3 and D4; its button check is one more step), B3 C2 into S20 (the collapsed switch is what a 200% zoom produces at small window sizes). Renamed: B3 C3 to S18, C4 to S19.

## Pending decisions that change what is heard

P4 is open (Grid lane B1 report, "Decisions for Zack"). The script follows the current build; if it flips, S05's "Must hear" lines change and the task is re-run.

- **P4: a screen-reader-driven scroll-into-view on an off-screen focused cell in logical scrolling would read as a proportional jump** (×1.5 at 1M rows, about ×80 at 50M). Untested; S05 is where it would show. Affects S05.

Decided, and what S01–S08 expect:
- **P3, decided by spec Z40: Space doesn't page the Grid.** Page Up/Down page. Shift+Space selects the row and Ctrl+Space the column; the spike doesn't build selection (the Grid milestone's acceptance test, Task B1b). S05 scrolls the view with the mouse wheel instead.
- **P5, decided by spec Z51: Space doesn't page Rows either.** Page Up/Down page, and Shift+Space selects the row in the product; the spike doesn't build selection (the Rows milestone's acceptance test, Task B1c). S06–S08 don't use Space, so nothing they expect changes.
- **The row-number column is ARIA column 1 (spec Z32).** Readers say "column 2", with its name, for the first CSV column; the Grid has 21 columns for a 20-column CSV.
- **It shows the record number (spec Z31):** 1 for the first data record. The header row is still ARIA row 1, so a record's announced row is its number + 1: record 1 is row 2, and the last record, `1000000`, is row 1,000,001. Under sorting the number stays the record's (sorting isn't in this spike); Raw keeps the physical source lines.

## Setup

All launches are from `spikes/app`, after `npm run build` (it builds every page). Start the screen reader **before** the app (except in S13), so accessibility mode is on from the first frame. The app turns it on by itself when a screen reader starts; `TYPOSE_A11Y=1` forces it for a dry run without one.

The dark strip at the top of every page (the page's `#titlebar`, not the window frame) is the **status strip**. It reads `core <version>` at first, then `N lines` (`indexing… N lines` while the file is still being indexed), `20000 blocks · 1040 headings` on the Rendered page, `5000 turns` on the Transcript page.

Each PowerShell launch clears the variables when the window closes. Close the window between tasks that say "restart". A leftover `TYPOSE_OPEN` makes every later launch open the file too. A wrong path fails silently: if the status strip still reads `core 0.0.0` after a few seconds and the page shows no grid, document or feed, `TYPOSE_OPEN` names a file that does not exist. The launch commands expect `spikes/app` as the current directory and the fixtures in `spikes/.fixtures`.

### Fixtures (once, `spikes/core`)

```bash
cargo run --release -p fixtures-gen -- csv-grid --rows 1000000 --cols 20 --out ../.fixtures/grid-1m-x20.csv
cargo run --release -p fixtures-gen -- csv-grid --rows 1000 --cols 5000 --out ../.fixtures/grid-1k-x5000.csv
cargo run --release -p fixtures-gen -- jsonl --bytes 10737418240 --line 200 --out ../.fixtures/10g.jsonl
cargo run --release -p fixtures-gen -- doc --blocks 20000 --out ../.fixtures/doc-20k.jsonl
cargo run --release -p fixtures-gen -- transcript --turns 5000 --out ../.fixtures/transcript-5k.jsonl
```

Expected lines: `grid-1m-x20.csv: 1000001 lines`, `grid-1k-x5000.csv: 1001 lines`, `10g.jsonl: 53687092 lines`, `doc-20k.jsonl: 20000 blocks, 1040 headings`. The chrome fixtures come from `node ../tools/chrome-fixtures.mjs` (below). On a Mac without room for the 10 GiB file, use `1g.jsonl` for Rows and read its line count (5,368,710) wherever the script says 53,687,092.

### Launch commands

Grid (S01–S03, S05), 1M × 20:
- PowerShell: `$env:TYPOSE_PAGE='grid'; $env:TYPOSE_OPEN="$PWD\..\.fixtures\grid-1m-x20.csv"; npx electron .; Remove-Item Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_PAGE=grid TYPOSE_OPEN="$(cygpath -w "$PWD/../.fixtures/grid-1m-x20.csv")" npx electron .`
- Mac (Terminal): `TYPOSE_PAGE=grid TYPOSE_OPEN="$PWD/../.fixtures/grid-1m-x20.csv" npx electron .`

Grid (S04), 1,000 × 5,000: the same with `grid-1k-x5000.csv`.

Rows (S06–S08): the same with `TYPOSE_PAGE` `treegrid` and `10g.jsonl`:
- PowerShell: `$env:TYPOSE_PAGE='treegrid'; $env:TYPOSE_OPEN="$PWD\..\.fixtures\10g.jsonl"; npx electron .; Remove-Item Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_PAGE=treegrid TYPOSE_OPEN="$(cygpath -w "$PWD/../.fixtures/10g.jsonl")" npx electron .`
- Mac: `TYPOSE_PAGE=treegrid TYPOSE_OPEN="$PWD/../.fixtures/10g.jsonl" npx electron .`

Rendered (S09–S13) and Transcript (S14–S16): the same with `TYPOSE_PAGE` `doc` and `doc-20k.jsonl`, or `transcript` and `transcript-5k.jsonl`:
- PowerShell: `$env:TYPOSE_PAGE='doc'; $env:TYPOSE_OPEN="$PWD\..\.fixtures\doc-20k.jsonl"; npx electron .; Remove-Item Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_PAGE=doc TYPOSE_OPEN="$(cygpath -w "$PWD/../.fixtures/doc-20k.jsonl")" npx electron .`
- Mac: `TYPOSE_PAGE=doc TYPOSE_OPEN="$PWD/../.fixtures/doc-20k.jsonl" npx electron .`

Chrome (S17–S20): `TYPOSE_OPEN` is `<card file>|<peek file>`; the tool writes both files and prints the value:
- PowerShell: `$env:TYPOSE_PAGE='chrome'; $env:TYPOSE_OPEN=(node ..\tools\chrome-fixtures.mjs); npx electron .; Remove-Item Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_PAGE=chrome TYPOSE_OPEN="$(node ../tools/chrome-fixtures.mjs)" npx electron .`
- Mac: the same as Git Bash.

Page contents:
- **Grid:** `role=grid` named after the file; a `#` corner cell, column headers `col1`…, a row-number column (the record number, 1 for the first data record), cells `r<row>c<col>`.
- **Rows:** `role=treegrid` named after the file; one row per line (timestamp, type, summary `line 0000000000 xxx…`); Right expands a row into its keys.
- **Rendered:** a `main` document of headings, paragraphs, lists, code and tables, and a `navigation` named `Outline` (collapsed rail, with an `Outline` button). Block text starts with its number (`Block 4512.`, `Block 4512 item 1:`, `// block 4512`, `Block 4512 row 0`) and each heading ends with it (`Section 251 (block 5508)`). The window is 500 blocks and recenters every 126 blocks of reading.
- **Transcript:** a `feed` named `Transcript`; each turn an `article` named by its role (`User`, `Assistant`, `Tool`), with a level-2 heading `Assistant · turn 12` and text starting `Turn 12.`.
- **Chrome:** a card for `chrome-main.jsonl` with a lens switch (`Raw`, `Rows`, `Tree`) and a button `chrome-peek.jsonl` that opens the peek. Start by clicking the status strip once so the page has focus, then press Tab.

### Reader modes

| | NVDA | Narrator | VoiceOver (Mac) |
|---|---|---|---|
| Documents (S09–S15) | Browse mode (the default). | Scan mode on (Narrator+Space toggles it). | Quick Nav off; use the VO keys below. |
| Widgets: Grid, Rows, tabs, dialog, Transcript PageDown (S01–S08, S16–S20) | Focus mode. NVDA switches itself when focus lands in a grid, tab or dialog; NVDA+Space toggles. Note any task where it did not switch. | Scan mode **off** for plain arrows in widgets. | Quick Nav off. If the arrows do not reach the page, interact with VO+Shift+Down and note it. |
| Top / bottom | Ctrl+Home / Ctrl+End | Ctrl+Home / Ctrl+End | Cmd+↑ / Cmd+↓ (the Grid and Rows map them to Home/End) |

**The Grid and Rows are tested in focus mode only.** In accessibility mode the Rendered and Transcript pages mount a 500-item window, but the Grid and Rows keep their normal overscan, one viewport each way (about 94 rows mounted, Task B1b). Browse-mode table reading there (say-all, NVDA's Ctrl+Alt+arrows) would run out of mounted rows within about a screen and a half. That is by design (spec §5.3, §6.2, Z33): the wide window is for Rendered and Transcript. In the Grid and Rows every data cell must be reachable by the page's own keys, which load the target before moving focus, and continuous read-all is not a v1 requirement. So S01–S08 stay in focus mode, where every move goes through those keys.

Keys used by the document tasks. Verify Narrator's and VoiceOver's against their own key help (Narrator+F1, VO+H) and record any difference.

| Action | NVDA (browse mode) | Narrator (scan mode) | VoiceOver |
|---|---|---|---|
| Next / previous heading | H / Shift+H | H / Shift+H | VO+Cmd+H / VO+Cmd+Shift+H |
| Next / previous item | Down / Up | Down / Up (outside scan mode: Narrator+Right / Narrator+Left) | VO+Right / VO+Left |
| Read from here | NVDA+Down (say-all); Ctrl stops | Narrator+R; Ctrl stops | VO+A; Ctrl stops |
| Elements list (landmarks, headings, links, buttons) | NVDA+F7 | Narrator+F7 | VO+U (rotor) |
| Next landmark | D | D | rotor → Landmarks |
| Buttons list | NVDA+F7 → Buttons | Narrator+F7 → Buttons | rotor → Form Controls |

### Speech log (NVDA only)

NVDA menu (NVDA+N) → Tools → Speech viewer. After a reading task, click into the viewer, Ctrl+A, Ctrl+C and paste into Notepad. The log also holds what NVDA said before the reading: the page read from the top at load, the elements list. So mark where the reading starts: type a line `>>> start` directly above the line that names the task's start position, the last such line before the reading. The start positions:

| Task | Start line (the last one before the reading) | `$step` | `$jumps` |
|---|---|---|---|
| S11 | `Section 250 (block 2988)` | `1` | `@()` |
| S12 | `Section 542 (block 11508)` | `-1` | `@()` |
| S13 | `Section 250 (block 2988)` (or `Block 2989.` if NVDA started without reading the heading) | `1` | `@('2989->5508')`: the next-heading key, 2,519 blocks on |
| S15 | `User · turn 1` | `1` | `@()` |

Save as `spikes/results/sr-nvda-<task>.txt` (for example `sr-nvda-S11.txt`). Then check the numbers (PowerShell, `spikes/results`; set `$f`, `$step` and `$jumps` from the table):

```powershell
$f = '.\sr-nvda-S11.txt'; $step = 1; $jumps = @()
$log = @(Get-Content $f)
$at = [array]::IndexOf(@($log | ForEach-Object { $_.Trim() }), '>>> start')
if ($at -lt 0) { throw "$f has no '>>> start' line" }
$read = $log | Select-Object -Skip ($at + 1)
# The fixtures' own forms: Block N, (block N), // block N, turn N. A lowercase "block" among a block's words never is.
$n = $read | Select-String -CaseSensitive -AllMatches -Pattern '(?:Block|\(block|// block|[Tt]urn) (\d+)' | ForEach-Object { $_.Matches } | ForEach-Object { [int]$_.Groups[1].Value }
$seq = @($n[0]); foreach ($x in $n) { if ($x -ne $seq[-1]) { $seq += $x } }
for ($k = 1; $k -lt $seq.Count; $k++) { $j = "$($seq[$k - 1])->$($seq[$k])"; if ($seq[$k] - $seq[$k - 1] -ne $step -and $jumps -notcontains $j) { "break: $j" } }
$read | Select-String -SimpleMatch 'Continue:' | ForEach-Object { "edge control: $($_.Line)" }
"first $($seq[0]) last $($seq[-1]) distinct $($seq.Count)"
```

Each line's number is the block or turn it belongs to; lines of the same block in a row count once (a list item, a table row, say-all starting again on the line just read). A `break:` line is a step other than `$step` that the task didn't declare: a skipped position, or one heard again after a later one. `edge control:` lines are `Continue:` controls heard during the reading. Narrator and VoiceOver have no speech log: listen, and note the first and last numbers and any jump you hear.

## Grid (`grid-1m-x20.csv`, 1,000,001 lines)

### S01 · Grid: totals on entry
- **Launch:** Grid 1M × 20. Wait until the status strip reads `1000001 lines`.
- **Keys:** Tab (focus enters the grid at the `#` corner cell).
- **Must hear:** the grid's name `grid-1m-x20.csv` and its role (grid or table); **1,000,001 rows** and **21 columns** (20 CSV columns plus the row-number column); row 1, column 1; `#`.
- **Pass when:** both totals are spoken and exact.
- **Fail when:** a total is missing, smaller than the true one, or spoken as 0.
- **Decided:** spec Z32 (21 columns: the row-number column is column 1).

### S02 · Grid: position on every move
- **Launch:** from S01 (focus on `#`).
- **Keys:** ↓, →, →, →, ↓.
- **Must hear:** on each move the new cell's text: `1` (the row header: record 1, in row 2), `r1c1`, `r1c2`, `r1c3`, `r2c3`; the column header when the column changes (`col1`, `col2`, `col3`); the row header when the row changes (`2` on the last move); "row 3, column 4" or equivalent on the last move.
- **Pass when:** every announced row header is the record number shown at the left, every announced row number is that record number + 1, and every announced column number is the CSV column's number + 1 (`col<k>` at the top is column k + 1).
- **Fail when:** any position is off by one, skipped, repeated, or not announced.
- **Decided:** spec Z32 (the first CSV column is column 2), Z31 (the first record is numbered 1, in row 2).

### S03 · Grid: Ctrl+End reaches the true last cell
- **Launch:** Grid 1M × 20, any position.
- **Keys:** Ctrl+End, then Ctrl+Home (Mac: Cmd+↓, Cmd+↑).
- **Must hear:** Ctrl+End: **row 1,000,001**, **column 21**, the row header **`1000000`** (the last record's number), `col20`, `r1000000c20`. Ctrl+Home: row 1, column 1, `#`.
- **Pass when:** the true last row and column are spoken and the cell text matches the file's last line.
- **Fail when:** focus stops short of the last row, or the reader says nothing or reads a blank cell.
- **Decided:** spec Z31 (the row header is the record number), Z32.

### S04 · Grid: 5,000 columns
- **Launch:** Grid with `grid-1k-x5000.csv`. Wait until the status strip reads `1001 lines`.
- **Keys:** Tab in, End, Home, ↓, PageDown.
- **Must hear:** entering: **5,001 columns** (and 1,001 rows). End: column 5,001, `col5000`. Home: column 1, `#`. ↓: row 2, `1` (record 1). PageDown: a row number about one screen further (≈ 28 rows at the default window), and its cell text.
- **Pass when:** every spoken position matches the screen: the announced row is the record number shown at the left + 1, as in S02.
- **Fail when:** a column count under 5,001, an empty cell read on focus, or a position that does not match the screen.
- **Decided:** spec Z32.

### S05 · Grid: the focused cell survives being scrolled out of view
- **Launch:** Grid 1M × 20.
- **Keys:** Ctrl+Home, ↓ ↓, → → → (focus is `r2c3`). Scroll the view down about three screens with the mouse wheel (focus stays), then ↓.
- **Must hear:** while scrolling: no focus announcement, or the same cell `r2c3` again, never a different cell. ↓: row 4 (row header `3`), `r3c3`, and the view returns to it.
- **Pass when:** the focused cell survives being scrolled out of view and the next move continues from it.
- **Fail when:** the reader loses focus (silence, "document", or the top of the page), or the next move starts somewhere else.
- **Depends on:** P4. **Decided:** spec Z31, Z32, Z40.

## Rows (`10g.jsonl`, 53,687,092 lines)

### S06 · Rows: no total while indexing, the true total after
- **Launch:** Rows. Tab in **while the status strip still reads `indexing… N lines`** (immediately after launch), then wait until it reads `53687092 lines` and press ↓ then ↑.
- **Must hear:** while indexing: role (treegrid or table), level 1, position 1, and **no total** (or "unknown"). After indexing: level 1, **"1 of 53,687,092"** (or the fixture's true line count), collapsed, the row's timestamp, type and summary.
- **Pass when:** no partial count is ever presented as the total, and the true total is spoken once indexing is done.
- **Fail when:** any total other than the true one is spoken, for example a growing count while indexing.
- **Note:** indexing the 10 GiB file takes seconds. If it finishes before you can Tab in (very likely with `1g.jsonl` on the Mac), write "indexing phase not observed" in Notes; the after-indexing half still decides the task.

### S07 · Rows: level, position, set size and expansion
- **Launch:** from S06 (indexed).
- **Keys:** ↓ ×4 to the 5th row, →, ↓, ←, ←.
- **Must hear:** →: "expanded". ↓: level 2, **"1 of 3"**, `ts` and the timestamp. First ←: back on the 5th row, level 1, "5 of …". Second ←: "collapsed".
- **Pass when:** level, position, set size and expanded state are spoken correctly at each step.
- **Fail when:** a level or position is missing, the set size is wrong, or the expanded state is stale.

### S08 · Rows: Ctrl+End reaches the true last row
- **Launch:** Rows, indexed.
- **Keys:** Ctrl+End, then Ctrl+Home (Mac: Cmd+↓, Cmd+↑).
- **Must hear:** Ctrl+End: **"53,687,092 of 53,687,092"** (the true total) and `line 0053687091` in the summary. Ctrl+Home: "1 of 53,687,092".
- **Pass when:** the true last line is reached and both positions are exact.
- **Fail when:** focus stops short, or the position is not announced.

## Rendered (`doc-20k.jsonl`: 20,000 blocks, 1,040 headings)

Arrow reading uses the reader's own line keys (the key table above); NVDA is in browse mode. The Speech viewer is open for S11, S12 and S13.

### S09 · Rendered: the Outline and every heading are in the tree, and activating one moves focus there
- **Launch:** Rendered. The status strip reads `20000 blocks · 1040 headings` when ready. Leave the rail collapsed (do not click the `Outline` button).
- **Keys:**
  1. Open the elements list: look at Landmarks, then Headings, then Links.
  2. In Links, choose `Section 1040 (block 19992)` and activate it (NVDA: Activate; Narrator and VoiceOver: Enter). Then Down (NVDA: first press Escape if it switched to focus mode).
  3. Keyboard path: Tab from the document. A `Continue: next 500 blocks` button may come first; then the `Outline` button, then the first Outline entry. The rail appears while an entry has focus; Down and Up move between entries.
- **Must hear:** (1) Landmarks lists **Outline** (navigation) and **main**. Headings starts with `Section 1 (block 0)` (level 1) and ends with `Section 1040 (block 19992)` (level 2). Links includes `Section 1040 (block 19992)`. (2) `Section 1040 (block 19992)` as a heading, then `Block 19993.`. (3) the `Outline` button, then entries named by heading text.
- **Pass when:** all of the above, the rail is not visible on screen at step 1, and after step 2 the heading is on screen at the top. Block 19992 is far outside the 500-block window that was mounted at launch (blocks 0 to about 500).
- **Fail when:** the Outline or a heading is missing from the lists, activation leaves focus elsewhere, or Down does not read `Block 19993.`.

### S10 · Rendered: the heading key leaves the window across a 2,520-block heading-free stretch, both ways
- **Launch:** Rendered, fresh.
- **Keys:**
  1. In the headings list choose `Section 250 (block 2988)` (Enter). Down. Next-heading key once. Down.
  2. Up twice (you are on the last line of block 5507), previous-heading key. Down.
- **Must hear:** (1) `Block 2989.`; then `heading level 1, Section 251 (block 5508)` (5508 is 2,520 blocks on, far outside the 500-block window); then `// block 5509`, and the screen shows that heading. (2) `heading level 2, Section 250 (block 2988)`, then `Block 2989.`.
- **Pass when:** all of the above.
- **Fail when:** "no next heading" or "no previous heading", silence, or any other heading.

### S11 · Rendered: reading forward through 2,000 blocks (at least 4 recenters); the edge controls are a fallback only
- **Launch:** Rendered, fresh, Speech viewer open (NVDA).
- **Keys:**
  1. Headings list → `Section 250 (block 2988)`. Read forward: hold Down (or use say-all, or mix the two) until you hear block **4,988 or later** (2,000 blocks; blocks 3,000 to 5,500 have no heading). Stop.
  2. Mark the start and save the speech log as `sr-nvda-S11.txt` (Speech log, above), then run the check with `$step = 1; $jumps = @()`.
  3. Elements list → Buttons: choose `Continue: next 500 blocks` and activate it.
- **Must hear:** (1) consecutive block numbers, no `Continue:` announcement; the page scrolls along as you read. (3) a block (`Block N…`), then Up reads block N−1.
- **Pass when:** the check prints no `break:` and no `edge control:` lines, and `last` is 4988 or more; after step 3 there is no gap at the old window edge. At 126 blocks per recenter, 2,000 blocks cross about 16 recenters. Narrator and VoiceOver: no jump heard, first and last numbers noted.
- **Fail when:** a jump in the numbers, a repeated block, reading that stops early, the caret landing back at the top, or `Continue: next 500 blocks` heard while reading.

### S12 · Rendered: reading backward through 2,000 never-shown blocks
- **Launch:** restart the app (so the blocks above the cursor have never been shown), Speech viewer open.
- **Keys:** headings list → `Section 542 (block 11508)`. Up once (the last line of block 11507), then hold Up until you hear block **9,508 or earlier**. Mark the start, save the log as `sr-nvda-S12.txt` and run the check with `$step = -1; $jumps = @()`.
- **Must hear:** block numbers falling one at a time from 11507; no `Continue: previous 500 blocks`.
- **Pass when:** the check prints no `break:` and no `edge control:` lines, and `last` is 9508 or less. The text under the cursor never jumps on screen while you read (heights above the cursor are being corrected). Narrator and VoiceOver: no jump heard.
- **Fail when:** a jump in the numbers, a repeated block, or the text under the cursor jumping.

### S13 · Rendered: the screen reader started after the app
- **Launch:** screen reader **off**; launch Rendered.
- **Keys:** click the `Outline` button, scroll the rail, click the entry `Section 250 (block 2988)`. Now start the screen reader (and the Speech viewer). Down once, next-heading key, Down, then hold Down for 10 seconds. Mark the start, save the log as `sr-nvda-S13.txt` and run the check with `$step = 1; $jumps = @('2989->5508')`.
- **Must hear:** `Block 2989.`, then `heading level 1, Section 251 (block 5508)`, then `// block 5509`, then consecutive numbers.
- **Pass when:** as S10 step 1, and the check prints no `break:` lines (the heading key's 2989 → 5508 is the one declared jump).
- **Fail when:** the heading key finds no heading (the window did not grow when the reader started), or the numbers skip.

## Transcript (`transcript-5k.jsonl`: 5,000 turns)

### S14 · Transcript: feed, article and turn announcements
- **Launch:** Transcript. The status strip reads `5000 turns` when ready.
- **Keys:** from the top, Down through the first three turns.
- **Must hear:** for each turn its role as the article's name (`User`, `Assistant`, `Tool`), a level-2 heading `User · turn 1` (then `Assistant · turn 2`, `Tool · turn 3`), then the text starting `Turn 1.`.
- **Pass when:** all of the above. **Record, not pass/fail:** whether the feed (`Transcript`) and the position (for example "1 of 5000") are announced; spec §6.1 exposes both (`role=feed`, `aria-posinset` and `aria-setsize`), but readers differ.
- **Fail when:** a turn has no name, no heading, or the text does not follow its heading.

### S15 · Transcript: the heading key through 760 turns (at least 4 recenters)
- **Launch:** Transcript, fresh, Speech viewer open (NVDA).
- **Keys:** at `User · turn 1`, press the next-heading key steadily until you hear turn **760 or later**. Mark the start, save the log as `sr-nvda-S15.txt` and run the check with `$step = 1; $jumps = @()`.
- **Must hear:** `Assistant · turn 2`, `Tool · turn 3`, `Assistant · turn 4`, `User · turn 5`… one heading per press, in order.
- **Pass when:** the check prints no `break:` lines and `last` is 760 or more. Narrator and VoiceOver: no skipped heading heard.
- **Fail when:** a skipped or repeated turn, "no next heading", or the heading key stopping at the edge of the window (turn 500).

### S16 · Transcript: the feed's PageDown and PageUp
- **Launch:** Transcript, fresh.
- **Keys:** Tab into the transcript (focus lands on an article; NVDA switches to focus mode). PageDown 10 times, then PageUp 3 times.
- **Must hear:** each press announces the next or previous article by its role; after the 10th PageDown you are on turn 11 (`User · turn 11`), after the PageUps on turn 8.
- **Pass when:** all of the above.
- **Fail when:** focus lands on nothing (silence, or "document"), or a press is lost.

## Chrome: tabs and peek

Launch Chrome, fresh, for each of S17 to S19 as needed. The tables give each step's keys and what must be heard. "Fail when" applies to any step of the task.

### S17 · Chrome: the lens switch is a tablist
Page: the lens switch at the top of the card. Tab stops, in order: the selected lens tab, the `chrome-peek.jsonl` button, the card body.

| # | Keys | Must hear |
|---|---|---|
| 1 | Tab once from the page start | group **Lens** (a tab list), **Raw**, role **tab**, state **selected**, position **1 of 3** |
| 2 | Right Arrow | **Rows**, tab, selected, 2 of 3. Focus stays on the tab. The card body changes (Rows shows a kind label on each line) |
| 3 | End | **Tree**, tab, selected, 3 of 3 |
| 4 | Home, then Tab | **Raw**, tab, selected; then the **chrome-peek.jsonl** button |
| 5 | Left Arrow on **Raw** | wraps: **Tree**, tab, selected, 3 of 3. Then Right Arrow wraps back to **Raw** |

- **Pass when:** every listed item is announced.
- **Fail when:** the role is "button" or "link"; "selected" or the group name is missing; focus leaves the tablist on an arrow key; focus jumps to another tab instead of leaving the tablist on Tab; nothing is announced.

### S18 · Chrome: the peek opens as a dialog and keeps the reader inside it

| # | Keys | Must hear |
|---|---|---|
| 1 | Tab to the link | **chrome-peek.jsonl**, button, pops up a dialog |
| 2 | Enter | **chrome-peek.jsonl**, role **dialog**. Focus is on the dialog itself |
| 3 | Tab | **Open as tab**, button |
| 4 | Tab | **Close peek**, button |
| 5 | Tab, Tab | the lines of the peek file (`peek row 0 …`); then back to **Open as tab**. Focus never reaches the card underneath |
| 6 | Next-item key ×10 (NVDA Down in browse mode; Narrator Down in scan mode, or Narrator+Right; VoiceOver VO+Right) | reads only the dialog: the heading **chrome-peek.jsonl**, level 2, the two buttons, then the peek lines. Never the card header, the tabs or `main row` text |
| 7 | Next-heading key (H) | **chrome-peek.jsonl**, heading level 2, and no other heading |

- **Pass when:** every listed item is announced.
- **Fail when:** the page title ("Typose chrome spike") is read on opening; nothing is announced; focus is still on the card underneath; focus reaches the lens tabs or the **chrome-peek.jsonl** button; any card text (`chrome-main.jsonl`, `main row …`, the lens tabs) is read while the peek is open; the heading key announces the page heading or "no next heading".

### S19 · Chrome: closing the peek puts focus back on the link
Open with Enter or Space on the link each time; five rounds, each closed a different way.

| # | Keys | Must hear |
|---|---|---|
| 1 | open with Enter, close with Escape | the link is announced again: **chrome-peek.jsonl**, button |
| 2 | open with Space, Tab ×2, Enter on **Close peek** | **chrome-peek.jsonl**, button |
| 3 | open, Ctrl+W (a real keystroke; Mac: Cmd+W) | the peek closes and **chrome-peek.jsonl**, button is announced. **The window stays open** |
| 4 | open, click the dimmed card with the mouse | **chrome-peek.jsonl**, button |
| 5 | open with Enter, close with Escape, then press Enter again at once | the peek opens again and the dialog name is announced |

- **Pass when:** 5 of 5 on every reader.
- **Fail when:** the page title, "Typose chrome spike", "document", the window title or silence is announced after a close; the window closes on Ctrl+W (on the Mac, Cmd+W is a menu key and may close the window before the page sees it: record it as a fail); the second Enter in round 5 does nothing, or focus is lost.
- The automated gate covers 100 cycles of the same paths with focus read from the DOM; this task checks what the reader announces during them.

### S20 · Zoom to 200%: the lens switch, the peek, the Grid and the Outline stay reachable
Every 200% launch sets `TYPOSE_ZOOM=2` (main's default zoom factor; not persisted) and a private profile, `--user-data-dir=<a fresh temp dir>`, because Chromium stores per-host zoom in the shared `%APPDATA%\spike-app` profile. Use a new temp dir for each launch. The window opens at 1280 × 800 (`width: 1280`, `height: 800` in `main/index.ts`; no minimum size), which at 200% is 640 × 400 CSS px.

Launch commands (Chrome; for the Grid and Rendered launches in C1 and C2 swap `TYPOSE_PAGE` and the file as in Setup):
- PowerShell: `$p = Join-Path $env:TEMP "typose-sr-$(Get-Random)"; $env:TYPOSE_ZOOM='2'; $env:TYPOSE_PAGE='chrome'; $env:TYPOSE_OPEN=(node ..\tools\chrome-fixtures.mjs); npx electron . "--user-data-dir=$p"; Remove-Item Env:TYPOSE_ZOOM, Env:TYPOSE_PAGE, Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_ZOOM=2 TYPOSE_PAGE=chrome TYPOSE_OPEN="$(node ../tools/chrome-fixtures.mjs)" npx electron . "--user-data-dir=$(cygpath -w "$(mktemp -d)")"`
- Mac: `TYPOSE_ZOOM=2 TYPOSE_PAGE=chrome TYPOSE_OPEN="$(node ../tools/chrome-fixtures.mjs)" npx electron . "--user-data-dir=$(mktemp -d)"`

**First, the self-check (S20.0).** No screen reader is needed for this check. At the default window the lens switch shows three tabs (the card is 606 CSS px wide, over the 400 px limit). Drag the window's right edge in until it is about 860 px wide: the three tabs must be replaced by the single `Raw Lens` button. If they collapse only below about 435 px, the zoom is still 100%: stop, the knob did not apply, and S20 cannot be judged.

| # | At 200% | Keys | Must hear, and see |
|---|---|---|---|
| A1 | window 1280 × 800 | Tab, Right Arrow, End, Home | **Raw**, tab, selected, 1 of 3; then Rows, Tree, Raw as in S17. The tab strip and the focus ring are fully inside the window, with no horizontal scrolling |
| A2 | | Tab, Enter | the **chrome-peek.jsonl** button, then the peek dialog. The whole peek is inside the window |
| A3 | | Tab ×4 | **Open as tab**, **Close peek**, the peek lines, then **Open as tab** again. Escape closes the peek; **chrome-peek.jsonl**, button is announced |
| B1 | window about 860 px wide (drag the right edge in; not below 720 × 480) | Tab | the three tabs are gone; **Raw Lens**, role **button**, state **collapsed**, pops up a list |
| B2 | | Enter (or Space, or Down Arrow) | a list named **Lens** opens and focus is on its first item: **Raw**, selected, 1 of 3. A hidden **Dismiss** button before and after the list may be announced; that is expected. All three options are inside the window |
| B3 | | Down Arrow, Enter | the list closes; focus returns to the button: **Rows Lens**, button, collapsed. The card body is the Rows lens, and the tab panel is named **Rows** |
| B4 | | Enter, Escape | the list closes; focus is on the button again, still **Rows Lens** |
| B5 | | Tab, Enter | the **chrome-peek.jsonl** button, then the peek dialog. The peek is inside the window (no clipped edge); Tab stays inside it (**Open as tab**, **Close peek**, the lines); Escape returns focus to the button |
| C1 | relaunch on `grid-1m-x20.csv` with `TYPOSE_PAGE=grid`, `TYPOSE_ZOOM=2` and a new profile | Tab, End, Ctrl+End | the grid; then column 21 (`col20`) scrolled fully into view; then row 1,000,001 (row header `1000000`), `r1000000c20`. The focus ring and the row-number column are not clipped |
| C2 | relaunch on `doc-20k.jsonl` with `TYPOSE_PAGE=doc`, `TYPOSE_ZOOM=2` and a new profile | Tab until the `Outline` button | the `Outline` button is fully visible and operable; Enter opens the rail inside the window; its entries are reachable |

- **Pass when:** every step is announced as listed, and nothing is unreachable: no control, focus ring or dialog edge is clipped or off screen, and no step needs horizontal scrolling of the page.
- **Fail when:** a control cannot be reached by keyboard, focus lands off screen, the dialog or list is clipped, the list is not announced, focus stays on the button after Enter, or focus lands on the page or on nothing after a close.
- Steps C1 and C2 add what a reader hears. The automated 200% checks (Task B3c) Tab through the chrome page at 1280 × 800 and 720 × 480, and through the Grid, Rows, Rendered and Transcript pages at 1280 × 800, each opened with `TYPOSE_ZOOM=2` in a fresh profile.

## Results

Copy the table from `spikes/results/sr-results.md` (60 rows: 20 tasks × NVDA, Narrator, VoiceOver). One row per task per reader:

| Column | Content |
|---|---|
| Task | `S01` to `S20` |
| Screen reader and version | NVDA version, Narrator with the Windows build, VoiceOver with the macOS version |
| Heard | what was actually spoken, as a short transcript (verbatim on a failure) |
| Pass/fail | `pass` or `fail`, judged against the task's "Pass when" and "Fail when" |
| Notes | the step that failed; whether the DOM and UIA showed the right values at that moment (for the Grid and Rows, re-run `npx playwright test --project=e2e grid treegrid` to compare); the mode the reader was in; the speech-log file name |

A failure is a result: record the verbatim announcement and which part of spec §6 it breaks. Do not edit the build to make a task pass.
````

- [ ] **Step 2: Create the results file**

`spikes/results/sr-results.md`:
````markdown
# Spike B screen-reader results

Script: `spikes/results/sr-script.md` (tasks S01–S20). Date: <date>. Build: <commit>. Machines: PC (NVDA, Narrator) · Mac (VoiceOver).

Replace the `<…>` in the second column with the reader's version. A failure is a result: write what was heard verbatim and the step that failed in Notes.

| Task | Screen reader and version | Heard | Pass/fail | Notes |
|---|---|---|---|---|
| S01 | NVDA <version> | | | |
| S01 | Narrator <Windows build> | | | |
| S01 | VoiceOver <macOS version> | | | |
| S02 | NVDA <version> | | | |
| S02 | Narrator <Windows build> | | | |
| S02 | VoiceOver <macOS version> | | | |
| S03 | NVDA <version> | | | |
| S03 | Narrator <Windows build> | | | |
| S03 | VoiceOver <macOS version> | | | |
| S04 | NVDA <version> | | | |
| S04 | Narrator <Windows build> | | | |
| S04 | VoiceOver <macOS version> | | | |
| S05 | NVDA <version> | | | |
| S05 | Narrator <Windows build> | | | |
| S05 | VoiceOver <macOS version> | | | |
| S06 | NVDA <version> | | | |
| S06 | Narrator <Windows build> | | | |
| S06 | VoiceOver <macOS version> | | | |
| S07 | NVDA <version> | | | |
| S07 | Narrator <Windows build> | | | |
| S07 | VoiceOver <macOS version> | | | |
| S08 | NVDA <version> | | | |
| S08 | Narrator <Windows build> | | | |
| S08 | VoiceOver <macOS version> | | | |
| S09 | NVDA <version> | | | |
| S09 | Narrator <Windows build> | | | |
| S09 | VoiceOver <macOS version> | | | |
| S10 | NVDA <version> | | | |
| S10 | Narrator <Windows build> | | | |
| S10 | VoiceOver <macOS version> | | | |
| S11 | NVDA <version> | | | |
| S11 | Narrator <Windows build> | | | |
| S11 | VoiceOver <macOS version> | | | |
| S12 | NVDA <version> | | | |
| S12 | Narrator <Windows build> | | | |
| S12 | VoiceOver <macOS version> | | | |
| S13 | NVDA <version> | | | |
| S13 | Narrator <Windows build> | | | |
| S13 | VoiceOver <macOS version> | | | |
| S14 | NVDA <version> | | | |
| S14 | Narrator <Windows build> | | | |
| S14 | VoiceOver <macOS version> | | | |
| S15 | NVDA <version> | | | |
| S15 | Narrator <Windows build> | | | |
| S15 | VoiceOver <macOS version> | | | |
| S16 | NVDA <version> | | | |
| S16 | Narrator <Windows build> | | | |
| S16 | VoiceOver <macOS version> | | | |
| S17 | NVDA <version> | | | |
| S17 | Narrator <Windows build> | | | |
| S17 | VoiceOver <macOS version> | | | |
| S18 | NVDA <version> | | | |
| S18 | Narrator <Windows build> | | | |
| S18 | VoiceOver <macOS version> | | | |
| S19 | NVDA <version> | | | |
| S19 | Narrator <Windows build> | | | |
| S19 | VoiceOver <macOS version> | | | |
| S20 | NVDA <version> | | | |
| S20 | Narrator <Windows build> | | | |
| S20 | VoiceOver <macOS version> | | | |
````

- [ ] **Step 3: Build and prepare the fixtures**

Run (`spikes/app`): `npm run build`. Generate the fixtures listed in the script's "Fixtures" section (`spikes/core`) if they are not already in `spikes/.fixtures`. No `TYPOSE_*` variable may be set in the shell.

Check that all five pages open: for each launch command in the script's Setup, the window opens and the status strip reaches its final text (`1000001 lines`, `1001 lines`, `53687092 lines`, `20000 blocks · 1040 headings`, `5000 turns`; on the 1.2 GiB stand-in for `10g.jsonl`, `6442451 lines`). The chrome page has no status text of its own; it shows the card and the `chrome-peek.jsonl` button.

- [ ] **Step 4: Run the script on NVDA and Narrator (Zack's PC)**

Per reader, run S01 to S20 in order (S20 launches with `TYPOSE_ZOOM=2` and a private profile, so it leaves no zoom behind). Defender on, nothing else heavy running. Start the screen reader before each launch, except in S13. Save the NVDA speech logs as the script says and run its check. Note NVDA's version (NVDA menu → Help → About) and Narrator's Windows build (`winver`).

For each task write what was actually spoken, then pass or fail. A failure is a result: keep going, and record the verbatim announcement.

- [ ] **Step 5: Run the script on VoiceOver (Mac batch)**

On the friend's Mac, with the branch checked out and `npm run build` done in `spikes/app`. The fixtures: generate `grid-1m-x20.csv`, `grid-1k-x5000.csv`, `doc-20k.jsonl` and `transcript-5k.jsonl` as in the script; for Rows use `10g.jsonl` if it was generated for Spike A, otherwise `1g.jsonl` (5,368,710 lines). Run S01 to S20 with the Mac launch commands and keys (Ctrl+Home/End are Cmd+↑/↓; S20 uses the Mac launch commands with `TYPOSE_ZOOM=2`). Record in S19 whether Cmd+W closed the window.

- [ ] **Step 6: Record the results**

`spikes/results/sr-results.md`: fill in every row (20 tasks × 3 readers = 60). Add the speech-log files. A task that failed gets a note on what was heard instead, which step failed, and, for the Grid and Rows, whether the DOM and UIA showed the right values at that moment (`npx playwright test --project=e2e grid treegrid`).

Count: passes per reader out of 20. The Spike B gate "100% completion of the 20-task script" holds for a reader only at 20 of 20. Tasks that failed on a reader feed back into spec §6.2 (the wide window, the Outline, the edge controls) and §6.1 (grid, treegrid, feed semantics) before any product code is written.

- [ ] **Step 7: Read your own work (rule 8), then commit**

Re-read `sr-script.md` and `sr-results.md` in full as they sit on disk, and check that the results file has 60 rows and no row left blank.
```bash
git add spikes/results/sr-script.md spikes/results/sr-results.md spikes/results/sr-nvda-S11.txt spikes/results/sr-nvda-S12.txt spikes/results/sr-nvda-S13.txt spikes/results/sr-nvda-S15.txt
git commit -m "spike(b): the 20-task screen-reader script and its results (NVDA, Narrator, VoiceOver)"
```
