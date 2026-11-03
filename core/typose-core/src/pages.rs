//! Bounded pages (spec §3.4, plan C2): an item covers at most `PIECE_BYTES` source bytes, excluding its line
//! terminator, and a page at most `PAGE_BYTES` and `MAX_ITEMS` items. The first item always fits.
//! A longer line continues in further pieces (plan C3), up to `LINE_SHOWN` bytes (brief §5.1).
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};

use crate::bytemap::ByteMap;
use crate::encoding::{bom_len, decode_prefix, newline_and_cr, newline_ends};
use crate::index::{LineIndex, locate_line};
use crate::store::{ByteStore, StoreError};

/// Spec §3.4's "64KiB of text", in source bytes (plan C2).
pub const PIECE_BYTES: usize = 65_536;
/// Spec §3.4's "256KiB" page, in source bytes summed over the page's items.
pub const PAGE_BYTES: usize = 262_144;
/// An empty line costs no source bytes but still an item and a map, so without a count the wire size has no bound.
pub const MAX_ITEMS: usize = 1_024;
/// Brief §5.1: a line shows its first 1 MiB in pieces; past that, "+N MB more on this line".
pub const LINE_SHOWN: usize = 1 << 20;
/// The most source bytes one element of a Raw decode takes (a UTF-8 char or a UTF-16 pair; a U+FFFD takes at most
/// 3). A piece with this much room always holds an element, so no continuation ever yields an empty piece.
const MAX_ELEMENT: usize = 4;

/// The most bytes a wire map's `points` (`bytemap::WireMap`) takes for an item covering `bytes` source bytes.
/// A Raw decode's elements are a char or one U+FFFD, so the densest map is all surrogate pairs: 3 breakpoints per
/// 4 bytes, plus the first, at 2 `u32`s each. A uniform map's pair list is smaller (1 `u32` per 4 bytes).
pub const fn map_max(bytes: usize) -> usize {
    8 * (1 + 3 * bytes / 4)
}

/// One item's map at most: 393,224 bytes.
pub const MAP_MAX: usize = map_max(PIECE_BYTES);

/// An upper bound on one item's structured-clone bytes besides its text and map points: the keys, the numbers
/// (each at most a tag and 8 bytes), the map's kind, the typed array's header and the continuation token, with the
/// session and document the core host adds. Measured in the Node wire test (264 bytes at most).
pub const ITEM_WIRE_FIXED: usize = 288;

/// Plan C2's wire bound, from the actual representation: a page `{items}` whose items are `{gen, line, offset,
/// text, more, map, next, rest}`. Text is at most 2 bytes per UTF-16 unit and a unit per source byte; the map is
/// at most `map_max(bytes)`, which is 8 + 6 bytes per source byte; and the source bytes sum to at most
/// `PAGE_BYTES`. So the sum, not `MAX_ITEMS` × `MAP_MAX`, bounds a page (2,400,320 bytes). Nothing preallocates
/// from it.
pub const PAGE_WIRE_MAX: usize = 64 + MAX_ITEMS * (ITEM_WIRE_FIXED + 8) + PAGE_BYTES * (2 + 6);

/// The decoder settles an element within 4 bytes of its start (UTF-8's longest sequence, a UTF-16 pair), and a
/// newline is at most 2 more: reading this far past a piece shows where it can end.
const LOOKAHEAD: usize = 8;

/// The longest path the core opens, in bytes: Windows' 32,767 UTF-16 units, at most 3 bytes each as UTF-8.
pub const MAX_PATH_BYTES: usize = 3 * 32_767;

