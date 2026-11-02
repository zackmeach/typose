//! Documents with generations (spec §3.1): after every read, the path or inherited route's identity is checked against the one
//! taken at open [Z63], and every chunk is verified against its first-read hash. Any change freezes the document.
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::budget::{OverBudget, Reservation};
use crate::local::{LocalError, LocalRoute};
use crate::store::{ByteStore, NotRegular, StoreError, refusal, route_refusal};

thread_local! {
    /// The document whose identity check `Document::batch` holds to the end of its page, on this thread.
    static BATCHED: std::cell::Cell<*const Document> = const { std::cell::Cell::new(std::ptr::null()) };
}
#[cfg(test)]
thread_local! {
    /// Identity checks (a route walk and an open of the path each) made on this thread.
    pub(crate) static CHECKS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// What change detection compares, taken from a freshly opened path or inherited local route (spec §3.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileId {
    pub volume: u64,
    pub index: u64,
    pub size: u64,
    pub modified: SystemTime,
}

impl FileId {
    #[cfg(windows)]
    pub fn of(path: &Path) -> io::Result<FileId> {
        let f = crate::store::query_open(path, 0)?; // query only, with identification-level QoS
        Self::of_file(&f)
    }

    #[cfg(windows)]
    pub(crate) fn of_file(f: &File) -> io::Result<FileId> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let meta = f.metadata()?;
        Ok(FileId {
            volume: info.dwVolumeSerialNumber as u64,
            index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            size: meta.len(),
            modified: meta.modified()?,
        })
    }

    #[cfg(unix)]
    pub fn of(path: &Path) -> io::Result<FileId> {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path)?;
        Ok(FileId { volume: meta.dev(), index: meta.ino(), size: meta.len(), modified: meta.modified()? })
    }

    #[cfg(unix)]
    pub(crate) fn of_file(f: &File) -> io::Result<FileId> {
        use std::os::unix::fs::MetadataExt;
        let meta = f.metadata()?;
        Ok(FileId { volume: meta.dev(), index: meta.ino(), size: meta.len(), modified: meta.modified()? })
    }
}

#[derive(Debug)]
pub enum DocError {
    Io(io::Error),
    /// The caller's span belongs to an older generation (spec §3.1: copy is refused, Reload is offered).
    Stale {
        current: u32,
        asked: u32,
    },
    /// The file changed; nothing more is read until Reload.
    Frozen(String),
    /// Never opened: a device or special file, or a file whose offsets JavaScript can't hold exactly (spec §3.3).
    Refused(String),
    /// A NUL in the first 8KB without a UTF-16 BOM (spec §4.1).
    Binary,
    /// A caller's value the core couldn't have issued: a forged continuation (plan C3).
    Invalid(String),
    /// The read was cancelled (plan C5). Nothing changed: the document reads on.
    Cancelled,
    /// Plan C1: the memory budget can't hold what this needs. Nothing stays charged.
    Memory(OverBudget),
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocError::Io(e) => write!(f, "io: {e}"),
            DocError::Stale { current, asked } => write!(f, "stale span (generation {asked}, now {current})"),
            DocError::Frozen(why) => write!(f, "frozen: {why}"),
            DocError::Refused(why) => write!(f, "refused: {why}"),
            DocError::Binary => write!(f, "binary file"),
            DocError::Invalid(why) => f.write_str(why),
            DocError::Cancelled => f.write_str("cancelled"),
            DocError::Memory(e) => write!(f, "{e}"),
        }
    }
}

/// Offsets and sizes reach JavaScript as numbers, exact up to 2^53 − 1 bytes (8 PiB).
pub const MAX_SAFE: u64 = (1 << 53) - 1;

fn check_len(len: u64) -> Result<(), DocError> {
    match len {
        0..=MAX_SAFE => Ok(()),
        _ => Err(DocError::Refused("over 2^53 − 1 bytes: offsets wouldn't be exact in JavaScript".into())),
    }
}

/// An I/O error, `Refused` when the handle turned out not to be a regular file (`store::open_regular`), or `Memory`
/// when the ledger refused the store's floor.
fn io_error(e: io::Error) -> DocError {
    match e.get_ref() {
        Some(inner) if inner.is::<NotRegular>() => DocError::Refused(e.to_string()),
        Some(inner) if let Some(over) = inner.downcast_ref::<OverBudget>() => DocError::Memory(*over),
        _ => DocError::Io(e),
    }
}

fn local_error(e: LocalError) -> DocError {
    match e {
        LocalError::Refused(why) => DocError::Refused(why.into()),
        LocalError::Io(e) => io_error(e),
        LocalError::Memory(e) => DocError::Memory(e),
    }
}

/// Only a newly opened target's mutation is a navigation refusal; source freezes keep their own error code.
pub(crate) fn local_target_error(e: DocError) -> DocError {
    match e {
        DocError::Frozen(why) => DocError::Refused(format!("local target changed while opening: {why}")),
        other => other,
    }
}

/// A freeze reason is kept to this many bytes, reserved with the document (plan C1's metadata).
pub const REASON_MAX: usize = 256;
/// The document's own structures, with the `Raw` around it and the `Arc` napi keeps that in (plan C1's metadata).
pub const STRUCT_BYTES: u64 = 2048;

/// What a document's metadata charges: its path, the longest freeze reason kept, and its structures.
pub fn metadata_bytes(path: &Path) -> u64 {
    path.as_os_str().len() as u64 + REASON_MAX as u64 + STRUCT_BYTES
}

/// What a document has charged, itemized (plan C1, C6's debug stats).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Charges {
    pub hashes: u64,
    pub checkpoints: u64,
    pub cache: u64,
    pub metadata: u64,
}

impl Charges {
    pub fn total(&self) -> u64 {
        self.hashes + self.checkpoints + self.cache + self.metadata
    }
}

pub struct Document {
    path: PathBuf,
    store: ByteStore,
    id: FileId,
    generation: u32,
    cache_chunks: usize,
    frozen: Mutex<Option<String>>,
    /// Captured only at explicit source open, then inherited by local navigation. Absence is cached refusal.
    local: Option<LocalRoute>,
    /// A derived document must never regain ordinary pathname access, including after Reload.
    local_only: bool,
    /// Pays for the path, the freeze reason and the structures. Declared last, so it's released after them.
    metadata: Reservation,
}

impl Document {
    pub fn open(path: &Path) -> Result<Document, DocError> {
        Self::open_with(path, 64, 1)
    }

