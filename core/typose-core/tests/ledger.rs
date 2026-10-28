//! Plan C1's acceptance: live ≤ reserved, at every allocation. A counting global allocator checks, on each allocation on
//! any thread, that the heap's live bytes above the post-init baseline are ≤ what the ledger has charged at that moment,
//! less the pool's free slots (`budget::in_use`). That's a contemporaneous comparison, not a peak against a high-water
//! mark, which could hide an uncharged allocation behind an earlier reservation. A `realloc` counts its new block before
//! it frees the old one, as a moving realloc holds both.
//!
//! It's a binary of its own (`harness = false`): every allocation in the process is counted, so it allocates nothing of
//! its own while the check is armed. Its fixtures and threads are made first, and its page reads do what napi's do: take
//! a page slot, read, then make the wire maps beside the pieces.
//!
//! Negative control (plan C1): with the checkpoint table's charge dropped, it fails.
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use typose_core::budget::{self, Work};
use typose_core::doc::{DocError, STRUCT_BYTES};
use typose_core::md::MAX_SOURCE;
use typose_core::pages::MAX_ITEMS;
use typose_core::raw::Raw;
use typose_core::store::CHUNK;

struct Counting;

static LIVE: AtomicU64 = AtomicU64::new(0);
static BASELINE: AtomicU64 = AtomicU64::new(0);
static ARMED: AtomicBool = AtomicBool::new(false);
static CHECKS: AtomicU64 = AtomicU64::new(0);
/// Checks given up on because the ledger kept moving while they read it.
static SKIPPED: AtomicU64 = AtomicU64::new(0);
static OVER: AtomicU64 = AtomicU64::new(0);
/// The worst check: live bytes past the baseline, what was reserved then, and the allocation's size.
static WORST: [AtomicU64; 3] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
/// The least room seen (reserved − live), and the step it was seen in.
static MARGIN: AtomicU64 = AtomicU64::new(u64::MAX);
static MARGIN_AT: AtomicUsize = AtomicUsize::new(0);
/// Where the test is: a shape's index × 4 + its step (open, fill, index, pages).
static STEP: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: Counting = Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            LIVE.fetch_add(layout.size() as u64, SeqCst);
            check(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size() as u64, SeqCst);
    }

    unsafe fn realloc(&self, p: *mut u8, layout: Layout, new: usize) -> *mut u8 {
        LIVE.fetch_add(new as u64, SeqCst);
        check(new);
        let q = unsafe { System.realloc(p, layout, new) };
        LIVE.fetch_sub(if q.is_null() { new } else { layout.size() } as u64, SeqCst);
        q
    }
}

/// Live ≤ reserved, read while the ledger stood still: its version is the same before and after.
fn check(size: usize) {
    if !ARMED.load(SeqCst) {
        return;
    }
    CHECKS.fetch_add(1, SeqCst);
    for _ in 0..1000 {
        let (reserved, version) = budget::in_use();
        let live = LIVE.load(SeqCst).saturating_sub(BASELINE.load(SeqCst));
        if budget::version() != version {
            continue;
        }
        if live > reserved {
            if OVER.fetch_add(1, SeqCst) == 0 || live - reserved > WORST[0].load(SeqCst) - WORST[1].load(SeqCst) {
                for (slot, v) in WORST.iter().zip([live, reserved, size as u64]) {
                    slot.store(v, SeqCst);
                }
            }
        } else if MARGIN.fetch_min(reserved - live, SeqCst) > reserved - live {
            MARGIN_AT.store(STEP.load(SeqCst), SeqCst);
        }
        return;
    }
    SKIPPED.fetch_add(1, SeqCst);
}

const WORKERS: usize = 8;

/// The open document the workers read.
static RAW: Mutex<Option<Arc<Raw>>> = Mutex::new(None);
/// The workers' job, as a `fn(usize)`, and how many rounds have run and finished.
static JOB: AtomicUsize = AtomicUsize::new(0);
static ROUND: AtomicUsize = AtomicUsize::new(0);
static DONE: AtomicUsize = AtomicUsize::new(0);
/// Lines a page job reads; and pages that came back `Memory` or failed otherwise (none should).
static PAGE_COUNT: AtomicUsize = AtomicUsize::new(MAX_ITEMS);
static FAILED: AtomicUsize = AtomicUsize::new(0);

