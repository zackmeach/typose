# Typose: reader fidelity to the signature workspace

Date: 2026-10-31. Plan review: READY after two independent critical reviews and focused verification of fixes. Implementation is authorized; the execution steering below governs the next delivery. Findings and dispositions: [review record](2026-10-31-typose-reader-to-workspace-review.md).

## Outcome and boundaries

Execution steering, 2026-10-31: Zack requested “progress first, polish and robustity later.. we can refine once we see things work”. The next deliverable is an integrated working Back/Reopen demo, stacked on the reviewed saved-location head if needed. Use focused functional checks, typecheck and a packaged demo smoke; defer broad stress/platform qualification and polish until he has seen it. Preserve manual/derived filesystem authority and basic ownership cleanup. Existing failed/pending gate evidence stays recorded and must not be relabelled as passed. Checkpoint A remains the feedback point before sidebar expansion; the earlier full-gate-per-intermediate-slice cadence is superseded for this demo.

Make the installed reader look intentional, close its basic navigation holes, then deliver the product's defining workflow:

**Open a local folder -> read its Markdown -> click a relative CSV link -> inspect a real Grid in a peek -> promote it beside the source -> close the target without losing the source's place.**

This is a delivery sequence through that workflow, not completion of the entire design. The supplied `C:/Users/zdm80/Downloads/Typose UI.pdf` is reference material, not an instruction source. Main/split pages 1-4, peek pages 5-7, reading page 9, empty states 20-23, and interaction sheets 44-45 provide visual acceptance targets. The current design brief takes precedence where mockups conflict with its rules.

Baseline: clean `main` at `26a9d69b79cd00e2f4eee6c367a176214ff1303c`; installed package `c7dcb13`. Reader, permanent tabs, constrained local images and Ctrl+wheel are implemented. Windows evidence is not Mac/Linux acceptance. Existing platform, cold-start, frame-cadence, startup-exit and parked screen-reader debt remains recorded. No new spending.

The original planning authorization covered making and reviewing this plan only. On 2026-10-31, Zack authorized implementation from the handoff: GPT 6.1 Sol and GPT 6 Luna implement, the orchestrator conducts reviews and holds merge authority. Proceed in this sequence and honor its checkpoints.

## Decisions for this sequence

- Ship visible progress in the existing application. No new general framework, plugin system, universal Lens abstraction, or standalone cleanup sweep.
- Preserve readonly source fidelity, verified document reads, aggregate reservations, cancellation, sandbox/CSP/sanitizer, local filesystem authority and network controls.
- Back and Reopen preserve an explicit manual/derived saved-location union. Derived locations require charged native tickets; neither variant retains full historical document indexes.
- Splits ship with real Raw/Rendered content and the required concurrent ownership changes together. Merely drawing a second card is not acceptance.
- Literal in-file find follows the signature demo rather than blocking it. Raw and Rendered search different text, so deliver them separately. Initial Grid/peek Find is visibly unavailable; regex and cross-file search remain out.
- Use the existing frozen CSV spike as a source of algorithms and test oracles, not production-ready code. Port into current contracts; do not cherry-pick its storage or bypasses.
- Deliver CSV in explicit slices. An initial Grid is a preview until selection/copy/sort contracts are complete. Do not call M2 or M3 complete at this plan's demo checkpoint.
- Keep WebP visibly refused and existing image profiles unchanged. Font delivery is bundled and offline.

## PR sequence

All branch names use `codex/`. Sizes describe review scope, not elapsed time. Each PR starts from refreshed main after its dependency merges. The two later search PRs are deliberately outside the signature demo dependency chain. One implementer owns each PR; separate reviewers challenge it. No simultaneous changes to shared runtime files. Sidebar, splits, CSV and peek are provisional decent-sized slices; if a detailed implementation diff is large, split at the stated behavior/ownership boundary before dispatch. Do not disguise a large change with a size label.

### 1. Reader visual fidelity — small — `codex/reader-fidelity`

