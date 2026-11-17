//! Raw (brief §5.1) over a `Document`: the sniffed encoding, the line index and bounded pages.
use std::ops::Range;
use std::path::Path;
use std::sync::{Mutex, RwLock};

use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static UTF8_FALLBACK: AtomicBool = AtomicBool::new(false);
/// Applies to newly opened/reloaded documents; existing generations retain their detected encoding.
pub fn set_encoding_fallback(utf8: bool) {
    UTF8_FALLBACK.store(utf8, Ordering::Relaxed);
}

use crate::budget::{self, NoSlot, OverBudget, Reservation, Work};
use crate::doc::{Charges, DocError, Document};
use crate::encoding::{Sniffed, bom_len, sniff};
use crate::index::{IndexConfig, LineIndex, Progress, build};
use crate::local::LocalRoute;
use crate::md;
use crate::pages::{self, Caps, LinePiece, MAX_PATH_BYTES};
use crate::store::{CACHE_CHUNKS, CHUNK, StoreError, cancelled};

/// Plan C1: an open's own temporaries, reserved while it runs. The head it sniffs, and the chunk read for it on its way
/// into the cache; a single-byte decode of that head for the blank check (3 bytes per byte at most); the path's copies.
pub const OPEN_TEMP: u64 = (5 * CHUNK + 16 * MAX_PATH_BYTES + 64 * 1024) as u64;

pub struct Raw {
    doc: Document,
    index: RwLock<LineIndex>,
    /// Held through each index run, so a run that continues the index starts where the last one stopped. First in the
    /// lock order (`ByteStore`'s `len`).
    indexing: Mutex<()>,
    blank: AtomicBool,
    /// The length the encoding was last sniffed at: the whole file while it's at most a chunk (`extend`).
    sniffed: AtomicU64,
    /// The fallback that sniff used, which a later one uses again, whatever the setting is by then.
    fallback: &'static Encoding,
}

impl Raw {
    /// Opens `path` and sniffs its encoding from the first chunk (spec §4.1). A binary file is refused.
    pub fn open(path: &Path) -> Result<Raw, DocError> {
        Self::open_with(path, CACHE_CHUNKS, 1)
    }

    /// Plan C1: reserves the document's floor (its hashes, every byte-bound checkpoint, the cache's floor and its
    /// metadata) and the open's temporaries first. If the ledger can't hold them, the open fails with `Memory` and
    /// nothing stays charged.
    fn open_with(path: &Path, cache_chunks: usize, generation: u32) -> Result<Raw, DocError> {
        let _temp = Reservation::new(OPEN_TEMP).map_err(DocError::Memory)?; // declared first, released last
        let doc = Document::open_with(path, cache_chunks, generation)?;
        Self::from_document(doc)
    }

    /// The caller reserves `OPEN_TEMP` before either kind of document construction and this initial sniff.
    fn from_document(doc: Document) -> Result<Raw, DocError> {
        let fallback = if UTF8_FALLBACK.load(Ordering::Relaxed) { UTF_8 } else { WINDOWS_1252 };
        let index = LineIndex::new(doc.len(), &IndexConfig::default(), fallback).map_err(DocError::Memory)?;
        let head = doc.verified(doc.generation(), |store| store.read(0, CHUNK as u64))?;
        let encoding = match sniff(&head, doc.len() <= CHUNK as u64, fallback) {
            Sniffed::Text { encoding, .. } => encoding,
            Sniffed::Binary => return Err(DocError::Binary),
        };
        let blank = doc.len() <= CHUNK as u64 && whitespace_only(&head, encoding);
        let indexing = Mutex::new(());
        // macOS boxes a std mutex at its first lock: that's here, under the open's reservation, as an index run's start
        // has nothing reserved for it.
        drop(indexing.lock().unwrap());
        Ok(Raw {
            index: RwLock::new(LineIndex { encoding, ..index }),
            indexing,
            blank: AtomicBool::new(blank),
            sniffed: AtomicU64::new(doc.len()),
            fallback,
            doc,
        })
    }

    /// What this document holds charged, itemized (plan C1, C6).
    pub fn charges(&self) -> Charges {
        Charges { checkpoints: self.index.read().unwrap().checkpoints.charged(), ..self.doc.charges() }
    }

    /// Ctrl+R (spec §3.1): the same path, opened again one generation later, with a new index. This generation
    /// freezes, so its index stops at its next block and its pages and tokens are refused. If the open fails
    /// (the file is gone, say), this generation stays as it was.
    pub fn reload(&self) -> Result<Raw, DocError> {
        self.reload_in_folder(None)
    }

    pub fn reload_in_folder(&self, folder: Option<&crate::local::folder::Folder>) -> Result<Raw, DocError> {
        let _temp = Reservation::new(OPEN_TEMP).map_err(DocError::Memory)?;
        let mut doc = self.doc.reopened()?;
        if let Some(folder) = folder {
            doc.bind_folder(folder)?;
        }
        let next = Self::from_document(doc)?;
        let _ = self.doc.freeze("reloaded".into());
        Ok(next)
    }

    /// A local target is opened and sniffed through the inherited capability, with source checks on both sides.
    pub fn open_local(&self, generation: u32, target: &str) -> Result<Raw, DocError> {
        let _temp = Reservation::new(OPEN_TEMP).map_err(DocError::Memory)?;
        let target = self.doc.open_local(generation, target)?;
        let next = Self::from_document(target).map_err(crate::doc::local_target_error)?;
        self.doc.check_local_source(generation)?;
        Ok(next)
    }