/// Waits for each round, then runs its job. Spawned before the baseline, so its own allocations are already made.
fn worker(i: usize) {
    let mut seen = 0;
    loop {
        while ROUND.load(SeqCst) == seen {
            std::thread::sleep(Duration::from_millis(1));
        }
        seen = ROUND.load(SeqCst);
        let job = JOB.load(SeqCst);
        if job == 0 {
            return;
        }
        let job: fn(usize) = unsafe { std::mem::transmute(job) };
        job(i);
        DONE.fetch_add(1, SeqCst);
    }
}

/// Runs `job` on all 8 workers at once (the shapes' 8 concurrent `page()` calls) and waits for them.
fn run(job: fn(usize)) {
    DONE.store(0, SeqCst);
    JOB.store(job as usize, SeqCst);
    ROUND.fetch_add(1, SeqCst);
    while DONE.load(SeqCst) < WORKERS {
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn raw() -> Arc<Raw> {
    RAW.lock().unwrap().clone().unwrap()
}

/// napi's page read: a page slot, then the read, then the wire maps beside the pieces (`resolve`).
fn napi_page(raw: &Raw, start: u64, count: usize) -> Result<Vec<typose_core::pages::LinePiece>, DocError> {
    let _slot = budget::slot(Work::Page, &|| false).unwrap();
    let pieces = raw.page(raw.document().generation(), start, count)?;
    let wire: Vec<_> = pieces.iter().map(|p| p.map.to_wire()).collect();
    drop(wire);
    Ok(pieces)
}

/// Worker `i` reads a page from line 4·i, then follows the first long line's continuations for a few pieces.
fn page_job(i: usize) {
    let raw = raw();
    let lines = raw.lines_known().0.max(1);
    let start = (4 * i as u64) % lines;
    let Ok(pieces) = napi_page(&raw, start, PAGE_COUNT.load(SeqCst)) else {
        FAILED.fetch_add(1, SeqCst);
        return;
    };
    let token = pieces.iter().find_map(|p| p.next.map(|next| (p.line, next)));
    drop(pieces);
    let Some((line, mut next)) = token else { return };
    for _ in 0..3 {
        let _slot = budget::slot(Work::Page, &|| false).unwrap();
        match raw.piece(raw.document().generation(), line, next) {
            Ok(piece) => {
                let wire = piece.map.to_wire();
                drop(wire);
                match piece.next {
                    Some(n) => next = n,
                    None => return,
                }
            }
            Err(_) => {
                FAILED.fetch_add(1, SeqCst);
                return;
            }
        }
    }
}

/// Chunks below this are left alone by `touch_job`: it reads chunk `TOUCH_FROM + i`.
static TOUCH_FROM: AtomicUsize = AtomicUsize::new(0);

/// Reads one byte of chunk `TOUCH_FROM + i` through the verified read path, so the cache holds it.
fn touch_job(i: usize) {
    let raw = raw();
    let at = ((TOUCH_FROM.load(SeqCst) + i) as u64) << 20;
    let _slot = budget::slot(Work::Page, &|| false).unwrap();
    if at < raw.document().len() && raw.document().read(raw.document().generation(), at, at + 1).is_err() {
        FAILED.fetch_add(1, SeqCst);
    }
}

/// Deletes the fixtures on the way out, failures included.
struct Fixtures(PathBuf);

impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, parts: &[&[u8]], repeat: usize) {
    let mut f = std::io::BufWriter::new(File::create(path).unwrap());
    for _ in 0..repeat {
        for part in parts {
            f.write_all(part).unwrap();
        }
    }
    f.flush().unwrap();
}

/// A 1 GiB file of one line: 8 KiB of text, then zeros. Sparse, so the disk holds almost none of it.
fn one_gib_line(path: &Path) {
    let f = File::create(path).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::IO::DeviceIoControl;
        use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;
        let (mut returned, null) = (0u32, std::ptr::null_mut());
        let ok = unsafe {
            DeviceIoControl(f.as_raw_handle() as _, FSCTL_SET_SPARSE, null, 0, null, 0, &mut returned, null as _)
        };
        assert_ne!(ok, 0, "FSCTL_SET_SPARSE: {}", std::io::Error::last_os_error());
    }
    (&f).write_all(&[b'x'; 8192]).unwrap();
    f.set_len(1 << 30).unwrap();
}

/// The longest path each OS opens here: Windows' MAX_PATH without long-path support, macOS's PATH_MAX of 1,024 and
/// Linux's of 4,096, with room for the temp directory.
const LONG_PATH: usize = if cfg!(windows) {
    240
} else if cfg!(target_os = "macos") {
    1000
} else {
    4000
};