Own renderer styles, bundled font assets/licenses, and the existing card header.

- Bundle Inter and JetBrains Mono with provenance/licenses. Use UI 13px, reading 16px/1.6, prose-code mono 13px/1.55; H1 30/1.2, H2 22, H3 18. Raw keeps its shared integer 20px row geometry (13px font), including virtualizer/cache math. Keep the 70ch measure.
- Match card/pill geometry, 16px single-card edge margins, paragraph/list/heading spacing and filled code blocks. Use real format icons; replace the placeholder title glyph.
- Replace filename-only header with `parent / filename` breadcrumb and full-path tooltip; preserve filename at narrow sizes and keep lens controls reachable. Put existing line/encoding status in its state slot. Open file remains available through the menu and empty state.
- No inert info, Outline or settings controls. CSV info UI arrives in PR7; unrelated future info fields remain deferred.

Acceptance: compare the same launch-plan content with PDF page1 and the brief at 1280x800 and 1440x900; check 720px width, 50/100/200% zoom, long paths, Raw and Rendered, keyboard focus, reduced motion and accessibility mode. Inspect actual packaged screenshots. No clipping or scroll-anchor regression after font load. Network denial and packaged offline font loading remain proven.

**Visual checkpoint:** install the tested fidelity package immediately after PR1. Compare the same document with the reference at normal zoom before extending the workspace.

### 2. Back after local navigation — decent — `codex/navigation-back`

Own saved-location core/napi/protocol, host validation, workspace history and visible Back control.

- Capture saved locations only from owned documents, with origin determined by host/native document metadata, never an elevatable caller flag. The union is `manual { path, anchor, lens }` versus `derived { session-bound ticket, anchor, lens }`. Manual metadata is charged; a derived ticket retains a charged `LocalRoute` clone. No HTML, Blobs, pages or old document index.
- Explicit Back/Reopen of a manual entry uses existing manual-open policy, including all existing refusal checks. This covers TXT/CSV, Markdown whose optional route capture failed, and manual opens on other platforms. A derived entry opens through its saved native route, never manual `open(displayPath)`. Preserve origin through tab moves, close history and peek promotion. Tickets cannot be serialized as durable authority.
- Successful replacement alone pushes Back history. Failed/cancelled open or Back leaves current content and the recoverable history entry unchanged. Reopening shows current verified bytes, not a historical snapshot; anchor is clamped if the file changed.
- History has no silent count cap or eviction. Every entry is precharged. If a new entry cannot be paid, refuse that navigation visibly and preserve source. Discarding a tab releases its Back history. Core restart invalidates derived tickets and offers manual reselection; manual entries remain explicitly reopenable under manual-open policy. There is no derived-to-manual fallback.

Acceptance: manual TXT/CSV, optional-route-failure Markdown, manual platform fallback, derived TXT and duplicate manual/derived paths; A->B->C->Back->B->Back->A retains lens/place; missing/replaced/junction targets, budget refusal, rapid navigation, late completion, tab close and core restart cannot redirect authority or publish stale state. History discard/window close releases tickets and native handles. Existing document close still releases indexes and cancels jobs.

### 3. Reopen closed tab — small after PR2 — `codex/reopen-tab`

Reuse saved locations; add menu action and Ctrl+Shift+T. Keep session-only LIFO closed-tab records with destination/order, anchor/lens and origin policy; reopening does not restore an entire discarded Back history.

- Save before close when the history reservation is available. Closing itself always succeeds; if history cannot be retained, report that this tab cannot be reopened. No hidden retention of full documents.
- A failed reopen preserves the entry and current tab. Manual duplicate paths focus the existing manual tab; a capability-derived location is never merged solely by display-path equality.
- Closing the last tab releases documents/indexes/lenses. Closed-location metadata and route tickets remain separately charged until consumed, cleared or window close. Add a visible Clear recently closed tabs action. Reopen a derived ticket after core loss requires manual reselection.

