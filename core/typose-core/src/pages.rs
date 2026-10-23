//! Bounded pages (spec §3.4, plan C2): an item covers at most `PIECE_BYTES` source bytes, excluding its line
//! terminator, and a page at most `PAGE_BYTES` and `MAX_ITEMS` items. The first item always fits.
use crate::bytemap::ByteMap;
use crate::encoding::{decode_prefix, newline_and_cr, newline_ends};
use crate::index::{LineIndex, locate_line};
use crate::store::{ByteStore, StoreError};

/// Spec §3.4's "64KiB of text", in source bytes (plan C2).
pub const PIECE_BYTES: usize = 65_536;
/// Spec §3.4's "256KiB" page, in source bytes summed over the page's items.
pub const PAGE_BYTES: usize = 262_144;
/// An empty line costs no source bytes but still an item and a map, so without a count the wire size has no bound.
pub const MAX_ITEMS: usize = 1_024;

/// The most bytes a wire map's `points` (`bytemap::WireMap`) takes for an item covering `bytes` source bytes.
/// A Raw decode's elements are a char or one U+FFFD, so the densest map is all surrogate pairs: 3 breakpoints per
/// 4 bytes, plus the first, at 2 `u32`s each. A uniform map's pair list is smaller (1 `u32` per 4 bytes).
pub const fn map_max(bytes: usize) -> usize {
    8 * (1 + 3 * bytes / 4)
}

/// One item's map at most: 393,224 bytes.
pub const MAP_MAX: usize = map_max(PIECE_BYTES);

/// An upper bound on one item's structured-clone bytes besides its text and map points: the keys, the numbers
/// (each at most a tag and 8 bytes), the map's kind and the typed array's header. Measured in the Node wire test.
pub const ITEM_WIRE_FIXED: usize = 256;

/// Plan C2's wire bound, from the actual representation: a page `{items}` whose items are `{gen, line, offset,
/// text, more, map}`. Text is at most 2 bytes per UTF-16 unit and a unit per source byte; the map is at most
/// `map_max(bytes)`, which is 8 + 6 bytes per source byte; and the source bytes sum to at most `PAGE_BYTES`.
/// So the sum, not `MAX_ITEMS` × `MAP_MAX`, bounds a page (2,367,552 bytes). Nothing preallocates from it.
pub const PAGE_WIRE_MAX: usize = 64 + MAX_ITEMS * (ITEM_WIRE_FIXED + 8) + PAGE_BYTES * (2 + 6);

/// The decoder settles an element within 4 bytes of its start (UTF-8's longest sequence, a UTF-16 pair), and a
/// newline is at most 2 more: reading this far past a piece shows where it can end.
const LOOKAHEAD: usize = 8;

/// The three page bounds. Tests shrink them; everything else uses `Caps::DEFAULT`.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub piece: usize,
    pub page: usize,
    pub items: usize,
}

