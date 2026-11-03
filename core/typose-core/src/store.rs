//! File-backed byte store (spec §3.1, §3.3): positional reads only, never mmap.
//! Every 1MiB chunk is hashed the first time it's read and verified on every later read.
use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use xxhash_rust::xxh3::xxh3_64;

use crate::budget::{OverBudget, Reservation};

pub const CHUNK: usize = 1 << 20;
/// The chunk cache's size: 64 MiB.
pub const CACHE_CHUNKS: usize = 64;
/// Plan C1's Raw floor: the cache keeps 4 chunks whatever the ledger holds (or the whole file, if it's smaller).
pub const FLOOR_CHUNKS: usize = 4;

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    /// The bytes on disk no longer match the version first read.
    Changed {
        chunk: u64,
    },
    /// The read's cancel flag was set (plan C5, `cancellable`): it stopped before its next chunk.
    Cancelled,
}

/// Each chunk's xxh3, and a bit for whether it's been seen, since 0 is a valid hash (spec §3.1). The tables are sized
/// at open: a document's length is fixed for its life, so they never grow (plan C1).
pub struct ChunkHashes {
    table: Mutex<HashTable>,
    /// Pays for the tables and this struct. Declared after them, so they're freed first.
    charge: Reservation,
}

struct HashTable {
    hashes: Box<[u64]>,
    seen: Box<[u64]>,
}

/// The chunk cache (spec §3.3), bounded in charged bytes (plan C1). Its floor (`FLOOR_CHUNKS`) is reserved at open;
/// past that it grows a chunk at a time while the ledger allows, up to `max`, and otherwise evicts. Readers copy out of
/// it under its lock, so an evicted chunk is freed at once rather than when the last reader lets go.
struct Cache {
    chunks: VecDeque<(u64, Vec<u8>)>,
    slots: usize,
    max: usize,
    /// The file's length: the cache never holds more than that.
    len: u64,
    /// Inactive documents keep their floor but cannot grow, including inserts from reads already in flight.
    active: bool,
    charge: Reservation,
}

pub struct ByteStore {
    file: File,
    len: u64,
    hashes: Arc<ChunkHashes>,
    cache: Mutex<Cache>,
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
            StoreError::Cancelled => f.write_str("cancelled"),
        }
    }
}

thread_local! {
    /// The cancel flag of the read running on this thread, while `cancellable` runs it.
    static CANCEL: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

/// Runs `reads` on this thread with `cancel` as its cancel flag (plan C5): every chunk it touches checks the flag
/// first and fails with `Cancelled` once it's set. A page touches a chunk at least once per item, so a cancelled read
/// stops within the chunk read it's in, between items at the latest. It's a thread's, not a parameter, so every read
/// path through the store (`pages`, `locate_line`) honours it without carrying it.
pub fn cancellable<T>(cancel: &Arc<AtomicBool>, reads: impl FnOnce() -> T) -> T {
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            CANCEL.with(|c| *c.borrow_mut() = None);
        }
    }
    CANCEL.with(|c| *c.borrow_mut() = Some(cancel.clone()));
    let _clear = Clear;
    reads()
}

/// Whether the read `cancellable` runs on this thread has been cancelled.
pub fn cancelled() -> bool {
    CANCEL.with(|c| c.borrow().as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)))
}

/// Spec §3.3 🔒: device and special files are refused before anything opens them. Opening a named pipe, or on
/// Windows even stat-ing one, connects to its server, and opening a FIFO blocks. `Ok(Some(why))` is a refusal, which
/// names a folder as one (a launch that names one makes it a root); `Err` is the path's own error (missing, permission
/// denied).
pub fn refusal(path: &Path) -> io::Result<Option<&'static str>> {
    if let Some(why) = route_refusal(path)? {
        return Ok(Some(why));
    }
    // A stat. On Unix it opens nothing. On Windows it opens a query handle (`query_open`), once `route_refusal` has
    // followed every link in the path to a location that isn't a device.
    #[cfg(windows)]
    let meta = query_open(path, 0)?.metadata()?;
    #[cfg(unix)]
    let meta = std::fs::metadata(path)?;
    Ok((!meta.is_file()).then_some(if meta.is_dir() { "a folder" } else { "not a regular file" }))
}