/// Plan C1's temporaries of one page read in Rust, (a) and (b), which its page slot reserves (`budget::Work::Page`):
/// - (a) its reads at once: a continuation's read of its line's shown part (`piece`), a piece's own read (`cut`), a
///   line search's chunk (`locate_line`) and a chunk read from disk on its way into the cache;
/// - (b) the pieces of a page's source bytes, plus the piece that didn't fit: text at most 3 bytes per source byte (a
///   U+FFFD for one malformed byte), a map at most 13 (`MapBuilder`'s pair list, n / 4 `u32`s, then its breakpoints,
///   3 of 16 bytes per 4 bytes), and the wire map napi makes from it, 6; with the item arrays, Rust's and napi's;
/// - the identity check's copies of the path (`Document::verified`), and the decoder's scratch.
///
/// The counting-allocator test (`tests/ledger.rs`) checks a sum, at every allocation: the heap's live bytes past its
/// baseline, page reads' included, never pass what the ledger has charged, less the pool's free slots
/// (`budget::in_use`). It doesn't attribute memory to one read, so it doesn't check this bound on its own.
pub const PAGE_TEMP: usize = {
    let reads = (LINE_SHOWN + LOOKAHEAD) + (PIECE_BYTES + LOOKAHEAD) + 2 * crate::store::CHUNK;
    let source = PAGE_BYTES + PIECE_BYTES + (MAX_ELEMENT - 1) * (MAX_ITEMS + 1);
    let items = (MAX_ITEMS + 1) * (size_of::<LinePiece>() + ITEM_NAPI);
    reads + (3 + 13 + 6) * source + 16 * (MAX_ITEMS + 1) + items + 16 * MAX_PATH_BYTES + 64 * 1024
};

/// napi's `PageItem` for one item, beside the `LinePiece` it's made from: its struct and its map's wrapper.
const ITEM_NAPI: usize = 256;

/// The page bounds and the shown part of a line. Tests shrink them; everything else uses `Caps::DEFAULT`.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub piece: usize,
    pub page: usize,
    pub items: usize,
    pub line: usize,
}

