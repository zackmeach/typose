//! Offsets beyond 4 GiB (spec §3.2, §13.1 Spike C): a sparse file over 5 GiB with text lines just below 2^32,
//! across it and above it, zeros elsewhere. Every layer must hand back the exact u64 offsets.
//! A gate that can't run must not read as passed: where it can't make a sparse file it fails, unless
//! `TYPOSE_ALLOW_NO_SPARSE=1` says to skip. Off Windows, where the spike has no sparse-file builder, it's ignored.

/// Each segment's text is wrapped in newlines, so it's a line of its own starting one byte after `at`.
const SEGMENTS: [(u64, &str); 4] = [
    ((1 << 32) - 4096, "\nbelow 4 GiB\n"),
    ((1 << 32) - 8, "\nstraddles 2^32\n"),
    ((1 << 32) + (1 << 20) + 2, "\nabove 4 GiB: é 😀\n"),
    (5 << 30, "\nlast line\n"),
];
const LEN: u64 = (5 << 30) + (4 << 20) + 5; // 5.004 GiB apparent

#[cfg(not(windows))]
#[test]
#[ignore = "the sparse fixture is built with FSCTL_SET_SPARSE, Windows only in the spike"]
fn offsets_beyond_4_gib_are_exact_in_every_layer() {}

#[cfg(windows)]
#[test]
fn offsets_beyond_4_gib_are_exact_in_every_layer() {
    use std::fs::File;
    use std::os::windows::fs::FileExt;
    use std::path::PathBuf;
    use std::sync::RwLock;
    use std::time::Instant;

    use crate::doc::Document;
    use crate::encoding::decode;
    use crate::index::{IndexConfig, LineIndex, build, locate_line};
    use crate::pages;
    use crate::store::ByteStore;

    /// Deletes the fixture on the way out, assertion failures included.
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.fixtures/beyond-4gib.bin"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let _cleanup = Cleanup(path.clone());
    let file = File::create(&path).unwrap();
    if let Err(why) = make_sparse(&file) {
        let allowed = std::env::var("TYPOSE_ALLOW_NO_SPARSE").is_ok_and(|v| v == "1");
        assert!(allowed, "can't make a sparse file ({why}); set TYPOSE_ALLOW_NO_SPARSE=1 to skip this gate");
        println!("skipped (TYPOSE_ALLOW_NO_SPARSE=1): {why}");
        return;
    }
    file.set_len(LEN).unwrap();
    for (at, text) in SEGMENTS {
        assert_eq!(file.seek_write(text.as_bytes(), at).unwrap(), text.len());
    }
    file.sync_all().unwrap(); // NTFS allocates cached writes on flush; before it, the size on disk reads 0
    drop(file);
    let on_disk = allocated(&path);
    println!("fixture: {LEN} bytes apparent, {on_disk} bytes allocated");
    assert!(on_disk > 0 && on_disk < 64 << 20, "not sparse: {on_disk} bytes allocated");

    // Lines: zeros, text, zeros, text, ... and a tail of zeros.
    let mut want: Vec<u64> = vec![0];
    for (at, text) in SEGMENTS {
        want.extend([at + 1, at + text.len() as u64]);
    }
    let text_line = |i: usize| (2 * i as u64 + 1, SEGMENTS[i].0 + 1, SEGMENTS[i].1.trim_matches('\n'));

    // Byte store: positional reads at, across and past 2^32.
    let store = ByteStore::open(&path).unwrap();
    assert_eq!(store.len(), LEN);
    for i in 0..4 {
        let (_, at, text) = text_line(i);
        assert_eq!(store.read(at, at + text.len() as u64).unwrap(), text.as_bytes());
    }

    // Line index over the whole file: one giant line of zeros per gap, so only byte-bounded checkpoints help.
    let shared = RwLock::new(LineIndex::default());
    let t = Instant::now();
    build(&File::open(&path).unwrap(), LEN, IndexConfig::default(), &store.hashes(), &shared, |_| true).unwrap();
    let ms = t.elapsed().as_millis().max(1);
    let idx = shared.into_inner().unwrap();
    println!(
        "index: {LEN} bytes in {ms} ms ({:.2} GB/s), {} checkpoints",
        LEN as f64 / 1e6 / ms as f64,
        idx.checkpoints.len()
    );
    assert_eq!(idx.line_count(), want.len() as u64);
    assert!(idx.checkpoints.windows(2).all(|p| p[1].offset - p[0].offset <= 1 << 20));
    let starts: Vec<u64> = (0..idx.line_count()).map(|l| locate_line(&store, &idx, l).unwrap().unwrap()).collect();
    assert_eq!(starts, want);

    // Pages: the text lines carry exact offsets and maps. Each zero run is a 64 KiB piece, so the
    // 256 KiB page cap splits the file across pages: read on from wherever the last page stopped.
    let mut page = Vec::new();
    while (page.len() as u64) < idx.line_count() {
        let more = pages::lines(&store, &idx, page.len() as u64, 16).unwrap();
        assert!(!more.is_empty(), "no progress at line {}", page.len());
        page.extend(more);
    }
    assert_eq!(page.iter().map(|p| p.offset).collect::<Vec<_>>(), want);
    for i in 0..4 {
        let (line, at, text) = text_line(i);
        let piece = &page[line as usize];
        assert_eq!((piece.offset, piece.text.as_str()), (at, text));
        assert_eq!(piece.map, decode(text.as_bytes(), encoding_rs::UTF_8, at).map);
        assert_eq!((piece.map.start_byte(0), piece.map.end_byte(piece.map.units())), (at, at + text.len() as u64));
    }
    assert_eq!(page[3].map.start_byte(7), 1 << 32); // "straddles 2^32": unit 7 is byte 2^32
    let above = &page[5].map; // "above 4 GiB: é 😀": unit 16 is inside 😀
    assert_eq!((above.start_byte(16), above.end_byte(16)), (SEGMENTS[2].0 + 17, SEGMENTS[2].0 + 21));

    // Document: the verified read path copy uses.
    let doc = Document::open(&path).unwrap();
    for i in 0..4 {
        let (_, at, text) = text_line(i);
        assert_eq!(doc.read(1, at, at + text.len() as u64).unwrap(), text.as_bytes());
    }
}

/// Marks a new, empty file sparse, so `set_len` and far writes allocate almost nothing. Needs no elevation.
#[cfg(windows)]
fn make_sparse(file: &std::fs::File) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_SPARSE_FILE;
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;

    let mut returned = 0u32;
    let null = std::ptr::null_mut();
    let ok = unsafe {
        DeviceIoControl(file.as_raw_handle() as _, FSCTL_SET_SPARSE, null, 0, null, 0, &mut returned, null as _)
    };
    if ok == 0 {
        return Err(format!("FSCTL_SET_SPARSE failed: {}", std::io::Error::last_os_error()));
    }
    let attributes = file.metadata().map_err(|e| e.to_string())?.file_attributes();
    if attributes & FILE_ATTRIBUTE_SPARSE_FILE == 0 {
        return Err("the volume doesn't keep the sparse attribute".into());
    }
    Ok(())
}

/// Bytes actually allocated on disk (Explorer's "Size on disk").
#[cfg(windows)]
fn allocated(path: &std::path::Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetCompressedFileSizeW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut high = 0u32;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    (u64::from(high) << 32) | u64::from(low)
}
