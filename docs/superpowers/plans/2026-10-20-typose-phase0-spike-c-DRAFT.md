# Typose Phase 0 · Spike C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Spike C's core on top of the Spike A harness, then measure it against spec §13.1's Spike C gates and outputs:
- documents with generations: non-locking handles, 1,000 mutation cycles, and the mutation race caught by chunk verification;
- byte maps with zero selection-endpoint mismatches across UTF-8, malformed UTF-8, Windows-1252 and UTF-16LE/BE, and correct offsets beyond 4 GiB;
- the JSON/JSONC structural scanner, its span-fidelity gate, its hostile inputs, and the scanner decision against `jiter` and `struson`;
- the CSV record index, its span-fidelity gate, its hostile inputs, and sequential CSV index throughput (moved here from Spike A);
- the Markdown block pipeline: `pulldown-cmark` blocks in bounded windows, sanitized with `ammonia`, with byte-mapped text runs, its span, byte-map and hostile-HTML gates, oversized blocks, hostile inputs, cancel latency and throughput;
- untrusted content in the renderer: YAML in a Web Worker with exact byte spans and its span gate, KaTeX in a worker behind DOMPurify, Mermaid in a sandboxed frame, and the zero-effects gate; YAML throughput sets `yaml.treeMaxBytes`;
- the Spike C core in the app: napi and the core host, a Rendered lens whose selections copy exact source bytes, link clicks that navigate nowhere, index progress and the block-budget stop (Z30, Z34), zero effects for hostile Markdown, and the oversized, hostile-input and cancel gates measured in the app.

**Architecture:**
- **Tasks C0–C4e are Rust in `spike-core`.** New modules:
  - `doc`: `Document` with generations, path-identity checks and verified reads;
  - `bytemap`: UTF-16 offset → source byte, with outward snapping;
  - `encoding`: sniffing, mapped decoding, UTF-16 newline units;
  - `json`: a push scanner, the container index with element checkpoints, lazy children;
  - `csv`: csv-core record checkpoints, bounded record pages, per-field spans;
  - `sanitize`, `mdemit`, `md`: the raw-HTML escape pass and ammonia, the Markdown emitter with byte-mapped runs, and the windowed Markdown block index.
- **Plan A's code changes in three places:** `index.rs` learns UTF-16 newline units and makes `read_block` crate-visible; `pages::lines` and `pages::piece` (plan A's Z37 continuation) decode through `decode` and return a byte map with each piece; and napi `Doc::piece` passes the line index to `piece`, for its encoding.
- **Until Task C5b1 the addon changes only in `Doc::piece` (Task C1b).** One TypeScript port (`bytemap.ts`) is checked against vectors that `cargo test` regenerates, and one node:test file checks offsets beyond 4 GiB through napi.
- **Tasks C5a1–C5a7 are TypeScript in the app** and touch nothing in `spikes/core`: a YAML worker that returns a columnar tree, KaTeX in a worker with DOMPurify, lazy Mermaid in a sandboxed frame, and a test-only effects recorder in main and the core host. Every Electron launch they add goes through one helper with a private profile.
- **Tasks C5b1–C5b5 bring the core into the app:** napi `Source` (the verified copy path), `MdView` and cancellable index jobs that report progress, the core host's methods for them, a minimal Rendered lens that pairs every DOM text node with its run before hydration and stops on the block budget, and the end-to-end gates. `spike-core` gains only `ByteStore::open_shared`, two tests and an ignored corpus writer.

**Tech Stack:** as plan A, plus:
- **dependencies:** encoding_rs 0.8.42, csv-core 0.1.13 (pinned `=0.1.13`), ammonia 4.2.4, pulldown-cmark 0.13.4 (pinned `=0.13.4`; default features off), and windows-sys 0.61 on Windows (`FileId`);
- **dev-dependencies:** jiter 0.17 and struson 0.7 (the benchmark only), and more windows-sys features on Windows (sparse files, peak working set);
- **app (Tasks C5a1–C5a4, exact versions):** yaml 2.9.1, katex 0.19.0, dompurify 3.4.17, mermaid 12.2.0. Mermaid brings its own katex 0.18.10;
- **spike-node (Task C5b1):** encoding_rs 0.8.42 and serde_json 1, both already in `Cargo.lock`.

**Spec:** `docs/superpowers/specs/2026-10-20-typose-tech-design.md` (Draft 2): §3.1–3.5, §4.1–4.3, §4.6, §11.1, §13.1 Spike C, §14 D1 and D17. The design brief, revision 4, is `docs/superpowers/specs/2026-10-20-typose-design-brief.md` (§4.6, §5.2, §5.3, §5.5, §7.4, §7.6, §7.7, §7.9, §8.1–8.2).

**Builds on:** plan A, `docs/superpowers/plans/2026-10-20-typose-phase0-base-and-spike-a.md`, Tasks 1–10: the code on `spike/a`, as amended for Zack's ruling Z37 (plan A at sha256 `f55dac02…`: Raw's first screen is the first bounded piece; `pages::piece`, napi `Doc.piece` and the RPC `piece` continue a long line; a `fullLineScan` mark). Plan A's Task 11 adds only results files.

**Test counts:** plan A's Task 12 is conditional: it runs only if indexing is below 1 GB/s, and the scratch run indexed at about 4 GB/s. Every count in this plan assumes Task 12 **did not run**. If it ran, its test `index::tests::parallel_build_matches_sequential` is one more `spike-core` test: add 1 to a run's `passed` count when the run's filter matches it (no filter, or `index`), and 1 to its `filtered out` count otherwise. The counts quoted are the unit tests' `test result` line. From Task C2b on, `cargo test -p spike-core` also runs `tests\json_spans.rs`: its own line reads `1 passed` with no filter, and `0 passed` with `1 filtered out` under a filter its test doesn't match.

**Validated:** every code block in Tasks C0–C5b5 was applied literally from this text, step by step, to a fresh build of plan A Tasks 1–10 (as amended for Z37), and every command was run on Zack's PC (2026-10-21) except Task C5a6 Step 2, the long YAML measurement, whose numbers are lane C5a's. The counts, errors and outputs stated as expected are the ones that replay printed. The code was first written and validated in seven scratch lanes (C0–C4, C5a, C5b); after the plan's first review, a fix lane changed Tasks C0–C4e. The code is byte-identical to the fix lane's validated tree (C0–C4e), lane C5a's files (C5a1–C5a7) and lane C5b's tree (C5b1–C5b5), carried onto plan A's Z37 amendment, except in three places: Task C1b converts plan A's new `pages::piece`, its two Z37 tests and napi `Doc::piece` (the lanes predate Z37); Task C4b pins `pulldown-cmark` to `=0.13.4` (0.13.5 appeared after the lanes ran, and Task C4c's scanner mirrors 0.13.4's block rules); and Task C4d's generator drops a dead assignment that made every `spike-core` test build warn.

**Measurements:** numbers quoted as "the scratch run gave" or "on the lane machine" come from those lanes, on the same PC with other builds running. They show the output's format and its scale. They aren't expectations: record your own.

## Global Constraints

- **Throwaway code.** Everything lives under `spikes/` on `spike/*` branches and is **never merged to `main`** (spec §13.1). The spike's output is its report and numbers, not the code.
- **Branch:** `spike/c` is cut from `spike/a`. Commit on `spike/c` after each task.
- **Staging:** stage explicit paths only and never use `git add -A`. Never stage research files: `astra-research.md`, `fable-research.md`, `docs/research/`. Never stage proptest's saved seeds (`spikes/core/spike-core/proptest-regressions/`, `spikes/core/spike-core/tests/*.proptest-regressions`): the red and falsification steps write failing seeds there. Task C0 gitignores them, and each step deletes them anyway.
- **Rule 8 (standing procedure):** whoever writes a file reads the final on-disk version in full before calling the task done.
- **Gate thresholds:** on Zack's PC they are **half** the budget, unless marked **Mac** (spec Z29, §10.2). A failing gate is a result: record the number and the suspected cause, and fix the harness only if the harness itself is wrong.
- **File access:** positional reads only. **No memory-mapping on any OS** (spec §3.3).
- **Fixed sizes (from plan A):**
  - Chunk: `CHUNK = 1 MiB`, hashed with xxh3 on first read and verified on every later read.
  - Checkpoints: every **1,024 lines (records, children) or 1 MiB, whichever comes first** (spec §3.5).
  - Rendering unit: ≤ **64 KiB** of text per item (`MAX_PIECE = 65_536`).
  - Page: ≤ **256 KiB** (`MAX_PAGE = 262_144`) (spec §3.4).
- **Commands:** run them from the directory each step names. They work in PowerShell and in Git Bash unless a step gives both forms.
- **A rare e2e flake:** a Playwright worker can die as it launches Electron, with `Error: worker process exited unexpectedly (code=3221226505, signal=null)` (0xC0000409). The test is reported failed after `0ms`, before any sample, and the Electron it was launching keeps running. The cause wasn't found; lane C5b hit it in e2e and perf runs alike, once in its replay of Task C5a2's red step. Stop that Electron (its executable is under this tree's `spikes/app/node_modules/electron`), then rerun the test, or a perf row alone with `-g '<its title>'`.
- **Disk:**
  - Fixtures go in `spikes/.fixtures/` (gitignored). Task C2c's JSON fixtures take about 1.4 GB (deleted after its Step 7), Task C3c's CSV fixtures about 1.3 GiB (1 GiB of it deleted at the end of the task), and Task C4e's Markdown fixtures about 960 MB (deleted after its Step 3), plus a 1 GiB file it deletes itself. Tasks C5a2–C5a6 write private Electron profiles and effects logs there; Task C5a7 deletes them. Task C5b2 leaves a 59 MB Markdown file there, Task C5b3 writes 498 small files and Task C5b4 about 630 MB of fixtures; Task C5b5 deletes `spikes/.fixtures/`.
  - Tests write temporary files into `%TEMP%`: Task C2a's up to about 0.7 GB at once, Task C3a's 100 and 200 MB. Those are deleted on any exit (`store::testutil::Temp`); plan A's `temp_file` leaves its small files behind, so clear the `spike-core-*` files between runs.
- **Edit instructions:** an `<!-- op: … -->` comment sits above every code block that is file content. It repeats what the prose says, in a form a script can replay:
  - `create PATH`: the next block is the whole new file;
  - `replace PATH`: the next two blocks are the exact old text, which occurs once, and its replacement;
  - `temporary PATH`: like `replace`, but the step undoes it (falsification);
  - `insert-before PATH :: LINE`: the next block, then a blank line, go directly above the one line that starts (after its indentation) with `LINE`;
  - `insert-adjacent-before` / `insert-adjacent-after PATH :: LINE`: the next block goes directly above / below that line;
  - `append-in-module PATH`: a blank line, then the next block, go above the file's last line, the test module's closing `}`;
  - `replace-fn PATH`: the next block is a whole function; it replaces the function whose first line equals the block's first line, through its closing `}`.

---

## File Structure

```
spikes/
  .gitignore                    + proptest's saved seeds (C0)
  core/
    Cargo.toml                  + debug-build opt-level 3 for memchr and xxhash-rust (C1d)
    spike-core/
      Cargo.toml                + windows-sys (C0), encoding_rs (C1b), csv-core (C3a), ammonia (C4a), pulldown-cmark (C4b); dev: windows-sys features (C1d, C2c), jiter, struson (C2c)
      src/lib.rs                module wiring
      src/doc.rs                FileId, DocError, Document: generations, identity checks, verified reads (C0)
      src/bytemap.rs            ByteMap, MapBuilder (C1a)
      src/encoding.rs           sniff, decode, newline_and_cr, newline_ends; the byte-map gate (C1b, C1c)
      src/store.rs              changed: testutil::Temp, a temp file deleted on drop (C2a); ByteStore::open_shared (C5b1)
      src/index.rs              changed: LineIndex.encoding and UTF-16 newline units (C1b); read_block is pub(crate) (C3a)
      src/pages.rs              changed: LinePiece.map; lines and piece decode through decode (C1b)
      src/big_offsets.rs        test only: offsets beyond 4 GiB in every layer (C1d)
      src/json.rs               JSON/JSONC scanner: container index, element checkpoints, children, duplicate keys (C2a)
      src/csv.rs                CSV sniffing, record index, records, fields with byte maps; the CSV gate and throughput (C3a–C3c)
      src/sanitize.rs           raw-HTML escape pass, ammonia, inert image placeholders, segments (C4a)
      src/mdemit.rs             Markdown → sanitized HTML per block, a byte map per DOM text run (C4b)
      src/md.rs                 windowed block index: oversized sub-blocks, first screen, pages, reconcile, headings (C4c)
      src/md_gates.rs           test only: Markdown span, byte-map and sanitizer gates (C4d); the navigation probe and the hostile corpus writer (C5b3)
      src/md_perf.rs            test only, ignored: Markdown measurements (C4e)
      tests/json_spans.rs       JSON span-fidelity gate (C2b)
      examples/json_bench.rs    scanner benchmark against jiter and struson (C2c)
    spike-node/Cargo.toml, src/lib.rs     Doc::piece passes the index (C1b); + Source, MdView, Job, JobEvent, indexJson, indexCsv (C5b1)
    spike-node/test/beyond-4gib.test.js   offsets beyond 4 GiB through napi (C1d)
    spike-node/test/spike-c.test.js       the napi surface (C5b1)
    fixtures-gen/src/lib.rs, src/main.rs  + json_doc / `json` (C2c), csv / `csv` (C3c)
  app/
    package.json, package-lock.json       + yaml, katex, dompurify, mermaid (C5a1, C5a3, C5a4)
    src/main/effects.ts                   test-only effects recorder (C5a5)
    src/main/index.ts, core-host.ts       report effects; TYPOSE_FALSIFY=protocol (C5a5); the core host's Markdown, copy and index-job methods (C5b1)
    src/renderer/index.html               CSP + frame-src data: (C5a4)
    src/renderer/src/
      bytemap.ts, bytemap.test.ts         the TypeScript port and its test (C1a)
      bytemap.vectors.json                cross-language vectors, written by `cargo test` (C1a)
      main.ts, style.css                  window.__spike.untrusted (C5a2–C5a4); openRendered and .md-* styles (C5b2)
      rendered.ts                         the Rendered lens: windowed items, pairing, hydration, selection, copy, links, progress line, budget stop (C5b2)
      yaml/gen.ts, tree.ts, tree.test.ts  span-gate generator, columnar tree, tests (C5a1)
      yaml/yaml.worker.ts, client.ts      worker and main-thread client (C5a2)
      math/tex.ts, tex.test.ts            KaTeX options and render (C5a3)
      math/katex.worker.ts, math.ts       worker, DOMPurify, renderMath (C5a3)
      mermaid/diagram.ts                  lazy Mermaid, sandbox frame (C5a4)
    e2e/launch.ts                         private-profile launch (C5a2)
    e2e/hostile.ts                        hostile TeX, HTML, Mermaid and YAML (C5a3)
    e2e/yaml.e2e.ts, math.e2e.ts, mermaid.e2e.ts   (C5a2–C5a4)
    e2e/effects.ts, effects.e2e.ts        zero-effects harness and gate (C5a5)
    e2e/mdgen.ts, rendered.e2e.ts         the selection oracle and its tests (C5b2)
    e2e/md-effects.e2e.ts                 links, zero effects and falsification in Rendered (C5b3)
    perf/yaml.e2e.ts                      throughput runner (C5a6)
    perf/spike-c.e2e.ts                   oversized and hostile-input measurements in the app (C5b4)
  results/
    json-bench.txt              benchmark output and the scanner decision (C2c)
    csv-throughput.txt          CSV index throughput (C3c)
    yaml-<hostname>.json        YAML worker throughput (C5a6)
    spike-c-<hostname>.json     the app's oversized, hostile-input and cancel numbers (C5b4)
```

## Notes for the checkpoint (deviations from the spec, by design)

- **UTF-16 CSV/TSV is refused** (Task C3a). Spec §4.2 and §3.4 offer Grid for every CSV/TSV. A UTF-16 one, such as Excel's "Unicode Text" export, gets Grid locked with `csv::UTF16_REFUSED`, and Raw remains. csv-core tokenizes bytes, and UTF-16 has no single-byte delimiters, quotes or line ends. Transcoding with an offset map is the alternative if this matters later. Cells don't yet carry their U+FFFD count as a problem (spec §4.1); add a field when ⓘ needs it.
- **YAML front matter exists only at offset 0** (Task C4c; spec §4.6): after a BOM, and closing within the first 64 KiB. pulldown-cmark accepts a metadata block at any block start, which made the block index depend on window size, so a mid-document `---` … `---` pair is a rule and what follows. Longer front matter reads as a rule and Markdown.
- **An image keeps `data-src` only for a live target** (Tasks C4a–C4b): http, https, `mailto` or a relative path that isn't a network path. Brief §4.6's "Load remote images" therefore can't load a UNC or `smb:` image (no network path may sit in `data-src`), and a `data:` image is dropped too; carrying them needs a new attribute and a ruling. Links to other schemes and network paths stay clickable: `href="#"` with the target in `data-href`, for the hand-off (brief §4.4).
- **Lazy continuation after an oversized quote or list** (Task C4c). A line outside an oversized quote or list that doesn't interrupt a paragraph is taken as a lazy continuation. pulldown-cmark continues the block there only when the innermost open block is a paragraph, and telling that apart needs a block parser (fences, indented code at the item's content column, HTML blocks, tables, headings, nested quotes and lists, empty items), so the scanner doesn't approximate it. Five shapes disagree by window size (19 of 26 window sizes each in the fix lane's probe): a quote that ends in a heading, a blank `>` or a closed fence, and a list that ends in a closed fence or an empty item, each followed by an unindented line that can't interrupt. The span gate's generator writes none of them. Likewise, a `|` row followed by a delimiter row with as many columns ends a paragraph in pulldown-cmark, but that needs a line of lookahead, so such a table stays inside an oversized paragraph.
- **Cancelling inside a window costs index speed** (Task C4c). Checking the flag every 1,024 parser events and headings, and committing a window's headings and slugs all or nothing, makes `index_all` about 22–33% slower on a heading flood and about 5–6% slower on realistic Markdown (release, interleaved A/B in the fix lane). The cause is the per-window slug table. An undo log is the cheaper alternative if that matters.
- **JSON index jobs report no progress** (Task C5b1). `json::scan` builds its index privately and publishes nothing until it returns, so `indexJson` sends only its last event. Z30 asks for progress on giant Markdown, which the Markdown and CSV jobs report, so this is a gap in the spike, not a Z30 violation. Reporting needs a callback or shared state in Task C2a's scanner.
- **The aggregate memory budget isn't built** (Tasks C5b1–C5b2). Z34's safety limit, 25% of RAM across all open documents, is computed nowhere. `MdConfig::max_blocks` and its `TOO_MANY_BLOCKS` stop show the mechanism end to end: the Rendered lens stops whole, says why, and Raw stays. But `maxBlocks` must be passed explicitly: the core host opens with no limit unless `mdOpen` passes one.
- **Raw's first screen beside a running format index passes on plan A's Z37 mark** (Task C5b4). With the format index running, p95 was 20.5–27.4 ms on all six hostile inputs; 3 of 120 samples went over 50 ms under load, as did 2 of Raw alone's, and an earlier run under lighter load had none (max 29.0 ms). The index moved Raw's p50 by at most 3.5 ms against Raw alone. Before Z37, plan A marked a one-line file's first screen only once its line index had scanned the whole line, and lane C5b's runs on that mark were marginal (p95 48.0 and 49.3 ms on the one-line Markdown files; Raw alone over 50 ms at p95 on two one-line files). The inputs are 100–200 MB; a multi-GB single line isn't measured here.
- **Known gaps in the app** (Tasks C5b1–C5b2): after `reload`, the core host reopens the Markdown view without restarting its index job (and without `maxBlocks`); the Rendered list is forward-only, which is an M4 item; copy returns the verified bytes but doesn't write the clipboard (M6).
- **Decided after the first review** (Zack's rulings Z30–Z38, recorded in the spec's Draft 3, §0.3):
  - **Z36: the YAML Tree ceiling is 8 MiB in v1**, with Raw above it. That confirms Task C5a6's `yaml.treeMaxBytes`. Smaller files must still respect the memory and structural limits.
  - **Z34: 32 B per block is an optimization target for the Markdown index, not its safety limit.** The safety limit is one budget of 25% of RAM across all open documents, including their indexes, caches and temporary parsing allocations. When it, or `MdConfig::max_blocks`, is reached, Rendered stops building, says why it's unavailable, and Raw stays. Task C4e's per-block heap figures are inputs to that budget.
  - **Z30: Rendered on a 1 GiB Markdown file at roughly 20 s is acceptable**, not a deadline, while Raw opens immediately (Task C4e's `md-real-1gib.md` indexed in a p50 of 21.4 s in the fix lane's run and 22.4 s in this plan's replay). The giant-Markdown index needs progress events and cancellation: Task C5b1's Markdown and CSV jobs report progress at most 10 times a second and cancel within 50 ms, and Task C5b2's Rendered lens shows the progress in a `role="status"` line.
- **Declined after the first review** (recorded; no code):
  - **Page caps use different units** (review MINOR 12): `pages::lines` and CSV `records` cap source bytes, CSV `fields` unescaped bytes, and `md::page` HTML bytes, while spec §3.4 says only "256 KiB". One unit (for example, what crosses IPC) is a spec §3.4 checkpoint item, and it would reopen plan A's `pages.rs`.
  - **`csv::fields` re-tokenizes a record from its start** (review MINOR 14): for a huge record that misses spec §3.5's "no rescan reads more than 1 MiB" (about 0.34 s for a 50 MB record in a debug build). It's lane C3's open question 7: copying a cell beyond the first window re-tokenizes from the record's start. Resuming from the checkpoints when `first > 0` is the fix if it matters.
  - **Duplicate span types** (review N6): `json::Span`, `csv::Span` and `md`'s `(u64, u64)` stand in for spec §3.2's single `SourceSpan`. M1 unifies them.
  - **Compacting the Markdown index** (16-byte blocks): not done; Z34 makes 32 B per block an optimization target rather than a limit. Spec §3.5 calls the index "small". Task C4e measures 194.3 B per block on a heading flood (97 B per source byte), 41.9 B per block on one-letter paragraphs, and about 66–68 B per block, about 1 byte of heap per source byte, on realistic Markdown. `MdConfig::max_blocks` is the hook the budget stops Rendered with (Z34).

---

## Task C0: Documents with generations: identity checks, verified reads, freeze on change

**Files:**
- Create: `spikes/core/spike-core/src/doc.rs`
- Modify: `spikes/.gitignore` (proptest's saved seeds)
- Modify: `spikes/core/spike-core/src/lib.rs` (add `pub mod doc;`)
- Modify: `spikes/core/spike-core/Cargo.toml` (add `windows-sys` for Windows)

**Interfaces:**
- **Consumes** (plan A Task 4): `store::{ByteStore, StoreError, read_exact_at, CHUNK}`, `ByteStore::{open_with, read, len}`, and the test helper `store::testutil::temp_file`.
- **Produces:**
  - `pub struct FileId { pub volume: u64, pub index: u64, pub size: u64, pub modified: SystemTime }`, with `FileId::of(&Path) -> io::Result<FileId>` (`PartialEq`).
  - `pub enum DocError { Io(io::Error), Stale { current: u32, asked: u32 }, Frozen(String) }`, which implements `Display`.
  - `pub struct Document`:
    - `open(&Path)` and `open_with(&Path, cache_chunks: usize, generation: u32)`, both returning `Result<Document, DocError>`;
    - `generation() -> u32`, `len() -> u64`, `store() -> &ByteStore`, `frozen() -> Option<String>`;
    - `read(generation, start, end)` and `read_with(generation, start, end, between: impl FnOnce())`, both returning `Result<Vec<u8>, DocError>`;
    - `reload(&mut self) -> Result<(), DocError>`.

**Design** (spec §3.1, §3.3, §14 D6):
- **Identity comes from the path, never from the open handle.** On Windows, `FileId::of` opens the path query-only (access 0) with full sharing. It requests no data access, so it never locks the file.
- **Every verified read checks identity on both sides of the byte read.** In between, `ByteStore` verifies each chunk against the hash it recorded on first read. That catches the in-place, same-size write that metadata can't see.
- **Any change freezes the document**, and the freeze sticks. Nothing more is read until `reload`, which opens a fresh handle with fresh identity and a fresh hash table, one generation later.
- **A span from an older generation is refused** (`Stale`), so copy never returns bytes from a file that has changed since the span was made.

- [ ] **Step 1: Write the failing tests**

Keep proptest's saved seeds out of git: later tasks' red and falsification steps write failing seeds next to their tests. In `spikes/.gitignore`, replace
<!-- op: replace spikes/.gitignore -->
```gitignore
.fixtures/
*.netlog.json
```
with
```gitignore
.fixtures/
*.netlog.json
core/spike-core/proptest-regressions/
*.proptest-regressions
```

Add this table to `spikes/core/spike-core/Cargo.toml`, after the `[dependencies]` section:
<!-- op: insert-before spikes/core/spike-core/Cargo.toml :: [dev-dependencies] -->
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_Storage_FileSystem"] }
```

In `spikes/core/spike-core/src/lib.rs`, add this line directly above `pub mod index;`:
<!-- op: insert-adjacent-before spikes/core/spike-core/src/lib.rs :: pub mod index; -->
```rust
pub mod doc;
```

`spikes/core/spike-core/src/doc.rs`: the module with its tests. The three methods that do the work are stubs.
<!-- op: create spikes/core/spike-core/src/doc.rs -->
```rust
//! Documents with generations (spec §3.1): every read checks the path's identity before and after,
//! and every chunk is verified against its first-read hash. Any change freezes the document.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::store::{ByteStore, StoreError};

/// What change detection compares, taken from the path (never the open handle, spec §3.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileId {
    pub volume: u64,
    pub index: u64,
    pub size: u64,
    pub modified: SystemTime,
}

impl FileId {
    #[cfg(windows)]
    pub fn of(path: &Path) -> io::Result<FileId> {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            GetFileInformationByHandle,
        };
        // Access 0 = query only: no read access requested, so nothing is locked and nothing is scanned.
        let f = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let meta = f.metadata()?;
        Ok(FileId {
            volume: info.dwVolumeSerialNumber as u64,
            index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            size: meta.len(),
            modified: meta.modified()?,
        })
    }

    #[cfg(unix)]
    pub fn of(path: &Path) -> io::Result<FileId> {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path)?;
        Ok(FileId { volume: meta.dev(), index: meta.ino(), size: meta.len(), modified: meta.modified()? })
    }
}

#[derive(Debug)]
pub enum DocError {
    Io(io::Error),
    /// The caller's span belongs to an older generation (spec §3.1: copy is refused, Reload is offered).
    Stale { current: u32, asked: u32 },
    /// The file changed; nothing more is read until Reload.
    Frozen(String),
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocError::Io(e) => write!(f, "io: {e}"),
            DocError::Stale { current, asked } => write!(f, "stale span (generation {asked}, now {current})"),
            DocError::Frozen(why) => write!(f, "frozen: {why}"),
        }
    }
}

pub struct Document {
    path: PathBuf,
    store: ByteStore,
    id: FileId,
    generation: u32,
    cache_chunks: usize,
    frozen: Mutex<Option<String>>,
}

impl Document {
    pub fn open(path: &Path) -> Result<Document, DocError> {
        Self::open_with(path, 64, 1)
    }

    pub fn open_with(path: &Path, cache_chunks: usize, generation: u32) -> Result<Document, DocError> {
        todo!()
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn len(&self) -> u64 {
        self.store.len()
    }

    pub fn store(&self) -> &ByteStore {
        &self.store
    }

    pub fn frozen(&self) -> Option<String> {
        self.frozen.lock().unwrap().clone()
    }

    /// The verified read path that copy uses (spec §3.1).
    pub fn read(&self, generation: u32, start: u64, end: u64) -> Result<Vec<u8>, DocError> {
        self.read_with(generation, start, end, || {})
    }

    /// `between` runs after the first identity check and before the read: the mutation-race test injects writes there.
    pub fn read_with(&self, generation: u32, start: u64, end: u64, between: impl FnOnce()) -> Result<Vec<u8>, DocError> {
        todo!()
    }

    /// Ctrl+R: a fresh handle, identity and hash table, one generation later.
    pub fn reload(&mut self) -> Result<(), DocError> {
        todo!()
    }

    fn check(&self) -> Result<(), DocError> {
        if let Some(why) = self.frozen() {
            return Err(DocError::Frozen(why));
        }
        match FileId::of(&self.path) {
            Ok(now) if now == self.id => Ok(()),
            Ok(_) => Err(self.freeze("changed on disk".into())),
            Err(e) => Err(self.freeze(format!("unavailable: {e}"))),
        }
    }

    fn freeze(&self, why: String) -> DocError {
        *self.frozen.lock().unwrap() = Some(why.clone());
        DocError::Frozen(why)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;
    use crate::store::CHUNK;
    use std::fs::{self, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| ((i * 31) as u8).wrapping_add(seed)).collect()
    }

    #[test]
    fn a_current_span_copies_and_a_stale_one_is_refused() {
        let path = temp_file("doc-basic", &pattern(3 * CHUNK, 1));
        let mut doc = Document::open(&path).unwrap();
        assert_eq!(doc.read(1, 10, 20).unwrap(), pattern(3 * CHUNK, 1)[10..20]);
        OpenOptions::new().append(true).open(&path).unwrap().write_all(b"more").unwrap();
        assert!(matches!(doc.read(1, 10, 20), Err(DocError::Frozen(_))));
        doc.reload().unwrap();
        assert!(matches!(doc.read(1, 10, 20), Err(DocError::Stale { current: 2, asked: 1 })));
        assert_eq!(doc.read(2, 3 * CHUNK as u64, 3 * CHUNK as u64 + 4).unwrap(), b"more");
    }

    /// Spec §13.1 Spike C: an in-place, same-size write between the identity check and the read,
    /// with the timestamp restored, is caught by chunk verification in 1,000 of 1,000 runs.
    #[test]
    fn mutation_race_is_caught_by_chunk_verification_1000_of_1000() {
        let original = pattern(4 * CHUNK, 7);
        let path = temp_file("doc-race", &original);
        let mut caught = 0;
        for run in 0..1000u64 {
            let chunk = run % 4;
            let at = chunk * CHUNK as u64 + (run * 7919) % (CHUNK as u64 - 64);
            let doc = Document::open_with(&path, 1, 1).unwrap();
            doc.read(1, at, at + 16).unwrap(); // hashes `chunk`
            let other = ((chunk + 1) % 4) * CHUNK as u64;
            doc.read(1, other, other + 1).unwrap(); // evicts it from the one-chunk cache
            let id_before = FileId::of(&path).unwrap();
            let result = doc.read_with(1, at, at + 16, || {
                let mut f = OpenOptions::new().write(true).open(&path).unwrap();
                f.seek(SeekFrom::Start(at)).unwrap();
                f.write_all(&[!original[at as usize]; 16]).unwrap();
                f.set_modified(id_before.modified).unwrap();
            });
            assert_eq!(FileId::of(&path).unwrap(), id_before, "the write must be invisible to metadata");
            if matches!(result, Err(DocError::Frozen(ref why)) if why.contains("chunk")) {
                caught += 1;
            }
            let mut f = OpenOptions::new().write(true).open(&path).unwrap();
            f.seek(SeekFrom::Start(at)).unwrap();
            f.write_all(&original[at as usize..at as usize + 16]).unwrap();
            f.set_modified(id_before.modified).unwrap();
        }
        assert_eq!(caught, 1000);
    }

    /// Spec §13.1 Spike C: 1,000 append/truncate/replace/delete/rename-away cycles while the document is open,
    /// with zero blocked operations and zero stale copies accepted.
    #[test]
    fn a_thousand_mutation_cycles_never_block_and_never_copy_stale_bytes() {
        let path = temp_file("doc-cycles", &pattern(2 * CHUNK, 3));
        let (tmp, moved) = (path.with_extension("tmp"), path.with_extension("moved"));
        let mut doc = Document::open(&path).unwrap();
        let (mut blocked, mut stale_accepted) = (Vec::new(), 0);
        for i in 0..1000u32 {
            let generation = doc.generation();
            doc.read(generation, 0, 64).unwrap();
            let op: io::Result<()> = match i % 5 {
                0 => OpenOptions::new().append(true).open(&path).and_then(|mut f| f.write_all(b"appended\n")),
                1 => OpenOptions::new().write(true).open(&path).and_then(|f| f.set_len(CHUNK as u64 + i as u64)),
                2 => fs::write(&tmp, pattern(CHUNK + 100, i as u8)).and_then(|_| fs::rename(&tmp, &path)),
                3 => fs::remove_file(&path).and_then(|_| fs::write(&path, pattern(CHUNK + 7, i as u8))),
                _ => fs::rename(&path, &moved), // the open file renamed away: nothing is at the path now
            };
            if let Err(e) = op {
                blocked.push(format!("cycle {i}: {e}"));
                continue;
            }
            if doc.read(generation, 0, 64).is_ok() {
                stale_accepted += 1;
            }
            if i % 5 == 4
                && let Err(e) = fs::write(&path, pattern(CHUNK + 11, i as u8)) // a new file at the path, to reload
            {
                blocked.push(format!("cycle {i}: recreate: {e}"));
                continue;
            }
            doc.reload().unwrap();
            let fresh = doc.read(doc.generation(), 0, 64).unwrap();
            assert_eq!(fresh, fs::read(&path).unwrap()[..64]);
        }
        let _ = fs::remove_file(&moved);
        assert!(blocked.is_empty(), "blocked operations: {blocked:?}");
        assert_eq!(stale_accepted, 0);
    }

    /// Spec §3.3: keep the handle for the document's lifetime, or reopen per read? Prints the cost of each.
    /// Run: cargo test --release -p spike-core handle_lifetime -- --ignored --nocapture
    #[test]
    #[ignore]
    fn handle_lifetime_costs() {
        let len = 64 * CHUNK;
        let path = temp_file("doc-handles", &pattern(len, 5));
        let doc = Document::open(&path).unwrap();
        let offsets: Vec<u64> = (0..2000u64).map(|i| (i * 2_654_435_761) % (len as u64 - 65_536)).collect();
        let time = |label: &str, mut f: Box<dyn FnMut(u64)>| {
            let mut us: Vec<f64> = offsets
                .iter()
                .map(|&o| {
                    let t = std::time::Instant::now();
                    f(o);
                    t.elapsed().as_secs_f64() * 1e6
                })
                .collect();
            us.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("{label}: p50 {:.1} µs, p95 {:.1} µs", us[us.len() / 2], us[us.len() * 95 / 100]);
        };
        time("kept handle, store.read only", Box::new(|o| drop(doc.store().read(o, o + 65_536).unwrap())));
        time("kept handle + identity checks (doc.read)", Box::new(|o| drop(doc.read(1, o, o + 65_536).unwrap())));
        time(
            "reopen per read + identity checks",
            Box::new(|o| {
                let _ = FileId::of(&path).unwrap();
                let f = fs::File::open(&path).unwrap();
                let mut buf = vec![0u8; 65_536];
                crate::store::read_exact_at(&f, &mut buf, o).unwrap();
                let _ = FileId::of(&path).unwrap();
            }),
        );
        time("identity check alone", Box::new(|_| drop(FileId::of(&path).unwrap())));
    }
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run (`spikes/core`): `cargo test -p spike-core`
Expected:
- `test result: FAILED. 16 passed; 3 failed; 1 ignored`.
- The three failures are `a_current_span_copies_and_a_stale_one_is_refused`, `mutation_race_is_caught_by_chunk_verification_1000_of_1000` and `a_thousand_mutation_cycles_never_block_and_never_copy_stale_bytes`. Each panics with `not yet implemented` in `open_with`.
- The ignored test is `handle_lifetime_costs`, a measurement (Step 5).

- [ ] **Step 3: Implement**

In `doc.rs`, replace the three stub methods, each from its `pub fn` line to its closing `}`, with these.

`open_with`:
<!-- op: replace-fn spikes/core/spike-core/src/doc.rs -->
```rust
    pub fn open_with(path: &Path, cache_chunks: usize, generation: u32) -> Result<Document, DocError> {
        let id = FileId::of(path).map_err(DocError::Io)?;
        let store = ByteStore::open_with(path, cache_chunks).map_err(DocError::Io)?;
        if store.len() != id.size {
            return Err(DocError::Frozen("changed while opening".into()));
        }
        Ok(Document { path: path.to_owned(), store, id, generation, cache_chunks, frozen: Mutex::new(None) })
    }
```

`read_with`:
<!-- op: replace-fn spikes/core/spike-core/src/doc.rs -->
```rust
    pub fn read_with(&self, generation: u32, start: u64, end: u64, between: impl FnOnce()) -> Result<Vec<u8>, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        self.check()?;
        between();
        let bytes = self.store.read(start, end).map_err(|e| match e {
            StoreError::Changed { chunk } => self.freeze(format!("changed on disk (chunk {chunk})")),
            StoreError::Io(e) => self.freeze(format!("read failed: {e}")),
        })?;
        self.check()?;
        Ok(bytes)
    }
```

`reload`:
<!-- op: replace-fn spikes/core/spike-core/src/doc.rs -->
```rust
    pub fn reload(&mut self) -> Result<(), DocError> {
        *self = Document::open_with(&self.path, self.cache_chunks, self.generation + 1)?;
        Ok(())
    }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `19 passed; 0 failed; 1 ignored`. Two of these tests are spec §13.1 Spike C gates:
- `mutation_race_is_caught_by_chunk_verification_1000_of_1000`: an in-place, same-size write with the timestamp restored. It's injected between the identity check and the read, and it's invisible to metadata (the test asserts that). Chunk verification catches it in 1,000 of 1,000 runs.
- `a_thousand_mutation_cycles_never_block_and_never_copy_stale_bytes`: 1,000 append/truncate/replace/delete/rename-away cycles while the document is open. After a rename-away, nothing is at the path until the test writes a new file there. No operation is blocked (non-locking handles), no stale copy is accepted, and after each reload the bytes match the file.

- [ ] **Step 5: Measure the handle-lifetime choice**

Spec §3.3 asks whether to keep the handle for the document's lifetime or reopen it for every read. Run (`spikes/core`):
`cargo test --release -p spike-core handle_lifetime -- --ignored --nocapture`

It prints four lines, each `<label>: p50 … µs, p95 … µs`, for random 64 KiB reads in a 64 MiB file:
- `kept handle, store.read only`;
- `kept handle + identity checks (doc.read)`;
- `reopen per read + identity checks`;
- `identity check alone`.

Copy them into REPORT-C. The scratch run on Zack's PC gave a p50 of 57 µs for the kept handle with identity checks, against 93 µs for reopening per read. Both are well inside the 3 ms page-fetch budget, so the decision rests on locking, which the 1,000-cycle gate covers, rather than on speed.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/.gitignore spikes/core/spike-core/src/doc.rs spikes/core/spike-core/src/lib.rs spikes/core/spike-core/Cargo.toml spikes/core/Cargo.lock
git commit -m "spike(c): documents with generations, verified reads, mutation gates"
```

---

## Task C1a: Byte maps — `ByteMap`/`MapBuilder`, the TypeScript port, cross-language vectors

**Files:**
- Create: `spikes/core/spike-core/src/bytemap.rs`
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod bytemap;`)
- Create: `spikes/app/src/renderer/src/bytemap.ts`
- Create: `spikes/app/src/renderer/src/bytemap.test.ts`
- Generated by `cargo test`, committed: `spikes/app/src/renderer/src/bytemap.vectors.json`

**Interfaces:**
- **Consumes:** `serde_json::{json, Value}` (already a dependency).
- **Produces (Rust, `spike_core::bytemap`):**
  - `pub enum ByteMap` (`Debug, Clone, PartialEq, Eq`):
    - `Uniform { start: u64, unit_bytes: u32, units: u32, pairs: Vec<u32> }`: byte(u) = start + u × unit_bytes at every element boundary; `pairs` are the sorted offsets where a two-unit element (a surrogate pair) starts, and offsets inside one snap.
    - `Breakpoints { points: Vec<(u32, u64)>, end: (u32, u64) }`: points sorted by UTF-16 offset, `points[0] = (0, start)`, one unit = one byte between points, `end = (units, byte just past the slice)`. Points may share an offset: the first there is `start_byte`, the last is `end_byte`.
  - `pub struct MapBuilder` with `pub fn new(start: u64) -> Self`, `pub fn push(&mut self, units: u32, bytes: u64)`, `pub fn finish(self) -> ByteMap` (Uniform when every push was 1 or 2 units at one bytes-per-unit ratio, else Breakpoints).
  - `impl ByteMap`: `pub fn start_byte(&self, u: u32) -> u64`, `pub fn end_byte(&self, u: u32) -> u64` (both clamp `u` to `units()`), `pub fn units(&self) -> u32`, `pub fn to_json(&self) -> serde_json::Value`.
  - `#[cfg(test)] pub(crate) fn naive_endpoints(start: u64, elements: &[(u32, u64)]) -> Vec<(u64, u64)>`: the snapping definition by brute force, `(start_byte, end_byte)` for every offset `0..=units`. Task C1c reuses it.
- **Produces (TypeScript, `bytemap.ts`):**
  - `type ByteMap = { kind: 'uniform'; start: number; unitBytes: number; units: number; pairs: number[] } | { kind: 'breakpoints'; points: [number, number][]; end: [number, number] }` (the `to_json` form).
  - `startByte(map: ByteMap, u: number): number`, `endByte(map: ByteMap, u: number): number`: same semantics; `u` clamps to `[0, units]`. Exact while byte offsets stay ≤ 2^53.

**Snapping semantics (binding for every task that builds maps, Tasks C4–C5 included):** a slice is a run of *elements* (`units` UTF-16 units from `bytes` source bytes). `start_byte(u)` is the first byte of the first element not wholly before `u`; `end_byte(u)` is the byte just past the last element not wholly after `u`. So an endpoint inside a surrogate pair snaps back (start) / forward (end), and a zero-unit element at `u` (a dropped `\r`) is included by both endpoints: a selection never drops a source byte it touches. Markdown markers are not zero-unit: Task C4b joins each marker to the content it wraps.

**Design notes:**
- **Compact:** an ASCII run costs nothing; a one-unit, n-byte element (é, an entity, an escape, a U+FFFD for 2–3 bytes) costs one point; a zero-unit element costs one or two; a k-unit element costs 2k − 1. Lookups are a binary search (`partition_point`), never a walk.
- **Why `Uniform` has `units` and `pairs`** (added to the brief's two fields): `units()` can't be answered without a length, and UTF-16 with an astral character has every element at 2 bytes per unit (so the brief's ratio rule calls it Uniform) while an offset inside the pair must still snap. `pairs` keeps UTF-16 uniform and correct.
- **The vectors can't go stale:** `writes_cross_language_vectors` regenerates `bytemap.vectors.json` deterministically on every `cargo test`; a git diff on that file means Rust behaviour changed, and `bytemap.test.ts` then fails until the TS port matches.

- [ ] **Step 1: Write the failing Rust tests**

Add the module to `spikes/core/spike-core/src/lib.rs`: replace
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub mod doc;
```
with
```rust
pub mod bytemap;
pub mod doc;
```

`spikes/core/spike-core/src/bytemap.rs`:
<!-- op: create spikes/core/spike-core/src/bytemap.rs -->
```rust
//! Byte maps (spec §3.2): every text slice the core sends maps its UTF-16 offsets back to source bytes,
//! so the renderer never re-encodes text to find offsets.
//!
//! A slice is a run of *elements*: `units` UTF-16 units that came from `bytes` source bytes (a char,
//! one U+FFFD for 1–3 malformed bytes, an entity, an escape, a dropped `\r`). Endpoints snap outward:
//! - `start_byte(u)` is the first byte of the first element that isn't wholly before `u`;
//! - `end_byte(u)` is the byte just past the last element that isn't wholly after `u`.
//!
//! An element over units `[s, t)` is wholly before `u` if `t < u`, or `t == u` and `s < u`; wholly after
//! `u` if `s > u`, or `s == u` and `t > u`. So an offset inside a surrogate pair snaps back (start) or
//! forward (end) to the pair's edges, and a zero-unit element at `u` lies inside both: a selection never
//! drops a source byte it touches.
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByteMap {
    /// byte(u) = start + u * unit_bytes at every element boundary. Every element is one unit, except the
    /// two-unit elements (surrogate pairs) starting at the sorted offsets in `pairs`, inside which offsets snap.
    /// Windows-1252 and ASCII UTF-8 have unit_bytes 1, UTF-16 has 2.
    Uniform { start: u64, unit_bytes: u32, units: u32, pairs: Vec<u32> },
    /// `points` sorted by UTF-16 offset; points[0] = (0, start). Between points, one UTF-16 unit = one source byte.
    /// `end` = (total UTF-16 units, byte offset just past the slice).
    /// Points may share an offset: the first one there is `start_byte`, the last is `end_byte`.
    Breakpoints { points: Vec<(u32, u64)>, end: (u32, u64) },
}

pub struct MapBuilder {
    start: u64,
    units: u32,
    bytes: u64,
    /// True while every element is 1 or 2 units of `unit_bytes` bytes each.
    uniform: bool,
    unit_bytes: Option<u32>,
    pairs: Vec<u32>,
    points: Vec<(u32, u64)>,
}

/// The definition in the module docs, applied by brute force: `(start_byte, end_byte)` for every offset
/// `0..=units`. Test reference only: it never looks at a `MapBuilder` or a `ByteMap`.
#[cfg(test)]
pub(crate) fn naive_endpoints(start: u64, elements: &[(u32, u64)]) -> Vec<(u64, u64)> {
    let mut spans = Vec::new(); // (s, t, first byte, byte past)
    let (mut s, mut b) = (0u32, start);
    for &(units, bytes) in elements {
        spans.push((s, s + units, b, b + bytes));
        s += units;
        b += bytes;
    }
    (0..=s)
        .map(|u| {
            let before = |&&(s, t, _, _): &&(u32, u32, u64, u64)| t < u || (t == u && s < u);
            let after = |&&(s, t, _, _): &&(u32, u32, u64, u64)| s > u || (s == u && t > u);
            let lo = spans.iter().find(|x| !before(x)).map_or(b, |x| x.2);
            let hi = spans.iter().rev().find(|x| !after(x)).map_or(start, |x| x.3);
            (lo, hi)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn build(start: u64, elements: &[(u32, u64)]) -> ByteMap {
        let mut b = MapBuilder::new(start);
        for &(units, bytes) in elements {
            b.push(units, bytes);
        }
        b.finish()
    }

    fn endpoints(map: &ByteMap, upto: u32) -> Vec<(u64, u64)> {
        (0..=upto).map(|u| (map.start_byte(u), map.end_byte(u))).collect()
    }

    #[test]
    fn ascii_runs_are_uniform_and_cost_nothing() {
        let map = build(10, &[(1, 1); 5]);
        assert_eq!(map, ByteMap::Uniform { start: 10, unit_bytes: 1, units: 5, pairs: vec![] });
        assert_eq!((map.start_byte(3), map.end_byte(3), map.end_byte(99)), (13, 13, 15));
    }

    #[test]
    fn one_multibyte_char_costs_one_point() {
        // "aé b": only é (1 unit, 2 bytes) needs a point.
        let map = build(100, &[(1, 1), (1, 2), (1, 1), (1, 1)]);
        assert_eq!(map, ByteMap::Breakpoints { points: vec![(0, 100), (2, 103)], end: (4, 105) });
        assert_eq!(endpoints(&map, 4), vec![(100, 100), (101, 101), (103, 103), (104, 104), (105, 105)]);
    }

    #[test]
    fn utf16_surrogate_pairs_stay_uniform_and_snap() {
        // "a😀b" in UTF-16: every element is 2 bytes per unit.
        let map = build(2, &[(1, 2), (2, 4), (1, 2)]);
        assert_eq!(map, ByteMap::Uniform { start: 2, unit_bytes: 2, units: 4, pairs: vec![1] });
        assert_eq!((map.start_byte(2), map.end_byte(2)), (4, 8)); // inside the pair
    }

    #[test]
    fn a_surrogate_pair_in_utf8_snaps_back_and_forward() {
        let map = build(0, &[(1, 1), (2, 4), (1, 1)]); // "a😀b"
        assert_eq!(endpoints(&map, 4), vec![(0, 0), (1, 1), (1, 5), (5, 5), (6, 6)]);
    }

    #[test]
    fn entities_escapes_and_a_dropped_cr_are_representable() {
        // "&amp;\*x\r\ny" rendered as "&*x\ny": entity, escape, x, dropped \r, \n, y.
        let map = build(0, &[(1, 5), (1, 2), (1, 1), (0, 1), (1, 1), (1, 1)]);
        assert_eq!(map.units(), 5);
        assert_eq!(endpoints(&map, 5), vec![(0, 0), (5, 5), (7, 7), (8, 9), (10, 10), (11, 11)]);
    }

    #[test]
    fn json_form_names_its_kind() {
        let map = build(1 << 33, &[(1, 1), (1, 3)]);
        assert_eq!(map.to_json().to_string(), r#"{"end":[2,8589934596],"kind":"breakpoints","points":[[0,8589934592]]}"#);
    }

    fn element() -> impl Strategy<Value = (u32, u64)> {
        prop_oneof![
            8 => Just((1, 1)),
            2 => (2u64..=4).prop_map(|b| (1, b)), // multi-byte char, or U+FFFD for 2–3 bytes
            1 => Just((2, 4)),                     // surrogate pair
            1 => Just((1, 2)),                     // UTF-16 BMP char
            1 => (5u64..=9).prop_map(|b| (1, b)),  // entity
            1 => (1u64..=3).prop_map(|b| (0, b)),  // dropped \r, markers
            1 => Just((1, 0)),                     // inserted text
            1 => (3u32..=4).prop_map(|n| (n, 7)),  // a multi-unit rewrite
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]
        #[test]
        fn endpoints_match_the_naive_definition(
            start in prop_oneof![Just(0u64), 0u64..1 << 40],
            elements in prop::collection::vec(element(), 0..40),
            uniform_k in 1u64..=3,
            uniform in any::<bool>(),
        ) {
            // Half the cases are uniform-shaped streams, so both variants get exercised.
            let elements: Vec<(u32, u64)> = if uniform {
                elements.iter().map(|&(n, _)| if n == 2 { (2, 2 * uniform_k) } else { (1, uniform_k) }).collect()
            } else {
                elements
            };
            let map = build(start, &elements);
            let naive = naive_endpoints(start, &elements);
            let units = naive.len() as u32 - 1;
            prop_assert_eq!(map.units(), units);
            prop_assert_eq!(endpoints(&map, units), naive.clone());
            prop_assert_eq!((map.start_byte(units + 3), map.end_byte(units + 3)), naive[units as usize]);
        }
    }

    /// Writes the vectors `bytemap.test.ts` checks the TypeScript port against. Every `cargo test` run
    /// regenerates them (deterministic), so they can't go stale; a diff in git means Rust behaviour changed.
    #[test]
    fn writes_cross_language_vectors() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let shapes: [&[(u32, u64)]; 6] = [
            &[(1, 1)],                                         // ASCII → Uniform 1
            &[(1, 2), (2, 4)],                                 // UTF-16 → Uniform 2 with pairs
            &[(1, 3)],                                         // CJK in UTF-8 → Uniform 3
            &[(1, 1), (1, 2), (1, 3), (2, 4), (1, 1)],         // UTF-8 mix → Breakpoints
            &[(1, 1), (1, 5), (1, 2), (0, 1), (0, 2), (1, 0), (3, 7)], // Markdown-like → Breakpoints
            &[(1, 1), (1, 1), (1, 1), (1, 2), (1, 3)],         // mostly ASCII
        ];
        let mut lines = Vec::new();
        for (i, shape) in shapes.iter().enumerate() {
            for case in 0..24 {
                let start = if case % 3 == 0 { (1u64 << 32) - 3 + next(8) } else { next(1 << 20) };
                let len = if case == 0 { 0 } else { next(40) };
                let elements: Vec<(u32, u64)> = (0..len).map(|_| shape[next(shape.len() as u64) as usize]).collect();
                let map = build(start, &elements);
                let us = 0..=map.units() + 2;
                let starts: Vec<u64> = us.clone().map(|u| map.start_byte(u)).collect();
                let ends: Vec<u64> = us.map(|u| map.end_byte(u)).collect();
                lines.push(json!({ "shape": i, "map": map.to_json(), "starts": starts, "ends": ends }).to_string());
            }
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../app/src/renderer/src/bytemap.vectors.json");
        std::fs::write(path, format!("{{\"cases\":[\n{}\n]}}\n", lines.join(",\n"))).unwrap();
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core bytemap`
Expected: ``error: could not compile `spike-core` (lib test) due to 17 previous errors; 1 warning emitted``, all `E0599`: no associated function `new` on `MapBuilder`; no methods `start_byte`, `end_byte`, `units`, `to_json` on `ByteMap`.

- [ ] **Step 3: Implement**

Add to `bytemap.rs`, between the `MapBuilder` struct and `naive_endpoints` (so directly above the line starting `/// The definition in the module docs`), followed by a blank line:
<!-- op: insert-before spikes/core/spike-core/src/bytemap.rs :: /// The definition in the module docs -->
```rust
impl MapBuilder {
    pub fn new(start: u64) -> Self {
        MapBuilder { start, units: 0, bytes: 0, uniform: true, unit_bytes: None, pairs: Vec::new(), points: Vec::new() }
    }

    /// Append one display element: `units` UTF-16 units that came from `bytes` source bytes
    /// (a char, an entity like "&amp;" → push(1, 5), a backslash escape "\*" → push(1, 2), a dropped "\r" → push(0, 1)).
    pub fn push(&mut self, units: u32, bytes: u64) {
        if units == 0 && bytes == 0 {
            return;
        }
        if self.uniform {
            let k = self.unit_bytes.or_else(|| u32::try_from(bytes / u64::from(units.max(1))).ok());
            match k {
                Some(k) if (units == 1 || units == 2) && bytes == u64::from(units) * u64::from(k) => {
                    self.unit_bytes = Some(k);
                    if units == 2 {
                        self.pairs.push(self.units);
                    }
                    self.units += units;
                    self.bytes += bytes;
                    return;
                }
                _ => self.switch_to_points(),
            }
        }
        self.add_points(units, bytes);
        self.units += units;
        self.bytes += bytes;
    }

    /// Uniform when every push had the same bytes-per-unit ratio (and was 1 or 2 units), else Breakpoints.
    pub fn finish(mut self) -> ByteMap {
        if self.uniform {
            let unit_bytes = self.unit_bytes.unwrap_or(1);
            return ByteMap::Uniform { start: self.start, unit_bytes, units: self.units, pairs: self.pairs };
        }
        let end = (self.units, self.start + self.bytes);
        if self.points.len() > 1 && self.points.last() == Some(&end) {
            self.points.pop(); // `end` already says it
        }
        ByteMap::Breakpoints { points: self.points, end }
    }

    /// Replays the uniform elements so far as points; runs once, when the first non-uniform element arrives.
    fn switch_to_points(&mut self) {
        let k = u64::from(self.unit_bytes.unwrap_or(1));
        let (total, pairs) = (self.units, std::mem::take(&mut self.pairs));
        (self.uniform, self.units, self.bytes, self.points) = (false, 0, 0, vec![(0, self.start)]);
        let mut pairs = pairs.into_iter().peekable();
        while self.units < total {
            let n = if pairs.next_if_eq(&self.units).is_some() { 2 } else { 1 };
            self.add_points(n, u64::from(n) * k);
            self.units += n;
            self.bytes += u64::from(n) * k;
        }
    }

    /// Points for one element at the current position. Invariant: the 1:1 run from the last point reaches
    /// the current position, so a one-unit, one-byte element needs nothing.
    fn add_points(&mut self, units: u32, bytes: u64) {
        let (u, b) = (self.units, self.start + self.bytes);
        let e = b + bytes;
        match units {
            0 => {
                if self.points.last().map(|p| p.0) != Some(u) {
                    self.points.push((u, b));
                }
                self.points.push((u, e));
            }
            1 if bytes == 1 => {}
            1 => self.points.push((u + 1, e)),
            n => {
                for k in 1..n {
                    self.points.push((u + k, b));
                    self.points.push((u + k, e));
                }
                self.points.push((u + n, e));
            }
        }
    }
}

impl ByteMap {
    /// Selection START at UTF-16 offset u → source byte. Inside a multi-unit element (a surrogate pair) or a
    /// multi-byte element, snaps BACK to the element's first byte. Offsets past the end clamp to it.
    pub fn start_byte(&self, u: u32) -> u64 {
        match self {
            ByteMap::Uniform { start, unit_bytes, units, pairs } => {
                let u = u.min(*units);
                let u = if u > 0 && pairs.binary_search(&(u - 1)).is_ok() { u - 1 } else { u };
                start + u64::from(u) * u64::from(*unit_bytes)
            }
            ByteMap::Breakpoints { points, end } => {
                let u = u.min(end.0);
                let i = points.partition_point(|p| p.0 < u);
                match points.get(i) {
                    Some(&(pu, pb)) if pu == u => pb,
                    None if end.0 == u => end.1,
                    _ => run(points[i - 1], u),
                }
            }
        }
    }

    /// Selection END at u → source byte. Inside an element, snaps FORWARD to just past the element.
    pub fn end_byte(&self, u: u32) -> u64 {
        match self {
            ByteMap::Uniform { start, unit_bytes, units, pairs } => {
                let u = u.min(*units);
                let u = if u > 0 && pairs.binary_search(&(u - 1)).is_ok() { u + 1 } else { u };
                start + u64::from(u) * u64::from(*unit_bytes)
            }
            ByteMap::Breakpoints { points, end } => {
                if u >= end.0 {
                    return end.1;
                }
                run(points[points.partition_point(|p| p.0 <= u) - 1], u)
            }
        }
    }

    pub fn units(&self) -> u32 {
        match self {
            ByteMap::Uniform { units, .. } => *units,
            ByteMap::Breakpoints { end, .. } => end.0,
        }
    }

    /// The renderer's form, read by `bytemap.ts`. Byte offsets are exact in JS up to 2^53.
    pub fn to_json(&self) -> Value {
        match self {
            ByteMap::Uniform { start, unit_bytes, units, pairs } => {
                json!({ "kind": "uniform", "start": start, "unitBytes": unit_bytes, "units": units, "pairs": pairs })
            }
            ByteMap::Breakpoints { points, end } => json!({ "kind": "breakpoints", "points": points, "end": end }),
        }
    }
}

/// The 1:1 run from point `p`, evaluated at `u`.
fn run((pu, pb): (u32, u64), u: u32) -> u64 {
    pb + u64::from(u - pu)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core bytemap`
Expected: `8 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out`. `endpoints_match_the_naive_definition` runs 10,000 cases (set in the test). The run writes `spikes/app/src/renderer/src/bytemap.vectors.json` (144 cases, about 91 KB).

- [ ] **Step 5: Write the failing TypeScript test**

`spikes/app/src/renderer/src/bytemap.test.ts`:
<!-- op: create spikes/app/src/renderer/src/bytemap.test.ts -->
```ts
import { describe, expect, it } from 'vitest'
import { endByte, startByte, type ByteMap } from './bytemap'
// Written by spike-core's `writes_cross_language_vectors` test on every `cargo test`.
import vectors from './bytemap.vectors.json'

const cases = vectors.cases as { shape: number; map: ByteMap; starts: number[]; ends: number[] }[]

describe('bytemap.ts agrees with spike-core', () => {
  it('has vectors for every map shape, including surrogate pairs and zero-unit elements', () => {
    const uniformWithPairs = cases.filter((c) => c.map.kind === 'uniform' && c.map.pairs.length > 0)
    const zeroUnit = cases.filter(
      (c) => c.map.kind === 'breakpoints' && c.map.points.some((p, i, all) => i > 0 && all[i - 1][0] === p[0])
    )
    const beyond4GiB = cases.filter((c) => c.starts[0] > 2 ** 32)
    expect(new Set(cases.map((c) => c.shape)).size).toBe(6)
    expect(uniformWithPairs.length).toBeGreaterThan(0)
    expect(zeroUnit.length).toBeGreaterThan(0)
    expect(beyond4GiB.length).toBeGreaterThan(0)
  })

  it('startByte and endByte equal Rust at every offset, past-the-end ones included', () => {
    const mismatches: string[] = []
    let checked = 0
    cases.forEach((c, n) => {
      c.starts.forEach((want, u) => {
        const got = [startByte(c.map, u), endByte(c.map, u)]
        if (got[0] !== want || got[1] !== c.ends[u]) mismatches.push(`case ${n} u=${u}: ${got} != ${[want, c.ends[u]]}`)
        checked++
      })
    })
    expect(mismatches).toEqual([])
    expect(checked).toBeGreaterThan(3000)
  })

  it('clamps a negative offset to the start', () => {
    const map: ByteMap = { kind: 'breakpoints', points: [[0, 10]], end: [2, 14] }
    expect([startByte(map, -1), endByte(map, -1)]).toEqual([10, 10])
  })
})
```

Run (`spikes/app`): `npx vitest run bytemap`
Expected: FAIL, `Error: Cannot find module './bytemap' imported from …/bytemap.test.ts`, `Test Files  1 failed (1)`.

- [ ] **Step 6: Implement the TypeScript port**

`spikes/app/src/renderer/src/bytemap.ts`:
<!-- op: create spikes/app/src/renderer/src/bytemap.ts -->
```ts
// Byte maps from the core (spec §3.2), the same semantics as spike-core's bytemap.rs: a UTF-16 offset
// becomes a source byte, and an endpoint inside an element (a surrogate pair, a multi-byte character,
// an entity) snaps outward to the element's edge. The renderer never re-encodes text to find offsets.

export type ByteMap =
  | { kind: 'uniform'; start: number; unitBytes: number; units: number; pairs: number[] }
  | { kind: 'breakpoints'; points: [number, number][]; end: [number, number] }

/** The first index in [0, n) where `before` is false (`before` is true for a prefix). */
function partitionPoint(n: number, before: (i: number) => boolean): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (before(mid)) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insidePair(pairs: number[], u: number): boolean {
  const i = partitionPoint(pairs.length, (k) => pairs[k] < u - 1)
  return u > 0 && pairs[i] === u - 1
}

const clamp = (u: number, max: number): number => Math.min(Math.max(u, 0), max)

/** Selection start at UTF-16 offset `u`: inside an element, the element's first byte. */
export function startByte(map: ByteMap, u: number): number {
  if (map.kind === 'uniform') {
    u = clamp(u, map.units)
    return map.start + (insidePair(map.pairs, u) ? u - 1 : u) * map.unitBytes
  }
  const { points, end } = map
  u = clamp(u, end[0])
  const i = partitionPoint(points.length, (k) => points[k][0] < u)
  if (i < points.length && points[i][0] === u) return points[i][1]
  if (i === points.length && end[0] === u) return end[1]
  const [pu, pb] = points[i - 1]
  return pb + (u - pu)
}

/** Selection end at UTF-16 offset `u`: inside an element, the byte just past it. */
export function endByte(map: ByteMap, u: number): number {
  if (map.kind === 'uniform') {
    u = clamp(u, map.units)
    return map.start + (insidePair(map.pairs, u) ? u + 1 : u) * map.unitBytes
  }
  const { points, end } = map
  if (u >= end[0]) return end[1]
  u = clamp(u, end[0])
  const [pu, pb] = points[partitionPoint(points.length, (k) => points[k][0] <= u) - 1]
  return pb + (u - pu)
}
```

Run (`spikes/app`): `npx vitest run`
Expected: `Test Files  3 passed (3)`, `Tests  14 passed (14)` (plan A's 11, plus 3).

- [ ] **Step 7: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/bytemap.rs spikes/core/spike-core/src/lib.rs spikes/app/src/renderer/src/bytemap.ts spikes/app/src/renderer/src/bytemap.test.ts spikes/app/src/renderer/src/bytemap.vectors.json
git commit -m "spike(c): byte maps with outward snapping, a TS port and cross-language vectors"
```

---

## Task C1b: Sniffing and decoding; UTF-16 newlines in the line index; `pages::lines` and `pages::piece` through `decode`

**Files:**
- Modify: `spikes/core/spike-core/Cargo.toml` (`encoding_rs`)
- Create: `spikes/core/spike-core/src/encoding.rs`
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod encoding;`)
- Modify: `spikes/core/spike-core/src/index.rs` (`LineIndex.encoding`; `build` and `locate_line` scan UTF-16 by unit)
- Modify: `spikes/core/spike-core/src/pages.rs` (`LinePiece.map`; `lines` and `piece` decode through `decode`)
- Modify: `spikes/core/spike-node/src/lib.rs` (`Doc::piece` passes the index)

**Interfaces:**
- **Consumes:** `bytemap::{ByteMap, MapBuilder}`; `index::{build, locate_line, IndexConfig, LineIndex}`; `store::{ByteStore, StoreError, CHUNK}`; `encoding_rs 0.8.42` (`Encoding`, `DecoderResult`, `UTF_8`, `UTF_16LE`, `UTF_16BE`, `WINDOWS_1252`).
- **Produces (`spike_core::encoding`):**
  - `pub const NUL_WINDOW: usize = 8 * 1024;`
  - `pub enum Sniffed { Binary, Text { encoding: &'static Encoding, bom: usize } }` (`Debug, Clone, Copy, PartialEq, Eq`)
  - `pub struct TextSlice { pub text: String, pub map: ByteMap, pub replacements: u32 }` (`Debug, Clone, PartialEq`)
  - `pub fn sniff(head: &[u8], whole_file: bool, fallback: &'static Encoding) -> Sniffed`: spec §4.1's order. BOM (UTF-8, UTF-16LE/BE; a UTF-16 BOM skips the NUL test), then any NUL in the first 8 KiB ⇒ `Binary`, then valid UTF-8, then `fallback`. A head cut inside a UTF-8 sequence counts as UTF-8 unless `whole_file`.
  - `pub fn decode(bytes: &[u8], encoding: &'static Encoding, start_offset: u64) -> TextSlice`: at `start_offset == 0`, the encoding's BOM is excluded from the text and the map starts at its real offset. Each malformed sequence becomes one U+FFFD that maps to exactly the bytes it replaced. `encoding` is UTF-8, UTF-16LE/BE or single-byte.
  - `pub fn newline_and_cr(encoding: &'static Encoding) -> (&'static [u8], &'static [u8])`
  - `pub fn newline_ends<'a>(encoding: &'static Encoding, at: u64, bytes: &'a [u8]) -> Box<dyn Iterator<Item = usize> + 'a>`: the position of each newline's last byte; `bytes` start at file offset `at`.
- **Changes:**
  - `index::LineIndex` gains `pub encoding: &'static Encoding` (default `UTF_8`; `Default` becomes a manual impl). `build` reads it from `shared` before scanning; set it with `RwLock::new(LineIndex { encoding, ..LineIndex::default() })`.
  - `pages::LinePiece` gains `pub map: ByteMap` (between `text` and `more`). `lines` decodes each piece with `decode(bytes, index.encoding, offset)`; a first line's BOM and every line's `\r` lie outside the map.
  - `pages::piece` (plan A's Z37 continuation) becomes `piece(store, index, line, offset)`: it needs the index's encoding, and decodes the same way. Plan A's two Z37 tests and napi `Doc::piece` pass the index.

**The hidden problem:** Spike A finds lines with `memchr(b'\n')`. In UTF-16 a 0x0A byte is often half of another unit (U+010A is `0A 01` in UTF-16LE; U+0A0A is `0A 0A`), and a real newline is two bytes, so every following line start is off by one. Step 6 shows it. UTF-8 and Windows-1252 keep the `memchr` path unchanged.

- [ ] **Step 1: Add the dependency and write the failing tests**

In `spikes/core/spike-core/Cargo.toml`, replace
<!-- op: replace spikes/core/spike-core/Cargo.toml -->
```toml
[dependencies]
memchr = "2.8"
```
with
```toml
[dependencies]
encoding_rs = "0.8.42"
memchr = "2.8"
```

In `spikes/core/spike-core/src/lib.rs`, replace
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub mod doc;
pub mod index;
```
with
```rust
pub mod doc;
pub mod encoding;
pub mod index;
```

`spikes/core/spike-core/src/encoding.rs`:
<!-- op: create spikes/core/spike-core/src/encoding.rs -->
```rust
//! Sniffing and decoding (spec §4.1, brief §5.3): BOM, then NUL ⇒ binary, then valid UTF-8, then the fallback.
//! `decode` returns text plus its byte map (spec §3.2). Each malformed sequence becomes one U+FFFD that maps
//! to exactly the bytes it replaced.
use encoding_rs::{DecoderResult, Encoding, UTF_16BE, UTF_16LE, UTF_8};
use memchr::{memchr, memchr_iter, memmem};

use crate::bytemap::{ByteMap, MapBuilder};

/// Spec §4.1: a NUL in the first 8KB marks a file binary, unless a UTF-16 BOM came first.
pub const NUL_WINDOW: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sniffed {
    Binary,
    /// `bom` is the BOM's length in bytes, 0 without one.
    Text { encoding: &'static Encoding, bom: usize },
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextSlice {
    pub text: String,
    pub map: ByteMap,
    /// U+FFFD substitutions. Each one is a problem (brief §7.7).
    pub replacements: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::WINDOWS_1252;
    use std::time::Instant;

    fn utf16(text: &str, be: bool) -> Vec<u8> {
        text.encode_utf16().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() }).collect()
    }

    #[test]
    fn sniff_follows_the_spec_order() {
        let le = [b"\xFF\xFE".as_slice(), &utf16("a\0b", false)].concat();
        assert_eq!(sniff(&le, true, WINDOWS_1252), Sniffed::Text { encoding: UTF_16LE, bom: 2 });
        assert_eq!(sniff(b"\xFE\xFF\0a", true, WINDOWS_1252), Sniffed::Text { encoding: UTF_16BE, bom: 2 });
        assert_eq!(sniff(b"\xEF\xBB\xBFhi", true, WINDOWS_1252), Sniffed::Text { encoding: UTF_8, bom: 3 });
        assert_eq!(sniff(b"\xEF\xBB\xBFh\0i", true, WINDOWS_1252), Sniffed::Binary); // a UTF-8 BOM keeps the NUL test
        assert_eq!(sniff(&utf16("BOM-less", false), true, WINDOWS_1252), Sniffed::Binary);
        let mut late_nul = vec![b'a'; NUL_WINDOW + 1];
        late_nul[NUL_WINDOW] = 0;
        assert_eq!(sniff(&late_nul, true, WINDOWS_1252), Sniffed::Text { encoding: UTF_8, bom: 0 });
        late_nul[NUL_WINDOW - 1] = 0;
        assert_eq!(sniff(&late_nul, true, WINDOWS_1252), Sniffed::Binary);
        assert_eq!(sniff("héllo".as_bytes(), true, WINDOWS_1252), Sniffed::Text { encoding: UTF_8, bom: 0 });
        assert_eq!(sniff(b"caf\xE9 au lait", true, WINDOWS_1252), Sniffed::Text { encoding: WINDOWS_1252, bom: 0 });
        assert_eq!(sniff(b"ab\xE2\x82", false, WINDOWS_1252), Sniffed::Text { encoding: UTF_8, bom: 0 });
        assert_eq!(sniff(b"ab\xE2\x82", true, WINDOWS_1252), Sniffed::Text { encoding: WINDOWS_1252, bom: 0 });
    }

    /// encoding_rs's real UTF-8 behaviour (WHATWG "maximal subpart"): one U+FFFD for 1–3 bytes.
    #[test]
    fn each_replacement_maps_to_the_bytes_it_replaced() {
        let cases: [(&[u8], &str, &[u64]); 6] = [
            (b"a\xF0\x9F\x98", "a\u{FFFD}", &[0, 1, 4]),                       // truncated 4-byte sequence: 3 bytes
            (b"\xE2\x82A", "\u{FFFD}A", &[0, 2, 3]),                           // truncated 3-byte sequence: 2 bytes
            (b"\xC0\x80", "\u{FFFD}\u{FFFD}", &[0, 1, 2]),                     // overlong: C0 is never valid
            (b"\xE0\x80\x80", "\u{FFFD}\u{FFFD}\u{FFFD}", &[0, 1, 2, 3]),      // overlong 3-byte
            (b"\xED\xA0\x80", "\u{FFFD}\u{FFFD}\u{FFFD}", &[0, 1, 2, 3]),      // a surrogate encoded in UTF-8
            (b"\xF4\x90\x80\x80\xBF", "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}", &[0, 1, 2, 3, 4, 5]), // > U+10FFFF
        ];
        for (bytes, text, boundaries) in cases {
            let got = decode(bytes, UTF_8, 0);
            assert_eq!(got.text, text, "{bytes:x?}");
            assert_eq!(got.replacements as usize, text.matches('\u{FFFD}').count());
            let us: Vec<u64> = (0..=got.map.units()).map(|u| got.map.start_byte(u)).collect();
            assert_eq!(us, boundaries, "{bytes:x?}");
        }
    }

    #[test]
    fn a_bom_is_skipped_only_at_file_start_and_the_map_keeps_real_offsets() {
        let got = decode("\u{FEFF}hi".as_bytes(), UTF_8, 0);
        assert_eq!((got.text.as_str(), got.map.start_byte(0), got.map.end_byte(2)), ("hi", 3, 5));
        let mid = decode("\u{FEFF}hi".as_bytes(), UTF_8, 10); // U+FEFF mid-file is text (ZWNBSP)
        assert_eq!((mid.text.as_str(), mid.map.end_byte(1)), ("\u{FEFF}hi", 13));
        for (bom, be) in [(b"\xFF\xFE", false), (b"\xFE\xFF", true)] {
            let bytes = [bom.as_slice(), &utf16("a😀", be)].concat();
            let got = decode(&bytes, if be { UTF_16BE } else { UTF_16LE }, 0);
            assert_eq!(got.text, "a😀");
            assert_eq!(got.map, ByteMap::Uniform { start: 2, unit_bytes: 2, units: 3, pairs: vec![1] });
        }
    }

    /// encoding_rs's real UTF-16 behaviour (WHATWG): an unpaired surrogate is one U+FFFD for its 2 bytes;
    /// a lead surrogate plus an odd trailing byte at the end is ONE U+FFFD for 3 bytes.
    #[test]
    fn utf16_unpaired_surrogates_and_odd_bytes() {
        let cases: [(&[u8], &str, &[u64]); 4] = [
            (b"\x00\xD8\x41\x00", "\u{FFFD}A", &[0, 2, 4]), // lead surrogate, then 'A'
            (b"\x00\xDC\x41\x00", "\u{FFFD}A", &[0, 2, 4]), // lone trail surrogate
            (b"\x41\x00\x42", "A\u{FFFD}", &[0, 2, 3]),     // odd trailing byte
            (b"\x00\xD8\x41", "\u{FFFD}", &[0, 3]),         // lead surrogate + odd byte at the end
        ];
        for (bytes, text, boundaries) in cases {
            let got = decode(bytes, UTF_16LE, 1);
            assert_eq!(got.text, text, "{bytes:x?}");
            let us: Vec<u64> = (0..=got.map.units()).map(|u| got.map.start_byte(u) - 1).collect();
            assert_eq!(us, boundaries, "{bytes:x?}");
        }
    }

    #[test]
    fn windows_1252_is_one_byte_per_unit_with_no_replacements() {
        let bytes: Vec<u8> = (0..=255).collect();
        let got = decode(&bytes, WINDOWS_1252, 7);
        assert_eq!(got.map, ByteMap::Uniform { start: 7, unit_bytes: 1, units: 256, pairs: vec![] });
        assert_eq!((got.replacements, got.text.chars().nth(0x80)), (0, Some('€')));
    }

    #[test]
    fn utf16_newlines_are_aligned_units_not_bytes() {
        // U+010A is 0A 01 in LE; U+0A0D is 0D 0A in LE: two stray 0x0A bytes, one real newline.
        let le = [b"\xFF\xFE".as_slice(), &utf16("\u{010A}\u{0A0D}\nx", false)].concat();
        assert_eq!(newline_ends(UTF_16LE, 0, &le).collect::<Vec<_>>(), vec![7]);
        assert_eq!(newline_ends(UTF_8, 0, b"a\nb\n").collect::<Vec<_>>(), vec![1, 3]);
        // Parity is by file offset: the same bytes starting at an odd offset hold no newline.
        assert_eq!(newline_ends(UTF_16BE, 1, b"\0\n").count(), 0);
    }

    /// Hostile input: 1 MiB of random bytes per encoding decodes without a panic, in bounded time,
    /// with a map that covers every byte.
    #[test]
    fn a_random_megabyte_decodes_in_bounded_time() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let bytes: Vec<u8> = (0..1 << 20)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed as u8
            })
            .collect();
        for encoding in [UTF_8, UTF_16LE, UTF_16BE, WINDOWS_1252] {
            let t = Instant::now();
            let got = decode(&bytes, encoding, 1 << 32);
            let ms = t.elapsed().as_millis();
            println!("{}: 1 MiB in {ms} ms, {} replacements", encoding.name(), got.replacements);
            assert_eq!(got.map.end_byte(got.map.units()), (1 << 32) + bytes.len() as u64);
            assert_eq!(got.map.units() as usize, got.text.encode_utf16().count());
            assert!(ms < 5_000, "{}: {ms} ms", encoding.name());
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core encoding`
Expected: `due to 21 previous errors`, all `E0425`: cannot find function `sniff` (11), `decode` (7), `newline_ends` (3).

- [ ] **Step 3: Implement**

Add to `encoding.rs`, directly above `#[cfg(test)]`, followed by a blank line:
<!-- op: insert-before spikes/core/spike-core/src/encoding.rs :: #[cfg(test)] -->
```rust
/// `head` is the start of the file (the caller passes its first chunk); `whole_file` says it's all of it.
/// A head cut inside a UTF-8 sequence still counts as UTF-8, unless the file itself ends there.
pub fn sniff(head: &[u8], whole_file: bool, fallback: &'static Encoding) -> Sniffed {
    let bom = Encoding::for_bom(head);
    if let Some((encoding, bom)) = bom
        && encoding != UTF_8
    {
        return Sniffed::Text { encoding, bom }; // UTF-16 text is full of NULs: no NUL test
    }
    if memchr(0, &head[..head.len().min(NUL_WINDOW)]).is_some() {
        return Sniffed::Binary;
    }
    if let Some((encoding, bom)) = bom {
        return Sniffed::Text { encoding, bom };
    }
    match std::str::from_utf8(head) {
        Err(e) if e.error_len().is_some() || whole_file => Sniffed::Text { encoding: fallback, bom: 0 },
        _ => Sniffed::Text { encoding: UTF_8, bom: 0 },
    }
}

/// Decodes `bytes`, which start at file offset `start_offset`. At offset 0, `encoding`'s BOM is skipped:
/// it isn't text, and the map starts at its real offset just past it.
/// `encoding` is UTF-8, UTF-16LE/BE or a single-byte encoding, which is all `sniff` returns while the
/// fallback is single-byte (Windows-1252 by default).
pub fn decode(bytes: &[u8], encoding: &'static Encoding, start_offset: u64) -> TextSlice {
    let bom = match Encoding::for_bom(bytes) {
        Some((e, n)) if e == encoding && start_offset == 0 => n,
        _ => 0,
    };
    let src = &bytes[bom..];
    if encoding.is_ascii_compatible() && src.is_ascii() {
        // The common case at memcpy speed: a 64 KiB ASCII piece takes ~35 µs here, ~175 µs char by char.
        let map = ByteMap::Uniform { start: start_offset + bom as u64, unit_bytes: 1, units: src.len() as u32, pairs: Vec::new() };
        return TextSlice { text: String::from_utf8_lossy(src).into_owned(), map, replacements: 0 };
    }
    let utf16 = encoding == UTF_16LE || encoding == UTF_16BE;
    // ponytail: source length per valid char, from the char. Fine for UTF-8, UTF-16 and single-byte encodings;
    // a multi-byte legacy fallback (Shift_JIS, GBK…) would need lengths from the decoder itself.
    let source_len = |c: char| {
        if encoding == UTF_8 {
            c.len_utf8() as u64
        } else if utf16 {
            2 * c.len_utf16() as u64
        } else {
            1
        }
    };
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut map = MapBuilder::new(start_offset + bom as u64);
    let (mut text, mut pos, mut replacements) = (String::with_capacity(src.len()), 0, 0);
    // A small fixed buffer: `decode_to_string_*` touches every page of the String's spare capacity on each
    // call, and hostile input makes one call per malformed byte, which would be quadratic.
    let mut scratch = "\0".repeat(4096);
    loop {
        let (result, read, written) = decoder.decode_to_str_without_replacement(&src[pos..], &mut scratch, true);
        for c in scratch[..written].chars() {
            map.push(c.len_utf16() as u32, source_len(c));
        }
        text.push_str(&scratch[..written]);
        pos += read;
        match result {
            DecoderResult::InputEmpty => break,
            DecoderResult::OutputFull => {}
            DecoderResult::Malformed(bad, _) => {
                // Bytes consumed after the bad ones haven't produced output yet, so order is kept.
                text.push('\u{FFFD}');
                map.push(1, u64::from(bad));
                replacements += 1;
            }
        }
    }
    TextSlice { text, map: map.finish(), replacements }
}

/// `\n` and `\r` as `encoding` writes them: two-byte units in UTF-16, single bytes in every other
/// supported encoding (all ASCII-compatible).
pub fn newline_and_cr(encoding: &'static Encoding) -> (&'static [u8], &'static [u8]) {
    if encoding == UTF_16LE {
        (b"\n\0", b"\r\0")
    } else if encoding == UTF_16BE {
        (b"\0\n", b"\0\r")
    } else {
        (b"\n", b"\r")
    }
}

/// The position of each newline's last byte in `bytes`, which start at file offset `at`.
/// In UTF-16 a newline is the unit 0x000A at an even file offset. A lone 0x0A byte there is half of another
/// unit (U+010A is `0A 01` in UTF-16LE, U+0A0D is `0A 0D` in UTF-16BE), and the next line starts 2 bytes on.
pub fn newline_ends<'a>(encoding: &'static Encoding, at: u64, bytes: &'a [u8]) -> Box<dyn Iterator<Item = usize> + 'a> {
    match newline_and_cr(encoding).0 {
        [b'\n'] => Box::new(memchr_iter(b'\n', bytes)),
        unit => Box::new(memmem::find_iter(bytes, unit).filter(move |&i| (at + i as u64) % 2 == 0).map(|i| i + 1)),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass, and read the hostile-input timings**

Run (`spikes/core`): `cargo test -p spike-core encoding -- --nocapture`
Expected: `7 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out`, and four lines in the form `UTF-8: 1 MiB in 799 ms, 434585 replacements` (the scratch run's UTF-8 line; debug build; the test's bound is 5 s per MiB). Record them.

- [ ] **Step 5: Write the failing UTF-16 line-index tests**

In `spikes/core/spike-core/src/index.rs`, replace
<!-- op: replace spikes/core/spike-core/src/index.rs -->
```rust
use memchr::memchr_iter;
```
with
```rust
use encoding_rs::{Encoding, UTF_8};
use memchr::memchr_iter;
```

and replace
<!-- op: replace spikes/core/spike-core/src/index.rs -->
```rust
#[derive(Debug, Default)]
pub struct LineIndex {
    pub checkpoints: Vec<Checkpoint>,
    pub newlines: u64,
    pub last_line_start: u64,
    pub indexed_bytes: u64,
    pub done: bool,
}
```
with
```rust
#[derive(Debug)]
pub struct LineIndex {
    pub checkpoints: Vec<Checkpoint>,
    pub newlines: u64,
    pub last_line_start: u64,
    pub indexed_bytes: u64,
    pub done: bool,
    /// Decides what a newline is: in UTF-16 it's a 2-byte unit. Set it before `build`; the default is UTF-8.
    pub encoding: &'static Encoding,
}

impl Default for LineIndex {
    fn default() -> Self {
        LineIndex { checkpoints: Vec::new(), newlines: 0, last_line_start: 0, indexed_bytes: 0, done: false, encoding: UTF_8 }
    }
}
```

Add at the end of `mod tests` in `index.rs` (before its closing `}`, after a blank line):
<!-- op: append-in-module spikes/core/spike-core/src/index.rs -->
```rust
    fn index_encoded(name: &str, bytes: &[u8], cfg: IndexConfig, encoding: &'static Encoding) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex { encoding, ..LineIndex::default() });
        build(&File::open(&path).unwrap(), store.len(), cfg, &store.hashes(), &shared, |_| {}).unwrap();
        (store, shared.into_inner().unwrap())
    }

    /// Line starts found by decoding UTF-16 units in order (std's decoder), never by scanning bytes.
    fn utf16_line_starts(bytes: &[u8], be: bool) -> Vec<u64> {
        let units = bytes.chunks_exact(2).map(|p| if be { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) });
        let mut starts = if bytes.is_empty() { vec![] } else { vec![0u64] };
        let mut at = 0u64;
        for c in char::decode_utf16(units) {
            let newline = c == Ok('\n');
            at += c.map_or(2, |c| 2 * c.len_utf16() as u64);
            if newline && at < bytes.len() as u64 {
                starts.push(at);
            }
        }
        starts
    }

    fn utf16_file(units: &[u16], be: bool) -> Vec<u8> {
        let bom: &[u8] = if be { b"\xFE\xFF" } else { b"\xFF\xFE" };
        let body = units.iter().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
        bom.iter().copied().chain(body).collect()
    }

    /// Spike A's memchr(b'\n') finds 0x0A bytes. In UTF-16 that's wrong twice over: a 0x0A byte can be half of
    /// another unit (U+010A, U+0A0D, U+0A00), and a real newline is 2 bytes, so the next line starts 2 bytes on.
    #[test]
    fn utf16_lines_split_on_newline_units_not_0x0a_bytes() {
        for (be, encoding) in [(false, encoding_rs::UTF_16LE), (true, encoding_rs::UTF_16BE)] {
            let units: Vec<u16> = "Ċ\u{0A0D}\u{0A00}\r\nsecond ਊ\nthird".encode_utf16().collect();
            let bytes = utf16_file(&units, be);
            let (store, idx) = index_encoded("utf16-lines", &bytes, IndexConfig::default(), encoding);
            let got: Vec<Option<u64>> = (0..idx.line_count()).map(|l| locate_line(&store, &idx, l).unwrap()).collect();
            let want: Vec<Option<u64>> = utf16_line_starts(&bytes, be).into_iter().map(Some).collect();
            assert_eq!(got, want, "{encoding:?}");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn utf16_locate_line_matches_decoding(
            units in prop::collection::vec(
                prop::sample::select(vec![0x000A, 0x000D, 0x010A, 0x0A0D, 0x0A00, 0x0A0A, 0x0041, 0x00E9, 0xD83D, 0xDE00]),
                0..1500,
            ),
            be in any::<bool>(),
            cp_lines in 1u64..50,
            cp_bytes in 1u64..300, // odd values put mid-line checkpoints inside a unit
        ) {
            let encoding = if be { encoding_rs::UTF_16BE } else { encoding_rs::UTF_16LE };
            let bytes = utf16_file(&units, be);
            let (store, idx) = index_encoded("utf16-prop", &bytes, IndexConfig { cp_lines, cp_bytes, block: CHUNK }, encoding);
            let starts = utf16_line_starts(&bytes, be);
            prop_assert_eq!(idx.line_count(), starts.len() as u64);
            for (line, &start) in starts.iter().enumerate() {
                prop_assert_eq!(locate_line(&store, &idx, line as u64).unwrap(), Some(start));
            }
            for pair in idx.checkpoints.windows(2) {
                prop_assert!(pair[1].offset - pair[0].offset <= cp_bytes, "checkpoint gap over cp_bytes");
            }
        }
    }
```

- [ ] **Step 6: Run them to see Spike A's scan fail on UTF-16**

Run (`spikes/core`): `cargo test -p spike-core index`
Expected: `5 passed; 2 failed`. `utf16_lines_split_on_newline_units_not_0x0a_bytes` fails with
```text
assertion `left == right` failed: Encoding { name: "UTF-16LE", .. }
  left: [Some(0), Some(3), Some(6), Some(8), Some(11), Some(27), Some(28), Some(29)]
 right: [Some(0), Some(12), Some(30)]
```
That's 8 "lines" where the file has 3, and every start after line 0 is wrong, four of them mid-unit. `utf16_locate_line_matches_decoding` fails on a line count.

- [ ] **Step 7: Fix the scan**

In `index.rs`, replace
<!-- op: replace spikes/core/spike-core/src/index.rs -->
```rust
use encoding_rs::{Encoding, UTF_8};
use memchr::memchr_iter;

use crate::store::{read_exact_at, ByteStore, ChunkHashes, StoreError, CHUNK};
```
with
```rust
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use memchr::memchr_iter;

use crate::encoding::{newline_and_cr, newline_ends};
use crate::store::{read_exact_at, ByteStore, ChunkHashes, StoreError, CHUNK};
```

in `build`, replace
<!-- op: replace spikes/core/spike-core/src/index.rs -->
```rust
    let started = Instant::now();
    let mut b = Builder::new(cfg);
    let mut buf = vec![0u8; block_len(&cfg)];
    let mut pos = 0u64;
    while pos < len {
        let n = ((len - pos) as usize).min(buf.len());
        let block = read_block(file, &mut buf[..n], pos, hashes)?;
        b.block(pos, pos + n as u64, memchr_iter(b'\n', block));
```
with
```rust
    let started = Instant::now();
    let encoding = shared.read().unwrap().encoding;
    let mut b = Builder::new(cfg);
    let mut buf = vec![0u8; block_len(&cfg)];
    let mut pos = 0u64;
    while pos < len {
        let n = ((len - pos) as usize).min(buf.len());
        let block = read_block(file, &mut buf[..n], pos, hashes)?;
        if encoding == UTF_16LE || encoding == UTF_16BE {
            b.block(pos, pos + n as u64, newline_ends(encoding, pos, block));
        } else {
            b.block(pos, pos + n as u64, memchr_iter(b'\n', block)); // Spike A's hot path, unchanged
        }
```

and in `locate_line`, replace
<!-- op: replace spikes/core/spike-core/src/index.rs -->
```rust
    let mut pos = cp.offset;
    while pos < index.indexed_bytes {
        let end = (pos + CHUNK as u64).min(index.indexed_bytes);
        let bytes = store.read(pos, end)?;
        for rel in memchr_iter(b'\n', &bytes) {
```
with
```rust
    // An odd `cp_bytes` can put a mid-line checkpoint inside a UTF-16 newline unit: scan from the unit's start.
    let mut pos = if newline_and_cr(index.encoding).0.len() == 2 { cp.offset & !1 } else { cp.offset };
    while pos < index.indexed_bytes {
        let end = (pos + CHUNK as u64).min(index.indexed_bytes);
        let bytes = store.read(pos, end)?;
        for rel in newline_ends(index.encoding, pos, &bytes) {
```

`Builder` is untouched: `newline_ends` reports each newline's *last* byte, so `line_start = start + rel + 1` is right for 1- and 2-byte newlines alike. `build_parallel` (Task 12) still scans bytes; if Task 12 ever runs, give it the same branch.

- [ ] **Step 8: Run the index tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core index`
Expected: `7 passed; 0 failed; 0 ignored; 0 measured; 30 filtered out`: plan A's 5 index tests unchanged, plus 2. The proptest uses odd `cp_bytes`; without the `& !1` alignment in `locate_line` it fails (`left: Some(266)`, `right: Some(264)`).
Step 6's failures wrote seeds from the unfixed scan to `spikes/core/spike-core/proptest-regressions/index.txt`. Delete them (run in `spikes/core`: `git clean -fX spike-core/proptest-regressions`) so no red-step artifact is left behind. The `-X` matters: Task C0 gitignores the seeds, and plain `git clean -f` skips ignored files.

- [ ] **Step 9: Write the failing page tests**

In `spikes/core/spike-core/src/pages.rs`'s tests, replace
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
    use crate::store::testutil::temp_file;
    use std::fs::File;
```
with
```rust
    use crate::store::testutil::temp_file;
    use encoding_rs::{Encoding, UTF_16BE, UTF_16LE};
    use std::fs::File;
```

replace plan A's literal in `a_huge_line_is_one_bounded_piece_and_the_next_line_follows` (it gains the new field)
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
        assert_eq!(got[1], LinePiece { line: 1, offset: 100_001, text: "short".into(), more: false });
```
with
```rust
        let map = ByteMap::Uniform { start: 100_001, unit_bytes: 1, units: 5, pairs: vec![] };
        assert_eq!(got[1], LinePiece { line: 1, offset: 100_001, text: "short".into(), map, more: false });
```

in plan A's two Z37 tests, `piece` takes the index too (Step 10 gives it the index's encoding): replace
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
                let next = piece(&store, 0, MAX_PIECE as u64).unwrap();
```
with
```rust
                let next = piece(&store, &idx, 0, MAX_PIECE as u64).unwrap();
```

and replace
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
        assert_eq!(piece(&store, 0, 0).unwrap(), first); // a piece is exactly what `lines` returns at that offset
        let second = piece(&store, 0, first.offset + MAX_PIECE as u64).unwrap();
        let last = piece(&store, 0, second.offset + MAX_PIECE as u64).unwrap();
        assert_eq!((second.offset, second.text.len(), second.more), (MAX_PIECE as u64, MAX_PIECE, true));
        assert_eq!((last.offset, last.text.len(), last.more), (2 * MAX_PIECE as u64, 10, false)); // `\r` stripped
        let past = piece(&store, 0, u64::MAX).unwrap(); // an offset past the end reads nothing, and nothing follows
```
with
```rust
        assert_eq!(piece(&store, &idx, 0, 0).unwrap(), first); // a piece is exactly what `lines` returns at that offset
        let second = piece(&store, &idx, 0, first.offset + MAX_PIECE as u64).unwrap();
        let last = piece(&store, &idx, 0, second.offset + MAX_PIECE as u64).unwrap();
        assert_eq!((second.offset, second.text.len(), second.more), (MAX_PIECE as u64, MAX_PIECE, true));
        assert_eq!((last.offset, last.text.len(), last.more), (2 * MAX_PIECE as u64, 10, false)); // `\r` stripped
        let past = piece(&store, &idx, 0, u64::MAX).unwrap(); // an offset past the end reads nothing, and nothing follows
```

and add at the end of `mod tests` (before its closing `}`, after a blank line):
<!-- op: append-in-module spikes/core/spike-core/src/pages.rs -->
```rust
    fn open_encoded(name: &str, bytes: &[u8], encoding: &'static Encoding) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex { encoding, ..LineIndex::default() });
        build(&File::open(&path).unwrap(), store.len(), IndexConfig::default(), &store.hashes(), &shared, |_| {}).unwrap();
        (store, shared.into_inner().unwrap())
    }

    #[test]
    fn utf16_lines_decode_with_maps_past_the_bom_and_cr() {
        for (bom, encoding, be) in [(b"\xFF\xFE", UTF_16LE, false), (b"\xFE\xFF", UTF_16BE, true)] {
            let body = "Ċ first\r\nsecond 😀\nਊ".encode_utf16().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
            let bytes: Vec<u8> = bom.iter().copied().chain(body).collect();
            let (store, idx) = open_encoded("utf16-pages", &bytes, encoding);
            let got = lines(&store, &idx, 0, 10).unwrap();
            let summary: Vec<(&str, u64)> = got.iter().map(|p| (p.text.as_str(), p.offset)).collect();
            assert_eq!(summary, vec![("Ċ first", 0), ("second 😀", 20), ("ਊ", 40)], "{encoding:?}");
            assert_eq!(got[0].map, ByteMap::Uniform { start: 2, unit_bytes: 2, units: 7, pairs: vec![] });
            assert_eq!(got[1].map, ByteMap::Uniform { start: 20, unit_bytes: 2, units: 9, pairs: vec![7] });
            assert_eq!((got[1].map.start_byte(8), got[1].map.end_byte(8)), (34, 38)); // inside 😀
        }
    }

    #[test]
    fn utf8_lines_drop_the_bom_and_map_multibyte_chars() {
        let (store, idx) = open("utf8-bom", "\u{FEFF}é!\r\nok".as_bytes());
        let got = lines(&store, &idx, 0, 10).unwrap();
        assert_eq!((got[0].text.as_str(), got[0].offset), ("é!", 0));
        assert_eq!(got[0].map, ByteMap::Breakpoints { points: vec![(0, 3), (1, 5)], end: (2, 6) });
        assert_eq!(got[1].map, ByteMap::Uniform { start: 8, unit_bytes: 1, units: 2, pairs: vec![] });
    }
```

Run (`spikes/core`): `cargo test -p spike-core pages`
Expected: `due to 17 previous errors`: `E0433` cannot find type `ByteMap` (5), `E0560` no field named `map` on `LinePiece` (1), `E0609` no field `map` (6), and `E0061` this function takes 3 arguments but 4 arguments were supplied (5: `piece` gains its index in Step 10).

- [ ] **Step 10: Decode lines and pieces through `decode`**

In `pages.rs`, replace
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
use memchr::memchr;
use serde_json::Value;

use crate::index::{locate_line, LineIndex};
```
with
```rust
use serde_json::Value;

use crate::bytemap::ByteMap;
use crate::encoding::{decode, newline_and_cr, newline_ends};
use crate::index::{locate_line, LineIndex};
```

replace
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
    pub text: String,
    pub more: bool,
```
with
```rust
    pub text: String,
    /// Maps `text` back to file bytes (spec §3.2); a first line's BOM and every line's `\r` lie outside it.
    pub map: ByteMap,
    pub more: bool,
```

and in `lines`, replace
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
    let total = index.line_count();
    let (mut line, mut page_bytes) = (start, 0usize);
    while line < total && out.len() < count as usize {
        let bytes = store.read(offset, offset + MAX_PIECE as u64 + 1)?;
        match memchr(b'\n', &bytes) {
            Some(i) if i <= MAX_PIECE => {
                if !out.is_empty() && page_bytes + i > MAX_PAGE {
                    break;
                }
                let text = bytes[..i].strip_suffix(b"\r").unwrap_or(&bytes[..i]);
                out.push(LinePiece { line, offset, text: String::from_utf8_lossy(text).into_owned(), more: false });
                page_bytes += i;
                offset += i as u64 + 1;
            }
            _ => {
                let take = bytes.len().min(MAX_PIECE);
                if !out.is_empty() && page_bytes + take > MAX_PAGE {
                    break;
                }
                let ends_here = offset + bytes.len() as u64 >= store.len() && bytes.len() <= MAX_PIECE;
                out.push(LinePiece {
                    line,
                    offset,
                    text: String::from_utf8_lossy(&bytes[..take]).into_owned(),
                    more: !ends_here,
                });
```
with
```rust
    let total = index.line_count();
    let (nl, cr) = newline_and_cr(index.encoding);
    let piece = |line, offset, bytes: &[u8], more| {
        let slice = decode(bytes, index.encoding, offset);
        LinePiece { line, offset, text: slice.text, map: slice.map, more }
    };
    let (mut line, mut page_bytes) = (start, 0usize);
    while line < total && out.len() < count as usize {
        let bytes = store.read(offset, offset + (MAX_PIECE + nl.len()) as u64)?;
        match newline_ends(index.encoding, offset, &bytes).next() {
            Some(last) if last + 1 - nl.len() <= MAX_PIECE => {
                let i = last + 1 - nl.len();
                if !out.is_empty() && page_bytes + i > MAX_PAGE {
                    break;
                }
                out.push(piece(line, offset, bytes[..i].strip_suffix(cr).unwrap_or(&bytes[..i]), false));
                page_bytes += i;
                offset += last as u64 + 1;
            }
            _ => {
                let take = bytes.len().min(MAX_PIECE);
                if !out.is_empty() && page_bytes + take > MAX_PAGE {
                    break;
                }
                let ends_here = offset + bytes.len() as u64 >= store.len() && bytes.len() <= MAX_PIECE;
                out.push(piece(line, offset, &bytes[..take], !ends_here));
```
and replace plan A's `piece` (its Z37 continuation) with the same decoding:
<!-- op: replace spikes/core/spike-core/src/pages.rs -->
```rust
/// Spec §3.4's continuation (Z37): the bounded piece of `line` that starts at byte `offset`. A piece with `more`
/// continues at its `offset + MAX_PIECE`. It reads the file, not the index, so it works while indexing proceeds.
pub fn piece(store: &ByteStore, line: u64, offset: u64) -> Result<LinePiece, StoreError> {
    let bytes = store.read(offset, offset.saturating_add(MAX_PIECE as u64 + 1))?;
    let (text, more) = match memchr(b'\n', &bytes) {
        Some(i) => (bytes[..i].strip_suffix(b"\r").unwrap_or(&bytes[..i]), false),
        None => (&bytes[..bytes.len().min(MAX_PIECE)], bytes.len() > MAX_PIECE),
    };
    Ok(LinePiece { line, offset, text: String::from_utf8_lossy(text).into_owned(), more })
}
```
with
```rust
/// Spec §3.4's continuation (Z37): the bounded piece of `line` that starts at byte `offset`. A piece with `more`
/// continues at its `offset + MAX_PIECE`. It reads the file and the index's encoding, so it works while indexing proceeds.
pub fn piece(store: &ByteStore, index: &LineIndex, line: u64, offset: u64) -> Result<LinePiece, StoreError> {
    let (nl, cr) = newline_and_cr(index.encoding);
    let bytes = store.read(offset, offset.saturating_add((MAX_PIECE + nl.len()) as u64))?;
    let (text, more) = match newline_ends(index.encoding, offset, &bytes).next() {
        Some(last) => {
            let i = last + 1 - nl.len();
            (bytes[..i].strip_suffix(cr).unwrap_or(&bytes[..i]), false)
        }
        None => (&bytes[..bytes.len().min(MAX_PIECE)], bytes.len() > MAX_PIECE),
    };
    let slice = decode(text, index.encoding, offset);
    Ok(LinePiece { line, offset, text: slice.text, map: slice.map, more })
}
```
`spike-node`'s `Doc::lines` needs no change: it builds `JsLine` from `line`, `offset`, `text` and `more` and ignores `map`. Its `LineIndex::default()` is UTF-8, so the app behaves as before except that a UTF-8 BOM no longer shows as text on line 0. `Doc::piece` now passes the index; in `spikes/core/spike-node/src/lib.rs`, replace
<!-- op: replace spikes/core/spike-node/src/lib.rs -->
```rust
    /// its offset + 65,536. It reads the file, not the index, so it works while indexing proceeds.
    #[napi]
    pub fn piece(&self, line: i64, offset: i64) -> Result<JsLine> {
        let p = pages::piece(&self.store, line.max(0) as u64, offset.max(0) as u64).map_err(err)?;
```
with
```rust
    /// its offset + 65,536. It reads the file and the index's encoding, so it works while indexing proceeds.
    #[napi]
    pub fn piece(&self, line: i64, offset: i64) -> Result<JsLine> {
        let index = self.index.read().unwrap();
        let p = pages::piece(&self.store, &index, line.max(0) as u64, offset.max(0) as u64).map_err(err)?;
```
The addon is next built in Task C1d.

- [ ] **Step 11: Run all core tests**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `38 passed; 0 failed; 1 ignored`: plan A's 16, Task C0's 3 (its `handle_lifetime_costs` is the ignored one), 8 `bytemap`, 7 `encoding`, 2 more `index`, 2 more `pages`.

- [ ] **Step 12: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/Cargo.toml spikes/core/Cargo.lock spikes/core/spike-core/src/encoding.rs spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/index.rs spikes/core/spike-core/src/pages.rs spikes/core/spike-node/src/lib.rs
git commit -m "spike(c): BOM/NUL/UTF-8 sniffing, mapped decoding, UTF-16 newline units in the line index"
```

---

## Task C1c: The byte-map gate

**Files:**
- Modify: `spikes/core/spike-core/src/encoding.rs` (tests only)

**Interfaces:**
- **Consumes:** `encoding::decode`, `bytemap::naive_endpoints`, `proptest`.
- **Produces:** five proptests, each with 10,000 cases set in the test (`ProptestConfig::with_cases`, so `PROPTEST_CASES` can't lower it): `gate_utf8`, `gate_malformed_utf8`, `gate_windows_1252`, `gate_utf16le`, `gate_utf16be`.

**How the reference stays independent:** it never touches `encoding_rs` or `MapBuilder`. Text and per-char source lengths come from std's `utf8_chunks` (maximal subparts, the WHATWG rule) for UTF-8, a WHATWG UTF-16 decoder written from the spec's algorithm, and WHATWG's windows-1252 index for 1252. `naive_endpoints` turns them into expected endpoints by brute force. Every case compares the text, the replacement count, and `(start_byte, end_byte)` at every offset `0..=units`. Inputs cover multi-byte and astral characters, U+FEFF and a literal U+FFFD, CR/LF/NUL, file-start BOMs, starts up to 2^40, truncated sequences, overlongs, lone continuation bytes, UTF-8-encoded surrogates, bytes past U+10FFFF, lone UTF-16 surrogates, odd trailing bytes and the 0x0A-carrying units.

- [ ] **Step 1: Add the gate**

In `encoding.rs`'s tests, replace
<!-- op: replace spikes/core/spike-core/src/encoding.rs -->
```rust
    use super::*;
    use encoding_rs::WINDOWS_1252;
    use std::time::Instant;
```
with
```rust
    use super::*;
    use crate::bytemap::naive_endpoints;
    use encoding_rs::WINDOWS_1252;
    use proptest::prelude::*;
    use std::time::Instant;
```

and add at the end of `mod tests` in `encoding.rs` (before its closing `}`, after a blank line):
<!-- op: append-in-module spikes/core/spike-core/src/encoding.rs -->
```rust
    // The byte-map gate (spec §13.1, Spike C): zero selection-endpoint mismatches across UTF-8, malformed UTF-8,
    // Windows-1252 and UTF-16LE/BE. References decode independently of encoding_rs and of MapBuilder:
    // each yields (char, source bytes, is a replacement), and `naive_endpoints` applies the snapping definition.

    /// std's lossy UTF-8 (maximal subparts, the same rule as WHATWG), char by char.
    fn std_utf8(bytes: &[u8]) -> Vec<(char, u64, bool)> {
        let mut out = Vec::new();
        for chunk in bytes.utf8_chunks() {
            out.extend(chunk.valid().chars().map(|c| (c, c.len_utf8() as u64, false)));
            if !chunk.invalid().is_empty() {
                out.push(('\u{FFFD}', chunk.invalid().len() as u64, true));
            }
        }
        out
    }

    /// WHATWG's UTF-16 decoder, written from the spec's algorithm.
    fn whatwg_utf16(bytes: &[u8], be: bool) -> Vec<(char, u64, bool)> {
        let (mut out, mut lead, mut i) = (Vec::new(), None::<u16>, 0);
        while i + 1 < bytes.len() {
            let pair = [bytes[i], bytes[i + 1]];
            let unit = if be { u16::from_be_bytes(pair) } else { u16::from_le_bytes(pair) };
            i += 2;
            if let Some(l) = lead.take() {
                if (0xDC00..=0xDFFF).contains(&unit) {
                    let c = char::from_u32(0x10000 + ((u32::from(l) - 0xD800) << 10) + (u32::from(unit) - 0xDC00));
                    out.push((c.unwrap(), 4, false));
                    continue;
                }
                out.push(('\u{FFFD}', 2, true)); // the unpaired lead; `unit` is processed again below
            }
            match unit {
                0xD800..=0xDBFF => lead = Some(unit),
                0xDC00..=0xDFFF => out.push(('\u{FFFD}', 2, true)),
                _ => out.push((char::from_u32(u32::from(unit)).unwrap(), 2, false)),
            }
        }
        // End of input with a pending lead surrogate and/or lead byte: one error for all of it.
        let pending = 2 * u64::from(lead.is_some()) + (bytes.len() - i) as u64;
        if pending > 0 {
            out.push(('\u{FFFD}', pending, true));
        }
        out
    }

    /// Windows-1252 per WHATWG's index: Latin-1, except 0x80–0x9F.
    fn windows_1252(bytes: &[u8]) -> Vec<(char, u64, bool)> {
        const HIGH: [u16; 32] = [
            0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152, 0x8D, 0x17D, 0x8F,
            0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122, 0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178,
        ];
        let char_of = |b: u8| if (0x80..0xA0).contains(&b) { HIGH[usize::from(b) - 0x80] } else { u16::from(b) };
        bytes.iter().map(|&b| (char::from_u32(u32::from(char_of(b))).unwrap(), 1, false)).collect()
    }

    /// Decodes `bytes` at `start` and compares text, replacement count and every endpoint with the reference.
    fn gate(bytes: &[u8], encoding: &'static Encoding, start: u64, reference: impl Fn(&[u8]) -> Vec<(char, u64, bool)>) -> Result<(), TestCaseError> {
        let bom = match Encoding::for_bom(bytes) {
            Some((e, n)) if e == encoding && start == 0 => n, // spec §4.1: a file-start BOM isn't text
            _ => 0,
        };
        let want = reference(&bytes[bom..]);
        let got = decode(bytes, encoding, start);
        prop_assert_eq!(&got.text, &want.iter().map(|e| e.0).collect::<String>());
        prop_assert_eq!(got.replacements as usize, want.iter().filter(|e| e.2).count());
        let elements: Vec<(u32, u64)> = want.iter().map(|&(c, n, _)| (c.len_utf16() as u32, n)).collect();
        let ours: Vec<(u64, u64)> = (0..=got.map.units()).map(|u| (got.map.start_byte(u), got.map.end_byte(u))).collect();
        prop_assert_eq!(ours, naive_endpoints(start + bom as u64, &elements));
        Ok(())
    }

    fn any_char() -> impl Strategy<Value = char> {
        prop_oneof![
            4 => prop::char::range('\0', '\u{7F}'),
            2 => prop::char::range('\u{80}', '\u{7FF}'),
            2 => prop::char::range('\u{800}', '\u{FFFF}'),
            2 => prop::char::range('\u{10000}', '\u{10FFFF}'),
            1 => prop::sample::select(vec!['\r', '\n', '\0', '\u{FEFF}', '\u{FFFD}']),
        ]
    }

    /// Malformed UTF-8 pieces, mixed with valid chars.
    fn utf8_atom() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            6 => any_char().prop_map(|c| c.to_string().into_bytes()),
            2 => (prop::char::range('\u{80}', '\u{10FFFF}'), any::<prop::sample::Index>()).prop_map(|(c, cut)| {
                let b = c.to_string().into_bytes();
                b[..1 + cut.index(b.len() - 1)].to_vec() // a truncated sequence
            }),
            1 => prop::sample::select(vec![
                vec![0xC0, 0x80], vec![0xC1, 0xBF], vec![0xE0, 0x80, 0x80], vec![0xE0, 0x9F, 0xBF],
                vec![0xF0, 0x80, 0x80, 0x80], vec![0xF0, 0x8F, 0xBF, 0xBF], // overlongs
                vec![0xF4, 0x90, 0x80, 0x80], vec![0xF5, 0x80], vec![0xFF],  // past U+10FFFF, never-valid bytes
            ]),
            1 => (0x80u8..0xC0).prop_map(|b| vec![b]), // a lone continuation byte
            1 => (0xD800u32..0xE000).prop_map(|s| vec![0xE0 | (s >> 12) as u8, 0x80 | ((s >> 6) & 0x3F) as u8, 0x80 | (s & 0x3F) as u8]),
            1 => any::<u8>().prop_map(|b| vec![b]),
        ]
    }

    fn utf16_atom() -> impl Strategy<Value = Vec<u16>> {
        prop_oneof![
            6 => any_char().prop_map(|c| c.encode_utf16(&mut [0; 2]).to_vec()), // BMP or a surrogate pair
            1 => prop::sample::select(vec![0x010A, 0x0A0D, 0x0A00, 0x0D0A]).prop_map(|u| vec![u]), // 0x0A bytes that aren't newlines
            1 => (0xD800u16..0xDC00).prop_map(|u| vec![u]),                                         // a lone lead surrogate
            1 => (0xDC00u16..0xE000).prop_map(|u| vec![u]),                                         // a lone trail surrogate
        ]
    }

    fn start_and_bom() -> impl Strategy<Value = (u64, bool)> {
        prop_oneof![Just((0u64, true)), Just((0u64, false)), (1u64..1 << 40).prop_map(|s| (s, false))]
    }

    fn utf16_bytes(atoms: &[Vec<u16>], be: bool, bom: bool, odd: Option<u8>) -> Vec<u8> {
        let bom = if !bom { vec![] } else if be { vec![0xFE, 0xFF] } else { vec![0xFF, 0xFE] };
        let units = atoms.iter().flatten().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
        bom.into_iter().chain(units).chain(odd).collect()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        #[test]
        fn gate_utf8(chars in prop::collection::vec(any_char(), 0..64), (start, bom) in start_and_bom()) {
            let text: String = chars.into_iter().collect();
            let bytes = [if bom { "\u{FEFF}" } else { "" }.as_bytes(), text.as_bytes()].concat();
            gate(&bytes, UTF_8, start, std_utf8)?;
        }

        #[test]
        fn gate_malformed_utf8(atoms in prop::collection::vec(utf8_atom(), 0..48), (start, bom) in start_and_bom()) {
            let bytes = [if bom { b"\xEF\xBB\xBF".as_slice() } else { b"" }, &atoms.concat()].concat();
            gate(&bytes, UTF_8, start, std_utf8)?;
        }

        #[test]
        fn gate_windows_1252(bytes in prop::collection::vec(any::<u8>(), 0..256), start in any::<u64>().prop_map(|s| s >> 20)) {
            gate(&bytes, WINDOWS_1252, start, windows_1252)?;
        }

        #[test]
        fn gate_utf16le(atoms in prop::collection::vec(utf16_atom(), 0..48), (start, bom) in start_and_bom(), odd in prop::option::of(any::<u8>())) {
            gate(&utf16_bytes(&atoms, false, bom, odd), UTF_16LE, start, |b| whatwg_utf16(b, false))?;
        }

        #[test]
        fn gate_utf16be(atoms in prop::collection::vec(utf16_atom(), 0..48), (start, bom) in start_and_bom(), odd in prop::option::of(any::<u8>())) {
            gate(&utf16_bytes(&atoms, true, bom, odd), UTF_16BE, start, |b| whatwg_utf16(b, true))?;
        }
    }
```

- [ ] **Step 2: Run the gate**

Run (`spikes/core`): `cargo test -p spike-core encoding::tests::gate_`
Expected: `5 passed; 0 failed; 0 ignored; 0 measured; 39 filtered out` (about 5 s in a debug build). A failure here is a Spike C result: record the shrunk input, don't loosen the test.

- [ ] **Step 3: Falsify it**

Make the gate prove it can fail: add `return self.end_byte(u); // FALSIFY: no snap-back` as the first line of `ByteMap::start_byte`'s body in `bytemap.rs`. Replace
<!-- op: temporary spikes/core/spike-core/src/bytemap.rs -->
```rust
    pub fn start_byte(&self, u: u32) -> u64 {
        match self {
```
with
```rust
    pub fn start_byte(&self, u: u32) -> u64 {
        return self.end_byte(u); // FALSIFY: no snap-back
        match self {
```
Run (`spikes/core`): `cargo test -p spike-core -- encoding::tests::gate_ bytemap::tests::endpoints_match`
Expected: `1 passed; 5 failed; 0 ignored; 0 measured; 38 filtered out`. `gate_utf8`, `gate_malformed_utf8`, `gate_utf16le`, `gate_utf16be` and `endpoints_match_the_naive_definition` fail. `gate_utf8` shrinks to one astral char after a BOM: `left: [(3, 3), (7, 7), (7, 7)]`, `right: [(3, 3), (3, 7), (7, 7)]`. `gate_windows_1252` passes because 1252 has no multi-unit elements, so it can't see a snapping bug.
Don't run the whole suite while the edit is in: `writes_cross_language_vectors` would write the broken map's vectors.
Then revert, and delete the regression files the failing run wrote. Run (`spikes/core`):
```bash
git checkout -- spike-core/src/bytemap.rs
git clean -nX spike-core/proptest-regressions
```
Delete what `git clean -nX` lists with `git clean -fX spike-core/proptest-regressions` (`-X`: the seeds are gitignored since Task C0).

- [ ] **Step 4: Run all core tests**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `43 passed; 0 failed; 1 ignored`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/encoding.rs
git commit -m "spike(c): byte-map gate, 10,000 cases per encoding against independent decoders"
```

---

## Task C1d: Offsets beyond 4 GiB

**Files:**
- Create: `spikes/core/spike-core/src/big_offsets.rs` (test-only module)
- Modify: `spikes/core/spike-core/src/lib.rs` (`#[cfg(test)] mod big_offsets;`)
- Modify: `spikes/core/spike-core/Cargo.toml` (Windows dev-dependency features)
- Modify: `spikes/core/Cargo.toml` (optimise `memchr` and `xxhash-rust` in debug builds)
- Create: `spikes/core/spike-node/test/beyond-4gib.test.js`

**Interfaces:**
- **Consumes:** `store::ByteStore`, `index::{build, locate_line, IndexConfig, LineIndex}`, `pages::lines`, `doc::Document`, `encoding::decode`; napi `Doc.open/startIndex/lines` and `JsLine` from plan A Task 7; `windows-sys 0.61` (`DeviceIoControl`, `FSCTL_SET_SPARSE`, `GetCompressedFileSizeW`, `FILE_ATTRIBUTE_SPARSE_FILE`).
- **Produces:** two tests. Each builds a sparse file of 5,372,903,429 bytes in `spikes/.fixtures/` (gitignored) and deletes it on the way out, failures included. Text lines sit at 2^32 − 4095, across 2^32 (2^32 − 7 … 2^32 + 7), at 2^32 + 2^20 + 3 and at 5 GiB + 1, zeros elsewhere. The Rust test fails where it can't make a sparse file unless `TYPOSE_ALLOW_NO_SPARSE=1` (then it prints a skip), and is ignored off Windows; the node test skips (node:test reports it as skipped).
  - `big_offsets::offsets_beyond_4_gib_are_exact_in_every_layer` (Rust; creates the file with `FSCTL_SET_SPARSE`).
  - `test/beyond-4gib.test.js` (node:test; creates the file with `fsutil sparse setflag`).
  - Neither needs elevation. `fsutil file layout` does (`Error 5: Access is denied` unelevated); `fsutil sparse queryrange` doesn't.

This task adds no production code. It checks that every layer already carries u64 offsets, so a failure is a Spike C result. The red step is the missing Windows API features.

- [ ] **Step 1: Write the test**

In `spikes/core/spike-core/src/lib.rs`, replace
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub mod store;
```
with
```rust
pub mod store;

#[cfg(test)]
mod big_offsets;
```

`spikes/core/spike-core/src/big_offsets.rs`:
<!-- op: create spikes/core/spike-core/src/big_offsets.rs -->
```rust
//! Offsets beyond 4 GiB (spec §3.2, §13.1 Spike C): a sparse file over 5 GiB with text lines just below 2^32,
//! across it and above it, zeros elsewhere. Every layer must hand back the exact u64 offsets.
//! A gate that can't run must not read as passed: where it can't make a sparse file it fails, unless
//! `TYPOSE_ALLOW_NO_SPARSE=1` says to skip. Off Windows, where the spike has no sparse-file builder, it's ignored.

/// Each segment's text is wrapped in newlines, so it's a line of its own starting one byte after `at`.
const SEGMENTS: [(u64, &str); 4] = [
    ((1 << 32) - 4096, "\nbelow 4 GiB\n"),
    ((1 << 32) - 8, "\nstraddles 2^32\n"),
    ((1 << 32) + (1 << 20) + 2, "\nabove 4 GiB: é 😀\n"),
    (5 << 30, "\nlast line\n"),
];
const LEN: u64 = (5 << 30) + (4 << 20) + 5; // 5.004 GiB apparent

#[cfg(not(windows))]
#[test]
#[ignore = "the sparse fixture is built with FSCTL_SET_SPARSE, Windows only in the spike"]
fn offsets_beyond_4_gib_are_exact_in_every_layer() {}

#[cfg(windows)]
#[test]
fn offsets_beyond_4_gib_are_exact_in_every_layer() {
    use std::fs::File;
    use std::os::windows::fs::FileExt;
    use std::path::PathBuf;
    use std::sync::RwLock;
    use std::time::Instant;

    use crate::doc::Document;
    use crate::encoding::decode;
    use crate::index::{build, locate_line, IndexConfig, LineIndex};
    use crate::pages;
    use crate::store::ByteStore;

    /// Deletes the fixture on the way out, assertion failures included.
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.fixtures/beyond-4gib.bin"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let _cleanup = Cleanup(path.clone());
    let file = File::create(&path).unwrap();
    if let Err(why) = make_sparse(&file) {
        let allowed = std::env::var("TYPOSE_ALLOW_NO_SPARSE").is_ok_and(|v| v == "1");
        assert!(allowed, "can't make a sparse file ({why}); set TYPOSE_ALLOW_NO_SPARSE=1 to skip this gate");
        println!("skipped (TYPOSE_ALLOW_NO_SPARSE=1): {why}");
        return;
    }
    file.set_len(LEN).unwrap();
    for (at, text) in SEGMENTS {
        assert_eq!(file.seek_write(text.as_bytes(), at).unwrap(), text.len());
    }
    file.sync_all().unwrap(); // NTFS allocates cached writes on flush; before it, the size on disk reads 0
    drop(file);
    let on_disk = allocated(&path);
    println!("fixture: {LEN} bytes apparent, {on_disk} bytes allocated");
    assert!(on_disk > 0 && on_disk < 64 << 20, "not sparse: {on_disk} bytes allocated");

    // Lines: zeros, text, zeros, text, ... and a tail of zeros.
    let mut want: Vec<u64> = vec![0];
    for (at, text) in SEGMENTS {
        want.extend([at + 1, at + text.len() as u64]);
    }
    let text_line = |i: usize| (2 * i as u64 + 1, SEGMENTS[i].0 + 1, SEGMENTS[i].1.trim_matches('\n'));

    // Byte store: positional reads at, across and past 2^32.
    let store = ByteStore::open(&path).unwrap();
    assert_eq!(store.len(), LEN);
    for i in 0..4 {
        let (_, at, text) = text_line(i);
        assert_eq!(store.read(at, at + text.len() as u64).unwrap(), text.as_bytes());
    }

    // Line index over the whole file: one giant line of zeros per gap, so only byte-bounded checkpoints help.
    let shared = RwLock::new(LineIndex::default());
    let t = Instant::now();
    build(&File::open(&path).unwrap(), LEN, IndexConfig::default(), &store.hashes(), &shared, |_| {}).unwrap();
    let ms = t.elapsed().as_millis().max(1);
    let idx = shared.into_inner().unwrap();
    println!("index: {LEN} bytes in {ms} ms ({:.2} GB/s), {} checkpoints", LEN as f64 / 1e6 / ms as f64, idx.checkpoints.len());
    assert_eq!(idx.line_count(), want.len() as u64);
    assert!(idx.checkpoints.windows(2).all(|p| p[1].offset - p[0].offset <= 1 << 20));
    let starts: Vec<u64> = (0..idx.line_count()).map(|l| locate_line(&store, &idx, l).unwrap().unwrap()).collect();
    assert_eq!(starts, want);

    // Pages: the text lines carry exact offsets and maps. Each zero run is a 64 KiB piece, so the
    // 256 KiB page cap splits the file across pages: read on from wherever the last page stopped.
    let mut page = Vec::new();
    while (page.len() as u64) < idx.line_count() {
        let more = pages::lines(&store, &idx, page.len() as u64, 16).unwrap();
        assert!(!more.is_empty(), "no progress at line {}", page.len());
        page.extend(more);
    }
    assert_eq!(page.iter().map(|p| p.offset).collect::<Vec<_>>(), want);
    for i in 0..4 {
        let (line, at, text) = text_line(i);
        let piece = &page[line as usize];
        assert_eq!((piece.offset, piece.text.as_str()), (at, text));
        assert_eq!(piece.map, decode(text.as_bytes(), encoding_rs::UTF_8, at).map);
        assert_eq!((piece.map.start_byte(0), piece.map.end_byte(piece.map.units())), (at, at + text.len() as u64));
    }
    assert_eq!(page[3].map.start_byte(7), 1 << 32); // "straddles 2^32": unit 7 is byte 2^32
    let above = &page[5].map; // "above 4 GiB: é 😀": unit 16 is inside 😀
    assert_eq!((above.start_byte(16), above.end_byte(16)), (SEGMENTS[2].0 + 17, SEGMENTS[2].0 + 21));

    // Document: the verified read path copy uses.
    let doc = Document::open(&path).unwrap();
    for i in 0..4 {
        let (_, at, text) = text_line(i);
        assert_eq!(doc.read(1, at, at + text.len() as u64).unwrap(), text.as_bytes());
    }
}

/// Marks a new, empty file sparse, so `set_len` and far writes allocate almost nothing. Needs no elevation.
#[cfg(windows)]
fn make_sparse(file: &std::fs::File) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_SPARSE_FILE;
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;

    let mut returned = 0u32;
    let null = std::ptr::null_mut();
    let ok = unsafe { DeviceIoControl(file.as_raw_handle() as _, FSCTL_SET_SPARSE, null, 0, null, 0, &mut returned, null as _) };
    if ok == 0 {
        return Err(format!("FSCTL_SET_SPARSE failed: {}", std::io::Error::last_os_error()));
    }
    let attributes = file.metadata().map_err(|e| e.to_string())?.file_attributes();
    if attributes & FILE_ATTRIBUTE_SPARSE_FILE == 0 {
        return Err("the volume doesn't keep the sparse attribute".into());
    }
    Ok(())
}

/// Bytes actually allocated on disk (Explorer's "Size on disk").
#[cfg(windows)]
fn allocated(path: &std::path::Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetCompressedFileSizeW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut high = 0u32;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    (u64::from(high) << 32) | u64::from(low)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run (`spikes/core`): `cargo test -p spike-core big_offsets`
Expected: `due to 2 previous errors`, both ``error[E0433]: cannot find `System` in `Win32` `` (the `Win32_System_IO` and `Win32_System_Ioctl` features aren't enabled).

- [ ] **Step 3: Add the Windows API features (tests only)**

In `spikes/core/spike-core/Cargo.toml`, replace
<!-- op: replace spikes/core/spike-core/Cargo.toml -->
```toml
[dev-dependencies]
proptest = "1.12"
```
with
```toml
[dev-dependencies]
proptest = "1.12"

[target.'cfg(windows)'.dev-dependencies]
windows-sys = { version = "0.61", features = ["Win32_System_IO", "Win32_System_Ioctl"] }
```

Run (`spikes/core`): `cargo test -p spike-core big_offsets -- --nocapture`
Expected: `1 passed`, but slowly: the debug build indexes 5 GiB at about 0.16 GB/s (the scratch run printed `index: 5372903429 bytes in 32815 ms (0.16 GB/s), 5125 checkpoints`), because `memchr` and `xxhash-rust` aren't optimised.

- [ ] **Step 4: Optimise the two hot dependencies in debug builds**

In `spikes/core/Cargo.toml`, replace
<!-- op: replace spikes/core/Cargo.toml -->
```toml
[profile.release]
lto = "thin"
codegen-units = 1
```
with
```toml
[profile.release]
lto = "thin"
codegen-units = 1

[profile.dev.package.memchr]
opt-level = 3

[profile.dev.package.xxhash-rust]
opt-level = 3
```

Run (`spikes/core`): `cargo test -p spike-core big_offsets -- --nocapture`
Expected: `1 passed` in a few seconds, printing two lines. The `fixture` line is exact; the `index` line is the scratch run's:
```text
fixture: 5372903429 bytes apparent, 262144 bytes allocated
index: 5372903429 bytes in 1155 ms (4.65 GB/s), 5125 checkpoints
```
Record both lines. 262,144 bytes is four 64 KiB NTFS sparse allocation units: two around 2^32 (the first two writes, the second spanning both units), one at 2^32 + 1 MiB and one at 5 GiB. `spikes/.fixtures/` is empty afterwards.

- [ ] **Step 5: Check the napi boundary**

`spikes/core/spike-node/test/beyond-4gib.test.js`:
<!-- op: create spikes/core/spike-node/test/beyond-4gib.test.js -->
```js
// Offsets beyond 4 GiB reach JavaScript exactly (spec §3.2, §13.1 Spike C). Needs the built addon (npm run build).
// The fixture is a sparse file made with `fsutil sparse setflag`, which needs no elevation.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Doc } = require('..')

const LEN = 5 * 2 ** 30 + 4 * 2 ** 20 + 5
const SEGMENTS = [
  [2 ** 32 - 4096, '\nbelow 4 GiB\n'],
  [2 ** 32 - 8, '\nstraddles 2^32\n'],
  [2 ** 32 + 2 ** 20 + 2, '\nabove 4 GiB: é 😀\n'],
  [5 * 2 ** 30, '\nlast line\n']
]

test('JsLine.offset beyond 4 GiB is exact in JavaScript', async (t) => {
  if (process.platform !== 'win32') return t.skip('the sparse fixture uses fsutil, Windows only in the spike')
  const file = path.join(__dirname, '..', '..', '..', '.fixtures', 'beyond-4gib-node.bin')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  try {
    try {
      execFileSync('fsutil', ['sparse', 'setflag', file])
    } catch (e) {
      return t.skip(`fsutil sparse setflag failed: ${e.message}`)
    }
    fs.truncateSync(file, LEN)
    const fd = fs.openSync(file, 'r+')
    for (const [at, text] of SEGMENTS) fs.writeSync(fd, Buffer.from(text), 0, Buffer.byteLength(text), at)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    t.diagnostic(execFileSync('fsutil', ['sparse', 'queryrange', file]).toString().trim().replace(/\r?\n/g, ' | '))

    const doc = Doc.open(file)
    assert.equal(doc.size, LEN)
    const started = performance.now()
    const done = await new Promise((resolve) => doc.startIndex((p) => (p.done || p.error) && resolve(p)))
    t.diagnostic(`indexed ${LEN} bytes in ${Math.round(performance.now() - started)} ms (core: ${done.elapsedMs} ms)`)
    assert.ok(!done.error, done.error)
    assert.equal(done.lines, 9)

    SEGMENTS.forEach(([at, text], i) => {
      const [line] = doc.lines(2 * i + 1, 1)
      assert.equal(line.offset, at + 1)
      assert.ok(Number.isSafeInteger(line.offset))
      assert.equal(line.text, text.slice(1, -1))
    })
    assert.equal(doc.lines(5, 1)[0].offset, 4296015875) // 2^32 + 2^20 + 3, as a literal
  } finally {
    fs.rmSync(file, { force: true })
  }
})
```

Run (`spikes/core/spike-node`): `npm ci --prefer-offline`, then `npm run build`, then `node --test test/beyond-4gib.test.js`
Expected: `ℹ pass 1`, `ℹ fail 0`. The diagnostics show the allocated ranges and the release index time, e.g. `Allocated range[1]: Offset: 0xffff0000  Length: 0x20000 | Allocated range[2]: Offset: 0x100100000  Length: 0x10000 | Allocated range[3]: Offset: 0x140000000  Length: 0x10000` and `indexed 5372903429 bytes in 1154 ms`. Record them. This test passes on its first run: offsets were already `i64` across napi, and the test proves they arrive exactly.

- [ ] **Step 6: Run everything**

Run (`spikes/core`): `cargo test -p spike-core`, then `cargo test -p fixtures-gen`.
Expected: `44 passed; 0 failed; 1 ignored`, then `2 passed`.
Run (`spikes/app`): `npx vitest run`
Expected: `Tests  14 passed (14)`.

- [ ] **Step 7: Read your own work (rule 8), then commit**

```bash
git add spikes/core/Cargo.toml spikes/core/spike-core/Cargo.toml spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/big_offsets.rs spikes/core/spike-node/test/beyond-4gib.test.js
git commit -m "spike(c): exact offsets beyond 4 GiB through store, index, pages, Document and napi"
```

---

## Task C2a: JSON/JSONC scanner: container index, element checkpoints, lazy children

**Files:**
- Create: `spikes/core/spike-core/src/json.rs`
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod json;`)
- Modify: `spikes/core/spike-core/src/store.rs` (the test helper `testutil::Temp`)

**Interfaces:**
- **Consumes:** `store::{ByteStore, StoreError, CHUNK}` (plan A Task 4) and `pages::{MAX_PAGE, MAX_PIECE}` (plan A Task 6). No new dependencies: `memchr` and `xxhash-rust` are already there.
- **Produces** (all in `spike_core::json`):
  - `pub struct Span { pub start: u64, pub end: u64 }`: end-exclusive file offsets. Derives `Clone, Copy, Debug, Default, PartialEq, Eq`.
  - `pub enum Kind { Object, Array, String, Number, True, False, Null }`. `NaN`, `Infinity` and `-Infinity` are `Number`.
  - `pub const NO_PARENT: u32 = u32::MAX;`
  - `pub struct Container { pub start: u64, pub end: u64, pub children: u64, pub parent: u32, pub kind: Kind }`:
    - 32 bytes;
    - `end` is one past the closing bracket, or 0 while unclosed (the scan stopped inside it);
    - `parent` is `NO_PARENT` for the root.
  - `pub struct ElementCheckpoint { pub container: u32, pub child: u64, pub offset: u64 }`. `offset` is where child `child` starts: its key, for objects.
  - `pub struct Trivia { pub comments: u64, pub trailing_commas: u64, pub nonfinite: u64 }`. All zero means "Parsed as JSON"; anything else means "Parsed as JSONC" (brief §7.6).
  - `pub enum ErrorKind { Syntax(&'static str), TooDeep, TooManyContainers, Cancelled }`
  - `pub struct ScanError { pub kind: ErrorKind, pub offset: u64, pub line: u64, pub column: u64 }`:
    - `line` and `column` are 1-based within the scanned range;
    - `column` counts code points;
    - both are 0 for `Cancelled`.
  - `pub struct ScanOptions { pub jsonc: bool, pub max_depth: usize, pub max_containers: usize, pub cp_children: u64, pub cp_bytes: u64, pub window: usize }`. `Default`: `jsonc: true`, `max_depth: 10_000`, `max_containers: u32::MAX as usize`, `cp_children: 1024`, `cp_bytes: 1 << 20`, `window: 64 << 10`.
  - `pub struct Paged<T>`: a vector kept in 65,536-element pages. It has:
    - `len(&self) -> usize`;
    - `get(&self, i: usize) -> Option<&T>`;
    - `iter(&self) -> impl Iterator<Item = &T>`;
    - `partition_point(&self, pred: impl Fn(&T) -> bool) -> usize`;
    - `Index<usize>` and `IndexMut<usize>`.
  - `pub struct JsonIndex { pub range: Span, pub root: Option<(Kind, Span)>, pub containers: Paged<Container>, pub checkpoints: Vec<ElementCheckpoint>, pub long_scalars: Vec<Span>, pub trivia: Trivia, pub error: Option<ScanError>, pub window: usize }`, with `heap_bytes(&self) -> usize`:
    - `containers` is in document order, and a container root is `containers[0]`;
    - `checkpoints` is sorted by container, then child;
    - `long_scalars` holds every string, key and number of at least `MAX_PIECE` bytes, by start.
  - `pub struct Child { pub key: Option<Span>, pub value: Span, pub kind: Kind, pub container: Option<u32>, pub text: Vec<u8> }`:
    - `key` is the key token, quotes included;
    - `container` is the child's id, for objects and arrays;
    - `text` holds a scalar's verbatim bytes, at most `MAX_PIECE` of them.
  - `pub fn scan(store: &ByteStore, range: Range<u64>, opts: &ScanOptions, cancel: &AtomicBool) -> Result<JsonIndex, StoreError>`:
    - `range` is the whole file, or one JSONL record's span (spec §4.4);
    - a UTF-8 BOM is skipped only at file offset 0: a JSONL record that starts with one is a syntax error, as Task C1b's `decode` keeps a mid-file U+FEFF as text;
    - a `StoreError` (changed on disk, I/O) is returned as `Err`;
    - every other failure lands in `index.error`, and everything before it stays usable.
  - `pub fn children(store: &ByteStore, index: &JsonIndex, container: u32, first: u64, count: usize) -> Result<Vec<Child>, StoreError>`: up to `count` children from child `first` on, holding at most `MAX_PAGE` bytes of scalar text (containers carry none), checked before each push (spec §3.4). The next page starts at the child after the last one returned.
  - `pub fn duplicate_keys(store: &ByteStore, index: &JsonIndex, container: u32, cancel: &AtomicBool) -> Result<Option<Vec<u64>>, StoreError>`. It returns the ordinals of members whose unescaped key repeats an earlier one, or `None` if cancelled.
- **Produces (test only, in plan A's `store::testutil`):** `pub struct Temp(pub PathBuf)`, a temp file deleted on drop (it derefs to `Path`), so a failing assertion can't leave a 100–200 MB file behind. Tasks C2a and C3a use it for their big files.

**Design notes:**
- **Spans only.** The index holds containers, checkpoints and long-scalar spans. A scalar's span and text come from re-tokenizing at most a bounded window during enumeration, so display text is always a slice of the source.
- **One push scanner, no recursion.** The lexer state survives between `feed` calls, so any token can straddle any chunk or window. Depth only grows an explicit stack.
- **Element checkpoints:** one every 1,024 children or 1 MiB, whichever comes first. `children` starts at the nearest one, reads less than 1 MiB to reach `first`, and jumps over nested containers (through the index) and long scalars (through `long_scalars`).
- **Trivia** (comments, trailing commas, `NaN`/`Infinity`) are counted, not stored. The Tree doesn't display JSONC trivia (brief §5.5), and Raw shows the source.
- **Duplicate keys** are detected per object when it's first expanded (`duplicate_keys`), not in the index pass. A whole-file count for ⓘ is a background pass. The numbers behind this are in Task C2c Step 7.
- **Hostile input:** depth stops at `max_depth` (`TooDeep`), and the container count stops at `max_containers` (`TooManyContainers`). The caller sizes `max_containers` from the §3.6 budget at **32 bytes per container**. Container storage is paged (65,536 records per page), so growth adds at most one 2 MiB page and no push ever stalls cancellation. A plain `Vec` copied 537 MB in one push at 2^24 containers and held cancellation off for 88 ms.
- **Not validated by the scan:** raw control characters and UTF-8 inside strings. They don't affect structure or spans; the display layer flags them as problems (spec §4.1). Escapes *are* validated.

**Two things not to "fix":**
- The json unit tests spell a JSON backslash `~` (`esc()`), and the gate builds backslash-u escapes at run time (`u()`). Some editors and agent tools decode a literal backslash-u-hex sequence while saving, which would silently change the test inputs.
- The json unit tests write temporary files of up to 200 MB into `%TEMP%`, about 0.7 GB at once when they run in parallel, and delete them on any exit (`Temp`).

- [ ] **Step 1: Write the failing tests**

Give plan A's test helpers a temp file that deletes itself on drop, so a failing assertion can't leave a 100–200 MB file in `%TEMP%`. In `src/store.rs`, replace the `testutil` module
<!-- op: replace spikes/core/spike-core/src/store.rs -->
```rust
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// Writes `bytes` to a unique temp file and returns its path.
    pub fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("spike-core-{}-{}", std::process::id(), name));
        std::fs::write(&path, bytes).unwrap();
        path
    }
}
```
with
```rust
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};

    /// Writes `bytes` to a unique temp file and returns its path.
    pub fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("spike-core-{}-{}", std::process::id(), name));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// A temp file deleted on drop, so a failing assert can't leave 100–200 MB behind.
    pub struct Temp(pub PathBuf);

    impl std::ops::Deref for Temp {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}
```

Add `pub mod json;` to `src/lib.rs`, below `pub mod index;`:
<!-- op: insert-adjacent-after spikes/core/spike-core/src/lib.rs :: pub mod index; -->
```rust
pub mod json;
```
`spikes/core/spike-core/src/json.rs` (types and tests; the implementation is Step 3):
<!-- op: create spikes/core/spike-core/src/json.rs -->
```rust
//! JSON/JSONC structural scanner (spec §4.3, §3.5). It records spans only, so every displayed value is a slice
//! of the source and the Tree is lossless by construction. One streaming pass over `ByteStore` chunks builds the
//! container index; children are enumerated lazily from the nearest element checkpoint.
use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};

use memchr::{memchr, memchr2, memchr_iter, memrchr};
use xxhash_rust::xxh3::{xxh3_128, Xxh3};

use crate::pages::{MAX_PAGE, MAX_PIECE};
use crate::store::{ByteStore, StoreError, CHUNK};

/// `[start, end)` in original file bytes (spec §3.2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Object,
    Array,
    String,
    Number,
    True,
    False,
    Null,
}

pub const NO_PARENT: u32 = u32::MAX;

/// One object or array: 32 bytes, so the index costs 32 bytes per container (spec §3.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Container {
    pub start: u64,
    /// One past the closing bracket; 0 while unclosed (the scan stopped inside it).
    pub end: u64,
    pub children: u64,
    pub parent: u32,
    pub kind: Kind,
}

/// Where child `child` of `container` starts (its key, for objects).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElementCheckpoint {
    pub container: u32,
    pub child: u64,
    pub offset: u64,
}

/// JSONC features, counted rather than stored. All zero means the document is strict JSON.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Trivia {
    pub comments: u64,
    pub trailing_commas: u64,
    /// `NaN`, `Infinity` and `-Infinity` (brief §5.5 lists them with JSONC).
    pub nonfinite: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Syntax(&'static str),
    /// Nesting deeper than `ScanOptions::max_depth`.
    TooDeep,
    /// More containers than `ScanOptions::max_containers`, the memory budget's share (spec §3.6).
    TooManyContainers,
    Cancelled,
}

/// Where the scan stopped. `line` and `column` are 1-based within the scanned range, and `column` counts
/// characters. Both are 0 for `Cancelled`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanError {
    pub kind: ErrorKind,
    pub offset: u64,
    pub line: u64,
    pub column: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ScanOptions {
    /// Accept `//` and `/* */` comments, trailing commas and `NaN`/`Infinity` (`.json` falls back to JSONC, spec §4.1).
    pub jsonc: bool,
    /// Deeper nesting stops the scan with `TooDeep`. At 10,000 the index and stack hold about 560 KB.
    pub max_depth: usize,
    /// More containers stop the scan with `TooManyContainers`. Size it from the memory budget (spec §3.6) at
    /// 32 bytes per container: the records are paged, so growth adds at most one 2 MiB page.
    pub max_containers: usize,
    /// An element checkpoint every `cp_children` children or `cp_bytes` bytes, whichever comes first (spec §3.5).
    pub cp_children: u64,
    pub cp_bytes: u64,
    /// Bytes per step. Cancellation is checked before every step, and enumeration reads this much at a time.
    pub window: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions {
            jsonc: true,
            max_depth: 10_000,
            max_containers: NO_PARENT as usize,
            cp_children: 1024,
            cp_bytes: 1 << 20,
            window: 64 << 10,
        }
    }
}

/// A vector kept in pages of 65,536 elements, so growing it never moves more than one page. A plain `Vec`
/// doubling past 2^24 containers copied 537 MB in one push and held off cancellation for up to 88 ms.
#[derive(Debug)]
pub struct Paged<T> {
    pages: Vec<Vec<T>>,
    len: usize,
}

const PAGE: usize = 1 << 16;

impl<T> Paged<T> {
    fn new() -> Self {
        Paged { pages: Vec::new(), len: 0 }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn get(&self, i: usize) -> Option<&T> {
        self.pages.get(i / PAGE)?.get(i % PAGE)
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.pages.iter().flatten()
    }

    /// The first index where `pred` turns false; `pred` must hold for a prefix of the elements.
    pub fn partition_point(&self, pred: impl Fn(&T) -> bool) -> usize {
        let p = self.pages.partition_point(|page| page.last().is_some_and(&pred));
        self.pages.get(p).map_or(self.len, |page| p * PAGE + page.partition_point(&pred))
    }

    fn push(&mut self, v: T) {
        match self.pages.last_mut() {
            Some(page) if page.len() < PAGE => page.push(v),
            _ => self.pages.push(vec![v]),
        }
        self.len += 1;
    }

    fn heap_bytes(&self) -> usize {
        self.pages.iter().map(Vec::capacity).sum::<usize>() * size_of::<T>() + self.pages.capacity() * size_of::<Vec<T>>()
    }
}

impl<T> std::ops::Index<usize> for Paged<T> {
    type Output = T;
    fn index(&self, i: usize) -> &T {
        &self.pages[i / PAGE][i % PAGE]
    }
}

impl<T> std::ops::IndexMut<usize> for Paged<T> {
    fn index_mut(&mut self, i: usize) -> &mut T {
        &mut self.pages[i / PAGE][i % PAGE]
    }
}

#[derive(Debug)]
pub struct JsonIndex {
    pub range: Span,
    /// The top-level value. A container root is `containers[0]`.
    pub root: Option<(Kind, Span)>,
    /// Every object and array in document order, so `start` ascends.
    pub containers: Paged<Container>,
    /// Sorted by container, then child.
    pub checkpoints: Vec<ElementCheckpoint>,
    /// Strings (keys included) and numbers of at least `MAX_PIECE` bytes, by start. Enumeration jumps over them.
    pub long_scalars: Vec<Span>,
    pub trivia: Trivia,
    pub error: Option<ScanError>,
    pub window: usize,
}

/// One child of a container, as enumeration returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Child {
    /// The key token, quotes included (objects only).
    pub key: Option<Span>,
    pub value: Span,
    pub kind: Kind,
    /// The container's id, for objects and arrays.
    pub container: Option<u32>,
    /// Scalars only: the verbatim source bytes, at most `MAX_PIECE` of them.
    pub text: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::{temp_file, Temp};
    use std::io::Write;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn index_with(name: &str, bytes: &[u8], opts: ScanOptions) -> (ByteStore, JsonIndex) {
        let store = ByteStore::open(&temp_file(name, bytes)).unwrap();
        let idx = scan(&store, 0..store.len(), &opts, &AtomicBool::new(false)).unwrap();
        (store, idx)
    }

    fn index(name: &str, bytes: &[u8]) -> (ByteStore, JsonIndex) {
        index_with(name, bytes, ScanOptions::default())
    }

    /// Sources here spell a JSON backslash `~`, so no backslash-u escape has to survive copy and paste.
    fn esc(s: &str) -> Vec<u8> {
        s.replace('~', "\\").into_bytes()
    }

    fn texts(store: &ByteStore, idx: &JsonIndex, id: u32) -> Vec<String> {
        let all = children(store, idx, id, 0, usize::MAX).unwrap();
        all.into_iter().map(|c| String::from_utf8(c.text).unwrap()).collect()
    }

    /// `head`, then `unit` × `times`, then `tail`, streamed to a temp file (the hostile inputs are 100–200 MB).
    fn repeated(name: &str, head: &[u8], unit: &[u8], times: u64, tail: &[u8]) -> Temp {
        let path = std::env::temp_dir().join(format!("spike-core-{}-{}", std::process::id(), name));
        let mut w = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(&path).unwrap());
        w.write_all(head).unwrap();
        let per = ((1 << 20) / unit.len()).max(1) as u64;
        let block = unit.repeat(per as usize);
        let mut left = times;
        while left > 0 {
            let n = left.min(per);
            w.write_all(&block[..n as usize * unit.len()]).unwrap();
            left -= n;
        }
        w.write_all(tail).unwrap();
        w.flush().unwrap();
        Temp(path)
    }

    fn scan_timed(path: &Path, opts: ScanOptions) -> (ByteStore, JsonIndex, Duration) {
        let store = ByteStore::open(path).unwrap();
        let started = Instant::now();
        let idx = scan(&store, 0..store.len(), &opts, &AtomicBool::new(false)).unwrap();
        (store, idx, started.elapsed())
    }

    fn stop(idx: &JsonIndex) -> Option<(ErrorKind, u64)> {
        idx.error.map(|e| (e.kind, e.offset))
    }

    #[test]
    fn container_index_records_spans_counts_and_parents() {
        let (store, idx) = index("containers", br#"{"a": [1, {"b": null}], "c": {}}"#);
        assert_eq!(size_of::<Container>(), 32);
        assert_eq!(idx.error, None);
        assert_eq!(idx.root, Some((Kind::Object, Span { start: 0, end: 32 })));
        assert_eq!(
            idx.containers.iter().copied().collect::<Vec<_>>(),
            vec![
                Container { start: 0, end: 32, children: 2, parent: NO_PARENT, kind: Kind::Object },
                Container { start: 6, end: 22, children: 2, parent: 0, kind: Kind::Array },
                Container { start: 10, end: 21, children: 1, parent: 1, kind: Kind::Object },
                Container { start: 29, end: 31, children: 0, parent: 0, kind: Kind::Object },
            ]
        );
        let kids = children(&store, &idx, 0, 0, 10).unwrap();
        let a = Child { key: Some(Span { start: 1, end: 4 }), value: Span { start: 6, end: 22 }, kind: Kind::Array, container: Some(1), text: vec![] };
        let c = Child { key: Some(Span { start: 24, end: 27 }), value: Span { start: 29, end: 31 }, kind: Kind::Object, container: Some(3), text: vec![] };
        assert_eq!(kids, vec![a, c]);
        assert_eq!(texts(&store, &idx, 1), ["1", ""]);
    }

    #[test]
    fn numbers_and_scalars_stay_verbatim() {
        let (store, idx) = index("verbatim", &esc(r#"[12345678901234567890, 3.10, -0, 1e400, true, false, null, "~u00e9"]"#));
        let e9 = String::from_utf8(esc(r#""~u00e9""#)).unwrap();
        assert_eq!(texts(&store, &idx, 0), ["12345678901234567890", "3.10", "-0", "1e400", "true", "false", "null", &e9]);
        let kinds: Vec<Kind> = children(&store, &idx, 0, 0, 10).unwrap().iter().map(|c| c.kind).collect();
        let n = Kind::Number;
        assert_eq!(kinds, [n, n, n, n, Kind::True, Kind::False, Kind::Null, Kind::String]);
        for src in ["12345", "-0", "3.10", "1e400"] {
            let (_, idx) = index("root-number", src.as_bytes()); // a bare root number ends at the end of input
            assert_eq!(idx.root, Some((Kind::Number, Span { start: 0, end: src.len() as u64 })));
        }
    }

    #[test]
    fn duplicate_keys_are_kept_and_flagged_after_unescaping() {
        let (store, idx) = index("dups", &esc(r#"{"a":1,"b":2,"a":3,"~u0061":4,"~ud83d~ude00":5,"😀":6}"#));
        assert_eq!(children(&store, &idx, 0, 0, 10).unwrap().len(), 6);
        assert_eq!(duplicate_keys(&store, &idx, 0, &AtomicBool::new(false)).unwrap(), Some(vec![2, 3, 5]));
        assert_eq!(duplicate_keys(&store, &idx, 0, &AtomicBool::new(true)).unwrap(), None);
    }

    #[test]
    fn jsonc_trivia_is_counted_and_strict_json_rejects_it() {
        let src = b"// head\n{\"a\": [1, 2,], /* mid */ \"b\": NaN, \"c\": -Infinity,}\n";
        let (store, idx) = index("jsonc", src);
        assert_eq!(idx.error, None);
        assert_eq!(idx.trivia, Trivia { comments: 2, trailing_commas: 2, nonfinite: 2 });
        assert_eq!(texts(&store, &idx, 0), ["", "NaN", "-Infinity"]);
        assert_eq!(texts(&store, &idx, 1), ["1", "2"]);
        let (store, idx) = index("cr-comment", b"{\"a\":1, // c\r\"b\":2}"); // a `//` comment ends at a lone CR too
        assert_eq!((idx.error, texts(&store, &idx, 0)), (None, vec!["1".to_string(), "2".to_string()]));
        let strict = ScanOptions { jsonc: false, ..ScanOptions::default() };
        let (_, idx) = index_with("strict-comment", src, strict);
        assert_eq!(idx.error, Some(ScanError { kind: ErrorKind::Syntax("expected a value"), offset: 0, line: 1, column: 1 }));
        let (_, idx) = index_with("strict-comma", b"[1,]", strict);
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("expected a value"), 3)));
        let (_, idx) = index_with("strict-nan", b"[NaN]", strict);
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("expected a value or ]"), 1)));
    }

    #[test]
    fn invalid_input_reports_line_and_column_and_keeps_what_parsed() {
        let src = "{\"a\": [1, 2],\n \"x\": {\"y\": 3},\n \"é\": tru }".as_bytes();
        let (store, idx) = index("invalid", src);
        let at = src.len() as u64 - 2;
        assert_eq!(idx.error, Some(ScanError { kind: ErrorKind::Syntax("invalid literal"), offset: at, line: 3, column: 10 }));
        assert_eq!(idx.containers[0].children, 2); // "é" never got its value
        assert_eq!(texts(&store, &idx, 1), ["1", "2"]);
        assert_eq!(texts(&store, &idx, 2), ["3"]);

        let (_, idx) = index("bad-escape", br#"["a\x", 1]"#);
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("invalid escape"), 4)));

        let (store, idx) = index("unterminated-string", b"[1, \"abc");
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("unterminated string"), 4)));
        assert_eq!(texts(&store, &idx, 0), ["1"]);

        let (store, idx) = index("unterminated-comment", b"[1, 2 /* never closed");
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("unterminated comment"), 6)));
        assert_eq!(texts(&store, &idx, 0), ["1", "2"]);

        let (store, idx) = index("unclosed", b"{\"a\": [1, 2");
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("unexpected end of input"), 11)));
        assert_eq!(idx.containers[1].end, 0);
        let kids = children(&store, &idx, 0, 0, 10).unwrap();
        assert_eq!((kids[0].value, kids[0].container), (Span { start: 6, end: 11 }, Some(1)));
        assert_eq!(texts(&store, &idx, 1), ["1", "2"]);
    }

    #[test]
    fn a_sub_range_scans_one_jsonl_record() {
        let store = ByteStore::open(&temp_file("range", b"{\"a\":1}\n[2, 3]\n")).unwrap();
        let idx = scan(&store, 8..14, &ScanOptions::default(), &AtomicBool::new(false)).unwrap();
        assert_eq!(idx.error, None);
        assert_eq!(idx.root, Some((Kind::Array, Span { start: 8, end: 14 })));
        assert_eq!(texts(&store, &idx, 0), ["2", "3"]);
    }

    #[test]
    fn a_utf8_bom_is_skipped() {
        let (store, idx) = index("bom", b"\xEF\xBB\xBF[1]");
        assert_eq!(idx.error, None);
        assert_eq!(idx.root, Some((Kind::Array, Span { start: 3, end: 6 })));
        assert_eq!(texts(&store, &idx, 0), ["1"]);
    }

    #[test]
    fn a_bom_mid_file_is_not_skipped() {
        // C1's rule: only a file-start BOM is skipped; U+FEFF later on is text, so this JSONL record isn't JSON.
        let store = ByteStore::open(&temp_file("bom-mid", b"{\"a\":1}\n\xEF\xBB\xBF{\"b\":2}\n")).unwrap();
        let idx = scan(&store, 8..18, &ScanOptions::default(), &AtomicBool::new(false)).unwrap();
        assert_eq!((stop(&idx), idx.root), (Some((ErrorKind::Syntax("expected a value"), 8)), None));
    }

    #[test]
    fn long_scalars_are_jumped_and_previews_capped() {
        let big = "a".repeat(MAX_PIECE + 10);
        let num = "1".repeat(MAX_PIECE);
        let src = format!("[\"{big}\", {num}, {{\"{big}\": 1, \"{big}\": 2}}, true]");
        let (store, idx) = index("long", src.as_bytes());
        assert_eq!(idx.error, None);
        assert_eq!(idx.long_scalars.len(), 4); // the string, the number and both keys
        let kids = children(&store, &idx, 0, 0, 10).unwrap();
        let s = big.len() as u64 + 3;
        assert_eq!(kids[0].value, Span { start: 1, end: s });
        assert_eq!(kids[0].text.len(), MAX_PIECE);
        assert_eq!(kids[1].value, Span { start: s + 2, end: s + 2 + MAX_PIECE as u64 });
        assert_eq!(kids[3].text, b"true");
        assert_eq!(duplicate_keys(&store, &idx, 1, &AtomicBool::new(false)).unwrap(), Some(vec![1]));
    }

    #[test]
    fn a_page_stops_at_256_kib() {
        let s = format!("\"{}\"", "a".repeat(60_000));
        let (store, idx) = index("page-cap", format!("[{}]", vec![s; 20].join(",")).as_bytes());
        let page = children(&store, &idx, 0, 0, 100).unwrap();
        assert_eq!(page.len(), 4); // 4 × 60,002 ≤ 256 KiB < 5 × 60,002
        assert_eq!(children(&store, &idx, 0, 4, 100).unwrap()[0].value.start, page[3].value.end + 1); // the next page
    }

    #[test]
    fn tokens_straddle_real_chunk_boundaries() {
        // 21-byte unit: CHUNK boundaries land inside the string, on its closing quote, inside the number
        // and right after the number (2^20·k mod 21 = 4, 8, 12, 16).
        let unit: &[u8] = b"\"abc\\\"d\",123456,true,";
        assert_eq!(unit.len(), 21);
        let path = repeated("straddle", b"[", unit, 200_000, b"null]");
        let (store, idx, _) = scan_timed(&path, ScanOptions::default());
        assert_eq!(idx.error, None);
        assert_eq!(idx.containers[0].children, 600_001);
        let mut kids = Vec::new();
        while kids.len() < 600_001 {
            let page = children(&store, &idx, 0, kids.len() as u64, usize::MAX).unwrap(); // capped at 256 KiB a page
            assert!(!page.is_empty());
            kids.extend(page);
        }
        for (i, kid) in kids.iter().enumerate().take(600_000) {
            let base = 1 + 21 * (i as u64 / 3);
            let (start, end) = [(base, base + 8), (base + 9, base + 15), (base + 16, base + 20)][i % 3];
            assert_eq!(kid.value, Span { start, end }, "child {i}");
        }
        assert_eq!(kids[600_000].text, b"null");
    }

    #[test]
    fn cancel_returns_within_50ms() {
        let path = repeated("cancel", b"[", b"[1,\"abc\",{\"k\":null}],", 4_000_000, b"0]");
        let store = Arc::new(ByteStore::open(&path).unwrap());
        let mut worst = Duration::ZERO;
        for run in 0..20u64 {
            let cancel = Arc::new(AtomicBool::new(false));
            let (s, c) = (store.clone(), cancel.clone());
            let worker = std::thread::spawn(move || {
                let idx = scan(&s, 0..s.len(), &ScanOptions::default(), &c).unwrap();
                (idx.error.map(|e| e.kind), Instant::now())
            });
            std::thread::sleep(Duration::from_millis(5 + run * 3));
            let set = Instant::now();
            cancel.store(true, Ordering::Relaxed);
            let (kind, returned) = worker.join().unwrap();
            assert_eq!(kind, Some(ErrorKind::Cancelled), "run {run} finished before the cancel");
            worst = worst.max(returned.saturating_duration_since(set));
        }
        println!("cancel latency, max over 20 runs: {worst:?}");
        assert!(worst < Duration::from_millis(50), "{worst:?}");
    }

    #[test]
    fn hostile_100mb_of_open_brackets_stops_at_the_depth_cap() {
        let path = repeated("brackets", b"", b"[", 100 << 20, b"");
        let (store, idx, took) = scan_timed(&path, ScanOptions::default());
        println!("100 MB of '[': {took:?}, {} index bytes", idx.heap_bytes());
        assert_eq!(stop(&idx), Some((ErrorKind::TooDeep, 10_000)));
        assert_eq!(idx.containers.len(), 10_000);
        assert!(idx.heap_bytes() < 10_000 * size_of::<Container>() + 1024);
        assert!(took < Duration::from_secs(1));
        assert_eq!(children(&store, &idx, 0, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn hostile_alternating_object_nesting_stops_at_the_depth_cap() {
        let path = repeated("objects", b"", b"{\"a\":", 20 << 20, b"");
        let (_, idx, took) = scan_timed(&path, ScanOptions::default());
        println!("100 MB of '{{\"a\":': {took:?}, {} index bytes", idx.heap_bytes());
        assert_eq!(stop(&idx), Some((ErrorKind::TooDeep, 50_000)));
        assert_eq!(idx.containers[9_999].children, 0);
        assert!(idx.heap_bytes() < 10_000 * size_of::<Container>() + 1024);
        assert!(took < Duration::from_secs(1));
    }

    #[test]
    fn hostile_container_flood_stops_at_the_budget() {
        let path = repeated("flood", b"[", b"{},", 1_000_000, b"{}]");
        let opts = ScanOptions { max_containers: 1000, ..ScanOptions::default() };
        let (_, idx, took) = scan_timed(&path, opts);
        assert_eq!(stop(&idx), Some((ErrorKind::TooManyContainers, 2998)));
        assert_eq!(idx.containers[0].children, 999);
        assert!(idx.heap_bytes() < 1000 * size_of::<Container>() + 1024);
        assert!(took < Duration::from_secs(1));
        // Without the budget: 1,000,002 containers span 16 pages, and lookups cross them.
        let (store, idx, _) = scan_timed(&path, ScanOptions::default());
        assert_eq!(idx.containers.len(), 1_000_002);
        let ids: Vec<Option<u32>> = children(&store, &idx, 0, 999_999, 5).unwrap().iter().map(|c| c.container).collect();
        assert_eq!(ids, [Some(1_000_000), Some(1_000_001)]);
        assert_eq!(idx.containers[1_000_001].start, 3_000_001);
    }

    #[test]
    fn hostile_50m_element_flat_array_enumerates_from_the_middle() {
        let path = repeated("flat", b"[", b"0,", 49_999_999, b"0]");
        let (store, idx, took) = scan_timed(&path, ScanOptions::default());
        println!("50M-element array: scan {took:?}, {} index bytes", idx.heap_bytes());
        assert_eq!(idx.error, None);
        assert_eq!(idx.containers.len(), 1);
        assert_eq!(idx.containers[0].children, 50_000_000);
        assert_eq!(idx.checkpoints.len(), 48_828);
        assert!(idx.heap_bytes() < 2 << 20);
        assert!(took < Duration::from_secs(60));
        let started = Instant::now();
        let mid = children(&store, &idx, 0, 25_000_000, 3).unwrap();
        let took_mid = started.elapsed();
        println!("children(25,000,000..+3): {took_mid:?}");
        let starts: Vec<u64> = mid.iter().map(|c| c.value.start).collect();
        assert_eq!(starts, [50_000_001, 50_000_003, 50_000_005]);
        assert!(took_mid < Duration::from_millis(50));
    }

    #[test]
    fn hostile_200mb_single_string_is_never_buffered() {
        let path = repeated("string", b"\"", b"a", 200 << 20, b"\"");
        let (_, idx, took) = scan_timed(&path, ScanOptions::default());
        println!("200 MB string: {took:?}, {} index bytes", idx.heap_bytes());
        let span = Span { start: 0, end: (200 << 20) + 2 };
        assert_eq!(idx.root, Some((Kind::String, span)));
        assert_eq!(idx.long_scalars, vec![span]);
        assert!(idx.heap_bytes() < 1024);
        assert!(took < Duration::from_secs(60));
    }

    #[test]
    fn hostile_unterminated_string_and_comment_at_eof() {
        for (name, head, msg) in [("open-string", &b"[\""[..], "unterminated string"), ("open-comment", b"[/*", "unterminated comment")] {
            let path = repeated(name, head, b"a", 100 << 20, b"");
            let (_, idx, took) = scan_timed(&path, ScanOptions::default());
            println!("100 MB {msg}: {took:?}");
            assert_eq!(idx.error, Some(ScanError { kind: ErrorKind::Syntax(msg), offset: 1, line: 1, column: 2 }));
            assert_eq!(idx.containers[0].children, 0);
            assert!(idx.heap_bytes() < 1024);
            assert!(took < Duration::from_secs(60));
        }
    }

    #[test]
    fn hostile_invalid_utf8_and_nul_bytes() {
        let src = b"[\"\xff\xfe\", \"\xc3\", {\"\xff\": \"\x00\", \"\xff\": 1}, \"ok\"]";
        let (store, idx) = index("bad-utf8", src);
        assert_eq!(idx.error, None);
        let kids = children(&store, &idx, 0, 0, 10).unwrap();
        assert_eq!(kids[0].text, b"\"\xff\xfe\"");
        assert_eq!(kids[1].text, b"\"\xc3\"");
        assert_eq!(children(&store, &idx, 1, 0, 10).unwrap()[0].text, b"\"\x00\"");
        assert_eq!(duplicate_keys(&store, &idx, 1, &AtomicBool::new(false)).unwrap(), Some(vec![1]));

        let (_, idx) = index("nul", b"[1,\x00 2]");
        assert_eq!(stop(&idx), Some((ErrorKind::Syntax("expected a value"), 3)));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core json`
Expected: the build fails with 33 errors, every one a missing implementation, plus 7 unused-import warnings (one is `MAX_PAGE`, which only the implementation uses):
- ``error[E0425]: cannot find function `scan` in this scope`` (5);
- `` `children` `` (14);
- `` `duplicate_keys` `` (4);
- ``error[E0599]: no method named `heap_bytes` found for struct `json::JsonIndex` `` (10).

- [ ] **Step 3: Implement**

Add to `json.rs`, between the `Child` struct and `#[cfg(test)] mod tests`:
<!-- op: insert-before spikes/core/spike-core/src/json.rs :: #[cfg(test)] -->
```rust
impl JsonIndex {
    /// Resident size of the index (the scanner's own stack is freed when the scan returns).
    pub fn heap_bytes(&self) -> usize {
        self.containers.heap_bytes()
            + self.checkpoints.capacity() * size_of::<ElementCheckpoint>()
            + self.long_scalars.capacity() * size_of::<Span>()
    }

    /// Enumeration never reads past this: the error offset, or the end of the range.
    fn stop(&self) -> u64 {
        self.error.map_or(self.range.end, |e| e.offset)
    }

    fn checkpoints_of(&self, id: u32) -> &[ElementCheckpoint] {
        let lo = self.checkpoints.partition_point(|c| c.container < id);
        let hi = self.checkpoints.partition_point(|c| c.container <= id);
        &self.checkpoints[lo..hi]
    }
}

/// Builds the container index for `range` of the store (the whole file, or one JSONL record).
/// Syntax, depth, budget and cancel errors land in `JsonIndex::error`, with everything before them kept.
pub fn scan(store: &ByteStore, range: Range<u64>, opts: &ScanOptions, cancel: &AtomicBool) -> Result<JsonIndex, StoreError> {
    let end = range.end.min(store.len());
    let mut start = range.start.min(end);
    if start == 0 && store.read(0, end.min(3))? == b"\xEF\xBB\xBF" {
        start = 3; // a UTF-8 BOM at the file's start (spec §4.1): the document starts after it
    }
    let mut s = Scanner::new(opts, Span { start, end });
    let mut pos = start;
    let stopped = 'scan: {
        while pos < end {
            let idx = pos / CHUNK as u64;
            let chunk = store.chunk(idx)?;
            let base = idx * CHUNK as u64;
            let (lo, hi) = ((pos - base) as usize, ((end - base) as usize).min(chunk.len()));
            if lo >= hi {
                break;
            }
            for piece in chunk[lo..hi].chunks(opts.window.max(1)) {
                if cancel.load(Ordering::Relaxed) {
                    break 'scan Some((ErrorKind::Cancelled, pos));
                }
                if let Err(e) = s.feed(piece, pos) {
                    break 'scan Some(e);
                }
                pos += piece.len() as u64;
            }
        }
        s.finish(pos).err()
    };
    if let Some((kind, offset)) = stopped {
        s.on_error();
        let (line, column) = if kind == ErrorKind::Cancelled { (0, 0) } else { line_col(store, start, offset, opts, cancel)? };
        s.idx.error = Some(ScanError { kind, offset, line, column });
    }
    let mut idx = s.idx;
    idx.checkpoints.sort_by_key(|c| c.container); // stable: each container's checkpoints stay in child order
    if let Some(page) = idx.containers.pages.last_mut() {
        page.shrink_to_fit(); // at most one page moves
    }
    Ok(idx)
}

/// Up to `count` children of `container`, starting at child `first`, holding at most `MAX_PAGE` bytes of text,
/// checked before each push (spec §3.4): the next page starts after the last child returned. Starts at the nearest
/// checkpoint, jumps over nested containers through the index and over long scalars through `long_scalars`.
pub fn children(store: &ByteStore, index: &JsonIndex, container: u32, first: u64, count: usize) -> Result<Vec<Child>, StoreError> {
    let (mut out, mut bytes) = (Vec::new(), 0);
    if count == 0 {
        return Ok(out);
    }
    walk(store, index, container, first, |cur, mut child| {
        if !matches!(child.kind, Kind::Object | Kind::Array) {
            let v = child.value;
            child.text = cur.read(Span { start: v.start, end: v.end.min(v.start + MAX_PIECE as u64) })?.into_owned();
        }
        if !out.is_empty() && bytes + child.text.len() > MAX_PAGE {
            return Ok(false);
        }
        bytes += child.text.len();
        out.push(child);
        Ok(out.len() < count)
    })?;
    Ok(out)
}

/// Ordinals of the members of object `container` whose key, unescaped, repeats an earlier member's key, or
/// `None` if cancelled (checked every 1,024 members). Runs over the whole object once; the Tree calls it when
/// the object is first expanded. While it runs it holds a pre-sized set of 128-bit key hashes: 17–34 bytes
/// per member (136 MB for a 5M-key object).
pub fn duplicate_keys(store: &ByteStore, index: &JsonIndex, container: u32, cancel: &AtomicBool) -> Result<Option<Vec<u64>>, StoreError> {
    let members = index.containers.get(container as usize).filter(|c| c.kind == Kind::Object).map_or(0, |c| c.children);
    let (mut seen, mut dups, mut ordinal) = (HashSet::with_capacity(members as usize), Vec::new(), 0u64);
    let mut cancelled = false;
    walk(store, index, container, 0, |cur, child| {
        if ordinal % 1024 == 0 && cancel.load(Ordering::Relaxed) {
            cancelled = true;
            return Ok(false);
        }
        if let Some(key) = child.key {
            let hash = if key.end - key.start > MAX_PIECE as u64 {
                // ponytail: keys over 64 KiB are compared by raw bytes, escapes undecoded; streamed, never buffered.
                let mut h = Xxh3::new();
                let mut pos = key.start;
                while pos < key.end {
                    let piece = store.read(pos, key.end.min(pos + CHUNK as u64))?;
                    if piece.is_empty() {
                        break;
                    }
                    h.update(&piece);
                    pos += piece.len() as u64;
                }
                h.digest128()
            } else {
                xxh3_128(&unescape(&cur.read(key)?))
            };
            if !seen.insert(hash) {
                dups.push(ordinal);
            }
        }
        ordinal += 1;
        Ok(true)
    })?;
    Ok((!cancelled).then_some(dups))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
    Root,
    Value,
    ArrFirst,
    ArrNext,
    ObjFirst,
    ObjNext,
    Colon,
    After,
    Done,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Num {
    Minus,
    Zero,
    Int,
    Dot,
    Frac,
    Exp,
    ExpSign,
    ExpDigits,
}

/// Lexer state. It survives between `feed` calls, so a token may straddle any chunk or window boundary.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lex {
    Between,
    Str,
    Escape,
    Hex(u8),
    Num(Num),
    Word(&'static [u8], u8),
    Slash,
    LineComment,
    BlockComment,
    BlockStar,
}

struct Frame {
    id: u32,
    cp_child: u64,
    cp_offset: u64,
}

type Stop = (ErrorKind, u64);

/// Push scanner: no recursion, so file-controlled depth only grows `stack`, which `max_depth` caps.
struct Scanner<'o> {
    o: &'o ScanOptions,
    idx: JsonIndex,
    stack: Vec<Frame>,
    expect: Expect,
    lex: Lex,
    tok: u64,
    tok_kind: Kind,
    tok_is_key: bool,
    /// The innermost container's current child has started but not finished.
    in_child: bool,
}

fn num_next(n: Num, b: u8) -> Option<Num> {
    match (n, b) {
        (Num::Minus, b'0') => Some(Num::Zero),
        (Num::Minus, b'1'..=b'9') | (Num::Int, b'0'..=b'9') => Some(Num::Int),
        (Num::Zero | Num::Int, b'.') => Some(Num::Dot),
        (Num::Dot | Num::Frac, b'0'..=b'9') => Some(Num::Frac),
        (Num::Zero | Num::Int | Num::Frac, b'e' | b'E') => Some(Num::Exp),
        (Num::Exp, b'+' | b'-') => Some(Num::ExpSign),
        (Num::Exp | Num::ExpSign | Num::ExpDigits, b'0'..=b'9') => Some(Num::ExpDigits),
        _ => None,
    }
}

impl<'o> Scanner<'o> {
    fn new(o: &'o ScanOptions, range: Span) -> Self {
        let idx = JsonIndex {
            range,
            root: None,
            containers: Paged::new(),
            checkpoints: Vec::new(),
            long_scalars: Vec::new(),
            trivia: Trivia::default(),
            error: None,
            window: o.window.max(1),
        };
        Scanner { o, idx, stack: Vec::new(), expect: Expect::Root, lex: Lex::Between, tok: range.start, tok_kind: Kind::Null, tok_is_key: false, in_child: false }
    }

    fn feed(&mut self, buf: &[u8], base: u64) -> Result<(), Stop> {
        let mut i = 0;
        while i < buf.len() {
            let at = base + i as u64;
            match self.lex {
                Lex::Between => {
                    let b = buf[i];
                    i += 1;
                    if !matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                        self.token(b, at)?;
                    }
                }
                Lex::Str => match memchr2(b'"', b'\\', &buf[i..]) {
                    None => i = buf.len(),
                    Some(j) => {
                        i += j + 1;
                        if buf[i - 1] == b'"' {
                            self.end_string(base + i as u64);
                        } else {
                            self.lex = Lex::Escape;
                        }
                    }
                },
                Lex::Escape => {
                    self.lex = match buf[i] {
                        b'u' => Lex::Hex(4),
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => Lex::Str,
                        _ => return Err((ErrorKind::Syntax("invalid escape"), at)),
                    };
                    i += 1;
                }
                Lex::Hex(left) => {
                    if !buf[i].is_ascii_hexdigit() {
                        return Err((ErrorKind::Syntax("invalid escape"), at));
                    }
                    self.lex = if left == 1 { Lex::Str } else { Lex::Hex(left - 1) };
                    i += 1;
                }
                Lex::Num(Num::Minus) if buf[i] == b'I' && self.o.jsonc => {
                    self.idx.trivia.nonfinite += 1;
                    self.lex = Lex::Word(b"Infinity", 1);
                    i += 1;
                }
                Lex::Num(mut n) => {
                    while let Some(next) = buf.get(i).and_then(|&b| num_next(n, b)) {
                        n = next;
                        i += 1;
                    }
                    self.lex = Lex::Num(n);
                    // A byte that can't continue the number ends it; that byte is looked at again as `Between`.
                    if i < buf.len() {
                        if !matches!(n, Num::Zero | Num::Int | Num::Frac | Num::ExpDigits) {
                            return Err((ErrorKind::Syntax("invalid number"), base + i as u64));
                        }
                        self.end_scalar(base + i as u64);
                    }
                }
                Lex::Word(word, k) => {
                    if buf[i] != word[k as usize] {
                        return Err((ErrorKind::Syntax("invalid literal"), at));
                    }
                    i += 1;
                    if k as usize + 1 == word.len() {
                        self.end_scalar(base + i as u64);
                    } else {
                        self.lex = Lex::Word(word, k + 1);
                    }
                }
                Lex::Slash => {
                    self.lex = match buf[i] {
                        b'/' => Lex::LineComment,
                        b'*' => Lex::BlockComment,
                        _ => return Err((ErrorKind::Syntax("invalid comment"), self.tok)),
                    };
                    self.idx.trivia.comments += 1;
                    i += 1;
                }
                Lex::LineComment => match memchr2(b'\n', b'\r', &buf[i..]) {
                    None => i = buf.len(),
                    Some(j) => {
                        i += j + 1;
                        self.lex = Lex::Between;
                    }
                },
                Lex::BlockComment => match memchr(b'*', &buf[i..]) {
                    None => i = buf.len(),
                    Some(j) => {
                        i += j + 1;
                        self.lex = Lex::BlockStar;
                    }
                },
                Lex::BlockStar => {
                    self.lex = match buf[i] {
                        b'/' => Lex::Between,
                        b'*' => Lex::BlockStar,
                        _ => Lex::BlockComment,
                    };
                    i += 1;
                }
            }
        }
        Ok(())
    }

    fn token(&mut self, b: u8, at: u64) -> Result<(), Stop> {
        match b {
            b'"' if matches!(self.expect, Expect::ObjFirst | Expect::ObjNext) => {
                self.child_start(at);
                (self.tok, self.tok_is_key, self.lex) = (at, true, Lex::Str);
                Ok(())
            }
            b'"' => self.value(at, Lex::Str, Kind::String),
            b'{' | b'[' => {
                self.value_start(at)?;
                self.open(b, at)
            }
            b'-' => self.value(at, Lex::Num(Num::Minus), Kind::Number),
            b'0' => self.value(at, Lex::Num(Num::Zero), Kind::Number),
            b'1'..=b'9' => self.value(at, Lex::Num(Num::Int), Kind::Number),
            b't' => self.value(at, Lex::Word(b"true", 1), Kind::True),
            b'f' => self.value(at, Lex::Word(b"false", 1), Kind::False),
            b'n' => self.value(at, Lex::Word(b"null", 1), Kind::Null),
            b'N' | b'I' if self.o.jsonc => {
                let word: &'static [u8] = if b == b'N' { b"NaN" } else { b"Infinity" };
                self.value(at, Lex::Word(word, 1), Kind::Number)?;
                self.idx.trivia.nonfinite += 1;
                Ok(())
            }
            b',' if self.expect == Expect::After => {
                self.expect = if self.top_kind() == Some(Kind::Object) { Expect::ObjNext } else { Expect::ArrNext };
                Ok(())
            }
            b':' if self.expect == Expect::Colon => {
                self.expect = Expect::Value;
                Ok(())
            }
            b']' | b'}' => self.close(b, at),
            b'/' if self.o.jsonc => {
                (self.tok, self.lex) = (at, Lex::Slash);
                Ok(())
            }
            _ => Err(self.unexpected(at)),
        }
    }

    fn value(&mut self, at: u64, lex: Lex, kind: Kind) -> Result<(), Stop> {
        self.value_start(at)?;
        (self.tok, self.tok_kind, self.tok_is_key, self.lex) = (at, kind, false, lex);
        Ok(())
    }

    fn value_start(&mut self, at: u64) -> Result<(), Stop> {
        match self.expect {
            Expect::Root | Expect::Value => Ok(()),
            Expect::ArrFirst | Expect::ArrNext => {
                self.child_start(at);
                Ok(())
            }
            _ => Err(self.unexpected(at)),
        }
    }

    /// Counts a child of the innermost container and places a checkpoint at it when one is due.
    fn child_start(&mut self, at: u64) {
        let Some(f) = self.stack.last_mut() else { return };
        self.in_child = true;
        let c = &mut self.idx.containers[f.id as usize];
        let k = c.children;
        c.children += 1;
        if k - f.cp_child >= self.o.cp_children || at - f.cp_offset >= self.o.cp_bytes {
            self.idx.checkpoints.push(ElementCheckpoint { container: f.id, child: k, offset: at });
            (f.cp_child, f.cp_offset) = (k, at);
        }
    }

    fn open(&mut self, b: u8, at: u64) -> Result<(), Stop> {
        if self.stack.len() >= self.o.max_depth {
            return Err((ErrorKind::TooDeep, at));
        }
        if self.idx.containers.len() >= self.o.max_containers.min(NO_PARENT as usize) {
            return Err((ErrorKind::TooManyContainers, at));
        }
        let kind = if b == b'{' { Kind::Object } else { Kind::Array };
        let id = self.idx.containers.len() as u32;
        let parent = self.stack.last().map_or(NO_PARENT, |f| f.id);
        if self.stack.is_empty() {
            self.idx.root = Some((kind, Span { start: at, end: 0 }));
        }
        self.idx.containers.push(Container { start: at, end: 0, children: 0, parent, kind });
        self.stack.push(Frame { id, cp_child: 0, cp_offset: at });
        self.expect = if kind == Kind::Object { Expect::ObjFirst } else { Expect::ArrFirst };
        self.in_child = false;
        Ok(())
    }

    fn close(&mut self, b: u8, at: u64) -> Result<(), Stop> {
        let kind = if b == b'}' { Kind::Object } else { Kind::Array };
        let ok = match self.expect {
            Expect::After => self.top_kind() == Some(kind),
            Expect::ArrFirst => kind == Kind::Array,
            Expect::ObjFirst => kind == Kind::Object,
            Expect::ArrNext | Expect::ObjNext if self.o.jsonc && self.top_kind() == Some(kind) => {
                self.idx.trivia.trailing_commas += 1;
                true
            }
            _ => false,
        };
        if !ok {
            return Err(self.unexpected(at));
        }
        let Some(f) = self.stack.pop() else { return Err(self.unexpected(at)) };
        self.idx.containers[f.id as usize].end = at + 1;
        if let (true, Some((_, span))) = (self.stack.is_empty(), &mut self.idx.root) {
            span.end = at + 1;
        }
        self.after_value();
        Ok(())
    }

    fn end_string(&mut self, end: u64) {
        if self.tok_is_key {
            self.note_long(end);
            (self.lex, self.expect) = (Lex::Between, Expect::Colon);
        } else {
            self.end_scalar(end);
        }
    }

    fn end_scalar(&mut self, end: u64) {
        self.lex = Lex::Between;
        self.note_long(end);
        if self.stack.is_empty() {
            self.idx.root = Some((self.tok_kind, Span { start: self.tok, end }));
        }
        self.after_value();
    }

    fn note_long(&mut self, end: u64) {
        if end - self.tok >= MAX_PIECE as u64 {
            self.idx.long_scalars.push(Span { start: self.tok, end });
        }
    }

    fn after_value(&mut self) {
        self.in_child = false;
        self.expect = if self.stack.is_empty() { Expect::Done } else { Expect::After };
    }

    fn top_kind(&self) -> Option<Kind> {
        self.stack.last().map(|f| self.idx.containers[f.id as usize].kind)
    }

    fn unexpected(&self, at: u64) -> Stop {
        let msg = match self.expect {
            Expect::Root | Expect::Value | Expect::ArrNext => "expected a value",
            Expect::ArrFirst => "expected a value or ]",
            Expect::ObjFirst => "expected a key or }",
            Expect::ObjNext => "expected a key",
            Expect::Colon => "expected :",
            Expect::After if self.top_kind() == Some(Kind::Object) => "expected , or }",
            Expect::After => "expected , or ]",
            Expect::Done => "unexpected data after the value",
        };
        (ErrorKind::Syntax(msg), at)
    }

    fn finish(&mut self, end: u64) -> Result<(), Stop> {
        match self.lex {
            Lex::Between | Lex::LineComment => {}
            Lex::Num(Num::Zero | Num::Int | Num::Frac | Num::ExpDigits) => self.end_scalar(end),
            Lex::Str | Lex::Escape | Lex::Hex(_) => return Err((ErrorKind::Syntax("unterminated string"), self.tok)),
            Lex::Slash | Lex::BlockComment | Lex::BlockStar => return Err((ErrorKind::Syntax("unterminated comment"), self.tok)),
            Lex::Num(_) | Lex::Word(..) => return Err((ErrorKind::Syntax("unexpected end of input"), end)),
        }
        match self.expect {
            Expect::Root | Expect::Done => Ok(()),
            _ => Err((ErrorKind::Syntax("unexpected end of input"), end)),
        }
    }

    /// A child cut off by the error isn't counted, so `children` counts only what enumeration can return.
    /// An unclosed nested container still counts: what parsed inside it stays usable.
    fn on_error(&mut self) {
        if let (true, Some(f)) = (self.in_child, self.stack.last()) {
            let c = &mut self.idx.containers[f.id as usize];
            c.children = c.children.saturating_sub(1);
        }
    }
}

/// 1-based line and character column of `offset`, counted from `from`; (0, 0) if cancelled first.
fn line_col(store: &ByteStore, from: u64, offset: u64, opts: &ScanOptions, cancel: &AtomicBool) -> Result<(u64, u64), StoreError> {
    let (mut line, mut column, mut pos) = (1u64, 1u64, from);
    while pos < offset {
        if cancel.load(Ordering::Relaxed) {
            return Ok((0, 0));
        }
        let bytes = store.read(pos, offset.min(pos + opts.window.max(1) as u64))?;
        if bytes.is_empty() {
            break;
        }
        let tail = match memrchr(b'\n', &bytes) {
            Some(i) => {
                line += memchr_iter(b'\n', &bytes).count() as u64;
                column = 1;
                &bytes[i + 1..]
            }
            None => &bytes[..],
        };
        column += tail.iter().filter(|&&b| b & 0xC0 != 0x80).count() as u64;
        pos += bytes.len() as u64;
    }
    Ok((line, column))
}

/// Pull reader for enumeration: `[pos, end)` through the store, `window` bytes at a time.
struct Cursor<'s> {
    store: &'s ByteStore,
    pos: u64,
    end: u64,
    window: usize,
    buf: Vec<u8>,
    buf_start: u64,
}

impl Cursor<'_> {
    /// The buffered bytes from `pos` on, refilled when used up; empty at `end`.
    fn rest(&mut self) -> Result<&[u8], StoreError> {
        if self.pos < self.buf_start || self.pos >= self.buf_start + self.buf.len() as u64 {
            self.buf = self.store.read(self.pos, self.end.min(self.pos + self.window as u64))?;
            self.buf_start = self.pos;
        }
        Ok(&self.buf[(self.pos - self.buf_start) as usize..])
    }

    fn peek(&mut self) -> Result<Option<u8>, StoreError> {
        Ok(self.rest()?.first().copied())
    }

    /// Moves just past the first byte `find` locates, or to `end`.
    fn skip_past(&mut self, find: impl Fn(&[u8]) -> Option<usize>) -> Result<(), StoreError> {
        loop {
            let rest = self.rest()?;
            let (len, hit) = (rest.len(), find(rest));
            match hit {
                Some(j) => {
                    self.pos += j as u64 + 1;
                    return Ok(());
                }
                None if len == 0 => return Ok(()),
                None => self.pos += len as u64,
            }
        }
    }

    /// `span`'s bytes, from the buffer when it holds them.
    fn read(&mut self, span: Span) -> Result<Cow<'_, [u8]>, StoreError> {
        let buf_end = self.buf_start + self.buf.len() as u64;
        if span.start >= self.buf_start && span.end <= buf_end {
            let (a, b) = ((span.start - self.buf_start) as usize, (span.end - self.buf_start) as usize);
            return Ok(Cow::Borrowed(&self.buf[a..b]));
        }
        Ok(Cow::Owned(self.store.read(span.start, span.end)?))
    }

    /// Skips whitespace, commas, colons and comments (the scan already validated them) to the next token.
    fn next_token(&mut self) -> Result<Option<(u64, u8)>, StoreError> {
        loop {
            let Some(b) = self.peek()? else { return Ok(None) };
            match b {
                b' ' | b'\t' | b'\n' | b'\r' | b',' | b':' => self.pos += 1,
                b'/' => {
                    self.pos += 1;
                    if self.peek()? == Some(b'*') {
                        self.pos += 1;
                        loop {
                            self.skip_past(|s| memchr(b'*', s))?;
                            match self.peek()? {
                                Some(b'/') => {
                                    self.pos += 1;
                                    break;
                                }
                                Some(_) => {}
                                None => break,
                            }
                        }
                    } else {
                        self.skip_past(|s| memchr2(b'\n', b'\r', s))?;
                    }
                }
                _ => return Ok(Some((self.pos, b))),
            }
        }
    }

    /// End of the string, number or literal that starts at `start` with byte `first`.
    fn scalar_end(&mut self, index: &JsonIndex, start: u64, first: u8) -> Result<u64, StoreError> {
        if let Ok(i) = index.long_scalars.binary_search_by_key(&start, |s| s.start) {
            self.pos = index.long_scalars[i].end;
            return Ok(self.pos);
        }
        self.pos = start + 1;
        loop {
            let rest = self.rest()?;
            let len = rest.len();
            if first == b'"' {
                match memchr2(b'"', b'\\', rest).map(|j| (j, rest[j])) {
                    Some((j, b'"')) => return Ok(self.pos + j as u64 + 1),
                    Some((j, _)) => self.pos += j as u64 + 2, // a backslash and the byte it escapes
                    None if len == 0 => return Ok(self.pos),
                    None => self.pos += len as u64,
                }
            } else {
                let delim = |b: &u8| matches!(b, b',' | b']' | b'}' | b':' | b' ' | b'\t' | b'\n' | b'\r' | b'/');
                match rest.iter().position(delim) {
                    Some(j) => return Ok(self.pos + j as u64),
                    None if len == 0 => return Ok(self.pos),
                    None => self.pos += len as u64,
                }
            }
        }
    }
}

fn scalar_kind(first: u8) -> Kind {
    match first {
        b'"' => Kind::String,
        b't' => Kind::True,
        b'f' => Kind::False,
        b'n' => Kind::Null,
        _ => Kind::Number,
    }
}

/// Visits the children of `container` from child `first` on, until `visit` returns false.
fn walk(
    store: &ByteStore,
    index: &JsonIndex,
    container: u32,
    first: u64,
    mut visit: impl FnMut(&mut Cursor<'_>, Child) -> Result<bool, StoreError>,
) -> Result<(), StoreError> {
    let Some(c) = index.containers.get(container as usize).filter(|c| first < c.children) else { return Ok(()) };
    let cps = index.checkpoints_of(container);
    let (mut ordinal, from) = match cps.partition_point(|cp| cp.child <= first) {
        0 => (0, c.start + 1),
        i => (cps[i - 1].child, cps[i - 1].offset),
    };
    let stop = if c.end > 0 { c.end.min(index.stop()) } else { index.stop() }; // never read past the container
    let mut cur = Cursor { store, pos: from, end: stop, window: index.window, buf: Vec::new(), buf_start: from };
    while ordinal < c.children {
        let key = match c.kind {
            Kind::Object => {
                let Some((at, b)) = cur.next_token()? else { break };
                let end = cur.scalar_end(index, at, b)?;
                cur.pos = end;
                Some(Span { start: at, end })
            }
            _ => None,
        };
        let Some((at, b)) = cur.next_token()? else { break };
        let (kind, end, id) = match b {
            b'{' | b'[' => {
                let i = index.containers.partition_point(|c| c.start < at);
                let id = index.containers.get(i).filter(|c| c.start == at).map(|_| i);
                let end = id.map_or(0, |i| index.containers[i].end);
                let kind = if b == b'{' { Kind::Object } else { Kind::Array };
                (kind, if end == 0 { stop } else { end }, id.map(|i| i as u32))
            }
            _ => (scalar_kind(b), cur.scalar_end(index, at, b)?, None),
        };
        cur.pos = end;
        if ordinal >= first && !visit(&mut cur, Child { key, value: Span { start: at, end }, kind, container: id, text: Vec::new() })? {
            break;
        }
        ordinal += 1;
    }
    Ok(())
}

/// A string token (quotes included) with its escapes decoded. Other bytes, even invalid UTF-8, pass through.
fn unescape(tok: &[u8]) -> Cow<'_, [u8]> {
    let s = tok.strip_prefix(b"\"").unwrap_or(tok);
    let s = s.strip_suffix(b"\"").unwrap_or(s);
    if memchr(b'\\', s).is_none() {
        return Cow::Borrowed(s);
    }
    let hex = |i: usize| s.get(i..i + 4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok());
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] != b'\\' {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let Some(&e) = s.get(i + 1) else { break };
        let mut cp = match e {
            b'u' => hex(i + 2).unwrap_or(0xFFFD),
            b'b' => 8,
            b'f' => 12,
            b'n' => 10,
            b'r' => 13,
            b't' => 9,
            other => other as u32,
        };
        i += if e == b'u' { 6 } else { 2 };
        if (0xD800..0xDC00).contains(&cp) && s.get(i..i + 2) == Some(&b"\\u"[..]) {
            if let Some(lo @ 0xDC00..=0xDFFF) = hex(i + 2) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                i += 6;
            }
        }
        push_utf8(&mut out, cp);
    }
    Cow::Owned(out)
}

/// UTF-8 encoding that also encodes lone surrogates (as WTF-8 does), so every code unit compares exactly.
fn push_utf8(out: &mut Vec<u8>, cp: u32) {
    let cont = |shift: u32| 0x80 | ((cp >> shift) & 0x3F) as u8;
    match cp {
        0..=0x7F => out.push(cp as u8),
        0x80..=0x7FF => out.extend([0xC0 | (cp >> 6) as u8, cont(0)]),
        0x800..=0xFFFF => out.extend([0xE0 | (cp >> 12) as u8, cont(6), cont(0)]),
        _ => out.extend([0xF0 | (cp >> 18) as u8, cont(12), cont(6), cont(0)]),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core json -- --nocapture --test-threads=1`
Expected: `20 passed; 0 failed; 0 ignored; 0 measured; 44 filtered out`: the 19 `json` tests, plus Task C1a's `bytemap::tests::json_form_names_its_kind`, whose name the filter also matches. The hostile tests print their times. On the lane machine (debug build, one test at a time, and without Task C1d's debug-build opt-level for `memchr` and `xxhash-rust`) they were:

- 100 MB of `[`: `TooDeep` at offset 10,000 in 5.7 ms, with a 320,096-byte index;
- 100 MB of `{"a":`: `TooDeep` at offset 50,000 in 7.4 ms, with a 320,096-byte index;
- a 200 MB single string: 1.39 s, with a 64-byte index (the string is never buffered);
- a 50M-element flat array: a 2.96 s scan and a 1,572,992-byte index, then `children` from element 25,000,000 in 104 µs;
- a 100 MB unterminated string at EOF: 0.70 s; a 100 MB unterminated comment: 0.61 s;
- cancel: max 6.1 ms over 20 runs.

With Task C1d's opt-level, most of these take a fraction of that: in the replay, the 200 MB string took 95 ms and cancellation's max was 1.1 ms. The asserted bounds are looser: 1 s for the depth- and budget-capped inputs, 60 s for the full scans, and 50 ms for cancellation and for the mid-array `children`.

Then run (`spikes/core`): `cargo test -p spike-core`
Expected: `63 passed; 0 failed; 1 ignored` (Task C1d's 44 plus these 19).

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/json.rs spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/store.rs
git commit -m "spike(c): JSON/JSONC structural scanner with container index and lazy children"
```

---

## Task C2b: Span-fidelity gate (≥ 10,000 generated documents)

**Files:**
- Create: `spikes/core/spike-core/tests/json_spans.rs`

**Interfaces:**
- **Consumes:**
  - `spike_core::json::{children, duplicate_keys, scan, Child, Container, Kind, ScanOptions, Span, NO_PARENT}`;
  - `spike_core::store::ByteStore`.
- **Produces:** the integration test `every_span_matches_the_generator` (`ProptestConfig::with_cases(10_000)`).

**Design note:** the reference comes from the generator, never from the scanner. The emitter writes each document and records the byte range of every container, key and value as it writes them, plus each key's decoded value. Each case then checks:
- the root, and every container's start, end, child count, parent and kind;
- every child (key span, value span, kind, container id and verbatim text), enumerated in full and from 3 random starting children;
- `duplicate_keys` against the generator's decoded keys;
- that strict JSON accepts exactly the documents that use no JSONC feature.

Each case also draws:
- a window of 1–7 bytes, so tokens straddle feed boundaries;
- checkpoints every 1–4 children or 1–63 bytes, so enumeration starts mid-container.

The documents include:
- random whitespace;
- `//` comments (ended by LF or a lone CR) and `/* */` comments, including ones containing `"`, `,`, `]` and `}`, and trailing commas (JSONC cases);
- escapes, including surrogate pairs, plus raw UTF-8 and astral characters;
- `12345678901234567890`, `3.10`, `-0`, `1e400` and random exponents;
- `NaN`/`Infinity` (JSONC cases);
- duplicate keys, including `a` written as a backslash-u escape;
- empty containers, nesting up to about 45 levels, and a strict re-scan of every case.

- [ ] **Step 1: Write the gate**

`spikes/core/spike-core/tests/json_spans.rs`:
<!-- op: create spikes/core/spike-core/tests/json_spans.rs -->
```rust
//! Span-fidelity gate (spec §13.1): zero span mismatches across ≥ 10,000 generated documents. The generator
//! records the exact byte range of everything it emits; the scanner and enumeration must report those ranges.
//! Windows of 1–7 bytes make tokens straddle every boundary, and checkpoints every 1–4 children or 1–63 bytes
//! make enumeration start mid-container.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use proptest::prelude::*;
use spike_core::json::{children, duplicate_keys, scan, Child, Container, Kind, ScanOptions, Span, NO_PARENT};
use spike_core::store::ByteStore;

/// A JSON string as (source text with quotes, decoded value).
type Str = (String, String);

#[derive(Clone, Debug)]
enum Node {
    Scalar(String, Kind),
    Array(Vec<Node>),
    Object(Vec<(Str, Node)>),
}

#[derive(Clone, Debug)]
struct Doc {
    jsonc: bool,
    root: Node,
    /// Drives whitespace, comments and trailing commas.
    choices: Vec<u8>,
}

/// A backslash-u escape, built at run time.
fn u(unit: u16) -> String {
    format!("\\u{unit:04x}")
}

fn same(s: &str) -> Str {
    (s.to_string(), s.to_string())
}

fn string() -> impl Strategy<Value = Str> {
    let piece = prop_oneof![
        "[a-z ]{1,3}".prop_map(|s| same(&s)),
        Just(("\\n".to_string(), "\n".to_string())),
        Just(("\\\"".to_string(), "\"".to_string())),
        Just(("\\\\".to_string(), "\\".to_string())),
        Just(("\\/".to_string(), "/".to_string())),
        Just((u(0xe9), "é".to_string())),
        Just((u(0xd83d) + &u(0xde00), "😀".to_string())),
        Just(same("é")),
        Just(same("日本")),
        Just(same("😀")),
        Just(same("//,]}/*")),
    ];
    prop::collection::vec(piece, 0..5).prop_map(|parts| {
        let (src, val): (Vec<String>, Vec<String>) = parts.into_iter().unzip();
        (format!("\"{}\"", src.concat()), val.concat())
    })
}

fn key() -> impl Strategy<Value = Str> {
    prop_oneof![
        Just(("\"a\"".to_string(), "a".to_string())),
        Just((format!("\"{}\"", u(0x61)), "a".to_string())),
        Just(("\"b\"".to_string(), "b".to_string())),
        string(),
    ]
}

fn number() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("12345678901234567890".to_string()),
        Just("3.10".to_string()),
        Just("-0".to_string()),
        Just("1e400".to_string()),
        Just("-1.5E-7".to_string()),
        "-?(0|[1-9][0-9]{0,24})(\\.[0-9]{1,6})?([eE][+-]?[0-9]{1,3})?",
    ]
}

fn node(jsonc: bool) -> impl Strategy<Value = Node> {
    let lit = |s: &str, k: Kind| Just(Node::Scalar(s.to_string(), k)).boxed();
    let mut leaves = vec![
        string().prop_map(|s| Node::Scalar(s.0, Kind::String)).boxed(),
        number().prop_map(|s| Node::Scalar(s, Kind::Number)).boxed(),
        lit("true", Kind::True),
        lit("false", Kind::False),
        lit("null", Kind::Null),
    ];
    if jsonc {
        leaves.extend([lit("NaN", Kind::Number), lit("Infinity", Kind::Number), lit("-Infinity", Kind::Number)]);
    }
    prop::strategy::Union::new(leaves).prop_recursive(6, 48, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Node::Array),
            prop::collection::vec((key(), inner), 0..6).prop_map(Node::Object),
        ]
    })
}

/// Up to 39 extra levels of `[…]` / `{"k": …}` around the root, for deep-ish nesting.
fn doc() -> impl Strategy<Value = Doc> {
    any::<bool>().prop_flat_map(|jsonc| {
        (node(jsonc), 0usize..40, prop::collection::vec(any::<u8>(), 1..64)).prop_map(move |(mut root, wraps, choices)| {
            for w in 0..wraps {
                let k = ("\"k\"".to_string(), "k".to_string());
                root = if w % 2 == 0 { Node::Array(vec![root]) } else { Node::Object(vec![(k, root)]) };
            }
            Doc { jsonc, root, choices }
        })
    })
}

/// What the generator emitted: the bytes, the root, and every container in document order with its
/// children and decoded keys. This is the reference; nothing in it comes from the scanner.
struct Emitted {
    out: Vec<u8>,
    root: (Kind, Span),
    containers: Vec<(Container, Vec<Child>, Vec<String>)>,
    jsonc_used: bool,
}

struct Emitter<'d> {
    doc: &'d Doc,
    next: usize,
    e: Emitted,
}

impl Emitter<'_> {
    fn choice(&mut self) -> u8 {
        self.next += 1;
        self.doc.choices[self.next % self.doc.choices.len()]
    }

    fn pos(&self) -> u64 {
        self.e.out.len() as u64
    }

    /// Whitespace between tokens, and comments in JSONC.
    fn gap(&mut self) {
        let c = self.choice();
        let s = match c % 8 {
            0..=2 => "",
            3 => " ",
            4 => "\n",
            5 => "\r\n\t",
            6 if self.doc.jsonc => {
                self.e.jsonc_used = true;
                ["// c,]}\"\n", "/* \"x\" */", "/***/", "/* a\n*b */", "// c\r"][(c / 8 % 5) as usize]
            }
            _ => "  ",
        };
        self.e.out.extend_from_slice(s.as_bytes());
    }

    fn value(&mut self, node: &Node, parent: u32) -> Child {
        let start = self.pos();
        match node {
            Node::Scalar(src, kind) => {
                self.e.out.extend_from_slice(src.as_bytes());
                self.e.jsonc_used |= src.ends_with("NaN") || src.ends_with("Infinity");
                Child { key: None, value: Span { start, end: self.pos() }, kind: *kind, container: None, text: src.clone().into_bytes() }
            }
            Node::Array(items) => self.container(start, parent, Kind::Array, items.iter().map(|n| (None, n)).collect()),
            Node::Object(members) => self.container(start, parent, Kind::Object, members.iter().map(|(k, n)| (Some(k), n)).collect()),
        }
    }

    fn container(&mut self, start: u64, parent: u32, kind: Kind, items: Vec<(Option<&Str>, &Node)>) -> Child {
        let id = self.e.containers.len() as u32;
        let rec = Container { start, end: 0, children: items.len() as u64, parent, kind };
        self.e.containers.push((rec, vec![], vec![]));
        self.e.out.push(if kind == Kind::Object { b'{' } else { b'[' });
        for (i, (key, node)) in items.iter().enumerate() {
            if i > 0 {
                self.gap();
                self.e.out.push(b',');
            }
            self.gap();
            let key = key.map(|(src, val)| {
                let s = self.pos();
                self.e.out.extend_from_slice(src.as_bytes());
                let span = Span { start: s, end: self.pos() };
                self.e.containers[id as usize].2.push(val.clone());
                self.gap();
                self.e.out.push(b':');
                self.gap();
                span
            });
            let mut child = self.value(node, id);
            child.key = key;
            self.e.containers[id as usize].1.push(child);
        }
        if self.doc.jsonc && !items.is_empty() && self.choice() % 4 == 0 {
            self.gap();
            self.e.out.push(b',');
            self.e.jsonc_used = true;
        }
        self.gap();
        self.e.out.push(if kind == Kind::Object { b'}' } else { b']' });
        self.e.containers[id as usize].0.end = self.pos();
        Child { key: None, value: Span { start, end: self.pos() }, kind, container: Some(id), text: vec![] }
    }
}

fn emit(doc: &Doc) -> Emitted {
    let e = Emitted { out: vec![], root: (Kind::Null, Span::default()), containers: vec![], jsonc_used: false };
    let mut em = Emitter { doc, next: 0, e };
    em.gap();
    let root = em.value(&doc.root, NO_PARENT);
    em.gap();
    em.e.root = (root.kind, root.value);
    em.e
}

/// The case's file, deleted when the case ends, passing or failing.
struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp(bytes: &[u8]) -> Temp {
    let path = std::env::temp_dir().join(format!("spike-core-json-spans-{}", std::process::id()));
    std::fs::write(&path, bytes).unwrap();
    Temp(path)
}

fn expected_dups(keys: &[String]) -> Vec<u64> {
    let mut seen = HashSet::new();
    keys.iter().enumerate().filter(|(_, k)| !seen.insert(k.as_str())).map(|(i, _)| i as u64).collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn every_span_matches_the_generator(
        doc in doc(),
        window in 1usize..8,
        cp_children in 1u64..5,
        cp_bytes in 1u64..64,
        picks in prop::collection::vec((any::<u16>(), 1usize..4), 3),
    ) {
        let e = emit(&doc);
        let file = temp(&e.out);
        let store = ByteStore::open(&file.0).unwrap();
        let opts = ScanOptions { jsonc: doc.jsonc, window, cp_children, cp_bytes, ..ScanOptions::default() };
        let idx = scan(&store, 0..store.len(), &opts, &AtomicBool::new(false)).unwrap();
        prop_assert_eq!(idx.error, None);
        prop_assert_eq!(idx.root, Some(e.root));
        let want: Vec<Container> = e.containers.iter().map(|c| c.0).collect();
        let got: Vec<Container> = idx.containers.iter().copied().collect();
        prop_assert_eq!(&got, &want);
        for (id, (_, kids, keys)) in e.containers.iter().enumerate() {
            let id = id as u32;
            prop_assert_eq!(&children(&store, &idx, id, 0, usize::MAX).unwrap(), kids);
            for &(pick, count) in &picks {
                if kids.is_empty() {
                    break;
                }
                let first = pick as usize % kids.len();
                let got = children(&store, &idx, id, first as u64, count).unwrap();
                prop_assert_eq!(&got[..], &kids[first..(first + count).min(kids.len())]);
            }
            if !keys.is_empty() {
                prop_assert_eq!(duplicate_keys(&store, &idx, id, &AtomicBool::new(false)).unwrap(), Some(expected_dups(keys)));
            }
        }
        // Strict JSON accepts exactly the documents that use no JSONC feature, with the same index.
        let strict = scan(&store, 0..store.len(), &ScanOptions { jsonc: false, ..opts }, &AtomicBool::new(false)).unwrap();
        prop_assert_eq!(strict.error.is_none(), !e.jsonc_used);
        if !e.jsonc_used {
            let got: Vec<Container> = strict.containers.iter().copied().collect();
            prop_assert_eq!(&got, &want);
        }
    }
}
```

- [ ] **Step 2: Prove the gate catches an off-by-one at a window edge in enumeration**

Each case's temp file is deleted when the case ends, passing or failing (the gate's own small `Temp` guard: an integration test can't see `store::testutil`).

In `json.rs` (`Cursor::scalar_end`), replace this line:
<!-- op: temporary spikes/core/spike-core/src/json.rs -->
```rust
                    Some(j) => return Ok(self.pos + j as u64),
```
with this one, which ends a number one byte late when its delimiter is the first byte of a refilled window:
```rust
                    Some(j) => return Ok(self.pos + j as u64 + u64::from(j == 0 && self.pos == self.buf_start)),
```
Run (`spikes/core`): `cargo test -p spike-core --test json_spans`
Expected: FAIL. Proptest seeds each run at random, so the document it shrinks to varies; what's fixed is the line, `json_spans.rs:258`, and that a number's span ends one byte late. The replay's run began like this:

```text
Test failed: assertion failed: `(left == right)` 
  left: `[Child { key: None, value: Span { start: 44, end: 65 }, kind: Number, container: None, text: [49, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 93] }]`,
 right: `[Child { key: None, value: Span { start: 44, end: 64 }, kind: Number, container: None, text: [49, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48] }]` at spike-core\tests\json_spans.rs:258.
minimal failing input: doc = Doc {
```

On the lane machine, when the assertion was at line 248, the first case failed and shrank to this:

```text
Test failed: assertion failed: `(left == right)` 
  left: `[Child { key: None, value: Span { start: 1, end: 22 }, kind: Number, container: None, text: [49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 93] }]`,
 right: `[Child { key: None, value: Span { start: 1, end: 21 }, kind: Number, container: None, text: [49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48] }]` at spike-core\tests\json_spans.rs:248.
minimal failing input: doc = Doc {
    jsonc: false,
    root: Array(
        [
            Scalar(
                "12345678901234567890",
                Number,
            ),
        ],
    ),
    choices: [
        0,
    ],
}, window = 1, cp_children = 1, cp_bytes = 1, picks = [
    (
        0,
        1,
    ),
    (
        0,
        1,
    ),
    (
        0,
        1,
    ),
]
```

Restore the file, and delete the seed proptest saved beside the test (don't commit it): `git checkout -- spike-core/src/json.rs`, then `rm spike-core/tests/json_spans.proptest-regressions` (PowerShell: `Remove-Item spike-core/tests/json_spans.proptest-regressions`).

- [ ] **Step 3: Prove the gate catches an off-by-one at a window edge in the index pass**

In `json.rs` (`Scanner::feed`, the `Lex::Between` arm), replace this line:
<!-- op: temporary spikes/core/spike-core/src/json.rs -->
```rust
                        self.token(b, at)?;
```
with this one, which records a closing bracket one byte late when it is the first byte of a fed window:
```rust
                        self.token(b, at + u64::from(i == 1 && matches!(b, b']' | b'}')))?;
```
Run (`spikes/core`): `cargo test -p spike-core --test json_spans`
Expected: FAIL at `json_spans.rs:252`, with the root container's `end` one byte past the generator's. Proptest seeds each run at random, so the document it shrinks to varies: the replay's began like this:

```text
Test failed: assertion failed: `(left == right)` 
  left: `Some((Array, Span { start: 0, end: 22 }))`,
 right: `Some((Array, Span { start: 0, end: 21 }))` at spike-core\tests\json_spans.rs:252.
minimal failing input: doc = Doc {
```

The lane's run, when the assertion was at line 242, shrank to a one-element array:

```text
Test failed: assertion failed: `(left == right)` 
  left: `Some((Array, Span { start: 0, end: 5 }))`,
 right: `Some((Array, Span { start: 0, end: 4 }))` at spike-core\tests\json_spans.rs:242.
minimal failing input: doc = Doc {
    jsonc: false,
    root: Array(
        [
            Scalar(
                "\"\"",
                String,
            ),
        ],
    ),
    choices: [
        0,
    ],
}, window = 1, cp_children = 1, cp_bytes = 1, picks = [
    (
        0,
        1,
    ),
    (
        0,
        1,
    ),
    (
        0,
        1,
    ),
]
```

Restore the file and delete the saved seed again: `git checkout -- spike-core/src/json.rs`, then `rm spike-core/tests/json_spans.proptest-regressions` (PowerShell: `Remove-Item spike-core/tests/json_spans.proptest-regressions`).

- [ ] **Step 4: Run the gate**

Run (`spikes/core`): `cargo test -p spike-core --test json_spans`
Expected: `1 passed`. It took 62–72 s in a debug build on the lane machine. Zero mismatches across 10,000 cases is the §13.1 gate.

Then run (`spikes/core`): `cargo test -p spike-core`
Expected: `63 passed; 0 failed; 1 ignored` for the unit tests, then `1 passed` for `tests\json_spans.rs`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/tests/json_spans.rs
git commit -m "spike(c): span-fidelity gate over 10,000 generated JSON/JSONC documents"
```

---

## Task C2c: Benchmark against jiter and struson, and the scanner decision

**Files:**
- Modify: `spikes/core/fixtures-gen/src/lib.rs` (`json_doc` and its test)
- Modify: `spikes/core/fixtures-gen/src/main.rs` (the `json` subcommand)
- Modify: `spikes/core/spike-core/Cargo.toml` (dev-dependencies)
- Create: `spikes/core/spike-core/examples/json_bench.rs`
- Create: `spikes/results/json-bench.txt` (written by the benchmark)

**Interfaces:**
- **Consumes:**
  - Task C2a's API;
  - `jiter` 0.17 (`Jiter`, `Peek`);
  - `struson` 0.7 (`JsonStreamReader`, `ReaderSettings`, `ValueType`, the `JsonReader` trait);
  - `windows-sys` 0.61 (`GetProcessMemoryInfo`, `GetCurrentProcess`) for the peak working set.
- **Produces:**
  - `fixtures_gen::json_doc<W: Write>(w: &mut W, shape: &str, target_bytes: u64) -> io::Result<u64>`. It writes at least `target_bytes` and returns the element count. The shapes are:
    - `records`: an array of ~190-byte objects, like `jsonl` lines joined;
    - `wide`: one object, with every 100,000th key repeating key 0;
    - `deep`: an array of records nested 1,000 levels;
    - `numbers`.

    Any other shape is `ErrorKind::InvalidInput`.
  - CLI: `fixtures-gen json --shape <records|wide|deep|numbers> --bytes N --out <path>`.
  - `json_bench` (an example, so release-built and never shipped):
    - `<file> <typose|jiter|struson> [runs]` builds the same container index with one contender, n runs after one warm-up;
    - `<file> dups` runs `duplicate_keys` over every object;
    - `<file> cancel` takes 20 real cancels, the flag set at moments spread over the first 76% of a warm full scan. A run that finishes before the flag measures nothing: it's dropped and retried, and fewer than 20 real cancels in 100 runs is an error;
    - `--probes` runs the requirement probes;
    - `--all <fixtures-dir> <out-file>` runs all of the above, each contender in its own process, and writes the output to `<out-file>`.

**Dependency decision:** `jiter`, `struson` and the extra `windows-sys` features are **dev-dependencies**: only examples and tests see them. `cargo tree -p spike-core -e normal` lists neither `jiter` nor `struson`, so the production dependency set is unchanged.

- [ ] **Step 1: Write the failing test**

In `spikes/core/fixtures-gen/src/lib.rs`, add inside `mod tests`, below `huge_record_has_the_requested_payload` (leave one blank line between the two tests):
<!-- op: append-in-module spikes/core/fixtures-gen/src/lib.rs -->
```rust
    #[test]
    fn json_docs_reach_the_target_and_count_their_elements() {
        for shape in ["records", "wide", "deep", "numbers"] {
            let mut out = Vec::new();
            let n = json_doc(&mut out, shape, 100_000).unwrap();
            assert!(out.len() >= 100_000, "{shape}");
            assert_eq!(out.windows(2).filter(|w| w == b",\n").count() as u64 + 1, n, "{shape}");
            let (open, close): (&[u8], &[u8]) = if shape == "wide" { (b"{\n", b"\n}\n") } else { (b"[\n", b"\n]\n") };
            assert!(out.starts_with(open) && out.ends_with(close), "{shape}");
        }
        assert!(json_doc(&mut Vec::new(), "nope", 1).is_err());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: FAIL with ``error[E0425]: cannot find function `json_doc` in this scope`` (2 errors).

- [ ] **Step 3: Implement the generator and the subcommand**

In `src/lib.rs`, add below the `huge_record` function (one blank line after its closing brace):
<!-- op: insert-before spikes/core/fixtures-gen/src/lib.rs :: #[cfg(test)] -->
```rust
const NUMBERS: [&str; 10] =
    ["12345678901234567890", "3.10", "-0", "1e400", "0.000123", "-42", "6.02214076e23", "0", "-1.5E-7", "9007199254740993"];

/// A JSON document of at least `target_bytes` for the Spike C scanner benchmark; returns its element count.
/// Shapes: `records` (an array of ~190-byte objects, like `jsonl` lines joined), `wide` (one object, every
/// 100,000th key repeating key 0), `deep` (an array of records nested 1,000 levels) and `numbers`.
pub fn json_doc<W: Write>(w: &mut W, shape: &str, target_bytes: u64) -> io::Result<u64> {
    if !["records", "wide", "deep", "numbers"].contains(&shape) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unknown shape {shape}")));
    }
    let deep = format!("{}1{}", "{\"a\":[".repeat(500), "]}".repeat(500));
    let pad = "x".repeat(100);
    let (open, close): (&[u8], &[u8]) = if shape == "wide" { (b"{\n", b"\n}\n") } else { (b"[\n", b"\n]\n") };
    w.write_all(open)?;
    let (mut written, mut n) = (open.len() as u64, 0u64);
    while written < target_bytes {
        let item = match shape {
            "records" => format!(
                "{{\"id\":{n},\"ts\":\"2026-10-20T12:{:02}:{:02}.{:03}Z\",\"type\":\"{}\",\"msg\":\"line {n:010} {pad}\"}}",
                (n / 60_000) % 60,
                (n / 1000) % 60,
                n % 1000,
                TYPES[(n % 4) as usize]
            ),
            "wide" => format!("\"key_{:09}\":{}", if n % 100_000 == 99_999 { 0 } else { n }, ["1", "\"v\"", "true", "null"][(n % 4) as usize]),
            "deep" => deep.clone(),
            _ => NUMBERS[(n % 10) as usize].to_string(),
        };
        let sep: &[u8] = if n == 0 { b"" } else { b",\n" };
        w.write_all(sep)?;
        w.write_all(item.as_bytes())?;
        written += (sep.len() + item.len()) as u64;
        n += 1;
    }
    w.write_all(close)?;
    Ok(n)
}
```
In `src/main.rs`, add this arm above `other => panic!("unknown fixture kind {other:?}"),`:
<!-- op: insert-adjacent-before spikes/core/fixtures-gen/src/main.rs :: other => panic! -->
```rust
        Some("json") => {
            let shape = flag("--shape").unwrap_or_else(|| "records".into());
            let n = fixtures_gen::json_doc(&mut w, &shape, num("--bytes", 1 << 30))?;
            eprintln!("{out}: {n} elements ({shape})");
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: `3 passed`. Plan A's two tests are unchanged.

- [ ] **Step 5: Generate the four benchmark fixtures (≈ 1.4 GB)**

Run (`spikes/core`):
```bash
cargo run --release -p fixtures-gen -- json --shape records --bytes 1073741824 --out ../.fixtures/records-1g.json
cargo run --release -p fixtures-gen -- json --shape wide --bytes 104857600 --out ../.fixtures/wide-100m.json
cargo run --release -p fixtures-gen -- json --shape deep --bytes 104857600 --out ../.fixtures/deep-100m.json
cargo run --release -p fixtures-gen -- json --shape numbers --bytes 104857600 --out ../.fixtures/numbers-100m.json
```
Expected:
- `../.fixtures/records-1g.json: 5740203 elements (records)`
- `../.fixtures/wide-100m.json: 4993220 elements (wide)`
- `../.fixtures/deep-100m.json: 26195 elements (deep)`
- `../.fixtures/numbers-100m.json: 10591677 elements (numbers)`

- [ ] **Step 6: Add the dev-dependencies and the benchmark**

In `spikes/core/spike-core/Cargo.toml`, add `jiter` and `struson` to `[dev-dependencies]`, and two features to the Windows dev-dependency table Task C1d added. Replace
<!-- op: replace spikes/core/spike-core/Cargo.toml -->
```toml
[dev-dependencies]
proptest = "1.12"

[target.'cfg(windows)'.dev-dependencies]
windows-sys = { version = "0.61", features = ["Win32_System_IO", "Win32_System_Ioctl"] }
```
with
```toml
[dev-dependencies]
proptest = "1.12"
jiter = "0.17"
struson = "0.7"

[target.'cfg(windows)'.dev-dependencies]
windows-sys = { version = "0.61", features = ["Win32_System_IO", "Win32_System_Ioctl", "Win32_System_ProcessStatus", "Win32_System_Threading"] }
```
`spikes/core/spike-core/examples/json_bench.rs`:
<!-- op: create spikes/core/spike-core/examples/json_bench.rs -->
```rust
//! Spike C scanner benchmark (spec §4.3): the hand-written scanner against jiter and struson, each building the
//! same container index (every object and array: start, end, child count). One contender per process, so the
//! peak working set printed at the end is that contender's own.
//!
//!   cargo run --release -p spike-core --example json_bench -- <file> <typose|jiter|struson|dups|cancel> [runs]
//!   cargo run --release -p spike-core --example json_bench -- --probes
//!   cargo run --release -p spike-core --example json_bench -- --all <fixtures-dir> <out-file>
use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use jiter::{Jiter, Peek};
use spike_core::json::{children, duplicate_keys, scan, JsonIndex, Kind, ScanOptions};
use spike_core::store::ByteStore;
use struson::reader::{JsonReader, JsonStreamReader, ReaderSettings, ValueType};

/// Containers in document order as (start, end, children).
type Recs = Vec<[u64; 3]>;

/// Count, total children and an order-sensitive hash of every container: equal lines mean equal indexes.
fn summary(recs: impl Iterator<Item = [u64; 3]>) -> String {
    let (mut n, mut kids, mut h) = (0u64, 0u64, 0xcbf2_9ce4_8422_2325u64);
    for [s, e, c] in recs {
        n += 1;
        kids += c;
        for v in [s, e, c] {
            h = (h ^ v).wrapping_mul(0x100_0000_01b3);
        }
    }
    format!("containers={n} children={kids} hash={h:016x}")
}

fn typose_index(path: &Path) -> Result<(ByteStore, JsonIndex), String> {
    let store = ByteStore::open(path).map_err(|e| e.to_string())?;
    let idx = scan(&store, 0..store.len(), &ScanOptions::default(), &AtomicBool::new(false)).map_err(|e| e.to_string())?;
    match idx.error {
        Some(e) => Err(format!("{e:?}")),
        None => Ok((store, idx)),
    }
}

/// jiter's pull API driven by an explicit stack (its own `next_skip` recurses with a depth limit of 200).
fn jiter_index(data: &[u8]) -> Result<Recs, String> {
    let err = |e: jiter::JiterError| e.to_string();
    let mut j = Jiter::new(data).with_allow_inf_nan();
    let (mut recs, mut stack): (Recs, Vec<(usize, bool)>) = (Vec::new(), Vec::new());
    let mut value = Some(j.peek().map_err(err)?);
    loop {
        if let Some(peek) = value.take() {
            let start = j.current_index() as u64;
            match peek {
                Peek::Array | Peek::Object => {
                    let object = peek == Peek::Object;
                    recs.push([start, 0, 0]);
                    stack.push((recs.len() - 1, object));
                    let first = if object {
                        match j.next_object_bytes().map_err(err)? {
                            Some(_) => Some(j.peek().map_err(err)?),
                            None => None,
                        }
                    } else {
                        j.known_array().map_err(err)?
                    };
                    if let Some(p) = first {
                        recs[stack[stack.len() - 1].0][2] += 1;
                        value = Some(p);
                        continue;
                    }
                    let (id, _) = stack.pop().ok_or("stack")?;
                    recs[id][1] = j.current_index() as u64;
                }
                Peek::String => drop(j.known_bytes().map_err(err)?),
                Peek::True | Peek::False => drop(j.known_bool(peek).map_err(err)?),
                Peek::Null => j.known_null().map_err(err)?,
                _ => drop(j.known_number_bytes(peek).map_err(err)?),
            }
        }
        let Some(&(id, object)) = stack.last() else {
            j.finish().map_err(err)?;
            return Ok(recs);
        };
        let next = if object {
            match j.next_key_bytes().map_err(err)? {
                Some(_) => Some(j.peek().map_err(err)?),
                None => None,
            }
        } else {
            j.array_step().map_err(err)?
        };
        match next {
            Some(p) => {
                recs[id][2] += 1;
                value = Some(p);
            }
            None => {
                stack.pop();
                recs[id][1] = j.current_index() as u64;
            }
        }
    }
}

fn struson_settings(jsonc: bool) -> ReaderSettings {
    ReaderSettings {
        allow_comments: jsonc,
        allow_trailing_comma: jsonc,
        track_path: false,
        max_nesting_depth: None,
        restrict_number_values: false,
        ..ReaderSettings::default()
    }
}

/// struson streaming over any reader; spans come from `current_position().data_pos`.
fn struson_index(read: impl Read, jsonc: bool) -> Result<Recs, String> {
    let err = |e: struson::reader::ReaderError| e.to_string();
    let mut r = JsonStreamReader::new_custom(read, struson_settings(jsonc));
    let (mut recs, mut stack): (Recs, Vec<(usize, bool)>) = (Vec::new(), Vec::new());
    loop {
        let t = r.peek().map_err(err)?;
        let start = r.current_position(false).data_pos.unwrap_or(u64::MAX);
        match t {
            ValueType::Array | ValueType::Object => {
                if t == ValueType::Array { r.begin_array() } else { r.begin_object() }.map_err(err)?;
                recs.push([start, 0, 0]);
                stack.push((recs.len() - 1, t == ValueType::Object));
            }
            ValueType::Number => drop(r.next_number_as_str().map_err(err)?),
            _ => r.skip_value().map_err(err)?,
        }
        loop {
            let Some(&(id, object)) = stack.last() else {
                r.consume_trailing_whitespace().map_err(err)?;
                return Ok(recs);
            };
            if r.has_next().map_err(err)? {
                if object {
                    r.skip_name().map_err(err)?;
                }
                recs[id][2] += 1;
                break;
            }
            if object { r.end_object() } else { r.end_array() }.map_err(err)?;
            recs[id][1] = r.current_position(false).data_pos.unwrap_or(u64::MAX);
            stack.pop();
        }
    }
}

#[cfg(windows)]
fn peak_working_set_mb() -> f64 {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut c: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    c.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    c.PeakWorkingSetSize as f64 / (1u64 << 20) as f64
}

#[cfg(not(windows))]
fn peak_working_set_mb() -> f64 {
    f64::NAN
}

fn gbps(bytes: u64, secs: f64) -> f64 {
    bytes as f64 / secs / 1e9
}

/// p50, min and max of the per-run throughputs.
fn stats(mut v: Vec<f64>) -> String {
    v.sort_by(f64::total_cmp);
    format!("n={} p50 {:.3} GB/s, min {:.3}, max {:.3}", v.len(), v[v.len() / 2], v[0], v[v.len() - 1])
}

fn bench(path: &Path, who: &str, runs: usize) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let (mut walk, mut total, mut line) = (Vec::new(), Vec::new(), String::new());
    for run in 0..=runs {
        let t = Instant::now();
        match who {
            "typose" => {
                let (store, idx) = typose_index(path)?;
                let secs = t.elapsed().as_secs_f64();
                if run == runs {
                    let mid = idx.containers[0].children / 2;
                    let t = Instant::now();
                    let page = children(&store, &idx, 0, mid, 100).map_err(|e| e.to_string())?;
                    let page_us = t.elapsed().as_micros();
                    line = format!(
                        "{} | index {:.1} MB, {} checkpoints, {} long scalars | children(root, {mid}, 100) = {} in {page_us} µs",
                        summary(idx.containers.iter().map(|c| [c.start, c.end, c.children])),
                        idx.heap_bytes() as f64 / 1e6,
                        idx.checkpoints.len(),
                        idx.long_scalars.len(),
                        page.len()
                    );
                }
                if run > 0 {
                    (walk.push(gbps(len, secs)), total.push(gbps(len, secs)));
                }
            }
            "jiter" => {
                let data = std::fs::read(path).map_err(|e| e.to_string())?;
                let read_secs = t.elapsed().as_secs_f64();
                let w = Instant::now();
                let recs = jiter_index(&data)?;
                let walk_secs = w.elapsed().as_secs_f64();
                if run > 0 {
                    walk.push(gbps(len, walk_secs));
                    total.push(gbps(len, read_secs + walk_secs));
                }
                line = summary(recs.into_iter());
            }
            "struson" => {
                let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
                let recs = struson_index(std::io::BufReader::with_capacity(1 << 20, file), true)?;
                if run > 0 {
                    let secs = t.elapsed().as_secs_f64();
                    (walk.push(gbps(len, secs)), total.push(gbps(len, secs)));
                }
                line = summary(recs.into_iter());
            }
            other => return Err(format!("unknown contender {other}")),
        }
    }
    println!("{who:8} {name}: walk {}", stats(walk));
    println!("{who:8} {name}: read+walk {}", stats(total));
    println!("{who:8} {name}: {line}");
    println!("{who:8} {name}: peak working set {:.0} MB", peak_working_set_mb());
    Ok(())
}

/// Duplicate-key detection over every object in the file, as one pass after the scan. It re-tokenizes every
/// object, so it is an upper bound on what detecting duplicates inside the index pass would add.
fn dups(path: &Path) -> Result<(), String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let t = Instant::now();
    let (store, idx) = typose_index(path)?;
    let scan_secs = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let (mut objects, mut keys, mut found) = (0u64, 0u64, 0usize);
    for (id, c) in idx.containers.iter().enumerate() {
        if c.kind == Kind::Object {
            objects += 1;
            keys += c.children;
            found += duplicate_keys(&store, &idx, id as u32, &AtomicBool::new(false)).map_err(|e| e.to_string())?.map_or(0, |d| d.len());
        }
    }
    let dup_secs = t.elapsed().as_secs_f64();
    println!(
        "dups     {}: scan {scan_secs:.3} s ({:.3} GB/s); duplicate_keys over {objects} objects / {keys} keys: {dup_secs:.3} s \
         ({:.0} ns/key), {found} duplicates; peak working set {:.0} MB",
        path.display(),
        gbps(len, scan_secs),
        dup_secs * 1e9 / keys.max(1) as f64,
        peak_working_set_mb()
    );
    Ok(())
}

/// Cancel latency on a real fixture over 20 real cancels, the flag set at moments spread over the first 76% of the
/// warm full scan. A run that finishes before the flag measures nothing: it's dropped and retried, up to 100 runs.
fn cancel_latency(path: &Path) -> Result<(), String> {
    use spike_core::json::ErrorKind;
    use std::sync::Arc;
    use std::time::Duration;
    let store = Arc::new(ByteStore::open(path).map_err(|e| e.to_string())?);
    let mut full = Duration::ZERO;
    for _ in 0..2 {
        let t = Instant::now(); // the second scan is warm
        scan(&store, 0..store.len(), &ScanOptions::default(), &AtomicBool::new(false)).map_err(|e| e.to_string())?;
        full = t.elapsed();
    }
    let (mut worst, mut real, mut run) = (Duration::ZERO, 0, 0u32);
    while real < 20 {
        if run == 100 {
            return Err(format!("cancel: {real} real cancels in 100 runs (warm full scan {full:?})"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let (s, c) = (store.clone(), cancel.clone());
        let worker = std::thread::spawn(move || {
            let idx = scan(&s, 0..s.len(), &ScanOptions::default(), &c);
            let returned = Instant::now();
            let idx = idx.map(|i| (i.error.map(|e| e.kind), i.containers.len())); // drops the index
            (idx, returned, returned.elapsed())
        });
        std::thread::sleep(full * (run % 20) / 25);
        let set = Instant::now();
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        let (idx, returned, dropped) = worker.join().map_err(|_| "worker panicked")?;
        let (kind, containers) = idx.map_err(|e| e.to_string())?;
        let latency = returned.saturating_duration_since(set);
        let cancelled = kind == Some(ErrorKind::Cancelled);
        if cancelled {
            (real, worst) = (real + 1, worst.max(latency));
        }
        let note = if cancelled { "" } else { " (finished before the flag: dropped)" };
        println!("cancel   run {run:2}: {kind:?} after {containers} containers, latency {latency:?}, then drop {dropped:?}{note}");
        run += 1;
    }
    println!("cancel   {}: warm full scan {full:?}; n_real=20 of {run} runs; max latency {worst:?}", path.display());
    Ok(())
}

/// One small document per requirement, run through all three; prints what each returned.
fn probes() -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("json-bench-probes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let typose_on = |name: &str, src: &[u8]| -> Result<(ByteStore, JsonIndex), String> {
        let path = dir.join(name);
        std::fs::write(&path, src).map_err(|e| e.to_string())?;
        let store = ByteStore::open(&path).map_err(|e| e.to_string())?;
        let idx = scan(&store, 0..store.len(), &ScanOptions::default(), &AtomicBool::new(false)).map_err(|e| e.to_string())?;
        Ok((store, idx))
    };
    let show = |r: Result<Recs, String>| match r {
        Ok(recs) => format!("{recs:?}"),
        Err(e) => format!("error: {e}"),
    };

    println!("## spans: container (start, end, children) on {{\"a\": [1, \"x\"], \"b\": {{\"c\": null}}}}");
    let src = br#"{"a": [1, "x"], "b": {"c": null}}"#;
    let (_, idx) = typose_on("spans", src)?;
    println!("typose  {:?}", idx.containers.iter().map(|c| [c.start, c.end, c.children]).collect::<Vec<_>>());
    println!("jiter   {}", show(jiter_index(src)));
    println!("struson {}", show(struson_index(&src[..], false)));

    println!("## verbatim numbers on [12345678901234567890, 3.10, -0, 1e400]");
    let src = b"[12345678901234567890, 3.10, -0, 1e400]";
    let (store, idx) = typose_on("numbers", src)?;
    let texts: Vec<String> =
        children(&store, &idx, 0, 0, 10).map_err(|e| e.to_string())?.into_iter().map(|c| String::from_utf8_lossy(&c.text).into_owned()).collect();
    println!("typose  {texts:?}");
    let mut j = Jiter::new(src);
    let mut got = Vec::new();
    let mut next = j.next_array().map_err(|e| e.to_string())?;
    while let Some(p) = next {
        got.push(String::from_utf8_lossy(j.known_number_bytes(p).map_err(|e| e.to_string())?).into_owned());
        next = j.array_step().map_err(|e| e.to_string())?;
    }
    println!("jiter   {got:?} (known_number_bytes)");
    let mut r = JsonStreamReader::new_custom(&src[..], struson_settings(false));
    let mut got = Vec::new();
    r.begin_array().map_err(|e| e.to_string())?;
    while r.has_next().map_err(|e| e.to_string())? {
        got.push(r.next_number_as_str().map_err(|e| e.to_string())?.to_string());
    }
    println!("struson {got:?} (next_number_as_str)");

    println!("## JSONC on [1, /* c */ 2, // x\\n 3,]");
    let src = b"[1, /* c */ 2, // x\n 3,]";
    let (_, idx) = typose_on("jsonc", src)?;
    println!("typose  error={:?} trivia={:?} children={}", idx.error, idx.trivia, idx.containers[0].children);
    println!("jiter   {}", show(jiter_index(src)));
    println!("struson {} (allow_comments + allow_trailing_comma)", show(struson_index(&src[..], true)));

    println!("## duplicate keys on {{\"a\":1,\"a\":2}}");
    let src = br#"{"a":1,"a":2}"#;
    let (store, idx) = typose_on("dups", src)?;
    println!(
        "typose  children={} duplicate_keys={:?}",
        children(&store, &idx, 0, 0, 10).map_err(|e| e.to_string())?.len(),
        duplicate_keys(&store, &idx, 0, &AtomicBool::new(false)).map_err(|e| e.to_string())?
    );
    let mut j = Jiter::new(src);
    let mut keys = Vec::new();
    let mut key = j.next_object_bytes().map_err(|e| e.to_string())?.map(|k| k.to_vec());
    while let Some(k) = key {
        keys.push(String::from_utf8_lossy(&k).into_owned());
        j.next_skip().map_err(|e| e.to_string())?;
        key = j.next_key_bytes().map_err(|e| e.to_string())?.map(|k| k.to_vec());
    }
    println!("jiter   keys seen {keys:?}");
    let mut r = JsonStreamReader::new_custom(&src[..], struson_settings(false));
    let mut keys = Vec::new();
    r.begin_object().map_err(|e| e.to_string())?;
    while r.has_next().map_err(|e| e.to_string())? {
        keys.push(r.next_name_owned().map_err(|e| e.to_string())?);
        r.skip_value().map_err(|e| e.to_string())?;
    }
    println!("struson keys seen {keys:?}");

    println!("## mid-array enumeration from element 5's offset on [10, 11, …, 19] (offset from the typose index)");
    let src = b"[10, 11, 12, 13, 14, 15, 16, 17, 18, 19]";
    let (store, idx) = typose_on("mid", src)?;
    let kids = children(&store, &idx, 0, 5, 5).map_err(|e| e.to_string())?;
    let off = kids[0].value.start as usize;
    println!("typose  {:?}", kids.iter().map(|c| String::from_utf8_lossy(&c.text).into_owned()).collect::<Vec<_>>());
    let mut j = Jiter::new(&src[off..]);
    let mut got = Vec::new();
    let mut next = Some(j.peek().map_err(|e| e.to_string())?);
    while let Some(p) = next {
        got.push(String::from_utf8_lossy(j.known_number_bytes(p).map_err(|e| e.to_string())?).into_owned());
        next = j.array_step().map_err(|e| e.to_string())?;
    }
    println!("jiter   {got:?} (fresh Jiter over data[{off}..], array_step)");
    let mut r = JsonStreamReader::new_custom(b"[".chain(&src[off..]), struson_settings(false));
    let mut got = Vec::new();
    r.begin_array().map_err(|e| e.to_string())?;
    while r.has_next().map_err(|e| e.to_string())? {
        got.push(r.next_number_as_str().map_err(|e| e.to_string())?.to_string());
    }
    println!("struson {got:?} (reader over \"[\" + data[{off}..])");

    println!("## invalid UTF-8 inside a string on [\"\\xff\", 1] (spec §4.1: a counted problem, not a parse failure)");
    let src = b"[\"\xff\", 1]";
    let (_, idx) = typose_on("utf8", src)?;
    println!("typose  error={:?} children={}", idx.error, idx.containers[0].children);
    println!("jiter   {}", show(jiter_index(src)));
    println!("struson {}", show(struson_index(&src[..], false)));

    println!("## error position on {{\"a\": [1, 2,, 3]}} (truth: offset 12)");
    let src = br#"{"a": [1, 2,, 3]}"#;
    let (_, idx) = typose_on("error", src)?;
    println!("typose  {:?}", idx.error);
    println!("jiter   {}", show(jiter_index(src)));
    println!("struson {}", show(struson_index(&src[..], false)));
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// Every measurement, each in its own child process so peak working sets don't mix; output also goes to `out`.
fn all(fixtures: &Path, out: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let file = |name: &str| fixtures.join(format!("{name}.json")).display().to_string();
    let mut runs: Vec<Vec<String>> = vec![vec!["--probes".into()]];
    for f in ["records-1g", "wide-100m", "deep-100m", "numbers-100m"] {
        for who in ["typose", "jiter", "struson"] {
            runs.push(vec![file(f), who.into(), "5".into()]);
        }
    }
    runs.push(vec![file("wide-100m"), "dups".into()]);
    runs.push(vec![file("records-1g"), "dups".into()]);
    runs.push(vec![file("deep-100m"), "cancel".into()]);
    let mut log = String::new();
    for args in runs {
        let o = std::process::Command::new(&exe).args(&args).output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr);
        print!("{text}");
        log.push_str(&text);
        if !o.status.success() {
            return Err(format!("json_bench {} failed", args.join(" ")));
        }
    }
    std::fs::write(out, log).map_err(|e| e.to_string())
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [p] if p == "--probes" => probes(),
        [flag, dir, out] if flag == "--all" => all(Path::new(dir), Path::new(out)),
        [file, who] if who == "dups" => dups(Path::new(file)),
        [file, who] if who == "cancel" => cancel_latency(Path::new(file)),
        [file, who, rest @ ..] => bench(Path::new(file), who, rest.first().and_then(|r| r.parse().ok()).unwrap_or(5)),
        _ => Err("usage: json_bench <file> <typose|jiter|struson|dups|cancel> [runs] | --probes | --all <dir> <out>".into()),
    }
}
```
Run (`spikes/core`): `cargo build --release -p spike-core --example json_bench`
Expected: it builds with no warnings. Then run `cargo tree -p spike-core -e normal`; its output must contain neither `jiter` nor `struson`.

- [ ] **Step 7: Run every measurement**

Run (`spikes/core`): `cargo run --release -q -p spike-core --example json_bench -- --all ../.fixtures ../results/json-bench.txt`
It takes about 70 s (64 s, 69 s and 70 s on the lane machine). Expected, checked in this order:
1. **Probes.** Every probe prints the same as on the lane machine (below). Only jiter fails JSONC, and only struson fails on invalid UTF-8.
2. **Equal indexes.** For each fixture, the three `containers=… children=… hash=…` lines are identical, so all three contenders built the same index.
3. **The numbers.** They follow; record yours. A `cancel` run that finished before the flag prints `(finished before the flag: dropped)` and isn't counted; the summary line names how many runs it took to get 20 real cancels.

On the lane machine (warm, n=5 after one warm-up, p50 / min / max of per-run GB/s; peak working set per process):

| Fixture | typose: scan over `ByteStore` | jiter: read+walk (walk only) | struson | Peak working set: typose / jiter / struson |
|---|---|---|---|---|
| `records-1g` (1.07 GB, 5.74M containers) | 1.019 (min 0.948, max 1.022) | 1.269 (2.162) | 0.344 | 247 / 1,222 / 199 MB |
| `wide-100m` (1 object, 4.99M keys) | 0.784 (0.747, 0.790) | 0.960 (1.315) | 0.288 | 70 / 105 / 6 MB |
| `deep-100m` (26.2M containers) | 0.161 (0.138, 0.166) | 0.228 (0.247) | 0.075 | 872 / 874 / 775 MB |
| `numbers-100m` (10.6M numbers) | 0.509 (0.472, 0.519) | 0.823 (1.061) | 0.163 | 71 / 105 / 6 MB |

Notes on the table:
- The typose figures include positional reads and xxh3 verification of every chunk.
- jiter's read is one `std::fs::read`, with no verification.
- typose's peak includes the 64 MiB chunk cache.
- `children(root, middle, 100)` took 475 µs, 45 µs, 408 µs and 43 µs on the four fixtures.

The full output on the lane machine. Its 21 `cancel` lines are this plan's replay, because the instrument changed after the lane ran (it counts only real cancels now):

```text
## spans: container (start, end, children) on {"a": [1, "x"], "b": {"c": null}}
typose  [[0, 33, 2], [6, 14, 2], [21, 32, 1]]
jiter   [[0, 33, 2], [6, 14, 2], [21, 32, 1]]
struson [[0, 33, 2], [6, 14, 2], [21, 32, 1]]
## verbatim numbers on [12345678901234567890, 3.10, -0, 1e400]
typose  ["12345678901234567890", "3.10", "-0", "1e400"]
jiter   ["12345678901234567890", "3.10", "-0", "1e400"] (known_number_bytes)
struson ["12345678901234567890", "3.10", "-0", "1e400"] (next_number_as_str)
## JSONC on [1, /* c */ 2, // x\n 3,]
typose  error=None trivia=Trivia { comments: 2, trailing_commas: 1, nonfinite: 0 } children=3
jiter   error: expected value at index 4
struson [[0, 24, 3]] (allow_comments + allow_trailing_comma)
## duplicate keys on {"a":1,"a":2}
typose  children=2 duplicate_keys=Some([1])
jiter   keys seen ["a", "a"]
struson keys seen ["a", "a"]
## mid-array enumeration from element 5's offset on [10, 11, …, 19] (offset from the typose index)
typose  ["15", "16", "17", "18", "19"]
jiter   ["15", "16", "17", "18", "19"] (fresh Jiter over data[21..], array_step)
struson ["15", "16", "17", "18", "19"] (reader over "[" + data[21..])
## invalid UTF-8 inside a string on ["\xff", 1] (spec §4.1: a counted problem, not a parse failure)
typose  error=None children=2
jiter   [[0, 8, 2]]
struson error: IO error 'invalid UTF-8 data' at (roughly) line 0, column 2 (data pos 2)
## error position on {"a": [1, 2,, 3]} (truth: offset 12)
typose  Some(ScanError { kind: Syntax("expected a value"), offset: 12, line: 1, column: 13 })
jiter   error: expected value at index 12
struson error: syntax error: JSON syntax error UnexpectedComma at line 0, column 12 (data pos 12)
typose   records-1g.json: walk n=5 p50 1.019 GB/s, min 0.948, max 1.022
typose   records-1g.json: read+walk n=5 p50 1.019 GB/s, min 0.948, max 1.022
typose   records-1g.json: containers=5740204 children=28701015 hash=9945351654860c4a | index 183.9 MB, 5605 checkpoints, 0 long scalars | children(root, 2870101, 100) = 100 in 475 µs
typose   records-1g.json: peak working set 247 MB
jiter    records-1g.json: walk n=5 p50 2.162 GB/s, min 2.111, max 2.274
jiter    records-1g.json: read+walk n=5 p50 1.269 GB/s, min 1.238, max 1.337
jiter    records-1g.json: containers=5740204 children=28701015 hash=9945351654860c4a
jiter    records-1g.json: peak working set 1222 MB
struson  records-1g.json: walk n=5 p50 0.344 GB/s, min 0.276, max 0.362
struson  records-1g.json: read+walk n=5 p50 0.344 GB/s, min 0.276, max 0.362
struson  records-1g.json: containers=5740204 children=28701015 hash=9945351654860c4a
struson  records-1g.json: peak working set 199 MB
typose   wide-100m.json: walk n=5 p50 0.784 GB/s, min 0.747, max 0.790
typose   wide-100m.json: read+walk n=5 p50 0.784 GB/s, min 0.747, max 0.790
typose   wide-100m.json: containers=1 children=4993220 hash=9532017ea654d43d | index 0.2 MB, 4876 checkpoints, 0 long scalars | children(root, 2496610, 100) = 100 in 45 µs
typose   wide-100m.json: peak working set 70 MB
jiter    wide-100m.json: walk n=5 p50 1.315 GB/s, min 1.262, max 1.350
jiter    wide-100m.json: read+walk n=5 p50 0.960 GB/s, min 0.897, max 0.975
jiter    wide-100m.json: containers=1 children=4993220 hash=9532017ea654d43d
jiter    wide-100m.json: peak working set 105 MB
struson  wide-100m.json: walk n=5 p50 0.288 GB/s, min 0.285, max 0.293
struson  wide-100m.json: read+walk n=5 p50 0.288 GB/s, min 0.285, max 0.293
struson  wide-100m.json: containers=1 children=4993220 hash=9532017ea654d43d
struson  wide-100m.json: peak working set 6 MB
typose   deep-100m.json: walk n=5 p50 0.161 GB/s, min 0.138, max 0.166
typose   deep-100m.json: read+walk n=5 p50 0.161 GB/s, min 0.138, max 0.166
typose   deep-100m.json: containers=26195001 children=26221195 hash=5c0acdf1d58b402d | index 838.3 MB, 99 checkpoints, 0 long scalars | children(root, 13097, 100) = 100 in 408 µs
typose   deep-100m.json: peak working set 872 MB
jiter    deep-100m.json: walk n=5 p50 0.247 GB/s, min 0.245, max 0.249
jiter    deep-100m.json: read+walk n=5 p50 0.228 GB/s, min 0.226, max 0.230
jiter    deep-100m.json: containers=26195001 children=26221195 hash=5c0acdf1d58b402d
jiter    deep-100m.json: peak working set 874 MB
struson  deep-100m.json: walk n=5 p50 0.075 GB/s, min 0.073, max 0.076
struson  deep-100m.json: read+walk n=5 p50 0.075 GB/s, min 0.073, max 0.076
struson  deep-100m.json: containers=26195001 children=26221195 hash=5c0acdf1d58b402d
struson  deep-100m.json: peak working set 775 MB
typose   numbers-100m.json: walk n=5 p50 0.509 GB/s, min 0.472, max 0.519
typose   numbers-100m.json: read+walk n=5 p50 0.509 GB/s, min 0.472, max 0.519
typose   numbers-100m.json: containers=1 children=10591677 hash=b8cae47d2f9da514 | index 0.4 MB, 10343 checkpoints, 0 long scalars | children(root, 5295838, 100) = 100 in 43 µs
typose   numbers-100m.json: peak working set 71 MB
jiter    numbers-100m.json: walk n=5 p50 1.061 GB/s, min 1.023, max 1.066
jiter    numbers-100m.json: read+walk n=5 p50 0.823 GB/s, min 0.802, max 0.833
jiter    numbers-100m.json: containers=1 children=10591677 hash=b8cae47d2f9da514
jiter    numbers-100m.json: peak working set 105 MB
struson  numbers-100m.json: walk n=5 p50 0.163 GB/s, min 0.163, max 0.164
struson  numbers-100m.json: read+walk n=5 p50 0.163 GB/s, min 0.163, max 0.164
struson  numbers-100m.json: containers=1 children=10591677 hash=b8cae47d2f9da514
struson  numbers-100m.json: peak working set 6 MB
dups     ../.fixtures\wide-100m.json: scan 0.130 s (0.806 GB/s); duplicate_keys over 1 objects / 4993220 keys: 0.871 s (174 ns/key), 49 duplicates; peak working set 206 MB
dups     ../.fixtures\records-1g.json: scan 0.992 s (1.082 GB/s); duplicate_keys over 5740203 objects / 22960812 keys: 2.305 s (100 ns/key), 0 duplicates; peak working set 246 MB
cancel   run  0: Some(Cancelled) after 0 containers, latency 495.4µs, then drop 100ns
cancel   run  1: Some(Cancelled) after 998901 containers, latency 83.4µs, then drop 1.4642ms
cancel   run  2: Some(Cancelled) after 2063001 containers, latency 244.2µs, then drop 2.8718ms
cancel   run  3: Some(Cancelled) after 3274460 containers, latency 272.7µs, then drop 3.8686ms
cancel   run  4: Some(Cancelled) after 4453144 containers, latency 269.1µs, then drop 4.7599ms
cancel   run  5: Some(Cancelled) after 5648326 containers, latency 180.6µs, then drop 6.4447ms
cancel   run  6: Some(Cancelled) after 6810849 containers, latency 48.4µs, then drop 7.3585ms
cancel   run  7: Some(Cancelled) after 8202310 containers, latency 428.2µs, then drop 8.2318ms
cancel   run  8: Some(Cancelled) after 9086408 containers, latency 199.7µs, then drop 8.8926ms
cancel   run  9: Some(Cancelled) after 10478001 containers, latency 704µs, then drop 10.3275ms
cancel   run 10: Some(Cancelled) after 11607734 containers, latency 318.7µs, then drop 13.7001ms
cancel   run 11: Some(Cancelled) after 10461708 containers, latency 74.5µs, then drop 12.6707ms
cancel   run 12: Some(Cancelled) after 10969072 containers, latency 20.1µs, then drop 14.7432ms
cancel   run 13: Some(Cancelled) after 12229902 containers, latency 152.9µs, then drop 18.5867ms
cancel   run 14: Some(Cancelled) after 12950042 containers, latency 97.8µs, then drop 16.2939ms
cancel   run 15: Some(Cancelled) after 16077040 containers, latency 216.2µs, then drop 20.5965ms
cancel   run 16: Some(Cancelled) after 19302346 containers, latency 480.8µs, then drop 21.8818ms
cancel   run 17: Some(Cancelled) after 19417001 containers, latency 136.2µs, then drop 22.7573ms
cancel   run 18: Some(Cancelled) after 21578001 containers, latency 225.7µs, then drop 24.7461ms
cancel   run 19: Some(Cancelled) after 23460903 containers, latency 270.9µs, then drop 24.5009ms
cancel   ../.fixtures\deep-100m.json: warm full scan 703.2593ms; n_real=20 of 20 runs; max latency 704µs
```
Delete the four JSON fixtures (≈ 1.4 GB). Git Bash: `rm ../.fixtures/records-1g.json ../.fixtures/wide-100m.json ../.fixtures/deep-100m.json ../.fixtures/numbers-100m.json`. PowerShell: `Remove-Item ../.fixtures/records-1g.json, ../.fixtures/wide-100m.json, ../.fixtures/deep-100m.json, ../.fixtures/numbers-100m.json`.

- [ ] **Step 8: Apply the decision rule**

Spec §4.3: a library replaces the scanner only if it matches the span and laziness requirements at lower cost. So a contender replaces the hand-written scanner only if both hold:
1. it passes every requirement row below;
2. its read+walk p50 is at least the scanner's on all four fixtures, with peak memory no higher.

| Requirement (probe) | typose | jiter 0.17 | struson 0.7 |
|---|---|---|---|
| Byte span for every value (probe 1, plus the per-fixture index hashes) | yes | yes | yes |
| Bounded memory, streaming (API; peak on `records-1g`) | yes: `ByteStore` chunks, 247 MB | **no**: `Jiter::new(&[u8])` needs the whole document, 1,222 MB | yes: any `Read`, 199 MB |
| Verbatim numbers (probe 2) | yes | yes: `known_number_bytes` | yes: `next_number_as_str` |
| JSONC comments and trailing commas (probe 3) | yes, counted as trivia | **no**: `expected value at index 4` | yes, with `allow_comments` and `allow_trailing_comma` |
| Duplicate keys preserved (probe 4) | yes, and flagged | yes | yes |
| Lazy mid-array enumeration (probe 5) | yes, from its own checkpoints | only from an offset the typose index supplies, over the whole file in memory | only from an offset the typose index supplies (`"["` + a reader at it) |
| Error position (probe 7) | yes: offset 12, line 1, column 13 | yes: index 12 | yes: data pos 12 |
| Invalid UTF-8 in a string is a counted problem, not a stop (probe 6, spec §4.1) | yes | yes | **no**: `IO error 'invalid UTF-8 data'` |
| Cost: read+walk p50 against typose, all four fixtures | (baseline) | 1.22–1.62× faster, with the whole file resident | **2.1–3.1× slower** |

On the lane machine neither qualifies, so **the hand-written scanner stays**. Write your outcome as the last line of `spikes/results/json-bench.txt`, e.g. `decision: keep the hand-written scanner (jiter: no JSONC, whole file in memory; struson: stops on invalid UTF-8, 2.1-3.1x slower)`.

- [ ] **Step 9: Read your own work (rule 8), then commit**

The fixtures stay out of git (`spikes/.fixtures/` is gitignored).
```bash
git add spikes/core/fixtures-gen/src/lib.rs spikes/core/fixtures-gen/src/main.rs spikes/core/spike-core/Cargo.toml spikes/core/spike-core/examples/json_bench.rs spikes/core/Cargo.lock spikes/results/json-bench.txt
git commit -m "spike(c): JSON scanner benchmark against jiter and struson, with the decision"
```

---

## Task C3a: CSV sniffing, a record index with mid-record checkpoints, and bounded record pages

**Files:**
- Modify: `spikes/core/spike-core/Cargo.toml` (add `csv-core = "=0.1.13"`: pinned, because the bitwise `Reader` copy is version-specific)
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod csv;`)
- Modify: `spikes/core/spike-core/src/index.rs` (`read_block` becomes `pub(crate)`; nothing else changes)
- Create: `spikes/core/spike-core/src/csv.rs`
- Test: `spikes/core/spike-core/src/csv.rs` (`mod tests`)

**Interfaces:**
- **Consumes:**
  - `store::{ByteStore, ChunkHashes, StoreError, CHUNK, read_exact_at}` (plan A Task 4);
  - `index::read_block` (plan A Task 5, made `pub(crate)` here);
  - `pages::{MAX_PIECE, MAX_PAGE}` (plan A Task 6);
  - `encoding::decode` (Task C1b) and `bytemap::{ByteMap, MapBuilder}` (Task C1a), for each cell's text and byte map; `encoding_rs::Encoding`;
  - csv-core 0.1.13: `Reader`, `ReaderBuilder`, `ReadRecordResult`, `ReadFieldResult`.
- **Produces** (module `spike_core::csv`):
  - `pub const SNIFF_BYTES: u64 = 65_536;`
  - `pub struct Span { pub start: u64, pub end: u64 }` (`Clone, Copy, Debug, PartialEq, Eq`). Original file bytes, end-exclusive (spec §3.2).
  - `pub struct Dialect { pub delimiter: u8, pub has_header: bool }` (`Clone, Copy, Debug, PartialEq, Eq`). ⓘ overrides sniffing by passing its own.
  - `pub struct CsvConfig { pub delimiter: u8, pub cp_records: u64, pub cp_bytes: u64, pub block: usize, pub encoding: &'static Encoding }`. Defaults: `b','`, 1024, 1 MiB, 4 MiB, `UTF_8`. `encoding` is what Task C1b's `sniff` (or ⓘ) decided.
  - `pub struct Checkpoint { pub record: u64, pub offset: u64, /* private */ mid: Option<Box<csv_core::Reader>> }` (`Debug` only, deliberately not `Clone`). `record` = records completed before `offset`; `mid` is csv-core's state when `offset` is inside a record.
  - `pub struct CsvIndex { pub delimiter: u8, pub encoding: &'static Encoding, pub checkpoints: Vec<Checkpoint>, pub records: u64, pub indexed_bytes: u64, pub done: bool, pub refused: Option<&'static str> }` (`Debug`, and `Default` by hand: `&'static Encoding` has none; the default encoding is `UTF_8`). `records` counts completed records only. `refused` is set, with `done` and no records, when the encoding can't be indexed.
  - `pub const UTF16_REFUSED: &str`: why Grid stays locked for a UTF-16 file (spec §3.4's lens reason); Raw shows it.
  - `pub struct CsvProgress { pub records: u64, pub bytes: u64, pub done: bool, pub elapsed_ms: u64 }`
  - `pub struct Field { pub span: Span, pub text: String, pub more: bool, pub map: ByteMap }`. `span` is the raw field, quotes included; `text` is the unescaped value (≤ `MAX_PIECE` bytes of it) decoded in the index's encoding; `more` means the value continues past `text`; `map` maps `text`'s UTF-16 offsets to source bytes: a quote csv-core dropped joins the character after it, and the closing quote the last one unless the value is cut.
  - `pub struct CsvRow { pub record: u64, pub span: Span, pub cells: Vec<Field>, pub more: bool }`. `record` is the 0-based source record (the header is record 0); `span` excludes the terminator; `cells` come from the record's first `MAX_PIECE` bytes; `more` means the record continues past them.
  - `pub fn sniff(store: &ByteStore) -> Result<Dialect, StoreError>`
  - `pub fn build(file: &File, len: u64, cfg: CsvConfig, hashes: &ChunkHashes, shared: &RwLock<CsvIndex>, cancel: &AtomicBool, on_progress: impl FnMut(CsvProgress)) -> Result<bool, StoreError>`. It publishes `cfg.encoding` first; for UTF-16LE/BE it publishes `refused = Some(UTF16_REFUSED)` and `done`, reports progress once and returns `Ok(true)` with no records. Otherwise it publishes into `shared` and calls `on_progress` after every block and when done, hashes every chunk it reads, checks `cancel` at least every 64 KiB, and returns `Ok(false)` if cancelled, `Ok(true)` when done.
  - `pub fn locate_record(store: &ByteStore, index: &CsvIndex, n: u64) -> Result<Option<u64>, StoreError>`. Record `n`'s start; scans ≤ `cp_bytes` past a checkpoint.
  - `pub fn records(store: &ByteStore, index: &CsvIndex, start: u64, count: u32) -> Result<Vec<CsvRow>, StoreError>`. ≤ `count` rows, holding at most `MAX_PAGE` bytes.
  - `pub fn fields(store: &ByteStore, index: &CsvIndex, span: Span, first: usize, count: usize) -> Result<Vec<Field>, StoreError>`. Per-field spans on demand: re-tokenizes the record at `span` and returns fields `first..first + count`, holding at most `MAX_PAGE` bytes of text.
  - **Private, used by the tests and Tasks C3b–C3c:** `CsvIndex::{start_cp, end_cp}`, `primed`, `copy_reader`, `Tok`, `Ev`, `run`, `sniff_sample`, `record_end`, `split`, the constants `DELIMITERS`, `BOM`, `CANCEL_EVERY`.
  - **For a napi binding (not in this plan):** run `build` on its own thread with its own `File`, as plan A's `Doc::start_index` does, and call `records`/`fields` under `index.read()`. Map `CsvProgress` like `IndexProgress`. `Dialect.delimiter` feeds `CsvConfig.delimiter`, and Task C1b's sniffed encoding feeds `CsvConfig.encoding`; `has_header` is presentation only. A `refused` index keeps Grid locked with that reason.

**Design note:**
- **Records ≠ lines.** csv-core finds the record boundaries. It treats `\r`, `\n` and `\r\n` each as one terminator, and skips blank lines without reporting them. `Tok` skips blank lines itself, so it sees where each record starts.
  - Blank lines aren't records. The Grid's row number is `record` (brief §5.3: the source row, kept when sorted).
- **Checkpoints** are placed every `cp_records` records **or** `cp_bytes` bytes, whichever comes first (spec §3.5).
  - A checkpoint placed by the byte bound inside a record stores csv-core's reader state in `mid`. Between records, `mid` is `None` and a fresh reader resumes there.
  - Consecutive checkpoints are ≤ `cp_bytes` apart. A record's start is searched from the last checkpoint before the record starts, and its end from the last one before it ends. So no search scans more than 1 MiB, even through a 200 MB record or a run of blank lines.
- **csv-core 0.1.13's `Reader::clone` is broken.** `impl Clone for Dfa` (csv-core `src/reader.rs:1307-1313`) copies only the transition table, so the clone loses the byte classes and the final states, and misparses.
  - Checkpoints copy the reader bitwise instead (`copy_reader`). That's sound because csv-core is `no_std` without `alloc`: `Reader` holds only arrays and scalars. A `const` assertion checks that it has no drop glue.
  - `csv_core_clone_misparses_so_checkpoints_copy_bitwise` fails once csv-core fixes `Clone`. Switch to `.clone()` then.
- **BOM:** `build` skips a UTF-8 BOM at offset 0, once. Every reader is *primed* (it has already read one `\n`), so csv-core's own BOM stripping never fires on a record that starts with U+FEFF further into the file.
- **Pages:** a row's cells come from the first 64 KiB of its record, and a page stops at 256 KiB.
  - A longer record is cut (`more`). Its end and the next record's start come from the checkpoints, not from a scan.
  - Only completed records count. A record still being indexed isn't paged yet, so the Grid shows a 200 MB first record once the indexer has passed it (~0.2 s at the ~1 GB/s measured in Task C3c); Raw shows it at once.
- **Per-field spans** aren't stored. `fields` re-tokenizes one record on demand (spec §4.2).
- **Encoding** (spec §3.2, §4.1). A cell's text is csv-core's unescaped bytes decoded with Task C1b's `decode` (from offset 1, so a leading U+FEFF stays text). Its map comes from re-reading the field's raw bytes and following csv-core's quote states (the opening quote, `""` as one quote, a lone closing quote, then literal), checked byte for byte against csv-core's value; a whole-field element is the fallback if they ever disagree. That holds for UTF-8 and single-byte encodings, where `"`, delimiters and line ends are single bytes. UTF-16 has none of those, so it's refused (`UTF16_REFUSED`; see the Notes for the checkpoint). Not done: per-cell U+FFFD counts as problems (spec §4.1); `decode` returns them and `Field` doesn't carry them yet.
- **Cancellation:** `build` checks the flag before every step of ≤ 64 KiB. The longest gap is one block read in between: 4 MiB, ~1 ms. (The lane measured ~20 ms in a debug build, where xxh3 is slow; Task C1d's debug-build opt-level for `xxhash-rust` removes that.)
- **Sniffing heuristic** (overridable):
  - **Delimiter:** parse the first 64 KiB with each of `,` `\t` `;` `|`. Pick the one whose most common field count covers the largest share of records; on a tie, the larger count; then that order. A sample that only parses as one column gets `,`. The sample's last record is dropped unless the sample is the whole file.
  - **Header:** the first record's fields are all non-empty, distinct and non-numeric. An all-text table without a header reads as having one; ⓘ fixes that.
- **csv-core behaviours this task pins with tests:** `""` unescapes to `"`; a `"` inside an unquoted field is literal, and `"x"y` reads as `xy`; CR-only and mixed CRLF/LF endings; blank lines are skipped; ragged rows keep their own field counts, and `x,` has an empty last field; NUL is an ordinary byte; an unterminated quote runs to end of file as one record.

- [ ] **Step 1: Add the dependency and the module, and write the failing tests**

In `spikes/core/spike-core/Cargo.toml`, add as the first line under `[dependencies]`, above Task C1b's `encoding_rs`:
<!-- op: insert-adjacent-after spikes/core/spike-core/Cargo.toml :: [dependencies] -->
```toml
csv-core = "=0.1.13"
```
Add `pub mod csv;` to `src/lib.rs`, directly below `pub mod bytemap;`:
<!-- op: insert-adjacent-after spikes/core/spike-core/src/lib.rs :: pub mod bytemap; -->
```rust
pub mod csv;
```

In `src/index.rs`, change `fn read_block<'a>(` to `pub(crate) fn read_block<'a>(`: replace
<!-- op: replace spikes/core/spike-core/src/index.rs -->
```rust
fn read_block<'a>(file: &File, block: &'a mut [u8], pos: u64, hashes: &ChunkHashes) -> Result<&'a [u8], StoreError> {
```
with
```rust
pub(crate) fn read_block<'a>(file: &File, block: &'a mut [u8], pos: u64, hashes: &ChunkHashes) -> Result<&'a [u8], StoreError> {
```

`spikes/core/spike-core/src/csv.rs`:
<!-- op: create spikes/core/spike-core/src/csv.rs -->
```rust
//! CSV/TSV record index (spec §3.5, §4.2): delimiter and header sniffing, csv-core record checkpoints every
//! 1,024 records or 1 MiB, bounded record pages with source spans, and per-field spans by re-tokenizing one record.
//! Cells decode through C1's `decode` in the sniffed encoding, each with a byte map (spec §3.2, §4.1). csv-core
//! reads bytes, so that holds for UTF-8 and single-byte encodings; UTF-16 is refused (`UTF16_REFUSED`).
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::sync::{Mutex, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use csv_core::{ReadFieldResult, ReadRecordResult, Reader, ReaderBuilder};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

use crate::bytemap::{ByteMap, MapBuilder};
use crate::encoding::decode;
use crate::index::read_block;
use crate::pages::{MAX_PAGE, MAX_PIECE};
use crate::store::{read_exact_at, ByteStore, ChunkHashes, StoreError, CHUNK};

/// Why Grid stays locked for a UTF-16 file (spec §3.4's lens reason); Raw shows it. A deviation from spec §4.2.
pub const UTF16_REFUSED: &str = "Grid is unavailable for UTF-16 files: the CSV reader splits single-byte delimiters, quotes and line ends.";
pub const SNIFF_BYTES: u64 = 65_536;
const DELIMITERS: [u8; 4] = [b',', b'\t', b';', b'|'];
const BOM: &[u8] = b"\xEF\xBB\xBF";
/// The index build checks its cancel flag at least this often (bytes).
const CANCEL_EVERY: u64 = 65_536;

/// Original file bytes `[start, end)` (spec §3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

/// What sniffing decided. ⓘ overrides it by passing its own (brief §5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dialect {
    pub delimiter: u8,
    pub has_header: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct CsvConfig {
    pub delimiter: u8,
    pub cp_records: u64,
    pub cp_bytes: u64,
    pub block: usize,
    /// What C1's `sniff` (or ⓘ) decided. Cells decode with it.
    pub encoding: &'static Encoding,
}

impl Default for CsvConfig {
    fn default() -> Self {
        CsvConfig { delimiter: b',', cp_records: 1024, cp_bytes: 1 << 20, block: 4 << 20, encoding: UTF_8 }
    }
}

/// Where a scan can resume. `record` counts the records completed before `offset`. `mid` is csv-core's state
/// when `offset` is inside a record (spec §3.5); `None` means between records, where a fresh reader resumes.
/// Not `Clone`: csv-core's `Reader::clone` is broken (see `copy_reader`).
#[derive(Debug)]
pub struct Checkpoint {
    pub record: u64,
    pub offset: u64,
    mid: Option<Box<Reader>>,
}

#[derive(Debug)]
pub struct CsvIndex {
    pub delimiter: u8,
    pub encoding: &'static Encoding,
    pub checkpoints: Vec<Checkpoint>,
    /// Completed records. A record still being indexed is counted once its end is found.
    pub records: u64,
    pub indexed_bytes: u64,
    pub done: bool,
    /// Set (with `done`, and no records) when the encoding can't be indexed: `UTF16_REFUSED`.
    pub refused: Option<&'static str>,
}

impl Default for CsvIndex {
    fn default() -> Self {
        CsvIndex { delimiter: 0, encoding: UTF_8, checkpoints: Vec::new(), records: 0, indexed_bytes: 0, done: false, refused: None }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CsvProgress {
    pub records: u64,
    pub bytes: u64,
    pub done: bool,
    pub elapsed_ms: u64,
}

/// One field: its raw source span (quotes included) and its unescaped value, decoded. `more`: the value continues
/// past `text`. `map` maps `text`'s UTF-16 offsets to source bytes: a quote csv-core dropped joins the character
/// after it, and the closing quote the last one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub span: Span,
    pub text: String,
    pub more: bool,
    pub map: ByteMap,
}

/// One Grid row. `record` is the 0-based source record: the header is record 0, and blank lines don't count.
/// `cells` come from the record's first `MAX_PIECE` bytes; `more` means the record continues past them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CsvRow {
    pub record: u64,
    pub span: Span,
    pub cells: Vec<Field>,
    pub more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::{temp_file, Temp};
    use std::path::Path;
    use std::time::Duration;

    fn index_path(path: &Path, cfg: CsvConfig) -> (ByteStore, CsvIndex) {
        let store = ByteStore::open(path).unwrap();
        let shared = RwLock::new(CsvIndex::default());
        let done = build(&File::open(path).unwrap(), store.len(), cfg, &store.hashes(), &shared, &AtomicBool::new(false), |_| {});
        assert!(done.unwrap());
        (store, shared.into_inner().unwrap())
    }

    fn index_with(name: &str, bytes: &[u8], cfg: CsvConfig) -> (ByteStore, CsvIndex) {
        index_path(&temp_file(name, bytes), cfg)
    }

    /// Every record's span and cell values, through `records`.
    fn table(name: &str, bytes: &[u8]) -> Vec<(Span, Vec<String>)> {
        let (store, idx) = index_with(name, bytes, CsvConfig::default());
        let rows = records(&store, &idx, 0, u32::MAX).unwrap();
        rows.into_iter().map(|r| (r.span, r.cells.into_iter().map(|c| c.text).collect())).collect()
    }

    fn row(start: u64, end: u64, cells: &[&str]) -> (Span, Vec<String>) {
        (Span { start, end }, cells.iter().map(|c| c.to_string()).collect())
    }

    /// Consecutive checkpoints are ≤ `cp_bytes` apart and the last is ≤ `cp_bytes` from the indexed end,
    /// so no rescan reads more than `cp_bytes` past its checkpoint (spec §3.5).
    fn assert_bounded(idx: &CsvIndex, cp_bytes: u64) {
        for pair in idx.checkpoints.windows(2) {
            assert!(pair[1].offset - pair[0].offset <= cp_bytes, "checkpoint gap over cp_bytes");
        }
        assert!(idx.indexed_bytes - idx.checkpoints.last().unwrap().offset <= cp_bytes);
    }

    #[test]
    fn sniff_picks_the_consistent_delimiter() {
        let d = |s: &str| sniff_sample(s.as_bytes(), true).delimiter;
        assert_eq!(d("a,b,c\n1,2,3\n"), b',');
        assert_eq!(d("name\tnote\nann\tx, y\nbob\tz\n"), b'\t');
        assert_eq!(d("name;price\nfoo;1,5\nbar;2,25\n"), b';');
        assert_eq!(d("a|b\n1|2\n"), b'|');
        assert_eq!(d("\"a,b\";c\n\"d,e\";f\n"), b';'); // a quoted delimiter doesn't count
        assert_eq!(d("one column\nno delimiters\n"), b',');
    }

    #[test]
    fn sniff_detects_a_header() {
        let h = |s: &str| sniff_sample(s.as_bytes(), true).has_header;
        assert!(h("id,name\n1,ann\n"));
        assert!(!h("1,ann\n2,bob\n")); // a number in the first row
        assert!(!h("a,a\nb,c\n")); // duplicate names
        assert!(!h("id,\n1,2\n")); // an empty name
        assert_eq!(sniff_sample(b"\xEF\xBB\xBFx;y\n1;2\n", true), Dialect { delimiter: b';', has_header: true });
    }

    #[test]
    fn checkpoints_every_n_records() {
        let cfg = CsvConfig { cp_records: 3, ..CsvConfig::default() };
        let (store, idx) = index_with("csv-every-n", "a\n".repeat(10).as_bytes(), cfg);
        let cps: Vec<(u64, u64)> = idx.checkpoints.iter().map(|c| (c.record, c.offset)).collect();
        assert_eq!(cps, vec![(0, 0), (3, 6), (6, 12), (9, 18)]);
        assert_eq!(idx.records, 10);
        assert!(idx.done);
        assert_eq!(locate_record(&store, &idx, 7).unwrap(), Some(14));
        assert_eq!(locate_record(&store, &idx, 10).unwrap(), None);
    }

    #[test]
    fn a_checkpoint_inside_a_quoted_field_resumes_there() {
        let cfg = CsvConfig { cp_bytes: 2, ..CsvConfig::default() };
        let (store, idx) = index_with("csv-mid", b"\"a,b\nc\",d\ne\n", cfg);
        let cps: Vec<(u64, u64, bool)> = idx.checkpoints.iter().map(|c| (c.record, c.offset, c.mid.is_some())).collect();
        assert_eq!(cps, vec![(0, 0, false), (0, 2, true), (0, 4, true), (0, 6, true), (0, 8, true), (1, 10, false)]);
        for cp in idx.checkpoints.iter().filter(|c| c.mid.is_some()) {
            let mut tok = Tok::at(cp, b',');
            let end = run(&store, &mut tok, idx.indexed_bytes, |_, ev| match ev {
                Ev::End(e) => Some(e),
                _ => None,
            });
            assert_eq!(end.unwrap(), Some(9), "resumed at {}", cp.offset); // a fresh reader ends at 4 (from 2) or 12 (from 6)
        }
        assert_eq!(locate_record(&store, &idx, 1).unwrap(), Some(10));
        let rows = records(&store, &idx, 0, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].span, Span { start: 0, end: 9 });
        assert_eq!(rows[0].cells.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["a,b\nc", "d"]);
        assert_eq!(rows[0].cells[0].span, Span { start: 0, end: 7 });
        assert_eq!(rows[1].span, Span { start: 10, end: 11 });
    }

    #[test]
    fn csv_core_clone_misparses_so_checkpoints_copy_bitwise() {
        let parse_rest = |r: &mut Reader| {
            let (mut out, mut ends) = ([0u8; 64], [0usize; 8]);
            let (res, nin, _, nends) = r.read_record(b"cd\",e\n", &mut out, &mut ends);
            (res, nin, nends)
        };
        let mut r = primed(b',');
        r.read_record(b"\"ab,\n", &mut [0u8; 64], &mut [0usize; 8]); // stops inside the quoted field
        assert_eq!(parse_rest(&mut copy_reader(&r)), (ReadRecordResult::Record, 6, 2));
        assert_ne!(parse_rest(&mut r.clone()), (ReadRecordResult::Record, 6, 2)); // fails once csv-core fixes Clone
    }

    #[test]
    fn a_page_stops_at_256_kib() {
        let line = format!("{}\n", "y".repeat(60_000));
        let (store, idx) = index_with("csv-page-cap", line.repeat(10).as_bytes(), CsvConfig::default());
        assert_eq!(records(&store, &idx, 0, 10).unwrap().len(), 4); // 4 × 60,000 ≤ 256 KiB < 5 × 60,000
    }

    #[test]
    fn fields_stop_at_256_kib() {
        let line = format!("{}\n", vec!["z".repeat(60_000); 10].join(","));
        let (store, idx) = index_with("csv-fields-cap", line.as_bytes(), CsvConfig::default());
        let span = records(&store, &idx, 0, 1).unwrap()[0].span;
        assert_eq!(fields(&store, &idx, span, 0, 10).unwrap().len(), 4); // 4 × 60,000 ≤ 256 KiB < 5 × 60,000
    }

    #[test]
    fn a_record_over_64_kib_is_cut_at_the_window() {
        let bytes = "x,".repeat(40_000) + "end\n";
        let (store, idx) = index_with("csv-wide", bytes.as_bytes(), CsvConfig::default());
        let rows = records(&store, &idx, 0, 1).unwrap();
        assert_eq!(rows[0].span, Span { start: 0, end: 80_003 });
        assert!(rows[0].more);
        assert_eq!(rows[0].cells.len(), 32_768); // the window ends just after a delimiter: no empty cut cell
        assert!(rows[0].cells.iter().all(|c| c.text == "x" && !c.more));
    }

    #[test]
    fn readers_page_while_the_index_builds() {
        let bytes = "id,name\n".to_string() + &"1,\"two\nlines\"\n".repeat(300_000);
        let path = temp_file("csv-live", bytes.as_bytes());
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(CsvIndex::default());
        let cfg = CsvConfig { block: CHUNK, ..CsvConfig::default() };
        let (mut partial_pages, mut last) = (0, None);
        let file = File::open(&path).unwrap();
        let done = build(&file, store.len(), cfg, &store.hashes(), &shared, &AtomicBool::new(false), |p| {
            let idx = shared.read().unwrap();
            if !p.done {
                assert!(!idx.done && idx.records == p.records);
                let rows = records(&store, &idx, idx.records - 2, 10).unwrap();
                assert_eq!(rows.len(), 2); // only completed records are paged
                assert_eq!(rows[1].cells[1].text, "two\nlines");
                partial_pages += 1;
            }
            last = Some(p);
        });
        assert!(done.unwrap());
        assert!(partial_pages >= 3, "{partial_pages}");
        let last = last.unwrap();
        assert!(last.done);
        assert_eq!(last.records, 300_001);
    }

    #[test]
    fn cancel_returns_within_50ms() {
        let shapes: [(&str, Vec<u8>); 3] = [
            ("csv-cancel-rows", b"a,\"b\nc\",d\n".repeat(10_000_000)),
            ("csv-cancel-quote", [b"\"".as_slice(), &b"x,\n".repeat(33_000_000)].concat()),
            ("csv-cancel-blank", b"\r\n".repeat(50_000_000)),
        ];
        let paths: Vec<_> = shapes.iter().map(|(name, bytes)| Temp(temp_file(name, bytes))).collect();
        drop(shapes);
        let mut worst = Duration::ZERO;
        for run in 0..21 {
            let path = &paths[run % 3];
            let len = std::fs::metadata(&**path).unwrap().len();
            let (cancel, hashes, shared) = (AtomicBool::new(false), ChunkHashes::default(), RwLock::new(CsvIndex::default()));
            let file = File::open(&**path).unwrap();
            let latency = std::thread::scope(|s| {
                let setter = s.spawn(|| {
                    std::thread::sleep(Duration::from_millis(2 + (run as u64 * 7) % 15));
                    cancel.store(true, Ordering::Relaxed);
                    Instant::now()
                });
                let finished = build(&file, len, CsvConfig::default(), &hashes, &shared, &cancel, |_| {}).unwrap();
                let returned = Instant::now();
                assert!(!finished, "the build finished before the flag was set; use a bigger input");
                returned.saturating_duration_since(setter.join().unwrap())
            });
            worst = worst.max(latency);
        }
        println!("cancel: n=21, max {worst:?}");
        assert!(worst < Duration::from_millis(50), "{worst:?}");
    }

    #[test]
    fn doubled_quotes_unescape() {
        assert_eq!(table("csv-dq", b"\"a\"\"b\",c\n"), vec![row(0, 8, &["a\"b", "c"])]);
    }

    #[test]
    fn a_quote_inside_an_unquoted_field_is_literal() {
        assert_eq!(table("csv-q", b"ab\"c,\"x\"y\n"), vec![row(0, 9, &["ab\"c", "xy"])]);
    }

    #[test]
    fn cr_only_line_endings() {
        assert_eq!(table("csv-cr", b"a,b\rc,d\r"), vec![row(0, 3, &["a", "b"]), row(4, 7, &["c", "d"])]);
    }

    #[test]
    fn mixed_crlf_and_lf() {
        let want = vec![row(0, 1, &["a"]), row(3, 4, &["b"]), row(5, 6, &["c"]), row(8, 9, &["d"])];
        assert_eq!(table("csv-mixed", b"a\r\nb\nc\r\nd"), want);
    }

    #[test]
    fn a_bom_is_skipped_once_at_offset_0() {
        let want = vec![row(3, 6, &["a", "b"]), row(7, 11, &["\u{feff}c"])];
        assert_eq!(table("csv-bom", b"\xEF\xBB\xBFa,b\n\xEF\xBB\xBFc\n"), want);
    }

    #[test]
    fn cells_decode_in_the_sniffed_encoding_with_byte_maps() {
        // A Windows-1252 export (C1's `sniff` falls back to it): é is one byte, and a quoted cell's quotes join its
        // first and last characters, a doubled `""` its one displayed quote.
        let bytes = b"name,n\ncaf\xE9,1\n\"na\xEFve\"\"x\",2\n";
        assert_eq!(crate::encoding::sniff(bytes, true, encoding_rs::WINDOWS_1252), crate::encoding::Sniffed::Text { encoding: encoding_rs::WINDOWS_1252, bom: 0 });
        let cfg = CsvConfig { encoding: encoding_rs::WINDOWS_1252, ..CsvConfig::default() };
        let (store, idx) = index_with("csv-1252", bytes, cfg);
        let rows = records(&store, &idx, 1, 2).unwrap();
        let (cafe, naive) = (&rows[0].cells[0], &rows[1].cells[0]);
        assert_eq!((cafe.text.as_str(), cafe.map.clone()), ("café", ByteMap::Uniform { start: 7, unit_bytes: 1, units: 4, pairs: vec![] }));
        assert_eq!((naive.text.as_str(), naive.span), ("naïve\"x", Span { start: 14, end: 24 }));
        let ends: Vec<u64> = (0..=7).map(|u| naive.map.end_byte(u)).collect();
        assert_eq!(ends, [14, 16, 17, 18, 19, 20, 22, 24]); // `"n`, a, ï, v, e, `""`, `x"`
        assert_eq!(naive.map.start_byte(0), 14);
    }

    #[test]
    fn utf16_is_refused_with_a_reason() {
        // csv-core splits single-byte delimiters and line ends; UTF-16 has none. Grid stays locked; Raw shows it.
        let bytes: Vec<u8> = [0xFF, 0xFE].into_iter().chain("a\tb\r\n1\t2\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        for encoding in [UTF_16LE, UTF_16BE] {
            let (store, idx) = index_with("csv-utf16", &bytes, CsvConfig { delimiter: b'\t', encoding, ..CsvConfig::default() });
            assert_eq!((idx.refused, idx.records, idx.done, idx.encoding), (Some(UTF16_REFUSED), 0, true, encoding));
            assert!(records(&store, &idx, 0, 10).unwrap().is_empty());
        }
    }

    #[test]
    fn empty_lines_are_not_records() {
        assert_eq!(table("csv-blank", b"\n\na\n\r\n\n\rb\n\n"), vec![row(2, 3, &["a"]), row(8, 9, &["b"])]);
    }

    #[test]
    fn ragged_rows_keep_their_own_field_counts() {
        let want = vec![row(0, 5, &["a", "b", "c"]), row(6, 7, &["d"]), row(8, 15, &["e", "f", "g", "h"]), row(16, 18, &["x", ""])];
        assert_eq!(table("csv-ragged", b"a,b,c\nd\ne,f,g,h\nx,\n"), want);
    }

    #[test]
    fn nul_bytes_are_ordinary_bytes() {
        assert_eq!(table("csv-nul", b"a\0b,c\n\0,\0\0\n"), vec![row(0, 5, &["a\0b", "c"]), row(6, 10, &["\0", "\0\0"])]);
    }

    #[test]
    fn a_5000_column_header() {
        let mut text = (0..5000).map(|j| format!("c{j}")).collect::<Vec<_>>().join(",") + "\n";
        for _ in 0..3 {
            text += &(vec!["1"; 5000].join(",") + "\n");
        }
        let path = temp_file("csv-5000", text.as_bytes());
        let (store, idx) = index_path(&path, CsvConfig::default());
        assert_eq!(sniff(&store).unwrap(), Dialect { delimiter: b',', has_header: true });
        let rows = records(&store, &idx, 0, 10).unwrap();
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|r| r.cells.len() == 5000 && !r.more));
        assert_eq!(rows[0].cells[4999].text, "c4999");
    }

    #[test]
    fn a_100mb_single_cell_is_one_bounded_piece() {
        let mut bytes = b"a,b\n\"".to_vec();
        bytes.resize(bytes.len() + 100_000_000, b'x');
        bytes.extend_from_slice(b"\",c\nd,e\n");
        let path = Temp(temp_file("csv-100mb-cell", &bytes));
        drop(bytes);
        let (store, idx) = index_path(&path, CsvConfig::default());
        assert_eq!(idx.records, 3);
        assert_bounded(&idx, 1 << 20);
        let rows = records(&store, &idx, 0, 10).unwrap();
        assert_eq!(rows.len(), 3);
        let big = &rows[1];
        assert_eq!(big.span, Span { start: 4, end: 100_000_008 });
        assert!(big.more && big.cells.len() == 1 && big.cells[0].more);
        assert_eq!(big.cells[0].text.len(), MAX_PIECE - 1); // the window minus the opening quote
        assert_eq!(rows[2].cells.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["d", "e"]);
        let full = fields(&store, &idx, big.span, 0, 2).unwrap();
        assert_eq!(full[0].span, Span { start: 4, end: 100_000_006 });
        assert!(full[0].more && full[0].text.len() == MAX_PIECE);
        let c = ByteMap::Uniform { start: 100_000_007, unit_bytes: 1, units: 1, pairs: vec![] };
        assert_eq!(full[1], Field { span: Span { start: 100_000_007, end: 100_000_008 }, text: "c".into(), more: false, map: c });
    }

    #[test]
    fn an_unterminated_quote_runs_to_eof_as_one_200mb_record() {
        let bytes = [b"h1,h2\n\"open".as_slice(), &b"xxxxxxx,\n".repeat(22_222_222)].concat();
        let len = bytes.len() as u64;
        let path = Temp(temp_file("csv-unterminated", &bytes));
        drop(bytes);
        let (store, idx) = index_path(&path, CsvConfig::default());
        assert_eq!(idx.records, 2);
        assert_bounded(&idx, 1 << 20);
        assert!(idx.checkpoints.iter().filter(|c| c.mid.is_some()).count() >= 190);
        assert_eq!(locate_record(&store, &idx, 1).unwrap(), Some(6));
        let rows = records(&store, &idx, 0, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].span, Span { start: 6, end: len });
        assert!(rows[1].more && rows[1].cells.len() == 1 && rows[1].cells[0].more);
        assert_eq!(rows[1].cells[0].text.len(), MAX_PIECE - 1);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core csv`
Expected: compile errors, `due to 29 previous errors; 8 warnings emitted`:
- `error[E0425]: cannot find function` for `build` (3), `run` (1), `sniff` (1), `records` (11), `sniff_sample` (3), `locate_record` (4), `primed` (1), `copy_reader` (1) and `fields` (2);
- `error[E0433]: cannot find type` for `Tok` and `Ev` (1 each).

- [ ] **Step 3: Implement**

Add to `csv.rs`, below the `CsvRow` struct:
<!-- op: insert-before spikes/core/spike-core/src/csv.rs :: #[cfg(test)] -->
```rust
impl CsvIndex {
    /// Where a search for record `n`'s start resumes: the last checkpoint before `n` starts.
    fn start_cp(&self, n: u64) -> &Checkpoint {
        let i = self.checkpoints.partition_point(|c| c.record < n || (c.record == n && c.mid.is_none()));
        &self.checkpoints[i.saturating_sub(1)]
    }

    /// Where a search for record `n`'s end resumes: the last checkpoint before `n` ends.
    fn end_cp(&self, n: u64) -> &Checkpoint {
        &self.checkpoints[self.checkpoints.partition_point(|c| c.record <= n).saturating_sub(1)]
    }
}

/// A reader that has already read something, so csv-core's own BOM stripping never fires mid-file.
/// `build` handles the BOM once, at offset 0. Building csv-core's DFA costs ~10 µs, so it's built once per delimiter.
fn primed(delimiter: u8) -> Reader {
    static BUILT: Mutex<Vec<(u8, Reader)>> = Mutex::new(Vec::new());
    let mut built = BUILT.lock().unwrap();
    if let Some((_, r)) = built.iter().find(|(d, _)| *d == delimiter) {
        return copy_reader(r);
    }
    let mut r = ReaderBuilder::new().delimiter(delimiter).build();
    r.read_record(b"\n", &mut [0u8; 1], &mut [0usize; 1]);
    built.push((delimiter, copy_reader(&r)));
    r
}

/// An independent copy of `r`. Not `r.clone()`: csv-core 0.1.13's `impl Clone for Dfa` copies only the
/// transition table and drops the byte classes and final states (src/reader.rs:1307-1313), so a clone misparses.
fn copy_reader(r: &Reader) -> Reader {
    // SAFETY: csv-core is `no_std` without `alloc`, and `Reader` holds only arrays and scalars: no pointers,
    // no Drop (checked below). A bitwise copy is a complete, independent value.
    unsafe { std::ptr::read(r) }
}
const _: () = assert!(!std::mem::needs_drop::<Reader>());

#[derive(Clone, Copy, PartialEq)]
enum Ev {
    /// A record starts at `Tok::pos`.
    Start,
    /// A record ended here (terminator excluded).
    End(u64),
    /// The input was used up without either.
    Fed,
}

/// csv-core walking the file. csv-core skips blank lines silently, so `Tok` skips them itself to see where
/// each record starts.
struct Tok {
    reader: Reader,
    pos: u64,
    /// Records completed before `pos`.
    record: u64,
    in_record: bool,
    out: Vec<u8>,
    ends: Vec<usize>,
}

impl Tok {
    fn new(reader: Reader, pos: u64, record: u64, in_record: bool) -> Tok {
        Tok { reader, pos, record, in_record, out: vec![0; 4096], ends: vec![0; 256] }
    }

    fn fresh(delimiter: u8, pos: u64, record: u64) -> Tok {
        Tok::new(primed(delimiter), pos, record, false)
    }

    fn at(cp: &Checkpoint, delimiter: u8) -> Tok {
        let reader = cp.mid.as_deref().map_or_else(|| primed(delimiter), copy_reader);
        Tok::new(reader, cp.offset, cp.record, cp.mid.is_some())
    }

    /// Consumes a prefix of `input` (the bytes at `pos`; empty means end of file) up to the next event.
    fn step(&mut self, mut input: &[u8]) -> Ev {
        if !self.in_record {
            let skip = input.iter().position(|&b| b != b'\r' && b != b'\n').unwrap_or(input.len());
            self.pos += skip as u64;
            self.in_record = skip < input.len();
            return if self.in_record { Ev::Start } else { Ev::Fed };
        }
        let eof = input.is_empty();
        loop {
            let (res, nin, _, _) = self.reader.read_record(input, &mut self.out, &mut self.ends);
            self.pos += nin as u64;
            input = &input[nin..];
            // At end of file an open record ends whatever csv-core says, so no scan can stall there.
            if res == ReadRecordResult::Record || eof {
                self.record += 1;
                self.in_record = false;
                return Ev::End(if eof { self.pos } else { self.pos - 1 });
            }
            if input.is_empty() {
                return Ev::Fed;
            }
        }
    }
}

/// Feeds `tok` from the store up to `until` (end of file ends an open record) until `hit` returns a position.
fn run(
    store: &ByteStore,
    tok: &mut Tok,
    until: u64,
    mut hit: impl FnMut(&Tok, Ev) -> Option<u64>,
) -> Result<Option<u64>, StoreError> {
    let until = until.min(store.len());
    while tok.pos < until {
        let idx = tok.pos / CHUNK as u64;
        let (chunk, base) = (store.chunk(idx)?, idx * CHUNK as u64);
        let end = (base + chunk.len() as u64).min(until);
        while tok.pos < end {
            let ev = tok.step(&chunk[(tok.pos - base) as usize..(end - base) as usize]);
            if let Some(p) = hit(tok, ev) {
                return Ok(Some(p));
            }
        }
    }
    if tok.pos >= store.len() && tok.in_record {
        let ev = tok.step(&[]);
        return Ok(hit(tok, ev));
    }
    Ok(None)
}

/// Sniffs the first 64 KiB (spec §4.2). Overridable: callers may pass any `Dialect` instead.
pub fn sniff(store: &ByteStore) -> Result<Dialect, StoreError> {
    let sample = store.read(0, SNIFF_BYTES)?;
    Ok(sniff_sample(&sample, sample.len() as u64 == store.len()))
}

/// Delimiter: the candidate whose field count per record is most consistent (share of records with the
/// most common count, then the count itself, then the order `,` `\t` `;` `|`); a sample that only parses as
/// one column gets `,`. Header: the first record's fields are all non-empty, distinct and non-numeric.
/// ponytail: no type-vote per column (Python's Sniffer); an all-text table without a header reads as having one.
fn sniff_sample(sample: &[u8], whole: bool) -> Dialect {
    let sample = sample.strip_prefix(BOM).unwrap_or(sample);
    let parsed: Vec<_> = DELIMITERS.iter().map(|&d| sample_records(sample, d, whole)).collect();
    let (mut best, mut best_score) = (0, consistency(&parsed[0]));
    for (i, recs) in parsed.iter().enumerate().skip(1) {
        let score = consistency(recs);
        if score > best_score {
            (best, best_score) = (i, score);
        }
    }
    let numeric = |t: &str| t.parse::<f64>().is_ok() && t.bytes().any(|b| b.is_ascii_digit());
    let has_header = parsed[best].first().is_some_and(|first| {
        let mut seen = HashSet::new();
        first.iter().all(|f| {
            let s = String::from_utf8_lossy(f);
            let t = s.trim();
            !t.is_empty() && !numeric(t) && seen.insert(t.to_owned())
        })
    });
    Dialect { delimiter: DELIMITERS[best], has_header }
}

/// (share of records with the most common field count, that count); `(0.0, 1)` when that count is 1.
fn consistency(recs: &[Vec<Vec<u8>>]) -> (f64, usize) {
    let mut counts = HashMap::new();
    for r in recs {
        *counts.entry(r.len()).or_insert(0usize) += 1;
    }
    let mode = counts.into_iter().max_by_key(|&(len, hits)| (hits, len)).filter(|&(len, _)| len >= 2);
    mode.map_or((0.0, 1), |(len, hits)| (hits as f64 / recs.len() as f64, len))
}

/// The sample's records as unescaped fields. Unless the sample is the whole file, its cut last record is dropped.
fn sample_records(sample: &[u8], delimiter: u8, whole: bool) -> Vec<Vec<Vec<u8>>> {
    let mut r = primed(delimiter);
    let (mut recs, mut rec, mut field) = (Vec::new(), Vec::new(), Vec::new());
    let mut out = [0u8; 4096];
    let mut input = sample;
    loop {
        if input.is_empty() && !whole {
            return recs;
        }
        let (res, nin, nout) = r.read_field(input, &mut out);
        input = &input[nin..];
        field.extend_from_slice(&out[..nout]);
        match res {
            ReadFieldResult::Field { record_end } => {
                rec.push(std::mem::take(&mut field));
                if record_end {
                    recs.push(std::mem::take(&mut rec));
                }
            }
            ReadFieldResult::End => return recs,
            _ => {}
        }
    }
}

fn publish(shared: &RwLock<CsvIndex>, delimiter: u8, fresh: &mut Vec<Checkpoint>, records: u64, indexed: u64, done: bool) {
    let mut w = shared.write().unwrap();
    w.delimiter = delimiter;
    w.checkpoints.append(fresh);
    w.records = records;
    w.indexed_bytes = indexed;
    w.done = done;
}

/// Indexes records sequentially (spec §3.5), publishing into `shared` after every block so readers can page
/// while it runs. Checks `cancel` at least every 64 KiB. Returns `Ok(false)` if cancelled, `Ok(true)` when done.
pub fn build(
    file: &File,
    len: u64,
    cfg: CsvConfig,
    hashes: &ChunkHashes,
    shared: &RwLock<CsvIndex>,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(CsvProgress),
) -> Result<bool, StoreError> {
    let started = Instant::now();
    let progress = |records, bytes, done| CsvProgress { records, bytes, done, elapsed_ms: started.elapsed().as_millis() as u64 };
    shared.write().unwrap().encoding = cfg.encoding;
    if cfg.encoding == UTF_16LE || cfg.encoding == UTF_16BE {
        let mut w = shared.write().unwrap();
        (w.refused, w.done) = (Some(UTF16_REFUSED), true);
        on_progress(progress(0, 0, true));
        return Ok(true);
    }
    let cp_bytes = cfg.cp_bytes.max(1);
    let mut head = [0u8; 3];
    let bom = len >= 3 && {
        read_exact_at(file, &mut head, 0)?;
        head[..] == *BOM
    };
    let mut tok = Tok::fresh(cfg.delimiter, if bom { 3 } else { 0 }, 0);
    let mut fresh = vec![Checkpoint { record: 0, offset: tok.pos, mid: None }];
    let (mut last_cp, mut since) = (tok.pos, 0u64);
    let mut buf = vec![0u8; cfg.block.max(CHUNK) / CHUNK * CHUNK];
    let mut pos = 0u64;
    while pos < len {
        let n = ((len - pos) as usize).min(buf.len());
        let block = read_block(file, &mut buf[..n], pos, hashes)?;
        let end = pos + n as u64;
        while tok.pos < end {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if tok.pos >= last_cp.saturating_add(cp_bytes) {
                if !tok.in_record {
                    since = 0;
                }
                let mid = tok.in_record.then(|| Box::new(copy_reader(&tok.reader)));
                fresh.push(Checkpoint { record: tok.record, offset: tok.pos, mid });
                last_cp = tok.pos;
            }
            let lim = end.min(last_cp.saturating_add(cp_bytes)).min(tok.pos + CANCEL_EVERY);
            match tok.step(&block[(tok.pos - pos) as usize..(lim - pos) as usize]) {
                Ev::Start if since >= cfg.cp_records && last_cp != tok.pos => {
                    fresh.push(Checkpoint { record: tok.record, offset: tok.pos, mid: None });
                    (last_cp, since) = (tok.pos, 0);
                }
                Ev::End(_) => since += 1,
                _ => {}
            }
        }
        pos = end;
        publish(shared, cfg.delimiter, &mut fresh, tok.record, pos, false);
        on_progress(progress(tok.record, pos, false));
    }
    if tok.in_record {
        tok.step(&[]);
    }
    publish(shared, cfg.delimiter, &mut fresh, tok.record, len, true);
    on_progress(progress(tok.record, len, true));
    Ok(true)
}

/// Where record `n` starts. Scans at most `cp_bytes` past a checkpoint.
pub fn locate_record(store: &ByteStore, index: &CsvIndex, n: u64) -> Result<Option<u64>, StoreError> {
    if n >= index.records {
        return Ok(None);
    }
    let mut tok = Tok::at(index.start_cp(n), index.delimiter);
    run(store, &mut tok, index.indexed_bytes, |t, ev| (ev == Ev::Start && t.record == n).then_some(t.pos))
}

/// Where record `n` ends (terminator excluded). Scans at most `cp_bytes` past a checkpoint.
fn record_end(store: &ByteStore, index: &CsvIndex, n: u64) -> Result<Option<u64>, StoreError> {
    let mut tok = Tok::at(index.end_cp(n), index.delimiter);
    run(store, &mut tok, index.indexed_bytes, |t, ev| match ev {
        Ev::End(e) if t.record == n + 1 => Some(e),
        _ => None,
    })
}

/// Up to `count` rows from record `start` (spec §3.4): each row's cells come from at most `MAX_PIECE` bytes of
/// its record, and the page holds at most `MAX_PAGE` bytes. A huge record's end and the next record's
/// start come from the checkpoints, so no record is scanned past `MAX_PIECE` bytes plus `cp_bytes`.
pub fn records(store: &ByteStore, index: &CsvIndex, start: u64, count: u32) -> Result<Vec<CsvRow>, StoreError> {
    let mut rows = Vec::new();
    let Some(mut s) = locate_record(store, index, start)? else { return Ok(rows) };
    let (mut n, mut page) = (start, 0usize);
    while n < index.records && rows.len() < count as usize {
        let mut tok = Tok::fresh(index.delimiter, s, n);
        let near = run(store, &mut tok, s + MAX_PIECE as u64 + 1, |t, ev| match ev {
            Ev::End(e) if t.record == n + 1 => Some(e),
            _ => None,
        })?;
        let end = match near {
            Some(e) => e,
            None => match record_end(store, index, n)? {
                Some(e) => e,
                None => break,
            },
        };
        let until = end.min(s + MAX_PIECE as u64);
        if !rows.is_empty() && page + (until - s) as usize > MAX_PAGE {
            break;
        }
        let span = Span { start: s, end };
        let cells = split(store, index, span, until, 0, usize::MAX)?;
        rows.push(CsvRow { record: n, span, cells, more: until < end });
        page += (until - s) as usize;
        n += 1;
        if n >= index.records {
            break;
        }
        let lim = tok.pos + MAX_PIECE as u64;
        let next = match near {
            Some(_) => run(store, &mut tok, lim, |t, ev| (ev == Ev::Start).then_some(t.pos))?,
            None => None,
        };
        s = match next {
            Some(p) => p,
            None => match locate_record(store, index, n)? {
                Some(p) => p,
                None => break,
            },
        };
    }
    Ok(rows)
}

/// Per-field spans on demand (spec §4.2): re-tokenizes the record at `span` and returns its fields
/// `first..first + count`, holding at most `MAX_PAGE` bytes of text.
pub fn fields(store: &ByteStore, index: &CsvIndex, span: Span, first: usize, count: usize) -> Result<Vec<Field>, StoreError> {
    split(store, index, span, span.end, first, count)
}

/// Tokenizes `[span.start, until)` of one record into fields. Values are capped at `MAX_PIECE` bytes.
/// When `until < span.end`, the field it cuts is returned with `more` and a span ending at `until`.
fn split(store: &ByteStore, index: &CsvIndex, span: Span, until: u64, first: usize, count: usize) -> Result<Vec<Field>, StoreError> {
    let mut r = primed(index.delimiter);
    let mut out = vec![0u8; 4096];
    let (mut fields, mut val, mut long, mut text) = (Vec::new(), Vec::new(), false, 0usize);
    let (mut pos, mut field_start, mut idx) = (span.start, span.start, 0usize);
    while fields.len() < count && text < MAX_PAGE {
        let block = store.read(pos, (pos + CHUNK as u64).min(until))?;
        let eof = block.is_empty();
        if eof && until < span.end {
            if idx >= first && field_start < until {
                fields.push(field(store, Span { start: field_start, end: until }, &val, true, index.encoding)?);
            }
            break;
        }
        let mut input = &block[..];
        while eof || !input.is_empty() {
            let (res, nin, nout) = r.read_field(input, &mut out);
            if idx >= first {
                let room = MAX_PIECE.saturating_sub(val.len());
                val.extend_from_slice(&out[..nout.min(room)]);
                long |= nout > room;
            }
            pos += nin as u64;
            input = &input[nin..];
            match res {
                ReadFieldResult::Field { .. } => {
                    if idx >= first {
                        if !fields.is_empty() && text + val.len() > MAX_PAGE {
                            return Ok(fields);
                        }
                        text += val.len();
                        let span = Span { start: field_start, end: if eof { pos } else { pos - 1 } };
                        fields.push(field(store, span, &val, long, index.encoding)?);
                        val.clear();
                        long = false;
                    }
                    idx += 1;
                    field_start = pos;
                    if eof || fields.len() >= count || text >= MAX_PAGE {
                        return Ok(fields);
                    }
                }
                _ if eof => return Ok(fields),
                _ => {}
            }
        }
    }
    Ok(fields)
}

/// The field at `span` as Grid shows it: `val`, csv-core's unescaped bytes, decoded through C1's `decode`, with a
/// byte map onto the field's source. The value is the field's bytes less the quotes csv-core drops (the opening
/// one, the first of each `""` inside quotes, and the closing one, after which the rest is literal). A dropped
/// quote joins the character after it; the closing quote joins the last one, unless the value is cut (`more`).
fn field(store: &ByteStore, span: Span, val: &[u8], more: bool, encoding: &'static Encoding) -> Result<Field, StoreError> {
    let raw = store.read(span.start, span.end.min(span.start + 2 * val.len() as u64 + 2))?;
    let mut at = Vec::with_capacity(val.len()); // each value byte's offset in `raw`
    let mut quoted = raw.first() == Some(&b'"');
    let mut i = usize::from(quoted);
    while at.len() < val.len() && i < raw.len() {
        if quoted && raw[i] == b'"' {
            i += 1;
            quoted = raw.get(i) == Some(&b'"'); // `""` is one quote; a lone one closes the quotes
            if !quoted {
                continue;
            }
        }
        at.push(i);
        i += 1;
    }
    let slice = decode(val, encoding, 1); // value-relative, from 1 so a leading U+FEFF stays text
    let mut map = MapBuilder::new(span.start);
    if at.len() == val.len() && at.iter().zip(val).all(|(&i, &b)| raw[i] == b) {
        let (mut u, mut from) = (0, span.start);
        let mut chars = slice.text.chars().peekable();
        while let Some(c) = chars.next() {
            u += c.len_utf16() as u32;
            let last = at[(slice.map.end_byte(u) - 2) as usize]; // the char's last value byte
            let to = if chars.peek().is_none() && !more { span.end } else { span.start + last as u64 + 1 };
            map.push(c.len_utf16() as u32, to - from);
            from = to;
        }
    } else {
        // ponytail: unreachable while the walk above follows csv-core's quote states; a whole-field element still
        // maps every endpoint inside the field.
        map.push(slice.map.units(), span.end - span.start);
    }
    Ok(Field { span, text: slice.text, more, map: map.finish() })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core csv`
Expected: `23 passed; 0 failed; 0 ignored; 0 measured; 64 filtered out`, then `0 passed` with `1 filtered out` for `tests\json_spans.rs`.
- `cancel_returns_within_50ms` prints `cancel: n=21, max …` with `--nocapture`, and fails at 50 ms or more.
- The 100 MB and 200 MB tests write temp files of that size and delete them on any exit (`store::testutil::Temp`).

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `86 passed; 0 failed; 1 ignored` (Task C2c's 63 plus these 23; the ignored one is Task C0's `handle_lifetime_costs`), then `1 passed` for `tests\json_spans.rs`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/Cargo.toml spikes/core/Cargo.lock spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/index.rs spikes/core/spike-core/src/csv.rs
git commit -m "spike(c): CSV sniffing and a record index with mid-record checkpoints"
```

---

## Task C3b: Span-fidelity gate over 10,000 generated CSV tables

**Files:**
- Modify: `spikes/core/spike-core/src/csv.rs` (the gate, at the end of `mod tests`)

**Interfaces:**
- **Consumes:** Task C3a's `build`, `locate_record`, `records`, `fields`, `CsvIndex::{start_cp, end_cp}`, `BOM`, `DELIMITERS`, and the `index_path` test helper; `bytemap::naive_endpoints` (Task C1a).
- **Produces:** the gate `csv::tests::span_fidelity` (spec §13.1: zero span mismatches across ≥ 10,000 generated cases). The case count is set explicitly: `ProptestConfig::with_cases(10_000)`.

**Design note:**
- **The reference is the generator's own record of what it wrote:** every record's span, every field's span, every field's original value and its display elements (each character's own bytes, a `"` doubled inside quotes, the quotes joined to the first and last character). The code under test computes none of it.
- **The generator:**
  - 0–24 records of 1–6 fields. Values come from letters, a space, all four delimiters, `"`, `\r`, `\n`, `é`, `😀`, U+FEFF and NUL.
  - Quoting is random, and forced where a field must be quoted to round-trip: it holds the delimiter, a quote, CR or LF; it's a record's only field and empty (that would be a blank line); or it starts with U+FEFF at offset 0 without a BOM (that would read as one).
  - Terminators are random among `\n`, `\r\n` and `\r`. There are 0–2 blank lines before each record, an optional final terminator and an optional BOM.
  - Half the tables are written in Windows-1252 (`😀` becomes `€`, U+FEFF becomes `ÿ`, no BOM) and indexed with that encoding.
- **Checkpoints are forced tiny** (`cp_bytes` 1–63, `cp_records` 1–7), so they land inside records and inside quoted fields.
- **Each case asserts:**
  - the record count;
  - every `locate_record`, against the generator and against a checkpoint-free index (a full scan from offset 0);
  - that every record's start and end is ≤ `cp_bytes` past the checkpoint its search resumes from;
  - every row span, cell span and cell value from `records`, and again from `fields` (the whole record, and fields 1–2), each extracting exactly the generator's bytes, and every cell's byte map against `naive_endpoints` over the generator's display elements;
  - that a page from the middle equals the same rows of the full page.
- **Runtime:** about 75 s on Zack's PC. Most of it is Windows Defender scanning each new temp file: ~6 ms per file, measured against ~1 ms for a rewrite with unchanged content.

- [ ] **Step 1: Write the gate**

Add at the end of `mod tests` in `csv.rs` (before the file's last line, `}`):
<!-- op: append-in-module spikes/core/spike-core/src/csv.rs -->
```rust
    use proptest::prelude::*;

    const ALPHABET: [&str; 14] = ["a", "b", " ", ",", "\t", ";", "|", "\"", "\r", "\n", "é", "😀", "\u{feff}", "\0"];
    const TERMINATORS: [&str; 3] = ["\n", "\r\n", "\r"];

    /// (blank lines before the row, its fields as (value, quote it?), its terminator)
    type GenRow = (usize, Vec<(String, bool)>, usize);
    /// Each record's span, with its fields' spans, original values and display elements (UTF-16 units, source
    /// bytes): what the generator wrote.
    type Expected = Vec<(Span, Vec<(Span, String, Vec<(u32, u64)>)>)>;

    /// Serializes `rows`, quoting a field when asked to or when it must be quoted to round-trip. In Windows-1252,
    /// the chars it lacks become ones it has.
    fn emit(delimiter: u8, bom: bool, w1252: bool, rows: &[GenRow], last_terminated: bool) -> (Vec<u8>, Expected) {
        let enc = |s: &str| if w1252 { encoding_rs::WINDOWS_1252.encode(s).0.into_owned() } else { s.as_bytes().to_vec() };
        let mut b = if bom { BOM.to_vec() } else { Vec::new() };
        let mut expected = Vec::new();
        for (i, (blanks, row, term)) in rows.iter().enumerate() {
            for k in 0..*blanks {
                b.extend_from_slice(TERMINATORS[(term + k) % 3].as_bytes());
            }
            let start = b.len() as u64;
            let mut fields = Vec::new();
            for (j, (value, quote)) in row.iter().enumerate() {
                if j > 0 {
                    b.push(delimiter);
                }
                let value = if w1252 { value.replace('😀', "€").replace('\u{feff}', "ÿ") } else { value.clone() };
                let must = value.bytes().any(|c| [delimiter, b'"', b'\r', b'\n'].contains(&c))
                    || (row.len() == 1 && value.is_empty()) // an empty line is no record
                    || (i == 0 && j == 0 && !bom && value.starts_with('\u{feff}')); // it would read as a BOM
                let field_start = b.len() as u64;
                let quoted = *quote || must;
                // Each char's own bytes (a `"` is written twice inside quotes); the quotes join the first and last.
                let doubled = |c: char| if quoted && c == '"' { 2 } else { 1 };
                let mut elements: Vec<(u32, u64)> = value.chars().map(|c| (c.len_utf16() as u32, enc(&c.to_string()).len() as u64 * doubled(c))).collect();
                if quoted {
                    b.push(b'"');
                    b.extend_from_slice(&enc(&value.replace('"', "\"\"")));
                    b.push(b'"');
                    if let Some(first) = elements.first_mut() {
                        first.1 += 1;
                    }
                    if let Some(last) = elements.last_mut() {
                        last.1 += 1;
                    }
                } else {
                    b.extend_from_slice(&enc(&value));
                }
                fields.push((Span { start: field_start, end: b.len() as u64 }, value, elements));
            }
            expected.push((Span { start, end: b.len() as u64 }, fields));
            if i + 1 < rows.len() || last_terminated {
                b.extend_from_slice(TERMINATORS[*term].as_bytes());
            }
        }
        (b, expected)
    }

    fn arb_row() -> impl Strategy<Value = GenRow> {
        let value = prop::collection::vec(prop::sample::select(ALPHABET.to_vec()), 0..8).prop_map(|v| v.concat());
        (0usize..3, prop::collection::vec((value, any::<bool>()), 1..7), 0usize..3)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]
        #[test]
        fn span_fidelity(
            delimiter in prop::sample::select(DELIMITERS.to_vec()),
            bom in any::<bool>(),
            w1252 in any::<bool>(),
            rows in prop::collection::vec(arb_row(), 0..25),
            last_terminated in any::<bool>(),
            cp_records in 1u64..8,
            cp_bytes in 1u64..64,
        ) {
            let bom = bom && !w1252;
            let (bytes, expected) = emit(delimiter, bom, w1252, &rows, last_terminated);
            let path = temp_file("csv-fidelity", &bytes);
            let encoding = if w1252 { encoding_rs::WINDOWS_1252 } else { UTF_8 };
            let (store, idx) = index_path(&path, CsvConfig { delimiter, cp_records, cp_bytes, block: CHUNK, encoding });
            let naive_cfg = CsvConfig { delimiter, cp_records: u64::MAX, cp_bytes: 1 << 40, block: CHUNK, encoding };
            let (_, naive) = index_path(&path, naive_cfg);
            prop_assert_eq!(naive.checkpoints.len(), 1); // a full scan from offset 0 for every record
            prop_assert_eq!(idx.records, expected.len() as u64);
            for (n, (span, _)) in expected.iter().enumerate() {
                let n = n as u64;
                let start = locate_record(&store, &idx, n).unwrap();
                prop_assert_eq!(start, Some(span.start));
                prop_assert_eq!(locate_record(&store, &naive, n).unwrap(), start);
                prop_assert!(span.start - idx.start_cp(n).offset <= cp_bytes, "start rescan over cp_bytes");
                prop_assert!(span.end - idx.end_cp(n).offset <= cp_bytes, "end rescan over cp_bytes");
            }
            let got = records(&store, &idx, 0, u32::MAX).unwrap();
            prop_assert_eq!(got.len(), expected.len());
            for (row, (span, want)) in got.iter().zip(&expected) {
                prop_assert_eq!(row.span, *span);
                prop_assert_eq!(store.read(span.start, span.end).unwrap(), &bytes[span.start as usize..span.end as usize]);
                let again = fields(&store, &idx, row.span, 0, usize::MAX).unwrap();
                let tail = fields(&store, &idx, row.span, 1, 2).unwrap();
                prop_assert_eq!(&tail[..], &again[1.min(again.len())..3.min(again.len())]);
                for cells in [&row.cells, &again] {
                    prop_assert_eq!(cells.len(), want.len());
                    for (cell, (field_span, value, elements)) in cells.iter().zip(want) {
                        prop_assert_eq!(cell.span, *field_span);
                        let raw = store.read(cell.span.start, cell.span.end).unwrap();
                        prop_assert_eq!(raw, &bytes[field_span.start as usize..field_span.end as usize]);
                        prop_assert_eq!(&cell.text, value);
                        prop_assert!(!cell.more);
                        let ours: Vec<(u64, u64)> = (0..=cell.map.units()).map(|u| (cell.map.start_byte(u), cell.map.end_byte(u))).collect();
                        prop_assert_eq!(ours, crate::bytemap::naive_endpoints(field_span.start, elements));
                    }
                }
            }
            if !expected.is_empty() {
                let k = expected.len() / 2;
                let page = records(&store, &idx, k as u64, 3).unwrap();
                prop_assert_eq!(&page[..], &got[k..(k + 3).min(got.len())]);
            }
        }
    }
```

- [ ] **Step 2: Run the gate**

Run (`spikes/core`): `cargo test -p spike-core span_fidelity`
Expected: `1 passed; 0 failed; 0 ignored; 0 measured; 87 filtered out`, after about 75–85 s (proptest notes that the test "has been running for over 60 seconds"), then `0 passed` with `1 filtered out` for `tests\json_spans.rs`.

- [ ] **Step 3: Falsify the gate: break mid-record resume and watch it fail**

In `Tok::at`, temporarily replace
<!-- op: temporary spikes/core/spike-core/src/csv.rs -->
```rust
        let reader = cp.mid.as_deref().map_or_else(|| primed(delimiter), copy_reader);
```
with
```rust
        let reader = primed(delimiter); // FALSIFY: drop the saved mid-record state
```
Run (`spikes/core`): `cargo test -p spike-core csv::`
Expected: FAIL, `21 passed; 3 failed; 0 ignored; 0 measured; 64 filtered out`.
- `span_fidelity` fails within its first few cases (proptest seeds each run at random: four runs failed after 0, 4, 1 and 0 passing cases), then shrinks to a `minimal failing input`. Three of them failed on `locate_record` (`left: None`, `right: Some(…)`), one on a record's start (`left: Some(104)`, `right: Some(101)`).
- `a_checkpoint_inside_a_quoted_field_resumes_there` fails with `resumed at 2`, `left: Some(4)`, `right: Some(9)`.
- `an_unterminated_quote_runs_to_eof_as_one_200mb_record` fails with a record that ends early: `end: 199229446` instead of `200000009`.

Restore the original line. Delete `spikes/core/spike-core/proptest-regressions/`, where proptest saved the failing seed (it's gitignored since Task C0; delete it anyway):
- Git Bash: `rm -r spike-core/proptest-regressions`
- PowerShell: `Remove-Item -Recurse -Force spike-core/proptest-regressions`

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `87 passed; 0 failed; 1 ignored`, then `1 passed` for `tests\json_spans.rs`.

- [ ] **Step 4: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/csv.rs
git commit -m "spike(c): CSV span-fidelity gate over 10,000 generated tables"
```

---

## Task C3c: CSV fixtures and sequential index throughput

**Files:**
- Modify: `spikes/core/fixtures-gen/src/lib.rs` (`csv()` and two tests)
- Modify: `spikes/core/fixtures-gen/src/main.rs` (the `csv` subcommand)
- Modify: `spikes/core/spike-core/src/csv.rs` (the ignored `csv_throughput` measurement, at the end of `mod tests`)
- Create (gitignored): `spikes/.fixtures/100m.csv`, `1g.csv` (deleted in Step 8), `1m-x20.csv`, `5000-cols.csv`
- Create: `spikes/results/csv-throughput.txt`

**Interfaces:**
- **Consumes:** Task C3a's `sniff`, `build`, `records`, `Tok`, `Checkpoint`, `CANCEL_EVERY`; plan A Task 5's `index::{build, IndexConfig, LineIndex}`.
- **Produces:**
  - `fixtures_gen::csv<W: Write>(w: &mut W, target_bytes: u64, rows: u64, cols: usize, quoted_per_mille: u64) -> io::Result<u64>`.
    - It writes a header row `c0,c1,…`, then records whose columns cycle through integer, decimal, word and date, until `rows` records or `target_bytes`, whichever comes first. It returns the record count, header excluded.
    - About `quoted_per_mille`‰ of fields are quoted, holding a comma, doubled quotes and an embedded newline.
    - The word columns have 5 distinct values, so Spike B's value-pill rule applies to them.
  - CLI: `fixtures-gen csv --out <path> [--bytes N] [--rows N] [--cols N] [--quoted N]`. Defaults: 20 columns, 10‰ quoted, and 100 MiB when `--rows` isn't given.
  - `spikes/results/csv-throughput.txt`: CSV index against the line index, both from the page cache and in memory, plus page latency.

- [ ] **Step 1: Write the failing generator tests**

In `spikes/core/fixtures-gen/src/lib.rs`, add below Task C2c's `json_doc`, directly above `#[cfg(test)]`:
<!-- op: insert-before spikes/core/fixtures-gen/src/lib.rs :: #[cfg(test)] -->
```rust
const WORDS: [&str; 5] = ["alpha", "bravo", "charlie", "delta", "echo"];

/// CSV with a header row `c0,c1,…` and typed columns (integer, decimal, word, date), until `rows` records or
/// `target_bytes`, whichever comes first. About `quoted_per_mille`‰ of fields are quoted and hold a comma,
/// doubled quotes and an embedded newline. Returns the record count, header excluded.
pub fn csv<W: Write>(w: &mut W, target_bytes: u64, rows: u64, cols: usize, quoted_per_mille: u64) -> io::Result<u64> {
    todo!()
}
```
Add at the end of `mod tests` (before the file's last line, `}`):
<!-- op: append-in-module spikes/core/fixtures-gen/src/lib.rs -->
```rust
    #[test]
    fn csv_has_a_header_typed_columns_and_quoted_newlines() {
        let mut out = Vec::new();
        assert_eq!(csv(&mut out, u64::MAX, 2_000, 20, 10).unwrap(), 2_000);
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("c0,c1,c2,c3,"), "{}", &s[..40]);
        let quoted = s.matches(" note, with \"\"quotes\"\"\nand a second line\"").count();
        assert!((250..=550).contains(&quoted), "{quoted} quoted fields of 40,000");
        assert!(s.contains(",alpha,") && s.contains(",2026-"));
    }

    #[test]
    fn csv_stops_at_the_byte_target() {
        let mut out = Vec::new();
        let n = csv(&mut out, 100_000, u64::MAX, 20, 10).unwrap();
        assert!(out.len() >= 100_000 && out.len() < 102_000, "{}", out.len());
        assert!(n > 500, "{n}");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: FAIL with `not yet implemented`: `3 passed; 2 failed`.

- [ ] **Step 3: Implement the generator and the subcommand**

Replace the stub `csv` function (from its `pub fn csv` line to its closing `}`) with:
<!-- op: replace-fn spikes/core/fixtures-gen/src/lib.rs -->
```rust
pub fn csv<W: Write>(w: &mut W, target_bytes: u64, rows: u64, cols: usize, quoted_per_mille: u64) -> io::Result<u64> {
    use std::fmt::Write as _;
    let mut line = (0..cols).map(|j| format!("c{j}")).collect::<Vec<_>>().join(",") + "\n";
    w.write_all(line.as_bytes())?;
    let (mut written, mut n) = (line.len() as u64, 0u64);
    while n < rows && written < target_bytes {
        line.clear();
        for j in 0..cols as u64 {
            if j > 0 {
                line.push(',');
            }
            let k = n * cols as u64 + j;
            let _ = if (k.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) % 1000 < quoted_per_mille {
                write!(line, "\"row {n} note, with \"\"quotes\"\"\nand a second line\"")
            } else {
                match j % 4 {
                    0 => write!(line, "{}", k % 1_000_003),
                    1 => write!(line, "{}.{:02}", k % 10_000, k % 100),
                    2 => write!(line, "{}", WORDS[(k % 5) as usize]),
                    _ => write!(line, "2026-{:02}-{:02}", k % 12 + 1, k % 28 + 1),
                }
            };
        }
        line.push('\n');
        w.write_all(line.as_bytes())?;
        written += line.len() as u64;
        n += 1;
    }
    Ok(n)
}
```
In `src/main.rs`, add below the `Some("jsonl-huge-first")` arm, directly above Task C2c's `Some("json")` arm:
<!-- op: insert-adjacent-before spikes/core/fixtures-gen/src/main.rs :: Some("json") => { -->
```rust
        Some("csv") => {
            let rows = num("--rows", u64::MAX);
            let bytes = num("--bytes", if rows == u64::MAX { 100 << 20 } else { u64::MAX });
            let n = fixtures_gen::csv(&mut w, bytes, rows, num("--cols", 20) as usize, num("--quoted", 10))?;
            eprintln!("{out}: header + {n} records");
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: `5 passed`.

- [ ] **Step 5: Generate the CSV fixtures**

Run (`spikes/core`):
```bash
cargo run --release -p fixtures-gen -- csv --bytes 104857600 --cols 20 --out ../.fixtures/100m.csv
cargo run --release -p fixtures-gen -- csv --bytes 1073741824 --cols 20 --out ../.fixtures/1g.csv
cargo run --release -p fixtures-gen -- csv --rows 1000000 --cols 20 --out ../.fixtures/1m-x20.csv
cargo run --release -p fixtures-gen -- csv --rows 1000 --cols 5000 --out ../.fixtures/5000-cols.csv
```
Expected (about 1.3 GiB in all):
- `../.fixtures/100m.csv: header + 621096 records` (104,857,760 bytes)
- `../.fixtures/1g.csv: header + 6351494 records` (1,073,741,851 bytes)
- `../.fixtures/1m-x20.csv: header + 1000000 records` (168,865,475 bytes)
- `../.fixtures/5000-cols.csv: header + 1000 records` (42,093,067 bytes)

`100m.csv` is spec §13.1's "100MB CSV". `1m-x20.csv` and `5000-cols.csv` are the Grid shapes Spike B needs (its 1M×20 grid and the 5,000-column CSV).

- [ ] **Step 6: Add the measurement**

Add at the end of `mod tests` in `spikes/core/spike-core/src/csv.rs` (before the file's last line, `}`):
<!-- op: append-in-module spikes/core/spike-core/src/csv.rs -->
```rust
    /// Spec §3.5 / §10.2: sequential CSV indexing against plan A's line index on the same bytes, warm, plus the
    /// same two scans in memory (no I/O, no hashing) and 64-row page latency. Reads `spikes/.fixtures/{100m,1g}.csv`.
    /// Run: cargo test --release -p spike-core csv_throughput -- --ignored --nocapture
    #[test]
    #[ignore]
    fn csv_throughput() {
        use crate::index::{self, IndexConfig, LineIndex};
        let stat = |mut v: Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            format!("n={} p50 {:.2} min {:.2} max {:.2}", v.len(), v[v.len() / 2], v[0], v[v.len() - 1])
        };
        for name in ["100m.csv", "1g.csv"] {
            let path = Path::new("../../.fixtures").join(name);
            let Ok(store) = ByteStore::open(&path) else {
                println!("{name}: missing, skipped");
                continue;
            };
            let (len, delimiter) = (store.len(), sniff(&store).unwrap().delimiter);
            let csv_index = || {
                let shared = RwLock::new(CsvIndex::default());
                let (file, cfg) = (File::open(&path).unwrap(), CsvConfig { delimiter, ..CsvConfig::default() });
                build(&file, len, cfg, &ChunkHashes::default(), &shared, &AtomicBool::new(false), |_| {}).unwrap();
                shared.into_inner().unwrap()
            };
            let line_index = || {
                let shared = RwLock::new(LineIndex::default());
                let file = File::open(&path).unwrap();
                index::build(&file, len, IndexConfig::default(), &ChunkHashes::default(), &shared, |_| {}).unwrap();
                shared.into_inner().unwrap()
            };
            let bytes = std::fs::read(&path).unwrap();
            let tokenize = || {
                let mut tok = Tok::fresh(delimiter, 0, 0);
                while tok.pos < len {
                    let p = tok.pos as usize;
                    tok.step(&bytes[p..(p + CANCEL_EVERY as usize).min(bytes.len())]);
                }
                tok.record + u64::from(tok.in_record)
            };
            let (idx, lines) = (csv_index(), line_index()); // warm-up: the file is in the page cache from here on
            assert_eq!(tokenize(), idx.records);
            let gbps = |f: &dyn Fn()| {
                let t = Instant::now();
                f();
                len as f64 / t.elapsed().as_secs_f64() / 1e9
            };
            let (mut csv, mut line, mut csv_mem, mut line_mem) = (vec![], vec![], vec![], vec![]);
            for _ in 0..7 {
                csv.push(gbps(&|| drop(csv_index())));
                line.push(gbps(&|| drop(line_index())));
                csv_mem.push(gbps(&|| _ = std::hint::black_box(tokenize())));
                line_mem.push(gbps(&|| _ = std::hint::black_box(memchr::memchr_iter(b'\n', &bytes).count())));
            }
            let pages: Vec<f64> = (0..200u64)
                .map(|i| {
                    let t = Instant::now();
                    assert!(!records(&store, &idx, (i * 2_654_435_761) % idx.records, 64).unwrap().is_empty());
                    t.elapsed().as_secs_f64() * 1e6
                })
                .collect();
            let mids = idx.checkpoints.iter().filter(|c| c.mid.is_some()).count();
            let memory = idx.checkpoints.len() * size_of::<Checkpoint>() + mids * size_of::<Reader>();
            println!("{name}: {len} bytes, {} records, {} lines", idx.records, lines.line_count());
            let sizes = (size_of::<Checkpoint>(), size_of::<Reader>());
            println!("  checkpoints {} ({mids} mid-record), ~{} KiB ({} B each + {} B per mid)", idx.checkpoints.len(), memory / 1024, sizes.0, sizes.1);
            println!("  csv index, GB/s:              {}", stat(csv));
            println!("  line index, GB/s:             {}", stat(line));
            println!("  csv-core in memory, GB/s:     {}", stat(csv_mem));
            println!("  memchr '\\n' in memory, GB/s:  {}", stat(line_mem));
            println!("  records(_, 64), µs:           {}", stat(pages));
        }
    }
```
Run (`spikes/core`): `cargo test -p spike-core`
Expected: `87 passed; 0 failed; 2 ignored`, then `1 passed` for `tests\json_spans.rs`.

- [ ] **Step 7: Measure sequential CSV indexing, warm**

Run (`spikes/core`), in Git Bash:
```bash
cargo test --release -p spike-core csv_throughput -- --ignored --nocapture | tee ../results/csv-throughput.txt
```
Run this in Git Bash: PowerShell's redirection writes a BOM under 5.1 and none under 7, so the committed file would differ by shell.

Each fixture is indexed once to warm the page cache, then n=7 times by each index. The scratch run printed (other lanes were building on the same machine at the time):
```text
100m.csv: 104857760 bytes, 621097 records, 745301 lines
  checkpoints 607 (0 mid-record), ~14 KiB (24 B each + 440 B per mid)
  csv index, GB/s:              n=7 p50 1.01 min 0.98 max 1.03
  line index, GB/s:             n=7 p50 4.28 min 3.95 max 4.55
  csv-core in memory, GB/s:     n=7 p50 1.21 min 1.16 max 1.25
  memchr '\n' in memory, GB/s:  n=7 p50 21.83 min 16.93 max 23.74
  records(_, 64), µs:           n=200 p50 523.10 min 131.70 max 1155.40
1g.csv: 1073741851 bytes, 6351495 records, 7621830 lines
  checkpoints 6203 (0 mid-record), ~145 KiB (24 B each + 440 B per mid)
  csv index, GB/s:              n=7 p50 1.00 min 0.99 max 1.02
  line index, GB/s:             n=7 p50 4.28 min 3.86 max 4.35
  csv-core in memory, GB/s:     n=7 p50 1.24 min 1.19 max 1.25
  memchr '\n' in memory, GB/s:  n=7 p50 22.99 min 19.92 max 23.60
  records(_, 64), µs:           n=200 p50 603.10 min 169.20 max 1467.40
```
Then run (`spikes/core`): `cargo test --release -p spike-core cancel_returns -- --nocapture`
Expected: `2 passed`: the filter also matches Task C2a's `json::tests::cancel_returns_within_50ms`, which prints `cancel latency, max over 20 runs: …`. The CSV test prints `cancel: n=21, max …`, under 2 ms (scratch runs: 0.59–1.33 ms; the replay: 1.02 ms). The lane measured ~20 ms in a debug build, one 4 MiB block's hashing between checks; Task C1d's debug-build opt-level for `xxhash-rust` brings that to about 1 ms.

Judge the CSV index against spec §10.2's 1 GB/s line-index budget on the PC, and record the verdict in the Spike C report. In the scratch run:
- it sat at the budget (p50 1.00–1.01 GB/s, min 0.98), not above it with margin;
- it was bound by csv-core, not by I/O or hashing: csv-core alone, in memory, reached 1.21–1.24 GB/s, while the line index reached 4.28 GB/s from the page cache.

- [ ] **Step 8: Delete the 1 GiB fixture**

Git Bash: `rm ../.fixtures/1g.csv`. PowerShell: `Remove-Item ../.fixtures/1g.csv`.

- [ ] **Step 9: Read your own work (rule 8), then commit**

```bash
git add spikes/core/fixtures-gen/src/lib.rs spikes/core/fixtures-gen/src/main.rs spikes/core/spike-core/src/csv.rs spikes/results/csv-throughput.txt
git commit -m "spike(c): CSV fixtures and sequential CSV index throughput"
```

---

## Task C4a: The raw-HTML escape pass and the sanitizer

**The Markdown pipeline (Tasks C4a–C4e):**
- **Block index (Task C4c).** pulldown-cmark parses a whole `&str` and can't be interrupted, so it only ever sees one 64 KiB window. A window starts at a block boundary. After the parse, the index keeps the blocks before the last line that no top-level block or reference definition straddles, and the next window starts there. A block that fills its window from the first line is *oversized*: a scanner without pulldown-cmark finds its end, 256 KiB per step, and cuts it into sub-blocks of at most 32 KiB (code by lines, lists by items, tables by rows, paragraphs at word boundaries, else Raw source with a note). Every step is bounded, and a window also checks the flag every 1,024 parser events and headings, committing nothing when it's set, so a cancel is honoured within one step or one 1,024-block stretch of a window.
- **Items.** An item is a block, or one sub-block of an oversized block, rendered alone as sanitized HTML (Task C4b). No item holds more than 64 KiB of text (UTF-16 units) or 256 KiB of HTML: anything over that renders as Raw pieces. A page is at most 256 KiB of HTML, checked before each push.
- **Byte maps.** Every DOM text node of an item is a *run* with a `ByteMap` (Task C1a). Run k is the k-th Text node under the item's root, in document order (a `TreeWalker` with `SHOW_TEXT`). Markup belongs to the content it wraps: an opening marker (`**`, `[`, `# `, `> `, a fence line, an escape's `\`) joins the next displayed character, and a closing marker (`**`, `](url)`, a line ending) joins the previous one. No map needs a zero-unit element, so Task C1a's snapping is unchanged. This settles what a selection edge next to a marker copies, which lane C1 left open.
- **Sanitizing (Task C4a).** Raw HTML goes through an escape pass first: a tag on the brief's allowlist passes verbatim, and everything else (any other tag, a comment, a declaration, a lone `<`) becomes literal text. Then ammonia, with the allowlist plus the emitter's own markup, runs over the whole fragment. Last, every `<img>` becomes `<span class="tp-img" data-src=… data-alt=…>`, so no URL from the file reaches a resource-loading attribute, and every link's target is judged once (`target`): http, https, mailto and relative paths that aren't network paths stay live; any other scheme (`file:`, `smb:`, `ms-settings:`) or a network path (`//host`, `\\host`) becomes `href="#"` with the target in `data-href`, for the renderer's hand-off to decide on a click (brief §4.4); javascript, vbscript and data are dropped. Every link keeps an `href`, so it keeps its role and keyboard focus (brief §9). An image keeps `data-src` only for a live target. SVG and MathML are never allowed. Mermaid and math become inert placeholders.

**Files:**
- Modify: `spikes/core/spike-core/Cargo.toml` (`ammonia`)
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod sanitize;`)
- Create: `spikes/core/spike-core/src/sanitize.rs`

**Interfaces:**
- **Consumes:** `memchr` (already a dependency), `ammonia` 4.2.4 (added here).
- **Produces (`spike_core::sanitize`):**
  - `pub const RAW_TAGS: [&str; 20]`: brief §4.6's allowlist (`b i em strong code kbd sub sup br hr details summary a img table thead tbody tr th td`); `a` keeps `href` (as `data-href`, see `escape_raw`), `img` keeps `src` and `alt`.
  - `pub const OWN_TAGS: [&str; 16]`: the emitter's own tags. Raw HTML can't produce them.
  - `pub fn escape_raw(s: &str, out: &mut String)`: one `Html`/`InlineHtml` event's text into `out`. Allowlisted tags pass verbatim, except that an `a` tag's `href` (any case) becomes `data-href`; every other complete tag is escaped whole, and if the input ends inside a tag, the rest is escaped. Tag ends follow the WHATWG tokenizer (quoted `>` doesn't end a tag). Linear time.
  - `pub fn allowed_tag(s: &str) -> bool`: `s` is exactly one allowlisted tag.
  - `pub fn escape_text(s: &str, out: &mut String)`: escapes `&`, `<`, `>` and U+00A0 exactly as html5ever serializes them, so emitted text and sanitized text compare equal.
  - `pub fn escape_attr(s: &str) -> String`: the same, plus `"`.
  - `pub enum Target { Live, Inert, Dropped }` and `pub fn target(url: &str) -> Target`: a link or image target as WHATWG URL parsing reads it (C0 controls and spaces trimmed, tabs and newlines removed, `\` read as `/`). `//`, `\\`, `/\` or `\/` first is a network path: `Inert`. Otherwise an `http`, `https` or `mailto` scheme, or none, is `Live`; `javascript`, `vbscript` or `data` is `Dropped`; any other scheme is `Inert`.
  - `pub fn sanitize(html: &str) -> String`: ammonia (allowlist plus `OWN_TAGS`, per-tag attributes and classes, no generic attributes, schemes `http`/`https`/`mailto`, no `rel` added), then `<img>` → the placeholder, with `data-src` only for a `Live` target, and every `<a>` rebuilt from its `data-href` (or `href`) alone: `Live` → `<a href="v">`, `Inert` → `<a href="#" data-href="v">`, `Dropped` → `<a href="#">`. Running it again on its output is the identity.
  - **For Task C5b (the renderer):** a click on an `<a>` reads `data-href` when there is one and hands it to spec §7.2's hand-off; otherwise it reads `href`. `data-src` appears only for live targets (http, https, relative, and `mailto`, which is harmless).
  - `pub fn segments(html: &str) -> Vec<&str>`: the text between tags of serialized HTML, one entry per DOM text node.

- [ ] **Step 1: Add the dependency and write the failing tests**

In `spikes/core/spike-core/Cargo.toml`, add `ammonia` at the top of `[dependencies]`:
<!-- op: replace spikes/core/spike-core/Cargo.toml -->
```toml
[dependencies]
```
```toml
[dependencies]
ammonia = "4.2.4"
```
In `src/lib.rs`, add `pub mod sanitize;` above `pub mod store;`:
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub mod store;
```
```rust
pub mod sanitize;
pub mod store;
```

`spikes/core/spike-core/src/sanitize.rs`:
<!-- op: create spikes/core/spike-core/src/sanitize.rs -->
```rust
//! Raw HTML and the final pass over every emitted fragment (brief §4.6, spec §4.6).
//! - `escape_raw`: an allowlisted tag passes through verbatim for ammonia to sanitize. Every other `<` becomes
//!   `&lt;`, so a disallowed tag, a comment or a declaration renders as literal text (ammonia alone would strip
//!   the tag and keep its content, or drop `<script>`'s content).
//! - `sanitize`: ammonia with the brief's allowlist plus the emitter's own markup, then every `<img>` becomes an
//!   inert placeholder carrying its URL in `data-src`, so no URL from the file reaches a resource-loading attribute.
//! - Link targets (brief §4.4, §4.6): links reach ammonia with their target in `data-href`, which it keeps as data,
//!   and `sanitize` decides once (`target`): a live `href`, `href="#"` plus `data-href` for the hand-off, or dropped.
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::LazyLock;

/// Brief §4.6: the only tags raw HTML may contribute. `a[href]` and `img[src alt]` keep those attributes.
pub const RAW_TAGS: [&str; 20] = [
    "b", "i", "em", "strong", "code", "kbd", "sub", "sup", "br", "hr", "details", "summary", "a", "img", "table", "thead",
    "tbody", "tr", "th", "td",
];

/// The emitter's own tags. Raw HTML can't produce them: `escape_raw` escapes them like any other tag.
pub const OWN_TAGS: [&str; 16] = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "del", "span", "div", "input"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlisted_tags_pass_and_everything_else_is_literal_text() {
        let mut out = String::new();
        escape_raw(r#"<B title="a>b">x</b> <script>alert(1)</script> <!-- c --> a < b > c <br/> <img src=x onerror=y>"#, &mut out);
        assert_eq!(
            out,
            r#"<B title="a>b">x</b> &lt;script&gt;alert(1)&lt;/script&gt; &lt;!-- c --&gt; a &lt; b &gt; c <br/> <img src=x onerror=y>"#
        );
    }

    #[test]
    fn tag_ends_follow_the_tokenizer() {
        let end = |s: &str| tag_at(s.as_bytes(), 0);
        assert_eq!(end(r#"<a href='x>y' title=z/>rest"#), Some((23, "a".into()))); // quoted '>' and an unquoted '/'
        assert_eq!(end("<a\nhref=x>"), Some((10, "a".into())));
        assert_eq!(end("</TD x>"), Some((7, "td".into())));
        assert_eq!(end("<a =x>"), Some((6, "a".into())));
        assert_eq!(end("<a href=\"x"), None); // the input ends inside the tag: HTML drops it, we show it
        assert_eq!(end("<1>"), None);
        assert_eq!(end("</>"), None);
        assert_eq!(end("<!-- x -->"), None);
    }

    #[test]
    fn an_unterminated_tag_makes_the_rest_literal_in_linear_time() {
        let hostile = "<a ".repeat(200_000);
        let t = std::time::Instant::now();
        let mut out = String::new();
        escape_raw(&hostile, &mut out);
        assert_eq!(out, "&lt;a ".repeat(200_000));
        assert!(t.elapsed().as_secs() < 2, "{:?}", t.elapsed());
    }

    #[test]
    fn sanitize_strips_attributes_and_schemes_and_replaces_images() {
        let got = sanitize(
            r#"<p><b style="x" onclick="y" title="t">b</b> <a href="javascript:alert(1)">j</a> <a href="java&#115;cript:x">e</a> <a href="https://x.y/?a=1&amp;b">ok</a> <img src="http://evil/t.png" alt="A&quot;B" onerror="z"></p>"#,
        );
        assert_eq!(
            got,
            r#"<p><b>b</b> <a>j</a> <a>e</a> <a href="https://x.y/?a=1&amp;b">ok</a> <span class="tp-img" data-src="http://evil/t.png" data-alt="A&quot;B"></span></p>"#
        );
        assert_eq!(sanitize(&got), got, "idempotent");
    }

    #[test]
    fn segments_are_the_text_between_tags() {
        assert_eq!(segments("<p>a <b>b</b><br> &amp;c</p>"), vec!["a ", "b", " &amp;c"]);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core sanitize`
Expected: ``error: could not compile `spike-core` (lib test) due to 6 previous errors; 4 warnings emitted``. `E0425` cannot find function `escape_raw` (2), `tag_at` (1), `segments` (1); `E0423` expected function, found built-in attribute `sanitize` (2). The warnings are the imports only the implementation uses.

- [ ] **Step 3: Implement**

Add to `sanitize.rs`, above the `tests` module:
<!-- op: insert-before spikes/core/spike-core/src/sanitize.rs :: #[cfg(test)] -->
```rust
static AMMONIA: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let attrs: [(&str, &[&str]); 8] = [
        ("a", &["href", "data-href"]),
        ("img", &["src", "alt"]),
        // The emitter's attributes sit only on its own tags, so raw HTML can't smuggle them onto RAW_TAGS.
        ("ol", &["start"]),
        ("pre", &["data-lang"]),
        ("input", &["type", "checked", "disabled"]),
        ("span", &["data-src", "data-alt", "data-fn"]),
        ("div", &["data-align", "data-fn"]),
        ("blockquote", &["data-kind", "data-tint"]),
    ];
    let classes: [(&str, &[&str]); 4] = [
        ("span", &["tp-img", "tp-math", "tp-math-display", "tp-wiki", "tp-fnref"]),
        ("pre", &["tp-mermaid", "tp-frontmatter", "tp-raw"]),
        ("div", &["tp-html", "tp-table", "tp-footnote"]),
        ("blockquote", &["tp-callout"]),
    ];
    let set = |v: &[&'static str]| v.iter().copied().collect::<HashSet<_>>();
    let mut b = ammonia::Builder::empty();
    b.tags(RAW_TAGS.iter().chain(&OWN_TAGS).copied().collect())
        .tag_attributes(attrs.iter().map(|&(t, a)| (t, set(a))).collect::<HashMap<_, _>>())
        .allowed_classes(classes.iter().map(|&(t, c)| (t, set(c))).collect::<HashMap<_, _>>())
        .generic_attributes(HashSet::new()) // ammonia's default allows `lang` and `title` everywhere
        .url_schemes(["http", "https", "mailto"].into())
        .link_rel(None);
    b
});

const WS: [u8; 5] = [b'\t', b'\n', 0x0C, b'\r', b' '];

/// If a start or end tag begins at `s[i]` (a `<`), its end (just past `>`) and lowercase name, following the
/// WHATWG tokenizer's tag and attribute states. None for anything else: a comment, a declaration, a lone `<`,
/// or a tag the input ends inside.
fn tag_at(s: &[u8], i: usize) -> Option<(usize, String)> {
    tag_parts(s, i).map(|(end, name, _)| (end, name))
}

/// `tag_at`, plus where each attribute name is.
fn tag_parts(s: &[u8], i: usize) -> Option<(usize, String, Vec<Range<usize>>)> {
    let mut j = i + 1 + usize::from(s.get(i + 1) == Some(&b'/'));
    if !s.get(j)?.is_ascii_alphabetic() {
        return None;
    }
    let name_start = j;
    while j < s.len() && !WS.contains(&s[j]) && s[j] != b'/' && s[j] != b'>' {
        j += 1;
    }
    let name = String::from_utf8_lossy(&s[name_start..j]).to_ascii_lowercase();
    let mut attrs = Vec::new();
    loop {
        match *s.get(j)? {
            b'>' => return Some((j + 1, name, attrs)),
            c if WS.contains(&c) || c == b'/' => j += 1,
            _ => {
                let a = j;
                j += 1; // an attribute name; its first char may be '='
                while j < s.len() && !WS.contains(&s[j]) && !b"/>=".contains(&s[j]) {
                    j += 1;
                }
                attrs.push(a..j);
                while j < s.len() && WS.contains(&s[j]) {
                    j += 1;
                }
                if s.get(j) == Some(&b'=') {
                    j += 1;
                    while j < s.len() && WS.contains(&s[j]) {
                        j += 1;
                    }
                    match *s.get(j)? {
                        q @ (b'"' | b'\'') => j += 2 + memchr::memchr(q, &s[j + 1..])?,
                        b'>' => {}
                        _ => {
                            while j < s.len() && !WS.contains(&s[j]) && s[j] != b'>' {
                                j += 1;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Raw HTML (an `Html` or `InlineHtml` event) into `out`: allowlisted tags verbatim, except that an `a` tag's `href`
/// (any case) becomes `data-href`, everything else as text. Text keeps its `&` (entities mean what they mean in
/// HTML); `<` and `>` outside allowlisted tags are escaped.
pub fn escape_raw(s: &str, out: &mut String) {
    let b = s.as_bytes();
    let (mut i, mut done) = (0, 0);
    while let Some(k) = memchr::memchr2(b'<', b'>', &b[i..]) {
        let at = i + k;
        out.push_str(&s[done..at]);
        i = at + 1;
        if b[at] == b'<' {
            match tag_parts(b, at) {
                Some((end, name, attrs)) if RAW_TAGS.contains(&name.as_str()) => {
                    let mut from = at;
                    for r in attrs.into_iter().filter(|r| name == "a" && s[r.clone()].eq_ignore_ascii_case("href")) {
                        out.push_str(&s[from..r.start]);
                        out.push_str("data-href");
                        from = r.end;
                    }
                    out.push_str(&s[from..end]);
                    i = end;
                }
                Some((end, ..)) => {
                    // A disallowed tag: all of it is text. Jumping past it keeps the pass linear.
                    out.push_str(&s[at..end].replace('<', "&lt;").replace('>', "&gt;"));
                    i = end;
                }
                None if tag_at_eof(b, at) => {
                    // The input ends inside this tag, and HTML would swallow everything after it: all of it is
                    // text. Stopping here also keeps the pass linear (no re-scan per later `<`).
                    out.push_str(&s[at..].replace('<', "&lt;").replace('>', "&gt;"));
                    return;
                }
                None => out.push_str("&lt;"),
            }
        } else {
            out.push_str("&gt;");
        }
        done = i;
    }
    out.push_str(&s[done..]);
}

/// True when `s` is exactly one allowlisted tag (an `InlineHtml` event that `escape_raw` would pass whole).
pub fn allowed_tag(s: &str) -> bool {
    matches!(tag_at(s.as_bytes(), 0), Some((end, name)) if end == s.len() && RAW_TAGS.contains(&name.as_str()))
}

/// True when `s[i]` starts what would be a tag if the input didn't end first.
fn tag_at_eof(s: &[u8], i: usize) -> bool {
    let j = i + 1 + usize::from(s.get(i + 1) == Some(&b'/'));
    s.get(j).is_some_and(u8::is_ascii_alphabetic)
}

/// HTML-escapes text exactly as html5ever serializes it, so emitted text and sanitized text compare equal.
pub fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{A0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

/// An attribute value, double-quoted by the caller.
pub fn escape_attr(s: &str) -> String {
    let mut out = String::new();
    escape_text(s, &mut out);
    out.replace('"', "&quot;")
}

/// What a link or image target may become (brief §4.4, §4.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// http, https, mailto, or a relative path that isn't a network path: a live `href` or `data-src`.
    Live,
    /// Any other scheme (`file:`, `smb:`, …) or a network path (`//host`, `\\host`): inert data, for the hand-off
    /// to decide on a click.
    Inert,
    /// javascript, vbscript and data: nothing is kept.
    Dropped,
}

/// Classifies `url` (decoded) as WHATWG URL parsing reads it: C0 controls and spaces trimmed, tabs and newlines
/// removed, `\` read as `/`, and a scheme an ASCII letter then letters, digits, `+`, `-` or `.` before a `:`.
pub fn target(url: &str) -> Target {
    let s: String = url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let b = s.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\') {
        return Target::Inert;
    }
    let scheme = s.split_once(':').map(|(scheme, _)| scheme).filter(|scheme| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    match scheme.map(str::to_ascii_lowercase).as_deref() {
        None | Some("http" | "https" | "mailto") => Target::Live,
        Some("javascript" | "vbscript" | "data") => Target::Dropped,
        Some(_) => Target::Inert,
    }
}

/// Every fragment's last step: ammonia, then `<img>` → placeholder, and each link's target judged once: a live
/// `href`, `href="#"` with an inert `data-href`, or `href="#"` alone. Every link keeps an href, so it keeps its
/// role and keyboard focus (brief §9).
pub fn sanitize(html: &str) -> String {
    let clean = AMMONIA.clean(html).to_string();
    // ponytail: a string rewrite of ammonia's serialization, where `<` only ever opens a tag and attribute values
    // are double-quoted with `"`, `<` and `>` escaped. A DOM rewrite would need ammonia's unstable rcdom API.
    let mut out = String::with_capacity(clean.len());
    let mut rest = clean.as_str();
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let end = i + rest[i..].find('>').map_or(rest.len() - i, |e| e + 1);
        let tag = &rest[i..end];
        let value = |name: &str| tag.split_once(&format!(" {name}=\"")).map(|(_, v)| &v[..v.find('"').unwrap_or(v.len())]);
        let judge = |v: &str| target(&v.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", "\u{A0}").replace("&amp;", "&"));
        if tag.starts_with("<img") {
            out.push_str("<span class=\"tp-img\"");
            for (attr, v) in [("data-src", value("src").filter(|v| judge(v) == Target::Live)), ("data-alt", value("alt"))] {
                if let Some(v) = v {
                    out.push_str(&format!(" {attr}=\"{v}\""));
                }
            }
            out.push_str("></span>");
        } else if let Some(v) = tag.strip_prefix("<a ").and(value("data-href").or_else(|| value("href"))) {
            match judge(v) {
                Target::Live => out.push_str(&format!("<a href=\"{v}\">")),
                Target::Inert => out.push_str(&format!("<a href=\"#\" data-href=\"{v}\">")),
                Target::Dropped => out.push_str("<a href=\"#\">"),
            }
        } else {
            out.push_str(tag);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// The text between tags in sanitized HTML, as serialized: one entry per DOM text node.
pub fn segments(html: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = html;
    loop {
        let i = rest.find('<').unwrap_or(rest.len());
        if i > 0 {
            out.push(&rest[..i]);
        }
        match rest[i..].find('>') {
            Some(e) => rest = &rest[i + e + 1..],
            None => return out,
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core sanitize`
Expected: `test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 89 filtered out`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/Cargo.toml spikes/core/Cargo.lock spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/sanitize.rs
git commit -m "spike(c): raw-HTML escape pass and ammonia sanitizer with inert image placeholders"
```

---

## Task C4b: The emitter — sanitized HTML per block, a byte map per text run

**Files:**
- Modify: `spikes/core/spike-core/Cargo.toml` (`pulldown-cmark`)
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod mdemit;`)
- Create: `spikes/core/spike-core/src/mdemit.rs`

**Interfaces:**
- **Consumes:**
  - `bytemap::{ByteMap, MapBuilder}` and `encoding::decode(bytes: &[u8], encoding: &'static Encoding, start_offset: u64) -> TextSlice` (`TextSlice { text: String, map: ByteMap, replacements: u32 }`) from Tasks C1a and C1b;
  - `sanitize::{Target, allowed_tag, escape_attr, escape_raw, escape_text, sanitize, segments, target}` (Task C4a);
  - `pulldown-cmark` 0.13.4, pinned `=0.13.4` because Task C4c's scanner mirrors this version's block rules, with default features off (added here): `Parser::new_with_broken_link_callback`, `into_offset_iter`, `reference_definitions`. Its own HTML writer is not used.
- **Produces (`spike_core::mdemit`):**
  - `pub const OPTIONS: Options`: tables, footnotes, strikethrough, task lists, math, GFM (GitHub's five alert kinds) and wikilinks: seven of the eight extensions spec §4.6 lists, all native to 0.13.4. The eighth, YAML front matter, isn't among them: pulldown-cmark accepts a metadata block at any block start, so Task C4c finds front matter at the file's start itself. Obsidian callouts (brief §5.2) are recognized by the emitter on top. Options 0.13.4 also has but the spec doesn't ask for stay off: smart punctuation, heading attributes, `+++` metadata blocks, old footnotes, definition lists, superscript and subscript.
  - `pub const MAX_DEPTH: usize = 64`: deeper nesting sets `too_deep` and renders nothing.
  - `pub const RAW_HTML_BLOCK: &str`, `pub const RESTRUCTURED: &str`: the two `unmapped` reasons.
  - `pub struct Src` (`Debug, Clone`), with `pub fn at(&self, off: usize) -> u64`: decoded UTF-8 offset (a char boundary) → absolute source byte offset, in u64.
  - `pub struct Run { pub text: String, pub map: ByteMap }` (`Debug, Clone, PartialEq`): one DOM text node.
  - `pub struct Fragment { pub html: String, pub runs: Vec<Run>, pub unmapped: Option<&'static str>, pub too_deep: bool }` (`Debug, Clone`). `html` is sanitized.
  - `pub fn decode_slice(bytes: &[u8], encoding: &'static Encoding, start: u64) -> (String, Src)`: valid UTF-8 is copied, anything else goes through Task C1b's `decode`; a lone CR becomes LF (one byte for one byte, so no offset moves).
  - `pub fn emit(text: &str, lo: usize, hi: usize, at: &dyn Fn(usize) -> u64, links: &mut dyn FnMut(&str) -> Option<(String, String)>) -> Fragment`: renders `text[lo..hi]`. A synthetic prefix before `lo` and appended definitions after `hi` shape the parse but emit nothing. `links` resolves a reference label the parse can't find, to `(dest, title)`.
  - `pub fn emit_plain(text: &str, shown: &[Range<usize>], at: &dyn Fn(usize) -> u64, open: &str, close: &str) -> Fragment`: the `shown` ranges displayed one to one inside `open`…`close` (code lines, Raw source).

**Design notes:**
- **Flat loop.** The emitter walks pulldown-cmark's events with an explicit stack of closing tags, so file-controlled nesting never recurses. Past `MAX_DEPTH` it flags `too_deep` and `finish` discards the output; the index then shows the block as Raw.
- **Mapping.** For each `Text` event, the emitter looks for the displayed text inside the source range pulldown-cmark reports. If it is found, its chars pair one to one and the source around it is markup: a code span's backticks, an entity's tail. If not (a tab expanded to spaces, say), the equal leading and trailing chars pair one to one and the differing middle is one element. Unclaimed bytes before a displayed character (an escape's `\`, an opening marker) join it, and an event's trailing bytes join its last character.
- **The mapped check.** After sanitizing, `segments(html)` must equal the runs' text. If ammonia restructured raw HTML (merged, dropped or reordered text), the fragment is `unmapped` and an endpoint maps to the item's whole span. A raw HTML *block* is always unmapped: the HTML parser decodes its entities.
- **Inert extensions.** Mermaid fences become `<pre class="tp-mermaid">` source and math becomes `<span class="tp-math">` (or `tp-math-display`) source: placeholders for the renderer's sandboxed passes. Footnote references are `<span class="tp-fnref" data-fn=…>`, wikilinks `<span class="tp-wiki">` around an `<a>` (resolving it is brief §4.4's later work), front matter (Task C4c) `<pre class="tp-frontmatter">`. Every link (normal, e-mail, wiki, and an allowlisted raw `<a>`) carries its target as `data-href` into `sanitize`, which decides whether it becomes a live `href`; an image writes `data-src` only when its target is `Live`. Callouts are `<blockquote class="tp-callout" data-kind=… data-tint=…>`, with the `[!kind]` marker hidden but mapped.

- [ ] **Step 1: Add the dependency and write the failing tests**

In `spikes/core/spike-core/Cargo.toml`, add `pulldown-cmark` below `memchr`:
<!-- op: replace spikes/core/spike-core/Cargo.toml -->
```toml
memchr = "2.8"
```
```toml
memchr = "2.8"
pulldown-cmark = { version = "=0.13.4", default-features = false }
```
In `src/lib.rs`, add `pub mod mdemit;` above `pub mod pages;`:
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub mod pages;
```
```rust
pub mod mdemit;
pub mod pages;
```

`spikes/core/spike-core/src/mdemit.rs`:
<!-- op: create spikes/core/spike-core/src/mdemit.rs -->
```rust
//! Markdown → one sanitized HTML fragment per block or sub-block, with a byte map per text run (spec §3.2, §4.6).
//! The emitter is a flat loop over pulldown-cmark's events with an explicit stack, so file-controlled nesting
//! never recurses.
//!
//! **Markers at selection edges** (brief §7.4; C1's open question 1). Every source byte of an item belongs to
//! exactly one displayed character's element, and markup belongs to the content it wraps:
//! - an opening marker (`**`, `[`, `# `, `> `, a fence line, an escape's `\`) joins the next displayed character;
//! - a closing marker (`**`, `](url)`, a line ending) joins the previous one.
//!
//! So selecting `a ` in `a **b** c` copies `a `, selecting `b` copies `**b**`, and an endpoint reported at the
//! end of one DOM text node or at the start of the next maps to the same byte. No map needs a zero-unit element,
//! so `bytemap.rs`'s snapping is unchanged.
//!
//! **Pairing a DOM text node with its run.** In a mapped fragment, run k is the k-th Text node in document order
//! under the item's root (a TreeWalker with `SHOW_TEXT`). The emitter starts a new run at every tag it writes,
//! and after sanitizing, the text between tags must equal the runs (`sanitize::segments`), or the fragment is
//! `unmapped`: a raw HTML block, or raw HTML that ammonia restructured (merged, dropped or reordered text). In an
//! unmapped fragment a selection endpoint maps to the item's whole span.
use std::ops::Range;

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use pulldown_cmark::{Alignment, BlockQuoteKind, BrokenLink, CodeBlockKind, Event, LinkType, Options, Parser, Tag};

use crate::bytemap::{ByteMap, MapBuilder};
use crate::encoding::decode;
use crate::sanitize::{Target, allowed_tag, escape_attr, escape_raw, escape_text, sanitize, segments, target};

/// Spec §4.6's extensions, all native to pulldown-cmark 0.13.4. `ENABLE_GFM` parses GitHub's five alert kinds.
/// Front matter isn't among them: pulldown-cmark accepts a metadata block at any block start, so `md` finds it at
/// the file's start itself.
pub const OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS)
    .union(Options::ENABLE_MATH)
    .union(Options::ENABLE_GFM)
    .union(Options::ENABLE_WIKILINKS);

/// Deeper nesting renders as Raw source (Chromium's parser flattens past 512 levels anyway).
pub const MAX_DEPTH: usize = 64;
pub const RAW_HTML_BLOCK: &str = "raw HTML block: the HTML parser decodes its entities and may restructure it";
pub const RESTRUCTURED: &str = "the sanitizer changed the text structure of raw HTML";

/// Brief §5.2's callout tints. GitHub's five kinds come from pulldown-cmark; Obsidian's are found here.
const CALLOUTS: [(&str, &str); 16] = [
    ("note", "blue"),
    ("info", "blue"),
    ("todo", "blue"),
    ("tip", "green"),
    ("success", "green"),
    ("important", "purple"),
    ("question", "purple"),
    ("example", "purple"),
    ("warning", "yellow"),
    ("caution", "pink"),
    ("danger", "pink"),
    ("error", "pink"),
    ("bug", "pink"),
    ("failure", "pink"),
    ("quote", "neutral"),
    ("abstract", "neutral"),
];

/// Decoded-text offsets → source byte offsets for one decoded slice. pulldown-cmark reports UTF-8 offsets into
/// the decoded text; this composes them with the decode (C1's `decode`) back to file offsets.
/// Between points each decoded byte is `k` source bytes (1, or 2 for UTF-16); a point follows every character
/// whose source length differs (non-ASCII Windows-1252 or UTF-16, U+FFFD for malformed bytes).
#[derive(Debug, Clone)]
pub struct Src {
    base: u64,
    k: u64,
    points: Vec<(usize, u64)>,
}

/// One DOM text node's text and its map from UTF-16 offsets to source bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub text: String,
    pub map: ByteMap,
}

#[derive(Debug, Clone)]
pub struct Fragment {
    /// Sanitized.
    pub html: String,
    pub runs: Vec<Run>,
    pub unmapped: Option<&'static str>,
    pub too_deep: bool,
}

struct Emitter<'a> {
    text: &'a str,
    /// The real text is `text[lo..hi]`; before it is a synthetic prefix, after it appended definitions.
    lo: usize,
    hi: usize,
    html: String,
    /// Display text and elements `(units, decoded start, decoded end)` per run.
    runs: Vec<(String, Vec<(u32, usize, usize)>)>,
    /// The last run takes more text: no tag has been written since.
    open: bool,
    /// Bytes before this belong to an element; bytes after it join the next displayed character.
    cursor: usize,
    /// The closing HTML of every open tag.
    stack: Vec<&'static str>,
    /// Depth inside a skipped (synthetic) subtree.
    skip: usize,
    raw: Option<String>,
    raw_block: bool,
    /// A callout marker, hidden from display.
    suppress: Range<usize>,
    head: bool,
    body: bool,
    too_deep: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::WINDOWS_1252;

    fn render(md: &str) -> Fragment {
        emit(md, 0, md.len(), &|o| o as u64, &mut |_| None)
    }

    fn texts(f: &Fragment) -> Vec<&str> {
        f.runs.iter().map(|r| r.text.as_str()).collect()
    }

    /// Selection [u0 in run r0, u1 in run r1) → source bytes.
    fn copy<'a>(md: &'a str, f: &Fragment, (r0, u0): (usize, u32), (r1, u1): (usize, u32)) -> &'a str {
        &md[f.runs[r0].map.start_byte(u0) as usize..f.runs[r1].map.end_byte(u1) as usize]
    }

    /// Every source byte belongs to exactly one element: the runs' maps tile [0, len).
    fn assert_tiles(f: &Fragment, len: usize) {
        let mut at = 0;
        for r in &f.runs {
            assert_eq!(r.map.start_byte(0), at, "{:?}", f.runs);
            assert_eq!(r.text.encode_utf16().count() as u32, r.map.units());
            at = r.map.end_byte(r.map.units());
        }
        assert_eq!(at, if f.runs.is_empty() { 0 } else { len as u64 });
    }

    #[test]
    fn markers_belong_to_the_content_they_wrap() {
        let md = "a **b** c\n";
        let f = render(md);
        assert_eq!(f.html, "<p>a <strong>b</strong> c</p>");
        assert_eq!(texts(&f), ["a ", "b", " c"]);
        assert_eq!(copy(md, &f, (0, 0), (0, 2)), "a "); // C1's case: no trailing `**`
        assert_eq!(copy(md, &f, (1, 0), (1, 1)), "**b**");
        assert_eq!(copy(md, &f, (0, 2), (1, 1)), "**b**"); // start reported at the end of the previous node
        assert_eq!(copy(md, &f, (1, 0), (2, 0)), "**b**"); // end reported at the start of the next node
        assert_eq!(copy(md, &f, (1, 1), (2, 2)), " c\n");
        assert_tiles(&f, md.len());
    }

    #[test]
    fn entities_escapes_and_line_endings_map_to_their_source() {
        let md = "a &amp; &#x1F600; \\*x\r\n`` `c` `` [l](u \"t\")\n";
        let f = render(md);
        assert_eq!(texts(&f), ["a & 😀 *x\n", "`c`", " ", "l"]);
        let r = &f.runs[0];
        let span = |u0, u1| &md[r.map.start_byte(u0) as usize..r.map.end_byte(u1) as usize];
        assert_eq!(span(2, 3), "&amp;");
        assert_eq!(span(4, 6), "&#x1F600;");
        assert_eq!(span(5, 5), "&#x1F600;"); // inside the surrogate pair: snaps outward
        assert_eq!(span(7, 8), "\\*");
        assert_eq!(span(9, 10), "\r\n");
        assert_eq!(copy(md, &f, (1, 0), (1, 3)), "`` `c` ``");
        assert_eq!(copy(md, &f, (3, 0), (3, 1)), "[l](u \"t\")\n");
        assert_tiles(&f, md.len());
    }

    #[test]
    fn every_block_kind_tiles_its_source() {
        for md in [
            "# Title #\n",
            "Setext\n===\n",
            "> quote\nlazy\n> more\n",
            "- a\n  - b\n\n- c\n",
            "1. x\n2. y\n",
            "| a | b |\n|:-|-:|\n| 1 | 2 \\| 3 |\n",
            "```rust\nfn main() {}\r\n```\n",
            "    indented\n\tcode\n",
            "[^1]: a note\n",
            "- [ ] task\n- [x] done\n",
            "a  \nb\\\nc ~~d~~ $x$ $$y$$\n",
            "![alt *e*](i.png) <http://x.y> <a@b.c> [[Page|alias]]\n",
            "---\n",
        ] {
            let f = render(md);
            assert_tiles(&f, md.len());
            assert_eq!(f.unmapped, None, "{md:?}");
        }
    }

    #[test]
    fn extensions_render_to_inert_markup() {
        let html = |md: &str| render(md).html;
        assert_eq!(html("| a | b |\n|:-|-:|\n| 1 | 2 |\n"), r#"<div class="tp-table" data-align="lr"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>"#);
        assert_eq!(html("- [x] done\n"), r#"<ul><li><input type="checkbox" disabled="" checked="">done</li></ul>"#);
        assert_eq!(html("~~d~~\n"), "<p><del>d</del></p>");
        assert_eq!(html("x[^n]\n\n[^n]: y\n"), r#"<p>x<span class="tp-fnref" data-fn="n">n</span></p><div class="tp-footnote" data-fn="n"><p>y</p></div>"#);
        assert_eq!(html("> [!NOTE]\n> hi\n"), r#"<blockquote class="tp-callout" data-kind="note" data-tint="blue"><p>hi</p></blockquote>"#);
        assert_eq!(html("$a<b$ $$c$$\n"), r#"<p><span class="tp-math">a&lt;b</span> <span class="tp-math-display">c</span></p>"#);
        assert_eq!(html("[[Page Name]]\n"), r#"<p><span class="tp-wiki"><a href="Page Name">Page Name</a></span></p>"#);
        assert_eq!(html("```mermaid\ngraph TD; A-->B\n```\n"), r#"<pre class="tp-mermaid"><code>graph TD; A--&gt;B
</code></pre>"#);
        assert_eq!(html("```rust\nx\n```\n"), r#"<pre data-lang="rust"><code>x
</code></pre>"#);
        // No URL from the file reaches a resource-loading attribute: images are placeholders, and a network path
        // isn't kept even as data.
        assert_eq!(html("![a](//evil/x.png) ![b](\\\\\\\\host\\share\\x.png) ![c](c.png)\n"), r#"<p><span class="tp-img">a</span> <span class="tp-img">b</span> <span class="tp-img" data-src="c.png">c</span></p>"#);
        assert_eq!(html("[j](javascript:alert(1)) [m](mailto:a@b.c)\n"), r##"<p><a href="#">j</a> <a href="mailto:a@b.c">m</a></p>"##);
    }

    #[test]
    fn link_targets_are_live_inert_or_dropped() {
        // Brief §4.4, §4.6, §9: every link stays an `<a>` with an href, so it keeps its role and keyboard focus. Only
        // http, https, mailto and relative paths that aren't network paths are live; any other target rides in
        // `data-href` for the hand-off to decide on a click; javascript, vbscript and data are dropped. Markdown and
        // raw HTML follow the same rule.
        for (target, want) in [
            ("https://ok/?a=1&b", r#"href="https://ok/?a=1&amp;b""#),
            ("mailto:a@b.c", r#"href="mailto:a@b.c""#),
            ("docs/a.md#x", r#"href="docs/a.md#x""#),
            ("file:///C:/x", r##"href="#" data-href="file:///C:/x""##),
            ("smb://h/s", r##"href="#" data-href="smb://h/s""##),
            ("ms-settings:display", r##"href="#" data-href="ms-settings:display""##),
            ("//evil/x", r##"href="#" data-href="//evil/x""##),
            ("javascript:alert(1)", r##"href="#""##),
            ("VBScript:x", r##"href="#""##),
            ("data:text/html,x", r##"href="#""##),
        ] {
            let want = format!("<p><a {want}>l</a></p>");
            assert_eq!(render(&format!("[l]({target})\n")).html, want, "{target}");
            assert_eq!(render(&format!("<a href=\"{target}\">l</a>\n")).html, want, "raw {target}");
        }
        assert_eq!(render("<a href=\"  \\\\evil\\s\">u</a>\n").html, r##"<p><a href="#" data-href="  \\evil\s">u</a></p>"##);
        // pulldown-cmark reads `[[\\evil\share]]` as `\evil\share`, a root-relative path; it takes three to write `\\`.
        assert_eq!(render("[[\\\\evil\\share]]\n").html, r#"<p><span class="tp-wiki"><a href="\evil\share">\evil\share</a></span></p>"#);
        assert_eq!(render("[[\\\\\\evil\\share]]\n").html, r##"<p><span class="tp-wiki"><a href="#" data-href="\\evil\share">\\evil\share</a></span></p>"##);
    }

    #[test]
    fn obsidian_callouts_hide_their_marker() {
        let md = "> [!Info]- Title\n> body\n";
        let f = render(md);
        assert_eq!(f.html, r#"<blockquote class="tp-callout" data-kind="info" data-tint="blue"><p>Title
body</p></blockquote>"#);
        assert_eq!(copy(md, &f, (0, 0), (0, 1)), "> [!Info]- T");
        assert_tiles(&f, md.len());
        assert_eq!(render("> [!nope] x\n").html, "<blockquote><p>[!nope] x</p></blockquote>");
    }

    #[test]
    fn raw_html_is_allowlisted_or_literal() {
        let f = render("a <kbd>K</kbd> <span onclick=x>s</span> <!-- c -->\n");
        assert_eq!(f.html, "<p>a <kbd>K</kbd> &lt;span onclick=x&gt;s&lt;/span&gt; &lt;!-- c --&gt;</p>");
        assert_eq!(f.unmapped, None);
        assert_eq!(texts(&f), ["a ", "K", " <span onclick=x>s</span> <!-- c -->"]);
        let block = render("<div>\n<script>x</script>\n<b>ok</b>\n</div>\n");
        assert_eq!(block.html, "<div class=\"tp-html\">&lt;div&gt;\n&lt;script&gt;x&lt;/script&gt;\n<b>ok</b>\n&lt;/div&gt;\n</div>");
        assert_eq!(block.unmapped, Some(RAW_HTML_BLOCK));
        let stray = render("a </b> c\n");
        assert_eq!((stray.html.as_str(), stray.unmapped), ("<p>a  c</p>", Some(RESTRUCTURED)));
    }

    #[test]
    fn deep_nesting_is_flagged_not_recursed() {
        let md = "> ".repeat(10_000) + "x\n";
        assert!(render(&md).too_deep);
        assert!(!render("> > x\n").too_deep);
    }

    #[test]
    fn decoded_offsets_compose_with_the_decode() {
        let (text, src) = decode_slice(b"\xE9t\xE9 &amp;", WINDOWS_1252, 1 << 33);
        assert_eq!(text, "été &amp;");
        let offs: Vec<u64> = [0, 2, 3, 5, 6, 11].iter().map(|&o| src.at(o) - (1 << 33)).collect();
        assert_eq!(offs, [0, 1, 2, 3, 4, 9]);
        let le: Vec<u8> = [0xFF, 0xFE].into_iter().chain("aé😀b".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        let (text, src) = decode_slice(&le, UTF_16LE, 0);
        let offs: Vec<u64> = [0, 1, 3, 7, 8].iter().map(|&o| src.at(o)).collect();
        assert_eq!((text.as_str(), offs), ("aé😀b", vec![2, 4, 6, 10, 12]));
        let (text, src) = decode_slice(b"a\xE2\x82b", UTF_8, 7);
        let offs: Vec<u64> = [0, 1, 4, 5].iter().map(|&o| src.at(o)).collect();
        assert_eq!((text.as_str(), offs), ("a\u{FFFD}b", vec![7, 8, 10, 11]));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core mdemit`
Expected: ``error: could not compile `spike-core` (lib test) due to 4 previous errors; 5 warnings emitted``, all `E0425`: cannot find function `decode_slice` (3), `emit` (1). The warnings are unused imports.

- [ ] **Step 3: Implement**

Add to `mdemit.rs`, above the `tests` module:
<!-- op: insert-before spikes/core/spike-core/src/mdemit.rs :: #[cfg(test)] -->
```rust
impl Src {
    /// The source offset of decoded offset `off`, a char boundary: the slice's base plus the local offset, in u64.
    pub fn at(&self, off: usize) -> u64 {
        let i = self.points.partition_point(|p| p.0 <= off);
        let (o, b) = if i == 0 { (0, self.base) } else { self.points[i - 1] };
        b + (off - o) as u64 * self.k
    }
}

/// Decodes `bytes`, which start at file offset `start`. Valid UTF-8 is copied as is; anything else goes through
/// C1's `decode` (a file-start BOM is skipped there too), and its map becomes `Src` points.
/// A lone CR becomes LF: CommonMark ends a line at either, but pulldown-cmark 0.13.4 misreads a fence opener, front
/// matter or a final line ended by a lone CR. Both are one byte, so no offset moves. (Reads that may stop between a
/// CR and its LF drop the CR first: see `md::trim_to_char`.)
pub fn decode_slice(bytes: &[u8], encoding: &'static Encoding, start: u64) -> (String, Src) {
    let bom = match Encoding::for_bom(bytes) {
        Some((e, n)) if e == encoding && start == 0 => n,
        _ => 0,
    };
    if encoding == UTF_8
        && let Ok(s) = std::str::from_utf8(&bytes[bom..])
    {
        return (lone_cr_to_lf(s.to_owned()), Src { base: start + bom as u64, k: 1, points: Vec::new() });
    }
    let slice = decode(bytes, encoding, start);
    let k = if encoding == UTF_16LE || encoding == UTF_16BE { 2 } else { 1 };
    let mut src = Src { base: slice.map.start_byte(0), k, points: Vec::new() };
    let (mut u, mut off, mut at) = (0u32, 0usize, src.base);
    for c in slice.text.chars() {
        let (n8, n16) = (c.len_utf8(), c.len_utf16() as u32);
        let end = slice.map.end_byte(u + n16);
        if end - at != n8 as u64 * k {
            src.points.push((off + n8, end));
        }
        (u, off, at) = (u + n16, off + n8, end);
    }
    (lone_cr_to_lf(slice.text), src)
}

fn lone_cr_to_lf(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    let mut b = text.into_bytes();
    for i in 0..b.len() {
        if b[i] == b'\r' && b.get(i + 1) != Some(&b'\n') {
            b[i] = b'\n';
        }
    }
    String::from_utf8(b).expect("swapping one ASCII byte for another keeps UTF-8 valid")
}

/// Renders `text[lo..hi]` (pulldown-cmark parses all of `text`: a synthetic prefix before `lo` and appended
/// definitions after `hi` shape the parse but emit nothing). `at` maps decoded offsets in `lo..=hi` to source
/// bytes. `links` resolves a reference label pulldown-cmark couldn't find in `text`, to `(dest, title)`.
pub fn emit(text: &str, lo: usize, hi: usize, at: &dyn Fn(usize) -> u64, links: &mut dyn FnMut(&str) -> Option<(String, String)>) -> Fragment {
    let mut resolve = |link: BrokenLink| links(&link.reference).map(|(dest, title)| (dest.into(), title.into()));
    let parser = Parser::new_with_broken_link_callback(text, OPTIONS, Some(&mut resolve));
    let mut e = Emitter::new(text, lo, hi);
    for (event, range) in parser.into_offset_iter() {
        e.event(event, range);
    }
    e.finish(at)
}

/// Text shown as it is (code lines, Raw source) inside `open`…`close`: the `shown` ranges of `text` display one
/// to one, and every other byte is markup that joins a neighbouring element.
pub fn emit_plain(text: &str, shown: &[Range<usize>], at: &dyn Fn(usize) -> u64, open: &str, close: &str) -> Fragment {
    let mut e = Emitter::new(text, 0, text.len());
    e.tag(open);
    for r in shown {
        e.one_to_one(&text[r.clone()], r.start);
    }
    e.tag(close);
    e.finish(at)
}

const TABLE_END: &str = "</table></div>";
const HEAD_END: &str = "</tr></thead>";
const HEADING_ENDS: [&str; 6] = ["</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>"];

impl<'a> Emitter<'a> {
    fn new(text: &'a str, lo: usize, hi: usize) -> Emitter<'a> {
        Emitter {
            text,
            lo,
            hi,
            html: String::new(),
            runs: Vec::new(),
            open: false,
            cursor: lo,
            stack: Vec::new(),
            skip: 0,
            raw: None,
            raw_block: false,
            suppress: 0..0,
            head: false,
            body: false,
            too_deep: false,
        }
    }

    fn event(&mut self, event: Event, r: Range<usize>) {
        match event {
            Event::Start(_) if self.skip > 0 || r.end <= self.lo || r.start >= self.hi => self.skip += 1,
            Event::End(_) if self.skip > 0 => self.skip -= 1,
            _ if self.skip > 0 || r.end <= self.lo || r.start >= self.hi => {}
            Event::Start(tag) => {
                let (open, close) = self.start(tag, r.start);
                self.tag(&open);
                self.stack.push(close);
                self.too_deep |= self.stack.len() > MAX_DEPTH;
            }
            Event::End(_) => {
                self.close(r.end);
                let close = self.stack.pop().unwrap_or("");
                if close.is_empty()
                    && let Some(raw) = self.raw.take()
                {
                    self.html.push_str("<div class=\"tp-html\">");
                    escape_raw(&raw, &mut self.html);
                    self.html.push_str("</div>");
                }
                if close == TABLE_END && self.body {
                    self.html.push_str("</tbody>");
                    self.body = false;
                }
                self.head &= close != HEAD_END;
                self.tag(close);
            }
            Event::Text(t) | Event::Html(t) if self.raw.is_some() => self.raw.as_mut().unwrap().push_str(&t),
            Event::Text(t) | Event::Html(t) => self.text(&t, r),
            Event::InlineHtml(t) if allowed_tag(&t) => {
                let mut tag = String::new();
                escape_raw(&t, &mut tag); // one allowlisted tag: passed whole, an `a` tag's href renamed
                self.tag(&tag);
                if t.starts_with("</") {
                    self.close(r.end);
                }
            }
            Event::InlineHtml(t) => self.text(&t, r),
            Event::Code(t) => self.wrapped("<code>", &t, r, "</code>"),
            Event::InlineMath(t) => self.wrapped("<span class=\"tp-math\">", &t, r, "</span>"),
            Event::DisplayMath(t) => self.wrapped("<span class=\"tp-math-display\">", &t, r, "</span>"),
            Event::FootnoteReference(label) => {
                let open = format!("<span class=\"tp-fnref\" data-fn=\"{}\">", escape_attr(&label));
                self.wrapped(&open, &label, r, "</span>");
            }
            Event::SoftBreak => self.element("\n", r.start, r.end),
            Event::HardBreak => self.tag("<br>"),
            Event::Rule => self.tag("<hr>"),
            Event::TaskListMarker(checked) => {
                self.tag(if checked { r#"<input type="checkbox" disabled="" checked="">"# } else { r#"<input type="checkbox" disabled="">"# })
            }
        }
    }

    /// The opening HTML for a tag, and its closing HTML.
    fn start(&mut self, tag: Tag, at: usize) -> (String, &'static str) {
        let s = |open: &str, close: &'static str| (open.to_string(), close);
        match tag {
            Tag::Paragraph => s("<p>", "</p>"),
            Tag::Heading { level, .. } => (format!("<h{}>", level as usize), HEADING_ENDS[level as usize - 1]),
            Tag::BlockQuote(kind) => {
                let name = match kind {
                    Some(BlockQuoteKind::Note) => Some("note".to_string()),
                    Some(BlockQuoteKind::Tip) => Some("tip".into()),
                    Some(BlockQuoteKind::Important) => Some("important".into()),
                    Some(BlockQuoteKind::Warning) => Some("warning".into()),
                    Some(BlockQuoteKind::Caution) => Some("caution".into()),
                    None => self.obsidian(at),
                };
                match name.and_then(|n| CALLOUTS.iter().find(|c| c.0 == n)) {
                    Some((kind, tint)) => (format!("<blockquote class=\"tp-callout\" data-kind=\"{kind}\" data-tint=\"{tint}\">"), "</blockquote>"),
                    None => s("<blockquote>", "</blockquote>"),
                }
            }
            Tag::CodeBlock(CodeBlockKind::Fenced(info)) => match info.split_whitespace().next().unwrap_or("") {
                "" => s("<pre><code>", "</code></pre>"),
                lang if lang.eq_ignore_ascii_case("mermaid") => s("<pre class=\"tp-mermaid\"><code>", "</code></pre>"),
                lang => (format!("<pre data-lang=\"{}\"><code>", escape_attr(lang)), "</code></pre>"),
            },
            Tag::CodeBlock(CodeBlockKind::Indented) => s("<pre><code>", "</code></pre>"),
            Tag::HtmlBlock => {
                self.raw = Some(String::new());
                self.raw_block = true;
                s("", "")
            }
            Tag::List(Some(1)) => s("<ol>", "</ol>"),
            Tag::List(Some(n)) => (format!("<ol start=\"{n}\">"), "</ol>"),
            Tag::List(None) => s("<ul>", "</ul>"),
            Tag::Item => s("<li>", "</li>"),
            Tag::FootnoteDefinition(label) => (format!("<div class=\"tp-footnote\" data-fn=\"{}\">", escape_attr(&label)), "</div>"),
            Tag::Table(aligns) => {
                let align: String = aligns
                    .iter()
                    .map(|a| match a {
                        Alignment::Left => 'l',
                        Alignment::Center => 'c',
                        Alignment::Right => 'r',
                        Alignment::None => '-',
                    })
                    .collect();
                (format!("<div class=\"tp-table\" data-align=\"{align}\"><table>"), TABLE_END)
            }
            Tag::TableHead => {
                self.head = true;
                s("<thead><tr>", HEAD_END)
            }
            Tag::TableRow => {
                let open = if self.body { "<tr>" } else { "<tbody><tr>" };
                self.body = true;
                s(open, "</tr>")
            }
            Tag::TableCell if self.head => s("<th>", "</th>"),
            Tag::TableCell => s("<td>", "</td>"),
            Tag::Emphasis => s("<em>", "</em>"),
            Tag::Strong => s("<strong>", "</strong>"),
            Tag::Strikethrough => s("<del>", "</del>"),
            Tag::Superscript => s("<sup>", "</sup>"),
            Tag::Subscript => s("<sub>", "</sub>"),
            // A link's target travels as `data-href`: `sanitize` decides whether it becomes a live href.
            Tag::Link { link_type: LinkType::WikiLink { .. }, dest_url, .. } => {
                (format!("<span class=\"tp-wiki\"><a data-href=\"{}\">", escape_attr(&dest_url)), "</a></span>")
            }
            Tag::Link { link_type: LinkType::Email, dest_url, .. } => (format!("<a data-href=\"mailto:{}\">", escape_attr(&dest_url)), "</a>"),
            Tag::Link { dest_url, .. } => (format!("<a data-href=\"{}\">", escape_attr(&dest_url)), "</a>"),
            // Brief §4.6: images load later, behind the per-file bar. Here the URL is inert data, and only a live one.
            Tag::Image { dest_url, .. } if target(&dest_url) == Target::Live => {
                (format!("<span class=\"tp-img\" data-src=\"{}\">", escape_attr(&dest_url)), "</span>")
            }
            Tag::Image { .. } => s("<span class=\"tp-img\">", "</span>"),
            Tag::MetadataBlock(_) => s("<pre class=\"tp-frontmatter\"><code>", "</code></pre>"),
            Tag::DefinitionList | Tag::DefinitionListTitle | Tag::DefinitionListDefinition => s("<div>", "</div>"),
        }
    }

    /// An Obsidian callout marker, `[!kind]` with an optional fold sign, opening a quote's first line. A known
    /// kind's marker (and the spaces after it, or the line ending if nothing follows) is hidden from display.
    fn obsidian(&mut self, at: usize) -> Option<String> {
        let line = self.text[at..].trim_start_matches(' ').strip_prefix('>')?;
        let inner = line.trim_start_matches([' ', '\t']);
        let n = inner.strip_prefix("[!")?.find(']')?;
        let kind = inner[2..2 + n].to_ascii_lowercase();
        CALLOUTS.iter().find(|c| c.0 == kind)?;
        let start = self.text.len() - inner.len();
        let rest = inner[3 + n..].strip_prefix(['+', '-']).unwrap_or(&inner[3 + n..]);
        let rest = rest.trim_start_matches([' ', '\t']);
        let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix(['\n', '\r'])).unwrap_or(rest);
        self.suppress = start..self.text.len() - rest.len();
        Some(kind)
    }

    fn tag(&mut self, html: &str) {
        self.html.push_str(html);
        self.open = false;
    }

    fn wrapped(&mut self, open: &str, display: &str, r: Range<usize>, close: &str) {
        self.tag(open);
        self.text(display, r);
        self.tag(close);
    }

    /// Display text `d` from the source `text[r]`. The common case is `d` found inside the source: its chars pair
    /// one to one, and the source around it is markup (a code span's backticks, an entity's tail). Otherwise equal
    /// leading and trailing chars pair one to one and the differing middle is one element (an entity, a tab
    /// expanded to spaces).
    fn text(&mut self, d: &str, r: Range<usize>) {
        let (mut d, mut a) = (d, r.start);
        let b = r.end.min(self.hi);
        if a < self.lo {
            // pulldown-cmark merged a synthetic prefix ("x ") into this text: drop it from the display.
            let Some(rest) = d.strip_prefix(&self.text[a..self.lo]) else { return };
            (d, a) = (rest, self.lo);
        }
        if a >= b {
            return;
        }
        let s = &self.text[a..b];
        if let Some(i) = s.find(d).filter(|_| !d.is_empty()) {
            self.one_to_one(d, a + i);
        } else {
            let p: usize = d.chars().zip(s.chars()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum();
            let q: usize = d[p..].chars().rev().zip(s[p..].chars().rev()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum();
            self.one_to_one(&d[..p], a);
            if d.len() - q > p {
                let middle = d[p..d.len() - q].replace("\r\n", "\n").replace(['\r'], "\n").replace('\0', "\u{FFFD}");
                self.element(&middle, a + p, b - q);
            } else {
                self.close(b - q);
            }
            self.one_to_one(&d[d.len() - q..], b - q);
        }
        self.close(b);
    }

    /// `d` equals the source starting at `a`: one element per char. A `\r` before `\n` joins the `\n`, a lone
    /// `\r` shows as `\n`, and NUL shows as U+FFFD, as the HTML parser would make them.
    fn one_to_one(&mut self, d: &str, a: usize) {
        let mut chars = d.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            let (start, end) = (a + i, a + i + c.len_utf8());
            match c {
                '\r' if chars.peek().is_some_and(|&(_, n)| n == '\n') => {}
                '\r' => self.element("\n", start, end),
                '\0' => self.element("\u{FFFD}", start, end),
                c => self.element(c.encode_utf8(&mut [0; 4]), start, end),
            }
        }
    }

    /// One displayed element ending at decoded offset `b`; it also takes every unclaimed byte before it.
    fn element(&mut self, display: &str, a: usize, b: usize) {
        if self.suppress.start <= a && b <= self.suppress.end {
            return;
        }
        if !self.open {
            self.runs.push((String::new(), Vec::new()));
            self.open = true;
        }
        let end = b.min(self.hi).max(self.cursor);
        let run = self.runs.last_mut().unwrap();
        run.0.push_str(display);
        run.1.push((display.encode_utf16().count() as u32, self.cursor, end));
        self.cursor = end;
        escape_text(display, &mut self.html);
    }

    /// Closing markup up to `end` joins the last displayed element. Before any element, it waits for the first.
    fn close(&mut self, end: usize) {
        let end = end.min(self.hi);
        if end > self.cursor
            && let Some(last) = self.runs.last_mut().and_then(|r| r.1.last_mut())
        {
            last.2 = end;
            self.cursor = end;
        }
    }

    fn finish(mut self, at: &dyn Fn(usize) -> u64) -> Fragment {
        self.close(self.hi);
        if self.too_deep {
            return Fragment { html: String::new(), runs: Vec::new(), unmapped: None, too_deep: true };
        }
        let html = sanitize(&self.html);
        let runs: Vec<Run> = self
            .runs
            .into_iter()
            .map(|(text, elements)| {
                let mut map = MapBuilder::new(at(elements[0].1));
                for &(units, a, b) in &elements {
                    map.push(units, at(b) - at(a));
                }
                Run { text, map: map.finish() }
            })
            .collect();
        let escaped = runs.iter().map(|r| {
            let mut s = String::new();
            escape_text(&r.text, &mut s);
            s
        });
        let mapped = segments(&html).into_iter().map(str::to_string).eq(escaped);
        let unmapped = if self.raw_block {
            Some(RAW_HTML_BLOCK)
        } else if !mapped {
            Some(RESTRUCTURED)
        } else {
            None
        };
        Fragment { html, runs, unmapped, too_deep: false }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core mdemit`
Expected: `test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 94 filtered out`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/Cargo.toml spikes/core/Cargo.lock spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/mdemit.rs
git commit -m "spike(c): iterative Markdown emitter with byte-mapped text runs"
```

---

## Task C4c: The block index — windows, oversized blocks, first screen, pages, reconcile, headings

**Files:**
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod md;`)
- Create: `spikes/core/spike-core/src/md.rs`

**Interfaces:**
- **Consumes:** `store::{ByteStore, StoreError}` (plan A Task 4); `mdemit::{Fragment, OPTIONS, Run, Src, decode_slice, emit, emit_plain}` (Task C4b); `sanitize::escape_attr` (Task C4a); `encoding_rs`; `xxhash_rust::xxh3::xxh3_64`.
- **Produces (`spike_core::md`):**
  - `pub const MAX_ITEM_UNITS: usize = 65_536` (UTF-16 units of text per item), `pub const MAX_PAGE: usize = 262_144` (HTML bytes per page, so per item too).
  - `pub const RAW_NOTE: &str`, `pub const DEEP_NOTE: &str`: the notes on Raw items.
  - `pub struct MdConfig { pub window: usize, pub piece: usize, pub max_blocks: usize }` (`Clone, Copy, Debug`; `Default` = 64 KiB windows, 32 KiB sub-blocks, `usize::MAX` blocks, as JSON's `max_containers` defaults to its maximum). Size `max_blocks` from spec §3.6's budget at the index's measured cost per block (Task C4e).
  - `pub const TOO_MANY_BLOCKS: &str`: why indexing stopped early (spec §3.6); the lens stays locked with it, and Raw remains.
  - `pub enum Kind { Paragraph, Heading, Quote, Code, Html, List, Table, Footnote, Rule, Meta, Other }`.
  - `pub struct Block { pub start: u64, pub end: u64, pub kind: Kind }`: a top-level block, from the start of its first line through its last line's ending. Absolute offsets.
  - `pub enum Piece { Markdown, Code, Raw, Words { newline: bool }, Rows }` and `pub struct Big { pub cuts: Vec<(u64, Piece)>, .. }`: an oversized block's sub-blocks; piece k starts at `cuts[k].0`.
  - `pub struct Heading { pub level: u8, pub text: String, pub slug: String, pub block: u64, pub span: (u64, u64) }`: GitHub's slug, deduplicated with `-1`, `-2` across the document.
  - `pub struct Item { pub block: u64, pub piece: u32, pub pieces: u32, pub span: (u64, u64), pub html: String, pub runs: Vec<Run>, pub unmapped: Option<&'static str>, pub note: Option<&'static str>, pub pending: Vec<u64> }`. Its identity is `(block, piece)`. `pending` holds the hashes of reference and footnote labels not yet indexed when it rendered.
  - `pub struct MdIndex { pub blocks: Vec<Block>, pub big: HashMap<u64, Big>, pub headings: Vec<Heading>, pub pos: u64, pub done: bool, pub stopped: Option<&'static str>, .. }`, with `pub fn heap_bytes(&self) -> usize`. `stopped` is set, with `done`, when indexing stopped at `max_blocks`: the cut is exact, and a window over the budget keeps only its first blocks and their headings.
  - `pub struct MdDoc`:
    - `pub fn new(store: ByteStore, encoding: &'static Encoding, cfg: MdConfig) -> MdDoc`;
    - `pub fn index(&self) -> RwLockReadGuard<'_, MdIndex>`;
    - `pub fn step(&self) -> Result<bool, StoreError>`: one window, or one 256 KiB step of an oversized block's scan; true once complete;
    - `pub fn index_all(&self, cancel: &AtomicBool) -> Result<bool, StoreError>`: steps until done (true) or cancelled (false), checking the flag before every step and, within a window, every 1,024 parser events and headings. A cancelled window leaves the index as it was and is redone whole by the next step. What stays uninterruptible is pulldown-cmark's first pass over one window, the window's cut and its commit;
    - `pub fn first_screen(&self, max_items: usize) -> Result<Vec<Item>, StoreError>`: `page((0, 0), max_items)`;
    - `pub fn page(&self, from: (u64, usize), max_items: usize) -> Result<Vec<Item>, StoreError>`: items from (block, item within it) on, indexing only as far as needed, at most `max_items` and at most `MAX_PAGE` bytes of HTML. The next page continues after the last item returned;
    - `pub fn reconcile(&self, items: &[Item]) -> Result<Vec<Item>, StoreError>`: re-renders only the items whose pending labels the index has since found: the item's block, or only its sub-block of an oversized block, keyed by `(block, piece)`. At most `MAX_PAGE` bytes of HTML per call, in `(block, piece)` order, checked before each push; the caller continues with the items after the last one returned, as with `page`;
    - `pub fn render(&self, block: u64) -> Result<Vec<Item>, StoreError>` and `pub fn piece(&self, block: u64, k: usize) -> Result<Vec<Item>, StoreError>`.

**Design notes:**
- **Front matter exists only at the file's start.** `front_matter` looks for it in the first 64 KiB, after a BOM, by pulldown-cmark 0.13.4's metadata-block rule (a `---` line, a first line that's neither blank nor a closer, then `---` or `...`), and renders it as `Kind::Meta`. No window parses with metadata blocks on, because pulldown-cmark accepts one at any block start: a mid-document `---` … `---` pair is a rule and what follows, at every window size.
- **Where a window cuts.** At the last line start that no top-level block and no reference definition straddles, and whose line is complete. A blank line after indented code, a list or a footnote only counts if a complete non-blank line follows it in the window. The blocks before the cut depend only on lines up to and including the cut line, so they are final.
- **Absolute offsets.** pulldown-cmark reports offsets into the decoded window. `Src::at` composes them with the decode and adds the window's absolute u64 start. Each step asserts the composition: the decode map's end equals the window's start plus the bytes read.
- **Oversized blocks.** The kind comes from the window's parse, trusted only where the parse saw the block's first line and the line after it complete. A paragraph scan that meets a setext underline restarts as a heading, and a setext heading scan that meets a blank or interrupting line first restarts as a paragraph; otherwise a paragraph ends at a blank line or at any line that can interrupt it (pulldown-cmark's rule, except its `|`-table interrupt). A quote ends at a blank line or a line without `>` that interrupts a paragraph (outside the quote, any list marker does); a list ends at a line indented less than its item's content column that is another list's marker, interrupts a paragraph, or follows a blank line. A line outside either that doesn't interrupt is taken as a lazy continuation, which pulldown-cmark rejects when the innermost open block isn't a paragraph: a documented limitation.
- **Pages.** The page cap is checked before each push: `if out.len() == max_items || !out.is_empty() && bytes + item.html.len() > MAX_PAGE { return Ok(out); }`. A loop that pushes while `bytes < MAX_PAGE` returns one item too many; `a_page_never_overshoots` pins this. An oversized block's sub-blocks render one at a time, so a page renders no more of a 100 MB block than it returns.
- **References and footnotes defined elsewhere.** A block renders alone. A link label it can't resolve goes through the index (`links`, keyed by the xxh3 of the case-folded, whitespace-collapsed label) and is re-read from its definition's span. A footnote defined elsewhere gets a synthetic definition appended after the block's text, so the reference renders. A label not yet indexed is `pending`, and `reconcile` re-renders exactly those items, keeping their ids, pieces and spans.

- [ ] **Step 1: Write the failing tests**

In `src/lib.rs`, add `pub mod md;` above `pub mod mdemit;`:
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub mod mdemit;
```
```rust
pub mod md;
pub mod mdemit;
```

`spikes/core/spike-core/src/md.rs`:
<!-- op: create spikes/core/spike-core/src/md.rs -->
```rust
//! Markdown documents (spec §4.6, §3.4, §14 D1 and D17): a block index built window by window from the byte
//! store, a first screen from a prefix parse, background indexing with a cancel flag, reconcile, bounded items.
//!
//! **Windows.** pulldown-cmark parses a whole `&str` and can't be interrupted, so it only ever sees one window
//! (`MdConfig::window`, 64 KiB). A window starts at a block boundary. After parsing it, the unit ends at the last
//! line start that no top-level block and no reference definition straddles, and whose line is complete (the read
//! may end mid-line). The blocks before it depend only on the lines up to and including that line (a setext
//! underline or a table delimiter row there would straddle it), so they are final, and the next window starts at
//! the cut and decides that line itself. The first window is the first screen. Front matter exists only at the
//! file's start (`front_matter`), so no window parses with pulldown-cmark's metadata blocks, which it accepts at
//! any block start: a mid-document `---` … `---` pair is a rule and what follows, at every window size.
//!
//! **Oversized blocks.** A block that straddles its window from the first line is scanned without pulldown-cmark,
//! at most `STEP` bytes per step, for its end and its sub-blocks: code by lines, lists by items, tables by rows,
//! paragraphs at word boundaries. Anything else, and any piece without such a boundary, is bounded Raw source.
//! Its kind comes from the window's parse, trusted only where the parse saw its first line and the line after it
//! complete (see `parse_unit`). A paragraph whose scan meets a setext underline was a heading whose underline the
//! window cut off, so the scan restarts as a heading; a setext heading whose scan meets a blank or interrupting line
//! first was a paragraph whose next line the window cut off to look like an underline, so it restarts as one.
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, RwLockReadGuard};

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use xxhash_rust::xxh3::xxh3_64;

use crate::mdemit::{Fragment, OPTIONS, Run, Src, decode_slice, emit, emit_plain};
use crate::sanitize::escape_attr;
use crate::store::{ByteStore, StoreError};

/// Spec §3.4: no item holds more than 64 KiB of text, counted in UTF-16 units as the renderer holds it.
pub const MAX_ITEM_UNITS: usize = 65_536;
/// Spec §3.4: a page is at most 256 KiB, so no item's HTML may be larger.
pub const MAX_PAGE: usize = 262_144;
/// An oversized block's scan reads at most this much per step (one cancel check per step). At 1 MiB a debug build
/// took 46 ms per step on a 100 MB paragraph (a cut candidate per word); 256 KiB keeps it well inside 50 ms.
const STEP: usize = 256 << 10;
/// A window checks the cancel flag this often, in parser events and headings (each block is at least one event).
const CANCEL_EVERY: usize = 1024;
/// Front matter must close within the file's first this-many bytes.
/// ponytail: larger front matter reads as a rule and Markdown; scan it like an oversized block if that matters.
const FRONT_MATTER: u64 = 64 << 10;
pub const RAW_NOTE: &str = "Shown as source: this block is over 64 KiB and can't be split into rendered pieces.";
pub const DEEP_NOTE: &str = "Shown as source: this block is nested too deeply or renders too large.";
/// Why indexing stopped early (spec §3.6): the lens stays locked with this reason, and Raw remains.
pub const TOO_MANY_BLOCKS: &str = "Rendered is unavailable: this file has more blocks than the memory budget allows.";

#[derive(Clone, Copy, Debug)]
pub struct MdConfig {
    /// Bytes pulldown-cmark parses at once. A block larger than this is oversized.
    pub window: usize,
    /// The most source bytes in one sub-block.
    pub piece: usize,
    /// More blocks stop indexing with `TOO_MANY_BLOCKS`. Size it from the memory budget (spec §3.6) at the index's
    /// cost per block: about 24 bytes, up to about 200 for a flood of headings (C4e's hostile inputs).
    pub max_blocks: usize,
}

impl Default for MdConfig {
    fn default() -> Self {
        MdConfig { window: 64 << 10, piece: 32 << 10, max_blocks: usize::MAX }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Paragraph,
    Heading,
    Quote,
    Code,
    Html,
    List,
    Table,
    Footnote,
    Rule,
    Meta,
    Other,
}

/// A top-level block. The span runs from the start of its first line through its last line's ending.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Block {
    pub start: u64,
    pub end: u64,
    pub kind: Kind,
}

/// How a sub-block of an oversized block renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Piece {
    /// Parsed alone: a paragraph's first piece, list items, a table's first rows.
    Markdown,
    /// Code lines, without the fence lines and the indentation.
    Code,
    /// The source as it is, with a note.
    Raw,
    /// Paragraph text after a word boundary: parsed after a synthetic `x` and the separator, so the piece stays
    /// paragraph text even when it starts with `#` or `1.`.
    Words { newline: bool },
    /// Table rows: parsed after the header and delimiter rows, whose output is dropped.
    Rows,
}

/// An oversized block's sub-blocks: piece k starts at `cuts[k].0` and ends where the next starts (or the block ends).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Big {
    pub cuts: Vec<(u64, Piece)>,
    /// Code: the lines between the fences (all of it for indented code), the columns to strip, the language.
    body: (u64, u64),
    strip: usize,
    lang: String,
    /// Tables: the header and delimiter rows.
    head: (u64, u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    /// GitHub's slug, deduplicated with `-1`, `-2` across the document.
    pub slug: String,
    pub block: u64,
    pub span: (u64, u64),
}

/// One virtualized item: a whole block, or one sub-block of an oversized block.
#[derive(Clone, Debug)]
pub struct Item {
    pub block: u64,
    pub piece: u32,
    pub pieces: u32,
    pub span: (u64, u64),
    /// Sanitized.
    pub html: String,
    /// Run k is the k-th DOM text node under the item's root, unless `unmapped`.
    pub runs: Vec<Run>,
    pub unmapped: Option<&'static str>,
    pub note: Option<&'static str>,
    /// Hashes of reference and footnote labels unresolved when this rendered, while indexing was incomplete.
    pub pending: Vec<u64>,
}

#[derive(Default)]
pub struct MdIndex {
    pub blocks: Vec<Block>,
    pub big: HashMap<u64, Big>,
    pub headings: Vec<Heading>,
    slugs: HashMap<String, u32>,
    /// Label hash → the definition's span. The first definition wins (CommonMark).
    links: HashMap<u64, (u64, u64)>,
    notes: HashMap<u64, (u64, u64)>,
    /// Everything before this is indexed.
    pub pos: u64,
    pub done: bool,
    /// Set (with `done`) when indexing stopped at `MdConfig::max_blocks`.
    pub stopped: Option<&'static str>,
    scan: Option<Scan>,
}

pub struct MdDoc {
    store: ByteStore,
    encoding: &'static Encoding,
    cfg: MdConfig,
    index: RwLock<MdIndex>,
}

/// What a window's parse yields, in source offsets: the blocks, headings and definitions before `next`, where the
/// next window starts, or, with `big`, where the scan of an oversized block of that kind starts.
struct Unit {
    next: u64,
    blocks: Vec<Block>,
    /// (level, text, top-level block index within `blocks`, span)
    headings: Vec<(u8, String, usize, (u64, u64))>,
    links: Vec<(String, (u64, u64))>,
    notes: Vec<(String, (u64, u64))>,
    big: Option<Kind>,
}

/// An oversized block's scan in progress.
#[derive(Debug)]
struct Scan {
    kind: Kind,
    start: u64,
    /// The next byte to read.
    pos: u64,
    lines: usize,
    /// The last step stopped inside a line longer than a step.
    mid_line: bool,
    fence: Option<(u8, usize)>,
    marker: Option<&'static [&'static str]>,
    blank: bool,
    /// Just past the last non-blank line.
    content_end: u64,
    piece: u64,
    piece_start: u64,
    last_ok: Option<(u64, Piece)>,
    /// The block ends with the current line (a closing fence or marker seen on it).
    eol_end: bool,
    /// The current line is blank (judged on its first step's worth).
    cur_blank: bool,
    /// Scan again as this kind. A "paragraph" met a setext underline: the window cut it off before it, so it's a
    /// heading. A setext "heading" met a blank or interrupting line first: the window saw a cut-off line (`-` of
    /// `- item`) as its underline, so it's a paragraph.
    restart: Option<Kind>,
    /// A list's current item: its marker type (the bullet, or the ordered delimiter) and content column.
    item: (u8, usize),
    big: Big,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;

    fn doc(name: &str, md: &str, cfg: MdConfig) -> MdDoc {
        MdDoc::new(ByteStore::open(&temp_file(name, md.as_bytes())).unwrap(), UTF_8, cfg)
    }

    fn spans(d: &MdDoc) -> Vec<(u64, u64, Kind)> {
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        d.index().blocks.iter().map(|b| (b.start, b.end, b.kind)).collect()
    }

    const DOC: &str = "---\ntitle: x\n---\n# Head\n\npara one\nstill one\n\n```\nfence\n\n\nnot a cut\n```\n\n<!--\n\ncomment\n\n-->\n\n- a\n\n- b\n\n  more b\n\n1. c\n\nSetext\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> q\n\n[r]: /u\n'title'\n\n    code\n\n    more\n\nlast\n";

    #[test]
    fn small_windows_cut_only_at_block_boundaries() {
        let whole = spans(&doc("whole", DOC, MdConfig { window: 1 << 20, piece: 1 << 19, ..MdConfig::default() }));
        assert_eq!(whole.len(), 12, "{whole:?}");
        for window in 40..DOC.len() {
            let got = spans(&doc("win", DOC, MdConfig { window, piece: 32, ..MdConfig::default() }));
            // Oversized blocks keep their spans; only their rendering is split.
            assert_eq!(got, whole, "window {window}");
        }
    }

    #[test]
    fn units_compose_offsets_beyond_4_gib() {
        let base = 5 << 30;
        let text = "# A\n\npara\n\n[r]: /u\n\n[^n]: note\n\nmore\n";
        let (_, at0) = decode_slice(text.as_bytes(), UTF_8, 0);
        let (_, at5) = decode_slice(text.as_bytes(), UTF_8, base);
        let no = AtomicBool::new(false);
        let (u0, u5) = (parse_unit(text, &at0, true, &no).unwrap(), parse_unit(text, &at5, true, &no).unwrap());
        assert_eq!((u0.next, u5.next), (text.len() as u64, text.len() as u64 + base));
        assert_eq!((u0.blocks.len(), u5.blocks.len()), (4, 4));
        for (a, b) in u0.blocks.iter().zip(&u5.blocks) {
            assert_eq!((a.start + base, a.end + base), (b.start, b.end));
        }
        assert_eq!(u5.headings[0].3, (base, base + 4));
        assert_eq!(u5.links[0].1, (u0.links[0].1.0 + base, u0.links[0].1.1 + base));
        assert_eq!(u5.notes[0].1, (u0.notes[0].1.0 + base, u0.notes[0].1.1 + base));
    }

    #[test]
    fn headings_get_github_slugs() {
        let d = doc("slugs", "# A\n\n# A\n\n## A-1\n\n> # Café & *Co*!\n\n# A\n", MdConfig::default());
        d.index_all(&AtomicBool::new(false)).unwrap();
        let idx = d.index();
        let got: Vec<(&str, u64, (u64, u64))> = idx.headings.iter().map(|h| (h.slug.as_str(), h.block, h.span)).collect();
        assert_eq!(got, [("a", 0, (0, 4)), ("a-1", 1, (5, 9)), ("a-1-1", 2, (10, 17)), ("café--co", 3, (20, 36)), ("a-2", 4, (37, 41))]);
        assert_eq!(idx.headings[3].text, "Café & Co!");
    }

    #[test]
    fn first_screen_then_reconcile_keeps_block_identity() {
        let filler = "filler paragraph\n\n".repeat(20);
        let md = format!("see [later] and [^n] here\n\nplain\n\n{filler}[later]: /url\n\n[^n]: a note\n");
        let d = doc("reconcile", &md, MdConfig { window: 128, piece: 64, ..MdConfig::default() });
        let first = d.first_screen(2).unwrap();
        assert_eq!(first[0].html, "<p>see [later] and [^n] here</p>");
        assert_eq!(first[0].pending.len(), 2);
        assert!(first[1].pending.is_empty());
        assert!(!d.index().done, "the first screen indexed only the first window");
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        let again = d.reconcile(&first).unwrap();
        assert_eq!(again.len(), 1, "only the affected block re-renders");
        assert_eq!((again[0].block, again[0].span), (first[0].block, first[0].span));
        assert_eq!(again[0].html, r#"<p>see <a href="/url">later</a> and <span class="tp-fnref" data-fn="n">n</span> here</p>"#);
        assert!(again[0].pending.is_empty());
    }

    #[test]
    fn reconcile_rerenders_only_pending_pieces_within_a_page() {
        // A pending piece of an oversized paragraph re-renders alone, not its whole block.
        let md = format!("see [r] here {}\n\n[r]: /url\n", "word ".repeat(2_000));
        let d = doc("reconcile-piece", &md, MdConfig { window: 256, piece: 128, ..MdConfig::default() });
        let first = d.first_screen(3).unwrap();
        assert_eq!(first.iter().map(|i| (i.block, i.piece, i.pending.len())).collect::<Vec<_>>(), [(0, 0, 1), (0, 1, 0), (0, 2, 0)]);
        assert!(first[0].pieces > 50 && !d.index().done);
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        let again = d.reconcile(&first).unwrap();
        assert_eq!(again.iter().map(|i| (i.block, i.piece, i.span)).collect::<Vec<_>>(), [(0, 0, first[0].span)]);
        assert!(again[0].html.starts_with(r#"<p>see <a href="/url">r</a> here word"#));
        // What it returns obeys the page cap: six pending blocks of ~60 KB of HTML each resolve at once.
        let block = format!("[r] {}\n\n", "&".repeat(12_000));
        let md = format!("{}{}[r]: /url\n", block.repeat(6), "filler paragraph\n\n".repeat(6_000));
        let d = doc("reconcile-cap", &md, MdConfig { window: 128 << 10, ..MdConfig::default() });
        assert!(!d.step().unwrap());
        let items: Vec<Item> = (0..6).flat_map(|b| d.render(b).unwrap()).collect();
        assert!(items.len() == 6 && items.iter().all(|i| i.pending.len() == 1));
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        let again = d.reconcile(&items).unwrap();
        assert_eq!(again.iter().map(|i| i.block).collect::<Vec<_>>(), [0, 1, 2, 3]); // 4 × 60,026 ≤ 256 KiB < 5 × 60,026
        assert!(again.iter().map(|i| i.html.len()).sum::<usize>() <= MAX_PAGE);
        assert_eq!(d.reconcile(&items[4..]).unwrap().len(), 2); // the caller continues after the last one returned
    }

    /// Every item: within the caps, and its runs tile its span unless it's unmapped.
    fn check(items: &[Item]) {
        for it in items {
            let units: usize = it.runs.iter().map(|r| r.map.units() as usize).sum();
            assert!(units <= MAX_ITEM_UNITS && it.html.len() <= MAX_PAGE, "{} units, {} bytes", units, it.html.len());
            if it.unmapped.is_none() && !it.runs.is_empty() {
                assert_eq!(it.runs[0].map.start_byte(0), it.span.0);
                assert_eq!(it.runs.last().map(|r| r.map.end_byte(r.map.units())), Some(it.span.1));
            }
        }
    }

    #[test]
    fn oversized_blocks_render_in_bounded_pieces() {
        let fence = format!("```rust\n{}```\n", "let x = 1;\n".repeat(30));
        let list = "- item one\n  more\n".repeat(12);
        let table = format!("| a | b |\n|---|---|\n{}", "| 1 | 2 |\n".repeat(20));
        let para = "word ".repeat(70) + "\n";
        let html = format!("<div>\n{}</div>\n", "<p>x</p>\n".repeat(30));
        let md = format!("{fence}\n{list}\n{table}\n{para}\n{html}\nend\n");
        let cfg = MdConfig { window: 128, piece: 100, ..MdConfig::default() };
        let d = doc("oversized", &md, cfg);
        let blocks = spans(&d);
        assert_eq!(blocks.iter().map(|b| b.2).collect::<Vec<_>>(), [Kind::Code, Kind::List, Kind::Table, Kind::Paragraph, Kind::Html, Kind::Paragraph]);
        for (i, &(start, end, kind)) in blocks.iter().enumerate() {
            let items = d.render(i as u64).unwrap();
            check(&items);
            assert_eq!(items[0].span.0, start);
            assert_eq!(items.last().unwrap().span.1, end);
            for w in items.windows(2) {
                assert_eq!(w[0].span.1, w[1].span.0, "pieces tile the block");
            }
            for it in &items {
                assert!(it.span.1 - it.span.0 <= cfg.piece as u64);
                assert_eq!(it.pieces as usize, items.len());
            }
            let html: String = items.iter().map(|i| i.html.as_str()).collect();
            match kind {
                Kind::Code => {
                    assert!(items.len() > 3 && items.iter().all(|i| i.html.starts_with("<pre data-lang=\"rust\"><code>let x = 1;\n")));
                    assert_eq!((html.matches("let x = 1;\n").count(), html.contains("```")), (30, false));
                }
                Kind::List => assert!(items.len() > 1 && items.iter().all(|i| i.html.starts_with("<ul><li>") && i.note.is_none())),
                Kind::Table => {
                    assert!(items.len() > 1 && html.matches("<thead>").count() == 1);
                    assert!(items[1..].iter().all(|i| i.html.starts_with(r#"<div class="tp-table" data-align="--"><table><tbody><tr><td>1</td>"#)));
                }
                Kind::Paragraph if i == 3 => assert!(items.len() > 3 && items.iter().all(|i| i.html.starts_with("<p>word") && !i.html.contains('x'))),
                Kind::Html => assert!(items.iter().all(|i| i.html.starts_with(r#"<pre class="tp-raw"><code>"#) && i.note == Some(RAW_NOTE))),
                _ => {}
            }
        }
    }

    #[test]
    fn a_page_never_overshoots() {
        // Five code blocks of ~60 KiB of HTML each: a `while bytes < MAX_PAGE { push }` guard would return 5.
        let block = format!("```\n{}\n```\n\n", "&".repeat(12_000));
        let d = doc("page", &block.repeat(5), MdConfig::default());
        let page = d.page((0, 0), 100).unwrap();
        let bytes: usize = page.iter().map(|i| i.html.len()).sum();
        assert_eq!((page.len(), page[0].html.len()), (4, 60_025));
        assert!(bytes <= MAX_PAGE);
        assert_eq!(d.page((4, 0), 100).unwrap().len(), 1);
    }

    #[test]
    fn pages_continue_through_sub_blocks_one_at_a_time() {
        let md = format!("```\n{}```\n\nafter\n", "line\n".repeat(100));
        let d = doc("continue", &md, MdConfig { window: 128, piece: 64, ..MdConfig::default() });
        let first = d.page((0, 0), 3).unwrap();
        assert_eq!(first.iter().map(|i| (i.block, i.piece)).collect::<Vec<_>>(), [(0, 0), (0, 1), (0, 2)]);
        let rest = d.page((0, 3), 100).unwrap();
        assert_eq!(rest.len(), first[0].pieces as usize - 3 + 1);
        assert_eq!((rest[0].piece, rest.last().unwrap().html.as_str()), (3, "<p>after</p>"));
    }

    #[test]
    fn front_matter_only_at_the_file_start_at_every_window_size() {
        use Kind::{Heading as H, Meta, Paragraph as P, Rule};
        let docs: [(&str, &[(u64, u64, Kind)]); 6] = [
            ("intro para\n\n---\n\nnext para\n\nlast\n", &[(0, 11, P), (12, 16, Rule), (17, 27, P), (28, 33, P)]),
            ("intro para\n\n---\nnext para\n\nlast\n", &[(0, 11, P), (12, 16, Rule), (16, 26, P), (27, 32, P)]),
            ("# Slide 1\n\ntext one\n\n---\n# Slide 2\n\ntext two\n\n---\n# Slide 3\n", &[(0, 10, H), (11, 20, P), (21, 25, Rule), (25, 35, H), (36, 45, P), (46, 50, Rule), (50, 60, H)]),
            ("intro para\n\n---\ntitle: x\n---\n\nbody\n", &[(0, 11, P), (12, 16, Rule), (16, 29, H), (30, 35, P)]),
            ("---\ntitle: x\n---\n\nbody one\n\nbody two\n", &[(0, 17, Meta), (18, 27, P), (28, 37, P)]),
            ("\n---\nt: x\n---\n", &[(1, 5, Rule), (5, 14, H)]),
        ];
        for (md, want) in docs {
            for window in 8..md.len() + 8 {
                assert_eq!(spans(&doc("front", md, MdConfig { window, piece: 16, ..MdConfig::default() })), want, "{md:?}, window {window}");
            }
        }
        let d = doc("front-bom", "\u{FEFF}---\r\nt: x\r\n---\r\n", MdConfig::default());
        assert_eq!(spans(&d), [(3, 19, Meta)]);
        let items = d.render(0).unwrap();
        assert_eq!((items[0].html.as_str(), items[0].unmapped), ("<pre class=\"tp-frontmatter\"><code>t: x\n</code></pre>", None));
        check(&items);
    }

    #[test]
    fn a_block_starting_mid_line_keeps_its_start() {
        // A footnote definition can open mid-line, after another one: the space before it isn't indentation.
        let blocks = |md: &str| spans(&doc("mid-line", md, MdConfig::default()));
        assert_eq!(blocks("[^n]: [^n]: x\n"), [(0, 6, Kind::Footnote), (6, 14, Kind::Footnote)]);
        assert_eq!(blocks("para\n\n[^a]: [^b]: text\n"), [(0, 5, Kind::Paragraph), (6, 12, Kind::Footnote), (12, 23, Kind::Footnote)]);
        assert_eq!(blocks("  para\n\n   [^a]: x\n"), [(0, 7, Kind::Paragraph), (8, 19, Kind::Footnote)]);
    }

    #[test]
    fn oversized_paragraphs_with_non_ascii_line_starts_index() {
        // A line that opens with a multi-byte char, in a block over the window: the scan's fence check once sliced
        // inside that char and panicked with the index's write lock held.
        for line in ["été comme hiver, la route est longue\n", "日本語の段落です。\n", "“Quoted” line\n"] {
            let md = format!("Intro line of a long paragraph\n{}{line}more words after\n", "plain ascii words in a long paragraph\n".repeat(2000));
            assert!(md.len() > 76_000);
            let d = doc("non-ascii", &md, MdConfig::default());
            assert_eq!(spans(&d), [(0, md.len() as u64, Kind::Paragraph)], "{line:?}");
            check(&d.first_screen(3).unwrap());
            check(&d.render(0).unwrap());
        }
    }

    #[test]
    fn a_block_flood_stops_at_the_budget() {
        // Spec §3.6: past `max_blocks` the index stops with a reason, as JSON's `max_containers` does, keeping what
        // it has. A window holds ~21,000 of these blocks, so the cut falls inside one.
        for (unit, headings) in [("#\n", 1000), ("a\n\n", 0)] {
            let d = doc("flood", &unit.repeat(100_000), MdConfig { max_blocks: 1000, ..MdConfig::default() });
            assert!(d.index_all(&AtomicBool::new(false)).unwrap());
            let idx = d.index();
            assert_eq!((idx.blocks.len(), idx.headings.len(), idx.stopped, idx.done), (1000, headings, Some(TOO_MANY_BLOCKS), true));
            assert!(idx.heap_bytes() < 1000 * 256, "{unit:?}: {} bytes", idx.heap_bytes());
        }
        let d = doc("flood-exact", &"a\n\n".repeat(1000), MdConfig { max_blocks: 1000, ..MdConfig::default() });
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        assert_eq!((d.index().blocks.len(), d.index().stopped), (1000, None));
    }

    #[test]
    fn an_oversized_paragraph_ends_where_a_block_interrupts_it() {
        // Each tail follows a 10 KB paragraph with no blank line: read at a 4 KiB window (scanned as oversized)
        // and whole (pulldown-cmark), the spans must agree. 'i': the tail interrupts the paragraph; 's': it's a
        // setext underline, so paragraph and tail are one heading; 'c': it's continuation text.
        let para = format!("Intro\n{}", "plain words in a long paragraph\n".repeat(320));
        for (tail, what) in [
            ("# h\n", 'i'),
            ("###### h\n", 'i'),
            ("> q\n", 'i'),
            ("***\n", 'i'),
            ("___\n", 'i'),
            (" - - -\n", 'i'),
            ("- x\n", 'i'),
            ("* x\n", 'i'),
            ("+ x\n", 'i'),
            ("1. x\n", 'i'),
            ("01) x\n", 'i'),
            ("```\nc\n```\n", 'i'),
            ("   ~~~\nc\n~~~\n", 'i'),
            ("<div>\n", 'i'),
            ("</table>\n", 'i'),
            ("<!-- c -->\n", 'i'),
            ("<pre>\n</pre>\n", 'i'),
            ("<?x?>\n", 'i'),
            ("[^n]: note\n", 'i'),
            ("===\n", 's'),
            ("---\n", 's'),
            ("  -\n", 's'),
            ("2. x\n", 'c'),
            ("*   \n", 'c'),
            ("    # h\n", 'c'),
            ("#h\n", 'c'),
            ("####### h\n", 'c'),
            ("<span>\n", 'c'),
            ("[^n] x\n", 'c'),
            ("| a | b |\n", 'c'),
        ] {
            let md = format!("{para}{tail}tail words\n");
            let whole = spans(&doc("interrupt-whole", &md, MdConfig { window: 1 << 20, ..MdConfig::default() }));
            let (kind, end) = match what {
                'i' => (Kind::Paragraph, para.len()),
                's' => (Kind::Heading, para.len() + tail.len()),
                _ => (Kind::Paragraph, md.len()),
            };
            assert_eq!((whole[0].1, whole[0].2), (end as u64, kind), "{tail:?} whole");
            let small = spans(&doc("interrupt-small", &md, MdConfig { window: 4096, piece: 1024, ..MdConfig::default() }));
            assert_eq!(small, whole, "{tail:?}");
        }
    }

    #[test]
    fn an_oversized_quote_or_list_ends_where_a_block_interrupts_it() {
        // Each tail follows a 10 KB quote or list with no blank line, read at a 4 KiB window and whole. 'i': the
        // tail ends the block (it interrupts a paragraph, which in that lazy position includes any list marker, or
        // it starts another list); 'c': the block goes on (a lazy continuation, or a line inside the item, or an
        // item of the same list).
        let quote = format!("> Intro\n{}", "> plain words in a long quote\n".repeat(320));
        let bullets = format!("- Intro\n{}", "- plain words in a long list\n".repeat(320));
        let ordered = format!("1. Intro\n{}", "2. plain words in a long list\n".repeat(320));
        let cases = [
            (&quote, "# h\n", 'i'),
            (&quote, "   # h\n", 'i'),
            (&quote, "***\n", 'i'),
            (&quote, "---\n", 'i'),
            (&quote, "- x\n", 'i'),
            (&quote, "-\n", 'i'),
            (&quote, "2. x\n", 'i'),
            (&quote, "```\nc\n```\n", 'i'),
            (&quote, "<div>\n", 'i'),
            (&quote, "<!-- c -->\n", 'i'),
            (&quote, "[^n]: note\n", 'i'),
            (&quote, "plain\n", 'c'),
            (&quote, "===\n", 'c'),
            (&quote, "    # h\n", 'c'),
            (&quote, "#h\n", 'c'),
            (&quote, "<span>\n", 'c'),
            (&bullets, "# h\n", 'i'),
            (&bullets, " # h\n", 'i'),
            (&bullets, "> q\n", 'i'),
            (&bullets, "***\n", 'i'),
            (&bullets, "---\n", 'i'),
            (&bullets, "* other\n", 'i'),
            (&bullets, "1. other\n", 'i'),
            (&bullets, "```\nc\n```\n", 'i'),
            (&bullets, "<div>\n", 'i'),
            (&bullets, "[^n]: note\n", 'i'),
            (&bullets, "plain\n", 'c'),
            (&bullets, "===\n", 'c'),
            (&bullets, "- same\n", 'c'),
            (&bullets, "  # h\n  more\n", 'c'),
            (&bullets, "<span>\n", 'c'),
            (&ordered, "2) other\n", 'i'),
            (&ordered, "  # h\n", 'i'),
            (&ordered, "7. same\n", 'c'),
            (&ordered, "   # h\n   more\n", 'c'),
        ];
        for (block, tail, what) in cases {
            let md = format!("{block}{tail}tail words\n");
            let whole = spans(&doc("lazy-whole", &md, MdConfig { window: 1 << 20, ..MdConfig::default() }));
            let end = if what == 'i' { block.len() } else { md.len() };
            assert_eq!(whole[0].1, end as u64, "{tail:?} after {:?} whole", &block[..4]);
            let small = spans(&doc("lazy-small", &md, MdConfig { window: 4096, piece: 1024, ..MdConfig::default() }));
            assert_eq!(small, whole, "{tail:?} after {:?}", &block[..4]);
        }
        // A window that ends right after the `-` of `- item` (or the `---` of `---x`) sees a setext underline under
        // the paragraph: the heading's scan meets the real line, and scans again as a paragraph.
        for md in ["aaaa bbbb\ncccc dddd\n- item one\nlazy\n\nafter\n", "aaaa bbbb\ncccc dddd\n---x\n\nafter\n"] {
            let whole = spans(&doc("cutoff-whole", md, MdConfig::default()));
            for window in 8..md.len() + 8 {
                assert_eq!(spans(&doc("cutoff", md, MdConfig { window, piece: 16, ..MdConfig::default() })), whole, "{md:?}, window {window}");
            }
        }
    }

    #[test]
    fn a_cancelled_window_leaves_the_index_as_it_was() {
        // 3,000 headings in one window: a set flag stops it within 1,024 parser events, before it commits anything.
        let d = doc("cancel-window", &"# a\n".repeat(3000), MdConfig::default());
        assert!(!d.step_with(&AtomicBool::new(true)).unwrap());
        let idx = d.index();
        assert_eq!((idx.pos, idx.blocks.len(), idx.headings.len(), idx.slugs.len(), idx.done), (0, 0, 0, 0, false));
        drop(idx);
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        assert_eq!(d.index().headings.len(), 3000);
        // A window's slugs merge into the index's when it commits, so repeats count on across windows.
        let d = doc("slug-windows", &"# a\n\n".repeat(50), MdConfig { window: 64, piece: 32, ..MdConfig::default() });
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        let want: Vec<String> = (0..50).map(|n| if n == 0 { "a".into() } else { format!("a-{n}") }).collect();
        assert_eq!(d.index().headings.iter().map(|h| h.slug.clone()).collect::<Vec<_>>(), want);
    }

    #[test]
    fn cancel_stops_between_steps() {
        let d = doc("cancel", &"para\n\n".repeat(10_000), MdConfig { window: 256, piece: 128, ..MdConfig::default() });
        assert!(!d.index_all(&AtomicBool::new(true)).unwrap());
        assert!(!d.index().done);
        assert!(d.index_all(&AtomicBool::new(false)).unwrap());
        assert_eq!(d.index().blocks.len(), 10_000);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core md::`
Expected: ``error: could not compile `spike-core` (lib test) due to 43 previous errors; 10 warnings emitted``. `E0599` no method named `index` (12), `index_all` (11), `page` (4), `render` (4), `reconcile` (4), `first_screen` (3), `step` (1), `step_with` (1), no associated function `new` (1); `E0425` cannot find function `parse_unit` (2). The warnings are unused imports, and items that only the implementation uses (such as the constant `CANCEL_EVERY`).

- [ ] **Step 3: Implement**

Add to `md.rs`, above the `tests` module:
<!-- op: insert-before spikes/core/spike-core/src/md.rs :: #[cfg(test)] -->
```rust
impl MdIndex {
    /// Heap held by the index: capacities plus hash-table control bytes, without allocator overhead.
    pub fn heap_bytes(&self) -> usize {
        let table = |cap: usize, entry: usize| cap * 8 / 7 * (entry + 1);
        self.blocks.capacity() * size_of::<Block>()
            + self.headings.capacity() * size_of::<Heading>()
            + self.headings.iter().map(|h| h.text.capacity() + h.slug.capacity()).sum::<usize>()
            + table(self.slugs.capacity(), size_of::<(String, u32)>())
            + self.slugs.keys().map(String::capacity).sum::<usize>()
            + table(self.links.capacity(), size_of::<(u64, (u64, u64))>())
            + table(self.notes.capacity(), size_of::<(u64, (u64, u64))>())
            + table(self.big.capacity(), size_of::<(u64, Big)>())
            + self.big.values().map(|b| b.cuts.capacity() * size_of::<(u64, Piece)>() + b.lang.capacity()).sum::<usize>()
    }
}

impl MdDoc {
    pub fn new(store: ByteStore, encoding: &'static Encoding, cfg: MdConfig) -> MdDoc {
        MdDoc { store, encoding, cfg, index: RwLock::new(MdIndex::default()) }
    }

    pub fn index(&self) -> RwLockReadGuard<'_, MdIndex> {
        self.index.read().unwrap()
    }

    /// One bounded piece of indexing: a window, or one step of an oversized block's scan. True once complete.
    pub fn step(&self) -> Result<bool, StoreError> {
        self.step_with(&AtomicBool::new(false))
    }

    /// `step`, giving up a window when `cancel` is set: the index is left as it was, and the window is redone later.
    fn step_with(&self, cancel: &AtomicBool) -> Result<bool, StoreError> {
        let mut idx = self.index.write().unwrap();
        if !idx.done {
            if idx.scan.is_some() {
                self.scan_step(&mut idx)?;
            } else {
                self.window_step(&mut idx, cancel)?;
            }
            idx.done = idx.stopped.is_some() || idx.scan.is_none() && idx.pos >= self.store.len();
        }
        Ok(idx.done)
    }

    /// Background indexing: steps until done (true) or until `cancel` is set (false). Cancel is checked between
    /// steps, and within a window every `CANCEL_EVERY` parser events and headings: a window of 32k headings takes
    /// ~50 ms in a debug build. What's left uninterruptible is pulldown-cmark's first pass over one window, its cut,
    /// and its commit.
    pub fn index_all(&self, cancel: &AtomicBool) -> Result<bool, StoreError> {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if self.step_with(cancel)? {
                return Ok(true);
            }
        }
    }

    /// The first screen (spec §14 D1): rendered from the first window alone, provisionally.
    pub fn first_screen(&self, max_items: usize) -> Result<Vec<Item>, StoreError> {
        self.page((0, 0), max_items)
    }

    /// Items from `from` = (block, item within it) on, indexing only as far as needed: at most `max_items`, and at
    /// most `MAX_PAGE` bytes of HTML, checked before each push so a page never overshoots (spec §3.4). The next
    /// page starts after the last item returned (spec §3.4's continuation). An oversized block's sub-blocks render
    /// one at a time, so a page renders no more of it than it returns.
    pub fn page(&self, from: (u64, usize), max_items: usize) -> Result<Vec<Item>, StoreError> {
        let (mut out, mut bytes) = (Vec::new(), 0);
        let (mut block, mut k) = from;
        while out.len() < max_items {
            loop {
                let have = self.index().blocks.len() as u64;
                if have > block || self.step()? {
                    break;
                }
            }
            let pieces = self.index().big.get(&block).map(|b| b.cuts.len());
            let items = match pieces {
                Some(n) if k < n => self.piece(block, k)?,
                Some(_) => Vec::new(),
                None => self.render(block)?.into_iter().skip(k).collect(),
            };
            if items.is_empty() {
                if self.index().blocks.len() as u64 <= block {
                    break;
                }
                (block, k) = (block + 1, 0);
                continue;
            }
            for item in items {
                if out.len() == max_items || !out.is_empty() && bytes + item.html.len() > MAX_PAGE {
                    return Ok(out);
                }
                bytes += item.html.len();
                out.push(item);
                k += 1;
            }
            if pieces.is_none() {
                (block, k) = (block + 1, 0);
            }
        }
        Ok(out)
    }

    /// Spec §4.6, §14 D1: re-renders the items whose pending labels the index has since found: the item's block,
    /// or only its sub-block of an oversized block. The returned items keep their block ids, pieces and spans; the
    /// caller swaps them in place. At most `MAX_PAGE` bytes of HTML, checked before each push (spec §3.4): the
    /// caller continues with the items after the last one returned.
    pub fn reconcile(&self, items: &[Item]) -> Result<Vec<Item>, StoreError> {
        let stale: BTreeSet<(u64, u32)> = {
            let idx = self.index();
            let found = |k: &u64| idx.links.contains_key(k) || idx.notes.contains_key(k);
            items.iter().filter(|it| it.pending.iter().any(found)).map(|it| (it.block, it.piece)).collect()
        };
        let (mut out, mut bytes) = (Vec::new(), 0);
        for (block, piece) in stale {
            let big = self.index().big.contains_key(&block);
            for item in if big { self.piece(block, piece as usize)? } else { self.render(block)? } {
                if !out.is_empty() && bytes + item.html.len() > MAX_PAGE {
                    return Ok(out);
                }
                bytes += item.html.len();
                out.push(item);
            }
        }
        Ok(out)
    }

    /// A block's items: one, or one per sub-block of an oversized block (`piece` renders them one at a time). An
    /// item over the caps renders as bounded Raw pieces instead.
    pub fn render(&self, block: u64) -> Result<Vec<Item>, StoreError> {
        let pieces = self.index().big.get(&block).map(|b| b.cuts.len());
        if let Some(n) = pieces {
            let mut out = Vec::new();
            for k in 0..n {
                out.extend(self.piece(block, k)?);
            }
            return Ok(out);
        }
        let idx = self.index();
        let Some(&b) = idx.blocks.get(block as usize) else { return Ok(Vec::new()) };
        let (frag, pending) = match b.kind {
            Kind::Meta => (self.front(b)?, Vec::new()),
            _ => self.markdown(&idx, b.start, b.end, "")?,
        };
        let mut out = self.bounded(frag, pending, (b.start, b.end), None)?;
        let n = out.len() as u32;
        for (k, item) in out.iter_mut().enumerate() {
            (item.block, item.piece, item.pieces) = (block, k as u32, n);
        }
        Ok(out)
    }

    /// Sub-block `k` of an oversized block, rendered alone (at most `cfg.piece` source bytes, so one item).
    pub fn piece(&self, block: u64, k: usize) -> Result<Vec<Item>, StoreError> {
        let idx = self.index();
        let (Some(&b), Some(big)) = (idx.blocks.get(block as usize), idx.big.get(&block)) else { return Ok(Vec::new()) };
        let Some(&(at, mode)) = big.cuts.get(k) else { return Ok(Vec::new()) };
        let end = big.cuts.get(k + 1).map_or(b.end, |c| c.0);
        let prefix = match mode {
            Piece::Markdown => Some(String::new()),
            Piece::Words { newline } => Some(if newline { "x\n" } else { "x " }.to_string()),
            Piece::Rows if big.head.1 - big.head.0 <= self.cfg.piece as u64 => {
                let head = self.store.read(big.head.0, big.head.1)?;
                Some(decode_slice(&head, self.encoding, big.head.0).0)
            }
            _ => None,
        };
        let mut out = match (mode, prefix) {
            (_, Some(prefix)) => {
                let (frag, pending) = self.markdown(&idx, at, end, &prefix)?;
                self.bounded(frag, pending, (at, end), None)?
            }
            (Piece::Code, None) => self.bounded(self.code(at, end, big)?, Vec::new(), (at, end), None)?,
            (_, None) => self.raw(at, end, RAW_NOTE)?,
        };
        for item in &mut out {
            (item.block, item.piece, item.pieces) = (block, k as u32, big.cuts.len() as u32);
        }
        Ok(out)
    }

    /// The fragment as an item, or Raw pieces if it's nested too deeply or over the caps.
    fn bounded(&self, frag: Fragment, pending: Vec<u64>, span: (u64, u64), note: Option<&'static str>) -> Result<Vec<Item>, StoreError> {
        let units: usize = frag.runs.iter().map(|r| r.map.units() as usize).sum();
        if frag.too_deep || units > MAX_ITEM_UNITS || frag.html.len() > MAX_PAGE {
            return self.raw(span.0, span.1, DEEP_NOTE);
        }
        Ok(vec![item(frag, pending, span, note)])
    }

    /// Parses `[start, end)` alone, after a synthetic `prefix`. References and footnotes defined elsewhere resolve
    /// through the index; what it hasn't found yet is `pending`.
    fn markdown(&self, idx: &MdIndex, start: u64, end: u64, prefix: &str) -> Result<(Fragment, Vec<u64>), StoreError> {
        let bytes = self.store.read(start, end)?;
        let (text, src) = decode_slice(&bytes, self.encoding, start);
        let mut full = format!("{prefix}{text}");
        let mut pending = Vec::new();
        for label in footnote_refs(&text) {
            let key = label_key(label);
            match idx.notes.get(&key) {
                Some(&(a, b)) if start <= a && b <= end => {}
                // Defined elsewhere: a definition appended after `hi` makes pulldown-cmark emit the reference.
                Some(_) => full.push_str(&format!("\n\n[^{label}]: x\n")),
                None if !idx.done => pending.push(key),
                None => {}
            }
        }
        let lo = prefix.len();
        let at = |o: usize| src.at(o - lo);
        let mut links = |label: &str| {
            let key = label_key(label);
            let def = self.link_def(idx, key);
            if def.is_none() && !idx.done {
                pending.push(key);
            }
            def
        };
        let frag = emit(&full, lo, lo + text.len(), &at, &mut links);
        pending.sort_unstable();
        pending.dedup();
        Ok((frag, pending))
    }

    /// A reference definition found anywhere in the document, re-read from its span.
    fn link_def(&self, idx: &MdIndex, key: u64) -> Option<(String, String)> {
        let &(a, b) = idx.links.get(&key)?;
        let bytes = self.store.read(a, b).ok()?;
        let (text, _) = decode_slice(&bytes, self.encoding, a);
        let parser = Parser::new_ext(&text, OPTIONS);
        let (label, def) = parser.reference_definitions().iter().next()?;
        let title = def.title.as_ref().map_or(String::new(), |t| t.to_string());
        (label_key(label) == key).then(|| (def.dest.to_string(), title))
    }

    /// Front matter: the lines between its fences, shown as they are.
    fn front(&self, b: Block) -> Result<Fragment, StoreError> {
        let bytes = self.store.read(b.start, b.end)?;
        let (text, src) = decode_slice(&bytes, self.encoding, b.start);
        let open = text.find('\n').map_or(0, |i| i + 1);
        let close = text.trim_end_matches(['\n', '\r']).rfind('\n').map_or(open, |i| i + 1);
        Ok(emit_plain(&text, &[open..close], &|o| src.at(o), "<pre class=\"tp-frontmatter\"><code>", "</code></pre>"))
    }

    /// The file's front matter as a block, if its first `FRONT_MATTER` bytes hold one.
    fn front_matter(&self) -> Result<Option<Block>, StoreError> {
        let len = self.store.len();
        let raw = self.store.read(0, len.min(FRONT_MATTER))?;
        let eof = raw.len() as u64 == len;
        let bytes = if eof { &raw[..] } else { trim_to_char(&raw, self.encoding) };
        let (text, src) = decode_slice(bytes, self.encoding, 0);
        Ok(front_matter_end(&text, eof).map(|end| Block { start: src.at(0), end: src.at(end), kind: Kind::Meta }))
    }

    /// Code lines of an oversized code block: the fence lines and each line's indentation are markup.
    fn code(&self, start: u64, end: u64, big: &Big) -> Result<Fragment, StoreError> {
        let bytes = self.store.read(start, end)?;
        let (text, src) = decode_slice(&bytes, self.encoding, start);
        let b = text.as_bytes();
        let mut shown = Vec::new();
        let mut i = 0;
        for next in line_starts(&text).into_iter().chain([text.len()]) {
            if i < next && (big.body.0..big.body.1).contains(&src.at(i)) {
                let mut j = i;
                let mut col = 0;
                while j < next && col < big.strip {
                    match b[j] {
                        b' ' => col += 1,
                        b'\t' => col += 4 - col % 4,
                        _ => break,
                    }
                    j += 1;
                }
                shown.push(j..next);
            }
            i = next;
        }
        let open = match big.lang.as_str() {
            "" => "<pre><code>".to_string(),
            lang => format!("<pre data-lang=\"{}\"><code>", escape_attr(lang)),
        };
        Ok(emit_plain(&text, &shown, &|o| src.at(o), &open, "</code></pre>"))
    }

    /// `[start, end)` as Raw source, in pieces of at most `cfg.piece` bytes cut at line starts where it can.
    fn raw(&self, start: u64, end: u64, note: &'static str) -> Result<Vec<Item>, StoreError> {
        let bytes = self.store.read(start, end)?;
        let (text, src) = decode_slice(&bytes, self.encoding, start);
        let piece = self.cfg.piece as u64;
        let mut cuts = vec![0];
        let mut last_line = 0;
        for line in line_starts(&text).into_iter().chain([text.len()]) {
            while src.at(line) - src.at(cuts[cuts.len() - 1]) > piece {
                let from = cuts[cuts.len() - 1];
                let cut = if last_line > from { last_line } else { floor_at(&text, &src, src.at(from) + piece) };
                if cut <= from {
                    break;
                }
                cuts.push(cut);
            }
            last_line = line;
        }
        cuts.push(text.len());
        cuts.dedup();
        Ok(cuts
            .windows(2)
            .map(|w| {
                let part = &text[w[0]..w[1]];
                let frag = emit_plain(part, &[0..part.len()], &|o| src.at(w[0] + o), RAW_OPEN, "</code></pre>");
                item(frag, Vec::new(), (src.at(w[0]), src.at(w[1])), Some(note))
            })
            .collect())
    }

    fn window_step(&self, idx: &mut MdIndex, cancel: &AtomicBool) -> Result<(), StoreError> {
        let (s, len) = (idx.pos, self.store.len());
        let room = self.cfg.max_blocks.saturating_sub(idx.blocks.len());
        if room == 0 {
            idx.stopped = Some(TOO_MANY_BLOCKS);
            return Ok(());
        }
        if s == 0
            && let Some(front) = self.front_matter()?
        {
            idx.pos = front.end;
            idx.blocks.push(front);
            return Ok(());
        }
        let end = (s + self.cfg.window as u64).min(len);
        let raw = self.store.read(s, end)?;
        let eof = end == len;
        let bytes = if eof { &raw[..] } else { trim_to_char(&raw, self.encoding) };
        let (text, src) = decode_slice(bytes, self.encoding, s);
        // The composition: decoded offsets map onto exactly the bytes read, from the window's absolute start.
        assert_eq!(src.at(text.len()), s + bytes.len() as u64, "decode map must cover the window");
        let Some(mut unit) = parse_unit(&text, &src, eof, cancel) else { return Ok(()) };
        // Spec §3.6: past the budget, keep what fits and stop with the reason.
        let over = unit.blocks.len() + usize::from(unit.big.is_some()) > room;
        if over {
            unit.blocks.truncate(room);
            unit.headings.retain(|h| h.2 < room);
            unit.big = None;
        }
        // Slugs go to a table of this window's own until it commits, so a cancel leaves the index as it was.
        let (first, mut fresh) = (idx.blocks.len() as u64, HashMap::new());
        let mut headings = Vec::with_capacity(unit.headings.len());
        for (n, (level, t, top, span)) in unit.headings.into_iter().enumerate() {
            if n % CANCEL_EVERY == CANCEL_EVERY - 1 && cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let slug = slug(&t, &idx.slugs, &mut fresh);
            headings.push(Heading { level, text: t, slug, block: first + top as u64, span });
        }
        if over {
            idx.stopped = Some(TOO_MANY_BLOCKS);
        }
        idx.slugs.extend(fresh);
        idx.headings.extend(headings);
        idx.blocks.extend(unit.blocks);
        for (label, span) in unit.links {
            idx.links.entry(label_key(&label)).or_insert(span);
        }
        for (label, span) in unit.notes {
            idx.notes.entry(label_key(&label)).or_insert(span);
        }
        idx.pos = unit.next;
        if let Some(kind) = unit.big {
            idx.scan = Some(Scan::new(kind, unit.next, self.cfg.piece));
        }
        Ok(())
    }

    fn scan_step(&self, idx: &mut MdIndex) -> Result<(), StoreError> {
        let len = self.store.len();
        let Some(scan) = idx.scan.as_mut() else { return Ok(()) };
        let end = (scan.pos + STEP as u64).min(len);
        let raw = self.store.read(scan.pos, end)?;
        let eof = end == len;
        let bytes = if eof { &raw[..] } else { trim_to_char(&raw, self.encoding) };
        let (text, src) = decode_slice(bytes, self.encoding, scan.pos);
        assert_eq!(src.at(text.len()), scan.pos + bytes.len() as u64, "decode map must cover the step");
        if let Some(end) = scan.feed(&text, &src, eof)
            && let Some(scan) = idx.scan.take()
        {
            let (block, big) = scan.finish(end);
            idx.big.insert(idx.blocks.len() as u64, big);
            idx.blocks.push(block);
            idx.pos = end;
        }
        Ok(())
    }
}

const RAW_OPEN: &str = "<pre class=\"tp-raw\"><code>";

fn item(frag: Fragment, pending: Vec<u64>, span: (u64, u64), note: Option<&'static str>) -> Item {
    Item { block: 0, piece: 0, pieces: 1, span, html: frag.html, runs: frag.runs, unmapped: frag.unmapped, note, pending }
}

/// Reference and footnote labels compare after collapsing whitespace and folding case (CommonMark §4.7).
/// ponytail: `to_lowercase` approximates Unicode case folding (ß vs SS differ); the index keys a 64-bit hash, and
/// a lookup re-parses the definition and re-checks the key.
fn label_key(label: &str) -> u64 {
    xxh3_64(label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase().as_bytes())
}

/// Footnote labels `text` references (`[^label]`): candidates for definitions elsewhere in the document.
fn footnote_refs(text: &str) -> Vec<&str> {
    let mut out: Vec<&str> = memchr::memmem::find_iter(text.as_bytes(), b"[^")
        .filter_map(|i| {
            let rest = &text.as_bytes()[i + 2..];
            let n = rest.iter().take(257).position(|&b| b == b']' || b == b'[' || b.is_ascii_whitespace())?;
            (n > 0 && rest[n] == b']').then(|| &text[i + 2..i + 2 + n])
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// GitHub's heading slug (github-slugger): lowercase; keep letters, numbers, `-`, `_` and spaces; spaces become
/// `-`; a repeat gets `-1`, `-2`, …, skipping any slug already taken. `seen` holds the slugs (and repeat counts)
/// committed before this window, `fresh` this window's; `fresh` wins when merged.
/// ponytail: `char::is_alphanumeric` stands in for github-slugger's regex, which also keeps combining marks.
fn slug(text: &str, seen: &HashMap<String, u32>, fresh: &mut HashMap<String, u32>) -> String {
    let base: String = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .map(|c| if c == ' ' { '-' } else { c })
        .collect();
    let mut slug = base.clone();
    while fresh.contains_key(&slug) || seen.contains_key(&slug) {
        let n = fresh.entry(base.clone()).or_insert_with(|| seen.get(&base).copied().unwrap_or(0));
        *n += 1;
        slug = format!("{base}-{n}");
    }
    fresh.insert(slug.clone(), 0);
    slug
}

fn kind_of(tag: &Tag) -> Kind {
    match tag {
        Tag::Paragraph => Kind::Paragraph,
        Tag::Heading { .. } => Kind::Heading,
        Tag::BlockQuote(_) => Kind::Quote,
        Tag::CodeBlock(_) => Kind::Code,
        Tag::HtmlBlock => Kind::Html,
        Tag::List(_) => Kind::List,
        Tag::Table(_) => Kind::Table,
        Tag::FootnoteDefinition(_) => Kind::Footnote,
        Tag::MetadataBlock(_) => Kind::Meta,
        _ => Kind::Other,
    }
}

/// Positions just after each line ending (`\n`, `\r\n` or `\r`).
fn line_starts(text: &str) -> Vec<usize> {
    let b = text.as_bytes();
    memchr::memchr2_iter(b'\n', b'\r', b)
        .filter(|&i| !(b[i] == b'\n' && i > 0 && b[i - 1] == b'\r'))
        .map(|i| if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') { i + 2 } else { i + 1 })
        .collect()
}

/// The span of a block whose parser range is `r`: back to its line's start when only indentation precedes it
/// (top-level blocks; a footnote definition can start mid-line), and forward from its last non-blank character
/// through that line's ending.
fn span_of(text: &str, r: Range<usize>, top: bool) -> Range<usize> {
    let b = text.as_bytes();
    let mut s = r.start;
    let mut i = s;
    while top && i > 0 && matches!(b[i - 1], b' ' | b'\t') {
        i -= 1;
    }
    if i == 0 || matches!(b[i - 1], b'\n' | b'\r') {
        s = i;
    }
    let mut e = r.end;
    while e > s && matches!(b[e - 1], b' ' | b'\t' | b'\n' | b'\r') {
        e -= 1;
    }
    while e < b.len() && matches!(b[e], b' ' | b'\t') {
        e += 1;
    }
    e += if b[e..].starts_with(b"\r\n") { 2 } else { usize::from(e < b.len() && matches!(b[e], b'\n' | b'\r')) };
    s..e
}

/// Parses one window (spec §4.6): see the module docs for where it cuts. None once `cancel` is set.
fn parse_unit(text: &str, src: &Src, eof: bool, cancel: &AtomicBool) -> Option<Unit> {
    let parser = Parser::new_ext(text, OPTIONS);
    let defs: Vec<(String, Range<usize>)> = parser.reference_definitions().iter().map(|(l, d)| (l.to_string(), d.span.clone())).collect();
    let (mut tops, mut heads, mut notes) = (Vec::new(), Vec::new(), Vec::new());
    let (mut depth, mut heading) = (0usize, None::<(u8, String, Range<usize>, bool)>);
    for (n, (event, r)) in parser.into_offset_iter().enumerate() {
        if n % CANCEL_EVERY == CANCEL_EVERY - 1 && cancel.load(Ordering::Relaxed) {
            return None;
        }
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    tops.push((r.clone(), kind_of(&tag)));
                }
                match tag {
                    Tag::Heading { level, .. } => heading = Some((level as u8, String::new(), r, depth == 0)),
                    Tag::FootnoteDefinition(label) => notes.push((label.to_string(), r)),
                    _ => {}
                }
                depth += 1;
            }
            Event::End(end) => {
                depth -= 1;
                if matches!(end, TagEnd::Heading(_))
                    && let Some((level, t, r, top)) = heading.take()
                {
                    heads.push((level, t, tops.len() - 1, span_of(text, r, top)));
                }
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some(h) = heading.as_mut() {
                    h.1.push_str(&t);
                }
            }
            Event::Rule if depth == 0 => tops.push((r, Kind::Rule)),
            _ => {}
        }
    }
    let (cut, big) = match if eof { Some(text.len()) } else { choose_cut(text, &tops, &defs) } {
        Some(c) => (c, None),
        // No safe cut: one block fills the rest of the window, and is scanned as oversized from its start. Its kind
        // must be trustworthy: it is the last block whose first line and the line after it are complete (one starting
        // in the last two lines may misread a cut-off line), or else the block on the window's first line.
        None => match tops.iter().rev().find(|t| t.0.start < second_last(text)).or(tops.first().filter(|t| t.0.start < first_line_end(text))) {
            Some((r, kind)) => (span_of(text, r.clone(), true).start, Some(*kind)),
            None => {
                let first = text.find(|c: char| !c.is_whitespace()).unwrap_or(0);
                (line_starts(&text[..first]).last().copied().unwrap_or(0), Some(Kind::Other))
            }
        },
    };
    let at = |r: Range<usize>| (src.at(r.start), src.at(r.end));
    Some(Unit {
        next: src.at(cut),
        blocks: tops
            .iter()
            .filter(|(r, _)| r.start < cut)
            .map(|(r, kind)| {
                let (start, end) = at(span_of(text, r.clone(), true));
                Block { start, end, kind: *kind }
            })
            .collect(),
        headings: heads.into_iter().filter(|h| h.3.start < cut).map(|(l, t, top, s)| (l, t, top, at(s))).collect(),
        links: defs.into_iter().filter(|d| d.1.start < cut).map(|(l, r)| (l, at(r))).collect(),
        notes: notes.into_iter().filter(|n| n.1.start < cut).map(|(l, r)| (l, at(r))).collect(),
        big,
    })
}

/// The end of the front matter that opens `text` (the file's start; `eof` if it's the whole file), by pulldown-cmark
/// 0.13.4's metadata-block rule: a `---` line, a first line that is neither blank nor a closer, then a `---` or `...`
/// line (trailing spaces allowed). Unlike pulldown-cmark, only at offset 0: leading blank lines rule it out.
fn front_matter_end(text: &str, eof: bool) -> Option<usize> {
    fn bare(l: &str) -> &str {
        l.trim_end_matches(['\n', '\r'])
    }
    let mut lines = text.split_inclusive('\n').filter(|l| eof || l.ends_with('\n'));
    let closes = |l: &str| matches!(bare(l).trim_end_matches(' '), "---" | "...");
    let (open, first) = (lines.next()?, lines.next()?);
    let blank = bare(first).trim_matches([' ', '\t', '\u{b}', '\u{c}']).is_empty();
    if bare(open).trim_end_matches(|c: char| c.is_ascii_whitespace()) != "---" || blank || closes(first) {
        return None;
    }
    let mut end = open.len() + first.len();
    for l in lines {
        end += l.len();
        if closes(l) {
            return Some(end);
        }
    }
    None
}

/// The last line start that no top-level block or definition straddles, and whose line is complete (it starts
/// before the last line).
/// A blank line after indented code, a list or a footnote still belongs to it if an indented line follows, so it
/// is a cut only with a complete non-blank line after it in the window.
fn choose_cut(text: &str, tops: &[(Range<usize>, Kind)], defs: &[(String, Range<usize>)]) -> Option<usize> {
    let mut spans: Vec<(usize, usize)> = tops.iter().map(|t| (t.0.start, t.0.end)).chain(defs.iter().map(|d| (d.1.start, d.1.end))).collect();
    spans.sort_unstable();
    let reach: Vec<usize> = spans.iter().scan(0, |m, s| { *m = (*m).max(s.1); Some(*m) }).collect();
    let starts = line_starts(text);
    let limit = starts.last().copied().unwrap_or(0);
    let blank = |c: usize| text[c..].split(['\n', '\r']).next().is_some_and(|l| l.trim_matches([' ', '\t']).is_empty());
    let last_full = starts.iter().rev().copied().find(|&c| c < limit && !blank(c)).unwrap_or(0);
    starts.iter().rev().copied().filter(|&c| c < limit).find(|&c| {
        let i = spans.partition_point(|s| s.0 < c);
        let before = tops[..tops.partition_point(|t| t.0.start < c)].last().map(|t| t.1);
        (i == 0 || reach[i - 1] <= c)
            && (c < last_full || !blank(c) || !matches!(before, Some(Kind::Code | Kind::List | Kind::Footnote)))
    })
}

/// The start of a window's second-to-last line: lines before it are complete, and so is the line after each.
fn second_last(text: &str) -> usize {
    let starts = line_starts(text);
    starts.len().checked_sub(2).map_or(0, |i| starts[i])
}

/// The end of the window's first non-blank line.
fn first_line_end(text: &str) -> usize {
    let p = text.len() - text.trim_start().len();
    text[p..].find(['\n', '\r']).map_or(text.len(), |i| p + i)
}

/// The last char boundary of `text` whose source offset is at most `target`. `src.at` is only monotonic over
/// char boundaries (inside a decoded char longer than its source it runs ahead), so the search snaps first.
fn floor_at(text: &str, src: &Src, target: u64) -> usize {
    let boundary = |mut i: usize| {
        while !text.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let (mut lo, mut hi) = (0, text.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if src.at(boundary(mid)) <= target { lo = mid } else { hi = mid - 1 }
    }
    boundary(lo)
}

/// `b` (a read that stops before the end of the file) without a character the read cut short, and without a final
/// CR, whose LF may be the next byte: that line then counts as incomplete.
fn trim_to_char<'a>(b: &'a [u8], encoding: &'static Encoding) -> &'a [u8] {
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let unit = |i: usize| if encoding == UTF_16LE { u16::from_le_bytes([b[i], b[i + 1]]) } else { u16::from_be_bytes([b[i], b[i + 1]]) };
        let mut n = b.len() & !1;
        if n >= 2 && (0xD800..0xDC00).contains(&unit(n - 2)) {
            n -= 2;
        }
        if n >= 2 && unit(n - 2) == 0x0D {
            n -= 2;
        }
        return &b[..n];
    }
    let mut n = b.len();
    if encoding == UTF_8
        && let Some(i) = (n.saturating_sub(4)..n).rev().find(|&i| b[i] & 0xC0 != 0x80)
    {
        let need = match b[i] {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        if n - i < need {
            n = i;
        }
    }
    if n > 0 && b[n - 1] == b'\r' {
        n -= 1;
    }
    &b[..n]
}

fn columns(l: &str) -> usize {
    let mut col = 0;
    for b in l.bytes() {
        match b {
            b' ' => col += 1,
            b'\t' => col += 4 - col % 4,
            _ => break,
        }
    }
    col
}

/// A list item marker after up to 3 spaces: `-`, `+` or `*`, or 1–9 digits then `.` or `)`; then a space, a tab
/// or the line's end.
fn is_marker(l: &str) -> bool {
    let t = l.trim_start_matches(' ');
    if l.len() - t.len() > 3 {
        return false;
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    let rest = match t.strip_prefix(['-', '+', '*']) {
        Some(rest) => rest,
        None if (1..=9).contains(&digits) => match t[digits..].strip_prefix(['.', ')']) {
            Some(rest) => rest,
            None => return false,
        },
        None => return false,
    };
    rest.is_empty() || rest.starts_with([' ', '\t'])
}

/// The list item a line starts, as pulldown-cmark 0.13.4's `scan_list_marker_with_indent` reads it
/// (scanners.rs:307-373): its type (the bullet, or the ordered delimiter) and its content column, which follows the
/// marker and up to 4 columns of whitespace, else 1 column after the marker. A thematic break isn't an item.
fn marker_of(l: &str) -> Option<(u8, usize)> {
    let t = l.trim_start_matches(' ');
    if !is_marker(l) || thematic(t.as_bytes()) {
        return None;
    }
    let width = t.bytes().position(|c| matches!(c, b'-' | b'+' | b'*' | b'.' | b')'))? + 1;
    let end = l.len() - t.len() + width; // the marker's end column: everything up to it is ASCII
    let mut col = end;
    for c in t[width..].bytes() {
        match c {
            b' ' => col += 1,
            b'\t' => col += 4 - col % 4,
            _ => return Some((t.as_bytes()[width - 1], if col - end <= 4 { col } else { end + 1 })),
        }
    }
    Some((t.as_bytes()[width - 1], end + 1))
}

/// A line inside a block quote: `>` after up to 3 spaces.
fn quoted(l: &str) -> bool {
    let t = l.trim_start_matches(' ');
    l.len() - t.len() <= 3 && t.starts_with('>')
}

/// A fenced code opener after up to 3 spaces: (fence char, length, indent, info string).
fn fence_of(l: &str) -> Option<(u8, usize, usize, &str)> {
    let t = l.trim_start_matches(' ');
    let ch = *t.as_bytes().first().filter(|&&c| c == b'`' || c == b'~')?;
    let n = t.bytes().take_while(|&b| b == ch).count();
    let info = &t[n..];
    let ok = l.len() - t.len() <= 3 && (ch == b'`' || ch == b'~') && n >= 3 && !(ch == b'`' && info.contains('`'));
    ok.then_some((ch, n, l.len() - t.len(), info.trim()))
}

/// A setext underline: `=`s or `-`s after up to 3 spaces.
fn is_underline(l: &str) -> bool {
    let t = l.trim_start_matches(' ');
    let u = t.trim_end_matches([' ', '\t']);
    l.len() - t.len() <= 3 && !u.is_empty() && (u.bytes().all(|b| b == b'=') || u.bytes().all(|b| b == b'-'))
}

fn closes(l: &str, (ch, n): (u8, usize)) -> bool {
    let t = l.trim_start_matches(' ');
    l.len() - t.len() <= 3 && t.bytes().take_while(|&b| b == ch).count() >= n && t.trim_start_matches(ch as char).trim_matches([' ', '\t']).is_empty()
}

const TYPE1: &[&str] = &["</script>", "</pre>", "</style>", "</textarea>"];

/// HTML block types 1–5 (CommonMark §4.6) run to an end marker, across blank lines. Their markers.
fn html_marker(l: &str) -> Option<&'static [&'static str]> {
    let t = l.trim_start_matches(' ');
    if l.len() - t.len() > 3 {
        return None;
    }
    let head: Vec<u8> = t.bytes().take(10).map(|b| b.to_ascii_lowercase()).collect();
    for tag in ["<script", "<pre", "<style", "<textarea"] {
        if head.starts_with(tag.as_bytes()) && matches!(head.get(tag.len()), None | Some(b' ' | b'\t' | b'>')) {
            return Some(TYPE1);
        }
    }
    match head.as_slice() {
        [b'<', b'!', b'-', b'-', ..] => Some(&["-->"]),
        [b'<', b'?', ..] => Some(&["?>"]),
        [b'<', b'!', b'[', b'c', b'd', b'a', b't', b'a', b'[', ..] => Some(&["]]>"]),
        [b'<', b'!', c, ..] if c.is_ascii_alphabetic() => Some(&[">"]),
        _ => None,
    }
}

/// A column-0 line that opens a fence or an HTML block of types 1–5, either of which ends a paragraph, list,
/// quote or table without a blank line.
fn opens_raw(l: &str) -> bool {
    fence_of(l).is_some_and(|f| f.2 == 0) || html_marker(l).is_some()
}

/// HTML block type 6's tag names (pulldown-cmark 0.13.4's `HTML_TAGS`).
const HTML6: [&str; 62] = [
    "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col", "colgroup", "dd",
    "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "frame",
    "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe", "legend", "li", "link",
    "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search", "section",
    "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "track", "ul",
];

/// A line that ends a top-level paragraph without a blank line, by pulldown-cmark 0.13.4's
/// `scan_paragraph_interrupt` (the caller checks a setext underline first). After at most 3 spaces: a thematic
/// break, an ATX heading, a fence, a quote, a non-empty bullet item or one numbered 1, an HTML block of types 1–6,
/// or a footnote definition.
/// ponytail: pulldown-cmark also lets a `|` row interrupt when the next line is a delimiter row with as many
/// columns; that takes a line of lookahead, so such a table stays in the oversized paragraph.
fn interrupts(l: &str) -> bool {
    if columns(l) > 3 {
        return false;
    }
    let t = l.trim_start_matches(' ');
    let b = t.as_bytes();
    let space = |c: Option<&u8>| c.is_none_or(|c| matches!(c, b' ' | b'\t' | b'\x0b' | b'\x0c'));
    let rule = thematic(b);
    let hashes = b.iter().take_while(|&&c| c == b'#').count();
    let atx = (1..=6).contains(&hashes) && space(b.get(hashes));
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    let item = match b.first() {
        Some(b'-' | b'+' | b'*') => Some(&t[1..]),
        _ if (1..=9).contains(&digits) && t[..digits].parse() == Ok(1u32) => t[digits..].strip_prefix(['.', ')']),
        _ => None,
    }
    .is_some_and(|rest| rest.starts_with([' ', '\t']) && !rest.trim_matches([' ', '\t']).is_empty());
    let html6 = t.strip_prefix('<').is_some_and(|s| {
        let s = s.strip_prefix('/').unwrap_or(s);
        let n = s.bytes().take_while(u8::is_ascii_alphanumeric).count();
        let rest = &s[n..];
        HTML6.contains(&s[..n].to_ascii_lowercase().as_str()) && (rest.is_empty() || rest.starts_with([' ', '\t', '>']) || rest.starts_with("/>"))
    });
    rule || atx || fence_of(l).is_some() || t.starts_with('>') || item || html_marker(l).is_some() || html6 || footnote_def(t)
}

/// A thematic break once its indent is gone: `*`, `-` or `_` at least 3 times, with spaces or tabs (`scan_hrule`).
fn thematic(b: &[u8]) -> bool {
    matches!(b.first(), Some(b'*' | b'-' | b'_'))
        && b.iter().all(|&c| c == b[0] || c == b' ' || c == b'\t')
        && b.iter().filter(|&&c| c == b[0]).count() >= 3
}

/// `[^label]:` with a label on one line, without `[`, and not only whitespace (pulldown-cmark's link label).
/// ponytail: pulldown-cmark also caps a label at 1,000 code points.
fn footnote_def(t: &str) -> bool {
    let Some(rest) = t.strip_prefix("[^") else { return false };
    let b = rest.as_bytes();
    let (mut i, mut text) = (0, false);
    while let Some(&c) = b.get(i) {
        match c {
            b'[' => return false,
            b']' => return text && b.get(i + 1) == Some(&b':'),
            b'\\' if b.get(i + 1).is_some_and(u8::is_ascii_punctuation) => {
                (i, text) = (i + 2, true);
                continue;
            }
            b' ' | b'\t' | b'\x0b' | b'\x0c' => {}
            _ => text = true,
        }
        i += 1;
    }
    false
}

impl Scan {
    fn new(kind: Kind, start: u64, piece: usize) -> Scan {
        let mode = match kind {
            Kind::Code => Piece::Code,
            Kind::Paragraph | Kind::List | Kind::Table => Piece::Markdown,
            _ => Piece::Raw,
        };
        Scan {
            kind,
            start,
            pos: start,
            lines: 0,
            mid_line: false,
            fence: None,
            marker: None,
            blank: false,
            content_end: start,
            piece: piece as u64,
            piece_start: start,
            last_ok: None,
            eol_end: false,
            cur_blank: false,
            restart: None,
            item: (0, 0),
            big: Big { cuts: vec![(start, mode)], body: (start, u64::MAX), strip: 0, lang: String::new(), head: (start, start) },
        }
    }

    /// How a sub-block starting at one of this kind's cut candidates renders.
    fn mode(&self) -> Piece {
        match self.kind {
            Kind::Code => Piece::Code,
            Kind::List => Piece::Markdown,
            Kind::Table => Piece::Rows,
            Kind::Paragraph => Piece::Words { newline: true },
            _ => Piece::Raw,
        }
    }

    /// One decoded step. Returns the block's end once found; otherwise `pos` moves past what was consumed.
    fn feed(&mut self, text: &str, src: &Src, eof: bool) -> Option<u64> {
        let b = text.as_bytes();
        let floor = |target: u64| src.at(floor_at(text, src, target));
        let mut i = 0;
        while i < b.len() {
            let (end, next) = match memchr::memchr2(b'\n', b'\r', &b[i..]) {
                Some(k) => (i + k, i + k + if b[i + k] == b'\r' && b.get(i + k + 1) == Some(&b'\n') { 2 } else { 1 }),
                None => (b.len(), b.len()),
            };
            let complete = next > end || eof;
            if !complete && !self.mid_line && i > 0 {
                break; // re-read this line whole in the next step
            }
            let l = &text[i..end];
            if !self.mid_line
                && let Some(end) = self.line(l, src.at(i), &floor)
            {
                self.force(end, &floor);
                return Some(end);
            }
            if let Some(kind) = self.restart {
                *self = Scan::new(kind, self.start, self.piece as usize);
                return None;
            }
            if self.kind == Kind::Paragraph {
                for j in memchr::memchr2_iter(b' ', b'\t', l.as_bytes()) {
                    if l.as_bytes().get(j + 1).is_some_and(|c| !matches!(c, b' ' | b'\t')) {
                        self.offer(src.at(i + j + 1), Piece::Words { newline: false }, &floor);
                    }
                }
            }
            if let Some(m) = self.marker
                && m.iter().any(|m| l.as_bytes().windows(m.len()).any(|w| w.eq_ignore_ascii_case(m.as_bytes())))
            {
                self.eol_end = true;
            }
            if !complete {
                self.force(src.at(end), &floor); // a line longer than a step: bound its pieces as it goes
                self.mid_line = true;
                i = end;
                break;
            }
            self.mid_line = false;
            let le = src.at(next);
            if !self.cur_blank {
                self.content_end = le;
            }
            if self.eol_end {
                self.force(le, &floor);
                return Some(le);
            }
            i = next;
        }
        self.pos = src.at(i);
        (eof && i == b.len()).then(|| {
            self.force(self.content_end, &floor);
            self.content_end
        })
    }

    /// A line's start: first-line facts, end conditions and the line's cut. `Some(end)` when the block ended
    /// before this line; `eol_end` when it ends with it.
    fn line(&mut self, l: &str, ls: u64, floor: &dyn Fn(u64) -> u64) -> Option<u64> {
        let i = self.lines;
        self.lines += 1;
        let blank = l.bytes().all(|b| b == b' ' || b == b'\t');
        let indent = columns(l);
        let col0 = indent == 0 && !blank;
        self.cur_blank = blank;
        if i == 0 {
            match self.kind {
                Kind::Code => match fence_of(l) {
                    Some((ch, n, indent, info)) => {
                        self.fence = Some((ch, n));
                        self.big.strip = indent;
                        self.big.lang = info.split_whitespace().next().unwrap_or("").chars().take(64).collect();
                        self.big.body.0 = u64::MAX; // set once the opener's line ends
                    }
                    None => self.big.strip = 4,
                },
                Kind::Html => self.marker = html_marker(l),
                // An ATX heading is one line; a setext heading runs to its underline.
                Kind::Heading => self.eol_end = l.trim_start_matches(' ').starts_with('#'),
                Kind::Rule => self.eol_end = true,
                Kind::List => self.item = marker_of(l).unwrap_or((0, 2)),
                _ => {}
            }
        } else {
            if i == 1 && self.big.body.0 == u64::MAX {
                self.big.body.0 = ls;
            }
            let ends = match self.kind {
                Kind::Code if self.fence.is_some() => {
                    if self.fence.is_some_and(|f| closes(l, f)) {
                        self.big.body.1 = ls;
                        self.eol_end = true;
                    }
                    false
                }
                Kind::Code => !blank && indent < 4,
                Kind::Html => self.marker.is_none() && blank,
                Kind::Heading if !is_underline(l) && (blank || interrupts(l)) => {
                    self.restart = Some(Kind::Paragraph);
                    return None;
                }
                Kind::Heading => {
                    self.eol_end = is_underline(l);
                    false
                }
                Kind::Meta => {
                    self.eol_end = matches!(l.trim_end(), "---" | "...");
                    false
                }
                // Outside a list item or a quote (pulldown-cmark 0.13.4's `scan_containers`, parse.rs:1448-1462), a
                // line ends the block unless it lazily continues a paragraph, and a line that interrupts one never
                // does; out there any list marker interrupts too (firstpass.rs:2134-2141, `!current_container`).
                // ponytail: any other line is taken as a lazy continuation (a list's only if no blank line came
                // first). pulldown-cmark ends the block there when the innermost open block isn't a paragraph (a
                // heading, a fence, an empty item, …), which takes a block parser to know.
                Kind::List if !blank && indent < self.item.1 => match marker_of(l) {
                    // An item of this list, or another list (`continue_list`, firstpass.rs:1560-1582).
                    Some(m) if m.0 == self.item.0 => {
                        self.item = m;
                        false
                    }
                    Some(_) => true,
                    None => self.blank || interrupts(l),
                },
                Kind::List => false,
                Kind::Quote => blank || !quoted(l) && (interrupts(l) || is_marker(l)),
                Kind::Footnote => col0 && (self.blank || opens_raw(l)),
                Kind::Paragraph if is_underline(l) => {
                    self.restart = Some(Kind::Heading);
                    return None;
                }
                Kind::Paragraph => blank || interrupts(l),
                _ => blank || col0 && opens_raw(l),
            };
            if ends {
                return Some(self.content_end);
            }
            if i == 2 && self.kind == Kind::Table {
                self.big.head = (self.start, ls);
            }
            let candidate = match self.kind {
                Kind::List => indent <= 3 && is_marker(l),
                Kind::Table => i >= 2,
                _ => true,
            };
            if candidate && !self.eol_end {
                self.offer(ls, self.mode(), floor);
            }
        }
        self.blank = blank;
        None
    }

    fn offer(&mut self, at: u64, mode: Piece, floor: &dyn Fn(u64) -> u64) {
        self.force(at, floor);
        self.last_ok = Some((at, mode));
    }

    /// Cuts until the current piece is within `piece` bytes of `upto`: at the last candidate if there is one past
    /// the piece's start, else at a char boundary (a Raw piece).
    fn force(&mut self, upto: u64, floor: &dyn Fn(u64) -> u64) {
        while upto > self.piece_start + self.piece {
            let cut = match self.last_ok {
                Some((c, mode)) if c > self.piece_start && c < upto => (c, mode),
                _ => (floor(self.piece_start + self.piece), Piece::Raw),
            };
            if cut.0 <= self.piece_start {
                break;
            }
            self.big.cuts.push(cut);
            self.piece_start = cut.0;
        }
    }

    fn finish(mut self, end: u64) -> (Block, Big) {
        self.big.cuts.retain(|c| c.0 < end);
        self.big.cuts.dedup_by_key(|c| c.0);
        (Block { start: self.start, end, kind: self.kind }, self.big)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core md::`
Expected: `test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 103 filtered out`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/md.rs
git commit -m "spike(c): windowed Markdown block index with oversized sub-blocks, pages and reconcile"
```

---

## Task C4d: The gates — span fidelity, byte maps, hostile HTML and mXSS

**Files:**
- Modify: `spikes/core/spike-core/src/lib.rs` (`mod md_gates;`, test-only)
- Create: `spikes/core/spike-core/src/md_gates.rs`

**Interfaces:**
- **Consumes:** `md::{Item, Kind, MAX_ITEM_UNITS, MAX_PAGE, MdConfig, MdDoc, Piece}` (Task C4c), `sanitize::sanitize` (Task C4a), `bytemap::naive_endpoints` (Task C1a), `store::{ByteStore, testutil::temp_file}` (plan A Task 4).
- **Produces:** three tests, no API.
  - `gate_span_fidelity`: 10,000 generated documents (front matter, ATX and setext headings, fences, indented code, quotes, lists, tables, HTML blocks, rules, footnotes, reference definitions and paragraphs; LF, CRLF or CR; UTF-8, UTF-16LE/BE or Windows-1252, with or without a BOM), with words that may start with a multi-byte character, `---` rules right after a paragraph and slide decks of `---` pairs, multi-line setext headings, lazy continuation lines in quotes and lists, and one time in three a block that interrupts the paragraph, quote or list before it with no blank line, indexed with 128–527-byte windows and 16–215-byte pieces so most documents cut many times. Every block span, heading span and sub-block span must equal the generator's record. A greedy-cut oracle predicts the sub-blocks.
  - `gate_byte_maps`: 10,000 generated documents of one to three paragraphs, ATX headings or multi-line quotes, with entities, escapes, strong, emphasis, strikethrough, links, math and code spans, over UTF-8, malformed UTF-8, Windows-1252 and UTF-16LE/BE, and LF, CRLF or CR. The generator records each displayed character's bytes under the marker policy; Task C1a's `naive_endpoints` turns that into the expected `(start_byte, end_byte)` at every offset of every run.
  - `gate_hostile_html_and_mxss`: 71 hostile payloads (mXSS, namespace confusion, `<svg>`/`<math>`, comments, CDATA, unterminated tags, schemes, network paths, `file:`/`smb:`/`ms-settings:` links, `ping`/`target`/`rel` attributes, `style`, event handlers, tags split across lines and blocks) in 6 Markdown contexts (an HTML block, inline, a list item, a quote, a table cell, a heading). Every output must pass a checker written independently of the sanitizer's code and of ammonia's configuration: allowed tags and per-tag attributes only (18 pairs), no `on*`, no `style`, no resource-loading attribute; `href` only `http`/`https`/`mailto`, `#` or relative, never a network path; `data-href` never `javascript`/`vbscript`/`data`; `data-src` never a network path; idempotent under `sanitize`. A disallowed tag must show as escaped text. Every item must be bounded.

- [ ] **Step 1: Add the gates**

In `src/lib.rs`, add the module above `pub fn version`:
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub fn version() -> &'static str {
```
```rust
#[cfg(test)]
mod md_gates;

pub fn version() -> &'static str {
```

`spikes/core/spike-core/src/md_gates.rs`:
<!-- op: create spikes/core/spike-core/src/md_gates.rs -->
```rust
//! Spike C's Markdown gates (spec §13.1): span fidelity, byte maps and the sanitizer. Each oracle comes from the
//! generator's own record of what it wrote, or from rules written here; none reads pulldown-cmark's output.
use std::sync::atomic::AtomicBool;

use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1252};

use crate::bytemap::naive_endpoints;
use crate::md::{Item, Kind, MAX_ITEM_UNITS, MAX_PAGE, MdConfig, MdDoc, Piece};
use crate::sanitize::sanitize;
use crate::store::ByteStore;
use crate::store::testutil::temp_file;

const CASES: u64 = 10_000;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<T: Copy>(&mut self, v: &[T]) -> T {
        v[self.below(v.len())]
    }
}

/// Independent of ammonia's configuration: the brief's allowlist plus the emitter's markup, and per tag the only
/// attributes allowed. No `on*`, no `style`, no resource-loading attribute. Brief §4.4, §4.6: a live `href` is `#`,
/// http, https, mailto or a relative path that isn't a network path; any other target is inert `data-href`, only
/// on `<a>`, and never javascript, vbscript or data; no `data-src` is a network path. Sanitizing again changes nothing.
fn check_output(html: &str) -> Result<(), String> {
    const TAGS: [&str; 36] = [
        "b", "i", "em", "strong", "code", "kbd", "sub", "sup", "br", "hr", "details", "summary", "a", "table", "thead", "tbody", "tr",
        "th", "td", "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "del", "span", "div", "input", "img",
    ];
    const ATTRS: [(&str, &str); 18] = [
        ("a", "href"),
        ("a", "data-href"),
        ("ol", "start"),
        ("pre", "class"),
        ("pre", "data-lang"),
        ("input", "type"),
        ("input", "checked"),
        ("input", "disabled"),
        ("span", "class"),
        ("span", "data-src"),
        ("span", "data-alt"),
        ("span", "data-fn"),
        ("div", "class"),
        ("div", "data-align"),
        ("div", "data-fn"),
        ("blockquote", "class"),
        ("blockquote", "data-kind"),
        ("blockquote", "data-tint"),
    ];
    const LOADS: [&str; 14] =
        ["src", "srcset", "poster", "background", "action", "formaction", "data", "xlink:href", "codebase", "longdesc", "lowsrc", "ping", "manifest", "cite"];
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        let end = rest[i..].find('>').ok_or("unterminated tag")? + i;
        let tag = rest[i + 1..end].trim_start_matches('/');
        rest = &rest[end + 1..];
        let (name, mut attrs) = tag.split_once(' ').unwrap_or((tag, ""));
        if !TAGS.contains(&name) || name == "img" {
            return Err(format!("element <{name}>"));
        }
        while let Some((attr, after)) = attrs.trim_start().split_once("=\"") {
            let (value, after) = after.split_once('"').ok_or("unquoted attribute")?;
            attrs = after;
            if attr.starts_with("on") || attr == "style" || LOADS.contains(&attr) || !ATTRS.contains(&(name, attr)) {
                return Err(format!("attribute {attr} on <{name}>"));
            }
            let value = value.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", "\u{A0}").replace("&amp;", "&");
            let (s, scheme) = whatwg(&value);
            let bad = match attr {
                "href" => scheme.is_some_and(|s| !matches!(s.as_str(), "http" | "https" | "mailto")) || network_path(&s),
                "data-href" => scheme.is_some_and(|s| matches!(s.as_str(), "javascript" | "vbscript" | "data")),
                "data-src" => network_path(&s),
                _ => false,
            };
            if bad {
                return Err(format!("{attr} {value:?}"));
            }
        }
        if !attrs.trim().is_empty() {
            return Err(format!("stray attribute text {attrs:?}"));
        }
    }
    if sanitize(html) != html {
        return Err("sanitizing again changed it".into());
    }
    Ok(())
}

/// WHATWG URL parsing's first steps: C0 controls and spaces trimmed, tabs and newlines removed. Then the URL and its
/// scheme, lowercased: an ASCII letter followed by letters, digits, `+`, `-` or `.` before the first `:`.
fn whatwg(url: &str) -> (String, Option<String>) {
    let s: String = url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let scheme = s
        .split_once(':')
        .map(|(scheme, _)| scheme)
        .filter(|scheme| scheme.starts_with(|c: char| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)))
        .map(str::to_ascii_lowercase);
    (s, scheme)
}

/// `//host…` or `\\host…` (WHATWG reads `\` as `/`): a UNC path the brief touches only after a click.
fn network_path(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\')
}

/// Every item: structurally safe, within the caps, and (when mapped) its runs tile its span.
fn check_items(items: &[Item]) -> Result<(), String> {
    for it in items {
        check_output(&it.html)?;
        let units: usize = it.runs.iter().map(|r| r.map.units() as usize).sum();
        if units > MAX_ITEM_UNITS || it.html.len() > MAX_PAGE {
            return Err(format!("item over the caps: {units} units, {} bytes", it.html.len()));
        }
        if it.unmapped.is_none() {
            let mut at = it.span.0;
            for r in &it.runs {
                if r.map.start_byte(0) != at {
                    return Err(format!("runs don't tile {:?}: {:?}", it.span, it.runs));
                }
                at = r.map.end_byte(r.map.units());
            }
            if !it.runs.is_empty() && at != it.span.1 {
                return Err(format!("runs end at {at}, item at {}", it.span.1));
            }
        }
    }
    Ok(())
}

/// Encodes `s` and maps each UTF-8 char boundary of `s` to its byte offset in the encoded file.
fn encode(s: &str, encoding: &'static Encoding, bom: bool) -> (Vec<u8>, Vec<usize>) {
    let mut bytes: Vec<u8> = match (bom, encoding) {
        (false, _) => vec![],
        (true, e) if e == UTF_8 => vec![0xEF, 0xBB, 0xBF],
        (true, e) if e == UTF_16LE => vec![0xFF, 0xFE],
        (true, _) => vec![0xFE, 0xFF],
    };
    let mut map = vec![0; s.len() + 1];
    for (i, c) in s.char_indices() {
        map[i] = bytes.len();
        let mut buf = [0u16; 2];
        match encoding {
            e if e == UTF_16LE => bytes.extend(c.encode_utf16(&mut buf).iter().flat_map(|u| u.to_le_bytes())),
            e if e == UTF_16BE => bytes.extend(c.encode_utf16(&mut buf).iter().flat_map(|u| u.to_be_bytes())),
            e if e == WINDOWS_1252 => bytes.extend(WINDOWS_1252.encode(c.encode_utf8(&mut [0; 4])).0.iter()),
            _ => bytes.extend(c.encode_utf8(&mut [0; 4]).as_bytes()),
        }
    }
    map[s.len()] = bytes.len();
    (bytes, map)
}

// ---- Span fidelity ----

/// A block as the generator wrote it: UTF-8 byte range, kind, and the positions where a sub-block may start
/// (line starts, list items, table rows, word starts, by kind).
struct GenBlock {
    span: (usize, usize),
    kind: Kind,
    cuts: Vec<usize>,
}

struct Gen {
    s: String,
    nl: &'static str,
    blocks: Vec<GenBlock>,
    /// (block index, heading span)
    headings: Vec<(usize, (usize, usize))>,
}

impl Gen {
    /// Appends a line; returns its start.
    fn line(&mut self, text: &str) -> usize {
        let at = self.s.len();
        self.s.push_str(text);
        self.s.push_str(self.nl);
        at
    }

    /// A word starting with a letter, or one time in four with a multi-byte char (a line that starts with one is
    /// where byte-indexed slicing breaks): neither can start a block.
    fn word(&mut self, r: &mut Rng, chars: &[char]) -> String {
        let n = 1 + r.below(7);
        let mut w: String = (0..n).map(|_| r.pick(chars)).collect();
        let wide: Vec<char> = chars.iter().copied().filter(|c| !c.is_ascii()).collect();
        w.insert(0, if r.below(4) == 0 { r.pick(&wide) } else { r.pick(&['a', 'k', 'q', 'z', 'B']) });
        w
    }

    /// Words with inline markup; it starts with a word, so no line it begins can start a block.
    fn words(&mut self, r: &mut Rng, chars: &[char]) -> String {
        let mut out = self.word(r, chars);
        for _ in 0..r.below(9) {
            let w = self.word(r, chars);
            let piece = match r.below(9) {
                0 => format!("*{w}*"),
                1 => format!("**{w}**"),
                2 => format!("`{w}`"),
                3 => format!("[{w}](http://x/{w})"),
                4 => "&amp;".to_string(),
                5 => "\\*".to_string(),
                _ => w,
            };
            out.push(' ');
            out.push_str(&piece);
        }
        out
    }
}

fn generate(r: &mut Rng, chars: &[char]) -> Gen {
    let nl = r.pick(&["\n", "\r\n", "\r"]);
    let mut g = Gen { s: String::new(), nl, blocks: Vec::new(), headings: Vec::new() };
    let mut prev = Kind::Other;
    // The last block was a `---` rule with no blank line after it: a slide deck's shape.
    let mut tight = false;
    // The last block was a paragraph, quote or list, and a block that ends it follows with no blank line between.
    let mut interrupt = None;
    for b in 0..1 + r.below(12) {
        if b > 0 && !tight && interrupt.is_none() {
            g.line(r.pick(&["", "  ", "\t"]));
            if r.below(4) == 0 {
                let label = g.word(r, chars);
                g.line(&format!("[{label}]: /u"));
                if r.below(2) == 0 {
                    g.line("'a title'");
                }
                g.line("");
            }
        }
        let start = g.s.len();
        let mut lines = vec![];
        let mut cuts = vec![];
        // After a tight `---`, half the time the next slide's heading.
        // After a paragraph, an interrupting block: an ATX heading, a fence, a quote, a list starting at 1, HTML of
        // types 1–6, a `***` or `___` rule (`---` would be its setext underline) or a footnote definition. After a
        // quote or list the next line is outside it, where pulldown-cmark checks no setext underline (so `---` is a
        // rule) but the same interrupts; not a quote after a quote, or a list after a list, which would continue it.
        let choice = match interrupt {
            _ if tight && r.below(2) == 0 => 1,
            Some(Kind::Paragraph) => r.pick(&[1, 3, 5, 6, 8, 9, 10]),
            Some(Kind::Quote) => r.pick(&[1, 3, 6, 8, 9, 10]),
            Some(_) => r.pick(&[1, 3, 5, 8, 9, 10]),
            None => r.below(13),
        };
        let interrupting = interrupt == Some(Kind::Paragraph);
        tight = false;
        let kind = match choice {
            0 if b == 0 => {
                g.line("---");
                lines.push(g.line("key: value"));
                g.line("---");
                Kind::Meta
            }
            0 | 1 => {
                let text = g.words(r, chars);
                g.line(&format!("{} {text}", "#".repeat(1 + r.below(6))));
                g.headings.push((g.blocks.len(), (start, g.s.len())));
                Kind::Heading
            }
            2 => {
                let text = g.words(r, chars);
                g.line(&text);
                // A multi-line setext heading reads as a paragraph until its underline: oversized, its scan restarts.
                for _ in 0..r.below(3) {
                    let text = g.words(r, chars);
                    lines.push(g.line(&text));
                }
                g.line(r.pick(&["===", "---"]));
                g.headings.push((g.blocks.len(), (start, g.s.len())));
                Kind::Heading
            }
            3 => {
                let fence = r.pick(&["```", "~~~~"]);
                g.line(&format!("{fence}{}", r.pick(&["", "rust", "mermaid"])));
                for _ in 0..1 + r.below(8) {
                    let content = match r.below(6) {
                        0 => String::new(),
                        1 => "# not a heading".into(),
                        2 => "- not a list".into(),
                        3 => "<!-- not html".into(),
                        _ => g.words(r, chars),
                    };
                    lines.push(g.line(&content));
                }
                g.line(fence);
                Kind::Code
            }
            // Indented code after a list or footnote continues it, and after indented code it merges.
            4 if !matches!(prev, Kind::List | Kind::Footnote | Kind::Code) => {
                let text = g.words(r, chars);
                g.line(&format!("    {text}"));
                for _ in 0..r.below(5) {
                    if r.below(3) == 0 {
                        lines.push(g.line(""));
                    }
                    let text = g.words(r, chars);
                    lines.push(g.line(&format!("    {text}")));
                }
                Kind::Code
            }
            5 => {
                let first = match r.below(3) {
                    0 => "> [!NOTE]".to_string(),
                    1 => format!("> [!info] {}", g.words(r, chars)),
                    _ => format!("> {}", g.words(r, chars)),
                };
                g.line(&first);
                // pulldown-cmark 0.13.4 lets a lone `[!NOTE]` line swallow a following whitespace-only line (and so
                // merges the next quote): an alert always gets a body line here.
                for _ in 0..r.below(4).max(usize::from(first == "> [!NOTE]")) {
                    let text = g.words(r, chars);
                    if r.below(4) == 0 {
                        let at = g.line(&format!("> # {text}"));
                        lines.push(at);
                        g.headings.push((g.blocks.len(), (at + 2, g.s.len())));
                    } else {
                        lines.push(g.line(&format!("> {text}")));
                        // A lazy continuation line: no `>`, and it can't interrupt the paragraph it continues.
                        if r.below(4) == 0 {
                            let text = g.words(r, chars);
                            lines.push(g.line(&text));
                        }
                    }
                }
                Kind::Quote
            }
            6 if prev != Kind::List => {
                let (marker, indent) = r.pick(&[("-", 2), ("*", 2), ("1.", 3), ("1)", 3)]);
                let loose = r.below(2) == 0;
                for item in 0..1 + r.below(6) {
                    if item > 0 && loose {
                        lines.push(g.line(""));
                    }
                    let m = marker.replace('1', &(item + 1).to_string());
                    let text = g.words(r, chars);
                    let at = g.line(&format!("{m} {text}"));
                    if item > 0 {
                        cuts.push(at);
                    }
                    lines.push(at);
                    if r.below(3) == 0 {
                        let text = g.words(r, chars);
                        lines.push(g.line(&format!("{}{text}", " ".repeat(indent))));
                    }
                    // A lazy continuation line: outside the item's indent, continuing its paragraph.
                    if r.below(4) == 0 {
                        let text = g.words(r, chars);
                        lines.push(g.line(&text));
                    }
                }
                Kind::List
            }
            7 => {
                lines.push(g.line("| a | b |"));
                lines.push(g.line("|---|:-:|"));
                for _ in 0..1 + r.below(8) {
                    let (x, y) = (g.word(r, chars), g.word(r, chars));
                    let at = g.line(&format!("| {x} | {y} |"));
                    cuts.push(at);
                }
                Kind::Table
            }
            8 => {
                if r.below(2) == 0 {
                    g.line("<div>");
                    for _ in 0..r.below(5) {
                        let text = g.word(r, chars);
                        lines.push(g.line(&format!("<p>{text}</p>")));
                    }
                    lines.push(g.line("</div>"));
                } else {
                    g.line("<!--");
                    for _ in 0..r.below(5) {
                        let text = if r.below(3) == 0 { String::new() } else { g.words(r, chars) };
                        lines.push(g.line(&text));
                    }
                    lines.push(g.line("-->"));
                }
                Kind::Html
            }
            9 => {
                let rule = r.pick(if interrupting { &["***", "___"][..] } else { &["***", "___", "---"] });
                g.line(rule);
                // A `---` followed directly by the next block, half the time. Not at the file's start: there, a later
                // `---` line would close it as front matter.
                tight = rule == "---" && b > 0 && r.below(2) == 0;
                Kind::Rule
            }
            10 => {
                let (label, text) = (g.word(r, chars), g.words(r, chars));
                g.line(&format!("[^{label}]: {text}"));
                if r.below(2) == 0 {
                    lines.push(g.line(""));
                    let text = g.words(r, chars);
                    lines.push(g.line(&format!("    {text}")));
                }
                Kind::Footnote
            }
            _ => {
                let first = g.words(r, chars);
                g.line(&first);
                for _ in 0..r.below(4) {
                    let text = g.words(r, chars);
                    lines.push(g.line(&text));
                }
                Kind::Paragraph
            }
        };
        let end = g.s.len();
        // Where a sub-block may start, from what was written: see `Scan` in md.rs for the same rules.
        match kind {
            Kind::List | Kind::Table => {}
            Kind::Paragraph => {
                cuts.extend(lines.iter().copied());
                let bytes = g.s.as_bytes();
                cuts.extend((start..end).filter(|&i| i > start && bytes[i - 1] == b' ' && !matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r')));
            }
            // Line starts after the first, except a closing fence or front matter's closing line (it ends the block).
            _ => cuts.extend(lines.iter().copied()),
        }
        cuts.sort_unstable();
        g.blocks.push(GenBlock { span: (start, end), kind, cuts });
        prev = kind;
        interrupt = (matches!(kind, Kind::Paragraph | Kind::Quote | Kind::List) && r.below(3) == 0).then_some(kind);
    }
    if r.below(3) == 0 {
        let n = g.s.len() - nl.len();
        g.s.truncate(n); // no final line ending
        if let Some(b) = g.blocks.last_mut() {
            b.span.1 = b.span.1.min(n);
        }
        for h in g.headings.iter_mut() {
            h.1.1 = h.1.1.min(n);
        }
    }
    g
}

/// Spec §13.1: zero span mismatches across ≥ 10,000 generated cases, for every block span, heading span and
/// sub-block span, with windows and pieces small enough that most documents cut many times.
#[test]
fn gate_span_fidelity() {
    const UNICODE: [char; 12] = ['a', 'b', 'e', 'r', '7', 'é', 'ß', 'Ж', '中', '😀', 'o', 'n'];
    const LATIN1: [char; 8] = ['a', 'b', 'e', 'r', '7', 'é', '€', 'ü'];
    let (mut blocks, mut headings, mut pieces, mut items) = (0, 0, 0, 0);
    for case in 0..CASES {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15 ^ case.wrapping_mul(0x2545_F491_4F6C_DD1D));
        let encoding = r.pick(&[UTF_8, UTF_8, UTF_16LE, UTF_16BE, WINDOWS_1252]);
        let g = generate(&mut r, if encoding == WINDOWS_1252 { &LATIN1 } else { &UNICODE });
        let (bytes, map) = encode(&g.s, encoding, encoding != WINDOWS_1252 && r.below(2) == 0);
        // A window shorter than a reference definition and its title has nothing to cut at: see the report.
        let cfg = MdConfig { window: 128 + r.below(400), piece: 16 + r.below(200), ..MdConfig::default() };
        let doc = MdDoc::new(ByteStore::open(&temp_file("gate-spans", &bytes)).unwrap(), encoding, cfg);
        let fail = |what: String| panic!("case {case} ({}, {cfg:?}): {what}\n{:?}", encoding.name(), g.s);
        assert!(doc.index_all(&AtomicBool::new(false)).unwrap());
        let idx = doc.index();
        let got: Vec<(u64, u64, Kind)> = idx.blocks.iter().map(|b| (b.start, b.end, b.kind)).collect();
        let want: Vec<(u64, u64, Kind)> = g.blocks.iter().map(|b| (map[b.span.0] as u64, map[b.span.1] as u64, b.kind)).collect();
        if got != want {
            fail(format!("blocks\n got {got:?}\nwant {want:?}"));
        }
        blocks += got.len();
        // Heading entries exist for blocks indexed whole (an oversized block is scanned, not parsed).
        let got: Vec<(u64, (u64, u64))> = idx.headings.iter().map(|h| (h.block, h.span)).collect();
        let want: Vec<(u64, (u64, u64))> = g
            .headings
            .iter()
            .filter(|h| !idx.big.contains_key(&(h.0 as u64)))
            .map(|&(b, (s, e))| (b as u64, (map[s] as u64, map[e] as u64)))
            .collect();
        if got != want {
            fail(format!("headings\n got {got:?}\nwant {want:?}"));
        }
        headings += got.len();
        // Sub-blocks: each cut is the last candidate within `piece` bytes of the previous cut, or, with none,
        // a Raw cut at the last char boundary within `piece` bytes.
        for (&id, big) in &idx.big {
            let gb = &g.blocks[id as usize];
            let (end, piece) = (map[gb.span.1] as u64, cfg.piece as u64);
            let candidates: Vec<u64> = gb.cuts.iter().map(|&c| map[c] as u64).collect();
            let boundaries: Vec<u64> = (gb.span.0..gb.span.1).filter(|&i| g.s.is_char_boundary(i)).map(|i| map[i] as u64).collect();
            let mut prev = map[gb.span.0] as u64;
            for &(cut, mode) in &big.cuts[1..] {
                let best = candidates.iter().copied().filter(|&c| c > prev && c <= prev + piece && c < end).max();
                let ok = match best {
                    Some(c) => cut == c && mode != Piece::Raw || cut == c && matches!(gb.kind, Kind::Quote | Kind::Html | Kind::Footnote | Kind::Heading | Kind::Rule | Kind::Meta),
                    None => mode == Piece::Raw && Some(cut) == boundaries.iter().copied().filter(|&c| c > prev && c <= prev + piece).max(),
                };
                if !ok {
                    fail(format!("block {id} cut {cut} ({mode:?}) after {prev}: want {best:?}; cuts {:?}", big.cuts));
                }
                prev = cut;
            }
            if end - prev > piece {
                fail(format!("block {id}: last piece {prev}..{end} over {piece}"));
            }
            pieces += big.cuts.len();
        }
        drop(idx);
        for b in 0..g.blocks.len() as u64 {
            let rendered = doc.render(b).unwrap();
            if let Err(e) = check_items(&rendered) {
                fail(format!("block {b}: {e}"));
            }
            items += rendered.len();
        }
    }
    println!("span gate: {CASES} cases, {blocks} block spans, {headings} heading spans, {pieces} sub-block spans, {items} items checked: 0 mismatches");
}

// ---- Byte maps ----

/// A run as the generator expects it: display text and elements `(units, first byte, byte past)`.
#[derive(Default, Debug)]
struct WantRun {
    text: String,
    elements: Vec<(u32, u64, u64)>,
}

/// Writes inline Markdown in one encoding and records, for every displayed character, the source bytes it owns
/// under mdemit.rs's marker policy: markup before a character (an opening marker, an escape's `\`, a quote's
/// `> `) joins it, closing markup (`**`, `](url)`, the block's line ending) joins the character before.
struct Inline {
    encoding: &'static Encoding,
    malformed: bool,
    bytes: Vec<u8>,
    blocks: Vec<Vec<WantRun>>,
    claimed: u64,
}

impl Inline {
    fn src(&mut self, s: &str) -> u64 {
        let mut buf = [0u16; 2];
        for c in s.chars() {
            match self.encoding {
                e if e == UTF_16LE => self.bytes.extend(c.encode_utf16(&mut buf).iter().flat_map(|u| u.to_le_bytes())),
                e if e == UTF_16BE => self.bytes.extend(c.encode_utf16(&mut buf).iter().flat_map(|u| u.to_be_bytes())),
                e if e == WINDOWS_1252 => self.bytes.extend(WINDOWS_1252.encode(c.encode_utf8(&mut [0; 4])).0.iter()),
                _ => self.bytes.extend(c.encode_utf8(&mut [0; 4]).as_bytes()),
            }
        }
        self.bytes.len() as u64
    }

    /// A displayed element ending at `end`: it owns every unclaimed byte before it.
    fn show(&mut self, display: &str, end: u64) {
        let run = self.blocks.last_mut().unwrap().last_mut().unwrap();
        run.text.push_str(display);
        run.elements.push((display.encode_utf16().count() as u32, self.claimed, end));
        self.claimed = end;
    }

    /// Closing markup just written joins the last element.
    fn close(&mut self) {
        let end = self.bytes.len() as u64;
        let last = self.blocks.last_mut().unwrap().iter_mut().rev().find_map(|r| r.elements.last_mut()).unwrap();
        last.2 = end;
        self.claimed = end;
    }

    /// A tag: the next text is a new DOM text node.
    fn tag(&mut self) {
        self.blocks.last_mut().unwrap().push(WantRun::default());
    }

    /// Displayed one to one: each char owns its own bytes. Malformed UTF-8 shows U+FFFD per maximal invalid subpart
    /// (std's `utf8_chunks`, the WHATWG rule).
    fn plain(&mut self, r: &mut Rng, chars: &[char]) {
        let mut word = vec![];
        for i in 0..1 + r.below(6) {
            if self.malformed && i > 0 && r.below(3) == 0 {
                word.extend_from_slice(r.pick(&[&[0xE2, 0x82][..], &[0xFF], &[0xC0, 0x80], &[0xED, 0xA0, 0x80], &[0xF0, 0x9F, 0x98], &[0x80]]));
            } else {
                let c = if i == 0 { r.pick(&['a', 'k', 'B']) } else { r.pick(chars) };
                word.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
            }
        }
        if !self.malformed {
            for c in String::from_utf8(word).unwrap().chars() {
                let end = self.src(&c.to_string());
                self.show(&c.to_string(), end);
            }
            return;
        }
        for chunk in word.utf8_chunks() {
            for c in chunk.valid().chars() {
                let end = self.src(&c.to_string());
                self.show(&c.to_string(), end);
            }
            if !chunk.invalid().is_empty() {
                self.bytes.extend_from_slice(chunk.invalid());
                self.show("\u{FFFD}", self.bytes.len() as u64);
            }
        }
    }

    fn segment(&mut self, r: &mut Rng, chars: &[char]) {
        const ENTITIES: [(&str, &str); 11] = [
            ("&amp;", "&"),
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&copy;", "©"),
            ("&nbsp;", "\u{A0}"),
            ("&eacute;", "é"),
            ("&#65;", "A"),
            ("&#x1F600;", "😀"),
            ("&#0;", "\u{FFFD}"),
            ("&#X4E2D;", "中"),
        ];
        let wrap = |s: &mut Self, r: &mut Rng, open: &str, close: &str| {
            s.src(open);
            s.tag();
            s.plain(r, chars);
            s.src(close);
            s.close();
            s.tag();
        };
        match r.below(10) {
            0 => {
                let (src, display) = r.pick(&ENTITIES);
                let end = self.src(src);
                self.show(display, end);
            }
            1 => {
                let p = r.pick(&"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".chars().collect::<Vec<_>>());
                let end = self.src(&format!("\\{p}"));
                self.show(&p.to_string(), end);
            }
            2 => wrap(self, r, "**", "**"),
            3 => wrap(self, r, "*", "*"),
            4 => wrap(self, r, "~~", "~~"),
            5 => wrap(self, r, "[", "](http://x/y)"),
            6 => wrap(self, r, "$", "$"),
            7 => {
                // A code span shows its content literally, entities included.
                self.src("`");
                self.tag();
                let inner = r.pick(&["a*b", "&amp;", "x\\y", "<b>"]);
                for c in inner.chars() {
                    let end = self.src(&c.to_string());
                    self.show(&c.to_string(), end);
                }
                self.src("`");
                self.close();
                self.tag();
            }
            _ => self.plain(r, chars),
        }
    }
}

/// Spec §13.1: zero selection-endpoint mismatches across ≥ 10,000 generated cases, over UTF-8, malformed UTF-8,
/// Windows-1252 and UTF-16LE/BE, with entities, escapes and markup. The oracle is the generator's record of each
/// displayed character's bytes; C1's `naive_endpoints` turns it into the expected endpoint at every offset.
#[test]
fn gate_byte_maps() {
    const UNICODE: [char; 10] = ['a', 'b', 'e', 'r', '7', 'é', 'ß', 'Ж', '中', '😀'];
    const LATIN1: [char; 8] = ['a', 'b', 'e', 'r', '7', 'é', '€', 'ü'];
    let (mut runs, mut endpoints) = (0, 0);
    for case in 0..CASES {
        let mut r = Rng(0x2545_F491_4F6C_DD1D ^ case.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let (encoding, malformed) = r.pick(&[(UTF_8, false), (UTF_8, true), (WINDOWS_1252, false), (UTF_16LE, false), (UTF_16BE, false)]);
        let chars: &[char] = if encoding == WINDOWS_1252 { &LATIN1 } else { &UNICODE };
        let nl = r.pick(&["\n", "\r\n", "\r"]);
        let mut g = Inline { encoding, malformed, bytes: vec![], blocks: vec![], claimed: 0 };
        if encoding != WINDOWS_1252 && r.below(2) == 0 {
            g.bytes = match encoding {
                e if e == UTF_16LE => vec![0xFF, 0xFE],
                e if e == UTF_16BE => vec![0xFE, 0xFF],
                _ => vec![0xEF, 0xBB, 0xBF],
            };
        }
        for b in 0..1 + r.below(3) {
            if b > 0 {
                g.src(nl); // the blank line between blocks belongs to no block
            }
            g.claimed = g.bytes.len() as u64;
            g.blocks.push(vec![WantRun::default()]);
            let kind = r.below(3);
            match kind {
                0 => {
                    g.src(&format!("{} ", "#".repeat(1 + r.below(6))));
                }
                1 => {
                    g.src("> ");
                }
                _ => {}
            }
            let lines = if kind == 0 { 1 } else { 1 + r.below(3) };
            for line in 0..lines {
                if line > 0 {
                    let end = g.src(nl);
                    g.show("\n", end);
                    if kind == 1 {
                        g.src("> ");
                    }
                }
                g.plain(&mut r, chars);
                for _ in 0..r.below(6) {
                    let end = g.src(" ");
                    g.show(" ", end);
                    g.segment(&mut r, chars);
                }
            }
            g.src(nl);
            g.close();
        }
        let doc = MdDoc::new(ByteStore::open(&temp_file("gate-maps", &g.bytes)).unwrap(), encoding, MdConfig::default());
        assert!(doc.index_all(&AtomicBool::new(false)).unwrap());
        for (b, want) in g.blocks.iter().enumerate() {
            let want: Vec<&WantRun> = want.iter().filter(|w| !w.elements.is_empty()).collect();
            let items = doc.render(b as u64).unwrap();
            let fail = |what: String| panic!("case {case} ({}{}), block {b}: {what}\n{:?}", encoding.name(), if malformed { " malformed" } else { "" }, g.bytes);
            if items.len() != 1 || items[0].unmapped.is_some() {
                fail(format!("{} items, unmapped {:?}", items.len(), items[0].unmapped));
            }
            if let Err(e) = check_items(&items) {
                fail(e);
            }
            let got = &items[0].runs;
            if got.len() != want.len() {
                fail(format!("runs\n got {:?}\nwant {want:?}", got.iter().map(|r| &r.text).collect::<Vec<_>>()));
            }
            for (run, w) in got.iter().zip(&want) {
                let elements: Vec<(u32, u64)> = w.elements.iter().map(|&(u, a, b)| (u, b - a)).collect();
                let expect = naive_endpoints(w.elements[0].1, &elements);
                let ours: Vec<(u64, u64)> = (0..=run.map.units()).map(|u| (run.map.start_byte(u), run.map.end_byte(u))).collect();
                if run.text != w.text || ours != expect {
                    fail(format!("run {:?} (want {:?})\n got {ours:?}\nwant {expect:?}", run.text, w.text));
                }
                runs += 1;
                endpoints += 2 * ours.len();
            }
        }
    }
    println!("byte-map gate: {CASES} cases, {runs} runs, {endpoints} selection endpoints: 0 mismatches");
}

// ---- Sanitizer ----

/// Hostile raw HTML and mXSS payloads; `true` where the payload is HTML whose first disallowed tag must show as
/// literal text (`false` for Markdown-syntax payloads).
const HOSTILE: [(&str, bool); 71] = [
    // svg/math namespace confusion
    ("<svg><style><img src=x onerror=alert(1)></style></svg>", true),
    ("<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>", true),
    ("<svg><foreignObject><b>x</b></foreignObject></svg>", true),
    ("<math><mi><svg><title><img src=x onerror=1>", true),
    ("<svg><a xlink:href=\"javascript:alert(1)\">x</a></svg>", true),
    ("<math href=\"javascript:alert(1)\">x</math>", true),
    // raw-text and RCDATA elements
    ("<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">", true),
    ("<style><img src=x onerror=1></style>", true),
    ("<template><img src=x onerror=1></template>", true),
    ("<textarea><img src=x onerror=1></textarea>", true),
    ("<title><img src=x onerror=1></title>", true),
    ("<xmp><img src=x onerror=1></xmp>", true),
    ("<plaintext><img src=x onerror=1>", true),
    ("<noembed><img src=x onerror=1></noembed>", true),
    ("<iframe><img src=x onerror=1></iframe>", true),
    // comments and CDATA
    ("<!--<img src=x onerror=1>-->", false),
    ("<!--><img src=x onerror=1>-->", false),
    ("<![CDATA[<img src=x onerror=1>]]>", false),
    ("<!-- unclosed\n\n<img src=x onerror=1>", false),
    ("<!DOCTYPE html><html><body onload=alert(1)>", true),
    ("<?xml version=\"1.0\"?><x onclick=1>", true),
    // unclosed and split tags, across lines, events and blocks
    ("<b title=\"\n\n\" onclick=1>x</b>", false),
    ("<scr\n\nipt>alert(1)</script>", true),
    ("a <b\nonclick=1>x</b>", false),
    ("<b>open in block 1\n\n</b> closed in block 2", false),
    ("<a href=\"javascript:alert(1)\"\n\n>split</a>", false),
    ("<img src=x\n\nonerror=alert(1)>", false),
    // event handlers and URL schemes, with entity, tab, newline and case obfuscation
    ("<img src=x onerror=alert(1)>", false),
    ("<a href=\"javascript:alert(1)\">x</a>", false),
    ("<a href=\"JaVaScRiPt:alert(1)\">x</a>", false),
    ("<a href=\"java&#x09;script:alert(1)\">x</a>", false),
    ("<a href=\"java\tscript:alert(1)\">x</a>", false),
    ("<a href=\"&#106;avascript:alert(1)\">x</a>", false),
    ("<a href=\"&#x6A;avascript&#58;alert(1)\">x</a>", false),
    ("<a href=\" javascript:alert(1)\">x</a>", false),
    ("<a href=\"&#14;javascript:alert(1)\">x</a>", false),
    ("<a href=\"vbscript:msgbox(1)\">x</a>", false),
    ("<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">x</a>", false),
    ("<a href=\"DATA:text/html,<script>alert(1)</script>\">x</a>", false),
    ("<img src=\"javascript:alert(1)\" alt=\"j\">", false),
    ("[x](javascript:alert(1))", false),
    ("[x](JAVASCRIPT:alert(1))", false),
    ("[x](<java\tscript:alert(1)>)", false),
    ("[x](data:text/html,<script>alert(1)</script>)", false),
    ("[x](vbscript:msgbox)", false),
    ("[x]\n\n[x]: javascript:alert(1)", false),
    ("![x](javascript:alert(1)) ![y](\\\\evil\\share\\a.png) ![z](//evil/z.png) ![w](smb://evil/w.png)", false),
    ("<b style=\"background:url(http://evil/x)\" class=\"tp-img\" data-src=\"x\">styled</b>", false),
    // nested anchors and document-level elements
    ("<a href=\"http://a\"><a href=\"javascript:1\">x</a></a>", false),
    ("<base href=\"http://evil/\">", true),
    ("<meta http-equiv=\"refresh\" content=\"0;url=http://evil\">", true),
    ("<link rel=stylesheet href=http://evil/x.css>", true),
    ("<form action=\"http://evil\"><input type=submit formaction=\"javascript:1\"></form>", true),
    ("<img srcset=\"http://evil/x.png 1x\">", false),
    ("<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>", true),
    ("<object data=\"http://evil/x\"></object><embed src=\"http://evil/y\">", true),
    ("<video poster=\"http://evil/p.png\"></video><table background=\"http://evil/b\"><tr><td background=\"http://evil/c\">c</td></tr></table>", true),
    ("<details open ontoggle=alert(1)><summary onclick=1>s</summary>d</details>", false),
    // historical mXSS
    ("<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;\">", true),
    ("<svg></p><style><a id=\"</style><img src=1 onerror=alert(1)>\">", true),
    ("<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>", true),
    ("<math><mi><table><mi><mglyph><svg><mtext><textarea><path id=\"</textarea><img onerror=alert(1) src=1>\">", true),
    // link targets (brief §4.4, §4.6): inert data, never a live network-path href; attributes allowed tags mustn't keep
    ("<a href=\"file:///C:/x\">f</a> [f](file:///C:/x)", false),
    ("<a href=\"smb://h/s\">s</a> [s](smb://h/s)", false),
    ("<a href=\"//evil\">n</a> [n](//evil)", false),
    ("<a href=\"\\\\evil\\s\">u</a> [u](\\\\\\\\evil\\s)", false),
    ("<a href=\"  //evil\">w</a> [w](<  //evil>)", false),
    ("[[\\\\evil\\share]] [[\\\\\\evil\\share]] [[//evil/share]]", false),
    ("<a href=\"ms-settings:display\">o</a> [o](ms-settings:display)", false),
    ("<a ping=\"http://evil/p\" href=\"https://ok/\">p</a>", false),
    ("<a title=\"t\" target=\"_blank\" rel=\"opener\" href=\"https://ok/\">t</a>", false),
];

/// The first tag in `payload` that isn't on the brief's allowlist, as written (its case kept).
fn first_disallowed(payload: &str) -> Option<&str> {
    const ALLOWED: [&str; 20] = ["b", "i", "em", "strong", "code", "kbd", "sub", "sup", "br", "hr", "details", "summary", "a", "img", "table", "thead", "tbody", "tr", "th", "td"];
    let b = payload.as_bytes();
    (0..b.len()).find_map(|i| {
        let start = i + 1 + usize::from(b.get(i + 1) == Some(&b'/'));
        if b[i] != b'<' || !b.get(start)?.is_ascii_alphabetic() {
            return None;
        }
        let end = (start..b.len()).find(|&j| !b[j].is_ascii_alphanumeric()).unwrap_or(b.len());
        let name = &payload[start..end];
        (!ALLOWED.contains(&name.to_ascii_lowercase().as_str())).then_some(name)
    })
}

/// Brief §4.6: every payload, in every Markdown context, renders to output that passes `check_output` (including
/// idempotence), and a disallowed tag shows as visible escaped text.
#[test]
fn gate_hostile_html_and_mxss() {
    let mut outputs = 0;
    for (payload, literal) in HOSTILE {
        let contexts = [
            format!("intro\n\n{payload}\n"),
            format!("x {payload} y\n"),
            format!("- {payload}\n"),
            format!("> {payload}\n"),
            format!("| a |\n|---|\n| {payload} |\n"),
            format!("# {payload}\n"),
        ];
        for md in contexts {
            let doc = MdDoc::new(ByteStore::open(&temp_file("gate-html", md.as_bytes())).unwrap(), UTF_8, MdConfig::default());
            assert!(doc.index_all(&AtomicBool::new(false)).unwrap());
            let mut html = String::new();
            for b in 0..doc.index().blocks.len() as u64 {
                let items = doc.render(b).unwrap();
                if let Err(e) = check_items(&items) {
                    panic!("{md:?}: {e}\n{:?}", items.iter().map(|i| &i.html).collect::<Vec<_>>());
                }
                outputs += items.len();
                html.extend(items.iter().map(|i| i.html.as_str()));
            }
            if literal && let Some(name) = first_disallowed(payload) {
                assert!(html.contains(&format!("&lt;{name}")), "{md:?}: <{name} isn't literal text in {html:?}");
            }
        }
    }
    println!("sanitizer gate: {} payloads × 6 contexts, {outputs} outputs: all pass", HOSTILE.len());
}
```

- [ ] **Step 2: Run the gates**

Run (`spikes/core`): `cargo test -p spike-core md_gates -- --nocapture`
Expected: `test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 119 filtered out` (about 2 minutes in a debug build), after these three lines:
- `span gate: 10000 cases, 64876 block spans, 15034 heading spans, 56932 sub-block spans, 112016 items checked: 0 mismatches`;
- `byte-map gate: 10000 cases, 110143 runs, 1199556 selection endpoints: 0 mismatches`;
- `sanitizer gate: 71 payloads × 6 contexts, 535 outputs: all pass`.

The cases are seeded, so these counts are exact. A failure here is a Spike C result: record the case it prints, don't loosen the gate.

- [ ] **Step 3: Falsify them**

Each break below is one edit (two for the escape pass). Apply it, run the gate named, and check the failure. Then revert it from `spikes/core` with `git checkout -- spike-core/src/<file>`: the file was committed in Tasks C4a–C4c, so this restores it exactly. The gates write no proptest seeds.

**Break 1: span composition** (window-local offsets used as absolute ones). In `md.rs`, `parse_unit`, replace
<!-- op: temporary spikes/core/spike-core/src/md.rs -->
```rust
    let at = |r: Range<usize>| (src.at(r.start), src.at(r.end));
```
with
```rust
    let at = |r: Range<usize>| (r.start as u64, r.end as u64);
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::gate_span_fidelity -- --exact`
Expected: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 121 filtered out`, after `case 0 (windows-1252, MdConfig { window: 442, piece: 179, max_blocks: 18446744073709551615 }): blocks`, then `got [(0, 35, Paragraph), (37, 64, Paragraph), (65, 69, Rule), (99, 166, Heading), …]` against `want [(0, 29, Paragraph), (31, 50, Paragraph), (51, 55, Rule), (81, 133, Heading), …]`. Revert `md.rs`.

**Break 2: entity mapping** (an event's trailing source, such as an entity's tail, no longer joins its last character). In `mdemit.rs`, the last line of `Emitter::text`: replace
<!-- op: temporary spikes/core/spike-core/src/mdemit.rs -->
```rust
        self.close(b);
```
with
```rust
        self.close(a);
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::gate_byte_maps -- --exact`
Expected: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 121 filtered out`, after `case 1 (UTF-8 malformed), block 0: run "a*b" (want "a*b")`, then `got [(122, 122), (124, 124), (125, 125), (126, 126)]` against `want [(122, 122), (124, 124), (125, 125), (127, 127)]`. Revert `mdemit.rs`.

**Break 3: escape mapping** (unclaimed bytes before a character, such as an escape's `\`, no longer join it). In `mdemit.rs`, `Emitter::element`: replace
<!-- op: temporary spikes/core/spike-core/src/mdemit.rs -->
```rust
        run.1.push((display.encode_utf16().count() as u32, self.cursor, end));
```
with
```rust
        run.1.push((display.encode_utf16().count() as u32, a.max(self.cursor), end));
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::gate_byte_maps -- --exact`
Expected: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 121 filtered out`, after `case 0 (UTF-8 malformed), block 0: runs don't tile (0, 51): [Run { text: "k�Ж B����rr ", …`. Revert `mdemit.rs`.

**Break 4: the escape pass removed** (every complete raw tag goes to ammonia). In `sanitize.rs`, make two replacements. In `escape_raw`, replace
<!-- op: temporary spikes/core/spike-core/src/sanitize.rs -->
```rust
                Some((end, name, attrs)) if RAW_TAGS.contains(&name.as_str()) => {
```
with
```rust
                Some((end, name, attrs)) if !name.is_empty() => {
```
and in `allowed_tag`, replace the body
<!-- op: temporary spikes/core/spike-core/src/sanitize.rs -->
```rust
    matches!(tag_at(s.as_bytes(), 0), Some((end, name)) if end == s.len() && RAW_TAGS.contains(&name.as_str()))
```
with
```rust
    matches!(tag_at(s.as_bytes(), 0), Some((end, _)) if end == s.len())
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::gate_hostile_html_and_mxss -- --exact`
Expected: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 121 filtered out`, after `"intro\n\n<svg><style><img src=x onerror=alert(1)></style></svg>\n": <svg isn't literal text in "<p>intro</p><p><span class=\"tp-img\" data-src=\"x\"></span></p>"`. The output is still safe (ammonia drops the `svg`); the literal-text rule is what fails. Revert `sanitize.rs`.

**Break 5: ammonia allows `style`.** In `sanitize.rs`, replace `.generic_attributes(HashSet::new())` with `.generic_attributes(["style"].into())`:
<!-- op: temporary spikes/core/spike-core/src/sanitize.rs -->
```rust
        .generic_attributes(HashSet::new()) // ammonia's default allows `lang` and `title` everywhere
```
with
```rust
        .generic_attributes(["style"].into()) // ammonia's default allows `lang` and `title` everywhere
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::gate_hostile_html_and_mxss -- --exact`
Expected: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 121 filtered out`, after `"intro\n\n<b style=\"background:url(http://evil/x)\" class=\"tp-img\" data-src=\"x\">styled</b>\n": attribute style on <b>`. Revert `sanitize.rs`.

After the last revert, `cargo test -p spike-core md_gates::gate_hostile_html_and_mxss -- --exact` gives `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 121 filtered out`.

- [ ] **Step 4: Run all core tests**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `test result: ok. 120 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out` (about 2 minutes in a debug build): Task C3c's 87, plus 5 `sanitize`, 9 `mdemit`, 16 `md` and 3 gates. Then `1 passed` for `tests\json_spans.rs`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/md_gates.rs
git commit -m "spike(c): Markdown span, byte-map and sanitizer gates"
```

---

## Task C4e: Measurements — oversized blocks, hostile inputs, cancel latency, throughput

**Files:**
- Modify: `spikes/core/spike-core/src/lib.rs` (`mod md_perf;`, test-only)
- Create: `spikes/core/spike-core/src/md_perf.rs`
- Writes (gitignored): `spikes/.fixtures/md-*.md`, about 960 MB (deleted after Step 3), plus a 1 GiB fixture that the throughput test deletes when it's done. Check that about 2 GB is free first.

**Interfaces:**
- **Consumes:** `md::{Item, MAX_ITEM_UNITS, MAX_PAGE, MdConfig, MdDoc, RAW_NOTE}`, `mdemit::OPTIONS`, `store::ByteStore`, `pulldown_cmark::Parser`.
- **Produces:** four `#[ignore]` tests that print their numbers and assert the gates:
  - `oversized_fence_then_paragraph`: a 5 MB code fence then a one-line paragraph. The paragraph's page renders in < 50 ms at p95 (n = 30), and no item of the fence exceeds `MAX_ITEM_UNITS` or `MAX_PAGE`. A 5 MB raw HTML block becomes bounded Raw pieces.
  - `hostile_inputs_index_in_bounds`: thirteen hostile inputs (100 MB each of `>`, `[`, `*`, `` ` `` and `<`, 400k headings, 400k one-letter paragraphs, 100 × 100k-deep list and quote, one 100 MB paragraph, 1M reference definitions, 1M footnotes, pathological emphasis). Each indexes in < 30 s, its first page renders in < 500 ms, and the index heap stays under its per-block allowance (96 B; 256 B for headings) times blocks, plus 96 B per definition, plus 1 MiB. Each prints its heap per block. It also prints pulldown-cmark's own time on 64 KiB, 1 MiB and 4 MiB prefixes, which shows which inputs are super-linear in pulldown-cmark itself.
  - `hostile_inputs_cancel_within_50ms`: per hostile input, 20 real cancels at random moments before its warm full index time (at most 200 ms in); a run that finishes first is dropped and retried, and fewer than 20 real cancels in 200 runs fails; asserts max ≤ 50 ms.
  - `index_throughput`: ~100 MB (n = 5) and ~1 GiB (n = 3) of realistic Markdown; index time, blocks, headings, heap per block, first screen.

- [ ] **Step 1: Add the measurements**

In `src/lib.rs`, add the module above `pub fn version`:
<!-- op: replace spikes/core/spike-core/src/lib.rs -->
```rust
pub fn version() -> &'static str {
```
```rust
#[cfg(test)]
mod md_perf;

pub fn version() -> &'static str {
```

`spikes/core/spike-core/src/md_perf.rs`:
<!-- op: create spikes/core/spike-core/src/md_perf.rs -->
```rust
//! Spike C's Markdown measurements (spec §13.1): oversized blocks, hostile inputs and their cancel latency,
//! index throughput. All `#[ignore]`; run in release for the numbers (and in debug for cancel latency):
//! `cargo test --release -p spike-core md_perf -- --ignored --nocapture --test-threads 1`
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use encoding_rs::UTF_8;
use pulldown_cmark::Parser;

use crate::md::{Item, MAX_ITEM_UNITS, MAX_PAGE, MdConfig, MdDoc, RAW_NOTE};
use crate::mdemit::OPTIONS;
use crate::store::ByteStore;

/// `spikes/.fixtures/<name>`, written by `write` unless it already exists.
fn fixture(name: &str, write: impl FnOnce(&mut BufWriter<File>)) -> PathBuf {
    let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.fixtures"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    if !path.exists() {
        let tmp = path.with_extension("partial");
        let mut w = BufWriter::with_capacity(1 << 20, File::create(&tmp).unwrap());
        write(&mut w);
        w.flush().unwrap();
        drop(w);
        std::fs::rename(&tmp, &path).unwrap();
    }
    path
}

/// Whole copies of `unit`, at least `total` bytes.
fn repeat(w: &mut BufWriter<File>, unit: &[u8], total: usize) {
    let block = unit.repeat(((1 << 20) / unit.len()).max(1));
    let mut left = total.div_ceil(unit.len()) * unit.len();
    while left > 0 {
        let n = left.min(block.len());
        w.write_all(&block[..n]).unwrap();
        left -= n;
    }
}

fn open(path: &PathBuf) -> MdDoc {
    MdDoc::new(ByteStore::open(path).unwrap(), UTF_8, MdConfig::default())
}

/// p50, p95 and max of `samples`, in milliseconds.
fn stats(mut samples: Vec<Duration>) -> (f64, f64, f64) {
    samples.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1e3;
    (ms(samples[samples.len() / 2]), ms(samples[(samples.len() * 95).div_ceil(100) - 1]), ms(*samples.last().unwrap()))
}

fn assert_bounded(items: &[Item]) -> (usize, usize) {
    let (mut max_units, mut max_html) = (0, 0);
    for it in items {
        let units: usize = it.runs.iter().map(|r| r.map.units() as usize).sum();
        assert!(units <= MAX_ITEM_UNITS && it.html.len() <= MAX_PAGE, "{units} units, {} bytes", it.html.len());
        (max_units, max_html) = (max_units.max(units), max_html.max(it.html.len()));
    }
    (max_units, max_html)
}

/// Spec §13.1: a 5 MB code fence followed by a one-line paragraph renders the paragraph within the first-screen
/// gate (< 50 ms on the PC), and no item exceeds 64 KiB of text. A 5 MB raw-HTML block becomes bounded Raw pieces.
#[test]
#[ignore]
fn oversized_fence_then_paragraph() {
    let fence = fixture("md-fence-5mb.md", |w| {
        w.write_all(b"```rust\n").unwrap();
        repeat(w, b"let value = compute(42); // a line of code\n", 5 << 20);
        w.write_all(b"```\n\nThe paragraph after the fence.\n").unwrap();
    });
    let mut samples = Vec::new();
    for _ in 0..30 {
        let t = Instant::now();
        let items = open(&fence).page((1, 0), 1).unwrap(); // block 1 is the paragraph
        samples.push(t.elapsed());
        assert_eq!(items[0].html, "<p>The paragraph after the fence.</p>");
    }
    let (p50, p95, max) = stats(samples);
    println!("5 MB fence → paragraph rendered, n=30: p50 {p50:.2} ms, p95 {p95:.2} ms, max {max:.2} ms");
    assert!(p95 < 50.0, "first-screen gate: p95 {p95:.2} ms");
    let doc = open(&fence);
    let items = doc.page((0, 0), usize::MAX).unwrap();
    let all: Vec<Item> = (0..2).flat_map(|b| doc.render(b).unwrap()).collect();
    let (units, html) = assert_bounded(&all);
    println!("  fence: {} items, largest {units} UTF-16 units / {html} HTML bytes; first page {} items", all.len() - 1, items.len());

    let raw = fixture("md-html-5mb.md", |w| {
        w.write_all(b"<div>\n").unwrap();
        repeat(w, b"<p>raw <b>html</b> line</p>\n", 5 << 20);
        w.write_all(b"</div>\n\nAfter.\n").unwrap();
    });
    let doc = open(&raw);
    assert!(doc.index_all(&AtomicBool::new(false)).unwrap());
    let items = doc.render(0).unwrap();
    let (units, html) = assert_bounded(&items);
    assert!(items.iter().all(|i| i.note == Some(RAW_NOTE) && i.html.starts_with("<pre class=\"tp-raw\"><code>&lt;")));
    println!("  5 MB raw HTML: {} Raw pieces, largest {units} units / {html} HTML bytes", items.len());
}

type Gen = fn(&mut BufWriter<File>);

/// Spec §13.1 hostile inputs, with how many definitions each holds and the index heap allowed per block. Each one:
/// no panic and no stack overflow, index time and index heap within bounds, a bounded first screen, and cancel
/// within 50 ms of the flag (n = 20). A heading costs its `Block` (24 B), its `Heading` (80 B), its slug and a
/// slug-table entry, so a heading flood gets 256 B per block; everything else 96.
fn hostile() -> Vec<(&'static str, usize, usize, Gen)> {
    vec![
        ("100 MB of >", 0, 96, |w| repeat(w, b">", 100 << 20)),
        ("100 MB of [", 0, 96, |w| repeat(w, b"[", 100 << 20)),
        ("100 MB of *", 0, 96, |w| repeat(w, b"*", 100 << 20)),
        ("100 MB of `", 0, 96, |w| repeat(w, b"`", 100 << 20)),
        ("100 MB of <", 0, 96, |w| repeat(w, b"<", 100 << 20)),
        ("400k headings", 0, 256, |w| repeat(w, b"#\n", 800_000)),
        ("400k one-letter paragraphs", 0, 96, |w| repeat(w, b"a\n\n", 1_200_000)),
        // One 100k-deep block indexes in under a millisecond, too fast to cancel: 100 of them, each its own block.
        ("100 × 100k-deep list", 0, 96, |w| {
            for _ in 0..100 {
                repeat(w, b"- ", 200_000);
                w.write_all(b"x\n\nend\n\n").unwrap();
            }
        }),
        ("100 × 100k-deep quote", 0, 96, |w| {
            for _ in 0..100 {
                repeat(w, b"> ", 200_000);
                w.write_all(b"x\n\nend\n\n").unwrap();
            }
        }),
        ("one 100 MB paragraph", 0, 96, |w| repeat(w, b"lorem ipsum dolor sit amet, consectetur *adipiscing* elit sed do eiusmod\n", 100 << 20)),
        ("1M reference definitions", 1_000_000, 96, |w| {
            for i in 0..1_000_000 {
                writeln!(w, "[ref{i}]: /url/{i} \"title {i}\"").unwrap();
            }
            w.write_all(b"\n[ref999999] and [ref0]\n").unwrap();
        }),
        ("1M footnotes", 1_000_000, 96, |w| {
            for i in 0..1_000_000 {
                writeln!(w, "[^f{i}]: footnote {i}").unwrap();
            }
            w.write_all(b"\nsee[^f0] and[^f999999]\n").unwrap();
        }),
        ("pathological emphasis", 0, 96, |w| {
            w.write_all(b"*a").unwrap();
            repeat(w, b"**a", 100 << 20);
            w.write_all(b"\n").unwrap();
        }),
    ]
}

/// A fixture name per input: punctuation spelled as its code, so `>` and `<` don't share a file.
fn slug(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_string() } else { format!("-{:x}", c as u32) }).collect()
}

/// Release: the full index time, heap and pulldown-cmark's own time on prefixes of the input.
#[test]
#[ignore]
fn hostile_inputs_index_in_bounds() {
    for (name, defs, per_block, write) in hostile() {
        let path = fixture(&format!("md-hostile-{}.md", slug(name)), write);
        let len = std::fs::metadata(&path).unwrap().len();
        let doc = open(&path);
        let t = Instant::now();
        assert!(doc.index_all(&AtomicBool::new(false)).unwrap());
        let index = t.elapsed();
        let (blocks, heap, big) = {
            let idx = doc.index();
            (idx.blocks.len(), idx.heap_bytes(), idx.big.len())
        };
        let t = Instant::now();
        let first = doc.page((0, 0), 50).unwrap();
        let screen = t.elapsed();
        let (units, html) = assert_bounded(&first);
        // pulldown-cmark alone on prefixes: linear time means the ms per MiB stays flat.
        let bytes = std::fs::read(&path).unwrap();
        let per_mib: Vec<String> = [64 << 10, 1 << 20, 4 << 20]
            .iter()
            .filter(|&&n| n <= bytes.len())
            .map(|&n| {
                let text = String::from_utf8_lossy(&bytes[..n]);
                let t = Instant::now();
                let events = Parser::new_ext(&text, OPTIONS).count();
                let ms = t.elapsed().as_secs_f64() * 1e3;
                format!("{} KiB {ms:.1} ms ({:.1} ms/MiB, {events} events)", n >> 10, ms * f64::from(1 << 20) / n as f64)
            })
            .collect();
        println!(
            "{name}: {:.1} MB, index {:.0} ms ({:.0} MB/s), {blocks} blocks ({big} oversized), heap {:.1} MiB = {:.1} B/block; first page {} items in {:.1} ms (max {units} units / {html} B); pulldown: {}",
            len as f64 / 1e6,
            index.as_secs_f64() * 1e3,
            len as f64 / 1e6 / index.as_secs_f64(),
            heap as f64 / f64::from(1 << 20),
            heap as f64 / blocks.max(1) as f64,
            first.len(),
            screen.as_secs_f64() * 1e3,
            per_mib.join("; ")
        );
        assert!(index < Duration::from_secs(30), "{name}: index took {index:?}");
        assert!(screen < Duration::from_millis(500), "{name}: first page took {screen:?}");
        assert!(heap <= per_block * blocks + 96 * defs + (1 << 20), "{name}: index heap {heap} bytes for {blocks} blocks, {defs} definitions");
    }
}

/// Debug and release: cancel latency on every hostile input over 20 real cancels, the flag set at a random moment
/// before the input's warm full index time (at most 200 ms in). A run that finishes before the flag measures
/// nothing: it's dropped and retried, and an input that gives fewer than 20 real cancels in 200 runs fails.
#[test]
#[ignore]
fn hostile_inputs_cancel_within_50ms() {
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    for (name, _, _, write) in hostile() {
        let path = fixture(&format!("md-hostile-{}.md", slug(name)), write);
        let mut index = Duration::ZERO;
        for _ in 0..2 {
            let t = Instant::now(); // the second run is warm
            assert!(open(&path).index_all(&AtomicBool::new(false)).unwrap());
            index = t.elapsed();
        }
        let full = index.min(Duration::from_millis(200));
        let (mut samples, mut runs) = (Vec::new(), 0);
        while samples.len() < 20 {
            runs += 1;
            assert!(runs <= 200, "{name}: {} real cancels in 200 runs (warm full index {index:?})", samples.len());
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let doc = open(&path);
            let cancel = AtomicBool::new(false);
            let delay = Duration::from_nanos(seed % full.as_nanos().max(1) as u64);
            let (latency, finished) = std::thread::scope(|s| {
                let worker = s.spawn(|| doc.index_all(&cancel).unwrap());
                std::thread::sleep(delay);
                let set = Instant::now();
                cancel.store(true, Ordering::Relaxed);
                let finished = worker.join().unwrap();
                (set.elapsed(), finished)
            });
            if !finished {
                samples.push(latency);
            }
        }
        let (p50, p95, max) = stats(samples);
        println!(
            "{name}: warm full index {:.1} ms; cancel n_real=20 of {runs} runs, p50 {p50:.2} ms, p95 {p95:.2} ms, max {max:.2} ms",
            index.as_secs_f64() * 1e3
        );
        assert!(max <= 50.0, "{name}: cancel took {max:.2} ms");
    }
}

/// A realistic mix: headings, paragraphs with emphasis, links and entities, lists, fences, tables.
fn realistic(w: &mut BufWriter<File>, total: usize) {
    let mut written = 0;
    let mut i = 0usize;
    while written < total {
        let chunk = format!(
            "## Section {i}\n\nSome *emphasis*, **strong** text, a [link](https://example.com/{i}) and `code` &amp; an entity.\nA second line with ~~strike~~ and a footnote[^n{i}] in the paragraph.\n\n- item one\n- item two with [a ref][r{i}]\n  continued\n- [x] done\n\n```rust\nfn f{i}() -> u32 {{\n    {i}\n}}\n```\n\n| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n> A quote with *emphasis*.\n\n[r{i}]: https://example.com/r/{i}\n[^n{i}]: Footnote {i}.\n\n"
        );
        w.write_all(chunk.as_bytes()).unwrap();
        written += chunk.len();
        i += 1;
    }
}

/// Informational (no spec budget): block index throughput on ~100 MB and ~1 GiB of realistic Markdown, and index
/// memory per block. Deletes the 1 GiB fixture afterwards.
#[test]
#[ignore]
fn index_throughput() {
    for (name, size, runs) in [("md-real-100mb.md", 100usize << 20, 5), ("md-real-1gib.md", 1 << 30, 3)] {
        let path = fixture(name, |w| realistic(w, size));
        let len = std::fs::metadata(&path).unwrap().len();
        let mut samples = Vec::new();
        let mut last = (0, 0, 0);
        for _ in 0..runs {
            let doc = open(&path);
            let t = Instant::now();
            assert!(doc.index_all(&AtomicBool::new(false)).unwrap());
            samples.push(t.elapsed());
            let idx = doc.index();
            last = (idx.blocks.len(), idx.headings.len(), idx.heap_bytes());
        }
        let (p50, _, max) = stats(samples);
        let t = Instant::now();
        let first = open(&path).first_screen(50).unwrap();
        let screen = t.elapsed();
        println!(
            "{name}: {:.0} MB, index n={runs} p50 {p50:.0} ms ({:.3} GB/s), max {max:.0} ms; {} blocks, {} headings, heap {:.1} MiB = {:.1} B/block; first screen {} items in {:.2} ms",
            len as f64 / 1e6,
            len as f64 / 1e9 / (p50 / 1e3),
            last.0,
            last.1,
            last.2 as f64 / f64::from(1 << 20),
            last.2 as f64 / last.0 as f64,
            first.len(),
            screen.as_secs_f64() * 1e3
        );
        if size == 1 << 30 {
            std::fs::remove_file(&path).unwrap();
        }
    }
}
```

- [ ] **Step 2: Run the release measurements**

Run (`spikes/core`): `cargo test --release -p spike-core md_perf -- --ignored --nocapture --test-threads 1`
Expected: `test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 122 filtered out` (about 90 s, plus fixture writing on the first run). Each test prints its numbers. The gates it asserts:
- oversized p95 < 50 ms;
- per hostile input: index < 30 s, first page < 500 ms, heap ≤ its per-block allowance (96 B; 256 B for headings) × blocks + 96 B per definition + 1 MiB;
- cancel max ≤ 50 ms, over 20 real cancels per input.

A failure is a Spike C result: record the line, don't loosen the bound. For comparison, the fix lane's run of this code, on Windows 11 with another lane's builds running:
- `5 MB fence → paragraph rendered, n=30: p50 4.62 ms, p95 10.59 ms, max 15.81 ms`, `fence: 160 items, largest 32766 UTF-16 units / 32807 HTML bytes; first page 7 items`, `5 MB raw HTML: 161 Raw pieces, largest 32766 units / 60891 HTML bytes`.
- Hostile inputs: index at most 1,362 ms each, heap at most `83.1 MiB` (`1M footnotes`, `1000001 blocks`). Heap per block: `194.3 B/block` for `400k headings`, `41.9 B/block` for `400k one-letter paragraphs`, `87.1 B/block` for `1M footnotes` (a one-block input's figure is its whole heap). pulldown-cmark's own time stays flat per MiB except on `1M footnotes`: `33.7`, `450.2`, `1872.5 ms/MiB` on 64 KiB, 1 MiB and 4 MiB prefixes. That is quadratic inside pulldown-cmark, and the 64 KiB windows bound it.
- Cancel: every input reached `n_real=20` within 25 runs; max `6.55 ms` (`1M reference definitions`) over all thirteen inputs.
- `md-real-100mb.md: 105 MB, index n=5 p50 1818 ms (0.058 GB/s)`, `heap 104.1 MiB = 68.2 B/block`; `md-real-1gib.md: 1074 MB, index n=3 p50 21414 ms (0.050 GB/s)`, `heap 1023.6 MiB = 66.9 B/block`; first screen under 7 ms on both. The 1 GiB fixture is deleted afterwards.

- [ ] **Step 3: Run cancel latency in a debug build**

Run (`spikes/core`): `cargo test -p spike-core md_perf::hostile_inputs_cancel -- --ignored --nocapture --test-threads 1`
Expected: `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 125 filtered out` (about 40 s in the scratch run, which lacked Task C1d's debug-build opt-level for `memchr` and `xxhash-rust`; 67 s in the replay). Each input prints `warm full index …; cancel n_real=20 of {runs} runs, p50 …, p95 …, max …`. In the fix lane's debug runs of this code, the largest max was `15.10 ms` (`400k one-letter paragraphs`), and `23.36 ms` across its three debug runs since the window-internal cancel check (fix 17); before it, `400k headings` failed this step at `54.95 ms`. In this plan's replay the largest max was `23.98 ms` (`400k one-letter paragraphs`); an earlier run of this step in the same replay, with other lanes holding the CPU near 98%, failed at `52.02 ms` on that input and passed on its rerun (largest max `30.57 ms`). The bound is load-sensitive in a debug build.

Delete the Markdown fixtures (≈ 960 MB). Git Bash: `rm ../.fixtures/md-*.md`. PowerShell: `Remove-Item ../.fixtures/md-*.md`.

- [ ] **Step 4: Run all core tests**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `test result: ok. 120 passed; 0 failed; 6 ignored; 0 measured; 0 filtered out`, then `1 passed` for `tests\json_spans.rs`. The four measurements are ignored outside Steps 2 and 3.

- [ ] **Step 5: Read your own work (rule 8), then commit**

Record the printed lines from Steps 2 and 3 in the Spike C report.
```bash
git add spikes/core/spike-core/src/lib.rs spikes/core/spike-core/src/md_perf.rs
git commit -m "spike(c): Markdown oversized, hostile-input, cancel and throughput measurements"
```

---

## Task C5a1: A YAML tree with exact source byte spans (the span gate)

**What Tasks C5a1–C5a7 prove (spec §13.1 Spike C):**
- YAML in a renderer Web Worker yields an exact source byte span for every key, scalar, comment, anchor, alias and explicit tag: **zero mismatches across 10,000 generated cases** (spec §3.2, §4.5), and a one-line break in the UTF-16→byte table fails the gate.
- Hostile YAML (alias bomb, 100k-deep nesting, a 50 MiB scalar, 1M anchors, 1M tags, the densest 8 MiB) parses or fails with a reported error, leaves the renderer alive, and **cancels in ≤ 50 ms** as the UI sees it. An out-of-memory in the worker does kill the renderer (measured at 128 MiB), so the size ceiling is also the memory bound.
- KaTeX runs in a worker with `trust: false`, `maxExpand: 1000`, `maxSize: 20`, `throwOnError: false`; its output passes DOMPurify before the DOM sees it. Turning `trust` on, or dropping DOMPurify, fails a test.
- Mermaid runs lazily at `securityLevel: 'sandbox'`; every diagram type Mermaid 12.2.0 registers is fed hostile text. The CSP gains `frame-src data:` and nothing else.
- **Zero effects:** one run renders every hostile Mermaid, KaTeX and YAML fixture with every detector on — the NetLog assertion, a main-process request counter, Node network/process tripwires and an fs recorder in main and the core host, and a process diff — and finds nothing. Each detector is shown failing on a deliberate effect.
- **Output:** the YAML worker's throughput, which sets `yaml.treeMaxBytes`.

**Constraints for Tasks C5a1–C5a7 (on top of the plan's):**
- Every Electron launch goes through `e2e/launch.ts`: a fresh private `--user-data-dir` under `spikes/.fixtures/profiles/`, no inherited `TYPOSE_*` variables, and an assertion that the page zoom is 1. All spikes run as `spike-app`, and Chromium persists per-host zoom in the shared `%APPDATA%\spike-app`.
- Pinned versions (npm, verified 2026-10-20): `yaml` 2.9.1, `katex` 0.19.0, `dompurify` 3.4.17, `mermaid` 12.2.0. Mermaid brings its own `katex` 0.18.10 (for `$$…$$` labels); there is one `dompurify`.
- Hostile fixtures name only `.invalid` hosts (which never resolve) and loopback port 9 (an unsafe port Chromium refuses). Nothing leaves the machine even when a guard is off.
- `TYPOSE_EFFECTS` and `TYPOSE_FALSIFY` are test-only switches read by main and the core host; Task C5a5 adds them.
- They touch nothing in `spikes/core`. Task C5b reuses Task C5a5's harness (`e2e/effects.ts`) for hostile Markdown.

**Files:**
- Modify: `spikes/app/package.json`, `spikes/app/package-lock.json` (npm writes both)
- Create: `spikes/app/src/renderer/src/yaml/gen.ts`, `spikes/app/src/renderer/src/yaml/tree.test.ts`, `spikes/app/src/renderer/src/yaml/tree.ts`

**Interfaces:**
- **Consumes:** `yaml` 2.9.1: `Parser` (CST with offsets), `Composer` (Documents with UTF-16 `range`s), `isAlias/isMap/isPair/isScalar/isSeq`.
- **Produces (`tree.ts`):**
  - `KIND = { doc: 0, map: 1, seq: 2, pair: 3, scalar: 4, alias: 5 }`; `DUP_KEY = 1`; `SCALAR_TYPE = { str: 0, num: 1, bool: 2, null: 3 }` (in `flags` bits 1–2); `MAX_ALIAS_DEPTH = 16`.
  - `interface YamlTree` — columnar, so it crosses from the worker as transferred buffers: `bytes: Uint8Array` (the file); per node `kind: Uint8Array`, `flags: Uint8Array`, `parent: Int32Array`, `start/end: Float64Array` (byte span, end-exclusive, exact up to 2^53), `kidStart/kidCount: Int32Array` into `kids: Int32Array`, `ref: Int32Array` (an alias's anchored node, else −1); props `propNode: Int32Array` (ascending), `propIsTag: Uint8Array`, `propStart/propEnd: Float64Array`; `commentStart/commentEnd: Float64Array`; `docs: Int32Array`; `errors: YamlError[]` (`{ code, message, start, end }`, byte spans); `parseMs: number`.
  - `byteTable(text: string): (u: number) => number` — UTF-16 offset → UTF-8 byte offset.
  - `buildTree(bytes: Uint8Array): YamlTree` — throws on malformed UTF-8.
  - `nodeProps(tree, node): { anchor?: [number, number]; tag?: [number, number] }`.
  - `aliasTarget(tree, node, depth): number` — the anchored node to show under an alias reached through `depth` aliases, or −1 at `MAX_ALIAS_DEPTH`.
  - `transferables(tree): ArrayBuffer[]`.
- **Produces (`gen.ts`, test-only):** `type Span = [number, number]`; `interface OracleNode { kind: 'scalar' | 'alias' | 'map' | 'seq'; role: 'key' | 'value'; span?; anchor?; tag?; target? }`; `interface Case { bytes: Uint8Array; nodes: OracleNode[]; comments: Span[] }`; `genCase(seed: number): Case`.

**Design notes:**
- **The oracle is the generator, never the parser.** `genCase` writes random YAML piece by piece and records the byte range of each piece from `TextEncoder` lengths. It covers BOMs, CRLF, multi-byte and astral UTF-8 (`é`, `中文`, `😀`), block and flow collections, plain/single/double-quoted and block scalars, anchors, aliases, explicit tags (`!t`, `!Ref`, `!!str`) and full-line and trailing comments, in multi-document streams. Across seeds 1–10,000 that is 220,797 oracle nodes, 36,265 anchors, 14,620 aliases, 27,179 tags, 35,916 comments, 1,987 BOM cases, 3,028 CRLF cases, 4,705 multi-document cases and 8,188 cases with astral characters.
- **The comparison is strict:** the tree's nodes in pre-order (docs and pairs skipped) must match the oracle's one for one — kind, key/value role, span (scalars, aliases, flow collections), anchor span, tag span and, for aliases, the anchor token they resolve to — and the comment spans must match in order.
- **Spans:** node ranges come from the Composer; comments, anchors and tags from the CST (an iterative walk: nesting depth is file-controlled). Anchor and tag tokens pair with nodes in pre-order, which is source order. Every UTF-16 offset maps to bytes through `byteTable`, built once in a pass over the decoded text: runs of equal bytes-per-unit (1, 2, 3, or 2 per unit in a surrogate pair).
- **yaml 2.9.1 bug, worked around:** a BOM followed by a block sequence (`"\uFEFF- a"`) parses as `[null]` with "Unexpected scalar at node end". `buildTree` parses without the BOM and shifts every span by its 3 bytes. The span gate found this.
- **Aliases are never materialized.** An alias node stores a pointer to its anchored node (`ref`); the UI expands it on demand, and `aliasTarget` stops at `MAX_ALIAS_DEPTH`. `toJS` is never called, so `yaml`'s `maxAliasCount` (default 100, a `toJS` option) never comes into play; the bound is the pointer plus the depth limit.
- **Text stays bytes.** Values are verbatim by construction: the caller slices `bytes` by span.

- [ ] **Step 1: Add the dependency**

Run (`spikes/app`): `npm install --save-exact yaml@2.9.1`
Expected: `spikes/app/package.json` gains `"yaml": "2.9.1"` under `dependencies` (npm also reflows the `build.files` and `build.asarUnpack` arrays onto several lines).

- [ ] **Step 2: Write the generator and the failing tests**

`spikes/app/src/renderer/src/yaml/gen.ts`:
<!-- op: create spikes/app/src/renderer/src/yaml/gen.ts -->
```ts
// Span-gate generator (test-only). It writes random YAML and records the byte range of everything it writes.
// That record is the gate's oracle: it comes from TextEncoder lengths of the generator's own output, never from the parser.

export type Span = [number, number]
export interface OracleNode {
  kind: 'scalar' | 'alias' | 'map' | 'seq'
  role: 'key' | 'value'
  span?: Span // scalars, aliases and flow collections; block collections have no exact span to check
  anchor?: Span
  tag?: Span
  target?: Span // an alias: the anchor token it refers to
}
export interface Case {
  bytes: Uint8Array
  nodes: OracleNode[] // pre-order, the way the tree numbers its nodes
  comments: Span[]
}

const enc = new TextEncoder()
const WORDS = ['alpha', 'beta', 'é', 'naïve', '中文', 'emoji😀', 'x1', '3.14', 'true', 'null', '42', 'Ωmega', 'ß']
const TAGS = ['!t', '!Ref', '!!str']

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function genCase(seed: number): Case {
  const r = rng(seed)
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
  const nl = r() < 0.3 ? '\r\n' : '\n'
  const parts: string[] = []
  let pos = 0
  const put = (s: string): Span => {
    const start = pos
    parts.push(s)
    pos += enc.encode(s).length
    return [start, pos]
  }
  const nodes: OracleNode[] = []
  const comments: Span[] = []
  let anchors: { name: string; span: Span }[] = []
  let nextAnchor = 0
  const words = (): string => Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(WORDS)).join(' ')
  const trailingComment = (): void => {
    if (r() < 0.2) {
      put(' ')
      comments.push(put('# ' + words()))
    }
  }
  const commentLine = (indent: number): void => {
    put(' '.repeat(indent))
    comments.push(put('# ' + words()))
    put(nl)
  }
  /** Writes an anchor and/or a tag (each followed by a space) onto `node`, sometimes neither. */
  const props = (node: OracleNode, allowStrTag: boolean): void => {
    const anchorFirst = r() < 0.5
    const anchor = (): void => {
      if (r() >= 0.2) return
      const name = (r() < 0.3 ? 'é' : 'n') + nextAnchor++
      node.anchor = put('&' + name)
      put(' ')
      anchors.push({ name, span: node.anchor })
    }
    const tag = (): void => {
      if (r() >= 0.15) return
      node.tag = put(allowStrTag ? pick(TAGS) : pick(TAGS.slice(0, 2)))
      put(' ')
    }
    if (anchorFirst) {
      anchor()
      tag()
    } else {
      tag()
      anchor()
    }
  }
  /** A flow-safe scalar (plain, single- or double-quoted), with props. */
  const flowScalar = (role: 'key' | 'value'): void => {
    const node: OracleNode = { kind: 'scalar', role }
    nodes.push(node)
    props(node, true)
    const style = r()
    if (style < 0.5) node.span = put(words())
    else if (style < 0.75) node.span = put(`'${words()}''s'`)
    else node.span = put(`"${words()} \\"q\\" \\\\ \\t \\u00e9 \\x41 ${pick(WORDS)}"`)
  }
  const alias = (): void => {
    const a = pick(anchors)
    nodes.push({ kind: 'alias', role: 'value', span: put('*' + a.name), target: a.span })
  }
  const flowCollection = (depth: number): void => {
    const isMap = r() < 0.5
    const node: OracleNode = { kind: isMap ? 'map' : 'seq', role: 'value' }
    nodes.push(node)
    props(node, false)
    const start = put(isMap ? '{' : '[')[0]
    const n = 1 + Math.floor(r() * 3)
    for (let i = 0; i < n; i++) {
      if (i) put(', ')
      if (isMap) {
        flowScalar('key')
        put(': ')
      }
      const k = r()
      if (k < 0.2 && anchors.length) alias()
      else if (k < 0.35 && depth < 3) flowCollection(depth + 1)
      else flowScalar('value')
    }
    node.span = [start, put(isMap ? '}' : ']')[1]]
  }
  /** A value after `key:` or `- ` (the caller wrote that indicator, no trailing space). */
  const blockValue = (indent: number, depth: number): void => {
    const k = r()
    if (k < 0.15 && anchors.length) {
      put(' ')
      alias()
      trailingComment()
      put(nl)
    } else if (k < 0.3 && depth < 4) {
      blockCollection(indent + 2, depth + 1, true)
    } else if (k < 0.45) {
      put(' ')
      flowCollection(0)
      trailingComment()
      put(nl)
    } else if (k < 0.6) {
      put(' ')
      const node: OracleNode = { kind: 'scalar', role: 'value' }
      nodes.push(node)
      props(node, true)
      const start = put(pick(['|', '|-', '>', '>-']))[0]
      trailingComment()
      put(nl)
      const lines = 1 + Math.floor(r() * 3)
      for (let i = 0; i < lines; i++) put(' '.repeat(indent + 2) + words() + nl)
      node.span = [start, pos]
    } else {
      put(' ')
      flowScalar('value')
      trailingComment()
      put(nl)
    }
  }
  /** A block map or sequence at `indent`; `nested` means the caller is mid-line after `key:` or `-`. */
  const blockCollection = (indent: number, depth: number, nested: boolean): void => {
    const isMap = r() < 0.6
    const node: OracleNode = { kind: isMap ? 'map' : 'seq', role: 'value' }
    nodes.push(node)
    if (nested) {
      if (r() < 0.3) {
        put(' ')
        props(node, false)
      }
      trailingComment()
      put(nl)
    } else if (r() < 0.3) {
      props(node, false)
      put(nl)
    }
    const n = 1 + Math.floor(r() * 4)
    for (let i = 0; i < n; i++) {
      if (r() < 0.15) commentLine(indent)
      put(' '.repeat(indent))
      if (isMap) {
        flowScalar('key')
        put(':')
      } else {
        put('-')
      }
      blockValue(indent, depth)
    }
  }

  if (r() < 0.2) put('\uFEFF')
  const docs = 1 + Math.floor(r() * 3)
  for (let d = 0; d < docs; d++) {
    anchors = []
    if (r() < 0.3) commentLine(0)
    if (r() < 0.15) {
      put('--- ')
      flowScalar('value')
      put(nl)
    } else {
      if (d > 0 || r() < 0.3) put('---' + nl)
      blockCollection(0, 0, false)
    }
    if (r() < 0.2) put('...' + nl)
  }
  return { bytes: enc.encode(parts.join('')), nodes, comments }
}
```
`spikes/app/src/renderer/src/yaml/tree.test.ts`:
<!-- op: create spikes/app/src/renderer/src/yaml/tree.test.ts -->
```ts
import { describe, expect, it } from 'vitest'
import { genCase, type OracleNode, type Span } from './gen'
import { KIND, MAX_ALIAS_DEPTH, aliasTarget, buildTree, nodeProps, type YamlTree } from './tree'

const enc = new TextEncoder()
const text = (t: YamlTree, s: number, e: number): string => new TextDecoder().decode(t.bytes.subarray(s, e))

/** The tree's nodes in the oracle's shape: pre-order, docs and pairs skipped. */
function observed(t: YamlTree): OracleNode[] {
  const out: OracleNode[] = []
  for (let id = 0; id < t.kind.length; id++) {
    const k = t.kind[id]
    if (k === KIND.doc || k === KIND.pair) continue
    const p = t.parent[id]
    const role = p >= 0 && t.kind[p] === KIND.pair && t.kids[t.kidStart[p]] === id ? 'key' : 'value'
    const kind = k === KIND.scalar ? 'scalar' : k === KIND.alias ? 'alias' : k === KIND.map ? 'map' : 'seq'
    const node: OracleNode = { kind, role, span: [t.start[id], t.end[id]] }
    const { anchor, tag } = nodeProps(t, id)
    if (anchor) node.anchor = anchor
    if (tag) node.tag = tag
    if (k === KIND.alias) {
      const target = aliasTarget(t, id, 0)
      if (target >= 0) node.target = nodeProps(t, target).anchor
    }
    out.push(node)
  }
  return out
}

const same = (a?: Span, b?: Span): boolean => (a === undefined ? b === undefined : b !== undefined && a[0] === b[0] && a[1] === b[1])

/** Mismatching entries between the oracle and the tree: nodes (kind, role, span, anchor, tag, alias target) and comments. */
function mismatches(seed: number): string[] {
  const c = genCase(seed)
  const t = buildTree(c.bytes)
  const got = observed(t)
  const bad: string[] = []
  if (t.errors.length) bad.push(`seed ${seed}: parse errors ${JSON.stringify(t.errors.slice(0, 2))}`)
  for (let i = 0; i < Math.max(c.nodes.length, got.length); i++) {
    const want = c.nodes[i]
    const have = got[i]
    const ok =
      want &&
      have &&
      want.kind === have.kind &&
      want.role === have.role &&
      (want.span === undefined || same(want.span, have.span)) &&
      same(want.anchor, have.anchor) &&
      same(want.tag, have.tag) &&
      same(want.target, have.target)
    if (!ok) bad.push(`seed ${seed} node ${i}: want ${JSON.stringify(want)} got ${JSON.stringify(have)}`)
  }
  const gotComments = Array.from(t.commentStart, (s, i): Span => [s, t.commentEnd[i]])
  for (let i = 0; i < Math.max(c.comments.length, gotComments.length); i++)
    if (!same(c.comments[i], gotComments[i]))
      bad.push(`seed ${seed} comment ${i}: want ${JSON.stringify(c.comments[i])} got ${JSON.stringify(gotComments[i])}`)
  return bad
}

describe('YAML tree spans (spec §3.2, §13.1 span gate)', () => {
  it('has zero mismatches against the generator oracle across 10,000 cases', () => {
    const bad: string[] = []
    let nodes = 0
    for (let seed = 1; seed <= 10_000; seed++) {
      bad.push(...mismatches(seed))
      nodes += genCase(seed).nodes.length
    }
    console.log(`span gate: 10000 cases, ${nodes} oracle nodes, ${bad.length} mismatches`)
    expect(bad.slice(0, 5)).toEqual([])
  }, 120_000)

  it('keeps scalars verbatim and maps BOM, CRLF and 4-byte characters to source bytes', () => {
    const src = '\uFEFFk😀: 0x1F # é\r\nv: [1e400, "a\\u00e9"]\r\n'
    const t = buildTree(enc.encode(src))
    const scalars = [...t.kind.keys()].filter((id) => t.kind[id] === KIND.scalar)
    expect(scalars.map((id) => text(t, t.start[id], t.end[id]))).toEqual(['k😀', '0x1F', 'v', '1e400', '"a\\u00e9"'])
    expect(t.start[scalars[0]]).toBe(3) // after the 3-byte BOM
    expect(text(t, t.commentStart[0], t.commentEnd[0])).toBe('# é')
  })

  it('flags duplicate keys and multi-document files show each document', () => {
    const t = buildTree(enc.encode('a: 1\n"a": 2\n---\nb: 3\n'))
    expect(t.docs.length).toBe(2)
    const pairs = [...t.kind.keys()].filter((id) => t.kind[id] === KIND.pair)
    expect(pairs.map((id) => t.flags[id] & 1)).toEqual([0, 1, 0])
  })
})

describe('YAML aliases (brief §5.5)', () => {
  it('never materializes an alias bomb and expands on demand only to a bounded depth', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
    for (let i = 1; i < 30; i++) lines.push(`${String.fromCharCode(97 + (i % 26))}${i}: &a${i} [${Array(10).fill(i === 1 ? '*a' : `*a${i - 1}`).join(', ')}]`)
    const t = buildTree(enc.encode(lines.join('\n')))
    expect(t.kind.length).toBeLessThan(1_000) // 10^30 nodes if materialized
    const alias = t.kind.indexOf(KIND.alias)
    expect(aliasTarget(t, alias, 0)).toBeGreaterThanOrEqual(0)
    expect(aliasTarget(t, alias, MAX_ALIAS_DEPTH)).toBe(-1)
  })

  it('a recursive alias points at its own ancestor instead of looping', () => {
    const t = buildTree(enc.encode('&r [*r]\n'))
    const alias = t.kind.indexOf(KIND.alias)
    expect(aliasTarget(t, alias, 0)).toBe(t.parent[alias])
  })
})

describe('YAML errors', () => {
  it('reports parse errors with byte spans', () => {
    const t = buildTree(enc.encode('é: [unclosed\n'))
    expect(t.errors.length).toBeGreaterThan(0)
    expect(t.errors[0].start).toBeGreaterThanOrEqual(0)
  })

  it('rejects malformed UTF-8 instead of guessing offsets', () => {
    expect(() => buildTree(new Uint8Array([0x61, 0x3a, 0x20, 0xff, 0x0a]))).toThrow()
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run (`spikes/app`): `npx vitest run src/renderer/src/yaml`
Expected: FAIL, `Error: Cannot find module './tree' imported from …/tree.test.ts`.

- [ ] **Step 4: Implement the tree**

`spikes/app/src/renderer/src/yaml/tree.ts`:
<!-- op: create spikes/app/src/renderer/src/yaml/tree.ts -->
```ts
// YAML Tree data for the renderer's YAML worker (spec §4.5, brief §5.5).
// One parse, no materialization: an alias is a pointer to its anchored node, expanded on demand to a bounded depth.
// Every span is [start, end) in the original file's bytes (spec §3.2), from a UTF-16→byte table built here.
// Text is never copied out: the caller slices the returned bytes by span, so values are verbatim by construction.
import { Composer, Parser, isAlias, isMap, isPair, isScalar, isSeq } from 'yaml'
import type { Document, Node as YNode, Pair } from 'yaml'

export const KIND = { doc: 0, map: 1, seq: 2, pair: 3, scalar: 4, alias: 5 } as const
/** flags: bit 0 = a pair whose key repeats an earlier key of its map; bits 1–2 = scalar type. */
export const DUP_KEY = 1
export const SCALAR_TYPE = { str: 0, num: 1, bool: 2, null: 3 } as const
export const MAX_ALIAS_DEPTH = 16

export interface YamlError {
  code: string
  message: string
  start: number
  end: number
}

/** Columnar, so the whole tree crosses from the worker as transferred buffers: no per-node structured clone. */
export interface YamlTree {
  bytes: Uint8Array
  kind: Uint8Array
  flags: Uint8Array
  parent: Int32Array
  start: Float64Array // byte offsets: exact as JS numbers up to 2^53
  end: Float64Array
  kidStart: Int32Array
  kidCount: Int32Array
  kids: Int32Array
  ref: Int32Array // an alias's anchored node, else -1
  propNode: Int32Array // anchors and explicit tags, ascending by node
  propIsTag: Uint8Array
  propStart: Float64Array
  propEnd: Float64Array
  commentStart: Float64Array
  commentEnd: Float64Array
  docs: Int32Array
  errors: YamlError[]
  parseMs: number
}

/** UTF-16 offset → byte offset for UTF-8 text: runs of equal bytes-per-unit (1, 2, 3; 2 per unit in surrogate pairs). */
export function byteTable(text: string): (u: number) => number {
  const runUnit: number[] = []
  const runByte: number[] = []
  const runWidth: number[] = []
  let width = 0
  let byte = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xe000 ? 2 : 3
    if (w !== width) {
      runUnit.push(i)
      runByte.push(byte)
      runWidth.push(w)
      width = w
    }
    byte += w
  }
  const total = byte
  return (u) => {
    if (u >= text.length) return total
    let lo = 0
    let hi = runUnit.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (runUnit[mid] <= u) lo = mid
      else hi = mid - 1
    }
    return runUnit.length ? runByte[lo] + (u - runUnit[lo]) * runWidth[lo] : u
  }
}

interface SrcToken {
  type?: string
  offset: number
  source: string
}
const CST_CHILDREN = ['start', 'sep', 'end', 'items', 'key', 'value', 'props'] as const

/** Comment, anchor and tag tokens anywhere in a CST document. Iterative: nesting depth is file-controlled. */
function collectTokens(cst: object, comments: SrcToken[], anchors: SrcToken[], tags: SrcToken[]): void {
  const stack: unknown[] = [cst]
  while (stack.length) {
    const t = stack.pop() as Record<string, unknown> | unknown[]
    if (Array.isArray(t)) {
      for (const x of t) if (x && typeof x === 'object') stack.push(x)
      continue
    }
    const type = t.type
    if (type === 'comment') comments.push(t as unknown as SrcToken)
    else if (type === 'anchor') anchors.push(t as unknown as SrcToken)
    else if (type === 'tag') tags.push(t as unknown as SrcToken)
    for (const key of CST_CHILDREN) {
      const v = t[key]
      if (v && typeof v === 'object') stack.push(v)
    }
  }
}

const byOffset = (a: SrcToken, b: SrcToken): number => a.offset - b.offset

export function buildTree(bytes: Uint8Array): YamlTree {
  const t0 = performance.now()
  // ponytail: UTF-8 (with or without BOM) only; malformed input throws and Tree stays locked. UTF-16 YAML needs a uniform map here.
  // yaml 2.9.1 mis-parses a BOM followed by a block sequence ("\uFEFF- a" → [null] + error), so parse
  // without the BOM and shift every span by its 3 bytes.
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom))
  const table = byteTable(text)
  const at = (u: number): number => bom + table(u)
  const comments: SrcToken[] = []
  const anchorTokens: SrcToken[] = []
  const tagTokens: SrcToken[] = []
  const documents: Document.Parsed[] = []
  const composer = new Composer({ uniqueKeys: false })
  for (const cst of new Parser().parse(text)) {
    collectTokens(cst, comments, anchorTokens, tagTokens)
    documents.push(...(composer.next(cst) as Iterable<Document.Parsed>))
  }
  documents.push(...(composer.end() as Iterable<Document.Parsed>))
  comments.sort(byOffset)
  anchorTokens.sort(byOffset)
  tagTokens.sort(byOffset)

  const kind: number[] = []
  const flags: number[] = []
  const parent: number[] = []
  const start: number[] = []
  const end: number[] = []
  const kidStart: number[] = []
  const kidCount: number[] = []
  const kids: number[] = []
  const ref: number[] = []
  const propNode: number[] = []
  const propIsTag: number[] = []
  const propStart: number[] = []
  const propEnd: number[] = []
  const docs: number[] = []
  const errors: YamlError[] = []
  let nextAnchor = 0
  let nextTag = 0

  for (const doc of documents) {
    for (const e of doc.errors) errors.push({ code: e.code, message: e.message, start: at(e.pos[0]), end: at(e.pos[1]) })
    const anchorIds = new Map<string, number>() // the latest definition wins, as in YAML
    const dupPairs = new Set<Pair>()
    // Pre-order, so node ids follow source order and so do the anchor and tag tokens that belong to them.
    const stack: { n: YNode | Pair | Document.Parsed; parent: number; slot: number }[] = [{ n: doc, parent: -1, slot: -1 }]
    while (stack.length) {
      const { n, parent: p, slot } = stack.pop()!
      const id = kind.length
      if (slot >= 0) kids[slot] = id
      let k: number
      let f = 0
      let range: [number, number]
      let children: (YNode | Pair)[] = []
      let target = -1
      if (n === doc) {
        k = KIND.doc
        range = [doc.range[0], doc.range[1]]
        if (doc.contents) children = [doc.contents]
        docs.push(id)
      } else if (isPair(n)) {
        k = KIND.pair
        const key = n.key as YNode | null
        const value = n.value as YNode | null
        range = [(key ?? value)!.range![0], (value ?? key)!.range![1]]
        children = [key, value].filter((c): c is YNode => c !== null)
        if (dupPairs.has(n)) f |= DUP_KEY
      } else {
        const node = n as YNode
        range = [node.range![0], node.range![1]]
        if (isScalar(node)) {
          k = KIND.scalar
          const v = node.value
          const type =
            typeof v === 'number' || typeof v === 'bigint' ? SCALAR_TYPE.num : typeof v === 'boolean' ? SCALAR_TYPE.bool : v === null ? SCALAR_TYPE.null : SCALAR_TYPE.str
          f |= type << 1
        } else if (isAlias(node)) {
          k = KIND.alias
          target = anchorIds.get(node.source) ?? -1
        } else if (isMap(node)) {
          k = KIND.map
          children = node.items
          const seen = new Set<string>()
          for (const pair of node.items) {
            const key = pair.key as YNode | null
            const ident = isScalar(key) ? `${typeof key.value}:${String(key.value)}` : key ? text.slice(key.range![0], key.range![1]) : ''
            if (seen.has(ident)) dupPairs.add(pair)
            seen.add(ident)
          }
        } else if (isSeq(node)) {
          k = KIND.seq
          children = node.items as YNode[]
        } else {
          throw new Error('unexpected YAML node')
        }
        if (node.anchor) {
          // Resync by name: an anchor token on an error path has no node and must not shift the rest.
          while (nextAnchor < anchorTokens.length && anchorTokens[nextAnchor].source !== '&' + node.anchor) nextAnchor++
          const tok = anchorTokens[nextAnchor++]
          if (tok) {
            propNode.push(id)
            propIsTag.push(0)
            propStart.push(at(tok.offset))
            propEnd.push(at(tok.offset + tok.source.length))
          }
          anchorIds.set(node.anchor, id)
        }
        if (node.tag) {
          // ponytail: tags pair with tag tokens by order; a tag token on an error path shifts later tag spans.
          const tok = tagTokens[nextTag++]
          if (tok) {
            propNode.push(id)
            propIsTag.push(1)
            propStart.push(at(tok.offset))
            propEnd.push(at(tok.offset + tok.source.length))
          }
        }
      }
      kind.push(k)
      flags.push(f)
      parent.push(p)
      start.push(at(range[0]))
      end.push(at(range[1]))
      ref.push(target)
      kidStart.push(kids.length)
      kidCount.push(children.length)
      const first = kids.length
      kids.length += children.length
      for (let i = children.length - 1; i >= 0; i--) stack.push({ n: children[i], parent: id, slot: first + i })
    }
  }

  return {
    bytes,
    kind: Uint8Array.from(kind),
    flags: Uint8Array.from(flags),
    parent: Int32Array.from(parent),
    start: Float64Array.from(start),
    end: Float64Array.from(end),
    kidStart: Int32Array.from(kidStart),
    kidCount: Int32Array.from(kidCount),
    kids: Int32Array.from(kids),
    ref: Int32Array.from(ref),
    propNode: Int32Array.from(propNode),
    propIsTag: Uint8Array.from(propIsTag),
    propStart: Float64Array.from(propStart),
    propEnd: Float64Array.from(propEnd),
    commentStart: Float64Array.from(comments, (c) => at(c.offset)),
    commentEnd: Float64Array.from(comments, (c) => at(c.offset + c.source.length)),
    docs: Int32Array.from(docs),
    errors,
    parseMs: performance.now() - t0
  }
}

/** The anchor and explicit-tag spans of one node (binary search: props are ascending by node). */
export function nodeProps(tree: YamlTree, node: number): { anchor?: [number, number]; tag?: [number, number] } {
  let lo = 0
  let hi = tree.propNode.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tree.propNode[mid] < node) lo = mid + 1
    else hi = mid
  }
  const out: { anchor?: [number, number]; tag?: [number, number] } = {}
  for (let i = lo; i < tree.propNode.length && tree.propNode[i] === node; i++)
    out[tree.propIsTag[i] ? 'tag' : 'anchor'] = [tree.propStart[i], tree.propEnd[i]]
  return out
}

/** On-demand alias expansion: the node to show under an alias reached through `depth` aliases, or -1 past the limit. */
export function aliasTarget(tree: YamlTree, node: number, depth: number): number {
  return depth < MAX_ALIAS_DEPTH ? tree.ref[node] : -1
}

/** Every buffer in the tree, for postMessage's transfer list. */
export function transferables(tree: YamlTree): ArrayBuffer[] {
  return Object.values(tree).flatMap((v) => (ArrayBuffer.isView(v) ? [v.buffer as ArrayBuffer] : []))
}
```

- [ ] **Step 5: Run the span gate**

Run (`spikes/app`): `npx vitest run src/renderer/src/yaml --silent=false`
Expected: `span gate: 10000 cases, 220797 oracle nodes, 0 mismatches` and `Tests  7 passed (7)`.
(Without `--silent=false`, Vitest 5 hides a passing test's console output.)

- [ ] **Step 6: Falsify the byte table**

In `tree.ts`, `byteTable`, replace the width line
<!-- op: temporary spikes/app/src/renderer/src/yaml/tree.ts -->
```ts
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xe000 ? 2 : 3
```
with this one, so 2-byte characters count as 1 byte:
```ts
    const w = c < 0x80 ? 1 : c < 0x800 ? 1 : c >= 0xd800 && c < 0xe000 ? 2 : 3
```
Run (`spikes/app`): `npx vitest run src/renderer/src/yaml --silent=false`
Expected: `span gate: 10000 cases, 220797 oracle nodes, 216844 mismatches` and `Tests  2 failed | 5 passed (7)` (the gate and the BOM/CRLF/4-byte test).
Change the line back to `c < 0x800 ? 2`, then rerun: `Tests  7 passed (7)`.

- [ ] **Step 7: Read your own work (rule 8), then commit**

Re-read the three files as they sit on disk.
```bash
git add spikes/app/package.json spikes/app/package-lock.json spikes/app/src/renderer/src/yaml/gen.ts spikes/app/src/renderer/src/yaml/tree.test.ts spikes/app/src/renderer/src/yaml/tree.ts
git commit -m "spike(c): YAML tree with exact byte spans; span gate 0/10000"
```

---

## Task C5a2: The YAML worker — bytes in, columnar tree out, cancel by terminate

**Files:**
- Create: `spikes/app/src/renderer/src/yaml/yaml.worker.ts`, `spikes/app/src/renderer/src/yaml/client.ts`
- Create: `spikes/app/e2e/launch.ts`, `spikes/app/e2e/yaml.e2e.ts`
- Modify: `spikes/app/src/renderer/src/main.ts` (exposes `window.__spike.untrusted`)

**Interfaces:**
- **Consumes:** `buildTree`, `transferables`, `YamlTree` (Task C5a1); plan A's `window.__spike` and `#status`.
- **Produces:**
  - `parseYaml(bytes: ArrayBuffer): { done: Promise<YamlTree>; cancel(): void }` — one worker per parse; `bytes` is transferred (the caller's buffer is detached) and comes back as `tree.bytes`. `cancel()` calls `worker.terminate()` and rejects `done` with `Error('cancelled')`. A worker error rejects `done`.
  - `window.__spike.untrusted = { parseYaml }` (Tasks C5a3 and C5a4 extend it).
  - `e2e/launch.ts`: `FIX` (the `spikes/.fixtures` path) and `launch(name, env?): Promise<{ app, win }>`.

**Design notes:**
- **The tree crosses back as transferred buffers** (`transferables`), not as a structured clone of nodes, so the main thread never deserializes nodes. Delivery still isn't free at scale: Task C5a6 measures long frames from 16 MiB.
- **Cancel is `terminate()`.** It returns synchronously; the UI is free on the next frame. Nothing in the worker can outlive it.
- **An out-of-memory in the worker kills the whole renderer**, not just the worker: V8's OOM is fatal for the process. Measured: `ci`-shaped YAML at 128 MiB ends with `render-process-gone {"reason":"oom","exitCode":-536870904}` and no `onerror`. The size ceiling (`yaml.treeMaxBytes`, Task C5a6) is therefore a memory bound as much as a time bound; the test's last case is the densest input at the proposed 8 MiB ceiling (4.19M nodes), and the renderer survives it.
- **Hostile cases** (generated in the page): an alias bomb (31 levels × 10 aliases), `[` × 100,000, a 50 MiB double-quoted scalar, 1M anchors, 1M distinct tags, and 8 MiB of `a,` in one flow sequence. Each is also cancelled 20 ms into its parse.

- [ ] **Step 1: Write the launch helper and the failing test**

`spikes/app/e2e/launch.ts`:
<!-- op: create spikes/app/e2e/launch.ts -->
```ts
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const FIX = resolve(__dirname, '../../.fixtures')

/**
 * Launches the app in a fresh private profile and checks the page zoom is 1. Every spike runs as `spike-app`, and
 * Chromium persists per-host zoom in the shared %APPDATA%\spike-app profile. Inherited TYPOSE_* variables are dropped.
 */
export async function launch(name: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const profile = join(FIX, 'profiles', name)
  rmSync(profile, { recursive: true, force: true })
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...base, ...env } as Record<string, string> })
  const win = await app.firstWindow()
  await win.waitForFunction(() => (window as any).__spike?.untrusted, null, { timeout: 15_000 })
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1)
  return { app, win }
}
```
`spikes/app/e2e/yaml.e2e.ts`:
<!-- op: create spikes/app/e2e/yaml.e2e.ts -->
```ts
import { expect, test } from '@playwright/test'
import { launch } from './launch'

test('hostile YAML parses or fails with an error, the renderer survives, and cancel takes ≤ 50 ms', async () => {
  const { app, win } = await launch('yaml')
  const r = await win.evaluate(async () => {
    const u = (window as any).__spike.untrusted
    const cases: [string, () => string][] = [
      ['billion laughs', () => ['a0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]', ...Array.from({ length: 30 }, (_, i) => `a${i + 1}: &a${i + 1} [${Array(10).fill(`*a${i}`).join(', ')}]`)].join('\n')],
      ['100k-deep flow nesting', () => '['.repeat(100_000) + ']'.repeat(100_000)],
      ['50 MB single scalar', () => `k: "${'a'.repeat(50 * 2 ** 20)}"\n`],
      ['1M anchors', () => Array.from({ length: 1_000_000 }, (_, i) => `- &a${i} ${i}`).join('\n')],
      ['tag flood (1M tags)', () => Array.from({ length: 1_000_000 }, (_, i) => `- !t${i} ${i}`).join('\n')],
      // The densest nodes per byte at the proposed ceiling (yaml.treeMaxBytes = 8 MiB): memory, not just time.
      ['8 MiB dense flow sequence', () => `[${'a,'.repeat(4 * 2 ** 20 - 1)}a]`]
    ]
    const enc = new TextEncoder()
    const parses = []
    for (const [name, make] of cases) {
      const bytes = enc.encode(make()).buffer
      const mb = bytes.byteLength / 2 ** 20 // read before parseYaml transfers (detaches) the buffer
      const t0 = performance.now()
      const job = u.parseYaml(bytes)
      try {
        const t = await job.done
        parses.push({ name, mb, ms: performance.now() - t0, nodes: t.kind.length, errors: t.errors.map((e: any) => e.code) })
      } catch (err) {
        parses.push({ name, mb, ms: performance.now() - t0, failed: String(err) })
      }
    }
    // Cancel each one 20 ms into its parse; time it as the UI sees it: cancel() requested → terminate() returned → next frame.
    const cancels = []
    for (const [name, make] of cases) {
      const job = u.parseYaml(enc.encode(make()).buffer)
      await new Promise((ok) => setTimeout(ok, 20))
      const t0 = performance.now()
      job.cancel()
      const terminateMs = performance.now() - t0
      await new Promise((ok) => requestAnimationFrame(ok))
      const nextFrameMs = performance.now() - t0
      cancels.push({ name, terminateMs, nextFrameMs, outcome: await job.done.then(() => 'finished first', (e: Error) => e.message) })
    }
    return { parses, cancels }
  })
  for (const p of r.parses) console.log(`parse  ${p.name}: ${p.mb.toFixed(1)} MB, ${Math.round(p.ms)} ms, ${p.failed ?? `${p.nodes} nodes, errors ${JSON.stringify(p.errors.slice(0, 3))}`}`)
  for (const c of r.cancels) console.log(`cancel ${c.name}: terminate() ${c.terminateMs.toFixed(2)} ms, next frame ${c.nextFrameMs.toFixed(1)} ms, ${c.outcome}`)

  const laughs = r.parses[0]
  expect(laughs.nodes).toBeLessThan(1_000) // 10^31 nodes if aliases were materialized
  expect(r.parses[1].errors).toContain('RESOURCE_EXHAUSTION') // the deep nesting fails with a reported error
  for (const p of r.parses) expect(p.failed ?? p.nodes, p.name).toBeDefined()
  for (const c of r.cancels) {
    expect(c.nextFrameMs, c.name).toBeLessThanOrEqual(50)
    expect(['cancelled', 'finished first'], c.name).toContain(c.outcome)
  }
  expect(await win.evaluate(() => document.getElementById('status')!.textContent)).toBe('core 0.0.0') // the renderer is alive
  await app.close()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e yaml`
Expected: FAIL, `TimeoutError: page.waitForFunction: Timeout 15000ms exceeded.` (`__spike.untrusted` doesn't exist yet).

- [ ] **Step 3: Implement the worker and the client, and expose them**

`spikes/app/src/renderer/src/yaml/yaml.worker.ts`:
<!-- op: create spikes/app/src/renderer/src/yaml/yaml.worker.ts -->
```ts
// The YAML worker (spec §4.5): file bytes in (transferred), the columnar tree out (transferred back with the bytes).
import { buildTree, transferables } from './tree'

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const tree = buildTree(new Uint8Array(e.data))
    self.postMessage({ tree }, { transfer: transferables(tree) })
  } catch (err) {
    self.postMessage({ error: String(err) })
  }
}
```
`spikes/app/src/renderer/src/yaml/client.ts`:
<!-- op: create spikes/app/src/renderer/src/yaml/client.ts -->
```ts
// Main-thread side of the YAML worker: one worker per parse, so cancel is terminate() and nothing can outlive it.
import type { YamlTree } from './tree'

export interface YamlParse {
  done: Promise<YamlTree>
  cancel(): void
}

/** Parses file bytes off the main thread. `bytes` is transferred: the caller's buffer is detached, and the tree carries it back. */
export function parseYaml(bytes: ArrayBuffer): YamlParse {
  const worker = new Worker(new URL('./yaml.worker.ts', import.meta.url), { type: 'module' })
  let fail: (err: Error) => void = () => {}
  const done = new Promise<YamlTree>((ok, no) => {
    fail = no
    worker.onmessage = (e: MessageEvent<{ tree?: YamlTree; error?: string }>) => {
      worker.terminate()
      if (e.data.tree) ok(e.data.tree)
      else no(new Error(e.data.error))
    }
    // A worker error surfaces here. A V8 out-of-memory in the worker does not: it kills the whole renderer process
    // (render-process-gone, reason 'oom'). That is why yaml.treeMaxBytes bounds the input.
    worker.onerror = (e) => {
      worker.terminate()
      no(new Error(e.message || 'YAML worker failed'))
    }
  })
  worker.postMessage(bytes, [bytes])
  return {
    done,
    cancel: () => {
      worker.terminate()
      fail(new Error('cancelled'))
    }
  }
}
```
In `spikes/app/src/renderer/src/main.ts`, replace:
<!-- op: replace spikes/app/src/renderer/src/main.ts -->
```ts
import { PerfLog } from './perf'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf }
```
with:
```ts
import { PerfLog } from './perf'
import { parseYaml } from './yaml/client'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf, untrusted: { parseYaml } }
```

- [ ] **Step 4: Run it until it passes**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e yaml`
Expected: `1 passed`, and the log lines:
```text
parse  billion laughs: 0.0 MB, 16 ms, 405 nodes, errors []
parse  100k-deep flow nesting: 0.2 MB, 200 ms, 392 nodes, errors ["RESOURCE_EXHAUSTION","RESOURCE_EXHAUSTION","RESOURCE_EXHAUSTION"]
parse  50 MB single scalar: 50.0 MB, 2059 ms, 5 nodes, errors []
parse  1M anchors: 17.0 MB, 2988 ms, 1000002 nodes, errors []
parse  tag flood (1M tags): 17.0 MB, 6016 ms, 1000002 nodes, errors []
parse  8 MiB dense flow sequence: 8.0 MB, 5868 ms, 4194306 nodes, errors []
cancel billion laughs: terminate() 0.10 ms, next frame 0.4 ms, finished first
cancel 100k-deep flow nesting: terminate() 0.10 ms, next frame 0.5 ms, cancelled
cancel 50 MB single scalar: terminate() 0.10 ms, next frame 0.4 ms, cancelled
cancel 1M anchors: terminate() 0.10 ms, next frame 0.2 ms, cancelled
cancel tag flood (1M tags): terminate() 0.00 ms, next frame 0.3 ms, cancelled
cancel 8 MiB dense flow sequence: terminate() 0.10 ms, next frame 0.3 ms, cancelled
```
(Times vary run to run. The alias bomb parses in under 20 ms, so its cancel can find it already finished.)

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/yaml/yaml.worker.ts spikes/app/src/renderer/src/yaml/client.ts spikes/app/src/renderer/src/main.ts spikes/app/e2e/launch.ts spikes/app/e2e/yaml.e2e.ts
git commit -m "spike(c): YAML worker with transferred columnar tree; hostile inputs cancel in <=50 ms"
```

---

## Task C5a3: KaTeX in a worker, DOMPurify before the DOM

**Files:**
- Modify: `spikes/app/package.json`, `spikes/app/package-lock.json` (npm writes both)
- Create: `spikes/app/e2e/hostile.ts` (all four corpora; Tasks C5a4 and C5a5 use the rest)
- Create: `spikes/app/src/renderer/src/math/tex.ts`, `spikes/app/src/renderer/src/math/tex.test.ts`
- Create: `spikes/app/src/renderer/src/math/katex.worker.ts`, `spikes/app/src/renderer/src/math/math.ts`, `spikes/app/e2e/math.e2e.ts`
- Modify: `spikes/app/src/renderer/src/main.ts`

**Interfaces:**
- **Consumes:** `katex` 0.19.0 (`renderToString`, `katex/dist/katex.min.css`), `dompurify` 3.4.17; `launch` (Task C5a2).
- **Produces:**
  - `KATEX_OPTIONS = { trust: false, maxExpand: 1000, maxSize: 20, throwOnError: false }`; `renderTex(tex: string, displayMode: boolean): string`.
  - `sanitizeMath(html: string): string`; `renderMath(el: HTMLElement, tex: string, displayMode = false): Promise<void>` — a render error (a KaTeX `.katex-error`, or a throw such as stack exhaustion) shows the TeX source after a `span.problem` marker whose `title` is the message.
  - `e2e/hostile.ts`: `HOSTILE_TEX`, `HOSTILE_HTML`, `HOSTILE_YAML`, `HOSTILE_MERMAID: { name, source }[]`, `hugeFlowchart(edges, chars): string`.
  - `window.__spike.untrusted` gains `renderMath` and `sanitizeMath`.

**Design notes:**
- **Two layers, each tested on its own.** `tex.test.ts` pins KaTeX's own output for the hostile TeX (no `a`/`img`/`script`/`iframe`/`object`/`style` tags, no `href`/`src`/`xlink:href`/`data-*`/`on*` attributes, no `style` with `url(` or `@import`) before any sanitizer; turning `trust` on fails it. `math.e2e.ts` runs the same TeX through the worker, DOMPurify and the DOM, and separately feeds DOMPurify HTML/MathML/SVG that only a KaTeX bug could emit; dropping DOMPurify fails it.
- **DOMPurify config:** the MathML profile, plus HTML (KaTeX's layout spans) and SVG — KaTeX draws `\sqrt` and stretchy glyphs as inline SVG, which the MathML profile alone strips. Minus everything that loads: `FORBID_TAGS: ['style']`, `FORBID_ATTR: ['href', 'xlink:href', 'src']`, `ALLOW_DATA_ATTR: false`, and a hook that drops any `style` attribute with parentheses, quotes, backslashes or `@` (KaTeX's own styles are plain declarations; checked over the corpus). It's a private instance: Mermaid uses DOMPurify's default instance and must not inherit the hook.
- **maxSize: 20** (em) caps every user-given size; `\rule{100000em}{100000em}` renders 20 em square.

- [ ] **Step 1: Add the dependencies**

Run (`spikes/app`): `npm install --save-exact katex@0.19.0 dompurify@3.4.17`
Expected: `dependencies` gains `"dompurify": "3.4.17"` and `"katex": "0.19.0"`.

- [ ] **Step 2: Write the hostile corpora and the failing KaTeX test**

`spikes/app/e2e/hostile.ts`:
<!-- op: create spikes/app/e2e/hostile.ts -->
```ts
// Hostile fixtures for the untrusted-content renderers (spec §13.1). Every URL is on .invalid, which never resolves.

/** TeX: trusted commands, macro bombs, huge sizes, deep nesting, CSS injection, raw markup in text. */
export const HOSTILE_TEX: string[] = [
  String.raw`\href{javascript:alert(1)}{click}`,
  String.raw`\href{https://example.invalid/h}{x}\url{https://example.invalid/u}`,
  String.raw`\includegraphics{https://example.invalid/i.png}\includegraphics[height=1em]{file:///C:/Windows/win.ini}`,
  String.raw`\htmlData{onload=alert(1), x=y}{a}\htmlId{evil}{b}\htmlClass{x" onmouseover="alert(1)}{c}\htmlStyle{background:url(https://example.invalid/s)}{d}`,
  String.raw`\def\a{\a\a}\a`,
  String.raw`\def\b#1{#1#1}\b{\b{\b{\b{\b{\b{\b{\b{\b{\b{\b{\b{x}}}}}}}}}}}}`,
  String.raw`\newcommand{\zz}{\zz\zz}\zz`,
  String.raw`\rule{100000em}{100000em}\kern100000em\hspace{100000em}\mkern100000mu\raisebox{100000em}{x}`,
  '{'.repeat(50_000) + 'x' + '}'.repeat(50_000),
  '\\sqrt{'.repeat(5_000) + 'x' + '}'.repeat(5_000),
  String.raw`\color{red;background:url(https://example.invalid/c)}{x}\textcolor{expression(alert(1))}{y}\colorbox{url(https://example.invalid/b)}{z}`,
  String.raw`\text{<img src=https://example.invalid/t onerror=alert(1)><script>alert(1)</script>}`,
  String.raw`\mathrm{</span><a href="https://example.invalid/">x</a>}\operatorname{<math href="javascript:alert(1)">y</math>}`,
  String.raw`\begin{array}{c}\href{javascript:alert(1)}{x}\\\url{javascript:alert(1)}\end{array}`,
  String.raw`\sqrt{x}\frac{a}{b}\xrightarrow{abc}\widehat{xyz}` // legitimate: KaTeX draws these with inline SVG
]

/** HTML/MathML/SVG a KaTeX bug could emit: what the DOMPurify pass alone must neutralize. */
export const HOSTILE_HTML: string[] = [
  '<math><annotation-xml encoding="text/html"><img src="https://example.invalid/a" onerror="alert(1)"></annotation-xml></math>',
  '<math><semantics><mi>x</mi><annotation-xml encoding="application/xhtml+xml"><a href="https://example.invalid/">y</a></annotation-xml></semantics></math>',
  '<math href="javascript:alert(1)"><mi xlink:href="https://example.invalid/m">x</mi></math>',
  '<svg><a xlink:href="https://example.invalid/s"><text>x</text></a><foreignObject><img src="https://example.invalid/f"></foreignObject></svg>',
  '<svg><image href="https://example.invalid/i.png"></image><use href="https://example.invalid/u.svg#x"></use></svg>',
  '<span style="background:url(https://example.invalid/b)">a</span><span style="background:u\\72l(https://example.invalid/e)">b</span>',
  '<style>@import url(https://example.invalid/i.css)</style><span style="x:1;@import url(https://example.invalid/j.css)">c</span>',
  '<span onclick="alert(1)" data-x="1">d</span><script>alert(1)</script><img src=x onerror=alert(1)>',
  '<math><mtext><table><mglyph><style><img src=https://example.invalid/mx onerror=alert(1)>',
  '<a href="https://example.invalid/">link</a><iframe src="https://example.invalid/if"></iframe><object data="https://example.invalid/o"></object>'
]

/** YAML for the zero-effects run: an alias bomb, URL-shaped tags and %TAG handles, a recursive alias. */
export const HOSTILE_YAML: string[] = [
  ['a: &a [x, x, x, x, x, x, x, x, x]', ...Array.from({ length: 9 }, (_, i) => `${'bcdefghij'[i]}: &${'bcdefghij'[i]} [${Array(9).fill('*' + 'abcdefghi'[i]).join(', ')}]`)].join('\n'),
  '%TAG !e! tag:example.invalid,2000:\n--- !e!doc\na: !<https://example.invalid/t> 1\nb: !!binary aGVsbG8=\nc: !!js/function "function () { fetch(\'https://example.invalid/\') }"\n',
  'r: &r [*r]\n<<: *r\n'
]

/** A label payload: an image, a script, a javascript: link, an @import and a frame. */
const H =
  "<img src=https://example.invalid/i.png><script>alert(1)</script><a href='javascript:alert(1)'>a</a>" +
  "<style>@import url(https://example.invalid/s.css)</style><iframe src=https://example.invalid/f></iframe>"

/** A flowchart with `edges` edges, padded with a comment to `chars` characters (Mermaid's limits: 50,000 and 500). */
export function hugeFlowchart(edges: number, chars: number): string {
  const lines = ['flowchart LR']
  for (let i = 0; i < edges; i++) lines.push(`  n${i}["${i}"] --> n${i + 1}`)
  const body = lines.join('\n') + '\n'
  return body + '%%' + 'x'.repeat(Math.max(0, chars - body.length - 2))
}

/**
 * Mermaid: every diagram type mermaid 12.2.0 registers, with hostile text wherever the type's grammar accepts text,
 * plus directives, front-matter, click/href/link, classDef/style CSS and the image shape.
 */
export const HOSTILE_MERMAID: { name: string; source: string }[] = [
  {
    name: 'flowchart: init directive',
    source: `%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": "@import url(https://example.invalid/t.css); .node rect {fill: url(https://example.invalid/n.png)}", "fontFamily": "x;background:url(https://example.invalid/ff)"}}%%
flowchart LR
  A["${H}"] --> B`
  },
  {
    name: 'flowchart: front-matter config',
    source: `---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  themeCSS: "@import url(https://example.invalid/fm.css);"\n---\nflowchart LR\n  A["${H}"] --> B`
  },
  {
    name: 'flowchart: labels',
    source: `flowchart LR
  A["${H}"] --> B["\`**md** <img src=https://example.invalid/md.png>\`"]
  B --> C[#lt;img src=https://example.invalid/ent.png#gt;]
  C --> D["$$\\href{https://example.invalid/k}{k}\\includegraphics{https://example.invalid/g.png}$$"]
  D --> E(fa:fa-car icon)`
  },
  { name: 'flowchart: image shape', source: 'flowchart LR\n  A --> B@{ img: "https://example.invalid/shape.png", label: "x", pos: "t", h: 60 }' },
  {
    name: 'flowchart: click and href',
    source:
      'flowchart LR\n  A --> B --> C --> D\n  click A href "javascript:alert(1)"\n  click B href "https://example.invalid/b" _top\n  click C call alert(1)\n  click D href "https://example.invalid/d" _blank'
  },
  { name: 'flowchart: classDef url(', source: 'flowchart LR\n  A --> B\n  classDef evil fill:url(https://example.invalid/c.png)\n  class A evil' },
  { name: 'flowchart: style url(', source: 'flowchart LR\n  A --> B\n  style A fill:url(https://example.invalid/s.png)' },
  {
    name: 'sequence',
    source: `sequenceDiagram\n  participant A as ${H}\n  A->>B: ${H}\n  Note right of A: ${H}\n  link A: Evil @ javascript:alert(1)\n  links B: {"Web": "https://example.invalid/w"}`
  },
  {
    name: 'class',
    source: `classDiagram\n  class A["${H}"]\n  note for A "${H}"\n  link A "https://example.invalid/c" "tip"\n  click A href "javascript:alert(1)"`
  },
  { name: 'class: classDef url(', source: 'classDiagram\n  class A\n  classDef bad fill:url(https://example.invalid/cf.png)\n  cssClass "A" bad' },
  { name: 'state', source: `stateDiagram-v2\n  state "${H}" as s1\n  note right of s1 : x\n  [*] --> s1` },
  {
    name: 'state: classDef url( and @import',
    source:
      'stateDiagram-v2\n  s1 --> s2\n  classDef bad fill:url(https://example.invalid/sf.png)\n  classDef imp color:red;@import url(https://example.invalid/si.css)\n  class s1 bad\n  class s2 imp'
  },
  { name: 'er', source: `erDiagram\n  CUSTOMER ||--o{ ORDER : "${H}"\n  CUSTOMER {\n    string name "${H}"\n  }` },
  {
    name: 'gantt',
    source: `gantt\n  title ${H}\n  dateFormat YYYY-MM-DD\n  section ${H}\n  ${H} :a1, 2024-01-01, 30d\n  click a1 href "javascript:alert(1)"\n  click a1 call alert(1)`
  },
  { name: 'pie', source: `pie title ${H}\n  "${H}" : 42\n  "b" : 58` },
  { name: 'journey', source: `journey\n  title ${H}\n  section Sect\n    Task one: 5: Me` },
  { name: 'gitGraph', source: `gitGraph\n  commit id: "${H}"\n  branch b\n  commit tag: "${H}"\n  checkout main\n  merge b` },
  { name: 'mindmap', source: `mindmap\n  root["${H}"]\n    child["${H}"]\n    ::icon(fa fa-book)` },
  { name: 'timeline', source: `timeline\n  title ${H}\n  2024 : ${H}` },
  { name: 'quadrantChart', source: `quadrantChart\n  title ${H}\n  x-axis Low --> High\n  y-axis Low --> High\n  quadrant-1 Q1\n  Point A: [0.3, 0.6]` },
  { name: 'xychart', source: `xychart\n  title "${H}"\n  x-axis [a, b]\n  y-axis "${H}" 0 --> 10\n  bar [1, 2]` },
  { name: 'requirement', source: `requirementDiagram\n  requirement r {\n    id: 1\n    text: "${H}"\n    risk: high\n    verifymethod: test\n  }` },
  { name: 'sankey', source: `sankey\n"${H}",B,10\nB,C,5` },
  { name: 'block', source: `block\n  columns 1\n  a["${H}"]` },
  { name: 'packet', source: `packet\n  0-15: "${H}"` },
  { name: 'kanban', source: `kanban\n  todo["${H}"]\n    t1["${H}"]` },
  {
    name: 'architecture',
    source: `architecture-beta\n  group api(cloud)[${H}]\n  service db(database)[${H}] in api\n  service ext(logos:aws)[aws] in api\n  db:L -- R:ext`
  },
  { name: 'radar', source: `radar-beta\n  title ${H}\n  axis a["${H}"], b["b"], c["c"]\n  curve k["${H}"]{1, 2, 3}` },
  { name: 'treemap', source: `treemap\n  "${H}"\n    "child": 10` },
  {
    name: 'c4',
    source: `C4Context\n  title ${H}\n  Person(p, "${H}", "${H}", $link="https://example.invalid/p")\n  System(s, "${H}", $link="javascript:alert(1)")\n  Rel(p, s, "${H}")`
  },
  { name: 'flowchart-elk', source: `flowchart-elk LR\n  A["${H}"] --> B` },
  { name: 'info', source: 'info' },
  { name: 'venn', source: `venn-beta\n  title ${H}\n  set A["${H}"]\n  set B["b"]\n  union A,B` },
  { name: 'ishikawa', source: `ishikawa\n  ${H}\n    cause one\n      sub cause` },
  { name: 'usecase', source: `usecase-beta\n  actor User\n  User --> "${H}"` },
  { name: 'wardley', source: `wardley-beta\n  title ${H}\n  component Customer [0.9, 0.5]\n  component Cup [0.8, 0.6]\n  Customer -> Cup` },
  { name: 'cynefin', source: `cynefin-beta\n  title "${H}"\n  complex "${H}"` },
  { name: 'treeView', source: `treeView-beta\n  "${H}"\n    "child"` },
  { name: 'swimlane', source: `swimlane-beta\n  A["${H}"] --> B` },
  { name: 'agentflow', source: `agentflow-beta\n  A["${H}"] --> B` },
  { name: 'eventmodeling', source: `eventmodeling\n  tf 01 cmd DoThing [[Payload]]\n  data Payload \`html\` {\n    ${H}\n}\n  note 01 {\n    ${H}\n}` },
  { name: 'railroad', source: `railroad-beta\n  rule = terminal("${H}");` },
  { name: 'railroad-ebnf', source: `railroad-ebnf-beta\n  rule = "${H}" ;` },
  { name: 'railroad-abnf', source: `railroad-abnf-beta\n  rule = "${H}" ;` },
  { name: 'railroad-peg', source: `railroad-peg-beta\n  rule <- "${H}" ;` }
]
```
`spikes/app/src/renderer/src/math/tex.test.ts`:
<!-- op: create spikes/app/src/renderer/src/math/tex.test.ts -->
```ts
import { describe, expect, it } from 'vitest'
import { HOSTILE_TEX } from '../../../../e2e/hostile'
import { KATEX_OPTIONS, renderTex } from './tex'

/** Attributes or tags in KaTeX's own output that would load, link or carry data. TeX source echoed as text is escaped. */
const UNSAFE = [/<(a|img|script|iframe|object|style)[\s>]/, /\s(href|src|xlink:href)=/, /\sdata-[\w-]+=/, /\son\w+=/, /style="[^"]*(url\(|@import)/]

describe('KaTeX worker output (spec §4.6)', () => {
  it('runs with trust off, bounded expansion and a finite maxSize', () => {
    expect(KATEX_OPTIONS).toEqual({ trust: false, maxExpand: 1000, maxSize: 20, throwOnError: false })
  })

  it('emits nothing that loads, links or carries data for the hostile corpus, before any sanitizer', () => {
    const found: string[] = []
    for (const tex of HOSTILE_TEX)
      for (const displayMode of [false, true]) {
        let html = ''
        try {
          html = renderTex(tex, displayMode)
        } catch {
          continue // stack exhaustion on deep nesting: the renderer shows the source with a problem marker
        }
        const tags = (html.match(/<[^>]*>/g) ?? []).join('\n') // KaTeX escapes < > " in text and attribute values
        for (const re of UNSAFE) if (re.test(tags)) found.push(`${re} in ${tex.slice(0, 40)}`)
      }
    expect(found).toEqual([])
  })

  it('stops macro bombs at maxExpand and caps sizes at maxSize', () => {
    expect(renderTex(String.raw`\def\a{\a\a}\a`, false)).toContain('Too many expansions')
    expect(renderTex(String.raw`\rule{100000em}{100000em}`, false)).toContain('width="20em" height="20em"')
  })
})
```
Run (`spikes/app`): `npx vitest run src/renderer/src/math`
Expected: FAIL, `Error: Cannot find module './tex' imported from …/tex.test.ts`.

- [ ] **Step 3: Implement the KaTeX options and run the test**

`spikes/app/src/renderer/src/math/tex.ts`:
<!-- op: create spikes/app/src/renderer/src/math/tex.ts -->
```ts
// KaTeX hardening (spec §4.6). Shared by the KaTeX worker and its tests.
import katex from 'katex'

/**
 * trust: false refuses \href, \url, \includegraphics and \htmlData/\htmlId/\htmlClass/\htmlStyle;
 * maxExpand bounds macro bombs; maxSize caps every user-given size (\rule, \kern, \hspace) at 20 em.
 */
export const KATEX_OPTIONS = { trust: false, maxExpand: 1000, maxSize: 20, throwOnError: false } as const

/** HTML + MathML. Parse errors render as a red .katex-error span; anything else (stack exhaustion) throws. */
export function renderTex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode })
}
```
Run (`spikes/app`): `npx vitest run src/renderer/src/math`
Expected: `Tests  3 passed (3)` (KaTeX also prints "LaTeX-incompatible input and strict mode is set to 'warn'" lines; they are warnings).

- [ ] **Step 4: Falsify `trust`**

In `tex.ts`, change `trust: false` to `trust: true`, rerun the command above.
Expected: `Tests  2 failed | 1 passed (3)`; the corpus test lists `/<(a|img|script|iframe|object|style)[\s>]/ in \href{javascript:alert(1)}{click}` among others (with `trust: true`, KaTeX emits `<a href="javascript:alert(1)">`).
Change it back to `trust: false`; rerun: `Tests  3 passed (3)`.

- [ ] **Step 5: Write the failing end-to-end test**

`spikes/app/e2e/math.e2e.ts`:
<!-- op: create spikes/app/e2e/math.e2e.ts -->
```ts
import { expect, test } from '@playwright/test'
import { HOSTILE_HTML, HOSTILE_TEX } from './hostile'
import { launch } from './launch'

// The structural check runs in the page (the CSP forbids eval, so it is written inline in each evaluate):
// no script/style/foreignObject/frames, no on* handlers, no href/src/xlink:href/data, no style that loads
// (url(, @import, escapes), no annotation-xml with an HTML encoding.

test('KaTeX output that reaches the DOM is structurally clean and DOMPurify-idempotent', async () => {
  const { app, win } = await launch('math')
  const results = await win.evaluate(async (corpus) => {
    const u = (window as any).__spike.untrusted
    const unsafe = (root: ParentNode): string[] => {
      const bad: string[] = []
      for (const el of root.querySelectorAll('*')) {
        const tag = el.localName.toLowerCase()
        if (['script', 'style', 'foreignobject', 'iframe', 'object', 'embed'].includes(tag)) bad.push(tag)
        if (tag === 'annotation-xml' && /html/i.test(el.getAttribute('encoding') ?? '')) bad.push('annotation-xml html')
        for (const a of el.attributes) {
          if (/^on/i.test(a.name) || /^(href|src|xlink:href|data|action|formaction)$/i.test(a.name)) bad.push(`${tag}[${a.name}]`)
          if (a.name === 'style' && /url\(|@import|\\/i.test(a.value)) bad.push(`style ${a.value}`)
        }
      }
      return bad
    }
    const out = []
    for (const tex of corpus)
      for (const display of [false, true]) {
        const el = document.createElement('div')
        document.getElementById('card')!.append(el)
        await u.renderMath(el, tex, display)
        out.push({
          tex: tex.slice(0, 40),
          unsafe: unsafe(el),
          idempotent: u.sanitizeMath(el.innerHTML) === el.innerHTML,
          problem: el.querySelector('.problem')?.getAttribute('title') ?? null,
          svg: el.querySelectorAll('svg').length
        })
      }
    return out
  }, HOSTILE_TEX)
  for (const r of results) console.log(`${r.problem ? 'problem' : 'rendered'} ${JSON.stringify(r.tex)} ${r.problem ?? ''}`.slice(0, 160))
  expect(results.flatMap((r) => r.unsafe)).toEqual([])
  expect(results.filter((r) => !r.idempotent).map((r) => r.tex)).toEqual([])
  expect(results.find((r) => r.tex.startsWith('\\sqrt{x}'))!.svg).toBeGreaterThan(0) // radicals keep KaTeX's SVG
  expect(results.find((r) => r.tex.startsWith('\\def\\a'))!.problem).toContain('Too many expansions')
  await app.close()
})

test('the DOMPurify pass alone neutralizes what a KaTeX bug could emit', async () => {
  const { app, win } = await launch('math-purify')
  const results = await win.evaluate((corpus) => {
    const u = (window as any).__spike.untrusted
    const unsafe = (root: ParentNode): string[] => {
      const bad: string[] = []
      for (const el of root.querySelectorAll('*')) {
        const tag = el.localName.toLowerCase()
        if (['script', 'style', 'foreignobject', 'iframe', 'object', 'embed'].includes(tag)) bad.push(tag)
        if (tag === 'annotation-xml' && /html/i.test(el.getAttribute('encoding') ?? '')) bad.push('annotation-xml html')
        for (const a of el.attributes) {
          if (/^on/i.test(a.name) || /^(href|src|xlink:href|data|action|formaction)$/i.test(a.name)) bad.push(`${tag}[${a.name}]`)
          if (a.name === 'style' && /url\(|@import|\\/i.test(a.value)) bad.push(`style ${a.value}`)
        }
      }
      return bad
    }
    return corpus.map((html) => {
      const clean: string = u.sanitizeMath(html)
      const t = document.createElement('template') // inert: nothing in it loads
      t.innerHTML = clean
      return { html: html.slice(0, 50), unsafe: unsafe(t.content), idempotent: u.sanitizeMath(clean) === clean }
    })
  }, HOSTILE_HTML)
  expect(results.flatMap((r) => r.unsafe)).toEqual([])
  expect(results.filter((r) => !r.idempotent).map((r) => r.html)).toEqual([])
  await app.close()
})
```
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e math`
Expected: FAIL, both tests: `u.renderMath is not a function` and `u.sanitizeMath is not a function`.

- [ ] **Step 6: Implement the worker and the sanitizer, and expose them**

`spikes/app/src/renderer/src/math/katex.worker.ts`:
<!-- op: create spikes/app/src/renderer/src/math/katex.worker.ts -->
```ts
// The KaTeX worker (spec §4.6): TeX in, KaTeX's HTML+MathML out. The main thread sanitizes before the DOM sees it.
import { renderTex } from './tex'

self.onmessage = (e: MessageEvent<{ id: number; tex: string; displayMode: boolean }>) => {
  const { id, tex, displayMode } = e.data
  try {
    self.postMessage({ id, html: renderTex(tex, displayMode) })
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}
```
`spikes/app/src/renderer/src/math/math.ts`:
<!-- op: create spikes/app/src/renderer/src/math/math.ts -->
```ts
// Math on the main thread (spec §4.6): KaTeX runs in a worker, and its output passes DOMPurify before it reaches the DOM.
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

// Our own instance: the default one is shared with Mermaid, which must not inherit this hook.
const purify = DOMPurify(window)
// KaTeX's inline styles are plain declarations (sizes, margins, colors). Parentheses, quotes, backslash escapes
// or @ could load something (url(), image-set(), @import), so a style containing any of them is dropped.
const SAFE_STYLE = /^[\w\s:;.,#%-]*$/
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && !SAFE_STYLE.test(data.attrValue)) data.keepAttr = false
})
// The MathML profile, plus HTML for KaTeX's layout spans and SVG for its radicals and stretchy glyphs;
// minus anything that can load or navigate. KaTeX with trust: false never emits a link or an image.
const CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['href', 'xlink:href', 'src'],
  ALLOW_DATA_ATTR: false
}

export function sanitizeMath(html: string): string {
  return purify.sanitize(html, CONFIG)
}

type Result = { id: number; html?: string; error?: string }
let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, (r: Result) => void>()

function katexWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./katex.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<Result>) => {
    pending.get(e.data.id)?.(e.data)
    pending.delete(e.data.id)
  }
  w.onerror = (e) => {
    for (const [id, done] of pending) done({ id, error: e.message || 'KaTeX worker failed' })
    pending.clear()
    w.terminate()
    worker = undefined
  }
  return (worker = w)
}

function showProblem(el: HTMLElement, tex: string, message: string): void {
  const marker = document.createElement('span')
  marker.className = 'problem'
  marker.title = message
  marker.textContent = '⚠'
  el.replaceChildren(marker, tex)
}

/** Renders TeX into `el`. A render error shows the source with a problem marker (brief §4.6). */
export async function renderMath(el: HTMLElement, tex: string, displayMode = false): Promise<void> {
  const w = katexWorker()
  const id = nextId++
  const result = await new Promise<Result>((ok) => {
    pending.set(id, ok)
    w.postMessage({ id, tex, displayMode })
  })
  if (result.error !== undefined) return showProblem(el, tex, result.error)
  el.innerHTML = sanitizeMath(result.html ?? '')
  const parseError = el.querySelector('.katex-error')
  if (parseError) showProblem(el, tex, parseError.getAttribute('title') ?? 'KaTeX parse error')
}
```
In `spikes/app/src/renderer/src/main.ts`, replace:
<!-- op: replace spikes/app/src/renderer/src/main.ts -->
```ts
import { LensView } from './lens-view'
import { PerfLog } from './perf'
import { parseYaml } from './yaml/client'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf, untrusted: { parseYaml } }
```
with:
```ts
import { LensView } from './lens-view'
import { renderMath, sanitizeMath } from './math/math'
import { PerfLog } from './perf'
import { parseYaml } from './yaml/client'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf, untrusted: { parseYaml, renderMath, sanitizeMath } }
```

- [ ] **Step 7: Run it until it passes**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e math`
Expected: `2 passed`. The log shows a `problem` line for each macro bomb (`Too many expansions`), for the 50,000-deep braces and 5,000-deep `\sqrt` (`RangeError: Maximum call stack size exceeded`) and for the `\color` injection (`Invalid color`); every other entry `rendered`.

- [ ] **Step 8: Falsify DOMPurify**

In `math.ts`, replace the body of `sanitizeMath` with `return html`. Run: `npm run build`, then `npx playwright test --project=e2e math`.
Expected: `1 failed`, `1 passed`. The second test fails with 26 unsafe findings, beginning `"annotation-xml html"`, `"img[src]"`, `"img[onerror]"`, `"annotation-xml html"`, `"a[href]"`, `"math[href]"`, `"mi[xlink:href]"`. The first test still passes: with `trust: false`, KaTeX's own output is already clean, which is exactly why the DOMPurify layer has its own test.
Restore `return purify.sanitize(html, CONFIG)`, rebuild, rerun: `2 passed`.

- [ ] **Step 9: Read your own work (rule 8), then commit**

```bash
git add spikes/app/package.json spikes/app/package-lock.json spikes/app/src/renderer/src/math/tex.ts spikes/app/src/renderer/src/math/tex.test.ts spikes/app/src/renderer/src/math/katex.worker.ts spikes/app/src/renderer/src/math/math.ts spikes/app/src/renderer/src/main.ts spikes/app/e2e/hostile.ts spikes/app/e2e/math.e2e.ts
git commit -m "spike(c): KaTeX in a worker with trust off; DOMPurify before the DOM"
```

---

## Task C5a4: Mermaid at securityLevel 'sandbox'

**Files:**
- Modify: `spikes/app/package.json`, `spikes/app/package-lock.json` (npm writes both)
- Create: `spikes/app/src/renderer/src/mermaid/diagram.ts`, `spikes/app/e2e/mermaid.e2e.ts`
- Modify: `spikes/app/src/renderer/index.html` (CSP), `spikes/app/src/renderer/src/main.ts`

**Interfaces:**
- **Consumes:** `mermaid` 12.2.0 (`initialize`, `render`); `HOSTILE_MERMAID`, `hugeFlowchart` (Task C5a3); `launch` (Task C5a2).
- **Produces:** `renderDiagram(el: HTMLElement, source: string): Promise<void>` — the source shows (`pre.diagram-source`) until the diagram is ready; then `el` holds exactly one `<iframe sandbox="" src="data:text/html;…">`. A render error shows `span.problem` (title = the message) and the source. `window.__spike.untrusted` gains `renderDiagram`.

**Design notes:**
- **Lazy:** `import('mermaid')` on the first diagram; Vite splits Mermaid and each diagram type into their own chunks under `typose://app/assets/`.
- **Config:** `{ startOnLoad: false, securityLevel: 'sandbox', suppressErrorRendering: true }`; `maxTextSize` (50,000) and `maxEdges` (500) stay at their defaults. `securityLevel` and `suppressErrorRendering` are on Mermaid's secure list, so `%%{init}%%` and front-matter can't change them (the corpus tries). `suppressErrorRendering` matters: Mermaid's own error diagram path leaves its measuring iframe in `document.body`.
- **What sandbox mode does in 12.2.0:** Mermaid measures inside a temporary same-origin `about:blank` iframe appended to `document.body` (it inherits the page's CSP) and removes it afterwards; it returns the SVG base64-encoded in `<iframe src="data:text/html;…" sandbox="allow-top-navigation-by-user-activation allow-popups">`. The output is **not** passed through DOMPurify in this mode; the frame's sandbox (no `allow-scripts`) is the protection, and the console shows `Blocked script execution in 'data:…'` for the corpus's `<script>` labels.
- **The tokens are replaced with `sandbox=""`.** Mermaid rewrites a `javascript:` link to `about:blank` and targets `_top` in sandbox mode. A click on it navigates the app's own top frame to `about:blank`, and Electron 44.9.2 emits neither `will-navigate` nor `will-frame-navigate` for that (only `did-start-navigation`, which can't cancel). Task C5a5 pins both halves. With `sandbox=""` a diagram link is dead; a read-only viewer loses nothing.
- **Inserted inert:** the returned HTML is parsed in a `<template>` and accepted only as one `IFRAME` with a `sandbox` attribute and a `data:text/html;` source; nothing else reaches the app's DOM.
- **CSP:** the only change is `frame-src data:`.

- [ ] **Step 1: Add the dependency**

Run (`spikes/app`): `npm install --save-exact mermaid@12.2.0`
Expected: `dependencies` gains `"mermaid": "12.2.0"`.

- [ ] **Step 2: Write the failing test**

`spikes/app/e2e/mermaid.e2e.ts`:
<!-- op: create spikes/app/e2e/mermaid.e2e.ts -->
```ts
import { expect, test } from '@playwright/test'
import { HOSTILE_MERMAID, hugeFlowchart } from './hostile'
import { launch } from './launch'

const CORPUS = [
  ...HOSTILE_MERMAID,
  { name: 'at maxTextSize and maxEdges (50,000 chars, 499 edges)', source: hugeFlowchart(499, 50_000) },
  { name: 'over maxTextSize (50,001 chars)', source: hugeFlowchart(100, 50_001) },
  { name: 'over maxEdges (501 edges)', source: hugeFlowchart(501, 0) }
]

test('Mermaid draws hostile sources only inside a sandboxed data: frame; errors show the source with a marker', async () => {
  const { app, win } = await launch('mermaid')
  const r = await win.evaluate(async (corpus) => {
    const u = (window as any).__spike.untrusted
    const card = document.getElementById('card')!
    const bodyBefore = new Set(document.body.children)
    const bodyAdds: string[] = []
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) bodyAdds.push(`${n.nodeName}#${(n as Element).id ?? ''}`)
    }).observe(document.body, { childList: true })
    const out = []
    for (const { name, source } of corpus) {
      const el = document.createElement('div')
      card.append(el)
      const done = u.renderDiagram(el, source)
      const shownFirst = el.querySelector('pre')?.textContent === source
      const t0 = performance.now()
      await done
      const frame = el.querySelector('iframe')
      out.push({
        name,
        ms: Math.round(performance.now() - t0),
        shownFirst,
        children: [...el.children].map((c) => c.localName),
        sandbox: frame?.getAttribute('sandbox') ?? null,
        src: frame?.getAttribute('src')?.slice(0, 30) ?? null,
        problem: el.querySelector('.problem')?.getAttribute('title') ?? null
      })
    }
    await new Promise((ok) => setTimeout(ok, 500))
    return {
      out,
      bodyAdds,
      leaked: [...card.querySelectorAll('img, script, style, a, svg, foreignObject, object, embed, link')].map((e) => e.localName),
      bodyLeft: [...document.body.children].filter((c) => !bodyBefore.has(c)).map((c) => c.nodeName)
    }
  }, CORPUS)
  for (const e of r.out) console.log(`${String(e.ms).padStart(5)} ms  ${e.sandbox !== null ? 'frame  ' : 'problem'}  ${e.name}${e.problem ? '  — ' + e.problem.split('\n')[0] : ''}`)
  const shapes = [...new Set(r.bodyAdds.map((n) => n.replace(/\d+/g, 'N')))]
  console.log(`nodes Mermaid added to <body> (all removed again): ${r.bodyAdds.length}, ${JSON.stringify(shapes)}`)

  for (const e of r.out) {
    expect(e.shownFirst, e.name).toBe(true) // the source shows until the diagram is ready
    if (e.sandbox !== null) {
      expect(e.children, e.name).toEqual(['iframe'])
      expect(e.src, e.name).toBe('data:text/html;charset=UTF-8;b')
      // Mermaid 12.2.0 sets "allow-top-navigation-by-user-activation allow-popups"; renderDiagram replaces it with "".
      expect(e.sandbox, e.name).toBe('')
    } else {
      expect(e.children, e.name).toEqual(['span', 'pre']) // problem marker + source
      expect(e.problem, e.name).toBeTruthy()
    }
  }
  expect(r.leaked).toEqual([]) // the app's DOM gets nothing from a diagram but the frame
  expect(r.bodyLeft).toEqual([]) // everything Mermaid put into <body> while measuring is gone again
  // What Mermaid 12.2.0 does with this corpus at securityLevel 'sandbox' (pinned so a change is noticed):
  expect(r.out.filter((e) => e.problem).map((e) => e.name)).toEqual([
    'flowchart: image shape',
    'flowchart: classDef url(',
    'flowchart: style url(',
    'gitGraph',
    'eventmodeling',
    'over maxEdges (501 edges)'
  ])
  // The frames load and draw (the CSP's frame-src data: allows them): an SVG inside the first one.
  await expect(win.frameLocator('#card iframe').first().locator('svg').first()).toBeAttached()
  await app.close()
})
```
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e mermaid`
Expected: FAIL, `u.renderDiagram is not a function`.

- [ ] **Step 3: Implement the diagram renderer, the CSP and the hook**

`spikes/app/src/renderer/src/mermaid/diagram.ts`:
<!-- op: create spikes/app/src/renderer/src/mermaid/diagram.ts -->
```ts
// Mermaid (spec §4.6, §14 D7): lazy-loaded on the first diagram, at securityLevel 'sandbox' — the diagram is drawn
// inside an iframe whose data: document can run no script. maxTextSize and maxEdges stay at Mermaid's defaults.
type Mermaid = (typeof import('mermaid'))['default']
let loading: Promise<Mermaid> | undefined
let nextId = 0

function showSource(el: HTMLElement, source: string, problem?: string): void {
  const pre = document.createElement('pre')
  pre.className = 'diagram-source'
  pre.textContent = source
  if (problem === undefined) return el.replaceChildren(pre)
  const marker = document.createElement('span')
  marker.className = 'problem'
  marker.title = problem
  marker.textContent = '⚠'
  el.replaceChildren(marker, pre)
}

/** The source shows until the diagram is ready; a render error shows the source plus a problem marker. */
export async function renderDiagram(el: HTMLElement, source: string): Promise<void> {
  showSource(el, source)
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    // suppressErrorRendering: Mermaid's own error diagram would also leave its measuring iframe in document.body.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'sandbox', suppressErrorRendering: true })
    return mermaid
  })
  try {
    const { svg } = await (await loading).render(`mermaid-${nextId++}`, source)
    // Sandbox mode returns one <iframe sandbox src="data:text/html;base64,…"> with the SVG encoded inside.
    // Parse it inert and insert nothing else, so a Mermaid change can't put markup into the app's DOM.
    const t = document.createElement('template')
    t.innerHTML = svg
    const frame = t.content.firstElementChild
    const ok = t.content.childElementCount === 1 && frame?.tagName === 'IFRAME' && frame.hasAttribute('sandbox')
    if (!ok || !frame.getAttribute('src')?.startsWith('data:text/html;')) throw new Error('Mermaid did not return a sandboxed frame')
    // Mermaid sets sandbox="allow-top-navigation-by-user-activation allow-popups". Drop both: a clicked diagram link to
    // about:blank (Mermaid's rewrite of javascript:) navigates the app's top frame, and Electron emits no will-navigate
    // or will-frame-navigate for it. Diagram links go dead; a read-only viewer loses nothing.
    frame.setAttribute('sandbox', '')
    el.replaceChildren(frame)
  } catch (err) {
    showSource(el, source, err instanceof Error ? err.message : String(err))
  }
}
```
In `spikes/app/src/renderer/index.html`, replace:
<!-- op: replace spikes/app/src/renderer/index.html -->
```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
```
with:
```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src data:" />
```
In `spikes/app/src/renderer/src/main.ts`, replace:
<!-- op: replace spikes/app/src/renderer/src/main.ts -->
```ts
import { renderMath, sanitizeMath } from './math/math'
import { PerfLog } from './perf'
import { parseYaml } from './yaml/client'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf, untrusted: { parseYaml, renderMath, sanitizeMath } }
```
with:
```ts
import { renderMath, sanitizeMath } from './math/math'
import { renderDiagram } from './mermaid/diagram'
import { PerfLog } from './perf'
import { parseYaml } from './yaml/client'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf, untrusted: { parseYaml, renderMath, sanitizeMath, renderDiagram } }
```

- [ ] **Step 4: Run it until it passes**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e mermaid`
Expected: `1 passed`. The log lists every corpus entry with its time; 42 draw a frame, and these 6 show the source with a problem marker:
```text
26 ms  problem  flowchart: image shape  — The source image cannot be decoded.
20 ms  problem  flowchart: classDef url(  — Parse error on line 3:
8 ms  problem  flowchart: style url(  — Parse error on line 3:
101 ms  problem  gitGraph  — Cannot read properties of null (reading 'appendChild')
54 ms  problem  eventmodeling  — Cannot read properties of null (reading 'getBBox')
133 ms  problem  over maxEdges (501 edges)  — Edge limit exceeded. 500 edges found, but the limit is 500.
```
The log also prints `nodes Mermaid added to <body> (all removed again): 75, ["IFRAME#imermaid-N","svg#","DIV#cy"]` — its measuring frames, a text-measuring SVG and cytoscape's layout container (mindmap, architecture).

- [ ] **Step 5: Falsify the CSP edit**

In `index.html`, remove `; frame-src data:`. Run: `npm run build`, then `npx playwright test --project=e2e mermaid`.
Expected: `1 failed`: `Error: expect(locator).toBeAttached() failed` for `locator('#card iframe').first().contentFrame().locator('svg').first()`. Without `frame-src data:` the CSP blocks every diagram frame; the structural checks alone would not notice.
Put it back, rebuild, rerun: `1 passed`.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/app/package.json spikes/app/package-lock.json spikes/app/src/renderer/src/mermaid/diagram.ts spikes/app/src/renderer/index.html spikes/app/src/renderer/src/main.ts spikes/app/e2e/mermaid.e2e.ts
git commit -m "spike(c): lazy Mermaid in a sandbox frame (sandbox=\"\"); CSP frame-src data:"
```

---

## Task C5a5: The effects recorder and the zero-effects gate

**Files:**
- Create: `spikes/app/src/main/effects.ts`
- Modify: `spikes/app/src/main/index.ts`, `spikes/app/src/main/core-host.ts`
- Create: `spikes/app/e2e/effects.ts`, `spikes/app/e2e/effects.e2e.ts`

**Interfaces:**
- **Consumes:** plan A Task 3 `spikes/tools/netlog-assert.mjs` (run as a CLI); plan A Task 8's `TYPOSE_NETLOG`, network guard and navigation handlers; `HOSTILE_*` (Task C5a3); `launch` (Task C5a2).
- **Produces:**
  - Main and the core host: with `TYPOSE_EFFECTS=<file>`, `effect(kind, detail)` appends `{ proc, kind, detail }` JSON lines. Kinds: `net` and `proc` (tripwire: the call is logged, then throws), `file` (every path Node's `fs` is handed), `fork`, and from the app `request` (every non-`typose:` URL the guard saw), `serve` (every path `typose://` served), `navigate`/`window-open` (denied), `open` (a document the core opened). `TYPOSE_FALSIFY=protocol` (only with `TYPOSE_EFFECTS`) drops the `typose://` path check.
  - `e2e/effects.ts`: `launchRecorded(name, env?, opened?): Promise<{ app, win, finish(): Promise<EffectsReport> }>`, where `EffectsReport` is `{ netlogVerdict, netlog, requests, dataUrls, tripwire, denied, files, newProcesses, violations }` and `violations` is empty exactly when the gate passes. `opened` lists fixture paths the app may read (C5b passes its Markdown files).

**Design notes:**
- **Five detectors, because each sees something the others can't:**
  1. **NetLog** (plan A's `netlog-assert.mjs`): Chromium's network stack. A request the webRequest guard cancels leaves **no trace** in it — the falsification's `falsify.png` appears 0 times in that NetLog — so it can't see an attempt the guard stopped.
  2. **The guard's request log** (`request`): every non-`typose:` URL `onBeforeRequest` sees, cancelled or not. `data:` (Mermaid's frames) is counted and allowed; anything else is a violation.
  3. **Node tripwire** (`net`, `proc`) in main and the core host: `net.Socket.prototype.connect`, `dns` lookups/resolves (module, promises, both `Resolver` prototypes), `http(s).request/get`, `tls.connect`, `dgram.createSocket`, global `fetch`, Electron `net.fetch/request`, `child_process.*`, `shell.openExternal/openPath/showItemInFolder/trashItem`. A NetLog never shows these. Note: `session.fetch` runs through Electron's `net.request` in main, so the tripwire catches it too.
  4. **File recorder** (`file`, `serve`, `open`, `fork`): every `fs`/`fs.promises` path in main and the core host, every path `typose://` served, every document the core opened (the addon reads in Rust, where `fs` wrapping can't see; `open` is logged at its JS entry). Allowed: `spikes/app/out/`, `spikes/app/node_modules/`, `spikes/core/spike-node/`, and the `opened` fixtures.
  5. **Process diff:** `app.getAppMetrics()` after launch vs at the end. Allowed new types: `GPU` (Chromium starts it lazily, 1–3 s after launch, whatever the content) and `Tab` (the first Mermaid diagram starts one renderer for the sandboxed data: frames; later diagrams reuse it; KaTeX starts nothing). Anything else fails, including a new `Utility`.
- **The recorder can't record itself:** Node 24's `appendFileSync` calls the public `fs.writeFileSync`, so `effect` sets a reentrancy flag while it writes.
- **Falsification, one deliberate effect per detector** (the falsification test asserts each is caught):
  - an `http://127.0.0.1:9/falsify.png` image in a test-only `data:` window with no CSP or sanitizer → request log;
  - the same image from a window in a guard-less partition → NetLog (`request http://127.0.0.1:9/netlog.png`, plus the resolver and IPv6-reachability events it triggers);
  - `dns.lookup('example.invalid')` and `shell.openExternal('https://example.invalid/')` in main → tripwire. The test checks that both functions carry `tripwire: true` **before** any deliberate effect: unwrapped, they would really query DNS and start a browser.
  - a second utility process → process diff;
  - `typose://app/..%2f..%2fpackage.json` with `TYPOSE_FALSIFY=protocol` → file recorder (`spikes/app/package.json`, outside the allowed roots).
- **The navigation gap (pinned):** with Mermaid's own sandbox tokens, main's handlers deny a frame's `_top` navigation to `https://…` (`will-navigate`) and its `_blank` popup (`setWindowOpenHandler`), but a `_top` navigation to `about:blank` reaches neither and replaces the app's page. Task C5a4's `sandbox=""` closes it for diagrams; any other content that can navigate the top frame (a raw `<a href="about:blank">` in Rendered Markdown, for one) needs the renderer to intercept the click (C5b).

- [ ] **Step 1: Write the harness and the failing tests**

`spikes/app/e2e/effects.ts`:
<!-- op: create spikes/app/e2e/effects.ts -->
```ts
// The zero-effects harness (spec §13.1): launches the app with every detector on, and turns what they saw into
// violations. Reusable for any hostile fixture (C5b runs Markdown through it).
import type { ElectronApplication, Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIX, launch } from './launch'

const APP = resolve(__dirname, '..')
// Plan A's CLI, run as is (Playwright's loader can't import an .mjs that uses import.meta).
const NETLOG_ASSERT = resolve(APP, '../tools/netlog-assert.mjs')
/** Where Node in main and the core host may touch files: the app's bundle and dependencies, and the addon. */
const ALLOWED_ROOTS = [join(APP, 'out'), join(APP, 'node_modules'), resolve(APP, '../core/spike-node')].map((p) => p.toLowerCase() + sep)
/**
 * Process types Chromium itself starts after launch: the GPU process (lazily, 1–3 s in, whatever the content) and one
 * renderer ('Tab') for the sandboxed data: frames of Mermaid diagrams, which Chromium isolates out of process.
 * Anything else is a violation, including a Utility process (the core host already runs before the first snapshot).
 */
const CHROMIUM_INTERNAL = new Set(['Tab', 'GPU'])

export interface EffectsReport {
  netlogVerdict: string // netlog-assert.mjs's last line: PASS or FAIL
  netlog: string[] // NetLog violations (Chromium's network stack)
  requests: string[] // every URL the network guard saw other than typose: and data:, cancelled or not
  dataUrls: number // data: URLs the guard saw (Mermaid's frames) — allowed
  tripwire: string[] // Node network and process calls in main and the core host
  denied: string[] // navigations and window opens main refused
  files: string[] // every distinct path Node touched or typose:// served
  newProcesses: string[] // process types that appeared after launch
  violations: string[]
}

interface Proc {
  pid: number
  type: string
  name: string
}

const processes = (app: ElectronApplication): Promise<Proc[]> =>
  app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName ?? '' })))

const pathOf = (detail: string): string => {
  const p = detail.replace(/^"|"$/g, '')
  return p.startsWith('file:') ? fileURLToPath(p) : p
}

/** Launches with all detectors on. `opened` are fixture paths the app may legitimately read. */
export async function launchRecorded(
  name: string,
  env: Record<string, string> = {},
  opened: string[] = []
): Promise<{ app: ElectronApplication; win: Page; finish: () => Promise<EffectsReport> }> {
  const dir = join(FIX, 'effects', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'effects.jsonl')
  const netlog = join(dir, 'netlog.json')
  const { app, win } = await launch(`effects-${name}`, { TYPOSE_EFFECTS: log, TYPOSE_NETLOG: netlog, ...env })
  const before = await processes(app)

  const finish = async (): Promise<EffectsReport> => {
    const after = await processes(app)
    await app.close()
    const lines = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { proc: string; kind: string; detail: string })
      : []
    const report: EffectsReport = {
      netlogVerdict: '',
      netlog: [],
      requests: [],
      dataUrls: 0,
      tripwire: [],
      denied: [],
      files: [],
      newProcesses: [],
      violations: []
    }
    const allowedFile = (p: string): boolean =>
      ALLOWED_ROOTS.some((root) => p.toLowerCase().startsWith(root)) || opened.some((o) => resolve(o).toLowerCase() === p.toLowerCase())
    const files = new Set<string>()
    for (const { proc, kind, detail } of lines) {
      if (kind === 'net' || kind === 'proc') report.tripwire.push(`${proc} ${kind} ${detail}`)
      else if (kind === 'request' && detail.startsWith('data:')) report.dataUrls++
      else if (kind === 'request') report.requests.push(detail)
      else if (kind === 'navigate' || kind === 'window-open') report.denied.push(`${kind} ${detail}`)
      else if (kind === 'file') files.add(pathOf(detail.slice(detail.indexOf(' ') + 1)))
      else files.add(pathOf(kind === 'fork' ? detail.slice(detail.indexOf(' ') + 1) : detail)) // serve, open, fork
    }
    report.files = [...files].sort()
    const cli = existsSync(netlog) ? spawnSync(process.execPath, [NETLOG_ASSERT, netlog], { encoding: 'utf8' }) : null
    const out = cli?.stdout.trim().split('\n') ?? []
    report.netlogVerdict = out.at(-1) ?? 'no NetLog written'
    report.netlog = cli?.status === 0 ? [] : out.length > 1 ? out.slice(0, -1) : [report.netlogVerdict]
    report.newProcesses = after.filter((p) => !before.some((b) => b.pid === p.pid)).map((p) => (p.name ? `${p.type}:${p.name}` : p.type))
    report.violations = [
      ...report.netlog.map((v) => `netlog: ${v}`),
      ...report.requests.filter((u) => !u.startsWith('blob:typose:')).map((u) => `request: ${u}`),
      ...report.tripwire.map((t) => `tripwire: ${t}`),
      ...report.denied.map((d) => `denied: ${d}`),
      ...report.files.filter((f) => !allowedFile(f)).map((f) => `file: ${f}`),
      ...report.newProcesses.filter((p) => !CHROMIUM_INTERNAL.has(p.split(':')[0])).map((p) => `process: ${p}`)
    ]
    return report
  }
  return { app, win, finish }
}
```
`spikes/app/e2e/effects.e2e.ts`:
<!-- op: create spikes/app/e2e/effects.e2e.ts -->
```ts
import { expect, test } from '@playwright/test'
import { launchRecorded } from './effects'
import { HOSTILE_MERMAID, HOSTILE_TEX, HOSTILE_YAML } from './hostile'

test('zero effects: hostile Mermaid, KaTeX and YAML make no request, launch nothing and read no file', async () => {
  const run = await launchRecorded('hostile')
  await run.win.evaluate(
    async ({ mermaid, tex, yaml }) => {
      const u = (window as any).__spike.untrusted
      const card = document.getElementById('card')!
      for (const { source } of mermaid) {
        const el = document.createElement('div')
        card.append(el)
        await u.renderDiagram(el, source)
      }
      for (const t of tex) {
        const el = document.createElement('div')
        card.append(el)
        await u.renderMath(el, t, true)
      }
      for (const y of yaml) await u.parseYaml(new TextEncoder().encode(y).buffer).done.catch(() => {})
      await new Promise((ok) => setTimeout(ok, 2_000)) // let the frames load and anything late fire
    },
    { mermaid: HOSTILE_MERMAID, tex: HOSTILE_TEX, yaml: HOSTILE_YAML }
  )
  const report = await run.finish()
  console.log(JSON.stringify(report, null, 2))
  expect(report.violations).toEqual([])
})

test('a link inside a diagram can neither navigate the app nor open a window', async () => {
  const run = await launchRecorded('click')
  await run.win.evaluate(async (source) => {
    const el = document.createElement('div')
    document.getElementById('card')!.append(el)
    await (window as any).__spike.untrusted.renderDiagram(el, source)
  }, HOSTILE_MERMAID.find((m) => m.name === 'flowchart: click and href')!.source)
  const url = run.win.url()
  const anchors = run.win.frameLocator('#card iframe').locator('a') // the frame runs in its own renderer process
  await anchors.first().waitFor({ state: 'attached' })
  const links = await anchors.count()
  for (let i = 0; i < links; i++) await anchors.nth(i).click({ force: true }) // real input: the frame gets user activation
  await run.win.waitForTimeout(1_000)
  expect(run.win.url()).toBe(url)
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  const report = await run.finish()
  console.log(JSON.stringify({ links, denied: report.denied, violations: report.violations }))
  expect(links).toBe(3)
  expect(report.violations).toEqual([]) // sandbox="": a click can't even ask main to navigate
})

test("main denies a frame's top navigation and popup, but never sees a top navigation to about:blank", async () => {
  // A test-only frame with Mermaid's own tokens: checks main's handlers, and pins the gap the sandbox="" override closes.
  const run = await launchRecorded('handlers')
  await run.win.evaluate(() => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-top-navigation-by-user-activation allow-popups')
    f.src =
      'data:text/html,' +
      encodeURIComponent(
        '<a id=top href="https://example.invalid/t" target="_top">t</a> <a id=pop href="https://example.invalid/p" target="_blank">p</a> <a id=blank href="about:blank" target="_top">b</a>'
      )
    document.getElementById('card')!.append(f)
  })
  const frame = run.win.frameLocator('#card iframe')
  const url = run.win.url()
  await frame.locator('#top').click()
  await frame.locator('#pop').click()
  await run.win.waitForTimeout(500)
  expect(run.win.url()).toBe(url)
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await frame.locator('#blank').click()
  await run.win.waitForURL('about:blank') // the gap: no will-navigate, and the app's page is gone
  const report = await run.finish()
  console.log(JSON.stringify({ denied: report.denied, violations: report.violations }))
  expect(report.denied).toEqual(['navigate https://example.invalid/t', 'window-open https://example.invalid/p'])
  expect(report.violations.filter((v) => !v.startsWith('denied: '))).toEqual([])
})

test('every detector fails the gate when its effect happens (falsification)', async () => {
  // TYPOSE_FALSIFY=protocol: main's typose:// handler skips its path check, to show an out-of-bundle read is caught.
  const run = await launchRecorded('falsify', { TYPOSE_FALSIFY: 'protocol' })
  // Armed first: without the tripwire, the DNS lookup and shell.openExternal below would really happen.
  const armed = await run.app.evaluate(({ shell }) => ({
    lookup: (process.getBuiltinModule('node:dns').lookup as unknown as { tripwire?: boolean }).tripwire,
    openExternal: (shell.openExternal as unknown as { tripwire?: boolean }).tripwire
  }))
  expect(armed).toEqual({ lookup: true, openExternal: true })
  // Network, guard + counter: an http image in a test-only page without the app's CSP or sanitizer.
  await run.app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false })
    await w.loadURL('data:text/html,<img src="http://127.0.0.1:9/falsify.png">')
    await new Promise((ok) => setTimeout(ok, 500))
    w.destroy()
  })
  // Network, NetLog: the same from a page in a session without the guard (loopback, unsafe port: nothing leaves the
  // machine). Not session.fetch: that runs through Electron's net.request in main, which the Node tripwire blocks.
  await run.app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { partition: 'falsify' } })
    await w.loadURL('data:text/html,<img src="http://127.0.0.1:9/netlog.png">')
    await new Promise((ok) => setTimeout(ok, 500))
    w.destroy()
  })
  // Network, Node tripwire: a DNS lookup in main.
  await run.app.evaluate(() => {
    try {
      process.getBuiltinModule('node:dns').lookup('example.invalid', () => {})
    } catch {}
  })
  // Process, tripwire: shell.openExternal.
  await run.app.evaluate(({ shell }) => {
    try {
      void shell.openExternal('https://example.invalid/')
    } catch {} // the tripwire throws synchronously
  })
  // Process, metrics diff: a second utility process (the core host's own entry, which idles).
  await run.app.evaluate(({ app, utilityProcess }) => {
    const { join } = process.getBuiltinModule('node:path')
    const chunks = join(app.getAppPath(), 'out', 'main', 'chunks')
    const entry = process.getBuiltinModule('node:fs').readdirSync(chunks).find((f: string) => f.startsWith('core-host'))
    const child = utilityProcess.fork(join(chunks, entry), [], { serviceName: 'falsify' })
    return new Promise((ok) => child.once('spawn', ok))
  })
  // Files: an out-of-bundle read through typose:// (the app's own package.json).
  const status = await run.win.evaluate(() => fetch('typose://app/..%2f..%2fpackage.json').then((r) => r.status))
  const report = await run.finish()
  console.log(JSON.stringify({ status, ...report }, null, 2))
  expect(report.requests.some((u) => u.includes('falsify.png'))).toBe(true)
  expect(report.netlog.some((v) => v.includes('127.0.0.1:9/netlog.png'))).toBe(true)
  expect(report.tripwire.some((t) => t.includes('lookup example.invalid'))).toBe(true)
  expect(report.tripwire.some((t) => t.includes('openExternal'))).toBe(true)
  expect(report.newProcesses.some((p) => p.includes('falsify'))).toBe(true)
  expect(report.violations.some((v) => v.startsWith('file: ') && v.endsWith('package.json'))).toBe(true)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e effects`
Expected: `2 failed`, `2 passed`. The handlers test gets `denied: []` (nothing reports yet). The falsification test stops at its first assertion, `{ lookup: undefined, openExternal: undefined }`, before any deliberate effect. The zero-effects and diagram-click tests pass vacuously at this point, since nothing is recorded yet; the falsification test is what lets the gate fail.

- [ ] **Step 3: Implement the recorder and report effects from main and the core host**

`spikes/app/src/main/effects.ts`:
<!-- op: create spikes/app/src/main/effects.ts -->
```ts
// Test-only effects recorder for the zero-effects gate (spec §13.1, §7.3). Inert unless TYPOSE_EFFECTS names a log file.
// Imported first by main and by the core host. It appends one JSON line per effect to the log:
// - net / proc: every Node network or process call (the tripwire); the call then throws, so nothing leaves the machine;
// - file: every path Node's fs is handed;
// - whatever the app reports through `effect` (requests the network guard saw, paths typose:// served,
//   navigations and window opens it denied, documents the core opened).
// The NetLog covers Chromium's network stack; this covers Node's, which a NetLog never shows.
import { net, shell, utilityProcess } from 'electron'

type Effect = (kind: string, detail: string) => void
type Obj = Record<string, unknown>

function describe(arg: unknown): string {
  try {
    return typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? String(arg))
  } catch {
    return String(arg)
  }
}

function install(log: string): Effect {
  const builtin = (name: string): Obj => process.getBuiltinModule(name) as Obj
  const fs = builtin('node:fs') as unknown as typeof import('node:fs')
  const append = fs.appendFileSync
  const proc = process.type ?? 'node' // 'browser' in main, 'utility' in the core host
  let writing = false // appendFileSync itself calls the (wrapped) fs.writeFileSync
  const effect: Effect = (kind, detail) => {
    writing = true
    try {
      append(log, JSON.stringify({ proc, kind, detail }) + '\n')
    } finally {
      writing = false
    }
  }
  const isPath = (a: unknown): boolean => typeof a === 'string' || a instanceof URL || Buffer.isBuffer(a)
  const wrap = (obj: unknown, names: string[] | RegExp, kind: string, block: boolean, onlyPaths = false): void => {
    const o = obj as Obj | undefined
    if (!o) return // e.g. shell and utilityProcess don't exist in the core host
    const list = Array.isArray(names) ? names : Object.getOwnPropertyNames(o).filter((n) => names.test(n))
    for (const name of list) {
      const orig = o[name]
      if (typeof orig !== 'function') continue
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        if (!writing && (!onlyPaths || isPath(args[0]))) effect(kind, `${name} ${describe(args[0])}`)
        if (block) throw new Error(`effects tripwire: ${kind} ${name}`)
        return orig.apply(this, args)
      }
      Object.assign(wrapped, orig, { tripwire: true }) // keeps fs.realpathSync.native and the like
      o[name] = wrapped
    }
  }

  const dns = builtin('node:dns') as unknown as typeof import('node:dns')
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype])
    wrap(target, /^(lookup|resolve|reverse)/, 'net', true)
  wrap((builtin('node:net') as unknown as typeof import('node:net')).Socket.prototype, ['connect'], 'net', true)
  wrap(builtin('node:http'), ['request', 'get'], 'net', true)
  wrap(builtin('node:https'), ['request', 'get'], 'net', true)
  wrap(builtin('node:tls'), ['connect'], 'net', true)
  wrap(builtin('node:dgram'), ['createSocket'], 'net', true)
  wrap(globalThis, ['fetch'], 'net', true)
  wrap(net, ['fetch', 'request'], 'net', true)

  wrap(builtin('node:child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'proc', true)
  wrap(shell, ['openExternal', 'openPath', 'showItemInFolder', 'trashItem'], 'proc', true)
  wrap(utilityProcess, ['fork'], 'fork', false) // main forks the core host itself

  wrap(fs, /^[a-z]/, 'file', false, true)
  wrap(fs.promises, /^[a-z]/, 'file', false, true)
  return effect
}

export const effect: Effect | undefined = process.env.TYPOSE_EFFECTS ? install(process.env.TYPOSE_EFFECTS) : undefined
```
In `spikes/app/src/main/index.ts`, replace:
<!-- op: replace spikes/app/src/main/index.ts -->
```ts
import { app, BrowserWindow, MessageChannelMain, protocol, session, utilityProcess } from 'electron'
```
with:
```ts
import { effect } from './effects'
import { app, BrowserWindow, MessageChannelMain, protocol, session, utilityProcess } from 'electron'
```
replace:
<!-- op: replace spikes/app/src/main/index.ts -->
```ts
    const file = join(rendererDir, decodeURIComponent(new URL(req.url).pathname))
    if (!file.startsWith(rendererDir + sep)) return new Response('bad path', { status: 400 })
```
with:
```ts
    const file = join(rendererDir, decodeURIComponent(new URL(req.url).pathname))
    effect?.('serve', file)
    // Test-only: with TYPOSE_EFFECTS set, TYPOSE_FALSIFY=protocol drops this check so the gate can show it catches the read.
    const falsify = effect && process.env.TYPOSE_FALSIFY === 'protocol'
    if (!file.startsWith(rendererDir + sep) && !falsify) return new Response('bad path', { status: 400 })
```
replace:
<!-- op: replace spikes/app/src/main/index.ts -->
```ts
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !ALLOWED.test(details.url) })
  })
```
with:
```ts
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith('typose:')) effect?.('request', details.url.slice(0, 200))
    callback({ cancel: !ALLOWED.test(details.url) })
  })
```
and replace:
<!-- op: replace spikes/app/src/main/index.ts -->
```ts
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
```
with:
```ts
  win.webContents.on('will-navigate', (e) => {
    effect?.('navigate', e.url)
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    effect?.('window-open', url)
    return { action: 'deny' }
  })
```
In `spikes/app/src/main/core-host.ts`, replace:
<!-- op: replace spikes/app/src/main/core-host.ts -->
```ts
import type { MessagePortMain } from 'electron'
import { Doc, coreVersion } from 'spike-node'
```
with:
```ts
import { effect } from './effects'
import type { MessagePortMain } from 'electron'
import { Doc, coreVersion } from 'spike-node'
```
and replace:
<!-- op: replace spikes/app/src/main/core-host.ts -->
```ts
    open: ({ path }: { path: string }) => {
      const doc = Doc.open(path)
```
with:
```ts
    open: ({ path }: { path: string }) => {
      effect?.('open', path) // the addon reads in Rust, where the fs tripwire can't see
      const doc = Doc.open(path)
```

- [ ] **Step 4: Run them until they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e effects`
Expected: `4 passed`. The zero-effects report prints:
- **zero effects:** `"netlogVerdict": "PASS: no Chromium network-stack activity (Node sockets in main/core host are not covered)"`, `"netlog": []`, `"requests": []`, `"dataUrls": 40`, `"tripwire": []`, `"denied": []`, 117 file paths (1 under `out/main` — the core-host entry main forks — and 116 under `out/renderer`), `"newProcesses": ["GPU:GPU", "Tab"]` (or just `["Tab"]` when the GPU process was already up), `"violations": []`;
- **diagram links:** `{"links":3,"denied":[],"violations":[]}`;
- **handlers:** `{"denied":["navigate https://example.invalid/t","window-open https://example.invalid/p"], ...}` and the page is `about:blank` after the third click;
- **falsification:** `"status": 200` (the traversal was served), `"netlogVerdict": "FAIL: 7 violation(s)"` (`request http://127.0.0.1:9/netlog.png`, three `HOST_RESOLVER_*` events, an IPv6-reachability check and two `UDP_CONNECT`s), `"requests": ["http://127.0.0.1:9/falsify.png"]`, `"tripwire": ["browser net lookup example.invalid", "browser proc openExternal https://example.invalid/"]`, `"newProcesses": ["GPU:GPU", "Utility:falsify"]`, and 12 violations including `file: …\spikes\app\package.json` and `process: Utility:falsify`.

- [ ] **Step 5: The NetLog assertion's own verdict on the hostile run**

Run (`spikes/tools`): `node netlog-assert.mjs ../.fixtures/effects/hostile/netlog.json`
Expected: `PASS: no Chromium network-stack activity (Node sockets in main/core host are not covered)` — the Node side is covered by the tripwire above.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/main/effects.ts spikes/app/src/main/index.ts spikes/app/src/main/core-host.ts spikes/app/e2e/effects.ts spikes/app/e2e/effects.e2e.ts
git commit -m "spike(c): zero-effects gate: NetLog, request log, Node tripwire, fs recorder, process diff; each falsified"
```

---

## Task C5a6: YAML worker throughput, main-thread frames and memory → `yaml.treeMaxBytes`

**Files:**
- Create: `spikes/app/perf/yaml.e2e.ts`
- Create: `spikes/results/yaml-<hostname>.json` (from the run)

**Interfaces:**
- **Consumes:** `launch` (Task C5a2), `window.__spike.untrusted.parseYaml` and plan A's `window.__spike.perf` (`startFrames`/`stopFrames`), `percentile` (plan A Task 3).
- **Produces:** `spikes/results/yaml-<hostname>.json`, one key per `yaml:<shape>:<n>MiB`: `{ n, bytes, p50, max, parseMsP50, mibPerSec, nodes, errors, longFrames, frames, maxFrameGap, memPeakMB, memDeltaMB, failed?, samples }`. `p50`/`max` are wall time from handing the bytes to the worker until the tree is back on the main thread; `parseMsP50` is `buildTree`'s own time inside the worker. Memory is the renderer process's private bytes (the worker lives in it), sampled from main every 50 ms.
- **Knobs:** `RUNS` (default 5), `SIZES` in MiB (default `1,4,16,32,64,128`).

**Design notes:**
- **Shapes:** `k8s` (multi-document Deployments and ConfigMaps with flow maps, comments and block scalars), `ci` (GitLab-style jobs with `&defaults` anchors re-defined every 50 jobs and `<<: *defaults`), `list` (a long sequence of flat maps). Each has some non-ASCII text, so the byte table isn't trivially uniform.
- **The YAML is generated in the page** (`stash`), so 128 MiB never crosses Playwright; each run re-encodes it, because the parse transfers (detaches) the buffer.
- **Frames:** plan A's rAF sampler runs from just before the hand-off until two frames after the tree arrives, so the delivery itself is inside the window.
- **One launch per shape** (three tests), so each shape starts from a clean renderer heap.
- **A size can fail two ways, and the runner records either instead of hanging:** no tree after 120 s (the page cancels the parse), or the renderer dies — a dead renderer never answers Playwright's `evaluate`, so each run also races main's `render-process-gone`. A failed size skips the larger sizes of that shape. Without the race, a run stalls on `ci` at 128 MiB until Playwright's 30-minute test timeout: the renderer is gone (`render-process-gone`, reason `oom`), and the 120 s cap's timer died with it.

- [ ] **Step 1: Write the runner and do a quick run**

`spikes/app/perf/yaml.e2e.ts`:
<!-- op: create spikes/app/perf/yaml.e2e.ts -->
```ts
// YAML worker throughput (spec §4.5: yaml.treeMaxBytes at about 2 s of worker parse time), main-thread frames while it
// parses, and renderer memory. RUNS (default 5) samples per size; SIZES in MiB (default 1,4,16,32,64,128).
import { test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { launch } from '../e2e/launch'
import { percentile } from '../src/renderer/src/perf'

const OUT = resolve(__dirname, `../../results/yaml-${hostname()}.json`)
const RUNS = Number(process.env.RUNS ?? 5)
const SIZES = (process.env.SIZES ?? '1,4,16,32,64,128').split(',').map(Number)
const SHAPES = ['k8s', 'ci', 'list']

/** Runs in the page: builds realistic YAML of `shape`, at least `mib` MiB, into window.__src. Returns its length. */
function stash([shape, mib]: [string, number]): number {
  const k8s = (i: number): string => `---
# service ${i}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: svc-${i}
  namespace: prod
  labels: {app: svc-${i}, tier: backend, owner: équipe-${i % 7}}
  annotations:
    deployment.kubernetes.io/revision: "${i % 13}"
spec:
  replicas: ${1 + (i % 5)}
  selector:
    matchLabels:
      app: svc-${i}
  template:
    metadata:
      labels:
        app: svc-${i}
    spec:
      containers:
        - name: app
          image: registry.example.com/svc-${i}:1.${i % 10}.3
          ports:
            - containerPort: 8080
              protocol: TCP
          env:
            - name: LOG_LEVEL
              value: info # overridden in staging
            - name: DB_URL
              valueFrom:
                secretKeyRef: {name: db, key: url}
          resources:
            limits: {cpu: 500m, memory: 512Mi}
          args: ["--port=8080", "--name=svc-${i}"]
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg-${i}
data:
  app.yaml: |
    server:
      port: 8080
      greeting: "héllo ${i}"
    features: [a, b, c]
`
  const ci = (i: number): string =>
    (i % 50 === 0
      ? `.defaults-${i}: &defaults
  image: node:24
  retry: 2
  tags: [linux, docker]
  variables:
    LANG: C.UTF-8
`
      : '') +
    `job-${i}:
  <<: *defaults
  stage: ${['build', 'test', 'deploy'][i % 3]}
  script:
    - npm ci
    - npm test -- --shard=${i}/1000
    - echo "done ${i} ✓"
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: always
  artifacts:
    paths: [coverage/, reports/junit-${i}.xml] # keep for 7 days
    expire_in: 7 days
`
  const list = (i: number): string => `- id: ${i}
  name: "Café ${i}"
  price: ${(i * 1.37).toFixed(2)}
  active: ${i % 2 === 0}
  tags: [a${i % 10}, b, c]
  created: 2024-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z
  note: ${i % 3 ? 'null' : `"second line ${i}"`}
`
  const record = shape === 'k8s' ? k8s : shape === 'ci' ? ci : list
  const parts: string[] = []
  let length = 0
  for (let i = 0; length < mib * 2 ** 20; i++) {
    const r = record(i)
    parts.push(r)
    length += r.length
  }
  ;(window as any).__src = parts.join('')
  return (window as any).__src.length
}

const load = (): Record<string, unknown> => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {})
const save = (key: string, value: unknown): void => {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({ ...load(), [key]: value }, null, 2))
}

/** Resolves with a reason once main sees the window's renderer die: an out-of-memory in the worker kills the whole renderer. */
async function rendererGone(app: ElectronApplication, stop: { done: boolean }): Promise<string | null> {
  while (!stop.done) {
    await new Promise((ok) => setTimeout(ok, 1_000))
    const gone = await app.evaluate(() => (globalThis as any).__gone as { reason: string; exitCode: number } | undefined)
    if (gone) return `renderer gone: ${gone.reason} (exit code ${gone.exitCode})`
  }
  return null
}

// One launch per shape, so each starts from a clean renderer heap.
for (const shape of SHAPES) {
  test(`YAML worker (${shape}): throughput, main-thread frames and renderer memory`, async () => {
    const { app, win } = await launch(`perf-yaml-${shape}`)
    const pid = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      wc.on('render-process-gone', (_e, details) => ((globalThis as any).__gone = details))
      return wc.getOSProcessId()
    })
    for (const mib of SIZES) {
      await win.evaluate(stash, [shape, mib])
      const runs = []
      for (let i = 0; i < RUNS; i++) {
        // Renderer memory (the worker runs in the renderer process), sampled from main every 50 ms.
        await app.evaluate(({ app: a }, p) => {
          const g = globalThis as any
          const kb = (): number => {
            const m = a.getAppMetrics().find((x) => x.pid === p)?.memory
            return m ? (m.privateBytes ?? m.workingSetSize) : 0
          }
          g.__mem = { base: kb(), peak: 0 }
          g.__memTimer = setInterval(() => (g.__mem.peak = Math.max(g.__mem.peak, kb())), 50)
        }, pid)
        const stop = { done: false }
        const parse = win.evaluate(async () => {
          const s = (window as any).__spike
          const bytes = new TextEncoder().encode((window as any).__src).buffer
          const size = bytes.byteLength
          s.perf.startFrames()
          const t0 = performance.now()
          try {
            const job = s.untrusted.parseYaml(bytes)
            // The UI would give up too: cancel after 120 s and record it rather than hang the run.
            const cap = new Promise<never>((_, no) =>
              setTimeout(() => {
                job.cancel()
                no(new Error('no tree after 120 s; cancelled'))
              }, 120_000)
            )
            const tree = await Promise.race([job.done, cap])
            const ms = performance.now() - t0
            await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))) // the frames after delivery
            return { size, ms, parseMs: tree.parseMs, nodes: tree.kind.length, errors: tree.errors.length, frames: s.perf.stopFrames() }
          } catch (err) {
            return { size, ms: performance.now() - t0, failed: String(err), frames: s.perf.stopFrames() }
          }
        })
        // A dead renderer never answers the evaluate above, so race it against main's render-process-gone.
        const dead = rendererGone(app, stop).then((reason) =>
          reason ? { size: NaN, ms: NaN, failed: reason, frames: { frames: 0, longFrames: 0, maxGap: 0 } } : new Promise<never>(() => {})
        )
        const run: { size: number; ms: number; parseMs?: number; nodes?: number; errors?: number; failed?: string; frames: { frames: number; longFrames: number; maxGap: number } } =
          await Promise.race([parse, dead])
        stop.done = true
        const mem = await app.evaluate(() => {
          const g = globalThis as any
          clearInterval(g.__memTimer)
          return g.__mem as { base: number; peak: number }
        })
        runs.push({ ...run, memPeakMB: mem.peak / 1024, memDeltaMB: (mem.peak - mem.base) / 1024 })
        if (run.failed) break
      }
      const ok = runs.filter((r) => !r.failed)
      const ms = ok.map((r) => r.ms)
      const bytes = runs.find((r) => r.size > 0)?.size ?? null
      const summary = {
        n: ok.length,
        bytes,
        p50: percentile(ms, 50),
        max: Math.max(...ms),
        parseMsP50: percentile(ok.map((r) => r.parseMs!), 50),
        mibPerSec: bytes === null ? null : bytes / 2 ** 20 / (percentile(ms, 50) / 1000),
        nodes: ok[0]?.nodes,
        errors: ok[0]?.errors,
        longFrames: runs.reduce((s, r) => s + r.frames.longFrames, 0),
        frames: runs.reduce((s, r) => s + r.frames.frames, 0),
        maxFrameGap: Math.max(...runs.map((r) => r.frames.maxGap)),
        memPeakMB: Math.max(...runs.map((r) => r.memPeakMB)),
        memDeltaMB: Math.max(...runs.map((r) => r.memDeltaMB)),
        failed: runs.find((r) => r.failed)?.failed,
        samples: ms
      }
      console.log(`${shape} ${mib} MiB: ${JSON.stringify({ ...summary, samples: undefined })}`)
      save(`yaml:${shape}:${mib}MiB`, summary)
      if (summary.failed) break // larger sizes of this shape fail the same way (and a dead renderer can't go on)
    }
    await app.close()
  })
}
```
Run (`spikes/app`): `npm run build`, then
- PowerShell: `$env:SIZES='1,4'; $env:RUNS=2; npx playwright test --project=perf yaml; Remove-Item Env:SIZES, Env:RUNS`
- Git Bash: `SIZES=1,4 RUNS=2 npx playwright test --project=perf yaml`

Expected: `3 passed`, six `<shape> <n> MiB: {...}` lines. Delete `spikes/results/yaml-<hostname>.json` afterwards.

- [ ] **Step 2: The measured run**

Run (`spikes/app`): `npx playwright test --project=perf yaml` (about 10 minutes on Zack's PC).
Expected: `3 passed (9.7m)`; `spikes/results/yaml-<hostname>.json` holds 18 `yaml:*` keys. `ci` and `list` at 128 MiB record `failed: "renderer gone: oom (exit code -536870904)"` with `n: 0`. Measured on Zack's PC (n = 5 per row; p50/max wall, ms):

| Shape | Size | n | p50 ms | max ms | worker parse p50 ms | MiB/s | nodes | long frames / frames | max frame gap ms | renderer peak / Δ MB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| k8s | 1 MiB | 5 | 257 | 353 | 248 | 3.90 | 155252 | 1 / 506 | 73.2 | 143 / 74 |  |
| k8s | 4 MiB | 5 | 850 | 864 | 839 | 4.72 | 616568 | 0 / 1211 | 9.0 | 370 / 140 |  |
| k8s | 16 MiB | 5 | 3182 | 3200 | 3173 | 5.04 | 2453248 | 4 / 4506 | 24.4 | 1298 / 537 |  |
| k8s | 32 MiB | 5 | 6306 | 6382 | 6297 | 5.08 | 4891696 | 14 / 12163 | 60.3 | 2748 / 777 |  |
| k8s | 64 MiB | 5 | 12084 | 12849 | 12063 | 5.31 | 9768888 | 7 / 14456 | 105.1 | 6039 / 1956 |  |
| k8s | 128 MiB | 5 | 25743 | 27676 | 25729 | 4.98 | 19481832 | 13 / 27196 | 215.7 | 7520 / 2288 |  |
| ci | 1 MiB | 5 | 240 | 274 | 229 | 4.19 | 129890 | 1 / 451 | 43.3 | 200 / 114 |  |
| ci | 4 MiB | 5 | 789 | 794 | 777 | 5.11 | 515730 | 0 / 1108 | 9.1 | 475 / 171 |  |
| ci | 16 MiB | 5 | 3197 | 4515 | 3126 | 5.04 | 2046530 | 7 / 4239 | 39.6 | 1707 / 907 |  |
| ci | 32 MiB | 5 | 6099 | 7624 | 6090 | 5.28 | 4081686 | 7 / 7451 | 77.4 | 3405 / 1382 |  |
| ci | 64 MiB | 5 | 12066 | 12372 | 12056 | 5.34 | 8109706 | 14 / 23620 | 175.2 | 6866 / 2385 |  |
| ci | 128 MiB | 0 | — | — | — | — | — | 0 / 0 | 0.0 | 7606 / 1345 | renderer gone: oom (exit code -536870904) |
| list | 1 MiB | 5 | 303 | 340 | 294 | 3.33 | 198877 | 1 / 580 | 55.6 | 227 / 156 |  |
| list | 4 MiB | 5 | 1053 | 1146 | 1045 | 3.83 | 780152 | 0 / 2099 | 8.7 | 632 / 253 |  |
| list | 16 MiB | 5 | 4438 | 4462 | 4430 | 3.63 | 3082402 | 9 / 8529 | 22.9 | 2188 / 1178 |  |
| list | 32 MiB | 5 | 8111 | 9612 | 8102 | 3.97 | 6103527 | 14 / 16610 | 65.1 | 4535 / 1987 |  |
| list | 64 MiB | 5 | 18422 | 18837 | 18409 | 3.50 | 12145727 | 9 / 25916 | 98.6 | 7662 / 3478 |  |
| list | 128 MiB | 0 | — | — | — | — | — | 0 / 0 | 0.0 | 7916 / 1081 | renderer gone: oom (exit code -536870904) |

"renderer peak / Δ" is the renderer's private bytes at its highest during a size, and that peak minus the level before the parse. The base grows within a launch: terminated workers' memory comes back lazily.

- [ ] **Step 3: Set `yaml.treeMaxBytes`**

Set **`yaml.treeMaxBytes` = 8 MiB (8,388,608 bytes)**, not the spec's proposed 32 MiB (spec §4.5, §14 D11).
- **Time:** between 4 and 16 MiB the p50 grows linearly. Interpolated to 2.0 s, that's about 10 MiB for `k8s` and `ci` (≈ 5 MiB/s) and 7.4 MiB for `list` (≈ 3.6–3.8 MiB/s), so 8 MiB lands near 1.6 s for `k8s`/`ci` and 2.2 s for `list`. At 32 MiB the p50 is 6.1–8.1 s.
- **Memory:** the renderer grows 140–253 MB at 4 MiB and 537–1,178 MB at 16 MiB; at 128 MiB, `ci` and `list` kill it (`oom`). The densest input at 8 MiB (4.19M nodes, Task C5a2) parses in about 6 s and the renderer survives: an adversarial file under the ceiling is slow, not fatal, and the user can cancel it.
- **Frames:** up to 4 MiB a parse leaves 0 long frames (max rAF gap ≤ 9.1 ms). Long frames start at 16 MiB (max gap 23–40 ms) and reach 216 ms at 128 MiB. One long frame at 1 MiB per launch (43–73 ms) is the first parse after launch.
- Spec text: "YAML Tree is available up to `yaml.treeMaxBytes` (default **8 MiB**, about 2 s of worker parse time and well clear of the renderer's memory limit on Zack's PC)". Brief §5.5 and §8.2 change from "proposed 32MB" to 8 MB. Raw stays available above it.

- [ ] **Step 4: Read your own work (rule 8), then commit**

```bash
git add spikes/app/perf/yaml.e2e.ts spikes/results/yaml-*.json
git commit -m "spike(c): YAML worker throughput; yaml.treeMaxBytes from measurement"
```

---

## Task C5a7: Whole-suite check

- [ ] **Step 1: Run everything**

Run (`spikes/app`): `npx vitest run`
Expected: `Test Files  5 passed (5)`, `Tests  24 passed (24)` (plan A's 11, Task C1a's 3, Task C5a1's 7, Task C5a3's 3).

Run (`spikes/app`): `npm run build`, then `npm run e2e`
Expected: `11 passed` (plan A's 3; `yaml` 1, `math` 2, `mermaid` 1, `effects` 4).

Under heavy machine load, plan A's own `#status` expects (5 s) can time out while the core host starts slowly; that's environmental — rerun when the machine is quiet.

- [ ] **Step 2: Clean up**

Delete `spikes/.fixtures/effects/` and `spikes/.fixtures/profiles/` (logs, NetLogs and private profiles from the runs; gitignored).

---

## Task C5b1: The Spike C core through napi and the core host

**What Tasks C5b1–C5b5 prove (spec §13.1 Spike C, end to end in the app):**
- The Spike C core reaches the app: napi exposes the verified copy path (`Source`: generations, `read`, `reload`), Markdown items (`MdView`: `page`, `reconcile`, `outline`, a background index) and cancellable index jobs for Markdown, JSON and CSV; the core host speaks them over plan A's port protocol.
- A minimal **Rendered** lens inserts the core's already-sanitized HTML item by item in a windowed list, hydrates math with C5a's KaTeX worker and Mermaid with C5a's sandboxed frame, and leaves image placeholders inert. The renderer never parses Markdown.
- **The pairing contract holds after hydration.** Run k is the k-th Text node of a *freshly inserted* item (Task C4b's pairing contract); hydration replaces placeholder content, so each Text node is bound to its run in a `WeakMap` at insertion, before anything hydrates. An endpoint inside hydrated math or a diagram snaps to the placeholder's whole source span.
- **Selection → copy:** 240 random selections (UTF-8 and UTF-16LE) against a generator oracle, plus 14 hand-picked cases per encoding (entities, escapes, CJK, astral characters, across items, after hydrated math), copy exactly the file's bytes; a copy is refused once the file changes and for a stale generation after reload.
- **No link navigates.** Every `<a>` click (plain, Ctrl, Shift, middle, Enter) is intercepted in the renderer and logged with its target (`data-href` when C4's link contract put it there, else `href`); main's `will-navigate` and window-open handlers never even see a request. A Rust probe shows no sanitizer output carries `target`, a form, `base`, `meta`, `area` or a frame.
- **Giant Markdown (Zack's ruling Z30).** Raw opens at once while Rendered indexes in the core host. The Markdown and CSV index jobs report progress (bytes and blocks or records so far) at most 10 times a second, and the Rendered lens shows it in a `role="status"` line; cancel still stops a job within 50 ms.
- **The memory budget (Z34).** An index that stops early says why: a job's last event carries `reason`, `TOO_MANY_BLOCKS` when Markdown indexing stops at `MdConfig::max_blocks`, `UTF16_REFUSED` for a UTF-16 CSV. On `TOO_MANY_BLOCKS` the Rendered lens stops whole and announces the reason and that Raw stays available; Raw still opens and pages the file.
- **Gates, measured in the app:** the oversized fence (first-screen gate, no mounted item over 64 KiB), hostile inputs (Raw's first screen while the format index runs in the core host, Raw's full line scan as a metric of its own (Z37), then cancel timed in the core host), zero effects for hostile Markdown, Mermaid and KaTeX in Rendered, with each detector falsified in the same setting.

**Constraints for Tasks C5b1–C5b5 (on top of the plan's):**
- Every Electron launch in these tasks goes through C5a's `e2e/launch.ts` (a fresh private `--user-data-dir`, zoom asserted 1) or C5a's `launchRecorded`. Plan A's three baseline e2e tests launch without a profile: run them with a private one (this plan's replay added a `--user-data-dir` per launch from the Playwright side).
- **Offsets reach JavaScript as numbers, exact up to 2^53 − 1 bytes (8 PiB).** `Source.open` refuses a larger file; byte maps travel as `ByteMap::to_json` inside a JSON string that the core host parses.
- Hostile fixtures name only `.invalid` hosts and loopback port 9, as in C5a.
- Disk: Task C5b1's napi test writes and deletes a 59 MB and a 120 MB file; Task C5b2's tests leave a 59 MB Markdown file in `spikes/.fixtures/rendered/`; Task C5b3 writes 498 small files (28 KB); Task C5b4 writes about 630 MB of fixtures into `spikes/.fixtures/`; Task C5b5 deletes them.

**Dependency additions:** `spikes/core/spike-node/Cargo.toml` gains `encoding_rs = "0.8.42"` and `serde_json = "1"` (both already in `Cargo.lock` through `spike-core`; the lock gains two lines under `spike-node`). No npm dependency is added.

**C0–C4 API these tasks use:** `MdDoc::{new, page, reconcile, index_all, index}` (`index().headings` and `index().done` are the outline; `index().stopped` is a stop's reason), `MdConfig::max_blocks`, `ByteMap::to_json`, `Document::{open, read, reload, generation, len, store}`, `ByteStore::{open, open_with, hashes, read}` plus the new `open_shared`, `encoding::sniff`, `json::scan`, `csv::{sniff, build, CsvConfig}` (with `encoding`) and `CsvIndex::refused`. `first_screen` is `page((0, 0), n)`; an anchored open is `page((block, 0), n)`.

**How these tasks follow the fixes made after the plan's first review (round 1):**
- **Links (fix 8).** Every link keeps an `href`: a live target (http, https, mailto, or relative and not a network path) stays in `href`; any other target, including `file:`, `smb:`, `about:` and `//…` or `\\…` network paths, becomes `<a href="#" data-href="…">`; `javascript:`, `vbscript:` and `data:` become `<a href="#">`. The click handler prevents every `<a>` click and logs `data-href` before `href`. The link test asserts each of its 16 links' `href` and `data-href` against that contract, then clicks each one five ways: each is focusable now, so Enter is pressed on all 16 (80 clicks). `no_output_can_navigate` needs no change, but its falsification needs two edits, because `sanitize` rebuilds every `<a>` from its target alone and so drops whatever else ammonia kept.
- **`reconcile` per `(block, piece)`, at most `MAX_PAGE` of HTML a call (fix 3).** `MdView::reconcile` retires the pending items it returns; the renderer swaps each in by `(block, piece)` and calls again until it gets `[]`.
- **CSV in the sniffed encoding, UTF-16 refused (fix 4).** `indexCsv` sniffs the encoding from the first chunk (`encoding::sniff`, as `MdView.open` does) and passes it as `CsvConfig.encoding`. A UTF-16 CSV ends at once with `done: true` and `reason` = `UTF16_REFUSED`.
- **`MdConfig::max_blocks` (fix 6).** `MdView.open(source, maxBlocks?)` passes it on (default: no limit, as `MdConfig::default()`). A stop ends the index job with `done: true` and `reason` = `TOO_MANY_BLOCKS`, and the Rendered lens stops on it (Z34). Sizing `maxBlocks` from the safety limit, spec §3.6's aggregate budget (25% of RAM across every open document), is later work: the core host opens with no limit unless `mdOpen` passes `maxBlocks`, and no budget stop of its own is surfaced. (32 B per block is an optimization target, not that limit.)
- **Front matter only at offset 0, interrupted oversized blocks, `fence_of`, cancel inside a window (fixes 2, 18–19, 1 and 17):** no code change here. Every oversized fixture is ASCII, and a job that panics still reports (`spawn_job` catches the unwind and sends `error: "panicked"`), so a regression can't hang a gate. Task C5b4's Markdown cancel times are on the fixed scan.

Counts below are for C0–C4 with round 1's fixes on plan A amended for Z37 (`cargo test -p spike-core`: 120 passed, 6 ignored) plus C5a.

**Files:**
- Modify: `spikes/core/spike-core/src/store.rs` (`ByteStore::open_shared` and its test)
- Modify: `spikes/core/spike-node/Cargo.toml`, `spikes/core/Cargo.lock` (cargo writes it), `spikes/core/spike-node/src/lib.rs`
- Create: `spikes/core/spike-node/test/spike-c.test.js`
- Modify: `spikes/app/src/main/core-host.ts`

**Interfaces:**
- **Consumes:** `doc::Document` (C0), `bytemap::ByteMap::to_json` (C1a), `encoding::{sniff, Sniffed}` (C1b), `json::{scan, ScanOptions, ErrorKind}` (C2a), `csv::{sniff, build, CsvConfig, CsvIndex}` (C3a, with fix 4's `encoding` and `refused`), `md::{MdDoc, MdConfig, Item}` (C4c, with fix 6's `max_blocks` and `stopped`); plan A's `Doc`, `err`, port protocol and `effect` (C5a5).
- **Produces (`spike_core::store`):** `pub fn ByteStore::open_shared(path: &Path, cache_chunks: usize, hashes: Arc<ChunkHashes>) -> io::Result<ByteStore>`: a second handle whose chunks verify against another store's hashes.
- **Produces (napi, `spike-node`; offsets are numbers, exact below 2^53):**
  - `class Source { static open(path): Source; get generation(): number; get size(): number; read(generation, start, end): Buffer; reload(): number }` — the verified copy path (spec §3.1). `read` throws `stale span (generation G, now N)` or `frozen: …`.
  - `class MdView { static open(source: Source, maxBlocks?: number): MdView; get encoding(): string; page(block, item, count): string; reconcile(): string; outline(): string; startIndex(onEvent: (e: JobEvent) => void): Job }`. `page` and `reconcile` return JSON `[{block, piece, pieces, span: [start, end], html, runs: [{text, map}], unmapped, note}]` (`map` is `ByteMap::to_json`); `reconcile` returns at most `MAX_PAGE` of HTML a call and `[]` when nothing is left; `outline` returns `{done, headings: [{level, text, slug, block, span}]}`. Its store shares the source's chunk hashes.
  - `class Job { cancel(): void }`; `interface JobEvent { running: boolean; done: boolean; cancelled: boolean; elapsedMs: number; cancelMs?: number; error?: string; reason?: string; bytes?: number; count?: number }`. While a Markdown or CSV job runs, an event with `running: true` reports `bytes` and `count` (blocks or records) so far, at most every 100 ms; then one last event (`running: false`) says how it ended, with the final `bytes` and `count`. `cancelMs` runs from `cancel()` to the worker's return, timed in the core host; `reason` is set when a job that ran to the end has no usable index (`TOO_MANY_BLOCKS`, `UTF16_REFUSED`).
  - `indexJson(path, onEvent): Job` (no progress: `json::scan` publishes nothing until it returns), `indexCsv(path, onEvent): Job` (the sniffed encoding and delimiter).
- **Produces (core host port methods):** `mdOpen({path, block?, count?, maxBlocks?}) → {doc, gen, size, encoding, job, items}` (the first screen in one round trip, spec §3.4), `mdPage({doc, block, item, count}) → items`, `mdReconcile({doc}) → items`, `mdOutline({doc})`, `read({doc, gen, start, end}) → Uint8Array`, `reload({doc}) → {gen}`, `index({path, format: 'md' | 'json' | 'csv'}) → {job}`, `cancel({job}) → boolean` (still running), and `close` now also cancels a Markdown document's index. Event `{event: 'job', job, ...JobEvent}`, for each progress report and the last event; a job is forgotten (and `cancel` returns false) after its last.

**Design notes:**
- **One verified read path for display and copy.** `MdView` reads through `ByteStore::open_shared` on the source's hashes, so a chunk Rendered displayed and the same chunk copy reads are checked against one first-read hash (spec §3.1). With two independent stores, an in-place write between display and copy would go unnoticed.
- **Cancel is measured where it happens.** `Job.cancel()` records the instant and sets the flag; the worker thread measures from that instant to its own return. JSON checks the flag every 64 KiB window, CSV every 64 KiB, Markdown before every step (a 64 KiB window or a 256 KiB oversized-scan step) and inside a window every 1,024 parser events or headings.
- **Pages cross as JSON strings**, parsed by the core host, then structured-cloned to the renderer (spec §3.4's starting encoding). `serde_json` writes u64 offsets exactly; the 2^53 ceiling is JavaScript's.
- `reconcile` keeps the items it handed out with unresolved references and re-renders those once the index has found them (spec §14 D1), a page at a time; it forgets each item it returns, so repeated calls end in `[]`. The renderer swaps by `(block, piece)`.
- **Progress without touching the indexers** (Z30, spec §3.4). `MdDoc::index_all` and `csv::build` run unchanged on the job's thread; a reporter thread samples what they publish every 100 ms (`index().pos` and the block count; the CSV index's `indexed_bytes` and `records`, shared through an `Arc<RwLock<CsvIndex>>`) and is joined before the last event, so no progress report can follow it. Cancel latency is untouched: the flag is still checked inside the indexers. JSON gets no progress: `json::scan` builds its index privately and returns it at the end, so reporting needs a callback or shared state in C2a's scanner, a core change these tasks don't make.
- **One sniff for both lenses' indexes.** `text_encoding` reads the first chunk through the store and applies `encoding::sniff` with Windows-1252 as the fallback; a binary file is an error. `MdView.open` and `indexCsv` share it.

- [ ] **Step 1: Write the failing store test**

In `spikes/core/spike-core/src/store.rs` replace:
<!-- op: replace spikes/core/spike-core/src/store.rs -->
```rust
    #[test]
    fn the_file_stays_deletable_while_open() {
```
with:
```rust
    #[test]
    fn a_shared_store_verifies_against_the_first_stores_hashes() {
        let path = temp_file("shared", &pattern(CHUNK));
        let first = ByteStore::open(&path).unwrap();
        first.chunk(0).unwrap();
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.write_all(b"same-size in-place write").unwrap();
        drop(f);
        let second = ByteStore::open_shared(&path, 1, first.hashes()).unwrap();
        assert!(matches!(second.chunk(0), Err(StoreError::Changed { chunk: 0 })));
    }

    #[test]
    fn the_file_stays_deletable_while_open() {
```
Run (`spikes/core`): `cargo test -p spike-core store::`
Expected: FAIL, ``error[E0599]: no associated function or constant named `open_shared` found for struct `store::ByteStore` in the current scope`` and ``error: could not compile `spike-core` (lib test) due to 1 previous error``.

- [ ] **Step 2: Implement `open_shared`**

In `spikes/core/spike-core/src/store.rs` replace:
<!-- op: replace spikes/core/spike-core/src/store.rs -->
```rust
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn hashes(&self) -> Arc<ChunkHashes> {
```
with:
```rust
    /// Another handle on the same file whose chunks verify against `hashes` (another store's), so two readers of one
    /// document agree on its first-read content (spec §3.1).
    pub fn open_shared(path: &Path, cache_chunks: usize, hashes: Arc<ChunkHashes>) -> io::Result<ByteStore> {
        Ok(ByteStore { hashes, ..Self::open_with(path, cache_chunks)? })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn hashes(&self) -> Arc<ChunkHashes> {
```
Run (`spikes/core`): `cargo test -p spike-core store::`
Expected: `test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 122 filtered out` (then `json_spans`: `0 passed; … 1 filtered out`).

- [ ] **Step 3: Write the failing napi test**

`spikes/core/spike-node/test/spike-c.test.js`:
<!-- op: create spikes/core/spike-node/test/spike-c.test.js -->
```js
// Spike C's core through napi (spec §3.1, §3.4, §4.6): Markdown pages with byte-mapped runs, the verified copy path,
// and cancellable index jobs. Needs the built addon (npm run build).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MdView, Source, indexCsv, indexJson } = require('..')

const DIR = path.join(__dirname, '..', '..', '..', '.fixtures', 'spike-node')
fs.mkdirSync(DIR, { recursive: true })
const file = (name, bytes) => {
  const p = path.join(DIR, name)
  fs.writeFileSync(p, bytes)
  return p
}
/** Every event of a job, its progress reports and then the one that ends it. */
const events = (start) =>
  new Promise((resolve) => {
    const all = []
    start((e) => {
      all.push(e)
      if (!e.running) resolve(all)
    })
  })
const finished = (start) => events(start).then((all) => all.at(-1))

test('a Markdown page carries sanitized HTML, runs with byte maps, spans and the outline', () => {
  const p = file('page.md', '# Title\n\nSome **bold** &amp; é.\n')
  const md = MdView.open(Source.open(p))
  assert.equal(md.encoding, 'UTF-8')
  const [h, para] = JSON.parse(md.page(0, 0, 50))
  assert.deepEqual([h.block, h.piece, h.pieces, h.span, h.html, h.unmapped, h.note], [0, 0, 1, [0, 8], '<h1>Title</h1>', null, null])
  assert.deepEqual(h.runs, [{ text: 'Title', map: { kind: 'breakpoints', points: [[0, 0], [1, 3]], end: [5, 8] } }])
  assert.equal(para.html, '<p>Some <strong>bold</strong> &amp; é.</p>')
  assert.deepEqual(para.runs.map((r) => r.text), ['Some ', 'bold', ' & é.'])
  assert.deepEqual(para.span, [9, 33])
  assert.deepEqual(JSON.parse(md.outline()), { done: true, headings: [{ level: 1, text: 'Title', slug: 'title', block: 0, span: [0, 8] }] })
})

test('copy reads verified bytes, and refuses a changed file and a stale generation', () => {
  const p = file('copy.md', 'one two\n')
  const source = Source.open(p)
  assert.equal(source.generation, 1)
  assert.equal(source.read(1, 4, 7).toString(), 'two')
  fs.appendFileSync(p, 'three\n')
  assert.throws(() => source.read(1, 4, 7), /frozen: changed on disk/)
  assert.equal(source.reload(), 2)
  assert.throws(() => source.read(1, 4, 7), /stale span \(generation 1, now 2\)/)
  assert.equal(source.read(2, 8, 13).toString(), 'three')
  assert.equal(source.size, 14)
})

test('reconcile re-renders the items whose references the index found later', async () => {
  const filler = 'filler text for the first window.\n\n'.repeat(3000) // > 64 KiB: the definition is outside the first window
  const p = file('reconcile.md', `see [x][ref]\n\n${filler}[ref]: /url\n`)
  const md = MdView.open(Source.open(p))
  assert.equal(JSON.parse(md.page(0, 0, 1))[0].html, '<p>see [x][ref]</p>')
  assert.deepEqual(JSON.parse(md.reconcile()), []) // not indexed yet
  const e = await finished((done) => md.startIndex(done))
  assert.deepEqual([e.done, e.cancelled, e.error], [true, false, undefined])
  const [again] = JSON.parse(md.reconcile())
  assert.deepEqual([again.block, again.piece, again.html], [0, 0, '<p>see <a href="/url">x</a></p>'])
  assert.deepEqual(JSON.parse(md.reconcile()), []) // returned once: the renderer's loop ends
})

test('a job that ends without a usable index says why: too many blocks, a UTF-16 CSV', async () => {
  const md = MdView.open(Source.open(file('blocks.md', 'a\n\nb\n\nc\n')), 2)
  const e = await finished((done) => md.startIndex(done))
  assert.deepEqual([e.done, e.reason], [true, 'Rendered is unavailable: this file has more blocks than the memory budget allows.'])
  const fits = await finished((done) => MdView.open(Source.open(file('fits.md', 'a\n\nb\n')), 2).startIndex(done))
  assert.deepEqual([fits.done, fits.reason], [true, undefined])
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n1,2\n', 'utf16le')])
  const c = await finished((done) => indexCsv(file('utf16.csv', utf16), done))
  assert.deepEqual([c.done, c.reason], [true, 'Grid is unavailable for UTF-16 files: the CSV reader splits single-byte delimiters, quotes and line ends.'])
  const utf8 = await finished((done) => indexCsv(file('utf8.csv', 'a,b\n1,2\n'), done))
  assert.deepEqual([utf8.done, utf8.reason], [true, undefined])
})

test('Markdown and CSV jobs report progress at most 10 times a second, bytes rising, then end', async (t) => {
  const inputs = [
    ['md', file('progress.md', 'lorem ipsum dolor sit amet, consectetur *adipiscing* elit\n\n'.repeat(1_000_000)), (p, cb) => MdView.open(Source.open(p)).startIndex(cb)],
    ['csv', file('progress.csv', 'h1,h2\n' + 'abc,"def"\n'.repeat(12_000_000)), indexCsv]
  ]
  for (const [name, p, start] of inputs) {
    const all = await events((cb) => start(p, cb))
    const [progress, last] = [all.slice(0, -1), all.at(-1)]
    t.diagnostic(`${name}: ${progress.length} progress events, then ${JSON.stringify(last)}`)
    assert.ok(progress.length >= 2, `${name}: ${progress.length} progress events`)
    for (const [i, e] of progress.entries()) {
      assert.deepEqual([e.running, e.done, e.cancelled], [true, false, false])
      if (i === 0) continue
      assert.ok(e.bytes >= progress[i - 1].bytes && e.count >= progress[i - 1].count, `${name}: event ${i} went back`)
      assert.ok(e.elapsedMs - progress[i - 1].elapsedMs >= 90, `${name}: events ${i - 1}, ${i} under 100 ms apart`)
    }
    assert.ok(progress.at(-1).bytes > progress[0].bytes, `${name}: bytes never rose`)
    assert.deepEqual([last.running, last.done, last.bytes], [false, true, fs.statSync(p).size])
    fs.rmSync(p)
  }
})

test('every index job stops within 50 ms of cancel, timed where it runs', async (t) => {
  const inputs = [
    ['md', file('cancel.md', 'lorem ipsum dolor sit amet, consectetur *adipiscing* elit\n'.repeat(500_000)), (p, cb) => MdView.open(Source.open(p)).startIndex(cb)],
    ['json', file('cancel.json', '[' + '[1,"abc",{"k":null}],'.repeat(2_000_000) + '0]'), indexJson],
    ['csv', file('cancel.csv', 'h1,h2\n"open' + 'xxxxxxx,\n'.repeat(6_000_000)), indexCsv]
  ]
  for (const [name, p, start] of inputs) {
    let job
    const stopped = finished((cb) => (job = start(p, cb)))
    await new Promise((ok) => setTimeout(ok, 5))
    job.cancel()
    const e = await stopped
    t.diagnostic(`${name}: ${JSON.stringify(e)}`)
    assert.equal(e.cancelled, true, `${name} finished before the cancel`)
    assert.ok(e.cancelMs >= 0 && e.cancelMs < 50, `${name}: ${e.cancelMs} ms`)
  }
  for (const [, p] of inputs) fs.rmSync(p)
})
```
Run (`spikes/core/spike-node`): `node --test test/spike-c.test.js`
Expected: FAIL, `ℹ pass 0`, `ℹ fail 6`, each with `TypeError: Cannot read properties of undefined (reading 'open')` (the addon has no `MdView` or `Source` yet).

- [ ] **Step 4: Implement the bindings**

In `spikes/core/spike-node/Cargo.toml` replace:
<!-- op: replace spikes/core/spike-node/Cargo.toml -->
```toml
[dependencies]
napi = "3"
napi-derive = "3"
spike-core = { path = "../spike-core" }
```
with:
```toml
[dependencies]
encoding_rs = "0.8.42"
napi = "3"
napi-derive = "3"
serde_json = "1"
spike-core = { path = "../spike-core" }
```
In `spikes/core/spike-node/src/lib.rs` replace:
<!-- op: replace spikes/core/spike-node/src/lib.rs -->
```rust
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use spike_core::index::{build, IndexConfig, LineIndex};
use spike_core::pages;
use spike_core::store::ByteStore;
```
with:
```rust
use std::fs::File;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use encoding_rs::{Encoding, WINDOWS_1252};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde_json::{Value, json};
use spike_core::csv;
use spike_core::doc::Document;
use spike_core::encoding::{Sniffed, sniff};
use spike_core::index::{build, IndexConfig, LineIndex};
use spike_core::json::{ErrorKind, ScanOptions, scan};
use spike_core::md::{Item, MdConfig, MdDoc};
use spike_core::pages;
use spike_core::store::{ByteStore, CHUNK};
```
and at the end of the file, replace:
<!-- op: replace spikes/core/spike-node/src/lib.rs -->
```rust
            .map(|r| JsRow { line: r.line as i64, ts: r.ts, kind: r.kind, summary: r.summary, more: r.more, bad: r.bad })
            .collect())
    }
}
```
with:
```rust
            .map(|r| JsRow { line: r.line as i64, ts: r.ts, kind: r.kind, summary: r.summary, more: r.more, bad: r.bad })
            .collect())
    }
}

// ---- Spike C: the copy path, Markdown items and cancellable index jobs (spec §3.1, §3.4, §4.6) ----
// Offsets and sizes reach JavaScript as numbers, exact up to 2^53 - 1 bytes (8 PiB): `Source::open` refuses more.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// A document's verified copy path (spec §3.1): generations, identity checks and chunk verification.
#[napi]
pub struct Source {
    path: String,
    doc: Mutex<Document>,
}

#[napi]
impl Source {
    #[napi(factory)]
    pub fn open(path: String) -> Result<Source> {
        let doc = Document::open(Path::new(&path)).map_err(err)?;
        if doc.len() > MAX_SAFE {
            return Err(err("over 2^53 bytes: offsets would not be exact in JavaScript"));
        }
        Ok(Source { path, doc: Mutex::new(doc) })
    }

    #[napi(getter)]
    pub fn generation(&self) -> u32 {
        self.doc.lock().unwrap().generation()
    }

    #[napi(getter)]
    pub fn size(&self) -> i64 {
        self.doc.lock().unwrap().len() as i64
    }

    /// Copy (brief §7.4): the source bytes of [start, end), refused for a stale generation or a changed file.
    #[napi]
    pub fn read(&self, generation: u32, start: i64, end: i64) -> Result<Buffer> {
        let bytes = self.doc.lock().unwrap().read(generation, start.max(0) as u64, end.max(0) as u64).map_err(err)?;
        Ok(bytes.into())
    }

    /// Ctrl+R: the next generation. Spans of earlier generations are refused from now on.
    #[napi]
    pub fn reload(&self) -> Result<u32> {
        let mut doc = self.doc.lock().unwrap();
        doc.reload().map_err(err)?;
        Ok(doc.generation())
    }
}

/// The Rendered lens's core side (spec §4.6). It reads through a store that shares the source's chunk hashes, so
/// what Rendered shows and what copy reads are verified against the same first read (spec §3.1).
#[napi]
pub struct MdView {
    md: Arc<MdDoc>,
    encoding: &'static Encoding,
    /// Items handed out with unresolved references: `reconcile` re-renders them once the index has found those.
    pending: Mutex<Vec<Item>>,
}

#[napi]
impl MdView {
    /// `max_blocks` (default: no limit) stops indexing with `md::TOO_MANY_BLOCKS` (spec §3.6).
    #[napi(factory)]
    pub fn open(source: &Source, max_blocks: Option<u32>) -> Result<MdView> {
        let doc = source.doc.lock().unwrap();
        let encoding = text_encoding(doc.store())?;
        let store = ByteStore::open_shared(Path::new(&source.path), 64, doc.store().hashes()).map_err(err)?;
        let cfg = MdConfig { max_blocks: max_blocks.map_or(usize::MAX, |n| n as usize), ..MdConfig::default() };
        Ok(MdView { md: Arc::new(MdDoc::new(store, encoding, cfg)), encoding, pending: Mutex::default() })
    }

    #[napi(getter)]
    pub fn encoding(&self) -> String {
        self.encoding.name().to_string()
    }

    /// Up to `count` items from (block, item within it) on (spec §3.4's continuation), as `items_json`.
    #[napi]
    pub fn page(&self, block: i64, item: u32, count: u32) -> Result<String> {
        let items = self.md.page((block.max(0) as u64, item as usize), count as usize).map_err(err)?;
        self.pending.lock().unwrap().extend(items.iter().filter(|i| !i.pending.is_empty()).cloned());
        Ok(items_json(&items))
    }

    /// Spec §14 D1: replacements for handed-out items whose references the index has found since, as
    /// `items_json`, at most `MAX_PAGE` bytes of HTML a call. The renderer swaps each one in by (block, piece) and
    /// calls again until it gets `[]`.
    #[napi]
    pub fn reconcile(&self) -> Result<String> {
        let mut pending = self.pending.lock().unwrap();
        let fresh = self.md.reconcile(&pending).map_err(err)?;
        pending.retain(|p| !fresh.iter().any(|f| (f.block, f.piece) == (p.block, p.piece)));
        Ok(items_json(&fresh))
    }

    /// The outline so far, as JSON: `{done, headings: [{level, text, slug, block, span}]}`.
    #[napi]
    pub fn outline(&self) -> String {
        let idx = self.md.index();
        let headings: Vec<Value> = idx
            .headings
            .iter()
            .map(|h| json!({ "level": h.level, "text": h.text, "slug": h.slug, "block": h.block, "span": [h.span.0, h.span.1] }))
            .collect();
        json!({ "done": idx.done, "headings": headings }).to_string()
    }

    /// Indexes the rest of the document in the background (spec §4.6).
    #[napi]
    pub fn start_index(&self, on_event: ThreadsafeFunction<JobEvent, (), JobEvent, Status, false>) -> Job {
        let md = self.md.clone();
        let seen = self.md.clone();
        let probe: Probe = Arc::new(move || {
            let idx = seen.index();
            (idx.pos, idx.blocks.len() as u64)
        });
        spawn_job(on_event, Some(probe), move |cancel| Ok((md.index_all(cancel).map_err(|e| e.to_string())?, md.index().stopped)))
    }
}

/// The sniffed encoding of a text file (spec §4.1), from its first chunk; an error for a binary file.
fn text_encoding(store: &ByteStore) -> Result<&'static Encoding> {
    let head = store.read(0, CHUNK as u64).map_err(err)?;
    match sniff(&head, store.len() <= CHUNK as u64, WINDOWS_1252) {
        Sniffed::Text { encoding, .. } => Ok(encoding),
        Sniffed::Binary => Err(err("binary file")),
    }
}

/// `[{block, piece, pieces, span: [start, end], html, runs: [{text, map}], unmapped, note}]`. `html` is sanitized;
/// `map` is `ByteMap::to_json`, the form `bytemap.ts` reads; run k is the item's k-th DOM text node unless `unmapped`.
fn items_json(items: &[Item]) -> String {
    let items: Vec<Value> = items
        .iter()
        .map(|it| {
            let runs: Vec<Value> = it.runs.iter().map(|r| json!({ "text": r.text, "map": r.map.to_json() })).collect();
            json!({
                "block": it.block, "piece": it.piece, "pieces": it.pieces, "span": [it.span.0, it.span.1],
                "html": it.html, "runs": runs, "unmapped": it.unmapped, "note": it.note,
            })
        })
        .collect();
    Value::Array(items).to_string()
}

#[napi(object)]
#[derive(Default)]
pub struct JobEvent {
    /// A progress report (spec §3.4): the job is still running, with `bytes` and `count` so far. Every other event
    /// is the job's last.
    pub running: bool,
    /// Ran to the end.
    pub done: bool,
    pub cancelled: bool,
    pub elapsed_ms: f64,
    /// From `Job.cancel()` until the work stopped, timed in this process (the core host).
    pub cancel_ms: Option<f64>,
    pub error: Option<String>,
    /// Why a job that ran to the end has no usable result: `md::TOO_MANY_BLOCKS` or `csv::UTF16_REFUSED`.
    pub reason: Option<String>,
    /// Bytes indexed so far (Markdown and CSV jobs).
    pub bytes: Option<f64>,
    /// Blocks (Markdown) or records (CSV) indexed so far.
    pub count: Option<f64>,
}

/// Background work with a cancel flag (spec §3.4). It reports progress while it runs (Markdown, CSV), then once
/// more when it stops.
#[napi]
pub struct Job {
    cancel: Arc<AtomicBool>,
    asked: Arc<Mutex<Option<Instant>>>,
}

#[napi]
impl Job {
    #[napi]
    pub fn cancel(&self) {
        self.asked.lock().unwrap().get_or_insert_with(Instant::now);
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// What a job's work returns: Ok((true, reason)) when it ran to the end, Ok((false, _)) when it stopped at the
/// cancel flag.
type Work = std::result::Result<(bool, Option<&'static str>), String>;

/// (bytes, count) indexed so far, read from the index a job is building.
type Probe = Arc<dyn Fn() -> (u64, u64) + Send + Sync>;

/// Progress reports while a job runs (spec §3.4: 5–10 Hz).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Runs `work` on its own thread and reports how it ended. With a `probe`, a second thread also reports progress
/// every `PROGRESS_EVERY` until the work returns; it is joined before the last event, so nothing follows that.
fn spawn_job(
    on_event: ThreadsafeFunction<JobEvent, (), JobEvent, Status, false>,
    probe: Option<Probe>,
    work: impl FnOnce(&AtomicBool) -> Work + Send + 'static,
) -> Job {
    let job = Job { cancel: Arc::default(), asked: Arc::default() };
    let (cancel, asked) = (job.cancel.clone(), job.asked.clone());
    let on_event = Arc::new(on_event);
    std::thread::spawn(move || {
        let started = Instant::now();
        let ms = |d: Duration| d.as_secs_f64() * 1e3;
        let (finished, wait) = channel::<()>();
        let reporter = probe.clone().map(|probe| {
            let on_event = on_event.clone();
            std::thread::spawn(move || {
                while wait.recv_timeout(PROGRESS_EVERY) == Err(RecvTimeoutError::Timeout) {
                    let (bytes, count) = probe();
                    let event = JobEvent { running: true, elapsed_ms: ms(started.elapsed()), bytes: Some(bytes as f64), count: Some(count as f64), ..Default::default() };
                    on_event.call(event, ThreadsafeFunctionCallMode::NonBlocking);
                }
            })
        });
        // A panic must still report, or the caller would wait forever.
        let result = catch_unwind(AssertUnwindSafe(|| work(&cancel))).unwrap_or_else(|_| Err("panicked".into()));
        let stopped = Instant::now();
        drop(finished);
        if let Some(reporter) = reporter {
            let _ = reporter.join();
        }
        let (bytes, count) = probe.map(|probe| probe()).map_or((None, None), |(b, c)| (Some(b as f64), Some(c as f64)));
        let cancel_ms = asked.lock().unwrap().map(|t| ms(stopped.saturating_duration_since(t)));
        let (done, reason, error) = match result {
            Ok((done, reason)) => (done, reason.filter(|_| done).map(String::from), None),
            Err(e) => (false, None, Some(e)),
        };
        let cancelled = !done && error.is_none();
        let event = JobEvent { done, cancelled, elapsed_ms: ms(stopped - started), cancel_ms: cancel_ms.filter(|_| cancelled), error, reason, bytes, count, ..Default::default() };
        on_event.call(event, ThreadsafeFunctionCallMode::NonBlocking);
    });
    job
}

/// The JSON container scan of the whole file (spec §4.3), as a job.
#[napi]
pub fn index_json(path: String, on_event: ThreadsafeFunction<JobEvent, (), JobEvent, Status, false>) -> Result<Job> {
    let store = ByteStore::open(Path::new(&path)).map_err(err)?;
    // No progress: `json::scan` publishes nothing until it returns (C2a).
    Ok(spawn_job(on_event, None, move |cancel| {
        let idx = scan(&store, 0..store.len(), &ScanOptions::default(), cancel).map_err(|e| e.to_string())?;
        Ok((!idx.error.is_some_and(|e| e.kind == ErrorKind::Cancelled), None))
    }))
}

/// The CSV record index with the sniffed encoding and delimiter (spec §4.1, §4.2, §3.5), as a job. UTF-16 ends at
/// once with `reason` = `csv::UTF16_REFUSED`.
#[napi]
pub fn index_csv(path: String, on_event: ThreadsafeFunction<JobEvent, (), JobEvent, Status, false>) -> Result<Job> {
    let store = ByteStore::open(Path::new(&path)).map_err(err)?;
    let (encoding, delimiter) = (text_encoding(&store)?, csv::sniff(&store).map_err(err)?.delimiter);
    let file = File::open(&path).map_err(err)?;
    let shared = Arc::new(RwLock::<csv::CsvIndex>::default());
    let seen = shared.clone();
    let probe: Probe = Arc::new(move || {
        let idx = seen.read().unwrap();
        (idx.indexed_bytes, idx.records)
    });
    Ok(spawn_job(on_event, Some(probe), move |cancel| {
        let cfg = csv::CsvConfig { delimiter, encoding, ..Default::default() };
        let done = csv::build(&file, store.len(), cfg, &store.hashes(), &shared, cancel, |_| {}).map_err(|e| e.to_string())?;
        Ok((done, shared.read().unwrap().refused))
    }))
}
```
Run (`spikes/core/spike-node`): `npm run build`, then `node --test`
Expected: the build writes `index.d.ts` with `class Source`, `class MdView`, `class Job`, `interface JobEvent`, `indexCsv` and `indexJson`, and no warnings. Then `ℹ pass 7`, `ℹ fail 0` (plan C's `beyond-4gib` test and these 6), with diagnostics in this shape (times and progress counts vary):
```text
ℹ md: 4 progress events, then {"running":false,"done":true,"cancelled":false,"elapsedMs":506.07310000000007,"bytes":59000000,"count":1000000}
ℹ csv: 3 progress events, then {"running":false,"done":true,"cancelled":false,"elapsedMs":365.6366,"bytes":120000006,"count":12000001}
ℹ md: {"running":false,"done":false,"cancelled":true,"elapsedMs":17.663600000000002,"cancelMs":0.5599,"bytes":0,"count":0}
ℹ json: {"running":false,"done":false,"cancelled":true,"elapsedMs":14.4793,"cancelMs":3.3929}
ℹ csv: {"running":false,"done":false,"cancelled":true,"elapsedMs":4.7194,"cancelMs":1.3074000000000001,"bytes":0,"count":0}
```

- [ ] **Step 5: Wire the core host**

In `spikes/app/src/main/core-host.ts` replace:
<!-- op: replace spikes/app/src/main/core-host.ts -->
```ts
import { Doc, coreVersion } from 'spike-node'

type Handler = (params: any) => unknown

function serve(port: MessagePortMain): void {
  const docs = new Map<number, Doc>()
  let nextDoc = 1
  const get = (id: number): Doc => {
    const doc = docs.get(id)
    if (!doc) throw new Error(`no document ${id}`)
    return doc
  }
  const handlers: Record<string, Handler> = {
```
with:
```ts
import { Doc, MdView, Source, coreVersion, indexCsv, indexJson, type Job, type JobEvent } from 'spike-node'

type Handler = (params: any) => unknown
type Start = (onEvent: (e: JobEvent) => void) => Job

function serve(port: MessagePortMain): void {
  const docs = new Map<number, Doc>()
  const mds = new Map<number, { source: Source; md: MdView; job: number }>()
  const jobs = new Map<number, Job>()
  let nextDoc = 1
  let nextJob = 1
  const get = (id: number): Doc => {
    const doc = docs.get(id)
    if (!doc) throw new Error(`no document ${id}`)
    return doc
  }
  const getMd = (id: number) => {
    const md = mds.get(id)
    if (!md) throw new Error(`no Markdown document ${id}`)
    return md
  }
  /**
   * A cancellable job. Its 'job' events report progress while `running`; the last one says how it ended and, if
   * cancelled, how long it took to stop.
   */
  const startJob = (start: Start): number => {
    const id = nextJob++
    jobs.set(
      id,
      start((e) => {
        if (!e.running) jobs.delete(id)
        port.postMessage({ event: 'job', job: id, ...e })
      })
    )
    return id
  }
  const handlers: Record<string, Handler> = {
```
and replace:
<!-- op: replace spikes/app/src/main/core-host.ts -->
```ts
    close: ({ doc }: { doc: number }) => docs.delete(doc)
  }
```
with:
```ts
    // Spike C (spec §3.1, §3.4, §4.6). Offsets are numbers, exact up to 2^53: the addon refuses larger files.
    /** `maxBlocks` stops Rendered's index at that many blocks (spec §3.6's budget; none by default). */
    mdOpen: ({ path, block = 0, count = 50, maxBlocks }: { path: string; block?: number; count?: number; maxBlocks?: number }) => {
      effect?.('open', path)
      const source = Source.open(path)
      const md = MdView.open(source, maxBlocks)
      const items = JSON.parse(md.page(block, 0, count)) // the first screen, from a prefix parse (spec §14 D1)
      const doc = nextDoc++
      const job = startJob((cb) => md.startIndex(cb))
      mds.set(doc, { source, md, job })
      return { doc, gen: source.generation, size: source.size, encoding: md.encoding, job, items }
    },
    mdPage: ({ doc, block, item, count }: { doc: number; block: number; item: number; count: number }) =>
      JSON.parse(getMd(doc).md.page(block, item, count)),
    mdReconcile: ({ doc }: { doc: number }) => JSON.parse(getMd(doc).md.reconcile()),
    mdOutline: ({ doc }: { doc: number }) => JSON.parse(getMd(doc).md.outline()),
    read: ({ doc, gen, start, end }: { doc: number; gen: number; start: number; end: number }) => getMd(doc).source.read(gen, start, end),
    reload: ({ doc }: { doc: number }) => {
      const m = getMd(doc)
      jobs.get(m.job)?.cancel()
      const gen = m.source.reload()
      m.md = MdView.open(m.source)
      return { gen }
    },
    /** One format's index on its own, as a job: the hostile-input gate runs it beside Raw. */
    index: ({ path, format }: { path: string; format: 'md' | 'json' | 'csv' }) => {
      effect?.('open', path)
      const start: Start =
        format === 'json' ? (cb) => indexJson(path, cb) : format === 'csv' ? (cb) => indexCsv(path, cb) : (cb) => MdView.open(Source.open(path)).startIndex(cb)
      return { job: startJob(start) }
    },
    /** True if the job was still running: its 'job' event then carries cancelMs. */
    cancel: ({ job }: { job: number }) => {
      jobs.get(job)?.cancel()
      return jobs.has(job)
    },
    close: ({ doc }: { doc: number }) => {
      const md = mds.get(doc)
      if (md) jobs.get(md.job)?.cancel()
      return mds.delete(doc) || docs.delete(doc)
    }
  }
```
Run (`spikes/app`): `npm run build`
Expected: exit 0. Task C5b2's tests are the first to go through these methods.

- [ ] **Step 6: Read your own work (rule 8), then commit**

Re-read `store.rs`'s two edits, `lib.rs`'s new section and `core-host.ts` as they sit on disk.
```bash
git add spikes/core/spike-core/src/store.rs spikes/core/spike-node/Cargo.toml spikes/core/Cargo.lock spikes/core/spike-node/src/lib.rs spikes/core/spike-node/test/spike-c.test.js spikes/app/src/main/core-host.ts
git commit -m "spike(c): napi Source, MdView and cancellable index jobs; core-host wiring"
```

---

## Task C5b2: The Rendered lens — windowed items, the pairing contract, selection → copy

**Files:**
- Create: `spikes/app/src/renderer/src/rendered.ts`
- Modify: `spikes/app/src/renderer/src/main.ts` (`window.__spike.openRendered`), `spikes/app/src/renderer/src/style.css`
- Create: `spikes/app/e2e/mdgen.ts`, `spikes/app/e2e/rendered.e2e.ts`

**Interfaces:**
- **Consumes:** the core host methods of Task C5b1; `startByte`/`endByte`/`ByteMap` (C1a's `bytemap.ts`); `renderMath` (C5a3), `renderDiagram` (C5a4); `launch`, `FIX` (C5a2); plan A's `Core`, `PerfLog`.
- **Produces (`rendered.ts`):**
  - `interface MdItem { block, piece, pieces, span: [number, number], html, runs: { text, map: ByteMap }[], unmapped: string | null, note: string | null }`, `interface MdOpened { doc, gen, size, encoding, job, items }`, `interface SourceSpan { gen, start, end }`.
  - `endpointByte(scope: Node, node: Node, offset: number, end: boolean): number | null` — a selection endpoint → source byte; a start snaps back, an end forward.
  - `class RenderedView { constructor(parent, core, opened: MdOpened, perf); readonly root; readonly opened; readonly clicked: (string | null)[]; selection(): SourceSpan | null; copy(): Promise<Uint8Array | null>; settled(): Promise<void> }`. Each item is a `div.md-item` with `data-key="<block>:<piece>"`, `data-note` for a Raw note and `data-unmapped` when its runs can't be paired. After the scroller sits a `div.md-status` with `role="status"`: `Indexing for Rendered: <MB> of <MB> MB, <n> blocks` while the index runs, empty once it's done, and on a budget stop `<reason> Raw stays available.`
  - `window.__spike.openRendered(path, anchor = 0, maxBlocks?): Promise<RenderedView>` — `maxBlocks` goes to `mdOpen`; marks `openStart`, and the view marks `firstScreen` (rAF, then a task) once its items cover the viewport or the document ends: plan A's first-screen measure.
- **Produces (`e2e/mdgen.ts`, test-only):** `type Enc = 'utf-8' | 'utf-16le'`; `interface Shown { show, src, math?, start, end }`; `genDoc(seed, enc, blocks): { bytes, blocks: Shown[][] }`; `encode(s, enc)`.

**Design notes:**
- **The fix for the pairing contract** (lane C4 left open whether a renderer can keep an item's Text nodes intact). At insertion, before hydration, `bind` walks the item's Text nodes once, checks each against its run's text (any mismatch leaves the item unmapped, with `data-unmapped`), and records `Text → (item, k)` in a `WeakMap`, plus `placeholder element → (first run, last run)` for `.tp-math`, `.tp-math-display` and `pre.tp-mermaid`. An endpoint looks its node up; inside a hydrated placeholder it walks up to the placeholder and snaps to its runs' outer edges (the whole `$…$` or fence); an element boundary resolves to the nearest Text node on the covered side; an unmapped item maps to its whole span. Nothing ever counts Text nodes after insertion, so KaTeX's and Mermaid's DOM can't shift a run. This also satisfies C4's constraint that the renderer must not split or normalize Text nodes inside a mapped item: it never touches them.
- **Notes ride on CSS** (`data-note` + `::before`): a note element would add a Text node and shift the runs.
- **The windowed list** mounts the items within one viewport above and below, measured heights for mounted items, a 48 px estimate otherwise, and spacers for the rest. Correcting heights keeps the reading anchor (spec §5.3): without that, a diagram that shrinks after hydration moves the content under the viewport and the window flaps between two states (seen: the scroll position never settled on the hostile corpus). It pages forward only (`ponytail:` — an anchored open can't scroll above its anchor; plan A's virtualizer is the M4 home).
- **Hydration** runs on mount: `renderMath` for `.tp-math`/`.tp-math-display`, `renderDiagram` for `pre.tp-mermaid`; image placeholders (`span.tp-img`) are never touched. `settled()` resolves when every pass has finished.
- **Copy** is `selection()` → `{gen, start, end}` → `read` through `Source.read`: the core refuses a stale generation or a changed file. The clipboard write itself is not wired (M6); the tests compare the bytes `copy()` returns.
- **Links** (C5a's `_top` gap): a capture-phase `click` and `auxclick` handler on the lens root calls `preventDefault` for every `<a>`, whatever the button or modifier, and logs `data-href` (C4's markup for an inert target) or `href`. Spec §5.4's link resolution is M4 work; the spike follows nothing.
- **Reconcile** (spec §14 D1): when the index job's last event says `done`, the view calls `mdReconcile` until it returns `[]`, swapping each item in by `(block, piece)` and remounting it if it's mounted.
- **Progress and the budget stop** (Z30, Z34). The status line is a live region outside `.md-scroller`, so it never adds a Text node to an item. It stays in the accessibility tree while empty (no `display: none`), so its next change is announced. On a last event with `reason`, the view stops whole: it drops its items, fetches nothing more, and says why and that Raw stays available. A truncated Rendered document would read as the whole file. Raw is untouched: it has its own lens and line index (plan A's `open(path, 'raw')`). The progress test watches the status line with a `MutationObserver` (a progress text can come and go between two polls) while a 59 MB file indexes, and needs at least two progress texts, then the line cleared. The budget test opens 5,000 blocks with `maxBlocks` 2, expects the announced reason by role and no `.md-item` left, then opens the same file in Raw and scrolls it to its last line, 9,999.
- **The oracle** (`mdgen.ts`) writes random headings and paragraphs element by element (words of ASCII, Latin-1, Greek, CJK and astral characters; strong, emphasis, strikethrough, code and link wraps; entities; backslash escapes; inline math) and records the bytes each displayed element owns under C4's rule (an opening marker joins the next character, a closing marker or line ending the previous one). It never sees runs or maps. The test locates each endpoint in the DOM from the generator's own text (and checks the DOM shows exactly that text), sets the selection, and compares `selection()` and `copy()` with the generator's bytes. Starts sometimes fall inside a surrogate pair (must snap back), ends too (must snap forward), and endpoints inside math are KaTeX's own Text nodes (must snap to the whole `$…$`).

- [ ] **Step 1: Write the oracle and the failing tests**

`spikes/app/e2e/mdgen.ts`:
<!-- op: create spikes/app/e2e/mdgen.ts -->
```ts
// Selection oracle for the Rendered lens (test-only). It writes random Markdown element by element and records the
// source bytes each displayed element owns: a character (one or two UTF-16 units), an entity, an escape, or a whole
// math span (math hydrates into KaTeX, so an endpoint inside it can only snap to the whole span). Ownership is the
// rule C4 settled (spec §3.2, mdemit.rs): an opening marker joins the next displayed character, a closing marker or a
// line ending joins the previous one. It never looks at the core's runs or byte maps.

export interface Shown {
  show: string // what the element displays
  src: string // the source it owns
  math?: boolean
  start: number // owned bytes [start, end) in the encoded file
  end: number
}
export interface GenDoc {
  bytes: Uint8Array
  blocks: Shown[][]
}
export type Enc = 'utf-8' | 'utf-16le'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CHARS = ['a', 'b', 'x', 'y', 'z', 'é', 'ß', 'Ω', '中', '文', '😀']
const ENTITIES: [string, string][] = [['&', '&amp;'], ['<', '&lt;'], ['é', '&#233;'], ['©', '&copy;'], ['😀', '&#x1F600;']]
const ESCAPES = ['*', '_', '#', '[', '\\', '`']
const WRAPS: [string, string][] = [['**', '**'], ['*', '*'], ['~~', '~~'], ['`', '`'], ['[', '](http://example.invalid/x)']]
const TEX = ['x^2', 'a+b', '\\frac{1}{2}', '\\sqrt{y}']

export const encode = (s: string, enc: Enc): Uint8Array => {
  if (enc === 'utf-8') return new TextEncoder().encode(s)
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    out[2 * i] = s.charCodeAt(i) & 0xff
    out[2 * i + 1] = s.charCodeAt(i) >> 8
  }
  return out
}

/** `blocks` paragraphs and headings separated by blank lines, encoded as `enc` (UTF-16LE with a BOM). */
export function genDoc(seed: number, enc: Enc, blocks: number): GenDoc {
  const r = rng(seed)
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
  const word = (): string[] => Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(CHARS))
  const out: Omit<Shown, 'start' | 'end'>[][] = []
  const eols: string[] = []
  for (let b = 0; b < blocks; b++) {
    const els: Omit<Shown, 'start' | 'end'>[] = []
    const chars = (cs: string[], open = '', close = ''): void =>
      cs.forEach((c, i) => els.push({ show: c, src: (i === 0 ? open : '') + c + (i === cs.length - 1 ? close : '') }))
    const heading = r() < 0.25
    if (heading) {
      chars(word(), '#'.repeat(1 + Math.floor(r() * 3)) + ' ')
    } else {
      chars(['a', ...word()]) // a plain letter first: the paragraph can't turn into another block
    }
    for (let s = 0, n = 2 + Math.floor(r() * 8); s < n; s++) {
      els.push({ show: ' ', src: ' ' })
      const k = r()
      if (k < 0.35) chars(word())
      else if (k < 0.55) {
        const [open, close] = pick(WRAPS)
        chars(open === '`' ? word().filter((c) => c !== '`') : word(), open, close)
      } else if (k < 0.7) {
        const [show, src] = pick(ENTITIES)
        els.push({ show, src })
      } else if (k < 0.82) {
        const c = pick(ESCAPES)
        els.push({ show: c, src: '\\' + c })
      } else {
        const tex = pick(TEX)
        els.push({ show: tex, src: `$${tex}$`, math: true })
      }
    }
    const eol = r() < 0.3 ? '\r\n' : '\n'
    els[els.length - 1].src += eol // a line ending joins the previous character
    out.push(els)
    eols.push(eol)
  }
  let pos = enc === 'utf-16le' ? 2 : 0 // the BOM
  const parts: Uint8Array[] = enc === 'utf-16le' ? [new Uint8Array([0xff, 0xfe])] : []
  const shown = out.map((els, b) => {
    const placed = els.map((e) => {
      const bytes = encode(e.src, enc)
      parts.push(bytes)
      const s = { ...e, start: pos, end: pos + bytes.length }
      pos = s.end
      return s
    })
    if (b < out.length - 1) {
      const gap = encode(eols[b], enc) // the blank line between blocks: no element owns it
      parts.push(gap)
      pos += gap.length
    }
    return placed
  })
  const bytes = new Uint8Array(pos)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  return { bytes, blocks: shown }
}
```
`spikes/app/e2e/rendered.e2e.ts`:
<!-- op: create spikes/app/e2e/rendered.e2e.ts -->
```ts
import { expect, test } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIX, launch } from './launch'
import { encode, genDoc, type Enc, type Shown } from './mdgen'

const DIR = join(FIX, 'rendered')
mkdirSync(DIR, { recursive: true })

/** launch, then wait for the core connection too: openRendered exists once the core port is up. */
async function ready(name: string): ReturnType<typeof launch> {
  const run = await launch(name)
  await run.win.waitForFunction(() => (window as any).__spike.openRendered, null, { timeout: 15_000 })
  return run
}

// A paragraph with an entity, an escape, CJK, an astral character and inline math followed by more text.
const HAND = '# Héllo wörld\n\nplain **bold** &amp; \\* 中文 😀 $x^2$ after `code` [link](http://example.invalid/l) end\n'
/** [start needle, offset in it], [end needle, offset in it], the exact source the copy must return. */
const PICKS: [[string, number], [string, number], string][] = [
  [['plain', 0], ['plain', 5], 'plain'],
  [['plain', 2], ['bold', 2], 'ain **bo'],
  [['&', 0], ['&', 1], '&amp;'],
  [['*', 0], ['*', 1], '\\*'],
  [['中', 0], ['中', 1], '中'],
  [['😀', 0], ['😀', 1], '😀'], // half a surrogate pair snaps outward
  [['😀', 1], ['😀', 2], '😀'],
  [['after', 0], ['after', 5], 'after'], // after the math placeholder that KaTeX hydrated: the pairing contract
  [['code', 0], ['code', 4], '`code`'],
  [['link', 0], ['link', 4], '[link](http://example.invalid/l)'],
  [['wörld', 0], ['plain', 5], 'wörld\n\nplain'], // across items
  [['Héllo', 0], ['Héllo', 5], '# Héllo'],
  [[' end', 1], [' end', 4], 'end\n']
]

for (const enc of ['utf-8', 'utf-16le'] as Enc[]) {
  test(`hand-picked selections copy their exact source bytes (${enc}), after hydrated math too`, async () => {
    const path = join(DIR, `hand-${enc}.md`)
    const bytes = enc === 'utf-8' ? encode(HAND, enc) : new Uint8Array([0xff, 0xfe, ...encode(HAND, enc)])
    writeFileSync(path, bytes)
    const { app, win } = await ready(`rendered-hand-${enc}`)
    const got = await win.evaluate(
      async ({ path, picks }) => {
        const view = await (window as any).__spike.openRendered(path)
        await view.settled()
        const MATH = '.tp-math, .tp-math-display'
        const texts = (root: Node): Text[] => {
          const out: Text[] = []
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text)
          return out
        }
        const find = ([needle, at]: [string, number]): [Text, number] => {
          const t = texts(view.root).find((n) => !n.parentElement!.closest(MATH) && n.data.includes(needle))!
          return [t, t.data.indexOf(needle) + at]
        }
        const copy = async ([an, ao]: [Node, number], [zn, zo]: [Node, number]): Promise<number[]> => {
          getSelection()!.setBaseAndExtent(an, ao, zn, zo)
          return Array.from(await view.copy())
        }
        const out = []
        for (const [a, z] of picks) out.push(await copy(find(a), find(z)))
        const inside = texts(document.querySelector(MATH)!) // KaTeX's own text nodes
        out.push(await copy([inside[0], 0], [inside[inside.length - 1], 1]))
        return out
      },
      { path, picks: PICKS.map(([a, z]) => [a, z]) }
    )
    const want = [...PICKS.map((p) => p[2]), '$x^2$']
    expect(got.map((b) => Buffer.from(b).toString(enc === 'utf-8' ? 'utf8' : 'utf16le'))).toEqual(want)
    expect(got.map((b) => b.length)).toEqual(want.map((s) => encode(s, enc).length))
    await app.close()
  })
}

test('byte maps end to end: 240 random selections, zero endpoint mismatches against the generator oracle', async () => {
  const { app, win } = await ready('rendered-random')
  let endpoints = 0
  const bad: string[] = []
  for (const [seed, enc] of [[1, 'utf-8'], [2, 'utf-16le']] as [number, Enc][]) {
    const doc = genDoc(seed, enc, 30)
    const path = join(DIR, `random-${enc}.md`)
    writeFileSync(path, doc.bytes)
    // Random endpoints as (block, element, unit offset): a start before an element's unit, an end after one. A
    // two-unit element (an astral character) sometimes gets an offset inside it, which must snap outward.
    let x = seed * 7919
    const r = (): number => ((x = (x * 48271) % 2147483647) / 2147483647)
    const all = doc.blocks.flatMap((els, b) => els.map((_, e) => [b, e]))
    const picks = Array.from({ length: 120 }, () => {
      const [p, q] = [all[Math.floor(r() * all.length)], all[Math.floor(r() * all.length)]].sort((u, v) => u[0] - v[0] || u[1] - v[1])
      const pa = doc.blocks[p[0]][p[1]]
      const qa = doc.blocks[q[0]][q[1]]
      const mid = (s: Shown): boolean => s.show.length === 2 && !s.math && r() < 0.5
      return { a: { b: p[0], e: p[1], k: mid(pa) ? 1 : 0, inner: r() }, z: { b: q[0], e: q[1], k: mid(qa) ? 1 : qa.show.length, inner: r() } }
    })
    const got = await win.evaluate(
      async ({ path, blocks, picks }) => {
        const view = await (window as any).__spike.openRendered(path)
        await view.settled()
        const MATH = '.tp-math, .tp-math-display'
        const texts = (root: Node): Text[] => {
          const out: Text[] = []
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text)
          return out
        }
        const items = [...view.root.querySelectorAll('.md-item')] as HTMLElement[]
        const problems = items.length === blocks.length ? [] : [`${items.length} items for ${blocks.length} blocks`]
        // The DOM's text outside math must be exactly the generator's displayed text.
        const plain = items.map((el, b) => {
          const nodes = texts(el).filter((t) => !t.parentElement!.closest(MATH))
          const want = blocks[b].filter((e: any) => !e.math).map((e: any) => e.show).join('')
          if (nodes.map((n) => n.data).join('') !== want) problems.push(`block ${b}: DOM text differs from ${JSON.stringify(want)}`)
          if (el.dataset.unmapped) problems.push(`block ${b}: unmapped (${el.dataset.unmapped})`)
          return nodes
        })
        const locate = ({ b, e, k, inner }: any, end: boolean): [Node, number] => {
          const els = blocks[b]
          if (els[e].math) {
            const math = items[b].querySelectorAll(MATH)[els.slice(0, e).filter((s: any) => s.math).length]
            const inside = texts(math)
            const t = inside[Math.floor(inner * inside.length)]
            return [t, Math.floor(inner * (t.length + 1))]
          }
          let p = 0
          for (let i = 0; i < e; i++) if (!els[i].math) p += els[i].show.length
          const unit = end ? p + k - 1 : p + k // the unit the endpoint touches
          let acc = 0
          for (const n of plain[b]) {
            if (unit < acc + n.length) return [n, p + k - acc]
            acc += n.length
          }
          throw new Error(`block ${b} element ${e}: no text node`)
        }
        const out = []
        for (const { a, z } of picks) {
          const [an, ao] = locate(a, false)
          const [zn, zo] = locate(z, true)
          getSelection()!.setBaseAndExtent(an, ao, zn, zo)
          out.push({ span: view.selection(), bytes: Array.from(await view.copy()) })
        }
        return { problems, out }
      },
      { path, blocks: doc.blocks, picks }
    )
    bad.push(...got.problems)
    got.out.forEach(({ span, bytes }: { span: { start: number; end: number }; bytes: number[] }, i: number) => {
      const { a, z } = picks[i]
      const start = doc.blocks[a.b][a.e].start
      const end = doc.blocks[z.b][z.e].end
      endpoints += 2
      if (span.start !== start) bad.push(`${enc} pick ${i}: start ${span.start}, want ${start} (${JSON.stringify(a)})`)
      if (span.end !== end) bad.push(`${enc} pick ${i}: end ${span.end}, want ${end} (${JSON.stringify(z)})`)
      if (Buffer.compare(Buffer.from(bytes), Buffer.from(doc.bytes.subarray(start, end))) !== 0) bad.push(`${enc} pick ${i}: copy differs from the file`)
    })
  }
  console.log(`byte maps end to end: 240 selections, ${endpoints} endpoints, ${bad.length} mismatches`)
  expect(bad.slice(0, 10)).toEqual([])
  await app.close()
})

test('copy is refused once the file changes, and for a stale generation after reload', async () => {
  const path = join(DIR, 'stale.md')
  writeFileSync(path, HAND)
  const { app, win } = await ready('rendered-stale')
  const select = (): Promise<unknown> =>
    win.evaluate(() => {
      const view = (window as any).__spike.rendered
      const w = document.createTreeWalker(view.root, NodeFilter.SHOW_TEXT)
      let n = w.nextNode() as Text
      while (!n.data.includes('plain')) n = w.nextNode() as Text
      getSelection()!.setBaseAndExtent(n, 0, n, 5)
      return view.selection()
    })
  const copy = (): Promise<string> =>
    win.evaluate(() => (window as any).__spike.rendered.copy().then((b: Uint8Array) => new TextDecoder().decode(b), (e: Error) => e.message))
  await win.evaluate((p) => (window as any).__spike.openRendered(p), path)
  expect(await select()).toEqual({ gen: 1, start: 17, end: 22 })
  expect(await copy()).toBe('plain')
  appendFileSync(path, 'more\n')
  expect(await copy()).toBe('Error: frozen: changed on disk') // the core host's String(err)
  const reloaded = await win.evaluate(() => (window as any).__spike.core.call('reload', { doc: (window as any).__spike.rendered.opened.doc }))
  expect(reloaded).toEqual({ gen: 2 })
  expect(await copy()).toBe('Error: stale span (generation 1, now 2)')
  const fresh = await win.evaluate(() => {
    const s = (window as any).__spike
    return s.core.call('read', { doc: s.rendered.opened.doc, gen: 2, start: 17, end: 22 }).then((b: Uint8Array) => new TextDecoder().decode(b))
  })
  expect(fresh).toBe('plain')
  await app.close()
})

test('while Rendered indexes, the lens reports progress in a status line, and clears it when done', async () => {
  const path = join(DIR, 'progress.md')
  writeFileSync(path, 'lorem ipsum dolor sit amet, consectetur *adipiscing* elit\n\n'.repeat(1_000_000)) // 59 MB
  const { app, win } = await ready('rendered-progress')
  await win.evaluate(async (p) => {
    const texts: string[] = ((window as any).statusTexts = [])
    // Every text the lens's status line shows, from before it exists: progress can come and go between two polls.
    new MutationObserver(() => {
      const text = document.querySelector('#card [role="status"]')?.textContent ?? null
      if (text !== null && text !== texts.at(-1)) texts.push(text)
    }).observe(document.getElementById('card')!, { subtree: true, childList: true, characterData: true })
    await (window as any).__spike.openRendered(p)
  }, path)
  await win.waitForFunction(
    async () => {
      const s = (window as any).__spike
      return (await s.core.call('mdOutline', { doc: s.rendered.opened.doc })).done
    },
    null,
    { timeout: 15_000, polling: 100 }
  )
  await expect(win.getByRole('status')).toHaveText('') // the job's last event clears it
  const texts: string[] = await win.evaluate(() => (window as any).statusTexts)
  console.log(JSON.stringify(texts))
  expect(texts.filter((t) => /^Indexing for Rendered: [\d.]+ of 59\.0 MB, [\d,]+ blocks$/.test(t)).length).toBeGreaterThanOrEqual(2)
  expect(texts.at(-1)).toBe('')
  await app.close()
})

test('over its block budget, Rendered stops with an announced reason, and Raw still pages the file', async () => {
  const path = join(DIR, 'budget.md')
  writeFileSync(path, Array.from({ length: 5000 }, (_, i) => `block ${i}\n`).join('\n')) // 5,000 blocks, 9,999 lines
  const { app, win } = await ready('rendered-budget')
  await win.evaluate((p) => (window as any).__spike.openRendered(p, 0, 2), path) // a budget of 2 blocks
  const status = win.getByRole('status') // a live region: screen readers announce it
  await expect(status).toHaveText('Rendered is unavailable: this file has more blocks than the memory budget allows. Raw stays available.')
  await expect(win.locator('.md-item')).toHaveCount(0) // stopped whole: no partial document on screen
  await win.evaluate((p) => (window as any).__spike.open(p, 'raw'), path)
  await win.waitForFunction(() => (window as any).__spike.indexDone)
  await win.evaluate(() => (window as any).__spike.view.list.scrollToRow(9998))
  await win.waitForFunction(() => [...document.querySelectorAll('.vl-row')].some((r) => r.textContent === '9999block 4999'))
  await app.close()
})

test('a reference defined after the first window re-renders its item in place (reconcile)', async () => {
  const path = join(DIR, 'reconcile.md')
  writeFileSync(path, `see [x][ref]\n\n${'filler text for the first window.\n\n'.repeat(3000)}[ref]: /url\n`)
  const { app, win } = await ready('rendered-reconcile')
  const first = await win.evaluate(async (p) => (await (window as any).__spike.openRendered(p)).opened.items[0].html, path)
  expect(first).toBe('<p>see [x][ref]</p>') // provisional: the definition wasn't indexed yet
  await win.waitForFunction(() => document.querySelector('.md-item a[href="/url"]'))
  expect(await win.evaluate(() => document.querySelector('.md-item')!.innerHTML)).toBe('<p>see <a href="/url">x</a></p>')
  await app.close()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e rendered`
Expected: FAIL, `7 failed`, each `TimeoutError: page.waitForFunction: Timeout 15000ms exceeded.` (`__spike.openRendered` doesn't exist yet).

- [ ] **Step 3: Implement the lens and expose it**

`spikes/app/src/renderer/src/rendered.ts`:
<!-- op: create spikes/app/src/renderer/src/rendered.ts -->
```ts
// The Rendered lens (spec §4.6, §5.2): the core's sanitized HTML, one element per item, in a simple windowed list.
// The renderer never parses Markdown. A selection maps to source bytes through its text runs' byte maps (spec §3.2),
// and copy reads those bytes back through the core's verified path (spec §3.1). No link is ever followed here.
import { endByte, startByte, type ByteMap } from './bytemap'
import type { Core, CoreEvent } from './core'
import { renderMath } from './math/math'
import { renderDiagram } from './mermaid/diagram'
import type { PerfLog } from './perf'

export interface MdItem {
  block: number
  piece: number
  pieces: number
  span: [number, number]
  html: string
  runs: { text: string; map: ByteMap }[]
  unmapped: string | null
  note: string | null
}

export interface MdOpened {
  doc: number
  gen: number
  size: number
  encoding: string
  job: number
  items: MdItem[]
}

/** A selection as source bytes of one generation (spec §3.2's SourceRef, primary span only). */
export interface SourceSpan {
  gen: number
  start: number
  end: number
}

// The pairing contract (C4 decision 5): run k is the k-th Text node of a freshly inserted item. KaTeX and Mermaid
// replace their placeholder's content, which would shift every later run, so each Text node is bound to its run once,
// at insertion, before anything hydrates. An endpoint then looks its node up instead of counting nodes.
const runOf = new WeakMap<Text, { item: MdItem; k: number }>()
/** A hydrated placeholder stands for the runs it held: an endpoint inside it snaps to their outer edges. */
const heldBy = new WeakMap<Element, { item: MdItem; first: number; last: number }>()
/** Every mounted item element: an endpoint the runs can't place snaps to the item's whole span. */
const itemOf = new WeakMap<Element, MdItem>()

const PLACEHOLDERS = '.tp-math, .tp-math-display, pre.tp-mermaid'

function textNodes(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** Binds a freshly inserted item's Text nodes to its runs. False if they don't pair one to one: the item is unmapped. */
function bind(el: HTMLElement, item: MdItem): boolean {
  itemOf.set(el, item)
  const nodes = textNodes(el)
  if (item.unmapped || nodes.length !== item.runs.length || nodes.some((n, k) => n.data !== item.runs[k].text)) return false
  nodes.forEach((n, k) => runOf.set(n, { item, k }))
  for (const p of el.querySelectorAll(PLACEHOLDERS)) {
    const ks = textNodes(p).map((n) => runOf.get(n)!.k)
    if (ks.length) heldBy.set(p, { item, first: ks[0], last: ks[ks.length - 1] })
  }
  return true
}

/** KaTeX in its worker, Mermaid in its sandboxed frame (C5a). Image placeholders stay inert. */
function hydrate(el: HTMLElement): Promise<unknown> {
  const math = [...el.querySelectorAll<HTMLElement>('.tp-math, .tp-math-display')].map((p) =>
    renderMath(p, p.textContent ?? '', p.classList.contains('tp-math-display'))
  )
  const diagrams = [...el.querySelectorAll<HTMLElement>('pre.tp-mermaid')].map((p) => renderDiagram(p, p.textContent ?? ''))
  return Promise.allSettled([...math, ...diagrams])
}

function textEndpoint(t: Text, at: number, end: boolean): number | null {
  const bound = runOf.get(t)
  if (bound) {
    const map = bound.item.runs[bound.k].map
    return end ? endByte(map, at) : startByte(map, at)
  }
  for (let el = t.parentElement; el; el = el.parentElement) {
    const held = heldBy.get(el)
    if (held) return end ? endByte(held.item.runs[held.last].map, Infinity) : startByte(held.item.runs[held.first].map, 0)
    const item = itemOf.get(el)
    if (item) return end ? item.span[1] : item.span[0]
  }
  return null
}

/** A selection endpoint → source byte (spec §3.2): a start snaps back, an end forward. Null outside any item. */
export function endpointByte(scope: Node, node: Node, offset: number, end: boolean): number | null {
  if (node instanceof Text) return textEndpoint(node, offset, end)
  // An element boundary: the nearest text on the side the selection covers.
  const at = document.createRange()
  at.setStart(node, offset)
  let before: Text | null = null
  for (const t of textNodes(scope)) {
    if (at.comparePoint(t, 0) >= 0) return end && before ? textEndpoint(before, before.length, true) : textEndpoint(t, 0, end)
    before = t
  }
  return before && textEndpoint(before, before.length, end)
}

const OVERSCAN = 1 // viewports mounted above and below the visible one (spec §5.3)
const ESTIMATE = 48 // px, for an item not measured yet

// ponytail: a forward windowed list. It keeps every fetched item's data and pages forward only, so an anchored open
// can't scroll above its anchor; move to plan A's virtualizer (measured layout, both directions) for M4.
export class RenderedView {
  readonly root: HTMLDivElement
  /** Every link click, never followed (spec §5.4 is later work): `data-href` when the core put the target there, else `href`. */
  readonly clicked: (string | null)[] = []
  private readonly items: MdItem[]
  private readonly heights: number[] = []
  private readonly mounted = new Map<number, HTMLElement>()
  private readonly top = document.createElement('div')
  private readonly bottom = document.createElement('div')
  private readonly hydrating = new Set<Promise<unknown>>()
  /** Indexing progress, or why Rendered stopped: a live region outside the items, so it never shifts a run. */
  private readonly status = document.createElement('div')
  private more = true
  private fetching = false
  private stopped = false
  private firstScreenDone = false

  constructor(
    parent: HTMLElement,
    private readonly core: Core,
    readonly opened: MdOpened,
    private readonly perf: PerfLog
  ) {
    this.items = [...opened.items]
    this.root = Object.assign(document.createElement('div'), { className: 'md-scroller' })
    this.root.append(this.top, this.bottom)
    this.status.className = 'md-status'
    this.status.setAttribute('role', 'status') // polite: screen readers announce each change
    parent.replaceChildren(this.root, this.status)
    const stop = (e: MouseEvent): void => {
      const a = (e.target as Element | null)?.closest?.('a')
      if (!a) return
      e.preventDefault() // every click: plain, modified, middle, or Enter on a focused link
      const target = a.getAttribute('data-href') ?? a.getAttribute('href')
      this.clicked.push(target)
      console.info(`link not followed: ${target}`)
    }
    this.root.addEventListener('click', stop, true)
    this.root.addEventListener('auxclick', stop, true)
    this.root.addEventListener('scroll', () => this.render())
    new ResizeObserver(() => this.render()).observe(this.root)
    core.onEvent((e) => void this.onEvent(e))
    this.render()
  }

  /** The current selection as a source span, or null if it isn't in this view (spec §5.2 `selection()`). */
  selection(): SourceSpan | null {
    const sel = getSelection()
    if (!sel?.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (!this.root.contains(r.commonAncestorContainer)) return null
    const start = endpointByte(this.root, r.startContainer, r.startOffset, false)
    const end = endpointByte(this.root, r.endContainer, r.endOffset, true)
    return start === null || end === null ? null : { gen: this.opened.gen, start, end: Math.max(start, end) }
  }

  /** Copy (brief §7.4): the selection's source bytes, read through the core's verified path. Refused once stale. */
  async copy(): Promise<Uint8Array | null> {
    const span = this.selection()
    return span && this.core.call<Uint8Array>('read', { doc: this.opened.doc, ...span })
  }

  /** Resolves once every mounted item's KaTeX and Mermaid passes have finished. */
  async settled(): Promise<void> {
    while (this.hydrating.size) await Promise.allSettled([...this.hydrating])
  }

  private async onEvent(e: CoreEvent): Promise<void> {
    if (e.event !== 'job' || e.job !== this.opened.job) return
    if (e.running) {
      const mb = (n: number): string => (n / 1e6).toFixed(1)
      const blocks = (e.count as number).toLocaleString('en-US')
      this.status.textContent = `Indexing for Rendered: ${mb(e.bytes as number)} of ${mb(this.opened.size)} MB, ${blocks} blocks`
      return
    }
    this.status.textContent = ''
    if (e.reason) return this.stop(e.reason as string)
    if (!e.done) return
    // Spec §14 D1: the first screen rendered provisionally; swap in the items whose references are now indexed,
    // a page (256 KiB of HTML) per call until none are left.
    for (let fresh: MdItem[]; (fresh = await this.core.call<MdItem[]>('mdReconcile', { doc: this.opened.doc })).length; ) {
      for (const item of fresh) {
        const i = this.items.findIndex((x) => x.block === item.block && x.piece === item.piece)
        if (i < 0) continue
        this.items[i] = item
        const old = this.mounted.get(i)
        if (!old) continue
        const el = this.mount(item)
        old.replaceWith(el)
        this.mounted.set(i, el)
      }
    }
    this.render()
  }

  /**
   * Spec §3.6: over its budget the index stopped, so Rendered stops whole (a truncated document would mislead) and
   * says why. Raw is untouched: it has its own lens and line index.
   */
  private stop(reason: string): void {
    this.stopped = true
    this.more = false
    this.items.length = 0
    this.render()
    this.status.textContent = `${reason} Raw stays available.`
  }

  private height(i: number): number {
    return this.heights[i] ?? ESTIMATE
  }

  private render(): void {
    // Spec §5.3: correcting heights (a diagram drew, an item re-mounted) keeps the reading anchor, the item at the
    // top edge, where it is on screen. Without this the content shifts under the viewport and the window flaps.
    let anchor = 0
    let y = 0
    while (anchor < this.items.length - 1 && y + this.height(anchor) <= this.root.scrollTop) y += this.height(anchor++)
    const within = this.root.scrollTop - y
    for (const [i, el] of this.mounted) this.heights[i] = el.offsetHeight
    let scrollTop = within
    for (let i = 0; i < anchor; i++) scrollTop += this.height(i)
    const vp = this.root.clientHeight
    const from = scrollTop - OVERSCAN * vp
    const to = scrollTop + (1 + OVERSCAN) * vp
    let lo = 0
    let above = 0
    while (lo < this.items.length && above + this.height(lo) <= from) above += this.height(lo++)
    let hi = lo
    let reach = above
    while (hi < this.items.length && reach < to) reach += this.height(hi++)
    for (const [i, el] of this.mounted) {
      if (i < lo || i >= hi) {
        el.remove()
        this.mounted.delete(i)
      }
    }
    let next: Element = this.bottom
    for (let i = hi - 1; i >= lo; i--) {
      let el = this.mounted.get(i)
      if (!el) {
        el = this.mount(this.items[i])
        next.before(el)
        this.mounted.set(i, el)
      }
      next = el
    }
    for (let i = lo; i < hi; i++) this.heights[i] = this.mounted.get(i)!.offsetHeight
    let below = 0
    for (let i = hi; i < this.items.length; i++) below += this.height(i)
    this.top.style.height = `${above}px`
    this.bottom.style.height = `${below}px`
    if (Math.abs(this.root.scrollTop - scrollTop) >= 1) this.root.scrollTop = scrollTop
    reach = above
    for (let i = lo; i < hi; i++) reach += this.heights[i]
    if (hi === this.items.length && this.more && reach < to) void this.fetch()
    if (!this.firstScreenDone && (reach >= scrollTop + vp || !this.more)) {
      this.firstScreenDone = true
      // rAF then a task: the mark lands after the frame that shows the items has painted (as plan A's first screen).
      requestAnimationFrame(() => setTimeout(() => this.perf.mark('firstScreen')))
    }
  }

  private async fetch(): Promise<void> {
    if (this.fetching) return
    this.fetching = true
    const last = this.items[this.items.length - 1]
    const page = await this.core.call<MdItem[]>('mdPage', {
      doc: this.opened.doc,
      block: last ? last.block : 0,
      item: last ? last.piece + 1 : 0,
      count: 50
    })
    if (this.stopped) return
    this.more = page.length > 0
    this.items.push(...page)
    this.fetching = false
    this.render()
  }

  private mount(item: MdItem): HTMLElement {
    const el = document.createElement('div')
    el.className = 'md-item'
    el.dataset.key = `${item.block}:${item.piece}` // the item's identity (spec §4.6: one block identity, its pieces)
    // A note shows through CSS: a note element would add a Text node and shift the runs.
    if (item.note) el.dataset.note = item.note
    el.innerHTML = item.html // sanitized by the core (spec §4.6)
    if (!bind(el, item)) el.dataset.unmapped = item.unmapped ?? 'its DOM text does not pair with its runs'
    const done = hydrate(el)
    this.hydrating.add(done)
    void done.finally(() => {
      this.hydrating.delete(done)
      this.render() // its height changed
    })
    return el
  }
}
```
In `spikes/app/src/renderer/src/main.ts` replace:
<!-- op: replace spikes/app/src/renderer/src/main.ts -->
```ts
import { PerfLog } from './perf'
```
with:
```ts
import { PerfLog } from './perf'
import { RenderedView, type MdOpened } from './rendered'
```
and replace:
<!-- op: replace spikes/app/src/renderer/src/main.ts -->
```ts
spike.open = open
```
with:
```ts
spike.open = open

/** Opens Markdown into the Rendered lens, at block `anchor` (spec §5.2's mount(el, doc, anchor)), within `maxBlocks`. */
async function openRendered(path: string, anchor = 0, maxBlocks?: number): Promise<RenderedView> {
  perf.mark('openStart')
  const opened = await core.call<MdOpened>('mdOpen', { path, block: anchor, maxBlocks })
  const view = new RenderedView(document.getElementById('card')!, core, opened, perf)
  spike.rendered = view
  return view
}
spike.openRendered = openRendered
```
In `spikes/app/src/renderer/src/style.css` replace:
<!-- op: replace spikes/app/src/renderer/src/style.css -->
```css
.vl-row .pill { display: inline-block; padding: 0 6px; margin-right: 8px; border-radius: 6px; background: #1e2a4a; color: #a9c1ff; }
```
with:
```css
.vl-row .pill { display: inline-block; padding: 0 6px; margin-right: 8px; border-radius: 6px; background: #1e2a4a; color: #a9c1ff; }
.md-scroller { position: absolute; inset: 0; overflow-y: auto; padding: 0 24px; overflow-wrap: anywhere; overflow-anchor: none; }
.md-item pre { white-space: pre-wrap; }
.md-item[data-note]::before { content: attr(data-note); display: block; color: var(--warn); }
.md-status { position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 24px; background: var(--surface); color: var(--text2); }
.md-status:empty { padding: 0; } /* still in the accessibility tree, so its next change is announced */
```

- [ ] **Step 4: Run them until they pass**

Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e rendered`
Expected: `7 passed`, the line `byte maps end to end: 240 selections, 480 endpoints, 0 mismatches`, and the status line's texts while the 59 MB file indexes, in this shape (the count of progress lines varies, at least 2):
```text
["","Indexing for Rendered: 14.5 of 59.0 MB, 246,420 blocks","Indexing for Rendered: 25.3 of 59.0 MB, 428,460 blocks","Indexing for Rendered: 36.7 of 59.0 MB, 622,710 blocks","Indexing for Rendered: 49.4 of 59.0 MB, 836,940 blocks",""]
```

- [ ] **Step 5: Falsify the pairing**

Count Text nodes at selection time instead of using the binding made at insertion. In `rendered.ts`, temporary replace:
<!-- op: temporary spikes/app/src/renderer/src/rendered.ts -->
```ts
  const bound = runOf.get(t)
```
temporarily with:
```ts
  const root = t.parentElement?.closest('.md-item')
  const bound = root && itemOf.get(root) && { item: itemOf.get(root)!, k: textNodes(root).indexOf(t) } // naive: count Text nodes now
```
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e rendered`
Expected: `3 failed`, `4 passed`: both hand-picked tests and the random test fail with `TypeError: Cannot read properties of undefined (reading 'map')` — after KaTeX hydrated, the k-th Text node of an item is past its last run. The stale-copy, progress, budget and reconcile tests still pass.
Put the original line back (the two lines become `  const bound = runOf.get(t)` again; `rendered.ts` is new in this task, so `git checkout` can't restore it), rebuild, rerun: `7 passed`.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/rendered.ts spikes/app/src/renderer/src/main.ts spikes/app/src/renderer/src/style.css spikes/app/e2e/mdgen.ts spikes/app/e2e/rendered.e2e.ts
git commit -m "spike(c): Rendered lens with run binding before hydration; selections copy exact source bytes"
```

---

## Task C5b3: Nothing navigates, and zero effects for hostile Markdown in Rendered

**Files:**
- Modify: `spikes/core/spike-core/src/md_gates.rs` (append `NAV_PROBES`, `contexts`, `all_items`, `no_output_can_navigate`, `write_hostile_corpus`)
- Create: `spikes/app/e2e/md-effects.e2e.ts`

**Interfaces:**
- **Consumes:** C4d's `HOSTILE` (71 payloads), `check_items`, `temp_file`; `MdDoc::page`; `launchRecorded` and `EffectsReport` (C5a5), `HOSTILE_MERMAID` and `HOSTILE_TEX` (C5a3); `RenderedView` (Task C5b2).
- **Produces:** `cargo test -p spike-core write_hostile_corpus -- --ignored` writes `spikes/.fixtures/md-hostile/NNN-C.md`: the 71 payloads and 12 navigation probes, each in C4d's 6 contexts (498 files). The e2e test writes `spikes/.fixtures/md-extras.md` (5 unclicked images: remote, protocol-relative, UNC, `smb:`, raw `<img>`; every hostile Mermaid source as a fenced diagram; every hostile TeX as display math; the links) and `md-links.md`.

**Design notes:**
- **Can sanitizer output navigate?** No. C4's `check_output` already limits `<a>` to `href` and `data-href` and rejects `form`; `no_output_can_navigate` adds payloads aimed at navigation (`target` plain, unquoted and entity-encoded; `base target`; forms with a button, `formaction` and `formtarget`; `area`; svg and math links; `ping`; `{target=_top}` after a Markdown link) and checks every emitted tag for a form, button, `base`, `meta`, `area`, frame, `object`, `embed`, `link`, `svg` or `math`, and for `target`, `formaction`, `formtarget`, `action` and `ping`. Serialized HTML escapes `<` in text, so every `<` opens a tag and escaped payload text can't cause a false alarm.
- **Links in the app.** Sixteen links cover C4's three outcomes: live (http, https, mailto, relative, `./`, rooted, `#fragment`, wikilink, autolink, raw `<a>`), inert behind `href="#"` with `data-href` (protocol-relative, UNC, `file:`, `smb:`, `about:`) and dropped (`javascript:`). The test first asserts each link's `href` and `data-href`, then clicks each one plainly, with Ctrl, with Shift, with the middle button, and with Enter after focusing it. The page URL (fragment included) and the window count must not change, the lens must log every click with its target, and the effects harness must see no denied navigation at all: a request that reaches `will-navigate` is already a failure, because a `_top` navigation from a frame and a same-document `#fragment` navigation never reach it.
- **Zero effects:** all 500 files are opened in Rendered in one recorded launch and scrolled to the end, so every item mounts and hydrates once; the DOM may hold no `img`, `a[target]`, form, button, `base`, `meta`, `area`, `object`, `embed`, `link` or non-`sandbox=""` frame. Then C5a's five detectors must report nothing.
- **Falsification in this setting:** after rendering `md-extras.md` in the same kind of launch, one deliberate effect per detector: a Markdown document that isn't in `opened` (through `mdOpen`, so the core host's own `open` report is what's caught), an http image in a test-only window (guard log), the same in a guard-less partition (NetLog), a DNS lookup in main (tripwire, armed first), and a second utility process (process diff).

- [ ] **Step 1: The navigation probe and the corpus writer**

In `spikes/core/spike-core/src/md_gates.rs`, at the end of the file, replace:
<!-- op: replace spikes/core/spike-core/src/md_gates.rs -->
```rust
    println!("sanitizer gate: {} payloads × 6 contexts, {outputs} outputs: all pass", HOSTILE.len());
}
```
with:
```rust
    println!("sanitizer gate: {} payloads × 6 contexts, {outputs} outputs: all pass", HOSTILE.len());
}

// ---- C5b: no output can navigate, and the hostile corpus as files for the app's zero-effects gate ----

/// Payloads aimed at navigation: `target`, forms and form controls, `base`, `area`, `ping`, svg/math links.
const NAV_PROBES: [&str; 12] = [
    "<a href=\"https://example.invalid/\" target=\"_top\">t</a>",
    "<a target=_blank href=x>b</a>",
    "<a href=\"x\" target=\"&#95;top\">e</a>",
    "<base target=\"_top\"><a href=\"x\">x</a>",
    "<form action=\"https://example.invalid/\"><button>go</button></form>",
    "<form><input type=\"submit\" formaction=\"https://example.invalid/\" formtarget=\"_top\"></form>",
    "<area href=\"https://example.invalid/\" target=\"_top\">",
    "<svg><a href=\"https://example.invalid/\" target=\"_top\"><text>s</text></a></svg>",
    "<math><a href=\"https://example.invalid/\" target=\"_top\">m</a></math>",
    "<details open><summary><a href=\"x\" target=\"_top\">s</a></summary></details>",
    "<a href=\"https://example.invalid/\" ping=\"https://example.invalid/p\" rel=\"opener\" download>p</a>",
    "[t](https://example.invalid/ \"title\"){target=_top}",
];

/// The six contexts `gate_hostile_html_and_mxss` puts every payload in.
fn contexts(payload: &str) -> [String; 6] {
    [
        format!("intro\n\n{payload}\n"),
        format!("x {payload} y\n"),
        format!("- {payload}\n"),
        format!("> {payload}\n"),
        format!("| a |\n|---|\n| {payload} |\n"),
        format!("# {payload}\n"),
    ]
}

/// Every item of `md`, page by page.
fn all_items(md: &str) -> Vec<Item> {
    let doc = MdDoc::new(ByteStore::open(&temp_file("nav", md.as_bytes())).unwrap(), UTF_8, MdConfig::default());
    let (mut items, mut from) = (Vec::new(), (0, 0));
    loop {
        let page = doc.page(from, 1000).unwrap();
        let Some(last) = page.last() else { return items };
        from = (last.block, last.piece as usize + 1);
        items.extend(page);
    }
}

/// Brief §4.6, spec §7.1 (C5b): no sanitized output can navigate the app or a frame. No tag the core emits is a form,
/// a form control that submits, `base`, `meta`, `area`, a frame or an embed, and none carries `target`, `formaction`,
/// `formtarget`, `action` or `ping`. Serialized HTML escapes `<` in text, so every `<` opens a tag.
#[test]
fn no_output_can_navigate() {
    const TAGS: [&str; 12] = ["form", "button", "base", "meta", "area", "iframe", "frame", "object", "embed", "link", "svg", "math"];
    const ATTRS: [&str; 5] = [" target=", " formaction=", " formtarget=", " action=", " ping="];
    let mut outputs = 0;
    for payload in HOSTILE.iter().map(|h| h.0).chain(NAV_PROBES) {
        for md in contexts(payload) {
            let items = all_items(&md);
            for it in &items {
                for tag in it.html.split('<').skip(1).map(|s| s[..s.find('>').unwrap_or(s.len())].to_ascii_lowercase()) {
                    let name = tag.trim_start_matches('/').split([' ', '/']).next().unwrap_or("");
                    assert!(!TAGS.contains(&name) && !ATTRS.iter().any(|a| tag.contains(a)), "{md:?}: <{tag}> in {:?}", it.html);
                }
            }
            check_items(&items).unwrap_or_else(|e| panic!("{md:?}: {e}"));
            outputs += items.len();
        }
    }
    println!("navigation probe: {} payloads × 6 contexts, {outputs} outputs: no form, target, base, area, frame or ping", HOSTILE.len() + NAV_PROBES.len());
}

/// The hostile corpus as files for the app's zero-effects gate (C5b): every payload in every context, one file each,
/// in `spikes/.fixtures/md-hostile/`. Run: `cargo test -p spike-core write_hostile_corpus -- --ignored`.
#[test]
#[ignore]
fn write_hostile_corpus() {
    let dir = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.fixtures/md-hostile"));
    std::fs::create_dir_all(&dir).unwrap();
    let mut n = 0;
    for (i, payload) in HOSTILE.iter().map(|h| h.0).chain(NAV_PROBES).enumerate() {
        for (c, md) in contexts(payload).iter().enumerate() {
            std::fs::write(dir.join(format!("{i:03}-{c}.md")), md).unwrap();
            n += 1;
        }
    }
    println!("wrote {n} files");
}
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::no_output -- --nocapture`
Expected: `navigation probe: 83 payloads × 6 contexts, 619 outputs: no form, target, base, area, frame or ping` and `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 128 filtered out`. The probe is a gate on C4's sanitizer as it stands, so it passes at once; Step 2 shows it can fail.

- [ ] **Step 2: Falsify the probe**

Let ammonia keep `target`, and let a live link keep the tag ammonia wrote (round 1's `sanitize` rebuilds every `<a>` from its target alone, so the first edit by itself changes nothing). In `spikes/core/spike-core/src/sanitize.rs`, temporary replace:
<!-- op: temporary spikes/core/spike-core/src/sanitize.rs -->
```rust
        ("a", &["href", "data-href"]),
```
temporarily with:
```rust
        ("a", &["href", "data-href", "target"]),
```
and temporarily replace:
<!-- op: temporary spikes/core/spike-core/src/sanitize.rs -->
```rust
                Target::Live => out.push_str(&format!("<a href=\"{v}\">")),
```
temporarily with:
```rust
                Target::Live => out.push_str(tag),
```
Run (`spikes/core`): `cargo test -p spike-core md_gates::no_output`
Expected: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 128 filtered out`, after the first payload that carries `target` (one of C4d's round-1 payloads; `escape_raw` has already moved a raw `href` to `data-href`):
```text
"intro\n\n<a title=\"t\" target=\"_blank\" rel=\"opener\" href=\"https://ok/\">t</a>\n": <a target="_blank" data-href="https://ok/"> in "<p><a target=\"_blank\" data-href=\"https://ok/\">t</a></p>"
```
With only the first edit, the probe still passes (`1 passed`).
Restore it: `git checkout -- spike-core/src/sanitize.rs`.

- [ ] **Step 3: Write the corpus**

Run (`spikes/core`): `cargo test -p spike-core write_hostile_corpus -- --ignored --nocapture`
Expected: `wrote 498 files` and `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 128 filtered out`.

- [ ] **Step 4: Write and run the app's gates**

`spikes/app/e2e/md-effects.e2e.ts`:
<!-- op: create spikes/app/e2e/md-effects.e2e.ts -->
```ts
import { expect, test } from '@playwright/test'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRecorded } from './effects'
import { HOSTILE_MERMAID, HOSTILE_TEX } from './hostile'
import { FIX } from './launch'

// C4's 71 sanitizer payloads plus the 12 navigation probes, each in 6 contexts: written by
// `cargo test -p spike-core write_hostile_corpus -- --ignored` (spikes/core).
const CORPUS = join(FIX, 'md-hostile')
const corpus = (): string[] => readdirSync(CORPUS).map((f) => join(CORPUS, f))

// Every kind of link target C4's contract sorts: live, inert (moved to data-href) and dropped (brief §4.4, §4.6).
const LINKS = [
  '[http](http://example.invalid/h)',
  '[https](https://example.invalid/s)',
  '[mail](mailto:a@example.invalid)',
  '[relative](other.md)',
  '[dot](./sub/x.md)',
  '[rooted](/root.md)',
  '[fragment](#fragment)',
  '[[Wiki Page]]',
  '<https://example.invalid/auto>',
  '<a href="https://example.invalid/raw">raw</a>',
  '[network](//example.invalid/net)',
  '[unc](\\\\\\\\host\\\\share\\\\x.md)',
  '[file](file:///C:/Windows/win.ini)',
  '[smb](smb://example.invalid/x)',
  '[js](javascript:alert(1))',
  '[blank](about:blank)'
]

/** Mermaid and KaTeX inside Markdown, unclicked remote, UNC and smb images, and the links. */
function extras(): { all: string; links: string } {
  mkdirSync(FIX, { recursive: true })
  const links = join(FIX, 'md-links.md')
  writeFileSync(links, `${LINKS.join(' ')}\n\n# fragment\n`)
  const all = join(FIX, 'md-extras.md')
  const images = [
    '![remote](https://example.invalid/r.png)',
    '![network](//example.invalid/p.png)',
    '![unc](\\\\\\\\host\\\\share\\\\u.png)',
    '![smb](smb://example.invalid/s.png)',
    '<img src="https://example.invalid/raw.png" alt="raw">'
  ]
  const blocks = [
    images.join(' '),
    ...HOSTILE_MERMAID.map((m) => '````mermaid\n' + m.source + '\n````'),
    ...HOSTILE_TEX.map((t) => `$$${t}$$`),
    LINKS.join(' ')
  ]
  writeFileSync(all, blocks.join('\n\n') + '\n')
  return { all, links }
}

test('zero effects: hostile Markdown, Mermaid, KaTeX and unclicked remote images in Rendered', async () => {
  const { all, links } = extras()
  const files = [...corpus(), all, links]
  expect(files.length).toBe(500)
  const run = await launchRecorded('md-hostile', {}, files)
  await run.win.waitForFunction(() => (window as any).__spike.openRendered)
  const seen = await run.win.evaluate(async (paths) => {
    const s = (window as any).__spike
    const tally = { files: 0, items: 0, unmapped: 0, frames: 0, math: 0, images: 0, links: 0, problems: [] as string[], bad: [] as string[] }
    const frame = (): Promise<void> => new Promise((ok) => requestAnimationFrame(() => setTimeout(ok)))
    for (const p of paths) {
      const view = await s.openRendered(p)
      const root: HTMLElement = view.root
      const seen = new Set<string>()
      // Scroll to the end, so every item mounts and hydrates once; stop after 10 frames at the bottom without growth.
      for (let still = 0; still < 10; ) {
        await view.settled()
        for (const el of root.querySelectorAll<HTMLElement>('.md-item')) {
          if (seen.has(el.dataset.key!)) continue
          seen.add(el.dataset.key!)
          // Nothing that loads, navigates or submits reaches the DOM; the only frames are Mermaid's sandbox="" ones.
          const bad = el.querySelectorAll('img, a[target], form, button, base, meta, area, object, embed, link, iframe:not([sandbox=""])')
          for (const b of bad) tally.bad.push(`${p}: ${b.outerHTML.slice(0, 80)}`)
          tally.items++
          if (el.dataset.unmapped) tally.unmapped++
          tally.frames += el.querySelectorAll('iframe').length
          for (const m of el.querySelectorAll('pre.tp-mermaid .problem')) tally.problems.push(m.getAttribute('title')!.split('\n')[0])
          tally.math += el.querySelectorAll('.tp-math, .tp-math-display').length
          tally.images += el.querySelectorAll('.tp-img').length
          tally.links += el.querySelectorAll('a').length
        }
        const height = root.scrollHeight
        root.scrollTop += root.clientHeight
        await frame()
        still = root.scrollTop + root.clientHeight >= root.scrollHeight - 1 && root.scrollHeight === height ? still + 1 : 0
      }
      tally.files++
      await s.core.call('close', { doc: view.opened.doc })
    }
    await new Promise((ok) => setTimeout(ok, 2_000)) // let frames load and anything late fire
    return tally
  }, files)
  const report = await run.finish()
  console.log(JSON.stringify({ ...seen, report: { ...report, files: report.files.length } }, null, 2))
  expect(seen.bad).toEqual([])
  expect(report.violations).toEqual([])
})

test('a link click never navigates the app or opens a window, whatever the link and the click', async () => {
  const { links } = extras()
  const run = await launchRecorded('md-links', {}, [links])
  const { win, app } = run
  await win.waitForFunction(() => (window as any).__spike.openRendered)
  await win.evaluate((p) => (window as any).__spike.openRendered(p), links)
  const url = win.url()
  const anchors = win.locator('.md-scroller a')
  // C4's link contract: http(s), mailto and non-network relative targets keep href; any other target moves to
  // data-href behind href="#"; javascript:, vbscript: and data: are dropped. Every link keeps an href, so each focuses.
  expect(await anchors.evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('data-href')]))).toEqual([
    ['http', 'http://example.invalid/h', null],
    ['https', 'https://example.invalid/s', null],
    ['mail', 'mailto:a@example.invalid', null],
    ['relative', 'other.md', null],
    ['dot', './sub/x.md', null],
    ['rooted', '/root.md', null],
    ['fragment', '#fragment', null],
    ['Wiki Page', 'Wiki Page', null],
    ['https://example.invalid/auto', 'https://example.invalid/auto', null],
    ['raw', 'https://example.invalid/raw', null],
    ['network', '#', '//example.invalid/net'],
    ['unc', '#', '\\\\host\\share\\x.md'],
    ['file', '#', 'file:///C:/Windows/win.ini'],
    ['smb', '#', 'smb://example.invalid/x'],
    ['js', '#', null],
    ['blank', '#', 'about:blank']
  ])
  const targets = await anchors.evaluateAll((as) => as.map((a) => a.getAttribute('data-href') ?? a.getAttribute('href')))
  const want: (string | null)[] = []
  for (let i = 0; i < targets.length; i++) {
    const a = anchors.nth(i)
    for (const modifiers of [[], ['Control'], ['Shift']] as ('Control' | 'Shift')[][]) {
      await a.click({ modifiers })
      want.push(targets[i])
    }
    await a.click({ button: 'middle' })
    want.push(targets[i])
    await a.focus()
    await win.keyboard.press('Enter')
    want.push(targets[i])
  }
  await win.waitForTimeout(1_000)
  expect(win.url()).toBe(url)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(await win.evaluate(() => (window as any).__spike.rendered.clicked)).toEqual(want)
  const report = await run.finish()
  console.log(JSON.stringify({ anchors: targets.length, clicks: want.length, denied: report.denied, violations: report.violations }))
  expect(report.denied).toEqual([]) // main's will-navigate and window-open handlers never even see a request
  expect(report.violations).toEqual([])
})

test('every detector fails the gate when its effect happens in the Rendered setting (falsification)', async () => {
  const { all, links } = extras()
  // links.md is deliberately not in `opened`: reading it is the file recorder's effect.
  const run = await launchRecorded('md-falsify', {}, [all])
  const { win, app } = run
  await win.waitForFunction(() => (window as any).__spike.openRendered)
  const armed = await app.evaluate(({ shell }) => ({
    lookup: (process.getBuiltinModule('node:dns').lookup as unknown as { tripwire?: boolean }).tripwire,
    openExternal: (shell.openExternal as unknown as { tripwire?: boolean }).tripwire
  }))
  expect(armed).toEqual({ lookup: true, openExternal: true }) // before any deliberate effect
  await win.evaluate(async (p) => (await (window as any).__spike.openRendered(p)).settled(), all)
  // Files: a document outside `opened`, through the core host's Markdown path.
  await win.evaluate((p) => (window as any).__spike.openRendered(p), links)
  // Requests, guard log: an http image in a test-only page without the app's CSP or sanitizer.
  // Requests, NetLog: the same from a page in a partition without the guard (loopback port 9: nothing leaves).
  await app.evaluate(async ({ BrowserWindow }) => {
    for (const [partition, img] of [[undefined, 'falsify-md.png'], ['falsify-md', 'netlog-md.png']]) {
      const w = new BrowserWindow({ show: false, webPreferences: { partition } })
      await w.loadURL(`data:text/html,<img src="http://127.0.0.1:9/${img}">`)
      await new Promise((ok) => setTimeout(ok, 500))
      w.destroy()
    }
  })
  // Node tripwire: a DNS lookup in main (it throws instead of resolving).
  await app.evaluate(() => {
    try {
      process.getBuiltinModule('node:dns').lookup('example.invalid', () => {})
    } catch {}
  })
  // Process diff: a second utility process.
  await app.evaluate(({ app: a, utilityProcess }) => {
    const { join } = process.getBuiltinModule('node:path')
    const chunks = join(a.getAppPath(), 'out', 'main', 'chunks')
    const entry = process.getBuiltinModule('node:fs').readdirSync(chunks).find((f: string) => f.startsWith('core-host'))
    const child = utilityProcess.fork(join(chunks, entry), [], { serviceName: 'falsify-md' })
    return new Promise((ok) => child.once('spawn', ok))
  })
  const report = await run.finish()
  console.log(JSON.stringify({ ...report, files: report.files.length }, null, 2))
  expect(report.violations.some((v) => v.startsWith('file: ') && v.endsWith('md-links.md'))).toBe(true)
  expect(report.requests.some((u) => u.includes('falsify-md.png'))).toBe(true)
  expect(report.netlog.some((v) => v.includes('127.0.0.1:9/netlog-md.png'))).toBe(true)
  expect(report.tripwire.some((t) => t.includes('lookup example.invalid'))).toBe(true)
  expect(report.newProcesses.some((p) => p.includes('falsify-md'))).toBe(true)
})
```
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e md-effects`
Expected: `3 passed`. The zero-effects test prints:
```text
{
  "files": 500,
  "items": 686,
  "unmapped": 91,
  "frames": 40,
  "math": 14,
  "images": 143,
  "links": 311,
  "problems": [
    "The source image cannot be decoded.",
    "Parse error on line 3:",
    "Parse error on line 3:",
    "Cannot read properties of null (reading 'appendChild')",
    "Cannot read properties of null (reading 'getBBox')"
  ],
  "bad": [],
  "report": {
    "netlogVerdict": "PASS: no Chromium network-stack activity (Node sockets in main/core host are not covered)",
    "netlog": [],
    "requests": [],
    "dataUrls": 57,
    "tripwire": [],
    "denied": [],
    "files": 616,
    "newProcesses": [
      "GPU:GPU",
      "Tab"
    ],
    "violations": []
  }
}
```
`"frames": 40` and `"problems"` are C5a's hostile Mermaid corpus as it renders inside Markdown: 45 sources, 40 sandboxed frames, and the 5 problem markers C5a4 pins (its sixth, `over maxEdges`, is only in its own test). `"math": 14` is 15 hostile TeX sources less the 50,000-deep braces, a 100 KB paragraph that renders as Raw pieces. `"unmapped": 91` are raw-HTML blocks and restructured raw HTML (Task C4b). `"newProcesses"` may show only `["Tab"]` when the GPU process was already up.
The link test prints `{"anchors":16,"clicks":80,"denied":[],"violations":[]}`.
The falsification test prints a report with 11 violations: the 7 NetLog lines C5a5 lists (`request http://127.0.0.1:9/netlog-md.png`, resolver and UDP events), `request: http://127.0.0.1:9/falsify-md.png`, `tripwire: browser net lookup example.invalid`, `file: …\spikes\.fixtures\md-links.md` and `process: Utility:falsify-md`.

- [ ] **Step 5: Falsify the link intercept**

In `rendered.ts`, delete the line `      e.preventDefault() // every click: plain, modified, middle, or Enter on a focused link`.
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e md-effects -g "link click"`
Expected: `1 failed`, `TimeoutError: locator.click: Timeout 30000ms exceeded.` with the call log ending `- waiting for scheduled navigations to finish` on the first link (`http://example.invalid/h`): the click started a navigation. `spikes/.fixtures/effects/md-links/effects.jsonl` holds `{"proc":"browser","kind":"navigate","detail":"http://example.invalid/h"}` — main denied it, which the restored test treats as a failure on its own.
Restore it (in `spikes/app`: `git checkout -- src/renderer/src/rendered.ts`), rebuild, rerun: `1 passed`.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core/src/md_gates.rs spikes/app/e2e/md-effects.e2e.ts
git commit -m "spike(c): no sanitizer output navigates; link clicks intercepted; zero effects for hostile Markdown in Rendered"
```

---

## Task C5b4: Measurements in the app — oversized blocks, hostile inputs, cancel

**Files:**
- Create: `spikes/app/perf/spike-c.e2e.ts`
- Create: `spikes/results/spike-c-<hostname>.json` (from the run)

**Interfaces:**
- **Consumes:** `launch`, `FIX` (C5a2); `openRendered` and `.md-item[data-key]` (Task C5b2); the core host's `index` and `cancel` (Task C5b1); plan A's `window.__spike.open(path, 'raw')`, `perf.marks` and `percentile`.
- **Produces:** `spikes/results/spike-c-<hostname>.json` with `oversized:md-fence-5mb` (`firstScreenMs {n, p50, p95, max}`, `samples`, `dom {items, mounted, maxText, last}`), `hostile:<file>` (`firstScreenMs`, `fullScanMs`, `cancelMs`, `cancelled`, `finishedBeforeCancel`, `runningAtFirstScreen`, `errors`, `runs`) and, with `CONTROL=1`, `control:<file>` (`firstScreenMs` and `fullScanMs` with no format index beside Raw, `samples`, `scans`). Knobs: `RUNS` (default 20), `CONTROL`.

**Design notes:**
- **Measured like plan A's first screen:** one fresh launch per sample (private profile, zoom 1), the shell visible and settled for 500 ms, then open; the sample is `firstScreen − openStart` in the renderer.
- **Oversized** (spec §13.1, §14 D17): C4e's fixture (a 5 MiB `rust` fence of a 43-byte line, then `The paragraph after the fence.`), opened in Rendered anchored at block 1 — the paragraph — so the gate is about the fence not delaying what follows it. Then a second launch opens at block 0 and scrolls two viewports at a time to the end, so every item mounts once, and records the longest item text in the DOM.
- **Hostile inputs:** C4's 100 MiB of `[` and of `>` and its 1M footnotes, C2's 100 MiB JSON `[`, C3's 200 MB unterminated CSV quote, and C2's 84 MB cancel array (its fixture is named `88m`), because 100 MiB of `[` stops at the JSON depth cap within milliseconds and so never runs long enough to cancel. Per sample: start the format's index as a core-host job, open the file in plan A's Raw, wait for Raw's first screen, then cancel and wait for the job's last event (progress events are skipped), then for Raw's full line scan. `runningAtFirstScreen` says the index was still running when Raw painted; `cancelMs` is the core host's own measure.
- **Raw's first-screen mark is plan A's Z37 mark:** the first page painted, the rows available up to a viewport. On a one-line file that is line 0's first 64 KiB piece, painted while plan A's line index is still scanning the line; on a file of short lines it is still a full viewport. The control (`CONTROL=1`) runs Raw with no format index beside it.
- **Raw's full line scan is its own metric** (Zack's ruling Z37): `fullScanMs` runs from open to plan A's `indexDone` mark (the whole file scanned), recorded beside the first screen in every sample, with the format index and in the control. Z37 makes Raw's first screen the first bounded piece visible and usable while the scan continues (50 ms PC target); plan A is amended for it, and the numbers below are on that mark.

- [ ] **Step 1: Write the runner and do a quick run**

`spikes/app/perf/spike-c.e2e.ts`:
<!-- op: create spikes/app/perf/spike-c.e2e.ts -->
```ts
// Spike C gates measured in the app (spec §13.1): oversized blocks in Rendered, and hostile inputs whose format index
// runs in the core host while Raw paints its first screen, then cancels. RUNS samples each (default 20), one fresh
// launch per sample, measured like plan A's first screen: open → the first-screen mark. Raw's full line scan
// (open → plan A's indexDone mark) is recorded beside it as its own metric.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { FIX, launch } from '../e2e/launch'
import { percentile } from '../src/renderer/src/perf'

const OUT = resolve(__dirname, `../../results/spike-c-${hostname()}.json`)
const RUNS = Number(process.env.RUNS ?? 20)

const save = (key: string, value: unknown): void => {
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
  writeFileSync(OUT, JSON.stringify({ ...all, [key]: value }, null, 2))
}
const stats = (xs: number[]) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: Math.max(...xs) })
const fixture = (name: string, write: (path: string) => void): string => {
  const path = join(FIX, name)
  if (!existsSync(path)) write(path)
  return path
}

/** A fresh app with its shell up and settled, as plan A's first-screen runner opens files. */
async function settled(name: string): Promise<{ win: Page; close: () => Promise<void> }> {
  const { app, win } = await launch(name)
  await win.waitForFunction(() => (window as any).__spike.openRendered && document.visibilityState === 'visible')
  await win.waitForTimeout(500)
  return { win, close: () => app.close() }
}

test('oversized: a 5 MB fence then a one-line paragraph; the paragraph within the first-screen gate, no item over 64 KiB', async () => {
  const unit = 'let value = compute(42); // a line of code\n'
  const path = fixture('md-fence-5mb.md', (p) =>
    writeFileSync(p, '```rust\n' + unit.repeat(Math.ceil((5 << 20) / unit.length)) + '```\n\nThe paragraph after the fence.\n')
  )
  const samples: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const { win, close } = await settled('perf-oversized')
    await win.evaluate((p) => (window as any).__spike.openRendered(p, 1), path) // anchored at block 1, the paragraph
    await win.waitForFunction(() => (window as any).__spike.perf.marks.firstScreen)
    const s = await win.evaluate(() => {
      const { marks } = (window as any).__spike.perf
      return { ms: marks.firstScreen - marks.openStart, first: document.querySelector('.md-item')!.innerHTML }
    })
    expect(s.first).toBe('<p>The paragraph after the fence.</p>')
    samples.push(s.ms)
    await close()
  }
  // Every item of the document mounts once on the way down; none may hold more than 64 KiB of text (spec §3.4).
  const { win, close } = await settled('perf-oversized-dom')
  const dom = await win.evaluate(async (p) => {
    const view = await (window as any).__spike.openRendered(p)
    const root: HTMLElement = view.root
    const seen = new Set<string>()
    let maxText = 0
    // Two viewports a step: the list mounts one viewport above and below the visible one, so every item mounts.
    for (let still = 0; still < 20; ) { // 20 frames without moving or growing: the end
      for (const el of root.querySelectorAll<HTMLElement>('.md-item')) {
        seen.add(el.dataset.key!)
        maxText = Math.max(maxText, el.textContent!.length)
      }
      const [top, height] = [root.scrollTop, root.scrollHeight]
      root.scrollTop += 2 * root.clientHeight
      await new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 5)))
      still = root.scrollTop === top && root.scrollHeight === height ? still + 1 : 0
    }
    // Every item: the fence's pieces and the paragraph.
    return { items: view.opened.items[0].pieces + 1, mounted: seen.size, maxText, last: [...root.querySelectorAll('.md-item')].at(-1)!.innerHTML }
  }, path)
  await close()
  const result = { firstScreenMs: stats(samples), samples, dom }
  console.log(JSON.stringify(result))
  save('oversized:md-fence-5mb', result)
  expect(dom.mounted).toBe(dom.items)
  expect(dom.last).toBe('<p>The paragraph after the fence.</p>')
  expect(dom.maxText).toBeLessThanOrEqual(65_536)
})

// Spec §13.1's hostile inputs (C2, C3, C4), each opened in Raw while its format's index runs in the core host.
const HOSTILE: [string, 'md' | 'json' | 'csv', (path: string) => void][] = [
  ['hostile-brackets-100m.md', 'md', (p) => writeFileSync(p, Buffer.alloc(100 << 20, '['))],
  ['hostile-gt-100m.md', 'md', (p) => writeFileSync(p, Buffer.alloc(100 << 20, '>'))],
  [
    'hostile-footnotes-1m.md',
    'md',
    (p) => writeFileSync(p, Array.from({ length: 1_000_000 }, (_, i) => `[^f${i}]: footnote ${i}\n`).join('') + '\nsee[^f0] and[^f999999]\n')
  ],
  ['hostile-brackets-100m.json', 'json', (p) => writeFileSync(p, Buffer.alloc(100 << 20, '['))],
  // C2's cancel input: 100 MB of '[' stops at the depth cap within milliseconds, so it never runs long enough to cancel.
  ['hostile-array-88m.json', 'json', (p) => writeFileSync(p, '[' + '[1,"abc",{"k":null}],'.repeat(4_000_000) + '0]')],
  ['hostile-unterminated-200m.csv', 'csv', (p) => writeFileSync(p, Buffer.concat([Buffer.from('h1,h2\n"open'), Buffer.alloc(9 * 22_222_222, 'xxxxxxx,\n')]))]
]

for (const [name, format, write] of HOSTILE) {
  test(`hostile ${name}: Raw's first screen while the ${format} index runs, then the index cancels`, async () => {
    const path = fixture(name, write)
    const runs = []
    for (let i = 0; i < RUNS; i++) {
      const { win, close } = await settled(`perf-hostile-${format}`)
      runs.push(
        await win.evaluate(
          async ({ path, format }) => {
            const s = (window as any).__spike
            const ended = new Map<number, { at: number; e: any }>()
            s.core.onEvent((e: any) => e.event === 'job' && !e.running && ended.set(e.job, { at: performance.now(), e }))
            const { job } = await s.core.call('index', { path, format })
            void s.open(path, 'raw')
            while (!s.perf.marks.firstScreen) await new Promise((ok) => setTimeout(ok, 1))
            const { openStart, firstScreen } = s.perf.marks
            // Cancel as closing the document would: the core host times the stop (Job.cancel → the worker returns).
            const live = await s.core.call('cancel', { job })
            while (!ended.has(job)) await new Promise((ok) => setTimeout(ok, 1))
            const { at, e } = ended.get(job)!
            // Raw's full line scan, a separate metric from its first screen: plan A marks indexDone when it ends.
            while (!s.perf.marks.indexDone) await new Promise((ok) => setTimeout(ok, 1))
            const fullScanMs = s.perf.marks.indexDone - openStart
            return { firstScreenMs: firstScreen - openStart, fullScanMs, runningAtFirstScreen: at > firstScreen, live, ...e }
          },
          { path, format }
        )
      )
      await close()
    }
    const cancelled = runs.filter((r) => r.cancelled)
    const result = {
      firstScreenMs: stats(runs.map((r) => r.firstScreenMs)),
      fullScanMs: stats(runs.map((r) => r.fullScanMs)),
      cancelMs: cancelled.length ? stats(cancelled.map((r) => r.cancelMs)) : null,
      cancelled: cancelled.length,
      finishedBeforeCancel: runs.filter((r) => r.done).length,
      runningAtFirstScreen: runs.filter((r) => r.runningAtFirstScreen).length,
      errors: runs.filter((r) => r.error).map((r) => r.error),
      runs
    }
    console.log(`${name}: ${JSON.stringify({ ...result, runs: undefined })}`)
    save(`hostile:${name}`, result)
    expect(result.errors).toEqual([])
  })
}

// The control (CONTROL=1): Raw's first screen and full line scan on the same files with no format index beside it.
if (process.env.CONTROL === '1')
  for (const [name, , write] of HOSTILE) {
    test(`control ${name}: Raw's first screen alone`, async () => {
      const path = fixture(name, write)
      const samples: number[] = []
      const scans: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const { win, close } = await settled('perf-control')
        const ms = await win.evaluate(async (p) => {
          const s = (window as any).__spike
          void s.open(p, 'raw')
          while (!s.perf.marks.firstScreen || !s.perf.marks.indexDone) await new Promise((ok) => setTimeout(ok, 1))
          const { openStart, firstScreen, indexDone } = s.perf.marks
          return { firstScreen: firstScreen - openStart, fullScan: indexDone - openStart }
        }, path)
        samples.push(ms.firstScreen)
        scans.push(ms.fullScan)
        await close()
      }
      console.log(`control ${name}: ${JSON.stringify({ firstScreenMs: stats(samples), fullScanMs: stats(scans) })}`)
      save(`control:${name}`, { firstScreenMs: stats(samples), fullScanMs: stats(scans), samples, scans })
    })
  }
```
Run (`spikes/app`): `npm run build`, then
- PowerShell: `$env:RUNS=2; npx playwright test --project=perf spike-c; Remove-Item Env:RUNS`
- Git Bash: `RUNS=2 npx playwright test --project=perf spike-c`

Expected: `7 passed`, one JSON line per test. The first run writes about 630 MB of fixtures into `spikes/.fixtures/`. Delete `spikes/results/spike-c-<hostname>.json` afterwards.

- [ ] **Step 2: The measured run and the control**

Run (`spikes/app`): `npx playwright test --project=perf spike-c` (about 3 minutes), then the control: PowerShell `$env:CONTROL=1; npx playwright test --project=perf spike-c -g control; Remove-Item Env:CONTROL`, Git Bash `CONTROL=1 npx playwright test --project=perf spike-c -g control` (about 3 minutes).
Expected: `7 passed`, then `6 passed`. If a row fails after `0ms` because its Playwright worker died as it launched Electron (Global Constraints: a rare e2e flake), stop the Electron it was launching and rerun that row alone with `-g '<its title>'` (for a control row, with `CONTROL=1` set). Each row's results are saved under its own key, so the rerun completes the file. This plan's replay measured, on Zack's PC with other lanes' builds and tests running (ms; n = 20 per row; gate < 50 ms at p95):

Oversized (Rendered, anchored at the paragraph after the 5 MiB fence): first screen p50 / p95 / max **15.7 / 20.0 / 20.2**; DOM walk: 162 of 162 items mounted, longest item text 32766 UTF-16 units, last item `<p>The paragraph after the fence.</p>`.

| Input (format index beside Raw) | Raw first screen with the index, p50 / p95 / max | Raw first screen alone (control) | Raw full line scan with the index (Z37) | Raw full line scan alone | Index still running at Raw's first screen | Cancel → stopped (core host), p50 / p95 / max | Live cancels |
|---|---|---|---|---|---|---|---|
| Markdown, 100 MiB of `[` (one line) | 18.4 / 26.4 / 36.0 | 19.5 / 24.8 / 25.0 | 36.1 / 41.3 / 47.1 | 30.8 / 56.4 / 57.4 | 20 of 20 | 0.1 / 0.6 / 1.0 | 20 of 20 |
| Markdown, 100 MiB of `>` (one line) | 18.2 / 23.3 / 24.5 | 18.2 / 23.1 / 28.6 | 38.4 / 56.1 / 81.9 | 29.0 / 51.3 / 62.1 | 20 of 20 | 0.4 / 0.9 / 1.2 | 20 of 20 |
| Markdown, 1M footnotes (27.8 MB) | 16.7 / 20.5 / 21.5 | 13.2 / 16.9 / 18.1 | 17.3 / 24.7 / 25.1 | 14.7 / 17.1 / 18.1 | 20 of 20 | 0.4 / 2.6 / 3.3 | 20 of 20 |
| JSON, 100 MiB of `[` (one line) | 18.0 / 22.4 / 182.8 | 16.7 / 74.3 / 163.5 | 32.1 / 42.4 / 48.0 | 30.2 / 44.8 / 45.8 | 0 of 20 | — | 0 of 20 |
| JSON, 84 MB flat array (one line) | 18.7 / 27.4 / 124.8 | 17.5 / 23.0 / 24.5 | 29.6 / 38.0 / 43.9 | 23.8 / 32.7 / 43.5 | 20 of 20 | 1.4 / 2.7 / 3.6 | 20 of 20 |
| CSV, 200 MB unterminated quote | 17.4 / 22.9 / 171.3 | 16.5 / 26.4 / 28.3 | 155.0 / 166.4 / 195.9 | 146.7 / 164.6 / 183.2 | 20 of 20 | 0.4 / 1.5 / 1.9 | 20 of 20 |

- **Oversized gate: passes.** The paragraph after the 5 MiB fence paints in p95 20.0 ms, and no mounted item holds more than 32,766 UTF-16 units (all 162 items mounted once).
- **Cancel gate: passes,** max 3.6 ms over all 100 live cancels, timed in the core host. The 100 MiB JSON `[` finishes before any cancel (20 of 20: the scan stops at the depth cap), so its row is vacuous and the 84 MB array carries the JSON cancel.
- **Raw's first-screen gate beside a running index: passes at p95 for all six inputs** (plan A's Z37 mark). With the format index running, p95 is 20.5–27.4 ms. Three of 120 samples went over 50 ms (182.8 ms on the JSON `[`, 171.3 ms on the CSV, 124.8 ms on the JSON array), and Raw alone did the same (163.5 and 74.3 ms on the JSON `[`, which puts that row's control p95 at 74.3 ms): this run took 5.8 minutes with other lanes loading the PC, against 2.8 minutes for an earlier run of this replay that had no sample over 50 ms with the index (p95 17.6–20.4 ms, max 29.0 ms). The format index beside Raw moves p50 by −1.1, 0.0, +1.3 and +1.2 ms on the four one-line files, in the table's order, and by +3.5 and +0.9 ms on the footnotes and the CSV. On the one-line files the mark lands on line 0's first piece before the full scan ends in 154 of 160 samples (the rest are those slow samples and two near-ties); the full scan takes p50 29.6–38.4 ms there, 17.3 ms on the footnotes and 155.0 ms on the 200 MB CSV.

- [ ] **Step 3: Read your own work (rule 8), then commit**

```bash
git add spikes/app/perf/spike-c.e2e.ts spikes/results/spike-c-*.json
git commit -m "spike(c): oversized, hostile-input and cancel measurements in the app"
```

---

## Task C5b5: Whole-suite check, clean-up, and spec coverage

- [ ] **Step 1: Run everything**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `test result: ok. 122 passed; 0 failed; 7 ignored; 0 measured; 0 filtered out` (C0–C4's 120 with 6 ignored, plus `a_shared_store_verifies_against_the_first_stores_hashes`, `no_output_can_navigate` and the ignored `write_hostile_corpus`), then `json_spans`: `1 passed`.
Run (`spikes/core`): `cargo test -p fixtures-gen` → `5 passed`.
Run (`spikes/core/spike-node`): `node --test` → `ℹ pass 7`, `ℹ fail 0`.
Run (`spikes/app`): `npx vitest run` → `Test Files  5 passed (5)`, `Tests  24 passed (24)` (plan A's 11, C1a's 3, C5a's 10; Tasks C5b1–C5b5 add no unit test).
Run (`spikes/app`): `npm run build`, then `npm run e2e` → `21 passed` (plan A's 3, C5a's 8, `rendered` 7, `md-effects` 3). The `md-effects` tests need Task C5b3's corpus: if `spikes/.fixtures/md-hostile/` is gone, rerun Step 3 of Task C5b3 first.

- [ ] **Step 2: Clean up**

Delete `spikes/.fixtures/` (profiles, effects logs and NetLogs, the corpus, the Rendered, oversized and hostile fixtures: about 750 MB; gitignored).

- [ ] **Step 3: Spec §13.1 Spike C coverage**

| Gate (spec §13.1) | Evidenced by | Measured |
|---|---|---|
| Zero span mismatches across ≥ 10,000 generated cases | C2b (JSON), C3b (CSV), C4d (Markdown), C5a1 (YAML) | 0 mismatches each: 10,000 documents / tables / cases; YAML 220,797 oracle nodes |
| Byte maps: zero selection-endpoint mismatches across UTF-8, malformed UTF-8, Windows-1252, UTF-16LE/BE, Markdown entities and escapes | C1c (core, 10,000 cases per encoding), C4d (core), **C5b2 (app)** | 0; 0; in the app 0 of 480 endpoints (240 random selections, UTF-8 and UTF-16LE) plus 26 hand-picked copies and 2 inside math. The app-level run covers UTF-8 and UTF-16LE only: malformed UTF-8, 1252 and UTF-16BE are evidenced in the core (C1c, C4d) |
| Correct offsets beyond 4 GiB | C1d (core and napi `beyond-4gib.test.js`), C5b1 (ceiling) | exact at 2^32 ± and 5 GiB; JS numbers exact below 2^53, `Source.open` refuses larger files |
| 1,000 append/truncate/rename/delete cycles on Windows: zero blocked operations, crashes, stale-span copies accepted | C0 (with round 1's rename-away cycle); C5b2 (app: a copy refused after a change, and for generation 1 after reload) | 0 / 0 / 0 (C0); refused, refused (C5b2) |
| Mutation race: an in-place same-size write between the check and the read caught in 1,000 of 1,000 runs | C0; C5b1 (`open_shared`: display and copy verify against one hash table) | 1,000 of 1,000 |
| Oversized blocks: a 5 MB fence then a one-line paragraph renders the paragraph within the first-screen gate; no mounted item over 64 KiB | C4e (core), **C5b4 (app)** | app p95 20.0 ms (n = 20), 162 of 162 items mounted, longest 32766 units |
| Hostile inputs cancel within 50 ms while Raw keeps its first-screen gate | C2a, C3a, C4e (core cancel), C5a2 (YAML worker), **C5b4 (app)** | app cancel max 3.6 ms over 100 live cancels (100 MiB JSON `[` vacuous: done in ms); Raw p95 20.5–27.4 ms for all 6 inputs on plan A's Z37 first-screen mark (3 of 120 samples over 50 ms under load, as Raw alone), full line scan recorded separately (Z37), **see Task C5b4** |
| (ruling Z30) Giant Markdown: Raw opens while Rendered indexes, with progress and cancel | **C5b1** (napi: ≥ 2 progress events, bytes rising, at most 10 Hz, Markdown and CSV; cancel), **C5b2** (the lens's `role="status"` line), C5b4 (Raw beside a running index) | md 59 MB and CSV 120 MB both report progress; the 59 MB file indexes in 0.4–0.7 s (release addon; 0.42 s in this plan's replay), about 7–13 s per GiB, not measured on a 1 GiB file; cancel ≤ 50 ms (C5b1, C5b4); JSON has no progress (C2a's scanner publishes nothing until it returns) |
| (ruling Z34) Over the memory budget, Rendered stops, says why, and Raw stays | **C5b2** (e2e: `maxBlocks` 2) | the reason plus "Raw stays available." in a `role="status"` line, no item left on screen, Raw pages to line 9,999 of the same file |
| Hostile Markdown, Mermaid and KaTeX fixtures produce zero network requests, process launches or file accesses | C5a5 (Mermaid, KaTeX, YAML), **C5b3 (Markdown in Rendered: 500 files, 80 link clicks)** | 0 violations; each of the 5 detectors falsified in both settings |
| (spec §7.1) The hostile-fixture gate confirms the frame can't make requests or navigate the app | Mermaid frames: C5a4, C5a5 (`sandbox=""`); Rendered links: C5b2 (click intercept), C5b3 (test) | diagram links dead; 0 of 80 link clicks reach `will-navigate` |
| Outputs: the YAML worker's throughput (`yaml.treeMaxBytes`) and the scanner decision | C5a6, C2c | 8 MiB; keep the hand-written scanner |
| **Not covered** | — | No Spike C gate is Mac-marked, and nothing here ran on the Mac. The app-level byte-map run doesn't include malformed UTF-8, Windows-1252 or UTF-16BE files (core only). Raw's first-screen gate beside an index is measured on 100–200 MB files, not multi-GB ones, and on plan A's Z37 first-screen mark. The aggregate memory budget (25% of RAM across open documents) isn't computed: `maxBlocks` is passed explicitly, and no budget stop of its own is surfaced. JSON index jobs report no progress. |
