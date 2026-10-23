//! Sniffing and decoding (spec §4.1, brief §5.3): BOM, then NUL ⇒ binary, then valid UTF-8, then the fallback.
//! `decode` returns text plus its byte map (spec §3.2). Each malformed sequence becomes one U+FFFD that maps
//! to exactly the bytes it replaced.
use encoding_rs::{DecoderResult, Encoding, UTF_8, UTF_16BE, UTF_16LE};
use memchr::{memchr, memchr_iter, memmem};

use crate::bytemap::{ByteMap, MapBuilder};

/// Spec §4.1: a NUL in the first 8KB marks a file binary, unless a UTF-16 BOM came first.
pub const NUL_WINDOW: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sniffed {
    Binary,
    /// `bom` is the BOM's length in bytes, 0 without one.
    Text {
        encoding: &'static Encoding,
        bom: usize,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextSlice {
    pub text: String,
    pub map: ByteMap,
    /// U+FFFD substitutions. Each one is a problem (brief §7.7).
    pub replacements: u32,
}

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
    decode_prefix(bytes, encoding, start_offset, usize::MAX, true).0
}

/// Like `decode`, but stops at the last element boundary within `max` bytes (a BOM included) and returns how many
/// bytes the slice covers. An element is a char or one U+FFFD with the bytes it replaced.
///
/// With `last = false`, `bytes` is the start of a longer line. The decoder streams (WHATWG), so the elements it
/// finishes are the whole line's; a sequence that could continue past `bytes` stays unfinished and isn't output.
/// That's how a piece is cut at the whole line's element boundaries (plan C3): decoding a truncated prefix as
/// complete would turn `E2 82 | AC` into a U+FFFD that the line doesn't have. `max` must exceed the BOM.
pub fn decode_prefix(
    bytes: &[u8],
    encoding: &'static Encoding,
    start_offset: u64,
    max: usize,
    last: bool,
) -> (TextSlice, usize) {
    let bom = match Encoding::for_bom(bytes) {
        Some((e, n)) if e == encoding && start_offset == 0 => n,
        _ => 0,
    };
    let src = &bytes[bom..];
    let budget = max - bom;
    if encoding.is_ascii_compatible() && src.is_ascii() {
        // The common case at memcpy speed: a 64 KiB ASCII piece takes ~35 µs here, ~175 µs char by char.
        // Every ASCII byte is its own element in UTF-8 and the single-byte encodings, whatever follows it.
        let src = &src[..src.len().min(budget)];
        let map = ByteMap::Uniform {
            start: start_offset + bom as u64,
            unit_bytes: 1,
            units: src.len() as u32,
            pairs: Vec::new(),
        };
        return (TextSlice { text: String::from_utf8_lossy(src).into_owned(), map, replacements: 0 }, bom + src.len());
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
    let (mut text, mut pos, mut used, mut replacements) = (String::with_capacity(src.len().min(budget)), 0, 0u64, 0);
    let budget = budget as u64;
    // A small fixed buffer: `decode_to_string_*` touches every page of the String's spare capacity on each
    // call, and hostile input makes one call per malformed byte, which would be quadratic.
    let mut scratch = "\0".repeat(4096);
    'decode: loop {
        let (result, read, written) = decoder.decode_to_str_without_replacement(&src[pos..], &mut scratch, last);
        for (i, c) in scratch[..written].char_indices() {
            let n = source_len(c);
            if used + n > budget {
                text.push_str(&scratch[..i]);
                break 'decode;
            }
            map.push(c.len_utf16() as u32, n);
            used += n;
        }
        text.push_str(&scratch[..written]);
        pos += read;
        match result {
            DecoderResult::InputEmpty => break,
            DecoderResult::OutputFull => {}
            DecoderResult::Malformed(bad, _) => {
                // Bytes consumed after the bad ones haven't produced output yet, so order is kept.
                if used + u64::from(bad) > budget {
                    break;
                }
                text.push('\u{FFFD}');
                map.push(1, u64::from(bad));
                used += u64::from(bad);
                replacements += 1;
            }
        }
    }
    (TextSlice { text, map: map.finish(), replacements }, bom + used as usize)
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
        unit => {
            Box::new(memmem::find_iter(bytes, unit).filter(move |&i| (at + i as u64).is_multiple_of(2)).map(|i| i + 1))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytemap::naive_endpoints;
    use encoding_rs::WINDOWS_1252;
    use proptest::prelude::*;
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
            (b"a\xF0\x9F\x98", "a\u{FFFD}", &[0, 1, 4]), // truncated 4-byte sequence: 3 bytes
            (b"\xE2\x82A", "\u{FFFD}A", &[0, 2, 3]),     // truncated 3-byte sequence: 2 bytes
            (b"\xC0\x80", "\u{FFFD}\u{FFFD}", &[0, 1, 2]), // overlong: C0 is never valid
            (b"\xE0\x80\x80", "\u{FFFD}\u{FFFD}\u{FFFD}", &[0, 1, 2, 3]), // overlong 3-byte
            (b"\xED\xA0\x80", "\u{FFFD}\u{FFFD}\u{FFFD}", &[0, 1, 2, 3]), // a surrogate encoded in UTF-8
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
            0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152, 0x8D,
            0x17D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122, 0x161, 0x203A,
            0x153, 0x9D, 0x17E, 0x178,
        ];
        let char_of = |b: u8| if (0x80..0xA0).contains(&b) { HIGH[usize::from(b) - 0x80] } else { u16::from(b) };
        bytes.iter().map(|&b| (char::from_u32(u32::from(char_of(b))).unwrap(), 1, false)).collect()
    }

    /// Decodes `bytes` at `start` and compares text, replacement count and every endpoint with the reference.
    fn gate(
        bytes: &[u8],
        encoding: &'static Encoding,
        start: u64,
        reference: impl Fn(&[u8]) -> Vec<(char, u64, bool)>,
    ) -> Result<(), TestCaseError> {
        let bom = match Encoding::for_bom(bytes) {
            Some((e, n)) if e == encoding && start == 0 => n, // spec §4.1: a file-start BOM isn't text
            _ => 0,
        };
        let want = reference(&bytes[bom..]);
        let got = decode(bytes, encoding, start);
        prop_assert_eq!(&got.text, &want.iter().map(|e| e.0).collect::<String>());
        prop_assert_eq!(got.replacements as usize, want.iter().filter(|e| e.2).count());
        let elements: Vec<(u32, u64)> = want.iter().map(|&(c, n, _)| (c.len_utf16() as u32, n)).collect();
        let ours: Vec<(u64, u64)> =
            (0..=got.map.units()).map(|u| (got.map.start_byte(u), got.map.end_byte(u))).collect();
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
        let bom = if !bom {
            vec![]
        } else if be {
            vec![0xFE, 0xFF]
        } else {
            vec![0xFF, 0xFE]
        };
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
}
