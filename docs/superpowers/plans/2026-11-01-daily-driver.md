# Daily-driver plan (2026-11-01)

**Goal (Z75):** a Windows build Zack installs and uses every day for Markdown, CSV, JSON, JSONL and YAML. No signing and no Mac/Linux qualification in this milestone.

**Source:** `.evidence/audit/gap-analysis-2026-11-01.md` (not committed), which holds the defects, the board gaps, and Zack's decisions Z74–Z85.

**Baseline:** main `317855f` (#40 merged: sidebar, splits, Grid, Find, peek).

## Rules
- **Z84:**
  - Each PR lands on main before the next one stacks, and stacks go at most one layer deep.
  - Claude is PM; Opus lanes take risk work and Sonnet lanes take mechanical work.
  - One review round, or two for PRs that touch parsers of untrusted input, authority, or memory.
- **Z85:** the merge bar is the full local Windows gate (`fmt`, `lint`, `clippy` and `clippy-hooks`, `cargo test`, vendor tests, addon build, `check`, `test:hooks`, `package`, packaged visual, `e2e`) on Node ≥ 24.16, run on the PR head. Hosted CI is advisory once PR 1 lands.
- **Z77:** the transcript lens stays out. Session files keep #41's Raw/Rows/Table behaviour until after this milestone. The snapshot's transcript code (`core/typose-core/src/transcript.rs`, `core/typose-node/src/structured_transcript.rs`, `app/renderer/lenses/transcript-view.ts`, 1,651 lines) is parked on branch `park/transcripts` from `9379bca`. It is not ported.
- Snapshot code is ported **by tree diff** from `3e9e001`→`9379bca`, never by cherry-pick, because `3e9e001` is not an ancestor of `9379bca`. Each port PR names the files it takes. Untested snapshot code gets the same review and gate as new code.

## PRs, in landing order

| # | PR | Scope | Size | Lane / review |
|---|---|---|---|---|
| 1 | **CI slim + decisions** | `pr.yml`: lint, typecheck, Vitest, cargo, and an e2e smoke subset that fits 25 min. Full e2e on Windows and Linux moves to the weekly schedule. Spec §0.4 Z74–Z85. This plan file | small | Sonnet, 1 round |
| 2 | **Land #41** (structured lenses) | Merge main into `codex/workspace-candidate` (4 commits, 73 files, +6.6k), gate in a **clean** worktree (not `rc-product-review`, which carries 67 uncommitted snapshot files), fix whatever the full gate finds (at `80683f7` an isolated desktop subset failed JSONL and a rich-print startup waiter), merge | large | Opus, 2 rounds (parsers) |
| 3 | **Markdown extras + Markdown polish** | Port math, Mermaid, callouts, frontmatter, Outline, code highlighting and Copy, and rich print from the snapshot. Z80: a light highlight theme (today one `github-dark` theme serves both modes), light find-match colours, and the unresolved-link style with a "Not found: x" hover (gap §3.5, §3.7) | decent | Opus, 2 rounds (hostile Markdown, sandbox) |
| 4 | **Workspace controls + polish** | Port Settings, the palette, quick open (bounded walk, Z81) and TOML config. Z80: segmented mode control, styled Files tab, a TOML banner with "using your last good settings" and Open config.toml, Ctrl+,, a grouped palette, RECENT and IN OPEN FOLDERS headers | decent | Sonnet, 1 round |
| 5 | **Structured rework port** | Port the snapshot's `structured.ts`, `yaml-model.ts`, `jsonl.rs`, `json.rs` and `csv_metadata.rs` changes, **minus transcript**. Fix the YAML synthetic `[ 2 items ]` root (gap §4) and the JSONL truncated-line message (gap §3.6) | decent | Opus, 2 rounds (parsers) |
| 6 | **JSONL Rows: scrolling list + summaries** | Z79: replace the 100-row pager with a virtualised scrolling list. Z80: composed summaries (no raw JSON fallback), a colour per type, formatted times | decent | Opus, 2 rounds (memory) |
| 7 | **Open paths: drop + folder argv** | Z79: drag-and-drop of files and folders onto the window, with a drop-target state. A folder from argv, Explorer or a drop becomes a sidebar root (today: "refused: not a regular file"). Failed opens stay out of recents. An argv open activates its tab even while Settings is active (gap §3.3, §3.4) | decent | Opus, 2 rounds (authority) |
| 8 | **Hand-off actions** | Z79: Show in Explorer, Open with default app and Copy path on cards and sidebar rows. A binary-file sheet. An executable sheet that never launches anything (p42). Unsupported sidebar files get the hand-off instead of a notice | decent | Opus, 2 rounds (security) |
| 9 | **Wrap lines + crash restore** | Z79: Wrap lines wraps Raw (today a no-op), inside the Z66/ledger memory bounds. Z78: restore never auto-opens a document that crashed the core. Fix the "Folder not found · Core restarted" and doubled "Folder not found" copy, because the folder isn't missing | small–decent | Opus, 2 rounds (memory) |
| 10 | **Install** (Z82) | Package main, install to `%LOCALAPPDATA%\Programs\Typose`, run through the real workflows on Zack's files, and record the payload hash | small | PM |

Two of PRs 3–9 can run in parallel worktrees only if both branch from current main and touch disjoint files; check the file lists before dispatching. Known overlaps, which run in order: 5 → 6 (`structured.ts`), and 4, 7, 9 (`App.tsx`).

## Out of scope for this milestone
Transcripts (`park/transcripts`), the native 50k quick-open index (`quick-open-index-wip.patch`), CSV encoding override, signing, Mac/Linux qualification, and the rest of the ~30 fidelity deltas not named above (glyphs, docked Outline, problems list, tab drag, card-header stack/split buttons).

## Done when
PRs 1–10 have landed and the installed build opens Zack's real folders and files without a crash for a week of use. Any crash found is a blocker.
