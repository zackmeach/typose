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

use typose_core::budget::{self, Reservation, Work};
use typose_core::doc::{DocError, STRUCT_BYTES};
use typose_core::images::{self, ImageError};
use typose_core::jsonl;
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
/// Image jobs run after the document workers stop. Their own baselines exclude already allocated fixtures and their
/// reservations, so neither can conceal an uncharged codec allocation. Negative controls withdraw only image charges
/// from this test's comparison; production reservation behavior is never changed.
static RESERVED_BASELINE: AtomicU64 = AtomicU64::new(0);
static WITHDRAW_IMAGE_CHARGES: AtomicBool = AtomicBool::new(false);
static CANCEL_IMAGE_OUTPUT: AtomicBool = AtomicBool::new(false);
static IMAGE_CANCEL: AtomicBool = AtomicBool::new(false);

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
    // Deterministically cancel after the real canonical Vec allocation, with decoder pixels/work still alive.
    // This hook lives only in this allocator test binary and cannot alter the production addon.
    if CANCEL_IMAGE_OUTPUT.load(SeqCst) && size == images::MAX_CANONICAL {
        IMAGE_CANCEL.store(true, SeqCst);
    }
    for _ in 0..1000 {
        let (reserved, version) = budget::in_use();
        let reserved = if WITHDRAW_IMAGE_CHARGES.load(SeqCst) {
            0
        } else {
            reserved.saturating_sub(RESERVED_BASELINE.load(SeqCst))
        };
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

/// A Claude Code session for the transcript graph (M5 PR 1): tool calls and their results, sidechains, session events
/// between messages, a 2,000-message branch, and a rerun of its first records after a `bridge-session` record.
fn claude_session() -> String {
    let message = |kind: &str, uuid: &str, parent: &str, side: bool, content: &str| {
        format!(
            r#"{{"type":"{kind}","uuid":"{uuid}","parentUuid":{parent},"isSidechain":{side},"timestamp":"2026-11-04T12:00:00.000Z","message":{{"role":"{kind}","content":{content}}}}}"#
        )
    };
    let mut lines = Vec::new();
    let mut parent = "null".to_string();
    for i in 0..10_000 {
        let content = if i % 2 == 0 {
            format!(
                r#"[{{"type":"tool_result","tool_use_id":"t{i}a","content":"r"}},{{"type":"tool_result","tool_use_id":"t{i}b","content":"r"}}]"#
            )
        } else {
            r#""question""#.into()
        };
        lines.push(message("user", &format!("u{i}"), &parent, false, &content));
        parent = format!(r#""u{i}""#);
        if i % 7 == 0 {
            lines.push(format!(r#"{{"type":"system","uuid":"e{i}","parentUuid":{parent}}}"#));
            parent = format!(r#""e{i}""#);
        }
        let calls = format!(
            r#"[{{"type":"text","text":"answer"}},{{"type":"tool_use","id":"t{}a","name":"read","input":{{"path":"x"}}}},{{"type":"tool_use","id":"t{}b","name":"grep","input":{{}}}}]"#,
            i + 1,
            i + 1
        );
        lines.push(message("assistant", &format!("a{i}"), &parent, false, &calls));
        if i % 50 == 0 {
            lines.push(message("assistant", &format!("s{i}"), &format!(r#""a{i}""#), true, r#""side""#));
        }
        parent = format!(r#""a{i}""#);
    }
    lines.extend((0..2000).map(|i| {
        let fork = if i == 0 { r#""a0""#.to_string() } else { format!(r#""b{}""#, i - 1) };
        message("assistant", &format!("b{i}"), &fork, false, r#""branch""#)
    }));
    lines.push(r#"{"type":"bridge-session","sessionId":"s"}"#.into());
    lines.extend(lines[..500].to_vec());
    lines.push(message("user", "last", &parent, false, r#""last""#));
    lines.join("\n") + "\n"
}

/// An OpenAI fine-tuning dataset: conversations of a system prompt and 40 rounds of a tool call, its result and a
/// question, so each record's turns grow long.
fn openai_dataset() -> String {
    let round = |i: usize| {
        format!(
            r#"{{"role":"assistant","content":null,"tool_calls":[{{"id":"c{i}","type":"function","function":{{"name":"lookup","arguments":"{{}}"}}}}]}},{{"role":"tool","tool_call_id":"c{i}","content":"r"}},{{"role":"user","content":"q"}}"#
        )
    };
    let line = format!(
        r#"{{"messages":[{{"role":"system","content":"s"}},{}],"metadata":{{"split":"train"}}}}"#,
        (0..40).map(round).collect::<Vec<_>>().join(",")
    );
    vec![line; 1000].join("\n") + "\n"
}

/// Indexes `path` as JSONL, with its transcript graph, checked throughout; holds it, then drops it and the document:
/// the ledger is back to its baseline.
fn transcript_shape(step: usize, name: &str, path: &Path) {
    let before = budget::totals();
    STEP.store(step, SeqCst);
    ARMED.store(true, SeqCst);
    let start = (LIVE.load(SeqCst), budget::in_use().0);
    let raw = Raw::open(path).unwrap_or_else(|e| panic!("{name}: {e}"));
    let index = jsonl::Index::with_encoding(raw.source_encoding()).unwrap();
    let temp = Reservation::new(typose_core::structured::TEMP_BYTES).unwrap();
    index.build_reserved(raw.document(), 1, temp).unwrap_or_else(|e| panic!("{name}: {e}"));
    // The build's temporaries are released: the graph, the index and the document hold only what they're charged.
    let (live, reserved) = (LIVE.load(SeqCst) - start.0, budget::in_use().0 - start.1);
    let graph = index.transcript.lock().unwrap();
    let (ready, entries, items, charged) = (graph.ready, graph.entries.len(), graph.items.len(), graph.charged());
    drop(graph);
    drop(index);
    drop(raw);
    ARMED.store(false, SeqCst);
    let leaked = LIVE.load(SeqCst) as i64 - BASELINE.load(SeqCst) as i64;
    println!(
        "{name:>24}: {entries} records, {items} items, {charged} charged for the graph; once built, {live} live and \
         {reserved} reserved since it opened; live past baseline after: {leaked}"
    );
    assert!(ready, "{name}: the transcript graph is off");
    assert!(live <= reserved, "{name}: {live} bytes live since it opened, {reserved} reserved");
    assert_eq!(budget::totals().used, before.used, "{name}: the ledger isn't back to its baseline");
    assert!(leaked.unsigned_abs() < 64 << 10, "{name}: {leaked} bytes still live");
    // A budget with room for the index and half the graph: the graph turns off, the index stays whole for Rows, and
    // nothing stays charged.
    ARMED.store(true, SeqCst);
    let raw = Raw::open(path).unwrap();
    raw.document().store().set_cache_active(false); // its floor only: the budget's room is the index's and the graph's
    let (opened, limit) = (budget::totals().used, budget::totals().limit);
    let index = jsonl::Index::with_encoding(raw.source_encoding()).unwrap();
    budget::set_limit(opened + typose_core::structured::TEMP_BYTES + (1 << 20) + charged / 2).unwrap();
    let temp = Reservation::new(typose_core::structured::TEMP_BYTES).unwrap();
    let built = index.build_reserved(raw.document(), 1, temp);
    budget::set_limit(limit).unwrap();
    let progress = index.progress.read().unwrap().clone();
    let graph = index.transcript.lock().unwrap();
    let (ready, reason, held) = (graph.ready, graph.reason.clone(), graph.charged());
    drop(graph);
    drop(index);
    drop(raw);
    ARMED.store(false, SeqCst);
    println!("{name:>24}: under half the graph's budget: {reason:?}, the index done={}", progress.done);
    assert!(built.is_ok() && progress.done && progress.error.is_none(), "{name}: {built:?} {:?}", progress.error);
    assert!(!ready && held == 0, "{name}: the graph wasn't turned off");
    assert_eq!(reason.as_deref(), Some("Transcript graph exceeds its memory or record limit; Rows remains available"));
    assert_eq!(budget::totals().used, before.used, "{name}: a refused graph left something charged");
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

/// A charge-release negative control: the elastic vectors still exist, but the comparison withholds their charge.
/// The allocator normally runs only on allocations, so an explicit checkpoint is needed to make a shrink-before-free
/// mistake observable even when no allocation would occur between those operations. Production state stays intact.
fn cache_charge_negative(elastic: u64) -> bool {
    let over = OVER.load(SeqCst);
    let worst = WORST.each_ref().map(|value| value.load(SeqCst));
    let baseline = RESERVED_BASELINE.swap(elastic, SeqCst);
    check(0);
    let detected = OVER.load(SeqCst) > over;
    RESERVED_BASELINE.store(baseline, SeqCst);
    OVER.store(over, SeqCst);
    for (slot, value) in WORST.iter().zip(worst) {
        slot.store(value, SeqCst);
    }
    detected
}

#[derive(Clone, Copy)]
enum ImageExpected {
    Ready,
    Refused,
    Memory,
    Cancelled,
}

#[derive(Clone, Copy)]
enum ImageControl {
    Positive,
    MissingCharges,
    MissingResource,
    CancelOutput,
}

/// No fixture allocation or printing occurs while armed. Each job must return its exact ledger/heap baseline after
/// success, cancellation or refusal. A successful return may retain only its fixed canonical capacity.
fn image_case(name: &str, source: &Vec<u8>, expected: ImageExpected, control: ImageControl, room: Option<u64>) {
    let initial = budget::totals();
    let source_charge = budget::Reservation::new(source.capacity() as u64).unwrap();
    let before = budget::totals().used;
    if let Some(room) = room {
        budget::set_limit(before + room).unwrap();
    }
    BASELINE.store(LIVE.load(SeqCst), SeqCst);
    RESERVED_BASELINE.store(budget::in_use().0, SeqCst);
    CHECKS.store(0, SeqCst);
    SKIPPED.store(0, SeqCst);
    OVER.store(0, SeqCst);
    for slot in &WORST {
        slot.store(0, SeqCst);
    }
    IMAGE_CANCEL.store(false, SeqCst);
    CANCEL_IMAGE_OUTPUT.store(matches!(control, ImageControl::CancelOutput), SeqCst);
    WITHDRAW_IMAGE_CHARGES.store(matches!(control, ImageControl::MissingCharges), SeqCst);
    ARMED.store(true, SeqCst);
    let result = images::decode(source, &IMAGE_CANCEL);
    let expected_result = matches!(
        (&result, expected),
        (Ok(_), ImageExpected::Ready)
            | (Err(ImageError::Refused(_)), ImageExpected::Refused)
            | (Err(ImageError::Memory(_)), ImageExpected::Memory)
            | (Err(ImageError::Cancelled), ImageExpected::Cancelled)
    );
    let canonical_only = match &result {
        Ok(image) => {
            image.charged() == images::MAX_CANONICAL as u64
                && budget::totals().used - before == image.charged()
                && LIVE.load(SeqCst) - BASELINE.load(SeqCst) == image.charged()
                && image.bytes().len() <= images::MAX_CANONICAL
        }
        Err(_) => true,
    };
    if matches!(control, ImageControl::MissingResource) {
        WITHDRAW_IMAGE_CHARGES.store(true, SeqCst);
        check(0); // the completed resource's charge is withdrawn while its actual Vec remains live
    }
    drop(result);
    ARMED.store(false, SeqCst);
    CANCEL_IMAGE_OUTPUT.store(false, SeqCst);
    WITHDRAW_IMAGE_CHARGES.store(false, SeqCst);
    RESERVED_BASELINE.store(0, SeqCst);
    let (checks, skipped, over) = (CHECKS.load(SeqCst), SKIPPED.load(SeqCst), OVER.load(SeqCst));
    let leaked = LIVE.load(SeqCst) as i64 - BASELINE.load(SeqCst) as i64;
    budget::set_limit(initial.limit).unwrap();
    assert!(expected_result, "{name}: unexpected image result");
    assert!(canonical_only, "{name}: native work or pixels escaped with the canonical resource");
    assert_eq!(budget::totals().used, before, "{name}: image reservations survived completion/drop");
    assert_eq!(leaked, 0, "{name}: image heap survived completion/drop");
    assert!(checks > 0, "{name}: no actual image allocations were observed");
    assert_eq!(skipped, 0, "{name}: serialized image checks must not skip allocations");
    match control {
        ImageControl::MissingCharges | ImageControl::MissingResource => {
            assert!(over > 0, "{name}: withdrawing image reservations did not trip the allocator check");
        }
        _ => {
            let [live, reserved, size] = WORST.each_ref().map(|w| w.load(SeqCst));
            assert_eq!(over, 0, "{name}: {live} live > {reserved} reserved at allocation {size}");
        }
    }
    drop(source_charge);
    assert_eq!(budget::totals().used, initial.used, "{name}: source charge survived");
    println!(
        "{name:>30}: {checks} checked, {over} violations (negative controls require violations), heap/ledger restored"
    );
}

fn image_palette() -> Vec<u8> {
    (0..=255_u8).flat_map(|v| [v, v.wrapping_mul(3), 255 - v]).collect()
}

fn ledger_png() -> Vec<u8> {
    let mut source = Vec::new();
    let palette = image_palette();
    let transparency: Vec<u8> = (0..=255).collect();
    let mut state = 0x6d2b_79f5_u32;
    let indices: Vec<u8> = (0..(1024 * 256))
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            if state & 7 == 0 { state as u8 } else { (state & 7) as u8 }
        })
        .collect();
    {
        let mut encoder = png::Encoder::new(&mut source, 1024, 256);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(palette.as_slice());
        encoder.set_trns(transparency.as_slice());
        // Fixture creation is unarmed. Dynamic DEFLATE exercises the production decoder's secondary Huffman tables;
        // production canonical encoding still explicitly selects FdeflateUltraFast.
        encoder.set_deflate_compression(png::DeflateCompression::Level(6));
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&indices).unwrap();
        writer.finish().unwrap();
    }
    source
}

fn ledger_gif() -> Vec<u8> {
    let mut source = Vec::new();
    let palette = image_palette();
    let mut state = 0x1b87_3593_u32;
    let indices: Vec<u8> = (0..4096 * 32)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect();
    {
        let mut encoder = gif::Encoder::new(&mut source, 4096, 32, &palette).unwrap();
        let frame =
            gif::Frame { width: 4096, height: 32, buffer: std::borrow::Cow::Borrowed(&indices), ..Default::default() };
        encoder.write_frame(&frame).unwrap();
    }
    source
}

fn ledger_jpeg(width: u16, height: u16, sampling: u8) -> Vec<u8> {
    // A complete baseline YCbCr scan, zero DC and EOB for each block. Two one-bit Huffman codes per block.
    let mut source = vec![0xff, 0xd8, 0xff, 0xdb, 0, 0x43, 0];
    source.extend_from_slice(&[1; 64]);
    source.extend_from_slice(&[0xff, 0xc0, 0, 17, 8]);
    source.extend_from_slice(&height.to_be_bytes());
    source.extend_from_slice(&width.to_be_bytes());
    source.extend_from_slice(&[3, 1, sampling, 0, 2, 0x11, 0, 3, 0x11, 0]);
    for class in [0, 0x10] {
        source.extend_from_slice(&[0xff, 0xc4, 0, 20, class, 1]);
        source.extend_from_slice(&[0; 15]);
        source.push(0);
    }
    source.extend_from_slice(&[0xff, 0xda, 0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 0]);
    let (h, v) = (usize::from(sampling >> 4), usize::from(sampling & 15));
    let bits = usize::from(width).div_ceil(8 * h) * usize::from(height).div_ceil(8 * v) * (h * v + 2) * 2;
    source.resize(source.len() + bits / 8, 0);
    if bits % 8 != 0 {
        source.push((1_u8 << (8 - bits % 8)) - 1);
    }
    source.extend_from_slice(&[0xff, 0xd9]);
    source
}

fn corrupt_png_adler(source: &[u8]) -> Vec<u8> {
    let mut source = source.to_vec();
    let mut at = 8;
    let mut idat = None;
    while at < source.len() {
        let len = u32::from_be_bytes(source[at..at + 4].try_into().unwrap()) as usize;
        if &source[at + 4..at + 8] == b"IDAT" {
            idat = Some((at, len));
        }
        at += 12 + len;
    }
    let (at, len) = idat.unwrap();
    source[at + 8 + len - 1] ^= 1;
    let crc = crc32fast::hash(&source[at + 4..at + 8 + len]);
    source[at + 8 + len..at + 12 + len].copy_from_slice(&crc.to_be_bytes());
    source
}

fn image_checks() {
    // Built before each job's baseline. The complete active public production path is exercised for every format.
    let png = ledger_png();
    let gif = ledger_gif();
    let jpeg_h = ledger_jpeg(65_535, 1, 0x21);
    let jpeg_hv = ledger_jpeg(257, 257, 0x22);
    let webp = vec![
        0x52, 0x49, 0x46, 0x46, 0x3c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x30, 0, 0, 0, 0xd0, 1,
        0, 0x9d, 1, 0x2a, 2, 0, 2, 0, 2, 0, 0x34, 0x25, 0xa0, 2, 0x74, 0xba, 1, 0xf8, 0, 3, 0xb0, 0, 0xfe, 0xf0, 0xc4,
        0x0b, 0xff, 0x20, 0xb9, 0x61, 0x75, 0xc8, 0xd7, 0xff, 0x20, 0x3f, 0xe4, 7, 0xfc, 0x80, 0xff, 0xf8, 0xf2, 0, 0,
        0,
    ];
    for (name, source) in [
        ("PNG indexed dynamic", &png),
        ("GIF dictionary growth", &gif),
        ("JPEG H wide rows", &jpeg_h),
        ("JPEG HV partial MCU", &jpeg_hv),
    ] {
        image_case(name, source, ImageExpected::Ready, ImageControl::Positive, None);
    }
    for (name, source) in
        [("negative PNG charges", &png), ("negative GIF charges", &gif), ("negative JPEG charges", &jpeg_hv)]
    {
        image_case(name, source, ImageExpected::Ready, ImageControl::MissingCharges, None);
    }
    image_case("negative canonical resource", &png, ImageExpected::Ready, ImageControl::MissingResource, None);
    image_case("cancel at canonical allocation", &png, ImageExpected::Cancelled, ImageControl::CancelOutput, None);
    image_case("canonical budget refused", &png, ImageExpected::Memory, ImageControl::Positive, Some(4 << 20));
    let bad_png = corrupt_png_adler(&png);
    image_case("PNG decoder error cleanup", &bad_png, ImageExpected::Refused, ImageControl::Positive, None);
    let bad_gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\xff\x01\x00\x3b".to_vec();
    image_case("GIF decoder error cleanup", &bad_gif, ImageExpected::Refused, ImageControl::Positive, None);
    let sos = jpeg_hv.windows(2).position(|bytes| bytes == [0xff, 0xda]).unwrap();
    let entropy = sos + 2 + usize::from(u16::from_be_bytes([jpeg_hv[sos + 2], jpeg_hv[sos + 3]]));
    let mut short_jpeg = jpeg_hv[..entropy + 1].to_vec();
    short_jpeg.extend_from_slice(&[0xff, 0xd9]);
    image_case("JPEG decoder error cleanup", &short_jpeg, ImageExpected::Refused, ImageControl::Positive, None);
    // A known-valid WebP reaches only the explicit format refusal, with no codec/resource allocation or charge.
    let before = budget::totals().used;
    BASELINE.store(LIVE.load(SeqCst), SeqCst);
    RESERVED_BASELINE.store(budget::in_use().0, SeqCst);
    CHECKS.store(0, SeqCst);
    ARMED.store(true, SeqCst);
    let refused = images::decode(&webp, &AtomicBool::new(false));
    ARMED.store(false, SeqCst);
    RESERVED_BASELINE.store(0, SeqCst);
    assert!(matches!(refused, Err(ImageError::Refused("WebP images are not supported yet"))));
    assert_eq!(CHECKS.load(SeqCst), 0, "WebP refusal allocated codec/resource memory");
    assert_eq!(budget::totals().used, before, "WebP refusal changed reservations");
    assert_eq!(LIVE.load(SeqCst), BASELINE.load(SeqCst), "WebP refusal retained heap memory");
    println!("WebP explicit refusal: zero codec/resource allocations or charges");
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
    let transcripts = [("Claude Code session", at("claude.jsonl")), ("OpenAI dataset", at("dataset.jsonl"))];
    fs::write(&transcripts[0].1, claude_session()).unwrap();
    fs::write(&transcripts[1].1, openai_dataset()).unwrap();

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
    let cache_negative = cache_charge_negative(grown - floor);
    let limit = budget::totals().limit;
    budget::set_limit(budget::totals().used).unwrap();
    TOUCH_FROM.store(8, SeqCst);
    run(touch_job); // chunks 8-15, at the limit: read and cached in place of older ones
    TOUCH_FROM.store(0, SeqCst);
    budget::set_limit(limit).unwrap();
    let held = raw.charges().cache;
    raw.document().store().set_cache_active(false);
    let trimmed = raw.charges().cache;
    check(0); // real trim has already freed its removed Vecs before returning the elastic charge
    TOUCH_FROM.store(16, SeqCst);
    run(touch_job); // concurrent misses finishing while inactive must replace within the four-chunk floor
    let inactive = raw.charges().cache;
    raw.document().store().set_cache_active(true);
    let reactivated = raw.charges().cache;
    TOUCH_FROM.store(24, SeqCst);
    run(touch_job); // future misses may grow again after reactivation
    let regrown = raw.charges().cache;
    TOUCH_FROM.store(0, SeqCst);
    *RAW.lock().unwrap() = None;
    drop(raw);
    ARMED.store(false, SeqCst);
    println!(
        "elastic cache: {floor} floor, {grown} grown, {held} at limit; {trimmed} trimmed, {inactive} inactive, {reactivated} reactivated, {regrown} grown again; negative charge withdrawal detected={cache_negative}"
    );
    assert!(grown >= floor + (4 << 20), "the cache didn't grow past its floor");
    assert_eq!(held, grown, "the cache grew past the limit, or gave back what it held");
    assert!(cache_negative, "withholding the elastic charge while its vectors live did not trip the allocator check");
    assert_eq!(trimmed, floor, "inactive cache did not return to its paid floor");
    assert_eq!(inactive, floor, "late inactive misses regrew the cache");
    assert_eq!(reactivated, floor, "reactivation allocated before a future miss");
    assert!(regrown >= floor + (4 << 20), "reactivated cache could not grow on future misses");
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
    // M5 PR 1: the transcript graph's reservations, from its structs' sizes, cover what it holds as it's built and held.
    for (k, (name, path)) in transcripts.iter().enumerate() {
        transcript_shape(4 * shapes.len() + 3 + markdown.len() + k, name, path);
    }

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
        .chain(transcripts.iter().map(|t| t.0))
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
    image_checks();
    println!("ok");
}
