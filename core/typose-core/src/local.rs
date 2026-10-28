//! Local-link capabilities. Capture is part of an explicit manual open; markup only uses the held root.
//! Every later open walks one component at a time without following reparses. The display path is never opened.
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::budget::{OverBudget, Reservation};

const MAX_UNITS: usize = 32_767;
const MAX_BYTES: usize = 3 * MAX_UNITS;
const ROUTE_FIXED: u64 = 256;
// Absolute-path work, two normalized strings, a result path, and one UTF-16 component at a time.
const WORK_BYTES: u64 = (8 * MAX_BYTES + 64 * 1024) as u64;

#[derive(Debug)]
pub enum LocalError {
    Refused(&'static str),
    Io(io::Error),
    Memory(OverBudget),
}

impl std::fmt::Display for LocalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) => f.write_str(why),
            Self::Io(e) => e.fmt(f),
            Self::Memory(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for LocalError {}

impl From<io::Error> for LocalError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<OverBudget> for LocalError {
    fn from(e: OverBudget) -> Self {
        Self::Memory(e)
    }
}

#[derive(Debug)]
struct Root {
    #[cfg(windows)]
    file: File,
    drive: u8,
}

#[cfg(all(windows, feature = "test-hooks"))]
impl Drop for Root {
    fn drop(&mut self) {
        crate::hooks::HANDLES.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// A logical drive root captured during manual open, and a normalized route under that immutable handle.
/// Each route pays for its path and conservatively for the small shared root allocation too.
#[derive(Debug)]
pub struct LocalRoute {
    root: Arc<Root>,
    path: PathBuf,
    // Last, so path/root memory is released before its charge.
    charge: Reservation,
}

impl LocalRoute {
    /// Call only during explicit manual open. Failure disables local links, not the manual document.
    pub fn capture(path: &Path, source: &File) -> Result<Self, LocalError> {
        #[cfg(windows)]
        {
            let _work = Reservation::new(WORK_BYTES)?;
            let text = path.to_str().ok_or(LocalError::Refused("local path is not Unicode"))?;
            bounded(text)?;
            reject_namespace(text)?;
            if text.as_bytes().get(1) == Some(&b':') && !matches!(text.as_bytes().get(2), Some(b'/' | b'\\')) {
                return Err(LocalError::Refused("drive-relative paths are not supported"));
            }
            let absolute = std::path::absolute(path)?;
            let text = absolute.to_str().ok_or(LocalError::Refused("local path is not Unicode"))?;
            let drive = absolute_drive(text)?;
            let normalized = normalize(&format!("{}:\\source", drive as char), drive, text)?;
            let charge = Reservation::new(ROUTE_FIXED + MAX_BYTES as u64)?;
            // The original handle can differ from today's path after a manual-open race. Prove it too, before
            // caching a capability whose later identity checks will query that original handle.
            native::prove_source(source)?;
            // This by-path root open is permitted only here, in the explicit manual-open phase. A remote or
            // unproved root is discarded; no future markup operation retries it or opens a DOS path.
            let file = native::root(drive)?;
            let opened = native::walk(&file, &normalized)?;
            if native::identity(&opened)? != native::identity(source)? {
                return Err(LocalError::Refused("the source route changed while opening"));
            }
            #[cfg(feature = "test-hooks")]
            crate::hooks::HANDLES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(Self::make(Arc::new(Root { file, drive }), normalized, charge))
        }
        #[cfg(not(windows))]
        {
            let _ = (path, source);
            Err(LocalError::Refused("local file links are not supported on this platform"))
        }
    }

    /// Decoded local paths only: URI/scheme/percent classification belongs to the caller. No filesystem access.
    pub fn resolve(&self, target: &str) -> Result<Self, LocalError> {
        let _work = Reservation::new(WORK_BYTES)?;
        let path = normalize(self.path.to_str().expect("captured Unicode path"), self.root.drive, target)?;
        let charge = Reservation::new(ROUTE_FIXED + MAX_BYTES as u64)?;
        Ok(Self::make(Arc::clone(&self.root), path, charge))
    }

    pub fn try_clone(&self) -> Result<Self, LocalError> {
        let mut charge = Reservation::new(self.charge.bytes())?;
        let path = self.path.clone();
        charge.shrink(charge.bytes().saturating_sub(ROUTE_FIXED + path.capacity() as u64));
        Ok(Self { root: Arc::clone(&self.root), path, charge })
    }

    /// Rewalk the original route for every initial open, identity check and Reload. Never use `path()` for I/O.
    pub fn open(&self) -> Result<File, LocalError> {
        #[cfg(windows)]
        {
            native::walk(&self.root.file, self.path.to_str().expect("captured Unicode path"))
        }
        #[cfg(not(windows))]
        {
            Err(LocalError::Refused("local file links are not supported on this platform"))
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Compare proved-local handles without truncating ReFS's 128-bit identity to the manual FileId contract.
    pub fn same_file(&self, a: &File, b: &File) -> Result<bool, LocalError> {
        #[cfg(windows)]
        {
            Ok(native::identity(a)? == native::identity(b)?)
        }
        #[cfg(not(windows))]
        {
            let _ = (a, b);
            Err(LocalError::Refused("local file links are not supported on this platform"))
        }
    }

    pub fn charged(&self) -> u64 {
        self.charge.bytes()
    }

    fn make(root: Arc<Root>, text: String, mut charge: Reservation) -> Self {
        let path = PathBuf::from(text);
        charge.shrink(charge.bytes().saturating_sub(ROUTE_FIXED + path.capacity() as u64));
        Self { root, path, charge }
    }
}

fn bounded(text: &str) -> Result<(), LocalError> {
    if text.is_empty() || text.len() > MAX_BYTES || text.encode_utf16().count() > MAX_UNITS {
        return Err(LocalError::Refused("local path is empty or too long"));
    }
    if text.chars().any(|c| c <= '\u{1f}' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
        return Err(LocalError::Refused("local path contains an invalid character"));
    }
    Ok(())
}

fn reject_namespace(text: &str) -> Result<(), LocalError> {
    let mut chars = text.chars();
    let slash = |c| matches!(c, '/' | '\\');
    if chars.next().is_some_and(slash) && chars.next().is_some_and(slash) {
        return Err(LocalError::Refused("network and device paths are not supported"));
    }
    // The question marks are invalid characters too; keep the namespace refusal independent of that rule.
    if text.starts_with(r"\??\") || text.starts_with("/??/") {
        return Err(LocalError::Refused("device paths are not supported"));
    }
    Ok(())
}

fn absolute_drive(text: &str) -> Result<u8, LocalError> {
    bounded(text)?;
    reject_namespace(text)?;
    let bytes = text.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\') {
        Ok(bytes[0].to_ascii_uppercase())
    } else {
        Err(LocalError::Refused("an absolute local drive path is required"))
    }
}

fn component(name: &str) -> Result<(), LocalError> {
    if name.is_empty() || name.ends_with(['.', ' ']) || name.contains(':') || name.encode_utf16().count() > 255 {
        return Err(LocalError::Refused("ambiguous or unsupported local path component"));
    }
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ');
    let number =
        stem.get(..3).filter(|p| p.eq_ignore_ascii_case("COM") || p.eq_ignore_ascii_case("LPT")).map(|_| &stem[3..]);
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].iter().any(|n| stem.eq_ignore_ascii_case(n))
        || number
            .is_some_and(|n| matches!(n, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
    {
        return Err(LocalError::Refused("device names are not supported"));
    }
    Ok(())
}

/// Win32-style lexical dot normalization under the captured logical root (including a SUBST root).
fn normalize(base: &str, drive: u8, target: &str) -> Result<String, LocalError> {
    bounded(target)?;
    reject_namespace(target)?;
    let target = target.replace('/', "\\");
    let bytes = target.as_bytes();
    let (rooted, rest) = if bytes.get(1) == Some(&b':') {
        if !bytes[0].is_ascii_alphabetic() || bytes.get(2) != Some(&b'\\') {
            return Err(LocalError::Refused("drive-relative paths are not supported"));
        }
        if bytes[0].to_ascii_uppercase() != drive {
            return Err(LocalError::Refused("other drives are not supported"));
        }
        (true, &target[3..])
    } else if let Some(rest) = target.strip_prefix('\\') {
        (true, rest)
    } else {
        (false, target.as_str())
    };
    let mut out = String::with_capacity(MAX_BYTES);
    out.push(drive as char);
    out.push_str(":\\");
    if !rooted {
        let parent = base.rfind('\\').ok_or(LocalError::Refused("invalid captured source path"))?;
        if parent > 2 {
            out.push_str(&base[3..parent]);
        }
    }
    for name in rest.split('\\') {
        match name {
            "" | "." => continue,
            ".." => {
                if out.len() <= 3 {
                    return Err(LocalError::Refused("local path escapes the drive root"));
                }
                let last = out.rfind('\\').expect("drive root");
                out.truncate(last.max(3));
            }
            _ => {
                component(name)?;
                let separator = usize::from(out.len() > 3);
                if out.len() + separator + name.len() > MAX_BYTES {
                    return Err(LocalError::Refused("local path is too long"));
                }
                if separator > 0 {
                    out.push('\\');
                }
                out.push_str(name);
            }
        }
    }
    bounded(&out)?;
    if out.len() <= 3 {
        return Err(LocalError::Refused("a local file is required"));
    }
    out.shrink_to_fit();
    Ok(out)
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr::{null, null_mut};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_NO_RECALL, FILE_OPEN_REPARSE_POINT,
        FILE_SYNCHRONOUS_IO_NONALERT, FileFsDeviceInformation, NtCreateFile, NtQueryVolumeInformationFile,
    };
    use windows_sys::Wdk::System::SystemServices::{
        FILE_CHARACTERISTIC_WEBDAV_DEVICE, FILE_FS_DEVICE_INFORMATION, FILE_REMOTE_DEVICE, FILE_REMOTE_DEVICE_VSMB,
    };
    use windows_sys::Win32::Foundation::{
        HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
    };
    use windows_sys::Win32::Security::{SECURITY_QUALITY_OF_SERVICE, SecurityIdentification};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_DEVICE_DISK, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_NO_RECALL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_TYPE_DISK, FileAttributeTagInfo,
        FileIdInfo, GetFileInformationByHandleEx, GetFileType, SECURITY_IDENTIFICATION, SYNCHRONIZE,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

    #[cfg(test)]
    thread_local! { pub(super) static OPENS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) }; }

    pub(super) fn root(drive: u8) -> Result<File, LocalError> {
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .share_mode(SHARE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(format!("{}:\\", drive as char))?;
        check(&file, true)?;
        prove_local(&file)?;
        Ok(file)
    }

    pub(super) fn prove_source(file: &File) -> Result<(), LocalError> {
        prove_local(file)?;
        check(file, false)
    }

    fn prove_local(file: &File) -> Result<(), LocalError> {
        // Query each actual held handle, never a drive-name prefix. Only the explicit manual-open phase calls this.
        // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryvolumeinformationfile
        let mut info: FILE_FS_DEVICE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut iosb = IO_STATUS_BLOCK::default();
        let size = size_of::<FILE_FS_DEVICE_INFORMATION>();
        let status = unsafe {
            NtQueryVolumeInformationFile(
                file.as_raw_handle() as _,
                &mut iosb,
                (&mut info as *mut FILE_FS_DEVICE_INFORMATION).cast(),
                size as u32,
                FileFsDeviceInformation,
            )
        };
        status_ok(status)?;
        status_ok(unsafe { iosb.Anonymous.Status })?;
        if iosb.Information < size
            || info.DeviceType != FILE_DEVICE_DISK
            || info.Characteristics & (FILE_REMOTE_DEVICE | FILE_REMOTE_DEVICE_VSMB | FILE_CHARACTERISTIC_WEBDAV_DEVICE)
                != 0
        {
            return Err(LocalError::Refused("the source drive is not a proved local disk"));
        }
        Ok(())
    }

    pub(super) fn walk(root: &File, path: &str) -> Result<File, LocalError> {
        let mut names = path[3..].split('\\').peekable();
        let mut parent: Option<File> = None;
        while let Some(name) = names.next() {
            let directory = names.peek().is_some();
            let next = child(parent.as_ref().unwrap_or(root), name, directory)?;
            if !directory {
                return Ok(next);
            }
            parent = Some(next);
        }
        Err(LocalError::Refused("a local file is required"))
    }

    fn child(parent: &File, name: &str, directory: bool) -> Result<File, LocalError> {
        component(name)?;
        #[cfg(test)]
        OPENS.with(|opens| opens.borrow_mut().push(name.to_owned()));
        let mut wide = [0u16; 255];
        let mut units = 0;
        for unit in name.encode_utf16() {
            wide[units] = unit;
            units += 1;
        }
        let text =
            UNICODE_STRING { Length: (units * 2) as u16, MaximumLength: (units * 2) as u16, Buffer: wide.as_mut_ptr() };
        let qos = SECURITY_QUALITY_OF_SERVICE {
            Length: size_of::<SECURITY_QUALITY_OF_SERVICE>() as u32,
            ImpersonationLevel: SecurityIdentification,
            ContextTrackingMode: 0,
            EffectiveOnly: true,
        };
        let attrs = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent.as_raw_handle() as _,
            ObjectName: &text,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: &qos,
        };
        let mut iosb = IO_STATUS_BLOCK::default();
        let mut handle: HANDLE = null_mut();
        let access = if directory { FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE } else { FILE_GENERIC_READ };
        let kind = if directory { FILE_DIRECTORY_FILE } else { FILE_NON_DIRECTORY_FILE };
        // Qualified Windows rejects NO_RECALL with DIRECTORY_FILE. OPEN_REPARSE_POINT and the tag check still
        // prevent following a directory reparse; regular files retain NO_RECALL as well.
        let no_recall = if directory { 0 } else { FILE_OPEN_NO_RECALL };
        // One relative component makes OPEN_REPARSE_POINT cover the only component the kernel can traverse.
        // Inspect its returned handle explicitly; do not depend on the interaction with OBJ_DONT_REPARSE.
        // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &attrs,
                &mut iosb,
                null(),
                0,
                SHARE,
                FILE_OPEN,
                kind | FILE_OPEN_REPARSE_POINT | no_recall | FILE_SYNCHRONOUS_IO_NONALERT,
                null(),
                0,
            )
        };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            status_ok(status)?;
            return Err(LocalError::Refused("native local open returned no handle"));
        }
        let file = unsafe { File::from_raw_handle(handle.cast()) };
        status_ok(status)?;
        status_ok(unsafe { iosb.Anonymous.Status })?;
        check(&file, directory)?;
        Ok(file)
    }

    fn status_ok(status: i32) -> Result<(), LocalError> {
        if status == 0 {
            return Ok(());
        }
        if status < 0 {
            return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32).into());
        }
        Err(LocalError::Refused("native local operation did not complete synchronously"))
    }

    fn check(file: &File, directory: bool) -> Result<(), LocalError> {
        if unsafe { GetFileType(file.as_raw_handle() as _) } != FILE_TYPE_DISK {
            return Err(LocalError::Refused("not a disk file"));
        }
        let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileAttributeTagInfo,
                (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let refused = FILE_ATTRIBUTE_REPARSE_POINT
            | FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
        if tag.FileAttributes & refused != 0 || tag.ReparseTag != 0 {
            return Err(LocalError::Refused("reparse and cloud-backed paths are not supported"));
        }
        let meta = file.metadata()?;
        if if directory { !meta.is_dir() } else { !meta.is_file() } {
            return Err(LocalError::Refused("not a regular local file or directory"));
        }
        Ok(())
    }

    pub(super) fn identity(file: &File) -> Result<(u64, [u8; 16]), LocalError> {
        let mut info = FILE_ID_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok((info.VolumeSerialNumber, info.FileId.Identifier))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_rooted_and_same_drive_paths_normalize_lexically() {
        let base = r"C:\project\docs\source.md";
        for (target, expected) in [
            ("./next.md", r"C:\project\docs\next.md"),
            ("../other.md", r"C:\project\other.md"),
            (r"nested\..\next.md", r"C:\project\docs\next.md"),
            ("/root.md", r"C:\root.md"),
            ("c:/else/next.md", r"C:\else\next.md"),
            ("folder/a b.md", r"C:\project\docs\folder\a b.md"),
        ] {
            assert_eq!(normalize(base, b'C', target).unwrap(), expected, "{target}");
        }
    }

    #[test]
    fn network_device_other_drive_and_ambiguous_paths_are_refused() {
        for target in [
            r"\\host\share\x.md",
            "//host/share/x.md",
            r"\/host\share\x.md",
            r"\\?\C:\x.md",
            r"\\.\pipe\x",
            r"\??\C:\x",
            "file:///C:/x.md",
            "smb:host/x",
            "D:/x.md",
            "C:x.md",
            "next.md:stream",
            "dir./x.md",
            "dir /x.md",
            "NUL.md",
            "COM1.txt",
            "con .md",
            "a\0b",
            "../../../../x.md",
            "",
            "a?b.md",
            "a*b.md",
        ] {
            assert!(normalize(r"C:\project\source.md", b'C', target).is_err(), "accepted {target:?}");
        }
    }

    #[test]
    fn path_and_component_work_is_bounded() {
        assert!(normalize(r"C:\source.md", b'C', &"x".repeat(256)).is_err());
        assert!(normalize(r"C:\source.md", b'C', &"a/".repeat(MAX_UNITS)).is_err());
        assert!(normalize(r"C:\source.md", b'C', &"語".repeat(MAX_UNITS + 1)).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_does_not_claim_local_file_support() {
        let file = File::open(file!()).unwrap();
        assert!(matches!(LocalRoute::capture(Path::new(file!()), &file), Err(LocalError::Refused(_))));
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};

        struct Scratch(PathBuf);

        impl Scratch {
            fn new() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let path = std::env::temp_dir().join(format!(
                    "typose-local-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&path).unwrap();
                Self(path)
            }

            fn source(&self) -> (PathBuf, File, LocalRoute) {
                let path = self.0.join("source.md");
                fs::write(&path, "source").unwrap();
                let file = File::open(&path).unwrap();
                let route = LocalRoute::capture(&path, &file).unwrap();
                (path, file, route)
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }

        fn read(file: File) -> String {
            use std::io::Read;
            let mut file = file;
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            text
        }

        /// Sets an owned local reparse point by handle. No target path is opened by this helper.
        fn set_reparse(path: &Path, directory: bool, data: &[u8]) {
            use std::os::windows::fs::OpenOptionsExt;
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
            use windows_sys::Win32::System::IO::DeviceIoControl;
            use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
            let flags = FILE_FLAG_OPEN_REPARSE_POINT | if directory { FILE_FLAG_BACKUP_SEMANTICS } else { 0 };
            let file = fs::OpenOptions::new().write(true).custom_flags(flags).open(path).unwrap();
            let mut returned = 0;
            let ok = unsafe {
                DeviceIoControl(
                    file.as_raw_handle() as _,
                    FSCTL_SET_REPARSE_POINT,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            assert_ne!(ok, 0, "{}", io::Error::last_os_error());
        }

        fn junction(path: &Path, target: &Path) {
            fs::create_dir(path).unwrap();
            let target = format!(r"\??\{}", target.display());
            let subst: Vec<u16> = target.encode_utf16().collect();
            let names: Vec<u16> = subst.iter().copied().chain([0, 0]).collect();
            let mut data = Vec::new();
            data.extend(0xA000_0003u32.to_le_bytes());
            data.extend(((8 + 2 * names.len()) as u16).to_le_bytes());
            data.extend(0u16.to_le_bytes());
            data.extend(0u16.to_le_bytes());
            data.extend(((2 * subst.len()) as u16).to_le_bytes());
            data.extend(((2 * subst.len() + 2) as u16).to_le_bytes());
            data.extend(0u16.to_le_bytes());
            data.extend(names.iter().flat_map(|u| u.to_le_bytes()));
            set_reparse(path, true, &data);
        }

        fn trace() -> Vec<String> {
            native::OPENS.with(|opens| std::mem::take(&mut *opens.borrow_mut()))
        }

        #[test]
        fn capture_compares_the_walk_to_the_actual_source_handle() {
            let scratch = Scratch::new();
            let (path, file, route) = scratch.source();
            assert_eq!(read(route.open().unwrap()), "source");
            let other = scratch.0.join("other.md");
            fs::write(&other, "other").unwrap();
            assert!(matches!(LocalRoute::capture(&other, &file), Err(LocalError::Refused(_))));
            assert_eq!(route.path(), path);
            assert!(route.charged() >= ROUTE_FIXED + route.path.capacity() as u64);
        }

        #[test]
        fn derived_routes_share_the_root_and_keep_files_deletable() {
            let scratch = Scratch::new();
            let (_, source, route) = scratch.source();
            let next = scratch.0.join("next.txt");
            fs::write(&next, "next").unwrap();
            let derived = route.resolve("./next.txt").unwrap();
            let clone = derived.try_clone().unwrap();
            let root = Arc::downgrade(&route.root);
            assert!(Arc::ptr_eq(&route.root, &derived.root));
            assert_eq!(derived.charged(), clone.charged());
            let opened = derived.open().unwrap();
            fs::remove_file(&next).expect("a local capability must preserve delete sharing");
            assert_eq!(read(opened), "next");
            drop(route);
            drop(derived);
            assert!(root.upgrade().is_some());
            drop(clone);
            assert!(root.upgrade().is_none(), "the final route must close the root");
            drop(source);
        }

        #[test]
        fn replacing_a_captured_source_ancestor_with_a_junction_stops_before_the_leaf() {
            let scratch = Scratch::new();
            let dir = scratch.0.join("docs");
            fs::create_dir(&dir).unwrap();
            let path = dir.join("source.md");
            fs::write(&path, "source").unwrap();
            fs::write(dir.join("next.txt"), "original").unwrap();
            let source = File::open(&path).unwrap();
            let route = LocalRoute::capture(&path, &source).unwrap().resolve("next.txt").unwrap();
            let outside = scratch.0.join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("next.txt"), "must not read").unwrap();
            // Rust's Windows rename refuses an ancestor with an open child even with delete sharing. Move that
            // child out first, move its directory, then put the same open file back before installing the junction.
            let held = scratch.0.join("held-source.md");
            fs::rename(&path, &held).unwrap();
            let moved = scratch.0.join("old-docs");
            fs::rename(&dir, &moved).unwrap();
            fs::rename(&held, moved.join("source.md")).unwrap();
            junction(&dir, &outside);
            trace();
            assert!(route.open().is_err());
            let opens = trace();
            assert_eq!(opens.last().map(String::as_str), Some("docs"));
            assert!(!opens.iter().any(|name| name == "next.txt"));
            fs::remove_dir(&dir).unwrap();
        }

        #[test]
        fn final_file_reparse_is_refused_without_following_it() {
            let scratch = Scratch::new();
            let (_, _source, route) = scratch.source();
            let target = scratch.0.join("opaque.txt");
            fs::write(&target, "opaque").unwrap();
            // A private non-Microsoft GUID reparse tag needs no symlink privilege and names no target.
            let mut data = Vec::new();
            data.extend(0x0000_00A5u32.to_le_bytes());
            data.extend(0u16.to_le_bytes());
            data.extend(0u16.to_le_bytes());
            data.extend([0x17u8; 16]);
            set_reparse(&target, false, &data);
            trace();
            assert!(matches!(route.resolve("opaque.txt").unwrap().open(), Err(LocalError::Refused(_))));
            assert_eq!(trace().last().map(String::as_str), Some("opaque.txt"));
        }

        #[test]
        fn invalid_syntax_performs_no_native_walk_and_missing_or_directory_targets_fail() {
            let scratch = Scratch::new();
            let (_, _source, route) = scratch.source();
            trace();
            for target in [r"\\host\share\a", r"\\.\pipe\a", "Z:/other.txt", "a.txt:stream", "C:relative.txt"] {
                // Choose an actually different drive for this test even when %TEMP% is on Z:.
                let target = if target == "Z:/other.txt" && route.root.drive == b'Z' { "Y:/other.txt" } else { target };
                assert!(route.resolve(target).is_err(), "{target}");
            }
            assert!(trace().is_empty());
            assert!(matches!(route.resolve("missing.txt").unwrap().open(), Err(LocalError::Io(_))));
            fs::create_dir(scratch.0.join("directory")).unwrap();
            assert!(route.resolve("directory").unwrap().open().is_err());
        }
    }
}