impl Caps {
    pub const DEFAULT: Caps = Caps { piece: PIECE_BYTES, page: PAGE_BYTES, items: MAX_ITEMS, line: LINE_SHOWN };
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinePiece {
    pub line: u64,
    /// The piece's first byte: the line's for a first piece, a continuation's offset otherwise.
    pub offset: u64,
    pub text: String,
    /// Maps `text` back to file bytes (spec §3.2); a first line's BOM and every line's `\r` lie outside it.
    /// The piece covers `offset..map.end_byte(map.units())`, BOM included.
    pub map: ByteMap,
    /// The line goes on past this piece.
    pub more: bool,
    /// Where the next piece starts, while the line goes on within its shown part (plan C3's token offset).
    pub next: Option<u64>,
    /// When the line goes on past its shown part: the source bytes from this piece's end to the next line's start
    /// (or EOF), once the index knows where that is.
    pub rest: Option<u64>,
}

/// Where a line ends, as far as one piece's read can tell.
enum End {
    /// The next line starts here.
    Newline(u64),
    Eof,
    /// Past the read: the index may know where.
    Beyond,
}

/// The piece of `line` (which starts at `line_start`) that starts at `offset`, its source bytes, and where the line
/// ends. It ends at the last element boundary of the whole line's decode within `caps.piece` and within the line's
/// shown part (plan C3).
fn cut(
    store: &ByteStore,
    index: &LineIndex,
    line: u64,
    line_start: u64,
    offset: u64,
    caps: Caps,
) -> Result<(LinePiece, usize, End), StoreError> {
    let (nl, cr) = newline_and_cr(index.encoding);
    let shown_end = line_start + caps.line as u64;
    let room = caps.piece.min((shown_end - offset) as usize);
    let bytes = store.read(offset, offset + (room + LOOKAHEAD) as u64)?;
    // The line's text, and how it ends. Without a newline in reach, it ends here only at EOF.
    let (text, end) = match newline_ends(index.encoding, offset, &bytes).next() {
        Some(last) => {
            let i = last + 1 - nl.len();
            (bytes[..i].strip_suffix(cr).unwrap_or(&bytes[..i]), End::Newline(offset + last as u64 + 1))
        }
        None if offset + bytes.len() as u64 >= store.len() => (&bytes[..], End::Eof),
        None => (&bytes[..], End::Beyond),
    };
    let complete = !matches!(end, End::Beyond);
    let (slice, used) = decode_prefix(text, index.encoding, offset, room, complete);
    let more = used < text.len() || !complete;
    let piece_end = offset + used as u64;
    let next = (more && shown_end - piece_end >= MAX_ELEMENT as u64).then_some(piece_end);
    let rest = match end {
        _ if !more || next.is_some() => None,
        End::Newline(next_line) => Some(next_line - piece_end),
        End::Eof => Some(store.len() - piece_end),
        End::Beyond if index.done && index.line_count() == line + 1 => Some(store.len() - piece_end),
        End::Beyond => locate_line(store, index, line + 1)?.map(|next_line| next_line - piece_end),
    };
    let piece = LinePiece { line, offset, text: slice.text, map: slice.map, more, next, rest };
    Ok((piece, used, end))
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
    let mut out = Vec::with_capacity(count.min(caps.items)); // plan C1: sized once, never grown
    // Line 0 starts at byte 0, so the first page needs no index: `open` returns it at once (Z37).
    let first = if start == 0 { Some(0) } else { locate_line(store, index, start)? };
    let Some(mut offset) = first else { return Ok(out) };
    let (mut line, mut page_bytes) = (start, 0usize);
    while offset < store.len() && out.len() < count.min(caps.items) {
        let (piece, used, end) = cut(store, index, line, offset, offset, caps)?;
        if !out.is_empty() && page_bytes + used > caps.page {
            break;
        }
        out.push(piece);
        page_bytes += used;
        offset = match end {
            End::Newline(next) => next,
            End::Eof => break,
            End::Beyond => match locate_line(store, index, line + 1)? {
                Some(next) => next,
                None => break, // the index hasn't found the next line yet
            },
        };
        line += 1;
    }
    Ok(out)
}

/// Why a continuation offset was refused (plan C3's forged-token table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotACut(pub String);

/// Plan C3: the piece of `line` that starts at the continuation `offset`. A token is only echoed, so the offset is
/// checked as if forged: it must lie inside the line's text, past its first element and within its shown part, and
/// be an element boundary of the whole line's decode (`is_cut`). It works while the index is still scanning the
/// line: only the line's start must be known.
pub fn piece(
    store: &ByteStore,
    index: &LineIndex,
    line: u64,
    offset: u64,
    caps: Caps,
) -> Result<Result<LinePiece, NotACut>, StoreError> {
    let refuse = |why: String| Ok(Err(NotACut(format!("continuation offset {offset} of line {line}: {why}"))));
    let line_start = match line {
        0 => 0,
        _ => match locate_line(store, index, line)? {
            Some(start) => start,
            None => return refuse("the line isn't known".into()),
        },
    };
    if offset <= line_start || offset > line_start + (caps.line - MAX_ELEMENT) as u64 {
        return refuse("outside the line's shown part".into());
    }
    let at = (offset - line_start) as usize;
    let bytes = store.read(line_start, offset + LOOKAHEAD as u64)?;
    if bytes.len() <= at {
        return refuse("past the end of the file".into());
    }
    if newline_ends(index.encoding, line_start, &bytes[..at]).next().is_some() {
        return refuse("in another line".into());
    }
    let (nl, cr) = newline_and_cr(index.encoding);
    // The line's text in reach, without its terminator: the offset must have text after it.
    let (text, complete) = match newline_ends(index.encoding, offset, &bytes[at..]).next() {
        Some(last) => {
            let i = at + last + 1 - nl.len();
            (bytes[..i].strip_suffix(cr).unwrap_or(&bytes[..i]), true)
        }
        None => (&bytes[..], line_start + bytes.len() as u64 >= store.len()),
    };
    if text.len() <= at {
        return refuse("at the line's end".into());
    }
    let bom = if line == 0 { bom_len(text, index.encoding) } else { 0 };
    if at <= bom {
        return refuse("inside the byte order mark".into());
    }
    if !is_cut(text, index.encoding, line_start, at, complete) {
        return refuse("not an element boundary".into());
    }
    Ok(Ok(cut(store, index, line, line_start, offset, caps)?.0))
}

/// Plan C3: whether the whole line's decode has an element boundary at `at`, judged by the decoder that cuts
/// pieces (`decode_prefix`). `text` is the line's text from its start (file offset `start`) to past `at`; `complete`
/// says it reaches the line's end. The decoder restarts where an element certainly starts, at most a few bytes back,
/// so this costs a few bytes, not the line:
/// - single-byte: every byte is an element;
/// - UTF-16: only a lead surrogate stays open across a unit, so the restart is the lead just before `at`, if any;
/// - UTF-8: a byte that isn't a continuation byte (80–BF) always starts an element, and a sequence still open at
///   `at` started at most 3 bytes back. With no such byte there, nothing is open at `at`.
fn is_cut(text: &[u8], encoding: &'static Encoding, start: u64, at: usize, complete: bool) -> bool {
    let from = if encoding == UTF_8 {
        (at.saturating_sub(3)..at).rev().find(|&i| !(0x80..0xC0).contains(&text[i])).unwrap_or(at)
    } else if encoding == UTF_16LE || encoding == UTF_16BE {
        if !(start + at as u64).is_multiple_of(2) {
            return false;
        }
        let pair = [text[at - 2], text[at - 1]];
        let unit = if encoding == UTF_16LE { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) };
        if (0xD800..0xDC00).contains(&unit) { at - 2 } else { at }
    } else {
        at
    };
    let budget = at - from;
    decode_prefix(&text[from..], encoding, start + from as u64, budget, complete).1 == budget
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
        let shared = RwLock::new(LineIndex::new(store.len(), &IndexConfig::default(), encoding_rs::UTF_8).unwrap());
        build(&File::open(&path).unwrap(), store.len(), IndexConfig::default(), &store.hashes(), &shared, |_| true)
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
        let short =
            LinePiece { line: 1, offset: 100_001, text: "short".into(), map, more: false, next: None, rest: None };
        assert_eq!(got[1], short);
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
        let cfg = IndexConfig { block: 1 << 20, ..IndexConfig::default() };
        let shared = RwLock::new(LineIndex::new(store.len(), &cfg, encoding_rs::UTF_8).unwrap());
        let mut first = None;
        build(&File::open(&path).unwrap(), store.len(), cfg, &store.hashes(), &shared, |p| {
            if first.is_none() {
                let idx = shared.read().unwrap();
                let page = lines(&store, &idx, 0, 10).unwrap();
                // Continuation is available while scanning proceeds (Z37): the next piece needs only the line's start.
                let next = piece(&store, &idx, 0, page[0].next.unwrap(), Caps::DEFAULT).unwrap().unwrap();
                first = Some((p.lines, idx.newlines, page, next));
            }
            true
        })
        .unwrap();
        let (count, newlines, page, next) = first.unwrap();
        assert_eq!((count, newlines, page.len()), (1, 0, 1));
        assert_eq!((page[0].line, page[0].offset, page[0].text.len(), page[0].more), (0, 0, PIECE_BYTES, true));
        let want = (0, PIECE_BYTES as u64, PIECE_BYTES, true, Some(2 * PIECE_BYTES as u64));
        assert_eq!((next.line, next.offset, next.text.len(), next.more, next.next), want);
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
        let shared = RwLock::new(LineIndex::new(store.len(), &IndexConfig::default(), encoding).unwrap());
        build(&File::open(&path).unwrap(), store.len(), IndexConfig::default(), &store.hashes(), &shared, |_| true)
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
            let caps = Caps { piece, page: piece * page_pieces, items, line: LINE_SHOWN };
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

