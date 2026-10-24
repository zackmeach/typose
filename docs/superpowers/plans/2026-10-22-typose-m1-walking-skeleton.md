# Typose M1 · Walking skeleton: implementation plan

**Goal:** a hardened Electron + Rust app that opens a real file into Raw and scrolls it from the first PR, then grows into M1: the full Raw protocol, lifecycle, aggregate memory budget, title bars, single instance and CLI, and CI. Every PR leaves the app usable.

**M1 exit (spec §13.2 at `eb48e28`, verbatim):** "Open a 10GiB file into Raw within the §10.2 budgets, on an unsigned dev build (signing starts at M7, §15). Z34's aggregate accounting and enforcement, with a deterministic multi-document budget-exhaustion test [Z47]. Cold startup measured on the M1 app and within its targets [Z54, Z59]. No corresponding unexplained exit in the M1 baseline [Z56]. M1 stays open while Mac acceptance is pending [Z58]"

**Implements:**
- Tech design `docs/superpowers/specs/2026-10-20-typose-tech-design.md`, Draft 4 at `eb48e28`: §2, §3, §5.3, §6.3, §7, §8.1, §9, §10, §11, §13.2's M1 row and §15.
- Design brief rev 6: §3.1, §5.1, §7.9 and §8.
- The checkpoint decisions Z53–Z61, with the addendum at `docs/superpowers/plans/2026-10-22-phase0-decision-packet.md:529-564`.
- The agreed next steps in `<SP>\codex\reply1.md` and `reply2.md`, and the plan reviews `<SP>\m1rev\REVIEW.md` and `<SP>\codex\reply3.md`. `<SP>` is `C:\Users\zdm80\AppData\Local\Temp\claude\C--Users-zdm80-Typose\f692a7fc-20e8-46a2-87c8-8d44df3fa789\scratchpad`.