Acceptance: selected/background/last-tab closes, repeated LIFO reopen, duplicate names, missing file, refusal, restart and old replies; exact document-vs-history ledger/handle ownership. Preserve existing cleanup assertions by distinguishing live documents from intentionally retained saved locations, then prove clear/window close returns both to baseline.

**Checkpoint A:** after PR3, demonstrate the restyled reader, local-link Back and Reopen closed tab in the installed package. Gather feedback before workspace expansion; do not wait for Find to deliver this checkpoint.

### 4. Folder sidebar — decent — `codex/folder-sidebar`

Own native directory capability/listing, root protocol/metadata, sidebar and root-aware breadcrumbs/link base.

- Explicit Add folder/Open folder, lazy expansion and bounded paged listings. Refresh on expand, visible Refresh, Ctrl+R and window focus for expanded folders only; no watcher or recursive quick-open index.
- Enumerate and open children through held native directory authority. Reject network namespaces before access; never use a checked display path as a later `read_dir(path)` fallback. Do not follow junctions/symlinks/reparse points. Renderer receives labels/opaque child identities, not filesystem authority.
- Multiple roots, duplicate names, missing-root Locate/Remove, hidden-entry default and supported/unsupported file states. Unsupported files remain visibly refused until their hand-off sheet ships; no automatic launch.
- Roots affect breadcrumb membership and leading-`/` resolution together. Root removal must not broaden any document's authority. No recursive scanning on add.
- Match 240px default, 180-420 resize, collapse control and Ctrl+B; below 1000px auto-collapse with overlay reopening. No content stacking.

Acceptance: huge directories page within paid bounds; expand/collapse/refresh and stale root replies; root disappears or is replaced during enumeration; hidden files; junction/network traps; no unintended filesystem or network access. Opening a file uses the currently focused card and preserves existing manual/derived identity policies.

### 5. Real split cards — decent — `codex/split-cards`

Own card grouping/focus, App decomposition needed by this feature, per-surface host activation and additive reservations. Ship existing Raw and Rendered side by side.

- Each card has its own selected tab, anchor and lens; window has one focused surface for commands. Generalize only these current ownership assumptions, not all future lenses.
- Visible surfaces and pending/retired views are charged additively. Activating the right card must not deactivate/cancel the left. Same file may appear in separate cards: use independent native document identities initially, with aggregate accounting; do not share a destructive document owner between controllers.
- Split right, menu access, resize divider and double-click equalize. Cards remain one row, minimum 320px; insufficient space opens a tab with the notice. Shrinking the window scrolls the row horizontally, never wraps.
- Tab close, move and card close release exactly their owners. No drag-reorder implementation in this slice; tab moves needed by Open to side are explicit commands.

Acceptance: two simultaneously live Raw/Rendered documents, long documents and loaded images; both react to Reload correctly; focused commands; same-path two-card case; close either card mid-activation; core restart and delayed reservations; low-budget split refusal leaves source unchanged. Memory proof covers both visible DOMs plus actual overlap. Source anchor stays stable through resize/zoom.

### 6. Production CSV core — decent — `codex/csv-core`

Own native CSV scanner/checkpoints, bounded pages/field spans, napi/protocol and host validation. This is the one deliberate backend dependency PR, followed immediately by Grid work; no unrelated parser expansion.

- Reuse pinned spike algorithms/oracles after inspecting every transplanted function. Replace direct ByteStore reads and uncharged storage with current verified Document, reservation, cancellation and generation contracts.
- Resolve the pinned tokenizer's checkpoint-copy safety explicitly. No copied unsafe workaround without a pinned-source proof and regression coverage. Avoid record-start rescans for far fields in huge quoted records.
- Preserve original spans/record numbers, CSV delimiters, deterministic quoted TSV, header sniff/override semantics, ragged rows, BOM and UTF-16 Raw-only rule. Implement native first-1,000-row inference/pill/width metadata and reversible encoding/delimiter/header override groundwork here. Values remain verbatim decoded cell values; inference never reformats them.
- Bound serialized wire bytes, UTF-16 units, cells and maps, not only source/unescaped bytes. Huge fields use resumable bounded pieces and source locators. Raw remains immediately usable while indexing.
- Extend format metadata for CSV/TSV; do not yet expose local CSV links before Grid is usable.

