//! File-backed byte store (spec §3.1, §3.3): positional reads only, never mmap.
//! Every 1MiB chunk is hashed the first time it's read and verified on every later read.
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use xxhash_rust::xxh3::xxh3_64;

pub const CHUNK: usize = 1 << 20;
const DEFAULT_CACHE_CHUNKS: usize = 64;

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    /// The bytes on disk no longer match the version first read.
    Changed {
        chunk: u64,
    },
}

#[derive(Default)]
pub struct ChunkHashes(Mutex<HashMap<u64, u64>>);

pub struct ByteStore {
    file: File,
    len: u64,
    hashes: Arc<ChunkHashes>,
    cache: Mutex<VecDeque<(u64, Arc<Vec<u8>>)>>,
    cache_chunks: usize,
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "io: {e}"),
            StoreError::Changed { chunk } => write!(f, "changed on disk (chunk {chunk})"),
        }
    }
}

/// Spec §3.3: device and special files are refused before anything opens them. Opening `\\.\pipe\…` connects
/// to the pipe's server, and opening a FIFO blocks. `Ok(Some(why))` is a refusal; `Err` is the path's own error
/// (missing, permission denied).
pub fn refusal(path: &Path) -> io::Result<Option<&'static str>> {
    #[cfg(windows)]
    if windows_device_path(path) {
        return Ok(Some("a device path"));
    }
    // A stat. On Unix it opens nothing; on Windows it opens a query handle, which can reach a device now only
    // through a link, and `open_regular` checks the handle it reads through.
    Ok((!std::fs::metadata(path)?.is_file()).then_some("not a regular file"))
}

/// `\\.\`, `\\?\` and `\??\` paths (either slash), and the reserved device names in any directory.
#[cfg(windows)]
fn windows_device_path(path: &Path) -> bool {
    let full = path.as_os_str().to_string_lossy().replace('/', "\\");
    if [r"\\.\", r"\\?\", r"\??\"].iter().any(|p| full.starts_with(p)) {
        return true;
    }
    let Some(name) = path.file_name() else { return false };
    let name = name.to_string_lossy();
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let numbered = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT"));
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$")
        || numbered
            .is_some_and(|n| matches!(n, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
}

/// Marks an open refused because the handle isn't a regular file (`refusal` passed, then the path changed).
#[derive(Debug)]
pub struct NotRegular;

impl std::fmt::Display for NotRegular {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("not a regular file")
    }
}

impl std::error::Error for NotRegular {}

/// Opens `path` for reading, refusing anything but a regular file by its handle: a path swapped for a FIFO after
/// `refusal` must not block (`O_NONBLOCK`), and on Windows `GetFileType` must say disk.
pub fn open_regular(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path)?
    };
    #[cfg(unix)]
    let regular = file.metadata()?.is_file();
    #[cfg(windows)]
    let file = File::open(path)?; // Windows default share mode: READ | WRITE | DELETE
    #[cfg(windows)]
    let regular = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_DISK, GetFileType};
        let kind = unsafe { GetFileType(file.as_raw_handle() as _) };
        kind == FILE_TYPE_DISK && file.metadata()?.is_file()
    };
    if regular { Ok(file) } else { Err(io::Error::other(NotRegular)) }
}

pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, offset)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, offset)
    }
}

pub fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    while !buf.is_empty() {
        let n = read_at(file, buf, offset)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "file shorter than expected"));
        }
        buf = &mut buf[n..];
        offset += n as u64;
    }
    Ok(())
}

