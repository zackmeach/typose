//! napi-rs bindings for `typose-core` (spec §2.2: thin, no logic). Every caller-controlled number arrives as an
//! `f64` and goes through `limits::int` before any conversion (plan C4).
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsError, Task};
use napi_derive::napi;
use typose_core::doc::DocError;
#[cfg(feature = "test-hooks")]
use typose_core::hooks;
use typose_core::limits::{self, RANGES};
use typose_core::pages::{self, LinePiece};
use typose_core::raw::Raw;
use typose_core::store::cancellable;

/// Progress is throttled to 10 Hz, except while a first screen of lines is still filling (spec §3.4).
const FIRST_SCREEN_LINES: u64 = 256;

/// A thrown error's `code` (protocol v1's typed errors).
pub enum Code {
    InvalidParams,
    NotFound,
    PermissionDenied,
    Refused,
    Binary,
    Frozen,
    Stale,
    Io,
    Cancelled,
    NoDocument,
}

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        match self {
            Code::InvalidParams => "InvalidParams",
            Code::NotFound => "NotFound",
            Code::PermissionDenied => "PermissionDenied",
            Code::Refused => "Refused",
            Code::Binary => "Binary",
            Code::Frozen => "Frozen",
            Code::Stale => "Stale",
            Code::Io => "Io",
            Code::Cancelled => "Cancelled",
            Code::NoDocument => "NoDocument",
        }
    }
}

fn doc_error(e: DocError) -> Error<Code> {
    let code = match &e {
        DocError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => Code::NotFound,
        DocError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => Code::PermissionDenied,
        DocError::Io(_) => Code::Io,
        DocError::Stale { .. } => Code::Stale,
        DocError::Frozen(_) => Code::Frozen,
        DocError::Refused(_) => Code::Refused,
        DocError::Binary => Code::Binary,
        DocError::Invalid(_) => Code::InvalidParams,
        DocError::Cancelled => Code::Cancelled,
    };
    Error::new(code, e.to_string())
}

fn int(field: &str, x: f64) -> std::result::Result<u64, Error<Code>> {
    limits::int(field, x).map_err(|why| Error::new(Code::InvalidParams, why))
}

#[napi]
pub fn core_version() -> String {
    typose_core::version().to_string()
}

#[napi(object)]
pub struct Range {
    pub field: String,
    pub min: f64,
    pub max: f64,
}

/// Plan C2's bounds and C4's range table, as the core defines them.
#[napi(object)]
pub struct Limits {
    pub piece_bytes: u32,
    pub page_bytes: u32,
    pub max_items: u32,
    pub map_max: u32,
    pub item_wire_fixed: u32,
    pub page_wire_max: u32,
    pub ranges: Vec<Range>,
}

#[napi]
pub fn limits() -> Limits {
    Limits {
        piece_bytes: pages::PIECE_BYTES as u32,
        page_bytes: pages::PAGE_BYTES as u32,
        max_items: pages::MAX_ITEMS as u32,
        map_max: pages::MAP_MAX as u32,
        item_wire_fixed: pages::ITEM_WIRE_FIXED as u32,
        page_wire_max: pages::PAGE_WIRE_MAX as u32,
        ranges: RANGES
            .iter()
            .map(|&(field, min, max)| Range { field: field.into(), min: min as f64, max: max as f64 })
            .collect(),
    }
}

/// A byte map (spec §3.2 🔒) as typed arrays. `uniform`: `points` holds the UTF-16 offsets where a surrogate pair
/// starts, and unit `u` is at byte `start + u * unitBytes`. Otherwise `points` is `(unit, byte - start)` pairs
/// flattened, the breakpoints of `bytemap.rs`, and `unitBytes` is 0.
#[napi(object)]
pub struct WireMap {
    pub uniform: bool,
    pub start: f64,
    pub end: f64,
    pub units: u32,
    pub unit_bytes: u32,
    pub points: Uint32Array,
}

/// Where a line's next piece starts (plan C3): the core issues it and checks it when it comes back. The core host
/// adds its session.
#[napi(object)]
pub struct Continuation {
    #[napi(js_name = "gen")]
    pub generation: u32,
    pub line: f64,
    pub offset: f64,
}

/// One bounded piece of a line (plan C2). `offset` is the piece's first byte; `more` says the line goes on, `next`
/// is its next piece while the line's first 1 MiB goes on, and `rest` is how many bytes the line has past the last
/// piece shown (brief §5.1), once the index knows.
#[napi(object)]
pub struct PageItem {
    #[napi(js_name = "gen")]
    pub generation: u32,
    pub line: f64,
    pub offset: f64,
    pub text: String,
    pub more: bool,
    pub map: WireMap,
    pub next: Option<Continuation>,
    pub rest: Option<f64>,
}

#[napi(object)]
pub struct Page {
    pub items: Vec<PageItem>,
}

#[napi(object)]
pub struct IndexProgress {
    pub lines: f64,
    pub bytes: f64,
    pub done: bool,
    pub elapsed_ms: f64,
    pub error: Option<String>,
}