/// Opens `path` for queries only, as `std::fs::metadata` does (access 0, so nothing is locked or read; backup
/// semantics, so a directory opens too), plus `flags`, with identification-level QoS: if a swap ever wins the race
/// between the route walk and this open, a pipe server on the other end can identify the caller but can't
/// impersonate it.
#[cfg(windows)]
pub(crate) fn query_open(path: &Path, flags: u32) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SECURITY_IDENTIFICATION,
    };
    std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | flags)
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(path)
}

/// Whether `path` reaches a network share: a UNC path, or a drive letter (through any `subst` chain) that the
/// network redirector serves. String work and `QueryDosDeviceW` only: nothing is opened, so a dead share can't stall
/// it. Session restore uses it to leave such paths unopened until a click (brief §4.6).
pub fn network(path: &Path) -> bool {
    #[cfg(windows)]
    {
        windows::network(path)
    }
    #[cfg(unix)]
    {
        let _ = path;
        false
    }
}

/// The part of `refusal` that opens nothing a device could answer, to run before any by-path access after the
/// open too (plan PR 4): a path swapped for a link into the pipe namespace, or a drive letter remapped onto it,
/// must not connect a later identity check. On Unix a stat opens nothing, so there's nothing to check.
pub fn route_refusal(path: &Path) -> io::Result<Option<&'static str>> {
    #[cfg(windows)]
    {
        windows::refusal(path)
    }
    #[cfg(unix)]
    {
        let _ = path;
        Ok(None)
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::path::{Component, Path, PathBuf, Prefix};

    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    /// Links followed before giving up (Windows itself stops at 63).
    const MAX_LINKS: usize = 32;

    /// First by path form, then the drive, then through every link in the path, following none of them:
    /// - the form: `\\.\`, `\\?\` and `\??\` paths (either slash), UNC shares that reach pipes and mailslots, and
    ///   reserved device names;
    /// - the drive letter's target (`drive`), read without opening anything;
    /// - the links: each component in turn, through `GetFileAttributesW`, which reads a link's own attributes, then
    ///   for a reparse point a `query_open` of the link itself, never its target, then `read_link`. A junction's or
    ///   symlink's target gets the same checks before anything past the link is touched, so a link into
    ///   `\??\pipe\` is refused.
    pub fn refusal(path: &Path) -> io::Result<Option<&'static str>> {
        // The raw form first: `absolute` would read `\??\C:\x` as a rooted path on the current drive.
        if let Some(why) = form(path) {
            return Ok(Some(why));
        }
        let mut path = std::path::absolute(path)?; // GetFullPathNameW: string work, no file access
        for _ in 0..MAX_LINKS {
            if let Some(why) = form(&path) {
                return Ok(Some(why));
            }
            match drive(&path)? {
                Drive::Refused(why) => return Ok(Some(why)),
                Drive::Path(mapped) => {
                    path = std::path::absolute(mapped)?;
                    continue;
                }
                Drive::Disk => {}
            }
            match first_link(&path)? {
                Some(resolved) => path = std::path::absolute(resolved)?,
                None => return Ok(None),
            }
        }
        Ok(Some("too many links"))
    }

    pub fn network(path: &Path) -> bool {
        let unc = |p: &Path| match p.components().next() {
            Some(Component::Prefix(x)) => matches!(x.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..)),
            _ => false,
        };
        let Ok(mut path) = std::path::absolute(path) else { return unc(path) }; // GetFullPathNameW: string work
        for _ in 0..MAX_LINKS {
            if unc(&path) {
                return true;
            }
            match drive(&path) {
                Ok(Drive::Path(mapped)) => path = mapped,
                _ => return false,
            }
        }
        false
    }

    enum Drive {
        /// No drive letter, or one on a volume or another device: the walk goes on.
        Disk,
        Refused(&'static str),
        /// The same path through what the drive letter stands for, to check again.
        Path(PathBuf),
    }

    /// A drive letter is a name in the session's DOS-device namespace: `DefineDosDeviceW` (no privilege needed) or
    /// `subst` can point it anywhere, and a path through it reaches whatever that is. `QueryDosDeviceW` reads the
    /// target without opening anything:
    /// - the pipe and mailslot devices are refused, as their `\\.\` paths are;
    /// - a subst-style target (`\??\C:\dir`, `\??\UNC\host\share`) is translated back to a path, any other target in
    ///   the DOS-device namespace (`\??\PIPE`) is refused;
    /// - a network redirector's (`\Device\Mup\…`, `\Device\LanmanRedirector\…`) becomes the UNC path it reaches, so
    ///   `form` judges its share;
    /// - any other device (a volume, a CD, a RAM or encrypted disk) is a drive.
    fn drive(path: &Path) -> io::Result<Drive> {
        use windows_sys::Win32::Storage::FileSystem::QueryDosDeviceW;
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else { return Ok(Drive::Disk) };
        let Prefix::Disk(letter) = prefix.kind() else { return Ok(Drive::Disk) };
        let rest = components.as_path().to_string_lossy().into_owned(); // `\dir\file`
        let name = [u16::from(letter), u16::from(b':'), 0];
        let mut buf = vec![0u16; 4096];
        let n = unsafe { QueryDosDeviceW(name.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
        if n == 0 {
            return Err(io::Error::last_os_error()); // no such drive
        }
        let end = buf.iter().position(|&u| u == 0).unwrap_or(n as usize);
        let target = String::from_utf16_lossy(&buf[..end]);
        let lower = target.to_ascii_lowercase();
        // `target` below `prefix`: what follows it, if it's the prefix itself or a path under it.
        let under = |prefix: &str| {
            lower
                .strip_prefix(prefix)
                .filter(|r| r.is_empty() || r.starts_with('\\'))
                .map(|r| &target[target.len() - r.len()..])
        };
        if under(r"\device\namedpipe").is_some() || under(r"\device\mailslot").is_some() {
            return Ok(Drive::Refused("a drive mapped to pipes or mailslots"));
        }
        let unc = |host_share: &str| {
            let full = format!("{host_share}{rest}");
            Ok(Drive::Path(PathBuf::from(format!(r"\\{}", full.trim_start_matches('\\')))))
        };
        if let Some(r) = under(r"\device\mup").or_else(|| under(r"\device\lanmanredirector")) {
            // `\;LanmanRedirector\;Z:0000…\host\share`: the `;` components are the redirector's own.
            return unc(&r.split('\\').filter(|c| !c.is_empty() && !c.starts_with(';')).collect::<Vec<_>>().join(r"\"));
        }
        for alias in [r"\??\", r"\dosdevices\", r"\global??\"] {
            if lower.starts_with(alias) {
                let inner = &target[alias.len()..];
                if inner.get(..4).is_some_and(|p| p.eq_ignore_ascii_case(r"UNC\")) {
                    return unc(&inner[4..]);
                }
                let bytes = inner.as_bytes();
                if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                    return Ok(Drive::Path(PathBuf::from(format!("{inner}{rest}"))));
                }
                return Ok(Drive::Refused("a drive mapped to a device"));
            }
        }
        Ok(Drive::Disk)
    }

    fn form(path: &Path) -> Option<&'static str> {
        let full = path.as_os_str().to_string_lossy().replace('/', "\\");
        if [r"\\.\", r"\\?\", r"\??\"].iter().any(|p| full.starts_with(p)) {
            return Some("a device path");
        }
        if let Some(Component::Prefix(prefix)) = path.components().next()
            && let Prefix::UNC(_, share) = prefix.kind()
            && pipe_share(&share.to_string_lossy())
        {
            return Some("a pipe or mailslot share");
        }
        reserved(path).then_some("a device name")
    }

    /// `\\host\pipe\…` and `\\host\mailslot\…` reach pipes and mailslots on any host, this one included, and
    /// `IPC$` is the share they travel over. Windows drops a component's trailing dots and spaces.
    fn pipe_share(share: &str) -> bool {
        let share = share.trim_end_matches(['.', ' ']);
        ["pipe", "mailslot", "IPC$"].iter().any(|s| share.eq_ignore_ascii_case(s))
    }

    /// The reserved device names, in any directory, whatever follows them: `NUL`, `nul.txt`, `NUL:`, `con :x`.
    fn reserved(path: &Path) -> bool {
        let Some(name) = path.file_name() else { return false };
        let name = name.to_string_lossy();
        let stem = name.split(['.', ':']).next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
        let numbered = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT"));
        matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$")
            || numbered.is_some_and(|n| {
                matches!(n, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
            })
    }

    /// `path` with its first link replaced by the link's target, or `None` when no component is a link. A
    /// component past a link is never touched: it's checked again under the target.
    fn first_link(path: &Path) -> io::Result<Option<PathBuf>> {
        let mut walked = PathBuf::new();
        let mut components = path.components();
        while let Some(component) = components.next() {
            walked.push(component);
            if matches!(component, Component::Prefix(_) | Component::RootDir) {
                continue;
            }
            // `GetFileAttributesW` returns a link's own attributes, without a handle: one query per component, which
            // keeps the walk cheap enough to run before every identity check (plan PR 4). Only a reparse point needs
            // the link's own metadata (what `symlink_metadata` reads, here through `query_open` for its QoS), whose
            // `is_symlink` is true for symlinks and junctions (name surrogates), not for placeholders like OneDrive's.
            // `GetFileAttributesW` and `read_link` can't take QoS flags (plan §7).
            if reparse_point(&walked)?
                && super::query_open(&walked, FILE_FLAG_OPEN_REPARSE_POINT)?.metadata()?.file_type().is_symlink()
            {
                let target = std::fs::read_link(&walked)?;
                // A relative target is relative to the link's directory; an absolute one replaces the whole path.
                let base = walked.parent().unwrap_or(&walked);
                return Ok(Some(base.join(target).join(components.as_path())));
            }
        }
        Ok(None)
    }

    fn reparse_point(path: &Path) -> io::Result<bool> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, GetFileAttributesW, INVALID_FILE_ATTRIBUTES,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        match unsafe { GetFileAttributesW(wide.as_ptr()) } {
            INVALID_FILE_ATTRIBUTES => Err(io::Error::last_os_error()),
            attributes => Ok(attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0),
        }
    }
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
    let file = {
        // `File::open`'s options (default share mode: READ | WRITE | DELETE), with `query_open`'s QoS.
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
        std::fs::OpenOptions::new().read(true).security_qos_flags(SECURITY_IDENTIFICATION).open(path)?
    };
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
    /// What `new(chunks)` charges: 8 bytes and a seen bit per chunk, and the shared struct (plan C1's floor).
    pub const fn bytes(chunks: u64) -> u64 {
        chunks * 8 + chunks.div_ceil(64) * 8 + size_of::<ChunkHashes>() as u64 + 16 // an `Arc`'s two counts
    }

    pub fn new(chunks: u64) -> Result<Arc<ChunkHashes>, OverBudget> {
        let charge = Reservation::new(Self::bytes(chunks))?;
        let n = chunks as usize;
        let table =
            HashTable { hashes: vec![0; n].into_boxed_slice(), seen: vec![0; n.div_ceil(64)].into_boxed_slice() };
        Ok(Arc::new(ChunkHashes { table: Mutex::new(table), charge }))
    }

    /// Records the chunk's hash the first time it's seen; afterwards, verifies against it.
    pub fn check(&self, chunk: u64, data: &[u8]) -> Result<(), StoreError> {
        let hash = xxh3_64(data);
        let mut table = self.table.lock().unwrap();
        let HashTable { hashes, seen } = &mut *table;
        let Some(known) = hashes.get_mut(chunk as usize) else {
            return Err(StoreError::Changed { chunk }); // past the length the document opened with
        };
        let (word, bit) = (chunk as usize / 64, 1u64 << (chunk % 64));
        if seen[word] & bit == 0 {
            seen[word] |= bit;
            *known = hash;
            Ok(())
        } else if *known == hash {
            Ok(())
        } else {
            Err(StoreError::Changed { chunk })
        }
    }

    /// Chunks hashed so far.
    pub fn len(&self) -> usize {
        self.table.lock().unwrap().seen.iter().map(|w| w.count_ones() as usize).sum()
    }

    pub fn charged(&self) -> u64 {
        self.charge.bytes()
    }
}

impl Cache {
    /// The charge for `slots` chunks of a cache of at most `max`: its queue, and the chunks, never more than the file.
    fn bytes(slots: usize, max: usize, len: u64) -> u64 {
        (max * size_of::<(u64, Vec<u8>)>()) as u64 + (slots as u64 * CHUNK as u64).min(len)
    }

    fn new(max: usize, len: u64) -> Result<Cache, OverBudget> {
        let slots = FLOOR_CHUNKS.min(max);
        let charge = Reservation::new(Self::bytes(slots, max, len))?;
        Ok(Cache { chunks: VecDeque::with_capacity(max), slots, max, len, active: true, charge })
    }

    fn get(&self, idx: u64) -> Option<&[u8]> {
        self.chunks.iter().find(|(i, _)| *i == idx).map(|(_, data)| data.as_slice())
    }

    fn set_active(&mut self, active: bool) {
        self.active = active;
        if active {
            return; // reactivation enables future growth without allocating now
        }
        let floor = FLOOR_CHUNKS.min(self.max);
        while self.chunks.len() > floor {
            drop(self.chunks.pop_front()); // free each Vec before returning the reservation that paid for it
        }
        self.slots = floor;
        let keep = Self::bytes(floor, self.max, self.len); // max still pays for the retained queue allocation
        self.charge.shrink(self.charge.bytes() - keep);
    }

    /// Takes a chunk a reader has just read and verified. Past its floor the cache grows only while the ledger takes
    /// the next chunk's charge; otherwise the oldest chunk goes first, so the cache's bytes stay within its charge.
    fn insert(&mut self, idx: u64, data: Vec<u8>) {
        if self.get(idx).is_some() {
            return; // another read got there first
        }
        if self.chunks.len() >= self.slots {
            let more = Self::bytes(self.slots + 1, self.max, self.len) - Self::bytes(self.slots, self.max, self.len);
            if self.active && self.slots < self.max && self.charge.grow(more).is_ok() {
                self.slots += 1;
            } else {
                // At its most, or at the ledger's limit: the cache evicts, and keeps what it has (plan §7, PR 6).
                // ponytail: FIFO eviction, not LRU. Switch to LRU if Spike A shows cache thrash while scrolling.
                self.chunks.pop_front();
            }
        }
        self.chunks.push_back((idx, data));
    }
}

impl ByteStore {
    pub fn open(path: &Path) -> io::Result<ByteStore> {
        Self::open_with(path, CACHE_CHUNKS)
    }

    /// Opens `path` and reserves its share of plan C1's floor: the hash tables and the cache's floor. A refused
    /// reservation is an `io::Error` holding the `OverBudget`, and nothing stays charged.
    pub fn open_with(path: &Path, cache_chunks: usize) -> io::Result<ByteStore> {
        let file = open_regular(path)?;
        Self::from_file(file, cache_chunks)
    }

    /// A file already opened through a verified local route. This constructor never revisits its display path.
    pub(crate) fn from_file(file: File, cache_chunks: usize) -> io::Result<ByteStore> {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::other(NotRegular));
        }
        let len = metadata.len();
        let chunks = len.div_ceil(CHUNK as u64);
        let hashes = ChunkHashes::new(chunks).map_err(io::Error::other)?;
        let cache = Cache::new(cache_chunks.min(chunks as usize).max(1), len).map_err(io::Error::other)?;
        #[cfg(feature = "test-hooks")]
        crate::hooks::HANDLES.fetch_add(1, Ordering::Relaxed); // until `drop` below
        Ok(ByteStore { file, len, hashes, cache: Mutex::new(cache) })
    }

    /// The actual source handle, borrowed only while its local origin is captured during explicit open.
    pub(crate) fn file(&self) -> &File {
        &self.file
    }

    /// What this store has charged: (its hash tables, its cache).
    pub fn charges(&self) -> (u64, u64) {
        (self.hashes.charged(), self.cache.lock().unwrap().charge.bytes())
    }

    /// Inactive tabs retain the paid floor and queue metadata. The same lock guards trimming and insertion, so a
    /// read that finishes after deactivation cannot reclaim elastic slots. No source handle or hash state changes.
    pub fn set_cache_active(&self, active: bool) {
        self.cache.lock().unwrap().set_active(active);
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn hashes(&self) -> Arc<ChunkHashes> {
        self.hashes.clone()
    }

    /// Another handle to the file this store has open, made from the handle and never from the path, which may lead
    /// somewhere else by now (a link into the pipe namespace; plan PR 4). On Windows `ReOpenFile` makes a new file
    /// object, so its reads don't queue behind this handle's; on Unix `pread` never queues, so a `dup` will do.
    pub fn reopen(&self) -> io::Result<File> {
        #[cfg(unix)]
        {
            self.file.try_clone()
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle};
            use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, ReOpenFile,
            };
            let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
            let handle = unsafe { ReOpenFile(self.file.as_raw_handle() as _, GENERIC_READ, share, 0) };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(unsafe { File::from_raw_handle(handle as _) })
        }
    }

    /// Runs `f` on chunk `idx`: from the cache, or read from disk and verified (spec §3.1), then cached. A read from
    /// disk allocates the chunk in its caller's page slot (plan C1), and the cache takes it from there.
    fn with_chunk(&self, idx: u64, f: impl FnOnce(&[u8]) -> usize) -> Result<usize, StoreError> {
        if cancelled() {
            return Err(StoreError::Cancelled);
        }
        if let Some(hit) = self.cache.lock().unwrap().get(idx) {
            return Ok(f(hit));
        }
        #[cfg(feature = "test-hooks")]
        crate::hooks::read_delay();
        let start = idx * CHUNK as u64;
        let size = self.len.saturating_sub(start).min(CHUNK as u64) as usize;
        let mut buf = vec![0u8; size];
        read_exact_at(&self.file, &mut buf, start).map_err(|e| match e.kind() {
            io::ErrorKind::UnexpectedEof => StoreError::Changed { chunk: idx },
            _ => StoreError::Io(e),
        })?;
        self.hashes.check(idx, &buf)?;
        let mut cache = self.cache.lock().unwrap();
        let n = f(&buf);
        cache.insert(idx, buf);
        Ok(n)
    }

    pub fn read(&self, start: u64, end: u64) -> Result<Vec<u8>, StoreError> {
        let end = end.min(self.len);
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let mut pos = start;
        while pos < end {
            let idx = pos / CHUNK as u64;
            let off = (pos - idx * CHUNK as u64) as usize;
            let want = (end - pos) as usize;
            let take = self.with_chunk(idx, |data| {
                let take = want.min(data.len().saturating_sub(off));
                out.extend_from_slice(&data[off..off + take]);
                take
            })?;
            if take == 0 {
                break;
            }
            pos += take as u64;
        }
        Ok(out)
    }
}