impl ChunkHashes {
    /// Records the chunk's hash the first time it's seen; afterwards, verifies against it.
    pub fn check(&self, chunk: u64, data: &[u8]) -> Result<(), StoreError> {
        let hash = xxh3_64(data);
        let mut map = self.0.lock().unwrap();
        match map.get(&chunk) {
            Some(&known) if known != hash => Err(StoreError::Changed { chunk }),
            Some(_) => Ok(()),
            None => {
                map.insert(chunk, hash);
                Ok(())
            }
        }
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl ByteStore {
    pub fn open(path: &Path) -> io::Result<ByteStore> {
        Self::open_with(path, DEFAULT_CACHE_CHUNKS)
    }

    pub fn open_with(path: &Path, cache_chunks: usize) -> io::Result<ByteStore> {
        let file = open_regular(path)?;
        let len = file.metadata()?.len();
        Ok(ByteStore {
            file,
            len,
            hashes: Arc::new(ChunkHashes::default()),
            cache: Mutex::new(VecDeque::new()),
            cache_chunks: cache_chunks.max(1),
        })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn hashes(&self) -> Arc<ChunkHashes> {
        self.hashes.clone()
    }

    pub fn chunk(&self, idx: u64) -> Result<Arc<Vec<u8>>, StoreError> {
        if let Some((_, hit)) = self.cache.lock().unwrap().iter().find(|(i, _)| *i == idx) {
            return Ok(hit.clone());
        }
        let start = idx * CHUNK as u64;
        let size = self.len.saturating_sub(start).min(CHUNK as u64) as usize;
        let mut buf = vec![0u8; size];
        read_exact_at(&self.file, &mut buf, start).map_err(|e| match e.kind() {
            io::ErrorKind::UnexpectedEof => StoreError::Changed { chunk: idx },
            _ => StoreError::Io(e),
        })?;
        self.hashes.check(idx, &buf)?;
        let data = Arc::new(buf);
        let mut cache = self.cache.lock().unwrap();
        cache.push_back((idx, data.clone()));
        // ponytail: FIFO eviction, not LRU. Switch to LRU if Spike A shows cache thrash while scrolling.
        if cache.len() > self.cache_chunks {
            cache.pop_front();
        }
        Ok(data)
    }

    pub fn read(&self, start: u64, end: u64) -> Result<Vec<u8>, StoreError> {
        let end = end.min(self.len);
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let mut pos = start;
        while pos < end {
            let idx = pos / CHUNK as u64;
            let data = self.chunk(idx)?;
            let off = (pos - idx * CHUNK as u64) as usize;
            let take = ((end - pos) as usize).min(data.len().saturating_sub(off));
            if take == 0 {
                break;
            }
            out.extend_from_slice(&data[off..off + take]);
            pos += take as u64;
        }
        Ok(out)
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};

    /// Writes `bytes` to a unique temp file, deleted when the returned `Temp` drops (plan A:3622).
    pub fn temp_file(name: &str, bytes: &[u8]) -> Temp {
        let path = std::env::temp_dir().join(format!("typose-core-{}-{}", std::process::id(), name));
        std::fs::write(&path, bytes).unwrap();
        Temp(path)
    }

    /// A temp file deleted on drop, so a failing assert can't leave 100–200 MB behind.
    pub struct Temp(pub PathBuf);

    impl std::ops::Deref for Temp {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for Temp {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::temp_file;
    use super::*;
    use std::io::{Seek, SeekFrom, Write};

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn reads_across_chunk_boundaries() {
        let data = pattern(3 * CHUNK + 17);
        let store = ByteStore::open(&temp_file("cross", &data)).unwrap();
        let (a, b) = (CHUNK as u64 - 5, 2 * CHUNK as u64 + 9);
        assert_eq!(store.read(a, b).unwrap(), data[a as usize..b as usize]);
        assert_eq!(store.read(3 * CHUNK as u64, 10 * CHUNK as u64).unwrap(), data[3 * CHUNK..]);
    }

    #[test]
    fn a_changed_chunk_is_detected_on_reread() {
        let data = pattern(2 * CHUNK);
        let path = temp_file("changed", &data);
        let store = ByteStore::open_with(&path, 1).unwrap();
        store.chunk(0).unwrap();
        store.chunk(1).unwrap(); // evicts chunk 0 from the one-chunk cache
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start(10)).unwrap();
        f.write_all(b"same-size in-place write").unwrap();
        drop(f);
        assert!(matches!(store.chunk(0), Err(StoreError::Changed { chunk: 0 })));
    }

    #[test]
    fn a_truncated_file_reads_as_changed() {
        let data = pattern(2 * CHUNK);
        let path = temp_file("truncated", &data);
        let store = ByteStore::open(&path).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(10).unwrap();
        assert!(matches!(store.chunk(1), Err(StoreError::Changed { chunk: 1 })));
    }

    #[test]
    fn the_file_stays_deletable_while_open() {
        let path = temp_file("deletable", &pattern(100));
        let store = ByteStore::open(&path).unwrap();
        store.chunk(0).unwrap();
        std::fs::remove_file(&path).expect("Typose must never lock a file (brief §7.9)");
    }
}