    /// The text of the line starting at `start` in `bytes`, without its terminator.
    fn line_text<'a>(bytes: &'a [u8], encoding: &'static Encoding, start: u64) -> &'a [u8] {
        let (nl, cr) = newline_and_cr(encoding);
        let tail = &bytes[start as usize..];
        let end = newline_ends(encoding, start, tail).next().map_or(tail.len(), |last| last + 1 - nl.len());
        tail[..end].strip_suffix(cr).filter(|_| end < tail.len()).unwrap_or(&tail[..end])
    }

    /// The element boundaries of a whole line's decode, relative to the line's start.
    fn boundaries(text: &[u8], encoding: &'static Encoding, start: u64) -> Vec<usize> {
        let whole = decode(text, encoding, start);
        let mut at: Vec<usize> = (0..=whole.map.units()).map(|u| (whole.map.start_byte(u) - start) as usize).collect();
        at.dedup();
        at
    }

    /// Follows a line's continuation tokens from its first piece, and checks each piece against the whole line's
    /// decode: the same text and the same map, piece after piece (plan C3).
    fn walk_line(
        store: &ByteStore,
        idx: &LineIndex,
        bytes: &[u8],
        line: u64,
        caps: Caps,
    ) -> Result<Vec<LinePiece>, TestCaseError> {
        let encoding = idx.encoding;
        let mut pieces = lines_with(store, idx, line, 1, caps).unwrap();
        prop_assert_eq!(pieces.len(), 1);
        while let Some(next) = pieces.last().unwrap().next {
            let got = piece(store, idx, line, next, caps).unwrap();
            prop_assert!(got.is_ok(), "an issued token was refused: {:?}", got);
            pieces.push(got.unwrap());
        }
        let start = pieces[0].offset;
        let whole = decode(line_text(bytes, encoding, start), encoding, start);
        let (mut text, mut units) = (String::new(), 0u32);
        for (k, p) in pieces.iter().enumerate() {
            prop_assert!(p.map.units() > 0 || pieces.len() == 1, "piece {} is empty", k);
            for u in 0..=p.map.units() {
                let (s, e) = (p.map.start_byte(u), p.map.end_byte(u));
                prop_assert_eq!((s, e), (whole.map.start_byte(units + u), whole.map.end_byte(units + u)));
            }
            if k > 0 {
                let before = &pieces[k - 1].map;
                prop_assert_eq!(before.end_byte(before.units()), p.offset, "pieces aren't contiguous");
                prop_assert!(p.map.end_byte(p.map.units()) - p.offset <= caps.piece as u64);
            }
            text.push_str(&p.text);
            units += p.map.units();
        }
        let last = pieces.last().unwrap();
        let shown_end = last.map.end_byte(last.map.units());
        prop_assert!(whole.text.starts_with(&text));
        // Replacements, each piece's bytes decoded alone: a cut neither makes one nor hides one. (Counting U+FFFD in
        // the text can't tell, since a valid U+FFFD in the source decodes to the same char.)
        let replacements = |from: u64, to: u64| decode(&bytes[from as usize..to as usize], encoding, from).replacements;
        let in_pieces: u32 = pieces.iter().map(|p| replacements(p.offset, p.map.end_byte(p.map.units()))).sum();
        prop_assert_eq!(in_pieces, replacements(start, shown_end));
        if last.more {
            // Stopped at the shown part, with less room left than an element, and the rest reported.
            prop_assert!(start + caps.line as u64 - shown_end < MAX_ELEMENT as u64, "stopped early at {}", shown_end);
            let next_line = locate_line(store, idx, line + 1).unwrap().unwrap_or(store.len());
            prop_assert_eq!(last.rest, Some(next_line - shown_end));
        } else {
            prop_assert_eq!(&text, &whole.text);
            prop_assert_eq!(in_pieces, whole.replacements);
        }
        Ok(pieces)
    }