/// A path of `len` - 1 bytes, through nested directories, to a small text file.
fn long_path(dir: &Path, len: usize) -> PathBuf {
    let mut path = dir.join("long");
    loop {
        let room = len.saturating_sub(path.as_os_str().len() + 1 + "/f.txt".len());
        if room == 0 {
            break;
        }
        path.push("d".repeat(room.min(100)));
    }
    fs::create_dir_all(&path).unwrap();
    let file = path.join("f.txt");
    fs::write(&file, b"a line\nand another\n").unwrap();
    file
}

/// One unit of plan (Rendered Markdown slice) §1's mixed Markdown, `i` its number: every In construct, raw HTML
/// allowed and not, footnotes, repeated headings (the slug map grows), node-dense inline runs and padded table rows.
fn markdown_unit(i: usize) -> String {
    let mut s = format!(
        "# Heading\n\n## Heading {i}\n\nProse with *em*, **strong**, ~~del~~, `code`, [a link](other.md \"t\"), "
    );
    s.push_str("![an image](a.png), <https://x.y>, <kbd>K</kbd>, a footnote[^n] and &amp; an entity.\n\n");
    s.push_str(
        "- item\n  - nested\n- [ ] task\n- [x] done\n\n1. one\n2. two\n\n> a quote with **bold**\n> > nested\n\n",
    );
    s.push_str("```rust\nfn main() { println!(\"<b>\"); }\n```\n\n    indented code\n\n");
    s.push_str("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| short |\n\n");
    s.push_str(&format!("{}\n{}\n{}\n", "|h".repeat(64), "|-".repeat(64), "x\n".repeat(16)));
    s.push_str("<details><summary>S</summary>raw <script>x</script> <img src=x onerror=y></details>\n\n");
    s.push_str(&format!("{}\n\n[^n]: The note, *styled*.\n\n---\n\n", "*_".repeat(100)));
    s
}

/// Markdown of `len` bytes exactly: front matter, then units, each with a long code fence (cheap to build in a debug
/// test) and every fourth with a heavy block: a note of each kind (over 64 KiB, nested 65 deep, writing over 256 KiB),
/// raw HTML at ammonia's most a byte, and 200 KiB of HTML to sanitize. Then a paragraph makes up the length.
fn mixed_markdown(len: usize) -> String {
    let mut s = String::from("---\ntitle: ledger\n---\n");
    let heavy = [
        "word ".repeat(13_400),
        format!("{} x", ">".repeat(64)),
        format!("{}\n\n[^a]: a", "[^a]".repeat(15_000)),
        format!("<div>\n{}\n", "<b>".repeat(21_000)),
        "*a*".repeat(20_000),
    ];
    let fence = format!("```\n{}```\n\n", "a line of code, cheap to build\n".repeat(800));
    for i in 0.. {
        let mut unit = markdown_unit(i) + &fence;
        if i % 4 == 3 {
            unit += &(heavy[i / 4 % heavy.len()].clone() + "\n\n");
        }
        if s.len() + unit.len() + 2 > len {
            break;
        }
        s.push_str(&unit);
    }
    s.push_str(&"y".repeat(len - s.len()));
    s
}

/// pulldown-cmark's padded cells: 362-column tables of one-cell rows, 9,216 bytes of its tree a byte (`md.rs`).
fn padded_tables(len: usize) -> String {
    let mut s = String::new();
    while s.len() < len {
        s.push_str(&format!("{}\n{}\n{}\n", "|a".repeat(362), "|-".repeat(362), "a\n".repeat(724)));
    }
    s
}

/// Builds `path` as Markdown, checked throughout, holds the build, then drops it and the document: the ledger is back
/// to its baseline.
fn md_shape(step: usize, name: &str, path: &Path) {
    let before = budget::totals();
    budget::reset_high();
    STEP.store(step, SeqCst);
    ARMED.store(true, SeqCst);
    let raw = Raw::open(path).unwrap_or_else(|e| panic!("{name}: {e}"));
    let built = raw.render(1).unwrap_or_else(|e| panic!("{name}: {e}"));
    let (items, charged, high) = (built.items().len(), built.charged(), budget::totals().high);
    drop(built);
    drop(raw);
    ARMED.store(false, SeqCst);
    let leaked = LIVE.load(SeqCst) as i64 - BASELINE.load(SeqCst) as i64;
    println!(
        "{name:>24}: {items} items, {charged} charged for them; ledger peak {high}; live past baseline after: {leaked}"
    );
    assert_eq!(budget::totals().used, before.used, "{name}: the ledger isn't back to its baseline");
    assert!(leaked.unsigned_abs() < 64 << 10, "{name}: {leaked} bytes still live");
}