Acceptance: source-span oracle; quote/newline/chunk boundaries; BOM/fallback/malformed encodings; giant single-record/far-field cases; 5,000 columns; cancellation and mid-scan mutation; low budget and allocation negative controls; record-index throughput measured against existing Z46, with misses retained rather than rounded into acceptance.

### 7. Readable CSV Grid — decent to large; boundary review required — `codex/csv-grid`

Own Grid controller, two-axis virtualization, metadata/info UI and manual CSV/TSV lens switching.

- Render real bounded pages, sticky column/row headers, stable source record numbers, horizontal/vertical scrolling and all-cell keyboard reachability. Keep focused cells mounted; separate source numbering from positional ARIA indices.
- Preserve raw values; widths/type icons/alignment/value pills use first 1,000-row rules. Header/delimiter/encoding overrides live in info; header toggle must recover the first data record. Ragged rows and parse problems remain visible.
- Indexing/locked/refused states are visible; UTF-16 stays Raw-only. Raw/Grid switches map record source lines, never assume one record equals one physical line.
- Find and sort/range selection/copy are explicitly unavailable in this preview; do not substitute browser viewport search. Whole-Grid find arrives in PR11 after shared search. Keep the rest of the Grid keyboard-reachable. If required, split presentation from overrides/pill polish before dispatch; every missing contract remains in qualification docs until completed.

Acceptance: PDF page1 CSV fixture in a real packaged card; quoted multiline records, headerless/ragged files, type-looking strings preserved, wide files and offscreen keyboard navigation; 50/100/200% zoom, 320px card, axes/sticky headers and screen-reader tree. This is still a Grid preview: whole-Grid find and sorting/range-copy completeness follow PR11 and must be labelled in qualification docs.

### 8. Link peek and promotion — decent — `codex/link-peek`

Own capability-backed CSV target support, peek surface, link gestures and promotion into existing tabs/cards.

- Plain local click opens the peek; Ctrl+click opens/focuses a tab; Shift+click reuses nearest right card, otherwise left, creating a split only from one card. Same-file heading links still scroll in place. External and refused schemes retain current controls.
- Peek reuses saved-location Back and the split reservation model. Find remains visibly unavailable until its lens supports it: Raw in PR9, Rendered in PR10, Grid in PR11. Later find commands target the focused peek. It has its own charged history; does not retain discarded full document indexes. Budget refusal preserves source and existing peek.
- Match clamped size, scrim, breadcrumb/lens/header actions, icon actions below 560px, Escape/close/scrim dismissal, focus containment and return to activating link.
- Open as tab/side transfers ownership without reopening display paths or momentarily losing the target's paid allowance. Duplicate manual paths cannot bypass a derived capability check. Expand the CSV allowlist only with this tested route.
- Ctrl+W closes an open peek before its source tab; Escape/close/scrim dismissal likewise preserve the source. Source remains mounted at its original position throughout. No web fetch/session, extra schemes, wikilinks or broad resolver rewrite.

Acceptance: exact signature workflow above; nested peek links/Back; duplicate/manual-derived targets; promote/close races and rapid clicks; same file already visible elsewhere; failed target and low memory leave source intact; focus/keyboard and no-network evidence. Explicitly admit or visibly refuse left source + right target + peek + retiring view, with loaded images and same-path variants. Promotion into an occupied destination must account for overlap before releasing/replacing it; close/refusal cannot free another surface. No new split below minimum width.

**Checkpoint B:** after PR8, demonstrate PDF pages 1 and 6 with actual folder contents and real linked CSV data. Install the tested package, then stop for user level-set. Find and full Grid interactions remain explicitly deferred; this is not full M2/M3 acceptance. PR9-11 follow that checkpoint feedback.