    /// Brief §5.1 at the real caps: a 3 MiB line shows 16 pieces of 64 KiB (1 MiB), then how much more there is.
    #[test]
    fn a_long_line_continues_in_pieces_up_to_its_shown_part() {
        let mut bytes = vec![b'x'; 3 << 20];
        bytes.extend_from_slice(b"\nshort\n");
        let (store, idx) = open("shown", &bytes);
        let pieces = walk_line(&store, &idx, &bytes, 0, Caps::DEFAULT).unwrap();
        assert_eq!(pieces.len(), LINE_SHOWN / PIECE_BYTES);
        assert!(pieces.iter().all(|p| p.text.len() == PIECE_BYTES));
        let last = pieces.last().unwrap();
        assert_eq!((last.more, last.next, last.rest), (true, None, Some((2 << 20) + 1)));
    }

    /// The forged-token rows the pages layer refuses (the old generation and a non-integer are refused above it,
    /// in `raw.rs` and the addon). Each offset is a valid one's neighbour, so only the check named refuses it.
    #[test]
    fn a_forged_continuation_offset_is_refused_with_its_reason() {
        let caps = Caps { piece: 8, ..Caps::DEFAULT };
        let utf8 = "aé€😀b€€€€€€\nsecond line\n".as_bytes();
        let (store, idx) = open("forged-utf8", utf8);
        let first = lines_with(&store, &idx, 0, 1, caps).unwrap().remove(0);
        assert_eq!(first.next, Some(6)); // "aé€" is 6 bytes, and 😀 would end at 10
        let refused = |line: u64, offset: u64| match piece(&store, &idx, line, offset, caps).unwrap() {
            Ok(p) => panic!("line {line} offset {offset} accepted: {p:?}"),
            Err(NotACut(why)) => why,
        };
        assert!(piece(&store, &idx, 0, 6, caps).unwrap().is_ok());
        assert!(refused(0, 8).ends_with("not an element boundary"), "{}", refused(0, 8)); // inside 😀
        assert!(refused(0, 2).ends_with("not an element boundary")); // inside é
        assert!(refused(0, 33).ends_with("in another line")); // "second line" starts at 30
        assert!(refused(1, 29).ends_with("outside the line's shown part")); // before line 1's start
        assert!(refused(0, 29).ends_with("at the line's end")); // the newline itself
        assert!(refused(0, 0).ends_with("outside the line's shown part")); // the line's start isn't a continuation
        assert!(refused(1, utf8.len() as u64).ends_with("past the end of the file"));
        assert!(refused(1, u64::MAX >> 11).ends_with("outside the line's shown part"));
        assert!(refused(5, 30).ends_with("the line isn't known"));
        let utf16: Vec<u8> =
            [b"\xFF\xFE".as_slice(), &"ab😀c\nd".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>()]
                .concat();
        let (store, idx) = open_encoded("forged-utf16", &utf16, UTF_16LE);
        let refused = |offset: u64| piece(&store, &idx, 0, offset, caps).unwrap().unwrap_err().0;
        assert!(piece(&store, &idx, 0, 6, caps).unwrap().is_ok()); // 😀 starts at 6
        assert!(refused(5).ends_with("not an element boundary")); // odd
        assert!(refused(8).ends_with("not an element boundary")); // between 😀's surrogates
        assert!(refused(1).ends_with("inside the byte order mark"));
        assert!(refused(2).ends_with("inside the byte order mark")); // the text's first element isn't a continuation
        let bom8 = b"\xEF\xBB\xBFabc\n";
        let (store, idx) = open("forged-bom8", bom8);
        for offset in 1..=3 {
            let why = piece(&store, &idx, 0, offset, caps).unwrap().unwrap_err().0;
            assert!(why.ends_with("inside the byte order mark"), "{why}");
        }
    }

