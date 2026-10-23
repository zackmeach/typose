//! Raw (brief §5.1) over a `Document`: the sniffed encoding, the line index and bounded pages.
use std::path::Path;
use std::sync::RwLock;

use encoding_rs::WINDOWS_1252;

use crate::doc::{DocError, Document};
use crate::encoding::{Sniffed, sniff};
use crate::index::{IndexConfig, LineIndex, Progress, build};
use crate::pages::{self, LinePiece};
use crate::store::{CHUNK, open_regular};

pub struct Raw {
    doc: Document,
    index: RwLock<LineIndex>,
}

impl Raw {
    /// Opens `path` and sniffs its encoding from the first chunk (spec §4.1). A binary file is refused.
    pub fn open(path: &Path) -> Result<Raw, DocError> {
        let doc = Document::open(path)?;
        let head = doc.verified(doc.generation(), |store| store.read(0, CHUNK as u64))?;
        let encoding = match sniff(&head, doc.len() <= CHUNK as u64, WINDOWS_1252) {
            Sniffed::Text { encoding, .. } => encoding,
            Sniffed::Binary => return Err(DocError::Binary),
        };
        Ok(Raw { doc, index: RwLock::new(LineIndex { encoding, ..LineIndex::default() }) })
    }

    pub fn document(&self) -> &Document {
        &self.doc
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

    /// Up to `count` lines from `start` (plan C2's bounds), with one identity check before and one after.
    pub fn page(&self, start: u64, count: usize) -> Result<Vec<LinePiece>, DocError> {
        let index = self.index.read().unwrap();
        self.doc.verified(self.doc.generation(), |store| pages::lines(store, &index, start, count))
    }

    /// Builds the line index through its own handle, so page reads never queue behind index reads. Its chunk
    /// hashes are the document's: a chunk either one reads first is verified when the other reads it (§3.1).
    pub fn index(&self, on_progress: impl FnMut(Progress)) -> Result<(), String> {
        let file = open_regular(self.doc.path()).map_err(|e| e.to_string())?;
        let store = self.doc.store();
        build(&file, store.len(), IndexConfig::default(), &store.hashes(), &self.index, on_progress)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;

    #[test]
    fn the_first_page_needs_no_index_and_the_rest_follows_it() {
        let path = temp_file("raw-first", b"one\ntwo\r\nthree");
        let raw = Raw::open(&path).unwrap();
        assert_eq!(raw.encoding(), "UTF-8");
        let first = raw.page(0, 10).unwrap();
        assert_eq!(first.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["one", "two", "three"]);
        assert_eq!(raw.lines_known(), (0, false));
        raw.index(|_| {}).unwrap();
        assert_eq!(raw.lines_known(), (3, true));
        assert_eq!(raw.page(2, 10).unwrap()[0].text, "three");
    }

    #[test]
    fn a_binary_file_is_refused_and_utf16_and_windows_1252_are_sniffed() {
        assert!(matches!(Raw::open(&temp_file("raw-bin", b"PK\x03\x04\0\0")), Err(DocError::Binary)));
        assert_eq!(Raw::open(&temp_file("raw-le", b"\xFF\xFEa\0")).unwrap().encoding(), "UTF-16LE");
        assert_eq!(Raw::open(&temp_file("raw-be", b"\xFE\xFF\0a")).unwrap().encoding(), "UTF-16BE");
        assert_eq!(Raw::open(&temp_file("raw-1252", b"caf\xE9")).unwrap().encoding(), "windows-1252");
    }
}