**Format:** a PR-granular plan, not a replayable program. Each PR ports tested spike logic from the cited file and lines, and its tests are written in the PR.
- **[Z#]** marks Zack's decisions. **Ruling** marks the coordinator's rulings, which Zack may veto (plan §7). Everything else is a proposal, open to veto.
- "Plan §N" refers to this document; a bare §N refers to the tech design.

## Global Constraints

- **Z24:** "No in-app updater in v1."
- **Z25:** "Electron + a Rust core. The core is a napi-rs addon hosted in an Electron `utilityProcess`."
- **Z26:** "React 19 + React Aria" for the chrome; "Lenses are framework-free DOM controllers built on a hand-rolled virtualizer that owns scroll mapping."
- **Z27:** "License: `MIT OR Apache-2.0`."
- **Z28:** Linux is "built and smoke-tested in CI, but the screen-reader and 60fps gates (§6.3, §10.2) apply to Windows and macOS only."
- **Z29:** the PC "gates at **half** of each budget"; the Apple-silicon Mac "gates at the **full** budgets."
- **Z34 🔒:** "document data across all open files stays within **25% of physical RAM**. That includes indexes, caches and temporary parsing allocations."
- **Z37:** "Raw first screen means the first bounded piece is visible and usable, with continuation available while scanning proceeds. The 50ms PC target applies to that view."
- **Z39:** "Automated accessibility stays required: ARIA semantics, axe, accessibility-tree reads (UIA/CDP), keyboard and focus gates, and performance with accessibility mode on." Make no screen-reader support claim.
- **Z41:** spike code is preserved as local, unmerged branches, and the tested lockfiles are "never regenerated in transfer." That binds the spike branches, not the product: the product's lockfiles are a fresh resolve. Spike branches stay local and are never pushed.
- **Z47:** "M1 reserves and accounts across documents and concurrent builds, releases on close, cancellation and failure, and keeps enough capacity for Raw to stay usable. It closes with a deterministic multi-document budget-exhaustion test."
- **Z49:** "Quiet machine: no other heavy work or agent lanes; the CPU under 10% for a minute before each timing run, with load recorded during it; Defender on." Batches run separately. "Every failed or invalid run is kept with its reason."
- **Z52:** A far jump is scrolling under §10.2's "no stall > 50ms" rule: a scrollbar jump, an Outline jump, or open-then-scroll.
- **Z53:** M1 is authorized despite the failed and pending gates, which keep that status (or "parked"). This authorizes "implementation, not a release."
- **Z54:** "Cold startup is measured on the M1 app, early enough to inform its implementation. The **< 200ms PC / < 400ms Mac** targets stay." Measure "one fixed build and layout, launched first after each of five restarts." "A miss stays a miss."
- **Z55:** Mac access is "an Apple-silicon Mac under Zack's control." "The friend's Mac may bridge an initial batch." "Mac-dependent acceptance stays pending until measured."
- **Z56 conditions:** "Memory enforcement and its tests remain mandatory for M1 closure." "A corresponding unexplained exit in M1 blocks M1 closure." "Performance failures stay failures."
- **Z57:** "the implementer merges each PR once its review is clean and CI is green, within an approved milestone plan."
- **Z58:** "M1 stays open while its Mac acceptance is pending [Z55]. It doesn't close on Windows alone."
- **Z59:** "A missed cold-startup target blocks M1 closure until it's fixed or Zack explicitly changes the budget."
- **Z60:** "Windows and Linux run on every PR; macOS runs on merges to `main`, until the repo goes public."
- **Z61:** "No spending until after launch, once Typose is working." Actions "stay within the included minutes, with a $0 spending limit, so overage pauses CI rather than billing"; "A loaned or borrowed Mac only [Z55]; nothing is bought"; "No paid subscriptions."
- **§3.6 (since `bc76cfb`):** per-format caps "are the stop mechanism. They don't enforce the budget"; "Enforcement is the byte-accounted ledger [Z47]."
- **Spec 🔒 (binding, not Z):**
  - positional reads, "No memory-mapping on any OS in v1", and the default share modes on Windows (§3.3);
  - chunk verification (§3.1); every Raw slice "carries its starting byte offset and a byte map", and "The renderer never re-encodes text to find offsets" (§3.2);
  - the renderer never reads files, uses Node or opens URLs (§2.1); "Typose issues no requests," and `crashReporter` keeps minidumps locally only (§7.3).
- **Spec values:**
  - pages "capped at **256KiB**"; no item "exceeds **64KiB of text**"; "At most **2 outstanding viewport requests per lens**"; requests coalesced to "one per animation frame" (§3.4);
  - checkpoints every "1,024 units **or 1MiB of bytes**" (§3.5); native scrolling "Up to **16M px**" (§5.3).
- **§10.2 budgets** are enumerated per platform, fixture and cache state in plan §5.
- **Repo:** `origin` is https://github.com/zackmeach/typose, private until launch and public at launch. Work merges through GitHub PRs against `main`.
- **Toolchain (§2.2):** Node 24, npm 11, Rust 1.96. No pnpm or bun.

## 1. Prerequisites and owner questions

**Settled or verified:**
- **Remote:** `git remote -v` shows `origin`. `gh repo view zackmeach/typose` reports `PRIVATE` with default branch `main`. The `gh` token has the `gist`, `read:org`, `repo` and `workflow` scopes, and no `user` scope (PR 2).
- **Toolchain:** `node v24.15.0`, `npm 11.12.1` and `rustc 1.96.0` are installed. The pins are listed in PR 1.
  - Electron 44 is within one major of current stable (§7.1): on 2026-10-22, npm's `latest` for `electron` is 45.0.0 (published 2026-10-21), and PR 1 pins 44.9.2.
- **Port sources, frozen at the checkpoint (`eb48e28`).** Plans B and C are frozen, not closed, at `docs/superpowers/plans/2026-10-20-typose-phase0-spike-{b,c}.md`. The local branches peel to their tags `phase0-snap2/*` (`.evidence/phase0/snap2/MANIFEST.md:24-28`):
  - `spike/a` = `ce114fc`;
  - `spike/b` = `d83508b`, whose `spikes/app/perf/spike-b1.e2e.ts` is the G4 diagnostics harness (sha256 `e255bee1…`);
  - `spike/c` = `766e158`, whose `spikes/core/spike-core/src/budget.rs` has sha256 `c3cc284c…`.
  - Every `spike/c` citation below was re-checked at `766e158`.
- **Evidence:** `.evidence/phase0/snap2/` now holds the formerly scratch-only sources (snap2 MANIFEST:39-53): the plan B and C rev3 reviews and logs, `planb/asm/tools/trace-frames.mjs` (`e0855601…`), and both port sources above. Snapshot 1 is unchanged.

**Owner questions:** none open. CI is Z60 within Z61's free minutes, and merge authority is Z57, which governs PR 1 too (plan §7). **Owner action before hosted CI:** verify the stopping control (PR 1, PR 2).

## 2. Contracts M1 must settle

### C1 · Byte-accounted aggregate memory budget (Z34, Z47, Z56)

**Ledger.** One process-wide ledger in `typose-core`. `limit = floor(totalmem / 4)`: the core host passes `os.totalmem()`, validated under C4 (`spike/c budget.rs:7-32` is the fallback reference).

**Charge before allocation; release on ownership.** This is the obligation. Every allocation of document data is reserved before it's made. A reservation is released only when its owner drops the memory or its consumer is done with it, never when a call returns.
- Predicting `Vec` growth isn't enough: `try_reserve_exact` doesn't promise an exact capacity. The ported decoder, map builder and checkpoint publisher also allocate on their own (`spike/c encoding.rs:77-86`, `bytemap.rs:83-86`, `index.rs:119-121`).
- *Candidate implementations, chosen in PR 6:*
  - budget-owning buffers that reserve first, then allocate exactly that size;
  - fixed-size chunks for growing tables (checkpoints, chunk hashes), so publication moves chunks instead of briefly holding two vectors;
  - buffers pre-sized from C2's bounds for per-request text and maps.
- Metadata (the path, freeze reasons) is charged by allocated capacity.

**What is charged:**
- **Per document:**
  - chunk hashes, with a "seen" bit, since 0 is a valid xxh3 (the spike's `HashMap` is at `spike/a store.rs:22`);
  - checkpoints, 24 B each (`spike/a index.rs:10-15`; `spike/c :12-17`);
  - the chunk cache, up to 64 × 1 MiB (`store.rs:12`);
  - metadata.
- **Per index job:** the 4 MiB block buffer (`index.rs:26`, `:146`).
- **Per page request,** each representation separately, for as long as it exists:
  - (a) the read buffer;
  - (b) the Rust text and map;
  - (c) the core host's JS page object;
  - (d) the queued structured-clone copy;
  - (e) the renderer's received copy, until it enters the cache.

  (a) and (b) are released when the Rust task drops them. The obligation to charge (c), (d) and (e) stands, but how they're released is a **PR 6 hypothesis, not a guarantee**:
  - (c)–(e) are released when the renderer acknowledges the page;
  - a fixed GC-slack reservation, one extra in-flight set, covers JS memory that V8 hasn't collected yet.

  PR 6 tests both and amends them if they don't hold. The sum is `PAGE_TEMP_MAX`, a temporary-memory bound kept separate from C2's wire bound, `PAGE_WIRE_MAX`.
- **Renderer cache:** capped in *charged bytes*: 2 × UTF-16 units + the map's `byteLength`, with mounted items counted twice for their DOM copy.
  - The cap is sized at mount: mounted rows (visible + 2 × overscan) × 2 × (2 × 65,536 + `MAP_MAX`), plus an elastic part. It's re-reserved through `grow` on resize.
  - A refused `grow` shrinks the elastic part, then the overscan, and never blanks a visible row.
  - The core reserves the cap (§3.6's "renderer-side caches the core is told about"). The renderer reports its charged total in debug stats.
  - Overscan follows §5.3, or the deviation is recorded. The spike used 10 rows (`virtual-list.ts:71`) and kept 4,000 items of up to 64 KiB (`lens-view.ts:21`).

**Raw floor (Z47's "enough capacity for Raw to stay usable"):**
- At open, a document reserves:
  - its hashes: ⌈len / 1 MiB⌉ × 8 B, plus the seen bits;
  - the **whole** byte-bound checkpoint table, including the initial checkpoint: (⌈len / 1 MiB⌉ + 1) × 24 B;
  - a 4-chunk cache minimum.

  For a 10 GiB file that's about **4.31 MiB**, before the global pool and the renderer cache.
- Future checkpoint capacity is reserved at open and is unavailable to elastic consumers.
- Each mounted lens adds its cache cap.
- Transient work (index buffers, page temporaries) is reserved before it runs, and queues when it can't be. *Candidate:* a global pool, reserved at startup, holding 2 index buffers and `UV_THREADPOOL_SIZE` (default 4) × `PAGE_TEMP_MAX`.
- If the floor can't be reserved, open fails with the memory reason and the ledger doesn't change.

**Elastic structures** stop growing at the limit rather than failing:
- The 1,024-line checkpoints stop being added; the byte-bound checkpoints alone keep every rescan ≤ 1 MiB (§3.5).
- Caches shrink to the floor.
- M3/M4's heavy lenses estimate first and stay locked with the reason (§3.6).

**Bytes, not unit counts.** A count cap limits units, not the bytes each unit holds. Spike C's block cap missed heading text and reference definitions (plan C rev3 MAJOR A, `snap2/planc/rev3/REVIEW.md:33-75`).

**Acceptance:**
- **Live ≤ reserved, at every allocation.**
  - A counting `#[global_allocator]` in a single-test binary (`harness = false`; every thread is counted) checks on each allocation that live bytes above the post-init baseline are ≤ the ledger's *current* reservations. That's a contemporaneous comparison, not a peak against a high-water mark, which could hide an uncharged allocation behind an earlier reservation.
  - Shapes: a long path; all-newline, all-CJK, all-malformed and UTF-16 surrogate content; one 1 GiB line; 8 concurrent `page()` calls with the cache at its floor.
  - Negative control: dropping the checkpoint table's charge fails the test.
- **Deterministic multi-document exhaustion test,** with the `test-hooks` budget override (C4, m8) and generated fixtures:
  - Open documents and index them one at a time under the override, so saturation lands at the same point each cycle.
  - Every open document still shows Raw's first screen, jumps to its last line and fetches pages.
  - The next open is refused with `memory`, and the ledger doesn't change.
  - Cancel one index mid-run and inject a truncation in another; see C6 for what each releases.
  - Close all. The ledger returns to its byte-exact baseline, with 0 jobs and 0 live documents (debug stats).
  - Run 3 cycles. Each document's floor, the high-water mark and the post-close baseline are identical. After a forced GC (test build), the core host's private bytes differ by ≤ 16 MiB between cycles 2 and 3.
- **Renderer side:**
  - A vitest test checks that the cache's charged total never exceeds its cap, driven with 64 KiB all-CJK items.
  - An e2e scrolls 10 viewports of 64 KiB all-CJK lines in a 2160 px-tall window (or the tallest the rig allows, recorded). The renderer's private bytes rise by ≤ the reservation + 32 MiB.
- **Rust unit test:** threaded reserve and release never overshoots.

### C2 · Page-cap units (lands in PR 1)

**Three bounds per page:**
- **Source bytes:** an item covers ≤ 65,536 source bytes, excluding its line terminator; a page covers ≤ 262,144. The first item always fits.
- **Item count:** a page holds ≤ `MAX_ITEMS` items (proposal: 1,024). Empty lines count zero bytes but still cost an item object and a map: the port adds nothing to `page_bytes` for them (`spike/c pages.rs:42-51`). So without a count bound, the wire bound has no derivation.
- **Wire size:** PR 1 derives `PAGE_WIRE_MAX` from its actual page representation.
  - The product of the maximums (`MAX_ITEMS` × the largest per-item map) is a valid but loose bound: the 256 KiB source cap stops all items reaching maximum-sized maps together.
  - Nothing preallocates from it.

The spike's Raw counted source bytes (`spike/a pages.rs:43,58`); its other lenses counted different units (packet:515). This contract fixes the units before M3 adds lenses.

**Wire format:** each `page` item carries `{gen, line, offset, text, map}`, with the byte map as typed arrays (§3.2 🔒).
- Every source byte decodes to at most one UTF-16 unit, and a BOM or dropped `\r` decodes to none.
- `MAP_MAX`, `MAX_ITEMS` and `PAGE_WIRE_MAX` are defined in Rust and exported.

**Acceptance:**
- A Rust proptest over UTF-8, malformed UTF-8, Windows-1252 and UTF-16LE/BE asserts, for every item and page, that the byte and count caps hold and text units ≤ source bytes.
- A Node test `v8.serialize`s the largest generated pages and asserts each `byteLength` ≤ `PAGE_WIRE_MAX`. The shapes: all-CJK, all-malformed, alternating ASCII/2-byte, UTF-16 surrogates, **all-empty**, and **alternating empty/one-character** lines.
- An e2e asserts that no mounted item's text exceeds 64 KiB (§13.1). The gutter and continuation marker are excluded; the spike's `maxText` was 65,539 (`AMEND.md:135`).

### C3 · Generation-checked, character-safe continuations

**Cut rule.** A piece ends at an element boundary at or before start + 65,536.
- Element boundaries are the ones the decoder produces for the *whole line*, including its malformed-sequence segmentation (the `encoding_rs` loop at `spike/c encoding.rs:52-100`).
- The cutting algorithm is chosen in implementation. A truncated prefix decoded as end-of-input can manufacture a boundary: the port passes `last = true` (`encoding.rs:82`), so `E2 82 | AC` would end in a U+FFFD that the whole line doesn't have.
- The spike cut at the raw byte, which produces false U+FFFD on both sides, splits surrogate pairs and garbles odd UTF-16 offsets (`spike/a pages.rs:72-79`; `spike/c pages.rs:75-87`; plan A:3617).

**Token.** The core issues `{session, gen, line, offset}` (session per C7), and the renderer only echoes it. On receipt the core checks:
- that the session and `gen` are current, else `Stale`;
- that `offset` lies within the line's known bytes;
- that `is_cut(offset)` holds, using the same segmentation that issued the cut.

The spike trusted the caller's offset and clamped negatives to 0 (`spike/a spike-node/src/lib.rs:117`).

**Acceptance:**
- A proptest across all five encodings, malformed and astral text included, with a test-only small piece size. Every line's pieces, concatenated, equal the whole line's decode: the same text, the same replacement count, and contiguous maps.
- A forged-token table: a mid-sequence offset, an odd UTF-16 offset, another line's offset, an offset past the end, an old `gen`, and a non-integer. Each is refused with a typed error.
- After Ctrl+R, every old token returns `Stale`, and the renderer drops it.

### C4 · Validated numeric inputs at every boundary

**Boundaries:** preload → main; renderer → core host; core host → napi; and env, config and test hooks. Every PR that adds a protocol method, preload API or hook extends C4's table to it.

**Rule:** a numeric input is a JS number with `Number.isSafeInteger` true and within its declared `[min, max]`. It's checked before any conversion and never clamped or wrapped.

**Defects this fixes:**
- napi `u32` wraps, so `1e12` and `2^32` passed `cap()` (plan C rev3 MINOR B, `REVIEW.md:77-102`).
- The spike took `count: u32` and clamped `start.max(0)` (`spike/a spike-node/src/lib.rs:104-106`).
- Its dispatcher's `handlers[method]` (`spike/a core-host.ts:31`) resolves `toString` and `constructor` from `Object.prototype`.

**Fix:**
- Dispatch on own properties only.
- Protocol types are generated from Rust (§3.4) by napi-rs's own typegen: the addon's `index.d.ts`, which the core host and the renderer typecheck against. The `[min, max]` table is defined once in Rust (`limits::RANGES`) and reaches the core host at runtime through the addon (`limits()`), so there's no generated copy to go stale. *(Amended in PR 1, plan §7.)*
- napi signatures take `f64` for every caller-controlled number, never `u32` or `i64`. napi-rs's `i64` goes through `napi_get_value_int64`, which maps NaN and ±Infinity to 0, truncates fractions and saturates 1e20 (`m1rev` P1). Rust re-checks `x.is_finite() && x.fract() == 0.0 && (min..=max).contains(&x)` before any cast.

**Acceptance:**
- A table-driven test runs each numeric param against NaN, ±Infinity, −1, 0.5, 2^32, 2^32+1, 2^53, 1e12, `"1"`, `null`, missing, max+1, min and max.
- Invalid values give `InvalidParams` naming the field, with no state change and no addon call (a spy checks this). Valid values are accepted.
- The same table runs against the napi layer directly. The method names `__proto__`, `constructor` and `toString` give `UnknownMethod`.

### C5 · Stale-request cancellation (§3.4)

**Mechanics:** `page` runs as an async napi task with its own cancel flag, checked before each chunk read and between items. The core host's JS thread stays free, so `cancel(id)` arrives while the task runs. The spike's calls were synchronous (`spike/a core-host.ts:28-37`) and never cancelled (plan A:3616).

**Renderer (`DocHandle`):** keeps ≤ 2 outstanding requests per lens, coalesced to one per frame (port `lens-view.ts:47-61`). It cancels the oldest request whose range no longer meets the wanted range, and ignores late results. *(Amended in PR 5: it cancels every such request, and the lens's own request loop is the `DocHandle` until a second lens needs one; plan §7.)*

**Acceptance:** with the `test-hooks` per-read delay (m8), jump far every frame for 2 s.
- Outstanding requests stay ≤ 2 per lens throughout (debug stats).
- Every superseded request ends `Cancelled` within one chunk read of its cancel. *(Amended in PR 5: superseded means cancelled while its read runs; plan §7.)* *(After PR 5's macOS run: one chunk read as the machine times it; plan §7.)*
- The final viewport's page arrives, and 0 tasks are running after the view settles.

### C6 · Close, freeze and failure: what each releases

**Close releases everything.** `close(doc)` cancels the index job and in-flight pages, drops the `Document` (closing its handle), and returns every reservation the document holds.
- The spike's `close` only deleted a map entry, and its index thread ran on (`spike/a core-host.ts:26`, `spike-node/src/lib.rs:77-99`; plan A:3620).
- Reuse `spawn_job`/`Job.cancel` (`spike/c spike-node/src/lib.rs:309-378`) and `startJob` (`core-host.ts:33-43`).
- **New code, not a port:** a cancel flag in `index::build`, checked once per 4 MiB block. *(PR 4: the per-block check is `build`'s progress callback, which the freeze half already stops through; plan §7.)*
  - `spike/c`'s `build` takes no flag (`index.rs:146-153`).
  - Raw's `start_index` spawns a bare thread (`lib.rs:84-111`).
  - `close` cancels only Markdown jobs (`core-host.ts:100-104`).

**Freeze releases work and transients, and keeps charged state.** A change mid-index, an I/O error or a failed chunk check:
- ends the index job with an error event;
- cancels in-flight pages;
- returns the transient reservations.

The document keeps its explicitly charged state (its floor, checkpoints, hashes, cache and metadata) until close or Reload, as the ported `Document` keeps its store and frozen reason (`spike/c doc.rs:74-81,139-153`). Raw keeps showing what it has.

**Acceptance:**
- Close mid-index on the 10 GiB fixture: the job stops within 50 ms (proposal, from Spike C's cancel gate, §13.1). The ledger returns to baseline, with 0 jobs, 0 tasks and 0 handles for that document. *(Amended in PR 5: the ledger clauses here are checked from PR 6, which builds the ledger; plan §7.)*
- Truncate a file mid-index: the error event arrives, the document freezes, and 0 jobs and 0 tasks remain.
  - The ledger equals the baseline plus exactly that document's retained charges, as debug stats itemize them.
  - A later close returns it to baseline.

### C7 · When the core process dies

**Main:**
- Logs the utility process's `exit` and `child-process-gone`, and sends `core-gone` to the renderer.
- Respawns the core once per 60 s.
- **Sessions:** each spawn is a session with an id from main. On a death, main tears down the old port (closes both ends and removes its listeners), then hands the renderer a new one. The renderer accepts a port only from `event.source === window`. The spike posted with `'*'` and accepted the first matching message (`spike/a preload/index.ts:4-6`, `renderer/src/core.ts:13-15`).
- Every handle, continuation token and callback carries `{session, doc, gen}`, and the renderer drops anything from an old session. Generation alone can't tell sessions apart: document ids restart at 1 in a new core host (`spike/c core-host.ts:12`), and Reopen starts again at generation 1.

**Renderer:**
- Rejects every pending call with `CoreGone`. The spike's `pending` map is never rejected (`core.ts:18-29`).
- Discards cached text, since the hash tables died with the core, and shows each card as "Typose's core stopped · Reopen".

**Reopen:**
- Reopen opens the path again in the new session, as a new document at generation 1, at the same line. There's no automatic reopen in M1.
- After a second death within 60 s, the core isn't respawned and the app shows the stopped state. Once 60 s have passed, Reopen respawns the core (proposal, plan §7). *(Amended in PR 5: main respawns it then, and the card offers Reopen; plan §7.)*

**Acceptance:** kill the core host by its pid while idle, during a pending page, and mid-index on 10 GiB.
- Every pending promise rejects with `CoreGone` within 1 s, with no unhandled rejection.
- Main stays alive, and the log records the exit code and reason.
- Reopen restores the line. A second kill within 60 s leaves the app in the stopped state.
- A page and a progress event from the old session, delayed (`test-hooks`) until after Reopen, are rejected, and the reopened view is unchanged. *(PR 5: the hook holds them on their way into the renderer's client; plan §7.)*

### C8 · The perf instruments, reconciled with §10.2

**The mismatch:** the spike judged rAF intervals over 20 ms (`spike/a perf.ts:16`; plan A:3613). §10.2 requires "≥ 99% of frames < 16.7ms, no stall > 50ms," and §10.3 names Chromium tracing. `trace-frames.mjs` (snap2) is diagnostic only: it reads `FireAnimationFrame` gaps on the renderer main thread (`:39-49`), not presentation. C8 is new code.

**Frames (from a Chromium trace taken over CDP's `Tracing` domain on the fused build; amended in PR 3, plan §7):**
- **Demanded frames:** a frame is demanded from an input (a wheel, a key, a scrollbar drag, a jump, an open, a click that expands a long line) until the view settles, meaning the scroll has stopped and the target rows have painted. Idle time isn't demanded, so an idle tail is never a gap.
  - Concretely: an input demands frames from its own timestamp until its answer (below). Overlapping demands merge, so a continuous gesture is one demanded interval.
  - **Only an input that changes the view opens a demanded interval** (the coordinator's ruling, PR 9). An input whose first mark is a later input's had nothing of its own on screen before that input came: a scrollbar pointerdown before the drag's `scroll`, or Control before End. It's folded into the later input, so it doesn't open or anchor the interval. It's still timed to the answer of the mark it folded into, and judged on responsiveness like any input (the coordinator's round-5 ruling), except a folded pointerdown. That one's latency is reported apart (`foldedToPaint`), not judged (ruling A, round 6).
  - A scroll event the list caused itself isn't an input (PR 9). That covers a wheel or key in logical mode, whose own mark is the input, and the position re-applied as the index grows, which no one asked for.
  - An input that changes nothing on screen (its painted mark repeats the previous one) owes no frame. It's timed to its mark and reported apart (`unanswered`), outside the latency figure, and it's a stall if its mark comes over 50 ms after the input.
  - **Every trace begins with a baseline mark** (PR 9): the view as it stands, marked painted as sequence 0 when tracing starts (`typose:baseline`). So the trace's first input is judged against it; without it, an input that changed nothing, but was the trace's first mark, read as a change.
- **Presented frames:** the renderer's `PipelineReporter` slices whose state is `STATE_PRESENTED_ALL`, at their end. A `STATE_PRESENTED_PARTIAL` frame (a compositor-only update, such as the scrollbar thumb moving, shown while the main thread's update is still pending) shows stale rows, so it doesn't end a gap.
  - One present is one frame. Two `STATE_PRESENTED_ALL` slices, for different `frame_sequence`s, can end at the same timestamp. The earlier sequence often also has a slice of type `FORKED`. Why Chromium reports one present twice is unverified. The present counts once, begun when its earliest slice began.
- **Frame rule (ruling OQ-6, scoped by Z62): the 16.7 ms / ≥ 99% gate judges cadence.** Within each merged demanded interval, every presented frame after the first is judged on its gap from the presented frame before it, and passes if that gap is < 16.7 ms. That's §10.2's absolute threshold, at the panel's native refresh (164 Hz on the PC, `snap1/lanes/b2/REPORT.md:60`; Electron reports 165), with the Hz recorded.
  - **A merged interval's frames start at its first answer** (the coordinator's ruling, PR 9). Presents between an input and its answer are compositor or pipeline frames that can't carry the response, and the input's latency already covers that span. Later inputs' answers in a continuous gesture are ordinary cadence frames.
  - Every present after the first answer counts in the ≥ 99% denominator. None is exempt.
  - The answer itself isn't judged on cadence. It's judged by responsiveness.
  - A run where no interval has a present after its first answer reports cadence as `n/a`, never as passed. That's a run of discrete keypresses, each answered by one frame. Responsiveness is still judged.
- **Responsiveness (Z62):** each input that changes the view is timed from its own timestamp to its answer (input → target paint, below). Over 50 ms it's a stall, and plan §5's input-latency gate (< 50 ms) applies. Every run records the distribution over these answered inputs: n, p50, p95 and max.
  - **The answer is the frame that owns the input's paint** (the coordinator's ruling, PR 9): the `STATE_PRESENTED_ALL` slice of the frame whose main-thread `AnimationFrame` contains the painted mark, where `begin_frame_id.sequence_number` matches the `PipelineReporter`'s `frame_sequence` (and source). The mark fires inside its own frame, which began before it.
  - If that frame never presents (dropped, or partial only), the answer is the next presented frame after it, which carries the change. Runs count these (`ownerUnpresented`).
  - If that frame had no update to present (`STATE_NO_UPDATE_DESIRED`, with no presented slice), the input changed nothing on screen, whatever its key says (the coordinator's round-5 ruling). It's timed to its mark and reported apart (`unanswered`). While indexing, the row count in Raw's key grows between marks.
  - A trace is invalid with that reason when the answer can't be told: no `AnimationFrame` around a mark, one from another process, or an owning frame presented before the mark. The answer is never guessed.
  - The next present after an input, or after its paint, isn't its answer. While frames flow, it comes within a refresh, whatever it shows.
- **Stalls:** an open-then-scroll interval starts at the open request, and plan §5's input-latency gate (< 50 ms) stands beside all three kinds. A stall is any of these:
  - a presentation interval over 50 ms inside a demanded interval;
  - an input answered over 50 ms after its own timestamp;
  - an input that changes nothing, marked over 50 ms after it.
- **Validity:** a trace that can't be judged is invalid, with its reason kept (Z49). It reports cadence and responsiveness as `invalid`, never as passed. That's a trace with:
  - no renderer frames, or more than one renderer;
  - no input marks;
  - nothing demanded (every input changed nothing);
  - a demanded interval with no presented frame;
  - a paint mark whose answer can't be told (above).
- **Input → target paint:** for each input that changes the view, a jump included, measured from the input's timestamp to the presented frame that contains the target rows: the frame that owns the renderer's painted mark (above).
  - An input whose target never paints within 1 s fails.
  - It's the responsiveness latency above.
  - Raw's painted mark keys the view by its scroll position and row count, which grows as a long line's pieces expand (C3). It comes once every row in the viewport has its text, whether that's a line's first piece or a further one. Once a freeze's banner is up, the view is settled as it stands, and rows that never got their text stay blank.
- PR 3 pins the trace events to the Electron version: `PipelineReporter`, the renderer's `console.timeStamp` marks (`TimeStamp`), and (from PR 9) the main thread's `AnimationFrame` on Electron 44.9.2 (`e2e/perf/frames.mjs`). rAF figures are printed beside them and not judged.

**Startup (amended in PR 3, plan §7):** `shellVisible` is when the title bar reaches the screen: its first presentation after main's `show` event, on the wall clock. It's never `show` itself.
- That's `titlebarPresented` (Element Timing's `renderTime` for the title-bar text) when it comes after `show`.
- When the title bar was first presented to the still-hidden window, it's `shownPresented`: the presentation of the first frame after the show. Under the TYPOSE_MARKS hook only, main tells the page it has shown, and the page puts in a one-character probe in the background colour, outside React's root, and reads that probe's Element Timing.
- A run that can't establish a presentation after `show` is invalid, with its reason (Z49).
- PR 3's control settled the UNVERIFIED point: on Electron 44, `show` doesn't mark on-screen display. `titlebarPainted` (React's first title-bar commit, then rAF + task) is still recorded, for the cost breakdown.
- The page's own first frame is `typose:first-frame` on the renderer's User Timing timeline: a rAF scheduled when the bundle evaluates. Z37's first-screen gate starts its clock no earlier (Z64), since a page that can't paint yet is this section's problem, not the lens's. A run whose scan ends inside the budget from that start is not judged: that fails on Windows and macOS, and is logged on Linux (Z28).

**Acceptance,** with accessibility on and off:
- An injected 30 ms busy-wait during a scroll registers a long frame covering it, and no cadence stall. Its responsiveness is recorded as measured, not asserted: the block adds onto one input's answer. (Amended in PR 3.)
- A control scroll registers no stall and passes cadence (the ≥ 99% rule) and responsiveness, and every long frame it registers is listed. (Amended in PR 3.)
- The keypress control (21 discrete ArrowDown presses, no injection) passes responsiveness and reports cadence as `n/a` in 10 of 10 live runs, with accessibility on and with it off (Z62).
- A 60 ms busy-wait is **detected**: at least one stall covers the injection window. That holds during a scroll, in the handler of one discrete keypress (Z62), and in the first frame after a scrollbar jump.
  - During a scroll, the stall that covers it is a cadence stall. So the 30 ms control's assertion fails once its injection is 60 ms.
  - The test doesn't require exactly one stall under every scheduling outcome.
  - "Covers": the stall runs past the injection's end, and the work behind it began before the injection did. That's the frame that opens a gap, or the input whose first frame is late (Z62). A frame already in the pipeline still presents during the block. (Amended in PR 3.)
- A jump whose target rendering is suppressed fails as never painted. The test driver drops the page requests over CDP, so no hook is needed. (Amended in PR 3.)
- Expanding a long line is an input answered when its further pieces show, and a freeze is answered by its banner. Neither is judged a no-change or left unpainted. (Added in PR 3's merge with PR 4.)
- Startup controls, on the test-hooks build (amended in PR 3):
  - every run, delayed or not, is valid: it establishes the title bar's presentation after the show;
  - in each run that delays `show()` by 300 ms after both `ready-to-show` and `titlebarPainted`, that presentation lands ≥ 300 ms after the later of the two;
  - in each run that delays React's mount by 300 ms, it lands ≥ 300 ms after the bundle's evaluation, where the delay starts;
  - the two ≥ 300 ms checks hold by construction in any valid run:
    - a delayed `show()` fires 300 ms after the later of the two, and the presentation comes after the show;
    - a delayed mount can't present the title bar before it mounts;
    - so the checks only catch a mark that regresses to before the delay. "Every run is valid" is what tests the instrument;
  - medians against undelayed runs are recorded, not judged;
  - in startup traces, `titlebarPresented` (the app's own path) and `shownPresented` (with `show()` delayed) each coincide with one of the window's `Display::FrameDisplayed` frames, to within one refresh, after the show.

### C9 · Crash and lifecycle diagnostics, from PR 1

**Main** calls `crashReporter.start({ uploadToServer: false })` before anything else (§7.3). Plan B armed the same call after launch, via `app.evaluate` (`spike/b spikes/app/perf/spike-b1.e2e.ts:35`).
- A bounded lifecycle log, `userData/logs/lifecycle.jsonl` (rotated at 1 MiB, 2 kept), records:
  - start (version and pid), `ready` and the page's `did-finish-load` (plan §7), window shown and utility `exit`;
  - `child-process-gone` and `render-process-gone`, with every field;
  - `unresponsive` and `responsive`;
  - `before-quit`, `will-quit` and `quit` with its code, and `uncaughtException`.
- A `running` marker, written per pid (or only after PR 8's single-instance lock) and removed at `quit`, lets the next launch log "previous run ended without quit" and list any new dumps. With per-pid markers, a second instance's `quit` can't clear the first one's.

**The harness:**
- Records the main process's externally observed exit status, as plan B did (`spike-b1.e2e.ts:30,158-162`). It ports that capability, not every handler (reply2.md:23).
- Copies `lifecycle.jsonl` and any new dumps into each run's results; CI keeps them per PR 2's retention rules.
- Kills a launch whose window never comes, or that hasn't exited 15 s after its close, keeps its evidence, and fails the test (plan §7).
- **Invalid runs, not crashes:** a superseded run, or an infrastructure interruption with evidence (a runner shutdown or a lost runner, with the platform's record), is kept as invalid with its reason (Z49). An application timeout isn't invalid: it stays a failure that needs explaining.
- **A kill by a second launch (Windows):** a main exit with code 2, with no quit sequence logged, followed by `previous-run-unclean` at the next launch. The exit is told apart, not explained: main didn't answer for about 15 s, and the hang is the failure to explain (Z56). *(Added in PR 8, plan §7.)*

**Acceptance:** four controlled failures, each told apart by the log and exit status alone, as in plan B rev3 `REVIEW.md:126-128`:
- a window close: a clean quit sequence, exit 0;
- `forcefullyCrashRenderer()`: `render-process-gone` with `crashed` (`killed` on macOS, plan §7);
- a core kill, per C7;
- an armed `process.crash()` in main: an external exit of 0xC0000005 on Windows, a Crashpad dump, and the unclean marker at the next launch.

The NetLog assertion also passes with the reporter armed. Classification is evidence for plan §5's exit rule, not an explanation.

### C10 · Product typecheck

`npm run check` runs `tsc --noEmit` on every TS project (main, preload, core-host, renderer, shared and e2e), then `vitest`. CI runs it on every PR from PR 1. The spike only transpiled its TypeScript (plan A:3625).

**Acceptance:** green at PR 1. A deliberate type error planted in each project fails `check`; the reviewer runs that negative control once.

## 3. PR sequence

**Sizes:** tiny, small, decent, large.

**Review tiers:**
- **Low:** a quick read.
- **Medium:** one executed adversarial review (the `adversarial-reviewer` agent, Opus), which opens every cited file and runs the PR's negative controls.
- **High:** the same, with a named lens.

**Review rounds (ruling):** at most 2 general rounds per PR. After that, only fix-verification of concrete remaining defects.

Each PR's tests land in that PR, and every PR extends C4's table to what it adds. Spike branches are read with `git show <branch>:<path>`, never checked out or merged. Every PR merges under Z57: a clean review and green CI.

### PR 1 · Open a real file into Raw (large, high: security and lifecycle)

**Scope:**
- The §2.2 layout (`core/{typose-core,typose-node}`, `app/{main,core-host,renderer,shared}`, `e2e/`), plus `app/preload/`, which §2.2 doesn't list. npm and cargo workspaces, electron-vite and strict TS (C10).
- **Opening and reading:**
  - Open a file by argv or an **Open file…** button in the empty card.
  - Raw shows it, scrolls natively ≤ 16M px and logically above that, and tracks indexing progress.
  - **Wide lines scroll horizontally:** a horizontal scrollbar, Shift+wheel and Left/Right/Home/End. The spike's `overflow-x: hidden` and per-row ellipsis (`spike/a style.css:12-14`) aren't ported. Wrapping stays deferred to M4.
- **Protocol v1 envelope,** with types generated from Rust: a version handshake, session-scoped ids (C7), typed errors, the calls `open` (which returns `firstPage`), `page(doc, 'raw', window)` and `close`, and `progress` events. Page acknowledgements come in PR 6 (C1).
- **C2 in full:** byte, count and wire bounds, with typed-array byte maps (§3.2 🔒).
- C4 at every boundary this PR introduces, C9's diagnostics, and C7's rejection path (respawn comes in PR 5).
- **Minimal CI (Z57, Z60):**
  - `pr.yml` runs on `windows-latest` and `ubuntu-latest` for every non-draft PR (`if: github.event.pull_request.draft == false`), so drafts don't spend. It runs the napi build, `cargo test`, `npm run check`, and the e2e smoke run plus the NetLog assertion.
  - Linux runs under xvfb with `kernel.apparmor_restrict_unprivileged_userns=0`, never `--no-sandbox`; that sysctl is UNVERIFIED on the current image.
  - **Hosted CI waits for a verified stopping control [Z61].** Zack verifies that the $0 limit stops billing, or that free capacity is verified, before any hosted run. Until then PR 1 stays a draft, so it stays unmerged under Z57. Local development isn't blocked.
  - `main-macos.yml` runs the same on `macos-latest` for merges to `main`.
  - PR 2 hardens both.
- **Build dependencies:**
  - **The napi build:** the addon is a separate npm package built by `@napi-rs/cli` 3.10.8 (`spike/a spike-node/package.json:9-12`). It generates the `index.d.ts`/`index.js` that `tsc --noEmit` on the core host needs, so `npm run check` runs after the napi build, locally and in CI.
  - **Builds:** a release addon. The `test-hooks` addon (m8) arrives with the first behaviour-changing hook, in PR 5. *(Amended in PR 1, plan §7.)*
  - **C4's range table**, defined in Rust and read from the addon at runtime. *(Amended in PR 1: no generator, so no staleness check.)*
  - **electron-vite:** explicit entries for the §2.2 layout, and `?modulePath` for the core host. The spike's config is empty and assumes `src/{main,preload,renderer}` (`spike/a electron.vite.config.ts:3-7`).
  - **Dev mode** loads a watch-built renderer over `typose://`. Vite's dev server on `http://localhost` is blocked by the network guard (`main/index.ts:25,48-50`).
  - **npm pins:** the spike's tested set (`spike/a package.json:15-21`), plus React 19.3.1 and react-aria-components 1.22.1 (`spike/b package.json:14-17`), `@vitejs/plugin-react` 6.1.2, and `@axe-core/playwright` and `axe-core` 4.14.0 (`:21-24`).
  - **Rust pins:** napi 3.14.2 (plan A:3624); `memchr`, `xxhash-rust`, `encoding_rs` and `proptest`; `windows-sys` with `Win32_Storage_FileSystem` (`spike/c doc.rs:24-27`).
  - **Lockfiles:** a fresh resolve; Z41 binds only the spikes.
  - **`.gitignore`:** build outputs, plus `astra-research.md`, `fable-research.md` and `docs/research/`.

**Ports from `spike/a` and `spike/c`:**
- `store.rs` (`spike/a :1-156`), with `spike/c`'s delete-on-drop `Temp` test helper (`store.rs:176-190`), which fixes plan A:3622.
- `doc.rs` (`spike/c :1-154`) for generations, path identity, freeze and reload. It keeps the handle for the document's lifetime (`:74-95`), which settles §3.3's handle-lifetime choice.
- `encoding.rs` (`spike/c :1-122`) and `bytemap.rs` (`ByteMap` at `:16-25`). Converting their allocations to C1's buffers is PR 6.
- `index.rs` from `spike/c`, which is encoding-aware (`:40`; `build` at `:146`; `locate_line` at `:176`), and `pages::lines` (`spike/c pages.rs:32-71`). Any chunked-table change is PR 6.
- `big_offsets.rs` (the >4 GiB sparse test), and `spike/c`'s `fixtures-gen`, which adds 117 lines to `spike/a`'s.
- **Main hardening** (`spike/a main/index.ts:7-76`):
  - no-proxy;
  - `typose://` privileged with `codeCache`, and the path-confined handler;
  - the network guard and the sandbox flags;
  - denied navigation and window opening;
  - the utility fork and port hand-off.
- `scrollmath.ts` and its tests verbatim, `virtual-list.ts`, and the Raw path of `lens-view.ts`.
- `netlog-assert.mjs`, `e2e/shell.e2e.ts` and `open.e2e.ts`.

**Reworks:**
- **Identity checks:** Raw reads go through `Document`, with one identity check (`FileId::of`) before and one after each `page()` or `piece()` call, not per line or chunk. *(Amended in PR 4: one check, after the reads, which walks the path first; the cost is in plan §7.)*
  - Every chunk read still verifies its hash (§3.1).
  - Per-line checks would cost about 14.5 ms per 64 KiB page, against a < 3 ms fetch gate (`m1rev` P3, at about 24 µs per stat).
  - `spike/c`'s napi `Doc::open` used a bare `ByteStore` (`spike-node/src/lib.rs:72-75`), and only Markdown copy used `Document` (`:147-189`).
- **Smaller reworks:** the first piece is cut at element boundaries (C3), and the renderer cache is bounded in bytes (C1's cap; the ledger charges it from PR 6). `ChunkHashes`' layout change is PR 6.
- **Device files are refused before the open (§3.3).** Opening a FIFO blocks, and opening `\\.\pipe\…` connects to its server.
  - First, a path-form check for `\\.\` and `\\?\` device paths and reserved names (`CON`, `NUL`, …), then a regular-file `metadata` check.
  - On Unix, open with `O_NONBLOCK`, then `fstat`. On Windows, `GetFileType` must return `FILE_TYPE_DISK`.
  - Files over 2^53−1 bytes are refused too (`spike/c spike-node/src/lib.rs:145,159`).
- `virtual-list.ts` resets the drag gate on `pointercancel` and `blur` (plan A:3623).
- CSP becomes a `typose://` response header instead of a meta tag (`spike/a index.html:5`).
- The `TYPOSE_*` env hooks (`main/index.ts:10,20,80-90`) are split. Read-only measurement hooks ship, validated (plan §5); behaviour-changing ones live only in the `test-hooks` build (m8). *(Amended in PR 1: PR 1 ports none. The NetLog and the profile use Chromium's own `--log-net-log` and `--user-data-dir` switches, and the file to open comes from argv. The measurement hooks arrive with PR 3's instruments, so C4's env table is empty until then.)*
- React 19 renders the title-bar region and the card frame, so startup measures the real chrome cost (packet:524).
- Raw's semantics, which neither §6.1 nor the brief defines: a labelled, focusable region with an `aria-hidden` gutter (proposal, plan §7).

**Acceptance:**
- **`cargo test`:** the ported suites, plus new tests: first pieces never split an element, and device paths are refused without being opened. The ported suites are store and doc (including the stale-generation and same-size-write cases), the encoding and bytemap vectors, the UTF-8 and UTF-16 index proptests, and >4 GiB offsets.
- **C2's proptest and its `v8.serialize` test.**
- **`npm run check`** is green (C10).
- **e2e:**
  - UTF-8, Windows-1252 and UTF-16LE/BE fixtures display text equal to the reference decode;
  - Ctrl+End reaches the last line of a 1 GiB file (End is horizontal, per PR 1's scope; amended in PR 1);
  - the wheel moves 1:1 in logical mode;
  - on a line wider than the viewport, horizontal scrolling brings text beyond the viewport's width into view (its bounding box lies inside the viewport);
  - the NetLog assertion is clean.
- **C4's table** for `open`, `page` and `close`, and **C9's four controlled failures**.
- **CI:** once Zack has verified the stopping control, PR 1 leaves draft. Both workflows go green, and `pr.yml` gates the merge (Z57). Zack's hands-on session follows the merge.

### PR 2 · CI hardening within the free minutes (decent, medium)

**Scope:**
- **Triggers [Z60]:** unchanged from PR 1. A macOS-only break surfaces after merge. PR 3's macOS package and the macOS checks in PRs 7 and 8 run in that job, and a red macOS run is fixed in the next PR.
- **Minutes [Z61]:** GitHub Free's included minutes, with the $0 spending limit. Windows minutes count 2× and macOS 10×.
  - Caches for cargo, npm and the Electron binary.
  - `paths-ignore` for docs-only changes (`docs/**`, `*.md`). *(Amended in PR 2: `*.md` is root-level, and a PR is judged on its whole diff; plan §7.)*
  - `concurrency` with `cancel-in-progress: true` per ref. *(Amended in PR 2: not for pushes to `main`, which keep one macOS run each; plan §7.)*
  - Platform-independent steps (fmt and lint) run on Linux only. (PR 1 dropped the range staleness check: there's no generated table.) *(PR 2 adds clippy for the Windows target there, plan §7.)*
  - **If the quota runs out,** the $0 limit pauses CI, and gated merges wait until it resets or Zack changes the policy. There's no automatic downgrade of the macOS job.
- **Artifacts and storage [Z61]:**
  - GitHub Free includes 500 MB of artifact storage plus a separate cache allowance (`reply3.md:61`, citing GitHub's docs; not re-fetched here).
  - `retention-days: 5` (proposal) is a retention policy, not a storage cap.
  - The 500 MB cap is a separate control: upload only on failure (lifecycle logs, dumps and traces), compressed, with bounded sizes.
  - Caches are keyed per lockfile and pruned.
  - Before an artifact expires, the orchestrator copies the failure evidence into `.evidence/m1/ci/` with `gh run download`.
- **Stopping budget:** Zack verifies that the $0 limit stops billing rather than only alerting, or that free capacity is verified. The `gh` token has no `user` scope, so this is unverified here. It doesn't block local development, but hosted CI can't run until it's verified (PR 1).
- **Measured minutes (PR 2's runs on 2026-10-23, replacing the estimate).** Billed means each job rounded up to the whole minute, then Windows ×2, Linux ×1 and macOS ×10.
  - **A PR's first run, with cold caches** (pr run 39981985343): Windows 5m46s (12 billed), Linux 3m02s (4) and lint 1m06s (2), so 18 billed.
  - **A later push to the same PR, with warm caches** (pr run 39983589063, which ran every step): Windows 3m03s (8 billed), Linux 2m12s (3) and lint 54s (1), so 12 billed. The warm cache cut Windows' napi build from 84 s to 22 s and its `cargo test` from 91 s to 37 s.
  - **A macOS merge run** took 1m37s and 1m24s, the job times of main-macos runs 39977019396 and 39979583756, before PR 2's caches. So 20 billed each.
  - So a merged PR with ~3 runs costs about 18 + 12 + 12 + 20 ≈ 62 billed minutes, or about 32 merged PRs a month on the 2,000-minute quota (`reply3.md:61`). The estimate said 250 and 8.
  - Manual `workflow_dispatch` macOS runs aren't in that figure: about 20 billed each, and there were three on 2026-10-23.
  - A PR's first run is always cold: `main` runs only macOS, so Windows and Linux caches are saved on each PR's own ref, which other PRs can't read.
- **Additions to the steps:**
  - `cargo fmt --check` and `clippy -D warnings`;
  - lint on Linux, with a linter that doesn't need the TS compiler API (proposal: oxlint). TS 7.0.2 ships no `createSourceFile` (`m1rev` P4); typescript-eslint is used only if it's first verified on TS 7;
  - failure-artifact upload.
- Toolchain pins. `LICENSE-MIT` and `LICENSE-APACHE` [Z27].

**Acceptance:**
- The Windows and Linux jobs are green on the PR, and the macOS job is green on the merge.
- A planted fmt error, a clippy warning, a type error and a test-only external request (caught by NetLog) each fail their job.
- A docs-only change triggers no run, and a second push cancels the first push's run. *(A docs-only PR, or a docs-only push to `main`; amended in PR 2, plan §7.)*
- A failing run uploads its evidence with the retention set.

### PR 3 · Packaged build, fuses and the minimal instruments (large, high: security and instrument validity)

**Scope:**
- **Packaged build:** `electron-builder --dir` for Windows x64. The macOS arm64 `.app` is built on the macOS runner. The napi addon is unpacked from the asar (§12.1; `spike/a package.json:23-27`).
- **Fuses, set at package time (§7.1):** `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, `EmbeddedAsarIntegrityValidation` on.
- **The minimal C8 instruments.** This PR establishes the measurement semantics; PR 9 completes the runner.
  - **Startup:** port `shell-visible.mjs` (`:36-39`) to C8's `shellVisible` definition. The spike's premise was a static `<header>` (`spike/a index.html:10`).
  - The cold launch also records `launch→firstContent` and `open→usable Raw` (plan §5). Cold mode takes one sample per restart from the fixed fused build. Plan A's alternating dev and packaged launches aren't repeated (plan A:3396-3398, reply2.md:3).
  - **Frames:** trace capture with pinned events, demanded-frame accounting, stalls, and input→target-paint.
  - Every run records the CPU load (Z49) and the refresh rate.
- **Informational PC numbers** (warm n=30, plus any cold samples) go in the PR, not into qualification. Under Z59, a startup miss is M1-blocking work: verify the code cache (§10.1), split the bundle, and check React's cost.

**Acceptance:**
- The packaged app opens a file, and its fuses read back as §7.1 lists. NetLog is clean on the packaged build.
- `--remote-debugging-port=0` prints `DevTools listening` on the fused build, and `connectOverCDP` attaches.
- C8's acceptance, including both startup controls.

### PR 4 · Continuations, generations, file states (decent, high: correctness)

**Scope:**
- `page(doc, 'raw', {continuation})` per C3.
- **Long lines (brief §5.1):** the first piece shows with a continuation marker. Further pieces mount on demand as their own fixed-height items, each horizontally scrollable, up to 1 MB per line (1 MiB; plan §7). After that comes "+N MB more on this line" (Copy line comes in M6).
- **Freeze:** the "Changed on disk · Reload (Ctrl+R)" banner, and `reload` → gen+1, after which old-generation pages are dropped (brief §7.9, §3.1).
- **File states (brief §7.9, §8.2):**
  - empty;
  - binary (the message only; hand-off is M4);
  - missing;
  - permission denied (Retry, Close);
  - slow open ("Opening…" after 300 ms);
  - indexing ("Indexing N lines…");
  - memory-refused (proposed text, plan §7).
- **Plan A's scan-mark veto carries over** (packet:478, `afc58f9`): a missing, invalid or misordered scan-completion mark fails the Z37 gate.

**Ports:** `spike/c pages.rs:75-87` and `doc.rs:133-153`, both reworked.

**Acceptance:**
- C3's proptest and forged-token table.
- On the 1 GiB one-line fixture, the first piece is visible before the scan passes the line's end (Z37), further pieces load on demand, and no item exceeds 64 KiB (C2's e2e). The first-screen clock starts at the later of the open and the page's first frame (Z64).
- The gate's verdict is pass, fail or not judged. A lens that waits for the line's end fails any decisive run. A run whose scan ends inside the budget from the clock's start is not judged: on Windows and macOS that fails the test, and on Linux, smoke-only under Z28, it's logged as "NOT JUDGED (Linux smoke, Z28)".
- Removing the scan mark, or the page's first-frame mark, fails the gate (negative controls).
- A same-size write while scrolling freezes the document with nothing new shown, and Reload refuses old-generation pages.
- Each file state renders.
- On Windows, Spike C's mutation race (1,000 of 1,000) and its 1,000 append/truncate/rename/delete cycles run against Raw.

### PR 5 · Cancellation and lifecycle cleanup (decent, high: lifecycle)

**Scope:** C5's async pages and `cancel`; C6's close, freeze and failure paths, including the new index cancel flag; C7's sessions, port teardown, respawn, Reopen and second-death rule; and debug stats in the `test-hooks` build.

**Ports:** `spike/c spike-node/src/lib.rs:309-378` (Job) and `core-host.ts:33-43,96-104`.

**Acceptance:** the tests in C5, C6 and C7, run on the `test-hooks` build.

### PR 6 · Aggregate memory budget (large, high: memory)

**Scope:** C1 in full:
- the ownership accounting, with the chosen buffer and table implementations, including converting the ported decoder, map builder, checkpoints and chunk hashes (deferred from PR 1);
- page acknowledgements and the GC allowance, as hypotheses to test;
- the Raw floor, transient reservations, the elastic structures, the renderer-cache reservation, the memory refusal on open, and debug stats.

**Ports:** `physical_ram` and `private_bytes` from `spike/c budget.rs:7-53`, or `os.totalmem()`. `budget::cap` isn't ported, because its unit is blocks.

**Acceptance:**
- C1's tests, with the negative control.
- **Memory metrics are kept separate (plan §5); none substitutes for another:**
  - the ledger is ≤ its limit (Z34);
  - resident memory summed across processes is < 1 GiB on the 1 GiB fixture (the Spike A gate);
  - private bytes, working set/RSS and PSS (where the OS reports it) are reported separately, summed across processes, on 1 GiB and 10 GiB (§10.2 "Memory").

### PR 7 · Title bars, minimal chrome and M1 accessibility (decent, medium)

**Scope (brief §3.1, §9):**
- **Windows:**
  - WCO at 40 logical px (`spike/a main/index.ts:61`), with the whole bar draggable except its controls;
  - the title "`<focused file>` — Typose" and the glyph;
  - ☰ as a React Aria `Menu` with Open file…, Reload and Exit (the full command table is M2).
  - Electron's default menu goes with it (PR 4's residual). Its accelerators, Force Reload (Shift+CmdOrCtrl+R) among them, stay bound and are live wherever its menu bar is. PR 4's renderer takes only Ctrl+R.
- **macOS:** traffic lights centered in the 40 px bar (the spike set `{x: 14, y: 13}`, `:60`) and a minimal native menu.
- **Linux:** the native frame, best effort [Z28].
- **Accessibility (Z39, §6.3):**
  - Accessibility mode is forwarded from main (§6.2) and accepted only from `event.source === window`. The reference, `spike/b a11y/mode.ts:2-6`, accepts any window message.
  - Raw and the chrome are inspected through UIA on Windows (reference: `spike/b e2e/uia-element.ps1`) and through CDP accessibility-tree reads.
  - Also: axe on the chrome, keyboard and focus gates, and 200% zoom (reference: `spike/b e2e/zoom.e2e.ts`).
  - Real-reader testing stays parked.

**Acceptance:**
- **Snap Layouts:** the flyout appears over maximize on the packaged Windows 11 build, with screenshot evidence. This is Spike A's pending gate (MANIFEST:49).
- Dragging the bar moves the window, and double-clicking it maximizes.
- On macOS CI, `win.getWindowButtonPosition()` matches the centered position. The manual screenshot waits for the Mac (Z55).
- **Accessibility trees (UIA and CDP):**
  - Raw is a named region whose text excludes the gutter;
  - ☰ exposes menu roles;
  - focus stays in Raw across scrolling, far jumps and page replacement.
- **200% zoom:** the chrome and Raw stay reachable, and wide lines still scroll horizontally.
- axe finds 0 violations, and the keyboard reaches ☰ and Raw.

### PR 8 · Single instance, argv/open-file, CLI (small, medium)

**Scope (§8.1):**
- `requestSingleInstanceLock`. `second-instance` handles `argv` and `cwd`; on macOS, paths arrive through `open-file`, before and after ready. *(Amended in PR 8: the second instance's own argv and cwd come as the lock's `additionalData`; plan §7.)*
- Paths are normalized: relative paths, spaces, Unicode, `--`, and paths that look like options. The `.cmd` launcher also handles `%`, `^`, `&` and `!`.
- M1's single card shows the newest path; tabs are M2.
- `typose` launcher scripts (`.cmd` and `sh`) live in the repo. The installers put them on PATH in M7.

**Acceptance:**
- An e2e second launch with each path shape opens in the first instance and exits 0.
- An `open-file` test passes on macOS CI, on the packaged `.app`.
- A second instance's exit leaves the first instance's `running` marker intact (C9).
- The different-user and elevated cases are documented (§8.1, D15).

### PR 9 · The M1 runner (decent, high: instrument validity)

**Scope:**
- A runner for every row of plan §5's thresholds table, on PR 3's instruments.
- It ports the spike's tests, reworked to the product protocol, from `spike/a perf/spike-a.e2e.ts`:
  - `:80` first screen and `:96` oversized;
  - `:134` deep reading, throughput and memory;
  - `:194` 64 KiB fetch;
  - `:217` scrolling and input latency while indexing;
  - `:252` NetLog idle.
- It drives the fused build per plan §5: spawn, then CDP, then read-only hooks.
- **Far jumps:** a scrollbar jump, Ctrl+End and open-then-scroll, with accessibility on from launch and off [Z52].
- **The named ≤ 100 MB fixture set:** one fixture per format (md, csv, tsv, json, jsonl and yaml), opened in Raw.
- The scan-mark veto applies to its Z37 rows.
- Results JSON with n, p50, p95, max, the load and the refresh rate.

**Acceptance:** the scan-mark negative control, and a full pass against the fused PR 3 build, reported as informational.

### PR 10+ · Remediation, one PR per measured miss (sized when measured)

Each PR is named after the gate it fixes:
- the startup budget (mandatory under Z59);
- fetch p95 (§3.4's `ArrayBuffer` path applies only if *decode* is > 3 ms p95);
- a Raw far jump;
- the index rate.

One PR may fix related misses that share a cause. Its tier follows its area. Nothing is pre-built speculatively: rayon (plan A Task 12) is built only if the qualified throughput gate fails.

### M1 close · Qualification run (no product code; medium)

Run plan §5 and record the M1 summary. An executed review checks the evidence against plan §5. **Proposal:** logs go to `.evidence/m1/` (untracked, hashed and revision-labelled, following Z41's pattern), and a one-page summary is committed under `docs/`.

## 4. Gate disposition (Z53: no status is upgraded)

`snap1` and `snap2` are `.evidence/phase0/snap1` and `.evidence/phase0/snap2`, and `rev3B` is `snap2/planb/rev3/REVIEW.md`.
- No Phase 0 timing was measured under Z49 (snap1 MANIFEST:42-53). In this table, a bare `MANIFEST:` refers to snap1's.
- The "functional" rows have lane evidence only, and none counts as passed.
- §13.1:622 requires a disposition for every gate.

| Gate (§13.1) | Status now | Evidence | Owner |
|---|---|---|---|
| A: shell visible cold < 200 / < 400ms | pending; warm smoke under load p50 412 / p95 456ms (n=3); never run cold | `snap1/pv/results/spike-a-Zack-PC.json` `smokeShell`; MANIFEST:45-47 | M1 (Z59) |
| A: first screen Raw 1GiB/10GiB < 50ms warm, < 150ms cold | pending; loaded runs; "10g" was a 1,288,490,200 B stand-in | `snap1/lanes/ra/sandbox2/…/spike-a-Zack-PC.json`; `pv/results` `index10g` | M1 (both sizes, both cache states) |
| A: first screen Rows 1GiB/10GiB | pending | same | M3 |
| A: oversized first record (piece in gate, no item > 64KiB) | pending; post-Z37 max 25.9ms Raw, under load | `snap1/plana/z37/AMEND.md:130-143` | Raw M1; Rows M3 |
| A: deep reading (10 notches at line 40M ±1 line; PageDown = 1 viewport) | pending; real 10 GiB not run | MANIFEST:48 | M1 |
| A: Mac trackpad ≤ 1 viewport per frame | pending; no Mac batch | MANIFEST:50 | M1 (Mac per Z55, Z58) |
| A: all Mac gates (shell < 400ms, first screen < 100ms, index ≥ 0.5 GB/s, fetch, frames, memory) | pending; no Mac batch | MANIFEST:50 | M1 (Mac per Z55, Z58) |
| A: index ≥ 1 GB/s warm, NTFS, Defender on | pending; 3.0–5.1 GB/s on the stand-in, under load | `pv`, `sandbox2` `index10g*` | M1 |
| A: input latency < 50ms while indexing | pending | MANIFEST:45-46 | M1 |
| A: 64KiB fetch p95 < 3ms | pending; p95 2.6 / 2.7 / 3.8ms across 3 loaded runs | `pv`, `sandbox2`, `sandbox` `fetch64k` | M1 |
| A: ≥ 99% frames < 16.7ms during indexing | pending; the instrument was rAF > 20ms | `spike/a perf.ts:16`; plan A:3613 | M1 (C8) |
| A: memory < 1GiB on 1GiB; within aggregate budget on 10GiB | pending; aggregate budget unimplemented | `pv` `memory1g`/`memory10g`; Z47 | M1 (C1, PR 6) |
| A: Snap Layouts over WCO maximize | pending; not run | MANIFEST:49 | M1 (PR 7) |
| A: NetLog after 5 min idle, remote-image Markdown open | pending; Task 11 not run | MANIFEST:45; `spike-a.e2e.ts:252` | idle with Raw M1; remote-image variant M4 |
| B: G4, 1,000×100 positions, a11y on | **failed**: 4 unexplained mid-run exits | MANIFEST:53; `rev3B:57-65` | investigation M3; an unexplained exit in M1 blocks M1 [Z56] |
| B: ≤ 1% long frames, a11y on, 10s auto-scroll | pending; lane passes under load | `snap1/lanes/b2/REPORT.md:58-73`; `rev3B:132-139` | Grid/Rows M3, Rendered M4, Transcript M5; Raw's equivalent M1 |
| B: far jump, no stall > 50ms [Z52] | **failed**: 55–188ms with a11y on (Transcript up to 158ms opening, 188ms jumping). With a11y off: far jumps 6–18ms, but open-then-scroll 24–73ms, over 50ms in 2 of 5 Transcript runs (not asserted in the spike) | Z52 (corrected in `eb48e28`); `snap2/MANIFEST.md:61-64` | Raw M1 (a11y on and off); Grid/Rows M3; Rendered wide-window M4; Transcript M5 |
| B: real-reader items (20-task script, 2,000-block reads on NVDA/Narrator/VoiceOver, announcements, the reader's heading key) | parked [Z39] | MANIFEST:44; §13.1:670-676 | after launch |
| B: edge controls, G5's premise, P4 (reader scroll-into-view in logical scrolling) | parked [Z39] | `rev3B:75-82`; packet:525 | after launch |
| B: functional automated gates (Ctrl+End, 0 skips a11y off, simulated 2,000-block reading, Outline jumps, 100 peeks, 200% zoom, ARIA totals) | pending; lane evidence only | `snap1/lanes/b1…b4/REPORT.md` | Raw and chrome tree, zoom and focus M1 (PR 7); Grid/Rows M3; Rendered, Outline, peek M4; Transcript M5 |
| C: CSV index ≥ 0.9 GB/s PC / 0.45 Mac [Z46] | pending; n=30 p50 1.14 GB/s at 8% CPU, not Z49; Mac not run | `snap2/planc/rev3/logs/R3-Z46-throughput.log:1-10` | M3 |
| C: Markdown cap as memory bound (MAJOR A) | **failed** as a safety claim [Z56] | `snap2/planc/rev3/REVIEW.md:33-75` | enforcement M1 (C1); Markdown byte accounting M4 |
| C: cap validation (MINOR B) | **failed** in the spike | `snap2/planc/rev3/REVIEW.md:77-102` | M1 (C4) |
| C: YAML worker run C5a6 Step 2 | pending; not run | MANIFEST:51 | M3 |
| C: hostile cancel ≤ 50ms with Raw's first screen kept; C4e's debug bound | pending; under load | MANIFEST:52; packet:492,500 | Raw index cancel M1 (C6); parsers M3/M4 |
| C: 5 MB fence then a paragraph within the first-screen gate | pending; under load | MANIFEST:52 | M4 |
| C: functional gates (10,000 span cases, byte maps, > 4GiB, 1,000 append/truncate/rename/delete cycles, mutation race, hostile zero effects) | pending; lane evidence only | `snap1/lanes/c1…c5b/REPORT.md` | Raw-path tests M1 (PR 1, PR 4); JSON/CSV M3; Markdown/Mermaid/KaTeX M4 |
| C: Markdown ≤ 32 B/block (66–68 measured) | an optimization target, not a gate [Z34] | packet:523 | M4 |

## 5. Qualification for M1's exit

**Protocol [Z49, unchanged]:** a quiet PC, with CPU < 10% for a minute before each timing run, load recorded during it, and Defender on. Warm runs, the cold batches and manual checks run as separate batches. Every failed or invalid run is kept with its reason.

**Build [Z54; ruling OQ-2]:**
- **The build:** one fixed build, the PR 3 packaged unsigned layout at the M1 closing commit, with every §7.1 fuse set. It's named by its commit and binary hash, and every qualification run uses it.
- **Two required cold batches per reference platform,** each of five OS restarts, with the build launched **first** after each restart:
  - batch A opens the 10 GiB file by argv;
  - batch B opens the 1 GiB file.
  - Each launch records `shellVisible`, `launch→firstContent` (informational until restore, M2) and the judged `open→usable Raw` (from the open request to the first bounded piece visible and usable, Z37).
  - The launch passes no debugging switch; its marks come from the read-only hooks. A second launch isn't cold.
- **Driving the build:** Playwright's `_electron.launch` can't, because it waits for the Node inspector, which the fuse disables (`m1rev` P2). `_electron.launch` is for dev-layout e2e only.
  - The M1 runner spawns the executable with `--remote-debugging-port=0` and attaches with `chromium.connectOverCDP`.
  - Main-process figures come from validated, read-only `TYPOSE_*` hooks that write JSON to a results path, plus OS process counters.
- **Test hooks:** behaviour-changing hooks (the per-read delay, the budget override, debug stats as protocol calls) exist only in a `test-hooks` addon build, never in this one. A renderer that could raise the budget would defeat Z34.

**Judging:** warm is n = 30, judged on p95 (plan A:79); cold is the worst of 5. Frames follow C8 (ruling OQ-6). Memory metrics are reported separately, never substituted for one another (PR 6).

| Gate | Fixture | Cache | PC (half budget) | Mac (full budget) |
|---|---|---|---|---|
| Shell visible (`shellVisible`) | launch | cold | < 200ms | < 400ms |
| Raw first screen, `open→usable` | 1 GiB and 10 GiB JSONL | warm | < 50ms | < 100ms |
| Raw first screen, `open→usable` | 1 GiB and 10 GiB JSONL | cold | < 150ms | reported: §13.1 sets no Mac cold value |
| Raw first screen, ready lens (§10.2's ≤ 100MB row) | the named set, one per format | warm | < 50ms | < 100ms |
| Oversized first record | huge-first; 1 GiB one-line | warm | first piece < 50ms; full-line scan reported | < 100ms; reported |
| 64 KiB page fetch, round trip | 1 GiB, indexed | warm | p95 < 3ms | p95 < 3ms |
| Frames: scrolling while indexing, and far jumps, with a11y on and off | 10 GiB; far jumps also on 1 GiB | warm | ≥ 99% < 16.7ms, no stall > 50ms, every target painted | same |
| Input latency while indexing | 10 GiB | warm | < 50ms | reported |
| Line index throughput | real 10 GiB, NTFS, Defender on | warm | ≥ 1 GB/s | ≥ 0.5 GB/s |
| Deep reading | 10 GiB at line 40M | warm | 10 notches ±1 line; PageDown = 1 viewport | same, plus the trackpad moves ≤ 1 viewport per frame |
| Memory | 1 GiB | warm | resident < 1 GiB, summed | same |
| Memory | 10 GiB | warm | ledger ≤ limit; private bytes, RSS/working set and PSS reported | same |
| Snap Layouts | packaged | — | the flyout appears (manual) | — |
| `launch→firstContent` | 1 GiB and 10 GiB | cold | informational (the restored-content gate is M2) | informational |

**Mac [Z55, Z58, Z61]:** a loaned or borrowed Mac under Zack's control, since nothing is bought; the friend's Mac may bridge an initial batch. The reference rig is recorded before its runs, with any change from Z29 explained. M1 stays open while any Mac gate is pending.

**Exit integrity [Z56; ruling OQ-3]:**
- Every e2e, perf and qualification run, in CI and on the reference rigs, has C9's diagnostics armed. It keeps its `lifecycle.jsonl` and any Crashpad dumps with its results.
- An **unexplained exit** is any exit of the app, the renderer or the core host, or any page close, that the test didn't request. So is any "previous run ended without quit" record from a logged manual session.
- **Exception:** a superseded run or an evidenced infrastructure interruption (C9) is invalid, not unexplained. An application timeout isn't an exception.
- An exit stays unexplained until its root cause is identified and recorded. C9's classification (a reason, an exit status, a dump) is evidence toward a cause, not a cause.
- Every unexplained exit in the M1 baseline counts as "corresponding" (Z56), with accessibility on or off.
- Each one blocks M1 closure until it's root-caused, then either fixed with a regression test or accepted by Zack in writing. A passing rerun never clears it.

**Misses:** every M1 gate is an exit criterion (§13.2). A miss blocks closure until it's fixed in a PR 10+ remediation or Zack explicitly changes the budget [Z54, Z59]. It's never rounded into a pass. If the CI quota runs out, gated work pauses rather than spending (Z61).

## 6. What M1 doesn't do

- **Lenses:** no Rows, Grid, Table, Tree, Rendered or Transcript (M3–M5). The spike's Rows path (`pages::rows`, `summarize`) isn't ported.
- **Workspace (M2):** no sidebar, pills, cards or splits; no session restore; no quick open, command palette or command table; no settings, `config.toml` or themes; no designed empty state. M1 has one card and a temporary Open file… button.
- **Raw wrapping:** no View → Wrap lines, and no always-wrap with ↪ for lines over 10,000 characters. Both need measured-height layout, which arrives with Rendered in M4 (proposal, plan §7). Horizontal scrolling (PR 1) keeps wide lines readable until then.
- **Raw highlighting:** no Shiki (M4).
- **Find, go to, copy and print (M6):** includes the protocol's `read` call and "Copy line". Ctrl+Home/End do ship.
- **Index:** no per-checkpoint UTF-16 length or non-ASCII flag (§3.5). Nothing reads them until wrapping and measuring arrive (plan A:3618).
- **Release (M7):** no installers, file associations, PATH install or signing. Linux is built and smoke-tested only [Z28].
- **Launch signing is open:** Z61 rules out paid signing before launch, so how the launch builds are signed is decided before M7 (§15 Q2).
- **No paid services [Z61]:** crash reporting stays local-only (C9), and there's no hosted crash, coverage or perf tooling. CI uses only the free minutes and storage (PR 2).
- **Links (M4):** no links, hand-off, remote images, Mermaid or KaTeX.
- **No speculative optimization:** no rayon indexer and no transferable page encoding unless a qualified gate fails.
- **Core recovery:** no automatic reopen after a core death (C7).
- **No spike work:** no fixes to the frozen spikes' findings, no harness ports beyond the diagnostics capability, and the spike branches aren't pushed.

## 7. Rulings, settled notes and proposals

**Coordinator rulings (Zack may veto):**
- **OQ-1, withdrawn:** PR 1 carries minimal CI and merges under Z57 like every PR.
- **OQ-2, the qualification artifact:** qualify the fused shipping build, driven over `--remote-debugging-port` + `connectOverCDP` with read-only hooks; the cold launch stays free of debugging switches (plan §5). An inspect-enabled variant would measure a different artifact. This settles "unsigned dev build": it's the fused, packaged `--dir` layout.
- **OQ-3, the exit definition:** plan §5's "Exit integrity" text. Classification is evidence, not a cause. Superseded runs and evidenced infrastructure interruptions are invalid runs; application timeouts aren't.
- **OQ-6, the frame gate:** §10.2's absolute 16.7 ms at the panel's native refresh (164 Hz on the PC), with the Hz recorded (C8).
- **OQ-7:** the small items below are implementer proposals Zack can veto.
- **Review rounds:** 2 general rounds per PR, then only fix-verification of concrete remaining defects (plan §3).

The review's other owner questions are settled in the spec: Z57 (merge authority), Z58 (Mac gates keep M1 open), Z59 (a startup miss blocks M1), Z60 (CI on the private repo, now also in §11.2), Z61 (no spending) and `bc76cfb` (§3.6's caps).

**Amendment rule:**
- Contracts are acceptance targets for the PRs that own them. When implementation shows a mechanism or test detail is wrong or over-built, the owning PR amends the plan, states why, and its review checks the amendment.
- Z-decisions, 🔒 requirements and qualification gates can't be weakened by an implementer amendment.

**PR 1's amendments (mechanisms only; no Z-decision, 🔒 requirement or gate changes):**
- **C4's types and range table.** `ts-rs` plus a generated `[min, max]` file and a `git diff --exit-code` check became napi-rs's typegen plus a table read from the addon at runtime. *Why:* the napi objects *are* what crosses the wire, so the addon's `index.d.ts` already is the Rust-defined protocol type (§3.4's requirement: defined in Rust, exported to TypeScript, unable to drift). A second typegen would describe the same structs, and a runtime table has no copy to go stale.
- **The `test-hooks` addon** moves to PR 5. *Why:* PR 1 has no behaviour-changing hook, so it would be an identical second build.
- **No `TYPOSE_*` hooks in PR 1.** *Why:* Chromium's `--log-net-log` and `--user-data-dir` switches and argv cover what the e2e needs; the measurement hooks belong to PR 3's instruments.
- **"End reaches the last line" became Ctrl+End.** *Why:* PR 1's scope gives Home/End to horizontal scrolling, and §6 ships Ctrl+Home/End. The gate (the last line of 1 GiB is reachable) is unchanged.
- **`electron-builder` (PR 3) and `axe-core`/`@axe-core/playwright` (PR 7)** are installed, at the listed pins, by the PRs that use them. *Why:* PR 1 neither packages nor runs axe.

**Amendments from the first macOS run (main-macos run 39977019396, on PR 1's merge):**
- **C9's `forcefullyCrashRenderer()` case** expects `crashed` on Windows and Linux and `killed` on macOS. *Why:* Electron reports the forced crash as `killed` on macOS. The gate is unchanged: the four controlled failures stay told apart by the log and exit status alone.
- **`main-macos.yml` also takes `workflow_dispatch`.** *Why:* a macOS fix can be run on its branch before merge. The automatic triggers stay Z60's.

**PR 2's amendments (mechanisms only; no Z-decision, 🔒 requirement or gate changes):**
- **"A docs-only change triggers no run" means a docs-only PR, or a docs-only push to `main`.** GitHub applies a `pull_request` path filter to the PR's whole diff against its base, so a docs-only push to a PR that changes code still runs, as it should: the head moved. *Why:* that's GitHub's rule, not a choice. PR 2 shows the push case on `main-macos.yml`'s filter (a reverted probe commit, its job skipped); the first docs-only PR after PR 2 shows the PR case.
- **`*.md` matches root-level Markdown only** (GitHub's `*` doesn't cross `/`); `docs/**` covers the docs tree. *Why:* Typose's own tests will carry Markdown inputs under `app/`, `core/` and `e2e/`, and `**/*.md` would let a fixture-only PR skip CI.
- **Clippy also checks `x86_64-pc-windows-msvc`, from Linux.** *Why:* clippy runs on Linux only, so `cfg(windows)` code, such as §3.3's pipe and device refusals in `store.rs`, would never be linted. The cross-check lints it at Linux's rate.
- **Within a job, a step runs when what it needs succeeded,** not only when every earlier step did; the job still fails. *Why:* one run reports every failure (fmt, both clippies and oxlint; `cargo test`, `check` and the e2e) instead of one per push.
- **Every job is time-boxed** (`timeout-minutes`: lint 15, test 25, macOS 20, and 12 for the e2e step). *Why:* GitHub's default is 360 minutes, so one hung macOS job would bill 3,600 of the 2,000 included minutes. The e2e step's 12 is past the longest test's own limit (10 minutes in `large.e2e.ts` and `long-line.e2e.ts`; the config's is 5) and leaves room in each job's limit, so a hung e2e fails its own step and its evidence still uploads (a job timeout cancels the job, skipping the upload).
- **Rust is pinned in a root `rust-toolchain.toml`** (1.96.0, minimal profile, with rustfmt and clippy), which rustup reads locally and in CI. *Why:* one place; at the root it also covers `npm run fixtures`, which runs cargo from the root.
- **The Electron binary is fetched in its own step** (`npx --no install-electron`), from a cache keyed per lockfile and OS. *Why:* Electron 44 installs no binary at `npm ci`; the first `require('electron')` downloads it, which would otherwise land inside the e2e step.
- **`main-macos.yml` keeps one run per merge.** A push to `main` gets a concurrency group of its own (its sha), so a later merge neither cancels it nor replaces it while it waits. Only `workflow_dispatch` runs on one branch cancel each other. *Why:* a red macOS run must name its merge, since Z60's macOS break is fixed in the next PR, and a cancelled or replaced run leaves that merge with no verdict. It costs at most one more macOS run per overlapping merge, about 20 billed minutes.
- **Z57's green CI, for a docs-only PR.** `paths-ignore` gives a PR whose files are all under `docs/**` or root-level `*.md` no checks at all. Its CI counts as green when its file list shows nothing else, which the review confirms. Z57 itself is unchanged.
- **Failure evidence is capped by stored size** (deflated at level 9, as the artifact zip stores it): 16 MiB a file and 32 MiB in all. *Why:* a raw-byte cap dropped C9's 35 MB Windows main-process dump (pr run 39983589063), which stores at about 180 KB (kept in pr run 40047349718).

**PR 3's amendments (instrument definitions and test details; the frame gate's scope follows Zack's Z62; no other Z-decision, 🔒 requirement or gate threshold changes; the evidence is in PR 3's description):**
- **`shellVisible` is the title bar's first presentation after `show`, not max(`show`, `titlebarPainted`), and never `show` itself.** This is stricter: on the packaged build it reads 70–95 ms later than the old definition. *Why:* PR 3's control settled C8's UNVERIFIED point.
  - On Electron 44 the OS reports the window visible and uncloaked about 4 ms after `show()` is called, and the `show` event fires about 35–45 ms after that.
  - The title bar reaches the screen 70–95 ms after `show` (packaged build, this PC). Chromium's first contentful paint, the window's `Display::FrameDisplayed` and Element Timing agree to within a refresh.
  - The old definition under-read on-screen time by those 70–95 ms.
  - A frame can be presented to the still-hidden window: with `show()` delayed, Element Timing put the title bar's presentation 317–319 ms before `show` in 2 of 5 of the review's runs, and max(`show`, it) silently returned `show`. So when the title bar's presentation precedes `show`, a probe gives the first presentation after the show (`shownPresented`). A run that can't establish one is invalid with its reason, never `show`. The probe goes in only under the TYPOSE_MARKS hook, and a startup trace shows it lands on one of the window's displayed frames.
- **The startup controls are judged within each run; cross-run rises are recorded.** The control is ≥ 300 ms after the instant the delay starts from: max(`ready-to-show`, `titlebarPainted`) for `show()`, and `bundleEvaluated` for the mount. *Why:* each delay overlaps waiting that's already on the critical path, so the median rise across runs is below 300 ms even when the instrument is right.
  - The renderer's first frame comes about 175 ms after the bundle evaluates, whether or not React has mounted (React's own render and commit take about 15 ms of it). A 300 ms mount delay raised the median by 14–55 ms (three batches of five).
  - The first presentation after the window becomes visible takes 70–95 ms, so a 300 ms `show()` delay raised the median by 62–238 ms (three batches of five).
  - The within-run form still fails an instrument that marks `ready-to-show` instead of the show, or that marks before React commits.
- **The startup controls run on the dev layout of a test-hooks JS build** (`npm run build:hooks`, `electron-vite --mode test-hooks`, into `app/out-hooks/`), on the same Electron binary. *Why:*
  - Delaying `show()` and React's mount changes behaviour, so plan §5 keeps it out of the fused build. A constant `__TEST_HOOKS__` compiles it out of `npm run build`: the shipped bundle has none of it (checked by grep).
  - The addon's `test-hooks` build (PR 5) isn't involved, because these hooks are JS-side.
- **Frames come from CDP tracing on the fused build, and a "presented frame" is the renderer's `STATE_PRESENTED_ALL` `PipelineReporter` end, not `Display::FrameDisplayed`.** *Why:*
  - Electron's `contentTracing` is a main-process API, which the fused build doesn't expose; CDP's `Tracing` drives the same Chromium tracing.
  - During a scrollbar jump, the compositor presents thumb-only frames with stale rows while the main thread is blocked. A `Display::FrameDisplayed` 6 ms into a 60 ms block split the stall.
  - The renderer's frame reporter marks those frames `STATE_PRESENTED_PARTIAL`; excluding them is stricter. A negative control that counts partial frames fails the analyzer's tests.
- **The frame gate judges cadence, and the first frame after an input is judged by responsiveness (Z62, Zack, 2026-10-23).**
  - Cadence: within each merged demanded interval, every presented frame after the first is judged against 16.7 ms on its gap from the frame before it, and counts in the ≥ 99% denominator.
  - Responsiveness: each input that changes the view is judged from its own timestamp to its answer, the first present after its target rows painted. It's judged by the 50 ms stall rule, beside plan §5's 50 ms input-latency gate, and the distribution over answered inputs (n, p50, p95, max) is recorded. An input that changes nothing is timed to its painted mark and reported apart (`unanswered`); over 50 ms it's still a stall.
  - A run whose demands each produce one frame reports cadence as `n/a`, never as passed, and responsiveness is still judged.
  - *Why the answer, not the next present (review round 3):* round 2 timed input → the next present. While frames flow (a scroll, a repaint, a frame already in the pipeline), that comes within a refresh whatever it shows: a lower bound, not the latency.
    - The synthetic tests show it, with frames every 6 ms. A target first presented 40 ms after its input read 4 ms the old way, and reads 40 ms now. At 60 ms it read 6 ms, and is now a stall.
    - In round 3's frame-control run, the control scrolls' answers read p95 13.5–13.8 ms, with maxima of 25.7–37.9 ms. The 60 ms wheel injection is now also a responsiveness stall, at 72.7 ms and 74.1 ms.
  - *Why:* PR 3's first two definitions both failed.
    - The first judged opening frames as stalls only, so the review's synthetic 21 keypresses answered 45 ms late passed with 0 frames judged.
    - The second, review round 1's ruling, judged opening frames against 16.7 ms too, which counts pipeline depth: the uninjected 21-ArrowDown control failed 2 of 7 runs (18.186 ms in the case the review quoted).
    - Zack chose Z62, "smoothness only".
  - The tests:
    - synthetic keypresses answered in 10 and 45 ms report cadence `n/a` and pass responsiveness;
    - answered in 61 ms, every key is a stall;
    - a first frame begun late is judged from the input, not as a long frame;
    - the live keypress control passed responsiveness with cadence `n/a` in 10 of 10 runs with accessibility on and 10 of 10 with it off, timed to the answer (review round 3). Over round 3's 20 runs, each run's answers had p50 4.3–8.9 ms, p95 9.1–13.3 ms and max 10.3–15.2 ms; the round-3 review's own 5 runs reached 15.4 ms. Round 2's first batch, timed to the next present, had one failure from keyboard input the test didn't send; PR 3's description has it;
    - a 60 ms busy-wait in one keypress's handler is a stall covering it: 66.1 ms and 70.7 ms in round 3's frame-control run.
  - A continuous gesture still merges into one interval: 289–329 judged frames per 2 s scroll at 165 Hz.
- **One present is one frame.** Two `STATE_PRESENTED_ALL` `PipelineReporter` slices, for different `frame_sequence`s, can end at the same timestamp. They count once, begun when the earlier began.
  - What the traces show: in 15 traces there were 99 such pairs.
    - Their begins were 5.5–60.5 ms apart, and their `frame_sequence`s 1, 2 or 10 apart.
    - In 83 of the pairs, the earlier sequence also had a slice of type `FORKED`, which ended `STATE_PRESENTED_PARTIAL` (46) or `STATE_DROPPED` (37).
    - Why Chromium reports one present twice is unverified. The 64-bit `display_trace_id`s can't settle it, because JSON parsing rounds them.
  - *Why:* counted twice, the pair is a 0 ms gap.
    - In one full run of the frame controls, 13 of the 14 traces had such pairs, up to 21 in one 2 s scroll. That padded the ≥ 99% denominator by up to 6%.
    - In the two live keypress controls, 2 and 4 presents were doubled, so cadence read `pass` on 0 ms gaps instead of `n/a`.
    - The smallest non-zero gap between presents was 5.9 ms (one refresh at 165 Hz), so equal ends are one present.
- **A run that can't be judged is invalid and never passes:** cadence and responsiveness both read `invalid`.
  - That's a run with:
    - no renderer frames, or more than one renderer;
    - no input marks;
    - nothing demanded;
    - a demanded interval with no presented frame.
  - *Why:* the first version passed a trace with no inputs, or with 0 judged frames. The review's empty and input-less traces now return `valid: false` with a reason.
- **Perf results are appended, never overwritten.** Each run goes to `.evidence/m1/perf/<host>.jsonl` after the test's verdict. It carries its status, the test's error (`testError`) and the run's own `reason` for being invalid, and neither overwrites the other. *Why:* Z49 and §10.3 keep every failed or invalid run "with its reason, never replaced by a clean rerun"; the first version rewrote a key on every run.
- **The frame control is held to no stall and the ≥ 99% rule, not to 0 long frames. The injections must register a long frame or stall covering the injected window.** *Why:* on the loaded PC, each control scroll registered up to two long frames among about 300–330 judged: mostly 18.2–18.4 ms, once 36.4 ms and once 42.5 ms. The inspected 18.2 ms trace shows frames presented a refresh late: slices that began 6 ms apart, the next presented 18.2 ms after the previous one. That's the instrument detecting a real missed refresh, not a false positive. The §10.2 gate is unchanged, and a stray long frame can't satisfy the coverage check.
- **The 30 ms injection control asserts no cadence stall, and records responsiveness as measured (review round 4).**
  - *Why:* since responsiveness times the answer, the 30 ms block adds onto one input's answer. The live worst answers were 42.3–42.5 ms, about 7.5 ms under 50.
  - On a 60 Hz panel the baseline answer is one to two refreshes (16.7–33 ms), so "no stall" of either kind would fail there with the instrument right.
  - The 60 ms control must register a cadence stall covering its injection, so the 30 ms assertion still fails once the injection grows to 60 ms. The uninjected control scroll keeps asserting no stall of either kind: there, a late answer is the app's.
- **"Covers" means the stall runs past the injection's end, and the work behind it began before the injection did; it may start after the injection starts.** That work is the frame that opens a gap, or the input whose first frame is late (Z62). *Why:* a frame already in the pipeline when the main thread blocks still presents during the block (seen 3–12 ms in). No frame begun after the block starts can present until the block ends. The span is still the whole time nothing new reached the screen.
- **Target suppression needs no `test-hooks` hook.** The test driver drops the renderer's page requests over CDP. *Why:* CDP already reaches the page on the fused build; a hook would add behaviour-changing code to the app for nothing.
- **Raw's paint probe follows PR 4's rows (PR 3's merge with PR 4).**
  - The probe checks each viewport row's slot key: a line, or a line's further piece. Its view key adds the row count. A click is a marked input. Once the freeze's banner is up, the frozen view counts as settled.
  - *Why:* the merge state shows the failures, on two traced controls on the packaged build.
    - Expanding a 300 KB line left its `pointerdown` and the scroll it caused never painted. The probe asked the cache for lines 2–4 by row number, where the line's pieces now sit.
    - A freeze left the Ctrl+End `keydown` never painted, waiting for rows that would never load.
  - With the fix, the expansion's click is answered when its four further pieces show (45.2–111.6 ms over three runs: 74.7 in the first, 45.2 in the merge gate's, 111.6 in the final review's), and the freeze's keydown when the banner shows (20.2 ms).
  - The pieces' latency is reported, not judged: each piece's token comes from the piece before, so they're fetched one after another.
- **Z37's test clock starts at the later of the open and the page's first frame (Z64, Zack, 2026-10-23).**
  - PR 4's 1 GiB one-line test judges the first-screen budget from that start, and the page's first frame (`typose:first-frame`) is a required mark: missing or non-finite fails the gate.
  - "The first screen comes after the open" and "the line scan comes after the open" are still judged against the real open.
  - The test waits up to 10 s for every mark rather than reading them once, so a late mark reads as late, not missing.
  - The veto's controls are rebuilt against the new start. The unit check covers a first frame before the open, after it, and after the scan.
  - *Why:* on Linux CI the merged head failed this test in 3 of 5 runs, while PR 4's renderer passed 6 of 6.
    - On those runners the page sometimes renders nothing for 1–1.5 s after it starts. An open inside that gap can't show its first piece until the page's first frame, and the scan can finish first.
    - That's a startup problem, which Z59's gates measure, not the lens waiting for the line's end. A lens that waits still fails any decisive run.
  - **The verdict is pass, fail or not judged (the coordinator's ruling within Z64 and Z28, at the final review).** A run whose scan ends inside the budget from the clock's start can't tell a waiting lens apart, so it's not judged.
    - On Windows and macOS, the gating platforms, not judged fails the test: a gating run must be decisive, and if one stops being decisive, the fixture must grow.
    - On Linux, smoke-only under Z28, not judged is logged as "NOT JUDGED (Linux smoke, Z28)" and the test passes. Both Linux CI runs at `705dbec` were like that: the page's first frame came 852 and 499 ms after the open, after the scan's end at 144 and 246 ms.
    - Missing or misordered marks always fail (the veto). The unit rows cover a decisive pass, a waiting lens and not judged on each platform.
  - *Why a rAF mark, not paint timing's `first-paint`:* the renderer marks `typose:first-frame` in a rAF scheduled when its bundle evaluates.
    - `first-paint` comes with the window's first presentation. Locally it came 265–349 ms after the open, 150–200 ms after the page's frames had begun (`typose:first-screen`, itself a rAF, at 119–141 ms).
    - As the clock start, it would have excused ordinary runs: in 2 of 4, the scan finished within 9–15 ms of it, inside the 50 ms budget.
    - The rAF mark came 72 ms before the open or 113–133 ms after it, 4–5 ms before the first screen.
- **PR 4's 1 GiB one-line test asserts the indexing indicator at any count, not "Indexing 1 line…" (PR 3's merge with PR 4).** *Why:* the line's last progress event and the done event come back to back and can render as one update, so on Linux CI (run 40054430687) the status went from "Indexing 0 lines…" straight to "1 line · UTF-8". Brief §8.2 asks for the indicator while the scan runs, not a given count.

**Carried requirement from PR 3's review (§7.3 🔒, owner M4's Rendered lens):** a `<link rel="preconnect">` or `<link rel="dns-prefetch">` inserted into the page bypasses both the CSP and `session.webRequest`. The review planted one, and the NetLog showed DNS resolver events.
- It isn't reachable in M1, because Raw renders text only, never markup.
- Before any lens renders document-controlled markup (Rendered, M4), Typose must block it, and the NetLog assertion must cover a planted preconnect and dns-prefetch.
- Candidate mechanisms: the sanitizer refuses `link` elements, plus a network-context setting that turns off preconnect and DNS prefetching. They're chosen and tested in M4.

**PR 4's amendments (mechanisms only; no gate change. The after-only check amends §3.1's 🔒 text by Z63):**
- **One identity check per `page()` or `piece()`, after the reads, and it walks the path first.** PR 1 checked before and after.
  - The check runs the open's route walk (the path form, the drive letter's target and every link in the path) before `FileId::of` opens the path. Each component is read with `GetFileAttributesW`, which doesn't follow a link.
  - *Why the walk:* after the open, the path, a link in it or its drive letter can be swapped to reach a pipe, and on Windows the stat opens the path (PR 1's known limit 1). Change detection still stats the path (§3.3 🔒).
  - *Identification-level impersonation only* on the by-path opens: the open's stat and read (`refusal`, `open_regular`), change detection's stat (`FileId::of`), and the walk's open of a link. So a swap that wins the race between the walk and one of those opens can't let a pipe server impersonate Typose. Two calls in the walk can't take the flag, a residual reachable only by winning the same race: `GetFileAttributesW` has no parameter for it, and `std::fs::read_link` opens the link without it (doing that by hand means `FSCTL_GET_REPARSE_POINT` and parsing both reparse layouts).
  - *Why after only:* the reads go through the open handle, never the path. The check compares the path with the identity taken at open, not with the previous check, so any change before or during the reads fails it, and nothing those reads returned is shown. A check before the reads would catch nothing more, at twice the cost.
  - Spec §3.1 and brief §7.9 said "before and after every lazy read"; they now say "after", by Z63 (Zack, 2026-10-23).
  - *Cost,* at the napi layer: 3,000 random 64 KiB pages (328 lines of 200 B each) on an indexed 256 MiB file, at an 11-component path, in three interleaved runs. Main's addon (no walk, a stat before and after): p50 1.80–1.86 ms, p95 2.20–2.32 ms. A walk and stat before and after: p50 2.38–2.40, p95 2.91–3.03. After only: p50 2.09, p95 2.52–2.55.
  - The first PR 10+ candidate for §10.2's 64 KiB fetch gate (p95 < 3 ms, round trip) is the page path's own cost, which is larger: for every line, `pages::cut` copies a 64 KiB read window (`pages.rs:103`), about 21 MB for a page of 200-byte lines.
- **The index reads through a handle reopened from the document's** (`ReOpenFile` on Windows, `dup` on Unix), not through the path. *Why:* the same swap would otherwise connect the index's own open, and the reopened handle indexes the file the document actually has open.
- **Stopping an index:** `index::build`'s progress callback returns whether to go on, once per block. The freeze half stops through it: when a page finds a change, or Reload supersedes the generation, the job ends at its next block. *For PR 5:* C6's cancel flag can return through the same callback, with no new parameter.

**PR 5's amendments (mechanisms and test details; no Z-decision, 🔒 requirement or gate changes):**
- **C6's ledger clauses are checked from PR 6.** PR 5 checks the rest of C6 by the test-hooks build's debug stats: after close, 0 jobs, 0 tasks, 0 handles and 0 documents; after a truncation, 0 jobs and 0 tasks, the document's handle kept, and none after close. *Why:* the ledger is PR 6's (C1), so PR 5 has no ledger to compare with a baseline. C1's exhaustion test already cancels an index mid-run, truncates another and closes all, against the byte-exact baseline, so Z47's "releases on close, cancellation and failure" stays tested in M1.
- **C5: the lens cancels every request the wanted range no longer meets, not only the oldest.** A cancelled request keeps its place among the 2 until it ends, within one chunk read, so the core never runs more than 2 reads for a lens. *Why:* §3.4 🔒 says "stale requests are cancelled"; cancelling only the oldest would leave a stale read running while a wanted one waits. In one PR 5 run, 328 jumps in 2 s gave 38 cancels, with at most 2 requests out.
- **C5's `DocHandle` is the lens's own request loop for now:** each frame it cancels stale requests (an `AbortSignal` per call, which `CoreClient` turns into `cancel(id)`), then sends at most one request. *Why:* M1 has one lens and the rules are per lens; a shared class with one user would only move the loop. It's extracted when M3's second lens needs it.
- **C5: "superseded" means cancelled while its read runs.** The core host answers `cancel(id)` with whether the read was still running, and from then on it never resolves: a cancel that lands after the reads, while the result is on its way to JS, still rejects it with `Cancelled`. A request whose answer had already left the core host when the renderer cancelled it can't end `Cancelled`; the lens ignores it as a late result. The test checks that every cancel that found its read running ended it `Cancelled`, the slowest within one chunk read (97 ms with a 100 ms delay per read, in that run), and reports the late ones (0 of 38 there). *Why:* the race is inherent: the answer and the cancel cross on the port.
- **C7's delayed old-session events are held on their way into the renderer's client.** The test hook holds everything one session's port delivers, from before the kill until the test releases it after Reopen. *Why:* a killed core host sends nothing late. The only place an old session's page or progress event can arrive late is between its port and the client: a message already queued or in delivery when the death is reported. Released there, a progress event of the old session's document 1 at generation 1 would match the reopened document (ids and generations restart), so only the session check stops it; removing that check changes the reopened card's status (PR 5's negative control).
- **Proposal 2 (C7): once 60 s have passed since the last respawn, main respawns the core itself, and the card then offers Reopen.** Until then, the stopped state offers nothing. *Why:* the same outcome as Reopen respawning the core, without a renderer-to-main restart call or a "try again in N s" state for a click that comes too early. Main still respawns at most once per 60 s, and there's still no automatic reopen.
- **C7's port teardown:** on a death, main closes its handles to both ends of the session's channel and removes the utility process's listeners. Both ends were transferred: the core host's died with it, and the renderer detaches and closes its own when it hears `core-gone`. The renderer takes a port only from its own window and only for a newer session than the last.
- **C6's debug stats count:** `handles`, the documents' open byte stores (each one file handle); `jobs`, index threads not yet ended (a job's own reopened handle closes before its thread ends); `tasks`, page reads not yet settled. They exist only in the `test-hooks` addon, with the per-read delay.

**Amendments from PR 5's macOS run (main-macos run 40067408502, on PR 5's merge):**
- **C5's "within one chunk read" is a chunk read as the machine times it.** The test-hooks addon times every delay, and its debug stats carry the slowest (`delayMs`). Setting the delay starts the slowest over. The e2e test holds the slowest cancel under that plus 50 ms, and the napi test holds the rest of its cancelled read under that read's slowest delay plus 50 ms. The e2e bound is the run's slowest delay, since the core host sets the delay once: on macOS an outlier anywhere in the run loosens it, and Windows' and Linux's PR CI, where delays are tight, still catch a regression in the shared cancel code. *Why:* on the macOS runner a sleep overruns in every process, the test runner's own too: there, 100 ms waits took up to 242 ms in the test runner and 248 in main, and the core host's 100 ms delays up to 247 (run 40069785888). Against the nominal 100 ms, the e2e test failed there (232 ms) with no fault in the product: the cancelled read's result reached the core host's JS thread within 0.15 ms of its compute. The napi test's read ended 197 ms after its cancel there, against 200 (run 40072658390). On Windows a delay takes at most about 100.6 ms, so the e2e bound there is the old one. The gate is unchanged.
- **C9's lifecycle log also records `ready` and the page's `did-finish-load`.** *Why:* a launch whose window never came logged only its start, so its log couldn't say how far it got.
- **C9's harness kills a launch whose window never comes, or that hasn't exited 15 s after its close, keeps its evidence, and fails the test.** *Why:* each one held the job for minutes, at macOS's 10× (Z61): 5 at the worker's teardown, twice in run 40067408502, and the e2e step's whole 12-minute time box in run 40070774628.
- **`main-macos.yml`'s dispatch takes `grep` and `repeat-each`, and then skips `cargo test`.** *Why:* a macOS fix is checked on its branch for what its tests cost. A push to main runs everything.
- **On macOS, AppKit restores no windows** (proposal 5, below).

**PR 8's amendments (mechanisms and test details; no Z-decision, 🔒 requirement or gate changes):**
- **A second instance's argv and cwd come as `requestSingleInstanceLock`'s `additionalData`, not as the `second-instance` event's `argv`.** The first instance reads them as it reads its own.
  - *Why:* the event's `argv` is Chromium's re-parse of the command line. PR 8's probe of 18 shapes (Electron 44.9.2, Windows) showed:
    - switches moved ahead of the paths, with `--allow-file-access-from-files` added;
    - each argument's leading and trailing whitespace trimmed: ` lead.txt ` arrived as `lead.txt`;
    - on Windows, an argument starting with `/` taken for a switch;
    - after `--single-argument`, the rest turned into one quoted argument ending in a NUL.
  - `additionalData` arrived exactly in every case. It's as untrusted as argv: unless it's a string array and a string, of a real launch's size, it names nothing, and its path goes to the same open as any other (C4's path check, then §3.3's refusals).
- **Paths:** every argument after the first `--` is a path, whatever it looks like; before it, a switch isn't one. The newest file named is the last. A path is never read as a URL. `typose://…` and `file:…` are relative paths that open nothing, and `\\?\`, `\\.\` and pipe paths reach the core's refusals unchanged. While the core is stopped (C7), a newer path replaces the stopped card's, and Reopen opens it.
- **The lock comes before C9's log, and a second instance exits with `app.exit(0)`.** So it writes no log line and no `running` marker. That's C9's "only after PR 8's single-instance lock", and the markers stay per pid.
  - *Why:* `app.quit()` before ready still runs the launch. The probe logged `before-quit`, `will-quit` and `quit`, then `will-finish-launching` and `ready`, so the second instance would have opened a window and spawned a core.
  - Before the message loop runs, `app.exit` ends the process at the call (nothing after it ran), with exit code 0. The message is already sent by then: every hand-off in the probe and the e2e arrived.
- **A second launch can kill a hung first instance (Windows).** Chromium's process singleton terminates a first instance that doesn't answer within about 15 s. PR 8's review saw it: a sparse `additionalData` array of length 2^32 − 1 froze main (fixed: see C4 below), and a later launch killed it with exit code 2. The killed instance logs nothing. So C9's harness reads exit code 2, with no quit logged and `previous-run-unclean` at the next launch, as that kill. It identifies the exit; the hang behind it still needs explaining (Z56, ruling OQ-3).
- **The launchers** (`app/bin/typose.cmd` and `app/bin/typose`) take no options: every argument is a file, and one leading `--` is their own.
  - They pass the files after `--`, and don't wait for Typose. They ship in the package's `resources/bin` (`Contents/Resources/bin` in the `.app`) and run the Typose two folders up.
  - The `.cmd` passes each argument quoted and expands none of them again, so `%`, `^`, `&` and `!` arrive as given. An empty argument ends its list, since cmd.exe can't tell `""` from the end.
  - What reaches it is the caller's quoting, and cmd.exe's own parse:
    - unquoted, `=`, `,` and `;` split an argument, so such names need quotes;
    - a trailing backslash breaks the re-quoting (`"C:\dir\"` reads as an escaped quote). It's harmless for files. When folder roots arrive, the launcher must double trailing backslashes;
    - a `"` inside an argument breaks the `.cmd`. Windows file names can't contain one;
    - before `--`, an argument starting with `/` is a switch to Chromium and a path to Typose; harmless either way.
  - **From PowerShell 5.1, the `.cmd` is a command-execution hazard.** A name with `&` reaches cmd.exe unquoted, and cmd.exe runs what follows the `&` as a command (`a&b.txt` runs `b.txt`; PR 8's review). That's the outer shell's handling of batch files, so no `.cmd` can fix it. It's unreachable in M1, since nothing is on PATH until M7. M7 carries the requirement below.
- **The launcher test runs them against a stand-in Typose** that records its argv and cwd: Electron's own binary with a stub app on Windows, a script elsewhere. *Why:* the launchers pass no `--user-data-dir`, by design, so the real app would reach the user's own instance. The second-launch test drives the packaged executable itself with the same path shapes, on the test's own profile.
- **C4's table:** PR 8's new input is a second instance's message (`handoff`, `app/main/launch.ts`). Main checks its size before reading any element: at most 4,096 arguments, and 32,767 characters of arguments and of cwd, Windows' command-line limit. Then every element must be a string; a hole isn't. `launch.test.ts` refuses a sparse array of length 2^32 − 1 at once. PR 8's first check, `argv.every(…)`, froze on it, as main did in the review. The path then goes to the core's `open`, whose checks C4 already covers.

**Carried requirement from PR 8's review (owner M7's PATH install):** PowerShell must get an entry point that isn't a batch file: a `typose.ps1` that runs `Typose.exe -- @args`, or an exe shim. The `.cmd` alone isn't enough (the hazard above).

**Different user or elevated (§8.1, D15).** The lock is per profile, and each user has their own.
- A launch by another user (Windows' Run as different user, say) starts that user's own Typose, on that user's profile. The running window sees nothing. Untested, as it needs a second account.
- An elevated launch on Windows (Run as administrator) is the same user and profile, so it reaches the lock. What follows comes from the mechanism, and is untested, because testing it means a UAC prompt. Chromium's Windows singleton messages the running window, and Windows (UIPI) blocks messages only from a lower integrity level to a higher one. So:
  - a launch that isn't elevated, into an elevated Typose, can't reach it, and does nothing, as §8.1 says;
  - an elevated launch into a Typose that isn't elevated probably does reach it, and its file opens in the running window. §8.1 says it does nothing.

**Implementer calls in PR 4 (brief gaps):**
- Brief §5.1's "1MB" per line is 1 MiB: 16 pieces of 64 KiB, in C2's source bytes. A continuation is issued only while at least 4 bytes (the longest element) are left before the line's first MiB ends, so no piece is ever empty.
- "Further pieces mount on demand": the first piece ends in a "↪ more" button. Activating it gives the line one row per piece, each fetched when it comes into view. Expanding every long line on its own would shift every row below whenever a page revealed one. Until it's expanded, a long line shows its first 64 KiB, where brief §5.1 says lines over 1MB "show their first 1MB" (Zack may veto).
- "Empty file (0 bytes, or only whitespace)" is judged on the first chunk, so only for files up to 1 MiB. A bigger whitespace-only file shows its blank lines, since telling would take a full scan.
- Every freeze shows brief §7.9's "Changed on disk · Reload (Ctrl+R)" banner, with the reason in its tooltip. That includes an I/O error, which C6 freezes on too.

**PR 9's amendments (the runner's mechanisms and test details, and the coordinator's rulings in its fix rounds; the frame rules clarify Z62; no Z-decision, 🔒 requirement or gate threshold changes; the evidence is in PR 9's description):**
- **The warm rows that open a file open it in a running app (the coordinator's ruling).** That's the first screen on 1 GiB and 10 GiB, the named set, huge-first, the 1 GiB line, and open-then-scroll.
  - The app is launched by argv at the file's path while the file is parked under another name. Once its card shows "File not found", the file goes back, and Ctrl+R opens it: `App.tsx` reloads a failed card by opening its path, as `e2e/states.e2e.ts` drives it. No dialog opens.
  - Cold launches keep argv, as plan §5 requires.
  - *Why:* an argv open comes before the page's first frame (91–179 ms in PR 9's first pass). With Z64's clock, the argv runs measured only the page's first frame to its next, 2.6–8.3 ms, whatever the open cost.
  - In-app, the page's first frame came 212–473 ms before the open, so the clock starts at the open.
  - The control: the page's open request is held 60 ms over CDP. Every first screen reads 84.7–93.9 ms, and the row fails.
- **On the huge-first file, a run whose scan ends inside the budget from the clock's start isn't judged on order, and doesn't fail the row.** That's the exemption plan A's veto keeps (packet:476-478). PR 4's ruling (a run that isn't judged fails on Windows and macOS) stays the 1 GiB line's: that fixture exists to be decisive.
  - *Why:* the 200 MiB record's scan takes 44.1 ms from the open (p50; p95 60.6, max 80.2), so in-app it outlasts the budget in only some runs: 6 of 30 were decisive (all passed), and 24 weren't judged.
  - The row rests on the budget, the small records following, and no item over 64 KiB.
  - The 1 GiB line was decisive in 30 of 30 in-app runs, against 29 of 30 by argv.
- **An input's answer is the frame that owns its paint (the coordinator's ruling; C8).** That's the presented slice of the frame whose main-thread `AnimationFrame` contains the painted mark: `begin_frame_id.sequence_number` = the `PipelineReporter`'s `frame_sequence`.
  - If that frame never presents, the next presented frame after it answers, and runs count these (`ownerUnpresented`). A mark with no `AnimationFrame` around it makes the run invalid.
  - *Why:* the paint mark fires in a rAF inside its own frame, which began before the mark. In PR 3's keypress trace, `BeginFrame 153` came 3.42 ms before the mark, the `AnimationFrame` around the mark names frame 153, and frame 153 presents 7.33 ms after the mark.
  - "The first present after the paint", PR 3's rule, was often a frame early. Over 6,385 answers in 84 traces, ownership moved 4,946 later (p50 +7.6 ms).
  - The keypress answer stays 6.2 ms. The first jump after launch is answered by its paint's frame (seq 150) at 44.0 ms, not by a compositor frame at 20.8.
- **An owning frame with no update answers nothing (the coordinator's round-5 ruling; C8).** If the owner is `STATE_NO_UPDATE_DESIRED`, with no presented slice, the input changed nothing on screen: it's timed to its mark, in `unanswered`. The next-present fallback stays for dropped and partial-only owners.
  - *Why:* while indexing, the row count in Raw's key grows between marks, so an input that moved nothing reads as a change. Its owner never presents, and the fallback answered it with an unrelated frame.
  - That frame opened a cadence interval (the review's P5: cadence `fail` on a 44 ms gap), or made a false stall (P5b: 51 ms).
  - Of the round-4 final pass's 48 traces, the rule changes 7. One is a 10 GiB jump whose pointerdown had such an owner: it read cadence `pass` on a judged frame that wasn't its answer, and now reads `n/a`. The other six are open-then-scroll runs, each with one such input; their verdicts don't change.
- **The answer's linkage is checked (the round-2 review).** A run is invalid when the `AnimationFrame` around a paint mark is another process's, or when the owning frame presented before the mark.
  - *Why:* either one would link a mark to a frame that can't be its answer. The review's constructed cases read −30 ms and −890 ms.
- **Retracted: "an answer must begin at or after its paint mark" (the coordinator's ruling in PR 9's second fix round, withdrawn in its third).** *Why:* the frame that carries the paint began before it, so that rule was always a frame late.
  - Over the same 6,385 answers, it moved 99% of them later, p50 +15.6 ms: one frame past the frame that owns the paint (p50 +7.5 ms).
  - On PR 3's 21-key control, each key would have been answered by the next keypress's frame: 116.0 ms instead of 6.2.
- **A merged interval's frames start at its first answer (the coordinator's ruling; C8).** Presents between an input and its answer are compositor or pipeline frames that can't carry the response, and the input's latency covers that span. Cadence judges every present after the first answer.
  - *Why:* in the first jumps after launch, a frame begun after the pointerdown, but before the paint's own frame, presented 23.5–31.2 ms before the rows' frame, and was judged as a long gap.
- **Removed: round 1's "a present belongs to the interval only if it began at or after the interval's first input".** The interval-starts-at-answer rule decides what it decided.
  - *Why:* kept as a guard, it would discard answers. The owning frame often begins before its input: in PR 3's keypress trace, frame 153 began at −3.42 ms, and the keydown came at −0.73 ms.
  - Without it, the first pass's jump runs' first present (begun 3.1–8.8 ms before the pointerdown, the review found) is still left out: it presents before the answer.
- **Only an input that changes the view opens a demanded interval (the coordinator's ruling; C8).** An input whose first mark is a later input's is folded into it: a scrollbar pointerdown before the drag's `scroll`, Control before End, or two keydowns painted in one frame.
  - **A folded input is judged (the coordinator's round-5 ruling, stricter than round 2's).** It's timed to the present that answers the mark it folded into, and judged on responsiveness, whatever its kind. Folding only keeps it from opening or anchoring a cadence interval.
  - *Why:* folding hid real view-changing inputs. Two keydowns painted in one frame folded the first, so a 57 ms stall read as a pass (the review's P3k).
  - Withdrawn: round 4 timed a folded input to its mark, in `unanswered`. That kept the driver's ~7 ms between a pointerdown and its drag out of the pointerdown's figure, which read 51.2 and 51.4 ms on two 10 GiB jumps whose scrolls were answered under 50 ms.
  - **Except a folded pointerdown (the coordinator's ruling A, round 6, revising round 5's).** It counts in `folded`, and its latency to the drag's answer is reported in `foldedToPaint`, but it isn't judged on responsiveness. Every other folded input stays judged, which is what closes P3k.
  - *Why:* a folded pointerdown's latency is press → the drag's answer, and that span includes Playwright's separate `mouse.down` and `mouse.move` round trips: driver time, not app time. At `2d4050b`, the 1 GiB jump with a11y off failed on pointerdowns at 50.6–52.2 ms while every drag was answered under 50.
  - Folded modifier keydowns (Control before End) stay judged. The input mark carries only `keydown`, and the trace's `EventDispatch` only its type, so the key can't be recovered.
- **Every trace begins with a baseline mark (the coordinator's ruling; C8).** When tracing starts, `drive.ts` dispatches `typose:baseline`, and the renderer marks the view as it stands as painted sequence 0.
  - *Why:* without it, a first input that changed nothing read as a change if its mark was the trace's first. In one first jump after launch, the pointerdown (mark `0,0,1000000`, the top view) opened an interval, merged with the drag's late answer, and failed cadence on a 53.0 ms gap.
- **The live controls, after these rules:**
  - The uninjected jump control (ten jumps per launch, from the top) read `n/a` in 140 of 140 jumps after the baseline mark, in round 4: 100 at `--repeat-each=5`, ten to a launch, five launches in each mode; and 20 in each of two whole-file runs. About 120 of those were analyzed before round 4's folded-input change; that doesn't change cadence.
  - With the round-5 rules, on the build merged with PR 5, it read `n/a` in 60 of 60 jumps at `--repeat-each=3`, three launches in each mode, and in 20 of 20 in the full `npm run perf` pass. Its 118 answers at `--repeat-each=3` reached 46.5 ms, none over 50; the pointerdowns are among them now.
  - PR 3's controls behave as specified. The 21-key control reads `n/a` with accessibility on and off. In the round-5 full pass, the scroll control with accessibility on judged 240 frames, under its 250, with two 61 ms answers, at 35.7% CPU during the run (8–15% in every earlier pass). Run again on its own, it judged 239 at 65%. Round 4's and round 5's analyzers read both traces the same: the driver delivered 236 and 239 wheel events, against 249–260 in every earlier pass. With accessibility off it passed both times.
- **The scroll control's `frames > 250` floor is replaced (the coordinator's ruling B, round 6).** It was a guard against a vacuous run, but it mixed in how fast the driver delivers input.
  - Integrity, a fail: judged frames ≥ the presents inside the gesture's demanded interval, from its first input, minus 2 (`presents` in the analysis).
  - Delivery, a precondition: ≥ 200 wheels, and every gap between consecutive wheel inputs under 60 ms, from the input timestamps (`wheels`). Unmet, the run is invalid, with the counts as its reason.
  - Stalls, cadence and responsiveness stay fail conditions.
  - *Why:* on the a11y-on traces, Chromium's gesture generator pauses every ~170–180 ms for 17–56 ms, and the pauses grow with load (the round-3 review). The 07:25 run (65% CPU) failed only the floor: 239 of 240 presents judged, wheel gaps up to 28.2 ms, cadence and responsiveness both pass.
  - On the saved traces, 07:25 now passes. 07:03 still fails, on its 60.9 and 61.0 ms answers (236 wheels, largest gap 55.9 ms, 240 of 242 presents judged). Both a11y-off runs pass (256 of 257).
- **Raw doesn't mark a scroll its list applied itself (`VirtualList.ownScroll`).** That covers a wheel or key in logical mode, whose own mark is the input, and the position re-applied as the index grows.
  - *Why:* the review found that on the indexing 10 GiB file, 15 of 21 jump-row answers came from the list re-applying its own position.
  - The second pass marks one `scroll` per jump, indexing or not (12 of 12 runs).
- **The 64 KiB fetch is timed on the app's own core port, 300 pages over 3 launches.** The runner takes the port and the document from the app's next page request over CDP, by patching `MessagePort.prototype.postMessage` as PR 3's suppression control does. Then it times 100 random 327-line pages a launch, renderer to core host and back.
  - *Why:* the renderer's `CoreClient` is private, and a hook would be product code for what CDP already reaches.
- **Line index throughput is decimal bytes over `typose:open-start` → `typose:index-done`, from the 30 first-screen runs on the 10 GiB file, judged at the p95 time.**
  - Off NTFS, or with real-time protection off, the row is "not qualification-grade", never a pass. Defender's exclusions can't be read without admin (they read "N/A: Must be an administrator"), so they're recorded as unknown.
  - *Why:* the core reports no elapsed time, and the renderer's marks bracket it. The span includes the open's round trip, so it under-reads the index's rate.
- **Scrolling while indexing is two cases, each in its own launch: a 2 s wheel gesture, and PR 3's 21 discrete keys.**
  - A run whose index was done before its drive began is invalid ("not while indexing"). A drive that outlasts the index is judged whole, with its overlap recorded.
  - Input latency while indexing is every answered input of both cases, judged by C8's responsiveness: each under 50 ms, and every target painted.
  - *Why:* the 10 GiB index took 2.0–2.1 s here, which doesn't hold both drives after the trace's 500 ms lead-in. Each drive overlapped the index for its first 1.30–1.48 s, of 2.06–2.31 s.
- **A frames run with an input its drive didn't send is invalid, with the inputs named.** *Why:* the runs take focus on a PC its owner may be using.
  - `Control+End` is two keydowns, Control's and End's.
  - A wheel drive also marks `scroll` while the document still scrolls natively, under 16M px: a young index's first moments after an open.
- **Exit integrity (plan §5, OQ-3):** a launch that doesn't quit cleanly fails its test, and never invalidates its run. That's in the runner and in `startup.perf.ts`.
  - So does anything its kept `lifecycle.jsonl` shows the test didn't ask for: `render-process-gone`, `child-process-gone`, an `uncaughtException`, or the core host exiting before the quit.
- **Plan §5's cold first screen is judged from the open request.** *Why:* a cold launch passes no debugging switch, and the TYPOSE_MARKS hook carries no first-frame mark, so Z64's later clock start can't be read there.
  - That's stricter than Z64: with the page's first frame 91–179 ms after an argv open, it charges startup to the lens.
  - Reading Z64's start needs a first-frame startup mark in the renderer. That's a product change, left to the startup remediation (PR 10+).
  - The batch verdict (`e2e/perf/cold.mjs`) is the worst of five valid restarts, taking only each restart's first launch. Until there are five, it's pending.
  - **A batch is one build's restarts, one record per boot (the round-2 review).** Each cold record carries the packaged exe's and asar's sha256 and the OS boot time (now minus uptime). The batch is the build of the run being judged, and the first record of each boot; two boot times within a minute are one boot. A record without them isn't counted.
  - *Why:* the records carried no build or boot. So restarts from different builds combined into one "complete" batch, and two COLD runs after one restart both counted, the second not cold (Z54).
- **Z49 is a record field.** `qualification` is true only when QUALIFY=1 measured a minute of CPU under 10% before the row; QUALIFY=1 is also the operator saying there's no other heavy work and Defender is on. Every row of PR 9's passes is `qualification: false`.
- **Deep reading requires the thumb to land within 5 lines of line 40M**, and §13.1's ±1 line equality with line 0, not a pinned count.

**Found in PR 9, carried (product):**
- **The first far jump after launch can answer its drag late.** In one run of the jump control (1M lines; round 3, a11y off), the drag's `scroll` came 32 ms after the pointerdown, and was answered 75.3 ms after the scroll's timestamp: a responsiveness miss, which the scrollbar-jump row judges.
  - The runner's jump rows, each one a first jump after launch, didn't reproduce it in round 4's final 12 runs: answers 29.5–47.7 ms.
  - Nor did the jump control's ten launches since the baseline mark: their first jumps were answered in 37.4–46.6 ms.
  - In the round-5 full pass, drags were answered in 30.6–47.7 ms, except one at 264.5 ms on the 10 GiB file at 66.7% CPU. Its pointerdowns, judged in round 5 and reported apart since ruling A, took up to 52.2 ms, and that 10 GiB one 269.6.

**Implementer proposals Zack may veto (one place):**
1. **Memory-refused open state** (C1), shown in the card: "Can't open `<file>` · Typose's memory budget is full. Close a file, then Retry." Brief §7.9 has no such state yet.
2. **After a second core death within 60 s,** the core is respawned once 60 s have passed, and Reopen is offered then (C7; amended in PR 5, above).
3. **Raw wrapping** (brief §5.1's wrap rules) is deferred to M4, with horizontal scrolling meanwhile (plan §6).
4. **Raw's accessibility pattern:** a labelled, focusable region with an `aria-hidden` gutter (PR 1, checked in PR 7). Neither §6.1 nor brief §9 defines one. If Zack accepts it, it becomes a row in §6.1's 🔒 table.
5. **No AppKit window restoration on macOS:** main registers `ApplePersistenceIgnoreState` before the run loop starts (after PR 5's macOS run). *Why:* Typose restores no window through AppKit, yet after a crash AppKit asks at the next launch whether to reopen its windows, in a modal that keeps the launch from finishing until it's answered. In main-macos run 40072658390, after `lifecycle.e2e.ts`'s deliberate crash, 7 launches in a row sat in it, and on CI no one answers.

**Implementer calls on spec gaps:**
- §3.4 gives no unit for "256KiB" or "64KiB of text". C2 sets source bytes plus an item count.
- §3.4 triggers `ArrayBuffer` encoding on page *decode* > 3ms p95, while §10.2 gates the *round trip*. M1 measures both and applies each rule to its own number.
- §10.2 reports warm p50 and p95 without saying which is judged. M1 keeps plan A's p95 rule.
- §13.1's cold first-screen gate (< 150ms) has no Mac value, so Mac cold is reported (plan §5).
- §8.1's launcher is "installed by the installers". It ships in M1 and is installed in M7.
