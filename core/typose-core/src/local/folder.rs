//! The sidebar's session-only directory authority. Display paths never enumerate or open children.
#[cfg(windows)]
use super::LocalError;
use super::LocalRoute;
#[cfg(windows)]
use crate::budget::Reservation;
use crate::doc::DocError;
use std::path::Path;

pub const PAGE_ITEMS: usize = 128;
pub const PAGE_WORK: u64 = 512 * 1024;
pub const MAX_NODES: usize = 4096;
pub const MAX_SCANS: usize = 64;

pub struct Entry {
    pub id: u32,
    pub name: String,
    pub kind: &'static str,
    pub hidden: bool,
}
pub struct Page {
    pub entries: Vec<Entry>,
    pub cursor: Option<u32>,
}

#[cfg(windows)]
fn error(e: LocalError) -> DocError {
    match e {
        LocalError::Refused(s) => DocError::Refused(s.into()),
        LocalError::Io(e) => DocError::Io(e),
        LocalError::Memory(e) => DocError::Memory(e),
    }
}

pub struct Folder {
    #[cfg(windows)]
    inner: std::sync::Mutex<Option<win::Tree>>,
}

impl Folder {
    pub fn capture(path: &Path, id: &str) -> Result<Self, DocError> {
        #[cfg(windows)]
        {
            Ok(Self { inner: std::sync::Mutex::new(Some(win::Tree::capture(path, id).map_err(error)?)) })
        }
        #[cfg(not(windows))]
        {
            let _ = (path, id);
            Err(DocError::Refused("folder browsing is currently available on Windows only".into()))
        }
    }

    pub fn info(&self) -> Result<(String, String), DocError> {
        #[cfg(windows)]
        {
            let inner = self.inner.lock().unwrap();
            let t = inner.as_ref().ok_or(DocError::Cancelled)?;
            let f = t.root.folder.as_ref().unwrap();
            Ok((f.label.clone(), f.base.clone()))
        }
        #[cfg(not(windows))]
        {
            Err(DocError::Cancelled)
        }
    }