fn item(generation: u32, p: LinePiece) -> PageItem {
    let w = p.map.to_wire();
    let map = WireMap {
        uniform: w.uniform,
        start: w.start as f64,
        end: w.end as f64,
        units: w.units,
        unit_bytes: w.unit_bytes,
        points: Uint32Array::new(w.points),
    };
    let next = p.next.map(|offset| Continuation { generation, line: p.line as f64, offset: offset as f64 });
    let (line, offset, rest) = (p.line as f64, p.offset as f64, p.rest.map(|r| r as f64));
    PageItem { generation, line, offset, text: p.text, more: p.more, map, next, rest }
}

/// A cancel flag for one page read (plan C5) or one index job (C6): the core host makes one for each.
#[napi]
#[derive(Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
}

#[napi]
impl Cancel {
    #[napi(constructor)]
    pub fn new() -> Cancel {
        Cancel::default()
    }

    /// A page read stops before its next chunk read and rejects with `Cancelled`; an index job stops after its
    /// block. Cancelling something that has ended does nothing.
    #[napi]
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
}

/// What a page read fetches: a window of lines, or the piece a continuation names (plan C3).
#[derive(Clone, Copy)]
enum Want {
    Lines { start: u64, count: usize },
    Piece { line: u64, offset: u64 },
}

/// A page read as an async task (plan C5): it runs on libuv's thread pool, so the core host's JS thread stays free
/// to take `cancel`, and stops at its cancel flag before its next chunk read.
pub struct Read {
    raw: Arc<Raw>,
    generation: u32,
    want: Want,
    cancel: Arc<AtomicBool>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}

impl Read {
    fn new(raw: &Arc<Raw>, generation: u32, want: Want, cancel: &Cancel) -> AsyncTask<Read> {
        AsyncTask::new(Read {
            raw: raw.clone(),
            generation,
            want,
            cancel: cancel.flag.clone(),
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        })
    }
}

impl Task for Read {
    type Output = std::result::Result<Vec<LinePiece>, DocError>;
    type JsValue = Page;

    fn compute(&mut self) -> Result<Self::Output> {
        let (raw, generation) = (&self.raw, self.generation);
        Ok(cancellable(&self.cancel, || match self.want {
            Want::Lines { start, count } => raw.page(generation, start, count),
            Want::Piece { line, offset } => raw.piece(generation, line, offset).map(|p| vec![p]),
        }))
    }

    /// A cancel that arrives after the reads, while the result is on its way to JS, still ends the read: once the
    /// core host has cancelled a read, it never resolves.
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Page> {
        let output = if self.cancel.load(Ordering::Relaxed) { Err(DocError::Cancelled) } else { output };
        match output {
            Ok(pieces) => Ok(Page { items: pieces.into_iter().map(|p| item(self.generation, p)).collect() }),
            // A promise rejects with the JS value an error holds, so the typed code survives.
            Err(e) => Err(Error::from(JsError::from(doc_error(e)).into_unknown(env))),
        }
    }
}

/// An open document in Raw. Offsets and sizes are exact numbers: `Raw::open` refuses files over 2^53 − 1 bytes.
/// `close` drops it at once; until then it lives as long as the JS object does.
#[napi]
pub struct Doc {
    raw: Option<Arc<Raw>>,
}

#[napi]
impl Doc {
    #[napi(factory)]
    pub fn open(path: String) -> std::result::Result<Doc, Error<Code>> {
        if path.is_empty() || path.contains('\0') {
            return Err(Error::new(Code::InvalidParams, "path must be a non-empty string without NUL"));
        }
        Ok(Doc { raw: Some(Arc::new(Raw::open(std::path::Path::new(&path)).map_err(doc_error)?)) })
    }

    fn raw(&self) -> std::result::Result<&Arc<Raw>, Error<Code>> {
        self.raw.as_ref().ok_or_else(|| Error::new(Code::NoDocument, "the document is closed"))
    }

    #[napi(getter)]
    pub fn size(&self) -> std::result::Result<f64, Error<Code>> {
        Ok(self.raw()?.document().len() as f64)
    }

    #[napi(getter)]
    pub fn generation(&self) -> std::result::Result<u32, Error<Code>> {
        Ok(self.raw()?.document().generation())
    }

    #[napi(getter)]
    pub fn encoding(&self) -> std::result::Result<String, Error<Code>> {
        Ok(self.raw()?.encoding().into())
    }

    /// Brief §7.9's empty file: 0 bytes, or only whitespace.
    #[napi(getter)]
    pub fn blank(&self) -> std::result::Result<bool, Error<Code>> {
        Ok(self.raw()?.blank())
    }

    /// Ctrl+R (spec §3.1): the same path at the next generation, which `startIndex` then indexes. Every page and
    /// token of the old generation is refused from now on (`Stale`). If the open fails, nothing changes.
    #[napi]
    pub fn reload(&mut self) -> std::result::Result<(), Error<Code>> {
        let next = self.raw()?.reload().map_err(doc_error)?;
        self.raw = Some(Arc::new(next));
        Ok(())
    }

