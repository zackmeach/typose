# Typose — Technical Design (stack, architecture, delivery)

- **Date:** 2026-10-20 · **Status:** Draft 4 (2026-10-22).
  - Draft 2 folded in the external review of Draft 1 (Astra, 2026-10-20); each finding and its resolution is in §16.
  - Draft 3 records Zack's Phase 0 decisions Z30–Z38 (§0.3) and updates the affected sections.
  - Draft 4 records Zack's decisions Z39–Z50 (§0.4), from the Phase 0 decision packet (`docs/superpowers/plans/2026-10-22-phase0-decision-packet.md`), and updates the affected sections. Z39 parks screen-reader validation until after launch and supersedes Z35. Z51 and Z52 came later the same day, from Spike B's round-3 review. Z53–Z56 record the Phase 0 checkpoint: a conditional go to M1, with Phase 0 not qualified. Z57–Z59 settle M1's merge authority and closure rules, Z60 the CI matrix, and Z61 no spending until after launch.
- **Implements:** the design brief `docs/superpowers/specs/2026-10-20-typose-design-brief.md` (revision 6). §14 lists the changes this spec asked of the brief; revision 4 applied them. Revision 5 records Z30–Z37. Revision 6 records the product-facing parts of Z39–Z50. Nothing in the brief is overridden silently.
- **Inputs:**
  - Two independent research reports, `astra-research.md` and `fable-research.md` (repo root, local only, not committed).
  - Fable's evidence notes in `docs/research/research_notes/` (also local only).
  - The Claude Design canvas (https://claude.ai/artifact/PzKuQySzwKRRUNwd2VKYV8, v25).
- **Who decided what:** **[Z#]** marks Zack's decisions (log in §0). Untagged items are proposals, open to veto. 🔒 marks a safety or correctness requirement that can be reworded but not dropped.
- **Team:** one developer (Zack). Test hardware is one Windows 11 PC plus occasional access to a friend's Apple-silicon Mac mini and MacBook. There is no Linux machine.

---

## 0. Decisions

### 0.1 Carried from the brief
Z1–Z23 stand as written in the brief's §0.

### 0.2 Stack decisions (Zack, 2026-10-20)
| # | Decision |
|---|---|
| Z24 | **No in-app updater in v1.** Signed releases go to GitHub Releases, winget, Homebrew and Flathub; the package managers handle updates. |
| Z25 | **Shell: Electron + a Rust core.** The core is a napi-rs addon hosted in an Electron `utilityProcess`. Both research reports reached this independently. Tauri was rejected on three counts: print (WKWebView `window.print()` is a no-op in wry; there is no WebKitGTK PDF path), Linux scrolling and accessibility (WebKitGTK 2.52 is what Ubuntu and Debian ship), and Snap Layouts (tauri#4531). |
| Z26 | **App chrome: React 19 + React Aria.** **Lenses are framework-free DOM controllers** built on a hand-rolled virtualizer that owns scroll mapping (§5.3). |
| Z27 | **License: `MIT OR Apache-2.0`.** Contributions are inbound = outbound with a DCO sign-off, and a one-page `TRADEMARK.md` protects the Typose name. |
| Z28 | **Linux ships in v1 as best effort.** It is built and smoke-tested in CI, but the screen-reader and 60fps gates (§6.3, §10.2) apply to Windows and macOS only. Linux gating comes after v1. This narrows Z7 (§14, D12). |
| Z29 | **Performance reference rigs.** Zack's PC (i7-12700K, 32GB, RTX 3070 Ti, NVMe, Windows 11 26200) gates at **half** of each budget, as a proxy for a mid-range laptop. The friend's **Apple-silicon Mac** gates at the **full** budgets. |

### 0.3 Phase 0 decisions (Zack, 2026-10-21)
| # | Decision |
|---|---|
| Z30 | **Giant Markdown files** open immediately in Raw while Rendered indexes in the background. Roughly **20 seconds for a 1GiB file is acceptable**, but it isn't a guaranteed deadline. Progress and cancellation remain required (§4.6). |
| Z31 | **Grid row numbers are source record numbers.** They start at **1 for the first data record** and are preserved when the grid is sorted. Physical source lines remain available through Raw (§6.1). |
| Z32 | **Screen-reader column numbering:** the row-number column counts as column 1, so the first CSV data column is announced as "column 2" together with its name (§6.1). |
| Z33 | **Screen-reader navigation:** wide reading windows apply to **Rendered and Transcript**. Grid and Rows use keyboard navigation that loads its target before moving focus. Every data cell must be reachable, but continuous "read all" across Grid and Rows isn't a v1 requirement (§5.3, §6.2). |
| Z34 | **Memory budget 🔒:** document data across all open files stays within **25% of physical RAM**. That includes indexes, caches and temporary parsing allocations. When the limit is reached, Typose stops building Rendered, explains why it's unavailable, and keeps Raw. 32 bytes per Markdown block is an optimization target, not the safety limit (§3.5, §3.6). |
| Z35 | **Screen-reader testing:**<br>• Phase 0 runs the full 2,000-block forward and backward test on NVDA, Narrator and VoiceOver.<br>• Routine milestones run a shorter test: at least four window recenters each way, plus heading jumps and focus restoration.<br>• The full test runs again whenever virtualization or screen-reader behavior changes (§6.3).<br>**Superseded by Z39** (2026-10-22): parked until after launch. |
| Z36 | **YAML Tree ceiling: 8MiB in v1**, with Raw above it. Smaller files must still respect memory and structural limits (§4.5). |
| Z37 | **Raw first screen** means the first bounded piece is visible and usable, with continuation available while scanning proceeds. The 50ms PC target applies to that view. Full-line scan completion is measured separately (§10.2, §13.1). |
| Z38 | **Phase 0 sequence:**<br>1. Record these decisions in the specs.<br>2. Finish folding and reviewing the Spike B and C plans against them.<br>3. Preserve the validated spike code, and run the missing real screen-reader and full-size performance gates.<br>4. Hold the Phase 0 checkpoint before M1 (§13.1).<br>**Step 3 amended by Z39** (2026-10-22): no real screen-reader gates before launch. The full-size performance gates remain.<br>**Steps 3–4 amended by Z53** (2026-10-22): the checkpoint was held on existing evidence as a conditional go to M1. Qualification moves to the product milestones. |

### 0.4 Decisions from the Phase 0 decision packet (Zack, 2026-10-22)
The packet (`docs/superpowers/plans/2026-10-22-phase0-decision-packet.md`) holds each question's context and the full notes. These rows are the binding summary.

| # | Decision |
|---|---|
| Z39 | **Screen-reader validation is parked until after launch, as an expansion opportunity.** It supersedes Z35 and the packet's Q1 answer.<br>• Before launch: no manual screen-reader runs (NVDA, Narrator, VoiceOver), no speech capture, no listening protocols and no speech-log gates.<br>• Automated accessibility stays required: ARIA semantics, axe, accessibility-tree reads (UIA/CDP), keyboard and focus gates, and performance with accessibility mode on.<br>• The design for screen readers (§6.2, Z32, Z33) stands. Until the parked validation runs, Typose claims only what the automated gates show, not verified screen-reader support (§6.3, §13.1). |
| Z40 | **Grid keys.** When Grid navigation owns focus:<br>• **Shift+Space selects the row and Ctrl+Space the column**; Page Up/Down page; Space doesn't page-scroll.<br>• Space still activates a focused button, checkbox or menu item, and the grid never swallows child-control input or IME composition.<br>• Keyboard-reachable row and column selection commands are the fallback where the OS or an input method owns a shortcut (WAI-ARIA grid pattern).<br>Selection is a Grid-milestone acceptance test; the spikes don't implement it (§6.1). |
| Z41 | **Spike code is preserved** as local, unmerged `spike/a`, `spike/b` and `spike/c` branches, with an immutable tag for each captured state, refreshed after each closing review.<br>• The tested lockfiles travel with the branches; they're never regenerated in transfer.<br>• Reports, logs, checker scripts and untracked results go to a revision-labelled evidence directory with hashes, which records unrun gates.<br>• A results template is never relabelled as a completed run (§13.1). |
| Z42 | **UTF-16 CSV/TSV opens in Raw only in v1.** The Grid lock reads "Grid is unavailable for UTF-16 CSV/TSV. Open in Raw, or convert a copy to UTF-8."<br>• Covers UTF-16LE and BE, BOM detection and the manual encoding override.<br>• An encoding override never reinterprets UTF-16 as a single-byte format to unlock the Grid.<br>• Transcoding with original-byte maps is deferred beyond v1 (§4.2). |
| Z43 | **Inline `data:` images** are allowed in Rendered, base64 only, for `image/png`, `image/jpeg`, `image/gif` and `image/webp`.<br>• Caps per image: **8MiB** of decoded file bytes, **16,777,216 pixels**, and **64MiB** of decoded pixel buffers (animation frames included). Z34's remaining budget can lower them.<br>• SVG, other types, malformed payloads and decodes whose limits can't be enforced are refused. Alt text and the reason stay visible.<br>• The payload is delivered through a bounded resource path with an opaque reference, never inline in HTML fragments or viewport messages. Local `data:` images don't need the remote-image bar.<br>• **UNC, `smb:` and ambiguous network-path images** (`//host/…` and slash/backslash variants) **stay blocked, even after "Load remote images"**: a fetch can send NTLM credentials to the host. Only explicit HTTP(S) URLs use the remote-image fetch path, and a redirect never becomes a file or SMB load. `mailto:` is never an image target.<br>This is a v1 Rendered requirement; the spikes drop `data:` images and haven't validated it (§4.6, §7.3). |
| Z44 | **Markdown front matter** is recognized only at the start of the file (after an optional BOM), and only when it closes within the first **64KiB**.<br>• Anywhere else, or over the limit, it reads as ordinary Markdown: never silently discarded.<br>• The same bytes give the same block boundaries whatever the parser's window size (§4.6). |
| Z45 | **TSV uses one deterministic CSV-style quoting dialect** (double quotes, which may enclose tabs and newlines). This isn't strict IANA TSV, and quoting is never inferred from a sample (§4.2). |
| Z46 | **CSV record-index throughput:** PC **≥ 0.9 GB/s**, Mac **≥ 0.45 GB/s**, warm, in decimal source bytes per second.<br>• Judged on the p50 of 30 warm release-build runs on each of the 100MiB and 1GiB mixed/quoted CSV fixtures, also reporting the sample count, p95 elapsed time and slowest throughput.<br>• Measures the whole record-index path (hashing and checkpoints included), never the in-memory tokenizer.<br>• A miss is recorded and investigated, not rounded into a pass (§10.2). |
| Z47 | **Z34's aggregate accounting and enforcement are an M1 exit requirement.**<br>• Phase 0 shows only the bounded stop and the Raw fallback, and reports aggregate enforcement as not implemented.<br>• M1 reserves and accounts across documents and concurrent builds, releases on close, cancellation and failure, and keeps enough capacity for Raw to stay usable. It closes with a deterministic multi-document budget-exhaustion test.<br>• Until then, gate runs use explicit conservative caps (§3.6, §13.2). |
| Z48 | **CSV header detection** stays the bounded sniffer in v1.<br>• ⓘ's "First row is header" override is a Grid-milestone acceptance criterion. It's visible and reversible, recovers the first data record when detection is wrong, never edits source bytes, and recomputes record numbering consistently (§4.2). |
| Z49 | **Gate-run protocol** for qualification timing (§10.3):<br>• Quiet machine: no other heavy work or agent lanes; the CPU under 10% for a minute before each timing run, with load recorded during it; Defender on.<br>• Automated warm runs, the operator-controlled cold-restart batch and manual checks run as separate batches.<br>• Every failed or invalid run is kept with its reason, never replaced by a clean rerun in the report. |
| Z50 | **Mac gates are required to close Phase 0** (performance and trackpad), on the friend's Apple-silicon Mac [Z29], using the same preserved revisions, lockfiles and fixture definitions.<br>• If access or restart permission is unavailable, the affected gates stay pending and go to the checkpoint. Phase 0 never closes Windows-only silently, and warm samples never count as cold.<br>• Repeatable Mac access for later milestones is decided before M1 (§13.1).<br>**Amended by Z53 and Z55** (2026-10-22): Phase 0 closed as a conditional go without its Mac gates, and those gates stay pending. Mac access is a Mac Zack controls. |
| Z51 | **Rows follows the Grid's key model (Z40).** When Rows navigation owns focus:<br>• Shift+Space selects the row (the record), and Space doesn't page-scroll; Page Up/Down page.<br>• A focused child control keeps Space, and IME composition passes through.<br>Selection is a Rows-milestone acceptance test (M3); the spikes don't implement it (§6.1). |
| Z52 | **A far jump is scrolling under §10.2's "no stall > 50ms" rule.** A far jump is a window replacement: a scrollbar jump, an Outline jump, or open-then-scroll.<br>• Spike B's G9 gains a jump case with accessibility on from launch.<br>• Spike B measured, with accessibility on from launch, 55–188ms (the Transcript reached 158ms opening and 188ms in a jump run), almost all of it accessibility-tree serialization. So the case fails today, and that failure is a Phase 0 finding for the checkpoint. With accessibility off, far jumps took 6–18ms, but open-then-scroll stalled 24–73ms on the Transcript (over 50ms in 2 of 5 runs) and 36–49ms on the Document. The spike didn't assert that last case, and §10.2 still covers it. (Corrected 2026-10-22; this row first said 55–103ms, and 12ms with accessibility off.)<br>• Bringing the jumps under budget, for example by replacing the window in smaller pieces, is milestone work (§10.2, §13.1). |
| Z53 | **Phase 0 checkpoint (2026-10-22): a conditional go to M1. Phase 0 is not qualified.**<br>• The checkpoint is held on the evidence already available.<br>• M1 is authorized despite the failed and pending gates, which keep that status (or "parked") with their dispositions in the M1 plan.<br>• Spike B's finishing work is preserved, and the spikes are frozen with their open findings. There's no further general spike review cycle.<br>• Qualification moves to the product milestones under Z49's unchanged protocol.<br>• This authorizes implementation, not a release, and doesn't declare that the spikes passed.<br>Amends Z38 and Z50 (§13.1). |
| Z54 | **Keep Electron + Rust [Z25].** Busy-PC warm measurements don't justify changing stacks, and there's no pre-M1 reboot campaign.<br>• Cold startup is measured on the M1 app, early enough to inform its implementation. The **< 200ms PC / < 400ms Mac** targets stay.<br>• Qualification uses one fixed build and layout, launched first after each of five restarts per reference platform; a second launch isn't cold. Shell appearance is measured apart from usable document content.<br>• A miss stays a miss: it needs optimization or an explicit budget decision, and never becomes a pass (§10.1, §10.2). |
| Z55 | **Mac access: an Apple-silicon Mac under Zack's control** (a long-term loan is enough), where the toolchain can be installed, builds kept and the machine restarted.<br>• The friend's Mac may bridge an initial batch.<br>• Mac-dependent acceptance stays pending until measured.<br>• The chosen reference rig is recorded before its qualification runs, with any change from Z29's baseline explained (§10.2). |
| Z56 | **Risks accepted for starting M1:**<br>• startup likely over budget;<br>• far jumps at 55–188ms with accessibility on, and open-then-scroll at up to 73ms with it off (corrected from 55–103ms);<br>• G4's unexplained exits;<br>• CSV throughput unqualified;<br>• aggregate memory unenforced until M1;<br>• real screen-reader validation parked.<br>Conditions:<br>• Memory enforcement and its tests remain mandatory for M1 closure [Z47]. Spike C's block cap doesn't bound heading text or reference definitions, so it isn't a safety guarantee.<br>• A corresponding unexplained exit in M1 blocks M1 closure.<br>• Performance failures stay failures.<br>• Screen-reader support stays unverified until tested [Z39]. |
| Z57 | **Merge authority:** the implementer merges each PR once its review is clean and CI is green, within an approved milestone plan. |
| Z58 | **M1 stays open while its Mac acceptance is pending** [Z55]. It doesn't close on Windows alone (§13.2). |
| Z59 | **A missed cold-startup target blocks M1 closure** until it's fixed or Zack explicitly changes the budget [Z54] (§10.2, §13.2). |
| Z60 | **CI on the private repo:** Windows and Linux run on every PR; macOS runs weekly on `main` (Mondays 06:00 UTC) plus `workflow_dispatch` [PR #16, Z65], until the repo goes public (§11.2) (narrowed by Z85). |
| Z61 | **No spending until after launch, once Typose is working.** Everything uses free resources:<br>• GitHub Free for the private repo. Actions stay within the included minutes, with a $0 spending limit, so overage pauses CI rather than billing.<br>• A loaned or borrowed Mac only [Z55]; nothing is bought.<br>• No paid subscriptions.<br>Consequence: §12.1's paid signing (Azure Trusted Signing, the Apple Developer Program) can't start before launch, so how the launch builds are signed is open (§15). |
| Z62 | **The 16.7 ms / ≥ 99% frame gate (§10.2, plan §5, OQ-6) judges cadence: every presented frame after the first in a demanded interval.** The first frame after an input is judged by responsiveness: the 50 ms stall rule and plan §5's 50 ms input-latency gate. A run whose demands each produce one frame (discrete keypresses) reports the frame gate as not applicable, never as passed. |
| Z63 | **Change detection checks the path's size, modified time and file identity after every lazy read, against the identity taken at open (it was before and after).** Reads go through the handle opened at open, so any change before or during a read fails the after-check and freezes the document. The before-check only narrowed a change-then-revert window on a chunk's first read, which §3.1's content verification already concedes metadata can't close. Measured 64 KiB fetch p95 at the napi layer: before and after 2.91–3.03 ms; after only 2.52–2.55 ms. (2026-10-23; §3.1, brief §7.9) |
| Z64 | **In tests, Z37's first-screen clock starts at the later of the open and the page's first frame.** A lens that waits for the line's end still fails; a page that can't paint yet is a startup problem the Z59 gates measure, not the lens's. |
| Z65 | **Close M1 lean, then a lens.** M1 closes with its remaining gaps recorded, not chased, and the process gets leaner:<br>• one review round per PR, except for security and memory;<br>• Sonnet for mechanical work;<br>• no further measuring work;<br>• macOS CI weekly. (2026-10-24; §11.2, §13.2) |
| Z66 | **Raw lines wrap at 2,048 UTF-16 units into ↪ continuation rows** (plan PR 6b). This is a deliberate deviation from brief §5.1 for lines of 2,049–10,000 units. (2026-10-24; brief §5.1) |
| Z67 | **The PC's shell-visible cold budget is < 400ms, provisional.**<br>• Z29's half-budget rule doesn't apply to this row: the GPU process's start (driver device creation, measured at 175–196ms per process in M1's PR 10 review) doesn't scale with CPU.<br>• It's measured with an existing profile, on an unlocked, displayed session (an addition to Z49).<br>• The final number is set after a real cold batch of OS restarts [Z54].<br>Amends Z54's < 200ms PC target. (2026-10-24; §10.2, §10.3) |
| Z68 | **The first formatted lens is rendered Markdown,** built end to end before M2. (2026-10-24; §13.2) |
| Z69 | **Merge on the full local Windows gate** until GitHub Actions minutes reset. Included minutes were exhausted ~18:00Z 2026-10-24; the spending limit stays $0 [Z61], so hosted CI pauses rather than billing. (2026-10-24; narrowed by Z85) |
| Z70 | **The default menu's keys go with it** (M1 plan §7 proposal 6, accepted): on Windows and Linux, Undo, Redo, Cut, Copy, Paste, Select All, Reload, Force Reload, developer tools, page zoom (Actual Size, Zoom In, Zoom Out), Full Screen, Minimize and Close; on Linux, Quit (Ctrl+Q) too; on macOS, the View menu's Reload, Force Reload, developer tools, page zoom and Full Screen keys, with the app, Edit and Window menus and File's Close Window unchanged. Zoom, full screen, Minimize and Close on Windows and Linux, and zoom and full screen on macOS, return in M2; Force Reload and developer tools are gone for good. (2026-10-24; M1 plan §7) |
| Z71 | **Rendered's size ceiling is 8MiB of source** in the first Markdown slice. Above it, the file opens in Raw with Rendered disabled and the reason in its tooltip. (2026-10-24; §4.6; the slice's plan, §4) |
| Z72 | **Rendered uses native `content-visibility` over all of its blocks** in the first Markdown slice, within Z71's ceiling, instead of the virtualizer: a temporary departure from Z26. (2026-10-24; §5.3; the slice's plan, §2.2) |
| Z73 | **A relative link to a supported file replaces the card's file** ("open it in the window"). There's no Back until M2. (2026-10-24; §5.4; the slice's plan, §2.4) |
| Z74 | **Land #40 now as a merge commit** (it contains #29–#39); close #30–#39 as landed through #40. (2026-11-01) |
| Z75 | **The next milestone is a Windows daily driver:** an installed build Zack uses every day. No signing and no Mac/Linux qualification yet. It supersedes the "feature-complete candidate" as the near-term target. (2026-11-01) |
| Z76 | **The Typose UI prototype is directional:** fix the defects plus the deltas a user notices in the first hour. Code-level divergences (glyphs, wording) are accepted. (2026-11-01) |
| Z77 | **The 9379bca snapshot is split into PRs that land after #41.** The transcript lens is deferred until after the daily driver; until then, session files use Raw/Rows/Table. (2026-11-01) |
| Z78 | **The core-crash policy stays security-first:** after a core restart, folder roots need re-picking. Restore never automatically reopens a document that crashed the core. (2026-11-01) |
| Z79 | **Daily-driver must-haves:**<br>• drag-and-drop of files and folders;<br>• a folder from argv or Explorer becomes a sidebar root;<br>• hand-off actions (Show in Explorer, Open with default app, Copy path, binary and executable sheets);<br>• JSONL Rows as a scrolling list;<br>• Wrap lines wraps Raw. (2026-11-01) |
| Z80 | **Daily-driver polish:**<br>• light-theme code highlighting and find colours;<br>• the unresolved-link style;<br>• JSONL Rows summaries, type colours and times;<br>• Settings and palette polish (segmented mode, Files tab, TOML banner, Ctrl+,, grouped palette). (2026-11-01) |
| Z81 | **Quick open keeps the bounded walk;** the native 50k index is deferred. (2026-11-01) |
| Z82 | **Install the build once,** at the end of the milestone. (2026-11-01) |
| Z83 | **Cleanup of merged worktrees and the landed draft chain is authorized.** (2026-11-01) |
| Z84 | **Each PR lands on main before the next stacks,** at most one layer deep. Claude is PM with Opus/Sonnet lanes; review is lean. (2026-11-01) |
| Z85 | **The merge bar is the full local Windows gate.** Per-PR hosted CI is slim: lint, typecheck, Vitest, cargo and an e2e smoke (`npm run e2e:smoke`). Full Linux e2e runs weekly (Mondays 07:00 UTC, `weekly-linux.yml`), and macOS stays weekly. (2026-11-01) |
| Z86 | **Math macro definitions stay refused:** `\newcommand`, `\def` and the like show their source instead of rendering, which bounds KaTeX worker memory. Revisit if a real document needs one. (2026-11-02) |
| Z87 | **Z63 is satisfied per page:** structured reads check file identity once per page, after that page's reads and before anything returns (`Document::batch`), not after every read. (2026-11-02) |
| Z88 | **The hand-off residual is accepted:** a real gesture on a Typose hand-off control can hand off a file that page script opened through the core. It is limited to allowlisted document and media types on plain local paths; there is no main-side path provenance. (2026-11-02) |
| Z89 | **Open with default app stays an allowlist** of document and media types. Anything else gets Show in Explorer only. (2026-11-02) |
| Z90 | **Quick-open picks open by absolute path as manual records.** The open is gesture-gated and refuses reparse points. This relaxes "display paths are never opened as manual paths" for quick open only. (2026-11-02) |
| Z91 | **The Rendered charge growth from source maps is accepted for now.** Inline-heavy Markdown reserves up to about twice as much; recalibrating the per-span cost waits until a real document hits the limit. (2026-11-02) |
| Z92 | **On Linux the accessibility mode is always on.** Electron reports accessibility support on macOS and Windows only, so on Linux every Markdown block stays in the accessibility tree (no `content-visibility: auto` skipping) whether or not a screen reader runs. (2026-11-02) |
| Z93 | **Size-bounding Raw's reservation is shelved, and the per-row cost gap is a known issue.** Raw charges items per UTF-16 unit, so a row's own DOM cost (about 0.7 KB live, more as repaint garbage) is unmodeled: a 192 KB file of newlines overruns its reservation by about 176 MiB on `26792b3`. Bounding reservations by file size (branch `fix/size-bound-reservations`, review FIX-FIRST) would extend that gap to 4 KB files, so 7–8 GB machines and hosted runners keep the 1.75–2 GiB link-preview limit. Fixing both needs calibrated per-row terms. (2026-11-02) |

---

## 1. Goals and non-goals

**Goals**
- Implement the brief's v1 (brief §2) on Windows and macOS at full quality, with Linux best effort [Z28].
- One file-backed, windowed architecture for every file size. The 100MB line only decides which whole-file background work runs and which heavy lenses unlock later (§14, D1).
- Every rendered thing knows its source byte range (brief §2.1), so a future editor, diff lens and live reload don't need a rewrite [Z1, Z6].

**Non-goals for v1**
- Everything in the brief's expansion list.
- An updater [Z24].
- Telemetry of any kind.
- Plugins.
- Windows on ARM builds (§12.2).
- Gated Linux accessibility and performance [Z28].

---

## 2. Architecture

### 2.1 Processes
```
┌─ Main (Electron main, TypeScript) ───────────────────────────────────────────────────────┐
│ windows · title bars · native menu · dialogs · single instance · argv/open-file          │
│ typose:// asset protocol · network guard · print · OS hand-off (shell) · session         │
└──────┬────────────────────────────────────────────────┬──────────────────────────────────┘
       │ spawns, hands a MessagePort to both ends       │ creates
┌──────▼─────────────────────────────┐   MessagePort   ┌▼──────────────────────────────────┐
│ Core host (utilityProcess, Node)   │◄═══════════════►│ Renderer (sandboxed, no Node)     │
│  └ typose-core (Rust, napi-rs)     │  viewport pages │  React chrome (React Aria)        │
│    documents · byte store · index  │  progress, find │  lens controllers + virtualizer   │
│    parsers · md→HTML · sanitizer   │                 │  workers: YAML CST, KaTeX, Shiki  │
│    search · fs listing · TOML edit │                 │  Mermaid in a sandboxed iframe    │
└────────────────────────────────────┘                 └───────────────────────────────────┘
```

| Process | Owns | Never does |
|---|---|---|
| **Main** | Window lifecycle, title bars and menus (§9), single instance and argv, file dialogs, `shell` hand-off under brief §4.6 rules, print (§8.5), `session.json`, serving the `typose://` app scheme, the network guard (§7.3) | Parse documents, or hold document bytes |
| **Core host** | Every file read, document generations, indexes, parsing, search, Markdown→HTML, sanitization, sidebar listings, the quick-open index, `config.toml` edits | Touch the DOM or the network |
| **Renderer** | Layout, chrome, lens controllers, focus and accessibility semantics, final rendering of Mermaid, KaTeX and Shiki | Read files, use Node, open URLs or spawn processes 🔒 |

- **Why the core runs out of the main process:** a parser bug or a 10GB scan can't freeze window management or menus. The renderer talks to the core directly over a `MessageChannelMain` port that main hands to both ends, so viewport traffic never goes through main.
- **Startup:** main spawns the core host **in parallel** with creating the window (§10.1).

### 2.2 Repository layout
```
typose/
  core/                 Rust workspace
    typose-core/        document model, byte store, indexes, parsers, search, md, sanitizer
    typose-node/        napi-rs bindings (thin; no logic)
    fixtures/           shared test corpus (incl. hostile inputs)
  app/                  npm workspace
    main/               Electron main (TS)
    core-host/          utilityProcess entry (TS), loads typose-node
    renderer/           React chrome + lenses (TS)
      lenses/           framework-free controllers (raw, grid, rows, table, tree, rendered, transcript)
      virtual/          the virtualizer
    shared/             IPC protocol types (TS), generated from Rust (§3.4)
  e2e/                  Playwright-for-Electron tests, perf harness
  docs/
```
- **Builds:**
  - **Rust:** `cargo` workspace.
  - **JS:** npm workspaces, TypeScript strict, `electron-vite` for main/preload/renderer, and `electron-builder` for packaging (§12).
- **No pnpm or bun.** The toolchain present is Node 24, npm 11 and Rust 1.96.

---

## 3. Document model 🔒

### 3.1 Identity and generations
- Each open file gets one **`DocumentId`**, and a **generation** number within it.
- **Opening a file** records its size, modified time and file identity, starting **generation 1**.
- **Change detection (brief §7.9):** after every lazy read, against the identity taken at open [Z63], the core checks the path's size, modified time and **file identity** (volume + file index on Windows, device + inode elsewhere).
  - Any difference **freezes** the document at its current content: the brief's "Changed on disk" banner shows, and nothing new is read.
  - **Ctrl+R** starts a new generation.
- **Content verification 🔒:** metadata checks alone can't catch every write. An in-place, same-size write inside the timestamp resolution, or one landing between the check and the read, slips through. So:
  - The core hashes every **1MiB chunk** (xxh3-64) the first time it reads it. The indexing pass reaches every chunk, so an indexed document has a complete chunk table (8 bytes per MiB, about 80KB for 10GB). A chunk read before the indexer reaches it is hashed on that read, and the indexer verifies it when it arrives.
  - **Every later read of a chunk is verified** against its hash. A mismatch is handled like a metadata change: the document freezes, and nothing from that read is displayed or copied.
  - The guarantee: **every byte Typose displays or copies matches the first-hashed version of its chunk.**
- **Every span, page and search hit carries its generation.** Copy goes through the same verified read path. After a freeze it's refused, and Reload is offered.

### 3.2 Source spans
```text
SourceSpan { start: u64, end: u64 }          // original file bytes, end-exclusive
SourceRef  { gen: u32, primary: SourceSpan, contributing: SourceSpan[] }
```
- **Original bytes are authoritative.** Offsets are u64 throughout, so >4GiB files are correct. Libraries with 32-bit offsets (tree-sitter, for example) are never the coordinate system.
- **`contributing` spans:** a Transcript turn built from several records, or an alias pointing at its anchor, carries every span that fed it.
- **Byte maps 🔒:** the core decodes text, so the core maps it back. **The renderer never re-encodes text to find offsets.**
  - Every text slice the core sends (a Raw line, a cell, a rendered text run) carries its starting byte offset and a **byte map** from UTF-16 offsets to original-byte offsets.
  - **Uniform maps:** used when every UTF-16 unit is a fixed number of source bytes. Windows-1252 is always 1 byte per unit, UTF-16 is always 2, and ASCII-only UTF-8 is 1.
  - **Breakpoint maps:** otherwise, a compact list of breakpoints at every character whose source length differs. That covers multi-byte UTF-8, malformed UTF-8 (one `�` standing for 1–3 bytes) and, in Rendered Markdown, every place the display differs from the source: entities (`&amp;` → `&`), backslash escapes and any other rewrite.
  - A selection endpoint maps through the slice's byte map by binary search. An endpoint inside a multi-byte source sequence snaps to the sequence's boundary.
  - Copy then reads bytes from the core by span (§3.1).

### 3.3 Byte store (file access) 🔒
- **Positional reads only. No memory-mapping on any OS in v1.**
  - On Windows, a mapping blocks delete and replace, which breaks brief §7.9.
  - On macOS and Linux, another process truncating a mapped file turns a read into `SIGBUS`, which would crash the core.
  - Positional reads (`seek_read` / `read_at`) into reused 1–4MiB buffers keep `memchr`-class scanning at GB/s (Spike A verifies this).
- **Windows:** files open with Rust's default `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, so another app can save, rename, delete or replace the file at any time (brief §7.9).
- **Handle lifetime:** Spike C decides between two options:
  - keep the handle for the document's lifetime, which is cheaper and avoids an antivirus re-scan on every reopen;
  - reopen it for each read.

  Either way, **change detection stats the path, not the handle**. An editor's atomic replace leaves an open handle on the old file, and only the path shows the change.
- **Refused:** device and special files (FIFOs, `/dev/*`, `\\.\…`). UNC and `smb` paths are only read after a user click (brief §4.6).
- **Bounded cache:** a page cache holds recently read blocks. It counts toward the aggregate memory budget (§3.6).

### 3.4 Core API (the IPC contract)
- **One versioned protocol**, defined in Rust and exported to TypeScript (`ts-rs` or `specta`) so the types can't drift.
- **Request/response with ids, cancellation and progress:**

| Call | Returns |
|---|---|
| `open(path) → {doc, gen, format, size, encoding, firstPage, lenses: {name, ready, reason?}[]}` | Enough to paint the first screen in one round trip |
| `page(doc, lens, window \| continuation) → Page` | Rows, lines, nodes, blocks or turns for a window, each with its `SourceRef` and byte map. Or the next bounded piece of an oversized item. |
| `expand(doc, nodePath)` / `collapse` | Tree and Rows children (lazy) |
| `measure(doc, lens)` | Counts, column widths, value-pill decisions (progressive) |
| `sort(doc, column, dir)` | A sorted view id (core-side permutation) |
| `find(doc, lens, query, opts)` | A stream of hits `(SourceRef, lensLocator)` plus a running count |
| `read(doc, SourceRef)` | Source bytes for copy, refused if stale (§3.1) |
| `list(root, dir)` / `quickOpen(query)` | Sidebar listings and fuzzy matches |
| `config.get/set` | TOML read and format-preserving edit (§8.4) |
| `progress` (event, 5–10Hz) | Indexing and parse progress per document |

- **Ready lenses:** `open` reports each lens as **ready** or **locked**.
  - A lens is ready once what it needs exists: for example the container index for Tree, the record checkpoints for Grid, the YAML worker parse for YAML Tree.
  - A locked lens carries a reason ("Available after indexing", or the memory reason from §3.6), and a `progress` event announces when it becomes ready.
  - The brief's budgets for lens switching and first screen apply to ready lenses (§14, D1, D3).
- **Transport rules** (from both reports):
  - Pages are capped at **256KiB**.
  - **Rendering units are bounded too.** No single item in a page exceeds **64KiB of text**: a Raw line, a cell, a Rows record, a Markdown block or sub-block, a Transcript block. A larger item arrives as a first piece plus a **continuation token**. Each piece is its own virtualized item, and `page(doc, lens, continuation)` fetches the next one on demand (§4.4, §4.6).
  - At most **2 outstanding viewport requests per lens**; stale requests are cancelled.
  - Requests are coalesced to **one per animation frame**.
  - **The core never streams a whole index or tree to the renderer**, only pages and progress deltas.
- **Encoding starts as structured-clone objects**, which is the simplest option. If Spike A shows page decode above **3ms p95 for 64KiB**, hot pages move to transferable `ArrayBuffer`s with a compact binary layout.

### 3.5 Indexes
| Format | Index | Memory |
|---|---|---|
| Text, Raw (all formats) | Line checkpoints: one `u64` every 1,024 lines, built with `memchr` (+ `rayon` for >64MiB). The block is rescanned on demand. Each checkpoint also records the UTF-16 length and non-ASCII flag of its block. | ~16KiB per million lines |
| JSONL | The line index, plus per-line parse status and blank or failed counts | as above + 1 bit per line |
| CSV/TSV | **Record** checkpoints (records ≠ lines, because quoted fields contain newlines) from `csv-core` state, every 1,024 records. Quote state makes parallel indexing hard, so v1 indexes sequentially (Spike A measures this). | ~8KiB per million records |
| JSON/JSONC | A **container index**: every object and array, with start/end offsets and child count, from one streaming structural scan. Children of an expanded container are enumerated lazily, with element checkpoints for huge arrays. | Proportional to containers, not values |
| Markdown | Top-level **block boundaries** plus the heading list (for the outline), link reference definitions and footnote definitions | Proportional to blocks. Spike C measured 65–75 bytes per block on dense Markdown, about the file's own size; the optimization target is ≤ 32 bytes per block [Z34] |
| YAML | None in the core. See §4.5. | — |

- **Byte-bounded checkpoints:** every index above checkpoints after 1,024 units **or 1MiB of bytes, whichever comes first**. So no rescan reads more than 1MiB to find a position, even in a file whose first record is 200MB.
  - A checkpoint that falls inside a line or record stores what's needed to resume there: the in-line offset for text, and the `csv-core` parser state for CSV.

### 3.6 Memory budget 🔒
- **One aggregate ceiling:** 25% of physical RAM (brief §8.3) [Z34]. It covers every resident structure across **all open documents**: indexes, page caches, sort permutations, temporary parsing allocations, and renderer-side caches the core is told about. It is not 25% per tab (§14, D4).
- Before building a heavy lens's structures, the core **estimates** their size. If the estimate would exceed the remaining budget, the lens stays locked, with the reason in its tooltip and in ⓘ (brief §8.3).
- **If the limit is reached while building** (an estimate can be wrong, and a Markdown index grows with its block count), building stops. Rendered shows why it's unavailable, and Raw stays [Z34]. Per-format caps such as JSON's `max_containers` and Markdown's `max_blocks` are the stop mechanism. They don't enforce the budget: a count of blocks or containers doesn't bound bytes, because heading text and reference definitions grow outside the count (Spike C, Z56). Enforcement is the byte-accounted ledger [Z47].
- Closing a document frees its structures immediately.
- **When it's built** [Z47]: the aggregate accounting and enforcement are an M1 exit requirement. Phase 0 demonstrates only the bounded stop and the Raw fallback, through `max_blocks`, which alone is not the 25% budget. Until M1, gate runs pass explicit conservative caps.

---

## 4. Formats and parsing

The library picks are proposals. Spike C confirms or replaces each one.

### 4.1 Sniffing (core)
- **Format:** decided by extension, with `.json` falling back to JSONC (brief §5.5).
- **Encoding before binary detection** (brief §5.3 encodings, no statistical detection; the order changes brief §7.9, §14 D16):
  1. BOM check (UTF-8, UTF-16LE/BE). A UTF-16 BOM selects UTF-16 and **skips the NUL test**, because UTF-16 text is full of NUL bytes.
  2. Otherwise, any NUL in the first 8KB marks the file as binary (brief §7.9).
  3. Validate as UTF-8.
  4. Otherwise the configured fallback: **Windows-1252** by default (Settings → Files).
  5. ⓘ can override the encoding.
- **BOM-less UTF-16 is detected as binary.** The brief only recognizes UTF-16 by its BOM. Encoding override in ⓘ is the escape hatch.
- **Decoding:** `encoding_rs`. Undecodable bytes become `�` and are counted as a problem (brief §7.7).

### 4.2 CSV/TSV
- **Parsing:** `csv-core` for record boundaries and fields.
- **Sniffing:** delimiter (`,` `\t` `;` `|`) and header detection over the first 64KiB. ⓘ can override both (brief §5.3). Header detection stays this bounded sniffer in v1. The "First row is header" override is a Grid-milestone acceptance criterion [Z48].
- **TSV quoting:** the same deterministic CSV-style dialect as CSV. Double quotes may enclose tabs and newlines. It isn't strict IANA TSV, and quoting is never inferred from a sample [Z45].
- **UTF-16 CSV/TSV opens in Raw only in v1** [Z42]. `csv-core` tokenizes bytes, and UTF-16 has no single-byte delimiters, quotes or line ends. The Grid lock reads "Grid is unavailable for UTF-16 CSV/TSV. Open in Raw, or convert a copy to UTF-8." An encoding override never reinterprets UTF-16 as a single-byte format to unlock it.
- **Pages:** each row carries its record span. Per-field spans are computed on demand by re-tokenizing that one record.
- **Background work:** type inference (alignment, icon and sort order only, never reformatting), the value-pill decision, and column widths, all computed from the **first 1,000 rows**.
  - The first screen uses estimates from the rows in view; widths refine as the scan completes, keeping the reading anchor in place (§14, D14).
- **Sort:** a core-side permutation, view only. The row number stays the source row number (brief §5.3). Sort needs the whole record index:
  - on files over 100MB, it unlocks after indexing (brief §8.2);
  - on smaller files, it's available once the background scan finishes.

  Either way it's subject to the memory estimate (§3.6).

### 4.3 JSON and JSONC
- **Scanner:** a **hand-written structural scanner** that records spans only. Display text is always a slice of the source, so the Tree is lossless by construction:
  - verbatim numbers (`12345678901234567890`, `3.10`, `1e400`);
  - duplicate keys kept (and flagged);
  - comments and trailing commas recorded as trivia (JSONC).
- **Why hand-written:** of the libraries reviewed, only `jsonc-parser` gives byte ranges, and it builds a whole AST. A huge top-level array needs streaming enumeration, which the container index (§3.5) gives. Spike C benchmarks the scanner against `jiter` and `struson`. If either matches the span and laziness requirements at lower cost, it replaces the scanner.
- **Invalid files:**
  - A file invalid as a whole opens in Raw with the brief's banner and error position (brief §7.7).
  - A file that stops parsing partway shows what parsed plus the "Parse stopped at line N" row (brief §5.5).
- **Table lens:** offered when the root is an array of objects. Columns are the union of keys over the first 1,000 elements, growing as the scan proceeds.

### 4.4 JSONL
- **Rows pages:**
  - The core parses only the **visible** lines with the same scanner and extracts the row anatomy: timestamp, type and summary fields (brief §5.4).
  - Expanding a row runs the JSON Tree over that line's span.
  - A record over 64KiB arrives in bounded pieces (§3.4).
  - A record over 1MB shows its first 1MB, then "+N MB more · Copy record", mirroring Raw's long-line rule (§14, D13).
- **Table:** the union of top-level keys over the first 1,000 lines, plus the "…other keys" column (brief §5.4).
- **Transcript detection** follows brief §5.4. Each schema is a **versioned adapter** with fixtures, a confidence result, and fallback to Rows when detection fails.
  - **Claude Code adapter:**
    - fixtures come from real `~/.claude/projects/*.jsonl` sessions on Zack's machine, since the schema is community-documented and unstable;
    - it builds the `uuid` → `parentUuid` graph in one pass (about 48 bytes per record), which is why Transcript unlocks after indexing for files over 100MB (brief §8.2).
  - **OpenAI adapter:** handles dataset lines and message lines (brief §5.4).

### 4.5 YAML
- **Parsed in a renderer Web Worker** with the JS `yaml` package (`parseDocument` plus its CST). Both reports found **no Rust crate** that combines comments, anchors and aliases, explicit tags, spans and a tree.
  - The worker receives the file's **bytes** from the core, decodes them, and keeps its own UTF-16→byte table, so every node still yields a `SourceRef`.
  - `maxAliasCount` is set, and aliases expand on demand to a limited depth (brief §5.5).
- **Size ceiling:**
  - YAML Tree is available up to **`yaml.treeMaxBytes` = 8MiB** in v1 [Z36]. Spike C measured about 5MiB/s of worker parse time, so 8MiB is about 2s. At 128MiB, a parse ran the renderer out of memory.
  - Above the ceiling, Tree is locked with a reason that states the ceiling (e.g. "Tree available up to 8 MB"), and Raw remains (§14, D11).
  - Below the ceiling, the worker still enforces memory and structural limits: alias count, alias expansion depth and nesting depth [Z36].
  - Between the first-screen fixture size and the ceiling, Raw shows first and Tree unlocks when the worker finishes, with the indexing indicator.
- **Revisit:** if a Rust lossless YAML tree matures (`granit-parser`, `yaml-edit`), YAML moves into the core.

### 4.6 Markdown
- **Parser:** `pulldown-cmark` in the core, using `into_offset_iter` byte ranges (including inlines).
  - **Extensions:** GFM tables, task lists, strikethrough, footnotes, GitHub alerts, math, YAML frontmatter and wikilinks.
  - **Typose adds:** Obsidian callouts beyond the five GitHub kinds, Mermaid and math fence routing, wikilink resolution (brief §4.4) and heading slugs (GitHub algorithm).
  - **Front matter** [Z44]: recognized only at the start of the file (after an optional BOM), and only when it closes within the first 64KiB. Anywhere else, or over the limit, it reads as ordinary Markdown, never silently discarded. The same bytes give the same block boundaries whatever the window size.
- **Images** [Z43]:
  - Local `data:` images: base64 PNG, JPEG, GIF and WebP within the per-image caps (8MiB decoded file bytes, 16,777,216 pixels, 64MiB decoded pixel buffers). They're delivered through a bounded resource path with an opaque reference, never inline in a block's HTML fragment.
  - SVG and other types are refused, keeping the alt text and the reason.
  - UNC, `smb:` and ambiguous network-path images stay blocked, even after "Load remote images" (§7.3).
- **Output:** the core emits **one sanitized HTML fragment per top-level block**, plus the block's `SourceRef`, its heading entries and its plain text (for find).
  - Rendering stays in the core, so the renderer never parses Markdown and never sees unsanitized HTML.
  - Raw HTML is sanitized by **`ammonia`** against the brief's allowlist (brief §4.6). `svg` and `math` are never enabled; the 2025 mXSS advisory concerned exactly those.
  - Every text run carries its byte map (§3.2), so a selection inside a rendered paragraph maps to exact source bytes.
- **Oversized blocks** (§3.4, §14 D17): a block over 64KiB is split into **sub-blocks**. They virtualize as separate items under one block identity:
  - code fences and other Raw-like content by lines;
  - lists by items;
  - tables by rows, each chunk its own table with the column widths fixed by the first chunk;
  - paragraphs at word boundaries.

  A block that can't be split sensibly, such as one 5MB HTML fragment, renders as **its source in a bounded Raw view** with a note. It never becomes one giant DOM subtree.
- **Provisional rendering** (§14, D1):
  - The first screen renders from a **prefix parse**.
  - A reference definition or footnote found later triggers a **reconcile** of the affected blocks in the background; the reading anchor is kept.
  - Over 100MB, Rendered unlocks after the block index completes (brief §8.2).
  - **Giant files** [Z30] open immediately in Raw while Rendered indexes in the background, with progress and cancellation. Roughly 20 seconds for 1GiB is acceptable, but it isn't a deadline. Spike C measured about 65MB/s single-threaded.
- **Post-processing** in the renderer, on visible blocks only, cached by block hash:

| Tool | Where it runs | Hardening |
|---|---|---|
| **Shiki** (JS regex engine, grammars lazy-loaded) | Code blocks, and the Raw lens. In Raw it highlights **visible lines only**, restarting grammar state from the nearest line checkpoint, so highlighting can be approximate after a jump into a huge file. Lines over 10,000 characters aren't highlighted, and highlighting never gates Raw's first paint. | The brief's highlighting rules (§5.1, §5.2) |
| **KaTeX** | A worker, returning HTML+MathML | `trust: false`, `maxExpand: 1000`, a finite `maxSize`, `throwOnError: false`. Output passes **DOMPurify** with the MathML profile 🔒 |
| **Mermaid** | Lazy-loaded on the first diagram; **`securityLevel: 'sandbox'`** (an iframe) | `maxTextSize` and `maxEdges` at their defaults. The source shows until the diagram is ready, and a render error shows the source plus a problem marker (brief §4.6, §14 D7) 🔒 |

---

## 5. Renderer

### 5.1 Chrome (React 19 + React Aria) [Z26]
- **React owns:**
  - the title-bar content;
  - the sidebar (React Aria `Tree`);
  - tab pills (`Tabs`; reorder and moving between cards use React Aria's drag-and-drop hooks);
  - card frames and headers, including the lens switch (`Tabs`, the tablist role brief §9 requires) and its dropdown below 400px (`Select`);
  - ⓘ popovers;
  - the peek frame;
  - quick open and the command palette (`Autocomplete`/`ComboBox` in a `Dialog`);
  - settings, toasts, sheets, and the find and go-to bars.
- **State:** the workspace (roots, cards, tabs, lens per tab, scroll anchors) lives in **one plain TypeScript store module**, read through `useSyncExternalStore`. No state library.
- **Styling:**
  - Theme tokens become CSS custom properties on the root (the brief's §6 values; the canvas helmet is the reference).
  - Zoom scales a single `--px` unit that every px token derives from (brief §6.5).
  - The dark and light themes set `color-scheme`.
  - Fonts are bundled as woff2.
- **React never renders lens content.** Each card body is a `div` that a lens controller mounts into.

### 5.2 Lens controllers
- **Interface:** each lens is a class implementing
```ts
interface Lens {
  mount(el: HTMLElement, doc: DocHandle, anchor?: Anchor): void
  setViewportSize(w: number, h: number): void
  anchor(): Anchor                      // source-mapped, for lens switch and session restore
  find(q: FindQuery): FindSession
  goTo(target: LineOrRow): void
  selection(): SourceRef[]              // copy reads these from the core
  print(range: PrintRange): PrintJob    // §8.5
  dispose(): void
}
```
- **Rendering:** controllers render with direct DOM operations and recycle row and cell elements. They talk to the core through `DocHandle`, which owns request coalescing and cancellation (§3.4).
- **Lens switch:** take `anchor()` from the old lens, mount the new one at that anchor, and cross-fade for 90ms (brief §5).

### 5.3 The virtualizer
- **One implementation** with two layouts:
  - **Fixed-height rows:** Grid, Raw without wrapping, collapsed Rows, Tree.
  - **Measured variable-height items:** Rendered blocks, Transcript turns, Raw with wrapping. Unmeasured items use estimates, and the reading anchor is preserved when an estimate is corrected.
- **Native scrolling below the cap, logical scrolling above it.** Both Chromium and WebKit cap layout extents at about **33.55M px**, which is roughly 0.8–1.4M rows at 24–40px.
  - Up to **16M px** of content, scrolling is fully native.
  - Above that, the virtualizer switches to **logical scrolling**. Mapping the native position proportionally would amplify every movement: 50M rows × 24px on a 16M px spacer is about 75×, so one 120px wheel notch would jump roughly 375 rows (AG Grid documents the same effect). Instead:
    - **Wheel, trackpad and keyboard move 1:1 in logical pixels.** A non-passive `wheel` handler applies the deltas itself, converting line-mode deltas at the row height. Momentum still arrives as wheel events. Arrows, PageUp/PageDown and Home/End are applied by the lens.
    - **The native scrollbar is for coarse positioning only.** Its thumb tracks the logical position proportionally, and dragging it or clicking the track jumps proportionally. The virtualizer flags its own scrollbar updates, so they aren't read back as user jumps.
    - **Ctrl+Home/End and Go to row** set the logical position exactly (§14, D5).
  - Spike A gates incremental reading deep inside a huge file (§13.1).
- **Horizontal virtualization** for Grid, so 5,000 columns works (brief §5.3). The sticky header and row-number column are positioned, not stacked layers.
- **Overscan:** 1 viewport each way by default. When a screen reader is active, Rendered and Transcript widen it to the accessibility window (§6.2). Grid, Rows and Tree keep the default, and rely on keyboard navigation that loads its target first [Z33].

### 5.4 The peek and links
- **Peek:** the peek is a card frame (React) hosting a lens controller. Its header slot is supplied by the content (brief §2.1, §4.5).
- **Link resolution** follows brief §4.4. It runs **in the core**, which knows the roots and the file system.
- **Clicks:** the renderer sends `resolveLink(doc, href)` and gets back one of:
  - `{open: path, anchor}`;
  - `{handoff: kind, path}`;
  - `{external: url}`;
  - `{unresolvable}`.

  Only **main** acts on a hand-off or external result, under the rules in §7.2 🔒.

---

## 6. Accessibility architecture 🔒 (brief §9)

### 6.1 Semantics per surface
| Surface | Pattern |
|---|---|
| Pills, lens switch | React Aria `Tabs` (tablist) |
| Sidebar | React Aria `Tree` |
| Grid | `role=grid` with `aria-rowcount`/`aria-colcount` (the true totals, or `-1` while indexing) and `aria-rowindex`/`aria-colindex` on every rendered row and cell. Roving focus, with the **focused row kept mounted** even when it scrolls out of view.<br>• The row-number column is column 1, so the first data column is announced as "column 2" with its name [Z32].<br>• Row-number cells show the source record number (1 = the first data record) [Z31].<br>• `aria-rowindex` stays positional, with the header row as row 1.<br>• Keys [Z40]: Shift+Space selects the row and Ctrl+Space the column; Page Up/Down page; Space doesn't page-scroll; a focused child control keeps Space, and IME composition passes through. |
| Tree | `role=tree` with `aria-level`, `aria-setsize` and `aria-posinset` taken from the core's counts |
| Rows | `role=treegrid` (expandable rows). Keys follow the Grid's [Z51]: Shift+Space selects the row; Space doesn't page-scroll; a focused child control keeps Space. |
| Rendered | Document semantics: real `h1–h6`, lists, tables and `main`. Heading navigation across the virtualized body uses §6.2. |
| Transcript | `role=feed` of `article`s with `aria-setsize`/`aria-posinset`, turn headings and the role label as the accessible name |
| Mermaid, KaTeX | The diagram iframe is labelled, and the source stays available. MathML output is used for math. |

### 6.2 Virtualized content and screen readers
Nothing can expose DOM that doesn't exist (§14, D5). The design:
- **Accessibility mode:** main forwards Electron's `accessibility-support-changed` event. When a screen reader is active, document lenses render a **wide window** (500 blocks or turns; VS Code's `accessibilityPageSize` pattern), so browse-mode reading and "next heading" work across a large region.
  - **The window follows the reader.** Screen readers scroll the element under their virtual cursor into view. When that moves the position into the outer quarter of the window, the window **recenters**. The element under the cursor stays mounted across the shift, so reading continues without a jump.
  - **Edge controls** at both ends of the window ("Continue: next 500 blocks") are the fallback for a screen reader that doesn't scroll. Spike B decides whether they're needed.
- **The Outline is always present in the accessibility tree** for Rendered, even when the rail is hidden visually. Activating a heading scrolls to it and moves focus there.
- **Grid, Tree and Rows:** keyboard movement requests the target row before moving focus, so focus never lands on nothing (Astra). Every data cell is reachable this way. Continuous "read all" across them isn't a v1 requirement, so they don't render the wide window [Z33].
- **Totals are announced** through the `aria-*count` attributes, never as a partial count presented as final (unknown totals use `-1`).

### 6.3 Testing
- **Automated:** `axe-core` checks on the chrome in Playwright, plus accessibility-tree reads (UIA/CDP), keyboard and focus gates, and performance with accessibility mode on. These are the accessibility gates before launch [Z39].
- **Manual (parked until after launch [Z39]):** a fixed 20-task screen-reader script, on **NVDA (IA2) and Narrator (UIA)** on Zack's PC, and on **VoiceOver** in batched Mac sessions. Orca isn't gated in v1 [Z28].
  - Spike B's script is kept as the starting point for the expansion. Its cadence, Z35's, is superseded.
  - Until it runs, Typose claims only what the automated gates show, not verified screen-reader support.

---

## 7. Security 🔒 (brief §4.6)

### 7.1 Electron hardening
- **Renderer:**
  - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`;
  - a preload exposes only a typed, validated API;
  - `webSecurity` stays on;
  - every message from the renderer is validated in main and in the core.
- **Strict CSP** on `typose://`:
  - `default-src 'self'`;
  - images limited to `self`, `data:` and `blob:` (remote images reach the renderer as blobs from main, §7.3);
  - no inline script.

  Mermaid's sandbox mode renders into an iframe with a `data:` source, so the CSP allows `frame-src data:` and nothing else. The hostile-fixture gate (Spike C) confirms that the frame can't make requests or navigate the app.
- **Navigation:** `will-navigate` and `setWindowOpenHandler` deny everything. Links go through §5.4.
- **Electron fuses:** `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, `EmbeddedAsarIntegrityValidation` on.
- **Chromium age without an updater:** ship releases **within one Electron major of current stable**. A Chromium security release that affects the renderer triggers a patch release (§12.3).

### 7.2 Hand-off
- Brief §4.6 is implemented in **main** from the core's `resolveLink` result: the executable lists per OS, UNC/`smb` only on click, device files refused.
- `shell.openExternal` is called **only** for `http`, `https` and `mailto`. Any other scheme goes through the confirm sheet.

### 7.3 Network: "Typose issues no requests" 🔒
- **Blocked by default:**
  - `session.webRequest.onBeforeRequest` cancels everything not on `typose://`, `data:` or `blob:`;
  - the Hunspell dictionary download is off (`spellcheck: false`);
  - there is no `autoUpdater`;
  - `crashReporter` collects minidumps **locally only**.
- **Remote images** load only after the user clicks the per-file bar. Even then they're fetched by **main**, through a dedicated Electron session that is separate from the app's blocked one, with limits on redirects, response size and image type. The renderer never fetches them directly.
  - Only explicit HTTP(S) URLs take this path, and a redirect never becomes a file or SMB load. UNC, `smb:` and ambiguous network-path images are never fetched, even after the click, because a fetch can send the user's NTLM credentials to the host [Z43].
- **CI check (the NetLog assertion):** CI launches the app with `--log-net-log`, opens the hostile fixtures, and parses the log (§11.1).
  - It **fails on any URL request with a scheme other than `typose:`, `data:` or `blob:`, any DNS resolution, or any socket connection**.
  - "The log is empty" isn't the test, because a NetLog always holds metadata and non-request events.
- **Out of Typose's control** (§14, D8): OS certificate checks, network printers and the OS opening user-clicked URLs.

---

## 8. Features with notable mechanics

### 8.1 Single instance, CLI and "Open with"
- **Single instance:** `app.requestSingleInstanceLock`. The `second-instance` handler receives `argv` and `cwd`, and macOS paths arrive through `open-file`. Paths are normalized and opened under brief §4.1.
- **CLI:** a `typose` launcher script on PATH, installed by the installers. It handles spaces, Unicode, `--` and paths that look like options.
- **Edge case:** a launch from a different user or an elevated context can't reach the running instance, so it does nothing. This is documented (§14, D15).
- **File associations:** electron-builder `fileAssociations` for every format in brief §2, as "Open with" entries. Typose never makes itself the default handler without asking.

### 8.2 Session and recents
- **`session.json`**, written by main and read synchronously at startup so the window opens at the right bounds. It holds:
  - window state;
  - roots;
  - the cards, with each card's tabs, lens and scroll anchor;
  - recents (up to 8).
- **Writes:** debounced to 1s, written atomically (temp file + rename).
- **Restore:** a tab whose lens isn't ready yet opens in the immediate lens, then switches when it unlocks (brief §8.2).

### 8.3 Sidebar listings and quick open
- **Sidebar listing:** `walkdir` in the core. It never follows symlinks or junctions. Dotfiles follow the setting, and `.gitignore` is not applied (brief §3.4).
- **Re-listing** happens on expand, on ⟳, on Ctrl+R, and on window focus (expanded folders only). Nothing watches the file system.
- **Quick open:**
  - a per-root index capped at 50,000 entries, built in the background when a root is added;
  - fuzzy matching in the core;
  - excludes as in brief §4.2.

### 8.4 Config and themes
- **Files:**
  - `config.toml` in the OS config directory: `%APPDATA%\Typose`, `~/Library/Application Support/Typose`, `$XDG_CONFIG_HOME/typose`;
  - `themes/*.toml` beside it.
- **Edits** go through **`toml_edit`** in the core, which re-reads the file and edits only the changed keys, preserving comments and formatting (brief §7.10).
- **Parse errors:** the last good values are kept, and Settings shows a banner with the line and column.
- **When hand edits are picked up:** on launch and whenever the Settings tab gains focus. Nothing watches the file.
- **Theme files:** `version = 1`, and token names match the brief's §6.
- **Live preview:** Settings' preview opens bundled sample files (md, csv, jsonl) through the normal `open` path. It doesn't need a separate in-memory document API.

### 8.5 Print
- **API:** Electron `webContents.print` / `printToPDF` through the OS dialog (brief §7.11).
- **Separate print view:** each lens's `print(range)` builds a **dedicated paginated print document** in a hidden window using the **Light** tokens. It never prints the virtualized viewport.
  - Grid repeats its header on every page with a `thead` and `@page` rules.
  - Tree and Transcript print in their current expansion state.
- **Bounded before it's built** (§14, D9):
  - Typose's own print sheet comes **before** any print document is constructed. It shows the page estimate (from the index) and the range: All, the pages around the current view, or a custom range of rows, lines or pages.
  - A job is capped at **1,000 pages** (proposed). "All" is offered only when the whole file fits; larger files need a range.
  - Over 50 pages, this sheet also serves as the brief's confirmation (brief §7.11).
  - Only the chosen range is rendered, in bounded batches, into the print document. The OS dialog opens after that.
  - Print is disabled while the file is still indexing (brief §7.11).

---

## 9. OS chrome
| OS | Title bar | Menu |
|---|---|---|
| **Windows** | `titleBarStyle: 'hidden'` + `titleBarOverlay` (Window Controls Overlay, 40 **logical** px). Caption buttons are native, and **Snap Layouts** comes from WCO's `HTMAXBUTTON` hit-test. This is source-documented but unverified, so Spike A checks it on the packaged build. | ☰ (React Aria `Menu`) |
| **macOS** | `titleBarStyle: 'hidden'` + `trafficLightPosition` (centered in the 40px bar), with » after the lights. Fullscreen follows the system. | Native application menu built from the same command table as ☰ |
| **Linux** (best effort) | Frameless + WCO where Electron supports client-side decorations on Wayland. The native frame is the fallback where server-side decorations are forced; ☰ and » then move to the top-left of the canvas (brief §3.1). | ☰ |

- **One command table** (id, label, shortcut, enabled predicate) drives the ☰ menu, the native macOS menu, the command palette, context menus and the shortcut list in Settings (brief §3.2, §4.3, §7.2).

---

## 10. Performance

### 10.1 Cold start
- **Mechanics:**
  - The app loads from `typose://`, registered privileged with **V8 code cache** on (verify the `codeCache` flag in Spike A).
  - The chrome bundle is small; each lens module and Mermaid, KaTeX and Shiki are **lazy-loaded**.
  - The core host spawns in parallel with window creation, and the window is shown on `ready-to-show`.
  - Restore paints the chrome first, then each visible card's first page.
- **Budgets** (§14, D2): **shell visible < 400ms** and **first restored lens content < 1s**.

### 10.2 Budgets and where they're gated [Z29]
| Budget (brief §8.1, as revised in §14) | Zack's PC (half budget) | Apple-silicon Mac (full budget) |
|---|---|---|
| Shell visible, cold [Z67] | < 400ms, provisional | < 400ms |
| First restored lens content | < 500ms | < 1s |
| First screen, fixture set ≤ 100MB, ready lens | < 50ms | < 100ms |
| First screen, 1GiB/10GiB JSONL (Raw, Rows), warm cache | < 50ms | < 100ms |
| Lens switch to a ready lens (+ the 90ms fade) | < 25ms | < 50ms |
| Scrolling, any lens, during indexing, including far jumps that replace the window, with accessibility mode on or off [Z52] | ≥ 99% of frames < 16.7ms, no stall > 50ms | same |
| Viewport page fetch, 64KiB, round trip | p95 < 3ms | p95 < 3ms |
| Index throughput, JSONL line index | ≥ 1 GB/s warm | ≥ 0.5 GB/s |
| Index throughput, CSV record index (whole path; p50 of 30 warm release runs on the 100MiB and 1GiB CSV fixtures) [Z46] | ≥ 0.9 GB/s warm | ≥ 0.45 GB/s |
| Rendered on a 1GiB Markdown file (background index; Raw is immediate) | ~20s, informational [Z30] | informational |

- **"First screen" in Raw** is the first bounded piece visible and usable, with continuation available while scanning proceeds [Z37]. On a file whose first line is huge, it doesn't wait for the line's end. Full-line scan completion is measured and reported separately.
- **"Cold":** the first launch after an OS restart (n=5). Shell visible is measured with an existing profile, on an unlocked, displayed session [Z67].
- **"Warm":** n=30, reporting p50 and p95.
- **Memory:** OS-appropriate metrics are reported separately (private bytes, RSS, PSS) and summed across all processes.

### 10.3 Measurement
- **Performance marks** in the renderer and core (`open`, `firstPage`, `firstPaint`), collected by the Playwright perf harness in `e2e/perf`.
- **Frame timing:** from Chromium tracing during scripted scrolls.
- **Regression gate:** the harness runs on Zack's PC before each milestone closes. CI only runs a smoke version, because CI machines are too noisy to gate on.
- **Qualification runs** [Z49]:
  - Run on a quiet machine: no other heavy work or agent lanes, the CPU under 10% for a minute before each timing run, load recorded during it, and Defender on. The session is unlocked and displayed [Z67].
  - Automated warm runs, the cold-restart batch and manual checks are separate batches.
  - Every failed or invalid run is kept with its reason, never replaced by a clean rerun in the report.

---

## 11. Testing and CI

### 11.1 Test layers
| Layer | What |
|---|---|
| **Core unit + property** (`cargo test`, `proptest`) | **Span fidelity:** every span extracts exactly its original bytes across BOM, CRLF, non-ASCII, verbatim numbers, YAML trivia and quoted multi-line CSV. **Byte maps** across UTF-8, malformed UTF-8, Windows-1252, UTF-16LE/BE and Markdown entities and escapes. **Chunk verification** under injected writes. Byte-bounded checkpoints, and >4GiB offsets via sparse files. |
| **Core fuzz** (`cargo-fuzz`) | Every parser and the sanitizer, with corpora from `core/fixtures/hostile` |
| **Renderer unit** (`vitest`) | The store, the virtualizer math (logical scrolling, anchors), and lens controllers against a fake `DocHandle` |
| **E2E** (Playwright for Electron) | Open, lenses, links and peek, find, copy, print-to-PDF, session restore, single instance. The **network check:** the NetLog assertion (§7.3) after the hostile fixtures. |
| **Accessibility** | axe on the chrome (automated), plus the manual 20-task script (§6.3) |
| **Performance** | §10.3 |

### 11.2 CI (GitHub Actions)
- **Every push:** a matrix of `windows-latest`, `macos-latest` and `ubuntu-latest`, running `cargo fmt`, `clippy` and `test`; npm `typecheck`, `lint` and `vitest`; and a Playwright smoke run including the network check.
  - **While the repo is private** [Z60, Z61]: Windows and Linux run on every PR; macOS runs weekly on `main` (Mondays 06:00 UTC) plus `workflow_dispatch` [PR #16, Z65] (PR runs narrowed to a smoke e2e by Z85), all within the free included minutes. The full matrix on every push applies once the repo is public.
- **Tags:** the same, plus signed installers built and attached to a draft GitHub Release (§12).

---

## 12. Packaging and release

### 12.1 Artifacts
| OS | Artifacts | Signing |
|---|---|---|
| Windows x64 | NSIS installer + MSI (winget accepts both) | Azure Trusted Signing (~$10/mo) |
| macOS universal (arm64 + x64) | DMG | Developer ID + notarization (Apple Developer, $99/yr) |
| Linux x64 | AppImage, deb, Flatpak (Flathub manifest on `org.electronjs.Electron2.BaseApp`) | — |

- **The napi-rs addon is prebuilt per target** and packed outside the asar archive.
- **Homebrew cask:** needs a notarized app, plus the repo-age and popularity thresholds Homebrew sets, so it may land after launch day.

### 12.2 Out of v1
- Windows on ARM.
- The Microsoft Store and Mac App Store.
- Snap.

### 12.3 Release policy
- Track Electron stable and ship **within one major of current**.
- A Chromium security fix that affects the renderer triggers a patch release.
- There's no updater [Z24], so the About dialog shows the version plus a "Check releases" link (user-initiated) 🔒.

### 12.4 Repository hygiene
- `LICENSE-MIT` + `LICENSE-APACHE` [Z27].
- `CONTRIBUTING.md` (DCO sign-off).
- `TRADEMARK.md`.
- Third-party notices generated at build time. Fonts are OFL; Mermaid, KaTeX, Shiki and DOMPurify are MIT/Apache; Electron is MIT, plus the Chromium notices.

---

## 13. Delivery

### 13.1 Phase 0: spikes (throwaway, on `spike/*` branches, never merged)
Each spike answers one risk with numeric gates. A failed gate changes this spec before any product code is written. Thresholds are on Zack's PC (half budgets) unless marked **Mac**.

**Checkpoint held 2026-10-22: a conditional go to M1 [Z53]. Phase 0 is not qualified.** Step 1 is done. Step 2 ends with plans B and C frozen, not closed, without a further review round. Step 3's preservation is done for snapshot 1, and snapshot 2 follows plan B's last replay. Step 3's qualification runs move to the product milestones. Every gate below that hasn't been measured under Z49 stays failed, pending or parked, with its disposition in the M1 plan.

Sequence [Z38, amended by Z39 and Z53]:
1. Record the Phase 0 decisions in the specs.
2. Finish folding and reviewing the Spike B and C plans against them.
3. Preserve the validated spike code [Z41], and run the missing full-size performance gates under the qualification protocol [Z49]. That includes the Mac gates [Z50]. The real screen-reader gates are parked until after launch [Z39].
4. Hold the Phase 0 checkpoint before M1.

**Spike A: cold start, indexing, IPC, memory, Windows chrome**
- **Build:**
  - an Electron shell on `typose://` with code cache;
  - a core host with a napi-rs `memchr` + `rayon` line indexer;
  - a `MessageChannelMain` port to a renderer;
  - a minimal Raw and Rows viewport on the virtualizer, including logical scrolling past 16M px (§5.3).
- **Fixtures:**
  - a 100MB CSV;
  - 1GiB and 10GiB JSONL (~200B/line; the 10GiB file is about 50M lines);
  - a JSONL whose 200MB first record is followed by small records;
  - a 5,000-column CSV.
- **Gates:**
  - shell visible (cold) < 200ms PC / < 400ms **Mac**;
  - first screen of Raw/Rows on the 1GiB and 10GiB files < 50ms warm and < 150ms cold, without scanning to end of file. In Raw, "first screen" is the first bounded piece visible and usable [Z37];
  - **oversized first record:**
    - the record's first piece is visible and usable within the first-screen gate, and the small records after it follow as the scan passes the record;
    - full-line scan completion is measured separately [Z37];
    - no mounted item exceeds 64KiB of text (§3.4, §14 D13);
  - **incremental reading deep in a huge file:**
    - in the 10GiB Raw lens at line 40M, 10 wheel notches move the same distance as at line 0 (±1 line);
    - PageDown moves exactly one viewport;
    - continuous trackpad scrolling on the **Mac** never moves more than one viewport between frames;
  - index ≥ 1 GB/s warm on NTFS **with Defender on**;
  - input latency < 50ms throughout indexing;
  - 64KiB page fetch p95 < 3ms;
  - ≥ 99% of frames < 16.7ms while scrolling during indexing;
  - total resident memory < 1GiB on the 1GiB fixture, and within the aggregate budget on 10GiB;
  - **Snap Layouts flyout** appears over the WCO maximize button;
  - the NetLog assertion (§7.3) passes after 5 minutes idle, with a Markdown file open that contains remote images nobody clicked.

**Spike B: accessible virtualization**
- **Build:**
  - a 1M×20 CSV grid (36M px tall, so in logical scrolling);
  - a 50M-row JSONL treegrid;
  - a 20,000-block Markdown document with the Outline and long heading-free stretches;
  - a 5,000-turn Transcript feed;
  - React Aria tabs and a peek.

  Both document fixtures are at least 10× the 500-item accessibility window, so reading has to cross unmounted content.
- **Gates:**
  - **Before launch, these are automated: the accessibility tree, axe, keyboard, focus and accessibility mode, with no screen reader running [Z39].** The real-reader items below (the 20-task script, announcements, and heading jumps through a reader's own heading key) are parked until after launch. They stay listed as the expansion's gate.
  - *Parked [Z39]:* 100% completion of the 20-task script, with the full 2,000-block reading test on NVDA, Narrator and VoiceOver [Z35, superseded];
  - row and column position announced with totals (*announcement parked*; the `aria-*` totals are gated automatically);
  - Ctrl+End reaches the true last row;
  - zero skipped or duplicated positions across 1,000 rows × 100 columns;
  - 2,000 consecutive blocks or turns read **forward and backward**, crossing at least 4 window recenters each way, with the element under the cursor never unmounted and no position lost (*gated by a simulated reading cursor; a real reader's reading is parked [Z39]*);
  - heading jumps, both through the Outline and through the screen reader's heading key, land on headings **outside** the mounted window (*a real reader's heading key is parked [Z39]; the Outline and a simulated heading key are gated automatically*);
  - 100 peek open/close cycles with zero focus loss;
  - nothing unreachable at 200% zoom;
  - with accessibility on, ≤ 1% long frames during 10s of auto-scroll;
  - with accessibility on from launch, no stall > 50ms on a far jump (a scrollbar jump, an Outline jump, open-then-scroll) [Z52]. This fails today at 55–188ms, a Phase 0 finding. With accessibility off, open-then-scroll measured up to 73ms and isn't asserted by the spike.

**Spike C: lossless source model, hostile input, non-locking handles**
- **Build:**
  - the byte store with generations;
  - the JSON/JSONC structural scanner (benchmarked against `jiter` and `struson`);
  - the CSV record index;
  - YAML in a worker with byte mapping;
  - `pulldown-cmark` blocks with `ammonia`.
- **Gates:**
  - zero span mismatches across ≥ 10,000 generated cases;
  - **byte maps:** zero selection-endpoint mismatches across UTF-8, malformed UTF-8, Windows-1252 and UTF-16LE/BE, including Markdown entities and escapes;
  - correct offsets beyond 4GiB;
  - 1,000 append/truncate/rename/delete cycles on Windows with zero blocked operations, zero crashes and zero stale-span copies accepted;
  - **mutation race:** an in-place, same-size write injected between the metadata check and the read is caught by chunk verification in 1,000 of 1,000 runs;
  - **oversized blocks:** a 5MB code fence followed by a one-line paragraph renders the paragraph within the first-screen gate, and no mounted item exceeds 64KiB of text;
  - hostile inputs cancel within 50ms while Raw keeps its first-screen gate;
  - hostile Markdown, Mermaid and KaTeX fixtures produce zero network requests, process launches or file accesses;
  - **outputs:** the YAML worker's parse throughput (which set `yaml.treeMaxBytes` to 8MiB [Z36]) and the scanner decision.

### 13.2 Milestones (each one is a sequence of PRs; the implementation plan details M1 first)

**Implementation closeout [Z65]:** record M1's remaining gaps and continue to the first formatted lens. This does not establish qualification: Z58's Mac acceptance and Z59's cold-startup requirements still apply. Pending gates remain pending; failures remain failures.

| # | Milestone | Exit criterion |
|---|---|---|
| M1 | **Walking skeleton.** Repo, CI, security baseline (§7), core host + protocol, byte store and generations, the Raw lens on the virtualizer, title bars on Windows and macOS, single instance and CLI. | Open a 10GiB file into Raw within the §10.2 budgets, on an unsigned dev build (signing starts at M7, §15). Z34's aggregate accounting and enforcement, with a deterministic multi-document budget-exhaustion test [Z47]. Cold startup measured on the M1 app and within its targets [Z54, Z59, Z67]. No corresponding unexplained exit in the M1 baseline [Z56]. M1 stays open while Mac acceptance is pending [Z58] |
| M2 | **Workspace.** Sidebar roots, pills, cards and splits, session restore, quick open, the command palette and command table, settings + `config.toml` + themes, the empty state. | Brief §3, §4.1–4.3, §7.8 and §7.10, verified against the canvas boards |
| M3 | **Data lenses.** Grid, Rows, Table, JSON and YAML Tree, ⓘ and problems. | Brief §5.3–5.5 and §7.6–7.7; the Spike C gates as regression tests; the Grid's Shift+Space/Ctrl+Space selection [Z40], Rows' Shift+Space selection [Z51] and the "First row is header" override [Z48] |
| M4 | **Markdown and links.** Rendered Markdown first [Z68], as an end-to-end slice before M2 and M4's first part; then callouts, Mermaid, KaTeX and Shiki, link resolution, the peek, hand-off. | Brief §4.4–4.6 and §5.2; the hostile-fixture network check; `data:` images within their caps, with refusals and zero network effects [Z43] |
| M5 | **Transcript.** Both adapters, sidechains and branches. | Brief §5.4 against real Claude Code sessions |
| M6 | **Find, go to, copy, print.** | Brief §7.4, §7.5 and §7.11 |
| M7 | **Release.** Large-file UX polish, the full accessibility gate, packaging and signing, winget/Flathub submissions. | Every §10.2 gate and §6.3's automated accessibility gates green on Windows and the Mac; Linux smoke-tested [Z28]. Screen-reader validation is parked until after launch [Z39] |

---

## 14. Proposed brief revision 4
Each item below changes the brief and needs Zack's acceptance. "Both" means both research reports raised it independently.

| # | Brief § | Change | Why |
|---|---|---|---|
| D1 | §8.1 | "First screen < 100ms in every lens for files ≤ 100MB" applies to a **named fixture set** (normal records up to 100MB per format) and to **ready** lenses. There's one file-backed architecture for all sizes. Markdown may render **provisionally** and reconcile in place, with the anchor kept. | Both. A single 100MB record, deep nesting or a huge diagram can't meet a universal guarantee, and Markdown reference definitions can sit at end of file. |
| D2 | §8.1, §13 Q1 | Replace "cold start < 400ms to the restored session" with **shell visible < 400ms** and **first restored lens content < 1s**, gated per Z29. | Both. No published measurement reaches the original on any stack. |
| D3 | §8.1 | The < 50ms lens switch applies to a **ready** lens. Switching to a lens that isn't ready yet shows the progress line at once. | Both. An index can't be built in 50ms. |
| D4 | §8.3 | The 25% memory budget is **aggregate**, across all open documents and every resident structure. | Both. 25% per tab isn't a budget. |
| D5 | §9, §8.1 | "Document semantics for virtualized content" means **full navigability**: an accessibility mode with a wide render window that follows the reader, the always-present Outline, and focus that loads its target first. Beyond the engine's height cap, scrolling is logical: wheel, trackpad and keys move 1:1, and the scrollbar positions coarsely. | Both reports; the logical scrolling comes from Astra's review. No engine can expose DOM that doesn't exist, and proportional scaling amplifies scrolling about 75×. |
| D6 | §7.9 | Change detection adds file identity and **content verification**: per-chunk hashes, with any mismatch freezing the document. Spans carry a generation, and copy is refused after a freeze. **No memory-mapping.** | Both reports, plus Astra's review. Non-locking handles and immutable spans conflict, and metadata checks alone miss in-place writes. mmap blocks delete on Windows and can crash on truncation elsewhere. |
| D7 | §4.6 | Mermaid runs at `securityLevel: 'sandbox'` (an iframe) instead of `strict`. | Fable. Strict still renders in the app's DOM; a read-only viewer loses nothing in sandbox mode. |
| D8 | §12, §4.6 | "No network by default" becomes "**Typose issues no requests** unless the user clicks to load remote images", enforced by the CI NetLog assertion (§7.3). OS-level actors are out of scope. | Both. |
| D9 | §7.11 | Print works on a **range chosen before the print document is built**, with a page estimate and a job cap (1,000 pages, proposed). "All" is offered only when the file fits. It is rendered in batches as a separate print document. | Both reports, plus Astra's review. Nobody finishes printing a 50M-row file, and batching alone doesn't bound the document. |
| D10 | §3.1 | The title bar is 40 **logical** px; native metrics apply in the native-frame fallback. | Astra. |
| D11 | §5.5, §8.2 | YAML Tree has a **size ceiling** (`yaml.treeMaxBytes`, from Spike C). Above it, Tree is locked with the reason shown. This replaces "unlocks after indexing" for YAML over 100MB. | Both. No YAML parser in either ecosystem is incremental or file-backed. |
| D12 | §2, Z7 | Linux ships in v1 as **best effort** [Z28]. | Zack. |
| D13 | §5.4 | A Rows record over 1MB shows its first 1MB (in bounded pieces), then "+N MB more · Copy record", like Raw's long-line rule. | Astra. Rows can't always show the full record immediately. |
| D14 | §5.3 | Column auto-fit **refines** as the background scan proceeds. The first screen uses estimates from the visible rows, and the reading anchor is kept. | Both. |
| D15 | §2 | Single instance is per user session. A different-user or elevated "Open with" doesn't reach the running window; this is documented. | Fable. |
| D16 | §7.9, §5.3 | Encoding detection comes **before** the binary test. A UTF-16 BOM skips the NUL test. BOM-less UTF-16 is detected as binary, and ⓘ can override it. | Astra's review. The NUL test as written rejects every UTF-16 file. |
| D17 | §5.2, §5.4 | Rendered items are bounded: a Markdown block over 64KiB renders as split sub-blocks, or as its source in a bounded Raw view when it can't be split sensibly (with a note). | Astra's review. Virtualizing between blocks still mounts a multi-megabyte block whole. |

---

## 15. Open questions
1. **Repository:** answered. It's `github.com/zackmeach/typose`, private until launch [Z60].
2. **Signing spend:** Z61 rules out paid signing before launch. Open: how the launch builds are signed. Options:
   - unsigned launch builds, with Windows SmartScreen and macOS Gatekeeper warnings, and no Homebrew cask until notarized;
   - a free open-source signing route for Windows (e.g. SignPath Foundation's program, which requires a public repository);
   - launch after the subscriptions start, once Typose is proven working.

   Decide before M7.
3. **Minimum OS versions:** proposed to be Electron's own floor at release time.
4. **Crash reports:** local minidumps only, plus "Report an issue", which opens a prefilled GitHub issue in the browser at the user's click. Is that enough for v1?

---

## 16. Review log

### 16.1 Astra, review of Draft 1 (2026-10-20)
Verdict: keep the architecture, and revise the foundational contracts. Each finding was re-checked against the Draft 1 text before it was accepted.

| # | Severity | Finding | Verified | Resolution |
|---|---|---|---|---|
| R1 | P1 | Selections were mapped back to bytes with `TextEncoder`, which only encodes UTF-8, so offsets are wrong for Windows-1252, UTF-16 and malformed UTF-8. The NUL test also rejects UTF-16 files. | Yes. In Windows-1252 `€X`, `X` is at byte 1, but UTF-8 re-encoding says 3. | Byte maps produced by the core (§3.2, §4.6); encoding detection before the binary test (§4.1, D16); Spike C gate |
| R2 | P1 | Generations don't guarantee copy consistency, because a write can land between the metadata check and the read. | Yes. The check-then-read race is real, and a handle doesn't stop in-place writes. | File identity plus per-chunk content verification; copy is refused after a freeze (§3.1, D6); Spike C mutation-race gate |
| R3 | P1 | Proportional scroll scaling makes huge files unreadable: about 75× amplification at 50M × 24px over 16M px. | Yes: 1.2B px ÷ 16M px = 75, so one 120px notch is about 375 rows. | Logical scrolling above the cap (§5.3, D5); Spike A deep-reading gate |
| R4 | P1 | Bounded pages don't bound rendering units. One Markdown block or Rows record can be megabytes, and checkpoints every 1,024 units don't bound rescans. | Yes | A 64KiB cap per item with continuations (§3.4); sub-blocks or a Raw fallback (§4.6, D17); byte-bounded checkpoints (§3.5); gates in Spike A and C |
| R5 | P2 | The accessibility spike's 500-turn fixture equals the 500-turn window, so it never crosses unmounted content. The window continuation was also unspecified. | Yes | Fixtures at 10× the window, a recentering window plus edge controls (§6.2), and forward/backward and out-of-window heading gates (Spike B) |
| R6 | P2 | Print batching doesn't bound the final print document. | Yes | A range chosen before construction, plus a 1,000-page job cap (§8.5, D9). Settle before M6. |
| R7 | minor | "Empty NetLog" isn't a valid assertion, because NetLog always records metadata. | Yes | A defined NetLog assertion: no non-app-scheme requests, DNS resolutions or socket connections (§7.3) |

Not reopened, matching the review's own weighting: Electron + Rust, React chrome over direct-DOM lenses, no updater, and Linux best effort.
