# Embedded images plan, Z43 (2026-11-05)

**Goal:** embedded images render within Z43's per-image caps:
- Rendered shows inline `data:` images;
- Transcript shows a session's embedded images, such as pasted screenshots.

Both go through the bounded image path that local images already use. This follows M5 (`2026-11-04-transcripts.md`).

**Baseline:** main `f904797`.

## What exists (verified on main)
- **`images.rs`.**
  - `decode()` identifies PNG, JPEG, GIF and WebP by their magic bytes.
  - Its caps are `MAX_SOURCE` (8 MiB), `MAX_PIXELS` (16,777,216) and `MAX_PIXEL_BUFFERS` (64 MiB).
  - It emits a canonical PNG of at most 8 MiB.
- **`image_resource.rs`.**
  - `prepare()` reads a local file through `LocalRoute` into a charged `Snapshot`, then decodes it under the single codec permit and verifies it.
  - `Resources` holds two slots and serves 256 KiB chunks.
- **Wiring.** The napi method is `prepare_image` (typose-node `lib.rs`). The core host's `prepareImage`, `imageChunk` and `releaseImage` (`dispatch.ts`) are typed in `protocol.ts`.
- **`RenderedImages`** (`lenses/images.ts`):
  - loads lazily, within 600 px, two at a time;
  - charges `5 × encoded + 2 × pixels` through `growRendered`;
  - shows the result as a Blob URL;
  - on a refusal, keeps the alt text and shows the reason.
- **Today:** `sanitize::image_target` drops a `data:` target, so the image reads "Unsupported image target". Transcript shows a placeholder for every image (#62 F6).

## Real data
Structure only, from 3,004 Claude Code session files on this PC:
- **Count:** 2,958 image blocks in 120 files. All are `source.type: "base64"`.
- **Media types:** JPEG 1,742, PNG 1,032, WebP 184.
- **Where they sit:** 2,266 in `message`, 688 in `toolUseResult`, 4 in an attachment.
- **Size:** the largest decodes to 511,818 bytes, so every one is under the caps.
- **Encoding:** no `data:` URLs, and no escaped base64.

## Rules
- **The payload never enters a fragment or the DOM.** A Rendered fragment, or a Transcript node, carries the source span of the payload, never the URL or the base64. The core reads those bytes from the document under its generation, as with any other request from the renderer.
- **What is accepted**, either as raw text or inside a JSON string:
  - a `data:image/(png|jpeg|gif|webp);base64,` URL;
  - a bare base64 payload (Claude's `source.data`).
- **Decoding:**
  - The base64 is strict.
  - The image format comes from its magic bytes in `images::decode`, never from a declared type.
  - A declared SVG, or any other declared type, is refused with its reason.
- **Bounds before any read:**
  - the span is at most `ceil(MAX_SOURCE / 3) × 4` plus 64 header bytes;
  - the decoded payload is at most `MAX_SOURCE`;
  - the input is charged through the ledger, as `Snapshot` charges it;
  - one codec runs at a time.
- **A refused image** keeps its alt text, or "Image", and says why.
- **No network.** No new URL reaches the network stack.
- **Process:** Z84 and Z85, as in M5.

## PRs, in landing order

| # | PR | Scope | Size | Review |
|---|---|---|---|---|
| 1 | **Embedded images in Rendered** | **Core:** an embedded source for `image_resource` (span → base64 → `decode`). **napi and core host:** `prepareImage` takes a validated `span` as the alternative to `src`. **`md.rs`:** an inline or reference `data:` image emits its URL's span, never the URL. **Renderer:** `RenderedImages` loads it. **Tests:** core units (strict base64, header types, SVG refused, an over-bound span refused before any read, decoded size over the cap, charge back to 0); fragment tests showing no payload in the HTML; a host Vitest; e2e (PNG, JPEG, GIF and WebP shown; SVG, malformed and over-cap refused with their alt text and reason; no network effect). This plan lands here. | decent–large | Opus, 2 rounds (untrusted input, ledger) |
| 2 | **Embedded images in Transcript** | Claude `source` base64 blocks (the span of `source.data`) and OpenAI `image_url` data URLs load through the same path, in message content and in tool results. Each page's charge is released on page swap. Remote URLs keep their placeholder. **Tests:** e2e, plus the installed-build check on real sessions with images. | decent | Opus, 2 rounds (memory) |
| 3 | **Install** | Package, install, then open real sessions with images | small | PM |

## Out of scope
- **Remote images:** the §4.6 "Load remote images" bar and the main-process fetch session.
- **`<img src="data:…">` in raw HTML:** it stays refused, with its alt text kept.
- **`![](data:…)` inside Transcript text blocks:** their fragments are rendered from decoded JSON text, so no document span exists.
- **SVG.**

## Done when
PRs 1–3 have landed. On the installed build:
- Rendered shows a Markdown file's `data:` images within the caps;
- a refused image keeps its alt text and reason;
- Transcript shows the pasted screenshots in real sessions;
- nothing touches the network, and the lens's memory returns to 0 on close.