    /// Non-consuming reopen: only a saved route survives, and current bytes get a new verified index.
    pub fn open_saved(route: &LocalRoute) -> Result<Raw, DocError> {
        let _temp = Reservation::new(OPEN_TEMP).map_err(DocError::Memory)?;
        Document::from_saved(route, CACHE_CHUNKS).and_then(Self::from_document).map_err(crate::doc::local_target_error)
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn csv(
        &self,
        generation: u32,
        revision: u32,
        options: crate::csv::Options,
    ) -> Result<crate::csv::Csv, DocError> {
        crate::csv::Csv::new(&self.doc, generation, revision, options, self.index.read().unwrap().encoding)
    }

    pub fn line_offset(&self, generation: u32, line: u64) -> Result<Option<u64>, DocError> {
        let index = self.index.read().unwrap();
        self.doc.verified(generation, |store| crate::index::locate_line(store, &index, line))
    }

    pub fn source_encoding(&self) -> &'static Encoding {
        self.index.read().unwrap().encoding
    }
    pub fn source_line_at(&self, generation: u32, offset: u64) -> Result<Option<u64>, DocError> {
        if offset == 0 {
            return self.doc.verified(generation, |_| Ok(Some(0)));
        }
        let index = self.index.read().unwrap();
        if offset > index.indexed_bytes {
            return Ok(None);
        }
        let at = index.checkpoints.partition_point(|cp| cp.offset <= offset).saturating_sub(1);
        let cp = index.checkpoints.get(at);
        let start =
            if crate::encoding::newline_and_cr(index.encoding).0.len() == 2 { cp.offset & !1 } else { cp.offset };
        self.doc.verified(generation, |store| {
            let bytes = store.read(start, offset)?;
            Ok(Some(cp.line + crate::encoding::newline_ends(index.encoding, start, &bytes).count() as u64))
        })
    }

    pub fn bind_folder(&mut self, folder: &crate::local::folder::Folder) -> Result<bool, DocError> {
        self.doc.bind_folder(folder)
    }

    /// Generation `generation` as Markdown blocks, from one verified read in Raw's encoding (`md::build`). The store's
    /// cancel flag (`store::cancellable`) stops it.
    pub fn render(&self, generation: u32) -> Result<md::Rendered, DocError> {
        let encoding = self.index.read().unwrap().encoding; // not held while it builds: the index publishes meanwhile
        md::build(&self.doc, encoding, generation, &cancelled)
    }

    /// Generation `generation`'s embedded image at source bytes `span`, read in Raw's encoding as the Markdown build
    /// read it (`image_resource::prepare_embedded`).
    pub fn embedded_image(
        &self,
        generation: u32,
        span: std::ops::Range<u64>,
        cancel: &AtomicBool,
    ) -> Result<crate::images::CanonicalImage, DocError> {
        let encoding = self.index.read().unwrap().encoding;
        crate::image_resource::prepare_embedded(&self.doc, encoding, generation, span, cancel)
    }

    /// Brief §7.9's empty file: 0 bytes, or only whitespace. Judged on the first chunk, so only for a file that
    /// fits in it; a bigger one shows its blank lines. Judged again as it grows (`extend`).
    pub fn blank(&self) -> bool {
        self.blank.load(Ordering::Relaxed)
    }