    pub fn open_with(path: &Path, cache_chunks: usize, generation: u32) -> Result<Document, DocError> {
        if let Some(why) = refusal(path).map_err(DocError::Io)? {
            return Err(DocError::Refused(why.into())); // before FileId::of, which opens the path on Windows
        }
        let id = FileId::of(path).map_err(DocError::Io)?;
        check_len(id.size)?; // before the store charges for its length
        let store = ByteStore::open_with(path, cache_chunks).map_err(io_error)?;
        if store.len() != id.size {
            return Err(DocError::Frozen("changed while opening".into()));
        }
        check_len(store.len())?;
        let metadata = Reservation::new(metadata_bytes(path)).map_err(DocError::Memory)?;
        let local = crate::md::is_markdown(path).then(|| LocalRoute::capture(path, store.file()).ok()).flatten();
        Ok(Document {
            path: path.to_owned(),
            store,
            id,
            generation,
            cache_chunks,
            frozen: Mutex::new(None),
            local,
            local_only: false,
            metadata,
        })
    }

    fn from_local(route: LocalRoute, cache_chunks: usize, generation: u32) -> Result<Document, DocError> {
        let file = route.open().map_err(local_error)?;
        let id = FileId::of_file(&file).map_err(DocError::Io)?;
        check_len(id.size)?;
        let metadata = Reservation::new(metadata_bytes(route.path())).map_err(DocError::Memory)?;
        let path = route.path().to_owned();
        let store = ByteStore::from_file(file, cache_chunks).map_err(io_error)?;
        if store.len() != id.size || FileId::of_file(store.file()).map_err(DocError::Io)? != id {
            return Err(DocError::Frozen("changed while opening".into()));
        }
        Ok(Document {
            path,
            store,
            id,
            generation,
            cache_chunks,
            frozen: Mutex::new(None),
            local: Some(route),
            local_only: true,
            metadata,
        })
    }

    /// What this document's store and metadata have charged; `Raw` adds its checkpoints.
    pub fn charges(&self) -> Charges {
        let (hashes, cache) = self.store.charges();
        Charges {
            hashes,
            checkpoints: 0,
            cache,
            metadata: self.metadata.bytes() + self.local.as_ref().map_or(0, LocalRoute::charged),
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn len(&self) -> u64 {
        self.store.len()
    }

    pub fn store(&self) -> &ByteStore {
        &self.store
    }

    pub fn frozen(&self) -> Option<String> {
        self.frozen.lock().unwrap().clone()
    }

    /// The verified read path that copy uses (spec §3.1).
    pub fn read(&self, generation: u32, start: u64, end: u64) -> Result<Vec<u8>, DocError> {
        self.read_with(generation, start, end, || {})
    }

    /// `between` runs just before the read: the mutation-race test injects writes there.
    pub fn read_with(
        &self,
        generation: u32,
        start: u64,
        end: u64,
        between: impl FnOnce(),
    ) -> Result<Vec<u8>, DocError> {
        self.verified(generation, |store| {
            between();
            store.read(start, end)
        })
    }

    /// `reads` through the store, then one identity check (plan PR 1: per page, not per line or chunk; amended in
    /// PR 4: after only). The reads go through the open handle, never the path, and the check compares the path
    /// with the identity taken at open, so a change before or during the reads fails it, and nothing they read
    /// is returned. Every chunk read inside still verifies its hash (§3.1). A frozen document reads nothing.
    pub fn verified<T>(
        &self,
        generation: u32,
        reads: impl FnOnce(&ByteStore) -> Result<T, StoreError>,
    ) -> Result<T, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        if let Some(why) = self.frozen() {
            return Err(DocError::Frozen(why));
        }
        let out = reads(&self.store).map_err(|e| self.fail(e))?;
        if !std::ptr::eq(BATCHED.get(), self) {
            self.check()?;
        }
        Ok(out)
    }

    /// One page of many small reads (a Rows page, a Tree page): every `verified` inside, on this thread, still
    /// checks the generation, the freeze and each chunk's hash, but the identity check, a route walk and an open of
    /// the path, runs once, after the page (plan PR 1: per page). Nothing `page` returns is returned unless it passes.
    pub fn batch<T>(&self, generation: u32, page: impl FnOnce() -> Result<T, DocError>) -> Result<T, DocError> {
        struct Restore(*const Document);
        impl Drop for Restore {
            fn drop(&mut self) {
                BATCHED.set(self.0); // also on a panic: a pooled thread must not keep skipping checks
            }
        }
        let restore = Restore(BATCHED.replace(self));
        let out = page();
        drop(restore);
        let out = out?;
        self.verified(generation, |_| Ok(()))?;
        Ok(out)
    }

    /// A failed read freezes the document: a chunk that no longer matches, or an I/O error (plan C6). A cancelled
    /// one doesn't: it read nothing wrong.
    pub(crate) fn fail(&self, e: StoreError) -> DocError {
        match e {
            StoreError::Changed { chunk } => self.freeze(format!("changed on disk (chunk {chunk})")),
            StoreError::Io(e) => self.freeze(format!("read failed: {e}")),
            StoreError::Cancelled => DocError::Cancelled,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn local_only(&self) -> bool {
        self.local_only
    }

    pub fn folder_scope(&self) -> Option<(&str, Option<u32>, &str, &str)> {
        let route = self.local.as_ref()?;
        route
            .folder_scope()
            .map(|(id, label, _)| (id, route.folder_node(), label, route.folder_relative().expect("scoped route")))
    }

    /// Only a fresh manual open/reload can adopt an active root; the origin policy stays manual.
    pub fn bind_folder(&mut self, folder: &crate::local::folder::Folder) -> Result<bool, DocError> {
        if self.local_only || self.folder_scope().is_some() {
            return Ok(false);
        }
        let Some(route) = folder.bind(&self.path, self.store.file())? else { return Ok(false) };
        self.local = Some(route);
        Ok(true)
    }

    /// Retain authority, not this document's bytes/index. Manual opens never become derived locations.
    /// Saving an owned generation needs no filesystem access; reopen verifies the route's current bytes.
    pub fn saved_route(&self, generation: u32) -> Result<LocalRoute, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        if !self.local_only {
            return Err(DocError::Refused("manual locations use manual-open policy".into()));
        }
        self.local
            .as_ref()
            .ok_or_else(|| DocError::Refused("the derived location has no local route".into()))?
            .try_clone()
            .map_err(local_error)
    }

    pub(crate) fn from_saved(route: &LocalRoute, cache_chunks: usize) -> Result<Document, DocError> {
        Self::from_local(route.try_clone().map_err(local_error)?, cache_chunks, 1)
    }

    /// Resolve a decoded local target without opening it. Only the source route is checked for mutation.
    pub fn local_path(&self, generation: u32, target: &str) -> Result<LocalRoute, DocError> {
        self.local_target(generation, target)
    }

    /// An image target uses only this held capability. The codec, not a pathname extension, identifies its format.
    pub(crate) fn image_route(&self, generation: u32, target: &str) -> Result<LocalRoute, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        if !crate::md::is_markdown(&self.path) {
            return Err(DocError::Refused("local images require a Markdown source".into()));
        }
        if target.is_empty() || target.len() > 32 << 10 || target.chars().any(char::is_control) {
            return Err(DocError::Invalid(
                "image target must be a decoded path of at most 32 KiB, without controls".into(),
            ));
        }
        let source = self.local.as_ref().ok_or_else(|| {
            DocError::Refused("local images are unavailable for this source; select it manually again".into())
        })?;
        let route = source.resolve(target).map_err(local_error)?;
        self.check_local_source(generation)?;
        Ok(route)
    }

    pub fn open_local(&self, generation: u32, target: &str) -> Result<Document, DocError> {
        let route = self.local_target(generation, target)?;
        let next = Self::from_local(route, self.cache_chunks, 1).map_err(local_target_error)?;
        self.check_local_source(generation)?;
        Ok(next)
    }

    /// Any extension: the hand-off sheet shows where a program or script is, and nothing here opens it.
    pub fn link_path(&self, generation: u32, target: &str) -> Result<LocalRoute, DocError> {
        self.link_target(generation, target, false)
    }

    fn local_target(&self, generation: u32, target: &str) -> Result<LocalRoute, DocError> {
        self.link_target(generation, target, true)
    }

    fn link_target(&self, generation: u32, target: &str, supported_only: bool) -> Result<LocalRoute, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        if !crate::md::is_markdown(&self.path) {
            return Err(DocError::Refused("local links require a Markdown source".into()));
        }
        if target.is_empty() || target.len() > 32 << 10 || target.chars().any(char::is_control) {
            return Err(DocError::Invalid(
                "target must be a non-empty decoded path of at most 32 KiB, without control characters".into(),
            ));
        }
        let source = self.local.as_ref().ok_or_else(|| {
            DocError::Refused("local files are unavailable for this source; select it manually again".into())
        })?;
        let route = source.resolve(target).map_err(local_error)?;
        let supported = route.path().extension().and_then(|s| s.to_str()).is_some_and(|s| {
            s.eq_ignore_ascii_case("md")
                || s.eq_ignore_ascii_case("markdown")
                || s.eq_ignore_ascii_case("txt")
                || s.eq_ignore_ascii_case("csv")
                || s.eq_ignore_ascii_case("tsv")
        });
        if supported_only && !supported {
            return Err(DocError::Refused("local links support only Markdown, TXT, CSV and TSV files".into()));
        }
        self.check_local_source(generation)?;
        Ok(route)
    }