### 9. Whole-source Raw find — decent — `codex/raw-find`

Own native literal search, bounded hit transport and the Raw find bar. This PR ships usable Raw find, not an unused generic search service.

- Search verified decoded source in cancellable chunks, with query identity bound to session/document/generation. No whole-file JS string or all-hit array. Keep bounded hit windows, streamed counts and continuation locators; incomplete counts display `>= N...` until complete.
- Include UTF-8, UTF-16, fallback encoding, malformed substitutions and chunk boundaries. Define case-insensitive matching consistently without source-offset drift; preserve original byte locators.
- A hit carries enough byte/piece information to reach beyond Raw's initial long-line preview. Source line alone is insufficient. Search does not require full indexing to finish first.
- Find/next/previous/case/close have click paths plus Ctrl+F/F3/Shift+F3. While Rendered is selected in this intermediate PR, offer an explicit Find in Raw action; do not pretend to search Rendered.

Acceptance: offscreen and >1MiB-within-one-line hits, >100MB progressive counts, forward/backward/wrap, query replacement, mutation/freeze/Reload, close/core death, encoding boundaries, low-budget refusal and exact cleanup. Returning from find or closing the bar preserves focus and reading position as appropriate.

### 10. Whole-Rendered find — decent — `codex/rendered-find`

Own Markdown search projection, bounded range locators/highlights and shared focused-surface find UI.

- Search displayed text across the entire Rendered document, excluding app chrome and undisplayed Markdown syntax. Define cross-inline matches, block boundaries, entities, code, alt/refusal text and oversized-block notes in a fixture oracle.
- Extend core output with deterministic text projection and generation/block/text-range locators only as needed. Reuse existing parser/sanitized output; do not introduce a second HTML renderer or future whole-document copy mapping.
- Search identity includes a surface projection revision as well as session/document/generation/query. Image slots can change visible text without a document-generation change: keep bounded revisioned slot projections and invalidate stale count/range results when waiting text is replaced by a loaded image or refusal. Affected results are recomputed before a complete count is published; no stale range may address detached nodes. The current match is revalidated or visibly becomes unavailable.
- Bound and charge search state and highlight storage. Use DOM ranges/highlight APIs without modifying sanitized HTML or live link/image attributes. Navigate to an offscreen match before highlighting it.
- Commands target the focused card or peek when those arrive; query state belongs to a surface. Escape closes the bar and restores focus.

Acceptance: distant matches before a page has mounted, matches crossing inline tags/entities, headings/code/tables, no hidden syntax/chrome matches, many repeated matches, image waiting->loaded/refused transitions within one generation, low memory, query/lens/file changes and late results. Count completeness must be explicit; no viewport-only search advertised as whole-document find.

**Reader search checkpoint:** after PR10, demonstrate distant source and Rendered matches in the installed reader, including a live peek. Source-faithful copy, go-to and print remain outstanding M6 work.

### 11. Grid interaction completion — decent — `codex/grid-interactions`

After Checkpoint B and the search PRs: whole-Grid find over all decoded cell values, with sorted result navigation and bounded native hit state; stable source-number-preserving sort asc/desc/unsorted, cell/range/row/column selection, required Shift+Space/Ctrl+Space and keyboard-reachable alternatives, TSV copy with header for whole columns and bounded large-copy confirmation. Child controls and IME retain their keys. No source mutation.

Acceptance: full existing CSV brief contract matrix including sorted find/selection, quoted newlines, header override numbering, large fields, low budget and close/Reload/core restart. Native sort permutations and clipboard work are precharged/cancellable. This finishes this sequence's Grid interaction scope, not JSON/Rows/Tree M3 or whole-app M6.

## Review and merge gates

For this plan: two independent executed reviews, one product/sequencing and one security/memory/contracts. Reviewers open every referenced file and spend half their effort trying to break the design. Record findings, dispositions and any focused re-review in the adjacent review document. Planning reads source; it does not claim runtime validation.

