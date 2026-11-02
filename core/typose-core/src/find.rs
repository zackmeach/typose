//! Bounded literal matching over verified decoded source. Folding is Unicode lowercase per source scalar.
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use encoding_rs::Encoding;

use crate::budget::Reservation;
use crate::doc::{DocError, Document};
use crate::encoding::{TextSlice, decode, decode_prefix};
use crate::store::cancelled;

pub const SCAN_BYTES: u64 = 4 << 20;
pub const HIT_LIMIT: usize = 128;
pub const TEMP_BYTES: u64 = 16 << 20;
pub const STATE_BYTES: u64 = 256 << 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub start: u64,
    pub end: u64,
    pub line: u64,
    pub line_start: u64,
    pub ordinal: u64,
}

pub struct Pattern {
    chars: Vec<char>,
    prefix: Vec<usize>,
    match_case: bool,
}
impl Pattern {
    pub fn new(query: &str, match_case: bool) -> Result<Self, DocError> {
        if query.is_empty() || query.encode_utf16().count() > 512 {
            return Err(DocError::Invalid("Find query must contain 1–512 UTF-16 units".into()));
        }
        let chars: Vec<char> =
            if match_case { query.chars().collect() } else { query.chars().flat_map(char::to_lowercase).collect() };
        let mut prefix = vec![0; chars.len()];
        for i in 1..chars.len() {
            let mut k = prefix[i - 1];
            while k > 0 && chars[k] != chars[i] {
                k = prefix[k - 1];
            }
            if chars[k] == chars[i] {
                k += 1;
            }
            prefix[i] = k;
        }
        Ok(Self { chars, prefix, match_case })
    }
}
#[derive(Clone)]
pub struct Matcher {
    matched: usize,
    recent: VecDeque<Hit>,
}
impl Matcher {
    pub fn new(pattern: &Pattern) -> Self {
        Self { matched: 0, recent: VecDeque::with_capacity(pattern.chars.len()) }
    }
    pub fn reset(&mut self) {
        self.matched = 0;
        self.recent.clear();
    }
    pub fn feed(&mut self, pattern: &Pattern, c: char, position: Hit, mut found: impl FnMut(Hit)) {
        if pattern.match_case {
            self.feed_folded(pattern, c, position, &mut found);
        } else {
            for c in c.to_lowercase() {
                self.feed_folded(pattern, c, position, &mut found);
            }
        }
    }
    fn feed_folded(&mut self, pattern: &Pattern, c: char, position: Hit, found: &mut impl FnMut(Hit)) {
        if self.recent.len() == pattern.chars.len() {
            self.recent.pop_front();
        }
        self.recent.push_back(position);
        while self.matched > 0 && pattern.chars[self.matched] != c {
            self.matched = pattern.prefix[self.matched - 1];
        }
        if pattern.chars[self.matched] == c {
            self.matched += 1;
        }
        if self.matched == pattern.chars.len() {
            let first = self.recent[self.recent.len() - pattern.chars.len()];
            found(Hit { end: position.end, ..first });
            self.matched = 0; // literal Find uses non-overlapping matches
        }
    }
}
pub struct Progress {
    pub count: u64,
    pub bytes: u64,
    pub complete: bool,
    pub hits: Vec<Hit>,
}
#[derive(Clone)]
struct Cursor {
    offset: u64,
    line: u64,
    line_start: u64,
    count: u64,
    complete: bool,
    matcher: Matcher,
}
pub struct Source {
    pub generation: u32,
    pattern: Pattern,
    cursor: Mutex<Cursor>,
    anchors: Mutex<Vec<Cursor>>,
    closed: AtomicBool,
    _charge: Reservation,
}
impl Source {
    pub fn new(generation: u32, query: &str, match_case: bool, file_bytes: u64) -> Result<Self, DocError> {
        let capacity = file_bytes.div_ceil(SCAN_BYTES) + 2;
        let anchor_bytes = 128 + 2 * query.encode_utf16().count() as u64 * 3 * size_of::<Hit>() as u64;
        let charge = Reservation::new(
            STATE_BYTES
                + capacity
                    .checked_mul(anchor_bytes)
                    .ok_or_else(|| DocError::Invalid("Find anchor size overflow".into()))?,
        )
        .map_err(DocError::Memory)?;
        let pattern = Pattern::new(query, match_case)?;
        let matcher = Matcher::new(&pattern);
        let cursor = Cursor { offset: 0, line: 0, line_start: 0, count: 0, complete: false, matcher };
        let mut anchors = Vec::with_capacity(capacity as usize);
        anchors.push(cursor.clone());
        Ok(Self {
            generation,
            pattern,
            cursor: Mutex::new(cursor),
            anchors: Mutex::new(anchors),
            closed: AtomicBool::new(false),
            _charge: charge,
        })
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }
    pub fn charged(&self) -> u64 {
        self._charge.bytes()
    }
    pub fn snapshot(&self) -> Progress {
        let c = self.cursor.lock().unwrap();
        Progress { count: c.count, bytes: c.offset, complete: c.complete, hits: Vec::new() }
    }
    fn step(
        &self,
        doc: &Document,
        encoding: &'static Encoding,
        c: &mut Cursor,
        limit: u64,
        mut found: impl FnMut(Hit),
    ) -> Result<(), DocError> {
        let stop = (c.offset + limit).min(doc.len());
        while c.offset < stop {
            if cancelled() || self.closed.load(Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            let end = (c.offset + 65_536 + 4).min(doc.len());
            let bytes = doc.read(self.generation, c.offset, end)?;
            let (slice, used) = decode_prefix(&bytes, encoding, c.offset, 65_536.min(bytes.len()), end == doc.len());
            if used == 0 {
                return Err(DocError::Invalid("Find decode made no progress".into()));
            }
            let mut units = 0;
            for ch in slice.text.chars() {
                let start = slice.map.start_byte(units);
                units += ch.len_utf16() as u32;
                let end = slice.map.end_byte(units);
                let hit = Hit { start, end, line: c.line, line_start: c.line_start, ordinal: 0 };
                c.matcher.feed(&self.pattern, ch, hit, |mut hit| {
                    c.count += 1;
                    hit.ordinal = c.count;
                    found(hit);
                });
                if ch == '\n' {
                    c.line += 1;
                    c.line_start = end;
                }
            }
            c.offset += used as u64;
        }
        c.complete = c.offset == doc.len();
        Ok(())
    }
    pub fn scan(&self, doc: &Document, encoding: &'static Encoding) -> Result<Progress, DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let mut held = self.cursor.lock().unwrap();
        let mut c = held.clone();
        let mut hits = Vec::with_capacity(HIT_LIMIT);
        self.step(doc, encoding, &mut c, SCAN_BYTES, |h| {
            if hits.len() < HIT_LIMIT {
                hits.push(h);
            }
        })?;
        if c.offset > held.offset {
            self.anchors.lock().unwrap().push(c.clone());
        }
        let result = Progress { count: c.count, bytes: c.offset, complete: c.complete, hits };
        *held = c;
        Ok(result)
    }
    /// Navigation keeps only first/last qualifying hits. It never retains an all-hit array.
    pub fn seek(
        &self,
        doc: &Document,
        encoding: &'static Encoding,
        from: Option<u64>,
        previous: bool,
    ) -> Result<(Option<Hit>, bool), DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        self.seek_inner(doc, encoding, from, previous)
    }
    fn seek_inner(
        &self,
        doc: &Document,
        encoding: &'static Encoding,
        from: Option<u64>,
        previous: bool,
    ) -> Result<(Option<Hit>, bool), DocError> {
        let anchors = self.anchors.lock().unwrap();
        let at = match from {
            Some(p) => anchors.partition_point(|c| c.offset < p).saturating_sub(1),
            None if previous => {
                if anchors.last().unwrap().complete {
                    anchors.len().saturating_sub(2)
                } else {
                    anchors.len() - 1
                }
            }
            None => 0,
        };
        let mut c = anchors[at].clone();
        drop(anchors);
        c.complete = false;
        let (mut first, mut last, mut chosen) = (None, None, None);
        while !c.complete {
            self.step(doc, encoding, &mut c, SCAN_BYTES, |h| {
                first.get_or_insert(h);
                last = Some(h);
                if previous {
                    if from.is_none_or(|p| h.start < p) {
                        chosen = Some(h);
                    }
                } else if chosen.is_none() && from.is_none_or(|p| h.start > p) {
                    chosen = Some(h);
                }
            })?;
            if !previous && chosen.is_some() {
                break;
            }
            if previous && from.is_some_and(|p| c.offset >= p) {
                break;
            }
        }
        let wrapped = chosen.is_none() && from.is_some();
        if previous && chosen.is_none() && at > 0 {
            let mut anchor = at;
            while anchor > 0 {
                anchor -= 1;
                let mut earlier = self.anchors.lock().unwrap()[anchor].clone();
                earlier.complete = false;
                self.step(doc, encoding, &mut earlier, SCAN_BYTES, |h| {
                    if from.is_none_or(|p| h.start < p) {
                        chosen = Some(h);
                    }
                })?;
                if chosen.is_some() {
                    return Ok((chosen, false));
                }
            }
        }
        if wrapped {
            return self.seek_inner(doc, encoding, None, previous).map(|(hit, _)| (hit, true));
        }
        Ok((chosen.or(if previous { last } else { first }), wrapped))
    }
}
pub fn snippet(
    doc: &Document,
    generation: u32,
    encoding: &'static Encoding,
    hit: Hit,
) -> Result<(TextSlice, u32), DocError> {
    let matched = doc.read(generation, hit.start, hit.end)?;
    let match_units = decode(&matched, encoding, hit.start).text.encode_utf16().count() as u32;
    let end = (hit.end + 256).min(doc.len());
    let bytes = doc.read(generation, hit.start, end)?;
    let (slice, _) = decode_prefix(&bytes, encoding, hit.start, bytes.len(), end == doc.len());
    Ok((slice, match_units))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;
    use encoding_rs::{UTF_8, UTF_16LE, WINDOWS_1252};
    #[test]
    fn unicode_fold_and_long_line_hits_keep_original_spans_without_index() {
        let mut bytes = vec![b'x'; (1 << 20) + 3];
        bytes.extend_from_slice("École ΟΣ İ\nend ÉCOLE".as_bytes());
        let file = temp_file("source-find", &bytes);
        let doc = Document::open(&file).unwrap();
        let source = Source::new(1, "école", false, doc.len()).unwrap();
        let p = source.scan(&doc, UTF_8).unwrap();
        assert!(p.complete);
        assert_eq!(p.count, 2);
        assert_eq!(p.hits[0].line, 0);
        assert_eq!(p.hits[0].start, (1 << 20) + 3);
        let (last, _) = source.seek(&doc, UTF_8, None, true).unwrap();
        assert_eq!(last.unwrap().line, 1);
        let (wrapped, yes) = source.seek(&doc, UTF_8, Some(p.hits[1].start), false).unwrap();
        assert!(yes);
        assert_eq!(wrapped, Some(p.hits[0]));
    }
    #[test]
    fn source_decoding_crosses_chunks_utf16_and_fallback() {
        for (encoding, bytes, needle) in [
            (
                UTF_16LE,
                [vec![0xff, 0xfe], "Café\nCAFÉ".encode_utf16().flat_map(u16::to_le_bytes).collect()].concat(),
                "café",
            ),
            (WINDOWS_1252, b"Caf\xe9\nCAF\xc9".to_vec(), "café"),
        ] {
            let file = temp_file("source-find-encoding", &bytes);
            let doc = Document::open(&file).unwrap();
            assert_eq!(Source::new(1, needle, false, doc.len()).unwrap().scan(&doc, encoding).unwrap().count, 2);
        }
        let mut bytes = vec![b'x'; 65_535];
        bytes.extend_from_slice("ÉCOLE".as_bytes());
        let file = temp_file("source-find-boundary", &bytes);
        let doc = Document::open(&file).unwrap();
        let p = Source::new(1, "école", false, doc.len()).unwrap().scan(&doc, UTF_8).unwrap();
        assert_eq!(p.count, 1);
        assert_eq!(p.hits[0].start, 65_535);
    }
}
