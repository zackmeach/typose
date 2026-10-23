//! napi-rs bindings for `typose-core` (spec §2.2: thin, no logic). Every caller-controlled number arrives as an
//! `f64` and goes through `limits::int` before any conversion (plan C4).
use std::sync::Arc;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use typose_core::doc::DocError;
use typose_core::limits::{self, RANGES};
use typose_core::pages::{self, LinePiece};
use typose_core::raw::Raw;

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

/// One bounded piece of a line (plan C2). `offset` is the line's first byte; `more` says the line goes on.
#[napi(object)]
pub struct PageItem {
    #[napi(js_name = "gen")]
    pub generation: u32,
    pub line: f64,
    pub offset: f64,
    pub text: String,
    pub more: bool,
    pub map: WireMap,
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
    PageItem { generation, line: p.line as f64, offset: p.offset as f64, text: p.text, more: p.more, map }
}

/// An open document in Raw. Offsets and sizes are exact numbers: `Raw::open` refuses files over 2^53 − 1 bytes.
#[napi]
pub struct Doc {
    raw: Arc<Raw>,
}

#[napi]
impl Doc {
    #[napi(factory)]
    pub fn open(path: String) -> std::result::Result<Doc, Error<Code>> {
        if path.is_empty() || path.contains('\0') {
            return Err(Error::new(Code::InvalidParams, "path must be a non-empty string without NUL"));
        }
        Ok(Doc { raw: Arc::new(Raw::open(std::path::Path::new(&path)).map_err(doc_error)?) })
    }

    #[napi(getter)]
    pub fn size(&self) -> f64 {
        self.raw.document().len() as f64
    }

    #[napi(getter)]
    pub fn generation(&self) -> u32 {
        self.raw.document().generation()
    }

    #[napi(getter)]
    pub fn encoding(&self) -> String {
        self.raw.encoding().into()
    }

    /// Lines found so far by the index, and whether it's done.
    #[napi(getter)]
    pub fn lines(&self) -> f64 {
        self.raw.lines_known().0 as f64
    }

    #[napi(getter)]
    pub fn indexed(&self) -> bool {
        self.raw.lines_known().1
    }

    /// Indexes on a background thread with its own file handle, so page reads never queue behind index reads.
    #[napi]
    pub fn start_index(&self, on_progress: ThreadsafeFunction<IndexProgress, (), IndexProgress, Status, false>) {
        let raw = self.raw.clone();
        std::thread::spawn(move || {
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
            });
            if let Err(e) = result {
                let progress = IndexProgress {
                    lines: sent_lines as f64,
                    bytes: 0.0,
                    done: false,
                    elapsed_ms: 0.0,
                    error: Some(e),
                };
                on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
    }

    /// Up to `count` lines from line `start`, within plan C2's bounds.
    #[napi]
    pub fn page(&self, start: f64, count: f64) -> std::result::Result<Page, Error<Code>> {
        let (start, count) = (int("start", start)?, int("count", count)?);
        let generation = self.raw.document().generation();
        let pieces = self.raw.page(start, count as usize).map_err(doc_error)?;
        Ok(Page { items: pieces.into_iter().map(|p| item(generation, p)).collect() })
    }
}