struct Shape {
    name: &'static str,
    path: PathBuf,
    /// Fill the cache's floor before indexing, so nothing unused in it can cover an uncharged allocation then.
    fill_cache: bool,
}

/// Opens, fills the cache if asked, indexes, then reads 8 pages at once with the ledger pinned where it stands, so the
/// cache can only evict (at its floor, for the shapes that don't fill it); then closes. Checked throughout; afterwards
/// the ledger is back to the pool alone.
fn shape(i: usize, s: &Shape) {
    let before = budget::totals();
    STEP.store(4 * i, SeqCst);
    ARMED.store(true, SeqCst);
    let raw = Arc::new(Raw::open(&s.path).unwrap_or_else(|e| panic!("{}: {e}", s.name)));
    *RAW.lock().unwrap() = Some(raw.clone());
    STEP.store(4 * i + 1, SeqCst);
    if s.fill_cache {
        run(touch_job);
    }
    STEP.store(4 * i + 2, SeqCst);
    raw.index(|_| true).unwrap();
    let limit = budget::totals().limit;
    budget::set_limit(budget::totals().used).unwrap(); // the cache can't grow past where it is: evictions only
    STEP.store(4 * i + 3, SeqCst);
    run(page_job);
    budget::set_limit(limit).unwrap();
    let charges = raw.charges();
    *RAW.lock().unwrap() = None;
    drop(raw);
    ARMED.store(false, SeqCst);
    let after = budget::totals();
    let leaked = LIVE.load(SeqCst) as i64 - BASELINE.load(SeqCst) as i64;
    println!(
        "{:>14}: {} charged at close ({} hashes, {} checkpoints, {} cache, {} metadata); live past baseline after close: {leaked}",
        s.name,
        charges.total(),
        charges.hashes,
        charges.checkpoints,
        charges.cache,
        charges.metadata
    );
    assert_eq!(after.used, before.used, "{}: the ledger isn't back to its baseline after close", s.name);
    assert!(leaked.unsigned_abs() < 64 << 10, "{}: {leaked} bytes still live after close", s.name);
}

