# Local images

The first Windows local-image slice serves static PNG, GIF and baseline JPEG. WebP stays labelled with its alt text and “WebP images are not supported yet”, as Zack chose after a valid noisy VP8 image delayed cancellation by 445 ms. Remote images remain unfetched. Inline data images remain deferred.

Images use the Markdown document’s existing local capability. A target cannot acquire another drive or follow a reparse point. The source is checked before and after the read and decode; a changed source raises the existing Reload banner. A changed or unsupported target keeps its alt text and refusal reason. Other platforms refuse local image access until their capability backend is qualified.

## Supported profiles

- PNG: noninterlaced 8-bit gray, gray-alpha, RGB, RGBA or indexed. At most one each of `pHYs` (9 bytes), `sRGB` (1 byte) and `gAMA` (4 bytes) is accepted and ignored, after IHDR and before IDAT; `sRGB` and `gAMA` also before PLTE. Animation, 16-bit/sub-byte samples, `iCCP`, `cHRM`, text and every other metadata chunk are refused.
- GIF: one full-canvas frame, with a valid palette and complete LZW stream. Animation, application extensions, excess pixels and missing end codes are refused.
- JPEG: baseline SOF0, one scan, gray or ordinary three-component 4:4:4, 4:2:2 or 4:2:0 sampling. A bounded JFIF header is allowed. An ICC profile in APP2 `ICC_PROFILE` segments before the scan is accepted and ignored: at most 16 segments and 256 KiB of profile, with consistent counts and every sequence number exactly once. The input wrapper removes those segments, so the decoder never parses them. Progressive/multiple scans, CMYK, Exif/XMP (APP1), other APP2 data such as MPF and gain maps, and APP13/APP14 are refused.
- Colour is not managed. Embedded profiles, gamma and rendering intent are discarded, and the samples are treated as sRGB, so a wide-gamut or non-sRGB image can look less saturated or shifted.

These are deliberate supported subsets, not a promise to decode every file with one of these extensions. The byte signature selects the decoder. Missing, malformed, unsupported or over-budget images preserve the reader.

## Bounds and ownership

The file snapshot and canonical output each have an 8 MiB ceiling. Dimensions must be nonzero and contain at most 16,777,216 pixels. Simultaneous native pixel and row buffers must fit 64 MiB; conservative codec work reservations can refuse an image below those ceilings. Codec state is separately charged before allocation. Exact pinned-source formulas are beside the adapters in `core/typose-core/src/images.rs`.

The native pipeline reads one bounded snapshot, decodes through maintained codecs and writes a fresh static PNG8. It strips source metadata. Source bytes, codec work and native pixels drop before resource metadata is published. The bounded encoder uses a fixed-capacity sink; its sticky failure prevents the pinned compressor’s internal writer-error unwrap from turning an output refusal into a panic.

Opaque references bind session, document and generation. Two pending or ready resources fit per document, with one codec job at a time. Canonical bytes stay charged until release and travel in aligned chunks of at most 256 KiB. No original image bytes, filesystem URL or inline resource payload enters the HTML.

Before requesting chunks, the renderer adds five encoded-byte copies and two RGBA pixel copies to the retained Rendered allowance. This covers host backing, transport, received chunks, Blob and decoder input, plus bitmap/cache copies. It is an explicit resource inventory, not a universal bound on Chromium or allocator overhead. Loaded blobs and their allowance survive Raw/Rendered switches. Close removes their sources and revokes their URLs; Reload carries the existing retired-tree allowance. Handoffs freeze new grants before taking that allowance’s snapshot.

## JPEG dependency patch

The pinned Zune decoder’s strict mode accepted early EOI by consuming synthetic zero bits. The counting-allocator cleanup case exposed that behavior. The exact published 0.5.15 source is vendored with its licenses and provenance. The narrow patch tracks real entropy-bit consumption and rejects synthetic consumption in strict baseline decoding before IDCT or restart reset. It also refuses DC arithmetic overflow. It preserves the maintained Huffman, coefficient, sampling and pixel decoder; there is no second entropy decoder.

`core/vendor/zune-jpeg/TYPOSe-PATCH.md` records the source and changes. Its short-image, final-MCU, partial-MCU, restart and arithmetic regressions run separately with `cargo test --manifest-path core/Cargo.toml --locked -p zune-jpeg --lib`; the crate is excluded from workspace formatting to preserve unchanged upstream source.

The JPEG input wrapper checks cancellation on read, buffered-read and seek operations. PNG/GIF validation and canonical encoding also check between bounded work units. Qualification must measure real codec work and cleanup; a pre-cancelled flag alone proves no latency bound.

## Acceptance evidence

The final PR records the exact committed head, native exit codes, allocation controls, packaged visual and full Windows gate. Focused tests cover supported formats, refusals and NetLog, two active loads, retained lens switches, low budgets, stale responses, source changes, handoff races and close cleanup. Image private-byte checks isolate the image allowance so Raw’s viewport reservation cannot conceal a missing image charge.

Maximum-size and entropy-stressed cancellation probes remain separate from ordinary decoder correctness tests. Their failed runs remain evidence. Windows evidence does not establish Mac or Linux acceptance, and the existing qualification debt and $0 spending cap remain in force.

The pre-commit release probe exercised accepted maximum-size PNG (4096×4093), GIF (4096×4096), and entropy-stressed JPEG (4096×4096, 7,455,671 source bytes). Cancellation was requested after codec setup; native work and cleanup completed 1.677 ms, 17.354 ms and 1.635 ms after the flag respectively. Those are observed Windows samples, not a scheduling guarantee or a substitute for final-head close tests. The previous JPEG sample without the input wrapper took 103.178 ms; the failed WebP samples remain evidence for its deferral.