For implementation: one independent review round normally; full memory/security review for PR2-11 where authority, native state or retained UI/search/copy ownership changes. Re-review only affected fixes. No ceremonial repeated broad audits or dependency upgrades.

Before installs/builds, inspect tracked/untracked state and require >= 20 GiB free. Preserve existing worktrees and unpublished work. Each final committed runtime PR head runs the established complete Windows gate: install, release addon build, fmt, both clippy configurations, Rust workspace and vendored JPEG tests including ledger/negative controls, lint, `check` (already includes typecheck), test-hooks, package, packaged visual and full E2E. Commands are the existing gate, not a new runner:

```powershell
npm ci --prefer-offline
cargo fmt --all --manifest-path core/Cargo.toml --check
npm run lint -- .github/scripts
cargo clippy --manifest-path core/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo clippy --manifest-path core/Cargo.toml --workspace --all-targets --locked --features typose-node/test-hooks -- -D warnings
cargo test --manifest-path core/Cargo.toml --workspace --locked
cargo test --manifest-path core/Cargo.toml --locked -p zune-jpeg --lib
npm run build:addon
npm run check
npm run test:hooks
npm run package
# Run the current maintained fused-package visual config, then:
npm run e2e
```

Capture native exit codes immediately; any reused wrapper must fail a deliberate failing-command probe. Read actual footers. If a command fails before tests start, preserve failure and retry only affected work on unchanged head/package; source changes require relevant checks and a fresh final-head gate. Record head, commands, counts, skips, screenshot inspection, hosted disposition and package identity. Billing-blocked hosted jobs are not passes; Z69 Windows merge basis and $0 cap remain. Mac/Linux acceptance and full performance qualification stay separate, visible debts.

Do not run these gates for this docs-only planning task. No runtime changes, commits, PRs, merges or installations are part of making/reviewing the plan.

## Deferred, still in the product vision

Session restore/recents, quick open, palette, tab drag/context actions; themes/settings/config and flush frame; full info fields; Outline, frontmatter properties, highlighting/callouts/Mermaid/KaTeX; JSON/JSONC/YAML/JSONL/Transcript lenses; advanced link resolution/wikilinks/hand-off and remote/data images; go-to, source-faithful whole-document copy and print; remaining platform/release qualification.

These are recorded deferrals, not scope deletions. This sequence does not promise the complete 45-page PDF. No settings framework, transcript adapter or general cleanup is a prerequisite for the signature demo.

## Grounding map

- Product promise and visual/input rules: `../specs/2026-10-20-typose-design-brief.md` Z2/Z10; sections3,4,5.3,6,7.2-7.5; PDF pages cited above.
- Milestone/authority/search/data contracts: `../specs/2026-10-20-typose-tech-design.md` Z31/Z40/Z42/Z45/Z48/Z61/Z65/Z69/Z73; sections3.4,4.2,5.4,8.2-8.3,13.2.
- Current visible scope/debt: `../../qualification/file-tabs.md`, `../../qualification/local-images.md`, `2026-10-24-typose-m1-close.md`, `2026-10-24-typose-rendered-markdown-slice.md`.
- Current implementation assumptions: `app/renderer/App.tsx:578-626,788-810,914-915`; `app/renderer/workspace.ts:16-42`; `app/renderer/workspace-budget.ts:6-14`; `app/core-host/dispatch.ts:75,100-166`; `app/shared/protocol.ts:66-80,91-141`; `core/typose-core/src/local.rs:64-69,117-128`; `core/typose-core/src/md.rs:75-90`; `app/renderer/lenses/raw.ts:47-53`; `app/renderer/style.css:18,337-342`. Repository-relative paths, baseline above; line numbers move after implementation.
- Frozen CSV reuse: `2026-10-20-typose-phase0-spike-c.md:1,142,183-184`; tag `phase0-snap2/spike-c`, file `spikes/core/spike-core/src/csv.rs`. Frozen FIX-FIRST evidence is not current product acceptance.
