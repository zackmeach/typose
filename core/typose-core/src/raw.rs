//! Raw (brief §5.1) over a `Document`: the sniffed encoding, the line index and bounded pages.
use std::path::Path;
use std::sync::RwLock;

use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1252};

use crate::doc::{DocError, Document};
use crate::encoding::{Sniffed, sniff};
use crate::index::{IndexConfig, LineIndex, Progress, build};
use crate::pages::{self, Caps, LinePiece};
use crate::store::CHUNK;

/// The chunk cache's size: 64 MiB, `Document::open`'s.
const CACHE_CHUNKS: usize = 64;

pub struct Raw {
    doc: Document,
    index: RwLock<LineIndex>,
    blank: bool,
}

impl Raw {
    /// Opens `path` and sniffs its encoding from the first chunk (spec §4.1). A binary file is refused.
    pub fn open(path: &Path) -> Result<Raw, DocError> {
        Self::open_with(path, CACHE_CHUNKS, 1)
    }

    fn open_with(path: &Path, cache_chunks: usize, generation: u32) -> Result<Raw, DocError> {
        let doc = Document::open_with(path, cache_chunks, generation)?;
        let head = doc.verified(doc.generation(), |store| store.read(0, CHUNK as u64))?;
        let encoding = match sniff(&head, doc.len() <= CHUNK as u64, WINDOWS_1252) {
            Sniffed::Text { encoding, .. } => encoding,
            Sniffed::Binary => return Err(DocError::Binary),
        };
        let blank = doc.len() <= CHUNK as u64 && whitespace_only(&head, encoding);
        Ok(Raw { doc, index: RwLock::new(LineIndex { encoding, ..LineIndex::default() }), blank })
    }

    /// Ctrl+R (spec §3.1): the same path, opened again one generation later, with a new index. This generation
    /// freezes, so its index stops at its next block and its pages and tokens are refused. If the open fails
    /// (the file is gone, say), this generation stays as it was.
    pub fn reload(&self) -> Result<Raw, DocError> {
        let next = Self::open_with(self.doc.path(), CACHE_CHUNKS, self.doc.generation() + 1)?;
        let _ = self.doc.freeze("reloaded".into());
        Ok(next)
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// Brief §7.9's empty file: 0 bytes, or only whitespace. Judged on the first chunk, so only for a file that
    /// fits in it; a bigger one shows its blank lines.
    pub fn blank(&self) -> bool {
        self.blank
    }

    /// `encoding_rs`'s name: `UTF-8`, `UTF-16LE`, `UTF-16BE` or `windows-1252`.
    pub fn encoding(&self) -> &'static str {
        self.index.read().unwrap().encoding.name()
    }

    /// (lines found so far, whether indexing is done).
    pub fn lines_known(&self) -> (u64, bool) {
        let index = self.index.read().unwrap();
        (index.line_count(), index.done)
    }

    /// Up to `count` lines from `start` (plan C2's bounds) of generation `generation`, with one identity check
    /// before and one after.
    pub fn page(&self, generation: u32, start: u64, count: usize) -> Result<Vec<LinePiece>, DocError> {
        self.page_with(generation, start, count, || {})
    }

    /// `between` runs after the first identity check and before the reads: the mutation-race test writes there.
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
    /// Plan C6's freeze half: a failed read or chunk check freezes the document and ends the index with the
    /// reason; a freeze found by a page (or Reload) ends it at its next block. What's indexed so far stays.
    pub fn index(&self, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
        let store = self.doc.store();
        let built = store.reopen().map_err(crate::store::StoreError::Io).and_then(|file| {
            build(&file, store.len(), IndexConfig::default(), &store.hashes(), &self.index, |p| {
                on_progress(p);
                self.doc.frozen().is_none()
            })
        });
        if let Err(e) = built {
            return Err(self.doc.fail(e).to_string());
        }
        match self.doc.frozen() {
            Some(why) if !self.index.read().unwrap().done => Err(format!("frozen: {why}")),
            _ => Ok(()),
        }
    }
}

/// Whether `head`, a whole file, holds only whitespace after its BOM.
fn whitespace_only(head: &[u8], encoding: &'static Encoding) -> bool {
    let bom = match Encoding::for_bom(head) {
        Some((e, n)) if e == encoding => n,
        _ => 0,
    };
    let text = &head[bom..];
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let units = text.chunks_exact(2).map(|u| {
            if encoding == UTF_16LE { u16::from_le_bytes([u[0], u[1]]) } else { u16::from_be_bytes([u[0], u[1]]) }
        });
        text.len().is_multiple_of(2) && char::decode_utf16(units).all(|c| c.is_ok_and(char::is_whitespace))
    } else if encoding == UTF_8 {
        std::str::from_utf8(text).is_ok_and(|s| s.chars().all(char::is_whitespace))
    } else {
        text.iter().all(u8::is_ascii_whitespace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::FileId;
    use crate::store::testutil::temp_file;
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
        raw.index(|_| {}).unwrap();
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
        assert!(!blank("blank-text", b"\n\n x\n"));
        assert!(!blank("blank-u16-odd", b"\xFF\xFE \0\n"));
        assert!(!blank("blank-big", &[b' '; 2 << 20])); // past the first chunk: shown as blank lines
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
        });
        assert_eq!((indexed, blocks), (Err("frozen: changed on disk".into()), 1));
    }

    /// Spec §13.1 Spike C's mutation race, through Raw's pages: an in-place, same-size write between the identity
    /// check and the read, with the timestamp restored, is caught by chunk verification in 1,000 of 1,000 runs.
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
            raw.index(|_| {}).unwrap();
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
}
