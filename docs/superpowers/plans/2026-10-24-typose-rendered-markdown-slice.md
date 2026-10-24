# Typose · Rendered Markdown: the first slice

- **Date:** 2026-10-24 · **Base:** `main` = `2df0af7`.
- **Decided by:**
  - Z68: Rendered Markdown end to end, before M2.
  - Z65: lean process, "one review round per PR, except for security and memory".
  - This slice is M4's first part; M4's exit row (spec §13.2) is unchanged.
- **Goal:** Zack reads his own `.md` files in Typose. The yardstick is this repo's docs:
  - the largest is the Spike C plan, at 853 KB;
  - its largest block is a code fence of about 47 KB;
  - tables reach 13 KB.
- **Bottom line:** 3 PRs, every one security-relevant, so none gets the light review.
  - **Reading works when PR 2 merges.** Links and local images come with PR 3.
  - About 2,700 lines, more than half of them tests.
  - It's this small only because it ports Spike C's reviewed sanitizer and skips five over-built parts of the spec (§2.5).

The planner agent produced this plan read-only. The orchestrator saved it verbatim, then added the owner's answers in §4.

## 1. Scope

**In**
- **CommonMark + GFM through `pulldown-cmark`:**
  - headings, paragraphs, emphasis and strikethrough;
  - lists, read-only task lists and block quotes;
  - code blocks (no highlighting), tables and footnotes;
  - brief §4.6's raw-HTML allowlist, such as `<br>` in cells and `<details>`.
- **Front matter (Z44):**
  - at the file's start, closing within 64 KiB, it's shown as a code block;
  - anywhere else, it reads as ordinary Markdown;
  - it's never discarded.
- **A Rendered · Raw switch** in the card header: React Aria `Tabs`, so it's brief §9's tablist.
  - Markdown opens in Rendered (brief §5).
  - Switching keeps the reading position by source line.
- **Brief §7.9's file states for Markdown:** empty, binary, missing, permission denied, slow open, changed on disk, and Reload.
- **Links (PR 3):**
  - `#heading` links and footnotes scroll;
  - `http`, `https` and `mailto` open in the OS;
  - a relative link to a supported file opens it in the card (Q3).
- **Local images (PR 3):** PNG, JPEG, GIF and WebP from regular local files, within Z43's per-image caps.

**Out, deferred.** Every item is a deferral, not a drop.
- **M4:**
  - Mermaid and KaTeX (Z16, D7), Shiki (brief §5.2), and callouts (Z16). A GitHub `[!NOTE]` marker stays literal text.
  - The front-matter property grid (Z16), and wikilinks (Z22), which stay literal text.
  - The Outline pill and rail (Z20), and the always-present Outline (spec §6.2).
  - The peek, and Ctrl+click and Shift+click (Z10, brief §4.4–4.5).
  - The hand-off sheet, the executables rule, and the confirm sheet for other schemes (brief §4.6, spec §7.2).
  - Link resolution beyond the minimum: the case-insensitive fallback and its hover, `other.md#heading`, the dashed underline and its "Not found" hover, and `/` resolved against a root.
  - "Load remote images" and main's fetch session (brief §4.6, spec §7.3, D8).
  - `data:` images (Z43). Until then they're refused, with their alt text and the reason.
  - Oversized-block splitting (D17) and provisional rendering (D1).
  - Rendered above the ceiling, giant Markdown included: Z30, brief §8.2's Markdown row, spec §10.2's 1 GiB row.
  - Small gaps:
    - the code copy button (brief §5.2, §9);
    - table column alignment, because ammonia strips `style`;
    - GFM bare-URL autolinks, which pulldown-cmark may not parse (PR 1 confirms);
    - Z13's true two-lens cross-fade. The slice only fades the new lens in.
  - Spike C's Markdown gates (the 5 MB fence, cancel within 50 ms, ≤ 32 B per block) and `cargo-fuzz` of the parser and sanitizer (spec §11.1). PR 1's property tests stand in until then.
