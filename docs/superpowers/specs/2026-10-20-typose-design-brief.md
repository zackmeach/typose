# Typose — Design Brief (look, feel, experience)

- **Date:** 2026-10-20 · **Revision:** 6 (2026-10-22).
  - Revision 6 records the product-facing parts of Zack's decisions Z39–Z50 (§0.5). Screen-reader validation is parked until after launch, and supersedes Z35. It also covers the Grid keys, UTF-16 CSV/TSV, inline and network-path images, front matter, TSV quoting and header detection. The technical design logs the rest (Z41, Z46, Z47, Z49, Z50). Z51 (Rows keys) and Z52 (far jumps under the scrolling budget) followed the same day.
  - Revision 5 records Zack's Phase 0 decisions Z30–Z37 (§0.4). They cover giant-Markdown behavior, grid record numbers, screen-reader navigation and testing, the memory-budget behavior, the YAML Tree ceiling and the Raw first-screen definition.
  - Revision 2 applied the fixes from the adversarial review (verdict: FIX-FIRST).
  - Revision 3 applies the validated layout critique (`docs/design/critique-2026-10-20.md`): no-wrap splits, sidebar auto-collapse, breadcrumb shrink order, a yellow tint instead of orange, the scrim/shadow tokens, the two density scales and inset focus rings.
  - Revision 4 applies changes D1–D17 from the technical design (`docs/superpowers/specs/2026-10-20-typose-tech-design.md` §14), accepted by Zack on 2026-10-20. They cover:
    - performance budgets defined over fixtures and ready lenses, with the cold start split into two budgets;
    - an aggregate memory budget;
    - navigable virtualized content, with logical scrolling beyond the engine cap;
    - content-verified change detection;
    - Mermaid in sandbox mode, and "Typose issues no requests";
    - bounded print, a YAML Tree size ceiling and Linux best effort;
    - oversized-item rules;
    - encoding detection before the binary check.
- **Status:** All decisions resolved (§0.2, §0.4, §0.5). The stack decisions (Z24–Z29) and the Phase 0 sequence (Z38) are logged in the technical design.
- **Feeds:** the Claude Design pass (screens in §10, done) and the technical design (`docs/superpowers/specs/2026-10-20-typose-tech-design.md`).
- **Who decided what:** Zack's decisions from the grill session are marked **[Z#]** (log in §0.1). **Everything without a [Z#] tag is proposed by the assistant** and open to veto. Items marked 🔒 are safety or correctness requirements: their wording can change, but the requirement can't be dropped.

---

## 0. Decisions

### 0.1 Zack's decisions (grill, 2026-10-20)
| # | Decision |
|---|---|
| Z1 | v1 is a **read-only viewer**. A full editor is a possible future expansion and must not be precluded. |
| Z2 | The primary job is "all of the above". The pain is that each format opens in a different editor or a rigid viewer. **Cross-format link following is the signature feature.** |
| Z3 | **Open anything.** Files and folders arrive via drag, CLI or OS; folders become sidebar roots (several allowed); files from anywhere open as tabs; the session is restored. |
| Z4 | Shape-aware lenses: **Transcript only** (agent chat JSONL). Everything else is format-generic. |
| Z5 | Customization: **tokens + a live-preview settings UI**, backed by a plain-text config. Themes are shareable token files. **No CSS theming.** |
| Z6 | **No file watching in v1.** Live reload with sticky change markers is an expansion idea. |
| Z7 | **Windows, macOS and Linux from day one.** |
| Z8 | **Mouse-first**, with shortcuts that a Word or Excel user expects. |
| Z9 | Default framing is **card on canvas** (ref 02, breadcrumb + lens-switch header). Flush is a theme option. |
| Z10 | Clicking a link opens a **peek you can promote** (Open as tab / Open to side / ✕). |
| Z11 | Tabs are **pills on the canvas**, above each card. |
| Z12 | Type: **Inter + JetBrains Mono**. |
| Z13 | Motion is **quick and functional**: peek ~140ms, lens cross-fade ~90ms; tab and file open are instant; reduced-motion is respected. |
| Z14 | Color: **cool neutral + one blue accent** (links, focus, selection, active lens). More themes may come later. |
| Z15 | File info is **on demand only**. *Accepted exception:* parse problems always surface. |
| Z16 | **Markdown extras in v1:** a frontmatter property block, Mermaid, callouts and KaTeX. |
| Z17 | **Up to 100MB, every lens gives a first screen in under 100ms.** Past 100MB, the file opens immediately in Rows/Raw while the index streams in, and heavy lenses unlock afterwards. **1GB+ still opens.** |
| Z18 | Empty state: **recents + a drop zone**. |
| Z19 | **No cross-file search in v1.** |

### 0.2 Decided after the review (Zack, 2026-10-20)
| # | Decision |
|---|---|
| Z20 | **Keep** the md **Outline pill and rail** (§5.2). |
| Z21 | **Transcript detects two schemas:** Claude Code sessions **and** the OpenAI chat format (§5.4). |
| Z22 | **Keep wikilinks** (§4.4). |
| Z23 | **Multi-GB files:** a heavy lens may stay unavailable when indexing it would exceed the memory budget. The reason is stated (§8.3). |

### 0.3 Removed from v1 after the review
- **Preview tabs.** Reading is scrolling, so "scroll makes it permanent" defeats the purpose. They also let a single click launch a file.
- **`#L12`, `#row=` and JSON-Pointer anchors.** Invented conventions. `#heading` stays.
- **Links from JSON/YAML string values.** Moved to the expansion list: a stat per string on the render path, plus UNC exposure.
- **Columns popover.** Unusable at thousands of columns. Moved to the expansion list.
- **Top/bottom splits and drag-to-edge.** They collide with pills and gutters. Left/right splits remain.
- **The JSON Table toggle on a selected node.** Table is offered only when the *root* is an array of objects.
- **YAML alias jump links.** Replaced by alias nodes that expand on demand.

### 0.4 Phase 0 decisions (Zack, 2026-10-21)
| # | Decision |
|---|---|
| Z30 | **Giant Markdown files** open immediately in Raw while Rendered indexes in the background. Roughly 20 seconds for a 1GB file is acceptable, but it isn't a guaranteed deadline. Progress and cancellation remain required (§8.2). |
| Z31 | **Grid row numbers are source record numbers**, starting at **1 for the first data record**, and preserved when sorted. Physical source lines remain available through Raw (§5.3). |
| Z32 | **Screen readers count the row-number column as column 1**, so the first data column is announced as "column 2" together with its name (§9). |
| Z33 | **Wide reading windows apply to Rendered and Transcript.** Grid and Rows use keyboard navigation that loads its target before moving focus. Every data cell must be reachable, but continuous "read all" across Grid and Rows isn't a v1 requirement (§9). |
| Z34 | **Memory budget 🔒:** document data across all open files stays within 25% of physical RAM, including indexes, caches and temporary parsing allocations. When the limit is reached, Typose stops building Rendered, explains why it's unavailable, and keeps Raw. 32 bytes per Markdown block is an optimization target, not the safety limit (§8.3). |
| Z35 | **Screen-reader testing:**<br>• Phase 0 runs the full 2,000-block forward and backward test on NVDA, Narrator and VoiceOver.<br>• Routine milestones run a shorter test: at least four window recenters each way, plus heading jumps and focus restoration.<br>• The full test runs again whenever virtualization or screen-reader behavior changes (§9).<br>**Superseded by Z39** (2026-10-22): parked until after launch. |
| Z36 | **YAML Tree ceiling: 8MB in v1**, with Raw above it. Smaller files must still respect memory and structural limits (§5.5). |
| Z37 | **Raw's first screen** is the first bounded piece, visible and usable, with continuation available while scanning proceeds. The first-screen target applies to that view. Full-line scan completion is measured separately (§8.1). |

### 0.5 Decisions from the Phase 0 decision packet (Zack, 2026-10-22)
The product-facing ones. The technical design's §0.4 holds all of Z39–Z50, and the packet (`docs/superpowers/plans/2026-10-22-phase0-decision-packet.md`) holds the context.

