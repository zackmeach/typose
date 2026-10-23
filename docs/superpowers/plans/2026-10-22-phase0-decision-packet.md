# Phase 0 decision packet — 2026-10-22

**Completed 2026-10-22 by Codex at Zack's request.** Checked answers and their notes are the selected direction; the original context and leans are retained below. These are delegated decisions, not quotations from Zack or evidence that a gate has passed.

**Original handoff (historical):** this packet initially supplied decisions for later spec/plan propagation, preservation and commits. The recorded update below supersedes that initial pending status.

**Recorded 2026-10-22:** spec Draft 4 §0.4 (Z39–Z50) and brief revision 6 §0.5. On approving the follow-through, Zack also parked all screen-reader work until after launch ("park the reader work for an expansion opportunity, no voice work until after launch"). That is Z39, and it supersedes Q1's answer below and Z35.

**Latest decisions:** the [checkpoint addendum](#checkpoint-addendum--conditional-go-to-m1-2026-10-22) below changes the sequence and milestone Mac-access choice. It supersedes conflicting earlier packet answers; propagation into Z38, Z50 and spec §13.1 remains for the implementation owner.

**Baseline before these decisions (reported by the packet's author).**
- **Plan A** (base + Spike A) is closed. It passed 3 review rounds, then the Z37 amendment passed 2 more.
- **Plan B** (Spike B) passed its round-2 review: APPROVE-WITH-FIXES. Every round-1 finding is closed. Its fix round waits on Q1 and Q2.
- **Plan C** (Spike C) is fully assembled and replayed green on the final plan A. Its round-2 review hasn't started, so settling Q5–Q11 first lets that review judge against settled scope.
- **Nothing is committed** (Q4).
- Plans B and C are in the repo as `-DRAFT` copies.

**Evidence paths.** `<SP>` means `C:\Users\zdm80\AppData\Local\Temp\claude\C--Users-zdm80-Typose\f692a7fc-20e8-46a2-87c8-8d44df3fa789\scratchpad`, the session scratch folder. It may not outlive this session (Q3).

**Contents**
- Part 1: blocking the next steps (Q1–Q4)
- Part 2: scope deviations plan C recorded (Q5–Q11)
- Part 3: running the real gates (Q12–Q13)
- Part 4: calls I made — veto any
- Part 5: heads-up for the Phase 0 checkpoint (no decision now)

---

## Part 1 — Blocking the next steps

### Q1 · Z35 on Narrator and VoiceOver: making the full reading test able to fail

**Blocks:** plan B's fix round.

**Context.**
- Z35 has the full 2,000-block reading test (S11 forward, S12 backward) run on NVDA, Narrator and VoiceOver.
- NVDA's Speech viewer keeps a log, and the plan's speech-log check reads it line by line, so NVDA can catch a single lost or repeated block. That check passes a correct log and fails one that skips a block, has a wrong heading or jumps back. It has two blind spots — a misplaced start marker, and a heading key that did nothing — and the plan B fix round closes them (Part 4).
- Narrator and VoiceOver keep no log. The plan currently says "listen, note the first and last numbers and any jump you hear". The round-2 review showed this can't fail:
  - holding Down cuts each line off before its block number is spoken, so a lost block goes unheard;
  - the first and last numbers don't change when one block in between goes missing;
  - say-all would speak every number, but the ranges are 93,687 and 92,440 words: 3.9–8.7 hours per direction per reader.
- Evidence: `<SP>\planb\rev2\REVIEW.md`, MAJOR 1.

**Options.**
- **A. Paced protocol.**
  - Use the next-item key one press at a time (Narrator: Down in scan mode; VoiceOver: VO+Right), letting each block number be spoken.
  - Write down every number that ends in 00. The test passes when the list runs 3000, 3100, … 4900 forward, with nothing missing or repeated.
  - It costs about 1 hour per direction per reader, so about 4 hours for Narrator and VoiceOver together.
  - It catches a gap that crosses a hundred-mark, or a jump. A single lost block between two marks can still go unheard.
  - It adds a Checkpoint item 7 recording that this is a listening test.
- **B. Build speech capture.** An AppleScript poller of VoiceOver's last phrase, plus a Narrator equivalent, so both readers get NVDA-grade logs.
  - This is new tooling and hasn't been tried. Narrator has no obvious hook.
  - It costs engineering before Phase 0 can close.
- **C. Accept the gap.** Keep "listen for jumps" as written, and record in the checkpoint list that a lost block can go unheard on those two readers.
  - It costs the least of your time and has the weakest evidence.

**My lean: A.** NVDA's exact log already carries the "no position lost" claim. A's four hours make the other two readers catch everything except a single-block gap, without new tooling.

**Your call:**
- [ ] A
- [ ] B
- [ ] C
- [x] Other: Paced reading with every block transition checked, not just every hundredth block.

**Superseded by Z39 (2026-10-22):** reader work is parked until after launch. The protocol below is kept for that expansion.

**Notes:**

- Keep Z35's full forward and backward runs on all three readers. NVDA evidence does not qualify Narrator or VoiceOver. Sampling hundred-marks can miss multiple omissions or repeats between marks, not just one block.
- For Narrator and VoiceOver, advance one native reading item at a time and let its block number finish. Check each newly encountered block against a pre-generated numbered checklist. Preserve the current fixture, its long heading-free regions and its native reading path; do not jump between blocks through app controls to speed up the test.
- Use the script's actual endpoints: S11 starts at **2988** and reaches **4988**; S12 starts at **11508** and reaches **9508**. Check every intervening position in order. Normal repeated labels within one block are distinct from losing or revisiting a block after leaving it. Keep the checklist outside the app's focus path, and retain a local recording of the reader output for ambiguous transitions.
- A missing, out-of-order or unexplained repeated position fails. An inaudible or unrecorded stretch is incomplete evidence, not a pass. The every-hundred list may be a progress aid only. Validate the revised protocol against a deliberately skipped non-hundred block and a repeated block before using it to qualify the build; record this as a manual test, not NVDA-grade automated capture.
- Do not build speculative reader-specific capture tooling for this fix round. If the paced protocol cannot produce a complete auditable sequence, the affected reader gate remains open. No duration estimate is accepted before a pilot.

---

### Q2 · Grid: what Space and Shift+Space do (P3)

**Blocks:** plan B's fix round, which rewrites screen-reader script task S05's "Must hear" line.

**Context.**
- **As built,** Space and Shift+Space in the Grid page-scroll down and up and leave focus in place: the browser model.
- **What Excel does:** Shift+Space selects the row and Ctrl+Space the column.
- **What the brief says:**
  - Grid selection, brief §7.4: click a row number to select the row; select a column from the header's context menu.
  - It defines no keyboard path to either. Brief §9 requires a focus equivalent for every hover affordance, and the same keyboard-parity principle applies here.
- Selection isn't built in the spike. This decision sets the milestone behaviour and what the script expects.
- Ctrl+Space can toggle the input method on some Windows keyboard layouts (CJK). Excel uses it anyway.

**Options.**
- **A. Excel model.** Shift+Space selects the row, Ctrl+Space selects the column, and Space alone does nothing special in the Grid. This gives keyboard parity with the brief's row-number click and the column menu.
- **B. Browser model, as built.** Space and Shift+Space page down and up. Row and column selection get some other keyboard path.
- **C. Mixed.** Space pages down, and Shift+Space selects the row. Space and Shift+Space then stop being a matched pair.

**My lean: A.** Spreadsheet users and screen-reader users of grids both expect it. Page Down and Page Up already page.

**Your call:**
- [x] A
- [ ] B
- [ ] C
- [ ] Other: ____________________

**Notes:**

- Adopt Shift+Space for row selection and Ctrl+Space for column selection when Grid navigation owns focus. Page Up/Down handle paging. Space must still activate a focused button, checkbox or menu item normally; the grid must not swallow child-control input or IME composition.
- Provide keyboard-reachable row/column selection commands as the fallback when the OS or input method owns a shortcut. This follows the [WAI-ARIA data-grid keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/).
- Plan B must separate the current spike from the product requirement: selection is not implemented, so S05 cannot report a selection announcement as passed. Remove the conflicting Space paging behavior in the fix round, retain navigation checks, and mark selection checks deferred to the Grid milestone with an explicit acceptance test.

---

### Q3 · Z38 "preserve validated spike code": form and timing

**Blocks:** the Z38 sequence step after plans B and C close. The timing matters now, because everything lives in session scratch.

**Context.**
- **Where the validated code is.** It exists only in scratch:
  - `<SP>\planb\asm\replay`: branch `spike/b`, 14 commits, a 104 KiB pack;
  - `<SP>\planc\asm\replay`: branch `spike/c`, 27 commits, a 464 KiB pack. Its base commit `ce114fc` is plan A's final Tasks 1–10.
  - Each tree was built by replaying its plan's text literally.
- The repo has only `main`.
- **Rebuilding from the plans works but drifts.** The plans regenerate the code exactly, but dependency versions move: `pulldown-cmark` 0.13.5 shipped mid-session and changed parser rules plan C mirrors. Only the trees hold the lockfiles that were tested.
- **The standing rule:** spike code lives on `spike/*` branches and is never merged.

**Options.**
- **A. Local branches in the Typose repo.** Fetch `spike/b` and `spike/c` from the replay trees, plus a `spike/a` from `ce114fc`, as unmerged branches. This writes new refs, not commits on `main`. There's no remote, so it's local only.
- **B. Git bundles outside the repo.** Write `.bundle` files to a durable folder such as `C:\Users\zdm80\typose-spikes\`. The repo stays untouched.
- **C. Don't preserve.** Rely on replaying the plans, and accept the dependency drift.

**Timing.**
- (i) Now, as a snapshot, refreshed after plan B's fixes and plan C's review land.
- (ii) Only after those land.

**My lean: A, with timing (i).** It costs nothing, survives the scratch folder, and keeps the tested lockfiles.

**Your call:**
- [x] A
- [ ] B
- [ ] C
- [ ] Other: ____________________

**Timing:**
- [x] (i)
- [ ] (ii)

**Notes:**

- Preserve immediately in local, unmerged `spike/a`, `spike/b` and `spike/c` branches, then refresh after B's fixes and C's review. Keep an immutable tag for each captured state so refreshing a branch does not erase which revision a result describes. Never merge spike code into `main`.
- Read-only verification on 2026-10-22 found B at `a6261f59e5709d0049371cba3ed62aa1160f4bac`, C at `252f9b43322e1cf05d330e760f4fad2065e514d8`, and A's base at `ce114fcb714e0dad4422d545d02b349f75f23418`. Preserve the tested lockfiles; do not regenerate them during transfer.
- Fetching refs is insufficient: B has untracked `spikes/results/sr-script.md` and `spikes/results/sr-results.md`. Preserve those separately with the relevant review/fix reports, gate logs and checker scripts in a durable, revision-labelled evidence directory. Record source paths, hashes and unrun gates. Do not relabel a results template as a completed reader run.
- Verify the transferred refs, lockfiles and evidence before treating scratch as disposable. Preservation is selected here; it has not been executed by this packet edit.

---

### Q4 · Commit the planning docs: what and when

**Context.**
- **Committed so far:** only `96d605e` (the brief, the critique, the verification and the refs).
- **Uncommitted:**
  - brief revision 5 (modified);
  - spec Draft 3 (untracked; it carries Z24–Z38);
  - plan A (closed);
  - the plan B and C `-DRAFT` copies;
  - this packet.
- **Never staged:** `astra-research.md`, `fable-research.md` and `docs/research/`.

**Options.**
- **A.** Commit the spec, the brief and plan A now. The drafts and this packet are committed when final.
- **B.** Commit everything above now, drafts included, still marked `-DRAFT`.
- **C.** Wait and commit everything at the Phase 0 checkpoint.

**My lean: A.** Plan A is closed, and the spec and brief carry your nine binding Phase 0 decisions. Today they exist only as untracked files.

**Your call:**
- [ ] A
- [x] B
- [ ] C
- [ ] Other: ____________________

**Notes:**

- Version the current planning state now, including the two explicitly marked drafts and this completed packet. Draft status is a reason to preserve review history, not to leave it outside version control. A documentation commit does not close a plan or qualify Phase 0.
- The allowlist is exactly the brief, tech design, plan A, plan B `-DRAFT`, plan C `-DRAFT`, and this packet. Stage explicit file paths and inspect the staged diff. Exclude `astra-research.md`, `fable-research.md`, `docs/research/` and scratch/build artifacts.
- Record that this packet's decisions still need propagation; commit the later spec/plan amendments separately. No commit is made as part of this packet edit.

---

## Part 2 — Scope deviations plan C recorded (settle before its round-2 review)

Plan C's "Notes for the checkpoint" lists deviations from the spec and brief. These are the ones that change product behaviour. Settling them now lets the review judge plan C against final scope.

### Q5 · UTF-16 CSV/TSV opens in Raw only

**Context.**
- Spec §4.2 and §3.4 offer the Grid for every CSV/TSV.
- csv-core tokenizes bytes, and UTF-16 has no single-byte delimiters, quotes or line ends. So a UTF-16 file gets the Grid locked with `csv::UTF16_REFUSED`, and Raw remains.
- The main real-world source is Excel's "Unicode Text" export, which is UTF-16LE TSV. pandas and most AI tooling write UTF-8.
- The fix would be transcoding to UTF-8 with an offset map, so byte spans stay exact (the spec §4.1 layer).

**Options.**
- **A.** Accept for v1: Raw only, with a lock message that says why.
- **B.** Require Grid for UTF-16 in v1. That adds a transcoding task to a milestone.

**My lean: A.**

**Your call:**
- [x] A
- [ ] B
- [ ] Other: ____________________

**Notes:**

- Accept the v1 limitation explicitly in the brief's format matrix and the spec's lens-availability contract. The lock message should say **"Grid is unavailable for UTF-16 CSV/TSV. Open in Raw, or convert a copy to UTF-8."** Keep the original bytes untouched; an encoding override must not silently reinterpret UTF-16 as a single-byte format to unlock Grid.
- Cover UTF-16LE and BE, BOM detection and the manual encoding override. This is reduced Grid coverage, not complete CSV/TSV support. Transcoding with original-byte maps is deferred beyond v1, unless real usage justifies reopening this decision.

---

### Q6 · Images from network paths and `data:` URIs

**Context.**
- Brief §4.6 has a "Load remote images" choice.
- As built:
  - an image keeps a loadable `data-src` only for http, https, `mailto` or a relative path that isn't a network path;
  - UNC (`\\server\share\x.png`) and `smb:` images can't load;
  - `data:` images are dropped.
- Plan C says carrying them "needs a new attribute and a ruling".
- **Security, my addition:** a UNC or `smb:` fetch on Windows can send the user's NTLM credentials to the remote host. That makes it a credential leak, not just a network request.
- `data:` images involve no network. Markdown exported from notebooks often inlines base64 plots.

**Options.**
- **A.** Keep both blocked in v1.
- **B.** Allow raster `data:image/*` (png, jpeg, gif, webp; not SVG) up to a size cap, while UNC and `smb:` stay blocked.
- **C.** Allow both behind the "Load remote images" choice.

**My lean: B.** C exposes credentials, and A drops a common, harmless case.

**Your call:**
- [ ] A
- [x] B
- [ ] C
- [ ] Other: ____________________

**Size cap, if B:** 8 MiB of image-file bytes after base64 decoding per image, plus at most 16,777,216 pixels and 64 MiB of decoded pixel buffers per image. Z34's remaining aggregate budget can impose a lower limit.

**Notes:**

- Allow only base64 `data:image/png`, `data:image/jpeg`, `data:image/gif` and `data:image/webp`, with payload validation against the declared type. Reject SVG, other MIME types, malformed payloads and inputs whose decode limits cannot be enforced. A lack of network access does not make an unbounded image decode harmless.
- Bound the encoded input before allocating its decoded payload; enforce dimensions and decode-memory limits, including animation buffers, and account for resident image data under Z34. On refusal, retain alt text and a clear reason. The numbers above are selected product caps, not measured decoder guarantees.
- Keep UNC, `smb:` and ambiguous network-path image references (`//host/path` and slash/backslash variants) blocked even after "Load remote images". Only explicit HTTP(S) URLs use the remote-image fetch path. Never let an HTTP(S) redirect become a file/SMB load. `mailto:` is a link target, never an image-fetch target.
- Do not place multi-megabyte base64 strings into HTML fragments or viewport messages. Use a bounded resource path with an opaque reference; preserve the existing item/page caps. Local data images do not require the remote-image permission bar.
- This is a v1 Rendered-lens requirement. The current spike drops data images and therefore has not validated this feature. Record that boundary in C's review; validate allowed types, oversize/decode refusals and zero network effects before claiming the feature implemented.

---

### Q7 · YAML front matter only at the start of a Markdown file

**Context.**
- Front matter is recognised only at offset 0 (after a BOM), and only if it closes within the first 64 KiB.
- A `---` … `---` pair anywhere else is a horizontal rule, plus what follows it. Longer front matter reads as a rule and Markdown.
- pulldown-cmark accepts a metadata block at any block start. That made the block index depend on window size, so the spike restricted it.
- Jekyll, Hugo and Obsidian all expect front matter at the start of the file.

**Options.**
- **A.** Accept as built.
- **B.** Keep offset 0, but raise the 64 KiB limit (say, to 1 MiB).

**My lean: A.**

**Your call:**
- [x] A
- [ ] B (limit: ______)
- [ ] Other: ____________________

**Notes:**

- Keep start-of-file after an optional BOM and the 64 KiB closing limit. Document the fallback to ordinary Markdown; never silently discard an over-limit or unterminated region.
- Retain boundary fixtures around the limit, BOM/line-ending cases, and mid-document delimiters. The same bytes must produce the same block boundaries regardless of parser window size. Raising the limit is not needed for v1.

---

### Q8 · TSV quoting

**Context.**
- **As built,** TSV honours double quotes like CSV: a quoted field can hold tabs and newlines.
- **Strict IANA TSV** has no quoting, and forbids tabs and newlines in fields.
- **The trade-off:**
  - Quoting on reads pandas and Excel TSV exports correctly, since they quote such fields.
  - Quoting off is safer for a stray `"` at a field's start: with quoting on, that would swallow following lines until the next quote.

**Options.**
- **A.** Quoting on (as built).
- **B.** Quoting off.
- **C.** Detect it from the first records.

**My lean: A.** It matches what produces most real TSVs. A swallowed range still shows in Raw.

**Your call:**
- [x] A
- [ ] B
- [ ] C
- [ ] Other: ____________________

**Notes:**

- Use one deterministic CSV-style quoting dialect for TSV in v1. Do not infer quote behavior from a sample and silently change how later records parse. Document that this is not strict [IANA TSV](https://www.iana.org/assignments/media-types/text/tab-separated-values).
- Review fixtures with quoted tabs/newlines, escaped quotes, a literal leading quote and an unmatched quote. Keep record parsing, cancellation and display bounded. Raw provides access to original bytes; it does not make a misparsed Grid correct. A configurable quoting dialect can be reconsidered against real files later.

---

### Q9 · A CSV index throughput budget

**Context.**
- Spec §10.2 has an index budget for JSONL (PC ≥ 1 GB/s warm, Mac ≥ 0.5 GB/s), but none for CSV.
- CSV indexing through csv-core measured p50 1.00–1.01 GB/s, minimum 0.98, on the PC.
- Quoted fields make parallel CSV indexing hard: a record boundary can't be found without the quote state from before it.

**Options.**
- **A.** Add a row to §10.2: CSV record index ≥ 0.9 GB/s warm (PC), ≥ 0.45 GB/s (Mac).
- **B.** Hold CSV to the JSONL 1 GB/s, and fund parallel or speculative indexing.
- **C.** No budget; CSV throughput is informational.

**My lean: A.** It gates what csv-core actually delivers, with margin, and avoids a hard parallel-CSV project.

**Your call:**
- [x] A
- [ ] B
- [ ] C
- [ ] Other: ____________________

**Notes:**

- Add a separate CSV record-index gate: **PC ≥ 0.9 GB/s; Mac ≥ 0.45 GB/s**, decimal source bytes per second. Judge p50 over 30 warm release-build runs on each of the existing 100 MiB and 1 GiB mixed/quoted CSV fixtures. Report sample count, p95 elapsed time and slowest throughput as well.
- Measure the whole record-index path, including hashing/checkpoints, on a quiet reference machine with Defender on for Windows. Do not substitute the in-memory tokenizer benchmark. Reconcile C3c's seven-sample script with §10.2's warm-run convention before qualification.
- These are selected acceptance targets. The scratch measurements inform the PC target; they are not a fresh qualification run and provide no Mac result. Keep JSONL's existing target unchanged. A miss gets recorded and investigated, not rounded into a pass or followed by another automatic budget reduction.

---

### Q10 · Z34's aggregate memory budget: in Phase 0, or M1?

**Context.**
- Z34 is one budget of 25% of RAM across all open documents. On reaching it, Rendered stops, explains why, and Raw stays.
- **What plan C shows:** the mechanism end to end, through `MdConfig::max_blocks`. Rendered stops whole, its status line gives the reason plus "Raw stays available.", and Raw keeps paging.
- **What plan C doesn't build:** the cross-document accounting. Nothing computes 25% of RAM, and `maxBlocks` must be passed explicitly.

**Options.**
- **A.** M1. The mechanism is proven, and the accounting is product plumbing.
- **B.** Phase 0. Add a plan C task that computes and enforces the aggregate budget before the checkpoint.

**My lean: A.**

**Your call:**
- [x] A
- [ ] B
- [ ] Other: ____________________

**Notes:**

- Put the aggregate accounting and enforcement in **M1's core**, as an M1 exit requirement. Phase 0 proves the bounded-stop/fallback mechanism only; it must explicitly report aggregate Z34 enforcement as **not implemented**. `max_blocks` alone is not the 25% budget.
- Reserve/account across documents and concurrent builds, including indexes, caches, renderer allocations and temporary parsing buffers; release reservations on close, cancellation and failure. Reserve enough bounded capacity for Raw to remain usable. A per-tab cap or a post-allocation RSS sample does not enforce Z34.
- Require a deterministic multi-document budget-exhaustion test before M1 closes, including simultaneous builds, reopening/reloading, cleanup and continued Raw paging. Later lens milestones must join this accounting before shipping. Until then, gate runs use explicit conservative caps; an uncapped spike does not demonstrate memory safety.

---

### Q11 · CSV header detection

**Context.**
- **As built,** a sniffer guesses whether the first record is a header.
- The CSV lane asked whether that's enough, or whether a per-column type vote should land before M1. A per-column type vote means: if the first row's values are text while the rest of a column is numeric, treat the first row as a header.
- A wrong guess shows a data record as column names, or the reverse.

**Options.**
- **A.** Keep the sniffer, and revisit it against real files in M1.
- **B.** Build the per-column type vote before M1.

**My lean: A.**

**Your call:**
- [x] A
- [ ] B
- [ ] Other: ____________________

**Notes:**

- Keep the bounded sniffer for Phase 0. A per-column type vote is another heuristic, not a correctness guarantee; no new inference algorithm is required before M1.
- Preserve the already-required **"First row is header"** override in ⓘ as a Grid milestone acceptance criterion. The choice must be visible and reversible, must recover the first data record when detection is wrong, and must not edit source bytes. Recompute record numbering and view state consistently when it changes.
- Revisit detection against real header/no-header, all-text, mixed-type and single-record files. Do not treat the sniffer's current guess as settled file metadata.

---

## Part 3 — Running the real gates (Z38 step 3)

### Q12 · A gate-run window on the PC

**Context.** The binding perf and screen-reader numbers are measured on your PC.

**What the plans require:**
- **A quiet machine.**
  - Every load-sensitive gate failed only while agent lanes were loading the PC: G9's 16 ms apply bound, the 50 ms first screen, and the debug bounds.
  - Plan A Task 11 says "nothing else heavy running", with Defender on (spec §10.2 gates index throughput with Defender on).
  - I run no lanes during the window.
- **Five Windows restarts** for plan A's cold runs: shell visible, plus first screen on 1 GiB Raw and 10 GiB Rows, one sample per restart.
- **Disk:** about 13 GB for plan A's fixtures, the real 10 GiB file included, plus about 0.8 GB for plan C's. C: has about 49 GB free.
- **Your time:**
  - the screen-reader script (S01–S20) on NVDA and Narrator;
  - Z35's full reading test (Q1);
  - plan A's Snap Layouts check.
- The automated runners take the rest.

**Options.**
- **A.** Schedule it once plan B's fixes and plan C's review have landed. I hand you a run sheet: commands, order, and what to record.
- **B.** Run the automated gates first in a quiet window, and do the screen-reader sitting separately.
- **C.** Other timing.

**My lean: B.** The automated runs need the quiet PC, not you. The screen-reader sitting is the long part.

**Your call:**
- [ ] A
- [x] B
- [ ] C: ____________________

**When / constraints:**

After B's fixes, C's round-2 review and their resulting changes are closed, preserved and identified by exact revisions. No calendar slot is booked. Separate the automated warm runs, operator-controlled cold-restart batch, and manual screen-reader/Snap checks.

**Notes:**

- Prepare a run sheet with commands, fixture hashes, build/reader versions, expected outputs and storage locations. Check current disk space and memory headroom; the figures above are historical. Keep Defender on and stop heavy work/other agent lanes. Use the review's quiet-machine precondition: CPU below 10% for a minute before a timing run, and record load during it.
- Keep all five cold samples as separate first launches after restarts. Reboots are operator-controlled, not scheduled by this packet. Retain each failed/invalid run and its reason; do not replace failures with a clean rerun in the report.
- Run NVDA and Narrator separately with the Q1 protocol. Measure frame timing with each actual reader active as well as automated accessibility-on runs; neither substitutes for the other. Include the skipped YAML measurement only with adequate commit headroom, and keep it pending if that precondition cannot be met.

---

### Q13 · Mac access (Apple silicon)

**Context.** The Mac columns of spec §10.2 and Z35's VoiceOver runs need an Apple-silicon Mac.

**What it's needed for:**
- **Plan A Task 11 Step 5 (the Mac batch):**
  - full-budget perf gates;
  - a trackpad check;
  - `10g.jsonl` only if more than 15 GB is free;
  - 5 restarts for cold runs, only if the owner agrees.
- **Plan B:** the screen-reader script plus Z35 on VoiceOver. Under Q1 = A, the full test alone is about 2 hours.
- **Toolchain:** the Mac batch builds from source, so it needs Xcode command-line tools, Rust and Node installed on the Mac.

**Options.**
- **A.** One sitting on a friend's Mac, with the toolchain installed for it.
- **B.** A Mac you control (borrowed or bought), which also serves M1 onward.
- **C.** Defer the Mac gates past the Phase 0 checkpoint, and close Phase 0 Windows-only. That would be a deviation from Z35 and the §10.2 Mac columns, recorded as such.

**My lean: A for Phase 0.** Decide B before M1, since every milestone repeats the Mac checks.

**Your call:**
- [x] A
- [ ] B
- [ ] C
- [ ] Other: ____________________

**Which Mac / when:**

Target the friend's Apple-silicon Mac already named in Z29. Exact model, RAM, macOS version, owner-approved access/toolchain changes and session date are unconfirmed. Arrange the batch after the reviewed spike revisions and run sheet are ready; this packet does not claim access is booked.

**Notes:**

- Keep the Mac performance, trackpad and VoiceOver gates required for Phase 0 closure. If access or restart permission is unavailable, record the affected gates as pending and bring that fact to the checkpoint; do not silently close Phase 0 Windows-only or count warm samples as cold.
- Use the same preserved revisions, lockfiles and fixture definitions, recording platform differences. Decide repeatable Mac access for later milestones before M1 starts; no purchase is selected here.

---

## Part 4 — Calls I made (engineering; veto any)

Checked means **veto/reopen**, unlike Parts 1–3. Unchecked calls are accepted within their stated scope. One veto is recorded below; the acceptance notes qualify the remaining calls.

**Plan A**
- [ ] **Z37 also applies to Rows** on a file with a huge first record. The first screen is the first bounded piece, as in Raw. (You can veto this; I said so when Z37 landed.)
- [ ] **The one-line fixture is 1 GiB, not 100 MiB.** At 100 MiB, the line scan finished fast enough that a lens waiting for the line's end still passed the 50 ms gate, so the gate couldn't catch it.
- [ ] **"Painted before the line scan finished" is checked only where it can be seen.** On the huge-first-record file, the check is skipped when the line scan itself finishes inside the first-screen budget.
- [x] **Declined a hardening assert:** a missing scan mark would read as "not judged". It can't be reached in the current code.
  - **Veto:** require the scan-completion mark whenever the ordering check depends on it. An absent, invalid or misordered measurement must fail/invalidate that gate, never become a passing row. The separate exemption for a measured scan that finishes inside the first-screen budget stays. A negative-control run with the mark removed must demonstrate the gate rejects it.

**Plan B**
- [ ] **G9 keeps the 16 ms apply bound**, as one frame. The plan adds a quiet-PC precondition. The span measured is correct, and the failures were load (3 of 4 runs while lanes were loading the PC; 13.0 ms on a quieter run).
- [ ] **A mid-run exit of G4 with accessibility on counts as a G4 failure,** not a rerun.
  - The runner gets the crash diagnostics the review validated.
  - Ten armed runs didn't reproduce it, and its cause is unknown: it reads "closed", not "crashed", and Windows logged no error report.
- [ ] **The fix round adds spec §10.2's "no stall > 50 ms" check to G9.** The review saw 42–134 ms gaps under load, and no gate checks it today.
- [ ] **The doc axe scan excludes `heading-order`.** Heading levels in rendered Markdown are the author's, not Typose's.
- [ ] **Accepted the review's minors and nits.** The speech-log check's start marker is pinned. The Z35 milestone test is defined as S11/S12 cut to 650 blocks, plus S09, S10, S13 and S19. G4's in-view check accounts for the sticky row-number column. A test for the header's `#` is added.

**Plan C**
- [ ] **`pulldown-cmark` pinned to exactly `=0.13.4`.** 0.13.5 changes the container and lazy-continuation rules that plan C's Markdown index mirrors. Revisit the pin in M1.
- [ ] **One YAML measurement run (Task C5a6 Step 2) is not run;** lane C5a's measured results are used instead. That run takes the renderer to 7.9 GB, and the PC's commit charge was at 58.7 of 60 GB. Re-run it in the quiet window (Q12).
- [ ] **Task C4e's 50 ms debug-build bound is kept,** although it's load-sensitive: it failed once, at 52 ms with the CPU near 98%.

**Acceptance notes:**

- Applying Z37 to Rows and retaining the 1 GiB one-line fixture are accepted. Preserve both the first usable bounded view and full-scan measurements; do not claim the former proves the latter.
- Keep G9's 16 ms apply bound and add the 50 ms stall check. A quiet-PC precondition governs qualification; load remains a suspected explanation for prior failures, not proof that every failure was external. Record actual-reader timing under Q12.
- An unexplained G4 exit remains a failure even if a later run passes. Preserve diagnostics and investigate before closing the affected gate; the non-reproduction runs do not establish a cause.
- Limit the `heading-order` exclusion to author-supplied document content. Keep app-owned chrome and controls covered. Accept the specified speech-log fixes, milestone script, sticky-column check and `#` header test; they still need execution evidence. Verify the shorter script actually crosses at least four recenters each way.
- Keep the exact parser pin and tested lockfile. Revisit with compatibility/span fixtures, not an unreviewed dependency refresh. The skipped YAML run remains unrun; prior lane measurements are context, not a replacement qualification result. Keep the debug bound pending a valid quiet-machine run.

---

## Part 5 — Heads-up: what the Phase 0 checkpoint will put to you (no decision now)

**Likely gate problems, from early scratch signals and replays:**
- **Shell visible measured ~410–460 ms warm in scratch runs, some of them while other lanes were loading the PC. The gate is < 200 ms cold (PC).** Expect a fail that needs explaining, or a revised budget.
- **64 KiB page fetch p95 ≈ 3.0 ms, against a < 3 ms gate.** On the line.
- **G4 with accessibility on: an unexplained mid-run exit**, in 4 runs on record.
- **Frame timing with a real screen reader running** isn't measured by any automated gate.

**Spec deviations by design, recorded in the plans:**
- The indexer is sequential, with rayon only if throughput fails. Sequential reached ~4 GB/s against a 1 GB/s gate.
- Frame timing uses rAF intervals, not Chromium tracing.
- Page caps use different units per lens.
- The continuation is a byte offset, not an opaque token.
- `csv::fields` re-tokenizes from the record's start.
- JSON indexing reports no progress.
- Lazy continuation after an oversized quote or list is approximate.
- Cancel checks cost 5–6% index speed on realistic Markdown.

**Open questions:**
- **Markdown index memory:** about 66–68 B per block on realistic Markdown, against Z34's 32 B target.
- **React Aria's bundle:** about 1 MB minified, a cold-start question for spec §10.
- **Screen readers in logical scrolling (P4):** a screen-reader-driven scroll-into-view on an off-screen cell may read as a proportional jump (×1.5 at 1M rows, ×80 at 50M). S05 of the screen-reader run is where it would show.

---

## Checkpoint addendum — conditional go to M1 (2026-10-22)

**Decision authority:** Codex, on Zack's instruction to re-ground and make decisions (a)–(d). Grounded against repo `c557a4a`, spec Draft 4 through Z52, the B/C round-3 reviews and the agreed next-steps discussion in `<SP>\codex\reply2.md`. These decisions do not claim new measurements or completion of Plan B's in-flight lane.

### (a) Change the Phase 0 sequence: yes

Hold the checkpoint on the evidence already available and authorize a **conditional go to M1** despite the listed failed and pending gates. **Phase 0 is not qualified.** Finish and preserve B's in-flight result, freeze the spike evidence and record the outstanding findings; do not start another general spike review cycle as an entry condition for M1.

Amend Z38, Z50 and §13.1 to separate the checkpoint's development authorization from qualification. Deferred gates remain failed, pending or explicitly parked, with dispositions in the milestone plan. Z49's measurement protocol stays unchanged. This authorizes implementation, not release or a declaration that the spikes passed all gates.

### (b) Does the cold-start budget veto Electron? No

Keep **Electron + Rust (Z25)**. Do not require a pre-M1 reboot campaign to decide the stack. Measure startup on the M1 product app, early enough to inform its implementation.

The reported 410–460 ms warm result on a busy PC is a warning, not a valid cold-start result or evidence that another shell satisfies Typose's full requirements. Retain the **<200 ms PC / <400 ms Mac** targets. Qualification uses one fixed build/layout, launched first after each of five restarts on each reference platform; a second launch is not cold. Keep shell appearance separate from usable document content.

A miss remains a miss and requires optimization or an explicit product-budget decision. It does not automatically discard Electron, weaken the target or become a pass. The startup risk is accepted for starting M1.

### (c) Mac access for milestones: a Mac Zack controls

Choose reliable, repeatable access to an **Apple-silicon Mac under Zack's control**, including permission to install the toolchain, retain builds and restart it. A long-term loan is sufficient; ownership is not required. Do not make repeated milestone qualification depend on ad hoc visits to a friend's machine.

The friend's Mac may bridge an initial batch. This decision makes no purchase, selects no hardware model and asserts no access arrangement. M1 implementation may begin while access is arranged; Mac-dependent acceptance remains pending until measured. Record the chosen reference rig before its qualification runs and explain any baseline change from Z29.

### (d) Carry the risks forward: accepted for the conditional go

| Risk accepted | What this acceptance means |
|---|---|
| Startup is likely over budget | Cold startup remains unqualified; settle it on the M1 app under (b). |
| Far jumps measured 55–103 ms with accessibility on | Retain Z52's 50 ms stall rule and the failing finding. Parking manual reader work does not exempt automated accessibility-mode performance. |
| G4 has unexplained exits | Keep the incidents unresolved. A passing rerun does not erase them; a corresponding unexplained exit in the M1 baseline blocks M1 closure. |
| CSV speed is not qualified | Keep Z46 and Z49. Neither the marginal run nor the faster non-qualifying review run settles the gate. |
| Aggregate memory is unenforced until M1 | Working enforcement and tests remain an M1 exit requirement under Z47. C's block cap does not bound heading text or reference definitions; preserve that finding rather than presenting the cap as a safety guarantee. |
| Real screen-reader validation is parked until after launch | Retain Z39. Keep automated semantics, keyboard/focus and accessibility-mode gates. Make no verified screen-reader-support claim before real-reader validation. |

**Engineering ownership:** PR boundaries, product contracts, diagnostic implementation and the remaining gate-to-milestone assignments stay with the implementation owner. Preserve C's cap-validation finding alongside its memory finding. This addendum changes the decision record only; it does not implement the disposition plan, update spike refs or close any gate.