- **M6:**
  - Copy from the source range (brief §7.4), with Rendered's per-run byte maps (spec §3.2 🔒) and block byte spans (brief §2.1). The slice carries line ranges only.
  - Find, go to line and print in Rendered (brief §7.4–7.5, §7.11).
- **M2:** the lens per tab and its restore, the default lens in Settings (brief §5, spec §8.2), and Back after following a link.
- **M3:** ⓘ's word count and reading time for Markdown (brief §7.6).
- **M7:** qualifying Rendered's §10.2 rows under Z49, including Z52's far jumps with accessibility on. The slice records its numbers in PR descriptions and judges none (Z65).

## 2. Mechanism

### 2.1 Parsing in the core, as the spec decides
Spec §4.6 makes the choice: "**Parser:** `pulldown-cmark` in the core", and "Rendering stays in the core, so the renderer never parses Markdown and never sees unsanitized HTML." The slice keeps that and only simplifies how it's done.

- **One whole-file parse, up to the ceiling (Q1).** `render(doc, gen)`:
  - reads the file once through `Document::verified` (doc.rs:205-219), which checks the generation, the freeze and the file's identity, and verifies chunk hashes;
  - decodes it with `encoding::decode` (encoding.rs:55);
  - runs pulldown-cmark's offset iterator once.
- **Items:** each top-level block becomes an item `{block, line, lines, html, slug?, footnote?}`. Pages slice the stored items within §3.4's bounds (pages.rs:12-16).
- **Each block is built in three steps:**
  1. Raw `Html` and `InlineHtml` events go through Spike C's `escape_raw`. Allowlisted tags pass verbatim; everything else becomes literal text.
  2. pulldown-cmark's own `push_html` writes the block. It needs pulldown-cmark's `html` feature.
  3. The ported `sanitize` (ammonia) cleans the result.