impl Caps {
    pub const DEFAULT: Caps = Caps { piece: PIECE_BYTES, page: PAGE_BYTES, items: MAX_ITEMS };
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinePiece {
    pub line: u64,
    pub offset: u64,
    pub text: String,
    /// Maps `text` back to file bytes (spec §3.2); a first line's BOM and every line's `\r` lie outside it.
    /// The piece covers `offset..map.end_byte(map.units())`, BOM included.
    pub map: ByteMap,
    /// The line goes on past this piece.
    pub more: bool,
}

pub fn lines(store: &ByteStore, index: &LineIndex, start: u64, count: usize) -> Result<Vec<LinePiece>, StoreError> {
    lines_with(store, index, start, count, Caps::DEFAULT)
}

/// Up to `count` lines from `start`, within `caps`. A line longer than a piece shows its first piece, cut at the
/// last element boundary of the whole line's decode at or before `caps.piece` (plan C3), with `more` set.
pub fn lines_with(
    store: &ByteStore,
    index: &LineIndex,
    start: u64,
    count: usize,
    caps: Caps,
) -> Result<Vec<LinePiece>, StoreError> {
    let mut out = Vec::new();
    // Line 0 starts at byte 0, so the first page needs no index: `open` returns it at once (Z37).
    let first = if start == 0 { Some(0) } else { locate_line(store, index, start)? };
    let Some(mut offset) = first else { return Ok(out) };
    let (nl, cr) = newline_and_cr(index.encoding);
    let (mut line, mut page_bytes) = (start, 0usize);
    while offset < store.len() && out.len() < count.min(caps.items) {
        let bytes = store.read(offset, offset + (caps.piece + LOOKAHEAD) as u64)?;
        let newline = newline_ends(index.encoding, offset, &bytes).next();
        // The line's text, and whether `text` is all of it. Without a newline in reach, it ends here only at EOF.
        let (text, complete) = match newline {
            Some(last) => {
                let i = last + 1 - nl.len();
                (bytes[..i].strip_suffix(cr).unwrap_or(&bytes[..i]), true)
            }
            None => (&bytes[..], offset + bytes.len() as u64 >= store.len()),
        };
        let (slice, used) = decode_prefix(text, index.encoding, offset, caps.piece, complete);
        if !out.is_empty() && page_bytes + used > caps.page {
            break;
        }
        out.push(LinePiece { line, offset, text: slice.text, map: slice.map, more: used < text.len() || !complete });
        page_bytes += used;
        offset = match newline {
            Some(last) => offset + last as u64 + 1,
            None if complete => break,
            None => match locate_line(store, index, line + 1)? {
                Some(next) => next,
                None => break, // the index hasn't found the next line yet
            },
        };
        line += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::decode;
    use crate::index::{IndexConfig, build};
    use crate::store::testutil::temp_file;
    use encoding_rs::{Encoding, UTF_16BE, UTF_16LE};
    use proptest::prelude::*;
    use std::fs::File;
    use std::sync::RwLock;

    fn open(name: &str, bytes: &[u8]) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::default());
        build(&File::open(&path).unwrap(), store.len(), IndexConfig::default(), &store.hashes(), &shared, |_| {})
            .unwrap();
        (store, shared.into_inner().unwrap())
    }

    #[test]
    fn lines_strip_crlf_and_start_anywhere() {
        let (store, idx) = open("crlf", b"one\r\ntwo\r\nthree");
        let got = lines(&store, &idx, 1, 10).unwrap();
        assert_eq!(got.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["two", "three"]);
        assert!(got.iter().all(|p| !p.more));
        assert_eq!(got[0].offset, 5);
    }