    pub fn list(
        &self,
        node: u32,
        cursor: Option<u32>,
        hidden: bool,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Page, DocError> {
        #[cfg(windows)]
        {
            let mut inner = self.inner.lock().unwrap();
            let tree = inner.as_mut().ok_or(DocError::Cancelled)?;
            tree.list(node, cursor, hidden, cancelled)
        }
        #[cfg(not(windows))]
        {
            let _ = (node, cursor, hidden, cancelled);
            Err(DocError::Cancelled)
        }
    }

    pub fn route(&self, node: u32) -> Result<LocalRoute, DocError> {
        #[cfg(windows)]
        {
            let inner = self.inner.lock().unwrap();
            inner.as_ref().ok_or(DocError::Cancelled)?.route(node).map_err(error)
        }
        #[cfg(not(windows))]
        {
            let _ = node;
            Err(DocError::Cancelled)
        }
    }

    pub fn open(&self, node: u32) -> Result<crate::raw::Raw, DocError> {
        let route = self.route(node)?;
        let raw = crate::raw::Raw::open_saved(&route)?;
        #[cfg(windows)]
        {
            let inner = self.inner.lock().unwrap();
            let file = inner.as_ref().ok_or(DocError::Cancelled)?.open_node(node).map_err(error)?;
            if !route.same_file(&file, raw.document().store().file()).map_err(error)? {
                return Err(DocError::Refused("folder entry changed while opening; refresh the folder".into()));
            }
        }
        Ok(raw)
    }

    /// A pathname is only a membership candidate. The held source and root-relative walk must match full identity.
    pub fn bind(&self, path: &Path, source: &std::fs::File) -> Result<Option<LocalRoute>, DocError> {
        #[cfg(windows)]
        {
            let inner = self.inner.lock().unwrap();
            let tree = inner.as_ref().ok_or(DocError::Cancelled)?;
            tree.bind(path, source).map_err(error)
        }
        #[cfg(not(windows))]
        {
            let _ = (path, source);
            Ok(None)
        }
    }

    pub fn close(&self) -> bool {
        #[cfg(windows)]
        {
            self.inner.lock().unwrap().take().is_some()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}

#[cfg(windows)]
mod win {
    use super::super::{
        FolderScope, MAX_BYTES, ROUTE_FIXED, Root, WORK_BYTES, absolute_drive, bounded, component, native, normalize,
        reject_namespace, relative_to,
    };
    use super::*;
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::sync::Arc;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        FILE_ATTRIBUTE_RECALL_ON_OPEN, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_EXTD_DIR_INFO, FileIdExtdDirectoryInfo,
        FileIdExtdDirectoryRestartInfo, GetFileInformationByHandleEx,
    };

    struct Node {
        path: String,
        identity: [u8; 16],
        directory: bool,
        supported: bool,
        _charge: Reservation,
    }
    struct Scan {
        node: u32,
        id: u32,
        hidden: bool,
        file: File,
        buffer: Vec<u64>,
        offset: Option<usize>,
        restart: bool,
        _charge: Reservation,
    }
    pub(super) struct Tree {
        pub(super) root: Arc<Root>,
        nodes: Vec<Node>,
        scans: Vec<Scan>,
        next_scan: u32,
        _charge: Reservation,
    }

    fn supported(name: &str) -> bool {
        let ext = name.rsplit('.').next().unwrap_or("");
        [
            "md", "markdown", "txt", "csv", "tsv", "json", "jsonl", "log", "yaml", "yml", "toml", "ini", "cfg", "xml",
            "html", "css", "js", "ts", "py", "rs", "c", "h", "cpp", "hpp", "java", "sh", "ps1", "sql",
        ]
        .iter()
        .any(|x| ext.eq_ignore_ascii_case(x))
    }

    impl Tree {
        pub(super) fn capture(path: &Path, id: &str) -> Result<Self, LocalError> {
            let _work = Reservation::new(WORK_BYTES)?;
            let text = path.to_str().ok_or(LocalError::Refused("folder path is not Unicode"))?;
            bounded(text)?;
            reject_namespace(text)?;
            if text.as_bytes().get(1) == Some(&b':') && !matches!(text.as_bytes().get(2), Some(b'/' | b'\\')) {
                return Err(LocalError::Refused("drive-relative folder paths are not supported"));
            }
            let absolute = std::path::absolute(path)?;
            let text = absolute.to_str().ok_or(LocalError::Refused("folder path is not Unicode"))?;
            let drive = absolute_drive(text)?;
            let base = if text.trim_end_matches(['\\', '/']).len() == 2 {
                format!("{}:\\", drive as char)
            } else {
                normalize(&format!("{}:\\source", drive as char), drive, text)?
            };
            let scope_charge = Reservation::new((3 * MAX_BYTES + 4096) as u64)?;
            let label = if base.len() == 3 {
                format!("{}:", drive as char)
            } else {
                base.rsplit('\\').next().unwrap_or(&base).to_owned()
            };
            let drive_root = native::root(drive)?;
            let file = if base.len() == 3 {
                native::listing_root(drive)?
            } else {
                native::walk_relative(&drive_root, &base[3..], true)?
            };
            let identity = native::identity(&file)?.1;
            let charge = Reservation::new(
                (MAX_NODES * std::mem::size_of::<Node>() + MAX_SCANS * std::mem::size_of::<Scan>() + 1024 * 1024)
                    as u64,
            )?;
            let node_charge = Reservation::new((2 * base.len() + 1024) as u64)?;
            let mut nodes = Vec::with_capacity(MAX_NODES);
            nodes.push(Node { path: base.clone(), identity, directory: true, supported: true, _charge: node_charge });
            #[cfg(feature = "test-hooks")]
            crate::hooks::HANDLES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = Arc::new(Root {
                file,
                drive,
                folder: Some(FolderScope { id: id.to_owned(), base, label, _charge: scope_charge }),
            });
            Ok(Self { root, nodes, scans: Vec::with_capacity(MAX_SCANS), next_scan: 1, _charge: charge })
        }

        pub(super) fn open_node(&self, node: u32) -> Result<File, LocalError> {
            let n = self
                .nodes
                .get(node as usize)
                .ok_or(LocalError::Refused("folder entry is no longer available; refresh the folder"))?;
            let base = &self.root.folder.as_ref().unwrap().base;
            let relative = if node == 0 { "" } else { relative_to(base, &n.path)? };
            let file = native::walk_relative(&self.root.file, relative, n.directory)?;
            if native::identity(&file)?.1 != n.identity {
                return Err(LocalError::Refused("folder entry changed; refresh the folder"));
            }
            Ok(file)
        }

        pub(super) fn route(&self, node: u32) -> Result<LocalRoute, LocalError> {
            let n = self.nodes.get(node as usize).ok_or(LocalError::Refused("folder entry is no longer available"))?;
            if n.directory || !n.supported {
                return Err(LocalError::Refused("choose a supported text file"));
            }
            let charge = Reservation::new(ROUTE_FIXED + n.path.len() as u64)?;
            let mut route = LocalRoute::make(self.root.clone(), n.path.clone(), charge);
            route.node = Some(node);
            self.open_node(node)?; // authority and listed identity, never a checked display-path reopen
            Ok(route)
        }

        pub(super) fn bind(&self, path: &Path, source: &File) -> Result<Option<LocalRoute>, LocalError> {
            let _work = Reservation::new(WORK_BYTES)?;
            let absolute = std::path::absolute(path)?;
            let path = absolute.as_path();
            let Some(text) = path.to_str() else { return Ok(None) };
            if absolute_drive(text)? != self.root.drive {
                return Ok(None);
            }
            let normalized = normalize(&format!("{}:\\source", self.root.drive as char), self.root.drive, text)?;
            let text = normalized.as_str();
            let base = &self.root.folder.as_ref().unwrap().base;
            let Ok(relative) = relative_to(base, text) else { return Ok(None) };
            let file = native::walk_relative(&self.root.file, relative, false)?;
            if native::identity(&file)? != native::identity(source)? {
                return Ok(None);
            }
            let charge = Reservation::new(ROUTE_FIXED + text.len() as u64)?;
            Ok(Some(LocalRoute::make(self.root.clone(), text.to_owned(), charge)))
        }

        pub(super) fn list(
            &mut self,
            node: u32,
            cursor: Option<u32>,
            hidden: bool,
            cancelled: &dyn Fn() -> bool,
        ) -> Result<Page, DocError> {
            if cancelled() {
                return Err(DocError::Cancelled);
            }
            let index = if let Some(id) = cursor {
                self.scans
                    .iter()
                    .position(|s| s.node == node && s.id == id && s.hidden == hidden)
                    .ok_or_else(|| DocError::Refused("folder listing expired; refresh the folder".into()))?
            } else {
                let n = self
                    .nodes
                    .get(node as usize)
                    .ok_or_else(|| DocError::Refused("folder entry is unavailable".into()))?;
                if !n.directory {
                    return Err(DocError::Refused("choose a directory to expand".into()));
                }
                let file = self.open_node(node).map_err(error)?;
                let charge = Reservation::new(64 * 1024 + 4096).map_err(DocError::Memory)?;
                self.scans.retain(|s| s.node != node);
                if self.scans.len() >= MAX_SCANS {
                    return Err(DocError::Refused(
                        "demo limit: remove and add this root again to release its 64 pending listings".into(),
                    ));
                }
                let id = self.next_scan;
                self.next_scan = self.next_scan.checked_add(1).ok_or_else(|| {
                    DocError::Refused("folder listing identities exhausted; remove and add the root".into())
                })?;
                self.scans.push(Scan {
                    node,
                    id,
                    hidden,
                    file,
                    buffer: vec![0u64; 8192],
                    offset: None,
                    restart: true,
                    _charge: charge,
                });
                self.scans.len() - 1
            };
            let result = self.page(index, cancelled);
            if result.as_ref().map_or(true, |p| p.cursor.is_none()) {
                self.scans.remove(index);
            }
            result
        }

        fn page(&mut self, index: usize, cancelled: &dyn Fn() -> bool) -> Result<Page, DocError> {
            let mut entries = Vec::with_capacity(PAGE_ITEMS);
            let mut bytes = 0;
            // Hidden/blocked records also consume this bounded scan quantum. Empty pages can have a cursor.
            for _ in 0..512 {
                if cancelled() {
                    return Err(DocError::Cancelled);
                }
                if entries.len() == PAGE_ITEMS || bytes >= 64 * 1024 - 1024 {
                    break;
                }
                let scan = &mut self.scans[index];
                let Some(raw) = scan.next().map_err(error)? else {
                    return Ok(Page { entries, cursor: None });
                };
                if raw.name == "." || raw.name == ".." {
                    continue;
                }
                if component(&raw.name).is_err() || bounded(&raw.name).is_err() {
                    continue;
                }
                let hidden = raw.name.starts_with('.') || raw.attrs & FILE_ATTRIBUTE_HIDDEN != 0;
                if hidden && !scan.hidden {
                    continue;
                }
                let directory = raw.attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
                let blocked = raw.attrs
                    & (FILE_ATTRIBUTE_REPARSE_POINT
                        | FILE_ATTRIBUTE_OFFLINE
                        | FILE_ATTRIBUTE_RECALL_ON_OPEN
                        | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
                    != 0
                    || raw.tag != 0;
                let supported = !blocked && (directory || supported(&raw.name));
                let parent = &self.nodes[scan.node as usize].path;
                if parent.len() + 1 + raw.name.len() > MAX_BYTES {
                    return Err(DocError::Refused("folder entry path is too long".into()));
                }
                let charge =
                    Reservation::new((2 * (parent.len() + 1 + raw.name.len()) + 6 * raw.name.len() + 1024) as u64)
                        .map_err(DocError::Memory)?;
                let path = format!("{}\\{}", parent.trim_end_matches('\\'), raw.name);
                let found = self.nodes.iter().position(|n| {
                    n.path == path && n.identity == raw.identity && n.directory == directory && n.supported == supported
                });
                let id = if let Some(id) = found {
                    id
                } else {
                    if self.nodes.len() >= MAX_NODES {
                        return Err(DocError::Refused("demo limit: this root has 4096 loaded entries; remove and add it to browse a different set".into()));
                    }
                    self.nodes.push(Node { path, identity: raw.identity, directory, supported, _charge: charge });
                    self.nodes.len() - 1
                };
                bytes += raw.name.len();
                entries.push(Entry {
                    id: id as u32,
                    name: raw.name,
                    kind: if !supported {
                        "unsupported"
                    } else if directory {
                        "directory"
                    } else {
                        "file"
                    },
                    hidden,
                });
            }
            Ok(Page { entries, cursor: Some(self.scans[index].id) })
        }
    }

    struct Record {
        name: String,
        identity: [u8; 16],
        attrs: u32,
        tag: u32,
    }
    impl Scan {
        fn next(&mut self) -> Result<Option<Record>, LocalError> {
            if self.offset.is_none() {
                let class = if self.restart { FileIdExtdDirectoryRestartInfo } else { FileIdExtdDirectoryInfo };
                let ok = unsafe {
                    GetFileInformationByHandleEx(
                        self.file.as_raw_handle() as _,
                        class,
                        self.buffer.as_mut_ptr().cast(),
                        (self.buffer.len() * 8) as u32,
                    )
                };
                if ok == 0 {
                    let e = std::io::Error::last_os_error();
                    if e.raw_os_error() == Some(18) {
                        return Ok(None);
                    }
                    return Err(e.into());
                }
                self.restart = false;
                self.offset = Some(0);
            }
            let offset = self.offset.unwrap();
            let size = self.buffer.len() * 8;
            let header = std::mem::offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
            if offset + std::mem::size_of::<FILE_ID_EXTD_DIR_INFO>() > size {
                return Err(LocalError::Refused("invalid native directory record"));
            }
            let ptr = unsafe { self.buffer.as_ptr().cast::<u8>().add(offset).cast::<FILE_ID_EXTD_DIR_INFO>() };
            let info = unsafe { std::ptr::read_unaligned(ptr) };
            let len = info.FileNameLength as usize;
            if !len.is_multiple_of(2) || len > 510 || offset + header + len > size {
                return Err(LocalError::Refused("unsupported native directory name"));
            }
            let units = unsafe {
                std::slice::from_raw_parts(
                    self.buffer.as_ptr().cast::<u8>().add(offset + header).cast::<u16>(),
                    len / 2,
                )
            };
            let name = String::from_utf16(units).map_err(|_| LocalError::Refused("directory name is not Unicode"))?;
            self.offset = if info.NextEntryOffset == 0 {
                None
            } else {
                let next = info.NextEntryOffset as usize;
                if next < header + len || !next.is_multiple_of(8) || offset + next >= size {
                    return Err(LocalError::Refused("invalid native directory continuation"));
                }
                Some(offset + next)
            };
            Ok(Some(Record {
                name,
                identity: info.FileId.Identifier,
                attrs: info.FileAttributes,
                tag: info.ReparsePointTag,
            }))
        }
    }
}
