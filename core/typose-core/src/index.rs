//! Streaming line index with byte-bounded checkpoints (spec §3.5).
use std::fs::File;
use std::sync::RwLock;

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE};
use memchr::memchr_iter;

use crate::budget::{OverBudget, Reservation};
use crate::encoding::{newline_and_cr, newline_ends};
use crate::store::{ByteStore, CHUNK, ChunkHashes, StoreError, read_exact_at};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub line: u64,
    pub offset: u64,
    pub at_line_start: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct IndexConfig {
    pub cp_lines: u64,
    pub cp_bytes: u64,
    pub block: usize,
}

impl Default for IndexConfig {
    fn default() -> Self {
        IndexConfig { cp_lines: 1024, cp_bytes: 1 << 20, block: BLOCK }
    }
}

const BLOCK: usize = 4 << 20;
const CP: usize = size_of::<Checkpoint>();
/// Elastic checkpoints come in chunks of this many (24 KiB).
const CP_CHUNK: usize = 1024;

/// The checkpoints one block of `n` bytes can add: a line checkpoint per `cp_lines` lines (a line takes a byte at
/// least) and a byte-bound one per `cp_bytes`, plus what the block before carried into it.
const fn fresh_max(n: usize, cp_lines: u64, cp_bytes: u64) -> usize {
    n / cp_lines as usize + n / cp_bytes as usize + 4
}

/// Plan C1's index slot (`budget::Work::Index`): the block buffer, and the checkpoints one block can add while they
/// wait to be published, for the default config, which every other config must fit in (`build` checks).
pub const INDEX_TEMP: usize = BLOCK + fresh_max(BLOCK, 1024, 1 << 20) * CP + 4096;

/// Plan C1: checkpoints in chunks, filled in order, so the table grows without ever holding two copies.
/// - The first chunk holds every byte-bound checkpoint the file can have, the initial one included
///   (⌈len / cp_bytes⌉ + 1), reserved with the document's floor at open.
/// - Line checkpoints take elastic chunks of `CP_CHUNK`, charged as the index needs them. When the ledger refuses one,
///   line checkpoints stop, and the byte-bound ones alone keep every rescan ≤ `cp_bytes` (spec §3.5).
#[derive(Debug)]
pub struct Checkpoints {
    chunks: Vec<Vec<Checkpoint>>,
    len: usize,
    floor: usize,
    /// The elastic capacity charged, in checkpoints.
    elastic: usize,
    /// The byte bound the floor is sized for.
    cp_bytes: u64,
    /// Pays for the chunks and their list. Declared after them, so they're freed first.
    charge: Reservation,
}

impl Checkpoints {
    /// The floor's charge for a file of `len` bytes: its byte-bound checkpoints, and the list's first entry.
    pub const fn floor_bytes(len: u64, cp_bytes: u64) -> u64 {
        ((len.div_ceil(cp_bytes) + 1) as usize * CP + size_of::<Vec<Checkpoint>>()) as u64
    }

    pub fn new(len: u64, cp_bytes: u64) -> Result<Checkpoints, OverBudget> {
        let charge = Reservation::new(Self::floor_bytes(len, cp_bytes))?;
        let floor = (len.div_ceil(cp_bytes) + 1) as usize;
        let chunks = vec![Vec::with_capacity(floor)];
        Ok(Checkpoints { chunks, len: 0, floor, elastic: 0, cp_bytes, charge })
    }

    /// Makes room for `lines` line checkpoints in all, a chunk at a time, each charged before it's allocated. False
    /// when the ledger refuses: the index then adds no more line checkpoints.
    fn room(&mut self, lines: usize) -> bool {
        let entry = size_of::<Vec<Checkpoint>>() as u64;
        while self.elastic < lines {
            let full = self.chunks.len() == self.chunks.capacity();
            let (old, new) = (self.chunks.capacity(), 2 * self.chunks.capacity());
            // Growing the list may move it, holding the old list and the new one at once: both are charged until then.
            let need = (CP_CHUNK * CP) as u64 + if full { new as u64 * entry } else { 0 };
            if self.charge.grow(need).is_err() {
                return false;
            }
            if full {
                self.chunks.reserve_exact(new - self.chunks.len());
                self.charge.shrink(old as u64 * entry);
            }
            self.chunks.push(Vec::with_capacity(CP_CHUNK));
            self.elastic += CP_CHUNK;
        }
        true
    }