- **Oversized blocks are never rendered.** That covers a block over 64 KiB of source, one nested deeper than 64 levels (Spike C's `MAX_DEPTH`), and one whose HTML passes 256 KiB.
  - Each becomes a note: "This block is over 64 KiB · Show in Raw at line N".
  - This is brief §5.2's own fallback ("its source in a bounded Raw view, with a note").
- **Memory (Z34 🔒):**
  - The parse's temporaries are reserved before it starts, with `Reservation::new` (budget.rs:91).
  - The stored items grow a `Reservation` block by block.
  - If the ledger refuses, the build ends with `Memory`. The card says why, and Raw stays.
  - Close and cancel drop everything (C6).
  - `tests/ledger.rs`'s counting allocator covers the build.
- **Cancellation:** the build runs as a napi task with C5's cancel flag. It checks the flag every 1,024 events.

### 2.2 Virtualization: native, inside the ceiling (Q2)
**Why not the existing virtualizer:**
- It only lays out fixed-height rows (virtual-list.ts:27, :198).
- The spec's measured layout, with the 500-block accessibility window (§5.3, §6.2), is the most expensive part of the spec's Rendered.
- Without the Outline, it would break brief §9 🔒: heading navigation must work under virtualization.

**What the slice does instead:**
- **It mounts every block** and lets Chromium skip offscreen work: `.md-block { content-visibility: auto; contain-intrinsic-size: auto <estimate> }`.
  - Skipped content stays in the accessibility tree, the tab order and native find.
  - PR 2 tests this rather than assuming it.
- **It's charged to the ledger:**
  - Before appending, the lens reserves `RENDERED_PER_UNIT × text units + 2 × HTML bytes` through the existing `reserve` call, with the same one-lens holder as Raw.
  - If the reservation is refused, Rendered is disabled with the memory reason, and Raw stays.
  - `RENDERED_PER_UNIT` comes from one measurement, by PR 6's method.
- **Line boxes stay short:** everything wraps (`pre-wrap` for code, `overflow-wrap: anywhere`).
- **Input never stalls:** the lens appends one page per frame, each at most 256 KiB of HTML, with at most 2 requests in flight (C5).

**Opening a Markdown file:**
- `open` still returns Raw's first page at once (Z37).
- The renderer calls `render` straight away, and mounts Rendered if it's ready within 50 ms.
- Otherwise it shows Raw with "Rendering…" and switches when Rendered is ready, unless the reader has moved (brief §8.2's rule).

**Freeze and Reload:**
- Rendered is built from one verified read and never reads the file again.
- A freeze that the index or Raw finds raises the banner, and Rendered keeps what it shows.
- Reload goes through the existing path, then calls `render(gen)`.

**Carried notes:**
- PR 7's "the page can forge the accessibility mode": the slice's Rendered never reads the mode, so the forgery stays harmless. The note carries to the first lens that reads it.
- Z66 (Raw wraps at 2,048 units, PR 6b): independent of this slice. The lens switch uses Raw's `atLine` and `topLine`, which PR 6b must keep working.

### 2.3 Sanitizer and CSP (🔒 brief §4.6, spec §7)
**Port it, don't rewrite it.** The source is Spike C's `sanitize.rs` at tag `phase0-snap2/spike-c` (`766e158`):
- the allowlists (:14-20);
- the ammonia builder (:22-48), with `svg` and `math` off and no generic attributes;
- `escape_raw` (:109), `target` and `image_target` (:195-218), and `sanitize` (:223-257);
- the spike's pins, `ammonia =4.2.4` and `pulldown-cmark =0.13.4`, after an advisory check;
- the spike's output oracle (`md_gates.rs:43`) and hostile-corpus writer (`md_gates.rs:965`), which become tests.

**One change from the spike: no URL from the file ever reaches a live attribute.**
- Every link becomes `<a href="#" data-href="…">`, and `javascript:`, `vbscript:` and `data:` targets are dropped.
- Every image becomes the spike's inert `<span class="tp-img" data-src data-alt>`.
- A delegated handler calls `preventDefault` on every link click, and main still denies navigation and new windows.

**Preconnect and dns-prefetch** (plan §7's carried requirement):
- The chosen mechanism is the sanitizer. `link` is off the allowlist, so a planted one renders as text.
- PR 2's positive control shows the NetLog would catch a `link` that got through.

**CSP:** unchanged. No `style` attribute or `style` element survives the sanitizer. Local images arrive as `blob:` URLs.

**Images:**
- Local images load (PR 3).
- Remote images show their alt text and "Remote image not loaded", and are never fetched (D8).
- `data:`, UNC and `smb:` images show their alt text and the reason.

### 2.4 Links
| Target | PR 2 | PR 3 |
|---|---|---|
| `#heading`, `#footnote` | Inert; the tooltip shows the target. | Scrolls to `[data-slug]` or `[data-fn]` and focuses it. Slugs follow GitHub's algorithm, for top-level headings. |
| `http`, `https`, `mailto` | Inert. | The core classifies the link. Main re-checks the scheme and calls `shell.openExternal`. |
| A relative path or a local `file:` URL | Inert. | The core resolves it against the file's folder. A regular file of a supported format opens in the card (Q3). Anything else shows "Not opened: \<path\>". A missing target shows "Not found: \<path\>". |
| A network path, or any other scheme | Inert. | Refused with a message, before any file system access. |

### 2.5 What the slice skips as over-built
1. The windowed prefix parse, provisional render and reconcile (§4.6, D1). One whole-file parse under the ceiling replaces them.
2. Splitting oversized blocks into sub-blocks (§4.6, D17). The bounded note replaces it.
3. The measured virtualizer and the accessibility window (§5.3, §6.2). `content-visibility` replaces them.
4. The mapped emitter with per-run byte maps (§3.2, for Rendered). `push_html` replaces it. Copy stays the browser's native copy until M6.
5. Three smaller pieces: the `Lens` interface (two concrete controllers until M3), the block-hash post-processing cache, and `open`'s `lenses[]` (a `format` field is enough).

## 3. PRs
**Sequencing:** Z65 says M1 closes first. PR 1 touches only new core files, so it can be built meanwhile. PR 2 stacks on PR 1's branch.

### PR 1 · Core: Markdown blocks and the sanitizer · decent · 🔒 security and memory, full review
**Scope:**
- `core/typose-core/src/md.rs` and `sanitize.rs`, plus the two dependencies.
- napi `Doc.render(gen, cancel)`, returning `{blocks, units, htmlBytes}`, and `Doc.mdPage(gen, start, count)`.
- Dispatch: a `render` method, and `page` with `lens: 'rendered'`, both under C4's checks.
- `Opened.format`, decided by the file's extension (spec §4.1).

**Acceptance:**
- **Rendering:**
  - Each In construct renders to its expected sanitized HTML.
  - Z44's front matter: shown at the start; ordinary Markdown at 64 KiB + 1 or mid-file.
  - `[!NOTE]`, `$x$` and `[[w]]` stay literal text.
- **The ported oracle passes** on Spike C's hostile corpus, and on a proptest that mixes Markdown with raw HTML:
  - tags and attributes stay within the allowlists;
  - no `link`, `meta`, `base`, `style`, `script`, `iframe`, `object`, `svg`, `math` or `img` element;
  - every `href` is `#`;
  - `sanitize` is idempotent.
- **Bounds:**
  - A 65 KiB paragraph, table or code fence, and 65-deep nesting, each give the note item.
  - No item exceeds 64 Ki units, and no page exceeds 256 KiB.
- **Ceiling and cancel:** the ceiling + 1 byte is refused with the reason. Closing mid-build ends the build and releases everything.
- **Ledger:**
  - `tests/ledger.rs` builds a mixed document at the ceiling. Live heap stays ≤ the charged total at every allocation, and returns to baseline after close.
  - A tight budget gives `Memory`, with nothing left charged.
- **Generations:** a frozen document's build is `Frozen`, and an old generation's is `Stale`.

**Size:** decent, about 1,000 lines, more than half of them tests.

### PR 2 · Renderer: the Rendered lens and the switch · decent · 🔒 security and memory, full review
**Scope:**
- `app/renderer/lenses/rendered.ts`, framework-free.
- App's card state gains `lens` and Rendered's status. The switch goes in the card header.
- `card.ts` gives the reasons Rendered is disabled: the ceiling, or the memory budget.
- CSS:
  - the 70ch reading column (brief §5.2);
  - filled code blocks (brief §3.5);
  - wrapping everywhere;
  - a 90 ms fade-in that respects reduced motion.
- The `RENDERED_PER_UNIT` constant.

**Acceptance (e2e):**
- **Rendering and the switch:**
  - A Markdown fixture opens in Rendered, with real `h1`–`h6`, lists, `table`/`th`/`td` and task boxes, inside `main`.
  - Switching Raw ↔ Rendered keeps the top line, within one block.
  - A non-Markdown file shows no switch.
- **File states:**
  - An empty Markdown file says "Empty file".
  - A file over the ceiling opens in Raw, with Rendered disabled and its reason in the tooltip.
  - Ctrl+R keeps the reader at the same block.
  - A write while reading raises the banner, and Rendered keeps showing.
  - With `TYPOSE_TEST_BUDGET` set low, Rendered is refused with the memory reason, and Raw stays.
- **Accessibility:**
  - axe finds 0 violations with Rendered shown, and at 200% zoom.
  - The switch is a tablist.
  - A CDP or UIA read finds every heading of a 2,000-heading file without scrolling.
- **Security:**
  - The test opens Spike C's corpus in Rendered, plus these planted cases:
    - `<link rel=preconnect>`, `<link rel=dns-prefetch>`, `<meta http-equiv=refresh>`, `<base>`, `<iframe>` and `<svg><image>`;
    - remote, UNC and `smb` images;
    - CSS `url()`.
  - It scrolls to the end, then pointer-downs and clicks every link.
  - A DOM sweep finds no forbidden element or attribute, and no `href` other than `#`.
  - The NetLog passes.
  - Control: inserting a `<link rel=preconnect>` with `evaluate` makes `checkNetLog` report DNS activity, so the test can fail.
- **Memory:**
  - One measurement sets `RENDERED_PER_UNIT` with a fifth to spare. It's taken on wrapped ASCII, CJK, Arabic and Devanagari text at the ceiling.
  - After scrolling end to end, the renderer's private bytes stay ≤ the reservation + 32 MiB, C1's bound.

**Size:** decent, about 900 lines, half of them e2e. **This is the merge where Zack can read Markdown.**

### PR 3 · Links and local images · decent · 🔒 security, full review
**Scope:**
- **Resolution in the core**, through `resolve(doc, gen, href)` and `image(doc, gen, src)`:
  - percent-decoding, with `/` and `\` both accepted, relative to the file's folder;
  - network forms (`//`, `\\`, `smb:`, `file://host`, `\\?\`, `\\.\`) refused before any file system call;
  - then `store::refusal`;
  - then a refusal when the route walk ends on a UNC path.
- **Images:**
  - the type is sniffed: PNG, JPEG, GIF or WebP; SVG is refused;
  - at most 8 MiB of file bytes and 16,777,216 pixels by the header (Z43's caps);
  - read with `open_regular`'s sharing flags, so the file is never locked, and shown as a `blob:` URL;
  - width × height × 4 bytes are added to the lens's reservation;
  - loaded as they near the viewport, at most 2 at once.
- **Main's `open-external(url)`:**
  - It's the first preload call that takes an argument, so it gets C4's checks: a string, at most 32 KiB, from this window's app frame.
  - Main re-checks the scheme itself.
- The click and scroll handling in `rendered.ts`.

**Acceptance:**
- **Resolver table:**
  - It covers relative paths, `./`, `../`, `/`, `%20`, `\`, `file:///C:/…`, `file://host/…`, `//h/x`, `\\h\x`, `smb:`, `\\?\`, `\\.\pipe\x` and a directory.
  - On Windows, a junction to `\\localhost\c$` is refused.
- **Images:**
  - Each type is served.
  - SVG, oversize, over-pixel and truncated images are refused, with their alt text and the reason visible.
- **e2e:**
  - An http link calls a stubbed `shell.openExternal` exactly once.
  - A `javascript:` link does nothing.
  - `other.md` opens in the card.
  - `x.exe` shows "Not opened".
  - `#heading` scrolls to its heading and focuses it.
  - A footnote reference jumps to its definition.
  - After all of that, the NetLog passes, and local images arrive only over `blob:`.
- **Main unit test:** `open-external` refuses non-strings, oversize input, other schemes and other frames.

**Size:** decent, about 800 lines. If its review grows, images split off as a PR 4.

## 4. Owner questions: ANSWERED 2026-10-24
- **Z71:** the ceiling is 8 MiB of source ("8 MB").
- **Z72:** Rendered uses native `content-visibility` over all blocks in this slice, a temporary departure from Z26 ("Accept").
- **Z73:** a relative link to a supported file replaces the card's file ("Open it in the window").

The original questions:
1. **Rendered's size ceiling.** The slice renders files up to 8 MiB of source. Above that, the file opens in Raw with Rendered disabled. *Recommended: 8 MiB.*
2. **Z26 for Rendered.** The slice relies on native `content-visibility` over all blocks instead of the virtualizer, within the ceiling. *Recommended: accept it for this slice.*
3. **A relative link to another supported file:** replace the card's file (no Back until M2), or do nothing until M4's peek. *Recommended: replace.*

## 5. Risks
1. **Document markup causes network activity.** *Mitigation:* no URL from the file in any live attribute; the spike's reviewed allowlist plus the oracle and a proptest; PR 2's DOM sweep and NetLog over the corpus, with a positive control.
2. **Keeping the whole DOM costs too much on big files.** *Mitigation:* the ledger refuses and Raw stays; everything wraps; one page is appended per frame; the build runs off the UI thread; hostile shapes are timed at the ceiling. If it comes out bad, lower the ceiling.
3. **A link or image path reaches a network host and sends NTLM credentials** (Z43). *Mitigation:* network forms refused before the file system is touched; a UNC route refused; PR 3's junction test. *Cost:* images beside a document on a share or mapped drive don't load in this slice.