#[cfg(feature = "test-hooks")]
impl Drop for ByteStore {
    fn drop(&mut self) {
        crate::hooks::HANDLES.fetch_sub(1, Ordering::Relaxed); // the file closes with it
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
        store.read(0, 1).unwrap();
        store.read(CHUNK as u64, CHUNK as u64 + 1).unwrap(); // evicts chunk 0 from the one-chunk cache
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start(10)).unwrap();
        f.write_all(b"same-size in-place write").unwrap();
        drop(f);
        assert!(matches!(store.read(0, 1), Err(StoreError::Changed { chunk: 0 })));
    }

    #[test]
    fn a_truncated_file_reads_as_changed() {
        let data = pattern(2 * CHUNK);
        let path = temp_file("truncated", &data);
        let store = ByteStore::open(&path).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(10).unwrap();
        assert!(matches!(store.read(CHUNK as u64, CHUNK as u64 + 1), Err(StoreError::Changed { chunk: 1 })));
    }

    #[test]
    fn the_file_stays_deletable_while_open() {
        let path = temp_file("deletable", &pattern(100));
        let store = ByteStore::open(&path).unwrap();
        store.read(0, 1).unwrap();
        std::fs::remove_file(&path).expect("Typose must never lock a file (brief §7.9)");
    }

    #[test]
    fn inactive_cache_releases_growth_preserves_queue_and_can_reactivate() {
        let mut cache = Cache::new(8, (12 * CHUNK) as u64).unwrap();
        for idx in 0..8 {
            cache.insert(idx, vec![idx as u8; CHUNK]);
        }
        let (capacity, max) = (cache.chunks.capacity(), cache.max);
        cache.set_active(false);
        let floor = Cache::bytes(FLOOR_CHUNKS, max, cache.len);
        assert_eq!((cache.slots, cache.chunks.len(), cache.charge.bytes()), (FLOOR_CHUNKS, FLOOR_CHUNKS, floor));
        assert_eq!((cache.max, cache.chunks.capacity()), (max, capacity));
        assert!(cache.get(0).is_none());
        assert_eq!(cache.get(7).unwrap()[0], 7);
        cache.insert(8, vec![8; CHUNK]);
        cache.insert(8, vec![8; CHUNK]); // duplicate late replies neither grow nor evict another chunk
        assert_eq!((cache.slots, cache.chunks.len(), cache.charge.bytes()), (FLOOR_CHUNKS, FLOOR_CHUNKS, floor));
        assert!(cache.get(5).is_some());
        cache.set_active(false);
        assert_eq!(cache.charge.bytes(), floor);
        cache.set_active(true);
        assert_eq!((cache.slots, cache.chunks.len(), cache.charge.bytes()), (FLOOR_CHUNKS, FLOOR_CHUNKS, floor));
        cache.insert(9, vec![9; CHUNK]);
        assert_eq!((cache.slots, cache.chunks.len(), cache.charge.bytes()), (5, 5, floor + CHUNK as u64));
    }

    #[test]
    fn inactive_cache_keeps_empty_small_and_partial_file_floors_paid() {
        for (max, len) in [(1, 0), (1, 17), (2, CHUNK as u64 + 17), (5, (4 * CHUNK) as u64 + 17)] {
            let mut cache = Cache::new(max, len).unwrap();
            for idx in 0..len.div_ceil(CHUNK as u64) {
                let size = len.saturating_sub(idx * CHUNK as u64).min(CHUNK as u64) as usize;
                cache.insert(idx, vec![0; size]);
            }
            let capacity = cache.chunks.capacity();
            cache.set_active(false);
            let floor = FLOOR_CHUNKS.min(max);
            assert_eq!(cache.slots, floor);
            assert!(cache.chunks.len() <= floor);
            assert_eq!(cache.charge.bytes(), Cache::bytes(floor, max, len));
            assert_eq!(cache.chunks.capacity(), capacity);
            assert_eq!(cache.max, max);
            let data: usize = cache.chunks.iter().map(|(_, bytes)| bytes.capacity()).sum();
            assert!(data as u64 + (max * size_of::<(u64, Vec<u8>)>()) as u64 <= cache.charge.bytes());
        }
    }

    #[test]
    fn an_insert_prepared_before_deactivation_cannot_regrow_the_cache() {
        use std::sync::Barrier;
        let cache = Arc::new(Mutex::new(Cache::new(8, (12 * CHUNK) as u64).unwrap()));
        for idx in 0..8 {
            cache.lock().unwrap().insert(idx, vec![0; CHUNK]);
        }
        let prepared = Arc::new(Barrier::new(2));
        let insert = Arc::new(Barrier::new(2));
        let reader = {
            let (cache, prepared, insert) = (cache.clone(), prepared.clone(), insert.clone());
            std::thread::spawn(move || {
                let bytes = vec![9; CHUNK]; // a cache-miss read owns this outside the cache lock
                prepared.wait();
                insert.wait();
                cache.lock().unwrap().insert(9, bytes);
            })
        };
        prepared.wait();
        cache.lock().unwrap().set_active(false);
        insert.wait();
        reader.join().unwrap();
        let cache = cache.lock().unwrap();
        assert!(!cache.active);
        assert_eq!((cache.slots, cache.chunks.len()), (FLOOR_CHUNKS, FLOOR_CHUNKS));
        assert_eq!(cache.charge.bytes(), Cache::bytes(FLOOR_CHUNKS, cache.max, cache.len));
        assert_eq!(cache.get(9).unwrap()[0], 9);
    }
}