    /// Releases the elastic chunks `room` made ahead that no checkpoint reached: the index is done.
    fn trim(&mut self) {
        while self.chunks.len() > 1 && self.len <= self.floor + (self.chunks.len() - 2) * CP_CHUNK {
            self.chunks.pop();
            self.elastic -= CP_CHUNK;
            self.charge.shrink((CP_CHUNK * CP) as u64);
        }
    }

    /// Adds a checkpoint where the floor or `room` made space for it, so no chunk ever grows.
    fn push(&mut self, cp: Checkpoint) {
        let (j, _) = self.at(self.len);
        let chunk = &mut self.chunks[j];
        assert!(chunk.len() < chunk.capacity(), "a checkpoint past the table's charged capacity");
        chunk.push(cp);
        self.len += 1;
    }

    fn at(&self, i: usize) -> (usize, usize) {
        match i.checked_sub(self.floor) {
            None => (0, i),
            Some(k) => (1 + k / CP_CHUNK, k % CP_CHUNK),
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn get(&self, i: usize) -> Checkpoint {
        let (j, k) = self.at(i);
        self.chunks[j][k]
    }

    pub fn iter(&self) -> impl Iterator<Item = Checkpoint> + '_ {
        self.chunks.iter().flatten().copied()
    }

    /// The first index where `pred` is false, for a `pred` that's true then false over the table (`slice::partition_point`).
    pub fn partition_point(&self, pred: impl Fn(&Checkpoint) -> bool) -> usize {
        let (mut lo, mut hi) = (0, self.len);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if pred(&self.get(mid)) { lo = mid + 1 } else { hi = mid }
        }
        lo
    }

    pub fn charged(&self) -> u64 {
        self.charge.bytes()
    }
}

#[derive(Debug)]
pub struct LineIndex {
    pub checkpoints: Checkpoints,
    pub newlines: u64,
    pub last_line_start: u64,
    pub indexed_bytes: u64,
    pub done: bool,
    /// Decides what a newline is: in UTF-16 it's a 2-byte unit.
    pub encoding: &'static Encoding,
}

impl LineIndex {
    /// An empty index of a file of `len` bytes, its byte-bound checkpoints reserved (plan C1's floor).
    pub fn new(len: u64, cfg: &IndexConfig, encoding: &'static Encoding) -> Result<LineIndex, OverBudget> {
        Ok(LineIndex {
            checkpoints: Checkpoints::new(len, cfg.cp_bytes)?,
            newlines: 0,
            last_line_start: 0,
            indexed_bytes: 0,
            done: false,
            encoding,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Progress {
    pub lines: u64,
    pub bytes: u64,
    pub done: bool,
}

impl LineIndex {
    pub fn line_count(&self) -> u64 {
        self.newlines + u64::from(self.indexed_bytes > self.last_line_start)
    }

    /// The last checkpoint at or before `line`'s start: either `line`'s own start,
    /// or a checkpoint inside an earlier line. The predicate below is monotonic over `checkpoints`.
    pub fn checkpoint_for(&self, line: u64) -> Checkpoint {
        let i = self.checkpoints.partition_point(|c| c.line < line || (c.line == line && c.at_line_start));
        self.checkpoints.get(i.saturating_sub(1))
    }
}

/// Turns newline positions into checkpoints. Whatever reads the blocks feeds them here in file order.
struct Builder {
    cfg: IndexConfig,
    fresh: Vec<Checkpoint>,
    newlines: u64,
    last_line_start: u64,
    last_cp: u64,
    lines_since: u64,
    /// Line checkpoints made so far, and whether they're still being made (plan C1: they stop at the limit).
    line_cps: usize,
    lines_on: bool,
}

impl Builder {
    /// `fresh` holds what one block can add (`fresh_max`), so it never grows.
    fn new(cfg: IndexConfig, fresh: usize) -> Builder {
        let mut fresh = Vec::with_capacity(fresh);
        fresh.push(Checkpoint { line: 0, offset: 0, at_line_start: true });
        Builder { cfg, fresh, newlines: 0, last_line_start: 0, last_cp: 0, lines_since: 0, line_cps: 0, lines_on: true }
    }

    /// One block `[start, end)`; `rels` are its newline positions relative to `start`, ascending.
    fn block(&mut self, start: u64, end: u64, rels: impl Iterator<Item = usize>) {
        let cp_bytes = self.cfg.cp_bytes;
        for rel in rels {
            let line_start = start + rel as u64 + 1;
            while self.last_cp + cp_bytes < line_start {
                self.last_cp += cp_bytes;
                self.fresh.push(Checkpoint { line: self.newlines, offset: self.last_cp, at_line_start: false });
            }
            self.newlines += 1;
            self.lines_since += 1;
            self.last_line_start = line_start;
            let byte_bound = line_start - self.last_cp >= cp_bytes;
            if byte_bound || (self.lines_on && self.lines_since >= self.cfg.cp_lines) {
                self.fresh.push(Checkpoint { line: self.newlines, offset: line_start, at_line_start: true });
                self.line_cps += usize::from(!byte_bound);
                self.last_cp = line_start;
                self.lines_since = 0;
            }
        }
        while self.last_cp + cp_bytes <= end {
            self.last_cp += cp_bytes;
            self.fresh.push(Checkpoint { line: self.newlines, offset: self.last_cp, at_line_start: false });
        }
    }

    /// Moves the new checkpoints into the shared index and returns its line count.
    fn publish(&mut self, shared: &RwLock<LineIndex>, indexed: u64, done: bool) -> u64 {
        let mut w = shared.write().unwrap();
        for cp in self.fresh.drain(..) {
            w.checkpoints.push(cp);
        }
        if done {
            w.checkpoints.trim();
        }
        w.newlines = self.newlines;
        w.last_line_start = self.last_line_start;
        w.indexed_bytes = indexed;
        w.done = done;
        w.line_count()
    }
}

/// Reads one chunk-aligned block at `pos` and hashes every chunk in it.
pub(crate) fn read_block<'a>(
    file: &File,
    block: &'a mut [u8],
    pos: u64,
    hashes: &ChunkHashes,
) -> Result<&'a [u8], StoreError> {
    read_exact_at(file, block, pos).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => StoreError::Changed { chunk: pos / CHUNK as u64 },
        _ => StoreError::Io(e),
    })?;
    for (i, chunk) in block.chunks(CHUNK).enumerate() {
        hashes.check(pos / CHUNK as u64 + i as u64, chunk)?;
    }
    Ok(block)
}