    /// Adversarial UTF-8: everything that makes a decoder resynchronise.
    fn hostile_utf8() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            4 => any::<char>().prop_filter("no newline", |&c| c != '\n').prop_map(|c| c.to_string().into_bytes()),
            2 => prop::collection::vec(0x80u8..0xC0, 1..=8), // a run of lone continuation bytes
            // A truncated 2-, 3- or 4-byte sequence, then a lead byte.
            2 => (prop::sample::select(vec![vec![0xC3], vec![0xE2], vec![0xE2, 0x82], vec![0xF0], vec![0xF0, 0x9F], vec![0xF0, 0x9F, 0x98]]),
                  0xC2u8..0xF5).prop_map(|(t, lead)| [t, vec![lead]].concat()),
            2 => prop::sample::select(vec![
                vec![0xC0, 0x80], vec![0xC1, 0xBF], vec![0xE0, 0x80, 0x80], vec![0xE0, 0x9F, 0xBF], // overlongs
                vec![0xED, 0xA0, 0x80], vec![0xED, 0xBF, 0xBF], // surrogates in UTF-8
                vec![0xF4, 0x90, 0x80, 0x80], vec![0xF0, 0x8F, 0xBF, 0xBF], // past U+10FFFF, overlong 4-byte
                vec![0xE0, 0xA0, 0x80], vec![0xED, 0x9F, 0xBF], vec![0xF0, 0x90, 0x80, 0x80], vec![0xF4, 0x8F, 0xBF, 0xBF], // valid edges
            ]),
            1 => (0xF5u8..=0xFF).prop_map(|b| vec![b]),
            1 => (0xC2u8..0xF5).prop_map(|b| vec![b]), // a lone lead byte
            1 => Just(b"\r".to_vec()),
        ]
    }

    /// Adversarial UTF-16: unpaired surrogates, a lead before a pair, and units holding a 0x0A byte.
    fn hostile_utf16() -> impl Strategy<Value = Vec<u16>> {
        prop_oneof![
            4 => any::<char>().prop_filter("no newline", |&c| c != '\n').prop_map(|c| c.encode_utf16(&mut [0; 2]).to_vec()),
            2 => (0xD800u16..0xDC00).prop_map(|u| vec![u]), // a lone high surrogate
            2 => (0xDC00u16..0xE000).prop_map(|u| vec![u]), // a lone low surrogate
            2 => Just(vec![0xD83D, 0xD83D, 0xDE00]),         // high, high, low
            1 => prop::sample::select(vec![0x010A, 0x0A0D, 0x0A00, 0x0D0A]).prop_map(|u| vec![u]),
        ]
    }

    /// A hostile line in one of Raw's encodings, after a short first line so it starts mid-file. A UTF-16 one
    /// sometimes ends in an odd byte.
    fn hostile_line() -> impl Strategy<Value = (Vec<u8>, &'static Encoding)> {
        let utf8 =
            prop::collection::vec(hostile_utf8(), 1..40).prop_map(|a| ([b"x\n".to_vec(), a.concat()].concat(), UTF_8));
        let w1252 = prop::collection::vec(any::<u8>().prop_filter("no newline", |&b| b != b'\n'), 1..120)
            .prop_map(|b| ([b"x\n".to_vec(), b].concat(), encoding_rs::WINDOWS_1252));
        let utf16 = (prop::collection::vec(hostile_utf16(), 1..40), any::<bool>(), prop::option::of(any::<u8>()))
            .prop_map(|(atoms, be, odd)| {
                let units = ["x\n".encode_utf16().collect(), atoms.concat()].concat();
                let body = units.iter().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
                let bom: &[u8] = if be { b"\xFE\xFF" } else { b"\xFF\xFE" };
                (bom.iter().copied().chain(body).chain(odd).collect(), if be { UTF_16BE } else { UTF_16LE })
            });
        prop_oneof![utf8, w1252, utf16]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_000))]

        /// C3's cut check at every offset of a hostile line: `piece` accepts exactly the whole line's element
        /// boundaries (past its start, before its end), so `is_cut`'s short restart agrees with decoding the line
        /// from its start.
        #[test]
        fn is_cut_accepts_exactly_the_whole_lines_boundaries((bytes, encoding) in hostile_line()) {
            let (store, idx) = open_encoded("c3-cut", &bytes, encoding);
            let caps = Caps { piece: 16, ..Caps::DEFAULT };
            let start = locate_line(&store, &idx, 1).unwrap().unwrap();
            let text = line_text(&bytes, encoding, start);
            let cuts = boundaries(text, encoding, start);
            for at in 1..text.len() {
                let got = piece(&store, &idx, 1, start + at as u64, caps).unwrap();
                match (&got, cuts.binary_search(&at).is_ok()) {
                    (Ok(p), true) => {
                        prop_assert_eq!(p.offset, start + at as u64);
                        prop_assert!(p.map.units() > 0);
                    }
                    (Err(NotACut(why)), false) => prop_assert!(why.ends_with("not an element boundary"), "{}", why),
                    _ => {
                        let near = &text[at.saturating_sub(4)..(at + 4).min(text.len())];
                        return Err(TestCaseError::fail(format!("offset {at} ({near:x?}): {got:?}")));
                    }
                }
            }
        }

        /// C3: across the five encodings, malformed and astral text included, with tiny pieces and a tiny shown part,
        /// every line's pieces, concatenated, are the whole line's decode: the same text, the same replacement count
        /// and the same map, contiguous from piece to piece.
        #[test]
        fn pieces_concatenate_to_the_whole_lines_decode(
            (bytes, encoding) in prop_oneof![any_file(), hostile_line()],
            piece in 8usize..48,
            shown in 8usize..400,
        ) {
            let caps = Caps { piece, line: shown, ..Caps::DEFAULT };
            let (store, idx) = open_encoded("c3-walk", &bytes, encoding);
            for line in 0..idx.line_count() {
                walk_line(&store, &idx, &bytes, line, caps)?;
            }
        }
    }
}
