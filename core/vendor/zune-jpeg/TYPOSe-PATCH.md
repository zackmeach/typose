# Typose patch to zune-jpeg 0.5.15

Upstream package: zune-jpeg 0.5.15, maintained decoder from
https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg.
Published package commit: 31d81fed7551c8ccea456d9d8e2b1fd8bebb6995,
subdirectory crates/zune-jpeg.
Crate archive SHA-256: 27bc9d5b815bc103f142aa054f561d9187d191692ec7c2d1e2b4737f8dbd7296.

Copied unchanged from that exact installed crate: src/, normalized Cargo.toml,
README.md, LICENSE-APACHE, LICENSE-MIT, and LICENSE-ZLIB. Registry metadata,
lockfiles, build artifacts, benchmarks and external test assets are excluded.
Original MIT, Apache-2.0 and Zlib licensing remains intact.

The local patch changes only entropy accounting and checked DC arithmetic in
src/bitstream.rs, strict baseline rejection in src/mcu.rs, and focused unit regressions. Upstream padded
lookahead, Huffman lookup tables, coefficient decoding, IDCT, sampling and fast
paths remain in use. The new synthetic-bit rejection applies only to strict
baseline decoding. Overflowing DC prediction or dequantization returns the
decoder's existing FormatStatic error instead of wrapping or panicking; other
invalid-data recovery remains with the maintained decoder.

At the first entropy marker in a segment, record the real buffered bits before
the decoder adds its EOI pad. Central bit-consumption operations decrement this
count and record any use of synthetic padding. Peeking does not consume bits.
The count survives an EOI marker being taken; restart reset clears it. Strict
baseline blocks reject synthetic consumption before IDCT and before restart
handling can reset the flag, including discarded components.

This prevents an early EOI/RST marker from supplying fabricated coefficient bits.
It does not introduce a pixel decoder or a separate JPEG format validator.

A separate executed integration probe found a debug-build multiplication panic
with a 1x65535 grayscale baseline image, Q=255 and repeated category11 DC(+2047).
Prediction addition and baseline DC dequantization now use checked arithmetic.
The fixture uses physical entropy bits throughout, so this regression is
independent of the marker-padding fix. Vendor tests cover both this case and the
prediction-addition limit. Root retains the integration-level refusal test.

Tests/builds were not run by the patch author. Root task owns execution and final
qualification, including valid short/partial-MCU/restart images and truncation
at DC, AC, amplitude and the last MCU.