fn block_len(cfg: &IndexConfig) -> usize {
    cfg.block.max(CHUNK) / CHUNK * CHUNK // whole chunks, so every hash covers exactly one chunk
}

/// Indexes `file` block by block. After each block `on_progress` says whether to go on: when it says no, the index
/// stops there, published as far as it got and not done (plan C6: a frozen document's index ends).
///
/// Plan C1: its buffers fit in `INDEX_TEMP`, which its caller's index slot reserves. Before each block it makes room in
/// the checkpoint table for the line checkpoints the block can add; once the ledger refuses, it adds only byte-bound
/// ones.
pub fn build(
    file: &File,
    len: u64,
    cfg: IndexConfig,
    hashes: &ChunkHashes,
    shared: &RwLock<LineIndex>,
    mut on_progress: impl FnMut(Progress) -> bool,
) -> Result<(), StoreError> {
    let encoding = {
        let index = shared.read().unwrap();
        assert_eq!(index.checkpoints.cp_bytes, cfg.cp_bytes, "the table's floor was sized for another byte bound");
        index.encoding
    };
    let buf_len = block_len(&cfg).min(len as usize);
    let fresh = fresh_max(buf_len, cfg.cp_lines, cfg.cp_bytes);
    assert!(buf_len + fresh * CP <= INDEX_TEMP, "an index config past its slot");
    let mut b = Builder::new(cfg, fresh);
    let mut buf = vec![0u8; buf_len];
    let mut pos = 0u64;
    while pos < len {
        let n = ((len - pos) as usize).min(buf.len());
        if b.lines_on {
            // The line checkpoints this block can add: one per `cp_lines` lines, counting those carried in.
            let more = (b.lines_since as usize + n) / cfg.cp_lines as usize;
            b.lines_on = shared.write().unwrap().checkpoints.room(b.line_cps + more);
        }
        let block = read_block(file, &mut buf[..n], pos, hashes)?;
        if encoding == UTF_16LE || encoding == UTF_16BE {
            b.block(pos, pos + n as u64, newline_ends(encoding, pos, block));
        } else {
            b.block(pos, pos + n as u64, memchr_iter(b'\n', block)); // Spike A's hot path, unchanged
        }
        pos += n as u64;
        let lines = b.publish(shared, pos, false);
        if !on_progress(Progress { lines, bytes: pos, done: false }) {
            return Ok(());
        }
    }
    let lines = b.publish(shared, len, true);
    on_progress(Progress { lines, bytes: len, done: true });
    Ok(())
}