    pub(crate) fn check_local_source(&self, generation: u32) -> Result<(), DocError> {
        self.checked_local_file(generation).map(drop)
    }

    /// A fresh index handle must retain the derived document's local-only policy too.
    pub(crate) fn index_file(&self) -> Result<File, DocError> {
        if self.local_only || self.folder_scope().is_some() {
            self.checked_local_file(self.generation)
        } else {
            self.store.reopen().map_err(|e| self.fail(StoreError::Io(e)))
        }
    }

    fn checked_local_file(&self, generation: u32) -> Result<File, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        if let Some(why) = self.frozen() {
            return Err(DocError::Frozen(why));
        }
        let route = self.local.as_ref().ok_or_else(|| {
            DocError::Refused("local files are unavailable for this source; select it manually again".into())
        })?;
        let current = route
            .open()
            .and_then(|file| {
                if !route.same_file(&file, self.store.file())? {
                    return Ok(None);
                }
                let id = FileId::of_file(&file)?;
                Ok(Some((file, id)))
            })
            .map_err(local_error);
        match current {
            Ok(Some((file, now))) if now == self.id => Ok(file),
            Ok(_) => Err(self.freeze("changed on disk".into())),
            Err(e @ DocError::Memory(_)) => Err(e),
            Err(e) => Err(self.freeze(format!("local source unavailable: {e}"))),
        }
    }

    /// Ctrl+R: a fresh handle, identity and hash table, one generation later.
    pub fn reload(&mut self) -> Result<(), DocError> {
        *self = self.reopened()?;
        Ok(())
    }

    pub(crate) fn reopened(&self) -> Result<Document, DocError> {
        if self.local_only || self.folder_scope().is_some() {
            let route = self
                .local
                .as_ref()
                .expect("derived documents retain their local route")
                .try_clone()
                .map_err(local_error)?;
            let mut next = Self::from_local(route, self.cache_chunks, self.generation + 1)?;
            next.local_only = self.local_only;
            Ok(next)
        } else {
            Self::open_with(&self.path, self.cache_chunks, self.generation + 1)
        }
    }

    fn check(&self) -> Result<(), DocError> {
        #[cfg(test)]
        CHECKS.set(CHECKS.get() + 1);
        if self.local_only || self.folder_scope().is_some() {
            return self.check_local_source(self.generation);
        }
        if let Some(why) = self.frozen() {
            return Err(DocError::Frozen(why));
        }
        // `FileId::of` opens the path. Since the open, the path or a link or drive letter in it may have been swapped
        // to reach a pipe, so the route is checked first, as the open checked it (plan PR 4).
        match route_refusal(&self.path) {
            Ok(None) => {}
            Ok(Some(why)) => return Err(self.freeze(format!("changed on disk: now {why}"))),
            Err(e) => return Err(self.freeze(format!("unavailable: {e}"))),
        }
        match FileId::of(&self.path) {
            Ok(now) if now == self.id => Ok(()),
            Ok(_) => Err(self.freeze("changed on disk".into())),
            Err(e) => Err(self.freeze(format!("unavailable: {e}"))),
        }
    }

    /// Freezes the document (spec §3.1): nothing more is read until Reload. Also how Raw stops a superseded
    /// generation's index (`Raw::reload`) and records an index failure (plan C6).
    pub(crate) fn freeze(&self, why: String) -> DocError {
        let end = why.floor_char_boundary(REASON_MAX); // what the metadata's charge holds
        *self.frozen.lock().unwrap() = Some(why[..end].to_owned());
        DocError::Frozen(why)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::CHUNK;
    use crate::store::testutil::temp_file;
    use std::fs::{self, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| ((i * 31) as u8).wrapping_add(seed)).collect()
    }

    #[test]
    fn frozen_reason_fits_its_byte_charge_without_splitting_utf8() {
        let doc = Document::open(&temp_file("doc-freeze-reason", b"")).unwrap();
        for (why, kept) in [(String::new(), String::new()), ("x".repeat(REASON_MAX), "x".repeat(REASON_MAX))] {
            assert!(matches!(doc.freeze(why.clone()), DocError::Frozen(full) if full == why));
            assert_eq!(doc.frozen(), Some(kept));
        }
        for scalar in ['é', '界', '😀'] {
            for room in 0..=scalar.len_utf8() {
                let prefix = "x".repeat(REASON_MAX - room);
                let why = format!("{prefix}{scalar}tail");
                let kept = if room == scalar.len_utf8() { format!("{prefix}{scalar}") } else { prefix };
                assert!(matches!(doc.freeze(why.clone()), DocError::Frozen(full) if full == why));
                assert_eq!(doc.frozen(), Some(kept));
            }
        }
    }

    #[test]
    fn a_current_span_copies_and_a_stale_one_is_refused() {
        let path = temp_file("doc-basic", &pattern(3 * CHUNK, 1));
        let mut doc = Document::open(&path).unwrap();
        assert_eq!(doc.read(1, 10, 20).unwrap(), pattern(3 * CHUNK, 1)[10..20]);
        OpenOptions::new().append(true).open(&path).unwrap().write_all(b"more").unwrap();
        assert!(matches!(doc.read(1, 10, 20), Err(DocError::Frozen(_))));
        doc.reload().unwrap();
        assert!(matches!(doc.read(1, 10, 20), Err(DocError::Stale { current: 2, asked: 1 })));
        assert_eq!(doc.read(2, 3 * CHUNK as u64, 3 * CHUNK as u64 + 4).unwrap(), b"more");
    }

    #[test]
    fn a_batch_checks_identity_once_after_its_page_and_returns_nothing_after_a_change() {
        let path = temp_file("doc-batch", &pattern(CHUNK, 2));
        let doc = Document::open(&path).unwrap();
        let before = CHECKS.get();
        let page = doc.batch(1, || (0..10).map(|i| doc.read(1, i, i + 1)).collect::<Result<Vec<_>, _>>());
        assert_eq!(page.unwrap().len(), 10);
        assert_eq!(CHECKS.get() - before, 1);
        let changed = doc.batch(1, || {
            let bytes = doc.read(1, 0, 4)?;
            OpenOptions::new().append(true).open(&path).unwrap().write_all(b"more").unwrap();
            Ok(bytes)
        });
        assert!(matches!(changed, Err(DocError::Frozen(_))));
        // After the batch, every read checks again.
        let before = CHECKS.get();
        assert!(matches!(doc.read(1, 0, 4), Err(DocError::Frozen(_))));
        let other_path = temp_file("doc-batch-after", b"abc");
        let other = Document::open(&other_path).unwrap();
        other.read(1, 0, 3).unwrap();
        assert_eq!(CHECKS.get() - before, 1);
    }

    /// Spec §13.1 Spike C: an in-place, same-size write just before the read, with the timestamp restored, is caught
    /// by chunk verification in 1,000 of 1,000 runs.
    #[test]
    fn mutation_race_is_caught_by_chunk_verification_1000_of_1000() {
        let original = pattern(4 * CHUNK, 7);
        let path = temp_file("doc-race", &original);
        let mut caught = 0;
        for run in 0..1000u64 {
            let chunk = run % 4;
            let at = chunk * CHUNK as u64 + (run * 7919) % (CHUNK as u64 - 64);
            let doc = Document::open_with(&path, 1, 1).unwrap();
            doc.read(1, at, at + 16).unwrap(); // hashes `chunk`
            let other = ((chunk + 1) % 4) * CHUNK as u64;
            doc.read(1, other, other + 1).unwrap(); // evicts it from the one-chunk cache
            let id_before = FileId::of(&path).unwrap();
            let result = doc.read_with(1, at, at + 16, || {
                let mut f = OpenOptions::new().write(true).open(&path).unwrap();
                f.seek(SeekFrom::Start(at)).unwrap();
                f.write_all(&[!original[at as usize]; 16]).unwrap();
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

    /// Spec §13.1 Spike C: 1,000 append/truncate/replace/delete/rename-away cycles while the document is open,
    /// with zero blocked operations and zero stale copies accepted.
    #[test]
    fn a_thousand_mutation_cycles_never_block_and_never_copy_stale_bytes() {
        let path = temp_file("doc-cycles", &pattern(2 * CHUNK, 3));
        let (tmp, moved) = (path.with_extension("tmp"), path.with_extension("moved"));
        let mut doc = Document::open(&path).unwrap();
        let (mut blocked, mut stale_accepted) = (Vec::new(), 0);
        for i in 0..1000u32 {
            let generation = doc.generation();
            doc.read(generation, 0, 64).unwrap();
            let op: io::Result<()> = match i % 5 {
                0 => OpenOptions::new().append(true).open(&path).and_then(|mut f| f.write_all(b"appended\n")),
                1 => OpenOptions::new().write(true).open(&path).and_then(|f| f.set_len(CHUNK as u64 + i as u64)),
                2 => fs::write(&tmp, pattern(CHUNK + 100, i as u8)).and_then(|_| fs::rename(&tmp, &path)),
                3 => fs::remove_file(&path).and_then(|_| fs::write(&path, pattern(CHUNK + 7, i as u8))),
                _ => fs::rename(&path, &moved), // the open file renamed away: nothing is at the path now
            };
            if let Err(e) = op {
                blocked.push(format!("cycle {i}: {e}"));
                continue;
            }
            if doc.read(generation, 0, 64).is_ok() {
                stale_accepted += 1;
            }
            if i % 5 == 4
                && let Err(e) = fs::write(&path, pattern(CHUNK + 11, i as u8))
            // a new file at the path, to reload
            {
                blocked.push(format!("cycle {i}: recreate: {e}"));
                continue;
            }
            doc.reload().unwrap();
            let fresh = doc.read(doc.generation(), 0, 64).unwrap();
            assert_eq!(fresh, fs::read(&path).unwrap()[..64]);
        }
        let _ = fs::remove_file(&moved);
        assert!(blocked.is_empty(), "blocked operations: {blocked:?}");
        assert_eq!(stale_accepted, 0);
    }

    /// Spec §3.3: device and special files are refused before anything opens them. Opening `\\.\pipe\…`
    /// connects to the pipe's server, and opening a FIFO blocks.
    #[test]
    fn device_and_special_paths_are_refused() {
        let mut paths = vec![std::env::temp_dir()]; // a directory
        #[cfg(windows)]
        paths.extend(
            [
                r"\\.\NUL",
                "//./NUL",
                r"\\.\pipe\typose-no-such-pipe",
                r"\\?\C:\Windows\win.ini",
                r"\??\C:\Windows\win.ini",
                "NUL",
                "con",
                r"C:\Windows\CON.txt",
                "COM1",
                "lpt9.log",
                "CONIN$",
                "NUL:",
                "CON:",
                "COM1:",
                "CONIN$:",
                r"C:\Windows\nul:stream",
                r"\\localhost\mailslot\typose-no-such-slot",
                r"\\localhost\IPC$\typose-no-such-pipe",
            ]
            .map(PathBuf::from),
        );
        #[cfg(unix)]
        paths.push(PathBuf::from("/dev/null"));
        let opened: Vec<String> = paths
            .iter()
            .filter_map(|path| match Document::open(path) {
                Err(DocError::Refused(_)) => None,
                Err(e) => Some(format!("{path:?}: {e}")),
                Ok(_) => Some(format!("{path:?}: opened")),
            })
            .collect();
        assert!(opened.is_empty(), "not refused: {opened:#?}");
    }

    /// A named-pipe server that can tell whether a client ever connected: in `PIPE_NOWAIT` mode
    /// `ConnectNamedPipe` answers at once, `ERROR_PIPE_LISTENING` until a client comes.
    #[cfg(windows)]
    struct PipeServer {
        handle: windows_sys::Win32::Foundation::HANDLE,
        path: String,
    }

    #[cfg(windows)]
    impl PipeServer {
        fn new(name: &str) -> PipeServer {
            use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
            use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
            use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_NOWAIT, PIPE_TYPE_BYTE};
            let path = format!(r"\\.\pipe\typose-core-{}-{name}", std::process::id());
            let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
            let mode = PIPE_TYPE_BYTE | PIPE_NOWAIT;
            let handle =
                unsafe { CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, mode, 1, 0, 0, 0, std::ptr::null()) };
            assert_ne!(handle, INVALID_HANDLE_VALUE, "{}", io::Error::last_os_error());
            let server = PipeServer { handle, path };
            assert!(!server.connected()); // the first call starts listening
            server
        }

        fn connected(&self) -> bool {
            use windows_sys::Win32::Foundation::{
                ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, GetLastError,
            };
            use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
            let ok = unsafe { ConnectNamedPipe(self.handle, std::ptr::null_mut()) };
            let error = unsafe { GetLastError() };
            assert!(ok == 0 && [ERROR_PIPE_LISTENING, ERROR_PIPE_CONNECTED, ERROR_NO_DATA].contains(&error), "{error}");
            error != ERROR_PIPE_LISTENING
        }

        fn name(&self) -> &str {
            &self.path[r"\\.\pipe\".len()..]
        }
    }

    #[cfg(windows)]
    impl Drop for PipeServer {
        fn drop(&mut self) {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
        }
    }

    /// Makes `link` a directory junction (a mount point) to the NT path `target`, which needs no privilege.
    #[cfg(windows)]
    fn junction(link: &Path, target: &str) {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
        use windows_sys::Win32::System::IO::DeviceIoControl;
        use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
        const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
        fs::create_dir(link).unwrap();
        let flags = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;
        let dir = OpenOptions::new().write(true).custom_flags(flags).open(link).unwrap();
        let subst: Vec<u16> = target.encode_utf16().collect();
        let names: Vec<u16> = subst.iter().copied().chain([0, 0]).collect(); // the target, then an empty print name
        let mut buf = Vec::new();
        buf.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        buf.extend(((8 + 2 * names.len()) as u16).to_le_bytes()); // ReparseDataLength
        buf.extend(0u16.to_le_bytes()); // Reserved
        buf.extend(0u16.to_le_bytes()); // SubstituteNameOffset
        buf.extend(((2 * subst.len()) as u16).to_le_bytes()); // SubstituteNameLength
        buf.extend(((2 * subst.len() + 2) as u16).to_le_bytes()); // PrintNameOffset
        buf.extend(0u16.to_le_bytes()); // PrintNameLength
        buf.extend(names.iter().flat_map(|u| u.to_le_bytes()));
        let mut returned = 0;
        let (ptr, len, null) = (buf.as_ptr().cast(), buf.len() as u32, std::ptr::null_mut());
        let no_overlap = std::ptr::null_mut();
        let ok = unsafe {
            DeviceIoControl(
                dir.as_raw_handle() as _,
                FSCTL_SET_REPARSE_POINT,
                ptr,
                len,
                null,
                0,
                &mut returned,
                no_overlap,
            )
        };
        assert_ne!(ok, 0, "{}", io::Error::last_os_error());
    }

    /// A scratch directory under %TEMP%, removed on drop (junctions included, not followed).
    #[cfg(windows)]
    struct Scratch(PathBuf);

    #[cfg(windows)]
    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("typose-core-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir(&dir).unwrap();
            Scratch(dir)
        }
    }

    #[cfg(windows)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Spec §3.3 🔒: a named pipe is refused before anything opens it, by every route, because opening (or just
    /// stat-ing) a pipe connects to its server. A live server for each route checks that no client ever came.
    #[cfg(windows)]
    #[test]
    fn a_named_pipe_is_refused_by_every_route_and_no_client_connects() {
        let scratch = Scratch::new("pipes");
        let mut routes: Vec<(&str, PipeServer, PathBuf)> = Vec::new();
        let direct = PipeServer::new("direct");
        let path = PathBuf::from(&direct.path);
        routes.push(("direct", direct, path));
        // Every UNC spelling: host names, case, either slash, a trailing dot, and the verbatim form.
        for (route, unc) in [
            ("UNC", r"\\localhost\pipe\"),
            ("UNC by address, upper case", r"\\127.0.0.1\PIPE\"),
            ("UNC with forward slashes", "//localhost/pipe/"),
            ("UNC share with a trailing dot", r"\\localhost\pipe.\"),
            ("verbatim UNC", r"\\?\UNC\localhost\pipe\"),
        ] {
            let server = PipeServer::new(&route.replace([' ', ','], "-"));
            let path = PathBuf::from(format!("{unc}{}", server.name()));
            routes.push((route, server, path));
        }
        let jn = PipeServer::new("junction");
        let link = scratch.0.join("j");
        junction(&link, r"\??\pipe\");
        let path = link.join(jn.name());
        routes.push(("junction into \\??\\pipe\\", jn, path));
        let sl = PipeServer::new("symlink");
        let link = scratch.0.join("s");
        match std::os::windows::fs::symlink_file(&sl.path, &link) {
            Ok(()) => routes.push(("symlink to \\\\.\\pipe\\", sl, link)),
            // ERROR_PRIVILEGE_NOT_HELD: no Developer Mode and no admin. The junction covers link resolution.
            Err(e) if e.raw_os_error() == Some(1314) => println!("symlink route skipped: {e}"),
            Err(e) => panic!("symlink: {e}"),
        }
        let failures: Vec<String> = routes
            .iter()
            .filter_map(|(route, server, path)| {
                let result = Document::open(path);
                let connected = server.connected();
                let refused = matches!(result, Err(DocError::Refused(_)));
                let outcome = result.map_or_else(|e| e.to_string(), |_| "opened".into());
                (connected || !refused).then(|| format!("{route} {path:?}: client connected: {connected}; {outcome}"))
            })
            .collect();
        assert!(failures.is_empty(), "{failures:#?}");
    }

    /// The reparse-point walk refuses only device targets: links to regular files still open.
    #[cfg(windows)]
    #[test]
    fn links_to_regular_files_still_open() {
        let scratch = Scratch::new("links");
        let real = scratch.0.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("f.txt"), b"through a link").unwrap();
        junction(&scratch.0.join("j"), &format!(r"\??\{}", real.display()));
        let doc = Document::open(&scratch.0.join("j").join("f.txt")).unwrap();
        assert_eq!(doc.read(1, 0, 14).unwrap(), b"through a link");
        drop(doc);
        let link = scratch.0.join("s.txt");
        match std::os::windows::fs::symlink_file(real.join("f.txt"), &link) {
            Ok(()) => assert_eq!(Document::open(&link).unwrap().read(1, 0, 7).unwrap(), b"through"),
            Err(e) if e.raw_os_error() == Some(1314) => println!("symlink case skipped: {e}"),
            Err(e) => panic!("symlink: {e}"),
        }
    }

    /// Drive-letter tests take turns: each borrows a free letter of this logon session's DOS-device namespace.
    #[cfg(windows)]
    static DRIVES: Mutex<()> = Mutex::new(());

    /// A drive letter defined with `DefineDosDeviceW` (per logon session, no privilege), removed on drop, so a
    /// failing assert can't leave it behind.
    #[cfg(windows)]
    struct DosDevice {
        name: Vec<u16>,
        target: Vec<u16>,
        flags: u32,
    }

    #[cfg(windows)]
    impl DosDevice {
        /// The last letter from Z down that names nothing in this session.
        fn free_letter() -> char {
            use windows_sys::Win32::Storage::FileSystem::QueryDosDeviceW;
            let mut buf = [0u16; 512];
            ('G'..='Z')
                .rev()
                .find(|&c| {
                    let name = [c as u16, u16::from(b':'), 0];
                    unsafe { QueryDosDeviceW(name.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) == 0 }
                })
                .expect("a free drive letter")
        }

        /// `raw`: `target` is an NT path (`\Device\…`); otherwise a path, as `subst` takes it.
        fn define(letter: char, target: &str, raw: bool) -> DosDevice {
            use windows_sys::Win32::Storage::FileSystem::{DDD_RAW_TARGET_PATH, DefineDosDeviceW};
            let flags = if raw { DDD_RAW_TARGET_PATH } else { 0 };
            let device = DosDevice {
                name: [letter as u16, u16::from(b':'), 0].to_vec(),
                target: target.encode_utf16().chain([0]).collect(),
                flags,
            };
            let ok = unsafe { DefineDosDeviceW(flags, device.name.as_ptr(), device.target.as_ptr()) };
            assert_ne!(ok, 0, "DefineDosDeviceW {letter}: -> {target}: {}", io::Error::last_os_error());
            device
        }
    }

    #[cfg(windows)]
    impl Drop for DosDevice {
        fn drop(&mut self) {
            use windows_sys::Win32::Storage::FileSystem::{
                DDD_EXACT_MATCH_ON_REMOVE, DDD_REMOVE_DEFINITION, DefineDosDeviceW,
            };
            let flags = self.flags | DDD_REMOVE_DEFINITION | DDD_EXACT_MATCH_ON_REMOVE;
            let ok = unsafe { DefineDosDeviceW(flags, self.name.as_ptr(), self.target.as_ptr()) };
            assert!(ok != 0 || std::thread::panicking(), "removing the drive: {}", io::Error::last_os_error());
        }
    }

    /// Brief §4.6: session restore leaves network shares unopened. UNC forms, and drive letters the redirector serves
    /// directly or through a subst, are network; a local drive, a relative path and a subst'd folder aren't.
    #[cfg(windows)]
    #[test]
    fn network_routes_are_recognized_without_opening_them() {
        use crate::store::network;
        for path in
            [r"\\example.invalid\share\x.md", "//example.invalid/share/x.md", r"\\?\UNC\example.invalid\share\x"]
        {
            assert!(network(Path::new(path)), "{path}");
        }
        for path in [r"C:\Windows\x.md", "relative.md"] {
            assert!(!network(Path::new(path)), "{path}");
        }
        let _turn = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
        let letter = DosDevice::free_letter();
        let path = PathBuf::from(format!(r"{letter}:\x.md"));
        for target in [
            r"\Device\Mup\example.invalid\share",
            r"\Device\LanmanRedirector\;Q:0000000000001234\example.invalid\share",
            r"\??\UNC\example.invalid\share",
        ] {
            let _drive = DosDevice::define(letter, target, true);
            assert!(network(&path), "{letter}: -> {target}");
        }
        let scratch = Scratch::new("network-subst");
        let _drive = DosDevice::define(letter, &scratch.0.to_string_lossy(), false);
        assert!(!network(&path));
    }

    /// Plan PR 4 (PR 1's known limit 2): a drive letter mapped onto the pipe namespace, by `DefineDosDeviceW` as any
    /// program in the session can, is refused before anything opens the path. A subst'd folder still opens.
    #[cfg(windows)]
    #[test]
    fn a_drive_letter_mapped_onto_pipes_is_refused_and_no_client_connects() {
        let _turn = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
        let letter = DosDevice::free_letter();
        let mut failures = Vec::new();
        let routes = [(r"\Device\NamedPipe", ""), (r"\??\PIPE", ""), (r"\Device\Mup", r"localhost\pipe\")];
        for (i, (target, under)) in routes.into_iter().enumerate() {
            let server = PipeServer::new(&format!("drive-{i}"));
            let _drive = DosDevice::define(letter, target, true);
            let path = PathBuf::from(format!(r"{letter}:\{under}{}", server.name()));
            let result = Document::open(&path);
            let connected = server.connected();
            if connected || !matches!(result, Err(DocError::Refused(_))) {
                let outcome = result.map_or_else(|e| e.to_string(), |_| "opened".into());
                failures.push(format!("{letter}: -> {target}, {path:?}: client connected: {connected}; {outcome}"));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
        let scratch = Scratch::new("subst");
        fs::write(scratch.0.join("f.txt"), b"through a subst").unwrap();
        let _drive = DosDevice::define(letter, &scratch.0.to_string_lossy(), false);
        let doc = Document::open(Path::new(&format!(r"{letter}:\f.txt"))).unwrap();
        assert_eq!(doc.read(1, 0, 15).unwrap(), b"through a subst");
    }

    /// Plan PR 4 (PR 1's known limit 1): after the open, the path is swapped to reach a pipe, by re-pointing a
    /// junction in it (the file's parent, or three levels up) or by remapping its drive letter (written in either
    /// case). Raw's later reads check the path before opening it, and its index reopens the document's handle rather
    /// than the path, so no client ever connects and the document freezes.
    #[cfg(windows)]
    #[test]
    fn swapping_the_path_onto_a_pipe_after_the_open_connects_nothing() {
        use crate::raw::Raw;
        let _turn = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
        let scratch = Scratch::new("swap");
        let (real, link) = (scratch.0.join("real"), scratch.0.join("j"));
        fs::create_dir(&real).unwrap();
        let letter = DosDevice::free_letter();
        let mut failures = Vec::new();
        let routes = ["junction", "deep junction", "drive letter", "lower-case drive letter"];
        for (i, route) in routes.into_iter().enumerate() {
            // A pipe name may hold backslashes, so the deep route's pipe is the file's whole path under the link.
            let server = PipeServer::new(&format!("swap-{i}{}", if route == "deep junction" { r"\a\f" } else { "" }));
            let file = real.join(server.name());
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, b"a regular file\n").unwrap();
            let drive = route.ends_with("drive letter");
            let subst = drive.then(|| DosDevice::define(letter, &real.to_string_lossy(), false));
            let path = match subst {
                Some(_) if route.starts_with("lower-case") => {
                    PathBuf::from(format!(r"{}:\{}", letter.to_ascii_lowercase(), server.name()))
                }
                Some(_) => PathBuf::from(format!(r"{letter}:\{}", server.name())),
                None => {
                    junction(&link, &format!(r"\??\{}", real.display()));
                    link.join(server.name())
                }
            };
            let raw = Raw::open(&path).unwrap();
            assert_eq!(raw.page(1, 0, 1).unwrap()[0].text, "a regular file");
            // The swap: the same path now reaches the pipe.
            let _pipe_drive = match subst {
                Some(subst) => {
                    drop(subst);
                    Some(DosDevice::define(letter, r"\Device\NamedPipe", true))
                }
                None => {
                    fs::remove_dir(&link).unwrap(); // the junction, not its target
                    junction(&link, r"\??\pipe\");
                    None
                }
            };
            let page = raw.page(1, 0, 1).map(|_| ()).map_err(|e| e.to_string());
            let index = raw.index(|_| true);
            let connected = server.connected();
            if connected || !page.as_ref().is_err_and(|e| e.starts_with("frozen: changed on disk")) {
                failures.push(format!("{route}: client connected: {connected}; page {page:?}; index {index:?}"));
            }
            if !drive {
                fs::remove_dir(&link).unwrap(); // the junction, for the next route
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_blocking() {
        let path = std::env::temp_dir().join(format!("typose-core-{}-fifo", std::process::id()));
        let _ = fs::remove_file(&path);
        assert!(std::process::Command::new("mkfifo").arg(&path).status().unwrap().success());
        let (tx, rx) = std::sync::mpsc::channel();
        let fifo = path.clone();
        std::thread::spawn(move || tx.send(matches!(Document::open(&fifo), Err(DocError::Refused(_)))));
        let refused = rx.recv_timeout(std::time::Duration::from_secs(5));
        fs::remove_file(&path).unwrap();
        assert_eq!(refused, Ok(true), "a FIFO must be refused, not opened (an open blocks)");
    }

    #[test]
    fn a_file_whose_offsets_javascript_cannot_hold_is_refused() {
        assert!(check_len(MAX_SAFE).is_ok());
        assert!(matches!(check_len(MAX_SAFE + 1), Err(DocError::Refused(_))));
    }

    #[test]
    fn handle_identity_is_the_open_file_even_after_its_path_is_replaced() {
        let path = temp_file("handle-id", b"old");
        let moved = path.with_extension("old");
        let file = crate::store::open_regular(&path).unwrap();
        let id = FileId::of_file(&file).unwrap();
        fs::rename(&path, &moved).unwrap();
        fs::write(&path, b"newer").unwrap();
        assert_eq!(FileId::of_file(&file).unwrap(), id);
        assert_ne!(FileId::of(&path).unwrap(), id);
        drop(file);
        fs::remove_file(moved).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn local_documents_inherit_routes_and_reload_without_path_fallback() {
        let scratch = Scratch::new("local-document");
        let sub = scratch.0.join("sub");
        fs::create_dir(&sub).unwrap();
        let source_path = scratch.0.join("source.md");
        fs::write(&source_path, b"# Source").unwrap();
        fs::write(sub.join("child.md"), b"# Child").unwrap();
        fs::write(scratch.0.join("last.txt"), b"last").unwrap();
        let source = Document::open(&source_path).unwrap();
        assert!(!source.local_only());
        assert_eq!(source.local_path(1, "missing.txt").unwrap().path(), scratch.0.join("missing.txt"));
        assert!(matches!(source.open_local(2, "sub/child.md"), Err(DocError::Stale { .. })));
        assert!(matches!(source.open_local(1, "absent.png"), Err(DocError::Refused(_))));
        let mut child = source.open_local(1, "sub/child.md").unwrap();
        drop(source);
        assert!(child.local_only());
        assert_eq!(child.read(1, 0, 20).unwrap(), b"# Child");
        let mut text = child.open_local(1, "../last.txt").unwrap();
        assert!(text.local_only());
        text.reload().unwrap();
        assert!(text.local_only());
        assert_eq!(text.read(2, 0, 20).unwrap(), b"last");

        // An ordinary manual open follows this local junction. The inherited route must refuse it on read/Reload.
        let moved = scratch.0.join("moved");
        let held = scratch.0.join("held-child.md");
        fs::rename(sub.join("child.md"), &held).unwrap();
        fs::rename(&sub, &moved).unwrap();
        fs::rename(&held, moved.join("child.md")).unwrap();
        junction(&sub, &format!(r"\??\{}", moved.display()));
        assert!(Document::open(&sub.join("child.md")).is_ok());
        assert!(matches!(child.read(1, 0, 20), Err(DocError::Frozen(_))));
        assert!(matches!(child.reload(), Err(DocError::Refused(_))));
        assert_eq!(child.generation(), 1);
        assert!(child.local_only());
    }

    #[cfg(windows)]
    #[test]
    fn csv_and_tsv_local_targets_keep_markdown_origin_and_selected_folder_scope() {
        let scratch = Scratch::new("local-csv-tsv");
        let source_path = scratch.0.join("source.md");
        fs::write(&source_path, b"# Source").unwrap();
        fs::write(scratch.0.join("data.CSV"), b"a,b\n1,2\n").unwrap();
        fs::write(scratch.0.join("data.TsV"), b"a\tb\n1\t2\n").unwrap();
        let root = crate::local::folder::Folder::capture(&scratch.0, "1").unwrap();
        let mut source = Document::open(&source_path).unwrap();
        source.bind_folder(&root).unwrap();
        for name in ["/data.CSV", "/data.TsV"] {
            let mut target = source.open_local(1, name).unwrap();
            assert!(target.local_only());
            assert_eq!(target.folder_scope().unwrap().0, "1");
            assert!(target.open_local(1, "source.md").is_err(), "CSV/TSV does not become a Markdown link source");
            target.reload().unwrap();
            assert!(target.local_only());
            assert_eq!(target.folder_scope().unwrap().0, "1");
        }
        for refused in ["data.csv.exe", "data.tsv:stream", "/../outside.csv", r"\\server\share\data.csv"] {
            assert!(source.open_local(1, refused).is_err(), "{refused}");
        }
        root.close();
        let target = source.open_local(1, "/data.CSV").unwrap();
        assert!(target.local_only());
        assert_eq!(target.folder_scope().unwrap().0, "1");
    }

    #[cfg(windows)]
    #[test]
    fn derived_identity_and_reload_refuse_a_pipe_junction_without_connecting() {
        let scratch = Scratch::new("local-pipe-swap");
        let server = PipeServer::new("local-target.txt");
        let sub = scratch.0.join("sub");
        fs::create_dir(&sub).unwrap();
        let source_path = scratch.0.join("source.md");
        fs::write(&source_path, b"# Source").unwrap();
        fs::write(sub.join(server.name()), b"safe").unwrap();
        let source = Document::open(&source_path).unwrap();
        let target = format!("sub/{}", server.name());
        let mut derived = source.open_local(1, &target).unwrap();
        let held = scratch.0.join("held-target.txt");
        fs::rename(sub.join(server.name()), &held).unwrap();
        let moved = scratch.0.join("moved");
        fs::rename(&sub, &moved).unwrap();
        fs::rename(&held, moved.join(server.name())).unwrap();
        junction(&sub, r"\??\pipe\");
        assert!(matches!(source.open_local(1, &target), Err(DocError::Refused(_))));
        assert!(matches!(derived.read(1, 0, 4), Err(DocError::Frozen(_))));
        assert!(matches!(derived.reload(), Err(DocError::Refused(_))));
        assert!(!server.connected());
    }

    #[cfg(windows)]
    #[test]
    fn an_absent_cached_capability_refuses_before_rechecking_the_source_path() {
        let scratch = Scratch::new("local-no-capability");
        let server = PipeServer::new("local-source.md");
        let real = scratch.0.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join(server.name()), b"# Source").unwrap();
        let link = scratch.0.join("alias");
        junction(&link, &format!(r"\??\{}", real.display()));
        let source = Document::open(&link.join(server.name())).unwrap();
        assert!(source.local.is_none(), "a reparse route cannot become an automatic local-file capability");
        fs::remove_dir(&link).unwrap();
        junction(&link, r"\??\pipe\");
        assert!(matches!(source.local_path(1, "target.txt"), Err(DocError::Refused(_))));
        assert!(matches!(source.open_local(1, "target.txt"), Err(DocError::Refused(_))));
        assert!(!server.connected());
    }

    #[cfg(windows)]
    #[test]
    fn derived_index_open_uses_the_local_route_and_refuses_a_retargeted_ancestor() {
        let scratch = Scratch::new("local-index-route");
        let server = PipeServer::new("index-target.txt");
        let sub = scratch.0.join("sub");
        fs::create_dir(&sub).unwrap();
        let source_path = scratch.0.join("source.md");
        fs::write(&source_path, b"# Source").unwrap();
        fs::write(sub.join(server.name()), b"safe").unwrap();
        let source = crate::raw::Raw::open(&source_path).unwrap();
        let derived = source.open_local(1, &format!("sub/{}", server.name())).unwrap();
        let held = scratch.0.join("held-index.txt");
        fs::rename(sub.join(server.name()), &held).unwrap();
        let moved = scratch.0.join("moved");
        fs::rename(&sub, &moved).unwrap();
        fs::rename(&held, moved.join(server.name())).unwrap();
        junction(&sub, r"\??\pipe\");
        assert!(derived.index(|_| true).is_err(), "indexing must refuse the changed local route");
        assert!(derived.document().frozen().is_some());
        assert!(!server.connected());
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_local_origin_is_cached_without_changing_manual_open() {
        let path = temp_file("local-unsupported", b"# Source").with_extension("md");
        fs::write(&path, b"# Source").unwrap();
        let source = Document::open(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(matches!(source.local_path(1, "target.txt"), Err(DocError::Refused(_))));
        assert!(matches!(source.open_local(1, "target.txt"), Err(DocError::Refused(_))));
        assert!(!source.local_only());
    }

    #[cfg(windows)]
    #[test]
    fn saved_routes_keep_no_document_and_never_follow_a_retargeted_pipe_ancestor() {
        let scratch = Scratch::new("saved-pipe-route");
        let server = PipeServer::new("saved-target.txt");
        let sub = scratch.0.join("sub");
        fs::create_dir(&sub).unwrap();
        let source_path = scratch.0.join("source.md");
        fs::write(&source_path, b"# Source").unwrap();
        fs::write(sub.join(server.name()), b"original").unwrap();
        let source = Document::open(&source_path).unwrap();
        assert!(source.local.is_some());
        assert!(matches!(source.saved_route(1), Err(DocError::Refused(_))));
        let derived = source.open_local(1, &format!("sub/{}", server.name())).unwrap();
        let _ = derived.freeze("old generation was frozen".into());
        let saved = derived.saved_route(1).unwrap();
        assert!(matches!(derived.saved_route(2), Err(DocError::Stale { .. })));
        drop(derived);
        drop(source);
        fs::write(sub.join(server.name()), b"current bytes").unwrap();
        let current = crate::raw::Raw::open_saved(&saved).unwrap();
        assert_eq!(current.page(1, 0, 1).unwrap()[0].text, "current bytes");
        drop(current);
        fs::rename(&sub, scratch.0.join("moved")).unwrap();
        junction(&sub, r"\??\pipe\");
        assert!(matches!(crate::raw::Raw::open_saved(&saved), Err(DocError::Refused(_))));
        assert!(!server.connected());
    }
}