    /// Plan C6: drops the document. Its file handle closes once the index job and the page reads that share it have
    /// stopped, which the core host cancels first. Every later call is `NoDocument`.
    #[napi]
    pub fn close(&mut self) {
        self.raw = None;
    }

    /// Lines found so far by the index, and whether it's done.
    #[napi(getter)]
    pub fn lines(&self) -> std::result::Result<f64, Error<Code>> {
        Ok(self.raw()?.lines_known().0 as f64)
    }

    #[napi(getter)]
    pub fn indexed(&self) -> std::result::Result<bool, Error<Code>> {
        Ok(self.raw()?.lines_known().1)
    }

    /// Indexes on a background thread with its own file handle, so page reads never queue behind index reads.
    /// `cancel` stops it after its current block (plan C6). That block's progress event can still follow the cancel; it
    /// names a closed document, which the renderer ignores.
    #[napi]
    pub fn start_index(
        &self,
        cancel: &Cancel,
        on_progress: ThreadsafeFunction<IndexProgress, (), IndexProgress, Status, false>,
    ) -> std::result::Result<(), Error<Code>> {
        let (raw, cancel) = (self.raw()?.clone(), cancel.flag.clone());
        #[cfg(feature = "test-hooks")]
        let job = hooks::Live::new(&hooks::JOBS);
        std::thread::spawn(move || {
            #[cfg(feature = "test-hooks")]
            let _job = job; // dropped last, after the job's hold on the document (`raw`, below)
            let raw = raw;
            let mut last: Option<Instant> = None;
            let mut sent_lines = 0u64;
            let result = raw.index(|p| {
                let filling_first_screen = sent_lines < FIRST_SCREEN_LINES && p.lines > sent_lines;
                if p.done || filling_first_screen || last.is_none_or(|t| t.elapsed() >= Duration::from_millis(100)) {
                    last = Some(Instant::now());
                    sent_lines = p.lines;
                    let progress = IndexProgress {
                        lines: p.lines as f64,
                        bytes: p.bytes as f64,
                        done: p.done,
                        elapsed_ms: p.elapsed_ms as f64,
                        error: None,
                    };
                    on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
                }
                !cancel.load(Ordering::Relaxed)
            });
            if let Err(e) = result {
                let progress = IndexProgress {
                    lines: raw.lines_known().0 as f64, // what the index published, not the last count sent
                    bytes: 0.0,
                    done: false,
                    elapsed_ms: 0.0,
                    error: Some(e),
                };
                on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
        Ok(())
    }

    /// Up to `count` lines from line `start` of generation `gen`, within plan C2's bounds. Invalid numbers throw; the
    /// read's own errors reject, `Cancelled` among them.
    #[napi(ts_return_type = "Promise<Page>")]
    pub fn page(
        &self,
        generation: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Read>, Error<Code>> {
        let (generation, start, count) = (int("gen", generation)? as u32, int("start", start)?, int("count", count)?);
        Ok(Read::new(self.raw()?, generation, Want::Lines { start, count: count as usize }, cancel))
    }

    /// The piece a continuation names (plan C3), as a page of one item: `Stale` for an old generation,
    /// `InvalidParams` for an offset this core couldn't have issued.
    #[napi(ts_return_type = "Promise<Page>")]
    pub fn piece(
        &self,
        generation: f64,
        line: f64,
        offset: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Read>, Error<Code>> {
        let (generation, line, offset) = (int("gen", generation)? as u32, int("line", line)?, int("offset", offset)?);
        Ok(Read::new(self.raw()?, generation, Want::Piece { line, offset }, cancel))
    }
}

/// The test-hooks addon's own calls (plan m8), absent from the release addon.
#[cfg(feature = "test-hooks")]
pub mod test_hooks {
    use super::*;

    /// What's alive in this core (plan C6's "0 jobs, 0 tasks and 0 handles"), and the longest a chunk read's delay
    /// has actually waited (`delay_ms`, plan C5).
    #[napi(object)]
    pub struct DebugStats {
        pub jobs: u32,
        pub tasks: u32,
        pub handles: u32,
        pub delay_ms: f64,
    }

    #[napi]
    pub fn debug_stats() -> DebugStats {
        let count = |c| hooks::count(c) as u32;
        let delay_ms = hooks::slowest_delay_ms();
        DebugStats { jobs: count(&hooks::JOBS), tasks: count(&hooks::TASKS), handles: count(&hooks::HANDLES), delay_ms }
    }

    /// Plan C5's per-read delay: every chunk read from disk waits `ms` first.
    #[napi]
    pub fn set_read_delay(ms: f64) -> std::result::Result<(), Error<Code>> {
        hooks::set_read_delay(ms).map_err(|why| Error::new(Code::InvalidParams, why))
    }
}