| # | Decision |
|---|---|
| Z39 | **Screen-reader validation is parked until after launch**, as an expansion opportunity (§2). It supersedes Z35.<br>• No manual screen-reader runs, speech capture or listening tests before launch.<br>• Automated accessibility stays required: semantics, axe, accessibility-tree reads, keyboard and focus.<br>• The screen-reader design in §9 stands, but until the parked validation runs, Typose doesn't claim verified screen-reader support. |
| Z40 | **Grid keys:** Shift+Space selects the row and Ctrl+Space the column; Page Up/Down page; Space doesn't page-scroll (§7.4). |
| Z42 | **UTF-16 CSV/TSV opens in Raw only in v1.** The Grid lock says "Grid is unavailable for UTF-16 CSV/TSV. Open in Raw, or convert a copy to UTF-8." (§5.3) |
| Z43 | **Inline `data:` images** (PNG, JPEG, GIF, WebP; not SVG) render in Rendered within per-image caps. **UNC and `smb` images never load, even after "Load remote images"** (§4.6). |
| Z44 | **Front matter** is recognized only at the start of a Markdown file, and only when it closes within the first 64KB. Anywhere else, or longer, it reads as ordinary Markdown. |
| Z45 | **TSV honors double quotes** like CSV (not strict IANA TSV) (§5.3). |
| Z48 | **Header detection** stays automatic in v1, and ⓘ's "First row is header" override is required at the Grid milestone: visible, reversible, and recovering the first record when detection is wrong (§5.3). |
| Z51 | **Rows keys follow the Grid's:** Shift+Space selects the row, and Space doesn't page-scroll; Page Up/Down page (§7.4). |
| Z52 | **A far jump counts as scrolling.** A scrollbar jump, an Outline jump or open-then-scroll must not stall over the scrolling budget, with accessibility mode on or off (§8.1). |

---

## 1. What Typose is

Typose is an open-source desktop viewer for the formats the AI era runs on: **Markdown, JSON, JSONL, CSV/TSV and YAML**. It is very fast, very simple and deeply customizable.

**The pain [Z2]:** each of these formats opens somewhere different today. Some open in an editor window, some in a rigid single-format viewer like Typedown. Even in Obsidian, a CSV shows up in the file list but can't be opened and viewed nicely in a tab next to the markdown that links to it.

**The promise:** every format gets first-class treatment in one window, side by side, and **links work across formats**. A link in `.md` to `tasks.csv` opens a real grid beside the document. None of the ~70 web-app screens reviewed for this brief (§11) does this. It is Typose's signature behavior.

### Principles
1. **Content is the only loud thing.** The chrome is neutral and quiet. Color comes from the data and from problems, never from decoration.
2. **Every format gets a purpose-built lens**, with Raw always one click away.
3. **Speed is a feature you can feel.** Nothing blocks input, and big files open straight away into a degraded-but-useful lens rather than a spinner.
4. **Customizable through tokens, not internals [Z5].**
5. **Never lie about the file.** Values are shown verbatim, nothing is dropped silently, and problems always surface (§7.7).
6. **Every opened file is untrusted** (§4.6).

---

## 2. Scope

### v1
| Area | v1 behavior |
|---|---|
| Formats | `.md` `.markdown` · `.json` `.jsonc` · `.jsonl` `.ndjson` · `.csv` `.tsv` · `.yaml` `.yml` |
| Mode | **Read-only [Z1]** |
| Platforms | **Windows, macOS, Linux [Z7]**. Linux ships as **best effort** in v1: it's built and smoke-tested, but the accessibility and 60fps gates apply to Windows and macOS (Z28). |
| Opening | Drag-and-drop, CLI (`typose <path>…`), OS "Open with", Ctrl+O, and the menu's Open file… / Open folder… **[Z3]** |
| Workspace | Each folder becomes a sidebar **root**, with several allowed. Files from anywhere open as tabs. **[Z3]** |
| Session | Roots, cards, tabs, the lens for each tab and scroll positions are restored on launch **[Z3]** |
| File changes | **Static [Z6].** Ctrl+R reloads. The on-access change check (§7.9) is not watching. |
| Search | **In-file find only [Z19]** (§7.5) |
| Shape-aware lens | **Transcript only [Z4]** (§5.4) |
| Window | Single instance per user session, single window. Further CLI or "Open with" calls go to the running window. A launch from a different user or an elevated context can't reach it; this is a documented edge case. |

### Expansion list (designed for, not built)
1. **Live reload with sticky change markers [Z6].** Gutter markers stay until you've seen them, background tabs get an unseen dot, and appended JSONL auto-tails.
2. **Change review / diff lens**, built on item 1.
3. **Editing:** quick fixes, then a full editor **[Z1]**.
4. **Cross-file search [Z19]**, with results in the peek card.
5. **More bundled themes**, e.g. Warm paper or a signature-hue brand theme **[Z14]**.
6. More shape-aware lenses (OpenAPI, package.json, CI YAML), possibly as plugins.
7. **Links from JSON/YAML string values.** These need the UNC rules in §4.6.
8. **Grid Columns popover** (show and hide columns).
9. **Link-trail spine** (ref 05).
10. **Screen-reader validation [Z39].** Real-reader testing on NVDA, Narrator and VoiceOver, starting from Spike B's 20-task script, before Typose claims verified screen-reader support.

### 2.1 Design-for-later constraints (binding on v1)
- **Rendered output maps back to the source.** Every rendered block, grid row, tree node and transcript block knows its source byte range. Editing, change markers, diffs, copy (§7.4) and lens-switch scroll mapping all depend on this.
- **The peek card is a general surface.** The content supplies the header title and actions (§4.5), so cross-file search can reuse it.
- **One state slot on each tab pill and card header.** It is empty in v1. Later it shows distinct **glyphs** (not just colors): unseen change ● (accent), unsaved edit ● (filled, sharing the slot with ✕, as VS Code does), and conflict ⚠.

### Out of scope
Remote or URL files; PDFs and images as standalone documents; collaboration and presence; the AI-editor features in the inspiration screenshots (agent avatars, spend meter, "Accept all", presence count); arbitrary CSS theming.

---

## 3. Window anatomy

```
┌ title bar ─────────────────────────────────────────────────────────────────────┐
│ ▣ ☰ »                        launch-plan.md — Typose                    ─ ▢ ✕ │  ← Windows/Linux layout
├────────────────────────────────────────────────────────────────────────────────┤
│ canvas                                                                         │
│ FILES  «     (launch-plan.md ✕) (agent.yaml)    (tasks.csv ✕)                  │  ← tab pills on the canvas
│ ▾ pulse ⟳    ╭───────────────────────────────╮ ╭──────────────────────────────╮│
│   plan.md    │▤ pulse/launch-plan.md [Rnd|Raw]ⓘ│ │▦ pulse/tasks.csv [Grid|Raw] ⓘ││  ← one-row card header
│   tasks.csv  ├───────────────────────────────┤ ├──────────────────────────────┤│
│ ▸ notes      │  (content, centered ~70ch)    │ │ (grid, flush, no border)     ││
│ + Add folder ╰───────────────────────────────╯ ╰──────────────────────────────╯│
└────────────────────────────────────────────────────────────────────────────────┘
```
(`[Rnd|Raw]` = the Rendered | Raw lens switch, abbreviated to fit the diagram.)
The primary reference is [`02-frame-card-pane-header.png`](../../design/refs/02-frame-card-pane-header.png). Read it with the **Ignore** notes in §11.

### 3.1 Title bar (40 logical px; the native metrics apply in the native-frame fallback)
- **Windows:**
  - Left: the app glyph, **☰ menu** and **»** (shown only while the sidebar is collapsed).
  - Center: the window title, **`<focused file> — Typose`**.
  - Right: native-behaving caption buttons, with Windows 11 **Snap Layouts** on hovering maximize.
- **macOS:**
  - Native traffic lights inset into the custom bar on the left, followed by **»**.
  - The **native menu bar** replaces ☰.
  - In fullscreen the bar follows system behavior: it hides and reveals on hover.
- **Linux:**
  - Client-side bar. The button set and side follow `gtk-decoration-layout` (GNOME defaults to close only), and it provides resize edges under Wayland.
  - Where server-side decorations are forced (e.g. KDE), Typose uses the native title bar, and ☰ » move to the top-left of the canvas.
- **Layout per OS:** the bar's content **reflows per OS**. There is no reserved blank space for the other platform's controls.
- **Drag region:** the whole bar, except its controls.

### 3.2 Menu (☰ on Windows/Linux; native menu bar on macOS)
| Menu | Items |
|---|---|
| **File** | Open file… · Open folder… · Reopen closed tab · Reload · Print… · Settings · Exit (Quit on macOS/Linux) |
| **View** | Toggle sidebar · Split right · Wrap lines · Zoom in / out / reset · Full screen · Command palette |
| **Help** | Keyboard shortcuts · Report an issue · About Typose |

Every shortcut in §7.2 has a menu or on-screen click path **[Z8]**.

### 3.3 Canvas
- The window background. It holds the sidebar, the tab pills and the cards.
- Dark `#111113`, light `#F7F7F7`.