fn main() {
    assert!(size_of::<Raw>() as u64 + 16 <= STRUCT_BYTES, "a Raw ({} bytes) outgrew its metadata", size_of::<Raw>());
    let dir = std::env::temp_dir().join(format!("typose-ledger-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let _fixtures = Fixtures(dir.clone());
    let at = |name: &str| dir.join(name);
    let astral = "😀".repeat(17_000) + "a\n";
    let utf16: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain(("😀".repeat(17_000) + "\u{FFFD}\n").encode_utf16().flat_map(u16::to_le_bytes).cycle().take(4 << 20))
        .collect();
    let lone: Vec<u8> =
        [0xD800u16, 0x0041, 0xDC00].into_iter().cycle().take(40_000).flat_map(u16::to_le_bytes).collect();
    let mut shapes = vec![
        Shape { name: "all-newline", path: at("newlines.txt"), fill_cache: true },
        Shape { name: "all-CJK", path: at("cjk.txt"), fill_cache: true },
        Shape { name: "all-malformed", path: at("malformed.txt"), fill_cache: true },
        Shape { name: "windows-1252", path: at("w1252.txt"), fill_cache: true },
        Shape { name: "UTF-16 pairs", path: at("utf16.txt"), fill_cache: true },
        Shape { name: "astral UTF-8", path: at("astral.txt"), fill_cache: true },
        Shape { name: "1 GiB line", path: at("one-line.txt"), fill_cache: false },
        Shape { name: "long path", path: long_path(&dir, LONG_PATH), fill_cache: false },
    ];
    write(&shapes[0].path, &[b"\n"], 64 << 20);
    write(&shapes[1].path, &["語".repeat(23_334).as_bytes(), b"\n"], 120);
    // Valid UTF-8 in the first chunk, so it sniffs as UTF-8; then lone 0xFF bytes and truncated sequences.
    write(&shapes[2].path, &[&[b'a'; 99], b"\n"], 10_486);
    let mut f = fs::OpenOptions::new().append(true).open(&shapes[2].path).unwrap();
    for _ in 0..30 {
        f.write_all(&[[0xFF; 70_000].as_slice(), b"\n", &[0xE2, 0x82].repeat(35_000), b"\n"].concat()).unwrap();
    }
    drop(f);
    write(&shapes[3].path, &[&[0x80; 70_000], b"\n"], 60);
    write(&shapes[4].path, &[&utf16, &lone], 1);
    write(&shapes[5].path, &[astral.as_bytes()], 60);
    one_gib_line(&shapes[6].path);
    // Whole-file blank checks decode only files at or below CHUNK. Exercise their allocations at that boundary,
    // including UTF-16's three UTF-8 bytes per unit and malformed input's replacement characters.
    for (name, file, le, unit, len) in [
        ("short LE whitespace", "short-le-space.txt", true, 0x3000u16, CHUNK),
        ("short BE whitespace", "short-be-space.txt", false, 0x3000, CHUNK),
        ("short LE dense BMP", "short-le-bmp.txt", true, 0x0800, CHUNK),
        ("short BE dense BMP", "short-be-bmp.txt", false, 0x0800, CHUNK),
        ("short LE surrogate", "short-le-surrogate.txt", true, 0xD800, CHUNK),
        ("short BE surrogate", "short-be-surrogate.txt", false, 0xD800, CHUNK),
        ("odd LE whitespace", "odd-le-space.txt", true, 0x3000, CHUNK - 1),
        ("odd BE whitespace", "odd-be-space.txt", false, 0x3000, CHUNK - 1),
    ] {
        let encode = if le { u16::to_le_bytes } else { u16::to_be_bytes };
        let bom = if le { [0xFF, 0xFE] } else { [0xFE, 0xFF] };
        let bytes: Vec<u8> =
            bom.into_iter().chain(std::iter::repeat_n(unit, CHUNK / 2).flat_map(encode)).take(len).collect();
        let path = at(file);
        fs::write(&path, bytes).unwrap();
        shapes.push(Shape { name, path, fill_cache: false });
    }
    let path = at("short-malformed-utf8.txt");
    write(&path, &[b"\xEF\xBB\xBF", &vec![0xFF; CHUNK - 5], b"\xE3\x80"], 1);
    shapes.push(Shape { name: "short malformed UTF-8", path, fill_cache: false });
    // Plan (Rendered Markdown slice) §3: Markdown at the ceiling, padded tables, the densest parse (a node a byte, `md.rs`),
    // and UTF-16 and windows-1252 text.
    let mixed = mixed_markdown(MAX_SOURCE as usize);
    let small = mixed_markdown(1 << 20);
    let markdown = [
        ("Markdown at the ceiling", at("mixed.md"), mixed.into_bytes()),
        ("padded tables", at("tables.md"), padded_tables(32 << 10).into_bytes()),
        ("a node a byte", at("dense.md"), "*_".repeat(2 << 20).into_bytes()),
        (
            "Markdown in UTF-16",
            at("utf16.md"),
            [0xFF, 0xFE].into_iter().chain(small.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
        ),
        ("Markdown in windows-1252", at("w1252.md"), small.bytes().map(|b| if b == b'a' { 0xE9 } else { b }).collect()),
    ];
    for (_, path, bytes) in &markdown {
        fs::write(path, bytes).unwrap();
    }
    let markdown: Vec<(&str, PathBuf)> = markdown.into_iter().map(|(name, path, _)| (name, path)).collect();

    budget::set_limit(8 << 30).unwrap();
    // A first build makes the statics a build uses once for the process (ammonia's builder, html5ever's atoms).
    drop(Raw::open(&markdown[3].1).unwrap().render(1).unwrap());
    let workers: Vec<_> = (0..WORKERS).map(|i| std::thread::spawn(move || worker(i))).collect();
    println!("plan C1: live ≤ reserved at every allocation, {WORKERS} page reads at once");
    std::thread::sleep(Duration::from_millis(50)); // the workers are waiting
    BASELINE.store(LIVE.load(SeqCst), SeqCst);

    for (i, s) in shapes.iter().enumerate() {
        shape(i, s);
    }
    // Plan C1's elastic cache: it grows past its floor while the ledger allows, and at the limit it stops there and
    // evicts within what it holds.
    let used = budget::totals().used;
    STEP.store(4 * shapes.len(), SeqCst);
    ARMED.store(true, SeqCst);
    let raw = Arc::new(Raw::open(&shapes[0].path).unwrap());
    let floor = raw.charges().cache;
    *RAW.lock().unwrap() = Some(raw.clone());
    run(touch_job); // chunks 0-7: the cache grows to 8
    let grown = raw.charges().cache;
    let limit = budget::totals().limit;
    budget::set_limit(budget::totals().used).unwrap();
    TOUCH_FROM.store(8, SeqCst);
    run(touch_job); // chunks 8-15, at the limit: read and cached in place of older ones
    TOUCH_FROM.store(0, SeqCst);
    budget::set_limit(limit).unwrap();
    let held = raw.charges().cache;
    *RAW.lock().unwrap() = None;
    drop(raw);
    ARMED.store(false, SeqCst);
    println!("elastic cache: {floor} bytes at open, {grown} grown, {held} after 8 more chunks at the limit");
    assert!(grown >= floor + (4 << 20), "the cache didn't grow past its floor");
    assert_eq!(held, grown, "the cache grew past the limit, or gave back what it held");
    assert_eq!(budget::totals().used, used);
    // A path too long for this OS to open fails, as it should, within the open's own reservation.
    let too_long = PathBuf::from(format!("{}\\{}", dir.display(), "x\\".repeat(16_000)));
    let used = budget::totals().used;
    STEP.store(4 * shapes.len() + 1, SeqCst);
    ARMED.store(true, SeqCst);
    let refused = Raw::open(&too_long).is_err();
    ARMED.store(false, SeqCst);
    assert!(refused, "a 32,000-byte path opened");
    assert_eq!(budget::totals().used, used);
    // Plan (Rendered Markdown slice) §2.1: each Markdown build, checked throughout. Then a budget with room for the
    // read but not the parse refuses the build with `Memory`, and nothing stays charged.
    for (k, (name, path)) in markdown.iter().enumerate() {
        md_shape(4 * shapes.len() + 2 + k, name, path);
    }
    STEP.store(4 * shapes.len() + 2 + markdown.len(), SeqCst);
    ARMED.store(true, SeqCst);
    let used = budget::totals().used;
    let raw = Raw::open(&markdown[0].1).unwrap();
    let (opened, limit, floor) = (budget::totals().used, budget::totals().limit, raw.charges().cache);
    budget::set_limit(opened + (64 << 20)).unwrap(); // the read's 35 MiB, not the parse's 1.6 GiB
    let refused = raw.render(1);
    budget::set_limit(limit).unwrap();
    // Beside what the document holds: its read grew its chunk cache, which is the document's to keep (plan C1).
    let (after, grown) = (budget::totals().used, raw.charges().cache - floor);
    drop(raw);
    ARMED.store(false, SeqCst);
    assert!(matches!(refused, Err(DocError::Memory(_))), "{refused:?}");
    assert_eq!(after - grown, opened, "a refused build left something charged");
    assert_eq!(budget::totals().used, used);
    println!("a build under a tight budget: {}; the cache grew {grown} bytes reading for it", refused.unwrap_err());

    JOB.store(0, SeqCst);
    ROUND.fetch_add(1, SeqCst);
    for w in workers {
        w.join().unwrap();
    }
    let (checks, skipped, over) = (CHECKS.load(SeqCst), SKIPPED.load(SeqCst), OVER.load(SeqCst));
    let (margin, at) = (MARGIN.load(SeqCst), MARGIN_AT.load(SeqCst));
    let extras: Vec<&str> = ["the elastic cache", "too long a path"]
        .into_iter()
        .chain(markdown.iter().map(|m| m.0))
        .chain(["a Markdown build refused"])
        .collect();
    let place = match shapes.get(at / 4) {
        Some(s) => format!("{}: {}", s.name, ["open", "fill the cache", "index", "8 pages"][at % 4]),
        None => extras[at - 4 * shapes.len()].to_string(),
    };
    println!("{checks} allocations checked, {skipped} skipped (the ledger kept moving)");
    println!("least room: {margin} bytes, in {place}");
    assert_eq!(FAILED.load(SeqCst), 0, "page reads failed");
    let [live, reserved, size] = WORST.each_ref().map(|w| w.load(SeqCst));
    assert_eq!(
        over, 0,
        "{over} allocations found live > reserved; the worst: {live} live past the baseline, {reserved} reserved, at an \
         allocation of {size}"
    );
    assert!(checks > 10_000 && skipped * 100 < checks, "too few checks ran: the test proves nothing");
    println!("ok");
}