    /// `encoding_rs`'s name: `UTF-8`, `UTF-16LE`, `UTF-16BE` or `windows-1252`.
    pub fn encoding(&self) -> &'static str {
        self.index.read().unwrap().encoding.name()
    }

    /// (lines found so far, whether indexing is done: whether it has reached the document's length, which an extend
    /// moves on).
    pub fn lines_known(&self) -> (u64, bool) {
        let index = self.index.read().unwrap();
        (index.line_count(), index.done(self.doc.len()))
    }

    /// Up to `count` lines from `start` (plan C2's bounds) of generation `generation`, with an identity check after
    /// the reads (`Document::verified`).
    pub fn page(&self, generation: u32, start: u64, count: usize) -> Result<Vec<LinePiece>, DocError> {
        self.page_with(generation, start, count, || {})
    }

    /// `between` runs just before the reads: the mutation-race test writes there.
    fn page_with(
        &self,
        generation: u32,
        start: u64,
        count: usize,
        between: impl FnOnce(),
    ) -> Result<Vec<LinePiece>, DocError> {
        let index = self.index.read().unwrap();
        self.doc.verified(generation, |store| {
            between();
            pages::lines(store, &index, start, count)
        })
    }

    /// Plan C3: the piece a continuation token names, checked as if forged. An old generation is `Stale`; an offset
    /// this core couldn't have issued is `Invalid`.
    pub fn piece(&self, generation: u32, line: u64, offset: u64) -> Result<LinePiece, DocError> {
        let index = self.index.read().unwrap();
        self.doc
            .verified(generation, |store| pages::piece(store, &index, line, offset, Caps::DEFAULT))?
            .map_err(|e| DocError::Invalid(e.0))
    }

    /// Builds the line index through its own handle, so page reads never queue behind index reads. The handle is
    /// reopened from the document's, not from the path (plan PR 4). Its chunk hashes are the document's: a chunk
    /// either one reads first is verified when the other reads it (§3.1).
    ///
    /// Plan C6: after each block, the index goes on only while `on_progress` says to (close cancels it there) and
    /// the document isn't frozen. A failed read or chunk check freezes the document and ends the index with the
    /// reason; a freeze found by a page (or Reload) ends it at its next block. What's indexed so far stays.
    ///
    /// Plan C1: the job's buffers take an index slot, which it waits for. A cancel (`store::cancellable`) ends the wait,
    /// and the job with it.
    ///
    /// Live tail (Z95): each run picks up where the last one stopped and goes on to the document's length as it is at
    /// each block, so it takes in an extend made while it runs; after one made since, a run continues it. Runs take
    /// turns, before their slots. When the ledger can't hold the checkpoints a longer document needs, the run stops
    /// with `Memory` at that block, unpublished (what its earlier blocks published stays), the document not frozen, and
    /// a later run with room goes on.
    pub fn index(&self, mut on_progress: impl FnMut(Progress) -> bool) -> Result<(), String> {
        let _run = self.indexing.lock().unwrap();
        let _slot = match budget::slot(Work::Index, &cancelled) {
            Ok(slot) => slot,
            Err(NoSlot::Cancelled) => return Ok(()), // closed before it started: nothing indexed, nothing frozen
            Err(NoSlot::Budget(e)) => return Err(DocError::Memory(e).to_string()),
        };
        let file = self.doc.index_file().map_err(|e| e.to_string())?;
        let built = build(&file, self.doc.store(), IndexConfig::default(), &self.index, |p| {
            on_progress(p) && self.doc.frozen().is_none()
        });
        match built {
            Ok(()) => {}
            Err(StoreError::Io(ref e)) if let Some(over) = e.get_ref().and_then(|e| e.downcast_ref::<OverBudget>()) => {
                return Err(DocError::Memory(*over).to_string());
            }
            Err(e) => return Err(self.doc.fail(e).to_string()),
        }
        match self.doc.frozen() {
            Some(why) if !self.lines_known().1 => Err(format!("frozen: {why}")),
            _ => Ok(()),
        }
    }

    /// Live tail (Z95): the document grows with an append, in place and in the same generation (`Document::extend`),
    /// and this returns the bytes it gained, or `None` when nothing was appended. The index is then not done until a run
    /// continues it (`index`), which charges the longer document's checkpoints first.
    ///
    /// While the document is at most a chunk long, its sniff and blank check saw all of it, so they're made again at
    /// the new length, from a read in its caller's page slot through the store, chunk-verified, with no identity check,
    /// as the extend has just made one. An encoding the sniff would now decide differently freezes the document, with a
    /// reason that says so (Reload reads it again). A sniff cut short (a cancelled read) is owed, and the next call
    /// makes it.
    pub fn extend(&self) -> Result<Option<Range<u64>>, DocError> {
        let grew = self.doc.extend()?;
        let sniffed = self.sniffed.load(Ordering::Acquire);
        if sniffed <= CHUNK as u64 && sniffed < self.doc.len() {
            if let Some(why) = self.doc.frozen() {
                return Err(DocError::Frozen(why)); // a frozen document reads nothing
            }
            // A byte past the chunk tells whether the chunk is the whole file, at the length the read saw.
            let mut head = self.doc.store().read(0, CHUNK as u64 + 1).map_err(|e| self.doc.fail(e))?;
            let whole = head.len() <= CHUNK;
            head.truncate(CHUNK);
            let encoding = self.index.read().unwrap().encoding;
            let now = match sniff(&head, whole, self.fallback) {
                Sniffed::Text { encoding } => encoding.name(),
                Sniffed::Binary => "binary",
            };
            if now != encoding.name() {
                let why = format!("changed on disk: its encoding is now {now}, not {} (Reload)", encoding.name());
                return Err(self.doc.freeze(why));
            }
            if self.blank.load(Ordering::Relaxed) {
                self.blank.store(whole && whitespace_only(&head, encoding), Ordering::Relaxed);
            }
            self.sniffed.fetch_max(if whole { head.len() as u64 } else { u64::MAX }, Ordering::AcqRel);
        }
        Ok(grew)
    }
}