### 3.4 Sidebar
- It sits **directly on the canvas**; it is not a card. Its header is "FILES" with a collapse button «. To restore it, use **»** in the title bar, Ctrl+B, or View → Toggle sidebar.
- **Roots:** each root is a collapsible row.
  - On hover the row shows a **⟳ refresh** button. Its context menu also has Refresh and Remove from workspace.
  - Below the roots sits **+ Add folder…**.
  - With many roots the sidebar scrolls, and the root headers stick while their own contents scroll.
- **When listings refresh:** when a folder is expanded, when ⟳ is clicked, on Ctrl+R, and when the window regains focus (expanded folders only). This is a re-list, not watching.
- **File rows:**
  - Supported files show a format icon: doc for md, grid for csv/tsv, `{ }` for json and jsonl, a list icon for yaml.
  - Unsupported files are dimmed. Clicking one opens the hand-off sheet (§4.6); nothing launches on a single click.
  - The active file's row has a rounded fill.
- **Hidden entries:** dotfiles are hidden unless the Files setting turns them on. `.gitignore` is not applied to the sidebar.
- **Missing root:** shown with a ⚠ and "Folder not found", plus Locate… and Remove.
- **Size:** 240px wide by default, resizable from 180 to 420px. It collapses to nothing.
- **Narrow windows:** below a 1000px window width the sidebar **auto-collapses** and » shows in the title bar. It never stacks above the content. Opening it at that width overlays it on the canvas instead of pushing the cards.

### 3.5 Cards
- **Shape:** each pane is a rounded card on the canvas: 12px radius, a 1px `border`, filled with `surface`. No shadow in dark mode; light mode adds `0 1px 2px rgb(0 0 0 / 4%)`.
- **Card header:** **one row, 44px**, from left to right:
  - the format icon;
  - a **breadcrumb**, `root / …/ file.ext`, in `text.secondary` with the filename in `text`;
    - middle segments collapse to `…`;
    - for files outside any root it shows `parent-folder / file.ext`, with the full path in a tooltip;
    - **shrink order:** the root segment shrinks first, then the middle collapses to `…`, then the filename. The filename never goes below 10ch and ends in an ellipsis. It is the one thing in the header that must survive;
  - a spacer;
  - the **lens switch** (§5);
  - **ⓘ** (§7.6);
  - the state slot (§2.1).
- **Below a 400px card width**, the lens switch collapses into a dropdown showing the current lens name and ⌄. ⓘ never collapses.
- **The card body scrolls** (both axes where the lens needs it). It never clips content.
- **No card inside a card.** Grids, trees, Raw text and Rows sit **flush** in the card body, separated by hairline rules. They never get their own border.
  - Fenced code blocks inside *Rendered* markdown are the one block element. They are a **filled** region (`surface.raised`, 8px radius) with **no border**.
- **Gutters and edge margins:** 16px at 1–2 cards, 8px at 3 or more. They **never change while a drag is in progress**.
- **Minimum card width: 320px.** If a split would make a card narrower than that, the file opens as a tab instead, and a toast says "Not enough room to split".

### 3.6 Tab pills [Z11]
- **Placement:** a row of pills on the canvas directly above each card, in the same style as the Doc/Table switch in the inspiration screenshots ([`00-inspiration-table-dark.png`](../../design/refs/00-inspiration-table-dark.png)).
- **Sizing:** each pill is 28px tall, with 10px horizontal padding, an 8px radius and a 4px gap between pills. The row is 36px including padding.
  - The pill row is part of its card's footprint, so gutters are measured between footprints.
- **Contents:** format icon · filename · the state slot, which shows ✕ on hover and focus, and always on the active pill.
  - When two open files share a name, each pill appends its parent folder, dimmed: `README.md · docs`.
- **Active pill:** filled with `surface`, a 1px `border` and `text`.
- **Inactive pill:** transparent with `text.secondary`. On hover it fills with `surface` at 60%.
- **Overflow:** the row scrolls horizontally, with inner padding so focus rings aren't clipped. A **⌄** pinned at the end, **outside** the scrolling region so it's always visible when the row overflows, lists every tab in that card.
- **Dragging:** pills reorder by drag within their row, or move to another card's row. Dropping onto a card body does nothing.

### 3.7 Splits
- **Left/right only.** Use Ctrl+\\, View → Split right, "Open to side", or Shift+click a link.
- Dividers sit in the gutters and can be dragged to resize. Double-click a divider to even the split.
- **Cards never wrap or stack.** Open cards always share one row. If the window shrinks below the cards' combined minimum (320px each plus gutters), the card row scrolls horizontally instead.

### 3.8 Frame variant [Z9]
- The `frame` token takes `card` (default) or `flush` ([ref 01](../../design/refs/01-frame-hybrid.png)).
- In `flush`, cards meet at 1px hairlines with no gutters and no radius.
- Each pane's pills sit in a 36px strip at the top of the pane, styled identically to the card version.
- Document lenses keep their centered reading column.

---

## 4. Navigation and opening

### 4.1 Opening
| Gesture | Result |
|---|---|
| Drag a file onto a card | Opens it as a tab in that card |
| Drag a folder anywhere | Adds it as a root |
| CLI `typose a.md b.csv dir/` | Files open as tabs and folders become roots, in the running window |
| "Open with" from Explorer, Finder or a file manager | Opens it as a tab in the focused card |
| Click a sidebar file | Opens it as a tab in the focused card, or focuses its tab if it's already open there |