    #[test]
    fn a_huge_line_is_one_bounded_piece_and_the_next_line_follows() {
        let mut bytes = vec![b'x'; 100_000];
        bytes.extend_from_slice(b"\nshort\n");
        let (store, idx) = open("huge", &bytes);
        let got = lines(&store, &idx, 0, 10).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].text.len(), PIECE_BYTES);
        assert!(got[0].more);
        let map = ByteMap::Uniform { start: 100_001, unit_bytes: 1, units: 5, pairs: vec![] };
        assert_eq!(got[1], LinePiece { line: 1, offset: 100_001, text: "short".into(), map, more: false });
    }

    #[test]
    fn a_page_stops_at_256_kib() {
        let line = format!("{}\n", "y".repeat(60_000));
        let (store, idx) = open("page-cap", line.repeat(10).as_bytes());
        assert_eq!(lines(&store, &idx, 0, 10).unwrap().len(), 4); // 4 × 60,000 ≤ 256 KiB < 5 × 60,000
    }

    #[test]
    fn while_scanning_the_partial_first_line_shows_its_first_piece_and_continues() {
        // Z37: a 3 MiB first line, indexed 1 MiB at a time. At the first progress event its newline isn't found yet,
        // but it already counts as a line, and `lines` returns its first piece.
        let mut bytes = vec![b'x'; 3 << 20];
        bytes.extend_from_slice(b"\nshort\n");
        let path = temp_file("mid-index", &bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::default());
        let cfg = IndexConfig { block: 1 << 20, ..IndexConfig::default() };
        let mut first = None;
        build(&File::open(&path).unwrap(), store.len(), cfg, &store.hashes(), &shared, |p| {
            if first.is_none() {
                let idx = shared.read().unwrap();
                let page = lines(&store, &idx, 0, 10).unwrap();
                first = Some((p.lines, idx.newlines, page));
            }
        })
        .unwrap();
        let (count, newlines, page) = first.unwrap();
        assert_eq!((count, newlines, page.len()), (1, 0, 1));
        assert_eq!((page[0].line, page[0].offset, page[0].text.len(), page[0].more), (0, 0, PIECE_BYTES, true));
    }

    /// C3: a first piece ends at an element boundary of the whole line's decode, so it never shows a U+FFFD the
    /// line doesn't have, never splits a surrogate pair and never starts the next piece at an odd UTF-16 offset.
    #[test]
    fn a_first_piece_never_splits_an_element() {
        let utf16le = |s: &str| s.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
        // (the line, its newline): each line has a multi-byte element straddling PIECE_BYTES.
        let cases: [(Vec<u8>, &[u8], &'static Encoding); 3] = [
            ((["x".repeat(PIECE_BYTES - 1), "€€".into()].concat().into_bytes()), b"\n", encoding_rs::UTF_8),
            ((["x".repeat(PIECE_BYTES - 2), "😀😀".into()].concat().into_bytes()), b"\n", encoding_rs::UTF_8),
            (
                [b"\xFF\xFE".to_vec(), utf16le(&"x".repeat(PIECE_BYTES / 2 - 2)), utf16le("😀😀")].concat(),
                b"\n\0",
                UTF_16LE,
            ),
        ];
        for (i, (line, newline, encoding)) in cases.into_iter().enumerate() {
            let (store, idx) = open_encoded("first-piece", &[line.as_slice(), newline].concat(), encoding);
            let first = lines(&store, &idx, 0, 1).unwrap().remove(0);
            let whole = decode(&line, encoding, 0);
            assert!(first.more, "case {i}");
            assert!(whole.text.starts_with(&first.text), "case {i}: the piece isn't a prefix of the line");
            assert_eq!(
                first.text.matches('\u{FFFD}').count(),
                whole.text[..first.text.len()].matches('\u{FFFD}').count(),
                "case {i}"
            );
            assert!(first.map.end_byte(first.map.units()) <= PIECE_BYTES as u64, "case {i}");
        }
    }

    fn open_encoded(name: &str, bytes: &[u8], encoding: &'static Encoding) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex { encoding, ..LineIndex::default() });
        build(&File::open(&path).unwrap(), store.len(), IndexConfig::default(), &store.hashes(), &shared, |_| {})
            .unwrap();
        (store, shared.into_inner().unwrap())
    }

    #[test]
    fn utf16_lines_decode_with_maps_past_the_bom_and_cr() {
        for (bom, encoding, be) in [(b"\xFF\xFE", UTF_16LE, false), (b"\xFE\xFF", UTF_16BE, true)] {
            let body = "Ċ first\r\nsecond 😀\nਊ"
                .encode_utf16()
                .flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
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

    /// C2: an empty line costs no source bytes, so only the item count stops a page of them.
    #[test]
    fn a_page_of_empty_lines_stops_at_max_items() {
        let (store, idx) = open("empty-lines", &b"\n".repeat(3 * MAX_ITEMS));
        assert_eq!(idx.line_count(), 3 * MAX_ITEMS as u64);
        let got = lines(&store, &idx, 0, usize::MAX).unwrap();
        assert_eq!(got.len(), MAX_ITEMS);
        assert!(got.iter().all(|p| p.text.is_empty() && !p.more));
    }

    /// C2 and C3 with the real caps: 70,000 bytes of CJK cut at a character, and four such pieces fill a page.
    #[test]
    fn long_cjk_lines_cut_at_a_character_and_four_pieces_fill_a_page() {
        let line = "語".repeat(70_000 / 3);
        let (store, idx) = open("cjk-lines", format!("{line}\n").repeat(6).as_bytes());
        let got = lines(&store, &idx, 0, MAX_ITEMS).unwrap();
        assert_eq!(got.len(), 4); // 4 × 65,535 ≤ 262,144 < 5 × 65,535
        for p in &got {
            assert_eq!((p.text.chars().count(), p.more), (65_535 / 3, true));
            assert_eq!(p.map.end_byte(p.map.units()) - p.offset, 65_535);
        }
    }

    /// One of the five Raw encodings, as bytes with newlines in them, mixing valid, astral and malformed text.
    fn any_file() -> impl Strategy<Value = (Vec<u8>, &'static Encoding)> {
        let utf8 = prop::collection::vec(
            prop_oneof![
                6 => any::<char>().prop_map(|c| c.to_string().into_bytes()),
                2 => Just(b"\n".to_vec()),
                1 => Just(b"\r\n".to_vec()),
                1 => prop::sample::select(vec![vec![0xE2, 0x82], vec![0xF0, 0x9F, 0x98], vec![0x80], vec![0xC0, 0x80], vec![0xFF]]),
            ],
            0..200,
        )
        .prop_map(|atoms| (atoms.concat(), encoding_rs::UTF_8));
        let w1252 = prop::collection::vec(prop_oneof![4 => any::<u8>(), 1 => Just(b'\n')], 0..400)
            .prop_map(|b| (b, encoding_rs::WINDOWS_1252));
        let utf16 = (
            prop::collection::vec(
                prop_oneof![
                    6 => any::<char>().prop_map(|c| c.encode_utf16(&mut [0; 2]).to_vec()),
                    2 => Just(vec![0x000A]),
                    1 => Just(vec![0x000D, 0x000A]),
                    1 => (0xD800u16..0xE000).prop_map(|u| vec![u]), // a lone surrogate
                    1 => prop::sample::select(vec![vec![0x010A], vec![0x0A0D]]), // 0x0A bytes that aren't newlines
                ],
                0..200,
            ),
            any::<bool>(),
            any::<bool>(),
        )
            .prop_map(|(units, be, bom)| {
                let bytes = units.concat().into_iter().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
                let bom: &[u8] = match (bom, be) {
                    (false, _) => b"",
                    (true, false) => b"\xFF\xFE",
                    (true, true) => b"\xFE\xFF",
                };
                (bom.iter().copied().chain(bytes).collect(), if be { UTF_16BE } else { UTF_16LE })
            });
        prop_oneof![utf8, w1252, utf16]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_000))]

        /// C2: every page holds its byte and count caps, and every item's text has no more UTF-16 units than its
        /// source bytes, with a map within `map_max`. C3 (PR 1's part): a first piece is the whole line's decode
        /// cut at its last element boundary within the piece cap.
        #[test]
        fn pages_hold_their_caps_and_first_pieces_cut_at_the_lines_elements(
            (bytes, encoding) in any_file(),
            piece in 8usize..48,
            page_pieces in 1usize..5,
            items in 1usize..9,
        ) {
            let caps = Caps { piece, page: piece * page_pieces, items };
            let (store, idx) = open_encoded("c2-prop", &bytes, encoding);
            let (nl, cr) = newline_and_cr(encoding);
            let mut start = 0u64;
            while start < idx.line_count() {
                let page = lines_with(&store, &idx, start, usize::MAX, caps).unwrap();
                prop_assert!(!page.is_empty() && page.len() <= items, "{} items", page.len());
                let mut page_bytes = 0;
                for (k, p) in page.iter().enumerate() {
                    prop_assert_eq!(p.line, start + k as u64);
                    let used = (p.map.end_byte(p.map.units()) - p.offset) as usize;
                    prop_assert!(used <= piece, "item covers {} > {}", used, piece);
                    prop_assert!(p.map.units() as usize <= used, "{} units from {} bytes", p.map.units(), used);
                    prop_assert!(p.map.to_wire().points.len() * 4 <= map_max(used));
                    page_bytes += used;
                    // The whole line, decoded alone: the piece must be its prefix, ending at one of its elements.
                    let tail = &bytes[p.offset as usize..];
                    let end = newline_ends(encoding, p.offset, tail).next().map_or(tail.len(), |last| last + 1 - nl.len());
                    let line = tail[..end].strip_suffix(cr).filter(|_| end < tail.len()).unwrap_or(&tail[..end]);
                    let whole = decode(line, encoding, p.offset);
                    let units = p.map.units();
                    prop_assert!(whole.text.starts_with(&p.text));
                    prop_assert_eq!(p.map.end_byte(units), whole.map.start_byte(units), "not cut at an element boundary");
                    prop_assert_eq!(p.more, units < whole.map.units());
                    if p.more {
                        prop_assert!((whole.map.end_byte(units + 1) - p.offset) as usize > piece, "the cut isn't the last boundary");
                    }
                }
                prop_assert!(page_bytes <= caps.page || page.len() == 1, "page covers {}", page_bytes);
                start += page.len() as u64;
            }
        }
    }
}
