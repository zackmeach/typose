# Transcript lens plan, M5 (2026-11-04)

**Goal:** the Transcript lens from brief §5.4 on the installed Windows daily driver, for Claude Code sessions and OpenAI chat JSONL. It follows the daily driver [Z77].

**Source:** the diagnosis of the parked snapshot code, `diag/transcript-crash` (local branch, `9379bca` + `3c592bc` + `ff85dc9`). Its report, `transcript-diag-REPORT.md`, isn't committed; the findings this plan relies on are restated here.

**Baseline:** main `2cc253b`.

## What the diagnosis found
- **The crash.** The snapshot's transcript queries pass `group`, `item`, `call`, `end` and `block` to `limits::int`. `limits::RANGES` has no row for any of them, so `limits.rs:29` panics. typose-node has no `catch_unwind`, so the panic kills the core host with `0xC0000409` on the first page, tools or text query. That is every Transcript open. Main has the same `RANGES` table, so a port without the fix crashes main too.
- **With the fix, 66 files ran with no crash.** The set: 3 synthetic inputs, 24 sessions spread by size, and all 39 sessions over 10 MiB, the largest 68 MB. Max RSS 136 MiB; index build at most 441 ms.
- **Transcript works on only 21 of the 66.** Three refusal rules reject real data:
  - Sidechain-only subagent files are refused with "no non-sidechain leaf" (`transcript.rs:359-366`). The diagnosis counted 2,712 sidechain-only files among the 2,986 session files on this PC.
  - Duplicate UUIDs are refused (`transcript.rs:318-323`) in 10 of 274 main sessions. They are the same records appended again later in the file.
  - One refused Markdown block fails a whole 20-item page (`transcript-view.ts` `show()` has no per-item catch).
- **Memory and time defects:**
  - The renderer charges `html.length × 1280` cumulatively and never releases it. Reading the 65.5 MB session to the end would ask for about 13.2 GB.
  - `Graph::finish` is quadratic and can't be cancelled: 20,000 off-chain messages take 6.78 s under the transcript lock.
  - Transcript queries don't take a page slot.
- **Why port, not rewrite.** The parked core keeps payloads in the file as spans, reserves the graph through the ledger and releases it on drop, turns the graph off with a Rows fallback at its caps, and has cancellable queries. A rewrite on main's JSONL index would re-derive the same graph, link tables and fragment renderer: about 1,000 new lines against about 450 for the port, starting with no evidence.

## Rules
- **Z84:** each PR lands on main before the next one stacks. PRs 1–3 parse untrusted input and touch the memory ledger, so each gets two executed review rounds.
- **Z85:** merge on the full local Windows gate, run on the PR head.
- **Porting.** Port by tree diff from `diag/transcript-crash`, never by cherry-pick. The snapshot's structured pipeline predates #41 and #45, so its glue is rewritten against main, not copied. Untested snapshot code gets the same review and gate as new code.
- **e2e** follows the cross-platform rules: `ControlOrMeta+`, `runCommand`, and a skip off win32 for Windows-only capabilities.

## PRs, in landing order

| # | PR | Scope | Size | Lane / review |
|---|---|---|---|---|
| 1 | **Transcript core** | Port `transcript.rs` and `structured_transcript.rs` onto main's JSONL index, with glue in `jsonl.rs`, `lib.rs`, node `structured.rs`, `protocol.ts`, `structured-validation.ts` and `dispatch.ts`. **The crash fix is at the root:** `limits::int` returns an error for an unknown field instead of panicking, and `RANGES` gains rows for the new fields, which the core host then validates too. **Fixes:** duplicate UUIDs never refuse the file (which copy wins is chosen from real sessions and written down); a sidechain-only file falls back to its latest leaf; a linear, cancellable `finish`; `slot(Work::Page)` in `Read<Q>`; per-entry estimates near real struct sizes. **Tests:** Rust unit tests for each fix; a core-host Vitest over the two synthetic fixtures that drives the page, tools and text queries. The lens stays hidden, since the renderer is still the stub | large | Opus, 2 rounds |
| 2 | **Transcript lens** | Port `transcript-view.ts` and its CSS, and wire it into renderer `structured.ts` and `ReaderCard.tsx`, replacing the stub. **Fixes:** a per-item failure catch, with a refused Markdown block shown as literal text; an HTML reservation sized to the mounted page and released on unmount; HTML-like tags literal per §5.4. The two snapshot e2e tests, with `ff85dc9` | decent–large | Opus, 2 rounds |
| 3 | **OpenAI and remote images** | Tool-call arguments parsed from their JSON string; line metadata showing only the other keys; remote `image_url` behind the §4.6 gate | decent | Opus, 2 rounds (security) |
| 4 | **Install** | Package main, install, open real sessions (subagent, duplicate-UUID and largest files included), record the payload hash | small | PM |

## Out of scope
- `catch_unwind` across typose-node. Main has the same exposure: a panic in any napi method kills the core host. It's a separate decision.
- Transcript Find, and Go to inside Transcript (M6).
- Mac/Linux qualification.

## Done when
PRs 1–4 have landed. On the installed build, Transcript opens main sessions, subagent sessions and the largest session without a crash, a whole-page failure, or a memory refusal from ordinary reading.