/// Whether `head`, a whole file, holds only whitespace after its BOM.
fn whitespace_only(head: &[u8], encoding: &'static Encoding) -> bool {
    let bom = bom_len(head, encoding);
    encoding.decode_without_bom_handling(&head[bom..]).0.chars().all(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::FileId;
    use crate::store::testutil::temp_file;
    use encoding_rs::{UTF_8, UTF_16BE, UTF_16LE};
    use std::fs::{self, OpenOptions};
    use std::io::{self, Seek, SeekFrom, Write};

    #[test]
    fn the_first_page_needs_no_index_and_the_rest_follows_it() {
        let path = temp_file("raw-first", b"one\ntwo\r\nthree");
        let raw = Raw::open(&path).unwrap();
        assert_eq!(raw.encoding(), "UTF-8");
        let first = raw.page(1, 0, 10).unwrap();
        assert_eq!(first.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["one", "two", "three"]);
        assert_eq!(raw.lines_known(), (0, false));
        raw.index(|_| true).unwrap();
        assert_eq!(raw.lines_known(), (3, true));
        assert_eq!(raw.page(1, 2, 10).unwrap()[0].text, "three");
    }

    #[test]
    fn a_binary_file_is_refused_and_utf16_and_windows_1252_are_sniffed() {
        assert!(matches!(Raw::open(&temp_file("raw-bin", b"PK\x03\x04\0\0")), Err(DocError::Binary)));
        assert_eq!(Raw::open(&temp_file("raw-le", b"\xFF\xFEa\0")).unwrap().encoding(), "UTF-16LE");
        assert_eq!(Raw::open(&temp_file("raw-be", b"\xFE\xFF\0a")).unwrap().encoding(), "UTF-16BE");
        assert_eq!(Raw::open(&temp_file("raw-1252", b"caf\xE9")).unwrap().encoding(), "windows-1252");
    }

    /// Brief §7.9: "Empty file (0 bytes, or only whitespace)".
    #[test]
    fn an_empty_or_whitespace_only_file_is_blank() {
        let blank = |name: &str, bytes: &[u8]| Raw::open(&temp_file(name, bytes)).unwrap().blank();
        assert!(blank("blank-0", b""));
        assert!(blank("blank-ws", b" \r\n\t\n  \n"));
        assert!(blank("blank-bom", b"\xEF\xBB\xBF \n"));
        assert!(blank("blank-u16", b"\xFF\xFE \0\n\0\x00\x30")); // U+3000, an ideographic space
        assert!(blank("blank-nbsp", "\u{A0}\n".as_bytes()));
        assert!(blank("blank-1252-nbsp", b"\xA0\n\xA0\x0B")); // windows-1252 (0xA0 alone isn't UTF-8): NBSP, VT
        assert!(!blank("blank-1252-text", b"\xA0\xE9"));
        assert!(!blank("blank-text", b"\n\n x\n"));
        assert!(!blank("blank-u16-odd", b"\xFF\xFE \0\n"));
        assert!(!blank("blank-big", &[b' '; 2 << 20])); // past the first chunk: shown as blank lines
    }

    #[test]
    fn blank_decoding_keeps_malformed_text_and_nonmatching_boms_visible() {
        let cases: &[(&[u8], &Encoding, bool)] = &[
            (b"", UTF_8, true),
            (b"\xEF\xBB\xBF", UTF_8, true),
            ("\u{A0}\u{3000}\n".as_bytes(), UTF_8, true),
            (b" \xFF", UTF_8, false),
            (b"\xC0\xA0", UTF_8, false), // an overlong encoding of a space
            (b"\xE3\x80", UTF_8, false), // a truncated ideographic space
            (b"\xEF\xBB\xBF\xEF\xBB\xBF", UTF_8, false),
            (b"", UTF_16LE, true),
            (b"\xFF\xFE \0\x00\x30", UTF_16LE, true),
            (b"\xFE\xFF\0 \x30\x00", UTF_16BE, true),
            (b"\xFF\xFE \0\n", UTF_16LE, false),
            (b"\xFE\xFF\0 \n", UTF_16BE, false),
            (b"\xFF\xFE\0\xD8", UTF_16LE, false),
            (b"\xFF\xFE\0\xDC", UTF_16LE, false),
            (b"\xFE\xFF\xD8\0", UTF_16BE, false),
            (b"\xFE\xFF\xDC\0", UTF_16BE, false),
            (b"\xFE\xFF", UTF_16LE, false),
            (b"\xFF\xFE", UTF_16BE, false),
            (b"\xEF\xBB\xBF", WINDOWS_1252, false),
            (b"\xA0\n\x0B", WINDOWS_1252, true),
            (b"\xA0x", WINDOWS_1252, false),
        ];
        for &(bytes, encoding, blank) in cases {
            assert_eq!(whitespace_only(bytes, encoding), blank, "{}: {bytes:?}", encoding.name());
        }
    }

    fn letters(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| b'a' + ((i + seed as usize) % 26) as u8).collect()
    }

    /// Plan C3: after Reload, every page and token of the old generation is `Stale`, and the old generation's
    /// index stops at its next block (C6).
    #[test]
    fn reload_makes_old_pages_and_tokens_stale_and_stops_the_old_index() {
        let path = temp_file("raw-reload", &[letters(1 << 20, 0), b"\n".to_vec(), letters(11 << 20, 1)].concat());
        let raw = Raw::open(&path).unwrap();
        let first = raw.page(1, 0, 1).unwrap().remove(0);
        let token = first.next.unwrap();
        assert_eq!(raw.piece(1, 0, token).unwrap().offset, token);
        let mut fresh = None;
        let indexed = raw.index(|_| {
            if fresh.is_none() {
                fresh = Some(raw.reload().unwrap()); // after the first 4 MiB block of four
            }
            true
        });
        assert_eq!(indexed, Err("frozen: reloaded".into()));
        assert!(!raw.lines_known().1);
        let fresh = fresh.unwrap();
        assert_eq!(fresh.document().generation(), 2);
        assert!(matches!(fresh.piece(1, 0, token), Err(DocError::Stale { current: 2, asked: 1 })));
        assert!(matches!(fresh.page(1, 0, 1), Err(DocError::Stale { current: 2, asked: 1 })));
        let want = &letters(1 << 20, 0)[token as usize..token as usize + 65_536];
        assert_eq!(fresh.piece(2, 0, token).unwrap().text.as_bytes(), want);
        assert!(matches!(raw.page(1, 0, 1), Err(DocError::Frozen(_)))); // the old generation itself is frozen
    }

    /// Plan C6's freeze half: a truncation mid-index fails the index's next read, which freezes the document and
    /// ends the index with the reason. What it indexed stays; pages are refused.
    #[test]
    fn a_truncation_mid_index_freezes_the_document_and_ends_the_index() {
        let path = temp_file("raw-truncate", &b"0123456789abcde\n".repeat(12 << 16)); // 12 MiB of 16-byte lines
        let raw = Raw::open(&path).unwrap();
        let mut blocks = 0;
        let indexed = raw.index(|_| {
            blocks += 1;
            if blocks == 1 {
                OpenOptions::new().write(true).open(&path).unwrap().set_len(6 << 20).unwrap();
            }
            true
        });
        assert_eq!(indexed, Err("frozen: changed on disk (chunk 4)".into()));
        assert_eq!((blocks, raw.lines_known()), (1, (1 << 18, false))); // the first 4 MiB stay indexed
        assert!(matches!(raw.page(1, 0, 1), Err(DocError::Frozen(_))));
    }

    /// Plan C6's freeze half: a page that finds a change freezes the document, and the index ends at its next block.
    #[test]
    fn a_change_a_page_finds_ends_the_index_at_its_next_block() {
        let path = temp_file("raw-page-freeze", &b"0123456789abcde\n".repeat(12 << 16));
        let raw = Raw::open(&path).unwrap();
        let mut blocks = 0;
        let indexed = raw.index(|_| {
            blocks += 1;
            if blocks == 1 {
                OpenOptions::new().append(true).open(&path).unwrap().write_all(b"appended\n").unwrap();
                assert!(matches!(raw.page(1, 0, 1), Err(DocError::Frozen(_))));
            }
            true
        });
        assert_eq!((indexed, blocks), (Err("frozen: changed on disk".into()), 1));
    }

    /// Plan C6: close cancels the index through its progress callback, which stops it at the end of that block.
    /// The document isn't frozen: what's indexed stays, and pages still read.
    #[test]
    fn a_cancelled_index_stops_at_its_next_block_without_freezing() {
        let path = temp_file("raw-cancel-index", &b"0123456789abcde\n".repeat(12 << 16));
        let raw = Raw::open(&path).unwrap();
        let mut blocks = 0;
        let indexed = raw.index(|_| {
            blocks += 1;
            false
        });
        assert_eq!((indexed, blocks), (Ok(()), 1));
        assert_eq!(raw.lines_known(), (1 << 18, false)); // the first 4 MiB block
        assert_eq!(raw.document().frozen(), None);
        assert_eq!(raw.page(1, 1000, 1).unwrap()[0].text, "0123456789abcde");
    }

    /// Plan C5: a page read whose cancel flag is set stops at its next chunk with `Cancelled`, and the document reads
    /// on: a cancel isn't a change on disk.
    #[test]
    fn a_cancelled_page_stops_with_cancelled_and_the_document_reads_on() {
        use crate::store::cancellable;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let path = temp_file("raw-cancel-page", &b"0123456789abcde\n".repeat(12 << 16));
        let raw = Raw::open(&path).unwrap();
        raw.index(|_| true).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let far = 10 << 16; // line 655,360, in chunk 10: not read yet
        assert!(matches!(cancellable(&cancel, || raw.page(1, far, 4)), Err(DocError::Cancelled)));
        assert!(matches!(cancellable(&cancel, || raw.piece(1, 0, 1)), Err(DocError::Cancelled)));
        assert_eq!(raw.document().frozen(), None);
        cancel.store(false, Ordering::Relaxed);
        assert_eq!(cancellable(&cancel, || raw.page(1, far, 4)).unwrap().len(), 4);
        // The flag is the read's, not the thread's: outside `cancellable` nothing is checked.
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(raw.page(1, far, 4).unwrap().len(), 4);
    }

    /// Spec §13.1 Spike C's mutation race, through Raw's pages: an in-place, same-size write just before the read,
    /// with the timestamp restored, is caught by chunk verification in 1,000 of 1,000 runs.
    #[test]
    fn mutation_race_against_raw_pages_is_caught_1000_of_1000() {
        const LINE: usize = 64;
        let per_chunk = (CHUNK / LINE) as u64;
        let original: Vec<u8> = (0..4 * per_chunk).flat_map(|i| format!("{i:063}\n").into_bytes()).collect();
        let path = temp_file("raw-race", &original);
        let mut caught = 0;
        for run in 0..1000u64 {
            let chunk = run % 4;
            let line = chunk * per_chunk + (run * 7919) % (per_chunk - 1);
            let at = line * LINE as u64;
            let raw = Raw::open_with(&path, 1, 1).unwrap();
            raw.index(|_| true).unwrap();
            raw.page(1, line, 1).unwrap(); // reads `chunk`, already hashed by the index
            let other = ((chunk + 2) % 4) * per_chunk;
            raw.page(1, other, 1).unwrap(); // evicts it from the one-chunk cache
            let id_before = FileId::of(&path).unwrap();
            let result = raw.page_with(1, line, 1, || {
                let mut f = OpenOptions::new().write(true).open(&path).unwrap();
                f.seek(SeekFrom::Start(at)).unwrap();
                f.write_all(b"XXXXXXXXXXXXXXXX").unwrap();
                f.set_modified(id_before.modified).unwrap();
            });
            assert_eq!(FileId::of(&path).unwrap(), id_before, "the write must be invisible to metadata");
            if matches!(result, Err(DocError::Frozen(ref why)) if why.contains("chunk")) {
                caught += 1;
            }
            let mut f = OpenOptions::new().write(true).open(&path).unwrap();
            f.seek(SeekFrom::Start(at)).unwrap();
            f.write_all(&original[at as usize..at as usize + 16]).unwrap();
            f.set_modified(id_before.modified).unwrap();
        }
        assert_eq!(caught, 1000);
    }

    /// Spec §13.1 Spike C's 1,000 append/truncate/replace/delete/rename-away cycles, through Raw's pages and
    /// continuation pieces: no operation is blocked, nothing stale is accepted, and Reload reads the new file.
    #[test]
    fn a_thousand_mutation_cycles_against_raw_never_block_and_never_show_stale_text() {
        let path = temp_file("raw-cycles", &letters(2 * CHUNK, 3)); // one 2 MiB line: a first piece and more
        let (tmp, moved) = (path.with_extension("tmp"), path.with_extension("moved"));
        let mut raw = Raw::open(&path).unwrap();
        let (mut blocked, mut stale_accepted) = (Vec::new(), 0);
        for i in 0..1000u32 {
            let generation = raw.document().generation();
            let token = raw.page(generation, 0, 1).unwrap()[0].next.unwrap();
            raw.piece(generation, 0, token).unwrap();
            let op: io::Result<()> = match i % 5 {
                0 => OpenOptions::new().append(true).open(&path).and_then(|mut f| f.write_all(b"appended")),
                1 => OpenOptions::new().write(true).open(&path).and_then(|f| f.set_len(CHUNK as u64 + i as u64)),
                2 => fs::write(&tmp, letters(CHUNK + 100, i as u8)).and_then(|_| fs::rename(&tmp, &path)),
                3 => fs::remove_file(&path).and_then(|_| fs::write(&path, letters(CHUNK + 7, i as u8))),
                _ => fs::rename(&path, &moved), // the open file renamed away: nothing is at the path now
            };
            if let Err(e) = op {
                blocked.push(format!("cycle {i}: {e}"));
                continue;
            }
            stale_accepted += usize::from(raw.page(generation, 0, 1).is_ok());
            stale_accepted += usize::from(raw.piece(generation, 0, token).is_ok());
            if i % 5 == 4
                && let Err(e) = fs::write(&path, letters(CHUNK + 11, i as u8))
            {
                blocked.push(format!("cycle {i}: recreate: {e}"));
                continue;
            }
            raw = raw.reload().unwrap();
            let fresh = raw.page(raw.document().generation(), 0, 1).unwrap().remove(0);
            assert_eq!(fresh.text.as_bytes(), &fs::read(&path).unwrap()[..fresh.text.len()]);
        }
        let _ = fs::remove_file(&moved);
        assert!(blocked.is_empty(), "blocked operations: {blocked:?}");
        assert_eq!(stale_accepted, 0);
    }

    fn append(path: &Path, bytes: &[u8]) {
        OpenOptions::new().append(true).open(path).unwrap().write_all(bytes).unwrap();
    }

    fn texts(raw: &Raw) -> Vec<String> {
        raw.page(1, 0, 10).unwrap().into_iter().map(|p| p.text).collect()
    }

    /// Z95: an append that completes an unfinished last line. That line was counted already, so the count stays, and
    /// its bytes then read whole; a line after it is counted. Between the extend and the run that continues the index,
    /// the index isn't done.
    #[test]
    fn an_append_that_completes_the_last_line_keeps_the_count() {
        let path = temp_file("raw-complete-line", b"one\ntw");
        let raw = Raw::open(&path).unwrap();
        raw.index(|_| true).unwrap();
        assert_eq!((raw.lines_known(), texts(&raw)), ((2, true), vec!["one".to_string(), "tw".into()]));
        append(&path, b"o\n");
        assert_eq!(raw.extend().unwrap(), Some(6..8));
        assert_eq!(raw.lines_known(), (2, false));
        raw.index(|_| true).unwrap();
        assert_eq!((raw.lines_known(), texts(&raw)), ((2, true), vec!["one".to_string(), "two".into()]));
        append(&path, b"three");
        assert_eq!(raw.extend().unwrap(), Some(8..13));
        raw.index(|_| true).unwrap();
        assert_eq!(
            (raw.lines_known(), texts(&raw)),
            ((3, true), vec!["one".to_string(), "two".into(), "three".into()])
        );
    }

    /// Z95, and PR 116's precondition gone: an extend while the first index runs, between its blocks, after a read
    /// hashed the old last chunk, part of it, so the extend hashes it again at the new length. The index reads each
    /// block at the length as it is then, so it goes on to the new end with nothing `Changed`, and ends as the index of
    /// the whole file.
    #[test]
    fn an_extend_while_the_index_runs_is_taken_in() {
        let line = b"0123456789abcde\n";
        let old = [line.repeat(6 << 16), b"0123".to_vec()].concat(); // 6 MiB and an unfinished line
        let path = temp_file("raw-extend-mid-index", &old);
        let raw = Raw::open(&path).unwrap();
        let len = old.len() as u64;
        raw.document().read(1, len - 4, len).unwrap();
        let more = [b"456789abcde\n".to_vec(), line.repeat(1 << 17)].concat(); // ends that line, then 2 MiB
        let mut blocks = 0;
        raw.index(|_| {
            blocks += 1;
            if blocks == 1 {
                append(&path, &more);
                assert_eq!(raw.extend().unwrap(), Some(len..len + more.len() as u64));
            }
            true
        })
        .unwrap();
        assert_eq!((raw.lines_known(), raw.document().frozen()), (((6 << 16) + 1 + (1 << 17), true), None));
        let whole = Raw::open(&path).unwrap();
        whole.index(|_| true).unwrap();
        let (got, want) = (raw.index.read().unwrap(), whole.index.read().unwrap());
        assert_eq!(
            (got.newlines, got.last_line_start, got.indexed_bytes),
            (want.newlines, want.last_line_start, want.indexed_bytes)
        );
        assert!(got.checkpoints.iter().eq(want.checkpoints.iter()), "the checkpoints differ from the whole file's");
    }

    /// Review of #116's predicted deadlock. A page read holds the line-index lock across its store reads, so it can
    /// hold it while it waits for the length's read side behind a queued extend; an index that held the read side while
    /// it took the line-index lock to publish would then wait on the page, the page on the extend, and the extend on
    /// the index, for good. Here, in each of 200 rounds, the index holds the read side in its block read
    /// (`store::BLOCK_READ`) while an append's extend queues on the write side, and a page read takes the line-index
    /// lock and waits behind the extend; then the index goes on to publish. The run must end, with every extend and page
    /// whole and the index done at the file's line count. This thread is the watchdog: two minutes without an end is the
    /// deadlock.
    #[test]
    fn a_page_read_an_extend_and_the_index_never_wait_on_each_other() {
        use std::cell::RefCell;
        use std::rc::Rc;
        use std::sync::Arc;
        use std::sync::mpsc::{RecvTimeoutError, channel};
        use std::thread::{JoinHandle, spawn, yield_now};
        const ROUNDS: usize = 200;
        let path = temp_file("raw-deadlock", &b"a line of text\n".repeat(64));
        let raw = Arc::new(Raw::open(&path).unwrap());
        let (ended, end) = channel();
        let run = {
            let (raw, path) = (raw.clone(), path.to_path_buf());
            spawn(move || {
                // Rounds run, and the extends and pages of the last round, to join.
                let state = Rc::new(RefCell::new((0, Vec::<JoinHandle<Result<(), String>>>::new(), Vec::new())));
                let hook = {
                    let (state, raw) = (state.clone(), raw.clone());
                    move |len: &RwLock<u64>| {
                        let (rounds, pending, failed) = &mut *state.borrow_mut();
                        // This read waited for the last round's extend, and its page needs nothing this thread holds.
                        failed.extend(pending.drain(..).filter_map(|t| t.join().unwrap().err()));
                        if *rounds == ROUNDS {
                            return;
                        }
                        *rounds += 1;
                        append(&path, b"another line\n");
                        let extend = {
                            let raw = raw.clone();
                            spawn(move || match raw.extend() {
                                Ok(Some(grew)) if grew.end - grew.start == 13 => Ok(()),
                                other => Err(format!("extend: {other:?}")),
                            })
                        };
                        std::thread::scope(|s| {
                            s.spawn(|| {
                                while len.try_read().is_ok() && !extend.is_finished() {
                                    yield_now(); // until the extend is queued on the write side
                                }
                            });
                        });
                        let page = {
                            let raw = raw.clone();
                            spawn(move || match raw.page(1, 0, 4) {
                                Ok(page) if page.len() == 4 => Ok(()),
                                other => Err(format!("page: {other:?}")),
                            })
                        };
                        while raw.index.try_write().is_ok() && !page.is_finished() {
                            yield_now(); // until the page holds the line-index lock
                        }
                        // Both wait: the extend on this thread's read side, the page behind the extend.
                        assert!(!extend.is_finished() && !page.is_finished(), "round {rounds}: one didn't wait");
                        pending.extend([extend, page]);
                    }
                };
                crate::store::BLOCK_READ.set(Some(Box::new(hook)));
                let indexed = raw.index(|_| true);
                crate::store::BLOCK_READ.take();
                let (rounds, pending, mut failed) = Rc::try_unwrap(state).ok().unwrap().into_inner();
                failed.extend(pending.into_iter().filter_map(|t| t.join().unwrap().err()));
                ended.send(()).unwrap();
                (indexed, rounds, failed)
            })
        };
        if let Err(RecvTimeoutError::Timeout) = end.recv_timeout(std::time::Duration::from_secs(120)) {
            panic!("no end in 120 s: the index, an extend and a page read wait on each other");
        }
        let (indexed, rounds, failed) = run.join().unwrap();
        assert_eq!((indexed, rounds, failed), (Ok(()), ROUNDS, Vec::<String>::new()));
        assert_eq!((raw.lines_known(), raw.document().frozen()), ((64 + ROUNDS as u64, true), None));
    }

    /// Z95: while a file is at most a chunk long, its sniff and blank check saw all of it, so an extend makes them
    /// again. An empty file that gains whitespace stays blank, and one that gains text isn't; a file whose new bytes the
    /// sniff reads as another encoding freezes, with a reason that names both.
    #[test]
    fn an_extend_sniffs_a_small_file_again() {
        let path = temp_file("raw-extend-blank", b"");
        let raw = Raw::open(&path).unwrap();
        assert!(raw.blank());
        append(&path, b" \r\n");
        assert_eq!((raw.extend().unwrap(), raw.blank()), (Some(0..3), true));
        append(&path, b"text\n");
        assert_eq!((raw.extend().unwrap(), raw.blank()), (Some(3..8), false));
        assert_eq!((raw.encoding(), raw.document().frozen()), ("UTF-8", None));
        let cases = [
            ("half-char", b"caf\xE2\x82".as_slice(), b"\xAC!".as_slice(), "windows-1252", "UTF-8"), // half a euro sign
            ("nul", b"text", b"\0", "UTF-8", "binary"),
            ("bom", b"", b"\xFF\xFEa\0", "UTF-8", "UTF-16LE"),
        ];
        for (name, before, after, was, now) in cases {
            let path = temp_file(&format!("raw-extend-sniff-{name}"), before);
            let raw = Raw::open(&path).unwrap();
            assert_eq!(raw.encoding(), was, "{name}");
            append(&path, after);
            let why = format!("changed on disk: its encoding is now {now}, not {was} (Reload)");
            let result = raw.extend();
            assert!(matches!(result, Err(DocError::Frozen(ref w)) if *w == why), "{name}: {result:?}");
            assert_eq!(raw.document().frozen(), Some(why), "{name}");
        }
    }

    /// Z95: a file over a chunk isn't sniffed again: its sniff saw only its first chunk, which an append doesn't change.
    /// With the read's cancel flag set, its extend reads nothing, so it extends. A small file's extend stops at the
    /// sniff's read, `Cancelled`, extended and not frozen; its next extend, with nothing appended, makes the sniff it
    /// owes, and freezes.
    #[test]
    fn an_extend_sniffs_again_only_a_file_it_saw_whole() {
        use crate::store::cancellable;
        use std::sync::Arc;
        let cancel = Arc::new(AtomicBool::new(true));
        let big = [b"caf\xE2\x82".as_slice(), &letters(CHUNK, 0)].concat(); // invalid UTF-8 in its first chunk
        let path = temp_file("raw-extend-big", &big);
        let raw = Raw::open(&path).unwrap();
        append(&path, b"more\n");
        let len = big.len() as u64;
        assert_eq!(cancellable(&cancel, || raw.extend()).unwrap(), Some(len..len + 5));
        assert_eq!((raw.encoding(), raw.document().frozen()), ("windows-1252", None));
        let path = temp_file("raw-extend-owed", b"caf\xE2\x82");
        let raw = Raw::open(&path).unwrap();
        append(&path, b"\xAC");
        assert!(matches!(cancellable(&cancel, || raw.extend()), Err(DocError::Cancelled)));
        assert_eq!((raw.document().len(), raw.document().frozen()), (6, None));
        let result = raw.extend();
        assert!(matches!(result, Err(DocError::Frozen(ref why)) if why.contains("now UTF-8")), "{result:?}");
    }

    /// Review of #117: a run stopped at its last block isn't done, though it has reached the end of the file, as before
    /// Z95. Frozen there (in the only block of a small file, or the last of several), `index` ends with the freeze, which
    /// the host's index-error cleanup waits for. Stopped there by its callback, it isn't done, until a later run is.
    #[test]
    fn a_run_stopped_at_its_last_block_is_not_done() {
        let small = b"one\ntwo\nthree".to_vec();
        let big = [b"0123456789abcde\n".repeat(1 << 18), b"tail".to_vec()].concat(); // 4 MiB and 4 bytes: two blocks
        for (name, bytes, blocks, lines) in [("small", &small, 1, 3), ("big", &big, 2, (1 << 18) + 1)] {
            let raw = Raw::open(&temp_file(&format!("raw-last-frozen-{name}"), bytes)).unwrap();
            let mut seen = 0;
            let indexed = raw.index(|p| {
                seen += 1;
                if seen == blocks && !p.done {
                    let _ = raw.document().freeze("in the last block".into());
                }
                true
            });
            assert_eq!(
                (indexed, raw.lines_known()),
                (Err("frozen: in the last block".into()), (lines, false)),
                "{name}"
            );
            let raw = Raw::open(&temp_file(&format!("raw-last-stopped-{name}"), bytes)).unwrap();
            let mut seen = 0;
            let indexed = raw.index(|p| {
                seen += 1;
                seen != blocks || p.done // no to the last block's event
            });
            assert_eq!((indexed, raw.lines_known()), (Ok(()), (lines, false)), "{name}");
            raw.index(|_| true).unwrap();
            assert_eq!(raw.lines_known(), (lines, true), "{name}: a later run");
        }
    }

    /// Review of #117: index runs on one document take turns (`indexing`). Without that, two runs started together after
    /// an extend resume from the same state and each publish the same checkpoints. Here, in three rounds, two runs start
    /// together after a 9 MiB extend, and the index must equal a fresh index of the same bytes.
    #[test]
    fn two_index_runs_at_once_take_turns() {
        use std::sync::{Arc, Barrier};
        let line = b"0123456789abcde\n";
        let path = temp_file("raw-two-runs", &line.repeat(64));
        let raw = Arc::new(Raw::open(&path).unwrap());
        raw.index(|_| true).unwrap();
        for round in 0..3 {
            append(&path, &line.repeat(9 << 16));
            assert!(raw.extend().unwrap().is_some());
            let start = Arc::new(Barrier::new(2));
            let runs: Vec<_> = (0..2)
                .map(|_| {
                    let (raw, start) = (raw.clone(), start.clone());
                    std::thread::spawn(move || {
                        start.wait();
                        raw.index(|_| true)
                    })
                })
                .collect();
            for run in runs {
                assert_eq!(run.join().unwrap(), Ok(()), "round {round}");
            }
            let whole = Raw::open(&path).unwrap();
            whole.index(|_| true).unwrap();
            let (got, want) = (raw.index.read().unwrap(), whole.index.read().unwrap());
            assert_eq!(
                (got.checkpoints.len(), got.newlines, got.indexed_bytes),
                (want.checkpoints.len(), want.newlines, want.indexed_bytes),
                "round {round}"
            );
            assert!(got.checkpoints.iter().eq(want.checkpoints.iter()), "round {round}: the checkpoints differ");
        }
    }
}