pub fn locate_line(store: &ByteStore, index: &LineIndex, line: u64) -> Result<Option<u64>, StoreError> {
    if line >= index.line_count() {
        return Ok(None);
    }
    let cp = index.checkpoint_for(line);
    if cp.line == line && cp.at_line_start {
        return Ok(Some(cp.offset));
    }
    let mut need = line - cp.line;
    // An odd `cp_bytes` can put a mid-line checkpoint inside a UTF-16 newline unit: scan from the unit's start.
    let mut pos = if newline_and_cr(index.encoding).0.len() == 2 { cp.offset & !1 } else { cp.offset };
    while pos < index.indexed_bytes {
        let end = (pos + CHUNK as u64).min(index.indexed_bytes);
        let bytes = store.read(pos, end)?;
        for rel in newline_ends(index.encoding, pos, &bytes) {
            need -= 1;
            if need == 0 {
                return Ok(Some(pos + rel as u64 + 1));
            }
        }
        pos = end;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;
    use encoding_rs::UTF_8;
    use proptest::prelude::*;

    fn index_bytes(name: &str, bytes: &[u8], cfg: IndexConfig) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::new(store.len(), &cfg, UTF_8).unwrap());
        let file = File::open(&path).unwrap();
        build(&file, store.len(), cfg, &store.hashes(), &shared, |_| true).unwrap();
        (store, shared.into_inner().unwrap())
    }

    fn naive_line_starts(bytes: &[u8]) -> Vec<u64> {
        if bytes.is_empty() {
            return vec![];
        }
        let mut starts = vec![0u64];
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' && i + 1 < bytes.len() {
                starts.push(i as u64 + 1);
            }
        }
        starts
    }

    #[test]
    fn checkpoints_every_n_lines() {
        let cfg = IndexConfig { cp_lines: 3, cp_bytes: 1 << 20, block: CHUNK };
        let (_, idx) = index_bytes("every-n", "a\n".repeat(10).as_bytes(), cfg);
        let starts: Vec<(u64, u64)> = idx.checkpoints.iter().map(|c| (c.line, c.offset)).collect();
        assert_eq!(starts, vec![(0, 0), (3, 6), (6, 12), (9, 18)]);
        assert_eq!(idx.line_count(), 10);
        assert!(idx.done);
    }

    #[test]
    fn byte_bound_places_checkpoints_inside_a_long_line() {
        let cfg = IndexConfig { cp_lines: 1024, cp_bytes: 4, block: CHUNK };
        let (store, idx) = index_bytes("long-line", b"xxxxxxxxxx\ny\n", cfg);
        let cps: Vec<(u64, u64, bool)> = idx.checkpoints.iter().map(|c| (c.line, c.offset, c.at_line_start)).collect();
        assert_eq!(cps, vec![(0, 0, true), (0, 4, false), (0, 8, false), (1, 12, false)]);
        assert_eq!(idx.line_count(), 2);
        assert_eq!(locate_line(&store, &idx, 1).unwrap(), Some(11));
        assert_eq!(locate_line(&store, &idx, 2).unwrap(), None);
    }

    #[test]
    fn a_tail_without_a_newline_is_a_line() {
        let (store, idx) = index_bytes("tail", b"a\nb", IndexConfig::default());
        assert_eq!(idx.line_count(), 2);
        assert_eq!(locate_line(&store, &idx, 1).unwrap(), Some(2));
    }

    #[test]
    fn every_chunk_gets_hashed() {
        let bytes = vec![b'z'; 2 * CHUNK + 1];
        let (store, _) = index_bytes("hashed", &bytes, IndexConfig::default());
        assert_eq!(store.hashes().len(), 3);
    }

    proptest! {
        #[test]
        fn locate_line_matches_a_naive_scan(
            bytes in prop::collection::vec(prop_oneof![Just(b'\n'), Just(b'a'), Just(b'\r')], 0..4000),
            cp_lines in 1u64..50,
            cp_bytes in 1u64..300,
        ) {
            let cfg = IndexConfig { cp_lines, cp_bytes, block: CHUNK };
            let (store, idx) = index_bytes("prop", &bytes, cfg);
            let starts = naive_line_starts(&bytes);
            prop_assert_eq!(idx.line_count(), starts.len() as u64);
            for (line, &start) in starts.iter().enumerate() {
                prop_assert_eq!(locate_line(&store, &idx, line as u64).unwrap(), Some(start));
            }
            for pair in idx.checkpoints.iter().collect::<Vec<_>>().windows(2) {
                prop_assert!(pair[1].offset - pair[0].offset <= cp_bytes, "checkpoint gap over cp_bytes");
            }
        }
    }

    fn index_encoded(
        name: &str,
        bytes: &[u8],
        cfg: IndexConfig,
        encoding: &'static Encoding,
    ) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::new(store.len(), &cfg, encoding).unwrap());
        build(&File::open(&path).unwrap(), store.len(), cfg, &store.hashes(), &shared, |_| true).unwrap();
        (store, shared.into_inner().unwrap())
    }

    /// Line starts found by decoding UTF-16 units in order (std's decoder), never by scanning bytes.
    fn utf16_line_starts(bytes: &[u8], be: bool) -> Vec<u64> {
        let units = bytes
            .chunks_exact(2)
            .map(|p| if be { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) });
        let mut starts = if bytes.is_empty() { vec![] } else { vec![0u64] };
        let mut at = 0u64;
        for c in char::decode_utf16(units) {
            let newline = c == Ok('\n');
            at += c.map_or(2, |c| 2 * c.len_utf16() as u64);
            if newline && at < bytes.len() as u64 {
                starts.push(at);
            }
        }
        starts
    }

    fn utf16_file(units: &[u16], be: bool) -> Vec<u8> {
        let bom: &[u8] = if be { b"\xFE\xFF" } else { b"\xFF\xFE" };
        let body = units.iter().flat_map(|u| if be { u.to_be_bytes() } else { u.to_le_bytes() });
        bom.iter().copied().chain(body).collect()
    }

    /// Spike A's memchr(b'\n') finds 0x0A bytes. In UTF-16 that's wrong twice over: a 0x0A byte can be half of
    /// another unit (U+010A, U+0A0D, U+0A00), and a real newline is 2 bytes, so the next line starts 2 bytes on.
    #[test]
    fn utf16_lines_split_on_newline_units_not_0x0a_bytes() {
        for (be, encoding) in [(false, encoding_rs::UTF_16LE), (true, encoding_rs::UTF_16BE)] {
            let units: Vec<u16> = "Ċ\u{0A0D}\u{0A00}\r\nsecond ਊ\nthird".encode_utf16().collect();
            let bytes = utf16_file(&units, be);
            let (store, idx) = index_encoded("utf16-lines", &bytes, IndexConfig::default(), encoding);
            let got: Vec<Option<u64>> = (0..idx.line_count()).map(|l| locate_line(&store, &idx, l).unwrap()).collect();
            let want: Vec<Option<u64>> = utf16_line_starts(&bytes, be).into_iter().map(Some).collect();
            assert_eq!(got, want, "{encoding:?}");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]
        #[test]
        fn utf16_locate_line_matches_decoding(
            units in prop::collection::vec(
                prop::sample::select(vec![0x000A, 0x000D, 0x010A, 0x0A0D, 0x0A00, 0x0A0A, 0x0041, 0x00E9, 0xD83D, 0xDE00]),
                0..1500,
            ),
            be in any::<bool>(),
            cp_lines in 1u64..50,
            cp_bytes in 1u64..300, // odd values put mid-line checkpoints inside a unit
        ) {
            let encoding = if be { encoding_rs::UTF_16BE } else { encoding_rs::UTF_16LE };
            let bytes = utf16_file(&units, be);
            let (store, idx) = index_encoded("utf16-prop", &bytes, IndexConfig { cp_lines, cp_bytes, block: CHUNK }, encoding);
            let starts = utf16_line_starts(&bytes, be);
            prop_assert_eq!(idx.line_count(), starts.len() as u64);
            for (line, &start) in starts.iter().enumerate() {
                prop_assert_eq!(locate_line(&store, &idx, line as u64).unwrap(), Some(start));
            }
            for pair in idx.checkpoints.iter().collect::<Vec<_>>().windows(2) {
                prop_assert!(pair[1].offset - pair[0].offset <= cp_bytes, "checkpoint gap over cp_bytes");
            }
        }
    }
}