### 4.2 Quick open (Ctrl+O)
- **What it is:** a centered overlay listing recent files first, then fuzzy matches across the open roots. Each row shows a format badge, the filename and a dimmed path.
- **Footer:**
  - "**Browse…**" is pinned in the footer and opens the OS dialog.
  - Hints: ↑↓ · ↵ open · Shift+↵ open to side · Esc (pattern: [Magnific](https://mobbin.com/screens/e22e26e2-f813-4f1e-beda-43c9ecf26419)).
- **What gets indexed:**
  - Excluded: `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `target`, `.next`, plus hidden files unless they're enabled.
  - Symlinks and junctions are **not followed**.
  - The index is capped at **50,000 entries per root**. When the cap is hit, the overlay says "Index capped at 50,000 files in <root>".

### 4.3 Command palette (Ctrl+K)
- The same overlay as quick open, listing commands, each with its shortcut on a chip.
- Commands: switch lens · split right · toggle sidebar · wrap lines · zoom in/out/reset · go to line/row · print · reload · refresh folder · copy path · show in folder · theme: light/dark/system · open settings · keyboard shortcuts.

### 4.4 Links (the signature behavior) [Z10]
| Action | Windows / Linux | macOS | Result |
|---|---|---|---|
| Open in peek | Click | Click | **Peek** (§4.5) |
| Open as tab | Ctrl+click | Cmd+click | A tab in the same card, or focus the tab if it's already open in that card |
| Open to side | Shift+click | Shift+click | Reuses the nearest card to the right, otherwise the nearest to the left. Creates a split only when there's a single card. |

**Resolution rules:**
- Relative paths resolve against the containing file's folder. A leading `/` resolves against the file's **root**, as GitHub does; for files outside any root, against the file's own folder.
- Paths are percent-decoded. Both `/` and `\` are accepted as separators.
- `file://` URLs are treated as local paths, under the same rules.
- **Case:** an exact match wins. If there isn't one, a case-insensitive match in the same folder is used, and hovering the link shows "Case differs: Tasks.csv", so links that would break on Linux are visible.
- A `#heading` within the same file scrolls; it does not peek. `other.md#heading` peeks and scrolls to the heading. Slugs follow GitHub's algorithm.
- **Wikilinks [Z22]:** `[[name]]`, `[[name|alias]]` and `[[name#heading]]` resolve by filename, with or without `.md`, within the file's root, preferring the shortest path. Outside a root they resolve within the file's folder. `![[…]]` embeds render as a link chip; there's no transclusion.
- **Unresolvable links** get a dashed underline, and hovering shows "Not found: <path>".
- **External URLs, unsupported local files and anything else:** §4.6 decides.

### 4.5 Peek card [Z10]
- **Size:** a card that slides over the right side of the current card. Its width is `max(45% of the card, 420px)`, never wider than the window minus 32px, and it may overlap neighboring cards.
- **Underlying card:** the `scrim` token (§6.2) covers it. The motion is in §6.6. Reference: [`03-link-peek.png`](../../design/refs/03-link-peek.png), with the Ignore notes in §11.
- **Header:**
  - the content supplies the title and actions;
  - for a file, it's the standard card header (breadcrumb, lens switch, ⓘ) plus **Open as tab**, **Open to side** and **✕**;
  - below 560px of peek width, the actions become icons with tooltips. (560 = the header's fixed parts with ← shown, plus the filename at its 10ch minimum.)
- **Links inside the peek** replace its content. A **←** back control appears, with unlimited back history that's discarded when the peek closes.
- **Closing:** Esc, ✕, or clicking the scrim.
- **While a peek is open:** focus is inside it. Ctrl+F searches the peek's content, and Ctrl+W closes the peek.

### 4.6 Untrusted content 🔒
Every opened file is untrusted, including files written by your own agents.

**Local link targets:**
- Open inside Typose only if the target is a **regular file of a supported format**.
- Any other local target shows a **hand-off sheet** with the full path and file type, offering **Open with default app** or Cancel.
- **Never handed off, offering only "Show in folder":** executables, scripts, installers and shortcuts.
  - Windows: `.exe .bat .cmd .com .ps1 .vbs .js .jse .wsf .hta .msi .msix .scr .lnk .url .appref-ms .reg .cpl`
  - macOS: `.app .command .pkg .terminal .workflow` and any file with the executable bit
  - Linux: `.desktop .sh .AppImage` and any file with the executable bit

**URLs:**
- `http`, `https` and `mailto` open in the OS handler directly.
- **Any other scheme** shows a confirm sheet with the full URL.

**Paths Typose never touches without a click:**
- UNC paths (`\\host\…`, `//host/…`) and `smb://` URLs.
- Device or special files (FIFOs, `/dev/*`, `\\.\…`) are **refused**.

**Images:**
- Images from local regular files render inline.
- Inline `data:` images (PNG, JPEG, GIF, WebP; not SVG) render within per-image size caps. An over-cap or refused image keeps its alt text and shows why [Z43].
- Remote `http`/`https` images sit behind a once-per-file **"Load remote images"** bar. Rendering never makes network requests until that's clicked.
- **UNC and `smb` images never load, even after that click** [Z43]: on Windows, fetching one can send your credentials to the remote host.

**Raw HTML in markdown:**
- An **allowlist**: `b i em strong code kbd sub sup br hr details summary a[href] img[src alt] table thead tbody tr th td`.
- `href` and `src` follow the rules above. Every other attribute is stripped, including `style`.
- Anything not on the list renders as **literal text**.

**Mermaid and KaTeX:**
- **Mermaid** runs at `sandbox` security level: the diagram renders inside a sandboxed iframe, with no click handlers and no HTML labels. Strict mode still renders in the app's own DOM, and a read-only viewer loses nothing in sandbox mode.
- **KaTeX** runs with `trust: false` and `maxExpand`/`maxSize` limits.
- A render error shows the source, with a problem marker.

---

## 5. Lenses

- **The lens switch** is a segmented control in the card header (§3.5).
- **Active segment:** a raised neutral fill (`surface.raised`, as in ref 02) with an **accent** label [Z14]. Inactive segments use a `text.secondary` label.
- **Each tab remembers its lens.** Settings → Lenses sets the default lens for each format.
- **Switching lenses** cross-fades the card body and keeps the scroll position mapped through the source location (§2.1).
- **The naming is "Raw" everywhere**, including md.

| Format | Lenses (default first) |
|---|---|
| md | **Rendered** · Raw |
| csv / tsv | **Grid** · Raw |
| json / jsonc | **Tree** · Raw. A **Table** segment is added when the *root* is an array of objects. |
| jsonl | **Rows** · Table · Raw. When the schema is detected, **Transcript** is inserted first and becomes the default (§5.4). |
| yaml | **Tree** · Raw |

### 5.1 Raw (all formats)
- JetBrains Mono with syntax highlighting and a line-number gutter in `text.secondary`.
- No wrapping by default; View → Wrap lines toggles it.
- **Lines over 10,000 characters always wrap**, with a ↪ continuation marker.
- **Lines over 1MB** show their first 1MB followed by a "+N MB more on this line · Copy line" control. Nothing is cut silently.

### 5.2 Markdown: Rendered
- **Reading column:** centered, max `measure` (70ch).
- **CommonMark + GFM:** tables, task lists (read-only checkboxes), strikethrough, autolinks and footnotes.
- **Code blocks:** filled blocks (§3.5) with syntax highlighting. A **copy** button appears on hover *and* on keyboard focus.
- **Frontmatter [Z16]:** rendered as a compact **property block** above the H1, a key/value grid with keys in `text.secondary` and values in `text`.
- **Mermaid [Z16]:** rendered as diagrams, under the hardening in §4.6. The renderer is lazy-loaded the first time it's needed, and the source shows until the diagram is ready.
- **Callouts [Z16]:**
  | Callout | Tint |
  |---|---|
  | GitHub `NOTE` | blue |
  | `TIP` | green |
  | `IMPORTANT` | purple |
  | `WARNING` | yellow |
  | `CAUTION` | pink |
  | Obsidian `info` / `todo` | blue |
  | `tip` / `success` | green |
  | `question` / `example` | purple |
  | `warning` | yellow |
  | `danger` / `error` / `bug` / `failure` | pink |
  | `quote` / `abstract` | neutral |

  Callouts never use `warn`, which is reserved for Typose's own problem reporting.
- **Math [Z16]:** KaTeX, `$inline$` and `$$block$$`, under the hardening in §4.6.
- **Images and HTML:** §4.6 rules apply.
- **Oversized blocks:** a block over 64KiB (a giant code fence, table, list or paragraph) renders in bounded pieces: code by lines, lists by items, tables by rows, paragraphs at word boundaries. A block that can't be split sensibly shows its source in a bounded Raw view, with a note. Nothing renders as one giant block.
- **Outline [Z20]:**
  - A floating **"Outline" pill** in the card's bottom-right corner, shown only when the doc has 3 or more headings. Pattern: [Obvious](https://mobbin.com/screens/cf1f91e1-dfc8-425f-a5c7-5c3305bff52a).
  - Clicking it expands a rail inside the card listing H1–H3, with the current section highlighted.
  - The rail takes its own column only when the card is at least 936px wide: the 640px reading column, its padding, and the 232px rail. Below that, it overlays the content from the right (`surface`, `shadow`), so it never squeezes the reading column.
  - It is keyboard reachable.

### 5.3 CSV/TSV: Grid
- **Layout:** a **sticky header row** and a **row-number column**.
  - The row number is **always the source record number**, even when the grid is sorted. It starts at 1 for the first data record, and a record with quoted newlines is one row. Physical source lines are in Raw [Z31].
- **Column header:** an icon for the inferred type (text · number · date · boolean · url) plus the column name.
  - Clicking the header sorts ascending → descending → unsorted, as a view only.
  - Type inference drives **alignment, icons and sort order only. It never reformats values** (§7.7).
- **Width:** columns auto-fit from the first 1,000 rows, capped at 360px. The first screen uses estimates from the rows in view, and widths **refine** as the background scan completes, keeping the reading position. Overflowing cells end in an ellipsis, and the full value appears in a tooltip on hover *and* when the cell is selected.
- **Numbers:** right-aligned, in tabular figures.
- **Value pills:**
  - **Which columns:** decided from the first 1,000 rows (or all rows, if fewer). A string column with **≤ 6 distinct values** and **≥ 12 rows** renders its values as tinted pills. The decision is never revoked.
  - **Tints** are assigned in **order of first appearance** within the column, from the 6 hue tints (§6.2), so they never collide. A value first seen after row 1,000 gets a neutral pill.
  - **Color carries no meaning.** The text is always shown.
  - Empty cells and `—` render as plain `text.secondary`.
- **Encoding:**
  - UTF-8, with a BOM sniff for UTF-16. The fallback is **Windows-1252**.
  - Encoding is detected **before** the binary check (§7.9). A UTF-16 BOM skips the NUL test, because UTF-16 text is full of NUL bytes. BOM-less UTF-16 shows as binary, and ⓘ's encoding override is the way out.
  - **UTF-16 CSV/TSV opens in Raw only in v1.** The Grid lock says "Grid is unavailable for UTF-16 CSV/TSV. Open in Raw, or convert a copy to UTF-8." [Z42]
  - Undecodable bytes show as � and are counted as a problem.
- **Delimiter:** comma, tab, semicolon or pipe, auto-detected. TSV honors double quotes like CSV, so a quoted field can hold tabs and newlines [Z45].
- **Header row:** auto-detected.
- Encoding, delimiter and "First row is header" can all be overridden in ⓘ. The header override is visible and reversible, and it recovers the first data record when detection is wrong [Z48].
- **Ragged rows:** missing cells render empty; extra cells go into a trailing **"+N"** cell whose tooltip shows the values. Each ragged row is a problem (§7.7).
- **Wide files:** the header and row-number column stay sticky, and horizontal scrolling is virtualized, so 5,000 columns is fine.

### 5.4 JSONL: Rows · Table · Transcript
**Rows** (default for generic JSONL; reference: [`04-lenses-jsonl-yaml.png`](../../design/refs/04-lenses-jsonl-yaml.png))
- **Row anatomy:** `›` expand chevron · **timestamp** (first field matching `ts|time|timestamp|created_at`) · **type pill** (from `type|role|level|event`) · **summary** (first string among `message|msg|text|content|summary`, otherwise compact JSON).
- **Expanding** shows the row's Tree inline.
- **Blank lines** are ignored and counted in ⓘ.
- **A line that fails to parse** is a row with an amber `!` and its raw text. It is never skipped.
- **A record over 1MB** shows its first 1MB, then "+N MB more · Copy record", like Raw's long-line rule (§5.1).

**Table**
- Columns are the union of top-level keys over the first 1,000 lines. They **grow as indexing finds new keys**.
- Until indexing completes, a final **"…other keys"** column holds each row's unlisted keys as compact JSON. Nothing is dropped.

**Transcript [Z4, Z21]** (one lens, two schemas)
- **When detected**, Transcript is inserted first and becomes the default. Otherwise it doesn't appear.
- Lines that fail to parse are handled the same way in both schemas; see the last bullet of each.

*Claude Code sessions*
- **Detection:** among the first 200 lines that parse, at least 3 lines must have `type` ∈ {user, assistant}, a `message.role`, `message.content`, and `uuid`/`parentUuid`.
- **Order:**
  - Typose builds the `uuid` → `parentUuid` graph and renders **the chain ending at the most recent leaf**.
  - Branches off that chain show as a collapsed **"▸ N messages on another branch"** marker at the fork.
  - `isSidechain: true` runs (subagents) show as a collapsed **"▸ Sidechain · N messages"** group where they attach.
- **Turns:** each one is separated by a hairline, with a **role label** (User / Assistant) and a timestamp.
  - `tool_result` blocks arrive in user-role entries. **They are never shown as user turns**; they nest under their matching `tool_use`.
- **Blocks:**
  - `text`: rendered as markdown (§5.2 rules).
  - `thinking`: collapsed behind a "Thinking" disclosure.
  - `tool_use`: `▸ name(args summary)`, expanding to its input Tree plus the nested result.
  - `image`: an inline thumbnail when the data is embedded, otherwise a placeholder.
  - **Any other block type:** a collapsed `▸ <type>` Tree. Nothing is dropped.
- **HTML-like tags in message text** (e.g. `<command-name>`, `<local-command-stdout>`) render as **literal text**. They are never stripped or interpreted.
- **Non-message entries** (`attachment`, `queue-operation`, `last-prompt`, `system`, summaries, snapshots) are hidden behind one **"Show N session events"** toggle at the top. When it's on, they appear **in place**, as dimmed compact rows.
- **Lines that fail to parse:** a chip at the top reads "N lines couldn't be parsed · View in Rows"; they're also listed in ⓘ.

*OpenAI chat format*
- **Detection:** among the first 200 lines that parse, at least 3 lines must be either:
  - **dataset lines**, `{"messages": [{role, content}, …]}`, or
  - **message lines**, `{role, content}`,

  where `role` ∈ {system, developer, user, assistant, tool, function}.
- **Dataset lines (one conversation per line):**
  - Each line renders as **its own conversation**, under a divider: "Conversation 12 · line 12 · 8 turns".
  - Dividers can collapse their conversation. Conversations start expanded.
  - Any other top-level keys on the line (e.g. `tools`, `metadata`) appear as a collapsed "▸ Line metadata" Tree on the divider.
- **Message lines:** together they form **one conversation**, in line order.
- **Turns:**
  - `system` and `developer` messages collapse behind a "System prompt" disclosure.
  - `user` and `assistant` get role labels.
  - `assistant.tool_calls[]` render as `▸ name(args summary)`, with the arguments parsed from their JSON string.
  - `tool` and `function` messages **nest under the call with the matching `tool_call_id`**. A message with no match renders as its own "Tool" turn.
- **Content:**
  - A string renders as markdown.
  - An array renders part by part: `text` parts as markdown; `image_url` parts as a thumbnail for a data URL, or behind the remote-image gate (§4.6) otherwise; any other part type as a collapsed `▸ <type>` Tree.
- **Lines that fail to parse:** the same chip as for Claude Code sessions.

*Both schemas*
- **Width:** the same centered reading column as Rendered md.

### 5.5 JSON & YAML: Tree
- **Node anatomy:** fold chevron · key in `text` · `:` · the value.
- **Value colors** come from the **data tints** (§6.2): strings green, numbers yellow, booleans purple, null in `text.secondary`. They never use the accent.
- **Values are verbatim.** A number shows its exact source text: `12345678901234567890`, `3.10` and `1e400` appear as written.
- **Duplicate keys** are all shown, and each one is flagged as a problem.
- **Collapsed counts:** `{ 20 items }`, `[ 8 items ]`. On large files a count shows `…` until it's known.
- **Indent guides:** 1px solid `guide` (not dashed). `hairline` and `border` are both invisible on `surface` (1.0–1.2:1); `guide` is 1.5:1.
- **Initial expansion:** whole levels are expanded, up to 2 levels deep, stopping before the level that would exceed 200 visible nodes. A level is never partially expanded.
- **Context menu:** Copy value (source text) · Copy key · Copy path.
- **JSONC:** a `.json` file that fails strict parsing but parses as JSONC (comments, trailing commas, `NaN`/`Infinity`) renders normally, and ⓘ notes "Parsed as JSONC". It is not a problem.
- **A file that stops parsing partway:** Tree shows everything that parsed, then a final problem row, "Parse stopped at line N: <error> · View in Raw". Clicking it opens Raw at that line.
- **YAML specifics:**
  - The **YAML 1.2 core schema** applies, so `no` and `on` are strings.
  - **Comments:** full-line comments render on their own line, dimmed and italic. Trailing comments stay **on the same line**, after the value.
  - **Unknown tags** (`!Ref`, `!Sub`) show as a small tag badge before the value.
  - **Aliases** show as `*name` nodes that **expand on demand** to the anchor's value. They are never pre-materialized, and expansion is depth-limited, which makes alias bombs safe.
  - **Multi-document files** (`---`) show each document as a top-level node.
  - **Size ceiling:** YAML Tree is available up to **8MB** (`yaml.treeMaxBytes`) [Z36]. Above it, Tree is locked with a reason that states the ceiling, and Raw remains. No YAML parser is incremental or file-backed. Smaller files still respect memory and structural limits.

---

## 6. Visual system

All values are **tokens** (§6.7). These are the v1 defaults; Claude Design may tune them within the stated intent.

### 6.1 Type [Z12]
| Token | Default |
|---|---|
| `font.ui` / `font.reading` | **Inter** (bundled, OFL) |
| `font.mono` | **JetBrains Mono** (bundled, OFL) |
| `size.ui` | 13px |
| `size.reading` | 16px / 1.6 |
| `size.mono` | 13px / 1.55 |
| `measure` | 70ch |
| Reading headings | H1 30/1.2 semibold · H2 22 semibold · H3 18 semibold |

### 6.2 Color [Z14] (follows the OS by default; §7.10)
| Token | Dark | Light |
|---|---|---|
| `canvas` | `#111113` | `#F7F7F7` |
| `surface` | `#1B1B1D` | `#FFFFFF` |
| `surface.raised` (active segment, code block, hover) | `#232326` | `#F1F1F3` |
| `border` | `#26262A` | `#E8E8E8` |
| `hairline` | `#202024` | `#EFEFEF` |
| `guide` | `#3A3A3F` | `#D4D4D8` |
| `text` | `#EDEDED` | `#111111` |
| `text.secondary` | `#8A8A8F` | **`#6E6E73`** |
| `accent` | `#8FB0FF` | `#2B5BD7` |
| `warn` (problems only) | `#F5A35C` | **`#A85309`** |
| `scrim` (under peeks and overlays) | `canvas` at 55% | `#111113` at 12% |
| `shadow` (overlays only) | `0 16px 40px` black 45% | `0 16px 48px` `#111113` 22% |

- **Accent discipline:** the accent is used for **links**, **focus rings**, **text selection**, the **active lens label**, **find and quick-open matches** (current match: 35% fill + outline; other matches: 15% fill), and the **drag-over outline** (no fill). Nothing else; other segmented controls and selected states use a neutral `surface.raised` fill with `text`.
- **Native chrome follows the theme:** each theme declares its `color-scheme`, so scrollbars and any native control render dark in dark mode. A white scrollbar inside a dark card is a bug.
- **Data tints:** 6 hues (blue · yellow · green · purple · pink · teal) plus neutral, each with a background/text pair per theme.
  - Example: blue is `#1E2A4A`/`#A9C1FF` in dark and `#E6EEFF`/`#1F4FBF` in light. Tint text is deliberately **not** the accent value.
  - **Yellow** is `#33300F`/`#E6D27A` dark and `#FBF3CF`/`#6B5600` light (8.8 and 6.4:1 on its own background, 11.4 and 7.1:1 on `surface`). Revision 3 replaced orange, whose values were identical to `warn`, so a data value could read as a problem.
  - **Every tint's text color must reach 4.5:1** on both its own tint background **and** `surface`.
- **Borders read as a change of plane, not a stroke.** Match the contrast of the inspiration screenshots, not the heavier GPT mockups.

### 6.3 Shape and spacing
- **Radius:** card 12px · pills, segmented controls and code blocks 8px · chips 6px.
- **Spacing scale:** 4 · 8 · 12 · 16 · 24 · 32 · 48.

### 6.4 Density
There are two row scales, both driven by the one `density` setting:

| Rows | compact | default | spacious |
|---|---|---|---|
| Grid rows and Rows-lens rows | 28px | 36px | 44px |
| Tree rows and sidebar rows | 24px | 28px | 32px |

Trees and the file list stay tighter than data rows because they're scanned rather than read.

### 6.5 Zoom
Ctrl+= / Ctrl+- / Ctrl+0 scale **every px token**, so rows, padding, radii and type all grow together, from 50% to 200%.

### 6.6 Motion [Z13]
| What | Motion |
|---|---|
| Peek in/out | 140ms ease-out slide + fade, plus the scrim |
| Lens switch | 90ms cross-fade |
| Find bar | 120ms slide down |
| Outline rail | 140ms slide |
| Sidebar collapse | 160ms, animated with a transform; the layout is committed once at the end |
| Tab switch, file open, quick open, palette | **Instant** |

Motion is used only where it explains a change of place, and it never blocks input. `prefers-reduced-motion` turns every animation into an instant swap.

### 6.7 Customization [Z5]
See §7.10.

---

## 7. Interaction

### 7.1 Input posture [Z8]
- **Mouse-first.** Every command has a visible click path through the menu (§3.2), buttons or context menus.
- Shortcuts follow what Word or Excel users expect.
- The palette and quick open are accelerators, never the only way to do something.

### 7.2 Shortcuts
| Action | Windows / Linux | macOS |
|---|---|---|
| Quick open | Ctrl+O | Cmd+O |
| Close tab | Ctrl+W (on the last tab, leaves the empty state) | Cmd+W (on the empty state, closes the window; the app stays running) |
| Reopen closed tab | Ctrl+Shift+T | Cmd+Shift+T |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / Ctrl+PgUp | Ctrl+Tab / Ctrl+Shift+Tab, Cmd+Shift+] / Cmd+Shift+[ |
| Find · next · previous | Ctrl+F · F3 · Shift+F3 | Cmd+F · Cmd+G · Cmd+Shift+G |
| Go to line/row | Ctrl+G | Cmd+L |
| Top / bottom | Ctrl+Home / Ctrl+End | Cmd+↑ / Cmd+↓ |
| Select all · copy | Ctrl+A · Ctrl+C | Cmd+A · Cmd+C |
| Print | Ctrl+P | Cmd+P |
| Command palette | Ctrl+K | Cmd+K |
| Reload file (and refresh listings) | Ctrl+R, F5 | Cmd+R |
| Split right | Ctrl+\\ | Cmd+\\ |
| Toggle sidebar | Ctrl+B | Cmd+B |
| Zoom in / out / reset | Ctrl+= / Ctrl+- / Ctrl+0 | Cmd+= / Cmd+- / Cmd+0 |
| Settings | Ctrl+, | Cmd+, |
| Full screen | F11 | Ctrl+Cmd+F |
| Quit / hide / minimize | Alt+F4 (Win), Ctrl+Q (Linux) | Cmd+Q / Cmd+H / Cmd+M |
| Close the topmost layer | Esc: menu/popover → overlay → the focused surface's find bar → peek | same |

### 7.3 Context menus
- **Tab pill:** Close · Close others · Close to the right · Open to side · Reload · Copy path · Show in folder.
- **Sidebar file:** Open · Open to side · Copy path · Show in folder.
- **Root:** Refresh · Show in folder · Remove from workspace.
- **Tree node:** Copy value · Copy key · Copy path.
- **Grid:** Copy · Copy row · Copy column · Select column.
- "Show in folder" is "Show in Explorer" on Windows and "Show in Finder" on macOS.

### 7.4 Selection and copy
- **Rendered and Transcript:**
  - Text selection works normally, including across virtualized regions.
  - **Copy reads from the source range** (§2.1) and produces plain text.
  - Ctrl+A selects the whole document.
- **Raw:**
  - Ctrl+A selects all, and copy reads the source bytes.
  - A copy larger than **10MB asks for confirmation**, showing its size.
- **Grid:**
  - Click a cell to select it. Shift+click or drag selects a range. Click a row number to select the row; select a column from the header's context menu.
  - From the keyboard: **Shift+Space selects the row and Ctrl+Space the column**. Page Up/Down page, and Space doesn't scroll the grid. Row and column selection are also available as keyboard-reachable commands, for when the OS or an input method takes those shortcuts [Z40].
  - **Ctrl+C copies TSV**, including the header row when whole columns are selected.
- **Tree and Rows:**
  - Click a node or row to select it.
  - In Rows, **Shift+Space selects the row** and Space doesn't scroll, as in the Grid [Z51].
  - Ctrl+C copies its **source text** (the raw line, for Rows).
- **Go to line/row (Ctrl+G)** opens a small input where the find bar sits, and accepts a line number in Raw and Rendered or a row number in Grid and Rows.

### 7.5 Find (Ctrl+F) [Z19: in-file only]
- **Find bar:** a compact bar that slides down inside the card, below the header. It has the query, a count `3/17`, ↑ and ↓, a case toggle, and ✕.
- **Highlights:** every match is highlighted; the **current** match gets the strong highlight (§6.2) and is scrolled into view.
- **Where it searches:**
  - **Rendered:** the whole rendered document, not just the viewport.
  - **Grid:** cell values.
  - **Tree:** keys and values. **Only the current match's ancestors are expanded.**
  - **Rows and Transcript:** row and turn text. **Only the current match's row or turn is expanded.**
  - **Raw:** the source text.
- **Files over 100MB:** matches stream in, and the count reads `≥ 240…` until the search completes.

### 7.6 File info (on demand) [Z15]
- The **ⓘ** in the card header opens a popover with the path, size, modified time, encoding, line ending and line count.
  - **csv:** rows · columns · delimiter · header detection, plus the overrides from §5.3.
  - **jsonl:** lines · parsed · failed · blank · detected schema.
  - **json:** whether it was parsed as JSON or JSONC.
  - **md:** words · reading time.
- Nothing is shown inline unless there's a problem (§7.7).

### 7.7 Problems always surface 🔒 [Z15 exception]
- **Values are verbatim.** Lenses display source text. Numbers keep their exact lexeme, and cells are never reformatted: leading zeros, exponents and dates appear as written. Type inference never changes what's shown.
- **When a file has problems** (a malformed JSONL line, invalid JSON or YAML, a ragged CSV row, undecodable bytes, duplicate keys, a Mermaid or KaTeX error):
  1. **ⓘ gets an amber dot** (a badge on the icon, distinct from the state slot). The popover **groups problems by kind with counts**, e.g. "Ragged rows: 1,204 · first at row 18", and each group can be expanded into a clickable list.
  2. **An inline amber `!`** marks each problem where it occurs.
- **A file that's invalid as a whole** (e.g. JSON with a stray comma that isn't JSONC) opens in **Raw**. A banner at the top of the card reads "Couldn't parse as JSON · showing Raw · line 12, col 4", and the error position is highlighted.
- **Nothing is ever silently dropped, reformatted or truncated.** Wherever a lens can't show something, it says so.

### 7.8 Empty state [Z18]
- **One card centered on the canvas:**
  - "Drop files or folders anywhere";
  - **Open file…** (with its Ctrl+O chip) and **Open folder…** buttons. Open folder has no shortcut;
  - **Recent files and folders** (up to 8), each with a format badge and a dimmed path. On first run, this section is omitted.
- **At rest there's no dashed zone.** While something is dragged over the window, a dashed **accent** outline traces the canvas.

### 7.9 File states
| State | What shows |
|---|---|
| Empty file (0 bytes, or only whitespace) | Card body: "Empty file" in `text.secondary`. Not a problem. |
| Binary or misnamed file (NUL bytes in the first 8KB, checked only after the BOM sniff, so UTF-16 files with a BOM never count; §5.3) | "Binary file · not shown", plus the §4.6 hand-off ("Open with default app", or only "Show in folder" for executables) |
| Missing file (restored session, or Ctrl+R) | "File not found at <path>", with **Locate…** and **Close** |
| Permission denied | "Can't read <path> · permission denied", with **Retry** and **Close** |
| Slow open (no first screen after 300ms, e.g. a network share) | A thin progress line under the header plus "Opening…". Input is never blocked, and the file can be closed. |
| Changed on disk, found on access | Before and after each lazy read (a file over 100MB, or scrolling a file-backed region), Typose checks the file's size, modified time and identity. It also verifies each re-read 1MiB chunk against the hash taken the first time that chunk was read, which catches in-place writes that metadata misses. On any difference, the card **freezes at its current content** and shows the banner "Changed on disk · Reload (Ctrl+R)". Copy is refused until Reload. Everything Typose displays or copies matches the version it first read. This is not watching [Z6]. |
| Unresolvable link | A dashed underline; hovering shows "Not found: <path>" |

**Typose never locks a file it's viewing.** On Windows, files are opened with read, write and delete sharing, so agents and editors can save, rename and replace them freely. Files are read with positional reads and **never memory-mapped**. A mapping blocks delete and replace on Windows, and can crash the reader when another process truncates the file elsewhere.

### 7.10 Settings [Z5]
- **Where it opens:** as a **tab** in the focused card, with a gear icon and a breadcrumb like `Settings / Appearance`.
- **Sections:**
  - **Appearance:**
    - a **live preview** at the top: a miniature card with sample md, csv and jsonl that updates as you change values (pattern: [Amie](https://mobbin.com/screens/2b71e067-9630-4408-8a90-095797b68eb8));
    - **theme: a Light slot and a Dark slot.** The OS mode picks which one applies, with an override: System / Always light / Always dark. Theme cards are drawn as "Aa" samples (pattern: [Twenty](https://mobbin.com/screens/f42390bf-a8f7-4cad-ad42-a95091b84285));
    - fonts and sizes;
    - **density**: Compact / Default / Spacious (pattern: [Discord](https://mobbin.com/screens/b78c80ab-7423-4e66-92c8-33cdd2a6d5da));
    - frame: card / flush;
    - **accent**: a color picker that warns when contrast drops below 4.5:1.
  - **Files:** show hidden files · CSV encoding fallback · default excludes for quick open.
  - **Lenses:** the default lens for each format.
  - **Shortcuts:** a read-only list in v1.
- **Applying changes:** every change **applies app-wide and persists immediately**. There's no Save button.
- **Backing store:** a TOML config file in the OS config directory.
  - Writes re-read the file and **edit the changed keys in place**, so comments and formatting are preserved.
  - Edits made by hand are picked up on launch and whenever the Settings tab gains focus.
  - If the file doesn't parse, a banner in Settings shows the line and column, and the app keeps the last good values.
- **Themes:**
  - **"Save as theme…"** exports the current tokens into `themes/`, and dropping a file into `themes/` makes it selectable.
  - Theme files carry `version = 1`. If a theme names a font that isn't installed, Typose falls back to Inter or JetBrains Mono and notes it in Settings.
  - v1 ships **Typose Dark** and **Typose Light**.
- **Not customizable through CSS.**

### 7.11 Print (Ctrl+P)
- **Prints the current lens's content for the chosen range (all of it when it fits), using the Light tokens** regardless of the active theme.
- **Grid:** prints every row in the range, repeating the header on each page.
- **Tree and Transcript:** print in their current expansion state.
- **Mermaid and KaTeX:** print as rendered.
- **The range comes first:** before any print document is built, Typose's print sheet shows the page estimate and the range: All, the pages around the current view, or a custom range.
  - A job is capped (proposed: **1,000 pages**). "All" is offered only when the whole file fits.
  - Over 50 pages, this sheet is the confirmation.
  - Only the chosen range is built, in batches, before the OS dialog opens.
- **Files still indexing:** print is disabled until indexing finishes.
- **PDF:** saving to PDF goes through the OS print dialog.

---

## 8. Performance and large files [Z17]

### 8.1 Budgets
| Budget | Target |
|---|---|
| **First screen, files ≤ 100MB** | **< 100ms in every *ready* lens [Z17]**, measured on a **named fixture set** (normal records up to 100MB per format).<br>"First screen" means the top of the file is rendered and scrollable. In Raw, it's the first bounded piece, visible and usable, with continuation available while scanning proceeds. A huge first line doesn't make Raw wait for the line's end [Z37]. Whole-file work (fold counts, sort, the Outline, value pills past row 1,000, full validation) completes **progressively in the background** and never blocks input. Until it's done, counts show `…`.<br>Markdown may render **provisionally** from the start of the file, then reconcile in place (a reference definition can sit at the end), keeping the reading position.<br>There is one file-backed architecture for every size. The 100MB line only decides which background work runs and which lenses unlock later. |
| Scrolling | 60fps with no dropped frames, in any lens and at any file size (virtualized everywhere).<br>Beyond the engine's height cap, scrolling is **logical**: wheel, trackpad and keys move 1:1, and the scrollbar gives coarse positioning.<br>A far jump (scrollbar, Outline, open-then-scroll) is held to the same standard, with accessibility mode on or off [Z52]. |
| Lens switch | < 50ms + the 90ms cross-fade, **to a ready lens**. Switching to a lens that isn't ready yet shows the progress line at once. |
| Cold start | **Shell visible < 400ms**, and **first restored lens content < 1s**.<br>Gated at half those values on Zack's PC, and at the full values on an Apple-silicon Mac (Z29). |
| Memory | Files over 100MB are file-backed and indexed, never fully parsed into memory. |

### 8.2 Files over 100MB [Z17]
| Format | Available immediately | Unlocks after indexing |
|---|---|---|
| md | Raw | Rendered |
| csv / tsv | Raw, **Grid unsorted** (the scrollbar grows as indexing proceeds) | sort, final row count |
| json | Raw | Tree, Table |
| jsonl | **Rows** (scrollbar grows), Raw | Table, Transcript |
| yaml | Raw | Tree, up to the YAML size ceiling (§5.5); above it Tree stays locked |

- **Indexing indicator:** a thin progress line under the card header plus "Indexing 1.2M lines…".
- **Locked lenses** are disabled in the lens switch, with the tooltip "Available after indexing".
- **When indexing finishes**, locked lenses unlock and the indicator disappears.
- **Restored sessions:** a tab whose remembered lens isn't available yet opens in the immediate lens, then **switches automatically** once indexing finishes, unless you've changed lenses in the meantime.
- **Input:** nothing blocks input, and the file can be closed mid-index.
- **Giant Markdown** [Z30]: Raw is immediate, and Rendered indexes in the background with the indicator and cancellation. About 20 seconds for 1GB is acceptable, but it isn't a deadline.

### 8.3 Multi-GB [Z23]
- Files of several GB open under the same rules [Z17].
- If indexing a heavy lens would exceed the memory budget, that lens stays disabled. The reason appears in its tooltip and in ⓘ.
- **The budget is aggregate:** 25% of physical RAM across **all open documents** and every resident structure (indexes, caches, sort orders, temporary parsing allocations). It is not 25% per tab [Z34].
- **When the limit is reached while building,** Typose stops building Rendered, explains why it's unavailable, and keeps Raw [Z34].

---

## 9. Accessibility 🔒

- **Contrast:**
  - Text and data tints meet WCAG AA (4.5:1) in both themes (§6.2; the light theme was corrected in revision 2).
  - Color is never the only carrier of meaning: pills always show their text, and problems use the `!` glyph as well as amber.
- **Keyboard:**
  - Every interactive element is keyboard reachable.
  - **Every hover affordance has a focus equivalent:** pill ✕, the code copy button, cell tooltips and the Outline pill.
- **Focus ring:** the accent, offset 2px outside the element. Full-bleed rows (grid, tree, Rows, sidebar) use a 2px **inset** ring instead, because an outside ring would be clipped by the neighbouring rows. On accent-colored elements it switches to `text`.
- **Screen readers:**
  - Roles: tablist (pills, lens switch), tree (Tree), grid (Grid), and **document semantics in Rendered and Transcript** (headings, lists, landmarks).
  - Heading navigation must work even though rendering is virtualized.
  - **"Document semantics for virtualized content" means full navigability,** not every node being in the DOM at once:
    - with a screen reader active, Rendered and Transcript render a wide window that follows the reader [Z33];
    - the Outline is always present in the accessibility tree;
    - keyboard focus loads its target before moving.
  - **Grid and Rows:**
    - Every data cell is reachable by keyboard. Continuous "read all" across them isn't a v1 requirement [Z33].
    - The row-number column is column 1, so the first data column is announced as "column 2" with its name [Z32].
  - **Testing** [Z39, superseding Z35]:
    - Before launch, accessibility is verified by automated checks: semantics, axe, accessibility-tree reads, keyboard and focus.
    - Testing with real screen readers (NVDA, Narrator, VoiceOver) is **parked until after launch** as an expansion (§2). Until it runs, Typose doesn't claim verified screen-reader support.
- **Layout limits:** `prefers-reduced-motion` is honored. Zoom to 200% (§6.5) doesn't break the layout. The minimum window is 720×480.

---

## 10. Screens for the Claude Design pass

**Content:** use the mockup workspace (`pulse-launch`: `launch-plan.md`, `tasks.csv`, `run-0412.jsonl`, `agent.yaml`, `schema.json`).
- For the Transcript, the session file (`session-7f3a.jsonl`) must be shaped like a **Claude Code session**: user text, then assistant text + thinking + `tool_use` (Read `launch-plan.md`) with its nested `tool_result`, and one collapsed sidechain.
- Unless noted, each screen comes in **dark and light**.

1. **Main view (Windows):** the title bar with ☰, the sidebar, md **Rendered** | csv **Grid**, and tab pills on the canvas. Start from ref 02, applying the §11 Ignore notes.
2. **Link peek:** the `tasks.csv` peek over the md card, with the scrim and full header actions. Include a second variant with the **←** back control.
3. **JSONL:** **Rows** (one row expanded); **Transcript** for a Claude Code session; and **Transcript** for an OpenAI chat dataset, showing two conversation dividers, a collapsed system prompt and a `tool_calls` call with its nested result.
4. **Tree:** `agent.yaml` (comments, a tag badge, a collapsed alias) and `schema.json`, with fold counts and indent guides.
5. **Markdown extras:** frontmatter block, callouts, Mermaid, KaTeX, a filled code block, and the Outline pill expanded into its rail [Z20].
6. **Empty state** (§7.8), at rest and during drag-over.
7. **Settings:** Appearance with the live preview, the Files section, and the config parse-error banner.
8. **Problems and info:** a normal ⓘ popover; a JSONL with problems (amber ⓘ dot, inline `!` row, grouped popover); the whole-file-invalid Raw banner.
9. **Large file:** the indexing indicator, with locked lenses disabled and their tooltip.
10. **Overlays:** quick open (Ctrl+O, Browse… pinned) and the command palette (Ctrl+K).
11. **Find:** the find bar in Grid (cell matches) and in Tree (current match expanded); Go to row.
12. **Layout stress:** three cards at 1280px wide; a card at minimum width with the lens dropdown; a narrow peek with icon actions; a long pill row with the ⌄ overflow; two `README.md` pills.
13. **Title bars:** macOS (traffic lights + native menu bar) and Linux (GNOME close-only, plus the native-decoration fallback). Dark only.
14. **States sheet:** empty file, binary file, missing file, missing root, permission denied, slow open, the "Changed on disk" banner, an unresolvable-link hover, and the hand-off sheet for an executable.
15. **Interaction states:** hover and selection for rows, tree nodes, pills and grid cell ranges, plus focus rings.
16. **`flush` frame variant** of screen 1. Dark only.

---

## 11. References

**Every file below is in [`docs/design/refs/`](../../design/refs/).** Use each one only for the listed purpose. The **Ignore** column lists where the image contradicts this spec; where they conflict, the spec wins.

| File | Use for | Ignore |
|---|---|---|
| `00-inspiration-*.png` (4, the user's own screenshots) | The **visual DNA**: the tab-pill and segmented-control style (Doc/Table), breadcrumb header, pill tints, spacing, softness, border contrast | Agent avatars, spend meter, "Accept all", presence count. The content is an editor's; Typose is a viewer. |
| `02-frame-card-pane-header.png` | **Primary:** card framing, the one-row breadcrumb + lens-switch header | The grid's rounded border (grids sit flush); the code block's border (code blocks are filled, borderless); the gray active-segment label (it should be the accent label); the yaml sidebar icon (use a list icon); the missing tab pills, ⓘ and state slot |
| `01-frame-hybrid.png` | The `flush` frame variant | The missing tab strip (flush puts pills in a 36px strip at the top of each pane) |
| `03-link-peek.png` | Peek placement and the "Open as tab" + ✕ actions | The VS Code-style tab strip (pills sit on the canvas); the missing lens switch, ⓘ and "Open to side"; the undimmed underlying card (it should have the scrim); the ~52% width (§4.5); the grid border |
| `04-lenses-jsonl-yaml.png` | The Rows lens row anatomy and the YAML Tree structure | The tiling layout; key and value colors (keys are `text`, values use the data tints, never the accent); the MD/CSV/… badge chips (use the lens switch instead); the dashed indent guides (use 1px solid) |
| `05-trail-spine.png` | Not used in v1 (expansion item 9) | Everything |

**Patterns from Mobbin** (web apps only; Mobbin has no desktop category):
- Cofounder file viewer, the closest existing analog: [preview](https://mobbin.com/screens/40a3e649-36ff-4edc-b823-920c2beae01c), [raw](https://mobbin.com/screens/3f5d8cca-a1f7-43f4-bfef-a389822629b9).
- Lens switches: [Mistral Document AI](https://mobbin.com/screens/9d1334ff-fc93-4b2a-99b3-f16e2deedd10), [Neon](https://mobbin.com/screens/99207d7b-1120-484d-a1a8-e4cf16213d3d).
- Grid: [Asana CSV preview](https://mobbin.com/screens/0bfd3c3e-19c8-4dca-9268-dd0281e47705), [Airtable](https://mobbin.com/screens/7ed8c2ae-d0e9-44ef-b2b6-8a5881f4b856), [Notion](https://mobbin.com/screens/792336a7-3064-4872-95c3-4387f9b344d0).
- JSONL and logs: [Cloudflare](https://mobbin.com/screens/df651388-aa38-4859-a81f-684a2ba5d931), [WorkOS](https://mobbin.com/screens/a5b50327-60e0-4075-9cfd-7f383d18265c).
- Transcripts: [LangSmith](https://mobbin.com/screens/530a288a-6583-435f-8df7-dc6a87393516), [Browserbase](https://mobbin.com/screens/ea823985-9a01-448b-816e-2e97782e435e).
- Tree: [StackAI](https://mobbin.com/screens/5ef8b027-f8ea-4a46-9c11-ab04084430c2), [Midday](https://mobbin.com/screens/23b62690-a1a4-4246-8e8f-78a8eb1ab947).
- Outline: [Obvious](https://mobbin.com/screens/cf1f91e1-dfc8-425f-a5c7-5c3305bff52a), [Snowflake](https://mobbin.com/screens/6a3dbefc-1f05-4e82-8a99-4e261bb86eeb).
- Palette: [Magnific](https://mobbin.com/screens/e22e26e2-f813-4f1e-beda-43c9ecf26419), [Mintlify](https://mobbin.com/screens/7c7ad31f-9dfe-4be7-83d7-6002fe31d4d0).
- Settings: [Amie](https://mobbin.com/screens/2b71e067-9630-4408-8a90-095797b68eb8), [Discord](https://mobbin.com/screens/b78c80ab-7423-4e66-92c8-33cdd2a6d5da), [Twenty](https://mobbin.com/screens/f42390bf-a8f7-4cad-ad42-a95091b84285).
- Future diff lens: [Semrush](https://mobbin.com/screens/ed82aafc-c4dc-442d-87fc-359f7347f940).

---

## 12. Constraints this places on the stack spec

- **Theming** is token-based [Z5], so it doesn't force a webview.
- **Accessibility is a hard gate** (§9). The UI layer must expose full platform accessibility trees (UIA on Windows, AX on macOS, AT-SPI on Linux), including document semantics for virtualized content. A native GPU UI is viable **only if** its accessibility layer meets §9.
- **Rendering:** Mermaid and KaTeX (§5.2) are web-native libraries. A native UI needs an embedded web surface for them, or native equivalents with the same hardening (§4.6). Print (§7.11) needs paginated rendering for every lens.
- **Files:** large files need file-backed indexing with non-locking handles (§7.9), on-access change checks, a streaming parser for every format so first screens meet the §8.1 budget, and a background indexer.
- **Distribution:** single instance on all three OSes; registration as an "Open with" handler; per-OS title bars and menus (§3.1–3.2), including the Linux decoration fallback.
- **Typose issues no requests** unless the user clicks to load remote images (§4.6). A CI check enforces this: the app's network log may show no outside request, DNS lookup or socket connection. OS-level actors (certificate checks, network printers, the OS opening user-clicked URLs) are outside Typose's control.

## 13. Open questions (not blocking Claude Design)
1. ~~The cold-start budget (§8.1): is 400ms right, and on what reference hardware?~~ Resolved in revision 4: shell visible in < 400ms and first restored content in < 1s, on the reference machines in Z29.
