//! Documents with generations (spec §3.1): every read checks the path's identity before and after,
//! and every chunk is verified against its first-read hash. Any change freezes the document.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::store::{ByteStore, NotRegular, StoreError, refusal};

/// What change detection compares, taken from the path (never the open handle, spec §3.3).
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
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, GetFileInformationByHandle,
        };
        // Access 0 = query only: no read access requested, so nothing is locked and nothing is scanned.
        let f = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
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
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocError::Io(e) => write!(f, "io: {e}"),
            DocError::Stale { current, asked } => write!(f, "stale span (generation {asked}, now {current})"),
            DocError::Frozen(why) => write!(f, "frozen: {why}"),
            DocError::Refused(why) => write!(f, "refused: {why}"),
            DocError::Binary => write!(f, "binary file"),
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

/// An I/O error, or `Refused` when the handle turned out not to be a regular file (`store::open_regular`).
fn io_error(e: io::Error) -> DocError {
    match e.get_ref() {
        Some(inner) if inner.is::<NotRegular>() => DocError::Refused(e.to_string()),
        _ => DocError::Io(e),
    }
}

pub struct Document {
    path: PathBuf,
    store: ByteStore,
    id: FileId,
    generation: u32,
    cache_chunks: usize,
    frozen: Mutex<Option<String>>,
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
        let store = ByteStore::open_with(path, cache_chunks).map_err(io_error)?;
        if store.len() != id.size {
            return Err(DocError::Frozen("changed while opening".into()));
        }
        check_len(store.len())?;
        Ok(Document { path: path.to_owned(), store, id, generation, cache_chunks, frozen: Mutex::new(None) })
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

    /// `between` runs after the first identity check and before the read: the mutation-race test injects writes there.
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

    /// `reads` through the store between one identity check before and one after (plan PR 1: per page, not per
    /// line or chunk, since a path stat costs ~24 µs). Every chunk read inside still verifies its hash (§3.1).
    pub fn verified<T>(
        &self,
        generation: u32,
        reads: impl FnOnce(&ByteStore) -> Result<T, StoreError>,
    ) -> Result<T, DocError> {
        if generation != self.generation {
            return Err(DocError::Stale { current: self.generation, asked: generation });
        }
        self.check()?;
        let out = reads(&self.store).map_err(|e| match e {
            StoreError::Changed { chunk } => self.freeze(format!("changed on disk (chunk {chunk})")),
            StoreError::Io(e) => self.freeze(format!("read failed: {e}")),
        })?;
        self.check()?;
        Ok(out)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Ctrl+R: a fresh handle, identity and hash table, one generation later.
    pub fn reload(&mut self) -> Result<(), DocError> {
        *self = Document::open_with(&self.path, self.cache_chunks, self.generation + 1)?;
        Ok(())
    }

    fn check(&self) -> Result<(), DocError> {
        if let Some(why) = self.frozen() {
            return Err(DocError::Frozen(why));
        }
        match FileId::of(&self.path) {
            Ok(now) if now == self.id => Ok(()),
            Ok(_) => Err(self.freeze("changed on disk".into())),
            Err(e) => Err(self.freeze(format!("unavailable: {e}"))),
        }
    }

    fn freeze(&self, why: String) -> DocError {
        *self.frozen.lock().unwrap() = Some(why.clone());
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

    /// Spec §13.1 Spike C: an in-place, same-size write between the identity check and the read,
    /// with the timestamp restored, is caught by chunk verification in 1,000 of 1,000 runs.
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

    /// Spec §3.3: keep the handle for the document's lifetime, or reopen per read? Prints the cost of each.
    /// Run: cargo test --release -p spike-core handle_lifetime -- --ignored --nocapture
    #[test]
    #[ignore]
    fn handle_lifetime_costs() {
        let len = 64 * CHUNK;
        let path = temp_file("doc-handles", &pattern(len, 5));
        let doc = Document::open(&path).unwrap();
        let offsets: Vec<u64> = (0..2000u64).map(|i| (i * 2_654_435_761) % (len as u64 - 65_536)).collect();
        let time = |label: &str, mut f: Box<dyn FnMut(u64)>| {
            let mut us: Vec<f64> = offsets
                .iter()
                .map(|&o| {
                    let t = std::time::Instant::now();
                    f(o);
                    t.elapsed().as_secs_f64() * 1e6
                })
                .collect();
            us.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("{label}: p50 {:.1} µs, p95 {:.1} µs", us[us.len() / 2], us[us.len() * 95 / 100]);
        };
        time("kept handle, store.read only", Box::new(|o| drop(doc.store().read(o, o + 65_536).unwrap())));
        time("kept handle + identity checks (doc.read)", Box::new(|o| drop(doc.read(1, o, o + 65_536).unwrap())));
        time(
            "reopen per read + identity checks",
            Box::new(|o| {
                let _ = FileId::of(&path).unwrap();
                let f = fs::File::open(&path).unwrap();
                let mut buf = vec![0u8; 65_536];
                crate::store::read_exact_at(&f, &mut buf, o).unwrap();
                let _ = FileId::of(&path).unwrap();
            }),
        );
        time(
            "identity check alone",
            Box::new(|_| {
                FileId::of(&path).unwrap();
            }),
        );
    }
}
